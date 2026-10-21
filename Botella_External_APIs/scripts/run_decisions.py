#!/usr/bin/env python
"""The whole engine on one real store: 03 -> 07 -> 10 -> 11 -> 12 -> 14 -> 15 -> 16.

    node backend/scripts/export-pipeline-input.js 171 171 --top 25 > input.json
    python scripts/run_decisions.py input.json

`run_pipeline.py` stops at the forecast. This carries on to a VALIDATED
DECISION - the quantity, the date, the constraints that shaped it, and the
gate that either lets it through or pages someone - then to the SENTENCE an
owner actually reads, and the check that every numeral in it traces back to a
validated figure.

No model is called, so every card takes sheet 15's DEGRADED path deliberately.
That is the thing worth demonstrating: the template carries identical numbers,
so a model outage costs fluency and never a recommendation.

Like every Python entry point here the input is a file, not a connection.
Python holds no analytics credentials and reads no database; the whole run is
replayable from the payload months later.

The two windows this script threads are the point of it, and they are not the
same window:

    horizon_days   sheet 07 forecast horizon, in OPEN days. What the store
                   stands to sell, and the window every risk figure is over.
    coverage_days  lead time + review period. What the ORDER has to cover -
                   you are not buying 30 days of stock, you are buying enough
                   to reach the next delivery.

Comparing an order sized for one against demand over the other is how sheet
14 first real run paged on all three of store 171 decisions. Nothing about it
was visible in either stage alone.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline.assemble import estimate_and_forecast  # noqa: E402
from app.pipeline.candidates import (  # noqa: E402
    CandidateIdentity,
    GenerateRequest,
    SkuInputs,
    generate_candidates,
)
from app.pipeline.constraints import (  # noqa: E402
    ApplyRequest,
    Constraint,
    ConstraintSet,
    apply_constraints,
    budget_unavailable,
    known,
    on_hand_from_snapshot,
    parse_pack_size,
    shelf_capacity_unavailable,
    unavailable,
)
from app.pipeline.explain import (  # noqa: E402
    CohortPrecedent,
    ExplanationRequest,
    Precedent,
    render_explanation,
)
from app.pipeline.policy import (  # noqa: E402
    LEAD_TIME_DAYS,
    REVIEW_PERIOD_DAYS,
    PolicyRequest,
    estimate_policy,
)
from app.pipeline.provenance import Provenance  # noqa: E402
from app.pipeline.registry import cfg  # noqa: E402
from app.pipeline.validate import (  # noqa: E402
    DecisionRequest,
    ExplanationCheckRequest,
    ExplanationStats,
    StoreCatalogue,
    claim_evidence,
    pageable,
    validate_decision,
    validate_explanation,
)
from scripts.run_pipeline import _open_days_per_week, load  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--pattern", default="sku_velocity")
    parser.add_argument("--horizon", type=int, default=30,
                        help="sheet 07 forecast horizon, in OPEN days")
    parser.add_argument("--limit", type=int, default=25)
    args = parser.parse_args(argv)

    estate, skus, ctx = load(args.input)
    payload = json.loads(args.input.read_text(encoding="utf-8"))
    tenant, store = estate.store_key

    lead = int(cfg.get(LEAD_TIME_DAYS, ctx))
    review = int(cfg.get(REVIEW_PERIOD_DAYS, ctx))
    coverage = lead + review
    stock = _stock(payload, ctx)
    packs = _packs(payload)

    print(f"store {estate.store_key}  as_of={ctx.as_of}  "
          f"snapshot={ctx.snapshot_id}")
    print(f"  horizon  {args.horizon} open days (sheet 07)")
    print(f"  coverage {coverage} days = {lead} lead + {review} review "
          f"(sheet 10)")
    usable = {sku: c for sku, c in stock.items() if c.binds}
    unusable: dict[str, int] = {}
    for constraint in stock.values():
        if not constraint.binds:
            state = constraint.availability.value
            unusable[state] = unusable.get(state, 0) + 1
    detail = ", ".join(f"{n} {state}" for state, n in sorted(unusable.items()))
    print(f"  stock    {len(usable)} usable of {len(stock)} carried"
          f"{' (' + detail + ')' if detail else ''}, basis="
          f"{payload.get('stock_basis', 'absent')}\n")
    if not usable:
        print("No shelf counts in this payload, so no reorder can be sized:\n"
              "  ideal_qty = order_up_to - on_hand - on_order, and a missing\n"
              "  on_hand read as zero orders the maximum, not the minimum.\n"
              "  Re-export without a historical --as-of.\n")

    rows = estimate_and_forecast(
        estate, skus, args.pattern, args.horizon, ctx,
        open_days_per_week=_open_days_per_week(estate),
    )
    by_sku = {s.sku: s for s in skus}

    decisions: list = []
    paged: list = []
    refused: list = []
    provenances: dict = {}

    for row in rows[: args.limit]:
        if row.forecast is None:
            refused.append((row.sku, row.refused_reason or "unforecastable"))
            continue

        sku_input = by_sku.get(row.sku)
        family = (sku_input.category if sku_input else None) or "default"

        # The shelf count is a CONSTRAINT, not a number - it carries why it
        # has the value it has. A count that does not bind (absent, negative
        # or stale) refuses the decision rather than being read as zero,
        # because zero orders the maximum. See on_hand_from_snapshot.
        counted = stock.get(row.sku) or unavailable(
            "on_hand", "this SKU is not in the POS product snapshot"
        )
        if not counted.binds or counted.value is None:
            refused.append((row.sku, counted.detail or str(counted.availability)))
            continue
        on_hand = counted.value

        # -- 10 ------------------------------------------------------------
        policy_result = estimate_policy(
            PolicyRequest(
                sku=row.sku, family=family,
                p10=row.forecast.p10, p50=row.forecast.p50,
                p90=row.forecast.p90, horizon_open_days=args.horizon,
                on_hand=on_hand, on_order=None,
            ),
            ctx,
        )
        if not policy_result.ok or policy_result.value is None:
            refused.append((row.sku, "; ".join(policy_result.reasons)))
            continue
        policy = policy_result.value
        if policy.ideal_qty <= 0:
            refused.append((row.sku, "stocked above the reorder point"))
            continue

        # -- 11 ------------------------------------------------------------
        pack = packs.get(row.sku)
        constraint_set = ConstraintSet(
            case_pack=(known("case_pack", pack) if pack
                       else unavailable("case_pack", "no pack size recorded")),
            on_hand=counted,
            moq=unavailable("moq", "no purchase order history in this warehouse"),
            shelf_capacity=shelf_capacity_unavailable(),
            budget=budget_unavailable(),
        )
        feasible_result = apply_constraints(
            ApplyRequest(row.sku, policy.ideal_qty, constraint_set), ctx
        )
        if not feasible_result.ok or feasible_result.value is None:
            refused.append((row.sku, "; ".join(feasible_result.reasons)))
            continue
        feasible = feasible_result.value
        if feasible.feasible_qty <= 0:
            refused.append((row.sku, "constrained to zero"))
            continue

        # -- 12 ------------------------------------------------------------
        estimate = row.estimate
        if estimate is None:
            refused.append((row.sku, "no blended estimate"))
            continue
        generated = generate_candidates(
            GenerateRequest(
                skus=[SkuInputs(
                    identity=CandidateIdentity(tenant, store, row.sku),
                    provenance=_provenance(estimate),
                    demand_p50=row.forecast.p50, demand_p90=row.forecast.p90,
                    feasible_qty=feasible.feasible_qty,
                    constraint_reasons=feasible.reasons,
                    on_hand=on_hand, on_order=0.0,
                    lead_time_days=policy.lead_time_days,
                    lead_time_assumption=next(
                        (a for a in policy.assumptions if "lead" in a), ""
                    ),
                )],
                as_of=ctx.as_of,
            ),
            ctx,
        )
        if not generated.ok or generated.value is None:
            refused.append((row.sku, "; ".join(generated.reasons)))
            continue
        candidates = generated.value.by_family("reorder")
        if not candidates:
            reason = next((r for s, _, r in generated.value.withheld
                           if s == row.sku), "no reorder proposed")
            refused.append((row.sku, reason))
            continue
        candidate = candidates[0]

        # -- 14 ------------------------------------------------------------
        checked = validate_decision(
            DecisionRequest(
                candidate=candidate,
                quantity=feasible.feasible_qty,
                order_by_date=candidate.order_by_date,
                demand_p50=row.forecast.p50, demand_p90=row.forecast.p90,
                on_hand=on_hand, on_order=0.0,
                safety_stock=policy.safety_stock,
                lead_time_days=policy.lead_time_days,
                constraints=list(constraint_set.all()),
                assumptions=policy.assumptions,
                order_up_to=policy.order_up_to,
                # The two windows, stated. Getting these wrong is the bug this
                # gate found in itself on its first real run.
                horizon_days=args.horizon,
                coverage_days=coverage,
            ),
            ctx,
        )
        if not checked.ok or checked.value is None:
            paged.append((row.sku, list(checked.reasons)))
            continue

        # -- 15 ------------------------------------------------------------
        # No model is called here: this script runs offline, so every card
        # takes the DEGRADED path deliberately. That is the thing worth
        # demonstrating - the template sentence carries the identical figures,
        # so a model outage costs fluency and never a recommendation.
        explained = render_explanation(
            ExplanationRequest(
                record=checked.value,
                provenance=_provenance(estimate),
                model_sentence=None,
                precedent=Precedent(
                    cohort=CohortPrecedent(
                        level=_cohort_level(estimate),
                        size=estimate.cohort_size,
                    )
                ) if estimate.cohort_size else None,
            ),
            ctx,
        )
        provenances[checked.value.sku] = _provenance(estimate)
        decisions.append((checked.value, explained.value))

    _report(decisions, paged, refused, coverage, ctx,
            set(stock), provenances)
    return 1 if paged else 0


def _report(decisions, paged, refused, coverage: int, ctx,
            stock_skus, explanation_provenance) -> None:
    head = (f"{'sku':<16}{'qty':>6}{'by':>12}{'p50':>9}{'covers':>9}"
            f"{'on_hand':>9}{'ss':>8}  record")
    print(head)
    print("-" * len(head))
    for d, _ in decisions:
        print(f"{d.sku[:15]:<16}{d.quantity:>6}{str(d.order_by_date):>12}"
              f"{d.demand_p50:>9.1f}{d.coverage_demand:>9.1f}"
              f"{d.on_hand:>9.1f}{d.safety_stock:>8.1f}  "
              f"{len(d.constraint_states)} states, {len(d.figures())} figures")

    print(f"\n{len(decisions)} decisions passed the gate "
          f"({coverage}-day coverage window)")

    if decisions:
        print("\nThe cards as an owner reads them (sheet 15, degraded path - "
              "no model was called):")
        # Sheet 16 runs on every card, exactly as it would in production. The
        # rate is the signal, so it is counted rather than merely checked.
        stats = ExplanationStats()
        catalogue = StoreCatalogue(
            client_id=ctx.tenant_id, location_id=ctx.store_id,
            skus=frozenset(stock_skus),
        )
        for record, explanation in decisions:
            verdict = validate_explanation(
                ExplanationCheckRequest(
                    text=explanation.full_text,
                    record=record,
                    provenance=explanation_provenance[record.sku],
                    catalogue=catalogue,
                    provenance_sentence=explanation.provenance_sentence,
                    allowed_figures=explanation.allowed_figures,
                    allowed_literals=explanation.allowed_literals,
                    evidence=claim_evidence(
                        record, explanation_provenance[record.sku]
                    ),
                ),
                ctx,
            ).value
            stats.record(verdict)
            # The card that SHIPS is the verdict's text, never the raw model
            # output - a failed sentence has already been replaced with the
            # template by the time it gets here.
            print(f"  {verdict.text}")
            for reason in verdict.reasons:
                print(f"      {reason}")

        rate = stats.failure_rate
        print(f"\n  sheet 16: {stats.total} card(s) checked, {stats.failed} "
              f"failed"
              + (f" ({rate:.0%})" if rate is not None else "")
              + (f", by check {stats.as_dict()['by_check']}" if stats.failed
                 else " - every numeral traced to a validated figure"))

    if paged:
        print(f"\n{len(paged)} PAGED - a stage disagrees with another:")
        for sku, reasons in paged:
            for reason in pageable(reasons) or reasons:
                print(f"  {sku:<16}{reason}")

    if refused:
        print(f"\n{len(refused)} refused before the gate - not a bug, a stage "
              f"declining to answer:")
        for sku, reason in refused[:10]:
            print(f"  {sku:<16}{reason[:70]}")


def _cohort_level(estimate) -> str:
    """Sheet 06's rung, in Provenance's four-value vocabulary.

    `Estimate.cohort_level` names the ladder rung under its own scheme; the
    explanation layer needs the validated one. Mapped rather than passed
    through, because an unrecognised rung makes `Provenance` refuse and would
    lose a correct card over a label.
    """
    level = (estimate.cohort_level or "").lower()
    if level in {"store", "state", "region", "national"}:
        return level
    return "national"


def _provenance(estimate) -> Provenance:
    """Sheet 06's evidence, in the shape sheets 12-14 carry it.

    `Estimate` predates `Provenance` and records the same four facts under its
    own names. Translated here rather than duplicated on the dataclass, so
    there is exactly one definition of what n, the weight and the state mean.
    """
    return Provenance(
        own_observations=estimate.n,
        own_weight=estimate.own_weight,
        evidence_state=estimate.evidence_state,
        cohort_level=estimate.cohort_level,
        cohort_size=estimate.cohort_size,
    )


def _stock(payload: dict, ctx) -> dict[str, Constraint]:
    """The current shelf counts the exporter carried, keyed by SKU.

    ABSENT IS NOT ZERO, and the whole reason this function exists rather than
    a `.get(sku, 0.0)` at the call site is that the difference is expensive:

        ideal_qty = order_up_to - on_hand - on_order

    A missing on_hand read as zero does not produce a cautious small order, it
    produces the largest order the policy can express. The first version of
    this script did exactly that and recommended 170 units of 080686001904
    where the true count of 48 gives 116 - a 47% over-order, on every SKU, and
    nothing in the output looked wrong.

    `feature_daily.on_hand` is NULL estate-wide (all 12,091,569 rows), so the
    only source is the exporter's `stock` block, which is a CURRENT snapshot
    and is withheld entirely for a historical --as-of. When it is absent the
    decision is refused. That is the correct and expensive answer: no reorder
    can be sized without knowing what is already on the shelf.
    """
    return {
        row["sku"]: on_hand_from_snapshot(
            row.get("on_hand"),
            (datetime.fromisoformat(row["observed_at"]).date()
             if row.get("observed_at") else None),
            ctx.as_of,
            ctx,
        )
        for row in payload.get("stock", ())
    }


def _packs(payload: dict) -> dict[str, int]:
    """Pack sizes, from the same snapshot as the shelf counts.

    Sheet 11 parses these; an absent one is UNAVAILABLE rather than a pack of
    one, because a pack of one is a claim that singles can be ordered.
    """
    parsed: dict[str, int] = {}
    for row in payload.get("stock", ()):
        pack = row.get("pack_size")
        if pack is None:
            continue
        result = parse_pack_size(str(pack))
        if result.units is not None and result.units > 0:
            parsed[row["sku"]] = result.units
    return parsed


if __name__ == "__main__":
    raise SystemExit(main())
