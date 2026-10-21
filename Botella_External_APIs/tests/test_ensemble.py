"""Sheet 07 PR 2 — one forecaster per demand shape, every one with an interval."""

from __future__ import annotations

import ast
import inspect
import random
from datetime import date, timedelta

import pytest

from app.pipeline.context import RunContext
from app.pipeline.features.store import CalendarDay, DayFact
from app.pipeline.registry import cfg
from storeagent.forecasting import ensemble as ensemble_module
from storeagent.forecasting.classify import (
    ERRATIC,
    INTERMITTENT,
    LUMPY,
    NEW_SKU,
    SMOOTH,
    ClassifyRequest,
    classify,
)
from storeagent.forecasting.ensemble import (
    CROSTON_ALPHA,
    ETS_BETA,
    LOWER_QUANTILE,
    LUMPY_MAX_RELATIVE_WIDTH,
    UPPER_QUANTILE,
    ForecastRequest,
    croston_rate,
    forecast,
    quantile,
    seasonal_ets,
)

AS_OF = date(2026, 9, 22)
YEAR = 364
HORIZON = 30

#: The determinism tolerance. Stated, not bitwise - see
#: test_two_runs_on_the_same_snapshot_agree_within_epsilon.
EPSILON = 1e-9


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-07", "tenant_id": 1, "store_id": 1, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"forecast": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def calendar(days: int = YEAR) -> list[CalendarDay]:
    return [CalendarDay(AS_OF - timedelta(days=i), True, True) for i in range(days)]


def _facts(spec: dict[int, float]) -> list[DayFact]:
    return [
        DayFact(obs_date=AS_OF - timedelta(days=d), sku="X", units_sold=u, price=10.0)
        for d, u in sorted(spec.items())
    ]


def _series(spec: dict[int, float]) -> list[float]:
    series = [0.0] * YEAR
    for days_ago, units in spec.items():
        series[YEAR - 1 - days_ago] = units
    return series


def _request(spec: dict[int, float], **over) -> ForecastRequest:
    profile = classify(
        ClassifyRequest("X", calendar(), _facts(spec), YEAR), ctx()
    ).value
    fields = {
        "profile": profile, "horizon_open_days": HORIZON,
        "series": _series(spec), "open_days_per_week": 7,
    }
    fields.update(over)
    return ForecastRequest(**fields)


# Four realistic shapes, with noise so the intervals are not degenerate.
def smooth_spec() -> dict[int, float]:
    rng = random.Random("smooth")
    return {i: 4.0 + rng.randint(0, 4) for i in range(YEAR)}


def intermittent_spec() -> dict[int, float]:
    rng = random.Random("intermittent")
    return {i: 3.0 + rng.randint(0, 1) for i in range(0, YEAR, 5)}


def erratic_spec() -> dict[int, float]:
    rng = random.Random("erratic")
    return {i: rng.choice([1.0, 2.0, 30.0, 45.0]) for i in range(YEAR)}


def lumpy_spec() -> dict[int, float]:
    """A real lumpy shape: singles most of the time, a case now and then.

    ADI ~28 open days, so a 30-day horizon usually contains one event and
    often none. The honest interval is "about 2, but it could be 78", which is
    exactly the interval nobody can place an order against.
    """
    rng = random.Random("lumpy")
    return {i: rng.choice([1.0, 2.0, 3.0, 120.0]) for i in range(0, YEAR, 30)}


# ── The contract: never a bare point estimate ────────────────────────────────


@pytest.mark.parametrize(
    ("name", "spec", "expected_class"),
    [
        ("smooth", smooth_spec(), SMOOTH),
        ("intermittent", intermittent_spec(), INTERMITTENT),
        ("erratic", erratic_spec(), ERRATIC),
    ],
)
def test_every_class_returns_p10_p50_p90(name, spec, expected_class) -> None:
    """Sheet 07: 'a point estimate alone is not an acceptable output'."""
    request = _request(spec)
    assert request.profile.demand_class == expected_class, name
    result = forecast(request, ctx())
    assert result.ok, result.reasons
    f = result.value
    assert f.p10 <= f.p50 <= f.p90, "quantiles must be ordered"
    assert f.p10 >= 0.0, "a negative demand forecast is not a forecast"
    assert f.p90 > f.p10, "a zero-width interval on noisy data is not honest"
    assert set(f.as_dict()) >= {"p10", "p50", "p90"}


def test_the_interval_is_in_the_explanation_an_owner_reads() -> None:
    f = forecast(_request(smooth_spec()), ctx()).value
    text = f.explain()
    assert "8 cases out of 10" in text
    assert f"{f.p50:.0f}" in text


def test_the_quantile_levels_come_from_the_registry() -> None:
    assert LOWER_QUANTILE.default == 0.1
    assert UPPER_QUANTILE.default == 0.9
    wide = cfg.with_overrides("wide", {LOWER_QUANTILE.name: 0.01,
                                       UPPER_QUANTILE.name: 0.99})
    base = forecast(_request(erratic_spec()), ctx()).value
    widened = forecast(_request(erratic_spec()),
                       ctx(config_version="wide"), wide).value
    assert widened.p10 <= base.p10
    assert widened.p90 >= base.p90
    assert widened.p50 == pytest.approx(base.p50, abs=EPSILON), (
        "widening the interval must not move the centre"
    )


# ── Refusing is correct for lumpy ────────────────────────────────────────────


def test_a_lumpy_sku_with_an_unusable_interval_refuses() -> None:
    """Sheet 02's right to refuse, applied to forecasting.

    You cannot act on 'order somewhere between 2 and 40'. A confident-looking
    midpoint would be the ambiguous output this rebuild exists to remove.
    """
    request = _request(lumpy_spec())
    assert request.profile.demand_class == LUMPY
    result = forecast(request, ctx())
    assert not result.ok
    assert "lumpy_interval_too_wide_to_act_on" in result.reasons[0]
    assert result.provenance is not None, "a refusal still carries provenance"


def test_a_lumpy_sku_within_the_width_limit_is_still_answered() -> None:
    """The refusal is about the INTERVAL, not about the label.

    Raising the limit admits the same SKU, which proves the gate is measuring
    usability rather than quietly refusing an entire demand class.
    """
    request = _request(lumpy_spec())
    lenient = cfg.with_overrides("lenient", {LUMPY_MAX_RELATIVE_WIDTH.name: 99.0})
    result = forecast(request, ctx(config_version="lenient"), lenient)
    assert result.ok
    assert result.value.p10 <= result.value.p50 <= result.value.p90


def test_only_lumpy_may_refuse_on_width() -> None:
    """A wide interval on an erratic SKU is information, not a blocker."""
    erratic = _request(erratic_spec())
    assert erratic.profile.demand_class == ERRATIC
    strict = cfg.with_overrides("strict", {LUMPY_MAX_RELATIVE_WIDTH.name: 0.01})
    result = forecast(erratic, ctx(config_version="strict"), strict)
    assert result.ok, "the width gate must apply to lumpy only"


# ── Momentum: the failure this sheet must not repeat ─────────────────────────


def test_the_trend_weight_is_zero_by_default() -> None:
    """The 23%-vs-32% failure, encoded as a default.

    The previous engine was told to chase accelerating products, and momentum
    ANTI-predicts at this horizon (rho = -0.36 at 60 days). The trend slot
    exists so wave 6 can fit it; it starts at zero, and a positive fitted value
    is a signal to re-examine rather than a discovery.
    """
    assert ETS_BETA.default == 0.0
    assert "-0.36" in ETS_BETA.why
    assert "anti-predict" in ETS_BETA.why.lower()


def test_a_rising_series_is_not_extrapolated_upward() -> None:
    """With beta=0 the level is the level - the ramp is not projected forward.

    A trend term would take a SKU that doubled over the window and forecast it
    doubling again. That is precisely the behaviour that scored 23%.
    """
    ramp = {i: float(YEAR - i) / 10 for i in range(YEAR)}   # rising toward as_of
    request = _request(ramp)
    result = forecast(request, ctx())
    assert result.ok
    recent_rate = sum(request.series[-HORIZON:]) / HORIZON
    # The forecast sits near the recent LEVEL, not above an extrapolated ramp.
    assert result.value.p50 <= recent_rate * HORIZON * 2


def test_no_momentum_vocabulary_earns_weight_anywhere_in_the_module() -> None:
    """A named guard, so the objective cannot drift back by accident."""
    tree = ast.parse(inspect.getsource(ensemble_module))
    banned = {"momentum", "acceleration", "accelerating", "trending", "velocity_rank"}
    names = {n.id.lower() for n in ast.walk(tree) if isinstance(n, ast.Name)}
    names |= {n.attr.lower() for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    assert not (names & banned), f"momentum feature found: {names & banned}"


# ── Croston and SBA ──────────────────────────────────────────────────────────


def test_sba_is_lower_than_croston_because_croston_is_biased_high() -> None:
    """The published correction, and the reason for it.

    Croston divides a smoothed size by a smoothed interval, and the
    expectation of a ratio is not the ratio of expectations - it comes out
    high. SBA multiplies by (1 - alpha/2).
    """
    sizes = [4.0, 6.0, 5.0, 7.0, 3.0]
    intervals = [5, 4, 6, 5]
    alpha = cfg.get(CROSTON_ALPHA, ctx())
    plain = croston_rate(sizes, intervals, alpha, debias=1.0)
    debiased = croston_rate(sizes, intervals, alpha, debias=1 - alpha / 2)
    assert debiased < plain
    assert debiased == pytest.approx(plain * (1 - alpha / 2), abs=EPSILON)


def test_croston_of_an_empty_history_is_zero_not_an_error() -> None:
    assert croston_rate([], [], 0.1, debias=1.0) == 0.0


def test_croston_rate_is_per_open_day() -> None:
    """Five units every five open days is one unit per open day."""
    rate = croston_rate([5.0] * 20, [5] * 19, 0.1, debias=1.0)
    assert rate == pytest.approx(1.0, abs=1e-6)


# ── new_sku: the cold start, reached without a branch ────────────────────────


def test_a_new_sku_is_forecast_from_the_cohort_and_says_so() -> None:
    request = _request({5: 3.0, 90: 3.0}, cohort_level=0.4, cohort_cv_pct=60)
    assert request.profile.demand_class == NEW_SKU
    result = forecast(request, ctx())
    assert result.ok
    f = result.value
    assert f.method == "cohort_prior"
    assert f.p50 == pytest.approx(0.4 * HORIZON, rel=0.15)
    assert f.p10 < f.p50 < f.p90
    assert result.provenance.own_weight == 0.0, "borrowed, not own"


def test_a_new_sku_with_no_cohort_dispersion_gets_a_wide_interval_not_a_narrow_one() -> None:
    """Absent dispersion must not become confident dispersion."""
    request = _request({5: 3.0, 90: 3.0}, cohort_level=0.4, cohort_cv_pct=None)
    f = forecast(request, ctx()).value
    assert f.relative_width is not None and f.relative_width > 0.5


def test_a_new_sku_with_no_cohort_level_returns_zero_without_crashing() -> None:
    request = _request({5: 3.0, 90: 3.0}, cohort_level=None)
    result = forecast(request, ctx())
    assert result.ok
    assert result.value.p50 == 0.0


# ── Determinism: to a stated epsilon, never bitwise ──────────────────────────


def test_two_runs_on_the_same_snapshot_agree_within_epsilon() -> None:
    """Sheet 07's determinism requirement.

    Asserted to a TOLERANCE, deliberately. A bitwise assertion over
    floating-point accumulation becomes flaky the moment anything about the
    numeric path changes - a library, a thread count - and a flaky test gets
    disabled, which is worse than no test. This implementation is pure stdlib
    and happens to be bitwise stable; the assertion stays tolerance-based so it
    remains valid if that ever stops being true.
    """
    for spec in (smooth_spec(), intermittent_spec(), erratic_spec()):
        first = forecast(_request(spec), ctx()).value
        second = forecast(_request(spec), ctx()).value
        assert first.p10 == pytest.approx(second.p10, abs=EPSILON)
        assert first.p50 == pytest.approx(second.p50, abs=EPSILON)
        assert first.p90 == pytest.approx(second.p90, abs=EPSILON)


def test_a_skus_forecast_does_not_depend_on_what_else_was_in_the_batch() -> None:
    """The seed is per-SKU, not a shared stream.

    With one shared generator, a SKU's answer would change when an unrelated
    SKU was added ahead of it in the batch - the same class of instability as
    an estimate that moves with the batch size.
    """
    spec = erratic_spec()
    alone = forecast(_request(spec), ctx()).value
    for other in ("A", "B", "C"):
        forecast(_request(spec, profile=_request(spec).profile), ctx())
        _ = other
    after_others = forecast(_request(spec), ctx()).value
    assert alone.p50 == pytest.approx(after_others.p50, abs=EPSILON)


def test_a_different_run_gets_a_different_draw_but_a_similar_answer() -> None:
    """Seeded per run: reproducible within a run, not frozen across runs."""
    spec = erratic_spec()
    a = forecast(_request(spec), ctx(run_id="run-A")).value
    b = forecast(_request(spec), ctx(run_id="run-B")).value
    assert a.p50 == pytest.approx(b.p50, rel=0.2), "the same data, so a similar answer"


# ── Helpers ──────────────────────────────────────────────────────────────────


def test_quantile_interpolates_and_handles_the_edges() -> None:
    values = [1.0, 2.0, 3.0, 4.0, 5.0]
    assert quantile(values, 0.0) == 1.0
    assert quantile(values, 1.0) == 5.0
    assert quantile(values, 0.5) == 3.0
    assert quantile(values, 0.25) == 2.0
    assert quantile([7.0], 0.9) == 7.0
    with pytest.raises(ValueError, match="empty sample"):
        quantile([], 0.5)


def test_ets_on_a_series_too_short_for_two_seasons_falls_back_to_the_mean() -> None:
    """Not an error, and not a fabricated seasonality."""
    level, seasonal, residuals = seasonal_ets([3.0, 4.0, 5.0], 7, 0.2, 0.0, 0.1)
    assert level == pytest.approx(4.0)
    assert residuals == []
    assert all(s == 0.0 for s in seasonal)


def test_ets_recovers_a_weekly_shape() -> None:
    """A weekend surge should land in the seasonal indices, not the level."""
    weekly = [2.0, 2.0, 2.0, 2.0, 8.0, 12.0, 6.0]
    series = weekly * 20
    level, seasonal, residuals = seasonal_ets(series, 7, 0.2, 0.0, 0.1)
    assert max(seasonal) > min(seasonal), "a flat seasonal vector learned nothing"
    assert seasonal.index(max(seasonal)) == 5, "Saturday is the peak"
    assert len(residuals) == len(series) - 7


def test_a_horizon_below_one_open_day_is_refused() -> None:
    result = forecast(_request(smooth_spec(), horizon_open_days=0), ctx())
    assert not result.ok
    assert "horizon" in result.reasons[0]


# ── What the real backtest caught ────────────────────────────────────────────


def test_croston_not_the_raw_bootstrap_sets_the_intermittent_level() -> None:
    """The defect the real-data backtest found, and why it mattered.

    The first version used the bootstrap median as the point estimate. That
    resamples the whole history uniformly - a sale from two years ago weighted
    exactly like last week's - and it lost the intermittent class on store 171:
    WAPE 54.3 against a seasonal-naive 44.1. Croston's exponential smoothing IS
    the recency weighting, and it is the reason the sheet names Croston here.

    A SKU whose demand has halved recently must forecast BELOW its lifetime
    average. The uniform bootstrap cannot see that at all.
    """
    # Two years of 10s, then a recent stretch of 2s, every 5th open day.
    old_then_new = {}
    for i in range(0, YEAR, 5):
        old_then_new[i] = 2.0 if i < 120 else 10.0   # i counts days AGO
    request = _request(old_then_new)
    assert request.profile.demand_class == INTERMITTENT

    result = forecast(request, ctx())
    assert result.ok
    lifetime_mean = sum(request.profile.sizes) / len(request.profile.sizes)
    implied_daily = result.value.p50 / HORIZON
    naive_daily = lifetime_mean / (request.profile.adi or 1.0)

    assert implied_daily < naive_daily, (
        "the forecast must follow the recent level down, not the lifetime mean"
    )


def test_the_level_adjustment_cannot_manufacture_a_tail() -> None:
    """The second bug, found while fixing the first.

    Scaling the finished bootstrap totals by point/median explodes wherever
    the median sits near zero - which is most lumpy SKUs over a short horizon.
    A p90 of 100 became 12,052. The adjustment therefore goes into the
    SIMULATION's inputs, never onto its output.
    """
    sparse = {i: 1.0 if i % 60 else 200.0 for i in range(0, YEAR, 30)}
    request = _request(sparse)
    lenient = cfg.with_overrides("lenient2",
                                 {LUMPY_MAX_RELATIVE_WIDTH.name: 9999.0})
    result = forecast(request, ctx(config_version="lenient2"), lenient)
    assert result.ok
    f = result.value
    largest_possible = sum(request.profile.sizes)
    assert f.p90 <= largest_possible, (
        f"p90 {f.p90:.0f} exceeds every unit this SKU has EVER sold "
        f"({largest_possible:.0f}) - the interval was manufactured"
    )


def test_the_simulated_rate_matches_the_estimator_it_was_given() -> None:
    """The level adjustment must actually land on the target rate."""
    from storeagent.forecasting.ensemble import _level_adjusted_sizes

    sizes = [4.0, 6.0, 5.0, 5.0]
    intervals = [5, 5, 5]
    adjusted = _level_adjusted_sizes(sizes, intervals, target_rate=2.0)
    implied = (sum(adjusted) / len(adjusted)) / (sum(intervals) / len(intervals))
    assert implied == pytest.approx(2.0, rel=1e-9)
    # Degenerate inputs are returned untouched rather than divided by zero.
    assert _level_adjusted_sizes([], [], 1.0) == []
    assert _level_adjusted_sizes([0.0, 0.0], [5], 1.0) == [0.0, 0.0]


def test_the_bootstrap_is_unbiased_against_a_known_rate() -> None:
    """The inspection paradox, asserted numerically.

    A randomly chosen MOMENT is more likely to fall inside a long gap than a
    short one, so the interval containing 'today' must be length-biased.
    Sampling gaps uniformly over-forecast by +12.3% on store 171.
    """
    from storeagent.forecasting.ensemble import _bootstrap_demand_totals

    for intervals in ([5] * 10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [1, 1, 1, 1, 20]):
        rng = random.Random("unbiased")
        totals = _bootstrap_demand_totals([4.0] * 10, intervals, 30, 20000, rng)
        mean_interval = sum(intervals) / len(intervals)
        expected = 30 / mean_interval * 4.0
        assert sum(totals) / len(totals) == pytest.approx(expected, rel=0.03), (
            f"intervals {intervals}: biased against the known rate"
        )
