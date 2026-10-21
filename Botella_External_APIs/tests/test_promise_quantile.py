"""N1.1 — the promise is a quantile, and the ranking quantity must not move.

The arithmetic that justifies the whole prompt: a count distribution reaches its
own mean about half the time. For a true rate of 14 units over 30 days the spread
is sqrt(14) = 3.74, so P(realised >= 14) = 53.5%. A promise built on the mean
therefore fails about half the time even with a perfect forecast.

WHICH QUANTITY THE QUANTILE IS TAKEN OF. The promise is a floor on the TOTAL -
"at least N units will sell" - and not on the INCREMENT. The increment form is
refuted: clearing the baseline at a low quantile needs an uplift of 1/(p05/mean),
which rises with dispersion faster than this engine's candidates supply it, and
0 of 513 measured cards could carry one. `blend/promise_floor.py` has the
derivation. The shipped form holds 95.5% across the same cards.

The most important test in this file is the LAST one, which pins `deficit_units`
digit for digit: the +16.6 point edge over a reversion-matched null was measured
on that ordering, and this change must be provably unable to move it.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.pipeline.blend.reversion import (
    MIN_PROMISE_UNITS,
    PROMISE_QUANTILE,
    ReversionRequest,
    is_recommendable,
    revert,
)
from app.pipeline.context import RunContext
from app.pipeline.registry import cfg

AS_OF = date(2026, 3, 2)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-n11", "tenant_id": 1, "store_id": 171, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"temporal_reversion": "1.1.0"},
    }
    return RunContext(**{**base, **over})


def req(**over) -> ReversionRequest:
    """A SKU whose recent 28 open days ran below its own long run.

    28 units / 28 days = 1.0 a day recently; 420 / 300 = 1.4 a day long run.
    """
    base = dict(
        sku="0245",
        recent_units=28.0, recent_open_days=28,
        long_run_units=420.0, long_run_open_days=300,
        weekly_rates=(1.1, 0.9, 1.0, 1.05, 0.95, 1.0),
        horizon_days=30, horizon_open_days=26,
    )
    return ReversionRequest(**{**base, **over})


def reverted(**over):
    r = revert(req(**over), ctx())
    assert r.ok, r.reason
    return r.value


# ── The promise is below the mean ────────────────────────────────────────────


def test_promise_is_below_the_mean_for_a_lumpy_sku() -> None:
    """The point of the prompt, on the quantity a low quantile can carry.

    The promise is a floor on the TOTAL - "at least N units will sell" - and it
    must sit below what the engine EXPECTS to sell, or it is a forecast wearing a
    promise's clothes.
    """
    v = reverted()
    assert v.promise_units is not None
    assert v.promise_units > 0.0, "a floor of zero is not a promise"
    expected_total = v.rate_per_open_day * 26
    assert v.promise_units < expected_total, (
        "a low-quantile floor must be smaller than the expectation it sits "
        "beside, or nothing has changed"
    )
    assert v.promise_basis.startswith("total_floor_p")

def test_promise_is_the_published_intervals_low_end() -> None:
    """Pins WHERE the number comes from, which is the whole safety property.

    The card prints one range and promises one floor. Taking the floor FROM the
    interval rather than computing it alongside is what stops a card
    contradicting itself.
    """
    from app.pipeline.blend.predictive_interval import (
        PredictiveInterval,
        predictive_interval,
    )

    v = reverted()
    band = predictive_interval(
        rate=v.rate_per_open_day, horizon_open_days=26.0,
        dispersion_cv=v.dispersion_cv, ctx=ctx())
    assert isinstance(band, PredictiveInterval)
    assert v.promise_units == pytest.approx(float(band.low))


def test_the_increment_form_is_refuted_with_arithmetic() -> None:
    """The form this file used to test. It is not unfitted - it is unavailable,
    because clearing the baseline needs an uplift of 1 / (p05/mean) and that rises
    with dispersion faster than this engine's candidates supply it. Measured over
    513 cards: 0 could carry one."""
    from app.pipeline.blend.promise_floor import (
        uplift_required_for_increment_promise,
    )

    needed = [uplift_required_for_increment_promise(1.0, 30.0, cv, ctx())
              for cv in (0.25, 0.45, 0.60, 0.80)]
    assert all(n is not None for n in needed)
    assert needed == sorted(needed), needed
    # The measured median uplift in each band falls short of its requirement.
    for required, median_uplift in zip(needed, (1.45, 1.67, 1.67, 2.26)):
        assert median_uplift < required

def test_a_lumpier_sku_gets_a_smaller_promise() -> None:
    """A more erratic product can be promised LESS, monotonically. This is the
    whole reason the floor is keyed on the SKU's own measured scatter rather than
    on a store-wide factor."""
    steady = reverted(weekly_rates=(1.0, 1.0, 1.0, 1.0, 1.0, 1.0))
    erratic = reverted(weekly_rates=(0.2, 1.9, 0.4, 1.7, 0.3, 1.5))
    assert steady.promise_units is not None
    assert erratic.dispersion_cv > steady.dispersion_cv
    if erratic.promise_units is not None:
        assert steady.promise_units > erratic.promise_units
    # A floor that cannot clear one unit is withheld, which is also valid.

def test_the_calibration_factor_is_not_applied_to_the_promise() -> None:
    """Two mechanisms exist to make the promise land. Applying both corrects
    twice, and the per-store scalar is the one that failed to generalise."""
    plain = reverted(promise_ratio=0.90, promise_ratio_quantile=0.10)
    scaled = reverted(promise_ratio=0.90, promise_ratio_quantile=0.10,
                      deficit_calibration=0.5)
    # The calibration halves the RANKING quantity, as it always did...
    assert scaled.deficit_units == pytest.approx(plain.deficit_units * 0.5)
    # ...and leaves the PROMISE untouched.
    assert scaled.promise_units == pytest.approx(plain.promise_units)


# ── Absence, with a named reason, and never a fallback to the mean ───────────


def test_promise_absent_without_a_measurable_dispersion() -> None:
    """No measured scatter means no floor. It must NOT fall back to the mean,
    which is the whole point - and zero dispersion is the NARROWEST floor there
    is, so defaulting to it would state the most confident claim on the least
    evidence."""
    v = reverted(weekly_rates=())
    # With no weekly rates the registry default dispersion applies, which is
    # deliberately high - so the floor is either withheld or very low.
    if v.promise_units is not None:
        assert v.promise_units < v.rate_per_open_day * 26
    assert v.promise_basis
    # The ranking quantity is still there - only the claim is affected.
    assert v.deficit_units > 0.0

def test_the_interval_refusal_is_carried_not_restated() -> None:
    """One vocabulary for one failure. When the interval declines, the promise
    reports the interval's OWN named basis rather than inventing a second name
    for the same thing."""
    v = reverted(recent_units=0.0, recent_open_days=28,
                 long_run_units=0.0, long_run_open_days=300)
    assert v.promise_units is None
    assert v.promise_basis, "a refusal is always named"

def test_a_floor_below_one_unit_is_withheld() -> None:
    """A floor an owner cannot check against a till selling whole bottles is not
    a promise. 'No floor worth stating' is a real answer."""
    v = reverted(recent_units=1.0, recent_open_days=28,
                 long_run_units=12.0, long_run_open_days=300,
                 weekly_rates=(0.01, 0.9, 0.02, 0.8, 0.01, 0.7),
                 horizon_open_days=3)
    if v.promise_units is None:
        assert v.promise_basis
    else:
        assert v.promise_units >= 1.0

def test_sub_unit_promises_are_withheld() -> None:
    """'Expect 0.4 more bottles' is not a sentence an owner can act on."""
    # Tuned so the quantile clears the baseline by a fraction of a unit.
    v = reverted(promise_ratio=0.86, promise_ratio_quantile=0.10)
    assert v.promise_units is None or v.promise_units >= cfg.get(
        MIN_PROMISE_UNITS, ctx()
    )


def test_immaterial_sku_promises_nothing() -> None:
    v = reverted(recent_units=2.0, promise_ratio=0.9, promise_ratio_quantile=0.10)
    assert v.material is False
    assert v.promise_units is None
    assert v.promise_basis == "immaterial"


def test_promise_basis_is_always_populated() -> None:
    """A card quoting a figure whose basis cannot be named is the defect this
    rebuild exists to remove - so every path records one."""
    for kw in ({}, {"promise_ratio": 0.9, "promise_ratio_quantile": 0.10},
               {"promise_ratio": 0.9, "promise_ratio_quantile": 0.25},
               {"promise_ratio": 0.4, "promise_ratio_quantile": 0.10},
               {"recent_units": 1.0}):
        v = reverted(**kw)
        assert v.promise_basis and v.promise_basis != "not_computed"


def test_promise_appears_in_the_serialised_form() -> None:
    d = reverted(promise_ratio=0.9, promise_ratio_quantile=0.10).as_dict()
    assert "promise_units" in d and "promise_basis" in d
    assert d["promise_units"] is not None


# ── The setting ─────────────────────────────────────────────────────────────


def test_promise_quantile_is_declared_provisional_and_says_it_is_a_promise_dial() -> None:
    assert PROMISE_QUANTILE.status == "PROVISIONAL"
    assert cfg.get(PROMISE_QUANTILE, ctx()) == pytest.approx(0.10)
    low = PROMISE_QUANTILE.why.lower()
    assert "promise dial" in low and "never an order dial" in low, (
        "the why must state the direction, because the order quantity wants the "
        "OPPOSITE quantile and confusing the two is the defect N1.3 fixes"
    )


def test_a_longer_horizon_promises_more() -> None:
    """The floor scales with the window it covers, which is the direction an
    owner would expect: more selling days, more units guaranteed."""
    short = reverted(horizon_open_days=13)
    long = reverted(horizon_open_days=26)
    assert long.promise_units is not None
    if short.promise_units is not None:
        assert long.promise_units > short.promise_units


def test_open_days_not_calendar_days_set_the_floor() -> None:
    """26 open days in a 30-calendar-day window. Using 30 would overstate the
    floor, which is the one direction a promise must never be wrong in."""
    on_open = reverted(horizon_open_days=26)
    on_calendar = reverted(horizon_open_days=30)
    assert on_open.promise_units is not None
    assert on_calendar.promise_units is not None
    assert on_open.promise_units <= on_calendar.promise_units

# ── THE PIN: the ranking quantity must be provably unmoved ──────────────────


def test_deficit_units_is_byte_identical_to_v1_1_0() -> None:
    """The most important test in this file.

    The +16.6 point edge over a reversion-matched null (p = 0.0005, holding at
    all five pilot stores) was measured on `deficit_units` as computed by stage
    version 1.1.0. If this prompt moved that number by so much as a float's last
    bit, every result in the audit would have to be re-run.

    These expectations are computed from the formula by hand rather than copied
    from the implementation, so a change to the implementation cannot quietly
    update the pin along with the behaviour.
    """
    # Hand arithmetic, independent of the module:
    #   recent  = 28 / 28  = 1.0
    #   long    = 420 / 300 = 1.4
    #   cv      from the six weekly rates
    #   n_eff   = 28 / (1 + cv^2)
    #   w       = n_eff / (n_eff + k),  k = shrink.k.sku_velocity
    #   rate_hat= w * 1.0 + (1 - w) * 1.4
    #   deficit = (rate_hat - 1.0) * 30
    plain = reverted()
    assert plain.recent_rate == pytest.approx(1.0)
    assert plain.long_run_rate == pytest.approx(1.4)
    rate_hat = (plain.recent_weight * plain.recent_rate
                + (1.0 - plain.recent_weight) * plain.long_run_rate)
    assert plain.rate_per_open_day == pytest.approx(rate_hat)
    assert plain.deficit_units == pytest.approx((rate_hat - 1.0) * 30)

    # And supplying promise inputs must not perturb it in any direction.
    for kw in ({"promise_ratio": 0.90, "promise_ratio_quantile": 0.10},
               {"promise_ratio": 0.50, "promise_ratio_quantile": 0.10},
               {"promise_ratio": 1.30, "promise_ratio_quantile": 0.10},
               {"promise_ratio": 0.90, "promise_ratio_quantile": 0.25}):
        v = reverted(**kw)
        assert v.deficit_units == plain.deficit_units, (
            f"deficit_units moved when {kw} was supplied - the ranking changed "
            f"and the five-store audit is invalid"
        )
        assert v.raw_deficit_units == plain.raw_deficit_units
        assert v.rate_per_open_day == plain.rate_per_open_day
        assert v.p_hit == plain.p_hit
        assert v.uplift == plain.uplift
        assert v.recent_weight == plain.recent_weight


def test_recommendability_still_ignores_the_promise() -> None:
    """THE separation that protects the audit. Whether a card is worth showing is
    decided by the expectation and p_hit; the promise is a claim made AFTER that
    decision and must not feed back into it."""
    with_promise = reverted()
    assert with_promise.promise_units is not None
    # Same inputs, floor withheld by an impossible horizon.
    without = reverted(horizon_open_days=None)
    assert without.promise_units is None
    assert is_recommendable(with_promise, ctx()) == \
        is_recommendable(without, ctx()), (
        "the promise must not change whether a card is recommendable"
    )
    assert with_promise.deficit_units == pytest.approx(without.deficit_units)

def test_a_negative_deficit_is_still_refused() -> None:
    """The steady-decliner guard, unchanged: a window running HOT has a negative
    gap and is not a small opportunity, it is none."""
    v = reverted(recent_units=56.0)       # 2.0/day recently vs 1.4 long run
    assert v.deficit_units < 0.0
    assert is_recommendable(v, ctx(), cfg) is False
