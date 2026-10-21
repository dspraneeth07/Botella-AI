"""Read-only connector to the syncgo warehouse.

Hard guarantees:
  * Connection is opened read-only (`default_transaction_read_only = on`) and the
    psycopg connection's `read_only` flag is set, so any accidental write raises.
  * A statement timeout prevents runaway queries against the shared warehouse.
  * Queries against `sales` / `sale_items` are partition-aware: callers pass a
    `sale_date` lower bound so Postgres can prune monthly partitions.
"""
from __future__ import annotations

import contextvars
import os
import sys
import textwrap
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Callable, Iterator, Sequence

import psycopg
from psycopg.rows import dict_row

from ..config import SOURCE, _get

# --- TESTING-ONLY: SQL debug capture ----------------------------------------
# Records every warehouse query executed during a capability run so the
# dashboard can show the testing team the exact Postgres behind each figure.
# A ContextVar (not a global) so concurrent requests can't mix their logs;
# runtime/pipeline.py copies the context into its worker threads.
# Remove this block and every line marked "TESTING-ONLY: SQL debug"
# (here, api/service.py, runtime/pipeline.py, web/src/*) before production.
_sql_capture: ContextVar[list | None] = ContextVar("sql_capture", default=None)


def begin_sql_capture() -> list[dict]:
    log: list[dict] = []
    _sql_capture.set(log)
    return log


def end_sql_capture() -> None:
    _sql_capture.set(None)


def _source_tag() -> str | None:
    """Best-effort: the source/ repo module that issued this query (e.g.
    'inventory_repo', 'margin_repo'), found by walking up past connector.py.
    Lets the dashboard attribute each query to the component it feeds."""
    frame = sys._getframe(0).f_back  # caller: _record_sql
    while frame is not None:
        fn = frame.f_code.co_filename.replace("\\", "/")
        if "/source/" in fn and not fn.endswith("connector.py"):
            return os.path.splitext(os.path.basename(fn))[0]
        frame = frame.f_back
    return None


def _record_sql(sql: str, params: Any, started: float, rows: int | None) -> None:
    log = _sql_capture.get()
    if log is None:
        return
    if isinstance(params, dict):
        shown = {k: str(v) for k, v in params.items()}
    elif params:
        shown = {str(i): str(v) for i, v in enumerate(params)}
    else:
        shown = None
    log.append({
        "sql": textwrap.dedent(sql).strip(),
        "params": shown,
        "duration_ms": round((time.perf_counter() - started) * 1000, 1),
        "rows": rows,
        "source": _source_tag(),
    })
# -----------------------------------------------------------------------------


# --- Connection pool ---------------------------------------------------------
# Opening a warehouse connection costs seconds (TLS handshake on a
# high-latency link) while a query round trip is ~0.2s, so sessions are reused
# across requests. Borrowing re-issues SET statement_timeout, which doubles as
# a liveness ping; read-only/autocommit are session-level and survive reuse.
# Sized for a full cold panel open: overview's three engines plus the other
# tabs warming in parallel peak at ~12 concurrent sessions.
_POOL_MAX = int(_get("STOREAGENT_POOL_MAX", "16") or "16")
_POOL_IDLE_MAX_S = 600.0
_pool: list[tuple[psycopg.Connection, float]] = []  # (conn, returned_at)
_pool_lock = threading.Lock()


def _pool_borrow(timeout: str) -> psycopg.Connection | None:
    while True:
        with _pool_lock:
            if not _pool:
                return None
            conn, returned_at = _pool.pop()
        if conn.closed or time.monotonic() - returned_at > _POOL_IDLE_MAX_S:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 - best-effort cleanup
                pass
            continue
        try:
            with conn.cursor() as cur:
                cur.execute(f"SET statement_timeout = '{timeout}';")
            return conn
        except Exception:  # noqa: BLE001 - dead session; discard and try the next
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass


def _pool_release(conn: psycopg.Connection | None) -> None:
    if conn is None or conn.closed:
        return
    with _pool_lock:
        if len(_pool) < _POOL_MAX:
            _pool.append((conn, time.monotonic()))
            return
    try:
        conn.close()
    except Exception:  # noqa: BLE001
        pass


class SourceDB:
    def __init__(self, statement_timeout: str = "60s"):
        self._timeout = statement_timeout
        self._conn: psycopg.Connection | None = None

    def connect(self) -> psycopg.Connection:
        if self._conn is not None and not self._conn.closed:
            return self._conn
        conn = _pool_borrow(self._timeout)
        if conn is None:
            conn = psycopg.connect(**SOURCE.kwargs(), row_factory=dict_row)
            conn.read_only = True
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute(f"SET statement_timeout = '{self._timeout}';")
                cur.execute("SET default_transaction_read_only = on;")
                cur.execute("SET idle_in_transaction_session_timeout = '30s';")
        self._conn = conn
        return conn

    def fetch_all(self, sql: str, params: Sequence[Any] | None = None) -> list[dict]:
        started = time.perf_counter()  # TESTING-ONLY: SQL debug
        with self.connect().cursor() as cur:
            cur.execute(sql, params or ())
            rows = cur.fetchall()
        _record_sql(sql, params, started, len(rows))  # TESTING-ONLY: SQL debug
        return rows

    def fetch_one(self, sql: str, params: Sequence[Any] | None = None) -> dict | None:
        started = time.perf_counter()  # TESTING-ONLY: SQL debug
        with self.connect().cursor() as cur:
            cur.execute(sql, params or ())
            row = cur.fetchone()
        _record_sql(sql, params, started, 1 if row is not None else 0)  # TESTING-ONLY: SQL debug
        return row

    def close(self) -> None:
        # Return the session to the pool rather than closing it; connection
        # setup is the single most expensive operation against this warehouse.
        _pool_release(self._conn)
        self._conn = None

    def __enter__(self) -> "SourceDB":
        self.connect()
        return self

    def __exit__(self, *exc) -> None:
        self.close()


@contextmanager
def source_db(statement_timeout: str = "60s") -> Iterator[SourceDB]:
    db = SourceDB(statement_timeout=statement_timeout)
    try:
        db.connect()
        yield db
    finally:
        db.close()


def parallel_fetch(*thunks: Callable[[], Any]) -> list:
    """Run independent warehouse pulls concurrently, each thunk opening (or
    holding) its OWN connection — SourceDB is not thread-safe.

    The warehouse sits behind ~hundreds of ms of network round trip, so a repo
    that issues 6-9 small queries serially spends most of its wall time waiting
    on the wire. Overlapping independent chains is the single biggest speed
    lever available to a read-only client. Results come back in submission
    order; the first failure re-raises. copy_context() keeps the SQL-debug
    capture attributed to the right request across the worker threads.
    """
    if len(thunks) == 1:
        return [thunks[0]()]
    with ThreadPoolExecutor(max_workers=len(thunks)) as pool:
        futures = [pool.submit(contextvars.copy_context().run, t) for t in thunks]
        return [f.result() for f in futures]
