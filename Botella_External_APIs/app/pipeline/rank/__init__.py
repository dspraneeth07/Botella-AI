"""Sheet 13 — deterministic ranking. Code, not a model.

    score = expected_value * calibrated_confidence * urgency

Sorted by score descending, ties broken on ascending SKU, so two runs over
identical input produce byte-identical output. No model call, no randomness,
no clock read - every date comes from ctx.as_of.
"""

from app.pipeline.rank.order import (
    MAX_PER_FAMILY_IN_TOP_N,
    TOP_N,
    RankedCandidate,
    Ranking,
    RankRequest,
    apply_family_cap,
    rank_candidates,
    sort_key,
)
from app.pipeline.rank.score import (
    URGENCY_FLOOR,
    URGENCY_HORIZON_DAYS,
    WEIGHT_CONFIDENCE,
    WEIGHT_EXPECTED_VALUE,
    WEIGHT_URGENCY,
    Score,
    ScoreInputs,
    expected_value_of,
    score_candidate,
    urgency_of,
)

__all__ = [
    "MAX_PER_FAMILY_IN_TOP_N", "TOP_N", "URGENCY_FLOOR",
    "URGENCY_HORIZON_DAYS", "WEIGHT_CONFIDENCE", "WEIGHT_EXPECTED_VALUE",
    "WEIGHT_URGENCY", "RankRequest", "RankedCandidate", "Ranking", "Score",
    "ScoreInputs", "apply_family_cap", "expected_value_of",
    "rank_candidates", "score_candidate", "sort_key", "urgency_of",
]
