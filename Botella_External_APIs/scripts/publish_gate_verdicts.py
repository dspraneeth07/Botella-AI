#!/usr/bin/env python
"""Publish each store's gate verdict so the SERVING path can read it.

    python scripts/publish_gate_verdicts.py --stores ../audit/all_stores.json \
        --month 2026-03 --node http://localhost:3000 [--dry-run]

THIS IS THE LAST LINK IN THE GATE
    The verdict has been computed for weeks and published on an audit page, while
    the engine it was a verdict ABOUT had no way of reading it. `_gates.py` moved
    into `app/pipeline/gate/store.py` so production could import the rule; this
    script carries the measured INPUTS across so there is something to apply it
    to.

    Without it every live card reads `gate_state: shadow` with
    `gate_measured: false`, which is correct - an unmeasured store is an absence -
    but it means the gate has no effect. This is what gives it one.

THE SPLIT, AND WHY IT IS NOT NEGOTIABLE
    A store's expected calibration error, interval coverage and monthly net margin
    are aggregates over accumulated outcomes. That is batch work over a month of
    ledger and far too slow for a page load, so:

        measured here, offline, from all_stores.json
        stored by Node, which is the only writer of bottleai_analytics
        read on the request path, one row, by primary key

    Python holds no analytics credentials and opens no database connection. It
    POSTs to Node, which owns the table. That constraint is the reason this is a
    script talking to an API rather than an INSERT.

IT PUBLISHES FAILURES LOUDLY
    A store that fails is written with its state, its reason and every input that
    produced it. "DO NOT SHIP" with no numbers is the kind of refusal nobody can
    act on, and the columns exist so "why is this store dark" is answerable without
    re-running a month of ledger.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from app.pipeline.gate.store import (  # noqa: E402
    VERDICT_VALID_DAYS,
    serving_decision,
)

#: Seconds. A verdict publish that hangs must not hold a nightly batch open.
_TIMEOUT = 20


def verdict_payload(store: dict[str, Any], month: str) -> dict[str, Any]:
    """The row Node will store, built by the SAME rule the serving path applies.

    `serving_decision` is imported rather than reimplemented. Two implementations
    of one rule is how an estate ends up with two answers, and the gate is the
    last place that should disagree with itself.
    """
    decision = serving_decision(store)
    # The last day of the month this verdict measured. A month is only
    # judgeable once it has 120 days of outcomes behind it, so this is routinely
    # four months before today - which is the point of recording it separately
    # from `evaluated_at`.
    year, mon = (int(p) for p in month.split("-")[:2])
    as_of = (date(year + (mon == 12), 1 if mon == 12 else mon + 1, 1)
             - timedelta(days=1))
    return {
        "state": str(decision.state),
        "reason": decision.reason,
        "measured": decision.measured,
        "displayed": decision.displayed,
        # Every measured input, so the verdict can be argued with. None stays
        # None - an unmeasured input is an absence, never a zero.
        "promise_fill_ratio": store.get("promise_fill_ratio"),
        "ece_points": store.get("ece"),
        "worst_bin_points": store.get("worst_bin_deviation"),
        "interval_coverage": store.get("interval_coverage"),
        "net_margin_month": store.get("net30"),
        "backtest_edge": store.get("bt_edge"),
        "backtest_p_value": store.get("bt_p"),
        # Denominators. A rate without its sample size cannot be told from noise,
        # and a store once failed a coverage check by 0.05 standard errors for
        # want of one.
        "cards": store.get("cards"),
        "priced_cards": store.get("money_cards30"),
        "calibration_scored": store.get("calibration_scored"),
        "calibration_fitted": store.get("calibration_fitted"),
        "interval_considered": store.get("interval_considered"),
        "measured_for_month": month,
        # WHEN THIS VERDICT STOPS BEING TRUE (migration 033).
        #
        # `verdict_as_of` is the day it SPEAKS FOR - the end of the month it
        # measured - not the day it is written. A month needs 120 days of
        # outcomes behind it, so a June verdict is routinely published in
        # November, and stamping it with today would make every verdict look
        # fresh forever.
        #
        # `valid_until` is computed HERE and stored, rather than left for each
        # reader to derive from a TTL. The serving path and the audit page have
        # to compare the same date; two readers each applying their own window
        # is precisely how they come to disagree about one store.
        "verdict_as_of": as_of.isoformat(),
        "valid_until": (as_of + timedelta(days=VERDICT_VALID_DAYS)).isoformat(),
        # The staleness of the curve UNDER this verdict. `gate/store.py` already
        # lets these change the decision - a stale curve withholds the
        # calibration check and rewrites the reason it prints - and neither was
        # ever sent, so the audit page knew the verdict was made against a stale
        # curve and the serving path did not.
        #
        # `.get` with no default, so an input nobody supplied arrives as None:
        # "we were not told" is not "the curve was fine".
        "calibration_is_stale": store.get("calibration_is_stale"),
        "calibration_staleness_detail": store.get("calibration_staleness_detail"),
    }


def put_verdict(base: str, client_id: int, location_id: int,
                payload: dict[str, Any], token: str | None) -> tuple[bool, str]:
    """PUT one verdict. Returns (ok, detail); never raises."""
    url = (f"{base.rstrip('/')}/api/clients/{client_id}"
           f"/locations/{location_id}/gate-verdict")
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="PUT")
    request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            return True, f"HTTP {response.status}"
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}: {exc.read()[:200].decode(errors='replace')}"
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return False, f"{type(exc).__name__}: {exc}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stores", required=True,
                    help="all_stores.json from run_all_ledgers.py")
    ap.add_argument("--month", required=True, help="YYYY-MM the inputs cover")
    ap.add_argument("--node", default="http://localhost:3000")
    ap.add_argument("--token", default=None,
                    help="NODE_API_TOKEN, when the service token is enabled")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would be published and write nothing")
    args = ap.parse_args()

    stores = json.loads(Path(args.stores).read_text(encoding="utf-8"))
    print(f"{len(stores)} store(s) from {args.stores}\n")
    print(f"{'store':<30}{'state':>9}{'shown':>7}{'measured':>10}  reason")
    print("-" * 92)

    failures = 0
    for store in sorted(stores, key=lambda s: str(s.get("loc"))):
        loc = int(store["loc"])
        payload = verdict_payload(store, args.month)
        label = f"{loc} {str(store.get('name', ''))[:24]}"
        print(f"{label:<30}{payload['state']:>9}"
              f"{str(payload['displayed']):>7}{str(payload['measured']):>10}  "
              f"{payload['reason'][:44]}")
        if args.dry_run:
            continue
        # client_id and location_id are the same value in this estate's data, and
        # the route reads both from its own tenant resolution anyway.
        ok, detail = put_verdict(args.node, loc, loc, payload, args.token)
        if not ok:
            failures += 1
            print(f"{'':<30}  PUBLISH FAILED: {detail}")

    print("-" * 92)
    live = sum(1 for s in stores if verdict_payload(s, args.month)["displayed"])
    print(f"\n  {live} of {len(stores)} store(s) may display cards")
    if args.dry_run:
        print("  dry run - nothing written")
        return 0
    if failures:
        print(f"  {failures} publish(es) FAILED - those stores keep their old "
              f"verdict, which is safer than a half-written one")
        return 1
    print("  published")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
