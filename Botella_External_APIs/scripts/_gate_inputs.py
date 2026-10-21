"""Measure the gate's inputs from ledgers, so every check actually runs.

WHY THIS FILE EXISTS
    Four of the gate's seven checks had never run. Not failed - printed "not
    measured" at every store, every time, since the day the gate was written,
    because nothing ever computed the fields `_gates.py` reads. The table was
    issuing SHIP and DO NOT SHIP verdicts on ONE live check out of four in gate A
    and ONE out of three in gate B, and a verdict resting on a quarter of its
    stated evidence is worse than no verdict, because it looks like one.

    This module computes all of them, in one place, from the ledger.

THE CHECK THAT WAS NOT WRONG BUT UNREACHABLE
    The old `promise_kept` check asked for 85-95% of cards to deliver at least the
    promised increment. That cannot happen, at any store, under any promise, and
    the proof is one line of arithmetic: a promise of at least one unit can only
    be kept on a card whose realised increment is at least one unit, so

        promise_kept  <=  hit rate

    and the hit rates are 83 / 76 / 71 / 62 / 49%. The check was therefore a
    restatement of the accuracy target wearing the costume of an independent test,
    and it could not pass until the thing it was meant to help verify had already
    passed. Worse, the field wired into it was `prediction_accuracy`, a ratio of
    TOTALS - so the number being compared to a per-card kept-rate band was not
    even the same kind of quantity, and Marshfield was being handed a SHIP for
    under-delivering 11% in aggregate while Cork Runner failed for over-delivering.

    It is replaced by two checks that ask the two separable questions it had
    merged, and the fill ratio is fed to the one it is actually the statistic for:

        promise_unbiased    is the stated quantity systematically too big or too
                            small? The fill ratio, banded around 100%. Checkable
                            by the owner against the till: "we said 78, you got
                            74". Nothing about whether the card was RIGHT.
        interval_coverage   does the published range contain what happened? This
                            is the claim an owner can actually hold us to, and it
                            is reachable because the range is two-sided and sized
                            to each SKU's own dispersion.

    Whether the card was right at all is the hit rate, and that is already gated
    by the backtest edge and its permutation p-value. It does not need a third
    spelling.

CALIBRATION IS MEASURED OUT OF SAMPLE OR NOT AT ALL
    `ece` and `worst_bin_deviation` are computed by fitting the isotonic curve on
    EARLIER months and scoring the month under test. Fitting and scoring on the
    same slice measures how well a step function can memorise 200 points, which is
    perfectly, and would report an ECE near zero at every store forever.

    This is also why the raw `p_hit` fails so badly here (ECE 34 / 31 / 24 / 12
    points): it was never a probability. The card says so in as many words - "this
    ranks cards against each other and is not a percentage chance" - so the honest
    reading is not that the engine lies, but that it has been declining to state a
    probability at all. Running it through the curve is what turns it into one.

ONE HORIZON IS NAMED, THE REST ARE REPORTED
    Every rate here is the 30-day figure unless the field says otherwise, because
    30 days is the horizon the money gate is denominated in and mixing horizons
    inside one verdict is how a table starts comparing a 120-day hit rate to a
    30-day net. `interval_coverage` is the deliberate exception: it takes the WORST
    of the four horizons, because a range that only holds at one horizon is not a
    range the owner can rely on.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from typing import Any, Iterable, Sequence

from app.pipeline.blend.predictive_interval import (
    PredictiveInterval,
    predictive_interval,
)
from app.pipeline.calibrate.apply import ApplyRequest, apply_calibration
from app.pipeline.calibrate.fit import ANY, FitRequest, Outcome, fit_calibration
from app.pipeline.calibrate.staleness import (
    Staleness,
    staleness_from_rates,
)
from app.pipeline.calibrate.monitor import (
    MIN_BIN_OUTCOMES,
    RELIABILITY_BINS,
    Prediction,
    brier_score,
    expected_calibration_error,
    reliability_curve,
)
from app.pipeline.context import RunContext
from app.pipeline.registry import cfg

#: The horizon every rate is denominated in unless the field says otherwise.
PRIMARY_HORIZON = "30"
#: Coverage takes the worst of these, not the best and not the mean.
ALL_HORIZONS = ("30", "60", "90", "120")


@dataclass(frozen=True, slots=True)
class GateInputs:
    """Exactly the fields `_gates.py` reads, and nothing else.

    Every one is `float | None`, and None means "we could not measure this" - it
    is never a pass and never silently a zero.
    """

    #: Fill ratio as a PERCENTAGE: total delivered / total promised. The bias
    #: test. Named so it can never again be mistaken for a per-card kept rate.
    promise_fill_ratio: float | None
    #: Expected calibration error in POINTS, out of sample. Points, not a 0..1
    #: fraction, because the threshold beside it is written in points and a
    #: silent unit mismatch here reads as a store passing by a factor of 100.
    ece: float | None
    #: Worst single reliability bin gap in points, among bins with enough
    #: outcomes to be evidence.
    worst_bin_deviation: float | None
    #: Worst of the four horizons, as a percentage.
    interval_coverage: float | None
    #: Net margin per card by family, for the per-family profit check.
    family_nets: dict[str, float]
    #: Mean cards per decision date - the coverage figure printed beside every
    #: accuracy number so a rate is never read without its denominator.
    cards_per_run: float | None

    # ── Carried for the report, never for a gate ─────────────────────────────
    #: How many cards the calibration was SCORED on, and how many it was FITTED
    #: on. A 0.3-point ECE fitted on 40 cards is not the same claim as one
    #: fitted on 296, and the table says which.
    calibration_scored: int = 0
    calibration_fitted: int = 0
    #: Reliability bins that were populated but too thin to be evidence.
    thin_bins: int = 0
    #: Brier score, out of sample. Reported, not gated.
    brier: float | None = None
    #: The transform that was actually applied - "identity" means no curve was
    #: fitted, in which case `ece` describes the RAW score and the table must
    #: say so rather than implying a calibrated one.
    calibration_transform: str = "identity"
    #: Cards for which no interval could be produced, and the total considered.
    interval_refused: int = 0
    interval_considered: int = 0
    #: How far the store moved between the fit window and the scored one. ECE
    #: tracks this almost one for one, so a curve fitted before a large shift is
    #: STALE rather than miscalibrated - a different fault with a different fix.
    calibration_drift_points: float | None = None
    calibration_is_stale: bool = False
    calibration_staleness_detail: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "promise_fill_ratio": self.promise_fill_ratio,
            "ece": self.ece,
            "worst_bin_deviation": self.worst_bin_deviation,
            "interval_coverage": self.interval_coverage,
            "family_nets": dict(self.family_nets),
            "cards_per_run": self.cards_per_run,
            "calibration_scored": self.calibration_scored,
            "calibration_fitted": self.calibration_fitted,
            "thin_bins": self.thin_bins,
            "brier": self.brier,
            "calibration_transform": self.calibration_transform,
            "interval_refused": self.interval_refused,
            "interval_considered": self.interval_considered,
            "calibration_drift_points": self.calibration_drift_points,
            "calibration_is_stale": self.calibration_is_stale,
            "calibration_staleness_detail": self.calibration_staleness_detail,
        }


def _outcome_rows(ledger: Sequence[dict], horizon: str) -> list[dict]:
    """Cards with a scored outcome at this horizon. Unscored cards are dropped,
    not counted as misses: a card whose label does not exist yet has not failed."""
    rows = []
    for card in ledger:
        outcome = (card.get("outcomes") or {}).get(horizon)
        if outcome is None:
            continue
        rows.append({"card": card, "outcome": outcome})
    return rows


def _window_open_days(card: dict, outcome: dict) -> float | None:
    """Back out the horizon's OPEN days from the expected count.

    `expected = recent_rate * window_open_days` by construction in the harness, so
    this inverts it. Open days and never the calendar horizon: Bethany trades 25.7
    days in a 30-day window, and using 30 would inflate every interval's mean by
    16.8% - the same error this engine has already paid for once.
    """
    recent_rate = card.get("recent_rate")
    expected = outcome.get("expected")
    if not recent_rate or recent_rate <= 0.0 or expected is None:
        return None
    days = expected / recent_rate
    return days if days > 0.0 else None


# ── 1. The promise, as a bias test ───────────────────────────────────────────


def promise_fill_ratio(
    ledger: Sequence[dict], horizon: str = PRIMARY_HORIZON
) -> float | None:
    """Total delivered over total promised, as a percentage.

    A ratio of totals and NOT a mean of per-card ratios, on purpose: one card that
    promised 0.4 units and delivered 16 has a ratio of 40x, and a mean of ratios
    lets that single card carry the whole store's figure.
    """
    delivered = promised = 0.0
    for row in _outcome_rows(ledger, horizon):
        outcome = row["outcome"]
        gained, claim = outcome.get("gained_units"), outcome.get("promised_units")
        if gained is None or not claim or claim <= 0.0:
            continue
        delivered += gained
        promised += claim
    if promised <= 0.0:
        return None
    return delivered / promised * 100.0


def promise_kept_rate(
    ledger: Sequence[dict], horizon: str = PRIMARY_HORIZON
) -> float | None:
    """Fraction of cards that delivered at least the promised INCREMENT.

    Reported in the table and deliberately NOT gated. It is bounded above by the
    hit rate - a promise of one unit cannot be kept on a card whose increment is
    below one unit - so banding it at 85-95% would be the accuracy target restated
    as an independent check. Kept here because it is a genuinely useful number to
    read next to the hit rate, and because deleting the measurement would make the
    reason it is not gated unverifiable.
    """
    kept = total = 0
    for row in _outcome_rows(ledger, horizon):
        outcome = row["outcome"]
        gained, claim = outcome.get("gained_units"), outcome.get("promised_units")
        if gained is None or not claim or claim <= 0.0:
            continue
        total += 1
        kept += 1 if gained >= claim else 0
    return (kept / total * 100.0) if total else None


# ── 2 & 3. Calibration, out of sample ────────────────────────────────────────


def _predictions(
    ledger: Sequence[dict], horizon: str
) -> list[tuple[float, bool]]:
    out = []
    for row in _outcome_rows(ledger, horizon):
        raw, hit = row["card"].get("p_hit"), row["outcome"].get("hit")
        if raw is None or hit is None:
            continue
        out.append((min(1.0, max(0.0, float(raw))), bool(hit)))
    return out


def calibration_out_of_sample(
    *,
    fit_ledgers: Iterable[Sequence[dict]],
    score_ledger: Sequence[dict],
    ctx: RunContext,
    horizon: str = PRIMARY_HORIZON,
    family: str = "reorder",
) -> tuple[float | None, float | None, int, int, int, float | None, str]:
    """Fit on earlier months, score the month under test.

    Returns (ece_points, worst_bin_points, scored, fitted, thin_bins, brier,
    transform).

    The curve is fitted at the POOLED rung - `demand_class` and `velocity_band`
    both ANY - because the ledger does not record either, and addressing a cell
    whose key was never written would silently land on the global curve anyway
    while claiming to be narrower. Stating the rung is the honest version of the
    same behaviour.
    """
    fitted = [
        Outcome(family=family, demand_class=ANY, stated_confidence=raw, hit=hit,
                velocity_band=ANY)
        for led in fit_ledgers for raw, hit in _predictions(led, horizon)
    ]
    scoring = _predictions(score_ledger, horizon)
    if not scoring:
        return (None, None, 0, len(fitted), 0, None, "identity")

    bundle = fit_calibration(FitRequest(outcomes=fitted), ctx).value if fitted \
        else None

    transforms: set[str] = set()
    predictions: list[Prediction] = []
    for raw, hit in scoring:
        calibrated = apply_calibration(
            ApplyRequest(raw_confidence=raw, family=family, demand_class=ANY,
                         bundle=bundle, velocity_band=ANY),
            ctx,
        ).value
        transforms.add(calibrated.transform)
        predictions.append(Prediction(family, calibrated.value, hit))

    bins = int(cfg.get(RELIABILITY_BINS, ctx))
    min_bin = int(cfg.get(MIN_BIN_OUTCOMES, ctx))
    curve = reliability_curve(predictions, bins)
    ece = expected_calibration_error(curve, len(predictions))

    # Only bins with enough outcomes to BE evidence. At n = 30 and p = 0.5 the
    # binomial standard error is 9.1 points, which is the floor at which a
    # 10-point test stops measuring noise - a five-card bin condemned a whole
    # store once already.
    testable = [b for b in curve
                if b.count >= min_bin and b.mean_stated is not None
                and b.observed_rate is not None]
    thin = sum(1 for b in curve if 0 < b.count < min_bin)
    deviations = [abs(b.mean_stated - b.observed_rate) * 100.0 for b in testable]

    return (
        ece * 100.0 if ece is not None else None,
        max(deviations) if deviations else None,
        len(predictions),
        len(fitted),
        thin,
        brier_score(predictions),
        "+".join(sorted(transforms)) if transforms else "identity",
    )


# ── 4. Interval coverage ─────────────────────────────────────────────────────


def interval_coverage(
    ledger: Sequence[dict], ctx: RunContext,
    horizons: Sequence[str] = ALL_HORIZONS,
) -> tuple[float | None, int, int]:
    """Worst-horizon coverage of the published range, plus refusal counts.

    The WORST horizon and not the mean: a range that holds at 90 days and fails at
    30 is not a range the owner can rely on, and averaging the two hides exactly
    the horizon they are standing in.

    A card whose interval was REFUSED is excluded from the rate and counted
    separately. Folding refusals in as misses would punish the engine for
    declining to state a range, which is the behaviour this module wants; folding
    them in as hits would reward it for saying nothing.
    """
    worst: float | None = None
    refused = considered = 0
    for horizon in horizons:
        covered = scored = 0
        for row in _outcome_rows(ledger, horizon):
            card, outcome = row["card"], row["outcome"]
            actual = outcome.get("actual")
            if actual is None:
                continue
            considered += 1
            result = predictive_interval(
                rate=card.get("reverted_rate"),
                horizon_open_days=_window_open_days(card, outcome),
                dispersion_cv=card.get("dispersion_cv"),
                ctx=ctx,
            )
            if not isinstance(result, PredictiveInterval):
                refused += 1
                continue
            scored += 1
            covered += 1 if result.covers(actual) else 0
        if not scored:
            continue
        rate = covered / scored * 100.0
        worst = rate if worst is None else min(worst, rate)
    return worst, refused, considered


# ── 5 & 6. The two gate B checks that never ran ──────────────────────────────


def family_nets(
    ledger: Sequence[dict], horizon: str = PRIMARY_HORIZON
) -> dict[str, float]:
    """Net margin per card, by recommendation family.

    A card with no measurable money is EXCLUDED rather than counted as zero. Five
    of ten audited stores send no unit cost at all, and folding them in as 0.0
    would drag every family's average toward nothing and call it a measurement.
    """
    by_family: dict[str, list[float]] = defaultdict(list)
    for row in _outcome_rows(ledger, horizon):
        card, outcome = row["card"], row["outcome"]
        impact = outcome.get("margin_impact")
        held = outcome.get("over_ordered_cost")
        if impact is None or held is None:
            continue        # absence. not zero.
        family = str(card.get("family") or card.get("kind") or "reorder")
        by_family[family].append(impact - held)
    return {name: sum(vals) / len(vals)
            for name, vals in sorted(by_family.items()) if vals}


def cards_per_run(ledger: Sequence[dict]) -> float | None:
    """Mean cards per decision date. The denominator beside every rate."""
    by_date: dict[str, int] = defaultdict(int)
    for card in ledger:
        as_of = card.get("as_of")
        if as_of is None:
            continue
        by_date[str(as_of)] += 1
    if not by_date:
        return None
    return sum(by_date.values()) / len(by_date)


# ── Assembly ─────────────────────────────────────────────────────────────────


def gate_inputs_for(
    *,
    ledger: Sequence[dict],
    prior_ledgers: Sequence[Sequence[dict]] = (),
    store_id: int,
    as_of: date,
    horizon: str = PRIMARY_HORIZON,
) -> GateInputs:
    """Every gate input for one store, measured from its ledger."""
    ctx = RunContext(
        run_id=f"gate-inputs-{store_id}", tenant_id=1, store_id=store_id,
        as_of=as_of, snapshot_id=f"gate-{store_id}", config_version="default",
        seed=0,
        versions={"calibrate_fit": "1.0.0", "calibrate_apply": "1.0.0",
                  "predictive_interval": "1.0.0"},
    )
    ece, worst_bin, scored, fitted, thin, brier, transform = \
        calibration_out_of_sample(
            fit_ledgers=prior_ledgers, score_ledger=ledger, ctx=ctx,
            horizon=horizon,
        )
    coverage, refused, considered = interval_coverage(ledger, ctx)

    # STALENESS. The tolerance is the ECE bar itself, read from the gate: since
    # ECE is approximately |drift|, a store that moved further than the bar cannot
    # meet it, so the failure is arithmetically guaranteed before the curve is even
    # applied. That makes this the existing threshold applied to the quantity that
    # decides whether the threshold is reachable - not a new number.
    from app.pipeline.gate.store import MAX_ECE_POINTS

    fit_hits = fit_total = 0
    for earlier in prior_ledgers:
        for raw, hit in _predictions(earlier, horizon):
            fit_total += 1
            fit_hits += 1 if hit else 0
    scored_hits = scored_total = 0
    for raw, hit in _predictions(ledger, horizon):
        scored_total += 1
        scored_hits += 1 if hit else 0
    drift = staleness_from_rates(
        fit_hits=fit_hits, fit_outcomes=fit_total,
        scored_hits=scored_hits, scored_outcomes=scored_total,
        tolerance_points=float(MAX_ECE_POINTS),
    )

    return GateInputs(
        promise_fill_ratio=promise_fill_ratio(ledger, horizon),
        ece=ece,
        worst_bin_deviation=worst_bin,
        interval_coverage=coverage,
        family_nets=family_nets(ledger, horizon),
        cards_per_run=cards_per_run(ledger),
        calibration_scored=scored,
        calibration_fitted=fitted,
        thin_bins=thin,
        brier=brier,
        calibration_transform=transform,
        interval_refused=refused,
        interval_considered=considered,
        calibration_drift_points=drift.drift_points,
        calibration_is_stale=drift.is_stale,
        calibration_staleness_detail=drift.explain(),
    )


__all__ = [
    "ALL_HORIZONS",
    "PRIMARY_HORIZON",
    "GateInputs",
    "calibration_out_of_sample",
    "cards_per_run",
    "family_nets",
    "gate_inputs_for",
    "interval_coverage",
    "promise_fill_ratio",
    "promise_kept_rate",
]
