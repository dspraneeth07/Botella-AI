"""A curve fitted before a shift does not describe the store after it.

The guard this file tests is the one most at risk of being a loophole, so the
tests are weighted toward proving it is not: the threshold is the EXISTING ECE
bar, a store that has not moved is still judged, and `None` is still not a pass.
"""

from __future__ import annotations

import pytest

from app.pipeline.calibrate.staleness import Staleness, staleness_from_rates
from app.pipeline.gate.store import MAX_ECE_POINTS, gate_a, verdict_for

TOLERANCE = float(MAX_ECE_POINTS)


def drift(fit_rate: float, scored_rate: float, *, fit_n: int = 250,
          scored_n: int = 150) -> Staleness:
    return staleness_from_rates(
        fit_hits=int(round(fit_rate / 100 * fit_n)), fit_outcomes=fit_n,
        scored_hits=int(round(scored_rate / 100 * scored_n)),
        scored_outcomes=scored_n, tolerance_points=TOLERANCE)


def store(**over) -> dict:
    base = dict(
        loc="177", name="Mango Jo's", promise_fill_ratio=97.0, ece=21.5,
        interval_coverage=94.0, worst_bin_deviation=23.8,
        bt_edge=8.9, bt_p=0.0005,
        cards=130, money_cards30=130, calibration_scored=130,
        calibration_fitted=237, interval_considered=520,
        cost=0.95, net30=4611.0, cards_per_run=5.5,
        family_nets={"reorder": 35.5},
        calibration_is_stale=True,
        calibration_staleness_detail="hit rate moved +18.9 points",
    )
    return {**base, **over}


# ── The measurement ──────────────────────────────────────────────────────────


def test_drift_is_a_rate_difference_not_a_count_difference() -> None:
    """The fit window is deliberately larger than the scored one, so comparing
    counts would report the size difference as drift."""
    same_rate = staleness_from_rates(
        fit_hits=200, fit_outcomes=250, scored_hits=40, scored_outcomes=50,
        tolerance_points=TOLERANCE)
    assert same_rate.drift_points == pytest.approx(0.0)
    assert same_rate.is_stale is False


def test_the_five_measured_stores_land_where_they_should() -> None:
    """The observation that forced this guard: ECE tracks |drift| almost one for
    one. These are the measured pairs."""
    cases = [
        ("Marshfield", 86.3, 87.6, False),
        ("Bethany", 68.3, 70.2, False),
        ("Cork Runner", 75.9, 84.0, True),
        ("Northlake", 65.7, 56.1, True),
        ("Mango Jo's", 68.8, 87.7, True),
    ]
    for name, fit_rate, scored_rate, expected in cases:
        result = drift(fit_rate, scored_rate)
        assert result.is_stale is expected, (
            f"{name}: drift {result.drift_points:+.1f} against a "
            f"{TOLERANCE:.0f}-point tolerance")


def test_drift_is_signed_so_a_fall_is_distinguishable_from_a_rise() -> None:
    """Northlake fell 9.5 points and Mango Jo's rose 18.9. Both are stale, and a
    reader needs to know which."""
    fell, rose = drift(65.7, 56.1), drift(68.8, 87.7)
    assert fell.drift_points < 0
    assert rose.drift_points > 0
    # The SIGN must survive into the prose. Exact tenths are not asserted because
    # the helper rounds hits to whole cards, which moves a rate by ~0.1.
    assert "moved -" in fell.explain()
    assert "moved +" in rose.explain()
    # Tolerance of one card. On a 150-card scored window each card is worth 0.67
    # points, so a tighter bound would be asserting precision the grid cannot
    # express.
    assert fell.drift_points == pytest.approx(-9.5, abs=0.7)
    assert rose.drift_points == pytest.approx(18.9, abs=0.7)


# ── It is not a loophole ─────────────────────────────────────────────────────


def test_the_threshold_is_the_ece_bar_itself() -> None:
    """THE property that makes this principled rather than convenient. Since ECE
    is approximately |drift|, a store that moved further than the bar cannot meet
    it - so this is the existing threshold applied to the quantity that decides
    whether the threshold is reachable, not a new number."""
    assert drift(70.0, 70.0 + TOLERANCE).is_stale is False, "at the bar, not over"
    assert drift(70.0, 70.0 + TOLERANCE + 0.1).is_stale is True
    # And it moves WITH the bar rather than independently of it.
    tighter = staleness_from_rates(
        fit_hits=70, fit_outcomes=100, scored_hits=73, scored_outcomes=100,
        tolerance_points=2.0)
    assert tighter.is_stale is True
    looser = staleness_from_rates(
        fit_hits=70, fit_outcomes=100, scored_hits=73, scored_outcomes=100,
        tolerance_points=10.0)
    assert looser.is_stale is False


def test_a_store_that_has_not_moved_is_still_judged() -> None:
    """If this guard suppressed every calibration check it would have disabled
    the gate. A stationary store must still be held to its ECE."""
    stationary = store(calibration_is_stale=False, ece=21.5)
    result = gate_a(stationary)
    check = next(c for c in result.checks if c.name == "calibration_ece")
    assert check.passed is False, "a stationary store's high ECE is a real failure"
    assert "against <" in check.detail


def test_an_unmeasured_drift_does_not_suppress_anything() -> None:
    """Absence of evidence is not grounds to stop looking - which is the opposite
    of how absence is treated everywhere else here, so it is pinned."""
    nothing_fitted = staleness_from_rates(
        fit_hits=0, fit_outcomes=0, scored_hits=40, scored_outcomes=50,
        tolerance_points=TOLERANCE)
    assert nothing_fitted.drift_points is None
    assert nothing_fitted.is_stale is False


def test_not_testable_is_still_not_a_pass() -> None:
    """`None` has never satisfied a check in this gate, and a stale store is not
    asserted to be well calibrated - it is asserted to be unassessable."""
    stale = store()
    check = next(c for c in gate_a(stale).checks if c.name == "calibration_ece")
    assert check.passed is None
    assert check.passed is not True
    assert "STALE" in check.detail
    assert "refit" in check.detail, "the remedy travels with the finding"


def test_both_calibration_checks_are_suppressed_together() -> None:
    """Reliability bins are measured AGAINST the curve, so a bin 23.8 points out
    reports the size of the shift rather than the engine's calibration. Reporting
    one while suppressing the other would be incoherent."""
    checks = {c.name: c for c in gate_a(store()).checks}
    assert checks["calibration_ece"].passed is None
    assert checks["no_unreliable_confidence"].passed is None
    assert "STALE" in checks["no_unreliable_confidence"].detail


def test_staleness_does_not_touch_the_other_checks() -> None:
    """It is a statement about the CURVE. A store's promise, coverage, edge and
    money are measured without it and must be unaffected."""
    stale, fresh = store(), store(calibration_is_stale=False)
    for name in ("promise_unbiased", "interval_coverage", "beats_null"):
        a = next(c for c in gate_a(stale).checks if c.name == name)
        b = next(c for c in gate_a(fresh).checks if c.name == name)
        assert a.passed == b.passed, name
    assert (verdict_for(stale).gate_b.passed
            == verdict_for(fresh).gate_b.passed)


def test_a_stale_store_can_still_fail_on_money() -> None:
    """The case that keeps this honest: Cork Runner's curve is stale AND it earns
    $462 against a $1,000 bar. The guard must not rescue it."""
    cork = store(loc="181", name="Cork Runner", net30=462.0,
                 promise_fill_ratio=107.0, calibration_is_stale=True)
    v = verdict_for(cork)
    assert v.shippable is False
    assert "net_margin_per_month" in v.why


def test_the_explanation_carries_both_windows_and_their_sizes() -> None:
    """A drift measured on nine cards is not a drift, so a reader can discount it
    themselves."""
    text = drift(68.8, 87.7, fit_n=237, scored_n=130).explain()
    assert "237 cards" in text
    assert "130" in text
    assert "tolerance of 5" in text


def test_it_serialises_for_storage_beside_the_verdict() -> None:
    d = drift(68.8, 87.7).as_dict()
    for key in ("fit_window_hit_rate", "scored_hit_rate", "drift_points",
                "fit_outcomes", "scored_outcomes", "tolerance_points",
                "is_stale"):
        assert key in d, key
    assert d["is_stale"] is True
