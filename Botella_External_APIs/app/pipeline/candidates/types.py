"""Typed candidates. Each carries every number that will ever reach its card.

THE RULE THAT MAKES THE EXPLANATION LAYER CHECKABLE
    A candidate carries EVERY figure that will ever appear on its card. If a
    number is not in `figures()`, stage 16 rejects any sentence containing it.

    That is what turns "do not hallucinate" from an instruction into a
    mechanism. An instruction is followed most of the time; a mechanism is a
    set membership test.

    So `figures()` is not a convenience accessor - it is the contract. Adding a
    number to a card means adding it to the candidate first, which means
    sourcing it from a stage that computed it, which is the whole point.

IDENTITY IS (client_id, location_id, sku). NEVER A NAME.
    Two SKUs are not the same product because their names share a word. A
    search for "gin" matches "ginger ale" and "virgin mary" unless the pattern
    is word-bounded, and even bounded, a name is not an identifier: the same
    bottle is "Tito's Handmade Vodka 750ml" in one store and "TITOS VODKA
    750" in another.

    `CandidateIdentity` is the only way to say which product a candidate is
    about, and `test_no_name_based_matching_anywhere_in_the_package` asserts
    this module never compares, searches or matches on a name.

    > The sheet warns not to reintroduce a substring bug at
    > `backend/lib/metrics.js:561-566`. Checked against the live database for
    > this sheet: that function already returns `\\y<term>\\y`, and `\\y` is
    > Postgres's word-boundary escape. Measured: bounded `gin` matches "gin
    > bottle" and correctly rejects "ginger ale" and "virgin mary"; unbounded
    > `gin` matches all three. The defect described is already fixed. The rule
    > below is enforced here anyway, because it is right regardless of whether
    > anyone else is currently breaking it.

EVERY CANDIDATE CARRIES ITS PROVENANCE
    evidence_state, own_weight, cohort_level, config_keys - from the stages
    that produced it. A card that cannot say how much of itself is this
    store's own behaviour is a card nobody can weigh.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

from app.pipeline.provenance import Provenance

#: The five families. A candidate is exactly one of them.
REORDER = "reorder"
CLEAR = "clear"
MARKDOWN = "markdown"
RANGE = "range"
SUBSTITUTE = "substitute"

FAMILIES: tuple[str, ...] = (REORDER, CLEAR, MARKDOWN, RANGE, SUBSTITUTE)


@dataclass(frozen=True, slots=True)
class CandidateIdentity:
    """THE way to say which product a candidate is about.

    A tuple of integers and one opaque string. Not a name, not a description,
    not anything a human typed twice.
    """

    client_id: int
    location_id: int
    sku: str

    def __post_init__(self) -> None:
        if not self.sku or not str(self.sku).strip():
            raise ValueError("CandidateIdentity.sku must be non-empty")

    @property
    def store_key(self) -> tuple[int, int]:
        return (self.client_id, self.location_id)

    def as_dict(self) -> dict[str, Any]:
        return {"client_id": self.client_id, "location_id": self.location_id,
                "sku": self.sku}


@dataclass(frozen=True, slots=True)
class Candidate:
    """Base for every family. Never constructed directly."""

    identity: CandidateIdentity
    family: str
    provenance: Provenance
    #: Human-readable, for the card's subject line. NEVER used to match,
    #: compare or look anything up - see the module docstring.
    display_name: str | None = None

    #: Subclasses list the figure keys they are contracted to carry. Every one
    #: must be present and non-null, or construction fails.
    REQUIRED_FIGURES: tuple[str, ...] = field(default=(), init=False, repr=False)

    def figures(self) -> dict[str, float]:
        """Every NUMBER that may appear on this candidate's card.

        Stage 16 checks each numeral in a generated sentence against this
        mapping. A figure that is not here cannot be said.
        """
        raise NotImplementedError

    def _validate_figures(self) -> None:
        """Every contracted figure present and non-null. No exceptions.

        A candidate with a missing number would produce a card with a blank
        where a quantity should be, or - worse - a sentence that silently
        drops the figure and reads as a confident claim with nothing behind
        it.
        """
        values = self.figures()
        missing = [
            key for key in self.REQUIRED_FIGURES
            if key not in values or values[key] is None
        ]
        if missing:
            raise ValueError(
                f"{self.family} candidate for {self.identity.sku} is missing "
                f"required figure(s): {', '.join(sorted(missing))}. Every "
                "number that will appear on the card must be on the candidate."
            )

    def as_dict(self) -> dict[str, Any]:
        return {
            "identity": self.identity.as_dict(),
            "family": self.family,
            "display_name": self.display_name,
            "figures": self.figures(),
            "provenance": self.provenance.to_dict(),
        }


@dataclass(frozen=True, slots=True)
class ReorderCandidate(Candidate):
    """Order n units by date d."""

    feasible_qty: int = 0
    constraint_reasons: tuple[str, ...] = ()
    order_by_date: date | None = None
    demand_p50: float = 0.0
    demand_p90: float = 0.0
    on_hand: float = 0.0
    on_order: float = 0.0
    #: The declared lead time from sheet 10, and the fact that it IS declared.
    lead_time_days: int = 0
    lead_time_assumption: str = ""

    REQUIRED_FIGURES: tuple[str, ...] = field(
        default=("feasible_qty", "demand_p50", "demand_p90", "on_hand",
                 "on_order", "lead_time_days"),
        init=False, repr=False,
    )

    def __post_init__(self) -> None:
        if self.order_by_date is None:
            raise ValueError("a reorder must say WHEN to order by")
        if not self.lead_time_assumption:
            raise ValueError(
                "a reorder rests on a lead time that is declared rather than "
                "measured, and must say so"
            )
        self._validate_figures()

    def figures(self) -> dict[str, float]:
        return {
            "feasible_qty": float(self.feasible_qty),
            "demand_p50": self.demand_p50,
            "demand_p90": self.demand_p90,
            "on_hand": self.on_hand,
            "on_order": self.on_order,
            "lead_time_days": float(self.lead_time_days),
        }


@dataclass(frozen=True, slots=True)
class ClearCandidate(Candidate):
    """This capital is stuck."""

    units: float = 0.0
    capital: float = 0.0
    days_since_last_sale: int = 0
    rule_applied: str = ""

    REQUIRED_FIGURES: tuple[str, ...] = field(
        default=("units", "capital", "days_since_last_sale"),
        init=False, repr=False,
    )

    def __post_init__(self) -> None:
        if not self.rule_applied:
            raise ValueError(
                "a clear candidate must name the clearing rule it applied - "
                "'this is stuck' with no rule is an opinion"
            )
        self._validate_figures()

    def figures(self) -> dict[str, float]:
        return {
            "units": self.units,
            "capital": self.capital,
            "days_since_last_sale": float(self.days_since_last_sale),
        }


@dataclass(frozen=True, slots=True)
class MarkdownCandidate(Candidate):
    """Cut the price, volume compensates.

    MAY NOT EXIST unless the elasticity supports it. The generator checks
    sheet 09's guard before constructing one; this class refuses as a second
    line of defence, because a MarkdownCandidate that exists at all is already
    a claim that a price cut pays.
    """

    beta: float = 0.0
    beta_interval_low: float = 0.0
    beta_interval_high: float = 0.0

    REQUIRED_FIGURES: tuple[str, ...] = field(
        default=("beta", "beta_interval_low", "beta_interval_high"),
        init=False, repr=False,
    )

    def __post_init__(self) -> None:
        if self.beta_interval_low > self.beta_interval_high:
            raise ValueError("beta interval is inverted")
        if self.beta_interval_low <= 0.0 <= self.beta_interval_high:
            raise ValueError(
                "a markdown candidate cannot be constructed on an elasticity "
                "interval that spans zero - the data cannot distinguish a "
                "price cut that raises volume from one that lowers it"
            )
        self._validate_figures()

    def figures(self) -> dict[str, float]:
        return {
            "beta": self.beta,
            "beta_interval_low": self.beta_interval_low,
            "beta_interval_high": self.beta_interval_high,
        }


@dataclass(frozen=True, slots=True)
class RangeCandidate(Candidate):
    """Stock something you currently do not.

    The most cohort-dependent family, and the one that matters most to a
    brand-new store: it is the only family that can say anything at all when
    a store has no history of its own.
    """

    cohort_level: str = ""
    cohort_size: int = 0
    peer_adoption_rate: float = 0.0

    REQUIRED_FIGURES: tuple[str, ...] = field(
        default=("cohort_size", "peer_adoption_rate"),
        init=False, repr=False,
    )

    def __post_init__(self) -> None:
        if not self.cohort_level:
            raise ValueError(
                "a range candidate is a claim about what comparable stores "
                "do, and must name WHICH comparable stores"
            )
        if not 0.0 <= self.peer_adoption_rate <= 1.0:
            raise ValueError(
                f"peer_adoption_rate must be within 0..1, got "
                f"{self.peer_adoption_rate}"
            )
        self._validate_figures()

    def figures(self) -> dict[str, float]:
        return {
            "cohort_size": float(self.cohort_size),
            "peer_adoption_rate": self.peer_adoption_rate,
        }


@dataclass(frozen=True, slots=True)
class SubstituteCandidate(Candidate):
    """This product replaces that one."""

    #: The product being replaced. An IDENTITY, not a name - the whole point
    #: of this family is asserting two SKUs are related, which is exactly
    #: where a name match would do the most damage.
    replaces: CandidateIdentity | None = None
    #: "basket" (co-purchase evidence) or "category" (same category, similar
    #: price band). Named so the card can say which.
    evidence_kind: str = ""
    co_purchase_count: float = 0.0
    shared_basket_rate: float = 0.0

    REQUIRED_FIGURES: tuple[str, ...] = field(
        default=("co_purchase_count", "shared_basket_rate"),
        init=False, repr=False,
    )

    def __post_init__(self) -> None:
        if self.replaces is None:
            raise ValueError("a substitute must say what it replaces")
        if self.replaces == self.identity:
            raise ValueError("a product cannot substitute for itself")
        if self.evidence_kind not in {"basket", "category"}:
            raise ValueError(
                f"evidence_kind must be 'basket' or 'category', got "
                f"{self.evidence_kind!r} - a link with no stated evidence is "
                "the name-matching failure wearing a different hat"
            )
        self._validate_figures()

    def figures(self) -> dict[str, float]:
        return {
            "co_purchase_count": self.co_purchase_count,
            "shared_basket_rate": self.shared_basket_rate,
        }


__all__ = [
    "CLEAR",
    "FAMILIES",
    "MARKDOWN",
    "RANGE",
    "REORDER",
    "SUBSTITUTE",
    "Candidate",
    "CandidateIdentity",
    "ClearCandidate",
    "MarkdownCandidate",
    "RangeCandidate",
    "ReorderCandidate",
    "SubstituteCandidate",
]
