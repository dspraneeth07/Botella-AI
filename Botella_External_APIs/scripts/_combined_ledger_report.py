"""Five stores, one month, every card - on a single page.

WHY A SEPARATE PAGE AND NOT JUST THE INDEX
    `ENGINE_AUDIT.html` is an index: one row per store, a headline figure, a link.
    That is the right shape for deciding which store to look at and the wrong
    shape for reading the evidence, because the evidence is the cards and the
    index has none of them.

    This page is the other half. Every card every store issued in the month, with
    its own four outcomes attached, in one file you can open once and search.

WHAT IT ADDS BEYOND FIVE SEPARATE LEDGERS
    The comparison. A per-store ledger cannot show that a horizon which helps
    Bethany hurts Northlake, because it only has Bethany in it. The matrix near
    the top is the only place in the audit where the same question is asked of all
    five stores side by side at all four horizons.

ONE RULE, INHERITED FROM THE PER-STORE LEDGER
    Every card is published, including the bad ones. No sampling, no top-N of the
    results, no "representative examples". A report that shows only the winners is
    marketing and the reader can tell.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from scripts._ledger_report import CSS, HORIZONS, _esc, _money, window_label


def _rate_cell(hits: int, n: int) -> str:
    """A rate with its DENOMINATOR, always. 100% of two cards is not a result,
    and a rate printed without its n invites it to be read as one."""
    if not n:
        return '<td><span class="span">no scored cards</span></td>'
    rate = hits / n * 100.0
    cls = "good" if rate >= 70.0 else ("warn" if rate >= 55.0 else "bad")
    return (f'<td><b class="{cls}">{rate:.1f}%</b>'
            f'<span class="span">{hits} of {n}</span></td>')


def _pooled(stores: list[dict], h: int) -> tuple[int, int, float, int]:
    """(hits, n, net margin, priced cards) across every store at one horizon.

    Pooled by CARD, not by averaging store rates. A mean of five percentages
    weights a store that issued 12 cards the same as one that issued 180, which
    is how a quiet store comes to dominate an estate figure.
    """
    hits = n = priced = 0
    money = 0.0
    for s in stores:
        row = s["summary"].get(str(h)) or {}
        hits += int(row.get("hits") or 0)
        n += int(row.get("n") or 0)
        if row.get("net_margin") is not None and s["cost_coverage"] >= 0.01:
            money += float(row["net_margin"])
            priced += int(row.get("cards_with_money") or 0)
    return hits, n, money, priced


def _store_cards(store: dict) -> str:
    """Every card this store issued, grouped by the morning it was issued on."""
    ledger, days, cov = store["ledger"], store["trading_days"], store["cost_coverage"]
    blocks = []
    for day in sorted({r["as_of"] for r in ledger}):
        today = sorted([r for r in ledger if r["as_of"] == day],
                       key=lambda x: x["rank"])
        cards = []
        for r in today:
            c = r["card"]
            tiles = []
            for h in HORIZONS:
                o = (r.get("outcomes") or {}).get(str(h))
                if not o or o.get("lift") is None:
                    continue
                month, _span = window_label(days, h)
                hit = bool(o["hit"])
                money = "" if cov < 0.01 else (
                    f' &middot; {_money(o.get("margin_impact"), cov)}')
                # The interval, where one was published. It is the claim the
                # gate's coverage check tests, so a reader should be able to see
                # whether THIS card's actual landed inside it.
                band = o.get("interval") or {}
                inside = o.get("interval_covers")
                band_txt = ""
                if band.get("low") is not None:
                    mark = "in" if inside else "outside"
                    band_txt = (f'<span class="span">said {band["low"]}&ndash;'
                                f'{band["high"]}, got {o["actual"]:,.0f} '
                                f'({mark})</span>')
                tiles.append(
                    f'<div class="o {"hit" if hit else "miss"}">'
                    f'<div class="ow">{_esc(month)} &middot; {h}d</div>'
                    f'<div class="ov">{o["lift"]:.2f}&times;</div>'
                    f'<div class="od">{"hit" if hit else "miss"} &middot; '
                    f'{o["gained_units"]:+,.0f} units{money}</div>'
                    f'{band_txt}</div>')
            repeat = (f' <span class="span">day {r["day_of_claim"]} of this '
                      f'claim</span>' if r.get("day_of_claim", 1) > 1 else "")
            cards.append(
                f'<div class="card"><div class="head">{_esc(c["headline"])}'
                f'{repeat}</div>'
                f'<div class="body">{_esc(c["detail"])}</div>'
                f'<div class="why"><b>Why:</b> {_esc(c["why"])}</div>'
                f'<div class="conf">{_esc(c["confidence"])}</div>'
                f'<div class="out">{"".join(tiles)}</div></div>')
        blocks.append(
            f'<div class="day"><div class="dayhead">'
            f'<span class="d">{_esc(day)}</span>'
            f'<span class="c">{len(today)} card'
            f'{"s" if len(today) != 1 else ""}</span></div>'
            f'{"".join(cards)}</div>')
    return "".join(blocks)


def _store_retirements(store: dict) -> str:
    rets = store.get("retirements") or []
    if not rets:
        return ('<p class="sub">No card was retired this month: none of them '
                'started failing visibly enough to withdraw.</p>')
    rows = "".join(
        f'<tr><td>{_esc(r["sku"])}'
        f'<span class="span">{_esc(str(r.get("product", ""))[:42])}</span></td>'
        f'<td>{_esc(r["issued_on"])}</td><td>{_esc(r["retired_on"])}</td>'
        f'<td>{r["days_shown"]}</td>'
        f'<td>{(r.get("recovery_ratio") or 0) * 100:.0f}%</td>'
        f'<td><b>{_esc(str(r["rule"]).replace("_", " "))}</b></td></tr>'
        for r in sorted(rets, key=lambda x: x["retired_on"]))
    return (
        f'<div class="scroll"><table><thead><tr><th>SKU</th><th>issued</th>'
        f'<th>retired</th><th class="num">days up</th>'
        f'<th class="num">recovery</th><th>rule</th></tr></thead>'
        f'<tbody>{rows}</tbody></table></div>')


def _outcome_months(month_label: str) -> list[str]:
    """The four months a card month's 30/60/90/120-day outcomes land in.

    HARDCODED BEFORE THIS. The page said "hit rate, April" and "for a month of
    March cards, means outcomes measured in April, May, June and July" - true
    for the March run it was written against and wrong for every other month.
    Asked for April cards it would have printed April's own name over figures
    measured in May, which is the one thing an audit page may not do.
    """
    try:
        first = datetime.strptime(month_label, "%B %Y")
    except ValueError:
        return ["", "", "", ""]
    out = []
    y, m = first.year, first.month
    for _ in range(4):
        m += 1
        if m > 12:
            m, y = 1, y + 1
        out.append(date(y, m, 1).strftime("%B"))
    return out


def build_combined(stores: list[dict], month_label: str) -> str:
    # The 30-day horizon lands in the month AFTER the cards were issued, so
    # every label below is derived rather than written.
    _om = _outcome_months(month_label)
    first_outcome = _om[0] or "the following month"
    four_outcomes = (", ".join(_om[:3]) + " and " + _om[3]) if _om[3] else "the four months after"
    """One page: the comparison first, then every card from every store."""
    total_cards = sum(len(s["ledger"]) for s in stores)
    total_skus = len({(s["loc"], r["sku"]) for s in stores for r in s["ledger"]})
    total_days = sum(len({r["as_of"] for r in s["ledger"]}) for s in stores)
    priced_stores = [s for s in stores if s["cost_coverage"] >= 0.01]

    h30, n30, money30, cards30 = _pooled(stores, 30)
    rate30 = (h30 / n30 * 100.0) if n30 else 0.0

    # ── the matrix: five stores x four horizons ───────────────────────────
    head_h = "".join(
        f'<th class="num">{window_label(stores[0]["trading_days"], h)[0]}'
        f'<span class="span">{h} days</span></th>' for h in HORIZONS)
    rows = []
    for s in sorted(stores, key=lambda x: -(x["summary"].get("30", {})
                                            .get("hit_rate") or 0)):
        cells = ""
        for h in HORIZONS:
            row = s["summary"].get(str(h)) or {}
            cells += _rate_cell(int(row.get("hits") or 0), int(row.get("n") or 0))
        net = s["summary"].get("30", {}).get("net_margin")
        rows.append(
            f'<tr><td><b>{s["loc"]}</b> {_esc(s["name"])}'
            f'<span class="span">{len(s["ledger"])} cards over '
            f'{len({r["as_of"] for r in s["ledger"]})} trading days</span></td>'
            f'{cells}'
            f'<td>{_money(net, s["cost_coverage"])}'
            f'<span class="span">30-day net</span></td></tr>')
    pooled_cells = ""
    for h in HORIZONS:
        ph, pn, _m, _c = _pooled(stores, h)
        pooled_cells += _rate_cell(ph, pn)
    rows.append(
        f'<tr><td><b>All five, pooled by card</b>'
        f'<span class="span">not a mean of the five rates</span></td>'
        f'{pooled_cells}'
        f'<td>{_money(money30, 1.0)}<span class="span">30-day net</span></td></tr>')

    # ── per-horizon detail, pooled ────────────────────────────────────────
    hrows = []
    for h in HORIZONS:
        ph, pn, pm, pc = _pooled(stores, h)
        month, span = window_label(stores[0]["trading_days"], h)
        hrows.append(
            f'<tr><td><span class="month">{_esc(month)}</span>'
            f'<span class="span">{h} days &middot; {_esc(span)}</span></td>'
            f'<td>{pn}</td>'
            f'<td><b>{(ph / pn * 100.0) if pn else 0:.1f}%</b></td>'
            f'<td>{_money(pm, 1.0)}</td>'
            f'<td>{pc}<span class="span">priced cards</span></td></tr>')

    # ── per-store sections ────────────────────────────────────────────────
    sections = []
    for i, s in enumerate(sorted(stores, key=lambda x: x["loc"]), start=1):
        sm = s["summary"].get("30") or {}
        kpis = []
        for label, value, detail in (
            ("cards issued", f'{len(s["ledger"])}',
             f'over {len({r["as_of"] for r in s["ledger"]})} trading days, '
             f'{len({r["sku"] for r in s["ledger"]})} distinct products'),
            (f"hit rate, {first_outcome}", f'{sm.get("hit_rate") or 0:.1f}%',
             f'{sm.get("hits") or 0} of {sm.get("n") or 0} scored at 30 days'),
            (f"net margin, {first_outcome}",
             _money(sm.get("net_margin"), s["cost_coverage"], signed=False),
             "after the cost of holding what did not sell"
             if s["cost_coverage"] >= 0.01 else "no cost data at this store"),
            ("retired early", f'{len(s.get("retirements") or [])}',
             "withdrawn once the claim was visibly failing"),
        ):
            kpis.append(f'<div class="k"><div class="v">{value}</div>'
                        f'<div class="l">{label}</div>'
                        f'<div class="d">{detail}</div></div>')
        sections.append(
            f'<h2><span class="num">{i:02d}</span>{s["loc"]} &mdash; '
            f'{_esc(s["name"])}</h2>'
            f'<p class="sub">Backtest over 2.3 years: '
            f'<b>{s["bt_hit"]:.1f}%</b> against a volume- and reversion-matched '
            f'null of <b>{s["bt_null"]:.1f}%</b> '
            f'(<b>{s["bt_hit"] - s["bt_null"]:+.1f}</b> points, '
            f'p&nbsp;=&nbsp;{s["bt_p"]:.4f}). Cost data on '
            f'{s["cost_coverage"] * 100:.0f}% of sold lines.</p>'
            f'<div class="kpis">{"".join(kpis)}</div>'
            f'<h3>Retired before the month ended</h3>'
            f'{_store_retirements(s)}'
            f'<h3>Every card, in the order it was issued</h3>'
            f'{_store_cards(s)}')

    money_note = (
        "Every money figure is an ABSENCE at any store below 1% cost coverage, "
        "never a zero." if len(priced_stores) < len(stores) else
        f"All {len(stores)} stores carry usable cost data, so every money figure "
        f"on this page is measured rather than assumed.")

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>All five stores &middot; {_esc(month_label)} recommendation ledger</title>
<style>{CSS}</style></head><body><div class="wrap">

<h1>Every recommendation, every store, {_esc(month_label)}</h1>
<p class="lede">The engine ran once per trading day at five stores, exactly as
production does. Each card it issued is below with what actually happened to it
at 30, 60, 90 and 120 days &mdash; which, for a month of {_esc(month_label.split()[0])}
cards, means outcomes measured in {_esc(four_outcomes)}.</p>
<p class="sub"><b>{total_cards}</b> cards &middot; <b>{total_skus}</b>
store-products &middot; <b>{total_days}</b> store-days &middot;
scored at four horizons &middot; {_esc(money_note)}</p>

<div class="kpis">
  <div class="k"><div class="v">{total_cards}</div>
    <div class="l">cards issued</div>
    <div class="d">every one published, including the losses</div></div>
  <div class="k"><div class="v">{rate30:.1f}%</div>
    <div class="l">hit rate, {_esc(first_outcome)}</div>
    <div class="d">{h30} of {n30} scored cards, pooled by card across all five
    stores</div></div>
  <div class="k"><div class="v">{_money(money30, 1.0, signed=False)}</div>
    <div class="l">net margin, {_esc(first_outcome)}</div>
    <div class="d">margin captured less the cost of holding what did not
    sell, on {cards30} priced cards</div></div>
  <div class="k"><div class="v">{len(stores)}</div>
    <div class="l">stores measured</div>
    <div class="d">judged one store at a time; the engine is switched on one
    store at a time</div></div>
</div>

<div class="band">
<h3>How to read a hit</h3>
<p>A card is a <b>hit</b> when the product sold more over the window than its own
trailing rate implied it would &mdash; a lift of 1.00&times; or better against the
baseline the card itself published. It is not "the store ordered it" and not "the
product sold something". The baseline is the SKU's own recent run-rate over open
days, so a product that was always going to sell is not credited to the engine.</p>
<p>A card scored at four horizons is <b>one decision watched for four months</b>,
not four decisions. The engine is not re-run per horizon; re-running it would be a
different store on a different day.</p>
</div>

<h2><span class="num">00</span>The comparison &mdash; five stores, four horizons</h2>
<p>The only table in the audit that asks the same question of every store at every
horizon. A rate without its denominator is not shown: 100% of two cards is not a
result.</p>
<div class="scroll"><table>
<thead><tr><th>Store</th>{head_h}<th class="num">money</th></tr></thead>
<tbody>{"".join(rows)}</tbody></table></div>

<h3>Pooled by horizon</h3>
<div class="scroll"><table>
<thead><tr><th>Window</th><th class="num">scored cards</th>
<th class="num">hit rate</th><th class="num">net margin</th>
<th class="num">priced</th></tr></thead>
<tbody>{"".join(hrows)}</tbody></table></div>

{"".join(sections)}

<div class="foot">
<p>Generated by <code>scripts/build_combined_ledger.py</code> from the same
<code>ledger.json</code> files the per-store pages are built from, so a figure
here and a figure there cannot disagree. Opens from a <code>file://</code> URL
with no network: no CDN, no fonts, no script tags.</p>
<p><b>What this page does and does not measure.</b> It measures the sheet-20
reorder path &mdash; temporal reversion, the materiality and confidence gates, the
merchandise screen, the calibrated confidence, the track-record screen and the
published interval. It does <b>not</b> measure the live route's stock families
(the export carries no on-hand, so there are no stockout or overstock cards here),
the signal families, or the slate's cash budget. Those are live on the serving
path and are reported in the engine handover, not here.</p>
</div>

</div></body></html>"""


__all__ = ["build_combined"]
