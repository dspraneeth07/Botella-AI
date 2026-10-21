"""What retrieval is allowed to supply: words and precedent, never a figure.

THE ONE RULE, MADE STRUCTURAL
    Retrieval may contribute PROSE. It may not contribute a NUMBER.

    That is not a guideline anybody has to remember. `RetrievedText` refuses
    to be constructed from a string containing a digit, so a passage carrying
    "sold 400 units last March" cannot enter a prompt at all. The check is at
    the boundary rather than in a review comment, because a rule enforced by
    attention is a rule that holds until the day somebody is busy.

WHY IT MATTERS MORE THAN IT LOOKS
    Sheet 16 verifies faithfulness by checking every numeral in the generated
    sentence against stage 14's record. That check is only meaningful if the
    record is the ONLY source of numerals. One retrieved passage carrying a
    stale figure makes the whole verification decorative: the model would be
    quoting a real number from a real document, and the checker would see a
    numeral it cannot account for - or worse, one that happens to match.

    So the arithmetic and the retrieval are kept in separate pipes. The
    arithmetic pipe (stage 14) carries numbers and no prose. The retrieval pipe
    carries prose and no numbers. Nothing merges them but the sentence, and the
    sentence is checked.

THE THREE SOURCES, AND WHY ONLY ONE NEEDS A VECTOR STORE
    this store's past outcomes   structured lookup - a keyed read
    cohort precedent             structured lookup - "stores like yours"
    product / substitution text  pgvector, and ONLY once the store has
                                 category data

    The first two are keyed reads available from day one; they need no
    embedding and no similarity search, and treating them as a retrieval
    problem would add a vector store to a question that is a WHERE clause.

    The third is the only genuine retrieval, and it is useless without
    category data - which 31 stores in this estate do not have. For those the
    vector store is not queried at all rather than queried for noise: an empty
    result is a fact, and a nearest-neighbour match over a catalogue with no
    categories is a confident-looking irrelevance.

NUMBERS STILL REACH THE CARD - FROM THE STRUCTURED SIDE
    "based on 14 similar stores in Texas" contains a number, and it is
    allowed, because 14 came from `Provenance.cohort_size` - a counted fact
    travelling with the estimate - and not from a retrieved document. That
    sentence is GENERATED, deterministically, in `render.py`. The model is
    never asked to write it and never given the freedom to round it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

#: Any Unicode decimal digit. Deliberately broader than [0-9]: a figure
#: written in Devanagari or fullwidth digits is still a figure, and a check
#: that only knows ASCII is a check with a documented bypass.
_DIGIT = re.compile(r"\d", re.UNICODE)

#: Number words that would let a figure through the digit check unread.
#: Bounded at "twelve" on purpose - beyond that, prose says "dozens" rather
#: than counting, and a longer list starts rejecting ordinary words
#: ("a hundred times better") that carry no claim about this store.
_NUMBER_WORDS = frozenset({
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve", "dozen", "half", "third", "quarter",
    "double", "triple", "twice",
})

_WORD = re.compile(r"[a-z]+")


class RetrievalContainsFigure(ValueError):
    """Raised when retrieved prose carries a number.

    A distinct exception type rather than a bare ValueError, so the caller can
    drop the passage and continue instead of failing the card. Losing one
    retrieved sentence costs some colour; letting it through costs the
    verification.
    """


@dataclass(frozen=True, slots=True)
class RetrievedText:
    """A passage from the vector store. Prose only, enforced at construction.

    Frozen, so a passage cannot acquire a number after it has been checked.
    """

    text: str
    #: Where it came from, so a card's wording can be traced to a document.
    #: Never shown to the model as an instruction - only recorded.
    source: str

    def __post_init__(self) -> None:
        if not self.text.strip():
            raise ValueError("retrieved text is empty")
        if not self.source.strip():
            # An unattributed passage cannot be traced back when somebody
            # asks why a card said what it said.
            raise ValueError("retrieved text has no source")
        if _DIGIT.search(self.text):
            raise RetrievalContainsFigure(
                f"retrieved text carries a digit and cannot enter a prompt: "
                f"{self.text[:80]!r} (source: {self.source})"
            )
        words = set(_WORD.findall(self.text.lower()))
        overlap = words & _NUMBER_WORDS
        if overlap:
            raise RetrievalContainsFigure(
                f"retrieved text carries a number word {sorted(overlap)!r} and "
                f"cannot enter a prompt: {self.text[:80]!r} "
                f"(source: {self.source})"
            )


def safe_passages(
    candidates: list[tuple[str, str]],
) -> tuple[list[RetrievedText], list[str]]:
    """Keep the passages that carry no figure; report the ones dropped.

    Returns (kept, dropped_reasons). The reasons are returned rather than
    logged because "we retrieved five passages and used two" is something the
    card's provenance should be able to say. Silently dropping three would
    make the retrieval look more relevant than it was.
    """
    kept: list[RetrievedText] = []
    dropped: list[str] = []
    for text, source in candidates:
        try:
            kept.append(RetrievedText(text=text, source=source))
        except (RetrievalContainsFigure, ValueError) as exc:
            dropped.append(str(exc))
    return kept, dropped


@dataclass(frozen=True, slots=True)
class StoreOutcome:
    """What happened last time this store was told something similar.

    A STRUCTURED lookup - a keyed read of recorded outcomes, not a similarity
    search. Available from day one because it needs no embeddings, and exact
    because it is this store's own history rather than something like it.
    """

    action: str
    #: How many times this store has been given this action before.
    times_recommended: int
    #: How many of those it acted on. None when nothing has been measured yet -
    #: NOT zero, which would read as "it ignored every one".
    times_acted: int | None = None

    @property
    def has_history(self) -> bool:
        return self.times_recommended > 0 and self.times_acted is not None


@dataclass(frozen=True, slots=True)
class CohortPrecedent:
    """What stores like this one did. Structured, counted, and sourced."""

    #: Which peer group - the rung of sheet 05's ladder that answered.
    level: str
    #: How many stores are in it. The figure the provenance sentence quotes.
    size: int
    #: Geography, when the rung is a geographic one ("Texas"). None at the
    #: national rung, and the sentence then says so rather than inventing a
    #: place.
    region: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"level": self.level, "size": self.size, "region": self.region}


@dataclass(frozen=True, slots=True)
class Precedent:
    """Everything retrieval contributed, in the two shapes it may take.

    The split is the architecture: `passages` is prose that has been proven
    to carry no figure, and the structured members carry counted facts that
    never pass through a model.
    """

    passages: tuple[RetrievedText, ...] = ()
    outcome: StoreOutcome | None = None
    cohort: CohortPrecedent | None = None
    #: Passages rejected for carrying a figure, kept so the card can be honest
    #: about how much of the retrieval it actually used.
    dropped: tuple[str, ...] = ()

    @property
    def prose(self) -> tuple[str, ...]:
        return tuple(p.text for p in self.passages)

    @property
    def sources(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys(p.source for p in self.passages))


#: A store with no category data gets no vector retrieval at all. Exported so
#: the caller decides BEFORE embedding a query, rather than embedding,
#: searching, and discarding.
def vector_retrieval_is_useful(has_category_data: bool) -> bool:
    """Whether the vector store is worth querying for this store.

    Product and substitution context is matched on category. Without it the
    nearest neighbour is a confident-looking irrelevance, and the honest
    result is no passage rather than a poor one.
    """
    return has_category_data


__all__ = [
    "CohortPrecedent",
    "Precedent",
    "RetrievalContainsFigure",
    "RetrievedText",
    "StoreOutcome",
    "safe_passages",
    "vector_retrieval_is_useful",
]
