"""Sheet 12 — typed candidates carrying every figure they will display.

A candidate carries EVERY number that will ever appear on its card. If a
figure is not in `figures()`, stage 16 rejects any sentence containing it -
which turns "do not hallucinate" from an instruction into a set membership
test.

Identity is (client_id, location_id, sku). Never a name, never a substring.
"""

from app.pipeline.candidates.generate import (
    CandidateSet,
    GenerateRequest,
    SkuInputs,
    generate_candidates,
)
from app.pipeline.candidates.types import (
    CLEAR,
    FAMILIES,
    MARKDOWN,
    RANGE,
    REORDER,
    SUBSTITUTE,
    Candidate,
    CandidateIdentity,
    ClearCandidate,
    MarkdownCandidate,
    RangeCandidate,
    ReorderCandidate,
    SubstituteCandidate,
)

__all__ = [
    "CLEAR", "FAMILIES", "MARKDOWN", "RANGE", "REORDER", "SUBSTITUTE",
    "Candidate", "CandidateIdentity", "CandidateSet", "ClearCandidate",
    "GenerateRequest", "MarkdownCandidate", "RangeCandidate",
    "ReorderCandidate", "SkuInputs", "SubstituteCandidate",
    "generate_candidates",
]
