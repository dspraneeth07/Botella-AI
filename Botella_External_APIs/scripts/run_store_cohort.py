#!/usr/bin/env python
"""Backtest an arbitrary cohort of stores, and record what happened to each.

    python scripts/run_store_cohort.py --data ../audit-14/data --out ../audit-14 \
        --month 2026-03 --cohort cohort.json

HOW THIS DIFFERS FROM `run_all_ledgers.py`
    That script has the five pilot stores hardcoded and assumes every one of them
    can be measured. This takes a cohort file and assumes nothing: a store with no
    export, no sales, or too short a history produces a NAMED REFUSAL rather than
    an exception, and the refusal lands in the same report as the results.

WHY A REFUSAL BELONGS IN THE REPORT
    "Backtest these fourteen stores" has a real answer even when twelve of them
    cannot be backtested, and that answer is worth more than twelve empty pages:
    it is a readiness audit. A store that is not in the database, a store that is
    in it with zero sale rows, and a store with one month of history are three
    different problems with three different owners, and a report that shows them
    as the same blank cell cannot be acted on.

    A March 2026 backtest needs roughly 365 days of history BEFORE 1 March and 120
    days of outcomes AFTER 31 March. That is not a tunable - it is what the
    long-run rate and the four horizons are made of - so a store outside it is
    refused with the dates that put it there.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

#: Days of history the long-run rate needs behind the first decision date.
HISTORY_DAYS = 365
#: Days of outcomes the longest horizon needs after the last decision date.
OUTCOME_DAYS = 120


def refusal(loc: int, name: str, reason: str, detail: str = "") -> dict:
    return {"loc": loc, "name": name, "ok": False, "reason": reason,
            "detail": detail}


def check_store(data: Path, loc: int, name: str, month: str) -> dict:
    """Can this store be backtested for `month`? Returns a verdict, never raises."""
    path = data / f"store_{loc}_sale_items.csv.gz"
    if not path.exists():
        return refusal(loc, name, "not_in_database",
                       "no sales export - the store is not in the warehouse, or "
                       "has never sent a sale")
    try:
        from scripts.real_engine_backtest import load
        store = load(str(data), path.name)
    except SystemExit as exc:
        return refusal(loc, name, "export_unreadable", str(exc))
    except Exception as exc:                        # noqa: BLE001
        return refusal(loc, name, "export_unreadable", str(exc))

    if not store.trading_days:
        return refusal(loc, name, "no_sales",
                       "the export exists and contains no sold lines")

    first, last = store.trading_days[0], store.trading_days[-1]
    start = date.fromisoformat(f"{month}-01")
    nxt = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    need_from = start - timedelta(days=HISTORY_DAYS)
    need_to = nxt + timedelta(days=OUTCOME_DAYS)

    span = (last - first).days
    if first > need_from or last < need_to:
        return refusal(
            loc, name, "history_too_short",
            f"has {first} to {last} ({span} days, {len(store.trading_days)} "
            f"trading days); a {month} backtest needs {need_from} to {need_to}")

    return {"loc": loc, "name": name, "ok": True, "reason": "",
            "detail": f"{first} to {last}, {len(store.trading_days)} trading days",
            "cost_coverage": store.cost_coverage,
            "lines": store.n_lines, "skus": len(store.daily)}


def run(cmd: list[str], label: str) -> tuple[bool, str]:
    print(f"      {label} ...", flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "").strip().splitlines()
        return False, (tail[-1] if tail else f"exit {r.returncode}")
    return True, ""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--month", default="2026-03")
    ap.add_argument("--cohort", required=True,
                    help="JSON list of {loc, name} - or {loc: null} for a store "
                         "that is not in the database at all")
    ap.add_argument("--calibrate-on", default="2026-01,2026-02")
    ap.add_argument("--every", type=int, default=28)
    args = ap.parse_args()

    data, out = Path(args.data).resolve(), Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    cohort = json.loads(Path(args.cohort).read_text(encoding="utf-8"))

    verdicts: list[dict] = []
    for entry in cohort:
        name = entry["name"]
        loc = entry.get("loc")
        print(f"\n=== {name} ===", flush=True)
        if loc is None:
            print("      not in the database - skipped")
            verdicts.append(refusal(0, name, "not_in_database",
                                    entry.get("note", "no matching store")))
            continue

        verdict = check_store(data, int(loc), name, args.month)
        if not verdict["ok"]:
            print(f"      REFUSED: {verdict['reason']} - {verdict['detail']}")
            verdicts.append(verdict)
            continue

        print(f"      {verdict['detail']}, "
              f"cost on {verdict['cost_coverage'] * 100:.0f}% of lines")
        slug = str(loc)
        src = f"store_{loc}_sale_items.csv.gz"
        bt_dir, led_dir = out / f"{slug}-backtest", out / f"ledger-{slug}-{args.month}"

        ok, why = run([sys.executable, str(HERE / "real_engine_backtest.py"),
                       "--data", str(data), "--file", src, "--store", name,
                       "--every", "14", "--out", str(bt_dir)], "backtest")
        if not ok:
            verdict.update(ok=False, reason="backtest_failed", detail=why)
            print(f"      REFUSED: backtest failed - {why}")
            verdicts.append(verdict)
            continue

        prior: list[str] = []
        for fit_month in [m.strip() for m in args.calibrate_on.split(",") if m.strip()]:
            fit_dir = out / "calibration" / f"{fit_month}-{slug}"
            if not (fit_dir / "ledger.json").exists():
                run([sys.executable, str(HERE / "daily_recommendation_ledger.py"),
                     "--data", str(data), "--file", src, "--store", name,
                     "--month", fit_month, "--out", str(fit_dir)],
                    f"calibration slice {fit_month}")
            if (fit_dir / "ledger.json").exists():
                prior += ["--prior", str(fit_dir / "ledger.json")]

        ok, why = run([sys.executable, str(HERE / "daily_recommendation_ledger.py"),
                       "--data", str(data), "--file", src, "--store", name,
                       "--month", args.month, "--out", str(led_dir),
                       "--backtest", str(bt_dir / "summary.json")] + prior,
                      "ledger")
        if not ok:
            verdict.update(ok=False, reason="ledger_failed", detail=why)
            print(f"      REFUSED: ledger failed - {why}")
            verdicts.append(verdict)
            continue

        led = json.loads((led_dir / "ledger.json").read_text(encoding="utf-8"))
        bt = json.loads((bt_dir / "summary.json").read_text(encoding="utf-8"))
        s30 = led["summary"].get("30", {})
        verdict.update(
            slug=slug, cards=len(led["ledger"]),
            hit30=s30.get("hit_rate"), net30=s30.get("net_margin"),
            bt_hit=bt["sheet20"]["hit_rate"], bt_null=bt["null_reversion"],
            bt_p=bt["p_value"],
            bt_edge=bt["sheet20"]["hit_rate"] - bt["null_reversion"],
        )
        print(f"      done: {verdict['cards']} cards, April "
              f"{verdict['hit30'] or 0:.1f}%, backtest {verdict['bt_hit']:.1f}%")
        verdicts.append(verdict)

    (out / "cohort.json").write_text(json.dumps(verdicts, indent=1, default=str),
                                     encoding="utf-8")
    done = [v for v in verdicts if v["ok"]]
    print(f"\n{'=' * 78}")
    print(f"  {len(done)} of {len(verdicts)} stores backtested")
    print(f"{'=' * 78}")
    for v in verdicts:
        if v["ok"]:
            print(f"  {v['name'][:38]:>38}  {v['cards']:>4} cards  "
                  f"April {v['hit30'] or 0:>5.1f}%  backtest {v['bt_hit']:>5.1f}%")
        else:
            print(f"  {v['name'][:38]:>38}  -- {v['reason']}")
    print(f"\n  wrote {out / 'cohort.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
