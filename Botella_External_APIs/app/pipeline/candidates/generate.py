"""Build typed candidates from earlier stages. Never from the warehouse.

WHAT THIS MODULE MAY READ
    The forecast (07), the policy (10), the constraints (11), the elasticity
    (09), and the cohort figures from (05). All of it arrives in the request.

    It opens no connection and issues no query. A stage that reads a database
    cannot be replayed, only re-run - and a candidate whose numbers came from
    somewhere other than a recorded stage output is exactly the figure stage
    16 will have no way to check.

WHAT IT REFUSES TO PRODUCE
    A MARKDOWN candidate where the elasticity does not support a price cut.
    Not "generates one and flags it" - does not generate it. A markdown that
    exists at all is already the claim that cutting the price pays, so the
    check has to happen before construction rather than after.

    On real data that is most of them: sheet 09 measured 98.5% of (store,
    category) cells unable to support the claim.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from app.pipeline.candidates.types import (
    Candidate,
    CandidateIdentity,
    ClearCandidate,
    MarkdownCandidate,
    RangeCandidate,
    ReorderCandidate,
    SubstituteCandidate,
)
from app.pipeline.context import RunContext
from app.pipeline.elasticity.estimate import Elasticity
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

CLEAR_MIN_DAYS_SINCE_SALE = Setting(
    name="candidates.clear.min_days_since_sale",
    default=90,
    unit="days since the last unit sold",
    owner="commercial",
    why="provisional; below three months a quiet SKU is more likely between "
        "orders than dead, and telling an owner to clear it would be wrong "
        "in the direction that costs them a listing they wanted. To be "
        "measured against realised clearance outcomes in wave 6",
    status="PROVISIONAL",
)

CLEAR_MIN_CAPITAL = Setting(
    name="candidates.clear.min_capital",
    default=50,
    unit="dollars of tied-up cost",
    owner="commercial",
    why="provisional; below this the capital freed does not repay the shelf "
        "move and the owner's attention. A clear recommendation worth $8 is "
        "noise crowding out one worth $800",
    status="PROVISIONAL",
)

RANGE_MIN_PEER_ADOPTION = Setting(
    name="candidates.range.min_peer_adoption",
    default=0.4,
    unit="fraction of cohort stores carrying it",
    owner="commercial",
    why="provisional; below this 'comparable stores stock it' is not true "
        "enough to say. Ranging is the most cohort-dependent family and the "
        "only one a brand-new store can act on, so its bar is about whether "
        "the PEERS agree rather than about this store's own history",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class SkuInputs:
    """Everything earlier stages produced for one SKU. Supplied, never fetched."""

    identity: CandidateIdentity
    provenance: Provenance
    display_name: str | None = None

    # ── From sheet 07 ────────────────────────────────────────────────────
    demand_p50: float | None = None
    demand_p90: float | None = None

    # ── From sheets 10 and 11 ────────────────────────────────────────────
    feasible_qty: int | None = None
    constraint_reasons: tuple[str, ...] = ()
    on_hand: float | None = None
    on_order: float | None = None
    lead_time_days: int | None = None
    lead_time_assumption: str = ""

    # ── For CLEAR ────────────────────────────────────────────────────────
    days_since_last_sale: int | None = None
    capital: float | None = None

    # ── From sheet 09 ────────────────────────────────────────────────────
    elasticity: Elasticity | None = None

    # ── From sheet 05, for RANGE ─────────────────────────────────────────
    cohort_level: str | None = None
    cohort_size: int | None = None
    peer_adoption_rate: float | None = None
    #: True when this store does NOT currently carry the SKU. Only then can a
    #: RANGE candidate be proposed.
    is_ranged: bool = True

    # ── For SUBSTITUTE ───────────────────────────────────────────────────
    replaces: CandidateIdentity | None = None
    evidence_kind: str = ""
    co_purchase_count: float | None = None
    shared_basket_rate: float | None = None


@dataclass(frozen=True, slots=True)
class GenerateRequest:
    skus: Sequence[SkuInputs]
    as_of: date


@dataclass(frozen=True, slots=True)
class CandidateSet:
    """Everything proposed, and everything deliberately not proposed."""

    candidates: tuple[Candidate, ...]
    #: (sku, family, reason) for each candidate NOT generated. Carried rather
    #: than dropped: "we considered a markdown and the elasticity did not
    #: support it" is information, and its absence reads as "we never looked".
    withheld: tuple[tuple[str, str, str], ...]

    def by_family(self, family: str) -> list[Candidate]:
        return [c for c in self.candidates if c.family == family]

    def as_dict(self) -> dict[str, Any]:
        return {
            "candidates": [c.as_dict() for c in self.candidates],
            "withheld": [
                {"sku": s, "family": f, "reason": r} for s, f, r in self.withheld
            ],
        }


def _order_by(as_of: date, lead_time_days: int) -> date:
    """When the order has to be placed to arrive before stock runs out.

    Anchored to `ctx.as_of`, never to wall-clock - the same rule every window
    in this programme follows.
    """
    return as_of + timedelta(days=max(0, lead_time_days))


@stage("candidates_generate", "1.0.0")
def generate_candidates(
    request: GenerateRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Build every candidate the earlier stages support, and no others."""
    record_inputs("forecast_ensemble.p50", "policy_inventory.ideal_qty",
                  "constraints_apply.feasible_qty",
                  "elasticity_estimate.interval")

    min_days = config.get(CLEAR_MIN_DAYS_SINCE_SALE, ctx)
    min_capital = config.get(CLEAR_MIN_CAPITAL, ctx)
    min_adoption = config.get(RANGE_MIN_PEER_ADOPTION, ctx)

    candidates: list[Candidate] = []
    withheld: list[tuple[str, str, str]] = []

    for item in request.skus:
        sku = item.identity.sku

        # ── REORDER ──────────────────────────────────────────────────────
        if item.feasible_qty is not None and item.feasible_qty > 0:
            if item.demand_p50 is None or item.demand_p90 is None:
                withheld.append((sku, "reorder", "no_forecast_interval"))
            elif not item.lead_time_assumption:
                withheld.append((sku, "reorder", "no_lead_time_assumption"))
            else:
                candidates.append(ReorderCandidate(
                    identity=item.identity, family="reorder",
                    provenance=item.provenance,
                    display_name=item.display_name,
                    feasible_qty=item.feasible_qty,
                    constraint_reasons=tuple(item.constraint_reasons),
                    order_by_date=_order_by(request.as_of,
                                            item.lead_time_days or 0),
                    demand_p50=item.demand_p50,
                    demand_p90=item.demand_p90,
                    on_hand=item.on_hand or 0.0,
                    on_order=item.on_order or 0.0,
                    lead_time_days=item.lead_time_days or 0,
                    lead_time_assumption=item.lead_time_assumption,
                ))

        # ── CLEAR ────────────────────────────────────────────────────────
        if item.days_since_last_sale is not None and item.capital is not None:
            if item.days_since_last_sale < min_days:
                pass  # not stuck yet; not a withholding, just not a candidate
            elif item.capital < min_capital:
                withheld.append((
                    sku, "clear",
                    f"capital_below_floor:{item.capital:.0f}<{min_capital}",
                ))
            else:
                candidates.append(ClearCandidate(
                    identity=item.identity, family="clear",
                    provenance=item.provenance,
                    display_name=item.display_name,
                    units=item.on_hand or 0.0,
                    capital=item.capital,
                    days_since_last_sale=item.days_since_last_sale,
                    rule_applied=(
                        f"no sale in {item.days_since_last_sale} days and "
                        f"${item.capital:.0f} of cost on the shelf"
                    ),
                ))

        # ── MARKDOWN — checked BEFORE construction ───────────────────────
        if item.elasticity is not None:
            elasticity = item.elasticity
            if elasticity.usable:
                candidates.append(MarkdownCandidate(
                    identity=item.identity, family="markdown",
                    provenance=item.provenance,
                    display_name=item.display_name,
                    beta=elasticity.beta,
                    beta_interval_low=elasticity.interval.low,
                    beta_interval_high=elasticity.interval.high,
                ))
            else:
                interval = elasticity.interval
                bounds = f"[{interval.low:.3f},{interval.high:.3f}]"
                reason = (
                    f"elasticity_interval_spans_zero:{bounds}"
                    if interval.spans_zero
                    else f"elasticity_is_positive:{bounds}"
                    if not interval.entirely_below_zero
                    else f"elasticity_is_inelastic:{bounds}"
                )
                withheld.append((sku, "markdown", reason))

        # ── RANGE ────────────────────────────────────────────────────────
        if item.peer_adoption_rate is not None and not item.is_ranged:
            if not item.cohort_level or item.cohort_size is None:
                withheld.append((sku, "range", "no_cohort_resolved"))
            elif item.peer_adoption_rate < min_adoption:
                withheld.append((
                    sku, "range",
                    f"peer_adoption_below_floor:"
                    f"{item.peer_adoption_rate:.2f}<{min_adoption}",
                ))
            else:
                candidates.append(RangeCandidate(
                    identity=item.identity, family="range",
                    provenance=item.provenance,
                    display_name=item.display_name,
                    cohort_level=item.cohort_level,
                    cohort_size=item.cohort_size,
                    peer_adoption_rate=item.peer_adoption_rate,
                ))

        # ── SUBSTITUTE ───────────────────────────────────────────────────
        if item.replaces is not None:
            if not item.evidence_kind:
                withheld.append((sku, "substitute", "no_linking_evidence"))
            else:
                candidates.append(SubstituteCandidate(
                    identity=item.identity, family="substitute",
                    provenance=item.provenance,
                    display_name=item.display_name,
                    replaces=item.replaces,
                    evidence_kind=item.evidence_kind,
                    co_purchase_count=item.co_purchase_count or 0.0,
                    shared_basket_rate=item.shared_basket_rate or 0.0,
                ))

    result = CandidateSet(tuple(candidates), tuple(withheld))
    return StageResult.success(
        result,
        Provenance(
            own_observations=len(request.skus),
            own_weight=1.0,
            evidence_state="ESTABLISHED" if candidates else "NEW",
            inputs=("forecast_ensemble.p50", "policy_inventory.ideal_qty",
                    "constraints_apply.feasible_qty",
                    "elasticity_estimate.interval"),
        ),
    )


__all__ = [
    "CLEAR_MIN_CAPITAL",
    "CLEAR_MIN_DAYS_SINCE_SALE",
    "RANGE_MIN_PEER_ADOPTION",
    "CandidateSet",
    "GenerateRequest",
    "SkuInputs",
    "generate_candidates",
]
