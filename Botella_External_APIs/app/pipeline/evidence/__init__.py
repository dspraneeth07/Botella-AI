"""Evidence and peers — how much this store knows, and which stores resemble it.

Everything downstream needs one number: n, the count of usable observations
behind an estimate. It decides the shrinkage weight (06), the interval width
(07), the confidence (15) and the evidence-state label the owner sees.

    from app.pipeline.evidence import EvidenceRequest, count_evidence

    n = count_evidence(EvidenceRequest(
        pattern="day_of_week", calendar=calendar, window_days=364,
    ), ctx).value.n

n is NOT row count. It is usable observations for the specific pattern, and a
closed day is never counted.

    from app.pipeline.evidence import PeerRequest, StoreFeatures, find_peers

Peers match on observable structure only - state, category mix, volume band -
so every match is explainable in one sentence.
"""

from app.pipeline.evidence.count import (
    PATTERNS,
    SUFFICIENCY,
    WEEKDAY_NAMES,
    EvidenceCount,
    EvidenceRequest,
    count_evidence,
    evidence_profile,
)
from app.pipeline.evidence.peers import (
    Peer,
    PeerCohort,
    PeerRequest,
    cohort_keys,
    find_peers,
)
from app.pipeline.evidence.similarity import (
    Similarity,
    StoreFeatures,
    compare,
    cosine_similarity,
    exact_similarity,
    explain,
    volume_band_similarity,
)

__all__ = [
    "PATTERNS",
    "SUFFICIENCY",
    "WEEKDAY_NAMES",
    "EvidenceCount",
    "EvidenceRequest",
    "Peer",
    "PeerCohort",
    "PeerRequest",
    "Similarity",
    "StoreFeatures",
    "cohort_keys",
    "compare",
    "cosine_similarity",
    "count_evidence",
    "evidence_profile",
    "exact_similarity",
    "explain",
    "find_peers",
    "volume_band_similarity",
]
