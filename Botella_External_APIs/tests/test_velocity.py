from __future__ import annotations

from datetime import timedelta

from app.pipeline.features.store import CalendarDay
from app.store_data.velocity import (
    _bucket,
    _trend,
    compute_velocity,
    open_days_between,
)
from tests.conftest import NOW, sale


def test_window_aggregation_and_trend() -> None:
    sales = [
        sale("A", days_ago=1, units=14),   # in 7/30/90
        sale("A", days_ago=50, units=7),   # in 90 only -> contributes to prior
        sale("B", days_ago=60, units=3),   # in 90 only -> contributes to prior
        sale("C", days_ago=50, units=40),  # real volume that then stops
    ]
    category_by_sku = {"A": "beer", "B": "beer", "C": "beer"}

    vel = compute_velocity(sales, category_by_sku, NOW)

    a = vel["A"]
    assert a.units_7d == 14
    assert a.units_30d == 14
    assert a.units_90d == 21
    assert a.trend == "rising"  # 14 units in last week vs ~0.6/week prior

    # B's 3 units over 90 days is noise, not a trend — the guard keeps it stable.
    b = vel["B"]
    assert b.units_7d == 0
    assert b.units_90d == 3
    assert b.trend == "stable"

    # C had real prior volume (~3.4/week) and stopped — that IS falling.
    assert vel["C"].trend == "falling"

    # A clearly outsells B within the shared category.
    assert a.velocity_score > b.velocity_score


def test_zero_sellers_anchor_the_distribution() -> None:
    # Every inventory SKU gets a VelocityInfo, sales or not, so non-sellers
    # anchor the category mean instead of inflating it.
    sales = [sale("A", days_ago=1, units=10)]
    vel = compute_velocity(sales, {"A": "beer", "Z1": "beer", "Z2": "beer"}, NOW)
    assert set(vel) == {"A", "Z1", "Z2"}
    assert vel["Z1"].units_90d == 0
    assert vel["Z1"].velocity_bucket == "very_low"  # zero sales is never "medium"
    assert vel["A"].velocity_score > vel["Z1"].velocity_score


def test_sales_outside_90d_window_ignored() -> None:
    vel = compute_velocity([sale("A", days_ago=200, units=99)], {"A": "beer"}, NOW)
    # The SKU is seeded (it's in inventory) but the old sale contributes nothing.
    assert vel["A"].units_90d == 0
    assert vel["A"].velocity_bucket == "very_low"


def test_bucket_boundaries() -> None:
    assert _bucket(2.0) == "very_high"
    assert _bucket(1.0) == "high"
    assert _bucket(0.0) == "medium"
    assert _bucket(-1.0) == "low"
    assert _bucket(-2.0) == "very_low"


def test_trend_stable_when_no_history() -> None:
    assert _trend(0, 0) == "stable"
    assert _trend(5, 0) == "rising"


# ── Sheet 03: the rate divides by OPEN days ──────────────────────────────────


def _calendar(days: int, *, closed_weekday: int | None = None,
              unsynced_tail: int = 0) -> list[CalendarDay]:
    """A calendar ending on NOW's date, `days` long."""
    end = NOW.date()
    out = []
    for i in range(days):
        d = end - timedelta(days=i)
        out.append(CalendarDay(
            obs_date=d,
            was_open=(closed_weekday is None or d.weekday() != closed_weekday),
            has_data=(i >= unsynced_tail),
        ))
    return out


def test_open_days_between_excludes_closed_and_unsynced() -> None:
    end = NOW.date()
    cal = _calendar(30, closed_weekday=6, unsynced_tail=3)  # shut Sundays
    counted = open_days_between(cal, end - timedelta(days=30), end)
    # 30 days, minus ~4 Sundays, minus the 3 unsynced days at the tail (one of
    # which may itself be a Sunday, already excluded).
    assert counted is not None
    assert counted < 30
    closed = sum(1 for c in cal if not c.was_open)
    unsynced_open = sum(1 for c in cal if c.was_open and not c.has_data)
    assert counted == 30 - closed - unsynced_open


def test_open_days_between_is_none_without_a_calendar() -> None:
    """No calendar means UNKNOWN, never zero. Zero would be a divisor."""
    assert open_days_between(None, NOW.date() - timedelta(days=30), NOW.date()) is None


def test_a_closed_day_raises_the_prior_rate_and_can_flip_a_trend() -> None:
    """The bug this migration exists for.

    Dividing 83 days of units by CALENDAR weeks understates the prior rate for
    a store that closes, which inflates the 7d/prior ratio and mislabels a flat
    SKU as rising.
    """
    prior = 130  # units over the 83-day prior window

    # The divisor, three ways:
    #   83 calendar days -> 11.86 wk -> 10.96/wk   (what we used to do)
    #   71 open days     -> 10.14 wk -> 12.82/wk   (shut one day a week)
    #   36 open days     ->  5.14 wk -> 25.28/wk   (open three days a week)

    # 15 this week. The calendar divisor calls it RISING; on a six-day store
    # it is merely stable, and on a three-day store the SKU is actually
    # FALLING. One number, three verdicts, and only the last two are true.
    assert _trend(15, prior) == "rising"
    assert _trend(15, prior, 71) == "stable"
    assert _trend(15, prior, 36) == "falling"

    # And it does not invent movement in the other direction: a genuinely flat
    # SKU stays stable on the honest divisor.
    assert _trend(12, prior) == "stable"
    assert _trend(12, prior, 71) == "stable"


def test_prior_open_days_of_zero_falls_back_rather_than_dividing_by_zero() -> None:
    """A store with no open days in the prior window has no rate.

    0 is falsy on purpose here: it means "nothing to divide by", and the
    fallback is the calendar window - not a ZeroDivisionError, and not an
    infinite rate that would label every SKU falling.
    """
    assert _trend(5, 100, 0) == _trend(5, 100)


def test_compute_velocity_accepts_a_calendar_without_changing_unit_counts() -> None:
    """The calendar changes RATES, never the counts. Units are units."""
    sales = [sale("A", days_ago=1, units=14), sale("A", days_ago=50, units=7)]
    cats = {"A": "beer"}
    without = compute_velocity(sales, cats, NOW)
    with_cal = compute_velocity(sales, cats, NOW, _calendar(95, closed_weekday=6))
    assert without["A"].units_7d == with_cal["A"].units_7d == 14
    assert without["A"].units_90d == with_cal["A"].units_90d == 21
    assert without["A"].velocity_score == with_cal["A"].velocity_score
