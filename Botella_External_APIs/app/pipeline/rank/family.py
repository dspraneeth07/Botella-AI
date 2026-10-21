"""One currency for every recommendation family.

THE DEFECT, IN FOUR LINES OF app/recommender/families.py
    cold_box    confidence=0.55     a hardcoded literal
    pre_stock   confidence=0.55     a hardcoded literal
    bundles     confidence=0.7      a hardcoded literal
    stock_new   confidence=0.6      a hardcoded literal
    ExtraPick.units_at_stake        did not exist; bundles had no units at all

A hand-written confidence cannot be compared with a measured one, so
`app/recommender/pipeline.py` did the only thing it could and reserved slots:

    limit = max(1, self._settings.max_recommendations - len(extra))

The signal families take their slots first and the stock families fill what is
left. Nothing compares them, because there is nothing to compare them IN. That
is why the slate looks like restock: the signals are switched on - all twenty
modules under `app/signals/` default to true - they were given a SLOT instead of
a PRICE, and a slot is filled by the weakest card in a family as readily as by
the strongest.

WHAT THIS MODULE IS
    The contract that lets them be priced. Every family returns a `FamilyPick`
    carrying `units_at_stake` and `unit_margin`, which is exactly what
    `rank/score.py` already consumes - so no family keeps its own scoring and
    one sort orders all eleven.

THREE RULES, AND EACH IS ENFORCED STRUCTURALLY RATHER THAN BY REVIEW
    1. `units_at_stake` is a float and is validated. A family that cannot
       compute it REFUSES - it returns no pick. Passing a sentinel is worse than
       producing no card, because a sentinel ranks.
    2. There is NO `calibrated_confidence` field on this dataclass. A family
       cannot stamp one even by accident; it supplies `raw_confidence` and the
       calibration stage owns the rest. That is what keeps N2 meaningful.
    3. Only unit counts become dollars. `expected_value` multiplies
       `units_at_stake` by a margin and there is no other arithmetic here that
       could multiply a probability by money - the defect this rebuild has
       removed twice.

WHAT units_at_stake MEANS PER FAMILY
    understock        max(0, deficit_units)                    sheet 20
    overstock/clear   units above the policy's order_up_to      policy/inventory
    weather           effect.beta x baseline_units              a SignalEffect
    calendar/sports   the same, over the fixture's window       a SignalEffect
    news              the same, and a NEGATIVE beta suppresses  a SignalEffect
    bundle            incremental units on the ATTACHED sku     co-purchase lift
    new/trending      the cohort's first-30-day velocity        area winners

    The first two are available today. The middle three need an estimated
    coefficient, which is why `units_from_effect` refuses without one - and
    until that estimate exists those families produce nothing. That is a
    REDUCTION in coverage against today, and it is the correct trade: measured
    over 155 signal-driven recommendations, that layer scored 6 to 10 points
    BELOW random. A card priced at a guess is worse than no card.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from typing import Any

from app.pipeline.rank.score import ScoreInputs


@dataclass(frozen=True, slots=True)
class SignalEffect:
    """An estimated effect of one signal on this store's units, with its interval.

    The shape N4.1 fills in. It exists now so the families that need it have
    somewhere to put it and a defined way to refuse without it, rather than
    being rewritten when the estimator lands.

    `beta` is a proportional effect: 0.22 means "about 22% more units while this
    signal is active". A NEGATIVE beta is a valid and valuable result - a
    competitor promotion or a Ramadan trade area means do not pre-stock, and do
    not read the subsequent dip as something to recover.
    """

    key: str
    beta: float
    interval_lo: float
    interval_hi: float
    observations: int
    #: How it was estimated, and against what controls. Travels onto the card,
    #: because confounding here runs TOWARD finding an effect: a festival is
    #: scheduled for a weekend that was going to be busy anyway.
    basis: str

    def __post_init__(self) -> None:
        if self.interval_hi < self.interval_lo:
            raise ValueError(
                f"SignalEffect {self.key!r} has an inverted interval: "
                f"[{self.interval_lo}, {self.interval_hi}]"
            )
        if self.observations < 0:
            raise ValueError("observations must be >= 0")

    @property
    def usable(self) -> bool:
        """Does the interval EXCLUDE zero.

        The same refusal `elasticity/guard.py` applies to price effects, for the
        same reason: an interval spanning zero does not mean "no effect", it
        means the data cannot tell. Most signals at most stores will land here,
        and that is the correct answer rather than a failure of the estimator.
        """
        return self.interval_lo > 0.0 or self.interval_hi < 0.0

    @property
    def suppresses(self) -> bool:
        """A usable effect in the NEGATIVE direction. Not a card - a veto."""
        return self.usable and self.beta < 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key, "beta": self.beta,
            "interval_lo": self.interval_lo, "interval_hi": self.interval_hi,
            "observations": self.observations, "basis": self.basis,
            "usable": self.usable, "suppresses": self.suppresses,
        }


def units_from_effect(
    effect: SignalEffect | None, baseline_units: float
) -> float | None:
    """`beta x baseline` over the signal's window, or None - which means REFUSE.

    Three distinct Nones, and the caller does not need to tell them apart
    because all three mean the same thing: there is no card here.
      - no effect was estimated at all
      - the interval spans zero, so the data cannot tell
      - the effect is a SUPPRESSOR, which vetoes a card rather than creating one
    """
    if effect is None or not effect.usable or effect.suppresses:
        return None
    units = effect.beta * max(0.0, baseline_units)
    return units if units > 0.0 else None


@dataclass(frozen=True, slots=True)
class FamilyPick:
    """What EVERY family returns. One currency, no exceptions.

    Note what is ABSENT: there is no `calibrated_confidence` field. A family
    supplies `raw_confidence` and nothing else, so it cannot bypass sheet 08
    even by accident. That absence is the enforcement.
    """

    family: str
    category: str
    action_type: str
    primary_skus: tuple[str, ...]
    #: The units this card is ABOUT. Never None, never negative, never a
    #: sentinel. A family that cannot compute it must not build a pick.
    units_at_stake: float
    #: Per-unit margin. None when the store sends no cost - five of ten audited
    #: stores - which yields NO expected value rather than an assumed one.
    unit_margin: float | None
    #: The family's own stated likelihood, BEFORE calibration.
    raw_confidence: float
    horizon_open_days: int
    #: Which component produced each figure. A card whose numbers cannot be
    #: traced to a component that can defend them does not ship.
    provenance: str
    #: The estimate that earned this card, where one was needed.
    effect: SignalEffect | None = None
    decision_by: date | None = None
    rationale: str = ""
    signals_cited: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        u = self.units_at_stake
        if u is None or isinstance(u, bool) or not isinstance(u, (int, float)):
            raise TypeError(
                f"{self.family}: units_at_stake must be a number, got {u!r}. A "
                "family that cannot compute it REFUSES - it does not pass a "
                "sentinel, because a sentinel ranks."
            )
        if not math.isfinite(float(u)):
            raise ValueError(f"{self.family}: units_at_stake must be finite, got {u!r}")
        if float(u) < 0.0:
            raise ValueError(
                f"{self.family}: units_at_stake must not be negative, got {u}. A "
                "negative effect SUPPRESSES a card; it does not produce one with "
                "negative value."
            )
        if not 0.0 <= float(self.raw_confidence) <= 1.0:
            raise ValueError(
                f"{self.family}: raw_confidence must be within 0..1, got "
                f"{self.raw_confidence}"
            )
        if not self.primary_skus:
            raise ValueError(f"{self.family}: a pick must name at least one SKU")
        if not str(self.provenance or "").strip():
            raise ValueError(
                f"{self.family}: provenance must say which component produced "
                "these figures"
            )
        if self.horizon_open_days < 0:
            raise ValueError(f"{self.family}: horizon_open_days must be >= 0")

    @property
    def expected_value(self) -> float | None:
        """units x margin. None when there is no margin to multiply by.

        The ONLY place in this module where a number becomes money, and its
        multiplicand is a unit count by construction - `units_at_stake` is
        validated as one and `raw_confidence` is never used here.
        """
        if self.unit_margin is None:
            return None
        return self.units_at_stake * self.unit_margin

    def to_score_inputs(
        self, candidate: Any, calibrated_confidence: float, *,
        decision_by: date | None = None,
    ) -> ScoreInputs:
        """Hand this pick to the EXISTING ranker. No family keeps its own scoring.

        BOTH of the arguments come from the caller, and that is the design:
        `calibrated_confidence` is sheet 08's, which a family has no access to,
        and `candidate` is the typed action the composer owns. A family supplies
        the PRICE and nothing else.
        """
        return ScoreInputs(
            candidate=candidate,
            calibrated_confidence=calibrated_confidence,
            units_at_stake=self.units_at_stake,
            unit_margin=self.unit_margin,
            decision_by=decision_by if decision_by is not None else self.decision_by,
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "family": self.family, "category": self.category,
            "action_type": self.action_type,
            "primary_skus": list(self.primary_skus),
            "units_at_stake": self.units_at_stake,
            "unit_margin": self.unit_margin,
            "raw_confidence": self.raw_confidence,
            "horizon_open_days": self.horizon_open_days,
            "expected_value": self.expected_value,
            "provenance": self.provenance,
            "effect": self.effect.as_dict() if self.effect else None,
            "decision_by": self.decision_by.isoformat() if self.decision_by else None,
            "rationale": self.rationale,
            "signals_cited": list(self.signals_cited),
        }


__all__ = [
    "FamilyPick",
    "SignalEffect",
    "units_from_effect",
]
