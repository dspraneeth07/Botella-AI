"""Tests for the StoreAgent pure functions changed for multi-store rollout:
brand+size market dedupe, tri-state statuses, tiered customer readiness, and
adaptive basket handling."""

from __future__ import annotations

from datetime import date, timedelta

from storeagent.functions.basket import basket_affinity
from storeagent.functions.customers import customer_radar, data_readiness, engagement_profile
from storeagent.functions.market import _dedupe_key, _size_sig, market_intelligence

# ---------------------------------------------------------------- market ----


def test_size_sig_normalizes_variants() -> None:
    assert _size_sig("Titos Vodka 750ml") == "750ml"
    assert _size_sig("Titos Vodka 1.75L") == "1750ml"
    assert _size_sig("Titos Vodka 750") == "750ml"  # bare number assumed ml
    assert _size_sig("Bud Light 12pk") == "12pk"
    assert _size_sig("Titos Vodka") == ""


def test_dedupe_key_is_brand_plus_size() -> None:
    assert _dedupe_key("Titos Vodka 750ml") == "brand:Tito's|750ml"
    assert _dedupe_key("Tito's Handmade 1.75 L") == "brand:Tito's|1750ml"
    assert _dedupe_key("Titos Vodka") == "brand:Tito's"  # no size -> brand-wide


def _peer(upc: str, name: str, units: int = 90, stores: int = 3,
          price: float = 25.0) -> dict:
    return {"upc": upc, "product_name": name, "category": "spirits",
            "units": units, "stores": stores, "avg_price": price}


def _market_data(my_names: list[str], peer_rows: list[dict]) -> dict:
    return {
        "available": True, "as_of": "2026-07-01", "window_days": 90,
        "geo": {}, "peer_tier": "state", "peer_count": 5,
        "comparable_peer_count": 4,
        "my_units_by_upc": {}, "my_bought_by_upc": {},
        "my_price_by_upc": {}, "my_name_by_upc": {},
        "cost_by_upc": {}, "my_names": my_names,
        "peer_rows": peer_rows, "peer_for_mine": {},
    }


def test_market_size_gap_surfaces_as_opportunity() -> None:
    # I carry the 750ml; peers also sell the 1.75L, which used to be hidden
    # behind the brand-level key.
    data = _market_data(
        ["Titos Vodka 750ml"],
        [_peer("1", "Titos Vodka 750ml"),
         _peer("2", "Titos Vodka 1.75L"),
         _peer("3", "Jack Daniels 750ml")],
    )
    out = market_intelligence(data)
    assert out["status"] == "opportunities"
    names = {o["product_name"] for o in out["opportunities"]}
    assert names == {"Titos Vodka 1.75L", "Jack Daniels 750ml"}
    assert out["carried_count"] == 1
    assert out["assortment_coverage_pct"] == round(100 / 3, 1)


def test_market_sizeless_shelf_label_covers_whole_brand() -> None:
    # My name has no size token: we can't tell which size it is, so the brand
    # stays fully covered (the conservative pre-change behavior).
    data = _market_data(
        ["Titos Vodka"],
        [_peer("1", "Titos Vodka 750ml"), _peer("2", "Titos Vodka 1.75L")],
    )
    out = market_intelligence(data)
    assert out["status"] == "healthy"  # full coverage is a win, not an error
    assert out["opportunity_count"] == 0
    assert out["assortment_coverage_pct"] == 100.0


def test_market_no_peer_rows_is_insufficient_data() -> None:
    out = market_intelligence(_market_data(["Titos Vodka 750ml"], []))
    assert out["available"] is True
    assert out["status"] == "insufficient_data"
    assert out["assortment_coverage_pct"] is None


def test_market_unavailable_carries_status() -> None:
    out = market_intelligence({"available": False, "reason": "fewer than 3 peers"})
    assert out["status"] == "insufficient_data"


# ------------------------------------------------------------- customers ----


def _customer_rows(n: int, as_of: date) -> list[dict]:
    return [
        {"customer_id": f"c{i}", "name": f"Person {i}", "visits": 5,
         "spend": 250.0, "first_visit": as_of - timedelta(days=200),
         "last_visit": as_of - timedelta(days=10)}
        for i in range(n)
    ]


def test_readiness_tiers() -> None:
    as_of = date(2026, 7, 1)
    assert data_readiness(_customer_rows(50, as_of))["tier"] == "none"
    assert data_readiness(_customer_rows(150, as_of))["tier"] == "partial"
    assert data_readiness(_customer_rows(600, as_of))["tier"] == "full"


def test_readiness_bucket_dominance_disqualifies() -> None:
    as_of = date(2026, 7, 1)
    rows = _customer_rows(600, as_of)
    rows[0]["visits"] = 5000  # one "CASH"-style id dominating visits
    r = data_readiness(rows)
    assert r["tier"] == "none"
    assert "system bucket" in r["reason"]


def test_partial_tier_still_produces_win_back() -> None:
    as_of = date(2026, 7, 1)
    rows = _customer_rows(150, as_of)
    # One regular with ~7-day cadence who hasn't been seen for 40 days.
    rows[0].update(visits=10, first_visit=as_of - timedelta(days=103),
                   last_visit=as_of - timedelta(days=40))
    out = customer_radar(rows, as_of)
    assert out["available"] is True
    assert out["coverage"] == "partial"
    assert out["status"] == "opportunities"
    assert out["at_risk_count"] >= 1


def test_too_few_customers_is_insufficient() -> None:
    as_of = date(2026, 7, 1)
    out = customer_radar(_customer_rows(50, as_of), as_of)
    assert out["available"] is False
    assert out["status"] == "insufficient_data"
    assert "need >= 100" in out["reason"]


def test_engagement_profile_shapes_no_crm_fallback() -> None:
    ctx = {
        "capture": {"sales_90d": 2000, "linked_90d": 160, "avg_ticket": 18.457},
        "contact_book": {"contacts": 11228, "named": 9239, "with_phone": 7300, "with_email": 210},
        "by_day": [{"dow": 5, "tx": 400, "revenue": 9000.129},
                   {"dow": 6, "tx": 500, "revenue": 12000.0}],
        "by_hour": [{"hour": 12, "tx": 80}, {"hour": 17, "tx": 300},
                    {"hour": 18, "tx": 280}, {"hour": 19, "tx": 250},
                    {"hour": 20, "tx": 240}, {"hour": 9, "tx": 10}],
        "lines": {"baskets": 1800, "single_item": 1530},
    }
    eng = engagement_profile(ctx, distinct_customers=42)
    assert eng["needed_customers"] == 100
    assert eng["tracked_customers"] == 42
    assert eng["linked_pct_90d"] == 8.0
    assert eng["avg_ticket"] == 18.46
    assert eng["single_item_pct"] == 85.0
    assert eng["contact_book"]["with_phone"] == 7300
    assert [h["hour"] for h in eng["top_hours"]] == [17, 18, 19, 20]  # top 4 by tx
    assert eng["by_day"][1]["revenue"] == 12000.0


def test_engagement_profile_empty_context() -> None:
    eng = engagement_profile({}, distinct_customers=0)
    assert eng["linked_pct_90d"] is None
    assert eng["single_item_pct"] is None
    assert eng["by_day"] == [] and eng["top_hours"] == []


# ---------------------------------------------------------------- basket ----


def test_basket_no_sales_is_insufficient() -> None:
    out = basket_affinity({"as_of": None})
    assert out["status"] == "insufficient_data"


def test_basket_too_few_baskets_reports_counts() -> None:
    out = basket_affinity({"as_of": "2026-07-01", "window_days": 365,
                           "total_baskets": 30, "multi_item_baskets": 4,
                           "pairs": [], "window_widened": True})
    assert out["available"] is False
    assert out["status"] == "insufficient_data"
    assert out["reason"] == "only 30 transactions in the last 365 days"
    assert out["window_widened"] is True


def test_basket_no_pairs_is_healthy_with_single_item_insight() -> None:
    out = basket_affinity({"as_of": "2026-07-01", "window_days": 120,
                           "total_baskets": 200, "multi_item_baskets": 30,
                           "pairs": []})
    assert out["available"] is True
    assert out["status"] == "healthy"
    assert out["single_item_pct"] == 85.0
    assert out["top_bundles"] == [] and out["top_by_volume"] == []


def test_basket_pairs_flow_through_with_status() -> None:
    data = {
        "as_of": "2026-07-01", "window_days": 120,
        "total_baskets": 1000, "multi_item_baskets": 400,
        "min_support_used": 4,
        "sku_baskets": {"a": 100, "b": 50},
        "names": {"a": ("Beer", "beer"), "b": ("Chips", "snacks")},
        "pairs": [{"a": "a", "b": "b", "pair_count": 20}],
    }
    out = basket_affinity(data)
    assert out["status"] == "opportunities"
    assert out["min_support_used"] == 4
    assert out["top_bundles"][0]["lift"] == 4.0
    assert out["single_item_pct"] == 60.0


def test_market_nameless_peer_row_is_refused_and_counted() -> None:
    # Stores 101/102/103/2 sync lines with upc='' and no product name, and the
    # 8-digit sku becomes the barcode; a peer group built only from them had
    # product_name = NULL and the Market screen showed a row with 177 units, a
    # price and a projection but no product. The repo now fills the name from
    # the catalogue; whatever is STILL nameless is refused here - never shown,
    # never counted as a gap, and never matched against what I carry (it
    # cannot be) - and the refusal is reported so a feed problem is visible.
    nameless = _peer("4", "placeholder")
    nameless["product_name"] = None
    blank = _peer("5", "placeholder")
    blank["product_name"] = "   "
    data = _market_data(
        ["Titos Vodka 750ml"],
        [_peer("1", "Titos Vodka 750ml"), _peer("3", "Jack Daniels 750ml"), nameless, blank],
    )
    out = market_intelligence(data)
    names = [o["product_name"] for o in out["opportunities"]]
    assert names == ["Jack Daniels 750ml"]
    assert all(n and n.strip() for n in names)
    assert out["unnamed_skipped"] == 2
    # Refused rows are outside the coverage denominator too.
    assert out["regional_sku_count"] == 2
    assert out["carried_count"] == 1
