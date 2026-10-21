"""CLI entrypoint: run the nightly Inventory Intelligence briefing for a store.

    python -m storeagent.runtime.run                 # pilot store, no persist
    python -m storeagent.runtime.run --store 10 --persist
    python -m storeagent.runtime.run --json          # full structured output
"""
from __future__ import annotations

import argparse
import json
import sys

from ..config import (PILOT_CLIENT_ID, PILOT_CUSTOMER_CLIENT_ID)
from .pipeline import (run_basket, run_buying, run_customer_radar, run_loss,
                       run_loss_prevention, run_market, run_overview, run_pricing,
                       run_shrinkage, run_store)

# Avoid Windows cp1252 mojibake on any unicode in product names.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def main() -> None:
    ap = argparse.ArgumentParser(description="StoreAgent decision briefings")
    ap.add_argument("--capability",
                    choices=["overview", "inventory", "pricing", "buying", "basket",
                             "customers", "loss", "shrinkage", "lossprev", "market"],
                    default="inventory", help="which briefing to run")
    ap.add_argument("--store", type=int, default=None,
                    help="client_id (defaults to the capability's pilot store)")
    ap.add_argument("--location", type=int, default=None, help="location_id (defaults to client_id)")
    ap.add_argument("--persist", action="store_true", help="write run to the app database")
    ap.add_argument("--narrate", action="store_true",
                    help="add an AI-narrated summary over the same numbers")
    ap.add_argument("--json", action="store_true", help="print full JSON instead of the briefing")
    args = ap.parse_args()

    default_store = PILOT_CUSTOMER_CLIENT_ID if args.capability == "customers" else PILOT_CLIENT_ID
    store = args.store or default_store
    location = args.location if args.location is not None else store

    if args.capability == "customers":
        result = run_customer_radar(store, location, narrate=args.narrate)
    elif args.capability == "buying":
        result = run_buying(store, location, narrate=args.narrate)
    elif args.capability == "loss":
        result = run_loss(store, location, narrate=args.narrate)
    elif args.capability == "lossprev":
        result = run_loss_prevention(store, location, narrate=args.narrate)
    elif args.capability == "pricing":
        result = run_pricing(store, location, narrate=args.narrate)
    elif args.capability == "basket":
        result = run_basket(store, location, narrate=args.narrate)
    elif args.capability == "overview":
        result = run_overview(store, location, narrate=args.narrate)
    elif args.capability == "shrinkage":
        result = run_shrinkage(store, location, narrate=args.narrate)
    elif args.capability == "market":
        result = run_market(store, location, narrate=args.narrate)
    else:
        result = run_store(store, location, persist=args.persist, narrate=args.narrate)

    if args.json:
        print(json.dumps({k: v for k, v in result.items() if k != "briefing"},
                         indent=2, default=str))
    else:
        nar = result.get("narration")
        if nar and nar.get("available"):
            print("-" * 66)
            print(" STOREAGENT AI")
            print("-" * 66)
            print(nar["text"])
            print()
        elif nar and not nar.get("available"):
            print("[AI narration is off]\n")
        print(result["briefing"])


if __name__ == "__main__":
    main()
