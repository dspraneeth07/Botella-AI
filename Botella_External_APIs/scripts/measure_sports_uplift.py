#!/usr/bin/env python
"""SUPERSEDED, AND KEPT BECAUSE THE WAY IT FAILED IS THE USEFUL PART.

THIS SCRIPT IS WRONG. Do not use its numbers. It is retained because its PLACEBO
is the clearest demonstration in this repository of why a measurement needs one.

WHAT IT CLAIMED. Applied to 5,389 backfilled home games it reported a median lift
of 1.55x at all five stores, 1,560 of 2,084 cells "usable", and headline results
like "NFL Sundays triple Marlboro sales". Every one of those numbers is an
artefact.

HOW IT BROKE, TWICE. The first version filtered SKUs on their GAME-DAY volume and
then measured game-day volume against a baseline - selecting on the outcome. That
was fixed. The second version was still wrong for a subtler reason: a cell where
the SKU sold ZERO on the event day gives log(0), which the estimator refuses, so
only cells where the product happened to sell survived into the result. Selection
on the outcome again, this time reintroduced through the logarithm.

WHAT SETTLED IT. A placebo of non-game dates, matched for weekday and count,
scored a median 4.319x against the real fixtures' 4.155x. The fake dates beat the
real ones. No argument about mechanism was needed after that.

WHY THE EVENT-UPLIFT MACHINERY IS INNOCENT. It is sound for Thanksgiving Eve: a
multi-day window with real aggregate volume, where zeros do not dominate. A single
game day against a sparse SKU is a different problem and it is not built for one.

WHAT TO USE INSTEAD. scripts/publish_signal_effects.py, which regresses the series
against day-of-week, month and trend controls - so a zero is DATA rather than an
exclusion. On the same fixtures it finds NFL home games SUPPRESS wine at Mango
Jo's (-17.1%) and spirits at Northlake (-6.4%), with its own placebo refusing
everywhere. That is the opposite sign to what this script reported, and the
difference is entirely the method.
"""
from __future__ import annotations

import argparse
import math
import json
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from app.pipeline.blend.event_uplift import (  # noqa: E402
    MIN_OCCURRENCES,
    EventUpliftRequest,
    Occurrence,
    estimate_event_uplift,
)
from app.pipeline.context import RunContext  # noqa: E402
from app.pipeline.features.taxonomy import category_family_of  # noqa: E402

#: Weeks either side the matched-weekday baseline is drawn from. The same window
#: the event playbook uses, so a fixture and a holiday are measured alike.
WEEKS_EITHER_SIDE = 6
#: A SKU needs enough movement for a daily comparison to mean anything. Below
#: this the ratio is noise amplified by division, which is the same reason the
#: reversion path carries a materiality floor.
MIN_UNITS_PER_OCCURRENCE = 1.0


def occurrences_for_sku(
    series: dict[date, float], game_days: set[date], open_days: set[date],
) -> list[Occurrence]:
    """One occurrence per game day: that day against matched weekdays around it."""
    out: list[Occurrence] = []
    for day in sorted(game_days):
        if day not in open_days:
            continue
        low, high = day - timedelta(weeks=WEEKS_EITHER_SIDE), day + timedelta(
            weeks=WEEKS_EITHER_SIDE)
        baseline = [
            d for d in open_days
            if low <= d <= high and d.weekday() == day.weekday()
            # OTHER GAME DAYS ARE NOT A CONTROL. An NBA team plays twice a week;
            # leaving those in the baseline makes the effect measure itself away.
            and d not in game_days
        ]
        if not baseline:
            continue
        out.append(Occurrence(
            year=day.year,
            event_units=float(series.get(day, 0.0)),
            event_open_days=1,
            baseline_units=float(sum(series.get(d, 0.0) for d in baseline)),
            baseline_open_days=len(baseline),
        ))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stores", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--history", required=True,
                    help="directory holding sports_history_<loc>.json")
    ap.add_argument("--top", type=int, default=8)
    args = ap.parse_args()

    from scripts.real_engine_backtest import load  # noqa: PLC0415

    grand_usable = grand_cells = 0
    for loc in [int(s.strip()) for s in args.stores.split(",") if s.strip()]:
        path = Path(args.history) / f"sports_history_{loc}.json"
        if not path.exists():
            print(f"  {loc}: {path.name} not found, skipped")
            continue
        rows = json.loads(path.read_text(encoding="utf-8"))
        by_key: dict[str, set[date]] = defaultdict(set)
        for r in rows:
            by_key[r["signal_key"]].add(date.fromisoformat(r["as_of"][:10]))

        store = load(args.data, f"store_{loc}_sale_items.csv.gz")
        open_days = set(store.trading_days)
        as_of = store.trading_days[-1]
        ctx = RunContext(run_id=f"sports-{loc}", tenant_id=loc, store_id=loc,
                         as_of=as_of, snapshot_id=f"snap-{as_of}",
                         config_version="default", seed=0,
                         versions={"event_uplift": "1.0.0"})
        minimum = int(__import__("app.pipeline.registry", fromlist=["cfg"]).cfg
                      .get(MIN_OCCURRENCES, ctx))

        # THE PLACEBO. Dates with the same weekday mix and the same count as the
        # real fixtures, drawn from days WITHOUT a game. It has no reason to carry
        # an effect, so whatever it reports is the method's own bias - and if it
        # reports the same 1.5x the real fixtures do, the measurement is measuring
        # itself and nothing it says about sport can be trusted.
        import random as _random
        rng = _random.Random(20260207)
        placebo_by_key: dict[str, set[date]] = {}
        for key, days in by_key.items():
            games = days & open_days
            want = defaultdict(int)
            for d in games:
                want[d.weekday()] += 1
            pool = defaultdict(list)
            for d in open_days - games:
                pool[d.weekday()].append(d)
            picked: set[date] = set()
            for weekday, n in want.items():
                candidates = pool.get(weekday) or []
                picked |= set(rng.sample(candidates, min(n, len(candidates))))
            placebo_by_key[f"PLACEBO_{key}"] = picked

        results = []
        placebo_results = []
        cells = 0
        for key, days in sorted({**by_key, **placebo_by_key}.items()):
            games = days & open_days
            if len(games) < minimum:
                continue
            for sku, series in store.daily.items():
                # VOLUME OVER THE WHOLE SERIES, never over the game days.
                #
                # The first version filtered on game-day units and then measured
                # game-day units against the baseline - selecting on the outcome.
                # Any SKU that happened to sell on game days survived; one that
                # sold on ordinary days and not on game days was thrown out. It
                # produced a median lift of 1.55x at all five stores, which is the
                # shape of a bias, not of a finding.
                total = sum(series.values())
                if total < MIN_UNITS_PER_OCCURRENCE * len(games):
                    continue
                occ = occurrences_for_sku(series, games, open_days)
                if len(occ) < minimum:
                    continue
                cells += 1
                res = estimate_event_uplift(EventUpliftRequest(
                    event_key=key, sku=sku, occurrences=occ), ctx)
                uplift = res.value
                if uplift is None or not getattr(uplift, "usable", False):
                    continue
                target = (placebo_results if key.startswith("PLACEBO_")
                          else results)
                target.append((key, sku, store.names.get(sku, sku), uplift))

        grand_cells += cells
        grand_usable += len(results)
        if placebo_results:
            pm = sorted(math.exp(u.uplift) for _k, _s, _n, u in placebo_results)
            print(f"        PLACEBO: {len(placebo_results)} usable, "
                  f"median {pm[len(pm) // 2]:.3f}x  "
                  f"(anything far from 1.000 is the method's own bias)")
        else:
            print("        PLACEBO: nothing usable, as it should be")
        print(f"  {loc}: {len(by_key)} leagues, {cells} (league x SKU) cells, "
              f"{len(results)} usable")
        # MAGNITUDE, NOT JUST SIGNIFICANCE, and this is the part that decides
        # whether any of it is worth a card. `uplift` is a LOG ratio, so exp(u) is
        # the multiplier. With 420 MLB home games behind a cell the interval gets
        # narrow enough that a 2% lift clears zero - statistically distinguishable
        # and commercially meaningless. Reporting the count of "usable" cells
        # without their size is how a null result gets published as a finding.
        mags = sorted((math.exp(u.uplift) for _k, _s, _n, u in results),
                      reverse=True)
        if mags:
            big = sum(1 for m in mags if m >= 1.10 or m <= 0.91)
            print(f"        multipliers: median {mags[len(mags) // 2]:.3f}  "
                  f"max {mags[0]:.3f}  min {mags[-1]:.3f}  "
                  f"moves of 10%+: {big} of {len(mags)}")
        for key, sku, name, up in sorted(
                results, key=lambda r: -abs(r[3].uplift)
        )[:args.top]:
            print(f"        {key:>15} {name[:32]:<32} "
                  f"{math.exp(up.uplift):.3f}x "
                  f"[{math.exp(up.interval.low):.3f}, "
                  f"{math.exp(up.interval.high):.3f}] n={up.n_own}")

    print(f"\n  {grand_usable} usable of {grand_cells} (league x SKU) cells")
    if grand_usable == 0:
        print("  NO HOME-GAME EFFECT IS CITABLE AT ANY STORE. That is a finding, "
              "not a gap: the fixtures are now recorded, the comparison was made "
              "against matched weekdays, and the intervals include zero.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
