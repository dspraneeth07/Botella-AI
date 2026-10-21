#!/usr/bin/env python
"""One combined report per GOOD store: ledger + forecast accuracy + backtest.

    python scripts/run_all_ledgers.py --data ../audit/data --out ../audit \
        --month 2026-03

Each store gets all three layers of evidence in one page, because they answer
different questions and a reader needs all three:

    the month      every card and its outcome, checkable line by line
    the forecast   how wrong the quantity is, against three baselines (R10)
    the backtest   2.3 years at fortnightly spacing - the quotable headline

Per store, never pooled. The engine is switched on one store at a time, so it is
judged one store at a time, and a store where it does not work is the most
useful row in the index.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from _gate_inputs import gate_inputs_for, promise_kept_rate  # noqa: E402

STORES = [
    (171, "Bethany Discount Liquor", "171"),
    (176, "Northlake Liquors North", "176"),
    (177, "Mango Jo's Bar & Liquors", "177"),
    (178, "Marshfield Wine & Spirits", "178"),
    (181, "Cork Runner Wine & Spirits", "181"),
]


def run(cmd: list[str], label: str) -> bool:
    print(f"    {label} ...", flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"    FAILED: {label}")
        print(r.stdout[-1200:])
        print(r.stderr[-1200:])
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--month", default="2026-03")
    ap.add_argument("--every", type=int, default=28,
                    help="decision-date spacing for the accuracy harness")
    ap.add_argument(
        "--calibrate-on", default="2026-01,2026-02",
        help="EARLIER months to fit the confidence curve on, comma separated. "
             "The gate's ECE and reliability checks are measured OUT OF SAMPLE "
             "or not at all: fitting and scoring the same month measures how "
             "well a step function can memorise 200 points, which is perfectly, "
             "and would report a near-zero ECE at every store forever. Pass an "
             "empty string to score the RAW ranking score instead - the table "
             "then labels it as raw, which is a different and much weaker claim.")
    args = ap.parse_args()

    data, out = Path(args.data).resolve(), Path(args.out).resolve()
    done = []
    for loc, name, slug in STORES:
        src = data / f"store_{loc}_sale_items.csv.gz"
        if not src.exists():
            print(f"  {loc} {name}: export missing, skipped")
            continue
        print(f"\n=== {loc}  {name} ===", flush=True)
        acc_dir = out / f"forecast-{slug}"
        bt_dir = out / f"{slug}-backtest"
        led_dir = out / f"ledger-{slug}-{args.month}"

        ok = run([sys.executable, str(HERE / "forecast_accuracy.py"),
                  "--data", str(data), "--file", src.name, "--store", name,
                  "--every", str(args.every), "--out", str(acc_dir)],
                 "forecast accuracy (R10)")
        ok &= run([sys.executable, str(HERE / "real_engine_backtest.py"),
                   "--data", str(data), "--file", src.name, "--store", name,
                   "--every", "14", "--out", str(bt_dir)],
                  "walk-forward backtest")
        # The calibration slices are generated BEFORE the published month, because
        # they are also the track-record screen's evidence - a SKU whose January
        # and February cards lost money is known to have lost by March.
        prior_args: list[str] = []
        for fit_month in [m.strip() for m in args.calibrate_on.split(",")
                          if m.strip()]:
            fit_dir = out / "calibration" / f"{fit_month}-{slug}"
            if not (fit_dir / "ledger.json").exists():
                run([sys.executable, str(HERE / "daily_recommendation_ledger.py"),
                     "--data", str(data), "--file", src.name, "--store", name,
                     "--month", fit_month, "--out", str(fit_dir)],
                    f"calibration slice {fit_month}")
            if (fit_dir / "ledger.json").exists():
                prior_args += ["--prior", str(fit_dir / "ledger.json")]

        ok &= run([sys.executable, str(HERE / "daily_recommendation_ledger.py"),
                   "--data", str(data), "--file", src.name, "--store", name,
                   "--month", args.month, "--out", str(led_dir),
                   "--accuracy", str(acc_dir / "forecast_accuracy.json"),
                   "--backtest", str(bt_dir / "summary.json")] + prior_args,
                  "combined ledger")
        if not ok:
            continue
        led = json.loads((led_dir / "ledger.json").read_text(encoding="utf-8"))
        bt = json.loads((bt_dir / "summary.json").read_text(encoding="utf-8"))
        s30 = led["summary"].get("30", {})

        # THE CONFIDENCE CURVE IS FITTED ON EARLIER MONTHS, NEVER ON THIS ONE.
        # These ledgers exist only to fit on, so they are written under
        # calibration/ rather than beside the published month - a reader opening
        # the audit folder should not have to work out which of six ledgers is
        # the result.
        prior = []
        for fit_month in [m.strip() for m in args.calibrate_on.split(",")
                          if m.strip()]:
            fit_dir = out / "calibration" / f"{fit_month}-{slug}"
            if (fit_dir / "ledger.json").exists():
                prior.append(json.loads(
                    (fit_dir / "ledger.json").read_text(encoding="utf-8")
                )["ledger"])

        gate_in = gate_inputs_for(
            ledger=led["ledger"], prior_ledgers=prior, store_id=loc,
            as_of=date.fromisoformat(f"{args.month}-01"),
        )
        done.append({
            "loc": loc, "name": name,
            "folder": f"ledger-{slug}-{args.month}",
            "cards": len(led["ledger"]),
            "skus": len({r["sku"] for r in led["ledger"]}),
            "retired": len(led.get("retirements") or []),
            "hit30": s30.get("hit_rate"),
            # `promise_fill_ratio` and NOT `promise30`. The old key held a ratio
            # of TOTALS and was compared against a band written for a per-card
            # kept rate, which handed Marshfield a SHIP for under-delivering 11%
            # while failing Cork Runner for over-delivering. The gate now reads a
            # differently-named field, so that mix-up cannot recur silently.
            "net30": s30.get("net_margin"),
            # N0.2 - the per-card figure and its clustered interval. This is the
            # one the index sorts and compares on: a total cannot be compared
            # across stores that issued different numbers of cards.
            "net_per_card30": s30.get("net_margin_per_card"),
            "net_per_card30_ci": s30.get("net_margin_per_card_ci"),
            "money_cards30": s30.get("cards_with_money"),
            "captured30": s30.get("margin_captured"),
            "bt_hit": bt["sheet20"]["hit_rate"],
            "bt_null": bt["null_reversion"],
            "bt_edge": bt["sheet20"]["hit_rate"] - bt["null_reversion"],
            "bt_p": bt["p_value"],
            "cost": bt.get("cost_coverage", 1.0),
            # Every field the gate reads. Four of its seven checks printed "not
            # measured" at every store until these existed.
            **gate_in.as_dict(),
            # Measured and deliberately NOT gated: bounded above by the hit rate,
            # so banding it would restate the accuracy target as an independent
            # check. Published because the reason it is not gated has to stay
            # verifiable.
            "promise_kept_rate": promise_kept_rate(led["ledger"]),
        })
        print(f"    done: April {s30.get('hit_rate', 0):.1f}%, "
              f"promise {gate_in.promise_fill_ratio or 0:.0f}%, "
              f"backtest {bt['sheet20']['hit_rate']:.1f}% "
              f"(+{bt['sheet20']['hit_rate'] - bt['null_reversion']:.1f})")

    if not done:
        print("nothing ran")
        return 1
    (out / "all_stores.json").write_text(json.dumps(done, indent=1),
                                        encoding="utf-8")
    from datetime import datetime as _dt
    from scripts._index_report import build_index
    label = _dt.strptime(args.month, "%Y-%m").strftime("%B %Y")
    (out / "ENGINE_AUDIT.html").write_text(build_index(done, label),
                                           encoding="utf-8")
    print(f"\n{'=' * 78}\n  {len(done)} stores\n{'=' * 78}")
    print(f"{'store':>28} {'April':>7} {'fill':>8} {'net':>9} "
          f"{'backtest':>9} {'edge':>7} {'p':>8}")
    for d in sorted(done, key=lambda x: -(x["bt_edge"] or 0)):
        money = "-" if d["cost"] < 0.01 else format(d["net30"] or 0, "+,.0f")
        fill = d.get("promise_fill_ratio")
        print(f"{d['name'][:28]:>28} {d['hit30']:>6.1f}% "
              f"{(format(fill, '.0f') + '%') if fill is not None else '-':>8} "
              f"{money:>9} {d['bt_hit']:>8.1f}% {d['bt_edge']:>+6.1f} "
              f"{d['bt_p']:>8.4f}")
    print(f"\n  wrote {out / 'all_stores.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
