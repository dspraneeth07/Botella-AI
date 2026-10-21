"""The refusal. No card may cite a price effect on an interval spanning zero.

    beta = -1.8  [-2.4, -1.2]   -> a markdown may claim a volume response
    beta = -0.3  [-1.1, +0.5]   -> it may NOT, and the card is withheld

WHY THIS IS THE IMPORTANT HALF
    Retail price variation is mostly confounded with promotions, seasonality
    and competitor moves. Honest elasticity estimates on this data will
    FREQUENTLY have intervals spanning zero. That restraint is worth more than
    a fabricated number, and it is the whole reason the sheet is worth
    building even though it is marked optional.

    An interval spanning zero does not mean "no effect". It means the data
    cannot distinguish a price cut that raises volume from one that lowers it.
    A recommendation that says "drop the price, volume will more than
    compensate" on that evidence is not a cautious claim - it is a coin flip
    written in the imperative.

WHAT COUNTS AS CITING A PRICE EFFECT
    Any recommendation whose value proposition depends on volume responding
    to price: `markdown`, `liquidate`, and `bundle` (a bundle is a discount
    wearing a different hat). Those three make the claim, so those three need
    the evidence.

    `reorder`, `pre_stock`, `promote`, `endcap`, `cold_box` and `stock_new`
    do NOT - their claim is about availability or attention, not about a
    demand curve. Blocking them on an elasticity they never cited would be a
    different kind of dishonesty, and a store whose prices happen not to vary
    would lose recommendations it was entitled to.

A REFUSAL IS NOT A FAILURE
    `guard` returns ok=False for a blocked claim, with a reason an owner can
    read. The pipeline treats that exactly as sheet 02 treats a missing cost:
    the card is withheld and the reason is recorded, never shown as a blank or
    quietly rounded to a weaker claim.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.elasticity.estimate import UNIT_ELASTIC, Elasticity
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

#: Families whose value proposition IS a price-response claim. These need a
#: usable beta; everything else does not and must not be blocked on one.
PRICE_EFFECT_FAMILIES: frozenset[str] = frozenset({
    "markdown",    # "cut the price and the volume more than compensates"
    "liquidate",   # the same claim, at a steeper discount
    "bundle",      # a discount wearing a different hat
})

MIN_OWN_WEIGHT_TO_CITE = Setting(
    name="elasticity.min_own_weight_to_cite",
    default=0,
    unit="own weight, percent",
    owner="forecasting",
    why="provisional, and deliberately ZERO to start. A cohort-dominated beta "
        "is still a real estimate - that is what sheets 05 and 06 are for, and "
        "the card already says what fraction is the store's own. Raising this "
        "above zero would mean refusing to borrow, which contradicts the "
        "cold-start architecture. It exists so the choice is visible and "
        "measurable rather than implicit",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class GuardRequest:
    """One recommendation's price claim, and the evidence for it."""

    family: str
    category: str
    #: None means no estimate was produced at all - which is a refusal for a
    #: price-effect family, not a pass.
    elasticity: Elasticity | None


@dataclass(frozen=True, slots=True)
class PriceClaimVerdict:
    """Whether this card may cite a price effect, and why not if not."""

    family: str
    category: str
    may_cite: bool
    reason: str | None
    beta: float | None
    interval_low: float | None
    interval_high: float | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "family": self.family, "category": self.category,
            "may_cite": self.may_cite, "reason": self.reason,
            "beta": self.beta,
            "interval_low": self.interval_low,
            "interval_high": self.interval_high,
        }

    def explain(self) -> str:
        if self.may_cite:
            return (
                f"A {self.family} in {self.category} may cite a price effect: "
                f"beta {self.beta:.2f} "
                f"({self.interval_low:.2f} to {self.interval_high:.2f})."
            )
        return (
            f"No {self.family} recommendation for {self.category}: we cannot "
            "show that cutting the price here actually moves volume."
        )


@stage("elasticity_guard", "1.0.0")
def guard_price_claim(
    request: GuardRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """May this card cite a price effect?

    ok=False is the REFUSAL, carrying a reason. It is not an error and nothing
    upstream should retry it - the answer will be the same tomorrow unless the
    store's prices start moving.
    """
    record_inputs("elasticity_estimate.beta", "elasticity_estimate.interval")

    family = request.family

    # Families that never make a price-response claim pass straight through.
    # Blocking them on an elasticity they never cited would cost a store
    # recommendations it was entitled to.
    if family not in PRICE_EFFECT_FAMILIES:
        verdict = PriceClaimVerdict(
            family=family, category=request.category, may_cite=True,
            reason="family_makes_no_price_claim",
            beta=None, interval_low=None, interval_high=None,
        )
        return StageResult.success(verdict, _provenance(request.elasticity))

    estimate = request.elasticity
    if estimate is None:
        return StageResult.failure(
            "no_elasticity_estimate:price_claim_unsupported",
            provenance=_provenance(None),
        )

    interval = estimate.interval
    bounds = f"[{interval.low:.3f},{interval.high:.3f}]"

    if interval.spans_zero:
        # THE refusal. Stated with both ends so the reason is checkable.
        return StageResult.failure(
            f"elasticity_interval_spans_zero:{bounds}"
            f"_beta={estimate.beta:.3f}_levels={estimate.n_price_levels}",
            provenance=_provenance(estimate),
        )

    if not interval.entirely_below_zero:
        # A POSITIVE elasticity. Not a pass, and not the same refusal.
        #
        # An interval entirely above zero does not span zero, so a naive
        # spans-zero test lets it through - and it is evidence AGAINST the
        # claim it would be cited for. Found on real data: store 122's
        # Tobacco is +0.38 [+0.15,+0.61] and store 125's CIGAR is +0.76
        # [+0.51,+1.02]. Almost certainly confounding (retail prices rise in
        # exactly the periods demand is already high), but either way it is
        # not a reason to discount.
        return StageResult.failure(
            f"elasticity_is_positive:{bounds}_beta={estimate.beta:.3f}"
            "_cutting_price_is_not_supported",
            provenance=_provenance(estimate),
        )

    unit_elastic = config.get(UNIT_ELASTIC, ctx)
    if not interval.entirely_below(-float(unit_elastic)):
        # INELASTIC. Statistically real, economically a loss.
        #
        # The binding constraint on real data, and not the one the sheet
        # anticipated: 79 of the 84 cells whose interval excluded zero were
        # still inside unit elasticity. A markdown claims volume will "more
        # than compensate"; at |beta| < 1 it demonstrably does not.
        return StageResult.failure(
            f"elasticity_is_inelastic:{bounds}_beta={estimate.beta:.3f}"
            f"_needs_stronger_than_-{unit_elastic}"
            "_a_cut_here_loses_revenue",
            provenance=_provenance(estimate),
        )

    min_own_weight = config.get(MIN_OWN_WEIGHT_TO_CITE, ctx)
    if estimate.own_weight * 100 < min_own_weight:
        return StageResult.failure(
            f"elasticity_too_borrowed:own_weight="
            f"{estimate.own_weight * 100:.0f}%<{min_own_weight}%",
            provenance=_provenance(estimate),
        )

    verdict = PriceClaimVerdict(
        family=family, category=request.category, may_cite=True, reason=None,
        beta=estimate.beta,
        interval_low=estimate.interval.low,
        interval_high=estimate.interval.high,
    )
    return StageResult.success(verdict, _provenance(estimate))


def blocked_categories(
    estimates: Mapping[str, Elasticity | None],
) -> frozenset[str]:
    """Categories where no price-effect card may be shown.

    A set rather than a per-card call so the decision-validation stage can
    filter a whole run in one pass, and so "which categories are blocked" is
    one auditable value rather than a property recomputed per recommendation.
    """
    return frozenset(
        category for category, estimate in estimates.items()
        if estimate is None or not estimate.usable
    )


def filter_price_claims(
    recommendations: Sequence[Mapping[str, Any]],
    estimates: Mapping[str, Elasticity | None],
) -> tuple[list[Mapping[str, Any]], list[tuple[Mapping[str, Any], str]]]:
    """Split a run into (allowed, withheld-with-reason).

    Withheld rather than dropped: sheet 02 established that a refusal nobody
    can explain is just a different kind of unexplainable output, so the
    reason travels with the card.
    """
    blocked = blocked_categories(estimates)
    allowed: list[Mapping[str, Any]] = []
    withheld: list[tuple[Mapping[str, Any], str]] = []
    for rec in recommendations:
        family = str(rec.get("action_type") or "")
        category = str(rec.get("category") or "")
        if family in PRICE_EFFECT_FAMILIES and category in blocked:
            estimate = estimates.get(category)
            if estimate is None:
                reason = "no_elasticity_estimate"
            else:
                bounds = (f"[{estimate.interval.low:.3f},"
                          f"{estimate.interval.high:.3f}]")
                reason = (
                    f"elasticity_interval_spans_zero:{bounds}"
                    if estimate.interval.spans_zero
                    else f"elasticity_is_positive:{bounds}"
                )
            withheld.append((rec, reason))
        else:
            allowed.append(rec)
    return allowed, withheld


def _provenance(estimate: Elasticity | None) -> Provenance:
    if estimate is None:
        return Provenance(
            own_observations=0, own_weight=1.0, evidence_state="NEW",
            inputs=("elasticity_estimate.beta", "elasticity_estimate.interval"),
        )
    return Provenance(
        own_observations=estimate.n_price_levels,
        own_weight=estimate.own_weight,
        cohort_level=estimate.cohort_level,  # type: ignore[arg-type]
        cohort_size=estimate.cohort_size,
        evidence_state="ESTABLISHED",
        inputs=("elasticity_estimate.beta", "elasticity_estimate.interval"),
    )


__all__ = [
    "MIN_OWN_WEIGHT_TO_CITE",
    "PRICE_EFFECT_FAMILIES",
    "GuardRequest",
    "PriceClaimVerdict",
    "blocked_categories",
    "filter_price_claims",
    "guard_price_claim",
]
