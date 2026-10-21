#!/usr/bin/env python
"""The DECISION backtest (hit rate) on shortened windows, for a young store.

    python scripts/short_window_decisions.py --data ../audit/tuscany/data \
        --file store_173_sale_items.csv.gz --store "Tuscany Liquors" \
        --history 40 --horizons 10,20,30 --every 3 --out run/

SAME CAVEAT AS short_window_backtest.py, AND IT MATTERS MORE HERE.
`real_engine_backtest.py` is the production measurement and it refuses a store
with under 492 days of span. This runs the same production modules through the
same decision path, with only the two WINDOW bounds shortened:

    decision_dates' 370-day history requirement -> --history
    HORIZONS (30, 60, 90, 120)                  -> --horizons

Nothing about the engine is changed. But a hit rate computed against a 40-day
history is answering a materially easier question than one computed against a
year, because the engine's long-run reference and its recent window then
overlap. The number below is NOT comparable to the 75.7% quoted for Bethany,
and the report says so wherever it appears.

The production script is left untouched. Its figures are in print.
"""

from __future__ import annotations

import argparse
import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts import real_engine_backtest as reb  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True)
    ap.add_argument("--file", required=True)
    ap.add_argument("--store", default="the store")
    ap.add_argument("--history", type=int, default=40,
                    help="days of history required behind a decision date "
                         "(production: 370)")
    ap.add_argument("--horizons", default="10,20,30",
                    help="outcome horizons (production: 30,60,90,120)")
    ap.add_argument("--every", type=int, default=3)
    ap.add_argument("--out", default="run_short_decisions")
    args = ap.parse_args(argv)

    horizons = tuple(int(x) for x in args.horizons.split(",") if x.strip())
    prod_horizons = reb.HORIZONS
    reb.HORIZONS = horizons

    history = args.history

    def shortened(store, every: int = 14):
        """decision_dates with the history bound replaced.

        Deliberately a replacement rather than an edit to the original: the
        original's 370 is tied to the engine's 365-day long-run window and is
        correct for every store that can support it.
        """
        first = store.trading_days[0] + timedelta(days=history + 5)
        last = store.trading_days[-1] - timedelta(days=max(horizons) + 2)
        usable = [d for d in store.trading_days if first <= d <= last]
        if not usable:
            raise SystemExit(
                f"even the reduced window does not fit: needs "
                f"{history + 5 + max(horizons) + 2} days of span")
        return usable[::max(1, every)]

    reb.decision_dates = shortened

    print(f"REDUCED WINDOWS: history={history}d (production 370), "
          f"horizons={list(horizons)} (production {list(prod_horizons)})")
    print("This hit rate is NOT comparable to a production figure.\n")

    return reb.main(["--data", args.data, "--file", args.file,
                     "--store", args.store, "--out", args.out,
                     "--every", str(args.every)])


if __name__ == "__main__":
    raise SystemExit(main())
