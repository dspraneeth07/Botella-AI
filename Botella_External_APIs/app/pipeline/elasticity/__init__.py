"""Sheet 09 — price elasticity per (store, category), and the refusal.

    estimate  beta with an interval, always. Never a bare point.
    guard     no card may cite a price effect on an interval spanning zero.

The guard is the important half. Retail price variation is mostly confounded
with promotions, seasonality and competitor moves, so honest estimates will
frequently span zero. Refusing beats inventing.
"""

from app.pipeline.elasticity.estimate import (
    Elasticity,
    ElasticityRequest,
    Interval,
    PriceObservation,
    build_design,
    estimate_elasticity,
    ols_with_robust_se,
)
from app.pipeline.elasticity.guard import (
    PRICE_EFFECT_FAMILIES,
    GuardRequest,
    PriceClaimVerdict,
    blocked_categories,
    filter_price_claims,
    guard_price_claim,
)

__all__ = [
    "PRICE_EFFECT_FAMILIES",
    "Elasticity",
    "ElasticityRequest",
    "GuardRequest",
    "Interval",
    "PriceClaimVerdict",
    "PriceObservation",
    "blocked_categories",
    "build_design",
    "estimate_elasticity",
    "filter_price_claims",
    "guard_price_claim",
    "ols_with_robust_se",
]
