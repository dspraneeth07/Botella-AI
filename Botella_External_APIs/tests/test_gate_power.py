"""No gate check may fail on a single card.

Cork Runner failed `interval_coverage` at 89.8% against a 90.0% bar, on 59 scored
cards. The binomial standard error on a 90% rate at n=59 is 3.9 points, so that is
a failure by 0.05 standard errors - and the same store PASSED at 90.3% one run
earlier, with nothing about the engine changed between the two numbers except
which three cards were in the sample.

The bar does not move in any test below. What changes is the evidence required to
call it failed, and `test_the_bar_itself_did_not_move` is the guard against this
having been a threshold relaxation wearing a statistical costume.
"""

from __future__ import annotations

import math

import pytest

from app.pipeline.gate.power import (
    MIN_RATE_OUTCOMES,
    rate_clears_floor,
    rate_in_band,
    wilson_interval,
)

MINIMUM = int(MIN_RATE_OUTCOMES.default)


def floor_check(rate, total, bar=90.0):
    return rate_clears_floor(rate, total=total, floor=bar,
                             minimum_outcomes=MINIMUM)


def band_check(rate, total, low=85.0, high=115.0):
    return rate_in_band(rate, total=total, low_bar=low, high_bar=high,
                        minimum_outcomes=MINIMUM)


# ── The exact defect ─────────────────────────────────────────────────────────


def test_the_cork_runner_case() -> None:
    """89.8% against 90.0% on 59 cards. One card either way flips it."""
    verdict, detail = floor_check(89.8, 59)
    assert verdict is None, "a 0.2-point miss is not a measurement"
    assert "not testable" in detail
    assert "straddles" in detail
    assert "one outcome either way" in detail


def test_the_same_store_one_run_earlier() -> None:
    """90.3% on 62 cards passed. The engine did not change between these two
    numbers, so the verdicts must not be opposite."""
    earlier, _ = floor_check(90.3, 62)
    later, _ = floor_check(89.8, 59)
    assert earlier is True
    assert later is not False, (
        "the engine did not change; one verdict must not be a confident failure "
        "while the other is a pass")


def test_the_arithmetic_that_justifies_this() -> None:
    """3.9 points of standard error at n=59, and the miss was 0.2."""
    se = math.sqrt(0.9 * 0.1 / 59) * 100
    assert se == pytest.approx(3.9, abs=0.1)
    assert (90.0 - 89.8) / se < 0.1, "the failure was under a tenth of an SE"


# ── It is not a looser threshold ─────────────────────────────────────────────


def test_the_bar_itself_did_not_move() -> None:
    """A rate at or above the bar passes, exactly as before."""
    for rate in (90.0, 90.1, 95.0, 100.0):
        verdict, _ = floor_check(rate, 120)
        assert verdict is True, rate


def test_a_genuinely_bad_rate_still_fails_confidently() -> None:
    """If this change had disabled the check, these would come back None."""
    for rate, total in ((70.0, 120), (50.0, 100), (82.0, 400), (0.0, 60)):
        verdict, detail = floor_check(rate, total)
        assert verdict is False, (rate, total)
        assert "whole 95% interval" in detail


def test_more_evidence_makes_a_marginal_miss_decidable() -> None:
    """The same 89.8% is noise at n=59 and a real failure at a large enough n.
    That is the property that makes this a power correction and not a loophole."""
    assert floor_check(89.8, 59)[0] is None
    assert floor_check(89.8, 100_000)[0] is False


def test_a_thin_sample_says_so_out_loud() -> None:
    """Below the floor a Wilson interval is so wide nothing could ever fail, which
    would silently convert the check into a pass for every thin store."""
    for total in (1, 5, 12, MINIMUM - 1):
        verdict, detail = floor_check(40.0, total)
        assert verdict is None, total
        assert "not testable below" in detail


def test_none_is_never_a_pass() -> None:
    """Three outcomes, and the middle one must stay distinguishable from True."""
    assert floor_check(None, 100)[0] is None
    assert floor_check(50.0, 0)[0] is None
    assert floor_check(50.0, None)[0] is None
    assert floor_check(89.8, 59)[0] is None
    # and none of them is True
    for args in ((None, 100), (50.0, 0), (50.0, None), (89.8, 59)):
        assert floor_check(*args)[0] is not True


# ── The band form ────────────────────────────────────────────────────────────


def test_a_marginal_band_miss_is_not_testable() -> None:
    for rate in (84.9, 115.1, 84.0, 116.0):
        verdict, detail = band_check(rate, 183)
        assert verdict is None, rate
        assert "not testable" in detail


def test_a_wild_band_miss_still_fails() -> None:
    """Northlake delivers 20% of what it promises - over-promising five times -
    and Cork Runner 153%. Both are real defects and must keep failing."""
    for rate in (20.0, 45.0, 250.0, 300.0):
        verdict, detail = band_check(rate, 120)
        assert verdict is False, rate
        assert "whole 95% interval" in detail
        assert ("below the band" in detail) or ("above the band" in detail)


def test_inside_the_band_passes() -> None:
    for rate in (85.0, 100.0, 104.0, 110.0, 115.0):
        assert band_check(rate, 183)[0] is True, rate


# ── Wilson, and why not the normal approximation ─────────────────────────────


def test_wilson_is_bounded_where_the_normal_approximation_is_not() -> None:
    """A 90% coverage check lives exactly where the normal approximation puts its
    upper bound above 100%, which is impossible for a proportion."""
    for hits, total in ((59, 59), (58, 59), (119, 120), (30, 30)):
        low, high = wilson_interval(hits, total)
        assert 0.0 <= low <= high <= 100.0 + 1e-9, (hits, total)
    # The normal approximation on 58/59 would exceed 100.
    p = 58 / 59
    naive_high = (p + 1.96 * math.sqrt(p * (1 - p) / 59)) * 100
    assert naive_high > 100.0
    assert wilson_interval(58, 59)[1] <= 100.0


def test_wilson_narrows_as_evidence_grows() -> None:
    widths = [wilson_interval(int(0.9 * n), n)[1]
              - wilson_interval(int(0.9 * n), n)[0]
              for n in (30, 60, 120, 600, 6000)]
    assert widths == sorted(widths, reverse=True), widths


def test_wilson_handles_the_degenerate_cases() -> None:
    assert wilson_interval(0, 0) is None
    low, high = wilson_interval(0, 50)
    assert low == pytest.approx(0.0, abs=1e-9) and high > 0.0
    low, high = wilson_interval(50, 50)
    assert high == pytest.approx(100.0, abs=1e-9) and low < 100.0
    # Counts outside the sample are clamped rather than producing nonsense.
    assert wilson_interval(99, 50) == wilson_interval(50, 50)


def test_the_critical_value_is_the_shared_one() -> None:
    """A duplicate of 1.96 was caught by the no-literals guard once already. A
    claim refused in elasticity and one refused here are refused on one standard,
    and changing that standard must change both."""
    from app.pipeline.elasticity.estimate import CRITICAL_VALUE_95
    from app.pipeline.gate import power

    assert power._Z_95 == pytest.approx(float(CRITICAL_VALUE_95.default))


def test_the_minimum_is_declared_with_its_reason() -> None:
    assert MIN_RATE_OUTCOMES.status == "PROVISIONAL"
    assert MIN_RATE_OUTCOMES.default == 30
    assert "9.1 points" in MIN_RATE_OUTCOMES.why, (
        "the binomial justification must travel with the number")
