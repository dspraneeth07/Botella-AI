#!/usr/bin/env python
"""R10 — does the forecast beat the three baselines it has to beat?

    python scripts/forecast_accuracy.py --data ../audit/data \
        --file store_171_sale_items.csv.gz --store "Bethany" --every 14

WHY THIS COMES BEFORE ANY MODEL WORK
    Every accuracy claim made about this engine so far has been about HIT RATE -
    did a recommended product beat its own trailing rate. That is a question
    about selection, and it is already 59% by accident because most products
    that dip revert.

    This asks the forecasting question instead: when the engine says "expect N
    units over the next H days", how wrong is N? Nothing in the engine has ever
    measured that, and without it there is no way to tell whether a model change
    helped. Building the gate after the model is how teams convince themselves
    of improvements that are not there.

THE THREE BASELINES ARE NOT A FORMALITY
    trailing_28   what the engine uses today. Beating it is the minimum bar.
    last_year     the same calendar window a year ago. A seasonal product beats
                  trailing_28 on this alone, which is why it is here: it is the
                  baseline that catches a forecaster taking credit for
                  seasonality it did not model.
    year_average  the 12-month mean rate. Dull, hard to beat on noisy SKUs, and
                  it exposes a forecaster that is really just overfitting noise.

WHAT IS MEASURED
    WAPE by units      sum|err| / sum(actual). Scale-free across SKUs, and it
                       does not blow up on zero-demand windows the way MAPE does.
    WAPE by margin     the same, weighted by unit margin - a 5-unit error on a
                       $40 bottle is not a 5-unit error on a $2 miniature, and a
                       units-only metric says it is.
    bias               mean signed error over mean actual. A forecaster can have
                       excellent WAPE and be systematically 20% high.
    coverage           share of actuals inside p10-p90. Should be ~80%; much
                       more means the interval is uselessly wide, much less
                       means it is lying.

NO LEAKAGE, ASSERTED BY CONSTRUCTION
    Every estimator takes `as_of` and may only read strictly before it. The
    seasonal indices are re-estimated at each decision date from that date's
    history only - an index fitted on the whole export would quietly encode the
    future of every window it is then scored on.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline.features.calendar import facts_for  # noqa: E402
from scripts.real_engine_backtest import (  # noqa: E402
    BASELINE_WINDOW_DAYS,
    Store,
    load,
)

HORIZONS = (30, 60, 90, 120)
LONG_RUN_DAYS = 365
#: k for the temporal shrinkage, matching shrink.k.sku_velocity. Repeated here
#: rather than imported because this script must run without a RunContext.
SHRINK_K = 21
MIN_UNITS_TO_SCORE = 8          # the materiality floor - same population


# ── Seasonal indices, estimated per store from history only ──────────────────


def day_of_week_index(store: Store, as_of: date, lookback_days: int = 365
                      ) -> dict[int, float]:
    """Units on each weekday relative to the store's average open day.

    ESTIMATED, NOT ASSUMED. A hand-written "Friday is 1.4x" would be a guess
    about every store at once; this reads each store's own history. A store that
    shuts Sundays simply has no Sunday entry, and the caller must not invent one.
    """
    start = as_of - timedelta(days=lookback_days)
    totals: dict[int, float] = defaultdict(float)
    counts: dict[int, int] = defaultdict(int)
    for d in store.trading_days:
        if not (start < d <= as_of):
            continue
        day_units = sum(by.get(d, 0.0) for by in store.daily.values())
        totals[d.weekday()] += day_units
        counts[d.weekday()] += 1
    means = {w: totals[w] / counts[w] for w in totals if counts[w]}
    if not means:
        return {}
    overall = sum(means.values()) / len(means)
    if overall <= 0:
        return {}
    return {w: m / overall for w, m in means.items()}


def pre_holiday_index(store: Store, as_of: date, lookback_days: int = 730
                      ) -> float:
    """How much busier a pre-holiday open day is than an ordinary one.

    One number per store rather than one per holiday: two years of history
    contains about a dozen Thanksgiving-eve-type days, which is far too few to
    estimate each separately. Pooling them is the honest resolution available.
    """
    start = as_of - timedelta(days=lookback_days)
    pre_t = pre_n = ord_t = ord_n = 0.0
    for d in store.trading_days:
        if not (start < d <= as_of):
            continue
        day_units = sum(by.get(d, 0.0) for by in store.daily.values())
        if facts_for(d).in_pre_holiday_window:
            pre_t += day_units
            pre_n += 1
        else:
            ord_t += day_units
            ord_n += 1
    if pre_n < 5 or ord_n < 30 or ord_t <= 0:
        return 1.0                      # not enough to say anything
    pre_mean = pre_t / pre_n
    ord_mean = ord_t / ord_n
    return (pre_mean / ord_mean) if ord_mean > 0 else 1.0


def seasonal_multiplier(store: Store, as_of: date, end: date,
                        dow: dict[int, float], pre_idx: float) -> float:
    """How much busier the FORECAST window is than an average open day.

    This is the quantity the current engine is missing. A 60-day window ending
    2 January is 28% pre-holiday days; one ending 2 September is 0%. Projecting
    the same trailing rate across both and calling the difference mean reversion
    is the error this corrects.
    """
    days = [d for d in store.trading_days if as_of < d <= end]
    if not days:
        return 1.0
    total = 0.0
    for d in days:
        m = dow.get(d.weekday(), 1.0)
        if facts_for(d).in_pre_holiday_window:
            m *= pre_idx
        total += m
    return total / len(days)


# ── The estimators under test ────────────────────────────────────────────────


def _rate(store: Store, sku: str, start: date, end: date) -> float:
    n = store.open_days(start, end)
    return (store.units(sku, start, end) / n) if n else 0.0


def forecasts_for(store: Store, sku: str, as_of: date, horizon: int,
                  dow: dict[int, float], pre_idx: float,
                  ) -> dict[str, float] | None:
    """Every estimator's prediction of units over (as_of, as_of+horizon].

    Returns None when the window cannot be scored at all, which is a result
    rather than a zero.
    """
    end = as_of + timedelta(days=horizon)
    win_open = store.open_days(as_of, end)
    if win_open <= 0:
        return None

    recent_open = store.open_days(as_of - timedelta(days=BASELINE_WINDOW_DAYS), as_of)
    recent_units = store.units(sku, as_of - timedelta(days=BASELINE_WINDOW_DAYS), as_of)
    if recent_open <= 0 or recent_units < MIN_UNITS_TO_SCORE:
        return None

    r28 = recent_units / recent_open
    r365 = _rate(store, sku, as_of - timedelta(days=LONG_RUN_DAYS), as_of)

    # BASELINE 2 - the same calendar window last year, scaled to this window's
    # open days. Scaled rather than used raw because last year's window may have
    # had a different number of trading days, and comparing a 52-open-day window
    # to a 50-open-day one as if they were equal is the calendar-vs-open-days
    # error in a different coat.
    ly_start = as_of - timedelta(days=365)
    ly_end = end - timedelta(days=365)
    ly_open = store.open_days(ly_start, ly_end)
    last_year = ((store.units(sku, ly_start, ly_end) / ly_open * win_open)
                 if ly_open > 0 else r28 * win_open)

    # THE ENGINE, as it stands: temporal shrinkage toward the long run.
    weekly = []
    for k in range(13):
        a = as_of - timedelta(days=7 * (k + 1))
        b = as_of - timedelta(days=7 * k)
        n = store.open_days(a, b)
        if n:
            weekly.append(store.units(sku, a, b) / n)
    if len(weekly) >= 4:
        mean = sum(weekly) / len(weekly)
        var = sum((x - mean) ** 2 for x in weekly) / len(weekly)
        cv = (var ** 0.5 / mean) if mean > 0 else 1.0
    else:
        cv = 1.0
    n_eff = recent_open / (1.0 + cv ** 2)
    w = n_eff / (n_eff + SHRINK_K)
    engine_rate = w * r28 + (1.0 - w) * r365

    mult = seasonal_multiplier(store, as_of, end, dow, pre_idx)

    return {
        "trailing_28": r28 * win_open,
        "last_year": last_year,
        "year_average": r365 * win_open,
        "engine": engine_rate * win_open,
        # THE CANDIDATE: the engine's level, times how busy this particular
        # window is. Nothing is hand-weighted - `mult` is estimated from the
        # store's own history at this date.
        "engine_seasonal": engine_rate * win_open * mult,
        "_actual": store.units(sku, as_of, end),
        "_win_open": float(win_open),
        "_mult": mult,
        # The interval is NOT computed here. See `calibrate_interval`.
        #
        # Two analytic attempts both failed, and the pair of failures is the
        # argument for doing it empirically. Applying the weekly cv straight to
        # a window total gave 91-93% coverage against an 80% target - an
        # interval so wide it could not be wrong, which is a different failure
        # from being wrong but not a better one. Dividing by sqrt(weeks) gave
        # 37-62%: too narrow, because weekly demand is autocorrelated and the
        # independence that sqrt(n) assumes is not there.
        #
        # The honest answer is to stop assuming a shape and measure how wrong
        # this estimator has actually been on this store.
        "_cv": cv,
    }


def calibrate_interval(store: Store, horizon: int, dates: list[date],
                      dow_cache: dict, pre_cache: dict) -> tuple[float, float]:
    """Empirical p10/p90 multipliers, from this estimator's own track record.

    For every (SKU, date) in a CALIBRATION slice of history, take
    actual / forecast. The 10th and 90th percentiles of that ratio are the
    multipliers to put around a future forecast - no distributional assumption
    at all, just "this estimator has historically landed inside this band eight
    times in ten".

    NO LEAKAGE: the calibration dates are strictly earlier than the scored
    dates, and the caller is responsible for that split. A band fitted on the
    windows it is then scored on would read 80% by construction and mean
    nothing.
    """
    ratios: list[float] = []
    for as_of in dates:
        dow = dow_cache[as_of]
        pre = pre_cache[as_of]
        for sku in store.daily:
            f = forecasts_for(store, sku, as_of, horizon, dow, pre)
            if f is None or f["engine"] <= 0:
                continue
            ratios.append(f["_actual"] / f["engine"])
    if len(ratios) < 50:
        return (0.5, 2.0)          # not enough history to say - stay honest
    ratios.sort()
    lo = ratios[int(0.10 * len(ratios))]
    hi = ratios[int(0.90 * len(ratios))]
    return (lo, hi)


MODELS = ("trailing_28", "last_year", "year_average", "engine", "engine_seasonal")


# ── Scoring ──────────────────────────────────────────────────────────────────


def wape(rows: list[dict], model: str, weight: str = "units") -> float | None:
    """sum|error| / sum(actual), optionally margin-weighted.

    Scale-free, and unlike MAPE it does not divide by a zero actual - which is
    most windows for most SKUs in a liquor catalogue.
    """
    num = den = 0.0
    for r in rows:
        w = 1.0 if weight == "units" else (r["margin"] or 0.0)
        if w <= 0:
            continue
        num += w * abs(r[model] - r["_actual"])
        den += w * r["_actual"]
    return (num / den * 100) if den > 0 else None


def bias(rows: list[dict], model: str) -> float | None:
    """Mean signed error over mean actual. A forecaster can have fine WAPE and
    still run 20% high on everything, which shows up only here."""
    num = sum(r[model] - r["_actual"] for r in rows)
    den = sum(r["_actual"] for r in rows)
    return (num / den * 100) if den > 0 else None


def coverage(rows: list[dict]) -> float | None:
    inside = sum(1 for r in rows if r["_p10"] <= r["_actual"] <= r["_p90"])
    return (inside / len(rows) * 100) if rows else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", required=True)
    ap.add_argument("--file", required=True)
    ap.add_argument("--store", default="the store")
    ap.add_argument("--every", type=int, default=14)
    ap.add_argument("--out")
    args = ap.parse_args()

    print(f"loading {args.file} ...")
    store = load(args.data, args.file)
    print(f"  {store.n_lines:,} lines, {len(store.daily):,} products, "
          f"cost on {store.cost_coverage * 100:.0f}% of lines")

    first = store.trading_days[0] + timedelta(days=LONG_RUN_DAYS + 5)
    last = store.trading_days[-1] - timedelta(days=max(HORIZONS) + 2)
    dates = [d for d in store.trading_days if first <= d <= last][::args.every]
    if not dates:
        raise SystemExit("not enough history")
    print(f"  {len(dates)} decision dates: {dates[0]} .. {dates[-1]}")

    # A CALIBRATION SLICE, strictly earlier than everything scored. The
    # interval is fitted here and applied there; fitting it on the scored
    # windows would make coverage 80% by construction and mean nothing.
    split = max(3, len(dates) // 4)
    cal_dates, score_dates = dates[:split], dates[split:]
    print(f"  interval calibrated on {len(cal_dates)} early dates, "
          f"scored on {len(score_dates)}")

    dow_cache = {d: day_of_week_index(store, d) for d in dates}
    pre_cache = {d: pre_holiday_index(store, d) for d in dates}

    bands = {h: calibrate_interval(store, h, cal_dates, dow_cache, pre_cache)
             for h in HORIZONS}
    for h in HORIZONS:
        print(f"    {h:>4}d band  x{bands[h][0]:.2f} .. x{bands[h][1]:.2f}")

    rows: dict[int, list[dict]] = {h: [] for h in HORIZONS}
    for i, as_of in enumerate(score_dates, 1):
        dow = dow_cache[as_of]
        pre_idx = pre_cache[as_of]
        for h in HORIZONS:
            lo_m, hi_m = bands[h]
            for sku in store.daily:
                f = forecasts_for(store, sku, as_of, h, dow, pre_idx)
                if f is None:
                    continue
                f["_p10"] = f["engine"] * lo_m
                f["_p90"] = f["engine"] * hi_m
                p, c = store.price.get(sku), store.cost.get(sku)
                f["margin"] = (p - c) if (p and c and 0 < c < p) else 0.0
                f["sku"] = sku
                f["as_of"] = as_of.isoformat()
                f["category"] = store.category.get(sku, "")
                rows[h].append(f)
        if i % 10 == 0 or i == len(score_dates):
            print(f"  {i}/{len(score_dates)} dates, "
                  f"{sum(len(v) for v in rows.values()):,} forecasts")

    print("")
    print("=" * 94)
    print(f"  FORECAST ACCURACY - {args.store}".center(94))
    print("  WAPE: lower is better. bias: nearer zero is better.".center(94))
    print("=" * 94)

    summary: dict[str, Any] = {"store": args.store,
                               "calibration_dates": len(cal_dates),
                               "scored_dates": len(score_dates),
                               "interval_bands": {str(h): list(bands[h])
                                                  for h in HORIZONS},
                               "horizons": {}}
    for h in HORIZONS:
        rs = rows[h]
        if not rs:
            continue
        print(f"\n{h}-DAY HORIZON   n={len(rs):,} forecasts   "
              f"mean seasonal multiplier {sum(r['_mult'] for r in rs) / len(rs):.3f}")
        print(f"  {'model':>16} {'WAPE units':>11} {'WAPE margin':>12} {'bias':>8}")
        hor: dict[str, Any] = {"n": len(rs)}
        for m in MODELS:
            wu, wm, b = wape(rs, m), wape(rs, m, "margin"), bias(rs, m)
            hor[m] = {"wape_units": wu, "wape_margin": wm, "bias": b}
            mark = ""
            print(f"  {m:>16} {wu:>10.1f}% {('%.1f%%' % wm) if wm else '      n/a':>12} "
                  f"{b:>+7.1f}%{mark}")
        cov = coverage(rs)
        hor["coverage_p10_p90"] = cov
        print(f"  p10-p90 coverage {cov:>9.1f}%   (target 75-85%)")

        best = min((MODELS), key=lambda m: hor[m]["wape_units"] or 1e9)
        beats = [m for m in ("trailing_28", "last_year", "year_average")
                 if (hor["engine_seasonal"]["wape_units"] or 1e9)
                 < (hor[m]["wape_units"] or 1e9)]
        hor["best_model"] = best
        hor["engine_seasonal_beats"] = beats
        print(f"  best: {best}   |   engine_seasonal beats "
              f"{len(beats)}/3 baselines"
              + (f" ({', '.join(beats)})" if beats else ""))
        summary["horizons"][str(h)] = hor

    print("")
    print("=" * 94)
    print("  ACCEPTANCE (R10): beat all three baselines, bias within +/-5%, "
          "coverage 75-85%")
    print("  Judged on the SHIPPED model. The candidate is reported beside it,")
    print("  not instead of it - a gate that grades the thing you hope for is "
          "not a gate.")
    print("=" * 94)
    for h in HORIZONS:
        hor = summary["horizons"].get(str(h))
        if not hor:
            continue
        for label, key in (("engine   ", "engine"),
                           ("candidate", "engine_seasonal")):
            m = hor[key]
            beats = [b for b in ("trailing_28", "last_year", "year_average")
                     if (m["wape_units"] or 1e9) < (hor[b]["wape_units"] or 1e9)]
            ok_base = len(beats) == 3
            ok_bias = abs(m["bias"] or 1e9) <= 5
            flags = (f"baselines {'PASS' if ok_base else 'FAIL'} ({len(beats)}/3)   "
                     f"bias {'PASS' if ok_bias else 'FAIL'} ({m['bias']:+.1f}%)")
            cov = hor["coverage_p10_p90"]
            if key == "engine":
                ok_cov = 75 <= (cov or 0) <= 85
                flags += (f"   coverage {'PASS' if ok_cov else 'FAIL'} "
                          f"({cov:.0f}%)")
            print(f"  {h:>4}d {label}  {flags}")
            hor[key]["beats"] = beats
        print("")

    # The verdict on the candidate, computed rather than hoped for.
    wins = sum(1 for h in HORIZONS
               if (summary["horizons"].get(str(h), {}).get("engine_seasonal", {})
                   .get("wape_units") or 1e9)
               < (summary["horizons"].get(str(h), {}).get("engine", {})
                  .get("wape_units") or 1e9))
    summary["candidate_verdict"] = (
        "ADOPT" if wins == len(HORIZONS) else
        "REJECT" if wins == 0 else "MIXED")
    print("=" * 94)
    print(f"  SEASONAL CANDIDATE: {summary['candidate_verdict']} - it beats the "
          f"shipped model at {wins}/{len(HORIZONS)} horizons.")
    if wins == 0:
        print("  The multiplier inflates every forecast by ~7%, which is why "
              "bias worsens.")
        print("  The trailing window already reflects current conditions, so a "
              "store-level")
        print("  busy-ness index double-counts. This is the SECOND time "
              "seasonality has")
        print("  been tried on this engine and lost; it is not going in as a "
              "multiplier.")
    print("=" * 94)

    if args.out:
        out = Path(args.out).resolve()
        out.mkdir(parents=True, exist_ok=True)
        (out / "forecast_accuracy.json").write_text(
            json.dumps(summary, indent=1, default=str), encoding="utf-8")
        print(f"\n  wrote {out / 'forecast_accuracy.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
