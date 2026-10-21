"""Fit the transform from STATED confidence to OBSERVED outcome rate.

    stated 0.90  ->  observed 0.34      the curve learns this
    stated 0.60  ->  observed 0.31      and this
    stated 0.30  ->  observed 0.29      and that the engine cannot tell them apart

THE MEASURED PROBLEM
    The backtest scored mean stated confidence 0.48 against an actual hit rate
    of 0.23 - Brier 0.255, where 0.25 is a coin flip. The number carried no
    information.

    A figure that says 80% and is right 23% of the time is WORSE than no
    figure, because the interface and the owner both treat it as meaningful.
    Removing it would at least be honest; leaving it uncalibrated is a claim we
    have not earned.

    The live data says the same thing from a different angle. Across the 79
    recommendations currently stored, stated confidence averages 0.796, and
    `reorder` ranges from 0.87 to 0.95 - it has never once said it was unsure.
    A number that never varies cannot be carrying information about a world
    that does.

WHY ISOTONIC AND NOT A SIGMOID
    Platt scaling assumes the miscalibration has a particular S-shape. We have
    no reason to believe that, and every reason to think different families are
    wrong in different ways - `reorder` is uniformly overconfident, `promote`
    ranges 0.33 to 0.83 and may be closer to honest. Isotonic regression
    assumes only MONOTONICITY: more stated confidence should not mean fewer
    hits. That is the one thing we are willing to assert.

WHY IT IS WRITTEN OUT RATHER THAN IMPORTED
    `sklearn.isotonic.IsotonicRegression` is the obvious call and this service
    has no sklearn - no numpy, no scipy, nothing numeric. Pool-Adjacent-
    Violators is forty lines, exact (not iterative-approximate), and
    deterministic. Adding a numeric stack to a stateless service for forty
    lines of arithmetic would be the wrong trade, and the same one sheet 07
    declined over LightGBM.

A FIT IS AN ARTIFACT WITH A VERSION, NOT A MUTABLE GLOBAL
    Every fit carries the date it was fitted and a digest of the outcomes it
    was fitted on. `Provenance.calibration_version` records which curve shaped
    a given card, so a recommendation shown six months ago can still be
    explained. A calibration nobody can audit is just a second unexplained
    number stacked on the first.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

#: The recommendation families, mirroring ACTION_CLAIMS in
#: backend/services/recommendationGateService.js. Each is calibrated
#: separately: they make different claims, are produced by different logic and
#: are wrong in different directions.
FAMILIES: tuple[str, ...] = (
    "markdown", "liquidate", "bundle",
    "reorder", "pre_stock", "stock_new",
    "promote", "endcap", "cold_box",
)

MIN_OUTCOMES_TO_FIT = Setting(
    name="calibrate.min_outcomes_to_fit",
    default=50,
    unit="scored outcomes in one (family, demand class) cell",
    owner="calibration",
    why="provisional; below this an isotonic fit is shape-fitting noise - it "
        "will happily interpolate five points into a confident-looking "
        "staircase. A cell under the floor gets the IDENTITY transform with a "
        "reason attached, never a guessed curve. To be measured against "
        "holdout Brier once outcomes accumulate in wave 6",
    status="PROVISIONAL",
)

MIN_DISTINCT_CONFIDENCES = Setting(
    name="calibrate.min_distinct_confidences",
    default=4,
    unit="distinct stated values",
    owner="calibration",
    why="provisional; a cell where every recommendation stated 0.9 has no "
        "curve to fit - there is one point, and a transform through one point "
        "is a constant, not a calibration. This is not hypothetical: "
        "`reorder` currently spans 0.87 to 0.95 across 15 rows",
    status="PROVISIONAL",
)


#: The wildcard that makes the fallback chain explicit rather than implicit.
#: A fit keyed with ANY in a position was fitted POOLED over that dimension, so
#: `(reorder, smooth, ANY)` is the parent of `(reorder, smooth, slow)` and
#: `(ANY, ANY, ANY)` is the global curve. Writing the chain as keys rather than
#: as branching logic is what lets `fit_and_basis` name which rung it used.
ANY = "*"


@dataclass(frozen=True, slots=True)
class Outcome:
    """One scored recommendation: what we claimed, and what happened."""

    family: str
    #: The demand class from sheet 07. Calibration is fitted per (family,
    #: class) because a `reorder` on a smooth SKU and a `reorder` on a lumpy
    #: one are not the same claim with the same reliability.
    demand_class: str
    stated_confidence: float
    #: Did it work. A bool, not a score - calibration maps to a RATE, and a
    #: rate needs a denominator of things that either happened or did not.
    hit: bool
    #: N2.1 - the velocity band. A SKU selling 1 a month and one selling 40 a
    #: month do not share a reliability curve: the slow one's outcome is mostly
    #: Poisson noise and the fast one's is mostly signal, so pooling them fits a
    #: curve to neither. Appended with a default, so every existing construction
    #: site keeps working and lands in the pooled parent cell.
    velocity_band: str = ANY

    def __post_init__(self) -> None:
        if not 0.0 <= self.stated_confidence <= 1.0:
            raise ValueError(
                f"stated_confidence must be within 0..1, got "
                f"{self.stated_confidence}"
            )


@dataclass(frozen=True, slots=True)
class IsotonicFit:
    """A fitted step function for one (family, demand class, velocity) cell."""

    family: str
    demand_class: str
    #: Breakpoints, ascending. `ys` is non-decreasing by construction.
    xs: tuple[float, ...]
    ys: tuple[float, ...]
    n_outcomes: int
    #: The stated-confidence range this curve actually saw. Outside it the
    #: curve is CLIPPED, never extrapolated - see `predict`.
    domain_lo: float
    domain_hi: float
    fitted_at: date
    #: Which velocity band this curve was fitted on. ANY means it was pooled
    #: across bands - the parent cell. Appended so existing construction keeps
    #: working.
    velocity_band: str = ANY

    @property
    def levels(self) -> int:
        """How many DISTINCT values this curve can return.

        One means the curve is a constant: every stated confidence maps to the
        same number, so it carries the store's base rate and no ordering
        information whatsoever. That is the correct fit for a cell with few
        outcomes - pool-adjacent-violators merges every violating pair until the
        sequence is monotone, and with 56 outcomes on one noisy cell that is a
        single block - but a card stating it nine times in a row reads as nine
        measurements that happen to agree.

        Measured on the first production bundle: Bethany's nine reorder cards
        spanned raw scores 0.064 to 0.483 and every one displayed 0.444.
        """
        return len(set(self.ys))

    @property
    def is_constant(self) -> bool:
        return self.levels <= 1

    def predict(self, stated: float) -> tuple[float, tuple[str, ...]]:
        """Calibrated value, plus any reasons the caller must carry forward.

        NEVER EXTRAPOLATES. A stated confidence above anything the curve was
        fitted on is clipped to the top knot and says so. Extrapolating an
        isotonic fit means continuing the last segment into a region where no
        outcome was ever observed, which is exactly the unearned claim this
        sheet exists to remove - and it would be made most often precisely
        where the engine is most overconfident.
        """
        reasons: list[str] = []
        x = stated
        if x < self.domain_lo:
            reasons.append(
                f"clipped_below_fitted_range:{stated:.3f}<{self.domain_lo:.3f}"
            )
            x = self.domain_lo
        elif x > self.domain_hi:
            reasons.append(
                f"clipped_above_fitted_range:{stated:.3f}>{self.domain_hi:.3f}"
            )
            x = self.domain_hi
        return _step(self.xs, self.ys, x), tuple(reasons)

    def as_dict(self) -> dict[str, Any]:
        return {
            "family": self.family, "demand_class": self.demand_class,
            "velocity_band": self.velocity_band,
            "xs": list(self.xs), "ys": list(self.ys),
            "n_outcomes": self.n_outcomes,
            # DERIVED, not stored: it is a property of `ys` and persisting it
            # separately would let the two disagree after a round trip.
            "levels": self.levels,
            "domain_lo": self.domain_lo, "domain_hi": self.domain_hi,
            "fitted_at": self.fitted_at.isoformat(),
        }


@dataclass(frozen=True, slots=True)
class CalibrationBundle:
    """Every fit produced by one run, addressed by (family, demand class).

    Versioned and immutable. `apply` takes one of these; it never reaches for
    a module-level global, because a global cannot be replayed.
    """

    version: str
    fitted_at: date
    fits: Mapping[tuple[str, str], IsotonicFit]
    #: Cells that were seen but NOT fitted, and why. Carried rather than
    #: dropped: "we looked and there was not enough" is information, and its
    #: absence would read as "we never looked".
    skipped: Mapping[tuple[str, str], str]

    def fit_for(
        self, family: str, demand_class: str, velocity_band: str = ANY
    ) -> IsotonicFit | None:
        """The best available curve for this cell, walking the fallback chain."""
        return self.fit_and_basis(family, demand_class, velocity_band)[0]

    def fit_and_basis(
        self, family: str, demand_class: str, velocity_band: str = ANY
    ) -> tuple[IsotonicFit | None, str]:
        """The curve AND which rung of the chain supplied it.

        N2.1's fallback, written as a walk over keys rather than as branching
        logic, so the rung used has a name that can travel onto the card:

            (family, class, band)   the cell itself - the most specific
            (family, class, ANY)    the parent, pooled across velocity bands
            (ANY, ANY, ANY)         the global curve
            nothing                 the caller states a BAND, not a number

        Each rung is a real fit over real outcomes; the chain only ever trades
        specificity for sample size. It never invents a curve, and the last rung
        is an absence rather than an identity transform dressed up as a fit.
        """
        chain = (
            ((family, demand_class, velocity_band), "cell"),
            ((family, demand_class, ANY), "parent_cell"),
            ((ANY, ANY, ANY), "global_curve"),
        )
        for key, basis in chain:
            fit = self.fits.get(key)
            if fit is not None:
                return fit, basis
        return None, "no_curve"

    def as_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "fitted_at": self.fitted_at.isoformat(),
            "fits": [f.as_dict() for f in self.fits.values()],
            # THREE parts, matching the lookup key. A two-part key cannot be
            # read back into the tuple `cell_for` searches.
            "skipped": {"/".join(str(p) for p in k): v
                        for k, v in self.skipped.items()},
        }


# ── Reading a bundle back ────────────────────────────────────────────────────


def fit_from_dict(payload: Mapping[str, Any]) -> IsotonicFit:
    """One curve, read back from storage.

    `xs` and `ys` are returned as TUPLES, matching what `fit_calibration`
    produces. A list would compare unequal to a freshly fitted curve and would be
    mutable, and a curve that can be edited after it was fitted is not a record of
    anything.
    """
    return IsotonicFit(
        family=str(payload["family"]),
        demand_class=str(payload["demand_class"]),
        xs=tuple(float(x) for x in payload["xs"]),
        ys=tuple(float(y) for y in payload["ys"]),
        n_outcomes=int(payload["n_outcomes"]),
        domain_lo=float(payload["domain_lo"]),
        domain_hi=float(payload["domain_hi"]),
        fitted_at=date.fromisoformat(str(payload["fitted_at"])[:10]),
        velocity_band=str(payload.get("velocity_band", ANY)),
    )


def bundle_from_dict(payload: Mapping[str, Any]) -> CalibrationBundle:
    """A whole bundle, read back from storage.

    WHY THIS EXISTS. `as_dict` has been here since the module was written and
    nothing could read it back, so a curve could be fitted, serialised, stored -
    and never applied. That is the gap that kept stage 8 inert in production while
    the harness happily fitted curves it then threw away.

    The keys are rebuilt as the `(family, demand_class)` tuples `apply` looks up,
    because a bundle whose keys are strings silently misses every lookup and falls
    back to identity - which looks exactly like "no fit exists yet".
    """
    # A THREE-TUPLE, including the velocity band. `cell_for` walks
    #     (family, demand_class, velocity_band) -> (family, demand_class, ANY)
    #     -> (ANY, ANY, ANY)
    # so a two-tuple key misses every rung and the bundle silently falls back to
    # identity - which is indistinguishable from "no fit exists yet". The first
    # version of this function had exactly that bug, and it was caught only by
    # round-tripping a real bundle and comparing the APPLIED value rather than the
    # fit count, which matched perfectly while nothing worked.
    fits: dict[tuple[str, str, str], IsotonicFit] = {}
    for raw in payload.get("fits") or ():
        fit = fit_from_dict(raw)
        fits[(fit.family, fit.demand_class, fit.velocity_band)] = fit
    skipped: dict[tuple[str, str, str], str] = {}
    for key, reason in (payload.get("skipped") or {}).items():
        parts = str(key).split("/")
        while len(parts) < 3:
            parts.append(ANY)
        skipped[(parts[0], parts[1], parts[2])] = str(reason)
    return CalibrationBundle(
        version=str(payload["version"]),
        fitted_at=date.fromisoformat(str(payload["fitted_at"])[:10]),
        fits=fits, skipped=skipped,
    )


# ── Pool Adjacent Violators ──────────────────────────────────────────────────


def pool_adjacent_violators(
    points: Sequence[tuple[float, float, float]],
) -> list[tuple[float, float]]:
    """Weighted isotonic regression. `points` is (x, y, weight), x ascending.

    The algorithm in one sentence: walk left to right, and whenever a block's
    mean is lower than the block before it, merge the two into their weighted
    mean and re-check backwards.

    Exact and O(n) amortised - each block is merged at most once. No
    iteration-to-convergence, so no tolerance to tune and nothing to be
    non-deterministic about.
    """
    # Each block: [weighted sum, weight, x of the block's right edge]
    blocks: list[list[float]] = []
    for x, y, weight in points:
        blocks.append([y * weight, weight, x])
        # Merge backwards while the previous block's mean exceeds this one's.
        while len(blocks) > 1:
            previous, current = blocks[-2], blocks[-1]
            if previous[0] / previous[1] <= current[0] / current[1]:
                break
            merged = [
                previous[0] + current[0],
                previous[1] + current[1],
                current[2],
            ]
            blocks[-2:] = [merged]
    return [(block[2], block[0] / block[1]) for block in blocks]


def _step(xs: Sequence[float], ys: Sequence[float], x: float) -> float:
    """Value of the fitted step function at `x`, within the fitted domain.

    A step rather than linear interpolation between knots: isotonic regression
    produces a piecewise-CONSTANT solution, and smoothing between the knots
    would invent intermediate values the fit never asserted.
    """
    if not xs:
        return x
    for index, knot in enumerate(xs):
        if x <= knot:
            return ys[index]
    return ys[-1]


def _version_for(as_of: date, outcomes: Sequence[Outcome]) -> str:
    """`YYYY-MM-DD.<digest>` — the date, and what it was fitted on.

    The digest covers the outcomes themselves, so two fits on the same day
    over different data get different versions. A version that only carried
    the date would make a refit indistinguishable from the fit it replaced,
    and the whole point of recording it is to tell them apart.
    """
    payload = json.dumps(
        [
            [o.family, o.demand_class, round(o.stated_confidence, 6), o.hit]
            for o in sorted(
                outcomes,
                key=lambda o: (o.family, o.demand_class, o.stated_confidence, o.hit),
            )
        ],
        separators=(",", ":"),
    )
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]
    return f"{as_of.isoformat()}.{digest}"


@dataclass(frozen=True, slots=True)
class FitRequest:
    """Accumulated outcomes to fit on. Supplied, never fetched."""

    outcomes: Sequence[Outcome]


@stage("calibrate_fit", "1.0.0")
def fit_calibration(
    request: FitRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Fit one isotonic curve per (family, demand class). Offline, weekly.

    Always returns ok=True, including when nothing could be fitted. An empty
    bundle is a true statement - "we have no outcomes yet" - and `apply`
    handles it by running the identity transform. Failing here would make the
    whole pipeline depend on outcomes existing, which is exactly the coupling
    the sheet says to avoid while they accumulate.
    """
    record_inputs("recommendation_evaluations.outcome", "recommendations.confidence")

    min_outcomes = config.get(MIN_OUTCOMES_TO_FIT, ctx)
    min_distinct = config.get(MIN_DISTINCT_CONFIDENCES, ctx)

    # N2.1 - EVERY RUNG OF THE CHAIN IS FITTED, not just the leaf. A cell that
    # is too thin on its own must have somewhere to fall back to, and that
    # somewhere has to be a real curve over real outcomes rather than an
    # identity transform pretending to be one. So the same outcomes are pooled
    # three ways, most specific first:
    #
    #   (family, class, band)  the leaf        - most specific, thinnest
    #   (family, class, ANY)   the parent      - pooled across velocity bands
    #   (ANY, ANY, ANY)        the global      - every outcome in the run
    #
    # The thresholds then decide which rungs survive, and `fit_and_basis` walks
    # down until one does. Fitting the parents costs one extra pass and is what
    # turns "no_fit_for_cell" from a dead end into a fallback.
    cells: dict[tuple[str, str, str], list[Outcome]] = {}
    for outcome in request.outcomes:
        leaf = (outcome.family, outcome.demand_class, outcome.velocity_band)
        parent = (outcome.family, outcome.demand_class, ANY)
        cells.setdefault(leaf, []).append(outcome)
        if leaf != parent:
            cells.setdefault(parent, []).append(outcome)
        cells.setdefault((ANY, ANY, ANY), []).append(outcome)

    fits: dict[tuple[str, str, str], IsotonicFit] = {}
    skipped: dict[tuple[str, str, str], str] = {}

    for key, group in sorted(cells.items()):
        if len(group) < min_outcomes:
            skipped[key] = f"too_few_outcomes:{len(group)}<{min_outcomes}"
            continue
        distinct = {round(o.stated_confidence, 6) for o in group}
        if len(distinct) < min_distinct:
            skipped[key] = (
                f"too_few_distinct_confidences:{len(distinct)}<{min_distinct}"
            )
            continue

        ordered = sorted(group, key=lambda o: o.stated_confidence)
        points = [
            (o.stated_confidence, 1.0 if o.hit else 0.0, 1.0) for o in ordered
        ]
        knots = pool_adjacent_violators(points)
        fits[key] = IsotonicFit(
            family=key[0],
            demand_class=key[1],
            velocity_band=key[2],
            xs=tuple(x for x, _ in knots),
            ys=tuple(y for _, y in knots),
            n_outcomes=len(group),
            domain_lo=ordered[0].stated_confidence,
            domain_hi=ordered[-1].stated_confidence,
            fitted_at=ctx.as_of,
        )

    bundle = CalibrationBundle(
        version=_version_for(ctx.as_of, request.outcomes),
        fitted_at=ctx.as_of,
        fits=fits,
        skipped=skipped,
    )
    return StageResult.success(
        bundle,
        Provenance(
            own_observations=len(request.outcomes),
            own_weight=1.0,
            evidence_state="ESTABLISHED" if fits else "NEW",
            inputs=("recommendation_evaluations.outcome",
                    "recommendations.confidence"),
            calibration_version=bundle.version,
        ),
    )


__all__ = [
    "bundle_from_dict",
    "fit_from_dict",
    "ANY",
    "FAMILIES",
    "MIN_DISTINCT_CONFIDENCES",
    "MIN_OUTCOMES_TO_FIT",
    "CalibrationBundle",
    "FitRequest",
    "IsotonicFit",
    "Outcome",
    "fit_calibration",
    "pool_adjacent_violators",
]
