"""A predictive interval on the horizon count, so coverage becomes measurable.

WHY THIS EXISTS
    The gate has a check called `interval_coverage` and it has been reading
    "not measured" at every store since it was written. Not failing - absent.
    The reason is simple and was worth finding: the card publishes a POINT.

        "Order more Sobieski Vodka 50ml - about 78 units above your recent
         run-rate"

    There is no interval anywhere on that card, so there was nothing whose
    coverage could be checked, and a gate check that can never run is a gate
    check that is not doing its job. This module produces the interval the card
    should have been publishing, which is what lets that check come alive.

WHY NEGATIVE BINOMIAL AND NOT POISSON
    Poisson fixes the variance at the mean. These are liquor SKUs: a vodka that
    averages 14 units a month does not arrive 14 units a month, it arrives 4 then
    26 then 9, and this engine already measures that scatter as `dispersion_cv`
    over weekly rates. Handing a Poisson interval to a SKU with cv = 1.0 states a
    range about half as wide as the truth, and a too-narrow interval is worse than
    none: it reports coverage of 60% and looks like a forecasting problem when it
    is an arithmetic one.

    So the count over the horizon is negative binomial with

        mean      mu    = rate * horizon_open_days
        variance  sigma2 = mu + cv^2 * mu^2
        size      k      = 1 / cv^2

    which is the standard mean/dispersion parameterisation. The second term is
    the whole point: it is the SKU's own measured scatter, and at cv = 0 it
    vanishes and this collapses back to Poisson exactly. A steady seller gets the
    narrow interval it earns; an erratic one gets the wide interval it deserves.

OPEN DAYS, NEVER CALENDAR DAYS
    `horizon_open_days` and nothing else. Bethany trades 25.7 days in a 30-day
    window; using 30 would inflate every mean here by 16.8% and every interval
    with it. This engine has already paid for that mistake once.

THE INTERVAL IS TWO-SIDED AND IS NOT THE PROMISE/ORDER BAND
    A reader who has been through N1 will reach for [promise, order] as "the
    interval" and that would be a measurement error. Those two numbers are a p10
    and a q* chosen for two DIFFERENT jobs - what to say and what to buy - and the
    band between them has nominal coverage around 81%, so testing it against a 90%
    bar would fail a correct engine for a reason that has nothing to do with
    accuracy. This is a separate, symmetric, two-sided predictive interval whose
    nominal coverage is declared in one place and is the number the gate tests.

ABSENCE IS NOT A WIDE INTERVAL
    Every refusal returns None with a named basis. The tempting failure here is to
    widen the interval when the inputs are poor, because a wide interval always
    covers and the coverage check always passes. That is a way of scoring 100% on
    this gate while telling the owner nothing, so a SKU we cannot bound does not
    get a generous bound - it gets no interval, and the card says so.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.registry import ConfigRegistry, Setting, cfg

PREDICTIVE_COVERAGE = Setting(
    name="interval.predictive_coverage",
    default=0.90,
    unit="nominal two-sided coverage of the published interval, 0..1",
    owner="forecasting",
    why="provisional. 0.90 and not 0.95 because this interval is PRINTED ON A "
        "CARD and an owner reads a range to decide how much space to clear: a "
        "95% range on an erratic SKU is wide enough to be useless advice even "
        "though it is a more honest statement of uncertainty. 0.90 is the widest "
        "band that still narrows an owner's decision. It is deliberately the "
        "same number the gate tests coverage against, declared once here so the "
        "claim and its test can never drift apart. It becomes MEASURED when "
        "realised coverage has been tracked across a full season",
    status="PROVISIONAL",
)

MAX_SUMMATION_TERMS = Setting(
    name="interval.max_summation_terms",
    default=200_000,
    unit="terms of the negative binomial CDF before refusing",
    owner="forecasting",
    why="provisional guard, not a tuning knob. The CDF is summed term by term "
        "because there is no closed-form quantile, and an unbounded loop on a "
        "pathological mean would hang the run. A SKU selling 200,000 units in a "
        "horizon does not exist in this estate, so hitting this cap means the "
        "inputs are wrong rather than the product is large - and the honest "
        "response is to refuse the interval, not to return the partial sum as "
        "though it were a quantile",
    status="PROVISIONAL",
)

MIN_DISPERSION_CV = Setting(
    name="interval.min_dispersion_cv",
    default=0.0,
    unit="floor on the coefficient of variation used for the interval",
    owner="forecasting",
    why="provisional, and zero on purpose. A cv of exactly zero is legitimate - "
        "it means the weekly rates were identical - and it yields the Poisson "
        "interval, which is the correct narrowest answer rather than a special "
        "case. This exists as a named floor so that if dispersion is ever found "
        "to be systematically understated at low volumes, the correction has one "
        "place to live instead of being scattered through callers",
    status="PROVISIONAL",
)


#: Two tails, because the interval is two-sided. Deliberately not a Setting: a
#: one-sided interval is a DIFFERENT OBJECT with a different claim attached, and
#: making this configurable would let a caller turn a 90% two-sided range into a
#: 95% one-sided bound without changing the word "coverage" on the card.
_TAILS = 2


@dataclass(frozen=True, slots=True)
class PredictiveInterval:
    """A closed interval on a COUNT, with the distribution that produced it."""

    low: int
    high: int
    #: The nominal coverage claimed, so a stored interval can be audited against
    #: the setting that was in force when it was written.
    nominal_coverage: float
    mean: float
    #: The dispersion actually used, after the floor.
    dispersion_cv: float
    #: "negative_binomial" or "poisson" - cv == 0 is genuinely the Poisson case
    #: and saying so is more useful than reporting a size of infinity.
    distribution: str

    def __post_init__(self) -> None:
        if self.low > self.high:
            raise ValueError(
                f"low ({self.low}) exceeds high ({self.high}); a predictive "
                f"interval cannot be inverted"
            )
        if self.low < 0:
            raise ValueError(f"low ({self.low}) is negative; this is a count")

    def covers(self, actual: float) -> bool:
        """Did the realised count land inside. The coverage check, once."""
        return self.low <= actual <= self.high

    @property
    def width(self) -> int:
        return self.high - self.low

    def explain(self) -> str:
        return (
            f"between {self.low} and {self.high} units "
            f"({self.nominal_coverage * 100:.0f}% of the time)"
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "low": self.low, "high": self.high,
            "nominal_coverage": self.nominal_coverage,
            "mean": self.mean, "dispersion_cv": self.dispersion_cv,
            "distribution": self.distribution,
        }


@dataclass(frozen=True, slots=True)
class IntervalRefused:
    """No interval, and which of the named reasons applies."""

    basis: str

    def as_dict(self) -> dict[str, Any]:
        return {"low": None, "high": None, "basis": self.basis}


def _log_nb_pmf(x: int, size: float, mu: float) -> float:
    """log P(X = x) for NB in the mean/size parameterisation.

    `lgamma` and not a factorial: `size` is real-valued (1 / cv^2 is almost never
    an integer) so the combinatorial form does not apply, and summing logs keeps
    a 200-unit mean from underflowing to zero before the upper tail is reached.
    """
    p = size / (size + mu)
    return (
        math.lgamma(x + size) - math.lgamma(size) - math.lgamma(x + 1.0)
        + size * math.log(p) + x * math.log1p(-p)
    )


def _log_poisson_pmf(x: int, mu: float) -> float:
    return x * math.log(mu) - mu - math.lgamma(x + 1.0)


@dataclass(frozen=True, slots=True)
class LowerTail:
    """P(X <= count) under the count model, and which model it was.

    `distribution` is carried for the same reason `PredictiveInterval` carries
    it: a tail probability computed under Poisson for a SKU whose dispersion
    was never measured is a weaker statement than one computed under the SKU's
    own scatter, and the reader of a retirement reason is entitled to know
    which they are looking at.
    """

    probability: float
    distribution: str
    mean: float
    count: int

    def as_dict(self) -> dict[str, Any]:
        return {"probability": self.probability,
                "distribution": self.distribution,
                "mean": self.mean, "count": self.count}


def lower_tail_probability(
    count: float, *, mean: float, dispersion_cv: float,
) -> LowerTail:
    """P(X <= floor(count)) for a count with the given mean and dispersion.

    THE SAME MODEL AS THE INTERVAL, deliberately. The lifecycle's declining
    rule asks "how surprising is this few units, if the product were still
    selling at the rate that justified the card" - which is a lower-tail
    probability under exactly the count distribution the card's published
    range was drawn from. Two pmfs for one claim is how a card comes to say
    "between 4 and 26" on the front and be retired for selling 5 on the back.

    `dispersion_cv == 0` is Poisson, as in `predictive_interval`. A caller with
    an UNMEASURED cv must decide the fallback itself and say so; this function
    does not accept None, because silently reading absence as zero would test
    the product against the narrowest distribution there is on the least
    evidence - the exact defect `predictive_interval` refuses.

    BOUNDED. `count` is a realised number of units, so the sum runs from 0 to
    that count and no further; there is no quantile to search for and no cap
    to hit. A fractional count (a till that records 1.5 units) is floored,
    which errs toward a LOWER tail and therefore toward retiring, the
    conservative direction for a rule whose job is to stop a wrong card.
    """
    if mean <= 0.0:
        raise ValueError(f"mean ({mean}) must be positive; this is a count model")
    if dispersion_cv < 0.0:
        raise ValueError(f"dispersion_cv ({dispersion_cv}) cannot be negative")
    upper = max(0, int(math.floor(count)))

    if dispersion_cv == 0.0:
        distribution = "poisson"

        def log_pmf(x: int) -> float:
            return _log_poisson_pmf(x, mean)
    else:
        distribution = "negative_binomial"
        size = 1.0 / (dispersion_cv * dispersion_cv)

        def log_pmf(x: int) -> float:
            return _log_nb_pmf(x, size, mean)

    cumulative = 0.0
    for x in range(upper + 1):
        cumulative += math.exp(log_pmf(x))
    # Summing exponentials can creep a hair past 1.0 on a tail that is all
    # the mass; clamp rather than report a probability above one.
    return LowerTail(probability=min(1.0, cumulative), distribution=distribution,
                     mean=mean, count=upper)


def predictive_interval(
    *,
    rate: float | None,
    horizon_open_days: float | None,
    dispersion_cv: float | None,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> PredictiveInterval | IntervalRefused:
    """A two-sided predictive interval on units over the horizon.

    `rate` is per OPEN day and `horizon_open_days` is open days, because every
    other denominator in this engine is open days and mixing them here would
    inflate the mean silently.

    Returns `IntervalRefused` rather than raising: a SKU too thin to bound is an
    ordinary daily occurrence, not an error, and the caller prints the card
    without a range.
    """
    if rate is None or horizon_open_days is None:
        return IntervalRefused("no_inputs:rate_or_horizon_absent")
    if dispersion_cv is None:
        # Absence, not zero. Zero cv is the NARROWEST interval there is, so
        # defaulting an unmeasured SKU to it would state the most confident
        # possible range on the least evidence.
        return IntervalRefused("no_dispersion:not_measured")
    if rate <= 0.0:
        return IntervalRefused("no_demand:rate_not_positive")
    if horizon_open_days <= 0.0:
        return IntervalRefused("no_open_days:store_never_opens_in_horizon")
    if dispersion_cv < 0.0:
        return IntervalRefused(f"invalid_dispersion:cv_{dispersion_cv}")

    coverage = float(config.get(PREDICTIVE_COVERAGE, ctx))
    max_terms = int(config.get(MAX_SUMMATION_TERMS, ctx))
    cv = max(float(config.get(MIN_DISPERSION_CV, ctx)), dispersion_cv)

    mu = rate * horizon_open_days
    if mu <= 0.0:
        return IntervalRefused("no_expected_demand:mean_not_positive")

    # Symmetric tails. The interval is [q_lo, q_hi] with equal mass excluded on
    # each side, which is what makes a single `nominal_coverage` meaningful.
    tail = (1.0 - coverage) / _TAILS
    lo_target, hi_target = tail, 1.0 - tail

    if cv == 0.0:
        distribution = "poisson"

        def log_pmf(x: int) -> float:
            return _log_poisson_pmf(x, mu)
    else:
        distribution = "negative_binomial"
        size = 1.0 / (cv * cv)

        def log_pmf(x: int) -> float:
            return _log_nb_pmf(x, size, mu)

    # Walk the CDF once, recording both quantiles as they are passed. One pass,
    # so the two quantiles are guaranteed consistent with each other.
    cumulative = 0.0
    low: int | None = None
    high: int | None = None
    for x in range(max_terms):
        cumulative += math.exp(log_pmf(x))
        if low is None and cumulative >= lo_target:
            low = x
        if cumulative >= hi_target:
            high = x
            break
    if low is None or high is None:
        # The sum never reached the upper tail within the cap. Refusing is the
        # only honest move: the partial sum's last index is not a quantile.
        return IntervalRefused(f"not_converged:mean_{mu:.1f}_terms_{max_terms}")

    return PredictiveInterval(
        low=low, high=high, nominal_coverage=coverage, mean=mu,
        dispersion_cv=cv, distribution=distribution,
    )


__all__ = [
    "MAX_SUMMATION_TERMS",
    "MIN_DISPERSION_CV",
    "PREDICTIVE_COVERAGE",
    "IntervalRefused",
    "LowerTail",
    "PredictiveInterval",
    "lower_tail_probability",
    "predictive_interval",
]
