"""Does a signal move THIS store's units, and by how much — with an interval.

    ln(units + 1) = alpha + beta*signal_active + dow + month + trend + e

    beta = 0.22  [0.09, 0.35]   USABLE: heat lifts this store's seltzer ~25%
    beta = 0.05  [-0.18, 0.28]  REFUSED: the interval spans zero. No card.

THE CLAIM THIS EXISTS TO CHECK
    Every weather, calendar and news card makes an implicit claim - "this signal
    is live, so stock up". Until now that claim had no estimate behind it at
    all: `cold_box` fired when a heat key was present, picked the fastest-selling
    chillable SKU, and stated a hardcoded 0.55. Nothing asked whether heat moves
    seltzer AT THIS STORE.

    Measured across 155 signal-driven recommendations, that layer scored 6 to 10
    points BELOW random. So this module either supplies a real estimate or
    refuses to let the claim be made - and `Interval.spans_zero`, the same
    predicate `guard.py` uses for price, is the refusal.

WHY ln(units + 1) AND NOT ln(units)
    Price elasticity can assume positive units: a price observation exists
    because something sold. A signal is active on days when a category sells
    NOTHING, and those zero days are exactly the comparison the estimate needs.
    ln(0) is undefined, so the standard count transform applies. It biases beta
    slightly toward zero on sparse categories, which is the safe direction: it
    makes the estimator refuse more often rather than less.

THE IDENTIFICATION PROBLEM, AND IT IS WORSE HERE THAN FOR PRICE
    Signals are not randomly assigned, and the confounding runs TOWARD finding
    an effect:

      - a festival or a home fixture is SCHEDULED for a weekend that was going
        to be busy anyway. Without a day-of-week control the estimate measures
        the weekend and credits the event.
      - heat advisories cluster in summer, which is also when a liquor store's
        trade is seasonally high. Without a month control the estimate measures
        July.
      - a store growing year on year has more units on later dates, and later
        dates carry more signals simply because capture improved. Hence trend.

    dow, month and trend absorb the crudest of that. They absorb NONE of the
    competitor effect, nothing about local promotions, and nothing about why a
    festival was scheduled on that weekend rather than another. That residual
    bias runs toward overstating beta, so the card's provenance line says the
    controls are present and says what they do not cover.

SHRINKAGE, BECAUSE n IS SMALL BY NATURE
    A store with four past heat advisories has almost no information of its own.
    beta is therefore shrunk toward the cohort's beta with the registry's
    EXISTING `shrink.k.elasticity` - the constant already used for exactly this
    purpose on price elasticity - so no new judgement is introduced here.

WHAT TO EXPECT
    MOST INTERVALS WILL SPAN ZERO, especially at low-volume stores and for
    signals that have been active a handful of times. That is the correct answer,
    not a failure of the estimator, and the price module says the same thing
    about itself. A signal layer that finds an effect everywhere is the
    six-to-ten-points-below-random layer rebuilt with more arithmetic.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from typing import Any, Sequence

from app.pipeline.blend.shrink import k_for_pattern
from app.pipeline.context import RunContext
from app.pipeline.elasticity.estimate import (
    CRITICAL_VALUE_95,
    MIN_RESIDUAL_DF,
    Interval,
    ols_with_robust_se,
)
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

#: The pattern whose k governs shrinkage here. Deliberately the SAME one price
#: elasticity uses: a signal effect is an elasticity, and giving it its own
#: constant would be a second judgement about the same question.
ELASTICITY_PATTERN = "elasticity"

#: The t multiplier is NOT declared here. `elasticity.critical_value_95` already
#: owns it at 2.042, paired with `MIN_RESIDUAL_DF = 30` for the reason recorded
#: there: below 30 df the multiplier rises steeply (2.09 at 20, 2.78 at 4) and one
#: fixed value would understate the interval badly. A second copy would be a
#: second judgement about the same question, and the two would drift.


MIN_SIGNAL_DAYS = Setting(
    name="signal_effect.min_days",
    default=120,
    unit="store-days in the estimation window",
    owner="forecasting",
    why="provisional. The window has to be long enough to contain a month "
        "control and a trend without the dummies eating the degrees of freedom. "
        "120 open days is about six months of a six-day week, which is the "
        "shortest span that sees more than one month and still leaves residual "
        "df above the floor the price module measured at 30. It becomes MEASURED "
        "once the refusal rate is known as a function of window length",
    status="PROVISIONAL",
)

MIN_SIGNAL_ACTIVE_DAYS = Setting(
    name="signal_effect.min_active_days",
    default=20,
    unit="days on which the signal was active",
    owner="forecasting",
    why="provisional, and the binding constraint in practice. A 400-day window "
        "with THREE active days cannot estimate an effect however long it is: "
        "beta is then a comparison of three days against four hundred, and its "
        "interval will span zero - so refusing early is cheaper and clearer "
        "than fitting and then discarding. Twenty is the same floor N4.3 "
        "reports weekly as the leading indicator of how many signals will ever "
        "become usable, which keeps one number answering one question",
    status="PROVISIONAL",
)

MAX_PLAUSIBLE_SIGNAL_BETA = Setting(
    name="signal_effect.max_plausible_abs_beta",
    default=1.5,
    unit="absolute log-units per active day",
    owner="forecasting",
    why="provisional. beta is a log effect, so 1.5 is already a 4.5x swing in "
        "units from one signal being live. Anything past that is a data defect - "
        "a category that only began trading when the signal first fired, a "
        "renamed SKU, a single enormous basket - and not a demand effect. The "
        "price module keeps the equivalent cap for the same reason: an estimate "
        "this large is evidence about the DATA, so it is refused with that said "
        "rather than reported as a finding",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class SignalObservation:
    """One store-day: how much the category sold, and whether the signal was on."""

    obs_date: date
    units: float
    signal_active: bool

    def __post_init__(self) -> None:
        if self.units < 0:
            raise ValueError(f"units must be >= 0, got {self.units}")


@dataclass(frozen=True, slots=True)
class SignalEffectRequest:
    """One (store, category, signal key) cell."""

    signal_key: str
    category: str
    observations: Sequence[SignalObservation]
    #: The cohort's beta for this (category, signal key), if one exists. None
    #: means no peer estimate, and then no shrinkage is applied - which is
    #: honest rather than neutral: it says this is the store's own number alone.
    cohort_beta: float | None = None
    cohort_observations: int = 0


@dataclass(frozen=True, slots=True)
class SignalEffectResult:
    """beta, its interval, and whether a card may cite it."""

    signal_key: str
    category: str
    #: The shrunk estimate - what a card may cite.
    beta: float | None
    #: Before shrinkage, so a reader can see what this store's own data said.
    own_beta: float | None
    interval: Interval | None
    observations: int
    active_days: int
    own_weight: float
    #: Non-empty when nothing may be cited.
    refused_reason: str | None
    basis: str

    @property
    def usable(self) -> bool:
        """May a card cite this? The same question `guard.py` asks of price."""
        return (
            self.refused_reason is None
            and self.beta is not None
            and self.interval is not None
            and not self.interval.spans_zero
        )

    @property
    def suppresses(self) -> bool:
        """A measured effect in the NEGATIVE direction. A veto, not a card."""
        return self.usable and (self.beta or 0.0) < 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "signal_key": self.signal_key, "category": self.category,
            "beta": self.beta, "own_beta": self.own_beta,
            "interval_low": self.interval.low if self.interval else None,
            "interval_high": self.interval.high if self.interval else None,
            "observations": self.observations, "active_days": self.active_days,
            "own_weight": self.own_weight,
            "refused_reason": self.refused_reason, "basis": self.basis,
            "usable": self.usable, "suppresses": self.suppresses,
        }

    def explain(self) -> str:
        if self.refused_reason is not None:
            return (
                f"No usable effect for {self.signal_key} on {self.category}: "
                f"{self.refused_reason}."
            )
        assert self.interval is not None and self.beta is not None
        if self.interval.spans_zero:
            return (
                f"{self.signal_key} on {self.category}: beta {self.beta:+.2f} "
                f"({self.interval.low:+.2f} to {self.interval.high:+.2f}) - the "
                f"interval spans zero, so the data cannot tell. No card."
            )
        direction = "lifts" if self.beta > 0 else "SUPPRESSES"
        return (
            f"{self.signal_key} {direction} {self.category} by about "
            f"{abs(math.expm1(self.beta)):.0%} ({self.interval.low:+.2f} to "
            f"{self.interval.high:+.2f}), from {self.active_days} active days of "
            f"{self.observations}. Day-of-week, month and trend are controlled; "
            f"competitor activity and why the signal fell on those dates are not."
        )


def _refused(
    request: SignalEffectRequest, reason: str, *, active: int = 0
) -> SignalEffectResult:
    return SignalEffectResult(
        signal_key=request.signal_key, category=request.category,
        beta=None, own_beta=None, interval=None,
        observations=len(request.observations), active_days=active,
        own_weight=0.0, refused_reason=reason, basis="refused",
    )


def build_signal_design(
    observations: Sequence[SignalObservation],
) -> list[list[float]]:
    """[1, signal_active, dow dummies, month dummies, trend].

    THE REFERENCE LEVEL IS THE FIRST ONE OBSERVED, exactly as `build_design`
    does for price - and for the reason recorded there, which cost 61 of 335
    real cells before it was found: holding out a FIXED Monday/January only
    works if that level appears in the window. A six-month window contains no
    January, so a January-referenced month set gives every observed month a
    column, they sum to 1 on every row, that is the intercept, and the fit dies
    reported as "controls collinear" when it is really the dummy-variable trap
    with an absent reference.

    `trend` is the day index scaled onto roughly [0, 1] rather than a raw
    ordinal. Raw day numbers in the thousands put the design matrix orders of
    magnitude apart column to column, and the Gauss-Jordan inverse loses
    precision long before it reports anything wrong.
    """
    if not observations:
        return []
    weekdays = sorted({o.obs_date.weekday() for o in observations})
    months = sorted({o.obs_date.month for o in observations})
    weekday_levels = weekdays[1:]
    month_levels = months[1:]

    ordered = sorted(observations, key=lambda o: o.obs_date)
    first = ordered[0].obs_date
    span = max(1, (ordered[-1].obs_date - first).days)

    design: list[list[float]] = []
    for o in observations:
        row = [1.0, 1.0 if o.signal_active else 0.0]
        weekday = o.obs_date.weekday()
        row += [1.0 if weekday == d else 0.0 for d in weekday_levels]
        month = o.obs_date.month
        row += [1.0 if month == m else 0.0 for m in month_levels]
        row.append((o.obs_date - first).days / span)
        design.append(row)
    return design


@stage("signal_effect", "1.0.0")
def estimate_signal_effect(
    request: SignalEffectRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Estimate one signal's effect, shrink it, and say whether it may be cited.

    Always succeeds. A cell that cannot be estimated comes back REFUSED with a
    reason, because "we looked and the data cannot tell" is information and an
    exception would lose it.
    """
    record_inputs("signal_history.signal_key", "feature_daily.units")

    min_days = int(config.get(MIN_SIGNAL_DAYS, ctx))
    min_active = int(config.get(MIN_SIGNAL_ACTIVE_DAYS, ctx))
    max_abs = float(config.get(MAX_PLAUSIBLE_SIGNAL_BETA, ctx))
    min_df = int(config.get(MIN_RESIDUAL_DF, ctx))

    obs = list(request.observations)
    active = sum(1 for o in obs if o.signal_active)

    if len(obs) < min_days:
        return StageResult.success(
            _refused(request, f"too_few_days:{len(obs)}<{min_days}", active=active),
            _provenance(len(obs)),
        )
    if active < min_active:
        return StageResult.success(
            _refused(request, f"too_few_active_days:{active}<{min_active}",
                     active=active),
            _provenance(len(obs)),
        )
    if active == len(obs):
        # The signal was never OFF, so there is no comparison. The column is
        # collinear with the intercept and the fit would be singular.
        return StageResult.success(
            _refused(request, "signal_always_active:no_comparison_days",
                     active=active),
            _provenance(len(obs)),
        )

    design = build_signal_design(obs)
    y = [math.log(o.units + 1.0) for o in obs]
    residual_df = len(obs) - (len(design[0]) if design else 0)
    if residual_df < min_df:
        return StageResult.success(
            _refused(request, f"too_few_residual_df:{residual_df}<{min_df}",
                     active=active),
            _provenance(len(obs)),
        )

    fitted = ols_with_robust_se(design, y)
    if fitted is None:
        return StageResult.success(
            _refused(request, "singular_design:controls_collinear", active=active),
            _provenance(len(obs)),
        )
    coefficients, standard_errors, _r2 = fitted
    own_beta = coefficients[1]          # index 1 is signal_active by construction
    own_se = standard_errors[1]

    if not math.isfinite(own_beta) or not math.isfinite(own_se):
        return StageResult.success(
            _refused(request, "non_finite_estimate", active=active),
            _provenance(len(obs)),
        )
    if abs(own_beta) > max_abs:
        # Evidence about the DATA, not about demand. Said rather than reported.
        return StageResult.success(
            _refused(request, f"implausible_beta:{own_beta:+.2f}|>|{max_abs}",
                     active=active),
            _provenance(len(obs)),
        )

    # ── Shrink toward the cohort, with the k that already governs elasticity ──
    k = float(k_for_pattern(ELASTICITY_PATTERN, ctx, config))
    if request.cohort_beta is None:
        own_weight = 1.0
        beta = own_beta
        basis = "own_only"
    else:
        # The store's own evidence is its ACTIVE days, not its total days: a
        # thousand quiet days say nothing about what happens when the signal
        # fires.
        n = float(active)
        own_weight = n / (n + k)
        beta = own_weight * own_beta + (1.0 - own_weight) * request.cohort_beta
        basis = f"shrunk_to_cohort:{own_weight:.0%}_own"

    # The interval is built on the SHRUNK point with the OWN standard error.
    # Shrinkage moves the centre and does not narrow the uncertainty - treating
    # it as if it did would manufacture confidence out of a borrowed number.
    half = float(config.get(CRITICAL_VALUE_95, ctx)) * own_se
    interval = Interval(low=beta - half, high=beta + half)

    return StageResult.success(
        SignalEffectResult(
            signal_key=request.signal_key, category=request.category,
            beta=beta, own_beta=own_beta, interval=interval,
            observations=len(obs), active_days=active,
            own_weight=own_weight, refused_reason=None, basis=basis,
        ),
        _provenance(len(obs), own_weight),
    )


def _provenance(observations: int, own_weight: float = 0.0) -> Provenance:
    """A LATENT BUG, found while writing event_uplift.py: this said "ABSENT" for
    an empty observation list, and ABSENT is not one of the four permitted
    evidence states - so a cell with no observations would have RAISED instead of
    returning its refusal. Every test here supplied observations, so none of them
    caught it."""
    if observations <= 0:
        state = "NEW"
    elif observations < 120:
        state = "EMERGING"
    else:
        state = "MATURE"
    return Provenance(
        own_observations=observations,
        own_weight=own_weight,
        evidence_state=state,
    )


__all__ = [
    "MAX_PLAUSIBLE_SIGNAL_BETA",
    "MIN_SIGNAL_ACTIVE_DAYS",
    "MIN_SIGNAL_DAYS",
    "SignalEffectRequest",
    "SignalEffectResult",
    "SignalObservation",
    "build_signal_design",
    "estimate_signal_effect",
]
