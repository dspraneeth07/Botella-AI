"""Evidence state — four words, derived from n and k, FOR DISPLAY ONLY.

    NEW          n == 0          nothing of this store's own
    EMERGING     0 < n < k       own data present, cohort still dominant
    ESTABLISHED  k <= n < m·k    own data outweighs the cohort
    MATURE       n >= m·k        the cohort barely moves the answer

**NO STAGE ANYWHERE IN THE PIPELINE MAY BRANCH ON THIS LABEL.** The arithmetic
uses `n`; the label is what the interface says out loud. The moment a stage
writes `if evidence_state == "MATURE"` the architecture has grown a tier gate
through the back door — a cliff at the boundary that a store can see but not
explain, and a code path only some stores exercise.

That prohibition is enforced, not merely asked for:
`scripts/check_no_state_branches.py` walks the AST of every pipeline module and
fails the build on a branch, a comparison, or a match whose subject is
`evidence_state`. It runs as a test (`tests/test_blend.py`), so `pytest` catches
it with no separate CI step to forget.

Two places legitimately look at the label and are exempt:
  * this module, which derives it;
  * `provenance.py`, which validates it is one of the four.

Deriving a label from numbers is not branching on the label.
"""

from __future__ import annotations

from app.pipeline.context import RunContext
from app.pipeline.provenance import EvidenceState
from app.pipeline.registry import ConfigRegistry, Setting, cfg

MATURE_MULTIPLE = Setting(
    name="blend.mature_multiple",
    default=4,
    unit="multiples of k",
    owner="blending",
    why="provisional; at n = 4k the cohort carries 20% of the answer and "
        "further observations move it very little, so 'mature' is a fair word "
        "for it. Distinct from evidence.mature_multiple, which counts "
        "multiples of a PATTERN FLOOR rather than of the shrinkage constant. "
        "To be fitted in wave 6",
    status="PROVISIONAL",
)


def evidence_state_for(
    n: int, k: int, ctx: RunContext, config: ConfigRegistry = cfg
) -> EvidenceState:
    """The display label for this much evidence.

    The comparisons here are the DERIVATION of the label, which is this
    module's whole job. They are not a branch *on* the label, and nothing
    computed downstream may depend on which word comes out.
    """
    multiple = config.get(MATURE_MULTIPLE, ctx)
    if n <= 0:
        return "NEW"
    if n < k:
        return "EMERGING"
    if n < multiple * k:
        return "ESTABLISHED"
    return "MATURE"


def own_weight_for(n: int, k: int) -> float:
    """n / (n + k) — how much of the answer is this store's own data.

    The store-facing card needs to be able to say this out loud: *"based 30%
    on your own sales and 70% on 24 similar stores in Texas"* is a sentence an
    owner can act on, where a bare number is not.

    Pure arithmetic, no conditionals. k is validated positive when it is read
    from the registry (see shrink.k_for_pattern), so the denominator cannot be
    zero for any n >= 0.
    """
    return n / (n + k)


def cohort_weight_for(n: int, k: int) -> float:
    """k / (n + k). The complement, for the same sentence."""
    return k / (n + k)


__all__ = [
    "MATURE_MULTIPLE",
    "cohort_weight_for",
    "evidence_state_for",
    "own_weight_for",
]
