from __future__ import annotations

from app.schemas.derived import VelocityInfo
from app.store_data.inventory_health import compute_inventory_health
from tests.conftest import item


def _vel(sku: str, category: str, units_30d: int, bucket: str) -> VelocityInfo:
    return VelocityInfo(
        sku=sku,
        category=category,
        units_7d=units_30d // 4,
        units_30d=units_30d,
        units_90d=units_30d * 3,
        velocity_score=0.0,
        velocity_bucket=bucket,
        trend="stable",
    )


def test_stockout() -> None:
    health = compute_inventory_health([item("A", on_hand=0)], {})
    assert health[0].status == "stockout"


def test_understock_fast_mover_low_stock() -> None:
    inv = [item("A", category="beer", on_hand=2)]
    vel = {"A": _vel("A", "beer", units_30d=43, bucket="high")}  # ~10/wk -> 0.2 wks on hand
    status = compute_inventory_health(inv, vel)[0]
    assert status.status == "understock"
    assert status.weeks_on_hand is not None and status.weeks_on_hand < 0.5


def test_overstock_severe_slow_mover() -> None:
    inv = [item("W", category="wine", on_hand=100)]
    vel = {"W": _vel("W", "wine", units_30d=4, bucket="low")}  # ~107 wks on hand > 40
    status = compute_inventory_health(inv, vel)[0]
    assert status.status == "overstock_severe"


def test_healthy_middle_of_band() -> None:
    inv = [item("H", category="default", on_hand=10)]
    vel = {"H": _vel("H", "default", units_30d=10, bucket="medium")}  # ~4.3 wks
    assert compute_inventory_health(inv, vel)[0].status == "healthy"


def test_no_velocity_is_dead_stock() -> None:
    status = compute_inventory_health([item("D", on_hand=5)], {})[0]
    assert status.status == "overstock_severe"
    assert status.weeks_on_hand is None  # never sells -> undefined weeks-on-hand


# ── Sheet 03: weekly_rate divides by OPEN weeks ──────────────────────────────


def test_open_days_raise_the_weekly_rate_and_lower_weeks_on_hand() -> None:
    """The calendar divisor makes a store look better covered than it is.

    43 units in 30 days over 4.3 calendar weeks reads as 10.0/wk; the store is
    actually shut Sundays, so it sold those 43 units in 26 trading days -
    3.71 weeks, 11.58/wk. With 40 on hand that is 4.0 weeks of cover against a
    true 3.5, and the beer overstock_mild band sits at 4.0. The calendar
    divisor puts this SKU on the wrong side of a threshold.
    """
    inv = [item("A", category="beer", on_hand=40)]
    vel = {"A": _vel("A", "beer", units_30d=43, bucket="medium")}

    calendar_basis = compute_inventory_health(inv, vel)[0]
    open_basis = compute_inventory_health(inv, vel, None, 26)[0]

    assert calendar_basis.weekly_rate == 10.0
    assert open_basis.weekly_rate == 11.58
    assert open_basis.weekly_rate > calendar_basis.weekly_rate
    assert open_basis.weeks_on_hand < calendar_basis.weeks_on_hand


def test_weekly_rate_is_unchanged_when_no_open_day_count_is_supplied() -> None:
    """No calendar, no change. The migration is opt-in by construction."""
    inv = [item("A", category="beer", on_hand=40)]
    vel = {"A": _vel("A", "beer", units_30d=43, bucket="medium")}
    assert (compute_inventory_health(inv, vel)[0].weekly_rate
            == compute_inventory_health(inv, vel, None, None)[0].weekly_rate)


def test_zero_open_days_does_not_divide_by_zero() -> None:
    """A store with no trading days in the window still has to return."""
    inv = [item("A", category="beer", on_hand=40)]
    vel = {"A": _vel("A", "beer", units_30d=43, bucket="medium")}
    assert compute_inventory_health(inv, vel, None, 0)[0].weekly_rate == 10.0
