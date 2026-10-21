"""Score the calibration after outcomes land, and suspend what has drifted.

    Brier   mean squared error of a probability. 0.25 is a coin flip.
    ECE     expected calibration error - how far the stated rate sits from the
            observed one, averaged over bins and weighted by how many
            recommendations fell in each.
    curve   the reliability diagram, per family, as numbers rather than a plot.

WHY BRIER ALONE IS NOT ENOUGH
    Brier mixes calibration and discrimination. A model that says 0.23 for
    everything is perfectly CALIBRATED against a 23% base rate and completely
    useless, and its Brier looks respectable. ECE measures only the
    calibration part, and the reliability curve shows WHERE the miscalibration
    lives - which matters, because the engine is not uniformly wrong. It is
    wrong at the top, where it says 0.91 and means 0.34, and that is precisely
    the region that decides what an owner sees.

SUSPENSION IS A NORMAL STATE, NOT AN INCIDENT
    When a family's ECE drifts past its threshold, that family is suspended
    for that store: its curve stops being applied, `apply` falls back to the
    identity transform with a reason, and a refit is requested. Nothing pages
    anybody.

    This has to be routine, because the alternative is a curve everyone is
    slightly afraid to touch. A calibration that can be suspended and refitted
    on a schedule is maintainable; one whose suspension is an incident will be
    left running long past the point it stopped being true.

WHAT IT REFUSES TO DO
    Score a family with too few outcomes. A Brier over nine recommendations is
    a number, and it is not evidence. Those families come back UNSCORED, which
    is not the same as passing.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

PERCENT = 100

MIN_BIN_OUTCOMES = Setting(
    name="calibrate.min_bin_outcomes",
    default=30,
    unit="outcomes in one reliability bin before it may condemn a family",
    owner="forecasting",
    why="MEASURED, from the arithmetic of the test it guards. The per-bin rule "
        "asks whether an observed rate is within 10 points of a stated one, and "
        "an observed rate from n cards has a binomial standard error of "
        "sqrt(p(1-p)/n) - 9.1 points at n=30 and p=0.5. So THIRTY IS THE FLOOR "
        "AT WHICH THE TEST STOPS BEING PURE NOISE, not the point at which it "
        "becomes precise. Below it the granularity alone defeats the threshold: "
        "a 5-card bin can only report 0, 20, 40, 60, 80 or 100 percent, so it is "
        "at least 10 points away from almost any stated value by construction. "
        "Measured on the March ledger, Northlake's 115-card bin deviates 3.0 "
        "points and is well calibrated, while its FIVE-card bin deviates 15.8 "
        "and was condemning the whole store. Marshfield's 171-card bin deviates "
        "33.8 and is a REAL failure that this floor correctly leaves standing. A "
        "thin bin is still REPORTED - it is simply not evidence",
    status="MEASURED",
)

MAX_RELIABILITY_DEVIATION = Setting(
    name="calibrate.max_reliability_deviation",
    default=0.10,
    unit="absolute gap between stated and observed rate, in one bin",
    owner="forecasting",
    why="provisional. ECE averages the gap over bins WEIGHTED BY COUNT, so a "
        "badly wrong bin holding a tenth of the cards can sit inside a "
        "respectable ECE and still be the bin a particular owner is reading. "
        "This is the per-bin rule: a card may not state a number whose own bin "
        "is out by more than this, because that number is known to be wrong "
        "for cards like it. Ten points is the width of one conventional "
        "reliability bin, which is the coarsest error worth calling an error. "
        "Measured on the March ledger, p_hit's populated bins are out by 15.4, "
        "16.9 and 29.8 points, so at 0.10 every card today would state a band "
        "rather than a number - that is the honest state, not a reason to "
        "loosen the setting. It becomes MEASURED once holdout outcomes exist "
        "and the achievable deviation is known rather than assumed",
    status="PROVISIONAL",
)

ECE_SUSPEND_THRESHOLD = Setting(
    name="calibrate.ece_suspend_threshold",
    default=0.15,
    unit="expected calibration error",
    owner="calibration",
    why="provisional; above this the stated confidence is off by more than 15 "
        "points on average and the curve is doing more harm than the identity "
        "transform would. The measured starting point is far worse - stated "
        "0.48 against an observed 0.23 is an ECE around 0.25 - so this is a "
        "ceiling to climb down from, not a bar we currently clear. To be "
        "measured against realised ranking quality in wave 6",
    status="PROVISIONAL",
)

RELIABILITY_BINS = Setting(
    name="calibrate.reliability_bins",
    default=10,
    unit="equal-width probability bins",
    owner="calibration",
    why="provisional; ten bins of 0.1 is the conventional reliability diagram "
        "and keeps each bin interpretable as a decile of stated confidence. "
        "More bins on our data volume would mostly measure bin noise",
    status="PROVISIONAL",
)

MIN_OUTCOMES_TO_SCORE = Setting(
    name="calibrate.min_outcomes_to_score",
    default=30,
    unit="scored outcomes in one family",
    owner="calibration",
    why="provisional; below this a Brier score is a number rather than "
        "evidence, and suspending a family on nine outcomes would thrash. "
        "Such families are reported UNSCORED, which is not a pass",
    status="PROVISIONAL",
)

#: Brier score of a coin flip, DERIVED rather than written as 0.25.
#:
#: A predictor that says "even odds" to everything is wrong by 1/2 on every
#: outcome, and Brier squares that error - so its score is (1/2)^2, whatever
#: the base rate. Not a threshold and not ours to tune: it is the reference
#: line the measured 0.255 fell on the wrong side of.
_EVEN_ODDS = 1 / 2
COIN_FLIP_BRIER = _EVEN_ODDS ** 2


@dataclass(frozen=True, slots=True)
class Prediction:
    """One calibrated confidence and what actually happened to it."""

    family: str
    calibrated_confidence: float
    hit: bool


@dataclass(frozen=True, slots=True)
class Bin:
    """One bucket of the reliability curve."""

    lower: float
    upper: float
    count: int
    mean_stated: float | None
    observed_rate: float | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "lower": self.lower, "upper": self.upper, "count": self.count,
            "mean_stated": self.mean_stated, "observed_rate": self.observed_rate,
        }


@dataclass(frozen=True, slots=True)
class FamilyScore:
    """How well one family's confidence matched reality."""

    family: str
    outcomes: int
    brier: float | None
    ece: float | None
    reliability: tuple[Bin, ...]
    #: True/False when there were enough outcomes to judge; None when not.
    #: None is NOT a pass.
    suspended: bool | None
    reason: str | None
    #: N2.2 - the worst single-bin gap, and which bin it was. Reported whether or
    #: not it caused a suspension, because "suspension is reported WITH its
    #: deviation" is the difference between a decision and a silent suppression.
    worst_bin_deviation: float | None = None
    worst_bin: tuple[float, float] | None = None
    #: Bins that were populated but too thin to be evidence. Reported, because a
    #: family judged on one testable bin out of four is a different claim from one
    #: judged on all four.
    thin_bins: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "family": self.family, "outcomes": self.outcomes,
            "brier": self.brier, "ece": self.ece,
            "reliability": [b.as_dict() for b in self.reliability],
            "suspended": self.suspended, "reason": self.reason,
            "worst_bin_deviation": self.worst_bin_deviation,
            "worst_bin": list(self.worst_bin) if self.worst_bin else None,
            "thin_bins": self.thin_bins,
        }


@dataclass(frozen=True, slots=True)
class MonitorReport:
    by_family: dict[str, FamilyScore]
    suspended_families: tuple[str, ...]
    unscored_families: tuple[str, ...]
    refit_requested: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "by_family": {k: v.as_dict() for k, v in self.by_family.items()},
            "suspended_families": list(self.suspended_families),
            "unscored_families": list(self.unscored_families),
            "refit_requested": self.refit_requested,
        }

    def summary(self) -> str:
        header = (f"{'family':<12}{'n':>6}{'Brier':>9}{'ECE':>8}"
                  f"{'vs coin':>9}  status")
        lines = [header, "-" * len(header)]
        for name, score in sorted(self.by_family.items()):
            if score.suspended is None:
                status = f"UNSCORED ({score.reason})"
                brier = ece = coin = "-"
            else:
                status = "SUSPENDED" if score.suspended else "ok"
                brier = f"{score.brier:.3f}"
                ece = f"{score.ece:.3f}"
                coin = ("worse" if score.brier is not None
                        and score.brier >= COIN_FLIP_BRIER else "better")
            lines.append(
                f"{name:<12}{score.outcomes:>6}{brier:>9}{ece:>8}{coin:>9}  {status}"
            )
        lines.append("")
        lines.append(
            f"suspended: {', '.join(self.suspended_families) or 'none'}   "
            f"refit requested: {self.refit_requested}"
        )
        return "\n".join(lines)


# ── The three metrics ────────────────────────────────────────────────────────


def brier_score(predictions: Sequence[Prediction]) -> float | None:
    """Mean squared error of a probability. None on an empty sample.

    0.25 is what you get by saying 0.5 to everything, which is why the
    measured 0.255 was worse than useless rather than merely weak.
    """
    if not predictions:
        return None
    total = sum(
        (p.calibrated_confidence - (1.0 if p.hit else 0.0)) ** 2
        for p in predictions
    )
    return total / len(predictions)


def reliability_curve(
    predictions: Sequence[Prediction], bins: int
) -> tuple[Bin, ...]:
    """Observed hit rate against stated confidence, in equal-width bins.

    Empty bins are KEPT, with count 0 and None rates. Dropping them would make
    a family that only ever states 0.9 look like it covers the whole range -
    and that is exactly the shape `reorder` currently has.
    """
    bins = max(1, bins)
    width = 1.0 / bins
    buckets: list[list[Prediction]] = [[] for _ in range(bins)]
    for prediction in predictions:
        index = min(bins - 1, int(prediction.calibrated_confidence / width))
        buckets[index].append(prediction)

    out: list[Bin] = []
    for index, bucket in enumerate(buckets):
        lower = index * width
        upper = lower + width
        # Declared optional up front: an empty bin genuinely HAS no mean and
        # no rate, and letting the type say so is what stops a later reader
        # treating a 0.0 in an empty bin as an observed rate of zero.
        mean_stated: float | None = None
        observed: float | None = None
        if bucket:
            mean_stated = sum(p.calibrated_confidence for p in bucket) / len(bucket)
            observed = sum(1 for p in bucket if p.hit) / len(bucket)
        out.append(Bin(lower, upper, len(bucket), mean_stated, observed))
    return tuple(out)


def expected_calibration_error(curve: Sequence[Bin], total: int) -> float | None:
    """Weighted mean gap between stated and observed. None when nothing landed.

    Weighted by bin population on purpose: a bin holding two recommendations
    being 40 points out matters far less than a bin holding two hundred being
    10 points out, and an unweighted mean would say the opposite.
    """
    if total <= 0:
        return None
    error = 0.0
    for bucket in curve:
        if bucket.count and bucket.mean_stated is not None \
                and bucket.observed_rate is not None:
            error += (bucket.count / total) * abs(
                bucket.mean_stated - bucket.observed_rate
            )
    return error


@dataclass(frozen=True, slots=True)
class MonitorRequest:
    predictions: Sequence[Prediction]


@stage("calibrate_monitor", "1.0.0")
def monitor_calibration(
    request: MonitorRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Score every family, and suspend the ones that have drifted."""
    record_inputs("calibrate_apply.value", "recommendation_evaluations.outcome")

    threshold = config.get(ECE_SUSPEND_THRESHOLD, ctx)
    max_dev = float(config.get(MAX_RELIABILITY_DEVIATION, ctx))
    min_bin = int(config.get(MIN_BIN_OUTCOMES, ctx))
    bins = config.get(RELIABILITY_BINS, ctx)
    min_outcomes = config.get(MIN_OUTCOMES_TO_SCORE, ctx)

    grouped: dict[str, list[Prediction]] = {}
    for prediction in request.predictions:
        grouped.setdefault(prediction.family, []).append(prediction)

    by_family: dict[str, FamilyScore] = {}
    for family, group in sorted(grouped.items()):
        if len(group) < min_outcomes:
            by_family[family] = FamilyScore(
                family=family, outcomes=len(group), brier=None, ece=None,
                reliability=(), suspended=None,
                reason=f"too_few_outcomes:{len(group)}<{min_outcomes}",
            )
            continue

        curve = reliability_curve(group, bins)
        ece = expected_calibration_error(curve, len(group))

        # N2.2 - the per-bin rule, ALONGSIDE the ECE rule rather than instead of
        # it. They catch different failures: ECE catches a curve that is wrong
        # on average, the per-bin gap catches a curve that is wrong exactly
        # where a particular owner is reading it.
        worst_dev: float | None = None
        worst_bin: tuple[float, float] | None = None
        thin_bins = 0
        for b in curve:
            if not b.count or b.mean_stated is None or b.observed_rate is None:
                continue
            if b.count < min_bin:
                # REPORTED but not evidence. An observed rate from fewer than
                # min_bin cards cannot be within the threshold of anything: at
                # n=5 the only reachable rates are 0, 20, 40, 60, 80 and 100
                # percent, so the granularity alone exceeds the test.
                thin_bins += 1
                continue
            dev = abs(b.observed_rate - b.mean_stated)
            if worst_dev is None or dev > worst_dev:
                worst_dev, worst_bin = dev, (b.lower, b.upper)

        over_ece = ece is not None and ece > threshold
        over_bin = worst_dev is not None and worst_dev > max_dev
        suspended = over_ece or over_bin
        why: str | None = None
        if over_ece and over_bin:
            why = (f"ece_above_threshold:{ece:.3f}>{threshold}"
                   f";bin_deviation:{worst_dev:.3f}>{max_dev}")
        elif over_ece and ece is not None:
            why = f"ece_above_threshold:{ece:.3f}>{threshold}"
        elif over_bin and worst_dev is not None:
            lo, hi = worst_bin or (0.0, 0.0)
            why = (f"bin_deviation:{worst_dev:.3f}>{max_dev}"
                   f"@{lo:.1f}-{hi:.1f}")
        by_family[family] = FamilyScore(
            family=family,
            outcomes=len(group),
            brier=brier_score(group),
            ece=ece,
            reliability=curve,
            suspended=suspended,
            reason=why,
            worst_bin_deviation=worst_dev,
            worst_bin=worst_bin,
            thin_bins=thin_bins,
        )

    suspended_families = tuple(
        name for name, score in by_family.items() if score.suspended is True
    )
    unscored = tuple(
        name for name, score in by_family.items() if score.suspended is None
    )
    report = MonitorReport(
        by_family=by_family,
        suspended_families=suspended_families,
        unscored_families=unscored,
        # A suspension IS the refit trigger. Routine, not an incident.
        refit_requested=bool(suspended_families),
    )
    return StageResult.success(
        report,
        Provenance(
            own_observations=len(request.predictions),
            own_weight=1.0,
            evidence_state="ESTABLISHED" if by_family else "NEW",
            inputs=("calibrate_apply.value",
                    "recommendation_evaluations.outcome"),
        ),
    )


__all__ = [
    "MIN_BIN_OUTCOMES",
    "MAX_RELIABILITY_DEVIATION",
    "COIN_FLIP_BRIER",
    "ECE_SUSPEND_THRESHOLD",
    "MIN_OUTCOMES_TO_SCORE",
    "RELIABILITY_BINS",
    "Bin",
    "FamilyScore",
    "MonitorReport",
    "MonitorRequest",
    "Prediction",
    "brier_score",
    "expected_calibration_error",
    "monitor_calibration",
    "reliability_curve",
]
