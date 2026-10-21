"""In-process, geo-keyed cache for external signals shared across stores.

External signals are shared by geography, not by store: weather is per NWS
gridpoint, sports/holidays are per state (or global), events are per lat/long +
radius. In a daily run that fans out ~1,200 stores, fetching each signal once
per *store* makes thousands of redundant external calls and risks tripping
free-tier caps (Ticketmaster allows only 5,000/day). This cache collapses those
to one fetch per distinct geo key.

Two properties matter:

* **TTL** — entries expire so a long-lived process picks up fresh data on the
  next daily run (default 6h, longer than any single run, shorter than a day).
* **Single-flight** — when many stores in the same area ask for the same key
  concurrently, only the first triggers the fetch; the rest await its result.
  Without this, a 30-wide fan-out would still make 30 identical weather calls
  before the first one populated the cache.

This is intentionally in-process (no Redis dependency). With multiple workers
each holds its own cache, which still removes nearly all redundancy within a
worker's slice of the fan-out. Swapping in a shared backend later only requires
reimplementing ``get_or_fetch``.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import TypeVar

from app.logging_config import get_logger

log = get_logger(__name__)

T = TypeVar("T")


class SignalCache:
    """Async TTL cache with per-key single-flight locking.

    ``clock`` is injectable so tests can advance time deterministically; it
    defaults to a monotonic clock (immune to wall-clock adjustments).
    """

    def __init__(
        self,
        *,
        enabled: bool = True,
        ttl_seconds: float = 21600.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._enabled = enabled and ttl_seconds > 0
        self._ttl = ttl_seconds
        self._clock = clock
        self._store: dict[str, tuple[float, object]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._guard = asyncio.Lock()

    async def _lock_for(self, key: str) -> asyncio.Lock:
        async with self._guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[key] = lock
            return lock

    def _live(self, key: str) -> tuple[bool, object]:
        entry = self._store.get(key)
        if entry is None:
            return False, None
        expires_at, value = entry
        if self._clock() >= expires_at:
            self._store.pop(key, None)
            return False, None
        return True, value

    async def get_or_fetch(
        self,
        namespace: str,
        key: str,
        factory: Callable[[], Awaitable[T]],
        *,
        ttl_seconds: float | None = None,
    ) -> T:
        """Return a cached value for ``namespace:key`` or compute it via ``factory``.

        Disabled cache (or non-positive TTL) bypasses storage entirely and just
        awaits ``factory`` — useful for tests and for turning the optimization
        off via config without changing call sites.

        ``ttl_seconds`` overrides the cache-wide TTL for this entry — for
        sources that must be re-read on every run (the daily email) rather
        than shared across runs (weather, the national sports schedule). A
        non-positive override bypasses caching for the call entirely.
        """
        ttl = self._ttl if ttl_seconds is None else ttl_seconds
        if not self._enabled or ttl <= 0:
            return await factory()

        full_key = f"{namespace}:{key}"
        hit, value = self._live(full_key)
        if hit:
            return value  # type: ignore[return-value]

        lock = await self._lock_for(full_key)
        async with lock:
            # Re-check under the lock: a concurrent caller may have populated it
            # while we waited (single-flight — only the first does the fetch).
            hit, value = self._live(full_key)
            if hit:
                return value  # type: ignore[return-value]

            result = await factory()
            self._store[full_key] = (self._clock() + ttl, result)
            return result
