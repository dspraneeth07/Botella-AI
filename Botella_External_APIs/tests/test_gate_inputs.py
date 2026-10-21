"""The four gate checks that had never run, and the arithmetic that proves why
one of them never could."""

from __future__ import annotations

from datetime import date

import pytest

from scripts._gate_inputs import (
    ALL_HORIZONS,
    PRIMARY_HORIZON,
    GateInputs,
    calibration_out_of_sample,
    cards_per_run,
    family_nets,
    gate_inputs_for,
    interval_coverage,
    promise_fill_ratio,
    promise_kept_rate,
)
from app.pipeline.context import RunContext

AS_OF = date(2026, 3, 1)


def ctx() -> RunContext:
    return RunContext(
        run_id="run-gi", tenant_id=1, store_id=171, as_of=AS_OF,
        snapshot_id="snap-1", config_version="default", seed=0,
        versions={"calibrate_fit": "1.0.0", "calibrate_apply": "1.0.0",
                  "predictive_interval": "1.0.0"},
    )


def card(
    *, promised=10.0, gained=10.0, actual=20.0, expected=10.0, p_hit=0.6,
    hit=True, recent_rate=0.5, reverted_rate=0.7, cv=0.5, margin=5.0,
    held=1.0, as_of="2026-03-01", family="reorder", horizons=ALL_HORIZONS,
) -> dict:
    outcome = {
        "expected": expected, "actual": actual, "gained_units": gained,
        "promised_units": promised, "hit": hit, "margin_impact": margin,
        "over_ordered_cost": held, "lift": 1.2,
    }
    return {
        "as_of": as_of, "sku": "SKU1", "p_hit": p_hit, "family": family,
        "recent_rate": recent_rate, "reverted_rate": reverted_rate,
        "dispersion_cv": cv,
        "outcomes": {h: dict(outcome) for h in horizons},
    }


# ── 1. The promise, as a bias test ───────────────────────────────────────────


def test_fill_ratio_is_a_ratio_of_totals_not_a_mean_of_ratios() -> None:
    """One card that promised 0.4 units and delivered 16 has a ratio of 40x. A
    mean of per-card ratios lets that single card carry the whole store."""
    ledger = [
        card(promised=0.4, gained=16.0),      # ratio 40x
        *[card(promised=10.0, gained=10.0) for _ in range(9)],
    ]
    ratio = promise_fill_ratio(ledger)
    # Totals: 106 delivered on 90.4 promised = 117%. A mean of ratios would be
    # (40 + 9*1)/10 = 490%.
    assert ratio == pytest.approx((16.0 + 90.0) / 90.4 * 100.0)
    assert ratio < 200.0, "a mean of ratios would be nearly 500% here"


def test_an_unbiased_promise_scores_one_hundred_percent() -> None:
    ledger = [card(promised=10.0, gained=10.0) for _ in range(5)]
    assert promise_fill_ratio(ledger) == pytest.approx(100.0)


def test_over_and_under_promising_land_on_opposite_sides_of_100() -> None:
    over = [card(promised=50.0, gained=10.0) for _ in range(5)]
    under = [card(promised=10.0, gained=50.0) for _ in range(5)]
    assert promise_fill_ratio(over) == pytest.approx(20.0)
    assert promise_fill_ratio(under) == pytest.approx(500.0)


def test_a_card_with_no_promise_is_excluded_not_counted_as_zero() -> None:
    ledger = [card(promised=10.0, gained=10.0),
              card(promised=0.0, gained=5.0),
              card(promised=None, gained=5.0)]
    assert promise_fill_ratio(ledger) == pytest.approx(100.0)
    assert promise_fill_ratio([card(promised=0.0)]) is None


# ── The arithmetic that retired the old check ────────────────────────────────


def test_the_kept_rate_is_bounded_above_by_the_hit_rate() -> None:
    """THE reason `promise_kept` is measured but not gated. A promise of at least
    one unit can only be kept on a card whose realised increment is at least one
    unit, so no promise whatsoever can push this above the hit rate - and banding
    it at 85-95% would be the accuracy target restated as an independent check.
    """
    # Seven cards gain a unit or more, three decline. The hit rate is 70%.
    ledger = ([card(promised=5.0, gained=9.0) for _ in range(7)]
              + [card(promised=5.0, gained=-2.0) for _ in range(3)])
    hit_rate = 70.0
    assert promise_kept_rate(ledger) == pytest.approx(hit_rate)

    # Now shrink the promise as far as it can go while staying a real promise.
    # It still cannot exceed the hit rate, because the three decliners can never
    # deliver a positive increment however little is promised.
    for promise in (5.0, 2.0, 1.0, 0.5, 0.01):
        shrunk = ([card(promised=promise, gained=9.0) for _ in range(7)]
                  + [card(promised=promise, gained=-2.0) for _ in range(3)])
        assert promise_kept_rate(shrunk) <= hit_rate + 1e-9, promise


def test_a_kept_rate_of_ninety_requires_a_hit_rate_of_ninety() -> None:
    """Stated the other way round, which is the form that shows the old band was
    unreachable: the measured hit rates are 83 / 76 / 71 / 62 / 49%."""
    for hits, total in ((83, 100), (76, 100), (71, 100), (62, 100), (49, 100)):
        ledger = ([card(promised=1.0, gained=5.0) for _ in range(hits)]
                  + [card(promised=1.0, gained=-1.0)
                     for _ in range(total - hits)])
        assert promise_kept_rate(ledger) < 85.0, hits


# ── 2 & 3. Calibration, out of sample ────────────────────────────────────────


def test_calibration_is_fitted_on_one_slice_and_scored_on_another() -> None:
    """Fitting and scoring on the same slice measures how well a step function can
    memorise 200 points, which is perfectly, and would report an ECE near zero at
    every store forever."""
    # A badly calibrated raw score: understates throughout. Spread across four
    # confidence levels because the fitter refuses a slice with fewer distinct
    # values than MIN_DISTINCT_CONFIDENCES - a curve through one point is a
    # constant, and the guard is right to decline it.
    def slice_of(scale: int) -> list[dict]:
        rows = []
        for raw, true_rate in ((0.3, 0.6), (0.4, 0.7), (0.5, 0.8), (0.6, 0.9)):
            hits = int(round(true_rate * scale))
            rows += [card(p_hit=raw, hit=True) for _ in range(hits)]
            rows += [card(p_hit=raw, hit=False) for _ in range(scale - hits)]
        return rows

    fit_slice = slice_of(25)        # 100 cards
    score_slice = slice_of(20)      # 80 cards

    ece, worst, scored, fitted, _thin, brier, transform = \
        calibration_out_of_sample(
            fit_ledgers=[fit_slice], score_ledger=score_slice, ctx=ctx())

    assert scored == 80 and fitted == 100
    assert transform != "identity", "a curve was fitted, so say so"
    # The curve learns the mapping and the out-of-sample gap collapses. Measured
    # against the RAW score on the same slice, so the claim is a comparison and
    # not an absolute that a lucky slice could satisfy on its own.
    raw_ece, *_ = calibration_out_of_sample(
        fit_ledgers=[], score_ledger=score_slice, ctx=ctx())
    assert ece is not None and raw_ece is not None
    assert ece < raw_ece / 2.0, (ece, raw_ece)
    assert brier is not None


def test_no_fit_slice_means_the_raw_score_is_scored_and_labelled() -> None:
    """With nothing to fit on, apply runs the identity transform. The ECE then
    describes the RAW score, and the transform field is what stops that being
    read as a calibrated one."""
    score_slice = ([card(p_hit=0.6, hit=True) for _ in range(90)]
                   + [card(p_hit=0.6, hit=False) for _ in range(10)])
    ece, _worst, scored, fitted, _thin, _brier, transform = \
        calibration_out_of_sample(
            fit_ledgers=[], score_ledger=score_slice, ctx=ctx())
    assert fitted == 0 and scored == 100
    assert transform == "identity"
    # Stating 0.6 while hitting 90% is 30 points out, and it is reported as such.
    assert ece is not None and ece > 20.0


def test_an_empty_score_slice_measures_nothing_rather_than_passing() -> None:
    ece, worst, scored, _fitted, _thin, brier, _t = calibration_out_of_sample(
        fit_ledgers=[[card()]], score_ledger=[], ctx=ctx())
    assert ece is None and worst is None and brier is None and scored == 0


def test_thin_bins_are_excluded_from_the_worst_bin_but_counted() -> None:
    """At n = 30 and p = 0.5 the binomial standard error is 9.1 points, which is
    the floor at which a 10-point test stops measuring noise. A five-card bin
    condemned a whole store once already."""
    # A large well-behaved bin, plus three cards in a far-off bin that are wrong.
    score_slice = ([card(p_hit=0.9, hit=True) for _ in range(90)]
                   + [card(p_hit=0.9, hit=False) for _ in range(10)]
                   + [card(p_hit=0.1, hit=True) for _ in range(3)])
    _ece, worst, _scored, _fitted, thin, _brier, _t = calibration_out_of_sample(
        fit_ledgers=[], score_ledger=score_slice, ctx=ctx())
    assert thin >= 1, "the three-card bin is counted as thin"
    # The 3-card bin is 90 points out; it must NOT be the reported worst bin.
    assert worst is None or worst < 50.0


# ── 4. Interval coverage ─────────────────────────────────────────────────────


def test_coverage_takes_the_worst_horizon_not_the_mean() -> None:
    """A range that holds at 90 days and fails at 30 is not a range the owner can
    rely on, and averaging the two hides the horizon they are standing in."""
    # Actual lands far outside the interval at 30d only.
    ledger = []
    for _ in range(40):
        c = card(actual=20.0, expected=10.0, recent_rate=0.5, reverted_rate=0.7)
        c["outcomes"]["30"]["actual"] = 9_999.0      # wildly outside
        ledger.append(c)
    worst, refused, considered = interval_coverage(ledger, ctx())
    assert worst == pytest.approx(0.0), "the worst horizon is 30d at 0%"
    assert refused == 0 and considered > 0


def test_a_refused_interval_is_neither_a_hit_nor_a_miss() -> None:
    """Folding refusals in as misses punishes the engine for declining to state a
    range; folding them in as hits rewards it for saying nothing."""
    good = [card() for _ in range(10)]
    # cv absent - the interval refuses rather than assuming the narrowest one.
    bad = [card(cv=None) for _ in range(10)]
    worst_good, refused_good, _ = interval_coverage(good, ctx())
    worst_both, refused_both, considered = interval_coverage(good + bad, ctx())

    assert refused_good == 0
    assert refused_both == 10 * len(ALL_HORIZONS)
    # The RATE is unchanged by adding ten unmeasurable cards.
    assert worst_both == pytest.approx(worst_good)
    assert considered == 20 * len(ALL_HORIZONS)


def test_open_days_are_backed_out_of_expected_not_assumed_calendar() -> None:
    """`expected = recent_rate * window_open_days` by construction, so this
    inverts it. Bethany trades 25.7 days in a 30-day window and using 30 would
    inflate every interval's mean by 16.8%."""
    # recent_rate 0.5, expected 12.85 -> 25.7 open days, not 30.
    c = card(recent_rate=0.5, expected=12.85, reverted_rate=0.5, actual=13.0)
    worst, refused, _ = interval_coverage([c], ctx(), horizons=(PRIMARY_HORIZON,))
    assert refused == 0
    # mean = 0.5 * 25.7 = 12.85, and an actual of 13 sits inside a 90% range.
    assert worst == pytest.approx(100.0)


def test_a_card_without_a_rate_is_skipped_rather_than_defaulted() -> None:
    worst, refused, considered = interval_coverage(
        [card(recent_rate=0.0)], ctx(), horizons=(PRIMARY_HORIZON,))
    assert worst is None and considered == 1 and refused == 1


# ── 5 & 6. The gate B checks that never ran ──────────────────────────────────


def test_family_nets_excludes_unpriced_cards_rather_than_zeroing_them() -> None:
    """Five of ten audited stores send no unit cost at all. Folding them in as 0.0
    would drag every family's average toward nothing and call it a measurement."""
    ledger = [
        card(family="reorder", margin=20.0, held=5.0),
        card(family="reorder", margin=10.0, held=5.0),
        card(family="understock", margin=8.0, held=2.0),
        card(family="understock", margin=None, held=None),   # no cost data
    ]
    nets = family_nets(ledger)
    assert nets["reorder"] == pytest.approx(((20 - 5) + (10 - 5)) / 2)
    assert nets["understock"] == pytest.approx(8 - 2), "the unpriced card is out"
    assert all(v is not None for v in nets.values())


def test_cards_per_run_is_per_decision_date() -> None:
    ledger = ([card(as_of="2026-03-01") for _ in range(6)]
              + [card(as_of="2026-03-02") for _ in range(4)])
    assert cards_per_run(ledger) == pytest.approx(5.0)
    assert cards_per_run([]) is None


# ── Assembly ─────────────────────────────────────────────────────────────────


def test_gate_inputs_carry_every_field_the_gate_reads() -> None:
    """Four of seven checks printed "not measured" at every store since the day
    the gate was written, because nothing computed these fields."""
    ledger = ([card(p_hit=0.6, hit=True) for _ in range(60)]
              + [card(p_hit=0.6, hit=False) for _ in range(20)])
    prior = ([card(p_hit=0.6, hit=True) for _ in range(70)]
             + [card(p_hit=0.6, hit=False) for _ in range(30)])

    result = gate_inputs_for(ledger=ledger, prior_ledgers=[prior],
                             store_id=171, as_of=AS_OF)
    assert isinstance(result, GateInputs)
    d = result.as_dict()
    for field in ("promise_fill_ratio", "ece", "worst_bin_deviation",
                  "interval_coverage", "family_nets", "cards_per_run"):
        assert field in d, field
        assert d[field] is not None, f"{field} is what the gate reads"
    # And the provenance of the calibration figure travels with it.
    assert d["calibration_fitted"] == 100
    assert d["calibration_scored"] == 80
    assert d["calibration_transform"]


def test_none_is_never_silently_a_zero() -> None:
    """An empty ledger measures nothing. Every field reads None, which the gate
    treats as "not measured" and never as a pass."""
    result = gate_inputs_for(ledger=[], prior_ledgers=[], store_id=171,
                             as_of=AS_OF)
    assert result.promise_fill_ratio is None
    assert result.ece is None
    assert result.worst_bin_deviation is None
    assert result.interval_coverage is None
    assert result.cards_per_run is None
    assert result.family_nets == {}
