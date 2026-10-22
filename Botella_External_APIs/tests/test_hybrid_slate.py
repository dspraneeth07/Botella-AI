"""The hybrid slate: engine stock cards lead, model signal cards fill.

What the owner complained about, in one line: "only reorder recommendations,
the POS can do that". The engine's signal families refuse without a measured
effect; the model's signal cards were the part of the first version that
worked. These tests pin the composition rule that puts the two together, the
two safety properties it must never lose (the engine owns reorder, and a model
failure costs no engine card) and the relevance rules added after the first
live runs showed a bourbon sold as a scotch-trend pick and a game-day key on a
cigarette bundle.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.recommender import hybrid
from app.recommender.pipeline import RecommendationPipeline
from app.schemas.signals import SignalBundle


def _engine(rank: int, sku: str, action: str = "reorder") -> dict:
    category = "inventory_overstock" if action in ("markdown", "liquidate") else "inventory_understock"
    return {"rank": rank, "category": category, "action_type": action,
            "primary_skus": [sku], "rationale": f"engine {sku}",
            "signals_cited": [], "confidence": 0.6,
            "confidence_basis": "raw_ranking_score", "valid_through": "2026-11-05"}


def _model(rank: int, category: str, action: str, skus: list[str],
           cites: list[str] | None = None) -> dict:
    return {"rank": rank, "category": category, "action_type": action,
            "primary_skus": skus, "rationale": f"model {category}",
            "signals_cited": ["heat_advisory"] if cites is None else cites,
            "confidence": 0.5, "confidence_basis": "llm_stated",
            "valid_through": "2026-10-28"}


DOMAINS = {
    "heat_advisory": "weather", "cold_snap": "weather",
    "nhl_home_game": "sports", "nba_home_game": "sports",
    "event_concert": "events", "halloween": "holidays",
    "news_tariff_bourbon": "news", "trend_espresso_martini": "social",
}


# ── Composition ──────────────────────────────────────────────────────────────


def test_engine_lead_then_model_then_engine_remainder() -> None:
    engine = [_engine(i, f"E{i}") for i in range(1, 7)]
    model = [
        _model(1, "weather", "promote", ["M1"]),
        _model(2, "calendar_sports", "pre_stock", ["M2"]),
    ]
    slate = hybrid.plan(engine, model, lead_slots=4)
    order = [c["primary_skus"][0] for c in slate]
    assert order == ["E1", "E2", "E3", "E4", "M1", "M2", "E5", "E6"]
    assert [c["rank"] for c in slate] == list(range(1, 9))


def test_model_cards_carry_the_hybrid_source_and_engine_cards_do_not() -> None:
    slate = hybrid.plan([_engine(1, "E1")], [_model(1, "news", "promote", ["M1"])],
                        lead_slots=4)
    by_sku = {c["primary_skus"][0]: c for c in slate}
    assert hybrid.is_model_card(by_sku["M1"])
    assert not hybrid.is_model_card(by_sku["E1"])
    assert by_sku["E1"]["rationale"] == "engine E1"


def test_the_engine_owns_reorder_when_it_produced_one() -> None:
    engine = [_engine(1, "E1", "reorder")]
    model = [
        _model(1, "inventory_understock", "reorder", ["M1"]),
        _model(2, "weather", "promote", ["M2"]),
    ]
    slate = hybrid.plan(engine, model, lead_slots=4)
    assert [c["primary_skus"][0] for c in slate] == ["E1", "M2"]


def test_the_model_covers_a_stock_category_only_where_the_engine_was_silent() -> None:
    engine = [_engine(1, "E1", "reorder")]
    model = [
        _model(1, "inventory_overstock", "markdown", ["M1"]),
        _model(2, "inventory_understock", "reorder", ["M2"]),
    ]
    slate = hybrid.plan(engine, model, lead_slots=4)
    assert [c["primary_skus"][0] for c in slate] == ["E1", "M1"]
    slate = hybrid.plan(engine, model, lead_slots=4, stock_fallback=False)
    assert [c["primary_skus"][0] for c in slate] == ["E1"]


def test_an_empty_engine_slate_lets_the_model_cover_everything() -> None:
    model = [
        _model(1, "inventory_understock", "reorder", ["M1"]),
        _model(2, "inventory_overstock", "markdown", ["M2"]),
        _model(3, "bundle", "bundle", ["M3", "M4"]),
    ]
    slate = hybrid.plan([], model, lead_slots=4)
    assert [c["primary_skus"][0] for c in slate] == ["M1", "M2", "M3"]


def test_a_model_card_that_only_repeats_the_engine_is_dropped() -> None:
    engine = [_engine(1, "E1")]
    model = [
        _model(1, "weather", "promote", ["E1"]),          # all engine SKUs: gone
        _model(2, "bundle", "bundle", ["E1", "M1"]),      # one half left: a bundle needs two, gone
        _model(3, "calendar_sports", "endcap", ["E1", "M2"]),  # keeps the half it owns
        _model(4, "new_arrival", "stock_new", []),         # SKU-less: passes through
    ]
    slate = hybrid.plan(engine, model, lead_slots=4)
    assert [c["primary_skus"] for c in slate] == [["E1"], ["M2"], []]


def test_model_cards_do_not_repeat_each_other_and_a_bundle_keeps_two_skus() -> None:
    model = [
        _model(1, "calendar_sports", "pre_stock", ["TITOS"], cites=["nhl_home_game"]),
        _model(2, "bundle", "bundle", ["FORDS", "TITOS"], cites=[]),          # loses Tito's: dropped whole
        _model(3, "bundle", "bundle", ["GIN", "TONIC", "TITOS"], cites=[]),   # keeps two: stays
        _model(4, "weather", "promote", ["TITOS"]),                            # repeat: dropped
    ]
    slate = hybrid.plan([], model, lead_slots=4)
    assert [c["primary_skus"] for c in slate] == [["TITOS"], ["GIN", "TONIC"]]


def test_categories_outside_the_allowed_set_are_refused() -> None:
    model = [_model(1, "weather", "promote", ["M1"]),
             _model(2, "news", "promote", ["M2"])]
    slate = hybrid.plan([], model, lead_slots=4, signal_categories=("news",))
    assert [c["primary_skus"][0] for c in slate] == ["M2"]


def test_non_dict_model_output_is_ignored() -> None:
    slate = hybrid.plan([_engine(1, "E1")], ["junk", None, 3], lead_slots=4)  # type: ignore[list-item]
    assert [c["primary_skus"][0] for c in slate] == ["E1"]


# ── Relevance ────────────────────────────────────────────────────────────────


def test_a_weather_card_must_cite_a_weather_key() -> None:
    model = [
        _model(1, "weather", "promote", ["M1"], cites=["nhl_home_game", "trend_espresso_martini"]),
        _model(2, "weather", "promote", ["M2"], cites=["heat_advisory", "nhl_home_game"]),
    ]
    slate = hybrid.plan([], model, lead_slots=4, key_domains=DOMAINS)
    assert [c["primary_skus"][0] for c in slate] == ["M2"]
    # The game key did not drive a weather card; it is removed, not shown.
    assert slate[0]["signals_cited"] == ["heat_advisory"]


def test_calendar_cards_accept_holidays_games_and_events_and_nothing_else() -> None:
    model = [
        _model(1, "calendar_sports", "pre_stock", ["M1"], cites=["halloween"]),
        _model(2, "calendar_sports", "endcap", ["M2"], cites=["event_concert", "understock"]),
        _model(3, "calendar_sports", "promote", ["M3"], cites=["heat_advisory"]),
    ]
    slate = hybrid.plan([], model, lead_slots=4, key_domains=DOMAINS)
    assert [c["primary_skus"][0] for c in slate] == ["M1", "M2"]
    # An inventory fact may ride along with the real driver.
    assert slate[1]["signals_cited"] == ["event_concert", "understock"]


def test_a_bundle_loses_a_decorative_game_key_but_keeps_its_facts() -> None:
    model = [_model(1, "bundle", "bundle", ["M1", "M2"],
                    cites=["nfl_home_game", "co_purchase", "nhl_home_game"])]
    slate = hybrid.plan([], model, lead_slots=4, key_domains=DOMAINS)
    # nfl_home_game is not a key this bundle has; nhl_home_game is real and stays.
    assert slate[0]["signals_cited"] == ["co_purchase", "nhl_home_game"]


def test_a_trending_card_must_name_a_product_that_matches_the_trend() -> None:
    model = [
        _model(1, "social_trending", "promote", ["WOODFORD"], cites=["trend_espresso_martini"]),
        _model(2, "social_trending", "promote", ["KETEL_ESPRESSO", "WOODFORD"],
               cites=["trend_espresso_martini"]),
        _model(3, "social_trending", "stock_new", [], cites=["trend_espresso_martini"]),
    ]
    slate = hybrid.plan([], model, lead_slots=4, key_domains=DOMAINS,
                        trend_skus={"KETEL_ESPRESSO"})
    assert [c["primary_skus"] for c in slate] == [["KETEL_ESPRESSO"], []]


def test_trend_matching_skus_uses_the_slice_and_the_name() -> None:
    cands = [
        SimpleNamespace(sku="A", slice="social_trend", product_name="Anything"),
        SimpleNamespace(sku="B", slice="bestseller", product_name="Ketel One Espresso Martini"),
        SimpleNamespace(sku="C", slice="bestseller", product_name="Woodford Reserve Double Oaked"),
    ]
    assert hybrid.trend_matching_skus(cands, ["espresso martini", "sc"]) == {"A", "B"}


def test_an_overstock_card_with_a_visibility_action_becomes_a_markdown() -> None:
    model = [
        _model(1, "inventory_overstock", "endcap", ["M1"], cites=["overstock_severe"]),
        _model(2, "inventory_overstock", "liquidate", ["M2"], cites=["overstock_severe"]),
        _model(3, "inventory_overstock", "bundle", ["M3", "M4"], cites=["overstock_mild"]),
    ]
    slate = hybrid.plan([], model, lead_slots=4)
    assert [c["action_type"] for c in slate] == ["markdown", "liquidate", "bundle"]


def test_tobacco_and_lottery_never_reach_a_model_card() -> None:
    names = {"MARL": "MARLBORO GLD", "SCOTCH": "Dimple Pinch 15yr", "LOTTO": "Scratch Off $5",
             "VODKA": "Titos 1L"}
    pos = {"VODKA": "Vodka", "ICE": "Ice / Supplies"}
    model = [
        _model(1, "calendar_sports", "endcap", ["MARL", "SCOTCH"], cites=["nhl_home_game"]),  # keeps the scotch
        _model(2, "weather", "promote", ["LOTTO"]),                                 # gone
        _model(3, "weather", "promote", ["ICE"]),                                   # gone, by category
        _model(4, "weather", "promote", ["VODKA"]),                                 # fine
        _model(5, "bundle", "bundle", ["MARL", "VODKA"], cites=[]),                # cigarette half gone, one left: gone
    ]
    slate = hybrid.plan([], model, lead_slots=4, product_names=names, pos_categories=pos)
    assert [c["primary_skus"] for c in slate] == [["SCOTCH"], ["VODKA"]]


def test_is_non_beverage_vocabulary() -> None:
    assert hybrid.is_non_beverage("American Spirit Orange Pack")
    assert hybrid.is_non_beverage("Black & Mild Wine")
    assert hybrid.is_non_beverage("Anything", "Tobacco")
    # A drink named after an animal that is also a cigarette brand is a drink.
    assert not hybrid.is_non_beverage("Old Camel Hump Rye 750ml", "Whiskey")
    assert not hybrid.is_non_beverage("Casamigos Reposado 1.75L", "Tequila")
    assert not hybrid.is_non_beverage("Ice Cold Beer Lager 6pk", "Beer")


def test_signal_bundle_names_every_citable_key_by_domain() -> None:
    bundle = SignalBundle.model_validate({
        "weather": {"summary": "Hot", "high_f": 95.0},
        "sports": [{"league": "nhl", "home": "Stars", "away": "Kings", "date": "2026-10-23",
                    "is_local_home": True}],
        "holidays": [{"name": "Halloween", "date": "2026-10-31", "days_away": 9,
                      "key": "halloween"}],
        "news": [{"headline": "Tariffs", "category": "spirits", "key": "news_tariff",
                  "impact": "price_increase_risk"}],
        "social": [{"term": "espresso martini", "source": "google_trends",
                    "key": "trend_espresso_martini"}],
        "active_keys": ["heat_advisory", "nhl_home_game", "halloween", "news_tariff",
                        "trend_espresso_martini"],
    })
    domains = bundle.citable_keys_by_domain()
    assert domains["heat_advisory"] == "weather"
    assert domains["nhl_home_game"] == "sports"
    assert domains["halloween"] == "holidays"
    assert domains["news_tariff"] == "news"
    assert domains["trend_espresso_martini"] == "social"


# ── The prompt addendum ──────────────────────────────────────────────────────


def test_the_addendum_names_what_the_engine_covered_and_withholds_its_categories() -> None:
    text = hybrid.prompt_addendum([_engine(1, "E1", "reorder")], {"E1": "Titos 1L"})
    assert "E1 (Titos 1L)" in text
    assert "Do NOT produce inventory_understock picks" in text
    assert "inventory_overstock" in text.split("Spend your budget on these categories:")[1]
    text = hybrid.prompt_addendum([], {})
    assert "Do NOT" not in text
    assert "inventory_understock" in text and "inventory_overstock" in text


def test_the_addendum_asks_for_trending_and_new_arrival_picks_when_the_lines_exist() -> None:
    text = hybrid.prompt_addendum([], {}, has_trend_lines=True, has_new_lines=True)
    assert "include social_trending picks" in text
    assert "include at least one new_arrival pick" in text
    assert "NO-LOSS RULES" in text and "RELEVANCE RULES" in text
    text = hybrid.prompt_addendum([], {})
    assert "include social_trending picks" not in text


# ── The pipeline seam ────────────────────────────────────────────────────────


class _Ctx:
    catalogue: dict = {}
    candidates: list = []
    signals = None


@pytest.mark.asyncio
async def test_no_anthropic_client_means_the_engine_slate_is_returned_untouched() -> None:
    pipe = RecommendationPipeline.__new__(RecommendationPipeline)
    pipe._anthropic = None
    engine = [_engine(1, "E1")]
    assert await pipe._hybrid_model_cards(engine, _Ctx(), 1, 2) is engine


@pytest.mark.asyncio
async def test_a_model_failure_costs_no_engine_card(settings) -> None:
    """The 29 September property: the component that chooses stock cards is
    the engine, and nothing the model does can take those away."""
    pipe = RecommendationPipeline.__new__(RecommendationPipeline)
    pipe._anthropic = object()
    pipe._settings = settings

    class _Boom:
        async def recommend(self, prompt):  # noqa: ANN001
            raise RuntimeError("billing")

    pipe._llm = _Boom()
    engine = [_engine(1, "E1"), _engine(2, "E2")]
    assert await pipe._hybrid_model_cards(engine, _Ctx(), 1, 2) is engine
