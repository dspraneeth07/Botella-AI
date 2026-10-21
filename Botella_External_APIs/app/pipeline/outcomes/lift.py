"""THE definition of lift, on the Python side. The same one Node uses.

WHY THIS FILE IS A TRANSLATION AND NOT AN IMPLEMENTATION
    There were two definitions. `recommendationEvalService.js` used a 28-day
    baseline and pooled the ratio across a recommendation's SKUs;
    `app/store_data/feedback.py` used a 21-day baseline, a fixed 7-day post
    window, and the unweighted MEAN of per-SKU ratios. On identical data those
    produce answers 1.37x apart.

    That is the 454-vs-485 failure - a figure that differed between two screens
    while the owner was told in writing that they matched - reproduced in the
    metric the entire feedback loop depends on. Calibration fits on lift. The
    shrinkage constant k is fitted from it. The gate judges on it.

    So `backend/lib/lift.js` owns the arithmetic and this is its twin, pinned
    to it by a shared golden fixture (`tests/lift-parity-verify.js`) in the
    same way sheet 08 pins the stage envelope across the two languages.

THE THREE DECISIONS, RESTATED SO THIS FILE CAN BE READ ALONE

    1. OPEN DAYS, NEVER CALENDAR DAYS. A 28-calendar-day window at Bethany
       holds 23 open days, so a rate divided by 28 is understated by 21.7%;
       stores 101-103 are worse at 27.3%. Both windows use open days, because
       dividing one by open days and multiplying by calendar days only moves
       the error somewhere less visible.

    2. A POOLED RATIO, NOT A MEAN OF RATIOS. sum(actual) / sum(expected). A
       recommendation covering a 100-unit SKU and a 1-unit SKU is mostly about
       the 100-unit one; the mean of ratios lets the quiet SKU carry half the
       answer on a single basket's swing.

    3. A ZERO BASELINE IS NOT A ZERO DENOMINATOR. A SKU with no trailing sales
       has an UNDEFINED lift, not an infinite one. Its sales are reported as
       upside instead.

`lift=None` ALWAYS MEANS UNMEASURABLE, NEVER "NO EFFECT"
    A caller that reads None as 1.0 turns "we could not tell" into "it did
    nothing" - the same class of error as reading a missing count as zero, and
    the one this whole programme is built to remove.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from app.pipeline.registry import Setting

LIFT_CAP = Setting(
    name="outcomes.lift_cap",
    default=5.0,
    unit="multiples of the baseline, above which a lift is capped for scoring",
    owner="forecasting",
    why="provisional; a lift of 40x is a data error or a one-off case buy, not "
        "a recommendation working forty times as well as normal. Uncapped, one "
        "such row decides a store's verdict on its own. The RAW lift is always "
        "stored - only the SCORE is capped - so nothing is lost and the cap can "
        "be refitted from history once the loop has run",
    status="PROVISIONAL",
)

#: The cap's default, for callers with no RunContext to hand. Reading the
#: Setting needs a ctx; a scoring helper called from a pure function does not
#: always have one, and `score_from_lift` takes it as an argument instead.
DEFAULT_LIFT_CAP = LIFT_CAP.default


@dataclass(frozen=True, slots=True)
class SkuOutcome:
    """One SKU's trailing baseline and what it actually did."""

    sku: str
    baseline_units: float
    actual_units: float


@dataclass(frozen=True, slots=True)
class Lift:
    """A lift, and everything needed to argue with it."""

    lift: float | None
    expected: float
    actual: float
    upside_units: float
    baselined_skus: int
    upside_skus: int
    measurable: bool
    #: Why it could not be measured. Never empty when `measurable` is False -
    #: "unmeasurable" with no reason is a refusal nobody can act on.
    reason: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "lift": self.lift, "expected": self.expected, "actual": self.actual,
            "upside_units": self.upside_units,
            "baselined_skus": self.baselined_skus,
            "upside_skus": self.upside_skus,
            "measurable": self.measurable, "reason": self.reason,
        }


def _round2(value: float) -> float:
    """Two decimals - the resolution a lift is ever reported at.

    Rounded the same way and at the same point as the JavaScript, so the two
    agree to the last digit rather than to within a tolerance.
    """
    return round(value + 0.0, 2)


def _unmeasurable(reason: str) -> Lift:
    return Lift(lift=None, expected=0.0, actual=0.0, upside_units=0.0,
                baselined_skus=0, upside_skus=0, measurable=False,
                reason=reason)


def lift_for(
    skus: Sequence[SkuOutcome],
    baseline_open_days: float,
    window_open_days: float,
) -> Lift:
    """Lift for one recommendation. OPEN days in both windows.

    Mirrors `liftFor` in `backend/lib/lift.js`, statement for statement.
    """
    if not baseline_open_days or baseline_open_days <= 0:
        return _unmeasurable(
            "no open days in the baseline window - the store was closed or "
            "unsynced throughout it"
        )
    if not window_open_days or window_open_days <= 0:
        return _unmeasurable(
            "no open days in the measurement window - nothing could have sold"
        )

    expected = 0.0
    actual = 0.0
    upside_units = 0.0
    baselined = 0
    upside = 0

    for row in skus:
        base = float(row.baseline_units or 0.0)
        sold = float(row.actual_units or 0.0)
        if base > 0:
            expected += (base / baseline_open_days) * window_open_days
            actual += sold
            baselined += 1
        else:
            upside_units += sold
            upside += 1

    def result(lift: float | None, reason: str | None) -> Lift:
        """Written once so the six shared fields cannot drift between the three
        exits - the same reason `liftFor` builds one object in JavaScript."""
        return Lift(
            lift=lift,
            expected=_round2(expected),
            actual=_round2(actual),
            upside_units=_round2(upside_units),
            baselined_skus=baselined,
            upside_skus=upside,
            measurable=lift is not None,
            reason=reason,
        )

    if not baselined:
        return result(None, "no SKU on this recommendation had a trailing "
                            "baseline to measure against")
    if expected <= 0:
        return result(None, "the baseline projects zero units over this window")
    return result(_round2(actual / expected), None)


def score_from_lift(
    lift: float | None, cap: float = DEFAULT_LIFT_CAP
) -> float | None:  # noqa: D401
    """Lift squashed to 0-1. 1.0x -> 0.5, so neutral is the midpoint.

    Here rather than beside the callers for the same reason as `lift_for`: a
    score and the lift it came from must agree, and they only do if one file
    owns both.
    """
    if lift is None:
        return None
    capped = min(max(float(lift), 0.0), float(cap))
    return round(capped / (capped + 1) + 0.0, 3)


__all__ = ["DEFAULT_LIFT_CAP", "LIFT_CAP", "Lift", "SkuOutcome",
           "lift_for", "score_from_lift"]
