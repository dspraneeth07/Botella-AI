#!/usr/bin/env python
"""What the engine recommends TODAY, for a cohort, from whatever data each store has.

    python scripts/build_live_slate_report.py --runs <dir of {loc}.json> \
        --out ../audit-14/LIVE_SLATES.html --cohort ../audit-14/cohort.json

HOW THIS DIFFERS FROM THE LEDGER
    The ledger is retrospective: it replays a past month and scores each card
    against what actually happened, which needs seventeen months of history and
    is how ACCURACY is established.

    This is the engine speaking now. It needs only what the store has today, so a
    shop with thirty days of sales appears here and cannot appear there. Both are
    honest and they answer different questions - "is it right" and "what does it
    say" - and conflating them is how a store with no history gets written off as
    unservable when it is already being served.

NO OUTCOMES, AND THE PAGE SAYS SO
    Every card here is a forecast with no result attached, because the window has
    not closed. There is no hit rate on this page and there must not be one: the
    only number that could be printed is the engine's own confidence, which is a
    claim rather than a measurement.

AN EMPTY SLATE IS A ROW, NOT A GAP
    A store whose POS has never synced gets a line saying so. That is the most
    actionable row on the page for most of this cohort, and leaving it blank would
    hide the one thing somebody can fix today.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from scripts._ledger_report import CSS, _esc  # noqa: E402

#: Why a store produced nothing, keyed on what the payload shows.
EMPTY_REASONS = {
    "no_products": ("No products on file",
                    "The store is onboarded and its catalogue is empty. Nothing "
                    "has synced from the POS, so there is no shelf to reason "
                    "about.", "POS sync"),
    "no_candidates": ("Catalogue present, nothing in stock",
                      "Products exist and none are in stock, so there is no "
                      "candidate to reorder or mark down. Usually a stock feed "
                      "that has not run.", "POS sync"),
    "no_sales": ("Stock on the shelf, no sales history",
                 "The catalogue and stock levels are there and no sale has ever "
                 "synced. Demand is what the engine reasons from, so it can "
                 "describe the shelf and cannot yet rank it.", "POS sync"),
    "nothing_qualified": ("Nothing cleared the bar",
                          "The store has sales and stock and no product cleared "
                          "the materiality and confidence gates today. This is a "
                          "real answer, and it changes day to day.", "none"),
}


def classify_empty(payload: dict) -> str:
    if payload.get("error"):
        return "no_candidates"
    if not payload.get("candidate_count"):
        return "no_products"
    return "nothing_qualified"


def card_html(rec: dict) -> str:
    kind = _esc(rec.get("action_type") or "card")
    skus = ", ".join(_esc(s) for s in (rec.get("primary_skus") or [])[:4])
    extra = len(rec.get("primary_skus") or []) - 4
    if extra > 0:
        skus += f" <span class=\"span\">and {extra} more</span>"
    hint = rec.get("quantity_hint")
    conf = rec.get("confidence")
    basis = rec.get("confidence_basis") or ""
    cited = rec.get("signals_cited") or []
    bits = []
    if hint:
        bits.append(f'<div class="body">{_esc(hint)}</div>')
    bits.append(f'<div class="why"><b>Why:</b> {_esc(rec.get("rationale") or "")}</div>')
    foot = []
    if conf is not None:
        label = ("the store's overall rate, not this card's"
                 if rec.get("confidence_discriminates") is False
                 else _esc(basis) or "ranking score")
        foot.append(f"confidence {conf:.2f} &middot; {label}")
    if cited:
        foot.append("cites " + ", ".join(f"<code>{_esc(c)}</code>" for c in cited))
    if rec.get("suggested_order_qty"):
        foot.append(f"order {rec['suggested_order_qty']}")
    if foot:
        bits.append(f'<div class="conf">{" &middot; ".join(foot)}</div>')
    return (f'<div class="card"><div class="head">'
            f'<span class="span">{kind}</span> {skus}</div>'
            f'{"".join(bits)}</div>')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--runs", required=True)
    ap.add_argument("--cohort", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    runs = Path(args.runs)
    cohort = json.loads(Path(args.cohort).read_text(encoding="utf-8"))
    names = {int(c["loc"]): c["name"] for c in cohort if c.get("loc")}

    stores, missing = [], []
    for entry in cohort:
        loc = entry.get("loc")
        if not loc:
            missing.append(entry)
            continue
        path = runs / f"{loc}.json"
        if not path.exists():
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        stores.append((int(loc), entry["name"], payload))

    served = [(l, n, p) for l, n, p in stores if p.get("recommendations")]
    empty = [(l, n, p) for l, n, p in stores if not p.get("recommendations")]
    total_cards = sum(len(p["recommendations"]) for _l, _n, p in served)

    rows = []
    for loc, name, p in sorted(served, key=lambda t: -len(t[2]["recommendations"])):
        recs = p["recommendations"]
        kinds: dict[str, int] = {}
        for r in recs:
            kinds[r["action_type"]] = kinds.get(r["action_type"], 0) + 1
        mix = " &middot; ".join(f"{v} {_esc(k)}" for k, v in sorted(kinds.items()))
        rows.append(
            f'<tr><td><b>{loc}</b> {_esc(name)}</td>'
            f'<td><b class="good">{len(recs)}</b></td>'
            f'<td>{mix}</td>'
            f'<td>{p.get("candidate_count", 0)}'
            f'<span class="span">candidates considered</span></td></tr>')

    blocks = []
    for loc, name, p in sorted(served, key=lambda t: -len(t[2]["recommendations"])):
        recs = p["recommendations"]
        blocks.append(
            f'<h2><span class="num">{loc}</span>{_esc(name)}</h2>'
            f'<p class="sub"><b>{len(recs)}</b> recommendations &middot; '
            f'{p.get("candidate_count", 0)} candidates considered &middot; '
            f'data as of {_esc(p.get("data_as_of", "?"))}</p>'
            + "".join(card_html(r) for r in recs))

    by_reason: dict[str, list] = {}
    for loc, name, p in empty:
        by_reason.setdefault(classify_empty(p), []).append((loc, name, p))
    for entry in missing:
        by_reason.setdefault("not_onboarded", []).append(
            (0, entry["name"], {"note": entry.get("note", "")}))

    empty_blocks = []
    for reason, items in sorted(by_reason.items(), key=lambda kv: -len(kv[1])):
        if reason == "not_onboarded":
            title, why, owner = ("Not in the warehouse",
                                 "No store of this name exists in "
                                 "<code>client_locations</code>.", "onboarding")
        else:
            title, why, owner = EMPTY_REASONS[reason]
        lis = "".join(
            f'<tr><td><b>{_esc(n)}</b>'
            + (f'<span class="span">location {l}</span>' if l else "")
            + f'</td><td>{p.get("candidate_count", 0) if l else "&mdash;"}</td></tr>'
            for l, n, p in sorted(items, key=lambda t: t[1]))
        empty_blocks.append(
            f'<h3>{_esc(title)} &mdash; {len(items)} location'
            f'{"s" if len(items) != 1 else ""} '
            f'<span class="span">fixed by: {_esc(owner)}</span></h3>'
            f'<p>{why}</p>'
            f'<div class="scroll"><table><thead><tr><th>Location</th>'
            f'<th class="num">candidates</th></tr></thead>'
            f'<tbody>{lis}</tbody></table></div>')

    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live slates &middot; cohort</title>
<style>{CSS}</style></head><body><div class="wrap">

<h1>What the engine recommends today</h1>
<p class="lede">Every store in the cohort, run through the live route against
whatever data it has right now &mdash; not a replay of a past month, and not
dependent on having years of history.</p>
<p class="sub"><b>{len(served)}</b> of <b>{len(stores) + len(missing)}</b>
locations produced recommendations &middot; <b>{total_cards}</b> cards &middot;
generated {_esc(datetime.now().strftime("%d %B %Y, %H:%M"))}</p>

<div class="band">
<h3>These are forecasts, and there is no hit rate on this page</h3>
<p>Every card here was issued today and its window has not closed, so no outcome
exists to score it against. The only figure that could be printed is the engine's
own confidence, which is a claim rather than a measurement &mdash; and where the
calibration curve returns the same value for every card in a run, the card says so
in those words instead of letting it read as this card's own chance.</p>
<p>Accuracy lives in the ledger, which replays a finished month and scores each
card against what actually happened. A store needs about seventeen months of
history to appear there and about one month to appear here. <b>Backtestable and
recommendable are not the same thing</b>, and four of these stores are being
served today while being far too new to measure.</p>
</div>

<h2><span class="num">00</span>Who got what</h2>
<div class="scroll"><table>
<thead><tr><th>Store</th><th class="num">cards</th><th>mix</th>
<th class="num">pool</th></tr></thead>
<tbody>{"".join(rows) or '<tr><td colspan="4">nothing served</td></tr>'}</tbody>
</table></div>

{"".join(blocks)}

<h2><span class="num">99</span>The stores that produced nothing, and why</h2>
<p>Grouped by who can fix it. For most of this cohort the answer is a POS sync
that has never run &mdash; not an engine limit.</p>
{"".join(empty_blocks)}

<div class="foot">
<p>Generated by <code>scripts/build_live_slate_report.py</code> from the raw
<code>/run-recommendations</code> payloads, so every card here is exactly what the
API returned. No CDN, no fonts, no script tags.</p>
</div>

</div></body></html>"""

    out = Path(args.out)
    out.write_text(page, encoding="utf-8")
    print(f"  wrote {out}")
    print(f"  {len(served)} of {len(stores) + len(missing)} locations served, "
          f"{total_cards} cards, {out.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
