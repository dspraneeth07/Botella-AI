"""ESPN scoreboard windowing — the date-range regression and its guard."""
from __future__ import annotations

from datetime import UTC, datetime

import httpx
import respx

from app.config import Settings
from app.signals import sports

NOW = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)
# Both scoreboard hosts must be mocked: the client falls back to the
# mirror when the primary fails, and an unmocked mirror hides that.
SCOREBOARD = r"https://site\.(?:web\.)?api\.espn\.com/apis/site/v2/sports/football/nfl/scoreboard"


def _settings(**overrides) -> Settings:
    defaults = {"signal_lookahead_days": 3, "sports_leagues": ["nfl"]}
    defaults.update(overrides)
    return Settings(**defaults)


def _event(event_id: str, date: str, home: str, away: str) -> dict:
    return {
        "id": event_id,
        "date": date,
        "competitions": [{
            "venue": {"fullName": "Soldier Field", "address": {"state": "il"}},
            "competitors": [
                {"homeAway": "home", "team": {"displayName": home}},
                {"homeAway": "away", "team": {"displayName": away}},
            ],
        }],
    }


@respx.mock
async def test_window_is_walked_one_day_at_a_time() -> None:
    # ESPN 400s dates=START-END on both hosts now; only single dates work.
    # Asserting on the params proves we never send a range again.
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        dates = request.url.params.get("dates", "")
        seen.append(dates)
        if "-" in dates:
            return httpx.Response(400, json={"error": "bad range"})
        return httpx.Response(200, json={"events": [
            _event(f"e{dates}", "2026-09-20T17:00Z", "Chicago Bears", "Minnesota Vikings"),
        ]})

    respx.get(url__regex=SCOREBOARD).mock(side_effect=handler)

    async with httpx.AsyncClient() as http:
        games = await sports._fetch_league("nfl", http, NOW, _settings())

    assert seen == ["20260916", "20260917", "20260918", "20260919"]
    assert all("-" not in d for d in seen)
    assert len(games) == 4


@respx.mock
async def test_repeated_fixtures_across_days_collapse_to_one() -> None:
    # A single-date query can answer with a whole NFL week, so the same game
    # arrives under several days and must not be counted more than once.
    respx.get(url__regex=SCOREBOARD).mock(
        return_value=httpx.Response(200, json={"events": [
            _event("same-game", "2026-09-20T17:00Z", "Chicago Bears", "Minnesota Vikings"),
        ]})
    )

    async with httpx.AsyncClient() as http:
        games = await sports._fetch_league("nfl", http, NOW, _settings())

    assert len(games) == 1
    assert games[0].home == "Chicago Bears"


@respx.mock
async def test_one_bad_day_does_not_lose_the_league() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("dates") == "20260917":
            return httpx.Response(500)
        return httpx.Response(200, json={"events": [
            _event(f"e{request.url.params.get('dates')}", "2026-09-20T17:00Z",
                   "Chicago Bears", "Minnesota Vikings"),
        ]})

    respx.get(url__regex=SCOREBOARD).mock(side_effect=handler)

    async with httpx.AsyncClient() as http:
        games = await sports._fetch_league("nfl", http, NOW, _settings())

    assert len(games) == 3  # the other three days still land


@respx.mock
async def test_every_day_failing_yields_no_games() -> None:
    respx.get(url__regex=SCOREBOARD).mock(return_value=httpx.Response(400))

    async with httpx.AsyncClient() as http:
        games = await sports._fetch_league("nfl", http, NOW, _settings())

    assert games == []
