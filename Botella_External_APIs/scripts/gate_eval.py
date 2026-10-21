#!/usr/bin/env python
"""Evaluate one store-family's gate state from a supplied payload.

    python scripts/gate_eval.py payload.json

Node reads the outcomes and the null pool (it owns the analytics database);
this runs sheet 17's statistics over them and prints the verdict as JSON for
Node to persist. Python holds no analytics credentials - the standing
architectural constraint - so the boundary is a file, and the whole evaluation
is replayable from it months later.
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline.context import RunContext  # noqa: E402
from app.pipeline.gate import (  # noqa: E402
    GateRequest,
    GateState,
    Outcome,
    evaluate_gate,
)


def _state(value: str | None) -> GateState | None:
    if not value:
        return None
    try:
        return GateState(value)
    except ValueError:
        # An unrecognised state is treated as "never seen", not as live. The
        # table's CHECK makes this unreachable; if it ever is reached, the safe
        # reading of a state nobody recognises is "not proven".
        return None


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        print("usage: gate_eval.py <payload.json>", file=sys.stderr)
        return 2

    payload = json.loads(Path(args[0]).read_text(encoding="utf-8"))

    outcomes = [
        Outcome(
            sku=row["sku"],
            family=row["family"],
            lift=float(row["lift"]),
            volume_class=row.get("volume_class") or "unmeasured",
            shown=bool(row.get("shown", True)),
        )
        for row in payload.get("outcomes", [])
    ]

    # The seed and snapshot make the randomisation test reproducible: the same
    # inputs give the same p-value months later, which is what lets "the gate
    # opened" be a fact somebody can argue with rather than a coincidence.
    ctx = RunContext(
        run_id=f"gate-{payload['client_id']}-{payload['location_id']}",
        tenant_id=payload["client_id"],
        store_id=payload["location_id"],
        as_of=date.today(),
        snapshot_id=payload.get("snapshot_id")
        or f"outcomes-{len(outcomes)}-{payload['family']}",
        config_version="default",
        seed=0,
        versions={"gate": "1.0.0"},
    )

    result = evaluate_gate(
        GateRequest(
            client_id=payload["client_id"],
            location_id=payload["location_id"],
            family=payload["family"],
            outcomes=outcomes,
            null_pool={k: list(v) for k, v in (payload.get("null_pool") or {}).items()},
            current=_state(payload.get("current")),
            cohort_state=_state(payload.get("cohort_state")),
        ),
        ctx,
    )

    if not result.ok or result.value is None:
        # A gate that cannot decide leaves the family where it was. Printing a
        # verdict here would record a state nothing computed.
        print(json.dumps({
            "client_id": payload["client_id"],
            "location_id": payload["location_id"],
            "family": payload["family"],
            "state": payload.get("current") or "shadow",
            "reason": "gate_evaluation_failed",
            "n_outcomes": len(outcomes),
            "inherited": False,
            "evidence": None,
            "transitioned": False,
            "error": list(result.reasons),
        }))
        return 0

    print(json.dumps(result.value.as_dict()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
