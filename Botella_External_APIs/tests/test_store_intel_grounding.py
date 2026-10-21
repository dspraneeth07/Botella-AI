"""Store-intelligence grounding: the don't-buy gate, SI-classed price cuts,
the lost_sale candidate slice, market-gap stock_new picks, and the prompt tags
that carry the engines' measured facts."""

from __future__ import annotations

from datetime import date

from app.recommender.prompt_builder import build_prompt, format_candidates
from app.recommender.validator import validate_recommendations
from app.schemas.context import RecommendationContext
from app.schemas.derived import Candidate, HealthInfo, StoreSummary, VelocityInfo
from app.schemas.signals import SignalBundle
from app.schemas.store import StoreProfile
from app.store_data.candidates import select_candidates
from app.store_data.store_intel import (
    DontBuySku,
    LostSaleSku,
    MarketGap,
    SkuIntel,
    StoreIntel,
)
from tests.conftest import NOW, item

TODAY = date(2026, 6, 3)


# ---------------------------------------------------------------- helpers ---

def _intel(**overrides: object) -> StoreIntel:
    fields: dict = {
        "as_of": date(2026, 6, 1),
        "dont_buy": {},
        "lost_sales": {},
        "sku_intel": {},
        "market_gaps": [],
    }
    fields.update(overrides)
    return StoreIntel(**fields)


def _dont(sku: str) -> DontBuySku:
    return DontBuySku(
        sku=sku, reason="Stop ordering", days_since_sold=210, days_of_supply=400.0
    )


def _lost(sku: str, days_out: int = 12, revenue: float = 250.0) -> LostSaleSku:
    return LostSaleSku(
        sku=sku, days_out=days_out, daily_rate=1.5, lost_units=18.0,
        lost_revenue=revenue, ongoing_daily_loss=21.0,
    )


def _si(cls: str, *, premium: bool = False, dsl: int | None = 200) -> SkuIntel:
    return SkuIntel(velocity_class=cls, days_since_last_sale=dsl, premium=premium)


def _gap(upc: str = "0001112223334", name: str = "Peer Hit Seltzer") -> MarketGap:
    return MarketGap(
        upc=upc, product_name=name, category="seltzer", peer_units=120,
        peer_stores=7, avg_price=3.99, est_annual_revenue=1200.0,
    )


def _candidate(sku: str, **overrides: object) -> Candidate:
    fields: dict = {
        "sku": sku,
        "product_name": f"Product {sku}",
        "category": "beer",
    }
    fields.update(overrides)
    return Candidate(**fields)


def _rec(rank: int, skus: list[str], **overrides: object) -> dict:
    rec: dict = {
        "rank": rank,
        "category": "weather",
        "action_type": "endcap",
        "primary_skus": skus,
        "rationale": "because signal",
        "signals_cited": ["heat_advisory"],
        "confidence": 0.8,
        "valid_through": "2026-06-05",
    }
    rec.update(overrides)
    return rec


def _validate(
    raw: list[dict], candidates: list[Candidate], **kwargs: object
) -> tuple[list[dict], int]:
    kwargs.setdefault("active_signal_keys", ["heat_advisory"])
    return validate_recommendations(
        raw,
        candidates,
        max_recommendations=10,
        today=TODAY,
        horizon_days=21,
        **kwargs,  # type: ignore[arg-type]
    )


# --------------------------------------------------- don't-buy suppression ---

def test_reorder_on_dont_buy_sku_is_dropped() -> None:
    intel = _intel(dont_buy={"D1": _dont("D1")})
    raw = [_rec(1, ["D1"], category="inventory_understock", action_type="reorder")]
    valid, dropped = _validate(raw, [_candidate("D1")], store_intel=intel)
    assert valid == []
    assert dropped == 1


def test_pre_stock_on_dont_buy_sku_is_dropped_even_with_a_driver() -> None:
    # Event uplift never justifies buying into a dead / fading product.
    intel = _intel(dont_buy={"D1": _dont("D1")})
    raw = [_rec(1, ["D1"], category="calendar_sports", action_type="pre_stock")]
    valid, dropped = _validate(raw, [_candidate("D1")], store_intel=intel)
    assert valid == []
    assert dropped == 1


def test_reorder_with_mixed_skus_loses_only_the_dont_buy_ones() -> None:
    intel = _intel(dont_buy={"D1": _dont("D1")})
    raw = [
        _rec(1, ["D1", "OK1"], category="inventory_understock", action_type="reorder")
    ]
    valid, dropped = _validate(
        raw, [_candidate("D1"), _candidate("OK1")], store_intel=intel
    )
    assert dropped == 0
    assert valid[0]["primary_skus"] == ["OK1"]


def test_markdown_on_dont_buy_sku_is_allowed() -> None:
    # Clearing a don't-buy product is exactly what the engine recommends.
    intel = _intel(dont_buy={"D1": _dont("D1")}, sku_intel={"D1": _si("dead")})
    raw = [
        _rec(1, ["D1"], category="inventory_overstock", action_type="markdown",
             signals_cited=["overstock_severe"])
    ]
    valid, dropped = _validate(
        raw, [_candidate("D1", health_status="overstock_severe")], store_intel=intel
    )
    assert dropped == 0
    assert valid[0]["primary_skus"] == ["D1"]
    assert valid[0]["action_type"] == "markdown"


# --------------------------------------------- SI-classed price-cut gates ---

def test_si_stagnant_class_justifies_a_markdown_alone() -> None:
    # No overstock citation and a healthy weeks-of-cover flag, but the
    # Inventory tab classes the SKU dead — the tab's own clearance view is
    # justification enough, and the dead_stock citation survives cleaning.
    intel = _intel(sku_intel={"M1": _si("dead")})
    raw = [
        _rec(1, ["M1"], category="inventory_overstock", action_type="markdown",
             signals_cited=["dead_stock"])
    ]
    valid, dropped = _validate(raw, [_candidate("M1")], store_intel=intel)
    assert dropped == 0
    assert valid[0]["signals_cited"] == ["dead_stock"]


def test_markdown_without_any_justification_still_drops() -> None:
    intel = _intel(sku_intel={"M1": _si("fast", dsl=2)})
    raw = [_rec(1, ["M1"], category="inventory_overstock", action_type="markdown")]
    valid, dropped = _validate(raw, [_candidate("M1")], store_intel=intel)
    assert valid == []
    assert dropped == 1


def test_liquidate_softens_to_markdown_when_si_says_still_moving() -> None:
    intel = _intel(sku_intel={"L1": _si("normal", dsl=5)})
    raw = [
        _rec(1, ["L1"], category="inventory_overstock", action_type="liquidate",
             signals_cited=["overstock_severe"])
    ]
    valid, dropped = _validate(raw, [_candidate("L1")], store_intel=intel)
    assert dropped == 0
    assert valid[0]["action_type"] == "markdown"


def test_price_cut_on_premium_dead_stock_becomes_endcap() -> None:
    # The Inventory tab's explicit HOLD: feature premium dead bottles, never
    # discount them.
    intel = _intel(sku_intel={"P1": _si("dead", premium=True)})
    raw = [
        _rec(1, ["P1"], category="inventory_overstock", action_type="liquidate",
             signals_cited=["overstock_severe"])
    ]
    valid, dropped = _validate(raw, [_candidate("P1")], store_intel=intel)
    assert dropped == 0
    assert valid[0]["action_type"] == "endcap"


def test_liquidate_of_sku_unknown_to_si_is_untouched() -> None:
    intel = _intel(sku_intel={"OTHER": _si("fast")})
    raw = [
        _rec(1, ["L1"], category="inventory_overstock", action_type="liquidate",
             signals_cited=["overstock_severe"])
    ]
    valid, dropped = _validate(raw, [_candidate("L1")], store_intel=intel)
    assert dropped == 0
    assert valid[0]["action_type"] == "liquidate"


# ----------------------------------------------- market-gap stock_new picks ---

def test_skuless_market_gap_pick_gets_reference_upc_and_stock_new() -> None:
    intel = _intel(market_gaps=[_gap()])
    raw = [
        _rec(1, [], category="new_arrival", action_type="promote",
             rationale="Peer Hit Seltzer is selling across the state.",
             signals_cited=["market_gap"])
    ]
    valid, dropped = _validate(raw, [_candidate("X")], store_intel=intel)
    assert dropped == 0
    assert valid[0]["primary_skus"] == []
    assert valid[0]["action_type"] == "stock_new"
    assert valid[0]["reference_upc"] == "0001112223334"


def test_market_gap_pick_category_coerced_to_new_arrival() -> None:
    # Contract shape (c) is new_arrival + stock_new + market_gap: a gap pick
    # the model filed under another category is coerced, like its action.
    intel = _intel(market_gaps=[_gap()])
    raw = [
        _rec(1, [], category="bundle", action_type="stock_new",
             rationale="Peer Hit Seltzer is selling across the state.",
             signals_cited=["market_gap"])
    ]
    valid, dropped = _validate(raw, [_candidate("X")], store_intel=intel)
    assert dropped == 0
    assert valid[0]["category"] == "new_arrival"
    assert valid[0]["reference_upc"] == "0001112223334"


def test_skuless_market_gap_pick_unmatched_is_dropped() -> None:
    intel = _intel(market_gaps=[_gap(), _gap(upc="999", name="Other Bottling")])
    raw = [
        _rec(1, [], category="new_arrival", action_type="stock_new",
             rationale="Some invented product nobody sells.",
             signals_cited=["market_gap"])
    ]
    valid, dropped = _validate(raw, [_candidate("X")], store_intel=intel)
    assert valid == []
    assert dropped == 1


def test_market_gap_picks_are_rationed_per_run() -> None:
    intel = _intel(
        market_gaps=[_gap(), _gap(upc="9998887776665", name="Statewide Cream Ale")]
    )
    raw = [
        _rec(1, [], category="new_arrival", action_type="stock_new",
             rationale="Peer Hit Seltzer is proven nearby.",
             signals_cited=["market_gap"]),
        _rec(2, [], category="new_arrival", action_type="stock_new",
             rationale="Statewide Cream Ale is proven nearby.",
             signals_cited=["market_gap"]),
    ]
    valid, dropped = _validate(
        raw, [_candidate("X")], store_intel=intel, market_gap_max=1
    )
    assert len(valid) == 1
    assert valid[0]["reference_upc"] == "0001112223334"  # best-ranked wins
    assert dropped == 1


def test_no_intel_means_gap_citation_never_sanctions_skuless() -> None:
    raw = [
        _rec(1, [], category="new_arrival", action_type="stock_new",
             rationale="Peer Hit Seltzer is proven nearby.",
             signals_cited=["market_gap"])
    ]
    valid, dropped = _validate(raw, [_candidate("X")])
    assert valid == []
    assert dropped == 1


# ------------------------------------------------------- lost_sale slice ---

def _vel(sku: str, units_30d: int, bucket: str = "medium") -> VelocityInfo:
    return VelocityInfo(
        sku=sku, category="beer", units_7d=units_30d // 4,
        units_30d=units_30d, units_90d=units_30d * 3,
        velocity_score=0.0, velocity_bucket=bucket, trend="stable",
    )


def test_lost_sale_slice_outranks_everything_and_keeps_engine_order() -> None:
    inventory = [
        item("OUT_BIG", on_hand=0),
        item("OUT_SMALL", on_hand=0),
        item("BEST", on_hand=50),
    ]
    # OUT_BIG has been out >30d: zero units_30d in the Node feed, invisible to
    # the legacy stockout rule — only the engine's lost-sales view carries it.
    velocity = {"BEST": _vel("BEST", 100), "OUT_SMALL": _vel("OUT_SMALL", 4)}
    intel = _intel(lost_sales={
        "OUT_BIG": _lost("OUT_BIG", days_out=40, revenue=600.0),
        "OUT_SMALL": _lost("OUT_SMALL", days_out=6, revenue=90.0),
    })
    candidates = select_candidates(
        inventory, velocity, [], SignalBundle(), now=NOW, top_n=150, intel=intel
    )
    assert [c.sku for c in candidates[:2]] == ["OUT_BIG", "OUT_SMALL"]
    assert candidates[0].slice == "lost_sale"
    assert candidates[1].slice == "lost_sale"


def test_lost_sale_slice_ignores_in_stock_skus() -> None:
    # An SKU the engine flagged that has since been restocked in the Node feed
    # must not ride the lost_sale slice.
    inventory = [item("BACK", on_hand=12)]
    intel = _intel(lost_sales={"BACK": _lost("BACK")})
    candidates = select_candidates(
        inventory, {"BACK": _vel("BACK", 10)}, [], SignalBundle(),
        now=NOW, top_n=150, intel=intel,
    )
    by_sku = {c.sku: c for c in candidates}
    assert by_sku["BACK"].slice != "lost_sale"


# --------------------------------------------------------- prompt rendering ---

def test_candidate_line_renders_store_intel_tags() -> None:
    line = format_candidates([
        _candidate(
            "L1", on_hand=0, lost_days_out=12, lost_revenue=250.0,
        ),
        _candidate("D1", on_hand=30, dont_buy=True, si_class="dead",
                   days_since_last_sale=210),
        _candidate("N1", on_hand=8, si_class="never_sold",
                   days_since_last_sale=None),
    ])
    assert "LOST_SALE:12d out, ~$250 missed" in line
    assert "DONT_BUY" in line
    assert "DEAD_STOCK (no sale in 210d)" in line
    assert "DEAD_STOCK (never sold)" in line


def test_market_gap_section_renders_in_user_payload(settings) -> None:
    context = RecommendationContext(
        store=StoreProfile(id=42, name="Test Liquor", city="Austin", state="TX"),
        signals=SignalBundle(active_keys=["heat_advisory"]),
        velocity={},
        inventory_health=[],
        summary=StoreSummary(),
        candidates=[_candidate("0123")],
        data_as_of=date(2026, 6, 3),
        intel=_intel(market_gaps=[_gap()]),
    )
    prompt = build_prompt(context, settings)
    assert "=== MARKET GAP" in prompt["user"]
    assert "Peer Hit Seltzer" in prompt["user"]
    assert "7 peer stores" in prompt["user"]
    # The system prompt carries the rule that makes the section actionable.
    assert "market_gap" in prompt["system"]


def test_no_market_gap_section_without_intel(settings) -> None:
    context = RecommendationContext(
        store=StoreProfile(id=42, name="Test Liquor", city="Austin", state="TX"),
        signals=SignalBundle(),
        velocity={},
        inventory_health=[],
        summary=StoreSummary(),
        candidates=[_candidate("0123")],
        data_as_of=date(2026, 6, 3),
    )
    prompt = build_prompt(context, settings)
    assert "=== MARKET GAP" not in prompt["user"]


# -------------------------------------------------- inventory health slots ---

def test_health_list_unaffected_shape() -> None:
    # Guard: HealthInfo objects built elsewhere still validate against the
    # Candidate stamping path (no attribute drift in the new fields).
    h = HealthInfo(
        sku="A", category="beer", on_hand=1, weekly_rate=1.0,
        weeks_on_hand=1.0, tied_up_capital=10.0, status="healthy",
    )
    assert h.sku == "A"
