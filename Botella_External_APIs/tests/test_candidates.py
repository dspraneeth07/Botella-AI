from __future__ import annotations

from app.schemas.derived import HealthInfo, VelocityInfo
from app.schemas.signals import SignalBundle
from app.store_data.candidates import select_candidates
from tests.conftest import NOW, item


def _vel(sku: str, units_30d: int, trend: str = "stable", bucket: str = "medium") -> VelocityInfo:
    return VelocityInfo(
        sku=sku, category="beer_mexican", units_7d=units_30d // 4,
        units_30d=units_30d, units_90d=units_30d * 3,
        velocity_score=0.0, velocity_bucket=bucket, trend=trend,
    )


def _health(sku: str, status: str, weeks: float | None = 5.0) -> HealthInfo:
    return HealthInfo(
        sku=sku, category="beer_mexican", on_hand=10, weekly_rate=2.0,
        weeks_on_hand=weeks, tied_up_capital=100.0, status=status,
    )


def test_slices_dedup_and_priority() -> None:
    inventory = [
        item("UNDER", category="beer_mexican", on_hand=2),
        item("OVER", category="beer_mexican", on_hand=200, price=20),
        item("BEST", category="beer_mexican", on_hand=50),
        item("RISER", category="beer_mexican", on_hand=30),
    ]
    velocity = {
        "UNDER": _vel("UNDER", 40, bucket="high"),
        "OVER": _vel("OVER", 1, bucket="low"),
        "BEST": _vel("BEST", 100, bucket="very_high"),
        "RISER": _vel("RISER", 25, trend="rising"),
    }
    health = [
        _health("UNDER", "understock", weeks=0.3),
        _health("OVER", "overstock_severe", weeks=30.0),
        _health("BEST", "healthy"),
        _health("RISER", "healthy"),
    ]
    # heat_advisory maps to beer_mexican among others, so signal_aligned applies.
    signals = SignalBundle(active_keys=["heat_advisory"])

    candidates = select_candidates(inventory, velocity, health, signals, now=NOW, top_n=150)

    skus = [c.sku for c in candidates]
    assert len(skus) == len(set(skus))  # deduped
    assert set(skus) == {"UNDER", "OVER", "BEST", "RISER"}

    by_sku = {c.sku: c for c in candidates}
    # Slice priority: understock is evaluated first.
    assert by_sku["UNDER"].slice == "understock"
    assert by_sku["OVER"].slice == "overstock"


def test_proven_skus_get_their_own_slice() -> None:
    inventory = [
        item("PROVEN1", category="beer_mexican", on_hand=20),
        item("PLAIN", category="beer_mexican", on_hand=20),
    ]
    velocity = {"PROVEN1": _vel("PROVEN1", 5), "PLAIN": _vel("PLAIN", 5)}
    health = [_health("PROVEN1", "healthy"), _health("PLAIN", "healthy")]

    candidates = select_candidates(
        inventory, velocity, health, SignalBundle(), now=NOW, proven_skus={"PROVEN1"}
    )
    by_sku = {c.sku: c for c in candidates}
    # The proven slice outranks bestseller in dedup priority, so the winner
    # carries the "proven" label (rendered as a PROVEN tag in the prompt).
    assert by_sku["PROVEN1"].slice == "proven"
    assert by_sku["PLAIN"].slice != "proven"


def test_proven_sku_out_of_stock_is_not_resurrected() -> None:
    inventory = [item("GONE", category="beer", on_hand=0)]
    candidates = select_candidates(
        inventory, {}, [], SignalBundle(), now=NOW, proven_skus={"GONE"}
    )
    assert candidates == []


def test_news_keywords_create_news_match_slice() -> None:
    inventory = [
        item("RIOJA", category="wine_red", on_hand=12, name="Marques de Caceres Rioja Reserva"),
        item("NAPA", category="wine_red", on_hand=12, name="Napa Valley Cabernet"),
    ]
    velocity = {"RIOJA": _vel("RIOJA", 4), "NAPA": _vel("NAPA", 4)}
    health = [_health("RIOJA", "healthy"), _health("NAPA", "healthy")]
    signals = SignalBundle(
        active_keys=["news_tariff_spain_wine"],
        news_categories=["wine"],
        news_product_keywords=["rioja", "cava"],
    )

    candidates = select_candidates(inventory, velocity, health, signals, now=NOW)
    by_sku = {c.sku: c for c in candidates}
    # The name-matched import gets the news slice (rendered NEWS_MATCH);
    # the unaffected domestic wine is still eligible via news_categories
    # but lands in an ordinary slice.
    assert by_sku["RIOJA"].slice == "news_match"
    assert by_sku["NAPA"].slice != "news_match"
    assert "NAPA" in by_sku  # category-wide eligibility still applies


def test_only_in_stock_products_are_candidates() -> None:
    inventory = [item("ZERO", on_hand=0), item("STOCKED", on_hand=5)]
    velocity = {"STOCKED": _vel("STOCKED", 10)}
    health = [_health("STOCKED", "healthy")]
    candidates = select_candidates(inventory, velocity, health, SignalBundle(), now=NOW)
    assert [c.sku for c in candidates] == ["STOCKED"]


def test_respects_top_n_cap() -> None:
    inventory = [item(f"S{i}", on_hand=5) for i in range(50)]
    velocity = {f"S{i}": _vel(f"S{i}", i) for i in range(50)}
    health = [_health(f"S{i}", "healthy") for i in range(50)]
    candidates = select_candidates(inventory, velocity, health, SignalBundle(), now=NOW, top_n=10)
    assert len(candidates) == 10


def test_new_arrival_slices_split_by_performance() -> None:
    inventory = [
        # New (4 days) and selling fast -> new_hot.
        item("HOTNEW", category="beer_mexican", on_hand=20, created_days_ago=4),
        # New (4 days) but barely selling -> plain new.
        item("SLOWNEW", category="beer_mexican", on_hand=20, created_days_ago=4),
        # Added long ago -> not new at all.
        item("OLD", category="beer_mexican", on_hand=20, created_days_ago=200),
        # No first-seen date (baseline catalog) -> never new.
        item("BASELINE", category="beer_mexican", on_hand=20),
    ]
    velocity = {
        "HOTNEW": _vel("HOTNEW", 18, trend="rising"),
        "SLOWNEW": _vel("SLOWNEW", 2),
        "OLD": _vel("OLD", 18, trend="rising"),
        "BASELINE": _vel("BASELINE", 3),
    }
    health = [_health(s, "healthy") for s in ("HOTNEW", "SLOWNEW", "OLD", "BASELINE")]

    candidates = select_candidates(inventory, velocity, health, SignalBundle(), now=NOW)
    by_sku = {c.sku: c for c in candidates}

    assert by_sku["HOTNEW"].slice == "new_hot"
    assert by_sku["SLOWNEW"].slice == "new"
    assert by_sku["OLD"].slice not in ("new", "new_hot")
    assert by_sku["BASELINE"].slice not in ("new", "new_hot")


def test_new_hot_outranks_bestseller_label() -> None:
    # A new arrival that would also top the bestseller slice keeps the NEW_HOT
    # label - slice priority places new_hot before bestseller.
    inventory = [item("STAR", category="beer", on_hand=30, created_days_ago=5)]
    velocity = {"STAR": _vel("STAR", 60, trend="rising", bucket="very_high")}
    health = [_health("STAR", "healthy")]

    candidates = select_candidates(inventory, velocity, health, SignalBundle(), now=NOW)
    assert candidates[0].slice == "new_hot"


def test_new_hot_requires_volume_floor() -> None:
    # Rising trend on 3 units/30d is noise, not a hot new product.
    inventory = [item("TRICKLE", category="beer", on_hand=10, created_days_ago=4)]
    velocity = {"TRICKLE": _vel("TRICKLE", 3, trend="rising")}
    health = [_health("TRICKLE", "healthy")]

    candidates = select_candidates(inventory, velocity, health, SignalBundle(), now=NOW)
    assert candidates[0].slice == "new"


def test_naive_created_at_does_not_crash_selection() -> None:
    # A naive datetime from a non-Node caller is coerced to UTC by the schema.
    from datetime import datetime as _dt

    from tests.conftest import TODAY

    naive_item = item("NAIVE", category="beer", on_hand=10)
    naive_item = naive_item.model_copy(
        update={"created_at": _dt.fromordinal(TODAY.toordinal() - 3)}
    )
    naive_item = type(naive_item).model_validate(naive_item.model_dump())
    velocity = {"NAIVE": _vel("NAIVE", 2)}
    health = [_health("NAIVE", "healthy")]

    candidates = select_candidates([naive_item], velocity, health, SignalBundle(), now=NOW)
    assert candidates[0].slice == "new"


def test_area_winner_skus_get_their_own_slice() -> None:
    inventory = [
        item("LOCALHIT", category="rtd", on_hand=15),
        item("PLAIN2", category="rtd", on_hand=15),
    ]
    velocity = {"LOCALHIT": _vel("LOCALHIT", 10), "PLAIN2": _vel("PLAIN2", 10)}
    health = [_health("LOCALHIT", "healthy"), _health("PLAIN2", "healthy")]

    candidates = select_candidates(
        inventory, velocity, health, SignalBundle(), now=NOW,
        area_winner_skus={"LOCALHIT"},
    )
    by_sku = {c.sku: c for c in candidates}
    assert by_sku["LOCALHIT"].slice == "area_winner"
    assert by_sku["PLAIN2"].slice != "area_winner"


def test_order_due_skus_get_the_reorder_due_slice() -> None:
    # Week-ahead notice: the canonical engine ranked these two as due within
    # 7 days; they surface in their own slice even while "healthy", most
    # urgent first, and non-due products never borrow the tag.
    inventory = [
        item("DUE1", category="rtd", on_hand=20),
        item("DUE2", category="rtd", on_hand=20),
        item("NOTDUE", category="rtd", on_hand=20),
    ]
    velocity = {s: _vel(s, 10) for s in ("DUE1", "DUE2", "NOTDUE")}
    health = [_health(s, "healthy") for s in ("DUE1", "DUE2", "NOTDUE")]

    candidates = select_candidates(
        inventory, velocity, health, SignalBundle(), now=NOW,
        order_due_ranked=["DUE2", "DUE1", "GHOST"],  # unknown skus ignored
    )
    by_sku = {c.sku: c for c in candidates}
    assert by_sku["DUE1"].slice == "reorder_due"
    assert by_sku["DUE2"].slice == "reorder_due"
    assert by_sku["NOTDUE"].slice != "reorder_due"
    # Ranked order preserved (DUE2 was more urgent upstream).
    due = [c.sku for c in candidates if c.slice == "reorder_due"]
    assert due == ["DUE2", "DUE1"]


def test_understock_outranks_reorder_due_on_the_same_sku() -> None:
    # A SKU that is both understocked and order-due keeps the stronger
    # understock flag (slice order encodes priority; dedup keeps first).
    inventory = [item("BOTH", category="rtd", on_hand=2)]
    velocity = {"BOTH": _vel("BOTH", 30)}
    health = [_health("BOTH", "understock")]
    candidates = select_candidates(
        inventory, velocity, health, SignalBundle(), now=NOW,
        order_due_ranked=["BOTH"],
    )
    assert candidates[0].slice == "understock"

def test_price_tier_is_category_relative() -> None:
    # $20 is the CHEAPEST wine here but would look "expensive" next to beer —
    # the tier must say value/mid for it, and premium only for the top of its
    # own category. This is the deterministic ground under the prompt's
    # "never call a $20 wine costly" rule.
    inventory = [
        item(f"W{i}", category="wine_red", on_hand=5, price=p, name=f"Wine {i}")
        for i, p in enumerate([20, 35, 45, 60, 90, 120])
    ] + [
        item(f"B{i}", category="beer_mexican", on_hand=5, price=p, name=f"Beer {i}")
        for i, p in enumerate([8, 10, 12, 14, 18])
    ]
    velocity = {i.sku: _vel(i.sku, 10) for i in inventory}
    health = [_health(i.sku, "healthy") for i in inventory]
    candidates = select_candidates(inventory, velocity, health, SignalBundle(), now=NOW)
    tiers = {c.sku: c.price_tier for c in candidates}
    assert tiers["W0"] == "value"      # $20 wine = cheapest wine, NOT premium
    assert tiers["W5"] == "premium"    # $120 wine tops its cohort
    assert tiers["W2"] == "mid"
    assert tiers["B4"] == "premium"    # $18 beer IS premium among the beers


def test_price_tier_thin_cohort_stays_neutral() -> None:
    # 2 SKUs in the category and 2 in the family: no basis to call either
    # premium or value.
    inventory = [
        item("A", category="mezcal", on_hand=5, price=15),
        item("B", category="mezcal", on_hand=5, price=90),
    ]
    velocity = {i.sku: _vel(i.sku, 5) for i in inventory}
    health = [_health(i.sku, "healthy") for i in inventory]
    candidates = select_candidates(inventory, velocity, health, SignalBundle(), now=NOW)
    assert {c.price_tier for c in candidates} == {"mid"}


def test_stocked_out_recent_seller_joins_the_understock_slice() -> None:
    inventory = [
        item("EMPTY", category="beer_mexican", on_hand=0, name="Fast Empty"),
        item("FULL", category="beer_mexican", on_hand=40),
    ]
    velocity = {"EMPTY": _vel("EMPTY", 30, bucket="high"), "FULL": _vel("FULL", 10)}
    health = [
        HealthInfo(sku="EMPTY", category="beer_mexican", on_hand=0, weekly_rate=7.0,
                   weeks_on_hand=None, tied_up_capital=0.0, status="stockout"),
        _health("FULL", "healthy"),
    ]
    candidates = select_candidates(inventory, velocity, health, SignalBundle(), now=NOW)
    by_sku = {c.sku: c for c in candidates}
    assert by_sku["EMPTY"].slice == "understock"
    assert by_sku["EMPTY"].health_status == "stockout"
    # A never-seller with zero stock still stays out of the pool.
    dormant = [item("DEAD", category="beer", on_hand=0)]
    assert select_candidates(dormant, {"DEAD": _vel("DEAD", 0)}, [], SignalBundle(), now=NOW) == []


def test_liquidate_slice_respects_family_thresholds() -> None:
    # 18 weeks of wine cover is HEALTHY for wine (severe starts at 40) — it
    # must not enter the pool tagged liquidate the way the flat 16-week
    # cutoff used to.
    inventory = [item("VINO", category="wine_red", on_hand=18, price=25)]
    velocity = {"VINO": _vel("VINO", 4, bucket="low")}
    health = [
        HealthInfo(sku="VINO", category="wine_red", on_hand=18, weekly_rate=1.0,
                   weeks_on_hand=18.0, tied_up_capital=450.0, status="healthy"),
    ]
    candidates = select_candidates(inventory, velocity, health, SignalBundle(), now=NOW)
    assert all(c.slice != "liquidate" for c in candidates)
    # A genuinely severe overstock does.
    health = [
        HealthInfo(sku="VINO", category="wine_red", on_hand=18, weekly_rate=0.1,
                   weeks_on_hand=180.0, tied_up_capital=450.0, status="overstock_severe"),
    ]
    candidates = select_candidates(inventory, velocity, health, SignalBundle(), now=NOW)
    by_sku = {c.sku: c for c in candidates}
    # overstock slice claims it first (higher priority), which is fine — the
    # point is the healthy wine never got a liquidate label.
    assert by_sku["VINO"].slice in ("overstock", "liquidate")


def test_accented_news_hints_match_normalized_names() -> None:
    inventory = [
        item("ROSE", category="wine_rose", on_hand=6, name="Château Rosé d'Été"),
        item("OTHER", category="wine_red", on_hand=6, name="House Red"),
    ]
    velocity = {i.sku: _vel(i.sku, 5) for i in inventory}
    health = [_health(i.sku, "healthy") for i in inventory]
    signals = SignalBundle(news_product_keywords=["rosé"])
    candidates = select_candidates(inventory, velocity, health, signals, now=NOW)
    by_sku = {c.sku: c for c in candidates}
    assert by_sku["ROSE"].slice == "news_match"


def test_50ml_minis_never_reach_the_candidate_pool() -> None:
    # Minis were capped, not excluded, and the operational slices
    # (lost_sale/understock/reorder_due) were exempt from the cap entirely - so
    # a stocking-out nip always made the pool. Now nothing at or under 50ml does.
    inventory = [
        item("NIP1", name="Fireball .05", category="whiskey", on_hand=2),
        item("NIP2", name="Jim Beam 50ml", category="whiskey", on_hand=80),
        item("NIP3", name="Smirnoff Mini", category="vodka", on_hand=40),
        item("REAL", name="Kentucky Gentleman 750ml", category="whiskey", on_hand=30),
    ]
    velocity = {
        "NIP1": _vel("NIP1", 400, bucket="very_high"),
        "NIP2": _vel("NIP2", 300, bucket="very_high"),
        "NIP3": _vel("NIP3", 250, bucket="very_high"),
        "REAL": _vel("REAL", 20),
    }
    health = [
        _health("NIP1", "understock", weeks=0.2),   # the old exempt slice
        _health("NIP2", "healthy"),
        _health("NIP3", "healthy"),
        _health("REAL", "healthy"),
    ]

    candidates = select_candidates(inventory, velocity, health, SignalBundle(), now=NOW)

    assert [c.sku for c in candidates] == ["REAL"]


def test_100ml_still_reaches_the_pool_at_the_50ml_ceiling() -> None:
    inventory = [item("HALF", name="Fireball .100", category="whiskey", on_hand=20)]
    velocity = {"HALF": _vel("HALF", 50)}
    health = [_health("HALF", "healthy")]

    candidates = select_candidates(inventory, velocity, health, SignalBundle(), now=NOW)

    assert [c.sku for c in candidates] == ["HALF"]


def test_small_format_exclusion_is_configurable_off() -> None:
    inventory = [item("NIP1", name="Fireball .05", category="whiskey", on_hand=20)]
    velocity = {"NIP1": _vel("NIP1", 50)}
    health = [_health("NIP1", "healthy")]

    candidates = select_candidates(inventory, velocity, health, SignalBundle(),
                                   now=NOW, small_format_max_ml=0)

    assert [c.sku for c in candidates] == ["NIP1"]
