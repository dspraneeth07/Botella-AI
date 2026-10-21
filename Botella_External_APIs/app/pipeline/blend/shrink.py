"""Shrinkage — where cold start stops being a special case and becomes a weight.

    θ̂ = (n · θ_own + k · θ_cohort) / (n + k)

    n = 0    →  θ̂ = θ_cohort exactly.  a brand-new store. NO BRANCH TAKEN.
    n = k    →  θ̂ = the midpoint.       an emerging store.
    n >> k   →  θ̂ ≈ θ_own.              a mature store. SAME THREE LINES.

This is the smallest module in the programme and the one that makes the
architecture work. Forty lines of arithmetic replace what would otherwise be a
tier system with branches, and branches for rare cases are exactly the code
that never gets tested and rots.

WHAT IS NOT WRITTEN HERE, AND IT WAS TEMPTING:

    if store.tier == "T0": return cohort_estimate(...)
    if n == 0:             return theta_cohort
    if store.is_new:       ...

A tier gate creates a **cliff**: a store crossing the boundary sees its
recommendations jump overnight for no reason it can observe. And it creates a
code path only cold-start stores exercise, so it is never tested — which is
how the rare case becomes the broken case.

`blend()` therefore contains **no conditional of any kind**, and that is
asserted by a test which walks its AST looking for `If`, `IfExp` and `Match`
nodes. The formula handles every case because the formula IS every case.

THE ONE GUARD, AND WHY IT IS NOT A BRANCH ON DATA
`k_for_pattern` refuses a non-positive k. That is *configuration validation* —
it fires on a misconfigured registry, identically for every store, and never
on the shape of a store's data. With k >= 1 the denominator `n + k` cannot be
zero for any n >= 0, so `blend()` needs no guard at all.

θ_own WHEN THERE IS NOTHING OF IT
A store with n=0 has no own estimate. The value is still required by the
formula, where it is multiplied by n — i.e. by zero — and annihilated.
`BlendRequest` normalises a missing θ_own to 0.0 once, at the boundary, so the
hot path stays branchless. The test
`test_theta_own_is_annihilated_when_n_is_zero` proves the substitution cannot
matter by trying absurd values and getting the same answer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.pipeline.blend.evidence_state import (
    cohort_weight_for,
    evidence_state_for,
    own_weight_for,
)
from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

# ── k, per pattern, from the registry ────────────────────────────────────────
# NEVER a literal in the arithmetic. The current engine acquired 63 unexamined
# constants exactly by writing a plausible number inline and calling it done.
# Every k below starts PROVISIONAL and is fitted in wave 6 from holdout WAPE:
# the right k is the one that minimises error across the estate, and it will
# differ between day-of-week and seasonality because the patterns differ in how
# fast a single store's own data becomes trustworthy.

K_DAY_OF_WEEK = Setting(
    name="shrink.k.day_of_week",
    default=8,
    unit="observations",
    owner="blending",
    why="provisional; a weekday shape stabilises fast - eight same-weekday "
        "observations is two months of a weekly cycle. To be fitted from "
        "holdout WAPE per pattern in wave 6",
    status="PROVISIONAL",
)

K_WEEKLY_TREND = Setting(
    name="shrink.k.weekly_trend",
    default=13,
    unit="complete weeks",
    owner="forecasting",
    why="provisional; a quarter of weeks before a store's own trend outweighs "
        "its cohort's. To be fitted in wave 6",
    status="PROVISIONAL",
)

K_MONTHLY_SEASONALITY = Setting(
    name="shrink.k.monthly_seasonality",
    default=3,
    unit="complete years covering the month",
    owner="forecasting",
    why="provisional; seasonality is the pattern where own data is scarcest "
        "and the cohort matters most - most of the estate has fewer than two "
        "years. A low k in YEARS is still a high bar. To be fitted in wave 6",
    status="PROVISIONAL",
)

K_SKU_VELOCITY = Setting(
    name="shrink.k.sku_velocity",
    default=21,
    unit="open days with a known price",
    owner="forecasting",
    why="provisional; intermittent SKUs are the majority, so this k is high on "
        "purpose - it keeps a handful of noisy days from overriding a cohort "
        "of 60 stores. To be fitted in wave 6",
    status="PROVISIONAL",
)

K_CATEGORY_SHARE = Setting(
    name="shrink.k.category_share",
    default=14,
    unit="open days with a sale in the category",
    owner="forecasting",
    why="provisional; category mix moves slowly and pools across SKUs, so a "
        "store's own share becomes reliable sooner than a single SKU's rate. "
        "To be fitted in wave 6",
    status="PROVISIONAL",
)

K_ELASTICITY = Setting(
    name="shrink.k.elasticity",
    default=30,
    unit="distinct observed price levels",
    owner="forecasting",
    why="provisional, and the HIGHEST k in the programme on purpose. Retail "
        "price variation is largely confounded with promotions, seasonality "
        "and competitor moves, so a single store's own beta is the least "
        "trustworthy quantity we estimate - it needs a great deal of its own "
        "evidence before it should outweigh a cohort. To be fitted in wave 6",
    status="PROVISIONAL",
)

K_BY_PATTERN: dict[str, Setting[int]] = {
    "elasticity": K_ELASTICITY,
    "day_of_week": K_DAY_OF_WEEK,
    "weekly_trend": K_WEEKLY_TREND,
    "monthly_seasonality": K_MONTHLY_SEASONALITY,
    "sku_velocity": K_SKU_VELOCITY,
    "category_share": K_CATEGORY_SHARE,
}

PATTERNS: tuple[str, ...] = tuple(K_BY_PATTERN)


def k_for_pattern(pattern: str, ctx: RunContext, config: ConfigRegistry = cfg) -> int:
    """The shrinkage constant for this pattern, from the registry.

    Raises on an unknown pattern or a non-positive k. Both are CONFIGURATION
    errors — they fire identically for every store and never on the shape of a
    store's data — which is why they are exceptions rather than an `ok=False`
    outcome, and why they are not the branch this module forbids.
    """
    setting = K_BY_PATTERN.get(pattern)
    if setting is None:
        raise ValueError(f"unknown pattern {pattern!r}; expected one of {PATTERNS}")
    k = config.get(setting, ctx)
    if k <= 0:
        raise ValueError(
            f"{setting.name} must be positive, got {k}. k is the weight given "
            "to the cohort; at zero the formula would divide by n and a "
            "brand-new store would divide by zero."
        )
    return int(k)


# ── Request / result ─────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class BlendRequest:
    """One quantity to blend. Everything already computed upstream."""

    pattern: str
    #: Usable observations — sheet 04. NOT row count.
    n: int
    #: This store's own estimate. None when n = 0, where it is annihilated.
    theta_own: float | None
    #: The prior — sheet 05. Always present: the ladder always resolves.
    theta_cohort: float
    #: Carried through to provenance so the card can name the cohort.
    cohort_level: str | None = None
    cohort_size: int | None = None
    #: Sheet 05's dispersion, carried for sheet 07's interval width.
    dispersion_cv_pct: int | None = None

    #: `theta_own` normalised to a definite float, derived once at the
    #: boundary. A SEPARATE field rather than a rewrite of theta_own, because
    #: the caller's contract genuinely allows None and the arithmetic's
    #: genuinely does not - collapsing the two would have left the annotation
    #: lying about the value, which mypy correctly refused to accept.
    own_estimate: float = field(init=False, default=0.0)

    def __post_init__(self) -> None:
        if self.n < 0:
            raise ValueError(f"n must be >= 0, got {self.n}")
        # Normalise ONCE, at the boundary, so the hot path is branchless. When
        # n = 0 this value is multiplied by zero and cannot affect the result;
        # test_theta_own_is_annihilated_when_n_is_zero proves it.
        object.__setattr__(self, "own_estimate", float(self.theta_own or 0.0))
        object.__setattr__(self, "theta_cohort", float(self.theta_cohort))


@dataclass(frozen=True, slots=True)
class Blended:
    """The blended estimate, and the arithmetic that produced it."""

    pattern: str
    value: float
    n: int
    k: int
    own_weight: float
    cohort_weight: float
    theta_own: float
    theta_cohort: float
    #: DISPLAY ONLY. Nothing may branch on it.
    evidence_state: str
    cohort_level: str | None
    cohort_size: int | None
    dispersion_cv_pct: int | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "pattern": self.pattern, "value": self.value, "n": self.n, "k": self.k,
            "own_weight": self.own_weight, "cohort_weight": self.cohort_weight,
            "theta_own": self.theta_own, "theta_cohort": self.theta_cohort,
            "evidence_state": self.evidence_state,
            "cohort_level": self.cohort_level, "cohort_size": self.cohort_size,
            "dispersion_cv_pct": self.dispersion_cv_pct,
        }

    def explain(self) -> str:
        """The sentence the store-facing card says out loud."""
        own_pct = int(round(100 * self.own_weight))
        cohort = (
            f"{self.cohort_size} similar stores"
            + (f" ({self.cohort_level})" if self.cohort_level else "")
            if self.cohort_size else "similar stores"
        )
        return (
            f"Based {own_pct}% on your own sales ({self.n} observations) "
            f"and {100 - own_pct}% on {cohort}."
        )


# ── The keystone ─────────────────────────────────────────────────────────────


@stage("shrink_blend", "1.0.0")
def blend(
    request: BlendRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """θ̂ = (n·θ_own + k·θ_cohort) / (n + k).

    No branch on data availability. Not on n, not on a tier, not on whether the
    store is new. A brand-new store and a four-year-old store execute the same
    three lines; the only difference is the value of n.
    """
    record_inputs("evidence.n", "priors.theta_cohort")

    k = k_for_pattern(request.pattern, ctx, config)
    n = request.n
    theta_own = request.own_estimate
    theta_cohort = request.theta_cohort

    # The whole sheet.
    theta_hat = (n * theta_own + k * theta_cohort) / (n + k)

    own_weight = own_weight_for(n, k)
    blended = Blended(
        pattern=request.pattern,
        value=theta_hat,
        n=n,
        k=k,
        own_weight=own_weight,
        cohort_weight=cohort_weight_for(n, k),
        theta_own=theta_own,
        theta_cohort=theta_cohort,
        evidence_state=evidence_state_for(n, k, ctx, config),
        cohort_level=request.cohort_level,
        cohort_size=request.cohort_size,
        dispersion_cv_pct=request.dispersion_cv_pct,
    )

    provenance = Provenance(
        own_observations=n,
        cohort_level=request.cohort_level,  # type: ignore[arg-type]
        cohort_size=request.cohort_size,
        # THE field the card reads: how much of this was the store's own data.
        own_weight=own_weight,
        evidence_state=blended.evidence_state,  # type: ignore[arg-type]
        inputs=("evidence.n", "priors.theta_cohort"),
    )
    return StageResult.success(blended, provenance)


__all__ = [
    "K_BY_PATTERN",
    "K_CATEGORY_SHARE",
    "K_DAY_OF_WEEK",
    "K_ELASTICITY",
    "K_MONTHLY_SEASONALITY",
    "K_SKU_VELOCITY",
    "K_WEEKLY_TREND",
    "PATTERNS",
    "BlendRequest",
    "Blended",
    "blend",
    "k_for_pattern",
]
