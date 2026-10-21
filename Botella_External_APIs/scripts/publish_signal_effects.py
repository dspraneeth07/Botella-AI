#!/usr/bin/env python
"""Fit the effect of every signal on every drink family, and publish it.

    python scripts/publish_signal_effects.py --stores 171,176,177,178,181 \
        --data ../audit/data [--dry-run]

WHY THIS SCRIPT HAS TO EXIST
    `cold_box` and `pre_stock` refuse to speak without a measured effect, which is
    right: a festival is SCHEDULED for a weekend that was going to be busy anyway,
    so the naive version credits the signal for the weekend. The confound runs
    TOWARD finding an effect, which is the dangerous direction.

    The measurement itself has existed for a while in `elasticity/signal.py`. What
    did not exist was anywhere to put the answer. No table, no endpoint, nothing in
    `app/recommender` that read one. So the two families returned nothing at every
    store, forever, and the engine gathered five to thirteen live signals a day and
    cited none of them on any card.

WHAT IT FITS
        ln(units + 1) = alpha + beta*signal_active + dow + month + trend + e

    per (store, signal key, drink FAMILY). The family and not the POS category
    string: a per-category fit splits one product line across half a dozen
    spellings - "VODKA", "Vodka", "VODKA 80", "FLAVORED VODKA" - and then refuses
    all of them for too few active days.

EVERY CELL IS PUBLISHED, INCLUDING THE REFUSALS
    This is the part that matters for anyone reading it later. The first
    estate-wide fit refused 499 of 504 cells, and those refusals are the answer to
    the question an owner asks the moment a card does NOT mention tonight's game.
    A table holding only the five that earned a beta cannot say "we looked at
    sports and the data cannot tell", which is a finding, not a gap.

A DELIBERATE PLACEBO IS FITTED TOO
    `--placebo` adds a `probe_friday` key - active on Fridays, meaning nothing.
    It must refuse. If it earns a beta, the controls are not working and every
    other number here is suspect. It is the cheapest possible check that this
    script is measuring anything at all.

PYTHON COMPUTES, NODE WRITES
    Same contract as every other publisher here: this process holds no analytics
    credentials and PUTs through the integration route, which is the sole writer.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from app.pipeline.context import RunContext  # noqa: E402
from app.pipeline.elasticity.signal import (  # noqa: E402
    SignalEffectRequest,
    SignalObservation,
    estimate_signal_effect,
)
from app.pipeline.features.signal_backfill import backfill_rows  # noqa: E402
from app.pipeline.features.taxonomy import category_family_of  # noqa: E402

#: The placebo, and it is not invented for this script: `backfill_rows` already
#: emits `friday` as a signal key. A Friday is a real thing that happens and has no
#: business carrying a demand effect ONCE day-of-week is controlled for - which is
#: exactly what the design matrix controls for. So if this key earns a citable
#: beta, the day-of-week control is not working and every other number from this
#: run is suspect. Using the key the system already emits is better than a
#: synthetic probe: it tests the real path.
PLACEBO_KEY = "friday"

#: How far back the signal-history route will answer, in days. Node clamps the
#: `days` query to SALES_DAYS_MAX in `services/integrationService.js`, and this
#: mirrors that ceiling rather than discovering it: a request for more comes back
#: silently truncated, and the fit would then attribute "no row" to "inactive"
#: on days that were simply not served. Calendar keys are unaffected (they are
#: regenerated over the whole sales span); archived and captured keys are fitted
#: on at most this window, and the span actually served is printed per store.
HISTORY_DAYS_SERVED = 365


def store_ids(raw: str) -> list[int]:
    return [int(p.strip()) for p in raw.split(",") if p.strip()]


def active_by_key(
    days: list[date], loc: int, *, node: str, token: str | None,
) -> tuple[dict[str, set[date]], set[str]]:
    """{signal_key: dates it was active}, READ FROM `signal_history`.

    THE TABLE, NOT A RECONSTRUCTION. The first version of this sourced the dates
    from `backfill_rows`, which emits only the 35 reconstructible calendar keys -
    so the 1,550 ARCHIVED weather days already in the table (1,450 heat_advisory,
    100 cold_snap) were never fitted and weather got no verdict either way.

    It is also the only way this can ever see a CAPTURED key. The run now records
    what it observed each morning, so home fixtures, concerts and social trends
    will accumulate rows - and a fitter that re-derives the calendar would never
    look at one of them, however long they accumulated.

    Falls back to `backfill_rows` when the history cannot be read, which keeps the
    calendar keys fittable on a machine with no Node running. The fallback is
    announced, because silently fitting a third of the keys and reporting the rest
    as refusals would be the same bug wearing different clothes.
    """
    url = f"{node.rstrip('/')}/api/clients/{loc}/locations/{loc}/signal-history"
    # `days`, not `limit`. The route reads `days` and clamps it to Node's
    # SALES_DAYS_MAX (365); the `limit` the first version sent was never read,
    # so the request silently got the default and nobody could tell from the
    # output how far back the history it fitted actually reached. Asking for
    # exactly the ceiling and PRINTING the span that came back is the honest
    # form of the same request: a key whose archive runs to 2023 is fitted on
    # its last year here, and the reader of this log should know that.
    req = urllib.request.Request(f"{url}?days={HISTORY_DAYS_SERVED}")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    out: dict[str, set[date]] = defaultdict(set)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            rows = json.loads(resp.read().decode("utf-8")).get("data") or []
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"      signal_history unreadable ({exc}); falling back to the "
              f"CALENDAR KEYS ONLY - weather and captured signals will be absent")
        for row in backfill_rows(days, client_id=loc, location_id=loc):
            out[row["signal_key"]].add(date.fromisoformat(row["as_of"]))
        return dict(out), set(out)

    span = set(days)
    served = sorted({str(r.get("as_of") or "")[:10] for r in rows if r.get("as_of")})
    print(f"      signal_history: {len(rows)} rows"
          + (f" spanning {served[0]}..{served[-1]}" if served else " (empty)")
          + f" (route serves at most {HISTORY_DAYS_SERVED} days)")
    for row in rows:
        key = (row.get("signal_key") or "").strip()
        raw = row.get("as_of")
        if not key or not raw:
            continue
        try:
            day = date.fromisoformat(str(raw)[:10])
        except ValueError:
            continue
        # Only days the store traded. A signal active on a day the shop was shut
        # is not an observation about how the store responds to it, and including
        # it would put a zero in the series for a day that could not have sold
        # anything.
        if day in span:
            out[key].add(day)

    # ── CALENDAR KEYS ARE REGENERATED OVER THE WHOLE SPAN ─────────────────
    #
    # Two kinds of key live in this table and they have different coverage rules,
    # which is the distinction the first two attempts at this both missed.
    #
    #   a key `backfill_rows` EMITS is exact arithmetic on a date. A Friday in
    #   2023 was a Friday whether or not anybody wrote it down, so regenerating it
    #   across the full sales series fabricates nothing - and NOT regenerating it
    #   is what marked 53 of Cork Runner's Fridays as not-Fridays and let the
    #   placebo earn an effect.
    #
    #   every other key - archived weather, captured fixtures, trends - exists
    #   only where it was recorded. Outside that window there is no fact, and the
    #   caller restricts the fit to it.
    #
    # Note that `is_reconstructible` is the WRONG test here: it is a prefix
    # refusal list that happens not to name sports or trends, so it calls
    # `nfl_home_game` reconstructible when nothing can reconstruct one. What
    # matters is what the calendar module actually produces.
    regenerated: dict[str, set[date]] = defaultdict(set)
    for row in backfill_rows(days, client_id=loc, location_id=loc):
        regenerated[row["signal_key"]].add(date.fromisoformat(row["as_of"]))
    for key, dates in regenerated.items():
        out[key] = dates
    return dict(out), set(regenerated)


def coverage_window(
    active: set[date], days: list[date],
) -> tuple[date, date] | None:
    """The days this key's history actually covers, as (first, last).

    ABSENCE OUTSIDE THE WINDOW IS NOT A ZERO, and the placebo caught this. The
    first version fitted every key over the whole sales series and read "no row in
    signal_history" as "the signal was off" - so at Cork Runner, 53 real Fridays in
    2023 were recorded as NOT-Friday, because the backfill starts 2024-01-12 while
    the sales start 2023-01-01. That corrupted the day-of-week control badly enough
    that `friday` earned a citable -0.1236 on wine.

    Which is exactly the failure `publish_signal_history.py` warns about in its own
    docstring: a fabricated zero is not a missing measurement, and an elasticity
    fitted on one reports a finding about a signal nobody recorded.

    So each key is fitted ONLY between its first and last observation. Inside that
    span an absent day is genuinely inactive; outside it there is no record at all
    and the day cannot be used.
    """
    if not active:
        return None
    return min(active), max(active)


def fit_store(store, loc: int, *, args_placebo: bool,
              node: str, token: str | None) -> list[dict]:
    """One row per (signal key, drink family) cell, refusals included."""
    days = store.trading_days
    if not days:
        return []
    as_of = days[-1]
    ctx = RunContext(
        run_id=f"signal-effects-{loc}-{as_of}", tenant_id=loc, store_id=loc,
        as_of=as_of, snapshot_id=f"snap-{as_of}", config_version="default",
        seed=0, versions={"elasticity_signal": "1.0.0"},
    )

    # Units per (family, day). The family, not the raw category - see the module
    # docstring on why a per-category fit refuses everything.
    by_family: dict[str, dict[date, float]] = defaultdict(lambda: defaultdict(float))
    for sku, series in store.daily.items():
        family = category_family_of(store.category.get(sku))
        if family is None:
            continue
        for day, units in series.items():
            by_family[family][day] += units
    if not by_family:
        return []

    active_dates, calendar_keys = active_by_key(days, loc, node=node, token=token)
    if not args_placebo:
        active_dates.pop(PLACEBO_KEY, None)

    rows: list[dict] = []
    for key, active in sorted(active_dates.items()):
        if not active:
            continue
        if key in calendar_keys:
            # Exact arithmetic on a date: the whole series is known.
            fit_days = days
        else:
            window = coverage_window(active, days)
            if window is None:
                continue
            first, last = window
            # Only the days this key's history covers. Outside the window there is
            # no record, and a fabricated "inactive" there is what let the placebo
            # earn an effect.
            fit_days = [d for d in days if first <= d <= last]
        if not fit_days:
            continue
        for family, series in sorted(by_family.items()):
            obs = [SignalObservation(obs_date=d,
                                     units=float(series.get(d, 0.0)),
                                     signal_active=(d in active))
                   for d in fit_days]
            result = estimate_signal_effect(
                SignalEffectRequest(signal_key=key, category=family,
                                    observations=obs), ctx).value
            if result is None:
                continue
            interval = result.interval
            rows.append({
                "signal_key": key,
                "category_family": family,
                "beta": result.beta,
                "own_beta": result.own_beta,
                "interval_lo": None if interval is None else interval.low,
                "interval_hi": None if interval is None else interval.high,
                "own_weight": result.own_weight,
                "observations": result.observations,
                "active_days": result.active_days,
                "refused_reason": result.refused_reason,
                "basis": result.basis,
                "fit_from": days[0].isoformat(),
                "fit_to": as_of.isoformat(),
            })
    return rows


def put(node: str, loc: int, rows: list[dict], token: str | None) -> int:
    url = f"{node.rstrip('/')}/api/clients/{loc}/locations/{loc}/signal-effects"
    body = json.dumps({"effects": rows}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="PUT")
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    return int((payload.get("data") or {}).get("written") or 0)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stores", required=True, help="comma separated location ids")
    ap.add_argument("--data", required=True, help="folder holding the .csv.gz")
    ap.add_argument("--node", default="http://localhost:3000")
    ap.add_argument("--token", default=None)
    ap.add_argument("--placebo", action="store_true", default=True,
                    help="fit the `friday` key, which MUST refuse (default on)")
    ap.add_argument("--no-placebo", dest="placebo", action="store_false")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    from scripts.real_engine_backtest import load  # noqa: PLC0415 - heavy import

    total_usable = total_cells = 0
    placebo_usable: list[str] = []
    for loc in store_ids(args.stores):
        path = Path(args.data) / f"store_{loc}_sale_items.csv.gz"
        if not path.exists():
            print(f"  {loc}: export missing, skipped")
            continue
        store = load(str(Path(args.data)), path.name)
        rows = fit_store(store, loc, args_placebo=args.placebo,
                         node=args.node, token=args.token)
        usable = [r for r in rows
                  if r["refused_reason"] is None and r["beta"] is not None
                  and r["interval_lo"] is not None
                  and not (r["interval_lo"] <= 0.0 <= r["interval_hi"])]
        total_cells += len(rows)
        total_usable += len(usable)
        placebo_usable += [f"{loc}:{r['category_family']}" for r in usable
                           if r["signal_key"] == PLACEBO_KEY]
        print(f"  {loc}: {len(rows)} cells, {len(usable)} usable")
        for r in sorted(usable, key=lambda x: -abs(x["beta"]))[:6]:
            print(f"        {r['signal_key']:>26} x {r['category_family']:<8} "
                  f"beta {r['beta']:+.4f} "
                  f"[{r['interval_lo']:+.4f}, {r['interval_hi']:+.4f}] "
                  f"n={r['observations']}")
        if not args.dry_run:
            written = put(args.node, loc, rows, args.token)
            print(f"        published {written} rows")

    print(f"\n  {total_usable} usable of {total_cells} cells")
    # THE PLACEBO IS A HARD FAILURE. If a Friday probe earns a citable effect, the
    # day-of-week control is not working and every other number here is suspect.
    if placebo_usable:
        print(f"\n  PLACEBO EARNED AN EFFECT at {placebo_usable} - the "
              f"day-of-week control is not working and these fits cannot be "
              f"trusted. Nothing should be published from this run.")
        return 1
    if args.placebo:
        print("  placebo refused everywhere, as it must")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
