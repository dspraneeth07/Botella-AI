#!/usr/bin/env python
"""Has one store drifted below its matched null for a month? From a payload.

    python scripts/drift_eval.py payload.json

Node reads the outcomes and the null pool (it owns the analytics database);
this runs `app/pipeline/gate/drift.py` over them and prints the verdict as
JSON for Node to persist. Python holds no analytics credentials - the standing
architectural constraint - so the boundary is a file, and the whole evaluation
is replayable from it months later.

WHAT NODE DOES WITH THE ANSWER, AND WHAT IT MUST NOT
    `drifted: true` is an instruction to write `suspended` to
    `store_gate_verdict`, measured and not displayed, with the reason and the
    validity window printed here. `drifted: false` is an instruction to do
    NOTHING - not to promote, not to clear a suspension, not to touch the row.
    Promotion is Gate A/B's job (`publish_gate_verdicts.py`), on measured
    accuracy and money over a finished month. A monitor that could both close
    and open a store would be a second gate with a weaker bar.

THE VALIDITY WINDOW IS COMPUTED HERE
    `verdict_as_of` and `valid_until` are printed by this script, from the same
    Setting `publish_gate_verdicts.py` uses, so a drift suspension expires on
    the same rule as a published verdict. Two writers each applying their own
    window to one column is how the audit page and the serving path come to
    disagree about one store (migration 033).

PAYLOAD
    {
      "client_id": 1, "location_id": 171,
      "as_of": "2026-10-08",                 the day the window ends; today
      "outcomes": [{"sku", "family", "lift", "shown", "volume_class",
                    "scored_on": "2026-10-01"}, ...],
      "null_pool": {"v2": [0.9, 1.1, ...], ...},
      "snapshot_id": "..."                   optional; derived if absent
    }
"""

from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline.context import RunContext  # noqa: E402
from app.pipeline.gate import (  # noqa: E402
    DriftOutcome,
    DriftRequest,
    Outcome,
    evaluate_drift,
)
from app.pipeline.gate.store import VERDICT_VALID_DAYS  # noqa: E402


def _as_of(payload: dict) -> date:
    # The clock arrives in the payload so the run is replayable; today is the
    # fallback for a hand run, never for the cron, which always supplies it.
    raw = payload.get("as_of")
    return date.fromisoformat(raw) if raw else date.today()


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        print("usage: drift_eval.py <payload.json>", file=sys.stderr)
        return 2

    payload = json.loads(Path(args[0]).read_text(encoding="utf-8"))
    as_of = _as_of(payload)

    outcomes = [
        DriftOutcome(
            outcome=Outcome(
                sku=row["sku"],
                family=row["family"],
                lift=float(row["lift"]),
                volume_class=row.get("volume_class") or "unmeasured",
                shown=bool(row.get("shown", True)),
            ),
            scored_on=date.fromisoformat(str(row["scored_on"])[:10]),
        )
        for row in payload.get("outcomes", [])
        if row.get("lift") is not None
    ]

    ctx = RunContext(
        run_id=f"drift-{payload['client_id']}-{payload['location_id']}-{as_of.isoformat()}",
        tenant_id=int(payload["client_id"]),
        store_id=int(payload["location_id"]),
        as_of=as_of,
        snapshot_id=payload.get("snapshot_id")
        or f"outcomes-{len(outcomes)}-{as_of.isoformat()}",
        config_version="default",
        seed=0,
        versions={"gate": "1.0.0", "drift": "1.0.0"},
    )

    result = evaluate_drift(
        DriftRequest(
            client_id=int(payload["client_id"]),
            location_id=int(payload["location_id"]),
            outcomes=outcomes,
            null_pool={k: list(v) for k, v in (payload.get("null_pool") or {}).items()},
        ),
        ctx,
    )

    if not result.ok or result.value is None:
        # A monitor that cannot decide leaves the store where it was. Printing
        # `drifted: true` here would suspend a store on an exception.
        print(json.dumps({
            "client_id": payload["client_id"],
            "location_id": payload["location_id"],
            "drifted": False, "abstained": True, "state": None,
            "reason": "drift_evaluation_failed",
            "n_outcomes": len(outcomes), "days_covered": 0, "weeks": [],
            "as_of": as_of.isoformat(),
            "error": list(result.reasons),
        }))
        return 0

    out = result.value.as_dict()
    out["as_of"] = as_of.isoformat()
    # Printed whether or not the store drifted, so Node never computes a
    # window of its own; it is only WRITTEN when `drifted` is true.
    out["verdict_as_of"] = as_of.isoformat()
    out["valid_until"] = (as_of + timedelta(days=VERDICT_VALID_DAYS)).isoformat()
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
