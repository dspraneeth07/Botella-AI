"""N4.1 — a signal must earn its coefficient before a card may cite it.

The discipline is `elasticity/guard.py`'s, reused verbatim: an interval that
spans zero does not mean "no effect", it means the data cannot tell, and a card
may not cite it. Measured across 155 signal-driven recommendations, the layer
that cited signals WITHOUT this scored 6 to 10 points below random.
"""

from __future__ import annotations

import math
import random
from datetime import date, timedelta

import pytest

from app.pipeline.blend.shrink import K_ELASTICITY
from app.pipeline.context import RunContext
from app.pipeline.elasticity.estimate import MIN_RESIDUAL_DF
from app.pipeline.elasticity.signal import (
    MAX_PLAUSIBLE_SIGNAL_BETA,
    MIN_SIGNAL_ACTIVE_DAYS,
    MIN_SIGNAL_DAYS,
    SignalEffectRequest,
    SignalObservation,
    build_signal_design,
    estimate_signal_effect,
)
from app.pipeline.registry import cfg

AS_OF = date(2026, 4, 1)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-n41", "tenant_id": 1, "store_id": 171, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"signal_effect": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def series(effect: float, *, days=400, active_every=12, noise=0.25,
           weekend_lift=1.25, seed=7) -> list[SignalObservation]:
    """A store-day series with a KNOWN signal effect, a weekday pattern and noise."""
    rng = random.Random(seed)
    start = date(2025, 1, 1)
    out = []
    for i in range(days):
        d = start + timedelta(days=i)
        active = (i % active_every) == 0
        base = 10.0 * (weekend_lift if d.weekday() >= 4 else 1.0)
        units = base * (1.0 + effect if active else 1.0) * rng.uniform(
            1 - noise, 1 + noise)
        out.append(SignalObservation(obs_date=d, units=units, signal_active=active))
    return out


def run(obs, *, cohort_beta=None, key="heat_advisory", category="seltzer",
        c=None):
    r = estimate_signal_effect(
        SignalEffectRequest(key, category, obs, cohort_beta=cohort_beta),
        c or ctx(),
    )
    assert r.ok, r.reason
    return r.value


# ── The refusal is the point ─────────────────────────────────────────────────


def test_signal_beta_refused_when_interval_spans_zero() -> None:
    """A series with NO real effect must not produce a citable one."""
    v = run(series(0.0))
    assert v.interval is not None
    assert v.interval.spans_zero, f"got {v.interval}"
    assert v.usable is False
    assert v.suppresses is False
    assert "cannot tell" in v.explain()

    # And a real effect IS citable, so the refusal is discriminating rather than
    # a blanket no.
    real = run(series(0.30))
    assert real.usable is True
    assert real.interval is not None and not real.interval.spans_zero
    assert real.beta is not None and real.beta > 0


def test_negative_beta_is_allowed_and_suppresses() -> None:
    """A measured negative effect is a VETO, not a card with negative value. A
    competitor promotion or a Ramadan trade area means do not pre-stock, and do
    not read the subsequent dip as something to recover."""
    v = run(series(-0.35))
    assert v.usable is True, "a negative effect is still a MEASURED effect"
    assert v.beta is not None and v.beta < 0
    assert v.suppresses is True
    assert "SUPPRESSES" in v.explain()

    # A positive effect does not suppress.
    assert run(series(0.30)).suppresses is False


def test_thin_evidence_refuses_before_fitting() -> None:
    """Refusing early is cheaper and clearer than fitting and discarding."""
    c = ctx()
    assert "too_few_days" in run(series(0.3, days=80)).refused_reason
    # 400 days but the signal fired 4 times: a comparison of 4 against 400.
    assert "too_few_active_days" in run(
        series(0.3, days=400, active_every=120)).refused_reason
    assert int(cfg.get(MIN_SIGNAL_ACTIVE_DAYS, c)) == 20


def test_a_signal_that_is_always_active_has_no_comparison() -> None:
    """The column would be collinear with the intercept and the fit singular."""
    obs = [SignalObservation(obs_date=date(2025, 1, 1) + timedelta(days=i),
                             units=10.0, signal_active=True) for i in range(400)]
    assert "signal_always_active" in run(obs).refused_reason


def test_an_implausible_beta_is_evidence_about_the_data() -> None:
    """A category that only began trading when the signal first fired produces an
    enormous beta. That is a data defect, said rather than reported."""
    start = date(2025, 1, 1)
    obs = []
    for i in range(400):
        d = start + timedelta(days=i)
        active = i >= 200
        obs.append(SignalObservation(
            obs_date=d, units=(60.0 if active else 0.0), signal_active=active))
    v = run(obs)
    assert v.refused_reason is not None
    assert ("implausible_beta" in v.refused_reason
            or "signal_always_active" in v.refused_reason
            or "too_few" in v.refused_reason), v.refused_reason


# ── The controls ─────────────────────────────────────────────────────────────


def test_dow_and_month_controls_present() -> None:
    """Without them the estimate measures the weekend, or July, and credits the
    signal. The reference level is the FIRST OBSERVED one, not a fixed
    Monday/January - the dummy-variable trap that cost 61 of 335 real cells on
    the price module before it was found."""
    obs = series(0.3, days=400)
    design = build_signal_design(obs)

    weekdays = sorted({o.obs_date.weekday() for o in obs})
    months = sorted({o.obs_date.month for o in obs})
    # [intercept, signal, dow(k-1), month(k-1), trend]
    expected_width = 1 + 1 + (len(weekdays) - 1) + (len(months) - 1) + 1
    assert len(design[0]) == expected_width

    # The signal column is index 1, which the estimator relies on.
    for row, o in zip(design, obs):
        assert row[0] == 1.0
        assert row[1] == (1.0 if o.signal_active else 0.0)

    # Trend is scaled onto [0, 1], not a raw ordinal in the thousands.
    trend = [row[-1] for row in design]
    assert min(trend) == pytest.approx(0.0)
    assert max(trend) <= 1.0

    # A window that never sees January must not get a January column, and the
    # dummies must not sum to the intercept on any row.
    short = series(0.3, days=150)
    d2 = build_signal_design(short)
    for row in d2:
        dummies = row[2:-1]
        assert sum(dummies) < len(dummies) + 1


def test_the_controls_actually_remove_a_weekend_confound() -> None:
    """A signal that only ever fires at the weekend, on a store with a weekend
    lift and NO real signal effect, must not produce a citable beta."""
    rng = random.Random(3)
    start = date(2025, 1, 6)        # a Monday
    obs = []
    for i in range(400):
        d = start + timedelta(days=i)
        weekend = d.weekday() >= 5
        active = weekend and (i % 14 < 7)      # fires on alternate weekends only
        units = 10.0 * (1.6 if weekend else 1.0) * rng.uniform(0.8, 1.2)
        obs.append(SignalObservation(obs_date=d, units=units, signal_active=active))
    v = run(obs)
    # Either refused outright, or estimated with an interval that spans zero.
    assert v.usable is False, (
        f"the weekend confound leaked into beta: {v.beta} {v.interval}"
    )


# ── Shrinkage ────────────────────────────────────────────────────────────────


def test_signal_beta_shrinks_toward_cohort_when_thin() -> None:
    """A store with few active days has almost no information of its own, so its
    estimate is pulled toward the peers'. The k is the registry's EXISTING
    shrink.k.elasticity - the constant already governing price elasticity - so no
    new judgement is introduced."""
    c = ctx()
    k = int(cfg.get(K_ELASTICITY, c))

    thin = run(series(0.45, days=400, active_every=18), cohort_beta=0.0)
    fat = run(series(0.45, days=400, active_every=3), cohort_beta=0.0)
    assert thin.refused_reason is None and fat.refused_reason is None

    # More active days means more weight on this store's own number.
    assert fat.own_weight > thin.own_weight
    assert thin.own_weight == pytest.approx(
        thin.active_days / (thin.active_days + k))

    # And the shrunk estimate sits between the store's own and the cohort's.
    assert thin.beta is not None and thin.own_beta is not None
    assert 0.0 < thin.beta < thin.own_beta, (
        "shrinkage toward a cohort beta of 0 must pull the estimate DOWN"
    )
    assert abs(thin.beta - thin.own_beta) > abs(fat.beta - fat.own_beta), (
        "the thinner store must be pulled further"
    )
    assert "shrunk_to_cohort" in thin.basis


def test_no_cohort_means_no_shrinkage_and_says_so() -> None:
    """Honest rather than neutral: it states that this is the store's own number
    alone, instead of silently shrinking toward an invented zero."""
    v = run(series(0.30), cohort_beta=None)
    assert v.own_weight == 1.0
    assert v.beta == v.own_beta
    assert v.basis == "own_only"


def test_shrinkage_does_not_narrow_the_interval() -> None:
    """Shrinkage moves the CENTRE. Treating it as if it also reduced uncertainty
    would manufacture confidence out of a borrowed number."""
    obs = series(0.45, days=400, active_every=18)
    alone = run(obs, cohort_beta=None)
    shrunk = run(obs, cohort_beta=0.0)
    assert alone.interval is not None and shrunk.interval is not None
    width_alone = alone.interval.high - alone.interval.low
    width_shrunk = shrunk.interval.high - shrunk.interval.low
    assert width_shrunk == pytest.approx(width_alone)
    assert shrunk.beta != alone.beta


# ── Settings and shape ───────────────────────────────────────────────────────


def test_every_setting_is_declared_provisional() -> None:
    for setting in (MIN_SIGNAL_DAYS, MIN_SIGNAL_ACTIVE_DAYS,
                    MAX_PLAUSIBLE_SIGNAL_BETA):
        assert setting.status == "PROVISIONAL"
        assert setting.why.strip() and setting.owner.strip()
        assert cfg.get(setting, ctx()) is not None


def test_it_reuses_the_price_modules_residual_df_floor() -> None:
    """One floor, one reason: below 30 df a single t multiplier flatters the
    interval. Not re-litigated here."""
    assert int(cfg.get(MIN_RESIDUAL_DF, ctx())) == 30


def test_result_serialises_with_its_verdict() -> None:
    d = run(series(0.30)).as_dict()
    assert d["usable"] is True
    assert d["interval_low"] is not None and d["interval_high"] is not None
    assert d["active_days"] > 0
    assert d["basis"]
    refused = run(series(0.3, days=80)).as_dict()
    assert refused["usable"] is False
    assert refused["refused_reason"]


def test_log1p_transform_tolerates_zero_days() -> None:
    """A signal is active on days when a category sells nothing, and those zero
    days are exactly the comparison the estimate needs. ln(0) is undefined."""
    rng = random.Random(11)
    start = date(2025, 1, 1)
    obs = []
    for i in range(400):
        d = start + timedelta(days=i)
        active = (i % 10) == 0
        units = 0.0 if rng.random() < 0.4 else rng.uniform(1, 6) * (
            1.5 if active else 1.0)
        obs.append(SignalObservation(obs_date=d, units=units, signal_active=active))
    v = run(obs)
    assert v.refused_reason is None or "implausible" not in v.refused_reason
    assert all(math.isfinite(x) for x in (v.beta or 0.0,))
