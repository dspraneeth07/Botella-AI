"""Cohort priors — what we tell a store that opened yesterday.

The ladder ALWAYS resolves:

    state -> region -> national        (geography)
    sku   -> category -> all_products  (specificity, when a SKU cohort is thin)

    from app.pipeline.priors import PriorRequest, estimate_prior

    prior = estimate_prior(PriorRequest(
        store_key=(46, 46), pattern="sku_velocity", subject_state="TX",
        candidates=candidates, observations=observations, sku="0245",
    ), ctx).value
    prior.cohort_level     # 'state' | 'region' | 'national'
    prior.cohort_size      # distinct STORES behind it
    prior.dispersion       # sheet 07 turns this into interval width

k-anonymity is enforced at every rung: never fewer than k distinct stores, and
the ladder widens rather than returning a thin cohort.
"""

from app.pipeline.priors.cohort import (
    HIGH_DISPERSION_CV_PCT,
    MIN_OBSERVATIONS_PER_STORE,
    STRUCTURAL_DEFAULT_VALUE,
    Dispersion,
    Prior,
    PriorRequest,
    estimate_prior,
    measure_dispersion,
)
from app.pipeline.priors.kanon import (
    K_ANONYMITY_MIN,
    MAX_STORE_SHARE_PCT,
    CohortObservation,
    KAnonVerdict,
    check,
    distinct_stores,
    dominant_share_pct,
    redact,
)
from app.pipeline.priors.ladder import (
    GEO_LEVELS,
    PATTERN_START,
    PATTERNS,
    REGIONS,
    SPECIFICITIES,
    Rung,
    members_for,
    region_for,
    rungs_for,
)

__all__ = [
    "GEO_LEVELS",
    "HIGH_DISPERSION_CV_PCT",
    "K_ANONYMITY_MIN",
    "MAX_STORE_SHARE_PCT",
    "MIN_OBSERVATIONS_PER_STORE",
    "PATTERNS",
    "PATTERN_START",
    "REGIONS",
    "SPECIFICITIES",
    "STRUCTURAL_DEFAULT_VALUE",
    "CohortObservation",
    "Dispersion",
    "KAnonVerdict",
    "Prior",
    "PriorRequest",
    "Rung",
    "check",
    "distinct_stores",
    "dominant_share_pct",
    "estimate_prior",
    "measure_dispersion",
    "members_for",
    "redact",
    "region_for",
    "rungs_for",
]
