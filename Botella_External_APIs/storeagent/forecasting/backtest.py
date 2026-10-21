"""Walk-forward backtest of the demand model on store-level daily totals.

For each day in the holdout window we forecast it using ONLY prior data (same
model the buy list uses), then compare to actual. Reports WAPE (weighted absolute
% error) and bias so the owner knows how much to trust the forecast. Validated at
store level (stable); per-SKU point forecasts are inherently noisier.

SHEET 07 EXTENDS THIS FILE RATHER THAN REPLACING IT.
    `backtest_daily` below is the store-level walk-forward check and is
    unchanged - `storeagent/runtime/pipeline.py` calls it. Everything under the
    second banner is additive: a rolling-origin, per-SKU backtest scored
    separately for each demand class.
"""
from __future__ import annotations

import dataclasses
import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.features.store import CalendarDay, DayFact
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

from ..config import FORECAST, ForecastThresholds
from .classify import (
    DEMAND_CLASSES,
    NEW_SKU,
    ClassifyRequest,
    classify,
    open_day_sequence,
)
from .demand import pg_dow
from .ensemble import (
    LOWER_QUANTILE,
    UPPER_QUANTILE,
    ForecastRequest,
    forecast,
)


def _forecast_one_day(series: dict[date, float], target: date,
                      t: ForecastThresholds, train_days: int = 365,
                      recent_days: int = 90) -> float:
    dow_sum = [0.0] * 7
    dow_cnt = [0] * 7
    long_sum = recent_sum = 0.0
    for i in range(1, train_days + 1):
        d = target - timedelta(days=i)
        u = series.get(d, 0.0)
        w = pg_dow(d)
        dow_sum[w] += u
        dow_cnt[w] += 1
        long_sum += u
        if i <= recent_days:
            recent_sum += u
    rate_long = long_sum / train_days
    rate_short = recent_sum / recent_days
    if rate_long > 0:
        rf = max(t.recency_clamp_lo, min(t.recency_clamp_hi, rate_short / rate_long))
    else:
        rf = 1.0 if rate_short > 0 else 0.0
    w0 = pg_dow(target)
    dow_avg = dow_sum[w0] / dow_cnt[w0] if dow_cnt[w0] else 0.0
    return dow_avg * rf


def backtest_daily(daily: list[tuple[date, float]], as_of: date,
                   t: ForecastThresholds = FORECAST) -> dict:
    series = {d: float(u) for d, u in daily}
    test_days = t.backtest_test_days
    abs_err = total_actual = signed_err = 0.0
    n = 0
    for i in range(test_days):
        target = as_of - timedelta(days=i)
        actual = series.get(target, 0.0)
        fc = _forecast_one_day(series, target, t)
        abs_err += abs(actual - fc)
        signed_err += (fc - actual)
        total_actual += actual
        n += 1
    wape = (100 * abs_err / total_actual) if total_actual else None
    bias = (100 * signed_err / total_actual) if total_actual else None
    return {
        "test_days": n,
        "wape_pct": round(wape, 1) if wape is not None else None,
        "bias_pct": round(bias, 1) if bias is not None else None,
        "avg_daily_actual": round(total_actual / n, 1) if n else 0.0,
        "accuracy_pct": round(100 - wape, 1) if wape is not None else None,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Sheet 07 PR 3 — rolling-origin backtest, scored PER DEMAND CLASS.
#
# WHY PER CLASS, AND WHY THE VERDICT IS AN "ALL" RATHER THAN AN AVERAGE
#     An ensemble that wins on average while losing on intermittent SKUs has
#     FAILED. Intermittent is the majority of the catalogue, and an average
#     over SKUs is dominated by the smooth minority that sell every day and
#     carry most of the volume. Averaging would let us ship a model that is
#     worse for most products and report it as an improvement - which is very
#     close to what happened last time.
#
#     So `BacktestReport.passed` is true only when EVERY class with enough
#     windows to judge beats seasonal-naive. One failing class fails the whole
#     report, and a class with too few windows is UNJUDGED, which is also not a
#     pass.
#
# WHY MOMENTUM IS MEASURED HERE RATHER THAN ASSERTED IN A COMMENT
#     The previous engine scored 23% against a 32% random pick because it was
#     instructed to chase accelerating products, and momentum anti-predicts at
#     this horizon (rho = -0.36 at 60 days). `momentum_rho` recomputes that
#     correlation on whatever data this backtest was handed, so the claim is a
#     number the team can look at rather than a warning nobody re-checks. If it
#     ever comes back solidly positive, that is the moment to re-examine.
# ═══════════════════════════════════════════════════════════════════════════

PERCENT_SCALE = 100

BACKTEST_ORIGINS = Setting(
    name="backtest.origins",
    default=8,
    unit="rolling origins per SKU",
    owner="forecasting",
    why="provisional; eight origins a fortnight apart covers about four months "
        "of holdout per SKU - enough to average over a seasonal swing without "
        "spending the whole history on evaluation. To be measured against "
        "score stability in wave 6",
    status="PROVISIONAL",
)

BACKTEST_STEP = Setting(
    name="backtest.step_open_days",
    default=14,
    unit="open days between origins",
    owner="forecasting",
    why="provisional; origins closer than this share most of their horizon, so "
        "the windows stop being independent evidence and the score looks more "
        "certain than it is. To be measured in wave 6",
    status="PROVISIONAL",
)

BACKTEST_HORIZON = Setting(
    name="backtest.horizon_open_days",
    default=30,
    unit="open days",
    owner="forecasting",
    why="provisional; the reorder horizon the buy list actually works over. "
        "Scoring at a horizon nobody orders against would measure the wrong "
        "thing accurately. To be aligned with observed reorder cycles in wave 6",
    status="PROVISIONAL",
)

MIN_WINDOWS_PER_CLASS = Setting(
    name="backtest.min_windows_per_class",
    default=20,
    unit="scored windows",
    owner="forecasting",
    why="provisional; below this a class verdict is UNJUDGED rather than pass "
        "or fail. Declaring victory over seasonal-naive on three windows is "
        "how a model ships on noise. To be measured in wave 6",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class SkuHistory:
    """One store-SKU's full history, for evaluation. Supplied, never fetched."""

    sku: str
    calendar: Sequence[CalendarDay]
    facts: Sequence[DayFact]


@dataclass(frozen=True, slots=True)
class ClassScore:
    """How the ensemble did on one demand class, against seasonal-naive."""

    demand_class: str
    skus: int
    windows: int
    wape_pct: float | None
    mase: float | None
    pinball: float | None
    naive_wape_pct: float | None
    naive_mase: float | None
    naive_pinball: float | None
    refusals: int
    #: True/False when there are enough windows to judge; None when there are
    #: not. None is NOT a pass - see `BacktestReport.passed`.
    beats_naive: bool | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "demand_class": self.demand_class, "skus": self.skus,
            "windows": self.windows, "wape_pct": self.wape_pct,
            "mase": self.mase, "pinball": self.pinball,
            "naive_wape_pct": self.naive_wape_pct,
            "naive_mase": self.naive_mase, "naive_pinball": self.naive_pinball,
            "refusals": self.refusals, "beats_naive": self.beats_naive,
        }


@dataclass(frozen=True, slots=True)
class BacktestReport:
    """The verdict, per class and overall."""

    by_class: dict[str, ClassScore]
    #: Spearman rho between recent momentum and realised horizon demand.
    momentum_rho: float | None
    #: True only if EVERY judgeable class beat seasonal-naive.
    passed: bool
    failing_classes: tuple[str, ...]
    unjudged_classes: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "by_class": {k: v.as_dict() for k, v in self.by_class.items()},
            "momentum_rho": self.momentum_rho,
            "passed": self.passed,
            "failing_classes": list(self.failing_classes),
            "unjudged_classes": list(self.unjudged_classes),
        }

    def summary(self) -> str:
        header = (f"{'class':<14}{'skus':>6}{'win':>6}{'WAPE':>10}"
                  f"{'naiveWAPE':>11}{'MASE':>8}{'pinball':>10}"
                  f"{'naivePin':>10}{'verdict':>9}")
        lines = [header, "-" * len(header)]
        for name in DEMAND_CLASSES:
            score = self.by_class.get(name)
            if score is None or score.windows == 0:
                continue
            verdict = (
                "UNJUDGED" if score.beats_naive is None
                else ("BEATS" if score.beats_naive else "LOSES")
            )
            lines.append(
                f"{score.demand_class:<14}{score.skus:>6}{score.windows:>6}"
                f"{_fmt(score.wape_pct):>10}{_fmt(score.naive_wape_pct):>11}"
                f"{_fmt(score.mase):>8}{_fmt(score.pinball):>10}"
                f"{_fmt(score.naive_pinball):>10}{verdict:>9}"
            )
        lines.append("")
        lines.append(
            f"momentum rho = {_fmt(self.momentum_rho)}   "
            "(negative => chasing acceleration LOSES)"
        )
        lines.append(f"PASSED = {self.passed}")
        if self.failing_classes:
            lines.append(f"  FAILING: {', '.join(self.failing_classes)}")
        if self.unjudged_classes:
            lines.append(f"  unjudged (too few windows): "
                         f"{', '.join(self.unjudged_classes)}")
        return "\n".join(lines)


def _fmt(value: float | None) -> str:
    return "-" if value is None else f"{value:.3f}"


# ── Metrics ──────────────────────────────────────────────────────────────────


def pinball_loss(actual: float, predicted: float, q: float) -> float:
    """The loss a QUANTILE forecast is scored on.

    Asymmetric on purpose: at q=0.9, being under is penalised nine times as
    hard as being over, which is exactly the asymmetry a safety stock exists to
    buy. It is also the metric that makes intervals matter - a point forecast
    scored at p10 and p90 is penalised precisely for having no spread, where
    WAPE would not notice.
    """
    delta = actual - predicted
    return q * delta if delta >= 0 else (q - 1) * delta


def seasonal_naive_total(series: Sequence[float], horizon: int, period: int) -> float:
    """Tile the last complete season forward over the horizon.

    The baseline every class must beat. Seasonal rather than flat-naive because
    liquor has a hard weekly shape, and beating a baseline that ignores the
    weekend would be a win worth nothing.
    """
    period = max(1, period)
    if not series:
        return 0.0
    season = list(series[-period:])
    return sum(season[index % len(season)] for index in range(horizon))


def mase_denominator(series: Sequence[float], period: int) -> float | None:
    """Mean absolute in-sample seasonal-naive error. None when undefined.

    None rather than a small epsilon: a flat series has no naive error, so MASE
    is genuinely undefined there, and substituting a tiny denominator would
    manufacture a spectacular-looking score out of a division by almost zero.
    """
    period = max(1, period)
    if len(series) <= period:
        return None
    errors = [abs(series[i] - series[i - period]) for i in range(period, len(series))]
    mean_error = sum(errors) / len(errors) if errors else 0.0
    return mean_error if mean_error > 0 else None


def spearman(xs: Sequence[float], ys: Sequence[float]) -> float | None:
    """Rank correlation. None when either side is constant or too short.

    Rank-based rather than Pearson: momentum ratios have a long right tail, and
    a handful of SKUs that happened to triple would otherwise set the
    correlation on their own.
    """
    if len(xs) != len(ys) or len(xs) < 3:
        return None

    def ranks(values: Sequence[float]) -> list[float]:
        order = sorted(range(len(values)), key=lambda i: values[i])
        out = [0.0] * len(values)
        index = 0
        while index < len(order):
            stop = index
            while (stop + 1 < len(order)
                   and values[order[stop + 1]] == values[order[index]]):
                stop += 1
            shared = (index + stop) / 2 + 1
            for position in range(index, stop + 1):
                out[order[position]] = shared
            index = stop + 1
        return out

    rx, ry = ranks(xs), ranks(ys)
    mean_x = sum(rx) / len(rx)
    mean_y = sum(ry) / len(ry)
    cov = sum((a - mean_x) * (b - mean_y) for a, b in zip(rx, ry, strict=True))
    var_x = sum((a - mean_x) ** 2 for a in rx)
    var_y = sum((b - mean_y) ** 2 for b in ry)
    if var_x <= 0 or var_y <= 0:
        return None
    # math.sqrt rather than ** 0.5: the exponent form reads as a magic
    # constant to any reader and to the literal guard, and it is not one.
    return cov / math.sqrt(var_x * var_y)


# ── The rolling-origin evaluation ────────────────────────────────────────────


@dataclass
class _Accumulator:
    """Running sums for one demand class. Mutable by design; never returned."""

    skus: set[str]
    windows: int = 0
    abs_error: float = 0.0
    actual_total: float = 0.0
    naive_abs_error: float = 0.0
    scaled_error: float = 0.0
    naive_scaled_error: float = 0.0
    scaled_windows: int = 0
    pinball_total: float = 0.0
    naive_pinball_total: float = 0.0
    refusals: int = 0


def _open_day_units(
    history: SkuHistory, open_days: Sequence[date]
) -> list[float]:
    """Units per OPEN day, dense, in order. Zeros are real information."""
    by_day: dict[date, float] = {}
    for fact in history.facts:
        if fact.sku != history.sku:
            continue
        units = float(fact.units_sold or 0.0)
        if units > 0:
            by_day[fact.obs_date] = by_day.get(fact.obs_date, 0.0) + units
    return [by_day.get(day, 0.0) for day in open_days]


@stage("forecast_backtest", "1.0.0")
def backtest_by_class(
    histories: Sequence[SkuHistory],
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> StageResult:
    """Rolling-origin evaluation, scored separately for every demand class.

    At each origin the SKU is classified and forecast using ONLY the open days
    before that origin, then compared to what actually happened over the next
    `horizon` open days. Classifying on the full history would leak the future
    into the label and quietly flatter every score.
    """
    record_inputs("feature_daily.units_sold", "feature_store_day.was_open")

    origins = config.get(BACKTEST_ORIGINS, ctx)
    step = config.get(BACKTEST_STEP, ctx)
    horizon = config.get(BACKTEST_HORIZON, ctx)
    min_windows = config.get(MIN_WINDOWS_PER_CLASS, ctx)
    lower_q = config.get(LOWER_QUANTILE, ctx)
    upper_q = config.get(UPPER_QUANTILE, ctx)

    accumulators: dict[str, _Accumulator] = {
        name: _Accumulator(skus=set()) for name in DEMAND_CLASSES
    }
    momentum_values: list[float] = []
    realised_values: list[float] = []

    for history in histories:
        full_open = open_day_sequence(history.calendar, date.min, ctx.as_of)
        units = _open_day_units(history, full_open)
        period = _open_days_per_week(history.calendar, full_open)

        for origin_index in range(origins):
            # Origins walk BACKWARD from the most recent usable split.
            end = len(full_open) - origin_index * step
            split = end - horizon
            if split <= period * 2 or end > len(full_open):
                continue

            train_days = full_open[:split]
            train_units = units[:split]
            actual = sum(units[split:end])

            # THE ORIGIN'S OWN CONTEXT, not the run's.
            #
            # `classify` anchors its window to `ctx.as_of`. Passing the run's
            # as_of would make every origin look at a window ending TODAY -
            # i.e. classify each SKU using the very data the origin is about to
            # be tested on. The labels would be computed from the future, every
            # class would look better than it is, and nothing would fail.
            origin_ctx = dataclasses.replace(ctx, as_of=train_days[-1])
            label = classify(
                ClassifyRequest(
                    sku=history.sku,
                    calendar=history.calendar,
                    facts=[f for f in history.facts if f.obs_date <= train_days[-1]],
                    window_days=len(train_days),
                ),
                origin_ctx,
                config,
            ).value
            if label is None:
                continue

            result = forecast(
                ForecastRequest(
                    profile=label,
                    horizon_open_days=horizon,
                    series=train_units,
                    open_days_per_week=period,
                    cohort_level=(
                        sum(train_units) / len(train_units) if train_units else 0.0
                    ),
                ),
                origin_ctx,
                config,
            )

            acc = accumulators[label.demand_class]
            acc.skus.add(history.sku)
            # `ok` alone does not narrow `value`; a successful stage carrying a
            # None payload would fail much later, at the first attribute read.
            if not result.ok or result.value is None:
                # A refusal is recorded, never scored as a miss. Counting it as
                # error would penalise the honesty this sheet is asking for.
                acc.refusals += 1
                continue

            prediction = result.value
            naive = seasonal_naive_total(train_units, horizon, period)

            acc.windows += 1
            acc.actual_total += actual
            acc.abs_error += abs(actual - prediction.p50)
            acc.naive_abs_error += abs(actual - naive)

            scale = mase_denominator(train_units, period)
            if scale:
                acc.scaled_windows += 1
                acc.scaled_error += abs(actual - prediction.p50) / (scale * horizon)
                acc.naive_scaled_error += abs(actual - naive) / (scale * horizon)

            acc.pinball_total += (
                pinball_loss(actual, prediction.p10, lower_q)
                + pinball_loss(actual, prediction.p50, _median_quantile(lower_q, upper_q))
                + pinball_loss(actual, prediction.p90, upper_q)
            )
            # The baseline has no interval, so the same point is scored at all
            # three levels. That is not a handicap - it is what "no interval"
            # costs, and pinball is the metric that charges for it.
            acc.naive_pinball_total += (
                pinball_loss(actual, naive, lower_q)
                + pinball_loss(actual, naive, _median_quantile(lower_q, upper_q))
                + pinball_loss(actual, naive, upper_q)
            )

            momentum_values.append(_momentum(train_units, horizon))
            realised_values.append(actual)

    by_class = {
        name: _score(name, acc, min_windows)
        for name, acc in accumulators.items()
    }
    passed, failing, unjudged = verdict(by_class)
    report = BacktestReport(
        by_class=by_class,
        momentum_rho=spearman(momentum_values, realised_values),
        passed=passed,
        failing_classes=failing,
        unjudged_classes=unjudged,
    )
    return StageResult.success(
        report,
        Provenance(
            own_observations=sum(a.windows for a in accumulators.values()),
            own_weight=1.0,
            evidence_state="ESTABLISHED",
            inputs=("feature_daily.units_sold", "feature_store_day.was_open"),
        ),
    )


def verdict(
    by_class: dict[str, ClassScore],
) -> tuple[bool, tuple[str, ...], tuple[str, ...]]:
    """Pass only if EVERY judgeable class beat seasonal-naive.

    THE RULE THIS SHEET TURNS ON. An ensemble that wins on average while
    losing on intermittent SKUs has failed - intermittent is the majority of
    the catalogue, and a mean over SKUs is dominated by the smooth minority
    that sell every day and carry most of the volume. Averaging would let a
    model that is worse for most products be reported as an improvement.

    A class with too few windows is UNJUDGED, and unjudged is not a pass: it
    means we do not know, and "we do not know" must not read as "fine".
    """
    failing = tuple(
        name for name, score in by_class.items() if score.beats_naive is False
    )
    unjudged = tuple(
        name for name, score in by_class.items()
        if score.beats_naive is None and score.windows > 0 and name != NEW_SKU
    )
    # `any` as well as `not failing`: a report where nothing was judged at all
    # has proven nothing, and must not pass by vacuous truth.
    passed = not failing and any(
        score.beats_naive for score in by_class.values()
    )
    return passed, failing, unjudged


def _median_quantile(lower: float, upper: float) -> float:
    """The midpoint of the stated interval — p50 without writing 0.5.

    Derived rather than declared so that the three pinball levels cannot drift
    apart from the interval the stage actually returns.
    """
    return (lower + upper) / 2


def _open_days_per_week(
    calendar: Sequence[CalendarDay], open_days: Sequence[date]
) -> int:
    """The store's seasonal period, MEASURED rather than assumed to be 7.

    A store shut Sundays has a six-open-day week, and forcing a period of 7
    onto its open-day series would rotate the weekend through the seasonal
    indices until they averaged each other out.
    """
    if not open_days:
        return 7
    distinct_weekdays = len({day.weekday() for day in open_days})
    return max(1, distinct_weekdays)


def _momentum(train_units: Sequence[float], horizon: int) -> float:
    """Recent rate over prior rate — the thing that anti-predicts.

    Computed here ONLY so the backtest can report its correlation with what
    actually happened. It is never fed to a forecaster.
    """
    if len(train_units) < horizon * 2:
        return 1.0
    recent = sum(train_units[-horizon:]) / horizon
    prior = sum(train_units[-horizon * 2:-horizon]) / horizon
    if prior <= 0:
        return 1.0 if recent <= 0 else float(horizon)
    return recent / prior


def _score(name: str, acc: _Accumulator, min_windows: int) -> ClassScore:
    wape = (
        PERCENT_SCALE * acc.abs_error / acc.actual_total
        if acc.actual_total > 0 else None
    )
    naive_wape = (
        PERCENT_SCALE * acc.naive_abs_error / acc.actual_total
        if acc.actual_total > 0 else None
    )
    mase = acc.scaled_error / acc.scaled_windows if acc.scaled_windows else None
    naive_mase = (
        acc.naive_scaled_error / acc.scaled_windows if acc.scaled_windows else None
    )
    pinball = acc.pinball_total / acc.windows if acc.windows else None
    naive_pinball = (
        acc.naive_pinball_total / acc.windows if acc.windows else None
    )

    # UNJUDGED unless there is enough evidence AND both numbers exist.
    beats: bool | None = None
    if acc.windows >= min_windows and wape is not None and naive_wape is not None:
        beats = wape < naive_wape

    return ClassScore(
        demand_class=name,
        skus=len(acc.skus),
        windows=acc.windows,
        wape_pct=wape,
        mase=mase,
        pinball=pinball,
        naive_wape_pct=naive_wape,
        naive_mase=naive_mase,
        naive_pinball=naive_pinball,
        refusals=acc.refusals,
        beats_naive=beats,
    )


__all__ = [
    "BACKTEST_HORIZON",
    "BACKTEST_ORIGINS",
    "BACKTEST_STEP",
    "MIN_WINDOWS_PER_CLASS",
    "BacktestReport",
    "ClassScore",
    "SkuHistory",
    "backtest_by_class",
    "backtest_daily",
    "mase_denominator",
    "pinball_loss",
    "seasonal_naive_total",
    "spearman",
    "verdict",
]
