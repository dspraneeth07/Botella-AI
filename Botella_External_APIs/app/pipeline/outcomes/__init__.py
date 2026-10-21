"""Sheet 19 — outcomes. The loop everything else depends on.

Calibration fits on outcomes. The shrinkage constant k is fitted from them.
The gate judges on them. Cohort priors sharpen against them. Every PROVISIONAL
setting in the registry stays provisional until this loop has run.

`lift.py` is THE definition of lift on this side, pinned to
`backend/lib/lift.js` by `backend/tests/lift-parity-verify.js`. There used to
be two - a 28-day pooled ratio in Node, a 21-day mean-of-ratios here -
producing answers 1.37x apart on identical data.
"""

from app.pipeline.outcomes.lift import (
    DEFAULT_LIFT_CAP,
    LIFT_CAP,
    Lift,
    SkuOutcome,
    lift_for,
    score_from_lift,
)

__all__ = [
    "DEFAULT_LIFT_CAP",
    "LIFT_CAP",
    "Lift",
    "SkuOutcome",
    "lift_for",
    "score_from_lift",
]
