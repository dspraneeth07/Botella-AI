"""How much an event lifts a store's units — shrunk hard, because n is three.

THE STATISTICAL HEART OF THE PLAYBOOK, AND THE EASIEST THING TO GET WRONG
    The pilot stores have 3.7 years of history. That is THREE OR FOUR occurrences
    of each event per store. One store's Thanksgiving is n = 3, and an uplift
    estimated from three observations is noise.

    So this is the ONE place in the engine where the peer cohort is genuinely
    load-bearing rather than a cold-start convenience. Everywhere else the cohort
    is what a NEW store borrows until it has its own data; here even a four-year
    store will never have much, because the event only comes once a year.

        uplift_hat = (n_eff * u_own + k * u_cohort) / (n_eff + k)

    The same formula as sheets 06 and 20 - a THIRD axis, across events - with the
    registry's existing k rather than a new constant.

THE UPLIFT IS A LOG RATIO, AND THAT IS NOT A STYLE CHOICE
        uplift = ln(event window rate / matched baseline rate)

    Three reasons, and the first is the one that matters:

    1. ZERO MEANS NO EFFECT, so `Interval.spans_zero` - the same predicate
       `elasticity/guard.py` applies to price - is exactly the right refusal and
       is reused rather than reimplemented. A raw ratio would need "spans 1.0",
       a second predicate meaning the same thing, and the two would drift.
    2. It is additive, so shrinking it is a weighted mean rather than something
       that has to be done in log space and converted back.
    3. A SUPPRESSION is simply a negative number. Nothing clamps it at zero,
       because Ramadan reducing demand in a trade area is a correct and valuable
       result: it says do not pre-stock, and do not read the dip afterwards as
       something to recover.

THE BASELINE IS MATCHED ON WEEKDAY, AND IT HAS TO BE
    Thanksgiving is always a Thursday. The Super Bowl is always a Sunday. An
    unmatched baseline would compare a Thursday against a week containing two
    weekend days and credit the event with the weekday pattern - which is exactly
    the confound that made the seasonal multiplier lose at 0 of 4 horizons.

    OPEN days throughout. An event window containing a closure is SHORTER, and a
    calendar denominator would understate every event rate by the closed fraction.

WHAT THIS MODULE DOES NOT DO
    It does not touch `rate_hat` and it does not return a multiplier for the daily
    forecast. Seasonality has lost twice on this engine doing exactly that. This
    produces one number per (store, event, sku) that a playbook turns into an
    ORDER LIST, and if a future change starts scaling a daily rate from it, it
    will lose for the third time.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from typing import Any, Sequence

from app.pipeline.blend.shrink import k_for_pattern
from app.pipeline.context import RunContext
from app.pipeline.elasticity.estimate import Interval
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

#: The pattern whose k governs shrinkage here. `monthly_seasonality` on purpose:
#: an event uplift IS a seasonal effect, and the registry already owns a
#: shrinkage constant for seasonal effects. Introducing an "event" k would be a
#: second judgement about the same question, and the two would drift apart the
#: first time either was tuned.
SEASONALITY_PATTERN = "monthly_seasonality"

MIN_OCCURRENCES = Setting(
    name="event_uplift.min_occurrences",
    default=2,
    unit="past occurrences of this event at this store",
    owner="forecasting",
    why="provisional. ONE occurrence has no spread, so it cannot produce an "
        "interval and cannot be refused honestly - it would be a point estimate "
        "wearing a confidence. Two is the smallest number that yields any "
        "dispersion at all, and with 3.7 years of history most events will have "
        "exactly three or four, which is why the cohort carries most of the "
        "weight. It becomes MEASURED when enough stores have five or more and "
        "the refusal rate as a function of n is known",
    status="PROVISIONAL",
)

T_CRITICAL_BY_DF = Setting(
    name="event_uplift.t_critical_by_df",
    default=(12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306),
    unit="two-sided 95% t multiplier for df = 1..8",
    owner="forecasting",
    why="PUBLISHED Student-t critical values, not judgements - which is why they "
        "are a tuple in one Setting rather than eight constants. They exist "
        "because this module's n is 3: at 2 df the multiplier is 4.303 against "
        "2.042 at 30, and using the large-sample value would shrink every "
        "interval by half and make the estimator REFUSE FAR LESS THAN IT SHOULD. "
        "That is the dangerous direction - it would let three noisy observations "
        "produce a citable uplift. Past 8 df the module falls back to "
        "elasticity.critical_value_95, which already owns the large-sample case",
    status="MEASURED",
)

MAX_PLAUSIBLE_UPLIFT = Setting(
    name="event_uplift.max_plausible_abs",
    default=2.0,
    unit="absolute log uplift",
    owner="forecasting",
    why="provisional. A log uplift of 2.0 is a 7.4x swing in units from one "
        "event window. Real event lifts are large - Thanksgiving Eve genuinely "
        "multiplies a liquor store's day - but past this it is a data defect: a "
        "SKU that first appeared during the event, a renamed product, or a single "
        "enormous basket. Evidence about the DATA, said rather than reported as "
        "a finding",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class Occurrence:
    """One past instance of one event at one store, for one SKU.

    Both rates are per OPEN day, and the baseline is over MATCHED WEEKDAYS
    outside the window - see the module docstring for why that is not optional.
    """

    year: int
    event_units: float
    event_open_days: int
    baseline_units: float
    baseline_open_days: int

    def __post_init__(self) -> None:
        for name in ("event_units", "baseline_units"):
            if getattr(self, name) < 0:
                raise ValueError(f"{name} must be >= 0")
        for name in ("event_open_days", "baseline_open_days"):
            if getattr(self, name) < 0:
                raise ValueError(f"{name} must be >= 0")

    @property
    def usable(self) -> bool:
        """Both windows must have traded, and the baseline must be non-zero.

        A baseline of zero makes the ratio undefined rather than infinite: the
        SKU had no established rate to be lifted ABOVE.
        """
        return (self.event_open_days > 0 and self.baseline_open_days > 0
                and self.baseline_units > 0)

    @property
    def log_uplift(self) -> float | None:
        """ln(event rate / baseline rate), both per open day.

        The +1 is on the EVENT side only, so a window that genuinely sold nothing
        is a large negative rather than undefined - which is a real observation
        for a suppressing event.
        """
        if not self.usable:
            return None
        event_rate = (self.event_units + 1.0) / self.event_open_days
        baseline_rate = self.baseline_units / self.baseline_open_days
        return math.log(event_rate / baseline_rate)


@dataclass(frozen=True, slots=True)
class EventUpliftRequest:
    """One (store, event, sku) cell."""

    event_key: str
    sku: str
    occurrences: Sequence[Occurrence]
    #: The peer cohort's log uplift for this event, if one exists. None means no
    #: peer estimate and therefore NO shrinkage - honest rather than neutral,
    #: because shrinking toward an invented zero would manufacture a refusal.
    cohort_uplift: float | None = None
    #: Which of the five resolution levels supplied it, and how many peers. For
    #: the card: "based on 14 similar Texas stores" is a different claim from
    #: "based on 94 stores nationally".
    cohort_level: int | None = None
    cohort_stores: int = 0


@dataclass(frozen=True, slots=True)
class EventUplift:
    """The shrunk uplift, its interval, and what evidence produced it."""

    event_key: str
    sku: str
    #: Log uplift. Zero is no effect; negative is a suppression.
    uplift: float | None
    own_uplift: float | None
    interval: Interval | None
    n_own: int
    own_weight: float
    cohort_uplift: float | None
    cohort_level: int | None
    cohort_stores: int
    refused_reason: str | None

    @property
    def usable(self) -> bool:
        """May a playbook line cite this? The same question guard.py asks."""
        return (
            self.refused_reason is None
            and self.uplift is not None
            and self.interval is not None
            and not self.interval.spans_zero
        )

    @property
    def suppresses(self) -> bool:
        """A measured effect in the NEGATIVE direction. Do not pre-stock."""
        return self.usable and (self.uplift or 0.0) < 0.0

    @property
    def lift_multiple(self) -> float | None:
        """The uplift as a multiple of the baseline, for a sentence."""
        return None if self.uplift is None else math.exp(self.uplift)

    @property
    def evidence(self) -> str:
        """What the card SAYS about where its number came from.

        "Based on your 3 previous Thanksgivings" is a different claim from "based
        on 14 similar Texas stores", and the owner should be able to tell which
        one they got.
        """
        own = (f"your {self.n_own} previous"
               if self.n_own else "no history of your own")
        if self.cohort_uplift is None:
            return f"{own} (no peer estimate, so this is your data alone)"
        peers = (f"{self.cohort_stores} peer store"
                 f"{'' if self.cohort_stores == 1 else 's'}")
        level = ("" if self.cohort_level is None
                 else f", cohort level {self.cohort_level}")
        return (f"{own} at {self.own_weight:.0%} and {peers}{level} at "
                f"{1 - self.own_weight:.0%}")

    def as_dict(self) -> dict[str, Any]:
        return {
            "event_key": self.event_key, "sku": self.sku,
            "uplift": self.uplift, "own_uplift": self.own_uplift,
            "lift_multiple": self.lift_multiple,
            "interval_low": self.interval.low if self.interval else None,
            "interval_high": self.interval.high if self.interval else None,
            "n_own": self.n_own, "own_weight": self.own_weight,
            "cohort_uplift": self.cohort_uplift,
            "cohort_level": self.cohort_level,
            "cohort_stores": self.cohort_stores,
            "refused_reason": self.refused_reason,
            "usable": self.usable, "suppresses": self.suppresses,
            "evidence": self.evidence,
        }


def t_critical(df: int, ctx: RunContext, config: ConfigRegistry = cfg) -> float:
    """The two-sided 95% t multiplier for `df`, from the registry.

    Past the declared table it falls back to the price module's large-sample
    value, which already owns that case.
    """
    from app.pipeline.elasticity.estimate import CRITICAL_VALUE_95

    table = tuple(config.get(T_CRITICAL_BY_DF, ctx))
    if df < 1:
        raise ValueError(f"df must be >= 1, got {df}")
    if df <= len(table):
        return float(table[df - 1])
    return float(config.get(CRITICAL_VALUE_95, ctx))


def _refused(request: EventUpliftRequest, reason: str, n: int) -> EventUplift:
    return EventUplift(
        event_key=request.event_key, sku=request.sku,
        uplift=None, own_uplift=None, interval=None,
        n_own=n, own_weight=0.0,
        cohort_uplift=request.cohort_uplift,
        cohort_level=request.cohort_level,
        cohort_stores=request.cohort_stores,
        refused_reason=reason,
    )


@stage("event_uplift", "1.0.0")
def estimate_event_uplift(
    request: EventUpliftRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """One event's uplift for one SKU, shrunk toward the cohort.

    Always succeeds. A cell that cannot be estimated comes back REFUSED with a
    reason, because with n = 3 most cells WILL refuse and that is the correct
    answer rather than an error.
    """
    record_inputs("feature_daily.units", "events.window")

    minimum = int(config.get(MIN_OCCURRENCES, ctx))
    max_abs = float(config.get(MAX_PLAUSIBLE_UPLIFT, ctx))

    lifts = [o.log_uplift for o in request.occurrences]
    usable = [x for x in lifts if x is not None]
    n = len(usable)

    if n < minimum:
        return StageResult.success(
            _refused(request, f"too_few_occurrences:{n}<{minimum}", n),
            _provenance(n),
        )

    own = sum(usable) / n
    # Sample standard deviation, n-1 in the denominator. With n = 3 that is two
    # degrees of freedom and the interval is correspondingly wide, which is the
    # honest consequence of three observations rather than a defect.
    variance = sum((x - own) ** 2 for x in usable) / (n - 1)
    standard_error = math.sqrt(variance / n)

    if not math.isfinite(own) or not math.isfinite(standard_error):
        return StageResult.success(
            _refused(request, "non_finite_estimate", n), _provenance(n))
    if standard_error <= 0.0:
        # ZERO DISPERSION FROM THREE OBSERVATIONS IS NOT CERTAINTY. It happens
        # for real on sparse SKUs - one unit in each of three event windows
        # against the same baseline gives three identical log uplifts - and the
        # arithmetic would hand back a ZERO-WIDTH interval, which `spans_zero`
        # then passes and a card then states as a fact.
        #
        # Refusing is the only honest answer: the data has told us nothing about
        # the spread, so there is nothing to put an interval around.
        return StageResult.success(
            _refused(request, f"zero_dispersion:{n}_identical_observations", n),
            _provenance(n),
        )
    if abs(own) > max_abs:
        return StageResult.success(
            _refused(request, f"implausible_uplift:{own:+.2f}|>|{max_abs}", n),
            _provenance(n),
        )

    # ── Shrink toward the cohort, on the third axis ──────────────────────────
    k = float(k_for_pattern(SEASONALITY_PATTERN, ctx, config))
    if request.cohort_uplift is None:
        own_weight = 1.0
        shrunk = own
    else:
        own_weight = n / (n + k)
        shrunk = own_weight * own + (1.0 - own_weight) * request.cohort_uplift

    # The interval is built on the SHRUNK centre with the OWN standard error.
    # Shrinkage moves the centre; it does not reduce the uncertainty, and
    # narrowing it would manufacture confidence out of a borrowed number.
    half = t_critical(n - 1, ctx, config) * standard_error
    interval = Interval(low=shrunk - half, high=shrunk + half)

    return StageResult.success(
        EventUplift(
            event_key=request.event_key, sku=request.sku,
            uplift=shrunk, own_uplift=own, interval=interval,
            n_own=n, own_weight=own_weight,
            cohort_uplift=request.cohort_uplift,
            cohort_level=request.cohort_level,
            cohort_stores=request.cohort_stores,
            refused_reason=None,
        ),
        _provenance(n, own_weight),
    )


def cohort_uplift_from(
    per_store: Sequence[EventUplift], *, min_stores: int = 3
) -> float | None:
    """The peer cohort's uplift for one event: the mean of the stores' OWN values.

    Their OWN uplifts, deliberately, not their shrunk ones - shrinking toward a
    quantity that was itself shrunk toward the cohort would pull every store
    toward the cohort twice and collapse the spread.

    A store never enters its own cohort prior; the caller excludes it, which is
    the same guard sheet 06's cohort resolution already applies.
    """
    values = [u.own_uplift for u in per_store if u.own_uplift is not None]
    if len(values) < min_stores:
        return None
    return sum(values) / len(values)


def _evidence_state(n: int) -> str:
    """The registry's own ladder. NEW / EMERGING / ESTABLISHED / MATURE are the
    only permitted values, and an event with three occurrences is EMERGING no
    matter how many years the store has been trading - which is the honest label
    for this family and the reason the cohort carries most of the weight."""
    if n <= 0:
        return "NEW"
    if n < 4:
        return "EMERGING"
    if n < 8:
        return "ESTABLISHED"
    return "MATURE"


def _provenance(occurrences: int, own_weight: float = 0.0) -> Provenance:
    return Provenance(
        own_observations=occurrences,
        own_weight=own_weight,
        evidence_state=_evidence_state(occurrences),
    )


__all__ = [
    "MAX_PLAUSIBLE_UPLIFT",
    "MIN_OCCURRENCES",
    "SEASONALITY_PATTERN",
    "T_CRITICAL_BY_DF",
    "EventUplift",
    "EventUpliftRequest",
    "Occurrence",
    "cohort_uplift_from",
    "estimate_event_uplift",
    "t_critical",
]
