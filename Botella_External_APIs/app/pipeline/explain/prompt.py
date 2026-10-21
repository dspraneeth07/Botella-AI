"""The prompt. Built from the validated decision record, and nothing else.

WHAT THE MODEL IS ALLOWED TO SEE
    One `DecisionRecord` from stage 14, and prose that has been proven to
    carry no figure. Not a warehouse row, not a query handle, not a connection
    - the payload is a dict this module builds, so there is nothing to reach
    through. Python holds no analytics credentials anyway (the standing
    architectural constraint), but that is a property of deployment; this is a
    property of the call.

WHAT THE MODEL IS ASKED TO DO
    Write a sentence. It does not choose the action, rank it, compute a
    figure, or decide whether the card ships. All of that happened in stages
    12, 13 and 14 and cannot be revisited here - by the time this prompt is
    built the decision is already validated, and a model that disagreed with
    it could only be wrong.

WHY THE TEMPLATE IS VERSIONED
    `PROMPT_TEMPLATE_VERSION` travels in Provenance with every card. A card
    written six months ago was written by a specific template against a
    specific model at a specific temperature, and "why did this card read
    oddly" is unanswerable without all three. It is a version, not a hash of
    the text, because an intentional wording change should be a deliberate
    bump that somebody writes a line about.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.pipeline.explain.precedent import Precedent

#: Bump on any change to the system text or the payload SHAPE. Recorded in
#: Provenance on every card.
PROMPT_TEMPLATE_VERSION = "1.0.0"

_SYSTEM = """\
You write one short sentence for a retail recommendation card. That is your \
whole job.

EVERY NUMBER YOU NEED IS GIVEN TO YOU.
You may not compute, derive, round, convert, estimate or infer any figure. If \
a number is not in the DECISION block below, it does not go in the sentence. \
Do not turn 116 into "about 120", do not turn 14 days into "two weeks", do \
not add up two given numbers to make a third. Write the figures exactly as \
they appear.

YOU ARE NOT DECIDING ANYTHING.
The action, the quantity and the date were decided and validated before you \
were called. You are not asked whether they are right, and you cannot change \
them. Write what was decided.

THE CONTEXT BLOCK, IF PRESENT, IS WORDING ONLY.
It gives you vocabulary and precedent - how this kind of product is usually \
described, what this store has done before. It contains no figures, and you \
may not introduce one from it.

STYLE.
One sentence. Plain words a shop owner uses. Lead with the action. No \
preamble, no "I recommend", no hedging, no exclamation marks. If you cannot \
write it in one sentence, write the shortest true one."""


@dataclass(frozen=True, slots=True)
class ExplanationPrompt:
    """A built prompt, and the exact numerals the record permits.

    `allowed_figures` travels with the prompt so sheet 16 verifies against the
    SAME set this prompt was built from. Recomputing it there would let the two
    drift, and a faithfulness check that disagrees with the prompt it is
    checking is worse than none.
    """

    system: str
    user: str
    template_version: str
    allowed_figures: dict[str, float]

    def as_dict(self) -> dict[str, str]:
        """The shape `llm_client` takes."""
        return {"system": self.system, "user": self.user}


def _format_figure(value: float) -> str:
    """Render a number the way the card will show it.

    THE MODEL MUST BE SHOWN THE DISPLAY FORM, NOT THE FLOAT.
    Handing it `277.79999999999995` invites a "correction" to 277.8 - which
    would be the model computing a figure, and sheet 16 rejecting a numeral
    that is arguably more right than the one it was given. Rounding happens
    once, here, and what the model sees is what the card shows.
    """
    if value == int(value):
        return str(int(value))
    return f"{value:.1f}"


def _decision_block(record: Any) -> list[str]:
    """The validated record, flattened to labelled lines.

    Only `figures()` and the few identifying strings. Deliberately NOT
    `record.__dict__`: a future field added to `DecisionRecord` for some other
    purpose should not silently become something the model can quote.
    """
    lines = [
        f"product_sku: {record.sku}",
        f"action: {record.family}",
    ]
    if record.order_by_date is not None:
        lines.append(f"order_by_date: {record.order_by_date.isoformat()}")
    for name, value in sorted(record.figures().items()):
        lines.append(f"{name}: {_format_figure(value)}")
    for assumption in record.assumptions:
        lines.append(f"assumption: {assumption}")
    for name, state in sorted(record.constraint_states.items()):
        lines.append(f"constraint_{name}: {state}")
    return lines


def _context_block(precedent: Precedent) -> list[str]:
    lines: list[str] = []
    for text in precedent.prose:
        lines.append(f"- {text}")
    if precedent.outcome and precedent.outcome.has_history:
        # Phrased WITHOUT the counts. The numbers behind this belong to the
        # deterministic provenance sentence, not to prose the model rewrites.
        outcome = precedent.outcome
        acted = outcome.times_acted or 0
        if acted == 0:
            lines.append("- this store has not acted on this kind of "
                         "recommendation before")
        elif acted == outcome.times_recommended:
            lines.append("- this store has acted on every recommendation of "
                         "this kind so far")
        else:
            lines.append("- this store has acted on some recommendations of "
                         "this kind before")
    return lines


def build_prompt(record: Any, precedent: Precedent | None = None) -> ExplanationPrompt:
    """Assemble the prompt for one validated decision.

    Takes the record itself rather than a store id or a query, because there
    is then nothing for this function to look up and nothing for a future
    edit to start looking up.
    """
    figures = record.figures()
    parts = ["DECISION", *_decision_block(record)]

    if precedent is not None:
        context = _context_block(precedent)
        if context:
            parts += ["", "CONTEXT (wording only - contains no figures)", *context]

    parts += [
        "",
        "Write one sentence telling the owner what to do and why. "
        "Use only the figures in the DECISION block, exactly as written.",
    ]

    return ExplanationPrompt(
        system=_SYSTEM,
        user="\n".join(parts),
        template_version=PROMPT_TEMPLATE_VERSION,
        allowed_figures=figures,
    )


__all__ = ["PROMPT_TEMPLATE_VERSION", "ExplanationPrompt", "build_prompt"]
