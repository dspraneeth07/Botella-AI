from __future__ import annotations

import json

import httpx
import respx

from app.config import Settings
from app.schemas.store import StoreProfile
from app.signals import google_trends

STORE = StoreProfile(id=1, name="Probe", city="Austin", state="TX")


def _settings(**overrides) -> Settings:
    defaults = {
        "social_trends_enabled": True,
        "google_trends_enabled": True,
        "google_trends_seed_terms": ["mezcal", "soju"],
        "google_trends_batch_pause_seconds": 0.0,
    }
    defaults.update(overrides)
    return Settings(**defaults)


def _api_body(payload: dict) -> str:
    # The widget API prefixes JSON with an anti-hijacking line.
    return ")]}'\n" + json.dumps(payload)


def test_momentum_rising_needs_ratio_and_floor() -> None:
    flat = [20] * 28
    surge = flat + [40] * 7
    assert google_trends.momentum_of(surge, threshold=1.25, min_interest=10) == ("rising", 40)
    # Below the absolute floor a big ratio is still noise.
    tiny = [1] * 28 + [2] * 7
    assert google_trends.momentum_of(tiny, threshold=1.25, min_interest=10)[0] == "stable"
    fade = [40] * 28 + [10] * 7
    assert google_trends.momentum_of(fade, threshold=1.25, min_interest=10)[0] == "declining"
    # Too-short series can't establish a baseline.
    assert google_trends.momentum_of([50, 60], threshold=1.25, min_interest=10)[0] == "stable"
    assert google_trends.momentum_of([], threshold=1.25, min_interest=10) == ("stable", 0)


async def test_fetch_disabled_by_default() -> None:
    async with httpx.AsyncClient() as http:
        result = await google_trends.fetch(STORE, http, Settings(social_trends_enabled=True))
    assert result == ([], [], [])


@respx.mock
async def test_fetch_keeps_only_rising_terms() -> None:
    respx.get("https://trends.google.com/trends/explore").respond(text="ok")
    explore = respx.get("https://trends.google.com/trends/api/explore").respond(
        text=_api_body(
            {"widgets": [{"id": "TIMESERIES", "token": "tok", "request": {"x": 1}}]}
        )
    )
    timeline = [{"value": [20, 20]} for _ in range(28)] + [{"value": [40, 20]} for _ in range(7)]
    respx.get("https://trends.google.com/trends/api/widgetdata/multiline").respond(
        text=_api_body({"default": {"timelineData": timeline}})
    )

    async with httpx.AsyncClient() as http:
        signals, categories, keywords = await google_trends.fetch(STORE, http, _settings())

    assert [s.term for s in signals] == ["mezcal"]  # soju stayed flat
    signal = signals[0]
    assert signal.momentum == "rising" and signal.interest == 40
    assert signal.key == "trend_mezcal" and signal.source == "google_trends"
    assert signal.evidence == "search interest rising in US-TX"
    # The store's state scoped the query.
    request_json = json.loads(dict(explore.calls.last.request.url.params)["req"])
    assert request_json["comparisonItem"][0]["geo"] == "US-TX"
    # Vocabulary terms carry their canonical token; every kept term is a hint.
    assert categories == ["mezcal"]
    assert keywords == ["mezcal"]


@respx.mock
async def test_fetch_fail_soft_on_rate_limit() -> None:
    respx.get("https://trends.google.com/trends/explore").respond(text="ok")
    respx.get("https://trends.google.com/trends/api/explore").respond(status_code=429)
    async with httpx.AsyncClient() as http:
        assert await google_trends.fetch(STORE, http, _settings()) == ([], [], [])
