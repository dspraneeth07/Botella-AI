#!/usr/bin/env python
"""Run sheet 02's four quality gates for one store, from a supplied payload.

    python scripts/quality_eval.py payload.json

THE GATES HAD NO CALLER
    `app/pipeline/contracts/gates.py` has held the schema, completeness,
    freshness and anomaly gates - and the right to refuse - since sheet 02.
    `store_quality_state` (migration 017) is the row the serving path reads
    before it admits a card. Nothing connected the two: no process ran the
    gates and no process wrote the row, so `recommendationGateService` found
    no row for every store, read that as `unknown`, and admitted everything.
    A POS feed that stopped three weeks ago looked exactly like a healthy one.

    This is the caller. Node (`backend/scripts/run-quality.js`) assembles what
    the gates need - the sync history, the trailing distribution, optionally a
    sample batch - because Node owns both databases; this script holds no
    credentials and computes the verdict; Node writes it back. The boundary
    is a file, so a verdict is replayable from its payload.

WHAT GOES INTO THE ROW
    `staleness_days` AND `median_interval_days`. Both, because Node's
    `data_too_stale` refusal needs both to fire and neither was ever written.
    The freshness gate itself only DEGRADES a stale store - it attaches the
    staleness so a card can say "as of 6 days ago" - and the refusal at six
    times the store's own cadence belongs to Node's admission rule. This
    script's job is to make sure that rule has numbers to work with.

FRESHNESS IS JUDGED PER ENTITY, WORST WINS
    A store syncs sales and products as separate jobs, and either going dark
    makes the data unusable: no sales means no demand, no products means no
    price or stock. Each entity's freshness is gated and recorded on its own
    row, and the WORST one (never synced beats stale beats fresh) is what the
    store-level verdict is built from.

PAYLOAD
    {
      "client_id": 1, "location_id": 171, "connector": "clover",
      "as_of": "2026-10-08",
      "freshness": [
        {"entity": "sales", "last_successful_sync": "2026-10-07T03:10:00Z",
         "recent_syncs": ["2026-07-10T03:00:00Z", ...]},
        {"entity": "products", ...}
      ],
      "anomaly": {                               optional
        "entity": "sales", "batch_volume": 212, "batch_unit_price": 14.2,
        "batch_basket_size": 2.1,
        "trailing": {"median_daily_volume": 230, "median_unit_price": 13.9,
                     "median_basket_size": 2.0, "observations": 61}
      },
      "batch": {                                 optional
        "entity": "sales", "rows": [...], "batch_id": "...",
        "contract_version": null,
        "partition_min": "2025-04-01", "partition_max": "2026-11-30"
      },
      "notes": ["sync_history_unavailable:..."]  optional, echoed back
    }

OUTPUT
    One JSON object: the `store_quality_state` row, plus `gates` - one entry
    per gate run, in `data_quality_results` shape - and `may_recommend`.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, is_dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline.context import RunContext  # noqa: E402
from app.pipeline.contracts.gates import (  # noqa: E402
    AnomalyInput,
    Batch,
    FreshnessInput,
    TrailingStats,
    freshness_gate,
    run_quality_gates,
)
from app.pipeline.envelope import StageResult  # noqa: E402

#: Per-gate verdict vocabulary, as migration 017 constrains it.
GATE_VERDICTS = ("pass", "fail", "degraded", "abstained")

#: Reasons that mean "accepted, but something downstream must not be used".
_DEGRADING_PREFIXES = ("stale:", "field_unavailable:")
_ABSTAIN_REASON = "insufficient_history_to_judge"


def _stamp(raw: str | None) -> datetime | None:
    """ISO-8601 from Node (JSON.stringify of a Date ends in Z) to a datetime."""
    if not raw:
        return None
    text = str(raw).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)


def _day(raw: str | None) -> date | None:
    return date.fromisoformat(str(raw)[:10]) if raw else None


def _num(raw: Any) -> float | None:
    """A number or None. Never zero for an absence - that is the whole sheet."""
    if raw is None or raw == "":
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _jsonable(value: Any) -> Any:
    """StageResult values carry dataclasses (FieldAvailability); flatten them."""
    if is_dataclass(value) and not isinstance(value, type):
        return _jsonable(asdict(value))
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def gate_verdict(name: str, result: StageResult) -> str:
    """Collapse a StageResult to migration 017's four-way per-gate verdict."""
    if not result.ok:
        return "fail"
    if name == "anomaly" and _ABSTAIN_REASON in result.reasons:
        return "abstained"
    if any(r.startswith(_DEGRADING_PREFIXES) for r in result.reasons):
        return "degraded"
    return "pass"


def gate_row(name: str, entity: str | None, result: StageResult,
             contract_key: str | None = None) -> dict[str, Any]:
    """One `data_quality_results` row. The StageResult travels whole in
    `detail`, because a verdict whose evidence lives in a log line is a verdict
    nobody can audit six weeks later."""
    value = _jsonable(result.value) if result.value is not None else None
    key = contract_key
    if key is None and isinstance(value, dict):
        key = value.get("contract")
    return {
        "gate": name,
        "entity": entity,
        "verdict": gate_verdict(name, result),
        "stage_version": result.stage_version or None,
        "contract_key": key,
        "detail": {
            "ok": result.ok,
            "reasons": list(result.reasons),
            "value": value,
            "provenance": result.provenance.to_dict(),
            "duration_ms": result.duration_ms,
        },
    }


def _freshness_inputs(payload: dict[str, Any]) -> list[FreshnessInput]:
    raw = payload.get("freshness") or []
    if isinstance(raw, dict):
        raw = [raw]
    connector = str(payload.get("connector") or "")
    out: list[FreshnessInput] = []
    for entry in raw:
        stamps = tuple(
            s for s in (_stamp(x) for x in (entry.get("recent_syncs") or [])) if s is not None
        )
        out.append(FreshnessInput(
            connector=connector,
            entity=str(entry.get("entity") or "unknown"),
            last_successful_sync=_stamp(entry.get("last_successful_sync")),
            recent_syncs=stamps,
        ))
    return out


#: The feeds the engine cannot produce a recommendation without.
#:
#: NOT A TUNABLE - a contract. Reversion is computed from sales and screened
#: against the product master, so those two decide whether a slate can exist at
#: all. Purchases, customers and suppliers ENRICH cards (lead times, win-back,
#: supplier grouping); their absence costs a feature and is reported as an
#: unavailable field by the completeness gate.
ESSENTIAL_ENTITIES = ("sales", "products")


def _worst_freshness(
    inputs: list[FreshnessInput], results: list[StageResult]
) -> int:
    """Index of the entity the store-level verdict should be built from.

    Never synced outranks stale, which outranks fresh; among stale entities
    the one furthest past its own allowance wins. A store is only as fresh as
    its least fresh feed.

    RESTRICTED TO THE ESSENTIAL FEEDS, and that restriction is the whole point.
    "Worst wins" over EVERY entity meant one never-synced ancillary feed
    rejected the store outright: on QA, 182 of 211 stores were refused and
    produced no recommendations at all, Bethany among them, because
    `suppliers` had never synced while sales and products were current. A
    missing supplier list costs a lead-time sentence. It is not grounds to show
    an owner nothing.

    The losers still report. Every entity's own reasons are recorded per entity
    by the caller, so a never-synced suppliers feed is visible on the row and in
    `unavailable_fields` - it simply no longer decides whether the store may be
    served.

    If a payload carries no essential feed at all the contest falls back to
    everything, because then there is nothing better to judge on and silently
    passing would be worse than judging on an ancillary feed.
    """
    def rank(pair: tuple[int, StageResult]) -> tuple[int, float]:
        _, res = pair
        if not res.ok:
            return (2, 0.0)
        value = res.value or {}
        allowed = float(value.get("allowed_days") or 0.0) or 1.0
        ratio = float(value.get("staleness_days") or 0.0) / allowed
        return (1 if value.get("stale") else 0, ratio)
    essential = [i for i, info in enumerate(inputs)
                 if str(info.entity).lower() in ESSENTIAL_ENTITIES]
    pool = essential or list(range(len(results)))
    return max(((i, results[i]) for i in pool), key=rank)[0]


def _anomaly_input(payload: dict[str, Any]) -> AnomalyInput | None:
    raw = payload.get("anomaly")
    if not raw:
        return None
    trailing = raw.get("trailing") or {}
    return AnomalyInput(
        connector=str(payload.get("connector") or ""),
        entity=str(raw.get("entity") or "sales"),
        batch_volume=_num(raw.get("batch_volume")),
        batch_unit_price=_num(raw.get("batch_unit_price")),
        batch_basket_size=_num(raw.get("batch_basket_size")),
        trailing=TrailingStats(
            median_daily_volume=_num(trailing.get("median_daily_volume")),
            median_unit_price=_num(trailing.get("median_unit_price")),
            median_basket_size=_num(trailing.get("median_basket_size")),
            observations=int(trailing.get("observations") or 0),
        ),
    )


def _batch(payload: dict[str, Any]) -> Batch | None:
    raw = payload.get("batch")
    if not raw:
        return None
    return Batch(
        connector=str(payload.get("connector") or ""),
        entity=str(raw.get("entity") or "sales"),
        rows=list(raw.get("rows") or []),
        batch_id=str(raw.get("batch_id") or ""),
        contract_version=raw.get("contract_version"),
        partition_min=_day(raw.get("partition_min")),
        partition_max=_day(raw.get("partition_max")),
    )


def evaluate(payload: dict[str, Any]) -> dict[str, Any]:
    """The whole evaluation, as a function of the payload. Pure, so a test can
    call it without a subprocess and a replay can call it months later."""
    client_id = int(payload["client_id"])
    location_id = int(payload["location_id"])
    raw_as_of = payload.get("as_of")
    as_of = date.fromisoformat(str(raw_as_of)[:10]) if raw_as_of else date.today()

    ctx = RunContext(
        run_id=f"quality-{client_id}-{location_id}-{as_of.isoformat()}",
        tenant_id=client_id,
        store_id=location_id,
        as_of=as_of,
        snapshot_id=payload.get("snapshot_id") or f"sync-state-{as_of.isoformat()}",
        config_version="default",
        seed=0,
        versions={"contracts": "1.0.0"},
    )

    freshness_inputs = _freshness_inputs(payload)
    freshness_results = [freshness_gate(f, ctx) for f in freshness_inputs]

    chosen: FreshnessInput | None = None
    if freshness_inputs:
        chosen = freshness_inputs[_worst_freshness(freshness_inputs, freshness_results)]

    verdict = run_quality_gates(
        ctx,
        batch=_batch(payload),
        freshness=chosen,
        anomaly=_anomaly_input(payload),
    )

    gates: list[dict[str, Any]] = []
    for name, result in verdict.gates.items():
        if name == "freshness":
            continue  # recorded per entity below, from the same stage
        entity = None
        if name in ("schema", "completeness") and payload.get("batch"):
            entity = payload["batch"].get("entity")
        elif name == "anomaly" and payload.get("anomaly"):
            entity = payload["anomaly"].get("entity")
        gates.append(gate_row(name, entity, result))
    for info, result in zip(freshness_inputs, freshness_results, strict=True):
        gates.append(gate_row("freshness", info.entity, result))

    fresh = verdict.gates.get("freshness")
    median_interval: float | None = None
    if fresh is not None and fresh.ok and fresh.value:
        median_interval = fresh.value.get("median_interval_days")

    reasons = list(verdict.reasons)
    # Per-entity staleness that lost the worst-wins contest still matters to a
    # reader of the row - a store whose products feed is stale while sales is
    # fresh should say so, not hide it under the sales verdict.
    for info, result in zip(freshness_inputs, freshness_results, strict=True):
        if info is chosen:
            continue
        for reason in result.reasons:
            tagged = f"{info.entity}:{reason}"
            if tagged not in reasons:
                reasons.append(tagged)
    for note in payload.get("notes") or []:
        if note not in reasons:
            reasons.append(str(note))

    return {
        "client_id": client_id,
        "location_id": location_id,
        "connector": payload.get("connector") or None,
        "as_of": as_of.isoformat(),
        "verdict": verdict.verdict,
        "may_recommend": verdict.may_recommend,
        "unavailable_fields": list(verdict.unavailable_fields),
        "staleness_days": verdict.staleness_days,
        "median_interval_days": median_interval,
        "never_synced": verdict.never_synced,
        "freshness_entity": chosen.entity if chosen else None,
        "reasons": reasons,
        "gate_detail": {
            name: {
                "ok": res.ok,
                "reasons": list(res.reasons),
                "value": _jsonable(res.value) if res.value is not None else None,
                "stage_version": res.stage_version,
            }
            for name, res in verdict.gates.items()
        },
        "gates": gates,
    }


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        print("usage: quality_eval.py <payload.json>", file=sys.stderr)
        return 2
    payload = json.loads(Path(args[0]).read_text(encoding="utf-8"))
    print(json.dumps(evaluate(payload)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
