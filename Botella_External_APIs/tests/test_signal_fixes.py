"""Tests for the signal-layer correctness fixes: news query scoping, news
keyword precision, weather alert filtering, and sports geo-locality."""

from __future__ import annotations

from app.config import Settings
from app.schemas.signals import GameSignal, NewsSignal
from app.schemas.store import StoreProfile
from app.signals.news import build_query, keys_for_news
from app.signals.sports import is_local_game, localize
from app.signals.weather import _is_impactful


def _settings(**kw: object) -> Settings:
    return Settings(node_api_base_url="http://node.test", anthropic_api_key="x", **kw)


# ----- news query -----------------------------------------------------------


def test_news_query_without_state_is_topics_only() -> None:
    q = build_query(None)
    assert q.startswith("tariff OR")
    assert "AND" not in q


def test_news_query_scopes_with_and_not_or() -> None:
    q = build_query("NY")
    assert q.endswith('AND "New York"')
    assert q.startswith("(")  # topics are parenthesized so AND binds correctly


def test_news_query_oregon_is_not_malformed() -> None:
    # The old behavior produced "... OR OR" for Oregon stores.
    q = build_query("OR")
    assert "OR OR" not in q
    assert '"Oregon"' in q


def test_news_query_unknown_state_falls_back_to_topics() -> None:
    assert build_query("ZZ") == build_query(None)


def test_news_query_broad_mode_widens_recall() -> None:
    # With the LLM analyst downstream, the source query trades precision for
    # recall: any state news OR the tracked topics.
    q = build_query("NY", broad=True)
    assert q.startswith('"New York" OR (')
    # Still never the malformed bare-abbreviation shape.
    assert "OR OR" not in build_query("OR", broad=True)


# ----- news keyword precision ------------------------------------------------


def _headline(text: str) -> NewsSignal:
    return NewsSignal(headline=text, category="general")


def test_molotov_cocktail_does_not_trigger_viral_cocktail() -> None:
    assert keys_for_news([_headline("Molotov cocktail thrown at building")]) == []


def test_viral_cocktail_phrases_trigger() -> None:
    assert keys_for_news([_headline("This viral cocktail is everywhere")]) == [
        "news_viral_cocktail"
    ]
    assert keys_for_news([_headline("New cocktail trend takes over TikTok")]) == [
        "news_viral_cocktail"
    ]


def test_festival_still_triggers() -> None:
    assert keys_for_news([_headline("Summer beer festival announced")]) == ["news_festival"]


# ----- weather alert filtering ------------------------------------------------


def test_stock_up_alerts_are_impactful() -> None:
    for event in ("Winter Storm Warning", "Blizzard Warning", "Hurricane Watch",
                  "Severe Thunderstorm Warning", "Excessive Heat Warning"):
        assert _is_impactful(event), event


def test_non_buying_alerts_are_not_impactful() -> None:
    for event in ("Air Quality Alert", "Rip Current Statement", "Flood Watch",
                  "Dense Fog Advisory", "Small Craft Advisory"):
        assert not _is_impactful(event), event


# ----- sports locality ----------------------------------------------------------


def _store(lat: float | None = None, lng: float | None = None, state: str = "NY") -> StoreProfile:
    return StoreProfile(id=1, name="S", state=state, latitude=lat, longitude=lng)


def test_buffalo_store_is_local_to_bills_not_knicks() -> None:
    buffalo = _store(lat=42.89, lng=-78.88)
    assert is_local_game("Buffalo Bills", "NY", buffalo, radius_mi=75)
    # Same state, ~290 miles away — the old state heuristic got this wrong.
    assert not is_local_game("New York Knicks", "NY", buffalo, radius_mi=75)


def test_unknown_team_falls_back_to_state_match() -> None:
    store = _store(lat=42.89, lng=-78.88)
    assert is_local_game("Expansion Team FC", "NY", store, radius_mi=75)
    assert not is_local_game("Expansion Team FC", "CA", store, radius_mi=75)


def test_no_geo_falls_back_to_state_match() -> None:
    store = _store(state="PA")
    assert is_local_game("Philadelphia Eagles", "PA", store, radius_mi=75)
    assert not is_local_game("Philadelphia Eagles", "NJ", store, radius_mi=75)


def test_localize_emits_home_game_keys_and_orders_local_first() -> None:
    games = [
        GameSignal(league="nba", home="New York Knicks", away="Boston Celtics",
                   date="2026-06-12", venue_state="NY"),
        GameSignal(league="nfl", home="Buffalo Bills", away="Miami Dolphins",
                   date="2026-06-14", venue_state="NY"),
    ]
    buffalo = _store(lat=42.89, lng=-78.88)
    localized, keys = localize(games, buffalo, _settings())
    assert keys == ["nfl_home_game"]
    # Non-local games are dropped entirely, not just flagged: only the Bills
    # home game survives for a Buffalo store.
    assert [g.home for g in localized] == ["Buffalo Bills"]
    assert localized[0].is_local_home


# ── Sports: venue-local dates + series collapsing ────────────────────────────

def test_local_date_uses_venue_timezone_not_utc() -> None:
    """A 7:15pm Atlanta game is 23:15Z; the UTC date is the NEXT day, which is
    what made one series look like it had two games on the same date."""
    from app.signals.sports import local_date

    assert local_date("2026-07-20T23:15Z", "Atlanta Braves") == "2026-07-20"
    # Late Pacific start crosses midnight UTC but is still a Jul 20 game.
    assert local_date("2026-07-21T02:10Z", "Los Angeles Dodgers") == "2026-07-20"
    # Unknown team falls back to Eastern rather than raw UTC.
    assert local_date("2026-07-20T23:15Z", "Expansion Team") == "2026-07-20"
    # Unparseable input degrades to the original string, never raises.
    assert local_date("not-a-date", "Atlanta Braves") == "not-a-date"


def test_collapse_series_merges_one_matchup_into_one_signal() -> None:
    """The store-19 case: a 4-game homestand is ONE chip, not four."""
    from app.schemas.signals import GameSignal
    from app.signals.sports import _collapse_series

    series = [
        GameSignal(league="mlb", home="Atlanta Braves", away="San Diego Padres",
                   date=d, is_local_home=True)
        for d in ("2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23")
    ]
    collapsed = _collapse_series(series)
    assert len(collapsed) == 1
    assert collapsed[0].games == 4
    assert collapsed[0].date == "2026-07-20"
    assert collapsed[0].end_date == "2026-07-23"


def test_collapse_series_merges_split_sets_but_not_opponents() -> None:
    """One chip per matchup: a doubleheader AND a rematch later in the window
    fold into the same signal, so the owner never reads a fixture twice.
    A different opponent is a genuinely distinct signal and stays separate."""
    from app.schemas.signals import GameSignal
    from app.signals.sports import _collapse_series

    games = [
        GameSignal(league="mlb", home="Braves", away="Padres", date="2026-07-20"),
        GameSignal(league="mlb", home="Braves", away="Padres", date="2026-07-20"),
        GameSignal(league="mlb", home="Braves", away="Padres", date="2026-07-25"),
        GameSignal(league="mlb", home="Braves", away="Mets", date="2026-07-21"),
    ]
    collapsed = _collapse_series(games)
    assert len(collapsed) == 2  # Padres (all 3), Mets (1)

    padres = next(g for g in collapsed if g.away == "Padres")
    assert padres.games == 3
    assert padres.date == "2026-07-20" and padres.end_date == "2026-07-25"

    mets = next(g for g in collapsed if g.away == "Mets")
    assert mets.games == 1 and mets.end_date is None


def test_is_local_game_state_fallback_normalizes_names() -> None:
    """ESPN sends 'GEORGIA', profiles carry 'GA' — the fallback must match."""
    from app.schemas.store import StoreProfile
    from app.signals.sports import is_local_game

    store = StoreProfile(id=1, state="GA")  # no geo -> state fallback
    assert is_local_game("Expansion Team", "GEORGIA", store, 40.0) is True
    assert is_local_game("Expansion Team", "GA", store, 40.0) is True
    assert is_local_game("Expansion Team", "TEXAS", store, 40.0) is False


def test_sports_distance_disclosed_and_stadium_tiered() -> None:
    # Store-171 case: a game ~35 straight-line miles out (a ~45-mile drive) is
    # IN the team's market (watch-party demand) but the stadium is NOT nearby.
    # The distance rides the signal so prose can never claim proximity.
    games = [GameSignal(league="nfl", home="Buffalo Bills", away="Miami Dolphins",
                        date="2026-06-14", venue_state="NY")]
    # ~0.5 deg east of the Bills metro ≈ 25-30 straight-line miles.
    far_side_of_metro = _store(lat=42.89, lng=-78.30)
    localized, keys = localize(games, far_side_of_metro, _settings())
    assert keys == ["nfl_home_game"]
    g = localized[0]
    assert g.is_local_home
    assert g.distance_mi is not None and 20 < g.distance_mi < 40
    assert not g.stadium_nearby  # market game, not a foot-traffic game

    next_door = _store(lat=42.89, lng=-78.88)
    localized2, _ = localize(games, next_door, _settings())
    assert localized2[0].stadium_nearby
    assert localized2[0].distance_mi < 10


def test_sports_prompt_line_shows_metro_distance_not_proximity() -> None:
    from app.recommender.prompt_builder import format_signals
    from app.schemas.signals import SignalBundle

    market_game = GameSignal(
        league="nfl", home="Buffalo Bills", away="Miami Dolphins",
        date="2026-06-14", venue_state="NY", is_local_home=True,
        distance_mi=34.6, stadium_nearby=False,
    )
    text = format_signals(SignalBundle(sports=[market_game]))
    assert "metro ~35mi away" in text
    assert "STADIUM NEARBY" not in text

    close_game = market_game.model_copy(
        update={"distance_mi": 3.2, "stadium_nearby": True})
    text2 = format_signals(SignalBundle(sports=[close_game]))
    assert "STADIUM NEARBY ~3mi" in text2

def test_bare_festival_mentions_do_not_trigger() -> None:
    # A supply-risk story mentioning "festival season" once emitted the
    # demand-up news_festival key; only crowd-gathering festival phrases count.
    assert keys_for_news([_headline("Film festival canceled amid controversy")]) == []
    assert keys_for_news(
        [_headline("Disease may pause wine imports during festival season")]
    ) == []


async def test_fetch_dedupes_syndicated_titles() -> None:
    from app.signals import news as news_mod

    results = [{"title": "Same wire story", "category": ["general"]}] * 3 + [
        {"title": f"Unique story {i}", "category": ["general"]} for i in range(11)
    ]

    class _Resp:
        status_code = 200

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"results": results}

    class _Http:
        async def get(self, url: str, params: dict | None = None) -> _Resp:
            return _Resp()

    store = StoreProfile(id=1, state="TX")
    signals, _keys = await news_mod.fetch(
        store, _Http(), _settings(newsdata_api_key="k"), broad=True  # type: ignore[arg-type]
    )
    headlines = [s.headline for s in signals]
    assert headlines.count("Same wire story") == 1  # syndicated copies collapse
    assert len(headlines) == 10  # the cap fills from later unique items


# ----- gather_signals: analyst-kept keyword keys only -------------------------


async def _gather_with_news(monkeypatch, fetched, analyze_result) -> object:
    """gather_signals with every source but news stubbed out."""
    from types import SimpleNamespace

    from app.signals import (
        email_news,
        events,
        gather_signals,
        holidays,
        news,
        news_analyst,
        sports,
        weather,
    )

    async def _fake_news(store, http, settings, *, broad=False):
        return fetched, news.keys_for_news(fetched)

    async def _fake_analyze(signals, client, settings):
        return analyze_result

    async def _none(*a, **k):
        return None, []

    async def _empty_pair(*a, **k):
        return [], []

    async def _empty_list(*a, **k):
        return []

    monkeypatch.setattr(news, "fetch", _fake_news)
    monkeypatch.setattr(news_analyst, "analyze", _fake_analyze)
    monkeypatch.setattr(weather, "fetch", _none)
    monkeypatch.setattr(sports, "fetch_national", _empty_list)
    monkeypatch.setattr(events, "fetch", _empty_pair)
    monkeypatch.setattr(holidays, "fetch", _empty_pair)
    monkeypatch.setattr(email_news, "fetch", _empty_list)

    store = StoreProfile(id=1, state="TX")
    return await gather_signals(
        store, http=None, settings=_settings(),  # type: ignore[arg-type]
        anthropic_client=SimpleNamespace(),  # type: ignore[arg-type]
    )


async def test_dropped_headline_leaves_no_orphan_keyword_key(monkeypatch) -> None:
    # The Spain-wine shape: a broad-fetch headline matches "wine festival",
    # but the analyst drops it as irrelevant. Its demand key must NOT survive.
    fetched = [_headline("Disease fears cancel the wine festival this year")]
    bundle = await _gather_with_news(monkeypatch, fetched, ([], [], [], []))
    assert "news_festival" not in bundle.active_keys


async def test_supply_direction_kept_item_gets_no_demand_keyword_key(monkeypatch) -> None:
    # The analyst KEEPS the headline but as supply_risk: the demand-up
    # news_festival key must not ride along; only the analyst's key does.
    kept = [
        _headline("Disease in Spain may pause wine imports during wine festival season")
        .model_copy(update={"impact": "supply_risk", "key": "news_spain_wine_pause"})
    ]
    bundle = await _gather_with_news(
        monkeypatch,
        [_headline("Disease in Spain may pause wine imports during wine festival season")],
        (kept, ["news_spain_wine_pause"], ["wine"], ["rioja"]),
    )
    assert "news_spain_wine_pause" in bundle.active_keys
    assert "news_festival" not in bundle.active_keys


async def test_analyst_error_keeps_the_keyword_floor(monkeypatch) -> None:
    # analyze's fail-soft path returns unanalyzed signals (key=None): the
    # keyword floor still applies, as before the change.
    fetched = [_headline("Downtown wine festival returns this weekend")]
    bundle = await _gather_with_news(monkeypatch, fetched, (fetched, [], [], []))
    assert "news_festival" in bundle.active_keys
