"""Track-2 tests: the geo-keyed shared signal cache."""

from __future__ import annotations

import asyncio

from app.clients.signal_cache import SignalCache


async def test_caches_and_reuses_by_key() -> None:
    calls = {"n": 0}

    async def factory() -> str:
        calls["n"] += 1
        return "value"

    cache = SignalCache(enabled=True, ttl_seconds=100, clock=lambda: 0.0)
    a = await cache.get_or_fetch("weather", "40.7,-74.0", factory)
    b = await cache.get_or_fetch("weather", "40.7,-74.0", factory)
    assert a == b == "value"
    assert calls["n"] == 1  # second call served from cache


async def test_distinct_keys_fetch_separately() -> None:
    calls = {"n": 0}

    async def factory() -> int:
        calls["n"] += 1
        return calls["n"]

    cache = SignalCache(enabled=True, ttl_seconds=100, clock=lambda: 0.0)
    await cache.get_or_fetch("weather", "a", factory)
    await cache.get_or_fetch("weather", "b", factory)  # different key
    await cache.get_or_fetch("sports", "a", factory)  # different namespace
    assert calls["n"] == 3


async def test_per_call_ttl_override() -> None:
    now = {"t": 0.0}
    calls = {"n": 0}

    async def factory() -> int:
        calls["n"] += 1
        return calls["n"]

    cache = SignalCache(enabled=True, ttl_seconds=100, clock=lambda: now["t"])
    # Entry stored with a short override expires on its own clock, not the
    # cache-wide TTL (the daily email must be fresh per run).
    await cache.get_or_fetch("email_news", "global", factory, ttl_seconds=10)
    now["t"] = 5.0
    await cache.get_or_fetch("email_news", "global", factory, ttl_seconds=10)
    assert calls["n"] == 1  # still live
    now["t"] = 11.0
    await cache.get_or_fetch("email_news", "global", factory, ttl_seconds=10)
    assert calls["n"] == 2  # expired well before the cache-wide 100s
    # Non-positive override bypasses caching for the call entirely.
    await cache.get_or_fetch("email_news", "global", factory, ttl_seconds=0)
    assert calls["n"] == 3


async def test_ttl_expiry_refetches() -> None:
    now = {"t": 0.0}
    calls = {"n": 0}

    async def factory() -> int:
        calls["n"] += 1
        return calls["n"]

    cache = SignalCache(enabled=True, ttl_seconds=10, clock=lambda: now["t"])
    await cache.get_or_fetch("weather", "k", factory)
    now["t"] = 5.0
    await cache.get_or_fetch("weather", "k", factory)  # still live
    assert calls["n"] == 1
    now["t"] = 11.0
    await cache.get_or_fetch("weather", "k", factory)  # expired -> refetch
    assert calls["n"] == 2


async def test_single_flight_dedupes_concurrent_calls() -> None:
    calls = {"n": 0}
    gate = asyncio.Event()

    async def factory() -> str:
        calls["n"] += 1
        await gate.wait()  # hold the first fetch open
        return "v"

    cache = SignalCache(enabled=True, ttl_seconds=100, clock=lambda: 0.0)
    tasks = [
        asyncio.create_task(cache.get_or_fetch("weather", "k", factory)) for _ in range(5)
    ]
    await asyncio.sleep(0)  # let them all reach the lock
    gate.set()
    results = await asyncio.gather(*tasks)
    assert results == ["v"] * 5
    assert calls["n"] == 1  # only the first actually fetched


async def test_disabled_cache_bypasses() -> None:
    calls = {"n": 0}

    async def factory() -> int:
        calls["n"] += 1
        return calls["n"]

    cache = SignalCache(enabled=False, ttl_seconds=100, clock=lambda: 0.0)
    await cache.get_or_fetch("weather", "k", factory)
    await cache.get_or_fetch("weather", "k", factory)
    assert calls["n"] == 2  # nothing cached


async def test_zero_ttl_disables() -> None:
    calls = {"n": 0}

    async def factory() -> int:
        calls["n"] += 1
        return calls["n"]

    cache = SignalCache(enabled=True, ttl_seconds=0, clock=lambda: 0.0)
    await cache.get_or_fetch("weather", "k", factory)
    await cache.get_or_fetch("weather", "k", factory)
    assert calls["n"] == 2
