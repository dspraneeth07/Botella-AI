"""Sheet 15 — explanation. A validated decision becomes a sentence.

The model's job shrinks to WRITING. It does not choose, rank, compute or
decide: every number in its output was fixed by stages 10-14 before it was
called, and the prompt says so in as many words.

    build_prompt(record, precedent)   -> ExplanationPrompt   (pure)
    <caller awaits the model>                                 (I/O)
    render_explanation(request, ctx)  -> Explanation          (pure)

Retrieval supplies WORDS AND PRECEDENT, NEVER A FIGURE - and `RetrievedText`
refuses to be constructed from a string containing a digit, so that rule is
structural rather than remembered. It is what lets sheet 16 verify
faithfulness mechanically: if retrieval cannot reach the arithmetic, it cannot
corrupt it, and every numeral in a sentence must match `allowed_figures`.

A model outage degrades the prose, never the card: `template.py` writes the
same decision with the same figures.
"""

from app.pipeline.explain.precedent import (
    CohortPrecedent,
    Precedent,
    RetrievalContainsFigure,
    RetrievedText,
    StoreOutcome,
    safe_passages,
    vector_retrieval_is_useful,
)
from app.pipeline.explain.prompt import (
    PROMPT_TEMPLATE_VERSION,
    ExplanationPrompt,
    build_prompt,
)
from app.pipeline.explain.render import (
    DISPLAY_ROUNDING_TOLERANCE,
    MAX_SENTENCE_CHARS,
    Explanation,
    ExplanationRequest,
    build_provenance_sentence,
    numerals_in,
    provenance_figures,
    render_explanation,
    unaccounted_numerals,
)
from app.pipeline.explain.template import template_sentence

__all__ = [
    "DISPLAY_ROUNDING_TOLERANCE",
    "MAX_SENTENCE_CHARS",
    "PROMPT_TEMPLATE_VERSION",
    "CohortPrecedent",
    "Explanation",
    "ExplanationPrompt",
    "ExplanationRequest",
    "Precedent",
    "RetrievalContainsFigure",
    "RetrievedText",
    "StoreOutcome",
    "build_prompt",
    "build_provenance_sentence",
    "numerals_in",
    "provenance_figures",
    "render_explanation",
    "safe_passages",
    "template_sentence",
    "unaccounted_numerals",
    "vector_retrieval_is_useful",
]
