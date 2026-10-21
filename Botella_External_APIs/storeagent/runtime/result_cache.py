"""Shared per-process TTL cache + single-flight for capability results.

The overview action queue and the standalone capability endpoints used to
compute the same engines independently, so a cold "Store Intelligence" open
did nearly double the warehouse work (inventory/buying/market once for the
Daily Report, then again for their tabs). Both paths now share this cache:
whoever asks for a key first computes it, concurrent askers for the same key
wait for that computation instead of duplicating it, and later askers within
the TTL get the cached value instantly.

Keys are ``(capability, client_id, location_id, narrate)`` so the action
queue's engine runs are byte-identical cache entries to the tabs' capability
results.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable

TTL_S = 600.0  # matches the old api/service.py cache

_lock = threading.Lock()
_results: dict[tuple, tuple[float, Any]] = {}
_inflight: dict[tuple, threading.Event] = {}


def get_or_compute(key: tuple, factory: Callable[[], Any], ttl_s: float = TTL_S) -> Any:
    while True:
        with _lock:
            hit = _results.get(key)
            if hit and time.monotonic() - hit[0] < ttl_s:
                return hit[1]
            ev = _inflight.get(key)
            if ev is None:
                ev = threading.Event()
                _inflight[key] = ev
                break  # this thread computes
        ev.wait()  # someone else is computing this key; re-check when done
    try:
        value = factory()
        with _lock:
            _results[key] = (time.monotonic(), value)
        return value
    finally:
        # On failure the key is simply released: the next asker retries.
        with _lock:
            _inflight.pop(key, None)
        ev.set()


def put(key: tuple, value: Any) -> None:
    """Overwrite an entry (used by explicit nocache refreshes so everyone
    downstream sees the fresh result rather than a stale TTL hit)."""
    with _lock:
        _results[key] = (time.monotonic(), value)


def clear() -> None:
    with _lock:
        _results.clear()
