"""Apply calibration to a raw confidence — ONLINE, before the decision.

    raw 0.91  --[isotonic, reorder/smooth]-->  0.34   ranked on 0.34
    raw 0.91  --[identity, no fit yet]------>  0.91   ranked on 0.91, and says so

WHERE THIS RUNS IS THE WHOLE SHEET
    Calibration is applied BEFORE ranking (stage 13) and before display
    (stage 18) - not afterwards as a grade. That ordering is the point: it
    shapes WHAT GETS RECOMMENDED rather than annotating what already was.

    Applied afterwards, an overconfident `reorder` still wins the ranking and
    still reaches the owner; the calibration merely prints a smaller number
    beside it. Applied before, the same `reorder` loses its place to a
    `markdown` whose stated confidence was lower but whose observed hit rate
    is higher - which is the decision changing, which is the only outcome
    worth the engineering.

SHIPPED FIRST AS THE IDENTITY TRANSFORM, DELIBERATELY
    `recommendation_evaluations` currently holds ZERO rows. There are 79
    stored recommendations, every one with a stated confidence, and not a
    single scored outcome to check them against. So no curve can be fitted
    today, and none is.

    The plumbing ships complete anyway - request, result, reasons, the version
    in Provenance, and the call site in the ranking path. When outcomes
    accumulate the work is fitting a curve, not threading a new value through
    eleven stages. That sequencing is the sheet's own instruction and it is
    the difference between a week and a quarter.

NOTHING HERE IS A SILENT DEFAULT
    Every identity result carries a REASON saying why it was the identity: no
    bundle, no fit for this cell, the family suspended, too few outcomes. An
    unexplained passthrough and a fitted curve would look identical on the
    wire, and the first would quietly become permanent.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from app.pipeline.calibrate.fit import ANY, CalibrationBundle
from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, cfg

#: What `transform` says when no curve was applied.
IDENTITY = "identity"
ISOTONIC = "isotonic"

#: The version string used when no curve was applied. A real version, not
#: None, so that a card ranked without calibration is distinguishable from a
#: card whose provenance predates this sheet entirely.
IDENTITY_VERSION = "identity.v1"


@dataclass(frozen=True, slots=True)
class ApplyRequest:
    """One confidence to calibrate, and the context that selects the curve."""

    raw_confidence: float
    family: str
    #: The sheet-07 demand class. Part of the key, because a `reorder` on a
    #: smooth SKU and a `reorder` on a lumpy one are not equally reliable.
    demand_class: str
    #: None is normal and expected - it means no fit has been produced yet.
    bundle: CalibrationBundle | None = None
    #: Families suspended by the monitor (sheet 08 monitor.py). A suspended
    #: family falls back to identity rather than using a curve the monitor has
    #: said is drifting.
    suspended_families: Sequence[str] = ()
    #: N2.1 - the velocity band, so the three-way cell can be addressed. ANY
    #: means "do not narrow", which lands on the pooled parent cell and is the
    #: behaviour every existing caller already had.
    velocity_band: str = ANY

    def __post_init__(self) -> None:
        if not 0.0 <= self.raw_confidence <= 1.0:
            raise ValueError(
                f"raw_confidence must be within 0..1, got {self.raw_confidence}"
            )


@dataclass(frozen=True, slots=True)
class Calibrated:
    """The value ranking and display must both use, and its audit trail."""

    raw: float
    value: float
    transform: str
    version: str
    family: str
    demand_class: str
    reasons: tuple[str, ...]
    #: Distinct values the curve applied can return. 1 means it is a CONSTANT and
    #: discriminates between no two cards. 0 when no curve was applied.
    levels: int = 0

    @property
    def was_calibrated(self) -> bool:
        return self.transform != IDENTITY

    @property
    def discriminates(self) -> bool:
        """Whether this figure can differ between two cards at all.

        A constant curve is not WRONG - it is the store's measured base rate, and
        it is a better number than the raw score, which was 0.85-0.97 stated
        against about 0.65 actual. It simply must not be displayed as though it
        were card-specific, because an owner comparing two cards on it would
        conclude they are equally likely when the figure says nothing of the kind.
        """
        return self.was_calibrated and self.levels > 1

    def as_dict(self) -> dict[str, Any]:
        return {
            "raw": self.raw, "value": self.value,
            "transform": self.transform, "version": self.version,
            "family": self.family, "demand_class": self.demand_class,
            "reasons": list(self.reasons),
            "levels": self.levels,
            "discriminates": self.discriminates,
        }

    def explain(self) -> str:
        if not self.was_calibrated:
            return (
                f"Confidence {self.raw:.0%} shown as stated - no calibration "
                "curve for this kind of recommendation yet."
            )
        if not self.discriminates:
            # Said plainly, because the alternative is an owner reading a store
            # average as this card's own chance.
            return (
                f"{self.value:.0%} is how often this kind of recommendation has "
                f"worked at this store overall - there are not yet enough scored "
                f"outcomes to tell one card from another."
            )
        direction = "lowered" if self.value < self.raw else "raised"
        return (
            f"Confidence {direction} from {self.raw:.0%} to {self.value:.0%}, "
            f"from how often this kind of recommendation has actually worked."
        )


@stage("calibrate_apply", "1.0.0")
def apply_calibration(
    request: ApplyRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Calibrate one confidence. Always succeeds; never guesses.

    Returns the identity transform - with a reason - whenever a curve cannot
    honestly be applied. It never invents one, and it never extrapolates
    outside the range a curve was fitted on.
    """
    record_inputs("calibrate_fit.bundle", "recommendations.confidence")

    reasons: list[str] = []
    fit = None

    if request.bundle is None:
        reasons.append("no_calibration_bundle")
    elif request.family in tuple(request.suspended_families):
        # Suspension is a NORMAL state, not an incident - see monitor.py.
        reasons.append(f"family_suspended:{request.family}")
    else:
        # N2.1 - walk the fallback chain, and SAY WHICH RUNG was used. A curve
        # fitted on this exact cell and one borrowed from the global pool are
        # not the same claim, and once both are a float they are
        # indistinguishable unless the basis travels with them.
        fit, basis = request.bundle.fit_and_basis(
            request.family, request.demand_class, request.velocity_band
        )
        if fit is None:
            # Every rung that was TRIED and refused, with the reason the fitter
            # recorded. "we looked and there was not enough" is information, and
            # a generic no_fit_for_cell throws it away - which is how a thin
            # cell and a broken pipeline come to look identical.
            tried = [
                (request.family, request.demand_class, request.velocity_band),
                (request.family, request.demand_class, ANY),
                (ANY, ANY, ANY),
            ]
            why = next(
                (request.bundle.skipped[k] for k in tried
                 if k in request.bundle.skipped),
                None,
            )
            reasons.append(
                f"no_fit_for_cell:{request.family}/{request.demand_class}"
                + (f"/{request.velocity_band}"
                   if request.velocity_band != ANY else "")
                + (f":{why}" if why else "")
            )
        elif basis != "cell":
            # Not an error, but not the same thing either: this confidence was
            # calibrated on a POOLED curve because its own cell was too thin.
            reasons.append(f"calibrated_on:{basis}")

    if fit is None:
        calibrated = Calibrated(
            raw=request.raw_confidence,
            value=request.raw_confidence,
            transform=IDENTITY,
            version=IDENTITY_VERSION,
            family=request.family,
            demand_class=request.demand_class,
            reasons=tuple(reasons),
        )
        return StageResult.success(calibrated, _provenance(calibrated))

    value, clip_reasons = fit.predict(request.raw_confidence)
    if fit.is_constant:
        # Carried as a REASON, so it travels with the figure through every
        # consumer rather than having to be re-derived from the bundle.
        clip_reasons = clip_reasons + (
            f"constant_curve:{fit.n_outcomes}_outcomes_one_level",)
    calibrated = Calibrated(
        raw=request.raw_confidence,
        value=value,
        transform=ISOTONIC,
        version=request.bundle.version,  # type: ignore[union-attr]
        family=request.family,
        demand_class=request.demand_class,
        reasons=tuple(reasons) + clip_reasons,
        levels=fit.levels,
    )
    return StageResult.success(calibrated, _provenance(calibrated))


def calibrate_many(
    requests: Sequence[ApplyRequest],
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> list[Calibrated]:
    """Calibrate a batch, preserving order.

    Order is preserved because the caller ranks on the result, and a reorder
    here would silently permute the ranking - a bug that looks like a modelling
    difference rather than a plumbing one.
    """
    out: list[Calibrated] = []
    for request in requests:
        result = apply_calibration(request, ctx, config)
        if result.ok and result.value is not None:
            out.append(result.value)
    return out


def rank_key(calibrated: Calibrated) -> float:
    """What ranking sorts on. THE calibrated value, never the raw one.

    A one-line function so that "ranking uses the calibrated value" is a fact
    a test can assert about the code, rather than a convention every future
    call site has to remember.
    """
    return calibrated.value


def _provenance(calibrated: Calibrated) -> Provenance:
    return Provenance(
        own_observations=0,
        own_weight=1.0,
        evidence_state="NEW" if not calibrated.was_calibrated else "ESTABLISHED",
        inputs=("calibrate_fit.bundle", "recommendations.confidence"),
        calibration_version=calibrated.version,
    )


__all__ = [
    "IDENTITY",
    "IDENTITY_VERSION",
    "ISOTONIC",
    "ApplyRequest",
    "Calibrated",
    "apply_calibration",
    "calibrate_many",
    "rank_key",
]
