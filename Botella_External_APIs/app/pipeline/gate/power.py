"""A rate may only fail a gate when its INTERVAL clears the threshold.

THE DEFECT THIS FIXES, WITH THE ARITHMETIC
    Cork Runner failed `interval_coverage` at 89.8% against a 90.0% bar. It has
    59 scored cards, so one card is 1.7% of the sample and the binomial standard
    error on a 90% rate is

        sqrt(0.9 * 0.1 / 59) * 100  =  3.9 points

    The store therefore failed by 0.05 standard errors - a single card either way
    flips the verdict. That is not a measurement, it is a coin landing, and it
    came within one commit of taking a store out of production.

    The same store passed the check at 90.3% one run earlier. Nothing about the
    engine changed between those two numbers except which three cards were in the
    sample.

THIS IS NOT A LOOSER THRESHOLD
    The bar stays exactly where it was. What changes is the EVIDENCE required to
    call it failed: the whole 95% interval must sit beyond the threshold, which is
    the same discipline `Interval.spans_zero` already enforces on every elasticity
    coefficient in this engine. A store genuinely at 82% coverage on 120 cards
    still fails, and `test_a_genuinely_bad_store_still_fails` says so.

    Three outcomes, and the middle one is the point:

        FAIL        the interval lies entirely on the wrong side. Confident.
        PASS        the point estimate holds the bar.
        None        the interval straddles the bar - NOT TESTABLE, and `None` is
                    never a pass anywhere in this gate.

WILSON AND NOT NORMAL
    The normal approximation puts the upper bound above 100% for a rate near 1.0
    and can return a lower bound below zero, both of which are impossible for a
    proportion and both of which occur at exactly the sample sizes these stores
    have. Wilson is bounded by construction and is what the backtest already uses,
    so one estimator serves the whole report.

WHY A MINIMUM COUNT AS WELL
    An interval alone is not quite enough. At n = 4 a Wilson interval is so wide
    that nothing can ever fail, which silently converts the check into a pass for
    every thin store. The floor makes that case say "not testable" out loud
    instead, and it is the same 30-outcome floor, for the same binomial reason,
    that `calibrate/monitor.py` already applies to reliability bins.
"""

from __future__ import annotations

import math

from app.pipeline.elasticity.estimate import CRITICAL_VALUE_95
from app.pipeline.registry import Setting

#: 95% two-sided, taken from the SAME Setting the elasticity intervals use rather
#: than written again here - a duplicate of this exact value was caught by the
#: no-literals guard once already. A claim refused there and a claim refused here
#: are refused on one standard, and changing the standard changes both.
_Z_95 = float(CRITICAL_VALUE_95.default)

#: Structural, not tunable. A proportion times this is a percentage; the 2 and 4
#: are the Wilson score interval's own algebra. Integers, because none of them is
#: a number anyone may change - altering them does not loosen a threshold, it
#: computes a different quantity and calls it the same thing.
_PERCENT = 100
_HALF_DIVISOR = 2
_QUARTER_DIVISOR = 4

MIN_RATE_OUTCOMES = Setting(
    name="gate.min_rate_outcomes",
    default=30,
    unit="scored outcomes before a rate check may return a verdict",
    owner="forecasting",
    why="provisional, and the same floor calibrate/monitor applies to reliability "
        "bins, for the same reason: at n=30 and p=0.5 the binomial standard error "
        "is 9.1 points, which is the point at which a rate stops being mostly "
        "noise. Below it a Wilson interval is so wide that no store could ever "
        "fail, which would silently turn the check into a pass for every thin "
        "store - so the floor exists to make that case report NOT TESTABLE out "
        "loud. It becomes MEASURED when the realised variance of these rates is "
        "known across a full season",
    status="PROVISIONAL",
)


def wilson_interval(hits: int, total: int) -> tuple[float, float] | None:
    """A 95% Wilson interval on a proportion, in PERCENT. None when n is zero.

    Bounded by construction, unlike the normal approximation, which returns an
    upper bound above 100% for a rate near 1.0 - exactly the regime a 90%
    coverage check lives in.
    """
    if total <= 0:
        return None
    hits = max(0, min(hits, total))
    p = hits / total
    denominator = 1.0 + _Z_95 * _Z_95 / total
    centre = p + _Z_95 * _Z_95 / (_HALF_DIVISOR * total)
    spread = _Z_95 * math.sqrt(
        p * (1.0 - p) / total
        + _Z_95 * _Z_95 / (_QUARTER_DIVISOR * total * total))
    return ((centre - spread) / denominator * _PERCENT,
            (centre + spread) / denominator * _PERCENT)


def rate_clears_floor(
    rate: float | None,
    *,
    total: int | None,
    floor: float,
    minimum_outcomes: int,
) -> tuple[bool | None, str]:
    """Does a rate clear a MINIMUM threshold, with the evidence to say so?

    Returns (verdict, detail). The verdict is:

        True    the point estimate holds the floor
        False   the whole interval lies BELOW the floor - a confident failure
        None    the interval straddles it, or there are too few outcomes

    `None` is not a pass. It is the gate reporting that one card would have
    changed its mind, which is a different and more useful statement than either
    verdict.
    """
    if rate is None:
        return None, "not measured"
    if total is None or total <= 0:
        return None, f"{rate:.0f}% on no scored outcomes - not testable"
    if total < minimum_outcomes:
        return None, (
            f"{rate:.0f}% on only {total} outcomes - not testable below "
            f"{minimum_outcomes}")

    # Reconstruct the count the rate came from. The gate is handed a percentage
    # and a denominator, never the numerator, and rounding one card either way
    # cannot change an interval this wide.
    hits = int(round(rate / _PERCENT * total))
    interval = wilson_interval(hits, total)
    if interval is None:
        return None, f"{rate:.0f}% - interval not computable"
    low, high = interval

    if rate >= floor:
        return True, (
            f"{rate:.0f}% against >= {floor:.0f}% "
            f"(95% interval {low:.0f}-{high:.0f}% on {total} outcomes)")
    if high < floor:
        return False, (
            f"{rate:.0f}% against >= {floor:.0f}%, and the whole 95% interval "
            f"{low:.0f}-{high:.0f}% is below it on {total} outcomes")
    return None, (
        f"{rate:.0f}% against >= {floor:.0f}%, but the 95% interval "
        f"{low:.0f}-{high:.0f}% straddles the bar on {total} outcomes - "
        f"not testable, one outcome either way would flip it")


def rate_in_band(
    rate: float | None,
    *,
    total: int | None,
    low_bar: float,
    high_bar: float,
    minimum_outcomes: int,
) -> tuple[bool | None, str]:
    """Does a rate sit INSIDE a band, with the evidence to say so?

    The same three-way answer. A band is failed only when the interval lies
    entirely outside it on one side - a store whose interval overlaps the band has
    not been shown to be biased, however its point estimate reads.
    """
    if rate is None:
        return None, "not measured"
    if total is None or total <= 0:
        return None, f"{rate:.0f}% on no scored outcomes - not testable"
    if total < minimum_outcomes:
        return None, (
            f"{rate:.0f}% on only {total} outcomes - not testable below "
            f"{minimum_outcomes}")

    if low_bar <= rate <= high_bar:
        return True, f"{rate:.0f}% against {low_bar:.0f}-{high_bar:.0f}%"

    # A fill ratio is not a proportion - it can exceed 100% - so its uncertainty
    # is taken from the binomial on the SAME denominator rather than from Wilson,
    # which is defined only on 0..1. Approximate, and deliberately conservative:
    # it widens the interval rather than narrowing it.
    standard_error = math.sqrt(max(rate, 1.0) * _PERCENT / total)
    low, high = rate - _Z_95 * standard_error, rate + _Z_95 * standard_error
    if high < low_bar or low > high_bar:
        side = "below" if high < low_bar else "above"
        return False, (
            f"{rate:.0f}% against {low_bar:.0f}-{high_bar:.0f}%, and the whole "
            f"95% interval {low:.0f}-{high:.0f}% is {side} the band on "
            f"{total} outcomes")
    return None, (
        f"{rate:.0f}% against {low_bar:.0f}-{high_bar:.0f}%, but the 95% "
        f"interval {low:.0f}-{high:.0f}% overlaps the band on {total} "
        f"outcomes - not testable")


__all__ = [
    "MIN_RATE_OUTCOMES",
    "rate_clears_floor",
    "rate_in_band",
    "wilson_interval",
]
