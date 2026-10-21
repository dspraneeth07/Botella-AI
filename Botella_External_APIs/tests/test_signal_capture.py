"""Signal-capture tests: health, raw payloads, day keys, and isolation.

The properties under test are the ones whose failure would be invisible: a
capture layer that quietly mislabels a degraded source, misdates a day, or
leaks one store's fetch into another's record still returns recommendations
and still looks fine in a log.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import httpx
import pytest

from app.clients.signal_cache import SignalCache
from app.config import get_settings
from app.schemas.store import StoreProfile
from app.signals import gather_signals
from app.signals.capture import (
    RawPayloadCollector,
    SignalRecorder,
    count_items,
    fetch_scope,
    make_response_hook,
    resolve_day_key,
)

STORE = StoreProfile(
    id=46, name="T", state="TX", country="US", latitude=32.7801, longitude=-96.8005
)

POINTS = {
    "properties": {
        "timeZone": "America/Chicago",
        "forecast": "https://api.weather.gov/gridpoints/FWD/1,1/forecast",
        "observationStations": "https://api.weather.gov/gridpoints/FWD/1,1/stations",
    }
}
FORECAST = {
    "properties": {
        "periods": [
            {"startTime": "2026-09-21T06:00:00-05:00", "isDaytime": True,
             "temperature": 99, "shortForecast": "Hot"},
            {"startTime": "2026-09-21T18:00:00-05:00", "isDaytime": False,
             "temperature": 70, "shortForecast": "Clear"},
        ]
    }
}


def _handler(*, espn_status: int = 200):
    def handle(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/points/" in url:
            return httpx.Response(200, json=POINTS)
        if "/forecast" in url:
            return httpx.Response(200, json=FORECAST)
        if "/alerts/active" in url or "/stations" in url:
            return httpx.Response(200, json={"features": []})
        if "espn" in url:
            return httpx.Response(espn_status, json={"events": []})
        return httpx.Response(200, json={})
    return handle


def _client(collector: RawPayloadCollector, **kw) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.MockTransport(_handler(**kw)),
        event_hooks={"response": [make_response_hook(collector)]},
    )


# ── Day keys ────────────────────────────────────────────────────────────────

def test_day_key_uses_the_stores_own_calendar_day() -> None:
    """04:00 UTC - the rec cron's hour - is the PREVIOUS day across the US.

    Keying on UTC would label the whole network's Tuesday as Wednesday.
    """
    at = datetime(2026, 9, 22, 4, 0, tzinfo=UTC)
    assert resolve_day_key(at, "America/Chicago") == ("2026-09-21", "store_local")
    assert resolve_day_key(at, "America/New_York") == ("2026-09-22", "store_local")
    assert resolve_day_key(at, "America/Los_Angeles") == ("2026-09-21", "store_local")


def test_day_key_falls_back_to_utc_and_says_so() -> None:
    at = datetime(2026, 9, 22, 4, 0, tzinfo=UTC)
    assert resolve_day_key(at, None) == ("2026-09-22", "utc")
    # An unusable zone must degrade, not raise - and must not claim to be local.
    assert resolve_day_key(at, "Mars/Olympus") == ("2026-09-22", "utc")


def test_day_key_matches_node_across_a_dst_boundary() -> None:
    """Both sides key the day from the same IANA zone, so they must agree
    even where the offset changes. 2026-11-01 is the US DST fall-back."""
    before = datetime(2026, 11, 1, 5, 30, tzinfo=UTC)   # 00:30 CDT (UTC-5)
    after = datetime(2026, 11, 1, 7, 30, tzinfo=UTC)    # 01:30 CST (UTC-6)
    assert resolve_day_key(before, "America/Chicago") == ("2026-11-01", "store_local")
    assert resolve_day_key(after, "America/Chicago") == ("2026-11-01", "store_local")


# ── count_items ─────────────────────────────────────────────────────────────

def test_count_items_handles_every_factory_shape() -> None:
    assert count_items(None) == 0
    assert count_items([1, 2, 3]) == 3
    assert count_items(([1, 2], ["k"])) == 2      # (signals, keys) tuple
    assert count_items((None, [])) == 0           # weather: no signal
    assert count_items(object()) == 1             # a bare model


# ── Health ──────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_health_records_each_source_with_geo_key() -> None:
    collector = RawPayloadCollector()
    recorder = SignalRecorder()
    async with _client(collector) as http:
        await gather_signals(
            STORE, http, get_settings(), cache=SignalCache(enabled=False),
            recorder=recorder, collector=collector,
        )

    health = recorder.health()
    assert "weather" in health and health["weather"]["ok"] is True
    # The geo key is the CACHE key, so health can never disagree with what
    # was actually fetched.
    assert recorder.geo_keys["weather"] == {"scope": "gridpoint", "key": "32.78,-96.8"}
    assert recorder.geo_keys["sports"]["scope"] == "global"
    assert recorder.geo_keys["news"]["scope"] == "state"


@pytest.mark.asyncio
async def test_timezone_is_lifted_from_the_nws_points_lookup() -> None:
    collector = RawPayloadCollector()
    recorder = SignalRecorder()
    async with _client(collector) as http:
        bundle = await gather_signals(
            STORE, http, get_settings(), cache=SignalCache(enabled=False),
            recorder=recorder, collector=collector,
        )
    assert recorder.timezone == "America/Chicago"
    assert bundle.weather is not None
    assert bundle.weather.timezone == "America/Chicago"


@pytest.mark.asyncio
async def test_a_failsoft_source_is_reported_degraded_not_healthy() -> None:
    """The regression this layer exists for.

    Nearly every fetcher swallows its own HTTP error and returns [] so a dead
    source never sinks a run. That makes "ESPN 500ed on every request" and
    "no games today" produce identical bundles. Health must not repeat the
    confusion: the transport verdict wins.
    """
    collector = RawPayloadCollector()
    recorder = SignalRecorder()
    async with _client(collector, espn_status=500) as http:
        await gather_signals(
            STORE, http, get_settings(), cache=SignalCache(enabled=False),
            recorder=recorder, collector=collector,
        )
    sports = recorder.health()["sports"]
    assert sports["ok"] is False
    assert "500" in sports["error"]
    # ...while a source that really did answer stays healthy.
    assert recorder.health()["weather"]["ok"] is True


@pytest.mark.asyncio
async def test_dormant_sources_are_not_counted_as_failures() -> None:
    """A store with no coordinates has no weather BY DESIGN. Recording that as
    a failure would make every such store read as permanently broken."""
    collector = RawPayloadCollector()
    recorder = SignalRecorder()
    nogeo = StoreProfile(id=1, name="T", state="TX", country="US")
    async with _client(collector) as http:
        await gather_signals(
            nogeo, http, get_settings(), cache=SignalCache(enabled=False),
            recorder=recorder, collector=collector,
        )
    assert recorder.health()["weather"] == {"ok": True, "items": 0, "dormant": "no_geo"}
    assert recorder.health()["events"]["dormant"] == "no_geo"


# ── Raw payloads ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_raw_payloads_group_every_request_of_one_logical_fetch() -> None:
    collector = RawPayloadCollector()
    recorder = SignalRecorder()
    async with _client(collector) as http:
        await gather_signals(
            STORE, http, get_settings(), cache=SignalCache(enabled=False),
            recorder=recorder, collector=collector,
        )
    rows = {r["source"]: r for r in collector.drain()}
    weather = rows["weather"]
    assert weather["geo_scope"] == "gridpoint"
    assert weather["geo_key"] == "32.78,-96.8"
    # points + forecast + stations + alerts, in one row: they only mean
    # anything together.
    assert len(weather["payload"]["requests"]) == 4
    assert weather["payload"]["requests"][0]["body"] == POINTS


@pytest.mark.asyncio
async def test_a_failed_upstream_is_still_recorded() -> None:
    """"We asked and got a 500" is the fact worth keeping; a missing row
    would be indistinguishable from never having asked."""
    collector = RawPayloadCollector()
    async with _client(collector, espn_status=503) as http:
        await gather_signals(
            STORE, http, get_settings(), cache=SignalCache(enabled=False),
            recorder=SignalRecorder(), collector=collector,
        )
    sports = next(r for r in collector.drain() if r["source"] == "sports")
    assert sports["ok"] is False
    assert sports["error"] == "HTTP 503"


@pytest.mark.asyncio
async def test_drain_clears_the_buffer() -> None:
    collector = RawPayloadCollector()
    async with _client(collector) as http:
        await gather_signals(
            STORE, http, get_settings(), cache=SignalCache(enabled=False),
            recorder=SignalRecorder(), collector=collector,
        )
    assert collector.drain()      # first drain carries the rows
    assert collector.drain() == []  # second must not re-report them


def test_buffer_is_bounded() -> None:
    """A runaway fan-out must not grow the buffer without limit."""
    collector = RawPayloadCollector(max_rows=2)
    for i in range(5):
        with fetch_scope(None, collector, "weather", f"key{i}") as span:
            collector.record(span._ctx, url="u", status=200, body={}, latency_ms=1)
    assert len(collector.drain()) == 2


@pytest.mark.asyncio
async def test_requests_outside_a_fetch_are_ignored() -> None:
    """The hook captures SIGNALS. The geocoder and health probes share the
    client and must not land in the signal record."""
    collector = RawPayloadCollector()
    async with _client(collector) as http:
        await http.get("https://api.weather.gov/points/1,1")  # no active fetch
    assert collector.drain() == []


# ── Isolation ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_concurrent_stores_do_not_cross_contaminate_health() -> None:
    """Bulk runs share one HTTP client. Attribution rides a ContextVar, so
    each store's task tree must see only its own fetches."""
    collector = RawPayloadCollector()
    recorders = [SignalRecorder() for _ in range(3)]
    stores = [
        StoreProfile(id=i, name=f"S{i}", state="TX", country="US",
                     latitude=32.0 + i, longitude=-96.0 - i)
        for i in range(3)
    ]
    async with _client(collector) as http:
        await asyncio.gather(*(
            gather_signals(
                s, http, get_settings(), cache=SignalCache(enabled=False),
                recorder=r, collector=collector,
            )
            for s, r in zip(stores, recorders, strict=True)
        ))

    # Each store recorded its OWN gridpoint, not a neighbour's.
    keys = [r.geo_keys["weather"]["key"] for r in recorders]
    assert keys == ["32.0,-96.0", "33.0,-97.0", "34.0,-98.0"]
    assert len(set(keys)) == 3


@pytest.mark.asyncio
async def test_capture_is_optional_and_changes_nothing() -> None:
    """Passing no recorder/collector must reproduce the previous behaviour
    exactly - capture is additive, never a change to what is fetched."""
    collector = RawPayloadCollector()
    async with _client(collector) as http:
        settings = get_settings()
        with_capture = await gather_signals(
            STORE, http, settings, cache=SignalCache(enabled=False),
            recorder=SignalRecorder(), collector=collector,
        )
        without = await gather_signals(
            STORE, http, settings, cache=SignalCache(enabled=False),
        )
    assert with_capture.model_dump() == without.model_dump()


@pytest.mark.asyncio
async def test_a_broken_hook_never_fails_the_request() -> None:
    """Capture must not be able to take a run down with it."""
    class Exploding(RawPayloadCollector):
        def record(self, *a, **kw):  # type: ignore[override]
            raise RuntimeError("boom")

    collector = Exploding()
    async with _client(collector) as http:
        bundle = await gather_signals(
            STORE, http, get_settings(), cache=SignalCache(enabled=False),
            recorder=SignalRecorder(), collector=collector,
        )
    # The run completed and the weather signal still arrived.
    assert bundle.weather is not None
