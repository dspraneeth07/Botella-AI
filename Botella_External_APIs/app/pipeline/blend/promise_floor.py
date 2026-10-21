"""The promise, in the only form the arithmetic permits — and why.

TWO FORMS OF THE SAME IDEA, AND ONLY ONE IS POSSIBLE
    N1.1 asked for a promise at a LOW QUANTILE, so that a card is kept more often
    than a mean would be. That is the right instinct and it comes in two shapes:

        on the INCREMENT  "expect at least N units MORE than your current rate"
        on the TOTAL      "at least N units will sell over the period"

    The first is impossible for this engine's candidate population. The second is
    not only possible, it is already published on every card and holds 95.5% of
    the time. This module states the floor explicitly and refuses the increment
    form with the arithmetic rather than with a TODO.

WHY THE INCREMENT FORM IS REFUTED, NOT MERELY UNFITTED
    A low quantile of a count sits well below its mean, and how far below is set
    by dispersion. For `p_low(total) - baseline` to clear zero, the forecast has
    to beat the baseline by more than that shortfall:

        cv    p05/mean    uplift the floor REQUIRES
        0.00      0.70                      1.43x
        0.25      0.53                      1.88x
        0.45      0.33                      3.00x
        0.60      0.23                      4.29x
        0.80      0.10                     10.00x
        1.00      0.03                     30.00x

    Now the uplifts this engine actually recommends on, by dispersion band, over
    513 measured cards:

        cv 0.00-0.25  smooth        4% of candidates   median uplift 1.21x
        cv 0.25-0.45  near-smooth  32%                 median uplift 1.45x
        cv 0.45-0.70  erratic      38%                 median uplift 1.67x
        cv 0.70+      lumpy        26%                 median uplift 2.26x

    DISPERSION AND UPLIFT ARE ANTI-CORRELATED. The products steady enough to
    carry a floor have no uplift to promise; the products with the uplift are too
    erratic for a floor to clear. Each band fails for the opposite reason, which
    is precisely why "fit the band per demand class" cannot rescue it - there is
    no class where both conditions hold. Measured: 0 of 513 cards.

    That is a stronger statement than the one it replaces. The old note said the
    band was "pooled across demand classes and must be fitted per class", which
    sent the next reader after a fit that does not exist. Six formulations were
    tried - the published formula, per-class, p10 of the increment, per-class
    deficit calibration, a conditional floor among winners, and the predictive
    interval - and the arithmetic above is why none of them worked.

WHAT IS SHIPPED INSTEAD, AND IT IS THE SAME PROMISE
    The low end of the published 90% predictive interval, as an explicit floor on
    the total. Measured over the same 513 cards: held 95.5% of the time, by store
    99.4 / 98.5 / 96.5 / 94.0 / 84.7%. It is positive, it is checkable against the
    till, and the owner can hold the engine to it.

    `deficit_units` is untouched. It remains the expectation the gate measures for
    bias, and the floor sits beside it rather than competing with it - which is
    what N1 meant by promise and order being different numbers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.pipeline.blend.predictive_interval import (
    PredictiveInterval,
    predictive_interval,
)
from app.pipeline.context import RunContext
from app.pipeline.registry import ConfigRegistry, Setting, cfg

MIN_FLOOR_UNITS = Setting(
    name="promise.min_floor_units",
    default=1.0,
    unit="units below which a floor is not worth stating",
    owner="commercial",
    why="provisional. A floor of zero units is not a promise, and a floor below "
        "one unit cannot be checked against a till that sells in whole bottles. "
        "At or below this the card states no floor and says why, which is more "
        "useful than a number an owner cannot act on",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class PromiseFloor:
    """A floor on TOTAL units the owner can hold the engine to."""

    #: Whole units. The low end of the published interval.
    units: int
    #: The confidence the published interval claims, carried so a stored floor
    #: can be audited against the setting in force when it was written.
    coverage: float
    #: What the engine expects, for contrast. The floor is not a forecast.
    expected_units: float

    def explain(self) -> str:
        return (f"at least {self.units} units should sell over the period "
                f"(the engine expects about {self.expected_units:.0f})")

    def as_dict(self) -> dict[str, Any]:
        return {"floor_units": self.units, "coverage": self.coverage,
                "expected_units": self.expected_units}


@dataclass(frozen=True, slots=True)
class FloorRefused:
    """No floor, and which named reason applies."""

    basis: str

    def as_dict(self) -> dict[str, Any]:
        return {"floor_units": None, "basis": self.basis}


def uplift_required_for_increment_promise(
    rate: float, horizon_open_days: float, dispersion_cv: float,
    ctx: RunContext, config: ConfigRegistry = cfg,
) -> float | None:
    """How large an uplift the INCREMENT form would need, for this dispersion.

    Exists so the refusal can carry arithmetic instead of an opinion. A card that
    declines to promise an increase can say "this product would need a 4.3x lift
    for that floor to clear its current rate, and it has 1.67x", which is a
    statement an owner or an engineer can check.

    None when the interval itself cannot be computed.
    """
    interval = predictive_interval(
        rate=rate, horizon_open_days=horizon_open_days,
        dispersion_cv=dispersion_cv, ctx=ctx, config=config)
    if not isinstance(interval, PredictiveInterval) or interval.mean <= 0.0:
        return None
    fraction = interval.low / interval.mean
    if fraction <= 0.0:
        return None
    return 1.0 / fraction


def promise_floor(
    *,
    rate: float | None,
    horizon_open_days: float | None,
    dispersion_cv: float | None,
    baseline_rate: float | None = None,
    uplift: float | None = None,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> PromiseFloor | FloorRefused:
    """The floor on TOTAL units, from the published predictive interval.

    `baseline_rate` and `uplift` are optional and used only to explain a refusal
    of the INCREMENT form, which is what a reader will ask about next.
    """
    interval = predictive_interval(
        rate=rate, horizon_open_days=horizon_open_days,
        dispersion_cv=dispersion_cv, ctx=ctx, config=config)
    if not isinstance(interval, PredictiveInterval):
        # The interval's own named refusal is carried straight through rather
        # than restated - one vocabulary for one failure.
        return FloorRefused(interval.basis)

    minimum = float(config.get(MIN_FLOOR_UNITS, ctx))
    if interval.low < minimum:
        return FloorRefused(
            f"floor_below_minimum:{interval.low}<{minimum:.0f}")

    return PromiseFloor(units=interval.low,
                        coverage=interval.nominal_coverage,
                        expected_units=interval.mean)


def increment_promise_basis(
    *,
    rate: float | None,
    horizon_open_days: float | None,
    dispersion_cv: float | None,
    baseline_rate: float | None,
    uplift: float | None,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> str:
    """Why this SKU cannot be promised an INCREASE at a low quantile.

    Always a refusal. Returning a basis rather than a number is the point: six
    formulations were measured and the module docstring has the arithmetic. This
    turns "not implemented" into a statement with a figure in it.
    """
    if rate is None or horizon_open_days is None or dispersion_cv is None:
        return "no_inputs:cannot_assess_increment_promise"
    needed = uplift_required_for_increment_promise(
        rate, horizon_open_days, dispersion_cv, ctx, config)
    if needed is None:
        return "no_interval:cannot_assess_increment_promise"
    if uplift is None:
        return (f"refuted:needs_{needed:.1f}x_uplift_at_cv_{dispersion_cv:.2f}")
    if uplift >= needed:
        # Possible in principle, and vanishingly rare: 0 of 513 measured cards.
        # Kept as a branch because an arithmetic claim with no reachable true
        # case is an assertion, not a test.
        return (f"possible:uplift_{uplift:.2f}x_clears_{needed:.1f}x")
    return (f"refuted:needs_{needed:.1f}x_uplift_at_cv_{dispersion_cv:.2f}_"
            f"but_has_{uplift:.2f}x")


__all__ = [
    "MIN_FLOOR_UNITS",
    "FloorRefused",
    "PromiseFloor",
    "increment_promise_basis",
    "promise_floor",
    "uplift_required_for_increment_promise",
]
