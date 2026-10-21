#!/usr/bin/env python
"""Accuracy for every pilot store on ONE page, from what is on disk.

    python scripts/build_accuracy_summary.py --audit ../audit --month 2026-04

WHY A SEPARATE PAGE FROM THE COMBINED LEDGER
    `build_combined_ledger.py` puts every CARD on one page - the month, line by
    line. That answers "what did it recommend and what happened". It does not
    answer "how wrong is the number on the card", which is a different question
    with a different denominator: the ledger counts cards, the forecast harness
    counts store-product-horizons, and on Bethany that is 35 against 4,157.
    Pooling them onto one figure would be the kind of arithmetic this folder
    exists to prevent.

    So this page carries the three layers side by side, per store, and keeps
    them labelled:

      the month      hit rate and net margin on the cards actually issued
      the forecast   WAPE and bias against three baselines, out of sample
      the backtest   2.3 years at fortnightly spacing, with its null

NOTHING IS COMPUTED HERE. Every figure is read from the JSON the per-store runs
already wrote, so a number on this page and a number on a store page cannot
disagree. A missing file is printed as missing rather than defaulted - an audit
page that silently reads an absence as a zero is worse than one that admits a
gap.

THE BASELINE COMPARISON IS THE POINT. An engine WAPE of 43% means nothing on
its own; it means something next to the 48% a year-average gets on the same
store-product-horizons. Where the engine loses to a baseline the cell says so,
because that is the row a reader needs most.
"""
from __future__ import annotations

import argparse
import json
from datetime import date, datetime
from pathlib import Path
from typing import Any

STORES = [
    (171, "Bethany Discount Liquor", "Allen, TX", "171"),
    (176, "Northlake Liquors", "North Palm Beach, FL", "176"),
    (177, "Mango Jo's Bar & Liquors", "Ruskin, FL", "177"),
    (178, "Marshfield Wine & Spirits", "Calumet Park, IL", "178"),
    (181, "Cork Runner Wine & Spirits", "Los Angeles, CA", "181"),
]

HORIZONS = ("30", "60", "90", "120")
BASELINES = (("engine", "the engine"), ("year_average", "year average"),
             ("trailing_28", "trailing 28d"), ("last_year", "same weeks last year"))

CSS = """
:root{--bg:#fbfaf8;--pa:#fff;--tx:#1b1b1a;--tx2:#55534e;--mu:#8a8780;
--bd:#e6e3dd;--bd2:#d6d2c9;--ac:#1f5c3d;--bad:#8c2f21;--warn:#8a6d1f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:40px 20px 80px}
h1{font-size:30px;line-height:1.25;margin:0 0 10px;letter-spacing:-.02em}
h2{font-size:21px;margin:44px 0 6px;letter-spacing:-.01em}
h3{font-size:16px;margin:26px 0 6px}
.lede{font-size:17px;color:var(--tx2);margin:0 0 6px;max-width:68ch}
.sub{color:var(--mu);font-size:13.5px;margin:0 0 22px}
table{border-collapse:collapse;width:100%;font-size:13.5px;margin:10px 0 4px;
background:var(--pa)}
th,td{border:1px solid var(--bd);padding:7px 9px;text-align:right;
font-variant-numeric:tabular-nums}
th{background:#f3f1ec;font-weight:600;text-align:right;color:var(--tx2)}
th:first-child,td:first-child{text-align:left;font-variant-numeric:normal}
caption{caption-side:top;text-align:left;color:var(--mu);font-size:12.5px;
padding:4px 0 6px}
.win{color:var(--ac);font-weight:600}
.lose{color:var(--bad);font-weight:600}
.na{color:var(--mu)}
.note{color:var(--tx2);font-size:13px;max-width:72ch;margin:8px 0 0}
.miss{background:#fdf6e9;border:1px solid #e8dcc0;padding:10px 12px;
border-radius:6px;color:var(--warn);font-size:13.5px;margin:10px 0}
.scroll{overflow-x:auto}
a{color:var(--ac)}
"""


def esc(s: Any) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def pct(v: Any, dp: int = 1) -> str:
    return f"{float(v):.{dp}f}%" if isinstance(v, (int, float)) else '<span class="na">-</span>'


def num(v: Any, dp: int = 1) -> str:
    return f"{float(v):.{dp}f}" if isinstance(v, (int, float)) else '<span class="na">-</span>'


def money(v: Any) -> str:
    if not isinstance(v, (int, float)):
        return '<span class="na">-</span>'
    sign = "-" if v < 0 else ""
    return f"{sign}${abs(float(v)):,.0f}"


def outcome_months(month: str) -> list[str]:
    """The months the 30/60/90/120-day outcomes land in."""
    y, m = (int(p) for p in month.split("-")[:2])
    out = []
    for _ in range(4):
        m += 1
        if m > 12:
            m, y = 1, y + 1
        out.append(date(y, m, 1).strftime("%B"))
    return out


def read(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def collect(audit: Path, month: str) -> list[dict]:
    rows = []
    for loc, name, where, slug in STORES:
        led = read(audit / f"ledger-{slug}-{month}" / "ledger.json")
        acc = read(audit / f"forecast-{slug}" / "forecast_accuracy.json")
        bt = read(audit / f"{slug}-backtest" / "summary.json")
        rows.append({
            "loc": loc, "name": name, "where": where, "slug": slug,
            "ledger": led, "accuracy": acc, "backtest": bt,
            "report": (audit / f"{slug}-{slug}" / "REAL_ENGINE_REPORT.html"),
        })
    return rows


def month_table(rows: list[dict], first_outcome: str) -> str:
    head = ("<tr><th>store</th><th>cards</th><th>scored</th>"
            f"<th>hits</th><th>hit rate, {esc(first_outcome)}</th>"
            "<th>95% interval</th><th>median lift</th>"
            "<th>net margin</th><th>per card</th></tr>")
    body = []
    for r in rows:
        led = r["ledger"]
        if not led:
            body.append(f'<tr><td>{esc(r["name"])}</td>'
                        f'<td colspan="8" class="na">no ledger for this month</td></tr>')
            continue
        s = (led.get("summary") or {}).get("30") or {}
        ci = (f'{num(s.get("ci_lo"))}&ndash;{num(s.get("ci_hi"))}'
              if isinstance(s.get("ci_lo"), (int, float)) else '<span class="na">-</span>')
        body.append(
            f'<tr><td>{esc(r["name"])}</td>'
            f'<td>{len(led.get("ledger") or [])}</td>'
            f'<td>{s.get("n", 0)}</td><td>{s.get("hits", 0)}</td>'
            f'<td><b>{pct(s.get("hit_rate"))}</b></td><td>{ci}</td>'
            f'<td>{num(s.get("median_lift"), 2)}</td>'
            f'<td>{money(s.get("net_margin"))}</td>'
            f'<td>{money(s.get("net_margin_per_card"))}</td></tr>')
    return ("<div class='scroll'><table><caption>One row per store. The hit rule "
            "is lift &ge; 1.0: the product sold at least what its own trailing "
            "rate projected over the 30 days after the card. Net margin is "
            "margin captured less the cost of holding what did not sell.</caption>"
            + head + "".join(body) + "</table></div>")


def accuracy_table(rows: list[dict]) -> str:
    out = []
    for r in rows:
        acc = r["accuracy"]
        out.append(f'<h3>{esc(r["name"])} <span class="na">&middot; '
                   f'{esc(r["where"])}</span></h3>')
        if not acc:
            out.append('<div class="miss">No forecast-accuracy file on disk for '
                       'this store, so nothing is claimed about its quantities.</div>')
            continue
        hz = acc.get("horizons") or {}
        head = ("<tr><th>horizon</th>" + "".join(
            f"<th>{esc(label)}</th>" for _, label in BASELINES)
            + "<th>engine bias</th><th>n</th></tr>")
        body = []
        for h in HORIZONS:
            cell = hz.get(h) or {}
            if not cell:
                continue
            eng = (cell.get("engine") or {}).get("wape_units")
            tds = []
            for key, _ in BASELINES:
                v = (cell.get(key) or {}).get("wape_units")
                if not isinstance(v, (int, float)):
                    tds.append('<td class="na">-</td>')
                    continue
                if key == "engine":
                    tds.append(f"<td><b>{v:.1f}%</b></td>")
                else:
                    # LOWER WAPE IS BETTER. A baseline the engine loses to is
                    # the most useful cell on the page, so it is coloured as a
                    # loss rather than left for the reader to compare by eye.
                    worse = isinstance(eng, (int, float)) and v < eng
                    cls = "lose" if worse else "win"
                    tds.append(f'<td class="{cls}">{v:.1f}%</td>')
            bias = (cell.get("engine") or {}).get("bias")
            body.append(f"<tr><td>{h} days</td>" + "".join(tds)
                        + f"<td>{num(bias)}%</td><td>{cell.get('n', 0):,}</td></tr>")
        out.append(
            "<div class='scroll'><table><caption>WAPE on units, lower is better, "
            "measured on every store-product-horizon rather than on cards. A "
            "baseline shown in red beat the engine on that horizon. Bias is the "
            "signed error: positive over-forecasts.</caption>"
            + head + "".join(body) + "</table></div>")
        sc = acc.get("scored_dates")
        cal = acc.get("calibration_dates")
        if sc or cal:
            out.append(f'<p class="sub">{sc or 0} scored decision dates, '
                       f'{cal or 0} held back to fit the confidence curve - the '
                       f'curve is never scored on the dates it was fitted on.</p>')
    return "".join(out)


def backtest_table(rows: list[dict]) -> str:
    head = ("<tr><th>store</th><th>cards</th><th>hit rate</th>"
            "<th>clustered 95%</th><th>reversion null</th><th>edge</th>"
            "<th>p</th><th>cards/run</th></tr>")
    body = []
    for r in rows:
        bt = r["backtest"]
        if not bt:
            body.append(f'<tr><td>{esc(r["name"])}</td>'
                        '<td colspan="7" class="na">no backtest summary</td></tr>')
            continue
        s20 = bt.get("sheet20") or {}
        null = bt.get("null_reversion")
        hit = s20.get("hit_rate")
        edge = (hit - null) if isinstance(hit, (int, float)) and isinstance(null, (int, float)) else None
        cci = bt.get("clustered_ci") or []
        cci_s = (f"{cci[0]:.1f}&ndash;{cci[1]:.1f}" if len(cci) == 2
                 else '<span class="na">-</span>')
        p = bt.get("p_value")
        body.append(
            f'<tr><td>{esc(r["name"])}</td><td>{s20.get("n", 0):,}</td>'
            f'<td><b>{pct(hit)}</b></td><td>{cci_s}</td><td>{pct(null)}</td>'
            f'<td class="{"win" if isinstance(edge, float) and edge > 0 else "lose"}">'
            f'{("+" if isinstance(edge, float) and edge > 0 else "")}{num(edge)}</td>'
            f'<td>{("%.4f" % p) if isinstance(p, (int, float)) else "-"}</td>'
            f'<td>{num(bt.get("cards_per_run"), 2)}</td></tr>')
    return ("<div class='scroll'><table><caption>Walk-forward over the whole "
            "export at fortnightly spacing - the quotable figure, because it is "
            "many months rather than one. The null is the same selection rule "
            "with the reversion signal removed; the edge is the engine less that "
            "null, and p is the randomisation test against it.</caption>"
            + head + "".join(body) + "</table></div>")


def build(rows: list[dict], month: str) -> str:
    label = datetime.strptime(month, "%Y-%m").strftime("%B %Y")
    oms = outcome_months(month)
    first = oms[0]
    four = ", ".join(oms[:3]) + " and " + oms[3]
    have = [r for r in rows if r["ledger"]]
    missing = [r for r in rows if not r["ledger"]]
    total_cards = sum(len(r["ledger"].get("ledger") or []) for r in have)
    n30 = sum(((r["ledger"].get("summary") or {}).get("30") or {}).get("n", 0)
              for r in have)
    h30 = sum(((r["ledger"].get("summary") or {}).get("30") or {}).get("hits", 0)
              for r in have)
    pooled = (100.0 * h30 / n30) if n30 else None

    miss_html = ""
    if missing:
        names = ", ".join(esc(r["name"]) for r in missing)
        miss_html = (f'<div class="miss">No {esc(label)} ledger on disk for '
                     f'{names}. Those stores are absent from the figures above '
                     f'rather than counted as zero.</div>')

    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accuracy, five stores, {esc(label)}</title>
<style>{CSS}</style></head><body><div class="wrap">

<h1>How accurate was the engine on {esc(label)} cards?</h1>
<p class="lede">Three layers, kept apart because they answer different
questions and have different denominators. Cards issued in {esc(label)} are
scored at 30, 60, 90 and 120 days, which means outcomes measured in
{esc(four)}.</p>
<p class="sub"><b>{total_cards}</b> cards across <b>{len(have)}</b> store(s)
&middot; pooled 30-day hit rate <b>{pct(pooled)}</b> ({h30} of {n30} scored)
&middot; generated {esc(datetime.now().strftime("%Y-%m-%d %H:%M"))}</p>
{miss_html}

<h2>1. The month &mdash; the cards it actually issued</h2>
<p class="note">Counted per card. This is the figure an owner experiences,
and the smallest sample of the three: one month of one store is tens of
cards, so read the interval and not the point.</p>
{month_table(rows, first)}

<h2>2. The forecast &mdash; how wrong the quantity was</h2>
<p class="note">Counted per store-product-horizon, which is thousands of
observations rather than tens, and measured against three baselines on the
same rows. An engine error means nothing alone; it means something next to
what a year average achieves on identical data.</p>
{accuracy_table(rows)}

<h2>3. The backtest &mdash; many months, not one</h2>
<p class="note">The quotable headline, because a single month at a single
store cannot separate the engine from the weather. Compared against its own
null: the same selection with the reversion signal removed.</p>
{backtest_table(rows)}

<h2>What this page does not say</h2>
<p class="note">It states no holdout effect. Separating &ldquo;the engine
picked products that were going to sell&rdquo; from &ldquo;recommending them
changed what sold&rdquo; needs the withheld arm, and that lives on the
scoreboards, which refuse the comparison until both arms carry five measured
product-windows. Nothing here is evidence that showing a card caused a
sale.</p>
</div></body></html>"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--audit", required=True)
    ap.add_argument("--month", default="2026-04")
    ap.add_argument("--out", default=None,
                    help="default: <audit>/ACCURACY-<month>.html")
    args = ap.parse_args()

    audit = Path(args.audit).resolve()
    rows = collect(audit, args.month)
    if not any(r["ledger"] for r in rows):
        print(f"no {args.month} ledgers under {audit} - "
              "run scripts/run_all_ledgers.py first")
        return 1
    out = Path(args.out) if args.out else audit / f"ACCURACY-{args.month}.html"
    out.write_text(build(rows, args.month), encoding="utf-8")
    for r in rows:
        led = r["ledger"]
        s = ((led.get("summary") or {}).get("30") or {}) if led else {}
        state = (f'{s.get("hit_rate", 0):.1f}% on {s.get("n", 0)} scored'
                 if led else "no ledger")
        print(f"  {r['loc']}  {r['name']}: {state}")
    print(f"\n-> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
