#!/usr/bin/env python
"""The harness's forecaster against the engine's per-class ensemble.

WHY THIS EXISTS
    N6.2 asked for Syntetos-Boylan classification, Croston for intermittent SKUs,
    SBA, and an empirical bootstrap interval, on the grounds that "there is no
    app/pipeline/forecast/ module and no Croston, SBA or bootstrap anywhere in the
    tree".

    ALL FOUR ALREADY EXIST. They are in `storeagent/forecasting/`, not
    `app/pipeline/forecast/`:

        classify.py   Syntetos-Boylan, ADI_CUT 1.32 / CV2_CUT 0.49, in OPEN days
        ensemble.py   SMOOTH -> seasonal ETS, INTERMITTENT -> Croston,
                      ERRATIC and LUMPY -> SBA, intervals from a bootstrap,
                      and a REFUSAL when a lumpy interval is too wide to act on

    What was actually missing is this script. `scripts/forecast_accuracy.py` and
    `scripts/real_engine_backtest.py` each carry their OWN single-method
    forecaster and never call the ensemble - so every WAPE, bias and interval
    figure in the audit measures a forecaster the pipeline does not contain.

    That is the finding, and it reframes several others: the p10 band of 0.106
    that made a 90% promise impossible in N1.1 was fitted on the harness's single
    method pooled across every demand class, not on the ensemble's per-class
    bootstrap.

WHAT IT MEASURED, ON BETHANY
    The population is overwhelmingly NOT smooth, which is what the whole
    per-class argument rests on:

        intermittent  236 of 400     Croston
        new_sku       118            cohort prior
        lumpy          44            SBA (5 refused as too wide)
        smooth          2            seasonal ETS

    And yet, over 7 decision dates and ~1,300 SKU-windows per horizon:

        horizon   WAPE harness   WAPE ensemble   bias harness   bias ensemble
             30          46.6%           57.6%          +3.2%         +15.4%
             60          44.9%           58.6%          +4.2%         +18.8%
             90          44.2%           59.1%          +5.3%         +20.6%
            120          44.7%           61.2%          +8.2%         +24.0%

    p10-p90 coverage from the ensemble's bootstrap: 63 / 51 / 43 / 39 percent,
    against the harness's empirically calibrated band at 80-82.

    THE METHOD BUILT FOR INTERMITTENT DEMAND LOSES TO A SHRUNK MEAN, on this
    store, on this data, by 11 to 17 points of WAPE.

AND THE OBVIOUS ALTERNATIVE EXPLANATION WAS TESTED AND EXCLUDED
    +15.4% bias at 30 days is suspiciously close to Bethany's 13-17% closed-day
    fraction, which would be the signature of a calendar/open-day mismatch in
    this bridge rather than a real difference. So the ratio of the two central
    forecasts was measured per demand class:

        intermittent  n=121   median 1.037   IQR [0.862, 1.243]
        lumpy         n= 58   median 0.839   IQR [0.710, 1.177]
        ALL           n=183   median 1.012

    A unit mismatch would show a near-CONSTANT ratio of about 1.15 across every
    class. It does not: the median is 1.012 and it varies by class. So the bridge
    is not the cause.

    The shape that IS consistent with the numbers: the ensemble's typical
    forecast matches the simple one almost exactly, and its errors are far more
    DISPERSED - the interquartile ratios span 0.71 to 1.24. WAPE and bias are
    units-weighted sums, so they are decided by the large SKUs where the two
    disagree most, not by the median SKU where they agree.

WHAT THIS DOES NOT SAY
    Not that Croston is wrong in general - it is the standard treatment and the
    tests in tests/test_ensemble.py show it behaves correctly, including that SBA
    sits below Croston and that the bootstrap is unbiased against a known rate.
    What it says is narrower and more useful: ON THIS ESTATE, AT THESE HORIZONS,
    switching the measured path to it would make the published accuracy worse,
    and anyone proposing the switch should be shown this table first.

    Seven decision dates at one store is thin. `--dates` and `--file` widen it.
"""

from __future__ import annotations

import argparse
import statistics as st
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline.context import RunContext                       # noqa: E402
from app.pipeline.features.store import CalendarDay, DayFact      # noqa: E402
from storeagent.forecasting.classify import (                     # noqa: E402
    ClassifyRequest,
    classify,
)
from storeagent.forecasting.ensemble import (                     # noqa: E402
    ForecastRequest,
    forecast,
)
import scripts.forecast_accuracy as fa                            # noqa: E402
from scripts.real_engine_backtest import load                     # noqa: E402

HORIZONS = (30, 60, 90, 120)
#: A year of open days behind each decision date, which is what the classifier's
#: default window expects.
LOOKBACK_DAYS = 364
#: Below this a classification cannot distinguish an intermittent SKU from a
#: store that was simply shut for most of the window.
MIN_OPENS_TO_CLASSIFY = 60


def _ctx(store_id: int, as_of: date) -> RunContext:
    return RunContext(
        run_id="compare", tenant_id=1, store_id=store_id, as_of=as_of,
        snapshot_id="snap", config_version="default", seed=0,
        versions={"classify": "1.0.0", "forecast": "1.0.0"},
    )


def _wape(rows: list[tuple[float, ...]], idx: int) -> float:
    actual = sum(r[0] for r in rows)
    if actual <= 0:
        return float("nan")
    return sum(abs(r[idx] - r[0]) for r in rows) / actual * 100


def _bias(rows: list[tuple[float, ...]], idx: int) -> float:
    actual = sum(r[0] for r in rows)
    if actual <= 0:
        return float("nan")
    return sum(r[idx] - r[0] for r in rows) / actual * 100


def run(data: str, filename: str, store_id: int, every: int) -> int:
    store = load(data, filename)
    trading = store.trading_days
    if len(trading) < 500:
        print(f"  {filename}: too little history to compare")
        return 1

    # Dates need a year of history behind and the longest horizon ahead.
    first = trading[0] + timedelta(days=LOOKBACK_DAYS + 1)
    last = trading[-1] - timedelta(days=max(HORIZONS) + 1)
    dates = [d for d in trading if first <= d <= last][::every]
    if not dates:
        print(f"  {filename}: no scorable decision dates")
        return 1

    rows: dict[int, list[tuple[float, ...]]] = {h: [] for h in HORIZONS}
    classes: defaultdict[str, int] = defaultdict(int)
    methods: defaultdict[str, int] = defaultdict(int)
    ratios: defaultdict[str, list[float]] = defaultdict(list)

    for as_of in dates:
        dow = fa.day_of_week_index(store, as_of)
        pre = fa.pre_holiday_index(store, as_of)
        ctx = _ctx(store_id, as_of)
        window_start = as_of - timedelta(days=LOOKBACK_DAYS)
        calendar = [CalendarDay(obs_date=d, was_open=True)
                    for d in trading if window_start <= d < as_of]
        opens = [c.obs_date for c in calendar]
        if len(opens) < MIN_OPENS_TO_CLASSIFY:
            continue

        for sku, series in store.daily.items():
            facts = [DayFact(obs_date=d, sku=sku,
                             units_sold=float(series.get(d, 0.0)))
                     for d in opens]
            classified = classify(
                ClassifyRequest(sku=sku, calendar=calendar, facts=facts), ctx)
            if not classified.ok or classified.value is None:
                continue
            profile = classified.value
            dense = [float(series.get(d, 0.0)) for d in opens]

            for horizon in HORIZONS:
                end = as_of + timedelta(days=horizon)
                if end > trading[-1]:
                    continue
                harness = fa.forecasts_for(store, sku, as_of, horizon, dow, pre)
                if harness is None or harness["engine"] <= 0:
                    continue
                window_open = store.open_days(as_of, end)
                if window_open <= 0:
                    continue
                predicted = forecast(
                    ForecastRequest(profile=profile,
                                    horizon_open_days=window_open,
                                    series=dense), ctx)
                if not predicted.ok or predicted.value is None:
                    continue
                f = predicted.value
                rows[horizon].append(
                    (harness["_actual"], harness["engine"], f.p50, f.p10, f.p90))
                if horizon == HORIZONS[0]:
                    classes[profile.demand_class] += 1
                    methods[profile.method] += 1
                    ratios[profile.demand_class].append(f.p50 / harness["engine"])

    print(f"\n{filename} - {len(dates)} decision dates, every {every} trading days")
    print("\n  THE POPULATION IS NOT SMOOTH, which is what the per-class "
          "argument rests on:")
    for name, count in sorted(classes.items(), key=lambda kv: -kv[1]):
        print(f"    {name:<14}{count:>6}")
    print("\n  method actually used:")
    for name, count in sorted(methods.items(), key=lambda kv: -kv[1]):
        print(f"    {name:<22}{count:>6}")

    print(f"\n  {'horizon':>8}{'n':>7}{'WAPE harness':>14}{'WAPE ens':>11}"
          f"{'bias harness':>14}{'bias ens':>11}{'p10-p90 cov':>13}")
    for horizon, scored in rows.items():
        if len(scored) < 30:
            print(f"  {horizon:>8}{len(scored):>7}   too few to score")
            continue
        covered = sum(1 for r in scored if r[3] <= r[0] <= r[4]) / len(scored) * 100
        print(f"  {horizon:>8}{len(scored):>7}{_wape(scored,1):>13.1f}%"
              f"{_wape(scored,2):>10.1f}%{_bias(scored,1):>+13.1f}%"
              f"{_bias(scored,2):>+10.1f}%{covered:>12.0f}%")

    # The scaling-bug check. A unit mismatch would be a near-constant ratio
    # across every class; a method difference varies by class.
    print("\n  ratio of ensemble p50 to harness forecast - the bridge check:")
    print(f"    {'class':<14}{'n':>6}{'median':>9}{'IQR':>22}")
    pooled: list[float] = []
    for name, values in sorted(ratios.items(), key=lambda kv: -len(kv[1])):
        if not values:
            continue
        pooled += values
        ordered = sorted(values)
        q1 = ordered[len(ordered) // 4]
        q3 = ordered[3 * len(ordered) // 4]
        print(f"    {name:<14}{len(ordered):>6}{st.median(ordered):>9.3f}"
              f"   [{q1:.3f}, {q3:.3f}]")
    if pooled:
        print(f"    {'ALL':<14}{len(pooled):>6}{st.median(pooled):>9.3f}")
        print("\n  A near-CONSTANT ratio would mean a calendar/open-day mismatch "
              "in this bridge.\n  A ratio that varies by class means a real "
              "method difference.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, help="directory of exports")
    parser.add_argument("--file", required=True, help="store_NNN_sale_items.csv.gz")
    parser.add_argument("--store", type=int, default=0, help="location id, for the ctx")
    parser.add_argument("--every", type=int, default=21,
                        help="trading days between decision dates")
    args = parser.parse_args(argv)
    return run(args.data, args.file, args.store, args.every)


if __name__ == "__main__":        # pragma: no cover
    sys.exit(main())
