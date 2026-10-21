"""Price elasticity per (store, category), with an interval. Always.

    ln(units) = alpha + beta * ln(price) + day-of-week + month + e

    beta = -1.8  [-2.4, -1.2]   usable: a 10% cut buys ~18% more volume
    beta = -0.3  [-1.1, +0.5]   UNUSABLE: the interval spans zero

THE CLAIM THIS EXISTS TO CHECK
    Every markdown recommendation makes an implicit elasticity claim - "drop
    the price and volume will more than compensate". The current engine makes
    that claim with no estimate behind it at all. This sheet either supplies a
    real one or refuses to let the claim be made.

THE IDENTIFICATION PROBLEM, STATED PLAINLY
    Retail price variation is NOT experimental. Prices move for reasons that
    also move volume:

      - promotions, which are timed to demand the retailer already expects;
      - seasonality, which moves both price and volume together;
      - competitor moves, which we cannot observe at all;
      - cost pass-through, which moves price without moving demand.

    The day-of-week and month controls below absorb the crudest of that. They
    absorb NONE of the competitor effect and only some of the promotional one,
    because a promotion is precisely a price cut chosen for a week when volume
    was going to be high anyway. That bias runs toward finding elasticity
    where there is none.

    So: expect many intervals to span zero, especially at low-volume stores.
    **That is the correct answer, not a failure of the estimator.** Refusing
    beats inventing, and `guard.py` is the half of this sheet that matters.

WHY THE REGRESSION IS WRITTEN OUT
    There is no numpy, scipy, sklearn or statsmodels in this service. OLS via
    normal equations plus a Gauss-Jordan inverse is about eighty lines, exact,
    and deterministic. The same call sheet 07 made over LightGBM and sheet 08
    made over sklearn's isotonic.

    The standard errors are HC1 heteroskedasticity-robust, not the textbook
    homoskedastic ones. Retail daily sales are emphatically not constant-
    variance - a high-volume day is noisier in absolute terms than a quiet one
    - and classical standard errors would be too narrow, which would make
    intervals span zero LESS often. That is the one direction this sheet must
    not be wrong in.

SHRINKAGE IS SHEET 06's, NOT A SECOND IMPLEMENTATION
    The own estimate is blended toward a cohort beta through
    `app/pipeline/blend/shrink.py`, under the `elasticity` pattern, with the
    highest k in the programme. Nothing here re-implements a weighted average.
"""

from __future__ import annotations

import math
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

from app.pipeline.blend import BlendRequest, blend
from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

#: Pivot below which Gauss-Jordan calls the matrix singular.
#:
#: DERIVED from machine epsilon rather than written as 1e-12: it is a property
#: of floating-point arithmetic on this platform, not a judgement about retail
#: data, so it does not belong in the registry - and a hardcoded constant would
#: be silently wrong on a platform with different float precision. The
#: multiplier leaves several orders of magnitude of headroom above the point
#: where accumulated rounding in X'X becomes indistinguishable from a true zero.
_PIVOT_TOLERANCE = sys.float_info.epsilon * 4096

#: The step the card quotes an elasticity at. A 10% cut moving volume by
#: 10 * |beta| percent is the reading a buyer can act on; the raw coefficient
#: is not.
TEN_PERCENT_STEP = 10
PERCENT = 100

MIN_OBSERVATIONS = Setting(
    name="elasticity.min_observations",
    default=60,
    unit="store-days with a price and a sale",
    owner="forecasting",
    why="provisional; the regression spends 18 degrees of freedom on the "
        "day-of-week and month controls alone, so below roughly sixty "
        "observations the residual degrees of freedom collapse and every "
        "interval is vacuously wide. To be measured in wave 6",
    status="PROVISIONAL",
)

MIN_PRICE_LEVELS = Setting(
    name="elasticity.min_price_levels",
    default=5,
    unit="distinct observed prices",
    owner="forecasting",
    why="provisional; price has to actually move. Below five levels the slope "
        "is fitted through a cluster of near-identical points. Mirrors "
        "evidence.elasticity.min_price_levels, which counts the same thing "
        "for the shrinkage n",
    status="PROVISIONAL",
)

MIN_PRICE_CV_PCT = Setting(
    name="elasticity.min_price_cv_pct",
    default=2,
    unit="percent, coefficient of variation of price",
    owner="forecasting",
    why="provisional; five distinct prices spanning half a cent are still a "
        "flat price. This catches the rounding-noise case that a level count "
        "cannot: variation has to be economically real, not just arithmetic",
    status="PROVISIONAL",
)

UNIT_ELASTIC = Setting(
    name="elasticity.min_abs_beta_to_discount",
    default=1,
    unit="absolute elasticity",
    owner="forecasting",
    why="the REVENUE break-even, and arithmetic rather than judgement: at "
        "|beta| = 1 a price cut raises volume by exactly enough to hold "
        "revenue flat, and below it a discount LOSES money. A markdown claims "
        "volume will 'more than compensate', which is precisely |beta| > 1. "
        "Measured on real data this is the binding constraint, not the "
        "zero-spanning test: 79 of the 84 cells whose interval excluded zero "
        "were still inelastic, e.g. store 171 Vodka at -0.107, where a 10% cut "
        "buys 1.1% more volume and gives up about 9% of revenue. Margin "
        "break-even is STRICTER than this and depends on the cost sheet 02 "
        "already requires for a markdown; this is the floor every discount "
        "must clear, not the whole test",
    status="MEASURED",
)

MAX_PLAUSIBLE_ABS_BETA = Setting(
    name="elasticity.max_plausible_abs_beta",
    default=8,
    unit="absolute elasticity",
    owner="forecasting",
    why="provisional; a |beta| above eight means a 1% price move changes "
        "volume by 8% - not an elasticity, a fitting artifact from collinear "
        "controls or a handful of leverage points. Such a fit is reported as "
        "implausible rather than returned, because an absurd number with a "
        "tight interval is the most dangerous output this stage can produce",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class PriceObservation:
    """One store-day for one category: what it cost, how much moved."""

    obs_date: date
    price: float
    units: float

    def __post_init__(self) -> None:
        if self.price <= 0:
            raise ValueError(f"price must be positive, got {self.price}")
        if self.units < 0:
            raise ValueError(f"units cannot be negative, got {self.units}")


@dataclass(frozen=True, slots=True)
class Interval:
    """A closed interval. `spans_zero` is the only question that matters."""

    low: float
    high: float

    @property
    def spans_zero(self) -> bool:
        return self.low <= 0.0 <= self.high

    def entirely_below(self, threshold: float) -> bool:
        """Is the WHOLE interval beyond `threshold`? The claim-support test."""
        return self.high < threshold

    @property
    def entirely_below_zero(self) -> bool:
        """The only shape that supports a price-CUT claim.

        A markdown asserts "cut the price and volume rises", which needs beta
        strictly negative across the whole interval. An interval sitting
        entirely ABOVE zero does not span zero - so a naive "spans zero"
        test passes it - while being evidence AGAINST the very claim it would
        be cited for.

        That is not hypothetical. On real data, store 122's Tobacco category
        estimates beta +0.38 [+0.15, +0.61] and store 125's CIGAR +0.76
        [+0.51, +1.02]. Both are almost certainly confounding rather than real
        Veblen effects - retail prices rise in exactly the periods demand is
        already high - but either way they are not a reason to discount.
        """
        return self.high < 0.0

    @property
    def width(self) -> float:
        return self.high - self.low

    def as_dict(self) -> dict[str, Any]:
        return {"low": self.low, "high": self.high,
                "spans_zero": self.spans_zero}


@dataclass(frozen=True, slots=True)
class ElasticityRequest:
    """Everything the estimate needs. Supplied, never fetched."""

    store_key: tuple[int, int]
    category: str
    observations: Sequence[PriceObservation]
    #: The cohort's beta for this category, from sheet 05. None means no
    #: cohort resolved, and the own estimate stands alone.
    cohort_beta: float | None = None
    cohort_interval: Interval | None = None
    cohort_level: str | None = None
    cohort_size: int | None = None


@dataclass(frozen=True, slots=True)
class Elasticity:
    """beta, its interval, and enough context to distrust it correctly."""

    store_key: tuple[int, int]
    category: str
    beta: float
    interval: Interval
    #: Before shrinkage. Carried so a reader can see whether the store's own
    #: price history identified anything, or whether the answer is the
    #: cohort's wearing this store's name.
    own_beta: float
    own_interval: Interval
    own_weight: float
    n_observations: int
    n_price_levels: int
    price_cv_pct: float
    r_squared: float
    cohort_level: str | None
    cohort_size: int | None

    @property
    def usable(self) -> bool:
        """Usable AS A REASON TO CUT PRICE. See guard.py.

        Requires the whole interval beyond UNIT elasticity, not merely below
        zero. A beta of -0.1 is a real, statistically solid estimate that a
        10% cut moves 1% more volume - and acting on it gives up nine points
        of revenue to buy one. Statistically detectable and economically
        wrong are different things, and only the second one decides whether a
        card should be shown.
        """
        return self.interval.entirely_below(-float(UNIT_ELASTIC.default))

    def as_dict(self) -> dict[str, Any]:
        return {
            "store_key": list(self.store_key), "category": self.category,
            "beta": self.beta, "interval": self.interval.as_dict(),
            "own_beta": self.own_beta,
            "own_interval": self.own_interval.as_dict(),
            "own_weight": self.own_weight,
            "n_observations": self.n_observations,
            "n_price_levels": self.n_price_levels,
            "price_cv_pct": self.price_cv_pct,
            "r_squared": self.r_squared,
            "cohort_level": self.cohort_level, "cohort_size": self.cohort_size,
            "usable": self.usable,
        }

    def explain(self) -> str:
        """One sentence for the card. NEVER an empty string.

        The first version computed a redundant percentage and returned "" when
        it rounded to zero, so a genuine estimate whose beta was small but
        whose interval sat entirely below zero rendered as a BLANK - which is
        the failure sheet 02 outlawed, reached by arithmetic rather than by a
        missing field.
        """
        span = f"{self.interval.low:.2f} to {self.interval.high:.2f}"
        if self.interval.spans_zero:
            return (
                f"No reliable price effect for {self.category} at this store: "
                f"the estimate ({self.beta:.2f}) could plausibly be anywhere "
                f"from {span}, which includes no effect at all."
            )
        if not self.interval.entirely_below_zero:
            # Positive, and NOT a reason to discount. Said plainly rather than
            # reported as "no effect", which would be a different untruth.
            return (
                f"In {self.category}, volume has moved WITH price, not against "
                f"it ({self.beta:+.2f}, {span}) - usually a sign that prices "
                "rose in busy periods rather than that discounting would hurt. "
                "Either way it is not a reason to cut the price."
            )
        return (
            f"In {self.category}, a 10% price cut has moved volume about "
            f"{abs(self.beta) * TEN_PERCENT_STEP:.0f}% "
            f"({abs(self.interval.high) * TEN_PERCENT_STEP:.0f}-"
            f"{abs(self.interval.low) * TEN_PERCENT_STEP:.0f}%), "
            f"based on {self.n_price_levels} different prices over "
            f"{self.n_observations} days."
        )


# ── Linear algebra, pure stdlib ──────────────────────────────────────────────


def _invert(matrix: list[list[float]]) -> list[list[float]] | None:
    """Gauss-Jordan with partial pivoting. None when singular.

    None rather than an exception: a singular X'X means the design is
    collinear - a category where every day is the same weekday, say - and
    that is a data condition the caller must report, not a crash.
    """
    size = len(matrix)
    work = [row[:] + [1.0 if i == j else 0.0 for j in range(size)]
            for i, row in enumerate(matrix)]
    for column in range(size):
        pivot = max(range(column, size), key=lambda r: abs(work[r][column]))
        if abs(work[pivot][column]) < _PIVOT_TOLERANCE:
            return None
        work[column], work[pivot] = work[pivot], work[column]
        divisor = work[column][column]
        work[column] = [value / divisor for value in work[column]]
        for row in range(size):
            if row == column:
                continue
            factor = work[row][column]
            if factor:
                work[row] = [
                    a - factor * b for a, b in zip(work[row], work[column], strict=True)
                ]
    return [row[size:] for row in work]


def _xtx(design: Sequence[Sequence[float]]) -> list[list[float]]:
    width = len(design[0])
    out = [[0.0] * width for _ in range(width)]
    for row in design:
        for i in range(width):
            if row[i]:
                for j in range(width):
                    out[i][j] += row[i] * row[j]
    return out


def _xty(design: Sequence[Sequence[float]], y: Sequence[float]) -> list[float]:
    width = len(design[0])
    out = [0.0] * width
    for row, target in zip(design, y, strict=True):
        for i in range(width):
            if row[i]:
                out[i] += row[i] * target
    return out


def ols_with_robust_se(
    design: Sequence[Sequence[float]], y: Sequence[float]
) -> tuple[list[float], list[float], float] | None:
    """Coefficients, HC1 robust standard errors, and R-squared.

    HC1 rather than the classical homoskedastic formula. Daily retail sales
    are not constant-variance, and classical standard errors would come out
    too NARROW - making intervals span zero less often, which is the one
    direction this sheet must not be wrong in.
    """
    n = len(design)
    k = len(design[0])
    if n <= k:
        return None

    xtx_inverse = _invert(_xtx(design))
    if xtx_inverse is None:
        return None
    beta = [
        sum(xtx_inverse[i][j] * v for j, v in enumerate(_xty(design, y)))
        for i in range(k)
    ]

    residuals = [
        target - sum(b * x for b, x in zip(beta, row, strict=True))
        for row, target in zip(design, y, strict=True)
    ]

    # Meat of the sandwich: sum of e_i^2 * x_i x_i'.
    meat = [[0.0] * k for _ in range(k)]
    for row, residual in zip(design, residuals, strict=True):
        weight = residual * residual
        for i in range(k):
            if row[i]:
                for j in range(k):
                    meat[i][j] += weight * row[i] * row[j]

    # HC1's finite-sample correction, the same one Stata applies by default.
    correction = n / (n - k)
    variance = [
        [
            correction * sum(
                xtx_inverse[i][a] * meat[a][b] * xtx_inverse[b][j]
                for a in range(k) for b in range(k)
            )
            for j in range(k)
        ]
        for i in range(k)
    ]
    standard_errors = [math.sqrt(max(0.0, variance[i][i])) for i in range(k)]

    mean_y = sum(y) / n
    total_ss = sum((target - mean_y) ** 2 for target in y)
    residual_ss = sum(r * r for r in residuals)
    r_squared = 1.0 - residual_ss / total_ss if total_ss > 0 else 0.0
    return beta, standard_errors, r_squared


CRITICAL_VALUE_95 = Setting(
    name="elasticity.critical_value_95",
    default=2.042,
    unit="t multiplier",
    owner="forecasting",
    why="Student-t two-sided 95% at 30 residual degrees of freedom. ONE value "
        "rather than a lookup table, and conservative by construction: the "
        "stage refuses any fit with fewer than 30 residual df (see "
        "elasticity.min_residual_df), and t DECREASES as df rises, so this "
        "multiplier is at least as wide as the exact value for every fit the "
        "stage will accept. Erring wide is the only safe direction here - a "
        "narrower interval spans zero less often, which would let through "
        "exactly the unsupported price claims this sheet exists to block",
    status="MEASURED",
)

MIN_RESIDUAL_DF = Setting(
    name="elasticity.min_residual_df",
    default=30,
    unit="residual degrees of freedom",
    owner="forecasting",
    why="the floor that makes a single critical value honest. Below 30 df the "
        "t multiplier rises steeply (2.09 at 20, 2.78 at 4) and one fixed "
        "value would understate the interval badly. Such fits are refused "
        "rather than reported with a multiplier that flatters them",
    status="MEASURED",
)


# ── The estimate ─────────────────────────────────────────────────────────────


def build_design(
    observations: Sequence[PriceObservation],
) -> list[list[float]]:
    """[1, ln(price), day-of-week dummies, month dummies].

    THE REFERENCE LEVEL IS THE FIRST ONE OBSERVED, NOT A FIXED MONDAY/JANUARY.

    Dummy coding needs one level held out, or the dummies sum to the intercept
    and X'X is singular. Holding out a FIXED level only works if that level
    appears in the data. A 120-day window running May to September contains no
    January, so a January-referenced month set gives every observed month its
    own dummy - they sum to 1 on every row, which is exactly the intercept,
    and the fit dies reported as "controls collinear with price". It is not:
    it is the dummy-variable trap with an absent reference.

    That was silently costing real estimates - 61 of 335 real (store,
    category) cells were refused this way, most of them categories with a
    short trading history rather than anything wrong with their prices.

    Building the design from the OBSERVED levels fixes both that and the
    all-zero-column case in one step: a month that never occurs simply has no
    column.
    """
    if not observations:
        return []
    weekdays = sorted({o.obs_date.weekday() for o in observations})
    months = sorted({o.obs_date.month for o in observations})
    # Hold out the first observed level of each group.
    weekday_levels = weekdays[1:]
    month_levels = months[1:]

    design: list[list[float]] = []
    for observation in observations:
        row = [1.0, math.log(observation.price)]
        weekday = observation.obs_date.weekday()
        row += [1.0 if weekday == d else 0.0 for d in weekday_levels]
        month = observation.obs_date.month
        row += [1.0 if month == m else 0.0 for m in month_levels]
        design.append(row)
    return design


def _price_cv_pct(prices: Sequence[float]) -> float:
    mean = sum(prices) / len(prices)
    if mean <= 0:
        return 0.0
    variance = sum((p - mean) ** 2 for p in prices) / len(prices)
    return PERCENT * math.sqrt(variance) / mean


@stage("elasticity_estimate", "1.0.0")
def estimate_elasticity(
    request: ElasticityRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """beta for one (store, category), with an interval. Never a bare point.

    Refuses - ok=False - when the data cannot support a regression at all.
    That is different from succeeding with an interval that spans zero, which
    is a real estimate saying "no detectable effect" and is handled by
    `guard.py`. Both are honest answers; only one of them has a number.
    """
    record_inputs("feature_daily.price", "feature_daily.units_sold")

    usable = [o for o in request.observations if o.price > 0 and o.units > 0]
    min_observations = config.get(MIN_OBSERVATIONS, ctx)
    min_levels = config.get(MIN_PRICE_LEVELS, ctx)
    min_cv = config.get(MIN_PRICE_CV_PCT, ctx)

    if len(usable) < min_observations:
        return StageResult.failure(
            f"too_few_observations:{len(usable)}<{min_observations}",
            provenance=_empty_provenance(len(usable)),
        )

    prices = [o.price for o in usable]
    levels = {round(p, 2) for p in prices}
    if len(levels) < min_levels:
        return StageResult.failure(
            f"price_does_not_vary:{len(levels)}_distinct_levels<{min_levels}",
            provenance=_empty_provenance(len(usable)),
        )

    cv_pct = _price_cv_pct(prices)
    if cv_pct < min_cv:
        return StageResult.failure(
            f"price_variation_is_noise:cv={cv_pct:.2f}%<{min_cv}%",
            provenance=_empty_provenance(len(usable)),
        )

    design = build_design(usable)
    y = [math.log(o.units) for o in usable]
    fitted = ols_with_robust_se(design, y)
    if fitted is None:
        return StageResult.failure(
            "design_is_singular:controls_collinear_with_price",
            provenance=_empty_provenance(len(usable)),
        )

    coefficients, standard_errors, r_squared = fitted
    own_beta = coefficients[1]
    own_se = standard_errors[1]
    max_abs = config.get(MAX_PLAUSIBLE_ABS_BETA, ctx)
    if abs(own_beta) > max_abs:
        return StageResult.failure(
            f"implausible_beta:{own_beta:.2f}_exceeds_{max_abs}",
            provenance=_empty_provenance(len(usable)),
        )

    residual_df = len(usable) - len(design[0])
    min_df = config.get(MIN_RESIDUAL_DF, ctx)
    if residual_df < min_df:
        return StageResult.failure(
            f"too_few_residual_degrees_of_freedom:{residual_df}<{min_df}",
            provenance=_empty_provenance(len(usable)),
        )
    critical = config.get(CRITICAL_VALUE_95, ctx)
    own_interval = Interval(own_beta - critical * own_se,
                            own_beta + critical * own_se)

    # ── Shrinkage is sheet 06's. n is PRICE LEVELS, not days: two hundred
    # days at one price is no evidence about a price effect.
    n = len(levels)
    if request.cohort_beta is None:
        beta, interval, own_weight = own_beta, own_interval, 1.0
        cohort_level = cohort_size = None
    else:
        blended = blend(
            BlendRequest(
                pattern="elasticity", n=n, theta_own=own_beta,
                theta_cohort=request.cohort_beta,
                cohort_level=request.cohort_level,
                cohort_size=request.cohort_size,
            ),
            ctx, config,
        )
        if not blended.ok or blended.value is None:
            return blended
        beta = blended.value.value
        own_weight = blended.value.own_weight
        # The ENDPOINTS are shrunk on the same weight as the point estimate.
        # Shrinking only the centre would leave a wide own-interval around a
        # cohort-dominated point - an interval describing an estimate that is
        # no longer being reported.
        cohort_interval = request.cohort_interval or Interval(
            request.cohort_beta, request.cohort_beta
        )
        interval = Interval(
            own_weight * own_interval.low + (1 - own_weight) * cohort_interval.low,
            own_weight * own_interval.high + (1 - own_weight) * cohort_interval.high,
        )
        cohort_level = request.cohort_level
        cohort_size = request.cohort_size

    elasticity = Elasticity(
        store_key=request.store_key,
        category=request.category,
        beta=beta,
        interval=interval,
        own_beta=own_beta,
        own_interval=own_interval,
        own_weight=own_weight,
        n_observations=len(usable),
        n_price_levels=n,
        price_cv_pct=cv_pct,
        r_squared=r_squared,
        cohort_level=cohort_level,
        cohort_size=cohort_size,
    )
    return StageResult.success(
        elasticity,
        Provenance(
            own_observations=n,
            own_weight=own_weight,
            cohort_level=cohort_level,  # type: ignore[arg-type]
            cohort_size=cohort_size,
            evidence_state="ESTABLISHED" if n >= min_levels else "EMERGING",
            inputs=("feature_daily.price", "feature_daily.units_sold"),
        ),
    )


def _empty_provenance(observations: int) -> Provenance:
    return Provenance(
        own_observations=observations,
        own_weight=1.0,
        evidence_state="NEW",
        inputs=("feature_daily.price", "feature_daily.units_sold"),
    )


__all__ = [
    "CRITICAL_VALUE_95",
    "MAX_PLAUSIBLE_ABS_BETA",
    "MIN_RESIDUAL_DF",
    "MIN_OBSERVATIONS",
    "MIN_PRICE_CV_PCT",
    "MIN_PRICE_LEVELS",
    "Elasticity",
    "build_design",
    "ElasticityRequest",
    "Interval",
    "PriceObservation",
    "estimate_elasticity",
    "ols_with_robust_se",
]
