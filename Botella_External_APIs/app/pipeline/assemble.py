"""04 -> 05 -> 06 as one call. The wiring, and nothing else.

Sheets 04, 05 and 06 each produced a pure, tested stage and none of them
called another. This is the seam that makes them a pipeline:

    count_evidence   (04)  ->  n            how much of its own data the store has
    estimate_prior   (05)  ->  theta_cohort what comparable stores do
    blend            (06)  ->  theta_hat    the two, weighted by n

WHAT THIS MODULE IS NOT ALLOWED TO DO
    Fetch anything. Every input arrives in `SkuInput` / `EstateInput`, assembled
    by the caller from the feature store. That keeps all three stages replayable
    from their recorded inputs, which is the whole point of sheet 00's envelope
    - a stage that reads a database cannot be replayed, only re-run.

    Branch on evidence_state, or on n, or on whether the store is new. A store
    with no history and a store with four years of it take the same three calls
    in the same order; only the value of n differs. `check_no_state_branches.py`
    enforces the first of those, and sheet 06's own AST test the rest.

THE COLD-START CASE IS NOT A CASE
    A store with zero facts produces n=0, the ladder still resolves (it always
    does - climbing to national and then to a structural default), and the
    blend returns theta_cohort exactly. No branch was taken to make that
    happen. `own_weight` comes back 0.0 and the card says "based 0% on your own
    sales", which is both true and actionable.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from app.pipeline.blend import BlendRequest, blend
from app.pipeline.blend.reversion import (
    REVERSION_HORIZON_DAYS,
    ReversionRequest,
    RevertedDemand,
    revert,
)
from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.evidence import EvidenceRequest, count_evidence
from app.pipeline.features.store import CalendarDay, DayFact
from app.pipeline.patterns import canonical, for_evidence
from app.pipeline.priors import CohortObservation, PriorRequest, estimate_prior
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, cfg


@dataclass(frozen=True, slots=True)
class SkuInput:
    """One SKU's worth of inputs, already read from the feature store."""

    sku: str
    category: str | None = None
    #: The store's OWN rate for this SKU - units per open day. None when it has
    #: never sold one, where the blend annihilates it against n=0.
    #:
    #: SUPPLYING THIS ALONE IS THE OLD BEHAVIOUR, and it is the biased one: a
    #: trailing rate over-states a SKU that just spiked and under-states one
    #: that just went quiet. Supply the four window fields below and the rate
    #: is corrected across TIME before it is blended across STORES.
    own_rate: float | None = None
    #: unit key -> one observation per cohort store. Keys are the ladder's:
    #: the sku itself, its category, and "*" for all_products.
    observations: Mapping[str, Sequence[CohortObservation]] = field(
        default_factory=dict
    )

    #: The trailing window, and the same SKU's long run. When all four are
    #: present sheet 20 runs first and REPLACES `own_rate`; when any is
    #: missing `own_rate` is used as-is, so an un-migrated caller keeps
    #: working and gets the old answer. Open days throughout - sheet 03's
    #: denominator, never calendar days.
    recent_units: float | None = None
    recent_open_days: int | None = None
    long_run_units: float | None = None
    long_run_open_days: int | None = None
    #: Weekly rates over the stability window. Decides how hard the trailing
    #: window is shrunk; absent, sheet 20 assumes an erratic SKU and shrinks
    #: it hard, which is the conservative direction.
    weekly_rates: tuple[float, ...] = ()

    def reversion_request(self, horizon_days: int) -> ReversionRequest | None:
        """The sheet-20 request, or None when this caller has not migrated."""
        if (
            self.recent_units is None
            or self.recent_open_days is None
            or self.long_run_units is None
            or self.long_run_open_days is None
        ):
            return None
        return ReversionRequest(
            sku=self.sku,
            recent_units=self.recent_units,
            recent_open_days=self.recent_open_days,
            long_run_units=self.long_run_units,
            long_run_open_days=self.long_run_open_days,
            weekly_rates=self.weekly_rates,
            horizon_days=horizon_days,
        )


@dataclass(frozen=True, slots=True)
class EstateInput:
    """Everything shared across the SKUs of one store."""

    store_key: tuple[int, int]
    subject_state: str | None
    calendar: Sequence[CalendarDay]
    facts: Sequence[DayFact]
    #: (store_key, state) for every store that could join a cohort.
    candidates: Sequence[tuple[tuple[int, int], str | None]]
    window_days: int = 364


@dataclass(frozen=True, slots=True)
class EstimateRequest:
    """One SKU of one store, one pattern. The stage's whole input.

    A single request object rather than loose arguments, because sheet 00's
    `@stage` contract is (request, ctx) - the envelope records the first
    argument as THE input, and a stage whose input is spread across three
    parameters cannot be replayed from what was recorded. The envelope refused
    the loose-argument version outright, which is the guard working.
    """

    estate: EstateInput
    sku: SkuInput
    pattern: str


@dataclass(frozen=True, slots=True)
class Estimate:
    """One SKU, estimated. Every number that produced it is on the record."""

    sku: str
    pattern: str
    value: float
    n: int
    k: int
    own_weight: float
    theta_own: float
    theta_cohort: float
    evidence_state: str
    sufficiency: str
    cohort_level: str | None
    cohort_size: int | None
    cohort_basis: str
    #: WHICH RUNG answered: sku | category | all_products. Not cosmetic - an
    #: all_products prior answers a different question from a sku prior, and a
    #: reader who cannot see which one they got cannot tell a tight estimate
    #: from a fallback wearing the same clothes.
    specificity: str
    dispersion_cv_pct: int | None
    explanation: str
    #: Sheet 20's output, when the caller supplied the windows for it. None
    #: means the temporal correction did not run - NOT that it ran and found
    #: nothing. Ranking reads `deficit_units` for money and `p_hit` for
    #: confidence; both are None-safe by being absent rather than zero.
    reversion: RevertedDemand | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "sku": self.sku, "pattern": self.pattern, "value": self.value,
            "n": self.n, "k": self.k, "own_weight": self.own_weight,
            "theta_own": self.theta_own, "theta_cohort": self.theta_cohort,
            "evidence_state": self.evidence_state,
            "sufficiency": self.sufficiency,
            "cohort_level": self.cohort_level, "cohort_size": self.cohort_size,
            "cohort_basis": self.cohort_basis,
            "specificity": self.specificity,
            "dispersion_cv_pct": self.dispersion_cv_pct,
            "explanation": self.explanation,
        }


@stage("assemble_estimate", "1.0.0")
def estimate_sku(
    request: EstimateRequest,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> StageResult:
    """One SKU, one pattern, through all three stages.

    `request.pattern` may be spelled either way; it is canonicalised once here
    so the two vocabularies never meet downstream.
    """
    record_inputs("feature_daily", "feature_store_day", "client_locations.state")

    estate = request.estate
    sku_input = request.sku
    canon = canonical(request.pattern)

    # 04 - how much of its own data does this store have?
    ev = count_evidence(
        EvidenceRequest(
            pattern=for_evidence(canon),
            calendar=estate.calendar,
            facts=estate.facts,
            window_days=estate.window_days,
            sku=sku_input.sku,
            category=sku_input.category,
        ),
        ctx,
        config,
    )
    if not ev.ok or ev.value is None:
        return ev
    count = ev.value

    # 05 - what do comparable stores do? Always resolves.
    pr = estimate_prior(
        PriorRequest(
            store_key=estate.store_key,
            pattern=canon,
            candidates=estate.candidates,
            observations=sku_input.observations,
            subject_state=estate.subject_state,
            sku=sku_input.sku,
            category=sku_input.category,
        ),
        ctx,
        config,
    )
    if not pr.ok or pr.value is None:
        return pr
    prior = pr.value

    # 20 - correct the trailing window across TIME, before 06 blends it across
    # STORES. Order matters: shrinking a biased estimate toward the cohort
    # leaves a biased estimate, just a quieter one. When the caller has not
    # supplied the long-run window this is skipped and `own_rate` is used
    # unchanged, which is the old answer and is documented as such.
    reversion: RevertedDemand | None = None
    theta_own = sku_input.own_rate
    reversion_req = sku_input.reversion_request(
        int(config.get(REVERSION_HORIZON_DAYS, ctx))
    )
    if reversion_req is not None:
        rv = revert(reversion_req, ctx, config)
        if not rv.ok or rv.value is None:
            return rv
        reversion = rv.value
        theta_own = reversion.rate_per_open_day

    # 06 - the two, weighted by n. No branch on either.
    bl = blend(
        BlendRequest(
            pattern=canon,
            n=count.n,
            theta_own=theta_own,
            theta_cohort=prior.value,
            cohort_level=prior.cohort_level,
            cohort_size=prior.cohort_size,
            dispersion_cv_pct=prior.dispersion.cv_pct,
        ),
        ctx,
        config,
    )
    if not bl.ok or bl.value is None:
        return bl
    blended = bl.value

    estimate = Estimate(
        sku=sku_input.sku,
        pattern=canon,
        value=blended.value,
        n=blended.n,
        k=blended.k,
        own_weight=blended.own_weight,
        theta_own=blended.theta_own,
        theta_cohort=blended.theta_cohort,
        evidence_state=blended.evidence_state,
        sufficiency=count.sufficiency,
        cohort_level=prior.cohort_level,
        cohort_size=prior.cohort_size,
        cohort_basis=prior.basis,
        specificity=prior.specificity,
        dispersion_cv_pct=prior.dispersion.cv_pct,
        explanation=blended.explain(),
        reversion=reversion,
    )
    return StageResult.success(
        estimate,
        Provenance(
            own_observations=blended.n,
            cohort_level=prior.cohort_level,
            cohort_size=prior.cohort_size,
            own_weight=blended.own_weight,
            evidence_state=blended.evidence_state,
            inputs=("feature_daily", "feature_store_day", "client_locations.state"),
        ),
    )


def estimate_store(
    estate: EstateInput,
    skus: Sequence[SkuInput],
    pattern: str,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> list[Estimate]:
    """Every SKU of one store. Failures are dropped, never faked.

    A stage that returns ok=False has said it cannot answer; substituting a
    number here would turn a known unknown into a confident wrong answer, which
    is the failure mode this whole rebuild exists to remove.
    """
    out: list[Estimate] = []
    for sku_input in skus:
        result = estimate_sku(
            EstimateRequest(estate=estate, sku=sku_input, pattern=pattern),
            ctx, config,
        )
        # `ok` alone does not narrow `value` - a successful stage with a None
        # payload would append None and only fail much later, at the point
        # something tried to read a field off it.
        if result.ok and result.value is not None:
            out.append(result.value)
    return out


# ── Sheet 07 joins on here ───────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ForecastedSku:
    """The whole chain for one SKU: 07 -> 04 -> 05 -> 06 -> 07.

    `estimate` is the blended RATE (units per open day). `forecast` is that
    rate turned into a horizon total with an interval, by the method the
    demand CLASS selects. Either may be absent: a SKU can be estimable but
    unforecastable (a lumpy interval too wide to act on), and that is a
    result, not an error.
    """

    sku: str
    demand_class: str
    estimate: Estimate | None
    forecast: Any | None
    refused_reason: str | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "sku": self.sku,
            "demand_class": self.demand_class,
            "estimate": self.estimate.as_dict() if self.estimate else None,
            "forecast": self.forecast.as_dict() if self.forecast else None,
            "refused_reason": self.refused_reason,
        }


def estimate_and_forecast(
    estate: EstateInput,
    skus: Sequence[SkuInput],
    pattern: str,
    horizon_open_days: int,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
    open_days_per_week: int = 7,
) -> list[ForecastedSku]:
    """The full engine for one store, as one call.

    ORDER MATTERS, AND IT IS CLASSIFY FIRST.
        The demand class decides which forecaster runs, so it has to be known
        before the forecast - but it plays no part in the LEVEL, which comes
        from 04-05-06 exactly as before. Shape and level are separate
        questions and sheet 07 deliberately only answers the first.

    THE COLD-START JOIN.
        A `new_sku` has no own history to forecast from, so its level is the
        blend's - which, at n=0, IS the cohort prior, reached without a
        branch. Sheet 07 does not re-implement cold start; it consumes sheet
        06's answer.
    """
    # Imported here rather than at module scope: `storeagent` imports from
    # `app.pipeline`, so a top-level import would close the cycle.
    from storeagent.forecasting.classify import ClassifyRequest, classify
    from storeagent.forecasting.ensemble import ForecastRequest, forecast

    out: list[ForecastedSku] = []
    for sku_input in skus:
        classified = classify(
            ClassifyRequest(
                sku=sku_input.sku,
                calendar=estate.calendar,
                facts=estate.facts,
                window_days=estate.window_days,
            ),
            ctx, config,
        )
        if not classified.ok or classified.value is None:
            continue
        profile = classified.value

        estimated = estimate_sku(
            EstimateRequest(estate=estate, sku=sku_input, pattern=pattern),
            ctx, config,
        )
        estimate = estimated.value if estimated.ok else None

        # Units per OPEN day, dense, for the ETS path.
        open_dates = [
            c.obs_date for c in sorted(estate.calendar, key=lambda c: c.obs_date)
            if c.was_open and c.has_data
        ]
        by_day: dict[Any, float] = {}
        for fact in estate.facts:
            if fact.sku != sku_input.sku:
                continue
            units = float(fact.units_sold or 0.0)
            if units > 0:
                by_day[fact.obs_date] = by_day.get(fact.obs_date, 0.0) + units
        series = [by_day.get(day, 0.0) for day in open_dates]

        predicted = forecast(
            ForecastRequest(
                profile=profile,
                horizon_open_days=horizon_open_days,
                series=series,
                open_days_per_week=open_days_per_week,
                # THE JOIN: sheet 06's blended rate is what a new SKU is
                # forecast from. At n=0 that value is the cohort prior exactly.
                cohort_level=estimate.value if estimate else None,
                cohort_cv_pct=estimate.dispersion_cv_pct if estimate else None,
            ),
            ctx, config,
        )

        out.append(ForecastedSku(
            sku=sku_input.sku,
            demand_class=profile.demand_class,
            estimate=estimate,
            forecast=predicted.value if predicted.ok else None,
            refused_reason=None if predicted.ok else (
                predicted.reasons[0] if predicted.reasons else "refused"
            ),
        ))
    return out


__all__ = [
    "EstateInput",
    "Estimate",
    "EstimateRequest",
    "ForecastedSku",
    "SkuInput",
    "estimate_and_forecast",
    "estimate_sku",
    "estimate_store",
]
