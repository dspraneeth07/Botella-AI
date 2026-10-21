#!/usr/bin/env python
"""Does the stated confidence tell one card from another? Measured, not argued.

THE QUESTION
    A reviewer found the card confidence is not a probability and is
    inconsistent across stores: 352 cards with no basis, 33 with the raw
    ranking score passed through, every isotonic-calibrated card on the same
    0.444, and on the forward test HIGHER stated confidence went with LOWER
    hit rates (0.23 -> 50% met, 0.41 -> 7%). The ask has two halves that are
    easy to run together and must be kept apart:

      CALIBRATION     does a stated 0.60 hit about 60% of the time?
                      Fixable by a curve: isotonic regression maps stated
                      onto observed, and ECE measures how far off it is.
      DISCRIMINATION  does a card stating 0.65 hit more often than one
                      stating 0.55? Measured by AUC (the probability a random
                      hit outranks a random miss) and by Spearman's rho.
                      NOT fixable by a curve: isotonic regression is monotone,
                      so it preserves the ordering exactly and AUC is
                      unchanged up to ties the step function introduces.
                      Calibration cannot ADD information the score lacks.

    So this script measures both, out of sample, on every outcome history
    Bethany has, and says which of the two the stated confidence fails.

THE SOURCES, and why three
    ledger        audit/ledger-171-2026-0{3,4}/ledger.json - the offline
                  replay of the deterministic engine over March and April:
                  129 cards, each with the engine's own p_hit and a hit/miss
                  at 30/60/90/120 days. The largest history with a stated
                  figure the LIVE engine would also state.
    live          audit/calibration/outcomes-171.json, written by
                  backend/scripts/export-outcomes.js (read-only): the nightly
                  evaluation job's lift per card-window for Bethany. 140 rows
                  with a measurable lift, from 35 cards issued 25 Aug-9 Sep
                  under the LLM-era generator (every basis `not_recorded`).
    forward       audit/forward/daily/<date>/forward_test_w7_trailing30.json:
                  the forward test's resolved cards with `met_forecast_rate`.
                  Where the reviewer's anti-correlation was seen; 204 of its
                  235 resolved cards are Bethany's, so it is not "another
                  store" - it is Bethany's live engine over the last 30 days.

HIT, in every source, is the source's own definition: `hit` (lift >= 1.0) in
the ledger and the live rows, `met_forecast_rate` (sold at least the rate the
card promised) in the forward test. They are not pooled.

WHAT IS COMPUTED, per source and horizon
    n; stated-confidence p10/p50/p90 and distinct values; hit rate by
    stated-confidence quintile; Spearman rho; AUC with a bootstrap 95%
    interval; then an isotonic fit on the FIRST HALF BY DATE scored on the
    second: ECE before and after, the reliability table, AUC after (expected
    equal), and the number of distinct calibrated values the curve returns.
    Two fits are reported: the registry-governed one (`fit_calibration`, which
    refuses a cell under the 50-outcome floor and is the only one that could
    be published) and an unconstrained PAVA on the same rows, labelled as a
    diagnostic, so a reader can see the curve the floor is refusing.

PURE STDLIB plus the pipeline's own calibrate modules. No numpy; the statistics
here are rank sums and means, and the fit is the forty lines already in
fit.py. Every threshold is a registry Setting (the two new ones are declared
below with their reasons). No clock: the as-of date is an argument.

Usage:
    python scripts/calibration_differentiation.py --as-of 2026-10-19
"""

from __future__ import annotations

import argparse
import html
import json
import random
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Sequence

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
REPO = HERE.parent.parent

from app.pipeline.calibrate.fit import (  # noqa: E402
    ANY,
    MIN_DISTINCT_CONFIDENCES,
    MIN_OUTCOMES_TO_FIT,
    FitRequest,
    IsotonicFit,
    Outcome,
    fit_calibration,
    pool_adjacent_violators,
)
from app.pipeline.calibrate.monitor import (  # noqa: E402
    RELIABILITY_BINS,
    Prediction,
    expected_calibration_error,
    reliability_curve,
)
from app.pipeline.context import RunContext  # noqa: E402
from app.pipeline.registry import Setting, cfg  # noqa: E402

# ── The judgements this report makes, declared ───────────────────────────────

PUBLISHABLE_MAX_ECE = Setting(
    name="calibrate.publishable_max_ece",
    default=0.05,
    unit="expected calibration error, out of sample, as a probability",
    owner="calibration",
    why="provisional; the reviewer's acceptance line for a curve that may be "
        "published - five points of weighted gap between what the calibrated "
        "figure says and what happened, measured on cards the curve was NOT "
        "fitted on. Above it the curve is restating the fitting sample. To be "
        "revisited against a held-out quarter once a store has one",
    status="PROVISIONAL",
)

DIFFERENTIATION_BOOTSTRAP_RESAMPLES = Setting(
    name="calibrate.differentiation_bootstrap_resamples",
    default=2000,
    unit="bootstrap resamples of the outcome rows",
    owner="calibration",
    why="provisional; enough for a stable 95% percentile interval on an AUC "
        "over a few hundred rows (the interval's edges move by under 0.005 "
        "between seeds at this count), cheap enough to run on every report",
    status="PROVISIONAL",
)

DIFFERENTIATION_QUANTILE_BINS = Setting(
    name="calibrate.differentiation_quantile_bins",
    default=5,
    unit="equal-count bins of stated confidence",
    owner="calibration",
    why="provisional; quintiles, because the question is whether the TOP fifth "
        "of stated confidence hits more often than the bottom fifth, and five "
        "bins of 25 cards each is the coarsest cut that still shows a trend on "
        "a 129-card ledger",
    status="PROVISIONAL",
)

#: The chance level an AUC is compared against. Structural, not a judgement:
#: a classifier that knows nothing scores exactly this.
CHANCE_AUC = 0.5

#: The fitting share of a date-ordered split. Structural: the first half is
#: fitted, the second half is scored. A different split is a different claim.
FIT_SHARE = 0.5


# ── Inputs ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Row:
    """One card at one horizon: when it was issued, what it stated, what happened."""

    source: str
    horizon: str
    issued: str          # ISO date, for the date-ordered split
    key: str             # tiebreak for a stable sort
    stated: float
    hit: bool
    basis: str | None = None
    store: int | None = None


def load_ledgers(paths: Sequence[Path]) -> list[Row]:
    rows: list[Row] = []
    for path in paths:
        if not path.exists():
            print(f"  ledger missing, skipped: {path}")
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        for entry in data.get("ledger", []):
            stated = entry.get("p_hit")
            if stated is None:
                continue
            for horizon, outcome in (entry.get("outcomes") or {}).items():
                hit = outcome.get("hit") if isinstance(outcome, dict) else None
                if hit is None:
                    continue
                rows.append(Row(
                    source="ledger", horizon=f"{horizon}d",
                    issued=str(entry.get("as_of")), key=str(entry.get("sku")),
                    stated=min(1.0, max(0.0, float(stated))), hit=bool(hit),
                    basis="raw_ranking_score", store=171,
                ))
    return rows


def load_live(path: Path) -> list[Row]:
    if not path.exists():
        print(f"  live export missing, skipped: {path}")
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    rows: list[Row] = []
    for r in data.get("outcomes", []):
        if r.get("hit") is None or r.get("stated_confidence") is None:
            continue
        rows.append(Row(
            source="live_outcomes", horizon=f"w{r.get('window_open_days')}",
            issued=str(r.get("rec_date")), key=str(r.get("rec_id")),
            stated=min(1.0, max(0.0, float(r["stated_confidence"]))), hit=bool(r["hit"]),
            basis=r.get("confidence_basis"), store=data.get("store"),
        ))
    for r in data.get("evaluations", []):
        if r.get("hit") is None or r.get("stated_confidence") is None:
            continue
        rows.append(Row(
            source="live_evaluations", horizon=f"{r.get('window')}d",
            issued=str(r.get("rec_date")), key=str(r.get("rec_id")),
            stated=min(1.0, max(0.0, float(r["stated_confidence"]))), hit=bool(r["hit"]),
            basis=r.get("confidence_basis"), store=data.get("store"),
        ))
    return rows


def load_forward(path: Path) -> list[Row]:
    if not path.exists():
        print(f"  forward test missing, skipped: {path}")
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    rows: list[Row] = []
    for c in data.get("cards", []):
        if c.get("outcome") == "pending" or c.get("met_forecast_rate") is None:
            continue
        if c.get("stated_confidence") is None:
            continue
        rows.append(Row(
            source="forward", horizon=f"w{c.get('window_open_days_requested')}",
            issued=str(c.get("rec_date")), key=str(c.get("rec_id")),
            stated=min(1.0, max(0.0, float(c["stated_confidence"]))),
            hit=bool(c["met_forecast_rate"]), basis=None, store=c.get("location_id"),
        ))
    return rows


# ── Statistics, by hand ──────────────────────────────────────────────────────


def _average_ranks(values: Sequence[float]) -> list[float]:
    """1-based ranks, ties given the mean of the positions they span."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        mean_rank = (i + j + 2) / 2.0
        for k in range(i, j + 1):
            ranks[order[k]] = mean_rank
        i = j + 1
    return ranks


def auc(stated: Sequence[float], hit: Sequence[bool]) -> float | None:
    """Mann-Whitney AUC: P(stated of a random hit > stated of a random miss),
    ties counted half. None when either class is empty."""
    positives = sum(1 for h in hit if h)
    negatives = len(hit) - positives
    if positives == 0 or negatives == 0:
        return None
    ranks = _average_ranks(stated)
    rank_sum = sum(r for r, h in zip(ranks, hit) if h)
    return (rank_sum - positives * (positives + 1) / 2.0) / (positives * negatives)


def spearman(stated: Sequence[float], hit: Sequence[bool]) -> float | None:
    if len(stated) < 3:
        return None
    rx = _average_ranks(stated)
    ry = _average_ranks([1.0 if h else 0.0 for h in hit])
    mx = sum(rx) / len(rx)
    my = sum(ry) / len(ry)
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    vx = sum((a - mx) ** 2 for a in rx)
    vy = sum((b - my) ** 2 for b in ry)
    if vx == 0 or vy == 0:
        return None
    return cov / (vx * vy) ** 0.5


def bootstrap_auc(stated: Sequence[float], hit: Sequence[bool],
                  resamples: int, rng: random.Random) -> tuple[float, float] | None:
    n = len(stated)
    if n == 0:
        return None
    values: list[float] = []
    for _ in range(resamples):
        idx = [rng.randrange(n) for _ in range(n)]
        a = auc([stated[i] for i in idx], [hit[i] for i in idx])
        if a is not None:
            values.append(a)
    if len(values) < 2:
        return None
    values.sort()
    lo = values[int(0.025 * (len(values) - 1))]
    hi = values[int(0.975 * (len(values) - 1))]
    return lo, hi


def percentile(sorted_values: Sequence[float], q: float) -> float:
    if not sorted_values:
        return float("nan")
    pos = q * (len(sorted_values) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(sorted_values) - 1)
    frac = pos - lo
    return sorted_values[lo] * (1 - frac) + sorted_values[hi] * frac


def quantile_table(rows: Sequence[Row], bins: int) -> list[dict[str, Any]]:
    """Hit rate by equal-count bin of stated confidence, lowest first."""
    ordered = sorted(rows, key=lambda r: (r.stated, r.issued, r.key))
    n = len(ordered)
    out: list[dict[str, Any]] = []
    for b in range(bins):
        lo = (b * n) // bins
        hi = ((b + 1) * n) // bins
        chunk = ordered[lo:hi]
        if not chunk:
            continue
        hits = sum(1 for r in chunk if r.hit)
        out.append({
            "bin": b + 1, "n": len(chunk),
            "stated_min": round(chunk[0].stated, 3),
            "stated_max": round(chunk[-1].stated, 3),
            "stated_mean": round(sum(r.stated for r in chunk) / len(chunk), 3),
            "hits": hits, "hit_rate": round(hits / len(chunk), 3),
        })
    return out


# ── The out-of-sample fit ───────────────────────────────────────────────────


def ctx_for(as_of: date, label: str, seed: int) -> RunContext:
    return RunContext(
        run_id=f"calibration-differentiation-{label}", tenant_id=1, store_id=171,
        as_of=as_of, snapshot_id=f"diff-{label}", config_version="default",
        seed=seed, versions={"calibrate_fit": "1.0.0", "calibration_differentiation": "1.0.0"},
    )


def _predictions(values: Sequence[float], hits: Sequence[bool]) -> list[Prediction]:
    return [Prediction(family="reorder", calibrated_confidence=v, hit=h)
            for v, h in zip(values, hits)]


def _reliability(values: Sequence[float], hits: Sequence[bool], bins: int) -> dict[str, Any]:
    preds = _predictions(values, hits)
    curve = reliability_curve(preds, bins)
    return {
        "ece": expected_calibration_error(curve, len(preds)),
        "table": [b.as_dict() for b in curve if b.count],
    }


def _pava_fit(train: Sequence[Row], as_of: date) -> IsotonicFit | None:
    """The unconstrained diagnostic: PAVA on whatever rows there are."""
    if len(train) < 2:
        return None
    ordered = sorted(train, key=lambda r: r.stated)
    knots = pool_adjacent_violators(
        [(r.stated, 1.0 if r.hit else 0.0, 1.0) for r in ordered])
    return IsotonicFit(
        family="reorder", demand_class=ANY,
        xs=tuple(x for x, _ in knots), ys=tuple(y for _, y in knots),
        n_outcomes=len(train), domain_lo=ordered[0].stated, domain_hi=ordered[-1].stated,
        fitted_at=as_of, velocity_band=ANY,
    )


def out_of_sample(rows: Sequence[Row], as_of: date, label: str, seed: int,
                  bins: int) -> dict[str, Any]:
    ordered = sorted(rows, key=lambda r: (r.issued, r.key))
    cut = int(len(ordered) * FIT_SHARE)
    train, test = ordered[:cut], ordered[cut:]
    result: dict[str, Any] = {
        "fit_rows": len(train), "score_rows": len(test),
        "fit_dates": [train[0].issued, train[-1].issued] if train else None,
        "score_dates": [test[0].issued, test[-1].issued] if test else None,
    }
    if not train or not test:
        result["refused"] = "too few rows to split"
        return result

    test_stated = [r.stated for r in test]
    test_hit = [r.hit for r in test]
    before = _reliability(test_stated, test_hit, bins)
    result["before"] = {
        "ece": _r(before["ece"]), "auc": _r(auc(test_stated, test_hit)),
        "distinct_values": len(set(test_stated)), "reliability": before["table"],
    }

    # The registry-governed fit: the one that could be published.
    ctx = ctx_for(as_of, label, seed)
    outcomes = [Outcome(family="reorder", demand_class=ANY, stated_confidence=r.stated,
                        hit=r.hit, velocity_band=ANY) for r in train]
    fitted = fit_calibration(FitRequest(outcomes=outcomes), ctx).value
    governed = fitted.fit_for("reorder", ANY, ANY) if fitted is not None else None
    if governed is None:
        skipped = {"/".join(k): v for k, v in (fitted.skipped if fitted else {}).items()}
        result["governed"] = {"refused": skipped.get("*/*/*") or skipped or "no fit",
                              "min_outcomes_to_fit": cfg.get(MIN_OUTCOMES_TO_FIT, ctx),
                              "min_distinct_confidences": cfg.get(MIN_DISTINCT_CONFIDENCES, ctx)}
    else:
        result["governed"] = _score_fit(governed, test_stated, test_hit, bins)

    # The diagnostic: the curve the floor is refusing, so the reader can see it.
    diagnostic = _pava_fit(train, as_of)
    result["diagnostic_pava"] = (_score_fit(diagnostic, test_stated, test_hit, bins)
                                 if diagnostic else {"refused": "fewer than two rows"})
    return result


def _score_fit(fit: IsotonicFit, stated: Sequence[float], hit: Sequence[bool],
               bins: int) -> dict[str, Any]:
    calibrated = [fit.predict(s)[0] for s in stated]
    after = _reliability(calibrated, hit, bins)
    return {
        "levels_in_curve": fit.levels,
        "knots": [[round(x, 3), round(y, 3)] for x, y in zip(fit.xs, fit.ys)],
        "domain": [round(fit.domain_lo, 3), round(fit.domain_hi, 3)],
        "ece_after": _r(after["ece"]),
        "auc_after": _r(auc(calibrated, hit)),
        "distinct_calibrated_values_on_scored_half": len(set(calibrated)),
        "reliability_after": after["table"],
    }


# ── One cell of the report ───────────────────────────────────────────────────


def analyse(rows: Sequence[Row], as_of: date, label: str, seed: int,
            ctx: RunContext) -> dict[str, Any]:
    stated = [r.stated for r in rows]
    hits = [r.hit for r in rows]
    ordered = sorted(stated)
    rng = random.Random(seed)
    resamples = int(cfg.get(DIFFERENTIATION_BOOTSTRAP_RESAMPLES, ctx))
    bins = int(cfg.get(DIFFERENTIATION_QUANTILE_BINS, ctx))
    rel_bins = int(cfg.get(RELIABILITY_BINS, ctx))
    point = auc(stated, hits)
    interval = bootstrap_auc(stated, hits, resamples, rng) if point is not None else None
    cell: dict[str, Any] = {
        "n": len(rows), "hits": sum(hits),
        "hit_rate": round(sum(hits) / len(rows), 3) if rows else None,
        "stated": {
            "p10": round(percentile(ordered, 0.10), 3),
            "p50": round(percentile(ordered, 0.50), 3),
            "p90": round(percentile(ordered, 0.90), 3),
            "min": round(ordered[0], 3) if ordered else None,
            "max": round(ordered[-1], 3) if ordered else None,
            "distinct": len(set(stated)),
        },
        "quantiles": quantile_table(rows, bins),
        "spearman_rho": None if (s := spearman(stated, hits)) is None else round(s, 3),
        "auc": None if point is None else round(point, 3),
        "auc_ci95": None if interval is None else [round(interval[0], 3), round(interval[1], 3)],
        "bootstrap_resamples": resamples,
    }
    cell["discriminates"] = (
        interval is not None and interval[0] > CHANCE_AUC
    )
    cell["anti_discriminates"] = (
        interval is not None and interval[1] < CHANCE_AUC
    )
    cell["out_of_sample"] = out_of_sample(rows, as_of, label, seed, rel_bins)
    return cell


def publishable(cell: dict[str, Any], ctx: RunContext) -> tuple[bool, list[str]]:
    """Could the governed curve be published? Every refusal carries its reason."""
    reasons: list[str] = []
    oos = cell.get("out_of_sample", {})
    governed = oos.get("governed", {})
    floor = int(cfg.get(MIN_OUTCOMES_TO_FIT, ctx))
    max_ece = float(cfg.get(PUBLISHABLE_MAX_ECE, ctx))
    if "refused" in governed:
        reasons.append(f"no governed fit: {governed['refused']} (floor {floor})")
    else:
        if governed.get("ece_after") is None or governed["ece_after"] >= max_ece:
            reasons.append(f"ECE after {governed.get('ece_after')} is not under {max_ece}")
        if governed.get("levels_in_curve", 0) < 2:
            reasons.append("the curve has one level: a constant, not a calibration")
    if not cell.get("discriminates"):
        reasons.append(
            f"AUC {cell.get('auc')} with 95% interval {cell.get('auc_ci95')} does not clear "
            f"{CHANCE_AUC}: the stated figure does not separate hits from misses, and a "
            "monotone curve cannot add that")
    return (not reasons), reasons


# ── The report ───────────────────────────────────────────────────────────────


def build(args: argparse.Namespace) -> dict[str, Any]:
    as_of = date.fromisoformat(args.as_of)
    ctx = ctx_for(as_of, "report", args.seed)
    print("reading sources")
    ledger = load_ledgers([REPO / p for p in args.ledgers])
    live = load_live(REPO / args.live)
    forward = load_forward(REPO / args.forward)
    rows = ledger + live + forward
    print(f"  ledger {len(ledger)} rows, live {len(live)}, forward {len(forward)}")

    cells: dict[str, dict[str, Any]] = {}
    for source in ("ledger", "live_outcomes", "live_evaluations", "forward"):
        group = [r for r in rows if r.source == source]
        if not group:
            continue
        horizons = sorted({r.horizon for r in group},
                          key=lambda h: (int("".join(ch for ch in h if ch.isdigit()) or 0), h))
        for horizon in horizons:
            sub = [r for r in group if r.horizon == horizon]
            label = f"{source}:{horizon}"
            print(f"  {label}: n={len(sub)}")
            cells[label] = analyse(sub, as_of, label.replace(":", "-"), args.seed, ctx)
            cells[label]["source"] = source
            cells[label]["horizon"] = horizon
            cells[label]["hit_definition"] = (
                "met_forecast_rate (sold at least the promised rate)" if source == "forward"
                else "lift >= 1.0")
            ok, why = publishable(cells[label], ctx)
            cells[label]["publishable"] = ok
            cells[label]["not_publishable_because"] = why
        # Bethany only, for the forward test: the reviewer's claim and the
        # estate's are different claims, and 204 of 235 resolved cards are hers.
        if source == "forward":
            bethany = [r for r in group if r.store == 171]
            if bethany:
                label = "forward:171-only"
                cells[label] = analyse(bethany, as_of, "forward-171", args.seed, ctx)
                cells[label].update({"source": "forward", "horizon": "w7 (store 171 only)",
                                     "hit_definition": "met_forecast_rate"})
                ok, why = publishable(cells[label], ctx)
                cells[label]["publishable"] = ok
                cells[label]["not_publishable_because"] = why

    # The headline: the ledger at 30 days is the largest history with the live
    # engine's own figure, and the horizon the ledger itself headlines.
    headline_key = "ledger:30d" if "ledger:30d" in cells else next(iter(cells), None)
    headline = cells.get(headline_key) if headline_key else None
    forward_171 = cells.get("forward:171-only")

    conclusion = _conclusion(headline, headline_key, forward_171, cells, ctx)
    return {
        "generated_for": args.as_of,
        "store": 171,
        "sources": {
            "ledger": [str(p) for p in args.ledgers],
            "live": args.live, "forward": args.forward,
        },
        "settings": {
            "calibrate.min_outcomes_to_fit": cfg.get(MIN_OUTCOMES_TO_FIT, ctx),
            "calibrate.min_distinct_confidences": cfg.get(MIN_DISTINCT_CONFIDENCES, ctx),
            "calibrate.publishable_max_ece": cfg.get(PUBLISHABLE_MAX_ECE, ctx),
            "calibrate.reliability_bins": cfg.get(RELIABILITY_BINS, ctx),
            "calibrate.differentiation_bootstrap_resamples":
                cfg.get(DIFFERENTIATION_BOOTSTRAP_RESAMPLES, ctx),
            "calibrate.differentiation_quantile_bins":
                cfg.get(DIFFERENTIATION_QUANTILE_BINS, ctx),
            "seed": args.seed,
        },
        "headline_cell": headline_key,
        "conclusion": conclusion,
        "cells": cells,
    }


def _conclusion(headline: dict[str, Any] | None, key: str | None,
                forward_171: dict[str, Any] | None, cells: dict[str, dict[str, Any]],
                ctx: RunContext) -> dict[str, Any]:
    lines: list[str] = []
    if headline is None:
        return {"lines": ["No source could be read; nothing is concluded."],
                "publish": False}
    ci = headline.get("auc_ci95") or [None, None]
    lines.append(
        f"On Bethany's {headline['n']}-card ledger ({key}), the stated confidence spans "
        f"{headline['stated']['min']}-{headline['stated']['max']} (p10 {headline['stated']['p10']}, "
        f"p50 {headline['stated']['p50']}, p90 {headline['stated']['p90']}) and scores AUC "
        f"{headline['auc']} as a classifier of hit, 95% interval {ci[0]}-{ci[1]}, Spearman rho "
        f"{headline['spearman_rho']}."
    )
    if headline.get("discriminates"):
        lines.append("That interval clears 0.5: the stated figure DOES separate hits from "
                     "misses at this store, weakly.")
    elif headline.get("anti_discriminates"):
        lines.append("That interval sits BELOW 0.5: higher stated confidence goes with fewer "
                     "hits at this store. The forward test's anti-correlation holds on the "
                     "longer history.")
    else:
        lines.append("That interval straddles 0.5: on this history the stated figure does not "
                     "demonstrably separate a card that will work from one that will not. "
                     "Not demonstrably backwards either - the forward test's reversal is not "
                     "reproduced, and not refuted, by the ledger.")
    q = headline.get("quantiles") or []
    if len(q) >= 2:
        lines.append(
            f"By stated-confidence quintile the hit rate runs "
            + ", ".join(f"{b['hit_rate']:.0%} (stated {b['stated_min']}-{b['stated_max']})"
                        for b in q)
            + " from the least to the most confident fifth."
        )
    oos = headline.get("out_of_sample", {})
    gov = oos.get("governed", {})
    diag = oos.get("diagnostic_pava", {})
    if "refused" in gov:
        lines.append(
            f"Fitting on the first half by date ({oos.get('fit_rows')} rows) is refused by the "
            f"registry floor: {gov['refused']}. The unconstrained diagnostic curve on the same "
            f"rows has {diag.get('levels_in_curve')} level(s) and returns "
            f"{diag.get('distinct_calibrated_values_on_scored_half')} distinct value(s) on the "
            f"scored half; ECE moves from {_pct(oos.get('before', {}).get('ece'))} to "
            f"{_pct(diag.get('ece_after'))}, AUC from {oos.get('before', {}).get('auc')} to "
            f"{diag.get('auc_after')} - unchanged up to ties, as a monotone map must be."
        )
    else:
        lines.append(
            f"Fitting on the first half by date ({oos.get('fit_rows')} rows) and scoring the second "
            f"({oos.get('score_rows')}): the curve has {gov.get('levels_in_curve')} level(s) and "
            f"returns {gov.get('distinct_calibrated_values_on_scored_half')} distinct value(s); "
            f"ECE moves from {_pct(oos.get('before', {}).get('ece'))} to {_pct(gov.get('ece_after'))}, "
            f"AUC from {oos.get('before', {}).get('auc')} to {gov.get('auc_after')} - unchanged up "
            f"to ties, as a monotone map must be."
        )
    if forward_171:
        fci = forward_171.get("auc_ci95") or [None, None]
        lines.append(
            f"The forward test's resolved cards at Bethany ({forward_171['n']} cards, hit = met the "
            f"promised rate): AUC {forward_171['auc']}, interval {fci[0]}-{fci[1]}, rho "
            f"{forward_171['spearman_rho']}; by quintile "
            + ", ".join(f"{b['hit_rate']:.0%}" for b in forward_171.get("quantiles", []))
            + f". {'The reversal the reviewer saw is real on this window.' if forward_171.get('anti_discriminates') else 'The reversal is within noise on this window.'}"
        )
    lines.append(
        "Calibration and discrimination are different failures. Isotonic regression can move a "
        "stated 0.60 onto the observed rate; it is monotone, so it cannot reorder cards, and "
        "the AUC after equals the AUC before. The reviewer's question is discrimination, and "
        "no curve fitted to these rows answers it."
    )
    publish_keys = [k for k, c in cells.items() if c.get("publishable")]
    publish = bool(publish_keys)
    if publish:
        lines.append(f"A curve clears every bar on: {', '.join(publish_keys)}. It is published "
                     "with scripts/publish_calibration.py against local Node for store 171 only.")
    else:
        lines.append("No cell clears every bar (a governed fit above the registry floor, ECE under "
                     f"{cfg.get(PUBLISHABLE_MAX_ECE, ctx)} out of sample, and an AUC interval above "
                     "0.5). Nothing is published; the cards keep the basis they have, the UI keeps "
                     "the figure hidden, and the admission floor stays off every non-isotonic basis.")
    return {"lines": lines, "publish": publish, "publishable_cells": publish_keys}


def _pct(v: Any) -> str:
    return "n/a" if v is None else f"{v * 100:.1f} pts"


def _r(v: float | None, digits: int = 3) -> float | None:
    return None if v is None else round(v, digits)


# ── HTML ─────────────────────────────────────────────────────────────────────

_CSS = """
:root{--ink:#1f2328;--muted:#656d76;--line:#d0d7de;--bg:#fff;--soft:#f6f8fa;--bad:#b35900;--good:#1a7f37}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--ink:#e6edf3;--muted:#8b949e;--line:#30363d;--bg:#0d1117;--soft:#161b22;--bad:#e3a04a;--good:#3fb950}}
:root[data-theme="dark"]{--ink:#e6edf3;--muted:#8b949e;--line:#30363d;--bg:#0d1117;--soft:#161b22;--bad:#e3a04a;--good:#3fb950}
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg);margin:0;padding:24px 16px;max-width:1080px;margin-inline:auto}
h1{font-size:1.6rem;margin:0 0 .25rem}h2{font-size:1.2rem;margin:2rem 0 .5rem;border-top:1px solid var(--line);padding-top:1rem}
h3{font-size:1rem;margin:1.2rem 0 .4rem}.muted{color:var(--muted)}
table{border-collapse:collapse;width:100%;margin:.5rem 0 1rem;font-size:.92rem}
th,td{border-bottom:1px solid var(--line);padding:.35rem .5rem;text-align:left;vertical-align:top}
th{background:var(--soft)}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.conclusion{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:1rem 1.2rem}
.conclusion p{margin:.4rem 0}.bad{color:var(--bad);font-weight:600}.good{color:var(--good);font-weight:600}
code{font-size:.9em;background:var(--soft);padding:0 .3em;border-radius:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.6rem;margin:.6rem 0}
.tile{border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem}.tile b{display:block;font-size:1.25rem}
.tile span{color:var(--muted);font-size:.85rem}
"""


def _fmt(v: Any, digits: int = 3) -> str:
    if v is None:
        return "n/a"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float):
        return f"{v:.{digits}f}"
    return html.escape(str(v))


def _cell_html(key: str, cell: dict[str, Any]) -> str:
    e = html.escape
    st = cell["stated"]
    ci = cell.get("auc_ci95") or [None, None]
    verdict = ("<span class=good>separates</span>" if cell.get("discriminates")
               else "<span class=bad>reversed</span>" if cell.get("anti_discriminates")
               else "<span class=bad>does not separate</span>")
    parts = [f"<h2 id='{e(key)}'>{e(key)} <span class=muted>- n {cell['n']}, hit = {e(cell['hit_definition'])}</span></h2>"]
    parts.append("<div class=grid>"
                 f"<div class=tile><b>{cell['n']}</b><span>cards x horizon</span></div>"
                 f"<div class=tile><b>{_fmt(cell['hit_rate'])}</b><span>hit rate</span></div>"
                 f"<div class=tile><b>{_fmt(st['p10'])} / {_fmt(st['p50'])} / {_fmt(st['p90'])}</b><span>stated p10 / p50 / p90 ({st['distinct']} distinct)</span></div>"
                 f"<div class=tile><b>{_fmt(cell['auc'])}</b><span>AUC, 95% {_fmt(ci[0])}-{_fmt(ci[1])} - {verdict}</span></div>"
                 f"<div class=tile><b>{_fmt(cell['spearman_rho'])}</b><span>Spearman rho</span></div>"
                 "</div>")
    parts.append("<h3>Hit rate by stated-confidence quintile</h3><table><tr><th>bin</th><th class=num>n</th><th class=num>stated range</th><th class=num>stated mean</th><th class=num>hits</th><th class=num>hit rate</th></tr>")
    for b in cell["quantiles"]:
        parts.append(f"<tr><td>{b['bin']}</td><td class=num>{b['n']}</td><td class=num>{_fmt(b['stated_min'])}-{_fmt(b['stated_max'])}</td>"
                     f"<td class=num>{_fmt(b['stated_mean'])}</td><td class=num>{b['hits']}</td><td class=num>{_fmt(b['hit_rate'])}</td></tr>")
    parts.append("</table>")
    oos = cell.get("out_of_sample", {})
    parts.append(f"<h3>Out of sample: fit on {oos.get('fit_rows')} rows ({' to '.join(oos.get('fit_dates') or ['-','-'])}), score {oos.get('score_rows')} ({' to '.join(oos.get('score_dates') or ['-','-'])})</h3>")
    if "refused" in oos:
        parts.append(f"<p class=bad>{e(str(oos['refused']))}</p>")
    else:
        before = oos.get("before", {})
        gov = oos.get("governed", {})
        diag = oos.get("diagnostic_pava", {})
        parts.append("<table><tr><th></th><th class=num>ECE</th><th class=num>AUC</th><th class=num>levels in curve</th><th class=num>distinct values returned</th><th>note</th></tr>")
        parts.append(f"<tr><td>stated (before)</td><td class=num>{_pct(before.get('ece'))}</td><td class=num>{_fmt(before.get('auc'))}</td><td class=num>-</td><td class=num>{before.get('distinct_values')}</td><td></td></tr>")
        if "refused" in gov:
            parts.append(f"<tr><td>governed isotonic</td><td colspan=4 class=bad>refused: {e(str(gov['refused']))}</td><td>floor {gov.get('min_outcomes_to_fit')} outcomes, {gov.get('min_distinct_confidences')} distinct</td></tr>")
        else:
            parts.append(f"<tr><td>governed isotonic</td><td class=num>{_pct(gov.get('ece_after'))}</td><td class=num>{_fmt(gov.get('auc_after'))}</td><td class=num>{gov.get('levels_in_curve')}</td><td class=num>{gov.get('distinct_calibrated_values_on_scored_half')}</td><td>knots {e(str(gov.get('knots')))}</td></tr>")
        if "refused" in diag:
            parts.append(f"<tr><td>diagnostic PAVA</td><td colspan=5>{e(str(diag['refused']))}</td></tr>")
        else:
            parts.append(f"<tr><td>diagnostic PAVA <span class=muted>(below the floor; not publishable)</span></td><td class=num>{_pct(diag.get('ece_after'))}</td><td class=num>{_fmt(diag.get('auc_after'))}</td><td class=num>{diag.get('levels_in_curve')}</td><td class=num>{diag.get('distinct_calibrated_values_on_scored_half')}</td><td>knots {e(str(diag.get('knots')))}</td></tr>")
        parts.append("</table>")
        rel = (gov if "refused" not in gov else diag).get("reliability_after") or []
        if rel:
            parts.append("<h3>Reliability on the scored half, after the curve</h3><table><tr><th class=num>bin</th><th class=num>n</th><th class=num>mean calibrated</th><th class=num>observed</th></tr>")
            for b in rel:
                parts.append(f"<tr><td class=num>{_fmt(b['lower'],1)}-{_fmt(b['upper'],1)}</td><td class=num>{b['count']}</td><td class=num>{_fmt(b['mean_stated'])}</td><td class=num>{_fmt(b['observed_rate'])}</td></tr>")
            parts.append("</table>")
    pub = cell.get("publishable")
    parts.append(f"<p><b>Publishable:</b> {'<span class=good>yes</span>' if pub else '<span class=bad>no</span>'}"
                 + ("" if pub else " - " + "; ".join(e(r) for r in cell.get("not_publishable_because", []))) + "</p>")
    return "\n".join(parts)


def render_html(report: dict[str, Any]) -> str:
    e = html.escape
    c = report["conclusion"]
    body = [f"<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
            f"<title>Confidence Differentiation</title><style>{_CSS}</style></head><body>",
            f"<h1>Does the card confidence tell cards apart? Bethany (171), {e(report['generated_for'])}</h1>",
            "<p class=muted>Sources: the offline ledgers for March and April, the live evaluation job's outcomes "
            "(backend/scripts/export-outcomes.js), and the forward test's resolved cards. Hit is each source's own "
            "definition. Fits are out of sample: first half by issue date fitted, second half scored. "
            "Generated by Botella_External_APIs/scripts/calibration_differentiation.py; the JSON beside this file "
            "carries every number.</p>",
            "<div class=conclusion><h2 style='border:0;margin-top:0;padding-top:0'>Conclusion</h2>"]
    body += [f"<p>{e(line)}</p>" for line in c["lines"]]
    body.append("</div>")
    body.append("<h2>Settings read</h2><table><tr><th>setting</th><th class=num>value</th></tr>")
    for k, v in report["settings"].items():
        body.append(f"<tr><td><code>{e(k)}</code></td><td class=num>{e(str(v))}</td></tr>")
    body.append("</table>")
    body.append("<h2>Cells</h2><p class=muted>" + " · ".join(f"<a href='#{e(k)}'>{e(k)}</a>" for k in report["cells"]) + "</p>")
    for key, cell in report["cells"].items():
        body.append(_cell_html(key, cell))
    body.append("</body></html>")
    return "\n".join(body)


# ── Entry ────────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--as-of", required=True, help="ISO date the report is for; also the fit date")
    ap.add_argument("--ledgers", nargs="*",
                    default=["audit/ledger-171-2026-03/ledger.json",
                             "audit/ledger-171-2026-04/ledger.json"],
                    help="ledger.json paths, relative to the repo root")
    ap.add_argument("--live", default="audit/calibration/outcomes-171.json")
    ap.add_argument("--forward", default=None,
                    help="forward_test_w7_trailing30.json; defaults to the as-of day's")
    ap.add_argument("--out-dir", default="audit/calibration")
    ap.add_argument("--seed", type=int, default=20261019)
    args = ap.parse_args()
    if args.forward is None:
        args.forward = f"audit/forward/daily/{args.as_of}/forward_test_w7_trailing30.json"

    report = build(args)
    out_dir = REPO / args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"DIFFERENTIATION_{args.as_of}"
    (out_dir / f"{stem}.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    (out_dir / f"{stem}.html").write_text(render_html(report), encoding="utf-8")
    print()
    for line in report["conclusion"]["lines"]:
        print(f"  {line}")
    print(f"\n  wrote {out_dir / stem}.html and .json")
    # Publishing is a separate, deliberate step (scripts/publish_calibration.py);
    # this script only says whether it would be justified.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
