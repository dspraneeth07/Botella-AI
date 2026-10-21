"""Shelf-age-aware demand rates and the "Demand heating up" gate.

The bugs these pin down, all from one assumption (every SKU has a full year of
history): a four-week-old listing scored the 3.0 trend clamp automatically, its
30-day projection came out ~4x low, the row showed days-of-supply and a
projection that contradicted each other, and a mover that had stopped selling
weeks ago still sat in "accelerating" on the strength of a stale 90d ratio.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from storeagent.forecasting.demand import SkuDemand
from storeagent.functions.buying import buy_recommendations

AS_OF = date(2026, 8, 1)


def _sku(sku: str, u28: int, u90: int, u365: int, age_days: int,
         on_hand: int = 0, last_sale_days_ago: int = 0) -> SkuDemand:
    """A SKU selling at a flat daily rate across `age_days` of shelf life."""
    per_day = u365 / age_days
    dow = [0.0] * 7
    for i in range(age_days):
        d = AS_OF - timedelta(days=i)
        dow[d.isoweekday() % 7] += per_day
    return SkuDemand(
        sku=sku, product_name=sku, category="spirits", on_hand=on_hand,
        cost=10.0, price=20.0, units_28=u28, units_90=u90, units_365=u365,
        last_sale=AS_OF - timedelta(days=last_sale_days_ago),
        dow_units=dow, as_of=AS_OF,
        first_sale=AS_OF - timedelta(days=age_days - 1),
    )


def test_new_sku_no_longer_pins_to_the_trend_clamp() -> None:
    # 30 units, all inside a 31-day shelf life. The old math read this as
    # (30/90)/(30/365) = 4.06 -> clamped to the 3.0 ceiling, the same score
    # every new listing got regardless of how it was actually selling.
    d = _sku("NEW", u28=29, u90=30, u365=30, age_days=31, on_hand=42)
    assert d.days_live == 31
    assert d.recency_factor() == 1.0        # u90 == u365: no 90d-vs-year contrast
    assert d.trend_basis() == "28d"         # so the 28d window is the real signal
    assert 1.0 <= d.trend_factor() < 1.3    # steady, not "3x accelerating"


def test_new_sku_projection_tracks_its_actual_recent_rate() -> None:
    # 29 units in 28 days is ~1/day; the next 30 days should project ~30, not
    # the ~8 you get by averaging 30 units over a year it wasn't on the shelf.
    d = _sku("NEW", u28=29, u90=30, u365=30, age_days=31, on_hand=42)
    assert 28 <= d.forecast(30) <= 34
    # ...and days of supply follows the same rate instead of u90/90.
    assert d.days_of_supply_at_trend() < 50   # was 126d off the un-trended rate


def test_supply_and_projection_agree_on_the_same_row() -> None:
    d = _sku("NEW", u28=29, u90=30, u365=30, age_days=31, on_hand=42)
    proj = d.forecast(30)
    # approx, not ==: on_hand / (proj/30) and on_hand / proj * 30 are the same
    # quantity but different float op orders — exact equality is one ULP of
    # associativity away from flaking, which is precisely how this broke.
    assert d.days_of_supply_at_trend() == pytest.approx(d.on_hand / proj * 30, rel=1e-9)


def test_established_sku_math_is_unchanged() -> None:
    # A full year of history: days_live saturates, every span is the nominal
    # window, and the rates are exactly what they were before.
    d = _sku("OLD", u28=30, u90=80, u365=200, age_days=366, on_hand=40)
    assert d.recency_factor() == max(0.3, min(3.0, (80 / 90) / (200 / 365)))
    assert d.base_daily() == 80 / 90
    assert d.trend_basis() == "90d"
    assert d.trend_factor() == d.recency_factor()


def test_stalled_mover_is_not_accelerating() -> None:
    # 24 units in days 29-90, nothing in the last 28. Its 90d-vs-year ratio is
    # still 3.0, but it has stopped selling — the 28d factor is what says so.
    dead = _sku("STALLED", u28=0, u90=24, u365=32, age_days=300,
                on_hand=0, last_sale_days_ago=29)
    assert dead.recency_factor() >= 1.3     # the stale signal that used to pass
    assert dead.recent_factor() < 1.0       # the one that catches it
    out = buy_recommendations([dead], AS_OF)
    assert out["accelerating"] == []
    assert out["accelerating_count"] == 0


def test_genuine_accelerator_still_listed_with_agreeing_numbers() -> None:
    good = _sku("HOT", u28=30, u90=80, u365=200, age_days=366, on_hand=40)
    out = buy_recommendations([good], AS_OF)
    assert [r["sku"] for r in out["accelerating"]] == ["HOT"]
    row = out["accelerating"][0]
    assert row["trend"] >= 1.3
    assert row["trend_basis"] == "90d"
    assert row["days_live"] == 366
    # SUPPLY is cover at the projected pace, so it reconciles with PROJ. 30D.
    assert row["days_of_supply"] == round(row["on_hand"] / row["proj_30d"] * 30, 1)


def test_young_ramp_is_caught_by_the_28d_window() -> None:
    # 40 days old; nearly all of its 30 units landed in the last 28 days. The
    # 90d factor is blind to this (u90 == u365) — the 28d one is not.
    ramp = _sku("RAMP", u28=28, u90=30, u365=30, age_days=80, on_hand=10)
    assert ramp.recency_factor() == 1.0
    assert ramp.recent_factor() >= 1.3
    out = buy_recommendations([ramp], AS_OF)
    assert [r["sku"] for r in out["accelerating"]] == ["RAMP"]
    assert out["accelerating"][0]["trend_basis"] == "28d"


def test_short_history_store_says_why_instead_of_showing_nothing() -> None:
    # A store whose whole feed is a few days: recent rate == lifetime rate for
    # every SKU, so the trend is identically 1.00 and no list is possible. The
    # payload must distinguish that from "nothing is accelerating today".
    young = [_sku(f"S{i}", u28=20, u90=20, u365=20, age_days=4, on_hand=5)
             for i in range(5)]
    out = buy_recommendations(young, AS_OF)
    assert out["accelerating"] == []
    assert out["history_days"] == 4
    assert out["accelerating_status"] == "insufficient_history"
    assert "4 days of sales history" in out["accelerating_reason"]


def test_full_history_store_with_no_movers_reads_as_healthy() -> None:
    flat = [_sku(f"F{i}", u28=15, u90=50, u365=200, age_days=366, on_hand=20)
            for i in range(5)]
    out = buy_recommendations(flat, AS_OF)
    assert out["accelerating"] == []
    assert out["accelerating_status"] == "healthy"


def test_weekday_denominator_covers_the_live_window_only() -> None:
    # dow_avg divides by the weekday's occurrences since the first sale, not
    # since a year ago — that division is what deflated new-SKU forecasts.
    young = _sku("Y", u28=14, u90=14, u365=14, age_days=14)
    assert sum(young._dow_counts) == 14
    old = _sku("O", u28=14, u90=40, u365=140, age_days=366)
    assert sum(old._dow_counts) == 366
