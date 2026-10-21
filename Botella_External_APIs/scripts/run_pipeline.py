#!/usr/bin/env python
"""Run 04 -> 05 -> 06 on one real store, from an exported feature-store slice.

    node backend/scripts/export-pipeline-input.js 171 171 --top 25 > input.json
    python scripts/run_pipeline.py input.json

The input is a file, not a connection, and that is the point: Python holds no
analytics credentials, every stage sees only what is in the payload, and the
whole run is replayable from it months later.

This prints the estimate AND the arithmetic behind it, because a number a store
owner cannot interrogate is a number they should not act on.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline.assemble import (  # noqa: E402
    EstateInput,
    SkuInput,
    estimate_and_forecast,
    estimate_store,
)
from app.pipeline.context import RunContext  # noqa: E402
from app.pipeline.features.store import CalendarDay, DayFact  # noqa: E402
from app.pipeline.priors import CohortObservation  # noqa: E402


def _date(text: str) -> date:
    return date.fromisoformat(text[:10])


def load(path: Path) -> tuple[EstateInput, list[SkuInput], RunContext]:
    payload = json.loads(path.read_text(encoding="utf-8"))

    calendar = [
        CalendarDay(
            obs_date=_date(c["obs_date"]),
            was_open=bool(c["was_open"]),
            has_data=bool(c["has_data"]),
            open_source=c.get("open_source", "observed"),
        )
        for c in payload["calendar"]
    ]

    facts = [
        DayFact(
            obs_date=_date(f["obs_date"]),
            sku=f["sku"],
            units_sold=f.get("units_sold") or 0.0,
            revenue=f.get("revenue"),
            unit_cost=f.get("unit_cost"),
            on_hand=f.get("on_hand"),
            price=f.get("price"),
            baskets_containing=f.get("baskets_containing"),
            known_at=(
                datetime.fromisoformat(f["known_at"].replace("Z", "+00:00"))
                if f.get("known_at") else None
            ),
        )
        for f in payload["facts"]
    ]

    observations: dict[str, list[CohortObservation]] = {}
    for unit_key, rows in payload["observations"].items():
        observations[unit_key] = [
            CohortObservation(
                store_key=(row["store_key"][0], row["store_key"][1]),
                value=float(row["value"]),
                weight=float(row.get("weight", 1.0)),
            )
            for row in rows
        ]

    store_key = (payload["store_key"][0], payload["store_key"][1])
    estate = EstateInput(
        store_key=store_key,
        subject_state=payload.get("subject_state"),
        calendar=calendar,
        facts=facts,
        candidates=[
            ((c[0][0], c[0][1]), c[1]) for c in payload["candidates"]
        ],
        window_days=int(payload.get("window_days", 364)),
    )

    # Each SKU sees exactly the three rungs that could answer for it: its own
    # sku key, its category, and "*". Handing it every other SKU's
    # observations would not change the answer - the ladder looks up by key -
    # but it would make the recorded input for a replay far larger than the
    # thing it describes.
    skus = [
        SkuInput(
            sku=s["sku"],
            category=s.get("category"),
            own_rate=s.get("own_rate"),
            observations={
                k: v for k, v in observations.items()
                if k in {s["sku"], s.get("category"), "*"}
            },
        )
        for s in payload["skus"]
    ]

    # The snapshot id is the DIGEST OF THE INPUT FILE, not a timestamp. Two
    # runs over the same payload carry the same id and must produce the same
    # answer; a run over changed data carries a different one and is honestly
    # a different run. That is what makes `replay()` mean something.
    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
    ctx = RunContext(
        run_id=f"pipeline-{payload['as_of']}-{store_key[0]}-{store_key[1]}",
        tenant_id=store_key[0],
        store_id=store_key[1],
        as_of=_date(payload["as_of"]),
        snapshot_id=digest,
        config_version="default",
        seed=0,
        versions={"assemble": "1.0.0"},
    )
    return estate, skus, ctx


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--pattern", default="sku_velocity")
    parser.add_argument("--limit", type=int, default=15)
    parser.add_argument("--horizon", type=int, default=30,
                        help="forecast horizon in OPEN days (sheet 07)")
    parser.add_argument("--forecast", action="store_true",
                        help="also run sheet 07: classify + p10/p50/p90")
    args = parser.parse_args(argv)

    estate, skus, ctx = load(args.input)

    open_days = sum(1 for c in estate.calendar if c.was_open and c.has_data)
    print(f"store {estate.store_key}  state={estate.subject_state}  "
          f"as_of={ctx.as_of}")
    print(f"  calendar {len(estate.calendar)} days, {open_days} open and synced")
    print(f"  facts    {len(estate.facts)} rows over {len(skus)} SKUs")
    print(f"  cohort   {len(estate.candidates)} candidate stores")
    print(f"  pattern  {args.pattern}\n")

    estimates = estimate_store(estate, skus, args.pattern, ctx)
    if not estimates:
        print("no estimate produced")
        return 1

    head = (f"{'sku':<16}{'n':>5}{'k':>4}{'own%':>7}{'own':>9}"
            f"{'cohort':>9}{'BLEND':>9}  {'state':<12}{'rung/geo/size'}")
    print(head)
    print("-" * len(head))
    for e in estimates[: args.limit]:
        cohort_tag = (
            f"{e.specificity}/{e.cohort_level}/{e.cohort_size}"
            if e.cohort_size else f"{e.cohort_basis}/{e.specificity}"
        )
        print(f"{e.sku[:15]:<16}{e.n:>5}{e.k:>4}{e.own_weight * 100:>6.0f}%"
              f"{e.theta_own:>9.3f}{e.theta_cohort:>9.3f}{e.value:>9.3f}  "
              f"{e.evidence_state:<12}{cohort_tag}")

    print(f"\n{len(estimates)} of {len(skus)} SKUs estimated")
    print(f"\nexample explanation:\n  {estimates[0].explanation}")

    if args.forecast:
        _print_forecasts(estate, skus, ctx, args)
    return 0


def _open_days_per_week(estate) -> int:
    """Measured, not assumed. A six-day store has a six-open-day week."""
    weekdays = {
        c.obs_date.weekday() for c in estate.calendar if c.was_open and c.has_data
    }
    return max(1, len(weekdays)) if weekdays else 7


def _print_forecasts(estate, skus, ctx, args) -> None:
    """Sheet 07 on top of 04-05-06: shape, then level, then interval."""
    rows = estimate_and_forecast(
        estate, skus, args.pattern, args.horizon, ctx,
        open_days_per_week=_open_days_per_week(estate),
    )
    head = (f"\n{'sku':<16}{'class':<14}{'rate/day':>10}"
            f"{'p10':>9}{'p50':>9}{'p90':>9}  status")
    print(head)
    print("-" * (len(head) - 1))
    for row in rows[: args.limit]:
        rate = f"{row.estimate.value:.3f}" if row.estimate else "-"
        if row.forecast:
            f = row.forecast
            print(f"{row.sku[:15]:<16}{row.demand_class:<14}{rate:>10}"
                  f"{f.p10:>9.1f}{f.p50:>9.1f}{f.p90:>9.1f}  ok")
        else:
            reason = (row.refused_reason or "")[:40]
            print(f"{row.sku[:15]:<16}{row.demand_class:<14}{rate:>10}"
                  f"{'-':>9}{'-':>9}{'-':>9}  {reason}")

    refused = sum(1 for r in rows if r.forecast is None)
    print(f"\n{len(rows) - refused} of {len(rows)} forecast over "
          f"{args.horizon} open days; {refused} refused as unactionable")
    shapes: dict[str, int] = {}
    for row in rows:
        shapes[row.demand_class] = shapes.get(row.demand_class, 0) + 1
    print("demand shapes: " + ", ".join(
        f"{k}={v}" for k, v in sorted(shapes.items(), key=lambda kv: -kv[1])
    ))
    example = next((r for r in rows if r.forecast), None)
    if example:
        print(f"\nexample forecast:\n  {example.forecast.explain()}")


if __name__ == "__main__":
    raise SystemExit(main())
