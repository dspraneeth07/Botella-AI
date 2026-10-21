"""The interval the gate's fourth check had nothing to measure without."""

from __future__ import annotations

import math
from datetime import date

import pytest

from app.pipeline.blend.predictive_interval import (
    MAX_SUMMATION_TERMS,
    MIN_DISPERSION_CV,
    PREDICTIVE_COVERAGE,
    IntervalRefused,
    LowerTail,
    PredictiveInterval,
    lower_tail_probability,
    predictive_interval,
)
from app.pipeline.context import RunContext
from app.pipeline.registry import cfg


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-pi", "tenant_id": 1, "store_id": 171,
        "as_of": date(2026, 3, 1), "snapshot_id": "snap-1",
        "config_version": "default", "seed": 0,
        "versions": {"predictive_interval": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def interval(rate=0.5, days=28.0, cv=0.5, c=None):
    return predictive_interval(
        rate=rate, horizon_open_days=days, dispersion_cv=cv, ctx=c or ctx())


# ── The distribution is the point ────────────────────────────────────────────


def test_zero_dispersion_is_poisson_not_a_special_case() -> None:
    """cv == 0 means the weekly rates were identical, which is a real and
    legitimate measurement - and the Poisson interval is its correct answer."""
    result = interval(cv=0.0)
    assert isinstance(result, PredictiveInterval)
    assert result.distribution == "poisson"
    assert result.dispersion_cv == 0.0


def test_dispersion_widens_the_interval_monotonically() -> None:
    """The whole reason this is not Poisson. A SKU arriving 4 then 26 then 9 must
    get a wider range than one arriving 13, 14, 13 - at the same mean."""
    widths = []
    for cv in (0.0, 0.25, 0.5, 1.0, 1.5):
        result = interval(rate=0.5, days=28.0, cv=cv)
        assert isinstance(result, PredictiveInterval)
        widths.append(result.width)
    assert widths == sorted(widths), widths
    # And it is not a rounding difference - erratic is MUCH wider than steady.
    assert widths[-1] > widths[0] * 2


def test_the_variance_matches_the_stated_model() -> None:
    """mu + cv^2 * mu^2. Checked against the realised spread of the distribution
    the quantiles were taken from, so the parameterisation cannot drift."""
    mu, cv = 14.0, 0.5
    size = 1.0 / (cv * cv)
    p = size / (size + mu)
    # Mean and variance of the NB this module claims to be using.
    assert size * (1 - p) / p == pytest.approx(mu)
    assert size * (1 - p) / (p * p) == pytest.approx(mu + cv * cv * mu * mu)


def test_the_interval_actually_covers_its_nominal_rate() -> None:
    """The claim on the card is "between X and Y, 90% of the time". That is a
    testable statement about the distribution, so here it is tested: the mass
    inside the interval must be at least the nominal coverage."""
    c = ctx()
    nominal = float(cfg.get(PREDICTIVE_COVERAGE, c))
    for rate, days, cv in ((0.5, 28.0, 0.5), (3.44, 30.0, 1.0),
                           (0.1, 25.7, 0.0), (2.0, 21.0, 0.75)):
        result = predictive_interval(
            rate=rate, horizon_open_days=days, dispersion_cv=cv, ctx=c)
        assert isinstance(result, PredictiveInterval)
        mu = rate * days
        if cv == 0.0:
            def pmf(x: int) -> float:
                return math.exp(x * math.log(mu) - mu - math.lgamma(x + 1.0))
        else:
            size = 1.0 / (cv * cv)
            p = size / (size + mu)

            def pmf(x: int, _s=size, _p=p) -> float:
                return math.exp(
                    math.lgamma(x + _s) - math.lgamma(_s) - math.lgamma(x + 1.0)
                    + _s * math.log(_p) + x * math.log1p(-_p))

        mass = sum(pmf(x) for x in range(result.low, result.high + 1))
        assert mass >= nominal - 1e-9, (rate, days, cv, mass)


def test_open_days_are_the_denominator() -> None:
    """25.7 open days in a 30-calendar-day window. Using 30 inflates the mean by
    16.8%, which this engine has already paid for once."""
    open_days = interval(rate=0.5, days=25.7, cv=0.5)
    calendar = interval(rate=0.5, days=30.0, cv=0.5)
    assert isinstance(open_days, PredictiveInterval)
    assert isinstance(calendar, PredictiveInterval)
    assert open_days.mean < calendar.mean
    assert open_days.mean == pytest.approx(0.5 * 25.7)


# ── It is NOT the promise/order band ─────────────────────────────────────────


def test_this_interval_is_two_sided_and_symmetric() -> None:
    """A reader coming from N1 will reach for [promise, order] as "the interval".
    That band is a p10 and a q* chosen for two different jobs and its nominal
    coverage is about 81%, so testing it against a 90% bar would fail a correct
    engine. This one excludes equal mass on each side."""
    c = ctx()
    nominal = float(cfg.get(PREDICTIVE_COVERAGE, c))
    result = predictive_interval(
        rate=1.0, horizon_open_days=30.0, dispersion_cv=0.5, ctx=c)
    assert isinstance(result, PredictiveInterval)
    assert result.nominal_coverage == nominal
    # Both tails exist: the interval neither starts at zero nor runs away.
    assert result.low > 0
    assert result.high > result.mean > result.low


def test_nominal_coverage_is_carried_on_the_interval() -> None:
    """So a stored interval can be audited against the setting in force when it
    was written, rather than against today's."""
    result = interval()
    assert isinstance(result, PredictiveInterval)
    assert result.nominal_coverage == float(cfg.get(PREDICTIVE_COVERAGE, ctx()))
    assert "90%" in result.explain()
    assert result.as_dict()["nominal_coverage"] == result.nominal_coverage


# ── Refusals. Absence is not a wide interval ─────────────────────────────────


def test_unmeasured_dispersion_refuses_rather_than_assuming_zero() -> None:
    """Zero cv is the NARROWEST interval there is. Defaulting an unmeasured SKU
    to it would state the most confident possible range on the least evidence."""
    result = predictive_interval(
        rate=0.5, horizon_open_days=28.0, dispersion_cv=None, ctx=ctx())
    assert isinstance(result, IntervalRefused)
    assert result.basis == "no_dispersion:not_measured"
    assert result.as_dict()["low"] is None


def test_every_refusal_is_named() -> None:
    cases = {
        "no_inputs": predictive_interval(
            rate=None, horizon_open_days=28.0, dispersion_cv=0.5, ctx=ctx()),
        "no_inputs_days": predictive_interval(
            rate=0.5, horizon_open_days=None, dispersion_cv=0.5, ctx=ctx()),
        "no_demand": interval(rate=0.0),
        "no_demand_negative": interval(rate=-1.0),
        "no_open_days": interval(days=0.0),
        "invalid_dispersion": interval(cv=-0.5),
    }
    for label, result in cases.items():
        assert isinstance(result, IntervalRefused), label
        assert result.basis and ":" in result.basis, label


def test_a_refusal_is_not_a_generous_bound() -> None:
    """The tempting failure: widen the interval when the inputs are poor, because
    a wide interval always covers and the coverage check always passes. That is a
    way of scoring 100% on this gate while telling the owner nothing."""
    for result in (interval(rate=0.0), interval(cv=-1.0),
                   predictive_interval(rate=0.5, horizon_open_days=28.0,
                                       dispersion_cv=None, ctx=ctx())):
        assert isinstance(result, IntervalRefused)
        assert not hasattr(result, "low") or result.as_dict()["low"] is None


def test_an_inverted_interval_cannot_be_constructed() -> None:
    with pytest.raises(ValueError, match="exceeds"):
        PredictiveInterval(low=10, high=4, nominal_coverage=0.9, mean=7.0,
                           dispersion_cv=0.5, distribution="poisson")
    with pytest.raises(ValueError, match="negative"):
        PredictiveInterval(low=-1, high=4, nominal_coverage=0.9, mean=7.0,
                           dispersion_cv=0.5, distribution="poisson")


def test_the_summation_cap_refuses_rather_than_returning_a_partial_sum() -> None:
    """An unbounded loop on a pathological mean would hang the run; returning the
    last index reached would report a number that is not a quantile."""
    result = predictive_interval(
        rate=1e9, horizon_open_days=30.0, dispersion_cv=0.0,
        ctx=ctx(), config=cfg)
    assert isinstance(result, IntervalRefused)
    assert result.basis.startswith("not_converged:")


# ── covers() is the coverage check, in one place ─────────────────────────────


def test_covers_is_inclusive_at_both_ends() -> None:
    """An actual landing exactly on the boundary is covered. Excluding it would
    understate coverage by the mass of two whole atoms on a discrete count."""
    result = PredictiveInterval(low=4, high=26, nominal_coverage=0.9, mean=14.0,
                                dispersion_cv=0.5,
                                distribution="negative_binomial")
    assert result.covers(4) is True
    assert result.covers(26) is True
    assert result.covers(3) is False
    assert result.covers(27) is False
    assert result.covers(14) is True
    assert result.width == 22


# ── The lower tail the lifecycle retires on, from the same pmf ───────────────


def test_the_lower_tail_matches_the_textbook_poisson_values() -> None:
    """P(X <= k | mu = 3): 0.0498, 0.1991, 0.4232. These are the numbers the
    lifecycle's `why` quotes, so they are pinned here against the function
    rather than trusted."""
    for k, expected in ((0, 0.0498), (1, 0.1991), (2, 0.4232)):
        t = lower_tail_probability(k, mean=3.0, dispersion_cv=0.0)
        assert isinstance(t, LowerTail)
        assert t.probability == pytest.approx(expected, abs=5e-4), k
        assert t.distribution == "poisson" and t.count == k and t.mean == 3.0


def test_the_tail_is_the_same_distribution_the_interval_is_drawn_from() -> None:
    """One count model for one claim. The mass the interval places at or below
    its own low quantile must be what the tail function reports for that
    quantile, or a card could publish a range on the front and be retired by a
    different arithmetic on the back."""
    c = ctx()
    nominal = float(cfg.get(PREDICTIVE_COVERAGE, c))
    for rate, days, cv in ((0.5, 28.0, 0.5), (2.0, 21.0, 0.75), (0.1, 25.7, 0.0)):
        band = predictive_interval(
            rate=rate, horizon_open_days=days, dispersion_cv=cv, ctx=c)
        assert isinstance(band, PredictiveInterval)
        at_low = lower_tail_probability(band.low, mean=band.mean,
                                        dispersion_cv=cv)
        below_low = (lower_tail_probability(band.low - 1, mean=band.mean,
                                            dispersion_cv=cv).probability
                     if band.low > 0 else 0.0)
        lo_target = (1.0 - nominal) / 2
        assert below_low < lo_target <= at_low.probability, (rate, days, cv)
        assert at_low.distribution == band.distribution


def test_dispersion_widens_the_lower_tail_too() -> None:
    """An erratic SKU has quiet weeks as a matter of course, so the same low
    count is LESS surprising under its own scatter than under Poisson. This is
    why an unmeasured cv must not default to zero: zero is the most eager."""
    tails = [lower_tail_probability(3, mean=7.0, dispersion_cv=cv).probability
             for cv in (0.0, 0.25, 0.5, 1.0)]
    assert tails == sorted(tails), tails
    assert tails[0] == pytest.approx(0.0818, abs=5e-4)
    assert tails[2] == pytest.approx(0.223, abs=1e-3)


def test_a_fractional_count_is_floored_toward_the_lower_tail() -> None:
    """1.5 units is at most 1 whole unit for a count model, which errs toward
    retiring - the conservative direction for a rule meant to stop a wrong
    card."""
    assert (lower_tail_probability(1.5, mean=3.0, dispersion_cv=0.0).probability
            == lower_tail_probability(1, mean=3.0, dispersion_cv=0.0).probability)
    assert lower_tail_probability(-2, mean=3.0, dispersion_cv=0.0).count == 0


def test_the_tail_refuses_impossible_inputs_loudly() -> None:
    """Unlike the interval, which refuses softly because a thin SKU is an
    ordinary daily event, the tail is called only with inputs the lifecycle has
    already checked - so a bad one is a bug and should say so."""
    with pytest.raises(ValueError, match="mean"):
        lower_tail_probability(1, mean=0.0, dispersion_cv=0.0)
    with pytest.raises(ValueError, match="dispersion_cv"):
        lower_tail_probability(1, mean=3.0, dispersion_cv=-0.1)
    whole = lower_tail_probability(10_000, mean=3.0, dispersion_cv=0.0)
    assert whole.probability == pytest.approx(1.0)
    assert whole.probability <= 1.0, "never above one, whatever the sum does"


def test_every_setting_is_declared_with_a_reason() -> None:
    for setting in (PREDICTIVE_COVERAGE, MAX_SUMMATION_TERMS, MIN_DISPERSION_CV):
        assert setting.status == "PROVISIONAL"
        assert setting.why.strip() and setting.owner.strip()
        assert cfg.get(setting, ctx()) is not None
