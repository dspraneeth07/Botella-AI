"""Turn a validated decision into a sentence. The model's whole remaining job.

WHERE THE MODEL CALL IS, AND WHY IT IS NOT HERE
    Sheet 00's `@stage` contract is synchronous and enforced. The Anthropic
    call is async, so the split is:

        build_prompt(record, precedent)   deterministic, pure
        <caller awaits the model>         I/O, outside every stage
        render_explanation(request, ctx)  deterministic, pure

    That is not a workaround. It means the degraded path lives INSIDE the
    stage: `model_sentence=None` is an ordinary input, not an exception, so
    "the model timed out" and "the model answered" travel the same code and
    are tested the same way.

THE PROVENANCE SENTENCE IS GENERATED, NEVER WRITTEN BY THE MODEL
    When `own_weight < 1` the estimate is partly borrowed, and the card has to
    say so: "based on 14 similar stores in Texas; you have 3 weeks of your own
    history."

    Those figures come from `Provenance` - counted facts travelling with the
    estimate - and the model is never given the chance to round 14 to "about a
    dozen" or turn "3 weeks" into "a few weeks". A hedge is only worth
    printing if it is exact; a vague hedge reads as a disclaimer and gets
    ignored.

WHAT SHEET 16 IS PROMISED
    `Explanation.allowed_figures` is the complete set of numerals that may
    appear. It is the union of stage 14's `figures()` and the provenance
    figures this module itself generated - and nothing else, because retrieval
    cannot carry a number (see `precedent.py`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.explain.precedent import CohortPrecedent, Precedent
from app.pipeline.explain.prompt import PROMPT_TEMPLATE_VERSION
from app.pipeline.explain.template import template_sentence
from app.pipeline.provenance import Provenance
from app.pipeline.registry import ConfigRegistry, Setting, cfg

DAYS_PER_WEEK = 7

MAX_SENTENCE_CHARS = Setting(
    name="explain.max_sentence_chars",
    default=240,
    unit="characters in the model's sentence, before the provenance clause",
    owner="product",
    why="provisional; a card is read in a glance on a phone between customers. "
        "Beyond this the model has stopped writing a sentence and started "
        "writing a paragraph, which is a prompt regression rather than a long "
        "answer - and the template sentence, which is always shorter, is a "
        "better card than a truncated one",
    status="PROVISIONAL",
)

DISPLAY_ROUNDING_TOLERANCE = Setting(
    name="explain.display_rounding_tolerance",
    default=0.05,
    unit="absolute difference between a written numeral and an allowed figure",
    owner="product",
    why="provisional; absorbs DISPLAY rounding and nothing else - 277.8 written "
        "for 277.79999 is the same figure, and half a unit is the widest a "
        "one-decimal card can round. It must stay far below any real "
        "disagreement: a model that wrote 'about 120' for 116 is out by 4, "
        "eighty times this, and is computing rather than quoting - which the "
        "prompt forbids and sheet 16 has to be able to catch",
    status="PROVISIONAL",
)

#: A numeral as it would appear in prose: 116, 277.8, 1,204. The comma group
#: is matched so a thousands separator is read as ONE figure rather than two.
_NUMERAL = re.compile(r"\d[\d,]*(?:\.\d+)?")

#: An ISO date. Removed before scanning for figures, because 2026-09-30 is a
#: DATE and reading it as the three figures 2026, 09 and 30 would flag every
#: card that names its deadline - which is every reorder card.
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _literals(record: Any) -> tuple[str, ...]:
    """Exact strings that may appear verbatim and are NOT figures.

    A SKU IS AN IDENTIFIER, NOT A QUANTITY.
        `080686001904` is a name that happens to be spelled in digits. So is
        the order-by date. Neither is arithmetic, neither can be "rounded",
        and neither should be checked against the figure set - the first
        version of `unaccounted_numerals` flagged both on every single card,
        which is the shape of false positive that gets a checker switched off.

    Carried on the Explanation rather than re-derived by sheet 16, for the
    same reason `allowed_figures` is: two definitions of what counts drift.
    """
    literals = [record.sku]
    name = getattr(record, "product_name", None)
    if name:
        # "Terra Lager 12pk" contains 12. A product name read as arithmetic
        # fails every card whose product has a pack size in its name.
        literals.append(name)
    if record.order_by_date is not None:
        literals.append(record.order_by_date.isoformat())
    return tuple(literals)


@dataclass(frozen=True, slots=True)
class ExplanationRequest:
    """One validated decision, and whatever the model said about it."""

    #: Stage 14's `DecisionRecord`. Typed as Any to keep this package from
    #: importing the validator at module scope - the two are siblings, and a
    #: cycle between them would be a real one.
    record: Any
    provenance: Provenance
    #: What the model wrote. None when it timed out, was rate-limited, or
    #: returned something unusable - all three are the same fact here.
    model_sentence: str | None = None
    precedent: Precedent | None = None
    #: What was actually sent, recorded so a card can be explained later.
    model_id: str | None = None
    temperature: float | None = None
    template_version: str = PROMPT_TEMPLATE_VERSION


@dataclass(frozen=True, slots=True)
class Explanation:
    """The card's sentence, and everything needed to check or explain it."""

    sentence: str
    #: "model" | "template". Which path wrote it.
    source: str
    #: The generated clause, when the estimate is partly borrowed. Empty
    #: string when the store's own data carried the whole answer.
    provenance_sentence: str
    #: THE CONTRACT WITH SHEET 16: every numeral that may legitimately appear.
    allowed_figures: dict[str, float] = field(default_factory=dict)
    #: Exact strings that are identifiers rather than figures - the SKU, the
    #: ISO order-by date. Removed before the numeral scan.
    allowed_literals: tuple[str, ...] = ()
    #: Why the model's sentence was not used, when it was not. Carried rather
    #: than logged: "the model timed out" is something the run should be able
    #: to report per card, not something to reconstruct from a log.
    degraded_reason: str = ""
    model_id: str | None = None
    temperature: float | None = None
    template_version: str = PROMPT_TEMPLATE_VERSION
    retrieval_sources: tuple[str, ...] = ()
    retrieval_dropped: int = 0

    @property
    def full_text(self) -> str:
        """What the card shows: the sentence, then the hedge if there is one."""
        if not self.provenance_sentence:
            return self.sentence
        return f"{self.sentence} {self.provenance_sentence}"

    def as_dict(self) -> dict[str, Any]:
        return {
            "sentence": self.sentence,
            "full_text": self.full_text,
            "source": self.source,
            "provenance_sentence": self.provenance_sentence,
            "degraded_reason": self.degraded_reason,
            "model_id": self.model_id,
            "temperature": self.temperature,
            "template_version": self.template_version,
            "retrieval_sources": list(self.retrieval_sources),
            "retrieval_dropped": self.retrieval_dropped,
        }


def numerals_in(text: str) -> list[str]:
    """Every numeral in a sentence, as written.

    Shared with sheet 16 so the two cannot disagree about what a numeral is.
    A thousands separator is part of one figure, not a boundary between two.
    """
    return [m.group(0) for m in _NUMERAL.finditer(text)]


def _as_float(numeral: str) -> float:
    return float(numeral.replace(",", ""))


def provenance_figures(provenance: Provenance) -> dict[str, float]:
    """The numerals the provenance sentence is allowed to introduce.

    Separate from the record's figures because they answer a different
    question - not "what should you do" but "how much of this is about YOUR
    shop" - and sheet 16 should be able to tell them apart when a card is
    wrong.
    """
    figures: dict[str, float] = {}
    if provenance.cohort_size:
        figures["cohort_size"] = float(provenance.cohort_size)
    if provenance.own_observations:
        figures["own_observations"] = float(provenance.own_observations)
        weeks = provenance.own_observations // DAYS_PER_WEEK
        if weeks:
            figures["own_weeks"] = float(weeks)
    return figures


def build_provenance_sentence(
    provenance: Provenance, cohort: CohortPrecedent | None = None
) -> str:
    """"based on 14 similar stores in Texas; you have 3 weeks of your own history"

    Generated, never written by the model, and exact.

    THE RUNG AND THE PLACE ARE DIFFERENT FACTS, AND THEY LIVE APART.
        `Provenance.cohort_level` is the RUNG of sheet 05's ladder - one of
        store | state | region | national - and is validated against exactly
        that vocabulary. It is not a place name, and the first version of this
        function read it as one, which would have printed "based on 14 similar
        stores in state".

        The PLACE comes from `CohortPrecedent.region`, a structured lookup.
        Passing it is optional: without it the sentence says how many peers
        answered but not where, which is less useful and still true. Inventing
        a place to fill the gap would be neither.

    Returns "" when `own_weight` is 1.0 - the estimate is entirely this
    store's own data, there is nothing borrowed to disclose, and a hedge on a
    card that does not need one trains owners to ignore the hedge on cards
    that do.
    """
    if provenance.own_weight >= 1.0:
        return ""

    clauses: list[str] = []
    if provenance.cohort_size:
        where = ""
        # Only a geographic rung HAS a place, and only then is one printed.
        # The national rung covers everywhere, and "in the United States"
        # would be padding rather than information.
        if cohort and cohort.region and provenance.cohort_level in {"state", "region"}:
            where = f" in {cohort.region}"
        stores = "store" if provenance.cohort_size == 1 else "stores"
        clauses.append(
            f"based on {provenance.cohort_size} similar {stores}{where}"
        )

    observations = provenance.own_observations
    if observations:
        weeks = observations // DAYS_PER_WEEK
        if weeks >= 1:
            unit = "week" if weeks == 1 else "weeks"
            clauses.append(f"you have {weeks} {unit} of your own history")
        else:
            day_word = "day" if observations == 1 else "days"
            clauses.append(
                f"you have {observations} {day_word} of your own history"
            )
    elif clauses:
        # n=0 is the pure cold-start case. Saying so is the whole point of
        # sheet 06 - the card is honest that none of this is yet about them.
        clauses.append("this is your first data on it")

    if not clauses:
        return ""
    return f"({'; '.join(clauses)})"


def _unusable(sentence: str, limit: int) -> str:
    """Why this model output cannot be shipped, or "" if it can.

    Only STRUCTURAL faults: empty, too long, or refusing. Whether the numerals
    are faithful is sheet 16's question, asked after this stage, against
    `allowed_figures`. Answering it here as well would put the same check in
    two places and let them drift.
    """
    stripped = sentence.strip()
    if not stripped:
        return "model returned an empty sentence"
    if len(stripped) > limit:
        return f"model returned {len(stripped)} chars, over the {limit} limit"
    lowered = stripped.lower()
    # A model that declines, or narrates that it is about to answer, has not
    # written a card. Both read as plausible prose to a length check.
    for refusal in ("i cannot", "i can't", "i'm unable", "i am unable",
                    "as an ai", "i don't have enough"):
        if lowered.startswith(refusal):
            return f"model declined: {stripped[:60]!r}"
    return ""


@stage("explain_render", "1.0.0")
def render_explanation(
    request: ExplanationRequest,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> StageResult[Explanation]:
    """Produce the card's sentence, from the model or from the template.

    ALWAYS SUCCEEDS WHEN THE RECORD IS VALID. There is no path here that
    returns ok=False for a model problem, because the decision was already
    validated and a writing failure must not delete a correct recommendation.
    """
    record = request.record
    limit = int(config.get(MAX_SENTENCE_CHARS, ctx))

    degraded_reason = ""
    if request.model_sentence is None:
        degraded_reason = "model produced no sentence"
        sentence = template_sentence(record)
        source = "template"
    else:
        degraded_reason = _unusable(request.model_sentence, limit)
        if degraded_reason:
            sentence = template_sentence(record)
            source = "template"
        else:
            sentence = request.model_sentence.strip()
            source = "model"

    precedent = request.precedent
    cohort = precedent.cohort if precedent else None
    provenance_clause = build_provenance_sentence(request.provenance, cohort)

    # THE ALLOWED SET IS ONLY AS WIDE AS THE CARD.
    #
    # Provenance figures are permitted ONLY when the provenance clause is
    # actually printed. The first version added them unconditionally, so a
    # card with no hedge still allowed `own_observations` as a numeral - and a
    # fixture where that happened to be 120 let an invented "about 120 units"
    # pass the check. A permitted numeral that appears nowhere on the card is
    # a hole in the verification, not a harmless extra.
    allowed = dict(record.figures())
    if provenance_clause:
        allowed.update(provenance_figures(request.provenance))

    return StageResult.success(
        Explanation(
            sentence=sentence,
            source=source,
            provenance_sentence=provenance_clause,
            allowed_figures=allowed,
            allowed_literals=_literals(record),
            degraded_reason=degraded_reason,
            model_id=request.model_id,
            temperature=request.temperature,
            template_version=request.template_version,
            retrieval_sources=precedent.sources if precedent else (),
            retrieval_dropped=len(precedent.dropped) if precedent else 0,
        ),
        request.provenance,
    )


def unaccounted_numerals(
    text: str,
    allowed: dict[str, float],
    ctx: RunContext,
    config: ConfigRegistry = cfg,
    literals: tuple[str, ...] = (),
) -> list[str]:
    """Numerals in `text` that no allowed figure accounts for.

    Sheet 16's check, implemented here so the prompt, the template and the
    verifier share one definition of "a numeral" and one of "matches".

    The tolerance is a registry Setting rather than a default argument: it is a
    threshold, it decides whether a card ships, and a number that decides that
    belongs somewhere a person can find it. `check_no_literals` caught the
    first version of this line, which is the guard doing its job.
    """
    tolerance = float(config.get(DISPLAY_ROUNDING_TOLERANCE, ctx))
    values = list(allowed.values())

    # Identifiers and dates first, longest first so a SKU that contains
    # another allowed literal cannot be half-removed.
    scannable = _ISO_DATE.sub(" ", text)
    for literal in sorted(literals or (), key=len, reverse=True):
        scannable = scannable.replace(literal, " ")

    unaccounted: list[str] = []
    for numeral in numerals_in(scannable):
        value = _as_float(numeral)
        if any(abs(value - allowed_value) <= tolerance for allowed_value in values):
            continue
        unaccounted.append(numeral)
    return unaccounted


__all__ = [
    "DISPLAY_ROUNDING_TOLERANCE",
    "MAX_SENTENCE_CHARS",
    "Explanation",
    "ExplanationRequest",
    "build_provenance_sentence",
    "numerals_in",
    "provenance_figures",
    "render_explanation",
    "unaccounted_numerals",
]
