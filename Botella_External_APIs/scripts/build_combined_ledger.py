#!/usr/bin/env python
"""One page with every card from every store, built from the per-store ledgers.

    python scripts/build_combined_ledger.py --audit ../audit --month 2026-03

Reads the SAME `ledger.json` files the per-store pages are built from, so a figure
on this page and a figure on those cannot disagree. Run it after
`run_all_ledgers.py`; it computes nothing the ledgers have not already computed.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from scripts._combined_ledger_report import build_combined  # noqa: E402

STORES = [
    (171, "Bethany Discount Liquor", "171"),
    (176, "Northlake Liquors North", "176"),
    (177, "Mango Jo's Bar & Liquors", "177"),
    (178, "Marshfield Wine & Spirits", "178"),
    (181, "Cork Runner Wine & Spirits", "181"),
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--audit", required=True)
    ap.add_argument("--month", default="2026-03")
    ap.add_argument("--out", default=None,
                    help="default: <audit>/ALL_STORES_LEDGER.html")
    args = ap.parse_args()

    audit = Path(args.audit).resolve()
    stores: list[dict] = []
    for loc, name, slug in STORES:
        led_path = audit / f"ledger-{slug}-{args.month}" / "ledger.json"
        bt_path = audit / f"{slug}-backtest" / "summary.json"
        if not led_path.exists():
            print(f"  {loc}: {led_path.name} missing, skipped")
            continue
        led = json.loads(led_path.read_text(encoding="utf-8"))
        bt = (json.loads(bt_path.read_text(encoding="utf-8"))
              if bt_path.exists() else {})
        stores.append({
            "loc": loc, "name": name, "slug": slug,
            "ledger": led["ledger"],
            "summary": led["summary"],
            "retirements": led.get("retirements") or [],
            "trading_days": led["trading_days"],
            # Cost coverage decides whether a money figure is printed at all, and
            # it belongs to the EXPORT rather than to the month - so it is read
            # from the backtest summary, which measures it over the whole file.
            "cost_coverage": float(bt.get("cost_coverage", 1.0)),
            "bt_hit": (bt.get("sheet20") or {}).get("hit_rate", 0.0),
            "bt_null": bt.get("null_reversion", 0.0),
            "bt_p": bt.get("p_value", 1.0),
        })

    if not stores:
        print("no ledgers found - run scripts/run_all_ledgers.py first")
        return 1

    label = datetime.strptime(args.month, "%Y-%m").strftime("%B %Y")
    out = Path(args.out) if args.out else audit / "ALL_STORES_LEDGER.html"
    out.write_text(build_combined(stores, label), encoding="utf-8")
    cards = sum(len(s["ledger"]) for s in stores)
    size = out.stat().st_size / 1024
    print(f"  wrote {out}")
    print(f"  {len(stores)} stores, {cards} cards, {size:,.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
