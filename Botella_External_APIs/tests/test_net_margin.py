"""N0.2 — money as the primary scored outcome, per card, with an interval.

Hit rate answers a research question about selection. These tests pin the three
things that make the money figure trustworthy instead of flattering: it is
INCREMENTAL rather than total, its interval is clustered BY DECISION DATE rather
than by card, and a store with no cost data reports an absence rather than a
zero.
"""

from __future__ import annotations

import random

import pytest

from scripts.daily_recommendation_ledger import summarise
from scripts.real_engine_backtest import clustered_ci, clustered_mean_ci


def row(as_of: str, h: int, *, margin_impact, over_cost, captured=None,
        lift=1.2, hit=True, gained=5.0, promised=4.0, expected=10.0,
        actual=15.0) -> dict:
    """One ledger row, shaped exactly as `build_ledger` emits it."""
    return {
        "as_of": as_of,
        "sku": "0245",
        "outcomes": {
            h: {
                "expected": expected, "actual": actual,
                "lift": lift, "hit": hit,
                "gained_units": gained,
                "margin_impact": margin_impact,
                "margin_captured": captured,
                "promised_units": promised,
                "prediction_accuracy": None,
                "over_ordered_units": 0.0,
                "over_ordered_cost": over_cost,
                "over_ordered_cogs": None,
                "holding_breakdown": None,
            }
        },
    }


# ── Incremental, never total ─────────────────────────────────────────────────


def test_net_margin_is_incremental_not_total() -> None:
    """`(sold - expected) x margin`, minus holding. Never `sold x margin`.

    The case that matters is the one where the two disagree in SIGN: the old
    ordering showed the largest total margin flow in the estate ($215k) and a
    negative incremental margin at the same time, because total margin rewards
    naming the biggest sellers while predicting nothing about them.
    """
    # A card on a big seller that UNDERPERFORMED its own baseline: huge flow
    # touched, negative incremental.
    ledger = [
        row("2026-03-02", 30, margin_impact=-40.0, over_cost=5.0,
            captured=900.0, expected=100.0, actual=80.0),
        row("2026-03-03", 30, margin_impact=-30.0, over_cost=5.0,
            captured=850.0, expected=100.0, actual=85.0),
    ]
    s = summarise(ledger)[30]

    assert s["net_margin_per_card"] == pytest.approx((-45.0 + -35.0) / 2)
    assert s["net_margin_per_card"] < 0, "incremental is negative here"
    assert s["margin_captured"] == pytest.approx(1750.0)
    assert s["margin_captured"] > 0, "total flow is strongly positive"
    # The two must never be combined. The net is built from margin_impact only.
    assert s["net_margin_per_card"] != s["margin_captured"] / 2


def test_holding_cost_is_subtracted_from_the_incremental_margin() -> None:
    ledger = [row("2026-03-02", 30, margin_impact=100.0, over_cost=12.0)]
    s = summarise(ledger)[30]
    assert s["net_margin_per_card"] == pytest.approx(88.0)


def test_margin_captured_is_never_summed_into_the_net() -> None:
    """A labelled column, not a result. Changing it must not move the net."""
    a = summarise([row("2026-03-02", 30, margin_impact=10.0, over_cost=1.0,
                       captured=5.0)])[30]
    b = summarise([row("2026-03-02", 30, margin_impact=10.0, over_cost=1.0,
                       captured=5000.0)])[30]
    assert a["net_margin_per_card"] == b["net_margin_per_card"] == pytest.approx(9.0)
    assert a["margin_captured"] != b["margin_captured"]


# ── The interval is clustered by date, not by card ───────────────────────────


def test_interval_is_date_clustered() -> None:
    """Two cards on the same morning share a market.

    The test is structural rather than numeric: resampling CARDS instead of
    DATES must give a visibly tighter interval, and the shipped function must be
    the wider one. Same data, same draw count, same seed - the only difference
    is the unit of resampling.
    """
    # Twelve decision dates. Each date is internally consistent (its cards agree
    # with each other) but the dates disagree strongly with one another, which
    # is exactly the structure clustering exists to respect.
    by_date = [[100.0, 100.0, 100.0] if i % 2 else [-60.0, -60.0, -60.0]
               for i in range(12)]
    flat = [[v] for day in by_date for v in day]   # one "cluster" per card

    clustered = clustered_mean_ci(by_date, random.Random(7))
    rowwise = clustered_mean_ci(flat, random.Random(7))

    width_clustered = clustered[1] - clustered[0]
    width_rowwise = rowwise[1] - rowwise[0]
    assert width_clustered > width_rowwise, (
        "clustering by date must be WIDER than resampling cards; if it is not, "
        "the clustering is not happening and the interval overstates the "
        "evidence"
    )


def test_interval_brackets_the_point_estimate() -> None:
    by_date = [[12.0, 8.0], [20.0, 4.0], [-5.0, 15.0], [9.0, 11.0], [3.0, 7.0]]
    lo, hi = clustered_mean_ci(by_date, random.Random(1))
    mean = sum(v for d in by_date for v in d) / sum(len(d) for d in by_date)
    assert lo <= mean <= hi


def test_interval_is_reproducible_for_a_fixed_seed() -> None:
    """A bootstrap seeded from the clock makes two copies of the same report
    disagree with each other."""
    by_date = [[1.0, 2.0], [3.0, -1.0], [0.5, 4.0], [2.0, 2.5]]
    assert (clustered_mean_ci(by_date, random.Random(99))
            == clustered_mean_ci(by_date, random.Random(99)))


def test_interval_refuses_below_two_dates() -> None:
    """One decision date carries no information about between-date variation,
    and an interval computed from it would be a fiction."""
    lo, hi = clustered_mean_ci([[1.0, 2.0, 3.0]], random.Random(1))
    assert lo != lo and hi != hi        # NaN, the only honest answer

    s = summarise([row("2026-03-02", 30, margin_impact=10.0, over_cost=1.0)])[30]
    assert s["net_margin_per_card_ci"] is None
    assert s["net_margin_per_card"] is not None, (
        "the point estimate is still knowable - only the interval is not"
    )


def test_summarise_reports_a_date_clustered_interval() -> None:
    ledger = [
        row("2026-03-02", 30, margin_impact=50.0, over_cost=2.0),
        row("2026-03-02", 30, margin_impact=55.0, over_cost=2.0),
        row("2026-03-03", 30, margin_impact=-10.0, over_cost=3.0),
        row("2026-03-04", 30, margin_impact=20.0, over_cost=1.0),
        row("2026-03-05", 30, margin_impact=30.0, over_cost=1.0),
    ]
    s = summarise(ledger)[30]
    lo, hi = s["net_margin_per_card_ci"]
    assert lo < s["net_margin_per_card"] < hi
    assert s["decision_dates_with_money"] == 4, "four distinct mornings"
    assert s["cards_with_money"] == 5


def test_boolean_clustered_ci_is_untouched() -> None:
    """`clustered_ci` publishes the hit-rate interval quoted in every report.
    N0.2 added a sibling rather than refactoring it; this pins that it still
    returns a percentage and still behaves."""
    lo, hi = clustered_ci([[True, True], [False, True], [True, False]],
                          random.Random(3))
    assert 0.0 <= lo <= hi <= 100.0


# ── Absence is not zero ──────────────────────────────────────────────────────


def test_no_cost_store_reports_absence_not_zero() -> None:
    """Five of ten audited stores send no cost at all. Their money columns must
    read "no cost data", never "$0" - a zero reads as a measurement."""
    ledger = [
        row("2026-03-02", 30, margin_impact=None, over_cost=None),
        row("2026-03-03", 30, margin_impact=None, over_cost=None),
    ]
    s = summarise(ledger)[30]
    assert s["net_margin_per_card"] is None
    assert s["net_margin_per_card"] != 0.0
    assert s["net_margin_per_card_ci"] is None
    assert s["cards_with_money"] == 0
    assert s["margin_captured"] is None
    # The hit rate is unaffected: it measures units against a product's own
    # recent rate and never touches cost.
    assert s["hit_rate"] == pytest.approx(100.0)
    assert s["n"] == 2


def test_cards_without_money_are_excluded_not_zeroed() -> None:
    """A mixed store: some SKUs priced, some not. The average must be over the
    measurable ones only, or every figure drifts toward nothing."""
    ledger = [
        row("2026-03-02", 30, margin_impact=100.0, over_cost=0.0),
        row("2026-03-03", 30, margin_impact=None, over_cost=None),
        row("2026-03-04", 30, margin_impact=50.0, over_cost=0.0),
    ]
    s = summarise(ledger)[30]
    assert s["cards_with_money"] == 2
    assert s["n"] == 3, "all three cards still count for the hit rate"
    assert s["net_margin_per_card"] == pytest.approx(75.0), (
        "the mean is over the two measurable cards, not over all three"
    )


def test_a_genuine_zero_net_is_not_an_absence() -> None:
    """A card that exactly broke even is a measurement of zero."""
    s = summarise([row("2026-03-02", 30, margin_impact=5.0, over_cost=5.0),
                   row("2026-03-03", 30, margin_impact=5.0, over_cost=5.0)])[30]
    assert s["net_margin_per_card"] == 0.0
    assert s["net_margin_per_card"] is not None
    assert s["cards_with_money"] == 2


def test_per_card_denominator_is_money_cards_not_all_cards() -> None:
    """Dividing by the wrong denominator is how a rate gets compared to a
    volume. The two arms place 1,056 and 2,080 bets; the per-card figure must
    say which count it used."""
    ledger = [row("2026-03-02", 30, margin_impact=90.0, over_cost=0.0)] + [
        row(f"2026-03-{d:02d}", 30, margin_impact=None, over_cost=None)
        for d in range(3, 13)
    ]
    s = summarise(ledger)[30]
    assert s["n"] == 11
    assert s["cards_with_money"] == 1
    assert s["net_margin_per_card"] == pytest.approx(90.0), (
        "90/1, not 90/11 - the ten unpriced cards are absences"
    )
