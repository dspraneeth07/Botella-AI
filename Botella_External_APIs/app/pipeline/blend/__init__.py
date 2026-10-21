"""Shrinkage - where cold start stops being a special case and becomes a weight.

    theta_hat = (n * theta_own + k * theta_cohort) / (n + k)

    n = 0   -> theta_cohort exactly.  a brand-new store. NO BRANCH TAKEN.
    n = k   -> the midpoint.
    n >> k  -> essentially own history. SAME THREE LINES.

    from app.pipeline.blend import BlendRequest, blend

    out = blend(BlendRequest(
        pattern="sku_velocity", n=n, theta_own=own, theta_cohort=prior.value,
        cohort_level=prior.cohort_level, cohort_size=prior.cohort_size,
    ), ctx).value
    out.value          # the estimate
    out.own_weight     # n/(n+k) - what the store-facing card says out loud
    out.evidence_state # DISPLAY ONLY. Nothing may branch on it.
"""

from app.pipeline.blend.evidence_state import (
    MATURE_MULTIPLE,
    cohort_weight_for,
    evidence_state_for,
    own_weight_for,
)
from app.pipeline.blend.reversion import (
    DEFAULT_DISPERSION_CV,
    MATERIALITY_FLOOR_UNITS,
    MIN_HIT_PROBABILITY,
    MIN_WEEKS_FOR_DISPERSION,
    ReversionRequest,
    RevertedDemand,
    dispersion_cv,
    effective_observations,
    is_recommendable,
    revert,
    steadiness_of,
)
from app.pipeline.blend.shrink import (
    K_BY_PATTERN,
    K_CATEGORY_SHARE,
    K_DAY_OF_WEEK,
    K_MONTHLY_SEASONALITY,
    K_SKU_VELOCITY,
    K_WEEKLY_TREND,
    PATTERNS,
    Blended,
    BlendRequest,
    blend,
    k_for_pattern,
)

__all__ = [
    "DEFAULT_DISPERSION_CV",
    "K_BY_PATTERN",
    "K_CATEGORY_SHARE",
    "K_DAY_OF_WEEK",
    "K_MONTHLY_SEASONALITY",
    "K_SKU_VELOCITY",
    "K_WEEKLY_TREND",
    "MATERIALITY_FLOOR_UNITS",
    "MATURE_MULTIPLE",
    "MIN_HIT_PROBABILITY",
    "MIN_WEEKS_FOR_DISPERSION",
    "PATTERNS",
    "BlendRequest",
    "Blended",
    "ReversionRequest",
    "RevertedDemand",
    "blend",
    "cohort_weight_for",
    "dispersion_cv",
    "effective_observations",
    "is_recommendable",
    "revert",
    "steadiness_of",
    "evidence_state_for",
    "k_for_pattern",
    "own_weight_for",
]
