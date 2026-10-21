"""The cohort prior engine — what we tell a store that opened yesterday.

Without this, a zero-data store gets nothing, or — worse, and this is what the
current engine does — gets something invented with no stated basis.

`estimate_prior` **always resolves**. No input may cause it to return
`ok=False` for lack of a cohort. That is not politeness: if it could fail,
every downstream stage would need a branch for "no prior available", and
eliminating exactly that branch is the point of the architecture. The untested
error path is the one that breaks in production at 3am for the store that
signed up yesterday.

EVERY RETURN CARRIES, in Provenance:
    cohort_level   which rung answered (state / region / national)
    cohort_size    how many distinct STORES stood behind it
    own_weight     0.0 — a prior is borrowed evidence, never the store's own
and, on the value, DISPERSION across peers. Sheet 07 turns dispersion into
interval width: a prior drawn from peers who disagree wildly must produce a
wide interval, and one drawn from peers who agree a narrow one. A point
estimate without dispersion is the same false confidence this rebuild exists
to remove, one level up.

THE ONE CASE WHERE NO REAL COHORT EXISTS. If even the terminal rung
(national × all_products) cannot clear k, the function still resolves — with a
STRUCTURAL DEFAULT, `basis="structural_default"`, `cohort_size=0` and
`evidence_state="NEW"`. It is marked as not-evidence precisely so nothing
downstream mistakes it for a measurement. Resolving and being honest about
what resolved are not in tension; returning `ok=False` would have been the
dishonest option, because it would push the decision into an error path nobody
tests.
"""

from __future__ import annotations

import statistics
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.priors import kanon
from app.pipeline.priors.kanon import CohortObservation
from app.pipeline.priors.ladder import (
    PATTERNS,
    Rung,
    members_for,
    region_for,
    rungs_for,
)
from app.pipeline.provenance import EvidenceState, Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

PERCENT = 100

# ── Settings ─────────────────────────────────────────────────────────────────

MIN_OBSERVATIONS_PER_STORE = Setting(
    name="priors.min_observations_per_store",
    default=1,
    unit="observations",
    owner="priors",
    why="a store contributes to a cohort only with at least this many usable "
        "observations. One is deliberate: sheet 04 already decides whether a "
        "store's own evidence is sufficient, and double-filtering here would "
        "shrink cohorts twice for the same reason",
    status="PROVISIONAL",
)

HIGH_DISPERSION_CV_PCT = Setting(
    name="priors.dispersion.high_cv_pct",
    default=60,
    unit="percent - coefficient of variation",
    owner="priors",
    why="provisional; above 60% CV the peers disagree enough that the prior is "
        "weak information. Sheet 07 widens the interval; this flag is what "
        "makes that visible in the reasons. To be fitted in wave 6",
    status="PROVISIONAL",
)

STRUCTURAL_DEFAULT_VALUE = Setting(
    name="priors.structural_default_value",
    default=0,
    unit="the pattern's own unit",
    owner="priors",
    why="the value returned when even the national cohort cannot clear k. "
        "Zero, and marked basis=structural_default with cohort_size=0, so "
        "nothing downstream mistakes it for a measurement. Changing it to a "
        "non-zero guess would be inventing a number with no basis, which is "
        "the behaviour this sheet exists to end",
    status="PROVISIONAL",
)


# ── Request / result ─────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class PriorRequest:
    """Everything the ladder needs. Supplied, never fetched.

    `observations` maps a rung's unit key to per-store observations:

        sku_velocity    {"0245": [CohortObservation(...), ...]}
        category_share  {"whiskey": [...]}
        all_products    {"*": [...]}

    The caller assembles it from the feature store; the stage stays pure and
    replayable.
    """

    store_key: tuple[int, int]
    pattern: str
    #: (store_key, state) for every store that could be a cohort member.
    candidates: Sequence[tuple[tuple[int, int], str | None]]
    #: unit key -> observations, one or more per store.
    observations: Mapping[str, Sequence[CohortObservation]]
    subject_state: str | None = None
    sku: str | None = None
    category: str | None = None
    #: Exclude the subject store from its own cohort. True when the point is
    #: specifically to borrow (cold start); False when blending own + peers.
    exclude_self: bool = True

    def __post_init__(self) -> None:
        if self.pattern not in PATTERNS:
            raise ValueError(f"unknown pattern {self.pattern!r}; expected {PATTERNS}")


@dataclass(frozen=True, slots=True)
class Dispersion:
    """How much the peers disagree. Sheet 07 turns this into interval width."""

    #: Coefficient of variation as an integer percent. Scale-free, so a cohort
    #: of corner shops and one of superstores are comparable.
    cv_pct: int | None
    #: Robust alternative, preferred on small skewed cohorts.
    iqr: float | None
    iqr_over_median_pct: int | None
    p25: float | None
    p50: float | None
    p75: float | None
    high_dispersion: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "cv_pct": self.cv_pct, "iqr": self.iqr,
            "iqr_over_median_pct": self.iqr_over_median_pct,
            "p25": self.p25, "p50": self.p50, "p75": self.p75,
            "high_dispersion": self.high_dispersion,
        }


@dataclass(frozen=True, slots=True)
class Prior:
    """The answer. Always produced."""

    pattern: str
    value: float
    #: Median, because cohorts are small and one outlier store should not move
    #: the prior. The mean is reported alongside for comparison.
    basis: str            # cohort | structural_default
    cohort_level: str     # state | region | national
    specificity: str      # sku | category | all_products
    unit_key: str
    cohort_size: int
    observations: int
    dispersion: Dispersion
    mean: float | None
    rungs_tried: tuple[str, ...]
    rungs_rejected: dict[str, str] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "pattern": self.pattern, "value": self.value, "basis": self.basis,
            "cohort_level": self.cohort_level, "specificity": self.specificity,
            "unit_key": self.unit_key, "cohort_size": self.cohort_size,
            "observations": self.observations,
            "dispersion": self.dispersion.as_dict(), "mean": self.mean,
            "rungs_tried": list(self.rungs_tried),
            "rungs_rejected": dict(self.rungs_rejected),
        }


# ── Dispersion ───────────────────────────────────────────────────────────────


def measure_dispersion(
    values: Sequence[float], ctx: RunContext, config: ConfigRegistry = cfg
) -> Dispersion:
    """CV and IQR over the cohort's per-store values.

    Both are reported. CV is scale-free and familiar; IQR is robust, which
    matters more here because cohorts are small and one unusual store can
    double a standard deviation. Sheet 07 chooses.
    """
    high_cv = config.get(HIGH_DISPERSION_CV_PCT, ctx)
    ordered = sorted(float(v) for v in values)
    if not ordered:
        return Dispersion(None, None, None, None, None, None, False)

    p50 = statistics.median(ordered)
    mean = statistics.fmean(ordered)

    if len(ordered) < 2:
        # One store cannot disagree with itself. Dispersion is unknown, not
        # zero — reporting zero would claim perfect agreement from a single
        # observation and produce a confidently narrow interval downstream.
        return Dispersion(None, None, None, None, p50, None, False)

    quantiles = statistics.quantiles(ordered, n=4, method="inclusive")
    p25, p75 = quantiles[0], quantiles[2]
    iqr = p75 - p25
    stdev = statistics.stdev(ordered)

    cv_pct = int(round(PERCENT * stdev / abs(mean))) if mean else None
    iqr_pct = int(round(PERCENT * iqr / abs(p50))) if p50 else None

    return Dispersion(
        cv_pct=cv_pct, iqr=round(iqr, 6), iqr_over_median_pct=iqr_pct,
        p25=round(p25, 6), p50=round(p50, 6), p75=round(p75, 6),
        high_dispersion=cv_pct is not None and cv_pct > high_cv,
    )


def _unit_key_for(request: PriorRequest, rung: Rung) -> str:
    if rung.specificity == "sku":
        return request.sku or ""
    if rung.specificity == "category":
        return request.category or ""
    return "*"


def _per_store_values(
    observations: Sequence[CohortObservation], min_per_store: int
) -> list[CohortObservation]:
    """Collapse to ONE value per store, by median.

    A store with 300 observations must not outvote one with 3: the cohort is a
    cohort of STORES. Collapsing first is also what makes k mean what it says
    — otherwise a two-store cohort with 500 rows would sail past any row-count
    check.
    """
    grouped: dict[tuple[int, int], list[float]] = {}
    for o in observations:
        grouped.setdefault(o.store_key, []).append(float(o.value))
    return [
        CohortObservation(store_key=key, value=statistics.median(values), weight=1.0)
        for key, values in sorted(grouped.items())
        if len(values) >= min_per_store
    ]


# ── The engine ───────────────────────────────────────────────────────────────


@stage("estimate_prior", "1.0.0")
def estimate_prior(
    request: PriorRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Climb the ladder until a rung clears k-anonymity. ALWAYS resolves.

    Returns `ok=True` in every case, including the one where no real cohort
    exists anywhere — see the module docstring for why failing would be the
    dishonest choice.
    """
    record_inputs("feature_daily.units_sold", "client_locations.state")

    min_per_store = config.get(MIN_OBSERVATIONS_PER_STORE, ctx)
    has_region = region_for(request.subject_state) is not None
    ladder = rungs_for(request.pattern, has_region=has_region)

    tried: list[str] = []
    rejected: dict[str, str] = {}

    for rung in ladder:
        tried.append(rung.label)
        unit_key = _unit_key_for(request, rung)
        if not unit_key:
            rejected[rung.label] = f"no_{rung.specificity}_supplied"
            continue

        members = set(members_for(rung, request.subject_state, request.candidates))
        if request.exclude_self:
            members.discard(request.store_key)
        if not members:
            rejected[rung.label] = "no_stores_at_this_level"
            continue

        raw = [
            o for o in request.observations.get(unit_key, ())
            if o.store_key in members
        ]
        per_store = _per_store_values(raw, min_per_store)

        verdict = kanon.check(per_store, ctx, config)
        if not verdict.ok:
            # CLIMB. Never return a thin cohort - that is the legal boundary.
            rejected[rung.label] = verdict.reason or "k_anonymity"
            continue

        values = [o.value for o in per_store]
        dispersion = measure_dispersion(values, ctx, config)
        # Median, not mean: cohorts are small and one outlier store should not
        # move the prior.
        value = statistics.median(values)

        prior = Prior(
            pattern=request.pattern, value=round(value, 6), basis="cohort",
            cohort_level=rung.geo_level, specificity=rung.specificity,
            unit_key=unit_key, cohort_size=verdict.distinct_stores,
            observations=len(raw), dispersion=dispersion,
            mean=round(statistics.fmean(values), 6),
            rungs_tried=tuple(tried), rungs_rejected=dict(rejected),
        )
        return _success(prior, rung, dispersion, verdict.distinct_stores, ctx, config)

    # Nothing cleared k anywhere, including the terminal rung. Resolve anyway,
    # visibly marked as not a measurement.
    default_value = float(config.get(STRUCTURAL_DEFAULT_VALUE, ctx))
    prior = Prior(
        pattern=request.pattern, value=default_value, basis="structural_default",
        cohort_level="national", specificity="all_products", unit_key="*",
        cohort_size=0, observations=0,
        dispersion=Dispersion(None, None, None, None, None, None, False),
        mean=None, rungs_tried=tuple(tried), rungs_rejected=dict(rejected),
    )
    provenance = Provenance(
        own_observations=0,
        cohort_level="national",
        cohort_size=0,
        own_weight=0.0,
        evidence_state="NEW",
        inputs=("client_locations.state",),
    )
    return StageResult.success(
        prior, provenance,
        reasons=("structural_default:no_cohort_cleared_k_at_any_rung",),
    )


def _success(
    prior: Prior, rung: Rung, dispersion: Dispersion, cohort_size: int,
    ctx: RunContext, config: ConfigRegistry,
) -> StageResult:
    k = config.get(kanon.K_ANONYMITY_MIN, ctx)
    evidence: EvidenceState = (
        "MATURE" if cohort_size >= k * 4
        else "ESTABLISHED" if cohort_size >= k * 2
        else "EMERGING"
    )
    provenance = Provenance(
        own_observations=0,          # a prior is never the store's OWN evidence
        cohort_level=rung.geo_level,
        cohort_size=cohort_size,
        own_weight=0.0,
        evidence_state=evidence,
        inputs=("feature_daily.units_sold", "client_locations.state"),
    )
    reasons: list[str] = [f"cohort:{rung.label}:{cohort_size}_stores"]
    if rung.specificity != "sku" and prior.pattern == "sku_velocity":
        # Worth saying plainly: the answer is about the category, not the SKU.
        reasons.append(f"widened_to_{rung.specificity}:sku_cohort_below_k")
    if dispersion.high_dispersion:
        reasons.append(f"high_dispersion:cv_{dispersion.cv_pct}pct")
    return StageResult.success(prior, provenance, reasons=tuple(reasons))


__all__ = [
    "HIGH_DISPERSION_CV_PCT",
    "MIN_OBSERVATIONS_PER_STORE",
    "STRUCTURAL_DEFAULT_VALUE",
    "Dispersion",
    "Prior",
    "PriorRequest",
    "estimate_prior",
    "measure_dispersion",
]
