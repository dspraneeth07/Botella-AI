#!/usr/bin/env python
"""Run the shared lift fixture through the Python definition.

    python scripts/lift_parity.py fixture.json

Reads the cases `backend/tests/lift-parity-verify.js` writes, runs each one
through `app/pipeline/outcomes/lift.py`, and prints the results as JSON for the
Node side to compare digit for digit.

Exists so the two languages are PINNED rather than merely intended to agree.
There used to be two definitions of lift - a 28-day pooled ratio in Node, a
21-day mean-of-ratios in Python - producing answers 1.37x apart on identical
data, in the metric calibration, k and the gate all depend on.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline.outcomes.lift import SkuOutcome, lift_for  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        print("usage: lift_parity.py <fixture.json>", file=sys.stderr)
        return 2

    cases = json.loads(Path(args[0]).read_text(encoding="utf-8"))
    results = []
    for case in cases:
        skus = [
            SkuOutcome(
                sku=row["sku"],
                baseline_units=row["baseline_units"],
                actual_units=row["actual_units"],
            )
            for row in case["skus"]
        ]
        windows = case["windows"]
        result = lift_for(
            skus,
            baseline_open_days=windows["baseline_open_days"],
            window_open_days=windows["window_open_days"],
        )
        results.append(result.as_dict())

    # No trailing newline fuss: the Node side JSON.parses this directly.
    print(json.dumps(results))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
