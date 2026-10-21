"""Drift. A store whose shown cards sit below their matched null for a month.

WHAT THE FAMILY GATE CANNOT SEE
    `gate/state.py` suspends one FAMILY at one store when its outcomes stop
    beating the null. Gate A/B (`gate/store.py`) judges the whole STORE, but
    only when somebody runs the publisher over a finished month - which happens
    about four times a year, and a verdict then stands for 120 days.

    Between those publishes a store can go quietly wrong. A connector starts
    sending half its lines; a manager changes the ordering policy; a season
    turns. Every family may still be individually "not enough outcomes" to
    judge, while the store as a whole is visibly, consistently below what its
    own products would have done unprompted. Nothing watched for that. This
    does.

THE RULE, AND WHY IT IS DELIBERATELY SLOW
    Over the trailing window, the SHOWN arm's outcomes are bucketed by the
    week they were scored in. Each week is compared against the store's
    volume-matched null - the SAME comparison the family gate makes, from the
    same function, so "below the null" means one thing across the estate. The
    store drifts only when EVERY week is below, and only with enough outcomes
    for a week's reading to be more than one card's noise.

    One bad week is a bad week. Four in a row is a store. The rule is
    conjunctive across weeks rather than pooled across the month because a
    pooled mean can be dragged under by a single catastrophic week of quiet
    products while three ordinary weeks say nothing is wrong - and the thing
    being asked here is "has this stopped working", not "was there a bad week".

WHAT IT DOES NOT DO
    It never promotes. A store whose drift clears is not re-opened by this
    module: opening a store is Gate A/B's job, on measured accuracy and money
    over a finished month, and a monitor that could both close and open would
    be a second gate with a weaker bar. Node writes the suspension; the next
    publish decides what replaces it.

    It never fails for want of evidence. Thin data is an ABSTENTION with a
    reason - the store keeps whatever verdict it had - because a drift monitor
    that fires on three outcomes would be a random number generator with a
    kill switch attached.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.gate.matched import (
    MatchedResult,
    Outcome,
    compare_to_matched_null,
)
from app.pipeline.gate.state import GateState
from app.pipeline.provenance import Provenance
from app.pipeline.registry import ConfigRegistry, Setting, cfg

DRIFT_WINDOW_DAYS = Setting(
    name="gate.drift_window_days",
    default=30,
    unit="trailing calendar days of scored outcomes the monitor looks at",
    owner="forecasting",
    why="provisional; a month is the shortest span over which 'this store has "
        "stopped working' is distinguishable from 'this store had a bad week', "
        "and it matches the 30-day outcome window the evidence is measured on, "
        "so the window holds one generation of fully-scored cards. Only whole "
        "weeks inside it are judged (see DRIFT_BUCKET_DAYS); the reason string "
        "reports the days actually covered",
    status="PROVISIONAL",
)

DRIFT_BUCKET_DAYS = Setting(
    name="gate.drift_bucket_days",
    default=7,
    unit="days per bucket the window is split into",
    owner="forecasting",
    why="provisional; a week is the cadence an owner orders on and the "
        "smallest span with enough outcomes to carry a mean. Daily buckets "
        "would need a card a day to be judgeable; the month as one bucket "
        "would let one catastrophic week condemn three ordinary ones",
    status="PROVISIONAL",
)

DRIFT_MIN_OUTCOMES = Setting(
    name="gate.drift_min_outcomes",
    default=20,
    unit="shown-arm outcomes across the whole window before a verdict",
    owner="forecasting",
    why="provisional; five a week over four weeks. Below this the monitor "
        "abstains rather than suspends - a store that issued a dozen cards in "
        "a month has not been measured, it has been sampled, and sampling "
        "cannot prove a trend. Deliberately LOWER than gate.min_outcomes (30 "
        "per family) because this pools every family at the store and asks a "
        "weaker question: not 'is it proven', but 'has it stopped'",
    status="PROVISIONAL",
)

DRIFT_MIN_BUCKET_OUTCOMES = Setting(
    name="gate.drift_min_bucket_outcomes",
    default=3,
    unit="shown-arm outcomes a single week needs to count as measured",
    owner="forecasting",
    why="provisional; a week with one or two outcomes is one card's noise, "
        "and a week with none is an ABSENCE. Either way it cannot be 'below "
        "the null', and a rule that requires every week to be below must "
        "abstain on a week it cannot read rather than skip it - skipping is "
        "how four weeks of evidence quietly becomes two",
    status="PROVISIONAL",
)

#: The lift at which a card counts as a hit. The one definition shared with
#: the ledger and the calibration fitter: a card that did not move the number
#: is not a hit. 1.0 is a probability-style bound, exempt from the literal rule.
HIT_LIFT = 1.0


@dataclass(frozen=True, slots=True)
class DriftOutcome:
    """One scored, SHOWN-arm outcome with the day it was scored.

    Carries the gate's `Outcome` plus `scored_on`, because the week an outcome
    belongs to is the week its measurement window closed - the day the
    evidence landed, not the day the card was issued.
    """

    outcome: Outcome
    scored_on: date


@dataclass(frozen=True, slots=True)
class WeekReading:
    """What one week looked like against the null."""

    start: date
    end: date
    n_outcomes: int
    hit_rate: float | None
    comparison: MatchedResult | None

    @property
    def below_null(self) -> bool | None:
        """None when the week could not be compared - which is NOT below."""
        if self.comparison is None:
            return None
        return not self.comparison.beats_null

    def as_dict(self) -> dict[str, Any]:
        return {
            "start": self.start.isoformat(), "end": self.end.isoformat(),
            "n_outcomes": self.n_outcomes, "hit_rate": self.hit_rate,
            "below_null": self.below_null,
            "comparison": self.comparison.as_dict() if self.comparison else None,
        }


@dataclass(frozen=True, slots=True)
class DriftVerdict:
    """What the monitor concluded, and every week that led to it."""

    client_id: int
    location_id: int
    #: SUSPENDED when drift is proven. SHADOW is not used here - a store that
    #: has not drifted keeps whatever state Gate A/B gave it, and the monitor
    #: says `drifted=False` rather than naming a state it did not decide.
    drifted: bool
    reason: str
    weeks: tuple[WeekReading, ...] = ()
    n_outcomes: int = 0
    days_covered: int = 0
    abstained: bool = False

    @property
    def state(self) -> GateState | None:
        """The state Node should write, or None for 'leave it alone'."""
        return GateState.SUSPENDED if self.drifted else None

    def as_dict(self) -> dict[str, Any]:
        return {
            "client_id": self.client_id, "location_id": self.location_id,
            "drifted": self.drifted, "abstained": self.abstained,
            "state": self.state.value if self.state else None,
            "reason": self.reason, "n_outcomes": self.n_outcomes,
            "days_covered": self.days_covered,
            "weeks": [w.as_dict() for w in self.weeks],
        }


@dataclass(frozen=True, slots=True)
class DriftRequest:
    client_id: int
    location_id: int
    #: Scored outcomes for this store, every family. Only the shown arm is
    #: judged; the withheld arm is the control, not a worse recommendation.
    outcomes: Sequence[DriftOutcome] = ()
    #: volume class -> lifts of un-recommended SKUs at this store over the
    #: SAME window. Supplied, never fetched.
    null_pool: dict[str, Sequence[float]] = field(default_factory=dict)


def _weeks(as_of: date, window_days: int, bucket_days: int) -> list[tuple[date, date]]:
    """Whole buckets counted BACK from as_of, newest first.

    (start, end] half-open on the start: a bucket of seven days ending today
    covers today and the six days before it. Days older than the last whole
    bucket are dropped rather than pooled into a short one - a two-day bucket
    would be thin by construction and abstain on every store.
    """
    count = window_days // bucket_days
    out: list[tuple[date, date]] = []
    end = as_of
    for _ in range(count):
        start = end - timedelta(days=bucket_days)
        out.append((start, end))
        end = start
    return out


def _hit_rate(outcomes: Sequence[Outcome]) -> float | None:
    if not outcomes:
        return None
    return sum(1 for o in outcomes if o.lift > HIT_LIFT) / len(outcomes)


@stage("gate_drift", "1.0.0")
def evaluate_drift(
    request: DriftRequest,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> StageResult[DriftVerdict]:
    """Has this store been below its null for the whole window?

    Never fails for want of evidence: an unjudgeable store is an abstention
    with a reason, and the caller leaves its state where it was.
    """
    window_days = int(config.get(DRIFT_WINDOW_DAYS, ctx))
    bucket_days = int(config.get(DRIFT_BUCKET_DAYS, ctx))
    min_total = int(config.get(DRIFT_MIN_OUTCOMES, ctx))
    min_bucket = int(config.get(DRIFT_MIN_BUCKET_OUTCOMES, ctx))

    shown = [d for d in request.outcomes if d.outcome.shown]
    buckets = _weeks(ctx.as_of, window_days, bucket_days)
    days_covered = len(buckets) * bucket_days
    oldest = buckets[-1][0] if buckets else ctx.as_of
    in_window = [d for d in shown if oldest < d.scored_on <= ctx.as_of]

    provenance = Provenance(
        own_observations=len(in_window), own_weight=1.0, evidence_state="NEW",
    )

    def verdict(*, drifted: bool, reason: str, weeks: Sequence[WeekReading] = (),
                abstained: bool = False) -> StageResult[DriftVerdict]:
        return StageResult.success(
            DriftVerdict(
                client_id=request.client_id, location_id=request.location_id,
                drifted=drifted, reason=reason, weeks=tuple(weeks),
                n_outcomes=len(in_window), days_covered=days_covered,
                abstained=abstained,
            ),
            provenance,
        )

    if not buckets:
        return verdict(drifted=False, abstained=True,
                       reason="drift:window_shorter_than_one_bucket")
    if len(in_window) < min_total:
        return verdict(drifted=False, abstained=True,
                       reason=f"drift:thin_evidence:{len(in_window)}<{min_total}")

    readings: list[WeekReading] = []
    for start, end in buckets:
        week = [d.outcome for d in in_window if start < d.scored_on <= end]
        comparison = (
            compare_to_matched_null(week, request.null_pool, ctx, config)
            if len(week) >= min_bucket else None
        )
        readings.append(WeekReading(
            start=start, end=end, n_outcomes=len(week),
            hit_rate=_hit_rate(week), comparison=comparison,
        ))

    # A week that could not be read is not below the null - it is unread, and
    # the rule needs EVERY week read and below. Say which one and why.
    for week in readings:
        if week.n_outcomes < min_bucket:
            return verdict(
                drifted=False, abstained=True, weeks=readings,
                reason=f"drift:thin_week:{week.start.isoformat()}:"
                       f"{week.n_outcomes}<{min_bucket}",
            )
        if week.comparison is None:
            return verdict(
                drifted=False, abstained=True, weeks=readings,
                reason=f"drift:no_matched_null:{week.start.isoformat()}",
            )

    below = [w for w in readings if w.below_null]
    if len(below) == len(readings):
        return verdict(
            drifted=True, weeks=readings,
            reason=f"drift:below_null_for_{days_covered}d",
        )
    return verdict(
        drifted=False, weeks=readings,
        reason=f"drift:beat_null_in_{len(readings) - len(below)}_of_{len(readings)}_weeks",
    )


__all__ = [
    "DRIFT_BUCKET_DAYS",
    "DRIFT_MIN_BUCKET_OUTCOMES",
    "DRIFT_MIN_OUTCOMES",
    "DRIFT_WINDOW_DAYS",
    "HIT_LIFT",
    "DriftOutcome",
    "DriftRequest",
    "DriftVerdict",
    "WeekReading",
    "evaluate_drift",
]
