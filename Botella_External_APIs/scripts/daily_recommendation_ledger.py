#!/usr/bin/env python
"""Every recommendation the engine would have made in a month, and what happened.

    python scripts/daily_recommendation_ledger.py \
        --data ../audit/data --file store_171_sale_items.csv.gz \
        --store "Bethany Discount Liquor" --month 2026-03 --out ../audit/ledger-171-2026-03

HOW THIS DIFFERS FROM THE BACKTEST, AND WHY IT IS A BETTER QUESTION
    The backtest samples decision dates every two weeks and re-runs the engine
    once per horizon. That answers "does the engine have skill", and it is the
    right question for a statistician.

    This runs the engine ONCE PER TRADING DAY, exactly as production would, and
    then follows each card it issued for 30, 60, 90 and 120 days. That answers
    "what did it actually tell the owner, and was it right" - which is the
    question an owner asks, and the one you can check line by line.

    The distinction matters. A card is a single decision made on one morning.
    Measuring it at four horizons is watching one decision play out, not making
    four decisions. Re-running the engine per horizon would be a different
    store on a different day.

EVERY CARD IS PUBLISHED, INCLUDING THE BAD ONES
    No sampling, no top-N of the results, no "representative examples". The
    ledger is every recommendation the engine issued that month with its
    outcome at every horizon, because a report that shows only the winners is
    marketing and the reader can tell.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline.blend.predictive_interval import (  # noqa: E402
    PredictiveInterval,
    predictive_interval,
)
from app.pipeline.blend.reversion import (  # noqa: E402
    MATERIALITY_FLOOR_UNITS,
    MIN_HIT_PROBABILITY,
    REVERSION_HORIZON_DAYS,
)  # noqa: E402
from app.pipeline.candidates.track_record import (  # noqa: E402
    CardOutcome,
    screen as track_record_screen,
)
from app.pipeline.candidates.lifecycle import (  # noqa: E402
    CardHistory,
    review_card,
    suppressed_until,
)
from app.pipeline.features.taxonomy import category_family_of  # noqa: E402
from app.pipeline.policy.holding import holding_cost  # noqa: E402
from app.pipeline.registry import cfg  # noqa: E402

#: Fixed so the clustered interval reproduces on a rerun. A bootstrap seeded
#: from the clock gives a different confidence interval every time the report is
#: generated, which makes two copies of the same page disagree.
CI_SEED = 20260205
from scripts import _report_charts as charts  # noqa: E402
from scripts.real_engine_backtest import (  # noqa: E402
    BASELINE_WINDOW_DAYS,
    calibrate_deficit,
    Store,
    clustered_mean_ci,
    engine_picks,
    load,
    run_context,
    score_pick,
    wilson,
)

HORIZONS = (30, 60, 90, 120)


def month_trading_days(store: Store, year: int, month: int) -> list[date]:
    return [d for d in store.trading_days if d.year == year and d.month == month]


def outcomes_from_prior(paths: Sequence[str], horizon: int
                        ) -> list[CardOutcome]:
    """Scored cards from EARLIER ledgers, for the track-record screen.

    In production this evidence lives in `recommendation_evaluations`; in the
    harness it lives in last month's ledger.json. Either way the rule is the
    same: only the decision horizon's outcome counts, and `known_on` is the date
    it became knowable, never the date the card was issued.
    """
    out: list[CardOutcome] = []
    for path in paths:
        file = Path(path)
        if not file.exists():
            print(f"  prior ledger missing, skipped: {path}")
            continue
        rows = json.loads(file.read_text(encoding="utf-8")).get("ledger") or []
        for row in rows:
            outcome = (row.get("outcomes") or {}).get(str(horizon)) or                 (row.get("outcomes") or {}).get(horizon)
            if not outcome or outcome.get("hit") is None:
                continue
            issued = date.fromisoformat(row["as_of"])
            impact = outcome.get("margin_impact")
            held_cost = outcome.get("over_ordered_cost")
            out.append(CardOutcome(
                sku=row["sku"], issued_on=issued,
                known_on=issued + timedelta(days=horizon),
                hit=bool(outcome["hit"]),
                net_margin=(impact - held_cost
                            if impact is not None and held_cost is not None
                            else None),
            ))
    return out


def build_ledger(
    store: Store, days: list[date],
    prior_outcomes: Sequence[CardOutcome] = (),
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """One engine run per trading day, with MEMORY between days.

    The engine is asked for its decision ONCE, at its own configured horizon -
    the same call production makes. The four horizons are then measurement
    windows over that one decision, not four separate decisions.

    WHAT IS NEW HERE IS THE MEMORY. The first version of this ledger ran the
    engine 26 times with no state, so Stroyski 1.75L was recommended on eight
    consecutive days and missed every one. Each morning now:

      1. every card already up is REVIEWED against what the product has done
         since it went up, and retired if the recovery is not happening
      2. a product whose claim was retired is SUPPRESSED for a while, so the
         next claim rests on different data rather than the same data
         reconsidered
      3. only then are new cards issued

    Retirements are returned alongside the ledger, because a card pulled for
    being wrong is the most informative row in the report.
    """
    ctx0 = run_context(days[0], 30)
    decision_horizon = int(cfg.get(REVERSION_HORIZON_DAYS, ctx0))

    #: open-day index per date, so "fourteen open days later" means what sheet
    #: 03 says it means at a store that shuts on Sundays.
    open_index = {d: i for i, d in enumerate(store.trading_days)}

    ledger: list[dict[str, Any]] = []
    retirements: list[dict[str, Any]] = []
    #: sku -> the claim currently on screen
    active: dict[str, dict[str, Any]] = {}
    #: sku -> open-day index before which no new claim may be made
    suppressed: dict[str, int] = {}
    #: Every card whose DECISION-HORIZON outcome is already scored. Appended as
    #: the walk passes the date it became known, so the screen on any given
    #: morning sees exactly what that morning could have seen. This is the one
    #: structure in the file that must never be filled in advance.
    known_outcomes: list[CardOutcome] = list(prior_outcomes or ())

    for as_of in days:
        today = open_index[as_of]
        ctx = run_context(as_of, decision_horizon)

        # PROMOTE yesterday's cards into evidence, but only the ones whose
        # decision-horizon window has actually closed by this morning.
        for issued in ledger:
            if issued.get("_banked"):
                continue
            issued_on = date.fromisoformat(issued["as_of"])
            if issued_on + timedelta(days=decision_horizon) > as_of:
                continue                     # window still open. not evidence.
            outcome = issued["outcomes"].get(decision_horizon)
            if outcome is None or outcome.get("hit") is None:
                continue
            impact, held_cost = (outcome.get("margin_impact"),
                                 outcome.get("over_ordered_cost"))
            known_outcomes.append(CardOutcome(
                sku=issued["sku"], issued_on=issued_on,
                known_on=issued_on + timedelta(days=decision_horizon),
                hit=bool(outcome["hit"]),
                net_margin=(impact - held_cost
                            if impact is not None and held_cost is not None
                            else None),
            ))
            issued["_banked"] = True

        # 1. REVIEW what is already up.
        for sku, claim in list(active.items()):
            since = today - claim["issued_index"]
            units = store.units(sku, claim["issued_on"], as_of)
            verdict = review_card(
                CardHistory(sku=sku, first_issued=claim["issued_on"],
                            baseline_rate=claim["baseline_rate"],
                            units_since=units, open_days_since=since),
                ctx)
            if verdict.retire:
                retirements.append({
                    "sku": sku, "product": store.names.get(sku, ""),
                    "issued_on": claim["issued_on"].isoformat(),
                    "retired_on": as_of.isoformat(),
                    "days_shown": claim["times_shown"],
                    "open_days_since": since,
                    "rule": verdict.rule, "reason": verdict.reason,
                    "recovery_ratio": verdict.recovery_ratio,
                })
                del active[sku]
                suppressed[sku] = suppressed_until(today, ctx)

        # 2. ISSUE, skipping anything under suppression.
        #
        # The deficit is calibrated from THIS store's own CLOSED windows before
        # today. Raw it promises about twice what arrives; on dates the factor
        # never saw, the calibrated promise is kept 93% of the time against 50%
        # for the raw estimate.
        # TRACK RECORD, built from outcomes ALREADY SCORED by this morning. A card
        # issued on 2 March with a 30-day window is not evidence until 1 April, and
        # `usable_on` is what enforces that - an earlier version that ignored it
        # scored +12.1 points of pure look-ahead.
        record_screen = track_record_screen(
            known_outcomes, as_of=as_of,
            candidate_skus=sorted(store.daily), ctx=ctx,
        )
        # THE SCREEN FIRST, then the calibration fitted THROUGH it. Reversing
        # these two lines is the bug described in calibrate_deficit: a factor
        # fitted on the unscreened population, applied to the screened one, sent
        # Bethany's fill ratio from 104% to 158%.
        cal = calibrate_deficit(store, as_of, decision_horizon,
                                track_record=record_screen)
        picks, refused = engine_picks(store, as_of, decision_horizon,
                                      deficit_calibration=cal,
                                      track_record=record_screen)
        issued = 0
        held = 0
        for pick in picks:
            sku = pick["sku"]
            if suppressed.get(sku, -1) > today:
                held += 1
                continue
            issued += 1
            if sku in active:
                active[sku]["times_shown"] += 1
            else:
                active[sku] = {"issued_on": as_of, "issued_index": today,
                               "baseline_rate": pick["recent_rate"],
                               "times_shown": 1}
            row: dict[str, Any] = {
                "as_of": as_of.isoformat(),
                "rank": issued,
                "sku": sku,
                "product": store.names.get(sku, ""),
                "category": store.category.get(sku, ""),
                "recent_units": pick["recent_units"],
                "recent_rate": pick["recent_rate"],
                "long_run_rate": pick["long_run_rate"],
                "reverted_rate": pick["reverted_rate"],
                "uplift": pick["uplift"],
                "p_hit": pick["p_hit"],
                "dispersion_cv": pick["dispersion_cv"],
                "deficit_units": pick["deficit_units"],
                "raw_deficit_units": pick["raw_deficit_units"],
                "deficit_calibration": pick["deficit_calibration"],
                "unit_margin": pick["unit_margin"],
                "expected_value": pick["expected_value"],
                "evidence_state": pick["evidence_state"],
                "recent_weight": pick["recent_weight"],
                "why": pick["why"],
                "day_of_claim": active[sku]["times_shown"],
                "outcomes": {},
            }
            for h in HORIZONS:
                if as_of + timedelta(days=h) > store.trading_days[-1]:
                    continue        # the label does not exist yet - say nothing
                o = score_pick(store, sku, as_of, h)
                # M5 - GRADE THE PROMISE, not just the direction. The card
                # claimed `deficit_units` extra; this is what fraction arrived.
                promised = pick["deficit_units"]
                realised = o["gained_units"]
                accuracy = (realised / promised) if promised > 0 else None
                # M6 - COUNT THE DOWNSIDE. Units the card said to buy that did
                # not sell are capital on a shelf, and no earlier report costed
                # them.
                #
                # N0.1 - and the FIRST version of this line costed them wrongly.
                # It charged `over * cost`: the entire cost of goods, as though
                # the stock had been destroyed. Liquor does not spoil, so a
                # surplus bottle is deferred revenue and the real cost is
                # capital, shelf and the chance it never sells at full price -
                # cents a month on a $20 bottle, not $20. That one line is why
                # "four of five stores are net negative in April", so it is
                # corrected BEFORE any sizing change is judged against it.
                #
                # It also had the falsy-zero bug: `if cost` maps a genuine 0.0
                # unit cost to None, which is the same class already caught in
                # the index generator. holding_cost() takes `None` only for a
                # real absence and returns a real 0.0 for a free item.
                over = max(0.0, promised - realised)
                cost = store.cost.get(sku)
                # NOT `held`: that name is already the suppression counter in
                # this function, and shadowing it turned `held += 1` into a
                # TypeError on the first real run.
                holding = holding_cost(
                    over, cost, h, ctx0,
                    category_family=category_family_of(store.category.get(sku)),
                )
                # THE RANGE THE CARD PUBLISHES, and therefore the only range
                # whose coverage the gate is entitled to check. Measuring
                # coverage of an interval the owner never sees is theatre: it
                # scores the engine on a claim it never made.
                #
                # Open days and never the calendar horizon. `window_open` is what
                # the scorer used for `expected`, so the interval's mean and the
                # outcome it is graded against share one denominator.
                window_open = store.open_days(as_of, as_of + timedelta(days=h))
                band = predictive_interval(
                    rate=pick["reverted_rate"],
                    horizon_open_days=window_open,
                    dispersion_cv=pick["dispersion_cv"],
                    ctx=ctx0,
                )
                row["outcomes"][h] = {
                    "interval": band.as_dict(),
                    "interval_covers": (
                        band.covers(o["actual"])
                        if isinstance(band, PredictiveInterval)
                        and o["actual"] is not None else None
                    ),
                    "expected": o["expected"], "actual": o["actual"],
                    "lift": o["lift"], "hit": o["hit"],
                    "gained_units": realised,
                    # INCREMENTAL margin: (sold - expected) x unit margin. The
                    # only one of these two that is a result.
                    "margin_impact": o["margin_impact"],
                    # N0.2 - TOTAL margin flow touched: sold x unit margin.
                    # Carried as a separate, labelled column and never summed
                    # into a net. The old ordering showed the LARGEST captured
                    # flow in the estate ($215k) at the same time as a NEGATIVE
                    # incremental margin, because total margin rewards naming
                    # the biggest sellers while predicting nothing about them.
                    "margin_captured": o["margin_captured"],
                    "promised_units": promised,
                    "prediction_accuracy": accuracy,
                    "over_ordered_units": over,
                    # The holding cost, which is what the surplus ACTUALLY
                    # costs. Kept under the same key so every reader of the
                    # ledger follows automatically.
                    "over_ordered_cost": holding.total if holding else None,
                    # And what the deleted model would have charged, so the
                    # report can show the size of the correction rather than
                    # quietly improving.
                    "over_ordered_cogs": (
                        holding.cost_of_goods if holding else None
                    ),
                    "holding_breakdown": holding.as_dict() if holding else None,
                }
            row["card"] = card_text(store, row, decision_horizon)
            ledger.append(row)

        print(f"  {as_of}  {issued:>2} cards"
              + (f", {held} held under suppression" if held else "")
              + (f", {sum(1 for r in retirements if r['retired_on'] == as_of.isoformat())} retired"
                 if any(r["retired_on"] == as_of.isoformat() for r in retirements) else ""))
    # `_banked` is walk bookkeeping, not a measurement. Removed so it never
    # reaches a report, a JSON file or a reader wondering what it means.
    for row in ledger:
        row.pop("_banked", None)
    return ledger, retirements



def card_text(store: Store, r: dict, horizon: int) -> dict[str, str]:
    """The card as an owner would read it.

    WHY THIS IS ASSEMBLED HERE AND NOT BY sheet 15's template_sentence.
        `template_sentence` writes "you have N on hand and expect to sell M in
        the next D days". This replay has NO historical shelf counts - no
        `feature_daily.on_hand` existed before the forward capture started -
        so N is genuinely unknown. Passing 0.0 would print "you have 0 on
        hand", which is not a missing figure, it is a FALSE one, on the line a
        store owner would act from.

        So the action line states what the engine actually measured - the
        shortfall against the recent plan - and the missing stock level is
        declared rather than defaulted. The `why` line is untouched: it is
        sheet 20's own explain(), the exact sentence production writes.

    Everything numeric here traces to a figure the engine computed. Nothing is
    rounded up for effect and no figure appears that the pipeline did not.
    """
    name = r["product"] or r["sku"]
    recent = r["recent_units"]
    deficit = r["deficit_units"]
    expect = r["reverted_rate"] * (recent / r["recent_rate"] if r["recent_rate"] else 0)
    headline = f"Order more {name} — about {deficit:.0f} units above your recent run-rate"
    detail = (
        f"Sold {recent:.0f} units in the last 28 open days "
        f"({r['recent_rate']:.2f} a day). Its own 12-month rate is "
        f"{r['long_run_rate']:.2f} a day, so the last four weeks look quiet "
        f"against its own history. Over the next {horizon} days the engine "
        f"expects about {deficit:.0f} units MORE than those four weeks imply."
    )
    # The range, in the owner's words, at the horizon the card is written for.
    # A point estimate invites "you said 78 and I got 61, you were wrong"; a range
    # is a claim that can be kept, and it is the claim the gate checks.
    band = ((r.get("outcomes") or {}).get(horizon)
            or (r.get("outcomes") or {}).get(str(horizon)) or {}).get("interval")
    if band and band.get("low") is not None:
        detail += (
            f" Total sales over that period should land between "
            f"{band['low']} and {band['high']} units "
            f"{band['nominal_coverage'] * 100:.0f}% of the time, which is the "
            f"range this card can be held to."
        )
    conf = (f"Confidence {r['p_hit']:.2f} - this ranks cards against each "
            f"other and is not a percentage chance. "
            f"Evidence: {r['evidence_state'].lower()}, "
            f"{r['recent_weight'] * 100:.0f}% of the estimate is this "
            f"product's own recent sales.")
    return {"headline": headline, "detail": detail,
            "why": r["why"], "confidence": conf}


def summarise(ledger: list[dict]) -> dict[int, dict[str, Any]]:
    out: dict[int, dict[str, Any]] = {}
    for h in HORIZONS:
        rows = [r for r in ledger if h in r["outcomes"]
                and r["outcomes"][h]["lift"] is not None]
        if not rows:
            continue
        hits = sum(1 for r in rows if r["outcomes"][h]["hit"])
        lo, hi = wilson(hits, len(rows))
        lifts = sorted(r["outcomes"][h]["lift"] for r in rows)
        money = [r["outcomes"][h]["margin_impact"] for r in rows
                 if r["outcomes"][h]["margin_impact"] is not None]
        units = [r["outcomes"][h]["gained_units"] for r in rows]
        # M5: how much of what the card PROMISED actually arrived. Pooled as
        # realised-over-promised rather than a mean of ratios, so one tiny
        # promise that overshot 40x cannot carry the figure.
        promised = sum(r["outcomes"][h]["promised_units"] for r in rows
                       if r["outcomes"][h]["promised_units"] > 0)
        delivered = sum(r["outcomes"][h]["gained_units"] for r in rows
                        if r["outcomes"][h]["promised_units"] > 0)
        # M6: the cost of units the card called for that did not sell.
        over_cost = [r["outcomes"][h]["over_ordered_cost"] for r in rows
                     if r["outcomes"][h]["over_ordered_cost"] is not None]
        # N0.1: and what the DELETED model would have charged for the same
        # units - the full cost of goods, as though the stock were destroyed.
        # Carried so the report can print the size of the correction instead of
        # quietly improving, which would be the more flattering and less
        # useful thing to do.
        over_cogs = [r["outcomes"][h].get("over_ordered_cogs") for r in rows
                     if r["outcomes"][h].get("over_ordered_cogs") is not None]
        # ── N0.2: MONEY IS THE LEAD FIGURE, PER CARD, WITH AN INTERVAL ──────
        # Hit rate answers a research question about selection. The business
        # runs on money, so the money figure is promoted to first class here.
        #
        # PER CARD, never as a raw total: the arms being compared place
        # different numbers of bets - 1,056 against 2,080 - and dividing a
        # total by nothing compares a rate to a volume. Per card is +$48
        # against -$952; by total it reads +$51k against -$1.98m, which
        # flatters whichever arm bet more.
        #
        # And a card with no measurable money is EXCLUDED, not counted as zero.
        # Five of ten audited stores send no cost at all; folding them in as
        # 0.0 would drag every average toward nothing and call it a measurement.
        nets_by_date: dict[str, list[float]] = defaultdict(list)
        for r in rows:
            o = r["outcomes"][h]
            mi, oc = o["margin_impact"], o["over_ordered_cost"]
            if mi is None or oc is None:
                continue        # absence. not zero.
            nets_by_date[r["as_of"]].append(mi - oc)
        nets = [v for day in nets_by_date.values() for v in day]
        # Clustered BY DECISION DATE, because two cards issued on the same
        # morning share a market. Seeded per horizon so a rerun reproduces.
        rng = random.Random(CI_SEED + h)
        net_lo, net_hi = clustered_mean_ci(list(nets_by_date.values()), rng)

        captured = [r["outcomes"][h]["margin_captured"] for r in rows
                    if r["outcomes"][h].get("margin_captured") is not None]

        out[h] = {
            # The lead figure, and its honest denominator: how many cards the
            # money is actually measured on, which is NOT len(rows).
            "net_margin_per_card": (sum(nets) / len(nets)) if nets else None,
            "net_margin_per_card_ci": (
                [net_lo, net_hi] if len(nets_by_date) >= 2 else None
            ),
            "cards_with_money": len(nets),
            "decision_dates_with_money": len(nets_by_date),
            # Total flow touched. A separate, labelled column - NOT a result.
            "margin_captured": sum(captured) if captured else None,
            "n": len(rows), "hits": hits, "hit_rate": hits / len(rows) * 100,
            "ci_lo": lo, "ci_hi": hi,
            "median_lift": lifts[len(lifts) // 2],
            "winners": sum(1 for v in lifts if v >= 1.5),
            "margin": sum(money) if money else 0.0,
            "margin_per_card": (sum(money) / len(rows)) if money else 0.0,
            "units_gained": sum(units),
            "promised_units": promised,
            "delivered_units": delivered,
            "prediction_accuracy": (delivered / promised) if promised > 0 else None,
            "over_ordered_cost": sum(over_cost) if over_cost else 0.0,
            "over_ordered_cogs": sum(over_cogs) if over_cogs else 0.0,
            "net_margin": ((sum(money) if money else 0.0)
                           - (sum(over_cost) if over_cost else 0.0)),
            # The same figure on the OLD ruler, for the before/after. Not a
            # second result - a record of what was being measured wrongly.
            "net_margin_cogs_ruler": ((sum(money) if money else 0.0)
                                      - (sum(over_cogs) if over_cogs else 0.0)),
        }
    return out


def per_sku(ledger: list[dict]) -> list[dict]:
    """The same product recommended on many days is ONE judgement repeated, not
    many independent ones. A reader who does not see that will read 26 cards
    for the same bottle as 26 pieces of evidence."""
    by: dict[str, list[dict]] = defaultdict(list)
    for r in ledger:
        by[r["sku"]].append(r)
    out = []
    for sku, rows in by.items():
        scored = [r for r in rows if 30 in r["outcomes"]
                  and r["outcomes"][30]["lift"] is not None]
        if not scored:
            continue
        hits = sum(1 for r in scored if r["outcomes"][30]["hit"])
        money = sum(r["outcomes"][30]["margin_impact"] or 0.0 for r in scored)
        out.append({
            "sku": sku, "product": rows[0]["product"],
            "times": len(rows), "scored": len(scored), "hits": hits,
            "hit_rate": hits / len(scored) * 100,
            "median_uplift": sorted(r["uplift"] for r in rows)[len(rows) // 2],
            "margin_30": money,
            "first": min(r["as_of"] for r in rows),
            "last": max(r["as_of"] for r in rows),
        })
    return sorted(out, key=lambda r: (-r["times"], -r["margin_30"]))


def by_day(ledger: list[dict]) -> list[dict]:
    by: dict[str, list[dict]] = defaultdict(list)
    for r in ledger:
        by[r["as_of"]].append(r)
    out = []
    for d in sorted(by):
        rows = by[d]
        cell = {}
        for h in HORIZONS:
            s = [r for r in rows if h in r["outcomes"]
                 and r["outcomes"][h]["lift"] is not None]
            cell[h] = (sum(1 for r in s if r["outcomes"][h]["hit"]), len(s))
        out.append({"date": d, "cards": len(rows), "cells": cell,
                    "margin_30": sum(r["outcomes"].get(30, {}).get("margin_impact") or 0.0
                                     for r in rows)})
    return out


def _fmt_money(v, coverage):
    if coverage < 0.01:
        return "&mdash;"
    return ("$" + format(v, "+,.0f")) if v else "$0"


def write_report(ledger, summary, store, store_name, month_label, out: Path,
                 days: list[date], retirements: list[dict] | None = None,
                 accuracy: dict | None = None,
                 backtest: dict | None = None) -> None:
    """Hand the numbers to the presentation module and write the page.

    Computation and presentation were in one 300-line f-string. A `%` in a
    sentence broke the arithmetic's page and a change to the wording risked the
    figures, so they are now two files with plain data between them.
    """
    from scripts import _ledger_report as R

    day_strs = [d.isoformat() for d in days]
    charts = {
        "by_window": R.chart_by_window(summary, day_strs),
        "promise": R.chart_promise(summary, day_strs),
        "daily": R.chart_daily(ledger),
    }
    ctx0 = run_context(days[0], 30)
    settings = {
        "materiality floor": f"{int(cfg.get(MATERIALITY_FLOOR_UNITS, ctx0))} units per 28 open days",
        "minimum confidence (p_hit)": f"{float(cfg.get(MIN_HIT_PROBABILITY, ctx0)):.2f}",
        "decision horizon": f"{int(cfg.get(REVERSION_HORIZON_DAYS, ctx0))} days",
        "baseline window": f"{BASELINE_WINDOW_DAYS} days",
        "deficit calibration": (
            "measured per store from its own closed windows; "
            + ", ".join(sorted({f"x{r['deficit_calibration']:.2f}"
                                for r in ledger if 'deficit_calibration' in r}))[:90]
            if any("deficit_calibration" in r for r in ledger) else "not applied"),
        "trading days in the month": str(len(days)),
        "cards issued": str(len(ledger)),
        "cards retired": str(len(retirements or [])),
    }
    html = R.build_page(
        store_name=store_name, month_label=month_label, days=day_strs,
        ledger=ledger, summary=summary, retirements=retirements or [],
        cost_coverage=store.cost_coverage, settings=settings, charts=charts,
        accuracy=accuracy, backtest=backtest)
    (out / "RECOMMENDATION_LEDGER.html").write_text(html, encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", required=True)
    ap.add_argument("--file", required=True)
    ap.add_argument("--store", default="the store")
    ap.add_argument("--month", required=True, help="YYYY-MM")
    ap.add_argument("--out", required=True)
    ap.add_argument("--accuracy", help="forecast_accuracy.json to embed (R10)")
    ap.add_argument("--backtest", help="backtest summary.json to embed")
    ap.add_argument(
        "--prior", action="append", default=[],
        help="an EARLIER month's ledger.json, repeatable. Seeds the track-record "
             "screen with outcomes that were already scored before this month "
             "began. Without it the screen has no evidence inside a single month "
             "- a card issued on 2 March is not scored until 1 April - which is "
             "correct and is why it changes nothing when omitted. In production "
             "this evidence comes from recommendation_evaluations.")
    args = ap.parse_args()

    year, month = (int(x) for x in args.month.split("-"))
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    print(f"loading {args.file} ...")
    store = load(args.data, args.file)
    print(f"  {store.n_lines:,} lines, {len(store.daily):,} products, "
          f"cost on {store.cost_coverage * 100:.1f}% of lines")

    days = month_trading_days(store, year, month)
    if not days:
        raise SystemExit(f"no trading days in {args.month}")
    label = datetime(year, month, 1).strftime("%B %Y")
    print(f"\n{label}: {len(days)} trading days, {days[0]} .. {days[-1]}")
    latest = max(days) + timedelta(days=max(HORIZONS))
    if latest > store.trading_days[-1]:
        print(f"  NOTE: data ends {store.trading_days[-1]}; the longest windows "
              f"for late-month cards are incomplete and are left blank.")
    print("")

    # The decision horizon, resolved against this run's own context. `ctx0` in
    # write_report belongs to that function; reaching for it here was a NameError
    # the first time this ran.
    horizon_ctx = run_context(days[0], 30)
    prior = outcomes_from_prior(
        args.prior, int(cfg.get(REVERSION_HORIZON_DAYS, horizon_ctx)))
    if args.prior:
        print(f"  track record seeded with {len(prior)} scored outcomes "
              f"from {len(args.prior)} earlier ledger(s)")
    ledger, retirements = build_ledger(store, days, prior_outcomes=prior)
    summary = summarise(ledger)

    json.dump({"store": args.store, "month": args.month,
               "retirements": retirements,
               "trading_days": [d.isoformat() for d in days],
               "summary": {str(k): v for k, v in summary.items()},
               "ledger": ledger},
              open(out / "ledger.json", "w"), indent=1, default=str)
    # Embedded when supplied, absent when not. A section that renders empty
    # headings because its input is missing is worse than no section.
    def _read(path: str | None) -> dict | None:
        if not path:
            return None
        f = Path(path)
        if not f.exists():
            print(f"  note: {f} not found - that section is omitted")
            return None
        return json.loads(f.read_text(encoding="utf-8"))

    write_report(ledger, summary, store, args.store, label, out, days,
                 retirements, accuracy=_read(args.accuracy),
                 backtest=_read(args.backtest))

    print(f"\n{'=' * 76}\n  {args.store} - {label}\n{'=' * 76}")
    print(f"  {len(days)} trading days, {len(ledger)} cards "
          f"({len(ledger) / len(days):.1f} a day)\n")
    print(f"  {'window':>8} {'cards':>6} {'hit rate':>10} {'95% CI':>12} "
          f"{'med lift':>9} {'winners':>8} {'units':>9} {'margin':>12}")
    for h in HORIZONS:
        s = summary.get(h)
        if not s:
            continue
        money = "-" if store.cost_coverage < 0.01 else format(s["margin"], "+,.0f")
        print(f"  {h:>6}d {s['n']:>6} {s['hit_rate']:>9.1f}% "
              f"{s['ci_lo']:>5.0f}-{s['ci_hi']:<5.0f} {s['median_lift']:>9.2f} "
              f"{s['winners']:>8} {s['units_gained']:>+9,.0f} {money:>12}")
    print(f"\n  wrote {out / 'RECOMMENDATION_LEDGER.html'}")
    print(f"  wrote {out / 'ledger.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
