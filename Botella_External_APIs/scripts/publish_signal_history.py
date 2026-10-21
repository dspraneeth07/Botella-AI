#!/usr/bin/env python
"""Backfill the signal history that every signal estimate depends on.

    python scripts/publish_signal_history.py --stores 171,176,177,178,181 \
        --from 2024-01-01 --to 2026-10-06 [--dry-run]

WHY NOTHING IN THE SIGNAL LAYER WORKS WITHOUT THIS
    `elasticity/signal.py` fits

        ln(units + 1) = alpha + beta*signal_active + dow + month + trend + e

    and `signal_active` has to come from a RECORD of what was active on each past
    date. The engine has twenty signal modules and, until now, no history of any of
    them: `signals.active_keys` is computed for the current request and discarded.

    So the cold-box and pre-stock families, which correctly refuse to speak without
    a measured effect, have been silent for want of a table - not for want of a
    signal.

ONLY WHAT IS ARITHMETIC. THE REST NEEDS CAPTURE.
    Holidays, pre-holiday run-ups, paydays and weekdays are functions of the
    calendar and can be reconstructed exactly. Weather and news cannot: a past
    advisory is not recoverable from a date, and `is_reconstructible` refuses them
    by name.

    That distinction is the whole integrity of the exercise. Backfilling a weather
    signal as ABSENT on every past date is not a missing measurement - it is a
    fabricated zero, and an elasticity fitted on it would report "no effect" for a
    signal nobody ever recorded. One key, `severe_weather`, was slipping through
    the prefix list and was caught by auditing every key the signal layer can
    actually emit against that list.

STRENGTH IS NULL, AND ORIGIN SAYS 'computed'
    Every key here is a binary "the date falls in this window". A fabricated 1.0
    would later be averaged with a real captured intensity and called measured.
    And `origin` is what stops a backfill being quoted as evidence that capture was
    running - a holiday reconstructed from a calendar is a different kind of fact
    from a temperature somebody wrote down.

APPEND-ONLY AND IDEMPOTENT
    The table enforces append-only with a trigger, and the writer uses
    `ON CONFLICT DO NOTHING`. Re-running this over an overlapping range adds
    nothing: a signal was either active on a date or it was not, and two sources
    agreeing is not two observations.

PYTHON COMPUTES, NODE WRITES
    Python holds no analytics credentials. This POSTs rows to Node, which owns
    `bottleai_analytics` - and `features/signal_backfill.py` is asserted by its own
    test to contain no INSERT, no connect and no psycopg import.
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

from app.pipeline.features.signal_backfill import (  # noqa: E402
    NOT_RECONSTRUCTIBLE,
    backfill_rows,
)

_TIMEOUT = 60
#: Rows per request. The writer batches internally too; this bounds the payload.
_CHUNK = 4000


def _post(url: str, rows: list[dict[str, Any]],
          token: str | None) -> tuple[bool, str, int]:
    body = json.dumps({"rows": rows}).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8"))
            data = payload.get("data") or {}
            return True, f"HTTP {response.status}", int(data.get("inserted", 0))
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}: {exc.read()[:200].decode(errors='replace')}", 0
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return False, f"{type(exc).__name__}: {exc}", 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stores", required=True, help="comma-separated location ids")
    ap.add_argument("--from", dest="start", required=True, help="YYYY-MM-DD")
    ap.add_argument("--to", dest="end", required=True, help="YYYY-MM-DD")
    ap.add_argument("--node", default="http://localhost:3000")
    ap.add_argument("--token", default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    if end < start:
        print("  --to is before --from")
        return 1
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    locations = [int(x.strip()) for x in args.stores.split(",") if x.strip()]

    print(f"{len(days)} days, {start} to {end}, {len(locations)} store(s)")
    print(f"NOT backfilled - these need live capture and then a season of waiting:")
    for key, why in sorted(NOT_RECONSTRUCTIBLE.items()):
        print(f"    {key:<18} {why}")
    print()
    print(f"{'store':>7}{'rows':>8}{'inserted':>10}  keys")
    print("-" * 72)

    base = args.node.rstrip("/")
    failures = 0
    for loc in locations:
        rows = backfill_rows(days, client_id=loc, location_id=loc)
        keys = sorted({r["signal_key"] for r in rows})
        summary = f"{len(keys)} distinct"
        if args.dry_run:
            print(f"{loc:>7}{len(rows):>8}{'-':>10}  {summary}")
            continue
        url = (f"{base}/api/clients/{loc}/locations/{loc}/signal-history")
        inserted = 0
        ok = True
        for i in range(0, len(rows), _CHUNK):
            good, detail, n = _post(url, rows[i:i + _CHUNK], args.token)
            inserted += n
            if not good:
                ok = False
                print(f"{loc:>7}  WRITE FAILED: {detail}")
                break
        if not ok:
            failures += 1
            continue
        print(f"{loc:>7}{len(rows):>8}{inserted:>10}  {summary}")

    print("-" * 72)
    if args.dry_run:
        print("  dry run - nothing written")
        return 0
    if failures:
        print(f"  {failures} store(s) failed")
        return 1
    print("  written. `inserted` below `rows` on a re-run is correct: the table is")
    print("  append-only and a date that already had a signal is not a second one.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
