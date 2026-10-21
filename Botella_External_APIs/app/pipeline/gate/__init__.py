"""Sheet 17 — the gate. Per store, per family: has this actually worked HERE?

A recommendation family is shown at a store only once it has beaten a
VOLUME-MATCHED null at that store. Until then it runs in shadow: computed,
stored, scored, not displayed.

    shadow     the default. Nothing has been proven yet.
    live       beat the matched null here, with N outcomes and p < threshold.
    suspended  was live, then fell below the null. Automatic, reversible.

The null is matched on volume class because a SKU selling 2 a month and one
selling 200 are not comparable in percentage terms, and an unmatched
comparison is decided by which side drew the quieter products.

A new store inherits its cohort's state until it has N outcomes of its own -
so the stores with the least of their own data are not left in shadow for a
quarter, and are not trusted on zero evidence either.

The statistics live here; Node owns the table and the schedule. Two
implementations of one rule is how an estate ends up with two answers.
"""

from app.pipeline.gate.drift import (
    DRIFT_BUCKET_DAYS,
    DRIFT_MIN_BUCKET_OUTCOMES,
    DRIFT_MIN_OUTCOMES,
    DRIFT_WINDOW_DAYS,
    DriftOutcome,
    DriftRequest,
    DriftVerdict,
    WeekReading,
    evaluate_drift,
)
from app.pipeline.gate.matched import (
    MATCHED_BASKETS,
    VOLUME_CLASS_BOUNDS,
    MatchedResult,
    Outcome,
    compare_to_matched_null,
    volume_class,
)
from app.pipeline.gate.state import (
    MIN_OUTCOMES,
    P_THRESHOLD,
    SUSPEND_P_THRESHOLD,
    GateReason,
    GateRequest,
    GateState,
    GateVerdict,
    displayable,
    evaluate_gate,
)

__all__ = [
    "DRIFT_BUCKET_DAYS",
    "DRIFT_MIN_BUCKET_OUTCOMES",
    "DRIFT_MIN_OUTCOMES",
    "DRIFT_WINDOW_DAYS",
    "MATCHED_BASKETS",
    "MIN_OUTCOMES",
    "P_THRESHOLD",
    "SUSPEND_P_THRESHOLD",
    "VOLUME_CLASS_BOUNDS",
    "DriftOutcome",
    "DriftRequest",
    "DriftVerdict",
    "GateReason",
    "GateRequest",
    "GateState",
    "GateVerdict",
    "MatchedResult",
    "Outcome",
    "WeekReading",
    "compare_to_matched_null",
    "displayable",
    "evaluate_drift",
    "evaluate_gate",
    "volume_class",
]
