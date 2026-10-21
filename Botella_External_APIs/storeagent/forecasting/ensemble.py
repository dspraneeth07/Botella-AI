"""One forecaster per demand shape. Every one returns p10 / p50 / p90.

    smooth        seasonal ETS            interval from residual bootstrap
    intermittent  Croston                 interval from demand bootstrap
    erratic       SBA                     interval from demand bootstrap
    lumpy         SBA, wide               may REFUSE - see below
    new_sku       cohort prior            interval from cohort dispersion

A BARE POINT ESTIMATE IS NOT AN ACCEPTABLE OUTPUT OF THIS STAGE.
    Downstream inventory policy needs the spread, not the middle. "Order 12"
    and "order 12, and the realistic range is 4 to 31" lead to different
    decisions, and only the second one is honest about a lumpy SKU. Every
    method here produces all three quantiles or returns ok=False.

WHY THERE IS NO TREND TERM BY DEFAULT
    Holt-Winters has a trend slot, and filling it would be the obvious thing
    to do. We are not going to.

    The last backtest scored 23% against a 32% random pick because the engine
    was instructed to chase ACCELERATING products, and momentum ANTI-predicts
    at this horizon: rho = -0.36 at 60 days. The model executed that
    instruction faithfully, to within 0.3 points of a mechanical
    top-accelerators picker. It was not a modelling failure; it was a
    correctly-executed wrong objective.

    So `forecast.ets.beta` - the trend weight - defaults to **0.0**. The
    structure is present and the setting is in the registry, so wave 6 can fit
    it from holdout error if the data ever supports a trend term. Until then
    the level is the level. The target of this stage is DEMAND OVER THE
    HORIZON, not the direction demand has recently been moving.

WHY REFUSING IS CORRECT FOR LUMPY
    A lumpy SKU is rare AND wildly variable. Its honest 80% interval can span
    a factor of ten, and an interval that wide does not support any inventory
    decision - you cannot order "somewhere between 2 and 40". Sheet 02
    established the right to refuse; this is the forecasting instance of it.
    Returning a confident-looking midpoint instead would be the ambiguous
    output this rebuild exists to remove.

DETERMINISM IS ASSERTED TO A TOLERANCE, NOT BITWISE
    The bootstrap is seeded from `ctx.seed` and the SKU, so two runs on the
    same snapshot agree. The test asserts agreement within an epsilon rather
    than bitwise equality: a bitwise assertion over floating-point
    accumulation becomes flaky and then gets disabled, which is worse than no
    assertion at all.
"""

from __future__ import annotations

import math
import random
import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg
from storeagent.forecasting.classify import (
    ERRATIC,
    INTERMITTENT,
    LUMPY,
    NEW_SKU,
    SMOOTH,
    DemandProfile,
)

PERCENT = 100

# ── Smoothing constants ──────────────────────────────────────────────────────

CROSTON_ALPHA = Setting(
    name="forecast.croston.alpha",
    default=0.1,
    unit="smoothing weight",
    owner="forecasting",
    why="provisional; the classical Croston range is 0.05-0.2 and 0.1 is its "
        "midpoint. Low on purpose - intermittent series are mostly zeros, so a "
        "responsive alpha chases noise. To be fitted from holdout WAPE per "
        "demand class in wave 6",
    status="PROVISIONAL",
)

ETS_ALPHA = Setting(
    name="forecast.ets.alpha",
    default=0.2,
    unit="smoothing weight",
    owner="forecasting",
    why="provisional; level smoothing for smooth-class SKUs. Higher than "
        "Croston's because a daily seller's recent level is genuinely "
        "informative. To be fitted in wave 6",
    status="PROVISIONAL",
)

ETS_BETA = Setting(
    name="forecast.ets.beta",
    default=0.0,
    unit="smoothing weight",
    owner="forecasting",
    why="ZERO ON PURPOSE - this is the trend/momentum weight, and momentum "
        "ANTI-predicts at this horizon (rho = -0.36 at 60 days). The previous "
        "engine scored 23% against a 32% random pick precisely because it was "
        "told to chase accelerating products. The slot exists so wave 6 can "
        "fit it from holdout error if the data ever supports one; a positive "
        "fitted value is a signal to re-examine, not a discovery",
    status="PROVISIONAL",
)

ETS_GAMMA = Setting(
    name="forecast.ets.gamma",
    default=0.1,
    unit="smoothing weight",
    owner="forecasting",
    why="provisional; weekly seasonal smoothing. Liquor's weekend surge is "
        "stable, so the seasonal indices should move slowly. To be fitted in "
        "wave 6",
    status="PROVISIONAL",
)

# ── Interval construction ────────────────────────────────────────────────────

BOOTSTRAP_DRAWS = Setting(
    name="forecast.interval.bootstrap_draws",
    default=1000,
    unit="simulated horizons",
    owner="forecasting",
    why="provisional; enough draws that the 10th and 90th percentiles are "
        "stable to about a percent, few enough to run per SKU across the "
        "estate. To be measured against interval stability in wave 6",
    status="PROVISIONAL",
)

LOWER_QUANTILE = Setting(
    name="forecast.interval.lower_quantile",
    default=0.1,
    unit="quantile",
    owner="forecasting",
    why="p10. The lower edge of the 80% central interval this stage is "
        "contracted to return. Not a tuning knob - it is the output contract",
    status="MEASURED",
)

UPPER_QUANTILE = Setting(
    name="forecast.interval.upper_quantile",
    default=0.9,
    unit="quantile",
    owner="forecasting",
    why="p90. The upper edge of the same interval, and the number an inventory "
        "policy uses to size a safety buffer. Not a tuning knob",
    status="MEASURED",
)

LUMPY_MAX_RELATIVE_WIDTH = Setting(
    name="forecast.lumpy.max_relative_width",
    default=4.0,
    unit="(p90 - p10) / p50",
    owner="forecasting",
    why="provisional; above this the interval spans more than four times the "
        "central estimate and supports no ordering decision - you cannot act "
        "on 'somewhere between 2 and 40'. Refusing is the correct answer and "
        "sheet 02 established the right to give it. To be measured against "
        "what buyers actually act on in wave 6",
    status="PROVISIONAL",
)

NEW_SKU_FALLBACK_CV_PCT = Setting(
    name="forecast.new_sku.fallback_cv_pct",
    default=80,
    unit="percent",
    owner="forecasting",
    why="provisional; the dispersion assumed for a new SKU when the cohort "
        "reports none. Deliberately wide - a store with no history of a "
        "product should see a wide interval, and a narrow default would be a "
        "confident claim we have no basis for. To be measured in wave 6",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class ForecastRequest:
    """Everything a forecast needs. Assembled by the caller, never fetched."""

    profile: DemandProfile
    #: The horizon, measured in OPEN days - the same unit the profile's ADI and
    #: intervals are in. Mixing calendar and open days here would silently
    #: rescale every forecast by the store's opening pattern.
    horizon_open_days: int
    #: Units per OPEN day, oldest first, for the open days in the window.
    #: Dense: zeros included, because for a smooth SKU a zero day is real
    #: information. Only the smooth path reads it.
    series: Sequence[float] = ()
    #: How many open days there are in a week for this store. The seasonal
    #: period, derived from the calendar rather than assumed to be 7.
    open_days_per_week: int = 7
    #: Sheet 05/06 output, for the new_sku path. `cohort_level` is units per
    #: open day; `cohort_cv_pct` is the cohort's dispersion.
    cohort_level: float | None = None
    cohort_cv_pct: int | None = None


@dataclass(frozen=True, slots=True)
class Forecast:
    """Total units expected over the horizon, with its honest spread."""

    sku: str
    demand_class: str
    method: str
    horizon_open_days: int
    p10: float
    p50: float
    p90: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "sku": self.sku, "demand_class": self.demand_class,
            "method": self.method, "horizon_open_days": self.horizon_open_days,
            "p10": self.p10, "p50": self.p50, "p90": self.p90,
        }

    @property
    def relative_width(self) -> float | None:
        """(p90 - p10) / p50. None when the centre is zero."""
        return ((self.p90 - self.p10) / self.p50) if self.p50 > 0 else None

    def explain(self) -> str:
        return (
            f"Expect about {self.p50:.0f} units over the next "
            f"{self.horizon_open_days} trading days "
            f"({self.p10:.0f} to {self.p90:.0f} in 8 cases out of 10)."
        )


# ── Small numerical helpers, pure stdlib ─────────────────────────────────────


def quantile(values: Sequence[float], q: float) -> float:
    """Empirical quantile with linear interpolation, on a sorted copy.

    Written out rather than pulled from `statistics.quantiles`, which cuts at
    fixed n-tiles and would force p10/p90 to be expressed as "the 1st and 9th
    of 10 cuts" - a rounding of the contract rather than the contract.
    """
    if not values:
        raise ValueError("quantile of an empty sample")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = q * (len(ordered) - 1)
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def _rng(ctx: RunContext, sku: str) -> random.Random:
    """A generator seeded from the run and the SKU.

    Per-SKU rather than one shared stream, so a forecast does not depend on how
    many other SKUs were processed before it, or in what order. That would make
    a single SKU's answer change when an unrelated SKU was added to the batch -
    the same class of instability as an estimate that moves with the batch size.
    """
    return random.Random(f"{ctx.seed}:{ctx.run_id}:{sku}")


# ── The five methods ─────────────────────────────────────────────────────────


def croston_rate(
    sizes: Sequence[float], intervals: Sequence[int], alpha: float, *, debias: float
) -> float:
    """Units per open day. Croston when debias=1.0, SBA when debias<1.0.

    Croston smooths demand SIZE and demand INTERVAL as two separate series and
    divides one by the other. That is the whole idea: for an intermittent SKU,
    "how much when it sells" and "how often it sells" are different questions
    with different dynamics, and averaging over the zeros answers neither.

    SBA (Syntetos-Boylan Approximation) multiplies the result by (1 - alpha/2).
    Croston's estimator is biased HIGH - the expectation of a ratio is not the
    ratio of expectations - and the correction is the published remedy.
    """
    if not sizes:
        return 0.0

    # Two INDEPENDENT smoothed series, each walked over its own full length.
    #
    # The first version walked both inside one loop indexed by `sizes`, which
    # silently dropped the last interval - and the last interval is the one
    # that matters most, because it is the silence since the most recent sale.
    # On store 122 that left a delisted SKU forecasting 1,016 units against an
    # actual of 0: it had sold 22.8/day for 584 days and then stopped, and the
    # estimator never saw the stopping.
    size = sizes[0]
    for observed in sizes[1:]:
        size += alpha * (observed - size)

    interval = float(intervals[0]) if intervals else 1.0
    for observed_gap in intervals[1:]:
        interval += alpha * (observed_gap - interval)

    if interval <= 0:
        interval = 1.0
    return debias * size / interval


def seasonal_ets(
    series: Sequence[float], period: int, alpha: float, beta: float, gamma: float
) -> tuple[float, list[float], list[float]]:
    """Holt-Winters additive. Returns (level, seasonal indices, residuals).

    `beta` is the trend weight and defaults to 0.0 - see the module docstring.
    The trend line below is retained deliberately: deleting it would hide the
    decision, and a zero weight makes the decision visible and reversible from
    the registry rather than from a code change.
    """
    period = max(1, period)
    if len(series) < period * 2:
        level = statistics.fmean(series) if series else 0.0
        return level, [0.0] * period, []

    first = list(series[:period])
    level = statistics.fmean(first)
    trend = 0.0
    seasonal = [value - level for value in first]
    residuals: list[float] = []

    for index in range(period, len(series)):
        observed = series[index]
        season_index = index % period
        predicted = level + trend + seasonal[season_index]
        residuals.append(observed - predicted)

        previous_level = level
        deseasonalised = observed - seasonal[season_index]
        level = alpha * deseasonalised + (1 - alpha) * (level + trend)
        # Zero by default. The momentum term (see module docstring).
        trend = beta * (level - previous_level) + (1 - beta) * trend
        seasonal[season_index] = (
            gamma * (observed - level) + (1 - gamma) * seasonal[season_index]
        )

    return level, seasonal, residuals


def _bootstrap_demand_totals(
    sizes: Sequence[float], intervals: Sequence[int],
    horizon: int, draws: int, rng: random.Random,
) -> list[float]:
    """Simulate the horizon by resampling observed intervals and sizes.

    An intermittent forecast's uncertainty is mostly about WHEN, not how much,
    so the intervals are resampled too rather than held at their mean. Holding
    them fixed would produce an interval that understates the real spread in
    exactly the class where the spread is the point.
    """
    if not sizes:
        return [0.0] * draws
    pool = list(intervals) if intervals else [1]
    totals: list[float] = []
    for _ in range(draws):
        # THE FIRST GAP IS NEITHER A FULL INTERVAL NOR A UNIFORM ONE.
        #
        # The horizon starts wherever today happens to fall, not on a sale, so
        # the wait to the first demand is the renewal process's forward
        # recurrence time. Getting it right took two corrections, and both were
        # measured on store 171 rather than reasoned about:
        #
        #   1. Drawing a FULL interval first under-forecast badly - a SKU
        #      selling every ~36 open days returned p10 = p50 = p90 = 0 over a
        #      30-day horizon, because the first draw always overshot it. The
        #      true chance of a sale is ~83%.
        #
        #   2. Drawing the first interval UNIFORMLY then starting uniformly
        #      inside it over-forecast by +12.3% against a -1.0% seasonal-naive
        #      baseline, and lost the intermittent class in the backtest. The
        #      inspection paradox: a randomly chosen MOMENT is more likely to
        #      fall inside a long gap than a short one, so the interval
        #      containing "today" must be chosen with probability proportional
        #      to its LENGTH. Sampling gaps uniformly quietly assumes today is
        #      equally likely to sit in a one-day gap and a thirty-day one.
        #
        # Length-bias the containing interval, then start uniformly within it.
        # That is the stationary renewal process, and it is what makes the
        # expected event count come out at horizon / mean interval.
        containing = rng.choices(pool, weights=pool, k=1)[0]
        elapsed = rng.randint(1, max(1, containing))
        total = 0.0
        while elapsed <= horizon:
            total += rng.choice(sizes)
            elapsed += rng.choice(pool)
        totals.append(total)
    return totals


def _bootstrap_residual_totals(
    point: float, residuals: Sequence[float],
    horizon: int, draws: int, rng: random.Random,
) -> list[float]:
    """Horizon totals as the point forecast plus resampled one-step residuals.

    Resampled rather than scaled by sqrt(horizon): that shortcut assumes
    normal, independent errors, and demand residuals are neither. Summing real
    residuals keeps whatever skew the SKU actually has.
    """
    if not residuals:
        return [point] * draws
    return [
        max(0.0, point + sum(rng.choice(residuals) for _ in range(horizon)))
        for _ in range(draws)
    ]


@stage("forecast_ensemble", "1.0.0")
def forecast(
    request: ForecastRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """One SKU, one horizon, p10/p50/p90 - or an honest refusal.

    The method is chosen by the demand CLASS, which is what this sheet is for.
    That dispatch is not the branch sheet 06 forbids: it selects an estimator
    for a measured property of the SKU's demand, and it never branches on how
    much evidence there is. `new_sku` is a dispatch entry like any other, and
    its level arrives already blended by sheet 06.
    """
    record_inputs("forecast_classify.demand_class", "feature_daily.units_sold")

    profile = request.profile
    horizon = request.horizon_open_days
    if horizon < 1:
        return StageResult.failure(
            "horizon_must_be_at_least_one_open_day",
            provenance=_provenance(profile),
        )

    draws = config.get(BOOTSTRAP_DRAWS, ctx)
    lower = config.get(LOWER_QUANTILE, ctx)
    upper = config.get(UPPER_QUANTILE, ctx)
    rng = _rng(ctx, profile.sku)

    handlers = {
        SMOOTH: _forecast_smooth,
        INTERMITTENT: _forecast_croston,
        ERRATIC: _forecast_sba,
        LUMPY: _forecast_sba,
        NEW_SKU: _forecast_new_sku,
    }
    totals = handlers[profile.demand_class](request, ctx, config, horizon, draws, rng)

    point = statistics.median(totals)
    result = Forecast(
        sku=profile.sku,
        demand_class=profile.demand_class,
        method=profile.method,
        horizon_open_days=horizon,
        p10=quantile(totals, lower),
        p50=point,
        p90=quantile(totals, upper),
    )

    # The refusal. Lumpy only: for every other class a wide interval is
    # information, but for a lumpy SKU it is the whole answer, and a wide
    # answer to "how many should I order" is not an answer.
    if profile.demand_class == LUMPY:
        width = result.relative_width
        limit = config.get(LUMPY_MAX_RELATIVE_WIDTH, ctx)
        if width is None or width > limit:
            measured = "undefined" if width is None else round(width, 2)
            return StageResult.failure(
                f"lumpy_interval_too_wide_to_act_on:{measured}>{limit}",
                provenance=_provenance(profile),
            )

    return StageResult.success(result, _provenance(profile))


def _forecast_smooth(
    request: ForecastRequest, ctx: RunContext, config: ConfigRegistry,
    horizon: int, draws: int, rng: random.Random,
) -> list[float]:
    alpha = config.get(ETS_ALPHA, ctx)
    beta = config.get(ETS_BETA, ctx)
    gamma = config.get(ETS_GAMMA, ctx)
    level, seasonal, residuals = seasonal_ets(
        request.series, request.open_days_per_week, alpha, beta, gamma
    )
    # Sum the seasonal indices the horizon actually lands on rather than
    # assuming it covers whole weeks - a 10-day horizon on a 7-open-day week
    # is not 10/7 of a week's seasonality.
    start = len(request.series)
    seasonal_total = sum(
        seasonal[(start + offset) % len(seasonal)] for offset in range(horizon)
    ) if seasonal else 0.0
    point = max(0.0, level * horizon + seasonal_total)
    return _bootstrap_residual_totals(point, residuals, horizon, draws, rng)


def _level_adjusted_sizes(
    sizes: Sequence[float], intervals: Sequence[int], target_rate: float
) -> list[float]:
    """Rescale demand SIZES so the simulated process runs at `target_rate`.

    The bootstrap resamples the history uniformly, which says "what has this
    SKU done" and weights a sale from two years ago exactly like last week's.
    Croston says "what is it doing now" - the exponential smoothing IS the
    recency weighting, and it is the entire reason the sheet names Croston for
    this class. Using the raw bootstrap as the estimate threw that away and
    cost the intermittent class the backtest on store 171: WAPE 54.3 against a
    seasonal-naive 44.1.

    THE ADJUSTMENT GOES INTO THE SIMULATION, NOT ONTO ITS OUTPUT.
        The first attempt scaled the finished totals by point/median. Where the
        median sits near zero - which is most lumpy SKUs over a short horizon -
        that factor explodes: a p90 of 100 became 12,052. Scaling the inputs
        keeps the distribution coherent, preserves the genuine probability of
        selling nothing at all, and cannot manufacture a tail.
    """
    if not sizes:
        return []
    mean_size = statistics.fmean(sizes)
    mean_interval = statistics.fmean(intervals) if intervals else 1.0
    if mean_size <= 0 or mean_interval <= 0:
        return list(sizes)
    empirical_rate = mean_size / mean_interval
    if empirical_rate <= 0 or target_rate <= 0:
        return list(sizes)
    factor = target_rate / empirical_rate
    return [size * factor for size in sizes]


def _forecast_croston(
    request: ForecastRequest, ctx: RunContext, config: ConfigRegistry,
    horizon: int, draws: int, rng: random.Random,
) -> list[float]:
    """Croston for the level, bootstrap over the intervals for the spread."""
    alpha = config.get(CROSTON_ALPHA, ctx)
    profile = request.profile
    rate = croston_rate(profile.sizes, profile.intervals, alpha, debias=1.0)
    sizes = _level_adjusted_sizes(profile.sizes, profile.intervals, rate)
    return _bootstrap_demand_totals(sizes, profile.intervals, horizon, draws, rng)


def _forecast_sba(
    request: ForecastRequest, ctx: RunContext, config: ConfigRegistry,
    horizon: int, draws: int, rng: random.Random,
) -> list[float]:
    """SBA: the same bootstrap, recentred on the debiased rate.

    The bootstrap gives the SHAPE of the distribution; Croston's ratio is
    biased high, so the whole distribution is shifted down by the published
    (1 - alpha/2) factor rather than only the point estimate. Correcting the
    centre and leaving the tails would make p50 and p90 describe different
    estimators.
    """
    alpha = config.get(CROSTON_ALPHA, ctx)
    profile = request.profile
    rate = croston_rate(
        profile.sizes, profile.intervals, alpha, debias=1 - alpha / 2,
    )
    sizes = _level_adjusted_sizes(profile.sizes, profile.intervals, rate)
    return _bootstrap_demand_totals(sizes, profile.intervals, horizon, draws, rng)


def _forecast_new_sku(
    request: ForecastRequest, ctx: RunContext, config: ConfigRegistry,
    horizon: int, draws: int, rng: random.Random,
) -> list[float]:
    """The cold-start path. No own data is read, and none exists.

    The level arrives already blended by sheet 06 - with n=0 that blend IS the
    cohort prior, reached without a branch. All this does is turn a rate into a
    horizon total and put the cohort's own dispersion around it.
    """
    level = request.cohort_level or 0.0
    point = max(0.0, level * horizon)
    cv_pct = request.cohort_cv_pct
    if cv_pct is None:
        cv_pct = config.get(NEW_SKU_FALLBACK_CV_PCT, ctx)
    spread = point * (cv_pct / PERCENT)
    # A symmetric spread around the cohort level, floored at zero. Not a
    # bootstrap: there is nothing of this store's to resample, and resampling
    # the cohort's stores would claim a precision about THIS store that the
    # cohort cannot support.
    return [
        max(0.0, point + rng.uniform(-spread, spread)) for _ in range(draws)
    ]


def _provenance(profile: DemandProfile) -> Provenance:
    return Provenance(
        own_observations=profile.demand_events,
        own_weight=1.0 if profile.demand_class != NEW_SKU else 0.0,
        evidence_state="NEW" if profile.demand_class == NEW_SKU else "ESTABLISHED",
        inputs=("forecast_classify.demand_class", "feature_daily.units_sold"),
    )


__all__ = [
    "BOOTSTRAP_DRAWS",
    "CROSTON_ALPHA",
    "ETS_ALPHA",
    "ETS_BETA",
    "ETS_GAMMA",
    "LOWER_QUANTILE",
    "LUMPY_MAX_RELATIVE_WIDTH",
    "NEW_SKU_FALLBACK_CV_PCT",
    "UPPER_QUANTILE",
    "Forecast",
    "ForecastRequest",
    "croston_rate",
    "forecast",
    "quantile",
    "seasonal_ets",
]
