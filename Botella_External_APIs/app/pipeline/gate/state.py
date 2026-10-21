"""The gate. Per store, per family: has this actually worked HERE?

THE SHEET THAT WOULD HAVE PREVENTED THE 23% RESULT
    A recommendation family is shown at a store only once it has beaten a
    volume-matched null AT THAT STORE. Until then it runs in shadow: computed,
    stored, scored, not displayed.

    The 23% backtest could measure forecasting but not causation, because
    nothing had ever been withheld. Holding an arm back is what turns "the
    number went up" into "we made the number go up", and the gate is what
    stops an unproven family reaching an owner in the meantime.

THREE STATES, AND WHY SUSPENDED IS NOT SHADOW
    shadow     computed, stored, scored, NOT displayed. The default for every
               new store-family pair. Nothing has been proven yet.
    live       has beaten the matched null AT THIS STORE, with at least N
               outcomes and p below the threshold.
    suspended  WAS live, and then fell below the null. Automatic and
               reversible.

    `suspended` is deliberately not the same state as `shadow`. Shadow means
    "we have not learned anything yet"; suspended means "we learned something
    and it stopped being true". They need different alerting and they produce
    different conversations - a store whose reorder family was live for three
    months and then suspended is a signal about that store, not a new store.

A NEW STORE INHERITS, THEN EARNS
    A store that opened last week has no outcomes of its own. Leaving it in
    shadow until it accumulates N would mean the newest stores - the ones with
    the least of their own data, which sheet 06 exists to serve - get the
    least help for a quarter.

    So it inherits its cohort's state until it has N outcomes of its own, and
    switches to its own verdict the moment it does. Inheritance is not a free
    pass: the cohort's state is only `live` if the cohort actually proved it,
    so an unproven family is unproven everywhere.

WHAT THIS MODULE DOES NOT DO
    It does not read a database, write a state, or decide when to run. It
    takes measured outcomes and returns a verdict. Node owns the table and the
    schedule; keeping the statistics in one language and the persistence in
    the other is the same split sheet 03 uses, and for the same reason - two
    implementations of one rule is how the estate ends up with two answers.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.gate.matched import (
    MatchedResult,
    Outcome,
    compare_to_matched_null,
)
from app.pipeline.provenance import Provenance
from app.pipeline.registry import ConfigRegistry, Setting, cfg

MIN_OUTCOMES = Setting(
    name="gate.min_outcomes",
    default=30,
    unit="scored outcomes for one store-family before it may go live",
    owner="forecasting",
    why="provisional; below this the matched null cannot separate a real "
        "effect from a quiet month at a single store. Thirty is roughly a "
        "quarter of daily runs for one family at one store, which is also why "
        "the holdout had to be switched on before anything else in wave 6 - "
        "every week it stayed off was a week added to the end",
    status="PROVISIONAL",
)

P_THRESHOLD = Setting(
    name="gate.p_threshold",
    default=0.05,
    unit="randomisation-test p-value below which a family may go live",
    owner="forecasting",
    why="provisional; the conventional bar, and deliberately NOT tuned to let "
        "more families through. This gate exists because an unproven family "
        "reached customers once already; loosening it to raise the live rate "
        "would be optimising the number we are trying to measure",
    status="PROVISIONAL",
)

SUSPEND_P_THRESHOLD = Setting(
    name="gate.suspend_p_threshold",
    default=0.2,
    unit="p-value at or above which a LIVE family is suspended",
    owner="forecasting",
    why="provisional. THE MAINTENANCE BAR, and deliberately looser than the "
        "0.05 needed to go live: strong evidence to open, weaker evidence to "
        "stay open, suspended when even the weaker bar fails. Symmetric "
        "thresholds would flap a family in and out of view on noise, which "
        "reads to an owner as the system being broken. "
        "It must stay BELOW 0.5 to mean anything - a null that is roughly "
        "symmetric puts p under 0.5 whenever the observed value is above the "
        "null mean at all, so a 0.5 bar would only ever fire where the "
        "below-the-null check has already fired. The first version of this "
        "defaulted to 0.5 and was unreachable for exactly that reason",
    status="PROVISIONAL",
)


class GateState(StrEnum):
    """Three states. `str` values so Node can persist them verbatim."""

    #: Computed, stored, scored - NOT displayed. The default.
    SHADOW = "shadow"
    #: Proven at this store against a volume-matched null.
    LIVE = "live"
    #: Was live; fell below the null. Automatic and reversible.
    SUSPENDED = "suspended"


class GateReason(StrEnum):
    """Why the gate is where it is. Recorded, because "not shown" with no
    reason is the kind of refusal nobody can act on."""

    NOT_ENOUGH_OUTCOMES = "not_enough_outcomes"
    NO_MATCHED_NULL = "no_matched_null"
    BEAT_THE_NULL = "beat_the_null"
    DID_NOT_BEAT_THE_NULL = "did_not_beat_the_null"
    FELL_BELOW_THE_NULL = "fell_below_the_null"
    EVIDENCE_DECAYED = "evidence_decayed"
    INHERITED_FROM_COHORT = "inherited_from_cohort"
    STILL_BEATING_THE_NULL = "still_beating_the_null"


@dataclass(frozen=True, slots=True)
class GateVerdict:
    """One store-family's state, and the evidence behind it."""

    client_id: int
    location_id: int
    family: str
    state: GateState
    reason: GateReason
    #: True when this verdict came from the cohort rather than this store's
    #: own outcomes. The card can say so, and the next run knows to re-check.
    inherited: bool = False
    n_outcomes: int = 0
    evidence: MatchedResult | None = None
    #: The state this replaces, so a transition is visible without diffing
    #: two rows.
    previous: GateState | None = None

    @property
    def displayed(self) -> bool:
        """The only question the serving path asks."""
        return self.state is GateState.LIVE

    @property
    def transitioned(self) -> bool:
        return self.previous is not None and self.previous is not self.state

    def as_dict(self) -> dict[str, Any]:
        return {
            "client_id": self.client_id, "location_id": self.location_id,
            "family": self.family, "state": self.state.value,
            "reason": self.reason.value, "inherited": self.inherited,
            "n_outcomes": self.n_outcomes,
            "previous": self.previous.value if self.previous else None,
            "transitioned": self.transitioned,
            "displayed": self.displayed,
            "evidence": self.evidence.as_dict() if self.evidence else None,
        }


@dataclass(frozen=True, slots=True)
class GateRequest:
    """One store-family, its outcomes, and the null to judge them against."""

    client_id: int
    location_id: int
    family: str
    #: Scored outcomes for THIS store and family. Both arms; only the SHOWN
    #: arm is tested, and the holdout arm is what makes the null credible.
    outcomes: Sequence[Outcome] = ()
    #: volume class -> lifts of un-recommended SKUs at this store.
    null_pool: dict[str, Sequence[float]] = field(default_factory=dict)
    #: Where this store-family stands now. None for a pair never seen before.
    current: GateState | None = None
    #: The cohort's state, for a store without enough of its own outcomes.
    cohort_state: GateState | None = None
    provenance: Provenance | None = None


def _shown(outcomes: Sequence[Outcome]) -> list[Outcome]:
    """Only the shown arm is under test.

    The holdout arm is not a worse version of the same thing - it is the
    control, and scoring it as if it were a recommendation would compare the
    engine against itself.
    """
    return [o for o in outcomes if o.shown]


@stage("gate_state", "1.0.0")
def evaluate_gate(
    request: GateRequest,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> StageResult[GateVerdict]:
    """Where does this store-family stand, and why?

    Never fails for want of evidence. "Not enough outcomes" is a VERDICT -
    shadow, with a reason - not an error, because shadow is the correct and
    expected state for most store-family pairs most of the time.
    """
    minimum = int(config.get(MIN_OUTCOMES, ctx))
    threshold = float(config.get(P_THRESHOLD, ctx))
    suspend_at = float(config.get(SUSPEND_P_THRESHOLD, ctx))

    shown = _shown(request.outcomes)
    previous = request.current
    provenance = request.provenance or Provenance(
        own_observations=len(shown), own_weight=1.0, evidence_state="NEW",
    )

    def verdict(state: GateState, reason: GateReason, *,
                inherited: bool = False,
                evidence: MatchedResult | None = None) -> StageResult[GateVerdict]:
        return StageResult.success(
            GateVerdict(
                client_id=request.client_id, location_id=request.location_id,
                family=request.family, state=state, reason=reason,
                inherited=inherited, n_outcomes=len(shown), evidence=evidence,
                previous=previous,
            ),
            provenance,
        )

    # ── Not enough of its own evidence: inherit, or wait ──────────────────
    if len(shown) < minimum:
        if request.cohort_state is not None:
            # Inheritance is NOT a free pass - the cohort is only `live` if
            # the cohort proved it. An unproven family stays unproven
            # everywhere, and a new store is simply not punished for being new.
            return verdict(request.cohort_state,
                           GateReason.INHERITED_FROM_COHORT, inherited=True)
        return verdict(GateState.SHADOW, GateReason.NOT_ENOUGH_OUTCOMES)

    result = compare_to_matched_null(shown, request.null_pool, ctx, config)
    if result is None:
        # No comparable products to draw a null from. Not a failure and not a
        # pass: there is nothing to compare against, so nothing is proven.
        return verdict(GateState.SHADOW, GateReason.NO_MATCHED_NULL)

    # ── A live family: does it still hold up? ─────────────────────────────
    if previous is GateState.LIVE:
        if not result.beats_null:
            return verdict(GateState.SUSPENDED,
                           GateReason.FELL_BELOW_THE_NULL, evidence=result)
        if result.p_value >= suspend_at:
            # Still nominally above the null, but no longer separable from it.
            # This is the band between the going-live bar and the maintenance
            # bar, and it is the whole reason the two differ.
            return verdict(GateState.SUSPENDED,
                           GateReason.EVIDENCE_DECAYED, evidence=result)
        return verdict(GateState.LIVE, GateReason.STILL_BEATING_THE_NULL,
                       evidence=result)

    # ── Shadow or suspended: has it earned its place? ─────────────────────
    # Suspended is reversible on exactly the same bar a new family must clear.
    # A family that recovers is not owed the benefit of having once been live.
    if result.beats_null and result.p_value < threshold:
        return verdict(GateState.LIVE, GateReason.BEAT_THE_NULL,
                       evidence=result)

    return verdict(previous or GateState.SHADOW,
                   GateReason.DID_NOT_BEAT_THE_NULL, evidence=result)


def displayable(verdicts: Sequence[GateVerdict]) -> set[str]:
    """The families a store may actually be shown.

    A helper rather than a convention, so the serving path cannot drift from
    the state the gate assigned - the same reason `pageable()` exists in
    sheet 14.
    """
    return {v.family for v in verdicts if v.displayed}


__all__ = [
    "MIN_OUTCOMES",
    "P_THRESHOLD",
    "SUSPEND_P_THRESHOLD",
    "GateReason",
    "GateRequest",
    "GateState",
    "GateVerdict",
    "displayable",
    "evaluate_gate",
]
