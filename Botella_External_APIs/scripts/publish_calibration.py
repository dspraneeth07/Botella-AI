#!/usr/bin/env python
"""Fit the confidence curve from scored outcomes and publish it for SERVING.

    python scripts/publish_calibration.py --stores 171,176,177,178,181 \
        --node http://localhost:3000 [--dry-run]

THE LAST LINK IN STAGE 8
    `calibrate/fit.py` could always fit a curve and `calibrate/apply.py` could
    always apply one. Nothing could STORE one, so every curve the harness fitted
    was discarded at the end of the run and production shipped the raw ranking
    score. This script fits from the outcomes Node has accumulated and PUTs the
    bundle back, which is what finally connects the two halves.

WHAT IT MEASURED, AND WHY IT MATTERS TO AN OWNER
    On the first 58 scored production outcomes the raw score states 0.85-0.97 and
    the fitted curve maps every one of those to 0.651. An owner reading "0.95
    confidence" was reading a number that is right about two thirds of the time.
    Either state the calibrated figure or state none - and the card currently
    states none, with a disclaimer, which was the honest interim answer.

THE FALLBACK CHAIN DOES THE RATIONING, NOT THIS SCRIPT
    Per-family cells need 50 outcomes each and the estate has 4 to 11, so only the
    pooled global rung can fit today. That is NOT a reason to wait: `cell_for`
    walks leaf, then parent, then global, and NAMES the rung it landed on. A global
    curve applied to a `reorder` card is a weaker claim than a `reorder` curve, and
    the card says which it got.

    So this publishes whatever can be fitted and lets the chain ration it. As
    outcomes accumulate the same script starts producing leaf cells with no change
    here.

PYTHON HOLDS NO ANALYTICS CREDENTIALS
    It reads outcomes from a Node endpoint and PUTs the bundle to another. Node is
    the only writer of `bottleai_analytics`, which is why this is a script talking
    to an API rather than two SQL statements.

A THIN CURVE IS PUBLISHED WITH ITS THINNESS, NOT WITHHELD
    `outcomes_fitted`, `cells_fitted`, `cells_skipped` and `rungs` travel with the
    bundle. A curve fitted on 58 outcomes is a real curve and much better than a
    raw score 20 points out, but it is not the same claim as one fitted on 600, and
    the difference must not have to be inferred.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from app.pipeline.calibrate.fit import (  # noqa: E402
    ANY,
    FitRequest,
    Outcome,
    fit_calibration,
)
from app.pipeline.context import RunContext  # noqa: E402

_TIMEOUT = 30


def _get(url: str, token: str | None) -> Any:
    request = urllib.request.Request(url, method="GET")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
        return json.loads(response.read().decode("utf-8"))


def _put(url: str, payload: dict[str, Any], token: str | None) -> tuple[bool, str]:
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), method="PUT")
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


def ctx_for(store_id: int) -> RunContext:
    return RunContext(
        run_id=f"calibration-fit-{store_id}", tenant_id=1, store_id=store_id,
        as_of=date.today(), snapshot_id=f"cal-{store_id}",
        config_version="default", seed=0,
        versions={"calibrate_fit": "1.0.0"},
    )


def outcomes_from(rows: list[dict[str, Any]]) -> list[Outcome]:
    """Node rows into fitter inputs.

    The demand class and velocity band are ANY, because production does not record
    either on a recommendation. Addressing a narrower cell whose key was never
    written would land on the global curve anyway while claiming to be specific -
    stating the rung honestly is the same behaviour without the false precision.
    """
    out: list[Outcome] = []
    for row in rows:
        confidence = row.get("stated_confidence")
        if confidence is None:
            continue
        out.append(Outcome(
            family=str(row.get("family") or "reorder"),
            demand_class=ANY,
            stated_confidence=min(1.0, max(0.0, float(confidence))),
            hit=bool(row.get("hit")),
            velocity_band=ANY,
        ))
    return out


def _publish_pooled(base: str, locations: list[int], args: Any) -> int:
    """One curve from every store's outcomes, published to each, labelled.

    WHY INHERITING IS LEGITIMATE HERE AND NOT A SHORTCUT
        This is sheet 05's cohort ladder - state, then region, then national -
        applied to calibration instead of to a rate. Its justification is the same:
        a store with too little of its own evidence is not left with a raw ranking
        score for a quarter, and is not trusted on zero evidence either, so WHICH
        it is must be visible. Migration 019 carries an `inherited` column for
        exactly this reason.

        The measured need is concrete: the estate has 58 scored outcomes and 35 of
        them sit at one store, so no store clears the 50-outcome floor alone while
        the pool clears it comfortably.

    WHAT AN INHERITED CURVE IS NOT
        It is not a claim about this store. It is a claim about the estate, applied
        here because the alternative is a raw score measured 20 points out. The
        bundle's `rungs` says `global(inherited)` and the gate's staleness check
        still measures this store's own drift against it - so an inherited curve
        that does not fit this store is caught rather than trusted.
    """
    pooled: list[Outcome] = []
    per_store: dict[int, int] = {}
    engines: set[str] = set()
    for loc in locations:
        url = (f"{base}/api/clients/{loc}/locations/{loc}"
               f"/scored-outcomes?window={args.window}")
        try:
            payload = _get(url, args.token)
        except (urllib.error.HTTPError, urllib.error.URLError, OSError) as exc:
            print(f"{loc:>7}  could not read outcomes: {exc}")
            continue
        rows = payload.get("data") if isinstance(payload, dict) else payload
        got = outcomes_from(rows or [])
        per_store[loc] = len(got)
        pooled.extend(got)
        # Node filters each store's outcomes to the engine serving THAT store
        # and names it. Collected so the bundle can be stamped with the engine
        # it is valid for - see the refusal below.
        if isinstance(payload, dict) and got:
            ev = payload.get("engine_version")
            if ev:
                engines.add(str(ev))

    # POOLING ACROSS ENGINES IS NOT ALLOWED, and this is the one place that can
    # see it. Each store's rows are filtered to its own serving engine, so a
    # mid-rollout estate hands back two populations whose raw scores mean
    # different things, and a curve fitted on the union is a transform for a
    # quantity no engine computes. Refusing is the honest answer: every store
    # keeps the curve it has until the rollout finishes.
    if len(engines) > 1:
        print("")
        print(f"  REFUSED: outcomes span {len(engines)} engine versions "
              f"({', '.join(sorted(engines))}).")
        print("  A curve maps a raw ranking score onto a hit rate, so it "
              "belongs to ONE engine.")
        print("  Nothing published; every store keeps its current curve until "
              "the estate is on one version.")
        return 1
    engine_version = next(iter(engines)) if engines else None

    print(f"  pooled {len(pooled)} outcomes from "
          f"{sum(1 for n in per_store.values() if n)} store(s) with any: "
          + ", ".join(f"{loc}:{n}" for loc, n in sorted(per_store.items()) if n))
    result = fit_calibration(FitRequest(outcomes=pooled), ctx_for(0))
    bundle = result.value
    if bundle is None or not bundle.fits:
        skipped = len(bundle.skipped) if bundle else 0
        print(f"\n  the POOL does not clear the floor either "
              f"({len(pooled)} outcomes, {skipped} cells skipped).")
        print("  Nothing published. That is a true statement about the evidence, "
              "and\n  publishing an empty bundle would report a curve that does "
              "nothing as a curve.")
        return 0

    rungs = "global(inherited)"
    body = {
        "version": bundle.version,
        "fitted_at": bundle.fitted_at.isoformat(),
        "bundle": bundle.as_dict(),
        "outcomes_fitted": len(pooled),
        "cells_fitted": len(bundle.fits),
        "cells_skipped": len(bundle.skipped),
        "rungs": rungs,
        # The engine whose raw scores this was fitted against. The recommender
        # refuses to apply a bundle that does not match its own version.
        "engine_version": engine_version,
    }
    print(f"\n  fitted {len(bundle.fits)} cell(s) on {len(pooled)} pooled "
          f"outcomes, version {bundle.version}")
    print(f"  rungs: {rungs} - every store is told this curve is INHERITED\n")
    print(f"  engine: {engine_version or 'UNREPORTED'} - the curve is valid for this engine only")
    if args.dry_run:
        print("  dry run - nothing written")
        return 0
    failures = 0
    for loc in locations:
        ok, detail = _put(
            f"{base}/api/clients/{loc}/locations/{loc}/calibration-bundle",
            body, args.token)
        print(f"    {loc}: {'published' if ok else 'FAILED - ' + detail}")
        failures += 0 if ok else 1
    if failures:
        print(f"\n  {failures} store(s) failed and keep their previous curve")
        return 1
    print("\n  published to every store, labelled inherited")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stores", required=True,
                    help="comma-separated location ids")
    ap.add_argument("--node", default="http://localhost:3000")
    ap.add_argument("--window", type=int, default=30)
    ap.add_argument("--token", default=None)
    ap.add_argument(
        "--pooled", action="store_true",
        help="fit ONE curve across every named store and publish it to all of "
             "them, labelled as inherited. This is sheet 05's cohort ladder "
             "applied to calibration: a store with too few of its own outcomes "
             "inherits rather than being left with a raw score for a quarter. "
             "Measured need: the estate has 58 scored outcomes but 35 of them sit "
             "at one store, so no store clears the 50-outcome floor alone while "
             "the pool clears it comfortably.")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    base = args.node.rstrip("/")
    # Node names a store as "client:location" (server.js builds the list that
    # way for every Python job); older callers pass bare location ids. Both are
    # accepted and the LOCATION is what this script keys on - the pilot stores
    # have client_id == location_id, and the cron has failed on every run since
    # it was written with "invalid literal for int() with base 10: '2:2'".
    locations = [int(x.strip().split(":")[-1]) for x in args.stores.split(",") if x.strip()]
    print(f"{len(locations)} store(s), {args.window}-day outcomes\n")
    print(f"{'store':>7}{'outcomes':>10}{'cells':>7}{'skipped':>9}"
          f"{'rungs':>14}  version")
    print("-" * 78)

    failures = 0

    if args.pooled:
        return _publish_pooled(base, locations, args)

    for loc in locations:
        url = (f"{base}/api/clients/{loc}/locations/{loc}"
               f"/scored-outcomes?window={args.window}")
        try:
            payload = _get(url, args.token)
        except (urllib.error.HTTPError, urllib.error.URLError, OSError) as exc:
            print(f"{loc:>7}  could not read outcomes: {exc}")
            failures += 1
            continue
        rows = payload.get("data") if isinstance(payload, dict) else payload
        outcomes = outcomes_from(rows or [])
        # One store, so one engine: Node has already filtered these rows to the
        # version serving THIS store and named it. Stamped on the bundle so the
        # recommender can refuse a curve fitted against a different engine's
        # raw scores.
        engine_version = (payload.get("engine_version")
                          if isinstance(payload, dict) else None)
        result = fit_calibration(FitRequest(outcomes=outcomes), ctx_for(loc))
        bundle = result.value
        if bundle is None or not bundle.fits:
            # A true statement, not a failure: there is not enough yet. Publishing
            # an empty bundle would be worse than publishing nothing, because
            # `apply` would then report a curve that does nothing as a curve.
            skipped = len(bundle.skipped) if bundle else 0
            print(f"{loc:>7}{len(outcomes):>10}{0:>7}{skipped:>9}"
                  f"{'none':>14}  not enough to fit - nothing published")
            continue

        rungs = ",".join(sorted(
            "global" if key == (ANY, ANY, ANY) else f"{key[0]}/{key[1]}"
            for key in bundle.fits))
        body = {
            "version": bundle.version,
            "engine_version": engine_version,
            "fitted_at": bundle.fitted_at.isoformat(),
            "bundle": bundle.as_dict(),
            "outcomes_fitted": len(outcomes),
            "cells_fitted": len(bundle.fits),
            "cells_skipped": len(bundle.skipped),
            "rungs": rungs,
        }
        print(f"{loc:>7}{len(outcomes):>10}{len(bundle.fits):>7}"
              f"{len(bundle.skipped):>9}{rungs[:14]:>14}  {bundle.version}")
        if args.dry_run:
            continue
        ok, detail = _put(
            f"{base}/api/clients/{loc}/locations/{loc}/calibration-bundle",
            body, args.token)
        if not ok:
            failures += 1
            print(f"{'':>7}  PUBLISH FAILED: {detail}")

    print("-" * 78)
    if args.dry_run:
        print("  dry run - nothing written")
        return 0
    if failures:
        print(f"  {failures} store(s) failed - those keep their previous curve, "
              f"which is safer than a half-written one")
        return 1
    print("  published")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
