#!/usr/bin/env python
"""Three scoreboards, five stores, on one page - and they are kept apart.

    python scripts/build_engine_scorecard.py --audit ../audit

WHY THREE AND NOT ONE NUMBER
    They answer different questions and need different evidence, and averaging
    them produces a figure that answers none:

      PREDICTION ACCURACY  did the product sell more than its own trailing rate
                           implied? Needs NO owner action, which is what makes it
                           measurable today across 2.3 years.

      HOLDOUT MONEY        did SHOWN cards earn more than WITHHELD ones? This is
                           the only scoreboard that can answer "would it have sold
                           anyway", and it needs the owner to have done something.

      BACKTEST, WITH AND   what does the gating actually buy? The same engine run
      WITHOUT              with sheet 20's materiality and confidence gates on,
                           and with the ungated ordering that shipped before them.

    A store can score well on the first and have nothing on the second. Printing
    one blended "accuracy" would hide exactly that, and the second scoreboard is
    the one a sceptic asks about.

THE HOLDOUT SCOREBOARD IS REPORTED EVEN WHEN IT CANNOT BE COMPUTED
    It is the most important of the three and currently the emptiest. The page
    states which of its three preconditions is missing rather than showing an
    empty table, because "we cannot measure this yet, and here is the specific
    reason" is actionable and a blank is not.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from scripts._ledger_report import CSS, _esc, _money  # noqa: E402

STORES = [
    (171, "Bethany Discount Liquor", "171"),
    (176, "Northlake Liquors North", "176"),
    (177, "Mango Jo's Bar & Liquors", "177"),
    (178, "Marshfield Wine & Spirits", "178"),
    (181, "Cork Runner Wine & Spirits", "181"),
]
HORIZONS = (30, 60, 90, 120)


def _rate(pct: float | None, n: int | None = None) -> str:
    if pct is None:
        return '<span class="span">not measured</span>'
    cls = "good" if pct >= 70 else ("warn" if pct >= 55 else "bad")
    tail = f'<span class="span">{n} cards</span>' if n else ""
    return f'<b class="{cls}">{pct:.1f}%</b>{tail}'


def load(audit: Path, months: list[str]) -> list[dict]:
    out = []
    for loc, name, slug in STORES:
        bt_path = audit / f"{slug}-backtest" / "summary.json"
        row: dict = {"loc": loc, "name": name, "slug": slug, "months": {}}
        if bt_path.exists():
            row["bt"] = json.loads(bt_path.read_text(encoding="utf-8"))
        for month in months:
            led = audit / f"ledger-{slug}-{month}" / "ledger.json"
            if led.exists():
                row["months"][month] = json.loads(led.read_text(encoding="utf-8"))
        out.append(row)
    return out


def scoreboard_one(stores: list[dict], months: list[str]) -> str:
    """Prediction accuracy: per store, per month, per horizon."""
    head = "".join(f'<th class="num">{h}d</th>' for h in HORIZONS)
    blocks = []
    for month in months:
        label = datetime.strptime(month, "%Y-%m").strftime("%B %Y")
        rows = []
        for s in stores:
            led = s["months"].get(month)
            if not led:
                rows.append(f'<tr><td>{s["loc"]} {_esc(s["name"])}</td>'
                            f'<td colspan="{len(HORIZONS) + 2}">'
                            f'<span class="span">no ledger for this month</span>'
                            f'</td></tr>')
                continue
            cells = ""
            for h in HORIZONS:
                w = led["summary"].get(str(h)) or {}
                cells += f'<td>{_rate(w.get("hit_rate"), w.get("n"))}</td>'
            s30 = led["summary"].get("30") or {}
            rows.append(
                f'<tr><td><b>{s["loc"]}</b> {_esc(s["name"])}</td>'
                f'<td>{len(led["ledger"])}'
                f'<span class="span">{len({r["sku"] for r in led["ledger"]})}'
                f' products</span></td>'
                f'{cells}'
                f'<td>{_money(s30.get("net_margin"), 1.0)}</td></tr>')
        blocks.append(
            f'<h3>{_esc(label)} cards, followed forward</h3>'
            f'<div class="scroll"><table><thead><tr><th>Store</th>'
            f'<th class="num">cards</th>{head}<th class="num">30d net</th>'
            f'</tr></thead><tbody>{"".join(rows)}</tbody></table></div>')
    return "".join(blocks)


def scoreboard_two(facts: dict | None) -> str:
    """Holdout money - and why it cannot be computed yet."""
    if not facts:
        return ('<div class="band bad"><h3>Not available</h3><p>No '
                '<code>holdout_facts.json</code>. Run '
                '<code>backend/scripts/export-holdout-facts.js</code>.</p></div>')
    pre = facts.get("preconditions") or {}
    missing = [k for k, v in pre.items() if not v]
    rows = []
    by_loc: dict[int, dict] = {}
    for c in facts.get("cards") or ():
        by_loc.setdefault(c["location_id"], {})["cards"] = c
    for o in facts.get("outcomes") or ():
        by_loc.setdefault(o["location_id"], {})[o["arm"]] = o
    for loc, name, _slug in STORES:
        d = by_loc.get(loc) or {}
        c = d.get("cards") or {}
        shown, held = d.get("shown") or {}, d.get("withheld") or {}
        rows.append(
            f'<tr><td><b>{loc}</b> {_esc(name)}</td>'
            f'<td>{c.get("shown", 0)}</td><td>{c.get("withheld", 0)}</td>'
            f'<td>{shown.get("with_lift", 0)}</td>'
            f'<td class="{"bad" if not held.get("with_lift") else ""}">'
            f'{held.get("with_lift", 0)}</td>'
            f'<td class="bad">{(c.get("voted", 0) or 0) + (c.get("claimed", 0) or 0)}'
            f'</td>'
            f'<td class="bad">{(shown.get("purchase_evidence", 0) or 0)}</td>'
            f'</tr>')
    reasons = {
        "both_arms_have_cards": "cards exist in both arms",
        "both_arms_have_scored_lift": "outcomes are SCORED for both arms",
        "any_owner_action_recorded": "some owner action is recorded",
    }
    verdict = (
        '<div class="band bad"><h3>This scoreboard cannot be computed yet, and '
        'these are the exact reasons</h3><ul>'
        + "".join(f'<li><b>{_esc(reasons[m])}</b> &mdash; not true</li>'
                  for m in missing)
        + '</ul><p>The withheld arm has cards but <b>no scored lift</b>, so there '
        'is nothing to compare the shown arm against. And no owner action has '
        'been recorded anywhere: no votes, no action claims, and '
        '<code>purchased_qty_source</code> and <code>delivery_evidence</code> are '
        'null on every row &mdash; so "action inferred from stock jumps and '
        'invoices" is currently inferring nothing.</p>'
        '<p><b>This is the scoreboard that answers "would it have sold anyway", '
        'and it is the one with no data.</b> Prediction accuracy cannot stand in '
        'for it: a card can forecast perfectly and still change nothing, which is '
        'precisely what a holdout exists to detect.</p></div>'
    ) if missing else ""
    return (
        verdict +
        '<div class="scroll"><table><thead><tr><th>Store</th>'
        '<th class="num">shown</th><th class="num">withheld</th>'
        '<th class="num">shown scored</th><th class="num">withheld scored</th>'
        '<th class="num">owner actions</th>'
        '<th class="num">purchase evidence</th></tr></thead>'
        f'<tbody>{"".join(rows)}</tbody></table></div>')


def scoreboard_three(stores: list[dict]) -> str:
    """The gates, applied and not applied, on the same 2.3 years."""
    rows = []
    for s in stores:
        bt = s.get("bt")
        if not bt:
            continue
        on, off = bt.get("sheet20") or {}, bt.get("old_ordering") or {}
        rows.append(
            f'<tr><td><b>{s["loc"]}</b> {_esc(s["name"])}'
            f'<span class="span">{bt.get("runs", 0)} runs over '
            f'{bt.get("trading_days", 0):,} trading days</span></td>'
            f'<td>{_rate(on.get("hit_rate"), on.get("n"))}</td>'
            f'<td>{_rate(off.get("hit_rate"), off.get("n"))}</td>'
            f'<td><b class="good">'
            f'{(on.get("hit_rate", 0) - off.get("hit_rate", 0)):+.1f}</b></td>'
            f'<td>{_money(on.get("impact_per_card"), 1.0, dp=2)}</td>'
            f'<td class="bad">{_money(off.get("impact_per_card"), 1.0, dp=2)}</td>'
            f'<td>{bt.get("null_reversion", 0):.1f}%'
            f'<span class="span">matched null</span></td>'
            f'<td>{bt.get("p_value", 1):.4f}</td></tr>')
    return (
        '<div class="scroll"><table><thead><tr><th>Store</th>'
        '<th class="num">gates ON</th><th class="num">gates OFF</th>'
        '<th class="num">edge</th><th class="num">$/card ON</th>'
        '<th class="num">$/card OFF</th><th class="num">null</th>'
        '<th class="num">p</th></tr></thead>'
        f'<tbody>{"".join(rows)}</tbody></table></div>')


def build(stores: list[dict], facts: dict | None, months: list[str]) -> str:
    links = "".join(
        f'<div class="item"><div class="n">{s["loc"]} {_esc(s["name"])}</div>'
        f'<div class="links">'
        + "".join(
            f'<a class="pill" href="ledger-{s["slug"]}-{m}/'
            f'RECOMMENDATION_LEDGER.html">{datetime.strptime(m, "%Y-%m").strftime("%b %Y")} '
            f'&mdash; every product</a>' for m in months if m in s["months"])
        + f'<a class="pill" href="{s["slug"]}-backtest/REAL_ENGINE_REPORT.html">'
        f'backtest</a></div></div>'
        for s in stores)

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Engine scorecard &middot; five stores</title>
<style>{CSS}
a.pill{{font-size:12.5px;text-decoration:none;color:var(--accent);
  border:1px solid var(--line);border-radius:999px;padding:4px 11px;
  background:var(--bg);margin:0 6px 6px 0;display:inline-block}}
.grid{{display:grid;gap:12px;margin:18px 0;
  grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}}
.item{{background:var(--panel);border:1px solid var(--line);
  border-radius:12px;padding:14px 16px}}
.item .n{{font-weight:650;margin-bottom:8px}}
</style></head><body><div class="wrap">

<h1>Engine scorecard &mdash; five stores, three scoreboards</h1>
<p class="lede">They are kept apart on purpose. They answer different questions,
need different evidence, and averaging them produces a number that answers
none.</p>
<p class="sub">Built {_esc(datetime.now().strftime("%d %B %Y, %H:%M"))} &middot;
stores 171, 176, 177, 178, 181 &middot; monthly ledgers and a 2.3-year
walk-forward backtest</p>

<div class="band">
<h3>How to read a hit, in one sentence</h3>
<p>A card is a <b>hit</b> when the product sold more over the window than its own
trailing rate implied &mdash; a lift of 1.00&times; or better against the baseline
the card itself published. It is not "the owner ordered it" and not "the product
sold something": a product that was always going to sell is not credited to the
engine.</p>
</div>

<h2><span class="num">01</span>Prediction accuracy</h2>
<p>Did the product sell more than its own trailing rate implied? This needs
<b>no owner action</b>, which is what makes it measurable today. One decision
watched at four horizons &mdash; not four decisions.</p>
{scoreboard_one(stores, months)}
<p class="sub">Per product, one line each, in the per-store ledgers linked at the
foot of this page. Every card is published there including the losses.</p>

<h2><span class="num">02</span>Holdout money &mdash; shown against withheld</h2>
<p>The only scoreboard that answers <b>"would it have sold anyway"</b>. A
deterministic 10% of cards are withheld from the owner, computed and scored
exactly like the rest, so the two arms can be compared.</p>
{scoreboard_two(facts)}

<h2><span class="num">03</span>The backtest, gates applied and not applied</h2>
<p>The same engine over the same 2.3 years, run twice: with sheet 20's
materiality and confidence gates, and with the ungated ordering that shipped
before them (margin &times; total demand). This is what the gating buys.</p>
{scoreboard_three(stores)}
<div class="band good">
<h3>The gates are the engine</h3>
<p>Turning them off does not cost a few points &mdash; it inverts the result.
The ungated ordering issues roughly twice as many cards, hits about half as
often, and its margin per card goes from positive to deeply negative. The
<code>null</code> column is the hard test: a volume- and reversion-matched random
basket, so the edge is measured against products that were equally primed to
recover on their own.</p>
</div>

<h2><span class="num">04</span>Every product, every month</h2>
<div class="grid">{links}</div>

<div class="foot">
<p>Built by <code>scripts/build_engine_scorecard.py</code> from the same
<code>ledger.json</code> and <code>summary.json</code> files the per-store pages
are built from, plus <code>holdout_facts.json</code> exported by Node, which is
the only process holding analytics credentials. No figure here is computed twice.</p>
<p>Opens from a <code>file://</code> URL: no CDN, no fonts, no script tags.</p>
</div>

</div></body></html>"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--audit", required=True)
    ap.add_argument("--months", default="2026-03,2026-04")
    args = ap.parse_args()
    audit = Path(args.audit).resolve()
    months = [m.strip() for m in args.months.split(",") if m.strip()]
    stores = load(audit, months)
    facts_path = audit / "holdout_facts.json"
    facts = (json.loads(facts_path.read_text(encoding="utf-8"))
             if facts_path.exists() else None)
    out = audit / "ENGINE_SCORECARD.html"
    out.write_text(build(stores, facts, months), encoding="utf-8")
    print(f"  wrote {out}  ({out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
