#!/usr/bin/env python
"""One page for a whole cohort: the backtests, and why the rest could not run.

    python scripts/build_cohort_report.py --audit ../audit-14 --month 2026-03

WHY THE REFUSALS ARE THE POINT OF THIS PAGE
    `ALL_STORES_LEDGER.html` shows five stores that all work. Asked to backtest
    fourteen more, the honest answer was that one of them can be: the others are
    missing from the warehouse, present with zero sales, or hold a month of
    history against a question that needs seventeen.

    A page that showed those as empty cards would be useless and slightly
    dishonest. A page that NAMES each one, with the dates that put it there, is a
    readiness audit - and "not in the warehouse", "in it with no sales" and "too
    new" are three different problems with three different owners.

    So every store the cohort asked for appears, and each one carries either its
    cards or its reason.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from scripts._combined_ledger_report import build_combined  # noqa: E402
from scripts._ledger_report import CSS, _esc  # noqa: E402

REASONS = {
    "not_in_database": (
        "Not in the warehouse",
        "No store of this name exists in <code>client_locations</code>; all 197 "
        "were searched. The id supplied is not an internal one either - Manhattan "
        "Liquors is location 44, not 11264 - so there is a POS-to-internal "
        "mapping that this repository does not hold.",
        "onboarding"),
    "no_sales": (
        "In the warehouse, no sales",
        "The store exists and its sale table is empty. Nothing has ever synced "
        "from its POS, so there is no history to measure and no cards to issue.",
        "POS sync"),
    "history_too_short": (
        "Too new to measure",
        "A March 2026 backtest reads a 365-day long-run rate before the decision "
        "and follows each card for 120 days after it. A store whose first sale "
        "lands after the month being tested has nothing to compute a rate from "
        "and nothing to score against.",
        "time"),
    "export_unreadable": (
        "Export unreadable", "The file exists and could not be parsed.", "data"),
    "backtest_failed": (
        "Backtest failed", "The walk-forward run did not complete.", "engine"),
    "ledger_failed": (
        "Ledger failed", "The month ran and the ledger did not.", "engine"),
}


STATUS_RANK = {
    "measured_and_serving": 0, "serving_too_new": 1, "shelf_no_demand": 2,
    "catalogue_only": 3, "no_data": 4, "not_onboarded": 5,
}

STATUS_LABEL = {
    "measured_and_serving": ("Measured and serving", "good",
                             "Backtested against finished months AND issuing "
                             "cards today. The only state that carries a proven "
                             "hit rate."),
    "serving_too_new": ("Serving, too new to measure", "warn",
                        "Issuing cards today. Cannot be backtested yet: a "
                        "finished month needs about seventeen months of history "
                        "behind it, and these have one to three."),
    "shelf_no_demand": ("Shelf known, no demand", "bad",
                        "Stock levels are there and not one sale has ever "
                        "synced. The engine ranks on demand, so it can describe "
                        "the shelf and cannot yet rank it."),
    "catalogue_only": ("Catalogue only", "bad",
                       "A handful of products and nothing else. Effectively "
                       "empty."),
    "no_data": ("No data at all", "bad",
                "Onboarded, and nothing has ever arrived - no products, no "
                "stock, no sales."),
    "not_onboarded": ("Not in the warehouse", "bad",
                      "No store of this name exists in client_locations."),
}


def classify(facts: dict, cards: int, backtested: bool) -> str:
    if facts is None:
        return "not_onboarded"
    lines = facts.get("lines") or 0
    products = facts.get("products") or 0
    if backtested and cards:
        return "measured_and_serving"
    if cards:
        return "serving_too_new"
    if products > 100 and not lines:
        return "shelf_no_demand"
    if products:
        return "catalogue_only"
    return "no_data"


def status_section(audit, verdicts, runs_dir) -> str:
    """Every location on one line: what data it has, and what it can do with it.

    THIS IS THE TABLE SOMEBODY ACTS ON. The backtest answers "is it right" and the
    live slate answers "what does it say", and neither alone tells an operator
    which store needs a phone call. A store with six thousand units on the shelf
    and no sales row is a different job from one that was never onboarded, and
    both look like a blank cell until the status is named.
    """
    import json as _json
    facts_path = audit / "store_facts.json"
    facts = {}
    if facts_path.exists():
        for f in _json.loads(facts_path.read_text(encoding="utf-8")):
            facts[int(f["location_id"])] = f

    rows = []
    for v in verdicts:
        loc = v.get("loc") or 0
        f = facts.get(loc)
        cards = 0
        run = runs_dir / f"{loc}.json" if loc else None
        if run is not None and run.exists():
            try:
                cards = len((_json.loads(run.read_text(encoding="utf-8"))
                             .get("recommendations")) or [])
            except ValueError:
                cards = 0
        state = classify(f, cards, bool(v.get("ok")))
        label, cls, _why = STATUS_LABEL[state]
        money = bool(f and (f.get("cost_lines") or 0) > 0)
        sync = bool(f and f.get("sync_credential"))
        rows.append((STATUS_RANK[state], -cards, v["name"], loc, f, cards,
                     state, label, cls, money, sync, v))

    body = []
    for _r, _c, name, loc, f, cards, state, label, cls, money, sync, v in sorted(rows):
        lines = (f or {}).get("lines") or 0
        prods = (f or {}).get("products") or 0
        stock = (f or {}).get("in_stock") or 0
        bt = (f"{v['bt_hit']:.1f}%" if v.get("ok") else "&mdash;")
        body.append(
            f'<tr><td><b>{_esc(name)}</b>'
            + (f'<span class="span">location {loc}</span>' if loc
               else '<span class="span">no record</span>')
            + f'</td>'
            f'<td><b class="{cls}">{_esc(label)}</b></td>'
            f'<td>{prods:,}<span class="span">{stock:,} in stock</span></td>'
            f'<td>{lines:,}<span class="span">sale lines</span></td>'
            f'<td>{"yes" if money else "&mdash;"}</td>'
            f'<td>{"yes" if sync else "&mdash;"}</td>'
            f'<td><b>{cards or "&mdash;"}</b></td>'
            f'<td>{bt}</td></tr>')

    legend = "".join(
        f'<li><b class="{cls}">{_esc(label)}</b> &mdash; {why}</li>'
        for state, (label, cls, why) in sorted(
            STATUS_LABEL.items(), key=lambda kv: STATUS_RANK[kv[0]]))

    return (
        '<h2><span class="num">00</span>Every location, and what it can do today</h2>'
        '<p>One line per location. <b>Cards</b> is what the live route returned '
        'this run; <b>backtest</b> is the 2.3-year measured hit rate, which only '
        'exists for a store with enough history to replay.</p>'
        '<div class="scroll"><table><thead><tr>'
        '<th>Location</th><th>Status</th><th class="num">products</th>'
        '<th class="num">sales</th><th>money</th><th>sync</th>'
        '<th class="num">cards</th><th class="num">backtest</th>'
        '</tr></thead><tbody>' + "".join(body) + '</tbody></table></div>'
        f'<ul>{legend}</ul>'
        '<div class="band good"><h3>Tuscany is the one to lead with</h3>'
        '<p>It is the only location in this cohort with <b>cost on its sale '
        'lines</b> &mdash; 34,285 of 34,362 &mdash; and the only one with an '
        '<b>active sync credential</b>. Cost is what turns a card from "this will '
        'sell" into "this is worth $X", so every money figure the engine can '
        'produce is available there and nowhere else here. It issues a full '
        'slate today: 6 reorders, 3 markdowns and a bundle, from 8,936 products '
        'and 6,080 in stock.</p>'
        '<p>It is still too new to <em>measure</em> &mdash; 93 days of sales '
        'against the seventeen months a replay needs &mdash; so treat its hit '
        'rate as unproven and its cards as fully priced. Those are different '
        'claims and both are true.</p></div>')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--audit", required=True)
    ap.add_argument("--month", default="2026-03")
    args = ap.parse_args()
    audit = Path(args.audit).resolve()
    label = datetime.strptime(args.month, "%Y-%m").strftime("%B %Y")

    verdicts = json.loads((audit / "cohort.json").read_text(encoding="utf-8"))
    ok = [v for v in verdicts if v.get("ok")]

    stores = []
    for v in ok:
        led = audit / f"ledger-{v['slug']}-{args.month}" / "ledger.json"
        bt = audit / f"{v['slug']}-backtest" / "summary.json"
        if not led.exists():
            continue
        data = json.loads(led.read_text(encoding="utf-8"))
        btj = json.loads(bt.read_text(encoding="utf-8")) if bt.exists() else {}
        stores.append({
            "loc": v["loc"], "name": v["name"], "slug": v["slug"],
            "ledger": data["ledger"], "summary": data["summary"],
            "retirements": data.get("retirements") or [],
            "trading_days": data["trading_days"],
            "cost_coverage": float(btj.get("cost_coverage", 0.0)),
            "bt_hit": (btj.get("sheet20") or {}).get("hit_rate", 0.0),
            "bt_null": btj.get("null_reversion", 0.0),
            "bt_p": btj.get("p_value", 1.0),
        })

    # The refusal table, grouped so one owner can read one block.
    by_reason: dict[str, list[dict]] = {}
    for v in verdicts:
        if v.get("ok"):
            continue
        by_reason.setdefault(v.get("reason", "unknown"), []).append(v)

    blocks = []
    for reason, rows in sorted(by_reason.items(),
                               key=lambda kv: -len(kv[1])):
        title, why, owner = REASONS.get(
            reason, (reason, "", "unknown"))
        items = "".join(
            f'<tr><td><b>{_esc(r["name"])}</b>'
            + (f'<span class="span">location {r["loc"]}</span>'
               if r.get("loc") else
               f'<span class="span">id supplied: {r.get("given_id", "?")}</span>')
            + f'</td><td>{_esc(r.get("detail") or r.get("note") or "")}</td></tr>'
            for r in sorted(rows, key=lambda x: x["name"]))
        blocks.append(
            f'<h3>{_esc(title)} &mdash; {len(rows)} '
            f'location{"s" if len(rows) != 1 else ""} '
            f'<span class="span">fixed by: {_esc(owner)}</span></h3>'
            f'<p>{why}</p>'
            f'<div class="scroll"><table><thead><tr><th>Location</th>'
            f'<th>What the data says</th></tr></thead>'
            f'<tbody>{items}</tbody></table></div>')

    measured = len(stores)
    total = len(verdicts)
    status = status_section(audit, verdicts, audit / "runs")
    intro = f"""
<h1>Cohort backtest &mdash; {_esc(label)}</h1>
<p class="lede">Every location in the requested cohort, with its March 2026 cards
followed into April, May, June and July &mdash; or the reason it could not be
measured, with the dates that put it there.</p>
<p class="sub"><b>{measured}</b> of <b>{total}</b> locations could be backtested
&middot; generated {_esc(datetime.now().strftime("%d %B %Y"))}</p>

<div class="band bad">
<h3>Read the refusals first</h3>
<p>This cohort is mostly a data-readiness finding rather than an engine result.
A March 2026 backtest needs sales from <b>1 March 2025 to 29 July 2026</b>: a
365-day long-run rate behind each decision, and 120 days of outcomes in front of
it. Several of these locations have their first sale <em>after</em> the month
being tested, which no setting can work around &mdash; there is nothing to compute
a rate from and nothing to score against.</p>
<p>Zero cost data is <b>not</b> what blocks them. A store with no cost still gets
cards and a hit rate; it gets no money column, and the report prints an absence
rather than a zero. What blocks them is history.</p>
</div>

{status}

{"".join(blocks)}
"""

    if stores:
        page = build_combined(stores, label)
        # Splice the cohort preamble in ahead of the generated page's own header.
        marker = "<h1>"
        at = page.index(marker)
        end = page.index("</p>", page.index('<p class="sub">')) + 4
        page = page[:at] + intro + page[end:]
    else:
        page = (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
                f'<meta name="viewport" content="width=device-width,initial-scale=1">'
                f'<title>Cohort backtest &middot; {_esc(label)}</title>'
                f'<style>{CSS}</style></head><body><div class="wrap">{intro}'
                f'</div></body></html>')

    out = audit / "COHORT_LEDGER.html"
    out.write_text(page, encoding="utf-8")
    print(f"  wrote {out}")
    print(f"  {measured} of {total} locations backtested, "
          f"{out.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
