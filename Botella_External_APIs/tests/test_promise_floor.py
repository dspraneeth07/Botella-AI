"""The promise, in the only form the arithmetic permits.

N1.1 asked for a promise at a low quantile. It comes in two shapes, and only one
is possible for this engine's candidates:

    on the INCREMENT  "at least N units MORE than your current rate"  - REFUTED
    on the TOTAL      "at least N units will sell"                    - holds 95.5%

These tests pin the refutation's arithmetic, so the next reader does not go
looking for a per-class fit that cannot exist, and they pin the floor that does
work.
"""

from __future__ import annotations

import math
from datetime import date

import pytest

from app.pipeline.blend.promise_floor import (
    MIN_FLOOR_UNITS,
    FloorRefused,
    PromiseFloor,
    increment_promise_basis,
    promise_floor,
    uplift_required_for_increment_promise,
)
from app.pipeline.context import RunContext
from app.pipeline.registry import cfg


def ctx() -> RunContext:
    return RunContext(
        run_id="run-pf", tenant_id=1, store_id=171, as_of=date(2026, 3, 1),
        snapshot_id="snap-1", config_version="default", seed=0,
        versions={"predictive_interval": "1.0.0"},
    )


def floor(rate=0.92, days=25.7, cv=0.47):
    return promise_floor(rate=rate, horizon_open_days=days, dispersion_cv=cv,
                         ctx=ctx())


def basis(cv=0.47, uplift=2.14, rate=0.92, days=25.7):
    return increment_promise_basis(
        rate=rate, horizon_open_days=days, dispersion_cv=cv,
        baseline_rate=0.43, uplift=uplift, ctx=ctx())


# ── The refutation, and its arithmetic ───────────────────────────────────────


def test_the_required_uplift_rises_with_dispersion() -> None:
    """THE mechanism. A low quantile of a count sits below its mean, and how far
    below is set by dispersion - so the uplift a floor on the INCREMENT would
    need rises with it, fast."""
    needed = [uplift_required_for_increment_promise(1.0, 30.0, cv, ctx())
              for cv in (0.0, 0.25, 0.45, 0.60, 0.80, 1.00)]
    assert all(n is not None for n in needed)
    assert needed == sorted(needed), needed
    # Steady products need a modest lift; erratic ones need an impossible one.
    assert needed[0] < 1.6
    assert needed[2] > 2.5
    assert needed[-1] > 10.0


def test_the_engine_does_not_recommend_at_those_uplifts() -> None:
    """The other half of the refutation, and the reason per-class fitting cannot
    rescue it: the products steady enough to carry a floor have no uplift, and
    the ones with uplift are too erratic. Measured medians by band over 513
    cards."""
    measured_median_uplift = {0.12: 1.21, 0.35: 1.45, 0.57: 1.67, 0.85: 2.26}
    for cv, median_uplift in measured_median_uplift.items():
        needed = uplift_required_for_increment_promise(1.0, 30.0, cv, ctx())
        assert needed is not None
        assert median_uplift < needed, (
            f"at cv {cv} the band's median uplift {median_uplift}x must fall "
            f"short of the {needed:.1f}x a floor requires - that gap is the "
            f"refutation")


def test_the_refusal_carries_a_figure_not_an_opinion() -> None:
    """"Not implemented" sends a reader after a fit that does not exist.
    "needs 3.4x at cv 0.47 and has 2.14x" is a statement they can check."""
    reason = basis(cv=0.47, uplift=2.14)
    assert reason.startswith("refuted:")
    assert "needs_" in reason and "x_uplift" in reason
    assert "cv_0.47" in reason
    assert "has_2.14x" in reason


def test_a_more_erratic_sku_is_refused_more_emphatically() -> None:
    steady = basis(cv=0.25, uplift=1.0)
    erratic = basis(cv=0.80, uplift=1.0)

    def needed_from(text: str) -> float:
        return float(text.split("needs_")[1].split("x_")[0])

    assert needed_from(erratic) > needed_from(steady) * 2


def test_the_possible_branch_is_reachable() -> None:
    """An arithmetic claim with no reachable true case is an assertion, not a
    test. A steady SKU with a large lift CAN carry an increment floor - it is
    simply vanishingly rare in this estate (0 of 513 measured cards)."""
    reason = basis(cv=0.05, uplift=3.0)
    assert reason.startswith("possible:")
    assert "clears" in reason


def test_missing_inputs_are_named_not_guessed() -> None:
    for kwargs in ({"rate": None}, {"days": None}, {"cv": None}):
        reason = increment_promise_basis(
            rate=kwargs.get("rate", 0.92),
            horizon_open_days=kwargs.get("days", 25.7),
            dispersion_cv=kwargs.get("cv", 0.47),
            baseline_rate=0.43, uplift=2.0, ctx=ctx())
        assert reason.startswith("no_inputs:"), kwargs


# ── The floor that does work ─────────────────────────────────────────────────


def test_the_floor_is_positive_and_below_the_expectation() -> None:
    """It is a floor, not a forecast. Stating one at or above the expectation
    would be a forecast wearing a promise's clothes."""
    result = floor()
    assert isinstance(result, PromiseFloor)
    assert result.units >= 1
    assert result.units < result.expected_units
    assert result.coverage == pytest.approx(0.90)
    assert "at least" in result.explain()


def test_the_floor_narrows_as_the_product_steadies() -> None:
    """A steady seller can be promised more, which is the whole point of keying
    this on the SKU's own measured scatter."""
    steady = floor(cv=0.1)
    erratic = floor(cv=1.0)
    assert isinstance(steady, PromiseFloor)
    assert isinstance(erratic, PromiseFloor) or isinstance(erratic, FloorRefused)
    if isinstance(erratic, PromiseFloor):
        assert steady.units > erratic.units


def test_a_floor_below_one_unit_is_refused() -> None:
    """A floor an owner cannot check against a till selling whole bottles is not
    a promise."""
    minimum = float(cfg.get(MIN_FLOOR_UNITS, ctx()))
    assert minimum >= 1.0
    result = floor(rate=0.02, days=5.0, cv=1.2)
    assert isinstance(result, FloorRefused)
    assert result.basis.startswith("floor_below_minimum:")


def test_the_interval_refusal_is_carried_straight_through() -> None:
    """One vocabulary for one failure. A SKU with no measured dispersion is
    refused by the interval, and the floor reports that reason rather than
    inventing a second name for it."""
    result = promise_floor(rate=0.92, horizon_open_days=25.7,
                           dispersion_cv=None, ctx=ctx())
    assert isinstance(result, FloorRefused)
    assert result.basis == "no_dispersion:not_measured"


def test_the_floor_matches_the_published_interval() -> None:
    """The card prints one range and promises one floor. If these two ever
    disagree the card contradicts itself, so the floor is taken FROM the
    interval rather than computed beside it."""
    from app.pipeline.blend.predictive_interval import (
        PredictiveInterval,
        predictive_interval,
    )
    interval = predictive_interval(rate=0.92, horizon_open_days=25.7,
                                   dispersion_cv=0.47, ctx=ctx())
    result = floor()
    assert isinstance(interval, PredictiveInterval)
    assert isinstance(result, PromiseFloor)
    assert result.units == interval.low
    assert result.coverage == interval.nominal_coverage


def test_deficit_units_is_not_touched_anywhere_here() -> None:
    """The promise sits BESIDE the expectation, never in place of it. The +16.6
    point edge was measured on `deficit_units`, and moving it would invalidate
    the whole audit - so this module must not even import it."""
    import pathlib

    source = (pathlib.Path(__file__).parent.parent / "app" / "pipeline"
              / "blend" / "promise_floor.py").read_text(encoding="utf-8")
    assert "deficit_units" not in source.replace(
        "`deficit_units` is untouched", "").replace(
        "`deficit_units` is not", "")


def test_every_setting_is_declared_with_a_reason() -> None:
    assert MIN_FLOOR_UNITS.status == "PROVISIONAL"
    assert MIN_FLOOR_UNITS.why.strip() and MIN_FLOOR_UNITS.owner.strip()
    assert cfg.get(MIN_FLOOR_UNITS, ctx()) is not None


def test_the_measured_hold_rate_is_recorded_in_the_module() -> None:
    """The claim "holds 95.5%" must travel with the code that makes it, or the
    next reader has only an assertion."""
    import pathlib

    source = (pathlib.Path(__file__).parent.parent / "app" / "pipeline"
              / "blend" / "promise_floor.py").read_text(encoding="utf-8")
    assert "95.5%" in source
    assert "0 of 513" in source
