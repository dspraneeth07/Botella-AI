"""One-number rule: the canonical demand bridge and the shared reorder formula.

These pin the property the whole unification hangs on: the quantity an AI
recommendation quotes and the quantity the Store Intelligence Buying tab
prints come from the SAME function over the SAME rows, so they can never
disagree. The fruit-punch scenario (32/week, 42 on hand) is the reported bug.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.store_data.canonical_demand import _build_map
from storeagent.config import FORECAST
from storeagent.forecasting.demand import SkuDemand
from storeagent.functions.buying import buy_recommendations, order_quantity

AS_OF = date(2026, 8, 1)


def _sku(sku: str, weekly: float, on_hand: int, age_days: int = 365,
         reorder_cycle_days: int | None = None) -> SkuDemand:
    """A SKU selling `weekly` units/week at a flat daily rate."""
    per_day = weekly / 7
    total_days = min(age_days, 365)
    dow = [0.0] * 7
    for i in range(total_days):
        d = AS_OF - timedelta(days=i)
        dow[d.isoweekday() % 7] += per_day
    units_365 = round(per_day * total_days)
    return SkuDemand(
        sku=sku, product_name=sku, category="spirits", on_hand=on_hand,
        cost=1.0, price=2.0,
        units_28=round(per_day * min(28, total_days)),
        units_90=round(per_day * min(90, total_days)),
        units_365=units_365,
        last_sale=AS_OF, dow_units=dow, as_of=AS_OF,
        first_sale=AS_OF - timedelta(days=total_days - 1),
        reorder_cycle_days=reorder_cycle_days,
    )


def test_order_quantity_matches_the_buy_list_row() -> None:
    """The extracted formula IS the buy list's formula — refactor, not fork."""
    d = _sku("A", weekly=32, on_hand=42)
    qty, coverage = order_quantity(d, FORECAST)
    buy = buy_recommendations([d], AS_OF)
    row = next(r for r in buy["buy_list"] if r["sku"] == "A")
    assert row["order_qty"] == qty
    assert row["coverage_days"] == coverage


def test_fruit_punch_scenario_one_number() -> None:
    """32/week, 42 on hand, ~8-day supplier cadence: the reported mismatch.

    The engine's answer (and now the ONLY answer any surface gives) covers
    lead 7d + cycle 8d = 15 days of demand x1.25 minus stock — ~44 units.
    The rec pipeline's map must carry that exact figure.
    """
    d = _sku("PUNCH", weekly=32, on_hand=42, reorder_cycle_days=8)
    qty, coverage = order_quantity(d, FORECAST)
    assert coverage == 15  # lead 7 + observed cycle 8
    # flat 32/wk => 15d demand ~68.6, x1.25 ~85.7, minus 42 => ceil ~44
    assert 43 <= qty <= 46

    cmap = _build_map(AS_OF, [d])
    entry = cmap.by_sku["PUNCH"]
    assert entry.order_qty == qty
    assert entry.coverage_days == coverage
    # Display pace = the projected (trend-included) pace the order is sized on.
    assert entry.weekly_rate == round(d.projected_daily(FORECAST) * 7, 2)
    assert entry.weekly_rate == pytest.approx(32.0, abs=0.5)


def test_build_map_carries_zero_qty_rows() -> None:
    """SKUs needing nothing keep order_qty=0 (NOT dropped): the validator
    needs 'engine says nothing to order' to be distinguishable from 'engine
    never saw this sku' to drop false-urgency reorders."""
    stocked = _sku("FULL", weekly=7, on_hand=500)
    cmap = _build_map(AS_OF, [stocked], today=AS_OF)
    assert cmap.by_sku["FULL"].order_qty == 0
    assert cmap.by_sku["FULL"].order_by is None


def test_build_map_order_by_and_run_out_match_buy_row() -> None:
    d = _sku("A", weekly=32, on_hand=42)
    cmap = _build_map(AS_OF, [d], today=AS_OF)
    buy = buy_recommendations([d], AS_OF, today=AS_OF)
    row = next(r for r in buy["buy_list"] if r["sku"] == "A")
    assert cmap.by_sku["A"].order_by == row["order_by"]
    assert cmap.by_sku["A"].run_out == row["run_out"]
    assert cmap.by_sku["A"].stockout_risk == row["stockout_risk"]


def test_order_by_never_renders_in_the_past() -> None:
    """A lagging data frontier (or a SKU already inside its lead window) must
    read "order today", not a date days ago — an order-by is an instruction
    to a human acting in wall-clock time. The store-171 Fireball rec showed
    'the reorder date was August 22' two days late; this pins the fix."""
    wall_clock = AS_OF + timedelta(days=3)  # frontier lags 3 days
    d = _sku("LATE", weekly=21, on_hand=14)  # ~4.7d of supply, inside 7d lead
    cmap = _build_map(AS_OF, [d], today=wall_clock)
    assert cmap.by_sku["LATE"].order_by == wall_clock.isoformat()
    buy = buy_recommendations([d], AS_OF, today=wall_clock)
    row = next(r for r in buy["buy_list"] if r["sku"] == "LATE")
    assert row["order_by"] == wall_clock.isoformat()
    # run_out stays frontier-anchored (it is a fact about the data, not an
    # instruction): 14 on hand at 3/day = 4 whole days past the frontier.
    assert row["run_out"] == (AS_OF + timedelta(days=4)).isoformat()


def _young_sku(sku: str, daily: float, on_hand: int, age_days: int) -> SkuDemand:
    """A SKU first sold `age_days` days ago, selling `daily` units/day since."""
    dow = [0.0] * 7
    for i in range(age_days):
        d = AS_OF - timedelta(days=i)
        dow[d.isoweekday() % 7] += daily
    units = round(daily * age_days)
    return SkuDemand(
        sku=sku, product_name=sku, category="spirits", on_hand=on_hand,
        cost=1.0, price=2.0, units_28=units, units_90=units, units_365=units,
        last_sale=AS_OF, dow_units=dow, as_of=AS_OF,
        first_sale=AS_OF - timedelta(days=age_days - 1),
    )


def test_young_sku_forecast_agrees_with_its_own_daily_rate() -> None:
    """Store-171 Fireball bug: a 2-day-old SKU had zero observations for 5 of
    7 weekdays, so forecast(21) implied ~0.86/day while the SAME row showed
    3/day (21/week) and 4.7 days of supply. Unobserved weekdays now borrow
    base_daily, so the forecast and the displayed rate tell one story."""
    d = _young_sku("FIREBALL", daily=3.0, on_hand=14, age_days=2)
    assert d.base_daily() == 3.0
    # Forecast per day ~ base rate (trend 1.0, flat seller) over any horizon.
    assert d.forecast(21) == pytest.approx(3.0 * 21, rel=0.01)
    # A SKU with a full week+ of history is untouched (every weekday observed).
    old = _sku("OLD", weekly=21, on_hand=14)
    per_day = old.forecast(21) / 21
    assert per_day == pytest.approx(old.base_daily() * old.trend_factor(FORECAST), rel=0.05)


def test_young_sku_coverage_is_capped_to_its_history() -> None:
    """Two days of launch sales justify about a week's order, not three weeks
    of an unproven product: coverage = max(lead, days_live x 2) under 14 days
    of history, then the normal window again."""
    young = _young_sku("NEW2", daily=3.0, on_hand=14, age_days=2)
    assert young.coverage_days(FORECAST) == 7  # max(lead 7, 2*2)
    # The default window is lead 7 + review 7 = 14 since the Buying tab's
    # review period was aligned to the card policy's (it was 14, giving a
    # 21-day window the card never used, so the row and the card sized the
    # same bottle over different horizons). A week-old SKU's cap of 8*2 = 16
    # now sits ABOVE the default, so the default wins; the cap only bites
    # below seven days of history.
    week_old = _young_sku("NEW8", daily=3.0, on_hand=14, age_days=8)
    assert week_old.coverage_days(FORECAST) == 14  # min(default 14, 8*2)
    six_days = _young_sku("NEW6", daily=3.0, on_hand=14, age_days=6)
    assert six_days.coverage_days(FORECAST) == 12  # 6*2, under the 14 default
    proven = _sku("PROVEN", weekly=21, on_hand=14, age_days=60)
    assert proven.coverage_days(FORECAST) == 14  # lead 7 + review 7


def test_fireball_scenario_gets_a_coherent_order() -> None:
    """2 days old, 6 units sold, 14 on hand: the order now covers a week at
    the SKU's real 3/day pace (ceil(1.25 x 21 - 14) = 13), instead of the
    incoherent 9 the starved weekday model produced."""
    d = _young_sku("FIREBALL", daily=3.0, on_hand=14, age_days=2)
    qty, coverage = order_quantity(d, FORECAST)
    assert coverage == 7
    assert qty == 13
    cmap = _build_map(AS_OF, [d], today=AS_OF)
    assert cmap.by_sku["FIREBALL"].order_qty == 13
    assert cmap.by_sku["FIREBALL"].weekly_rate == 21.0


def test_collapsed_trend_seller_shows_its_current_pace() -> None:
    """Store-171 Ironroot bug: 209 units in a July surge then 10 in the last
    28 days. The card said "sells about 28 units a week" (the stale 90d
    average) beside an order sized for the collapsed pace — two paces on one
    row. Display figures now run at the projected pace the order math uses."""
    dow = [0.0] * 7
    for i in range(52):
        d_ = AS_OF - timedelta(days=i)
        # 199 units in the first 24 days, 10 spread over the last 28.
        dow[d_.isoweekday() % 7] += (10 / 28) if i < 28 else (199 / 24)
    d = SkuDemand(
        sku="IRONROOT", product_name="Ironroot Industrial Luciano",
        category="spirits", on_hand=9, cost=20.0, price=40.0,
        units_28=10, units_90=209, units_365=209,
        last_sale=AS_OF, dow_units=dow, as_of=AS_OF,
        first_sale=AS_OF - timedelta(days=51),
    )
    assert round(d.base_daily() * 7, 1) == pytest.approx(28.1, abs=0.2)  # the stale figure
    assert d.trend_factor(FORECAST) == 0.3  # 28d collapse, clamped

    cmap = _build_map(AS_OF, [d], today=AS_OF)
    entry = cmap.by_sku["IRONROOT"]
    # Displayed pace is the CURRENT one (~8/week), not the July average.
    assert entry.weekly_rate < 10
    # And the story is internally coherent: stock / weekly pace = weeks shown.
    assert entry.weeks_on_hand == pytest.approx(9 / entry.weekly_rate, abs=0.15)
    # The order still covers ~coverage days at that same pace.
    assert entry.order_qty == order_quantity(d, FORECAST)[0]


def test_forward_fields_match_between_bridge_and_buy_row_when_trending() -> None:
    # A rising seller: bridge and Buying tab must agree on the trended
    # forward fields (order_by / run_out / stockout_risk), not just qty.
    dow = [0.0] * 7
    for i in range(365):
        d_ = AS_OF - timedelta(days=i)
        dow[d_.isoweekday() % 7] += (60 / 28) if i < 28 else (140 / 337)
    d = SkuDemand(
        sku="HOT", product_name="HOT", category="spirits", on_hand=10,
        cost=1.0, price=2.0, units_28=60, units_90=88, units_365=200,
        last_sale=AS_OF, dow_units=dow, as_of=AS_OF,
        first_sale=AS_OF - timedelta(days=364),
    )
    cmap = _build_map(AS_OF, [d], today=AS_OF)
    buy = buy_recommendations([d], AS_OF, today=AS_OF)
    row = next(r for r in buy["buy_list"] if r["sku"] == "HOT")
    e = cmap.by_sku["HOT"]
    assert (e.order_by, e.run_out, e.stockout_risk) == (
        row["order_by"], row["run_out"], row["stockout_risk"])


def _named(sku: str, name: str, weekly: float, on_hand: int) -> SkuDemand:
    d = _sku(sku, weekly=weekly, on_hand=on_hand)
    d.product_name = name
    return d


def _ramping_nip(sku: str, name: str, weekly: float, on_hand: int) -> SkuDemand:
    """A mini selling at double its lifetime pace for the last 90 days - it
    qualifies for the accelerating list on the numbers, and is kept off it
    only by the size rule."""
    per_day = weekly / 7
    dow = [0.0] * 7
    for i in range(365):
        d = AS_OF - timedelta(days=i)
        dow[d.isoweekday() % 7] += per_day * (2.0 if i < 90 else 1.0)
    return SkuDemand(
        sku=sku, product_name=name, category="spirits", on_hand=on_hand,
        cost=1.0, price=2.0,
        units_28=round(per_day * 2.0 * 28),
        units_90=round(per_day * 2.0 * 90),
        units_365=round(per_day * 365),
        last_sale=AS_OF, dow_units=dow, as_of=AS_OF,
        first_sale=AS_OF - timedelta(days=364),
    )


def test_50ml_minis_stay_off_the_buy_and_accelerating_lists() -> None:
    # A nip outsells every real bottle on units alone, so a rate-ranked buy
    # list handed the owner the nip rack. Minis are off the buy list and the
    # accelerating list; the don't-buy list still shows them (frozen cash).
    nip = _ramping_nip("NIP", "Fireball .05", weekly=200, on_hand=4)
    real = _named("REAL", "Kentucky Gentleman 750ml", weekly=32, on_hand=42)

    # Without the size rule the nip wins both lists - the regression guard.
    loose = buy_recommendations([nip, real], AS_OF, today=AS_OF, small_format_max_ml=0)
    assert "NIP" in [r["sku"] for r in loose["buy_list"]]
    assert "NIP" in [r["sku"] for r in loose["accelerating"]]

    out = buy_recommendations([nip, real], AS_OF, today=AS_OF)
    assert [r["sku"] for r in out["buy_list"]] == ["REAL"]
    assert [r["sku"] for r in out["accelerating"]] == []


def test_buy_list_mini_exclusion_is_configurable_off() -> None:
    nip = _named("NIP", "Fireball .05", weekly=200, on_hand=4)

    out = buy_recommendations([nip], AS_OF, today=AS_OF, small_format_max_ml=0)

    assert [r["sku"] for r in out["buy_list"]] == ["NIP"]
