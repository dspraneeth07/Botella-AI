"""Signal capture: what we asked the world, what it said, and what went wrong.

The service returns recommendations, and until now that was ALL it returned
about a run. Whether a source answered, timed out, or was never configured;
which geography it was asked about; and what the upstream actually sent — none
of it survived the function call. The Node side then persisted a
display-trimmed chip list and called that the record of the day.

This module produces the rest, in two layers that answer two different
questions.

**Health** (:class:`SignalRecorder`) — per STORE, per run. "Did this source
work for this store, how long did it take, and if there is no event signal
today, is that because there are no events, because Ticketmaster timed out, or
because we never set an API key?" Those three are indistinguishable in a
SignalBundle and they mean completely different things. Recorded in
``gather_signals`` around each cached factory, where the source name and the
geo key are already known — they are literally the cache key, so health and
caching can never disagree about what was fetched.

**Raw payloads** (:class:`RawPayloadCollector`) — per GEOGRAPHY, process-wide.
The bytes the upstream sent, so a parser bug is repairable after the fact and a
backtest can re-derive signals without re-calling anything. Deliberately NOT
per store: one NWS gridpoint forecast is identical for every store on it, and
the storage table is keyed by (source, geo, date) for that reason. Attribution
to a particular store's run is therefore irrelevant — whichever run reports a
payload, it upserts to the same row.

Concurrency: a bulk run fans out many stores over ONE shared httpx client, so
the response hook cannot know which fetch it belongs to from the request alone.
A :class:`contextvars.ContextVar` set around each factory carries that — asyncio
tasks inherit context, so every request a factory makes is attributed correctly
even with thirty stores in flight.

Everything here is best-effort and swallows its own errors. Capture exists to
explain runs; it must never be the reason one fails.
"""

from __future__ import annotations

import json
import time
from collections.abc import Awaitable, Callable
from contextvars import ContextVar, Token
from dataclasses import dataclass
from datetime import UTC, date, datetime
from types import TracebackType
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

from app.logging_config import get_logger

log = get_logger(__name__)

# Scope of the geography each source's result actually varies by. Mirrors the
# CHECK constraint on signal_source_payloads.geo_scope, and the cache keys in
# app.signals.__init__ — if a source's cache key changes shape, its scope
# belongs in the same commit.
SOURCE_SCOPES: dict[str, str] = {
    "weather": "gridpoint",
    "events": "latlon",
    "sports": "global",
    "holidays": "global",
    "news": "state",
    "email_news": "global",
    "social_discovery": "global",
    "google_trends": "state",
}

# Per-response and per-row ceilings. A runaway upstream must not be able to
# push an unbounded document into memory or into the analytics row; a truncated
# body still answers "what did they send us" for every practical purpose.
MAX_BODY_BYTES = 1_000_000
MAX_REQUESTS_PER_FETCH = 12
MAX_PENDING_ROWS = 500


@dataclass
class _FetchContext:
    """The fetch currently in flight in this task, for the response hook."""

    source: str
    scope: str
    key: str
    collector: RawPayloadCollector | None


_active_fetch: ContextVar[_FetchContext | None] = ContextVar("active_fetch", default=None)


@dataclass
class SourceOutcome:
    """One source's result for one store."""

    ok: bool
    items: int | None = None
    latency_ms: int | None = None
    cache_hit: bool = False
    # Why a source produced nothing BY DESIGN — "no_api_key", "disabled",
    # "no_geo". Distinct from ok=False, which means it was supposed to work
    # and did not. Dormant sources must never be counted as failures or every
    # store reads as permanently degraded.
    dormant: str | None = None
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"ok": self.ok}
        if self.items is not None:
            out["items"] = self.items
        if self.latency_ms is not None:
            out["latency_ms"] = self.latency_ms
        if self.cache_hit:
            out["cache_hit"] = True
        if self.dormant:
            out["dormant"] = self.dormant
        if self.error:
            out["error"] = self.error
        return out


class RawPayloadCollector:
    """Process-wide buffer of raw upstream responses, keyed by geography.

    One entry per (source, scope, geo_key, date), holding EVERY HTTP response
    that logical fetch made — the weather fetch alone makes four (points,
    forecast, observations, alerts), and they only make sense together.

    ``drain`` hands the buffer to whichever run is reporting and clears it.
    Losing a drain costs at most one TTL's worth of raw bodies for that
    geography; the health record and the normalized bundle are unaffected.
    """

    def __init__(self, *, max_rows: int = MAX_PENDING_ROWS) -> None:
        self._rows: dict[tuple[str, str, str, str], dict[str, Any]] = {}
        self._max_rows = max_rows
        self._dropped = 0

    def record(
        self, ctx: _FetchContext, *, url: str, status: int | None,
        body: Any, latency_ms: int | None, error: str | None = None,
    ) -> None:
        today = date.today().isoformat()
        rk = (ctx.source, ctx.scope, ctx.key, today)
        row = self._rows.get(rk)
        if row is None:
            if len(self._rows) >= self._max_rows:
                # Full buffer: drop rather than grow without bound. Counted so
                # the condition is visible instead of silently invisible.
                self._dropped += 1
                return
            row = {
                "source": ctx.source, "geo_scope": ctx.scope, "geo_key": ctx.key,
                "fetch_date": today, "payload": {"requests": []},
                "ok": True, "item_count": 0, "http_status": None,
                "latency_ms": 0, "error": None,
            }
            self._rows[rk] = row

        requests: list = row["payload"]["requests"]
        if len(requests) < MAX_REQUESTS_PER_FETCH:
            requests.append({
                "url": url, "status": status, "body": body,
                "latency_ms": latency_ms, **({"error": error} if error else {}),
            })
        row["item_count"] = len(requests)
        row["latency_ms"] = (row["latency_ms"] or 0) + (latency_ms or 0)
        # The row's status is the LAST response's; its ok is the AND of all of
        # them, because a fetch whose forecast call succeeded and whose alerts
        # call failed is not a healthy fetch.
        row["http_status"] = status
        if error or (status is not None and status >= 400):
            row["ok"] = False
            row["error"] = error or f"HTTP {status}"

    def transport_outcome(self, ctx: _FetchContext) -> tuple[bool, str | None]:
        """Did the HTTP layer see a failure for this fetch? (ok, error)

        Exists because almost every signal fetcher is fail-soft BY DESIGN: it
        catches its own httpx error and returns an empty list so a dead source
        never sinks a run. That is the right behaviour, and it means the
        factory returns normally after a total upstream outage — so health
        based on "did the factory raise" reports ok=true for a source that
        answered 500 to every request. Observed exactly that: ESPN 500s while
        sports health read healthy with zero items, which is indistinguishable
        from a quiet sports day and is the precise confusion this whole module
        exists to remove.

        The transport layer is not fooled, so health defers to it.
        """
        row = self._rows.get((ctx.source, ctx.scope, ctx.key, date.today().isoformat()))
        if row is None:
            return True, None
        return bool(row["ok"]), row["error"]

    def drain(self) -> list[dict[str, Any]]:
        rows = list(self._rows.values())
        self._rows.clear()
        if self._dropped:
            log.warning("raw_payload_buffer_overflow", dropped=self._dropped)
            self._dropped = 0
        return rows


class SignalRecorder:
    """Per-store, per-run record of how each source behaved."""

    def __init__(self) -> None:
        self.sources: dict[str, SourceOutcome] = {}
        self.geo_keys: dict[str, dict[str, str]] = {}
        # IANA timezone for the store, when a source could tell us (NWS returns
        # it for the gridpoint it already resolves). This is what makes the
        # day key the STORE'S day rather than the server's.
        self.timezone: str | None = None
        # Where the store's coordinates came from: "profile" (Node supplied
        # them), "geocoded" (resolved from the address), or "none". Set by
        # build_context, and it is what distinguishes "quiet weather day" from
        # "we never located this store".
        self.geo_source: str | None = None

    def note(self, source: str, outcome: SourceOutcome, *, scope: str, key: str) -> None:
        self.sources[source] = outcome
        self.geo_keys[source] = {"scope": scope, "key": key}

    def dormant(self, source: str, reason: str) -> None:
        """Record a source that produced nothing by design."""
        self.sources[source] = SourceOutcome(ok=True, items=0, dormant=reason)

    def health(self) -> dict[str, dict[str, Any]]:
        return {name: o.as_dict() for name, o in self.sources.items()}


def resolve_day_key(instant: datetime, timezone: str | None) -> tuple[str, str]:
    """The store's own calendar date for ``instant``, and how we got it.

    The daily cron fires at 04:00 UTC, which is the PREVIOUS evening in every
    US timezone. Keying the day on UTC therefore labels a whole network's
    Tuesday as Wednesday. Where NWS told us the gridpoint's zone we use it;
    otherwise we fall back to UTC and say so, so no row is ever silently
    ambiguous about what "that day" meant.

    Node computes the same key the same way (dailySnapshotService.resolveDayKey)
    from the same IANA zone, so the two sides always agree.
    """
    if timezone:
        try:
            return instant.astimezone(ZoneInfo(timezone)).date().isoformat(), "store_local"
        except (ZoneInfoNotFoundError, ValueError):
            log.warning("unusable_timezone", timezone=timezone)
    return instant.astimezone(UTC).date().isoformat(), "utc"


def count_items(result: Any) -> int | None:
    """Best-effort item count for a factory result.

    Factories return wildly different shapes — a model or None (weather), a
    list, or a tuple whose first element is the list. Anything unrecognized
    returns None, which reads as "not counted" rather than as zero.
    """
    if result is None:
        return 0
    if isinstance(result, tuple):
        return count_items(result[0]) if result else 0
    if isinstance(result, (list, set, dict)):
        return len(result)
    return 1


def _truncate_body(raw: bytes) -> Any:
    """Decode a response body for storage, bounded and never raising."""
    if not raw:
        return None
    truncated = len(raw) > MAX_BODY_BYTES
    head = raw[:MAX_BODY_BYTES]
    if not truncated:
        try:
            return json.loads(head)
        except (ValueError, UnicodeDecodeError):
            pass
    text = head.decode("utf-8", errors="replace")
    return {"_raw_text": text, "_truncated": truncated, "_bytes": len(raw)}


def make_response_hook(
    collector: RawPayloadCollector,
) -> Callable[[httpx.Response], Awaitable[None]]:
    """An httpx ``response`` event hook that files bodies under the active fetch.

    Attached to the shared signal HTTP client. Requests made outside a
    registered fetch (the geocoder, the health probes) have no active context
    and are ignored — this captures SIGNALS, not every byte the process moves.

    The hook can never fail a request: every path is guarded, because an
    exception raised here would surface as a failed signal fetch and, through
    the fail-soft chain, as a store with no recommendations.
    """

    async def hook(response: httpx.Response) -> None:
        ctx = _active_fetch.get()
        if ctx is None or ctx.collector is None:
            return
        try:
            # Documented httpx pattern: the hook runs before the body is read,
            # so ask for it explicitly. Safe here because nothing streams on
            # this client (the only .stream() in the service is the Anthropic
            # SDK's, on its own client).
            await response.aread()
            elapsed_ms = None
            try:
                elapsed_ms = int(response.elapsed.total_seconds() * 1000)
            except (RuntimeError, AttributeError):
                pass  # elapsed is unavailable until the response is closed
            ctx.collector.record(
                ctx,
                url=str(response.url),
                status=response.status_code,
                body=_truncate_body(response.content),
                latency_ms=elapsed_ms,
            )
        except Exception as exc:  # noqa: BLE001 — capture must never break a run
            log.warning("raw_capture_failed", source=ctx.source, error=str(exc))

    return hook


class fetch_scope:  # noqa: N801 — used as a context manager, reads as one
    """Mark the source/geo a block of HTTP calls belongs to.

    Also times the block and files the outcome on the recorder, so a caller
    gets health and raw attribution from one ``with``.
    """

    def __init__(
        self, recorder: SignalRecorder | None, collector: RawPayloadCollector | None,
        source: str, key: str, *, scope: str | None = None,
    ) -> None:
        self._recorder = recorder
        self._source = source
        self._key = key
        self._scope = scope or SOURCE_SCOPES.get(source, "global")
        self._ctx = _FetchContext(source, self._scope, key, collector)
        self._token: Token[_FetchContext | None] | None = None
        self._started = 0.0

    def __enter__(self) -> fetch_scope:
        self._token = _active_fetch.set(self._ctx)
        self._started = time.perf_counter()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> Literal[False]:
        # Literal[False], not bool: a plain `bool` tells mypy this context
        # manager MIGHT swallow an exception, which makes every `return` after
        # a `raise` inside a `with` look unreachable to the checker (it did -
        # _maybe_cached reported a spurious "Missing return statement").
        if self._token is not None:
            _active_fetch.reset(self._token)
        return False

    @property
    def elapsed_ms(self) -> int:
        return int((time.perf_counter() - self._started) * 1000)

    def succeeded(self, result: Any, *, cache_hit: bool) -> None:
        """The factory returned. Whether that means the SOURCE worked is a
        separate question — see RawPayloadCollector.transport_outcome."""
        if self._recorder is None:
            return
        ok, error = True, None
        # A cache hit made no HTTP calls, so there is no transport verdict to
        # consult; checking anyway would attribute another store's fetch
        # failure to this one.
        if not cache_hit and self._ctx.collector is not None:
            ok, error = self._ctx.collector.transport_outcome(self._ctx)
        self._recorder.note(
            self._source,
            SourceOutcome(
                ok=ok, items=count_items(result),
                latency_ms=self.elapsed_ms, cache_hit=cache_hit,
                # "degraded" rather than a bare error: the fetcher absorbed
                # this and returned usable (if empty) data, so the run was not
                # broken — but the source did not really answer.
                error=None if ok else f"degraded: {error}",
            ),
            scope=self._scope, key=self._key,
        )

    def failed(self, exc: BaseException) -> None:
        if self._recorder is None:
            return
        self._recorder.note(
            self._source,
            SourceOutcome(
                ok=False, latency_ms=self.elapsed_ms,
                error=f"{exc.__class__.__name__}: {exc}"[:500],
            ),
            scope=self._scope, key=self._key,
        )


__all__ = [
    "RawPayloadCollector",
    "SignalRecorder",
    "SourceOutcome",
    "fetch_scope",
    "make_response_hook",
    "count_items",
    "resolve_day_key",
    "SOURCE_SCOPES",
]
