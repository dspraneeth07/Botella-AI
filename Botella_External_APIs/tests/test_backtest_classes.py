"""Sheet 07 PR 3 — rolling-origin backtest, scored per demand class."""

from __future__ import annotations

import random
from datetime import date, timedelta

import pytest

from app.pipeline.context import RunContext
from app.pipeline.features.store import CalendarDay, DayFact
from storeagent.forecasting.backtest import (
    MIN_WINDOWS_PER_CLASS,
    BacktestReport,
    ClassScore,
    SkuHistory,
    backtest_by_class,
    backtest_daily,
    mase_denominator,
    pinball_loss,
    seasonal_naive_total,
    spearman,
    verdict,
)
from storeagent.forecasting.classify import (
    ERRATIC,
    INTERMITTENT,
    LUMPY,
    SMOOTH,
)

AS_OF = date(2026, 9, 22)
DAYS = 560


def ctx(**over) -> RunContext:
    base = {
        "run_id": "bt", "tenant_id": 1, "store_id": 1, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"forecast": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def calendar(days: int = DAYS) -> list[CalendarDay]:
    return [CalendarDay(AS_OF - timedelta(days=i), True, True) for i in range(days)]


def history(sku: str, step: int, choices: list[float], seed: str) -> SkuHistory:
    rng = random.Random(seed)
    return SkuHistory(
        sku=sku,
        calendar=calendar(),
        facts=[
            DayFact(obs_date=AS_OF - timedelta(days=i), sku=sku,
                    units_sold=rng.choice(choices), price=10.0)
            for i in range(0, DAYS, step)
        ],
    )


def estate() -> list[SkuHistory]:
    """A miniature catalogue with all four shapes in it."""
    out: list[SkuHistory] = []
    for k in range(12):
        out.append(history(f"sm{k}", 1, [3.0, 4.0, 5.0, 6.0], f"sm{k}"))
        out.append(history(f"it{k}", 5, [2.0, 3.0], f"it{k}"))
        out.append(history(f"er{k}", 1, [1.0, 2.0, 25.0, 40.0], f"er{k}"))
        out.append(history(f"lu{k}", 22, [1.0, 2.0, 3.0, 120.0], f"lu{k}"))
    return out


def _score(name: str, *, wape: float | None, naive: float | None,
           windows: int, beats: bool | None) -> ClassScore:
    return ClassScore(
        demand_class=name, skus=10, windows=windows, wape_pct=wape,
        mase=None, pinball=None, naive_wape_pct=naive, naive_mase=None,
        naive_pinball=None, refusals=0, beats_naive=beats,
    )


# ── The rule the sheet turns on ──────────────────────────────────────────────


def test_losing_on_intermittent_fails_the_report_even_if_the_average_wins() -> None:
    """'An ensemble that wins on average while losing on intermittent SKUs has
    FAILED' — intermittent is the majority of the catalogue.

    Here smooth wins by a mile and intermittent loses narrowly. The mean WAPE
    across the two is comfortably better than naive, and that is exactly the
    summary that would have let this ship.
    """
    by_class = {
        SMOOTH: _score(SMOOTH, wape=5.0, naive=40.0, windows=100, beats=True),
        INTERMITTENT: _score(INTERMITTENT, wape=31.0, naive=30.0,
                             windows=100, beats=False),
    }
    mean_ours = (5.0 + 31.0) / 2
    mean_naive = (40.0 + 30.0) / 2
    assert mean_ours < mean_naive, "on average it looks like a win"

    passed, failing, _ = verdict(by_class)
    assert passed is False, "but one failing class fails the report"
    assert failing == (INTERMITTENT,)


def test_a_class_with_too_few_windows_is_unjudged_and_unjudged_is_not_a_pass() -> None:
    by_class = {
        SMOOTH: _score(SMOOTH, wape=5.0, naive=9.0, windows=100, beats=True),
        LUMPY: _score(LUMPY, wape=150.0, naive=140.0, windows=3, beats=None),
    }
    passed, failing, unjudged = verdict(by_class)
    assert failing == ()
    assert unjudged == (LUMPY,)
    assert passed is True, "an unjudged class does not fail the report..."

    # ...but a report where NOTHING was judged proves nothing.
    nothing = {LUMPY: _score(LUMPY, wape=None, naive=None, windows=3, beats=None)}
    passed_nothing, _, _ = verdict(nothing)
    assert passed_nothing is False, "no verdict must not pass by vacuous truth"


def test_the_minimum_window_count_comes_from_the_registry() -> None:
    assert MIN_WINDOWS_PER_CLASS.default == 20
    assert "noise" in MIN_WINDOWS_PER_CLASS.why


# ── The real run ─────────────────────────────────────────────────────────────


def test_every_class_is_scored_separately_and_beats_seasonal_naive() -> None:
    """Sheet 07's 'done when': beats seasonal-naive PER class, reported
    separately."""
    result = backtest_by_class(estate(), ctx())
    assert result.ok, result.reasons
    report = result.value
    assert isinstance(report, BacktestReport)

    for name in (SMOOTH, INTERMITTENT, ERRATIC):
        score = report.by_class[name]
        assert score.windows > 0, name
        assert score.wape_pct is not None and score.naive_wape_pct is not None
        assert score.beats_naive is True, (
            f"{name}: WAPE {score.wape_pct:.1f} vs naive "
            f"{score.naive_wape_pct:.1f}"
        )

    assert report.passed is True
    assert report.failing_classes == ()


def test_the_biggest_win_is_on_the_intermittent_majority() -> None:
    """The class the old single-method forecaster served worst.

    This is the sheet's whole premise: one approach applied to everything
    serves the intermittent majority worst, and that is most of the catalogue.
    """
    report = backtest_by_class(estate(), ctx()).value
    intermittent = report.by_class[INTERMITTENT]
    improvement = intermittent.naive_wape_pct - intermittent.wape_pct
    smooth = report.by_class[SMOOTH]
    assert improvement > (smooth.naive_wape_pct - smooth.wape_pct)


def test_refusals_are_counted_and_never_scored_as_misses() -> None:
    """Refusing must not be punished, or the model learns to guess.

    A lumpy SKU whose interval is unusable returns ok=False. Counting that as
    error would make the honest answer score worse than a confident wrong one.
    """
    report = backtest_by_class(estate(), ctx()).value
    lumpy = report.by_class[LUMPY]
    assert lumpy.refusals > 0, "the lumpy fixture should trigger refusals"
    assert lumpy.windows < lumpy.refusals + lumpy.windows
    assert lumpy.skus > 0, "the SKUs are still counted as seen"


def test_the_report_names_which_classes_failed_not_just_that_it_failed() -> None:
    report = backtest_by_class(estate(), ctx()).value
    text = report.summary()
    assert "WAPE" in text and "naiveWAPE" in text and "pinball" in text
    assert "PASSED" in text
    for name in (SMOOTH, INTERMITTENT, ERRATIC):
        assert name in text


# ── Momentum is measured, not assumed ────────────────────────────────────────


def test_momentum_correlation_is_reported_and_is_not_positive() -> None:
    """The 23%-vs-32% failure, re-measured on this data rather than recalled.

    The sheet's figure is rho = -0.36 at 60 days. This fixture is synthetic and
    stationary, so the expected value here is ~0; what matters is that the
    number is REPORTED, so a future run on real data cannot quietly rely on
    momentum without somebody seeing the correlation that justifies it.
    """
    report = backtest_by_class(estate(), ctx()).value
    assert report.momentum_rho is not None
    assert report.momentum_rho < 0.2, (
        "momentum should not predict; a solidly positive rho is a signal to "
        "re-examine, not a discovery"
    )
    assert "momentum rho" in report.summary()


# ── No leakage ───────────────────────────────────────────────────────────────


def test_each_origin_classifies_on_its_own_history_not_the_full_one() -> None:
    """The leak that would have flattered every score.

    `classify` anchors its window to ctx.as_of. Passing the RUN's as_of at
    every origin would classify each SKU using the very data the origin is
    about to be tested on. The bug is invisible in the output - every class
    simply looks better - so it is asserted structurally instead: truncating
    the history must change the answer.
    """
    full = estate()[:8]
    truncated = [
        SkuHistory(h.sku, h.calendar,
                   [f for f in h.facts if f.obs_date <= AS_OF - timedelta(days=120)])
        for h in full
    ]
    a = backtest_by_class(full, ctx()).value
    b = backtest_by_class(truncated, ctx()).value
    assert a.by_class[SMOOTH].wape_pct != b.by_class[SMOOTH].wape_pct, (
        "removing the most recent 120 days changed nothing - the backtest is "
        "reading data it should not have"
    )


# ── Metrics ──────────────────────────────────────────────────────────────────


def test_pinball_loss_is_asymmetric_in_the_direction_safety_stock_cares_about() -> None:
    # At p90, being UNDER should hurt far more than being over.
    under = pinball_loss(actual=100.0, predicted=50.0, q=0.9)
    over = pinball_loss(actual=50.0, predicted=100.0, q=0.9)
    assert under == pytest.approx(45.0)
    assert over == pytest.approx(5.0)
    assert under > over
    # At p10 the asymmetry reverses.
    assert pinball_loss(100.0, 50.0, 0.1) < pinball_loss(50.0, 100.0, 0.1)
    # A perfect forecast costs nothing at any quantile.
    for q in (0.1, 0.5, 0.9):
        assert pinball_loss(42.0, 42.0, q) == pytest.approx(0.0)


def test_a_point_forecast_is_penalised_for_having_no_spread() -> None:
    """Why pinball and not WAPE decides whether intervals were worth it."""
    actual = 100.0
    point_only = sum(pinball_loss(actual, 60.0, q) for q in (0.1, 0.5, 0.9))
    with_interval = (
        pinball_loss(actual, 20.0, 0.1)
        + pinball_loss(actual, 60.0, 0.5)
        + pinball_loss(actual, 110.0, 0.9)
    )
    assert with_interval < point_only


def test_seasonal_naive_tiles_the_last_complete_season() -> None:
    series = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]
    assert seasonal_naive_total(series, 7, 7) == pytest.approx(28.0)
    assert seasonal_naive_total(series, 14, 7) == pytest.approx(56.0)
    # A three-day horizon takes the first three of the tiled season.
    assert seasonal_naive_total(series, 3, 7) == pytest.approx(6.0)
    assert seasonal_naive_total([], 7, 7) == 0.0


def test_mase_is_undefined_rather_than_enormous_on_a_flat_series() -> None:
    """A tiny denominator would manufacture a spectacular score."""
    assert mase_denominator([5.0] * 30, 7) is None
    assert mase_denominator([1.0, 2.0], 7) is None
    varied = mase_denominator([1.0, 5.0] * 15, 7)
    assert varied is not None and varied > 0


def test_spearman_ranks_rather_than_letting_one_outlier_decide() -> None:
    rising = [1.0, 2.0, 3.0, 4.0, 5.0]
    assert spearman(rising, [10.0, 20.0, 30.0, 40.0, 50.0]) == pytest.approx(1.0)
    assert spearman(rising, [50.0, 40.0, 30.0, 20.0, 10.0]) == pytest.approx(-1.0)
    # One wild value cannot flip a rank correlation.
    assert spearman(rising, [10.0, 20.0, 30.0, 40.0, 1e9]) == pytest.approx(1.0)
    assert spearman([1.0, 1.0, 1.0], [1.0, 2.0, 3.0]) is None
    assert spearman([1.0, 2.0], [1.0, 2.0]) is None


# ── The existing store-level backtest is untouched ───────────────────────────


def test_the_original_store_level_backtest_still_works() -> None:
    """Sheet 07 EXTENDS this file. `storeagent/runtime/pipeline.py` calls it."""
    daily = [(AS_OF - timedelta(days=i), float(20 + i % 7)) for i in range(400)]
    out = backtest_daily(daily, AS_OF)
    assert out["test_days"] > 0
    assert out["wape_pct"] is not None
    assert out["accuracy_pct"] is not None
