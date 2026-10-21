"""Peer cohorts — which stores resemble this one, and why.

`find_peers` returns similar stores ordered by similarity, each carrying the
reason it matched. Sheet 15 will render *"stores like yours"*, so every entry
has to survive an owner asking "which stores, and why those?".

STATE IS A GATE, NOT A WEIGHT. The sheet lists state among the signals; it is
treated as an exact filter rather than a scored component because a Texas
store and a Maine store are not 60% similar, they are differently regulated,
differently taxed and differently seasonal. Within a state, the score decides.

WIDENING IS SHEET 05'S JOB, NOT THIS ONE'S. If fewer than `min_peers` qualify
at state level, this says so in `reasons` and returns what there is. Measured:
**4 states in the estate hold exactly one store**, so an empty peer list is a
real, reachable outcome and not an edge case — it returns ok=True with an
empty list, because "this store has no peers" is a true and useful answer, not
a failure.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.evidence.similarity import (
    Similarity,
    StoreFeatures,
    compare,
    explain,
)
from app.pipeline.provenance import EvidenceState, Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

MIN_PEERS_DEFAULT = Setting(
    name="peers.min_peers",
    default=5,
    unit="stores",
    owner="evidence",
    why="provisional; below five, a cohort statistic is dominated by whichever "
        "store happens to be unusual. Sheet 06 shrinks toward this cohort, so "
        "a thin one is worse than none. To be fitted in wave 6",
    status="PROVISIONAL",
)

MIN_SIMILARITY_PCT = Setting(
    name="peers.min_similarity_pct",
    default=40,
    unit="percent",
    owner="evidence",
    why="provisional; below 40% shared structure the stores are in the same "
        "state and little else, and 'stores like yours' stops being true",
    status="PROVISIONAL",
)

MAX_PEERS = Setting(
    name="peers.max_peers",
    default=25,
    unit="stores",
    owner="evidence",
    why="provisional; a cohort wide enough to be stable without reaching so "
        "far down the ranking that the tail stops resembling the store",
    status="PROVISIONAL",
)

PERCENT = 100


@dataclass(frozen=True, slots=True)
class Peer:
    """One matched store."""

    client_id: int
    location_id: int
    score: float
    match_reasons: tuple[str, ...]
    explanation: str
    missing_dimensions: tuple[str, ...]
    components: dict[str, float]

    def as_dict(self) -> dict[str, Any]:
        return {
            "client_id": self.client_id, "location_id": self.location_id,
            "score": self.score, "match_reasons": list(self.match_reasons),
            "explanation": self.explanation,
            "missing_dimensions": list(self.missing_dimensions),
            "components": dict(self.components),
        }


@dataclass(frozen=True, slots=True)
class PeerRequest:
    """The store, and the pool to search. The pool is supplied, never fetched."""

    store: StoreFeatures
    candidates: Sequence[StoreFeatures]
    min_peers: int | None = None
    max_peers: int | None = None
    min_similarity_pct: int | None = None
    #: Off by default. State is a gate for good reasons (see the module
    #: docstring); sheet 05 owns the decision to relax it.
    allow_cross_state: bool = False


@dataclass(frozen=True, slots=True)
class PeerCohort:
    peers: tuple[Peer, ...]
    requested_min: int
    same_state_candidates: int
    total_candidates: int
    sufficient: bool
    reasons: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "peers": [p.as_dict() for p in self.peers],
            "count": len(self.peers),
            "requested_min": self.requested_min,
            "same_state_candidates": self.same_state_candidates,
            "total_candidates": self.total_candidates,
            "sufficient": self.sufficient,
            "reasons": list(self.reasons),
        }


@stage("find_peers", "1.0.0")
def find_peers(
    request: PeerRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Stores that resemble this one, ordered by similarity, with reasons.

    Returns ok=True even when the cohort is EMPTY. A store that is the only
    one of its kind in its state has no peers, and that is a fact the caller
    needs — turning it into a failure would make sheet 06 unable to tell
    "no peers" from "the peer engine broke", which are opposite situations.
    """
    record_inputs("client_locations.state", "feature_daily.revenue")

    min_peers = request.min_peers if request.min_peers is not None \
        else config.get(MIN_PEERS_DEFAULT, ctx)
    max_peers = request.max_peers if request.max_peers is not None \
        else config.get(MAX_PEERS, ctx)
    min_score = (
        request.min_similarity_pct if request.min_similarity_pct is not None
        else config.get(MIN_SIMILARITY_PCT, ctx)
    ) / PERCENT

    store = request.store
    reasons: list[str] = []

    # Never a peer of itself: it would score 1.0 and anchor every cohort
    # statistic to the store we are trying to compare against.
    pool = [c for c in request.candidates if c.key != store.key]

    if not store.state:
        reasons.append("store_has_no_state_recorded")
        same_state = [] if not request.allow_cross_state else pool
    elif request.allow_cross_state:
        same_state = pool
        reasons.append("cross_state_search_enabled")
    else:
        same_state = [
            c for c in pool
            if c.state and c.state.strip().lower() == store.state.strip().lower()
        ]

    scored: list[tuple[StoreFeatures, Similarity]] = []
    for candidate in same_state:
        sim = compare(store, candidate, ctx, config)
        scored.append((candidate, sim))

    # Sorted by score, then by store key so the order is deterministic —
    # ties must not reshuffle between runs or a replay will not match.
    scored.sort(key=lambda pair: (-pair[1].score, pair[0].key))

    qualifying = [(c, s) for c, s in scored if s.score >= min_score]
    peers = tuple(
        Peer(
            client_id=c.client_id, location_id=c.location_id, score=s.score,
            match_reasons=s.match_reasons, explanation=explain(store, c, s),
            missing_dimensions=s.missing_dimensions, components=s.components,
        )
        for c, s in qualifying[:max_peers]
    )

    if not same_state:
        reasons.append(
            f"no_same_state_candidates:{store.state or 'unknown'}"
            if store.state else "no_candidates"
        )
    elif not peers:
        best = scored[0][1].score if scored else 0.0
        reasons.append(
            f"no_candidate_cleared_similarity_floor:"
            f"{int(round(PERCENT * best))}pct<{int(round(PERCENT * min_score))}pct"
        )

    sufficient = len(peers) >= min_peers
    if not sufficient:
        # Say it plainly. Widening the search is sheet 05's job.
        reasons.append(
            f"insufficient_peers:{len(peers)}<{min_peers}"
            f":widening_is_sheet_05"
        )

    # Every dimension the estate cannot supply, reported once rather than
    # repeated on all 25 peers.
    absent = sorted({d for p in peers for d in p.missing_dimensions})
    if absent:
        reasons.append(f"dimensions_unavailable:{','.join(absent)}")

    evidence: EvidenceState = (
        "MATURE" if len(peers) >= min_peers * 3
        else "ESTABLISHED" if sufficient
        else "EMERGING" if peers else "NEW"
    )
    provenance = Provenance(
        own_observations=len(peers),
        cohort_level="state" if store.state and not request.allow_cross_state else None,
        cohort_size=len(same_state) if same_state else None,
        # A peer cohort is by definition NOT this store's own evidence.
        own_weight=0.0,
        evidence_state=evidence,
        inputs=("client_locations.state", "feature_daily.revenue"),
    )

    cohort = PeerCohort(
        peers=peers,
        requested_min=min_peers,
        same_state_candidates=len(same_state),
        total_candidates=len(pool),
        sufficient=sufficient,
        reasons=tuple(reasons),
    )
    return StageResult.success(cohort, provenance, reasons=tuple(reasons))


def cohort_keys(cohort: PeerCohort) -> tuple[tuple[int, int], ...]:
    """The (client_id, location_id) pairs, for a downstream aggregate query."""
    return tuple((p.client_id, p.location_id) for p in cohort.peers)


__all__ = [
    "MAX_PEERS",
    "MIN_PEERS_DEFAULT",
    "MIN_SIMILARITY_PCT",
    "Peer",
    "PeerCohort",
    "PeerRequest",
    "cohort_keys",
    "find_peers",
]
