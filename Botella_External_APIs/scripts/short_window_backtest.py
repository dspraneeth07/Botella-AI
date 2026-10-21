#!/usr/bin/env python
"""A REDUCED-WINDOW forecast backtest, for a store too young for the real one.

    python scripts/short_window_backtest.py --data ../audit/tuscany/data \
        --file store_173_sale_items.csv.gz --store "Tuscany Liquors" \
        --long-run 45 --horizons 7,14,28 --every 2 --out run/tuscany.json

THIS IS NOT THE PRODUCTION MEASUREMENT, AND THE DIFFERENCE IS THE POINT.

`scripts/forecast_accuracy.py` (R10) and `scripts/real_engine_backtest.py` both
need, per decision date:

    370 days of history BEHIND it  - the engine's long-run rate is a 365-day
                                     window, and starting earlier compares a
                                     28-day window against a 90-day one while
                                     calling it a year
    122 days AHEAD of it           - max(HORIZONS) + 2, because the label does
                                     not exist until the window closes

That is 492 days before a single scorable decision date exists. A store with
less history is not measured badly by those scripts; it is REFUSED by them,
which is the correct behaviour and why they print "not enough history" and stop.

This script exists so that a young store can still be measured by SOMETHING,
with the windows shortened to fit and the shortening stated in the output. It
imports the same estimator - `forecast_accuracy.forecasts_for`, which is the
engine's shrinkage toward its long run - and patches only the two window
constants. The production scripts are left untouched: their figures are in
print, and a script that quietly changes a published window is worse than no
script.

WHAT A SHORTENED WINDOW COSTS, stated plainly because the numbers below are
weaker than the production ones in ways no confidence interval shows:

    TWO OF THE THREE BASELINES STOP BEING BASELINES. `last_year` needs the same
    calendar window a year earlier; with no history there, forecasts_for falls
    back to `r28 * win_open`, which is EXACTLY `trailing_28`. So "beats
    last_year" becomes a tautology, not evidence. `year_average` becomes an
    average over whatever history exists - three months, not a year. Only
    `trailing_28` survives as an independent comparison.

    THE ENGINE'S LONG RUN IS NO LONGER LONG. The estimator shrinks the recent
    rate toward the long-run rate; when the long run is 45 days and the recent
    window is 28, the two overlap heavily and the shrinkage does much less work
    than it does in production.

    FEW DECISION DATES MEANS A WIDE INTERVAL. Windows a few days apart share
    most of their data, so a dozen dates is nothing like a dozen independent
    observations. The reported interval is clustered by date for that reason,
    and it will still be wide.

So: a result here is evidence about this store's data at short horizons. It is
not an estimate of production accuracy, and it must not be quoted as one.

NO DATABASE. One CSV export in, one JSON out.
"""

from __future__ import annotations

import argparse
import json
import random
from datetime import timedelta
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts import forecast_accuracy as fa  # noqa: E402
from scripts.real_engine_backtest import BASELINE_WINDOW_DAYS, load  # noqa: E402

#: Baselines that mean what their name says only with a year of history behind
#: them. Reported, but flagged, so nobody quotes "beat 3 of 3".
DEGENERATE_WITHOUT_A_YEAR = ("last_year", "year_average")


def wape(rows: list[dict], model: str) -> float | None:
    """Weighted absolute percentage error: sum|err| / sum(actual)."""
    denom = sum(r["_actual"] for r in rows)
    if denom <= 0:
        return None
    return sum(abs(r[model] - r["_actual"]) for r in rows) / denom * 100


def bias(rows: list[dict], model: str) -> float | None:
    denom = sum(r["_actual"] for r in rows)
    if denom <= 0:
        return None
    return sum(r[model] - r["_actual"] for r in rows) / denom * 100


def clustered_ci(by_date: list[list[float]], rng: random.Random,
                 draws: int = 2000) -> tuple[float, float]:
    """A date-clustered bootstrap of the mean.

    Clustered because two forecasts made on the same morning share a market and
    a trailing window. Resampling individual forecasts would report an interval
    far tighter than the evidence supports - the same mistake the production
    backtest documents having made once and thrown away.
    """
    if len(by_date) < 2:
        return (float("nan"), float("nan"))
    means = []
    for _ in range(draws):
        drawn: list[float] = []
        for _ in range(len(by_date)):
            drawn.extend(rng.choice(by_date))
        if drawn:
            means.append(sum(drawn) / len(drawn))
    if not means:
        return (float("nan"), float("nan"))
    means.sort()
    return (means[int(0.025 * len(means))], means[int(0.975 * len(means))])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True)
    ap.add_argument("--file", required=True)
    ap.add_argument("--store", default="the store")
    ap.add_argument("--long-run", type=int, default=45,
                    help="days in the shortened long-run window (production: 365)")
    ap.add_argument("--horizons", default="7,14,28",
                    help="comma-separated forecast horizons (production: 30,60,90,120)")
    ap.add_argument("--every", type=int, default=2)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    horizons = tuple(int(x) for x in args.horizons.split(",") if x.strip())
    rng = random.Random(173)

    # THE OVERRIDE, in one place and recorded in the output. `forecasts_for`
    # reads these module globals at call time, so patching the module is enough
    # and no production file changes.
    production = {"long_run_days": fa.LONG_RUN_DAYS, "horizons": list(fa.HORIZONS)}
    fa.LONG_RUN_DAYS = args.long_run
    fa.HORIZONS = horizons

    print(f"loading {args.file} ...")
    store = load(args.data, args.file)
    span_days = (store.trading_days[-1] - store.trading_days[0]).days
    print(f"  {store.n_lines:,} lines, {len(store.daily):,} products, "
          f"{len(store.trading_days)} trading days over {span_days} calendar days")
    print(f"  cost on {store.cost_coverage * 100:.1f}% of sold lines")

    needed = production["long_run_days"] + 5 + max(production["horizons"]) + 2
    print(f"\n  PRODUCTION R10 needs {needed} days of span; this store has "
          f"{span_days}. Short by {needed - span_days}.")
    print(f"  Running instead with long-run={args.long_run}d, "
          f"horizons={list(horizons)}.")

    first = store.trading_days[0] + timedelta(days=args.long_run + 5)
    last = store.trading_days[-1] - timedelta(days=max(horizons) + 2)
    dates = [d for d in store.trading_days if first <= d <= last][::args.every]
    if not dates:
        raise SystemExit(
            f"even the reduced window does not fit: needs "
            f"{args.long_run + 5 + max(horizons) + 2} days of span, "
            f"store has {span_days}")
    print(f"  {len(dates)} decision dates: {dates[0]} .. {dates[-1]}")

    # The interval is calibrated on dates strictly earlier than those scored.
    # Fitting it on the scored windows would make coverage 80% by construction.
    split = max(2, len(dates) // 4)
    cal_dates, score_dates = dates[:split], dates[split:]
    if not score_dates:
        raise SystemExit("no dates left to score after the calibration slice")
    print(f"  interval calibrated on {len(cal_dates)}, scored on {len(score_dates)}")

    dow_cache = {d: fa.day_of_week_index(store, d) for d in dates}
    pre_cache = {d: fa.pre_holiday_index(store, d) for d in dates}
    bands = {h: fa.calibrate_interval(store, h, cal_dates, dow_cache, pre_cache)
             for h in horizons}

    rows: dict[int, list[dict]] = {h: [] for h in horizons}
    per_date: dict[int, dict[str, list[float]]] = {h: {} for h in horizons}
    for as_of in score_dates:
        dow, pre_idx = dow_cache[as_of], pre_cache[as_of]
        for h in horizons:
            lo_m, hi_m = bands[h]
            for sku in store.daily:
                f = fa.forecasts_for(store, sku, as_of, h, dow, pre_idx)
                if f is None:
                    continue
                f["_p10"] = f["engine"] * lo_m
                f["_p90"] = f["engine"] * hi_m
                f["sku"] = sku
                rows[h].append(f)
                key = as_of.isoformat()
                per_date[h].setdefault(key, []).append(
                    1.0 if f["_p10"] <= f["_actual"] <= f["_p90"] else 0.0)

    # Is `last_year` actually independent here, or has it collapsed onto
    # trailing_28? Measured rather than assumed, because the fallback is silent.
    collapsed = {}
    for h in horizons:
        if rows[h]:
            same = sum(1 for r in rows[h]
                       if abs(r["last_year"] - r["trailing_28"]) < 1e-9)
            collapsed[h] = {"identical_to_trailing_28": same, "of": len(rows[h])}

    summary = {
        "store": args.store,
        "data": {"lines": store.n_lines, "products": len(store.daily),
                 "trading_days": len(store.trading_days),
                 "span_days": span_days,
                 "first_day": store.trading_days[0].isoformat(),
                 "last_day": store.trading_days[-1].isoformat(),
                 "cost_coverage_pct": round(store.cost_coverage * 100, 2)},
        "production_requirement_days": needed,
        "production_windows": production,
        "windows_used": {"long_run_days": args.long_run, "horizons": list(horizons),
                         "baseline_window_days": BASELINE_WINDOW_DAYS},
        "dates": {"total": len(dates), "calibration": len(cal_dates),
                  "scored": len(score_dates),
                  "first": dates[0].isoformat(), "last": dates[-1].isoformat()},
        "interval_bands": {str(h): list(bands[h]) for h in horizons},
        "baseline_collapse": collapsed,
        "degenerate_baselines": list(DEGENERATE_WITHOUT_A_YEAR),
        "by_horizon": {},
    }

    print("")
    print("=" * 86)
    print(f"  REDUCED-WINDOW FORECAST ACCURACY - {args.store}".center(86))
    print("  WAPE: lower is better.  bias: nearer zero is better.".center(86))
    print("=" * 86)
    for h in horizons:
        r = rows[h]
        if not r:
            print(f"\n  {h}d: no scorable forecasts")
            summary["by_horizon"][str(h)] = {"forecasts": 0}
            continue
        cov = fa.coverage(r)
        lo, hi = clustered_ci(list(per_date[h].values()), rng)
        block = {
            "forecasts": len(r),
            "skus": len({x["sku"] for x in r}),
            "actual_units": round(sum(x["_actual"] for x in r), 1),
            "interval_coverage_pct": None if cov is None else round(cov, 1),
            "interval_coverage_ci95": [None if lo != lo else round(lo * 100, 1),
                                       None if hi != hi else round(hi * 100, 1)],
            "models": {},
        }
        print(f"\n  {h}-day horizon - {len(r):,} forecasts over "
              f"{block['skus']:,} SKUs, {block['actual_units']:,.0f} actual units")
        print(f"    {'model':<18} {'WAPE %':>9} {'bias %':>9}")
        for m in fa.MODELS:
            w, b = wape(r, m), bias(r, m)
            block["models"][m] = {"wape_pct": None if w is None else round(w, 2),
                                  "bias_pct": None if b is None else round(b, 2)}
            flag = "  (not independent at this store)" if m in DEGENERATE_WITHOUT_A_YEAR else ""
            print(f"    {m:<18} {w:>9.2f} {b:>9.2f}{flag}")
        if cov is not None:
            ci = (f"  95% CI {lo*100:.1f} .. {hi*100:.1f}"
                  if lo == lo else "  CI unavailable (too few dates)")
            print(f"    interval coverage {cov:.1f}% (target 80){ci}")
        summary["by_horizon"][str(h)] = block

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
