"""Sort by score, break ties stably, cap one family from crowding the top.

BYTE-IDENTICAL, AND ASSERTED
    Two runs over identical input produce the same ordering AND the same
    serialised bytes. This stage is one of the few in the pipeline where
    bitwise determinism is achievable - there is no bootstrap, no model, no
    clock - so it is asserted rather than hoped for.

    `test_two_runs_produce_byte_identical_output` serialises both runs and
    compares the bytes. That assertion is what stops the property eroding as
    people add features: the day somebody sorts on a dict, reads a clock, or
    lets a set iteration order leak into the output, it fails.

THE TIE-BREAK IS PART OF THE CONTRACT
    `(-score, sku)`. Scores collide constantly - two reorders with the same
    margin and the same confidence produce exactly the same float - and
    Python's sort is stable, so without an explicit tie-break the order would
    be whatever order the caller happened to build the list in. That is
    reproducible only by accident.

    Ascending SKU, so the tie-break is a property of the DATA rather than of
    the caller.

DIVERSITY IS A CAP ON CROWDING OUT, NOT A HARD QUOTA
    A store that receives ten reorder cards and nothing else has been told one
    thing ten times. The cap reserves room in the visible window for other
    families - it does NOT reserve slots for families that have nothing to say.

    So the cap BINDS ONLY WHERE THERE IS COMPETITION. Candidates of an
    over-represented family are held back first; if the window is still short
    afterwards because nothing else exists to fill it, they are backfilled in
    score order rather than leaving the window half empty.

    That asymmetry is deliberate. A store with eight reorders and one clear
    should see the clear - that is the whole point - but a store with eight
    reorders and nothing else is not helped by being shown three cards and
    told the other five exist somewhere. The guarantee is "a family with
    something to say is not crowded out", not "no family may appear more than
    three times".

    A hard quota would go further and manufacture a markdown to fill a slot,
    which is the opposite of every other rule in this programme.

    Nothing is deleted either way: held-back candidates are returned in
    `overflow` with the reason recorded, and still appear lower in `ranked`.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.rank.score import Score, ScoreInputs, score_candidate
from app.pipeline.registry import ConfigRegistry, Setting, cfg

MAX_PER_FAMILY_IN_TOP_N = Setting(
    name="rank.max_per_family_in_top_n",
    default=3,
    unit="candidates of one family within the visible window",
    owner="commercial",
    why="provisional; a store that receives ten reorder cards and nothing else "
        "has been told one thing ten times. Three leaves room for a clear, a "
        "range and a markdown to be seen without starving the family that "
        "usually has the most to say. To be tuned against what owners "
        "actually act on in wave 6",
    status="PROVISIONAL",
)

TOP_N = Setting(
    name="rank.top_n",
    default=10,
    unit="candidates in the visible window",
    owner="commercial",
    why="provisional; the window the family cap applies to. Below it the "
        "ordering still holds but nothing is capped - a card at rank 30 "
        "crowds nobody",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class RankedCandidate:
    """One scored candidate and where it landed."""

    rank: int
    score: Score

    def as_dict(self) -> dict[str, Any]:
        return {"rank": self.rank, **self.score.as_dict()}


@dataclass(frozen=True, slots=True)
class Ranking:
    """The ordered list, plus what the diversity cap displaced."""

    ranked: tuple[RankedCandidate, ...]
    #: (sku, family, reason) for candidates pushed out of the top N by the cap.
    #: Not deleted - they are still in `ranked`, below the cut.
    overflow: tuple[tuple[str, str, str], ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "ranked": [r.as_dict() for r in self.ranked],
            "overflow": [
                {"sku": s, "family": f, "reason": r} for s, f, r in self.overflow
            ],
        }

    def to_bytes(self) -> bytes:
        """The canonical serialisation the determinism test compares.

        `sort_keys=True` and a fixed separator, so two dicts built in a
        different insertion order still serialise identically - the point is
        to catch an ORDERING change, not a key-order change.
        """
        return json.dumps(
            self.as_dict(), sort_keys=True, separators=(",", ":")
        ).encode("utf-8")


def sort_key(score: Score) -> tuple[float, str]:
    """(-score, sku). THE tie-break, in one place a test can point at.

    Negated score rather than `reverse=True`, so that the whole key sorts
    ascending and the SKU tie-break runs in the direction it reads.
    """
    return (-score.score, score.sku)


def apply_family_cap(
    scores: Sequence[Score], max_per_family: int, top_n: int
) -> tuple[list[Score], list[tuple[str, str, str]]]:
    """Hold back surplus same-family candidates so others are not crowded out.

    Two passes. The first fills the window while honouring the cap; the second
    backfills any room the cap left over, in score order, because a half-empty
    window helps nobody.

    `overflow` records only candidates that were held back AND stayed out -
    one that the backfill readmitted was never actually displaced, and saying
    it was would be a false reason on a real card.
    """
    if max_per_family <= 0 or top_n <= 0:
        return list(scores), []

    window: list[Score] = []
    held_back: list[Score] = []
    counts: dict[str, int] = {}

    for candidate in scores:
        if len(window) >= top_n:
            held_back.append(candidate)
            continue
        seen = counts.get(candidate.family, 0)
        if seen >= max_per_family:
            held_back.append(candidate)
            continue
        counts[candidate.family] = seen + 1
        window.append(candidate)

    # Backfill: the cap protected the other families; any room it left over
    # goes back to the held-back candidates in score order.
    readmitted: list[Score] = []
    while held_back and len(window) + len(readmitted) < top_n:
        readmitted.append(held_back.pop(0))

    overflow = [
        (candidate.sku, candidate.family,
         f"family_cap:{max_per_family}_{candidate.family}_in_top_{top_n}")
        for candidate in held_back
        if counts.get(candidate.family, 0) >= max_per_family
    ]
    return window + readmitted + held_back, overflow


@dataclass(frozen=True, slots=True)
class RankRequest:
    inputs: Sequence[ScoreInputs]


@stage("rank_order", "1.0.0")
def rank_candidates(
    request: RankRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Score, sort, cap. Deterministic end to end."""
    record_inputs("candidates_generate.candidates", "calibrate_apply.value")

    scores = [score_candidate(item, ctx, config) for item in request.inputs]
    scores.sort(key=sort_key)

    ordered, overflow = apply_family_cap(
        scores,
        int(config.get(MAX_PER_FAMILY_IN_TOP_N, ctx)),
        int(config.get(TOP_N, ctx)),
    )

    ranking = Ranking(
        ranked=tuple(
            RankedCandidate(index, score)
            for index, score in enumerate(ordered, start=1)
        ),
        overflow=tuple(overflow),
    )
    return StageResult.success(
        ranking,
        Provenance(
            own_observations=len(scores),
            own_weight=1.0,
            evidence_state="ESTABLISHED" if scores else "NEW",
            inputs=("candidates_generate.candidates", "calibrate_apply.value"),
        ),
    )


__all__ = [
    "MAX_PER_FAMILY_IN_TOP_N",
    "TOP_N",
    "RankRequest",
    "RankedCandidate",
    "Ranking",
    "apply_family_cap",
    "rank_candidates",
    "sort_key",
]
