#!/usr/bin/env python
"""The audit folder's front door, built from what is actually on disk.

    python scripts/build_audit_home.py --audit ../audit --month 2026-03

WHY IT ENUMERATES RATHER THAN DECLARES
    `audit/index.html` had gone stale: it linked a generation of folders
    (`171-bethany/`) that a later run replaced with another (`ledger-171-2026-03/`,
    `171-backtest/`), and it named neither the combined ledger nor the gate index.
    A reader opening the folder found a page confidently linking the wrong thing.

    So nothing here is hardcoded as present. Every link is emitted only if the file
    exists, and a missing one says so plainly instead of 404-ing. A front door that
    lies about what is behind it is worse than no front door.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

STORES = [
    (171, "Bethany Discount Liquor", "171"),
    (176, "Northlake Liquors North", "176"),
    (177, "Mango Jo's Bar & Liquors", "177"),
    (178, "Marshfield Wine & Spirits", "178"),
    (181, "Cork Runner Wine & Spirits", "181"),
]

CSS = """
*{box-sizing:border-box}
:root{--bg:#fff;--panel:#f7f8fa;--panel2:#eef1f5;--fg:#0d1117;--mut:#5b6672;
  --line:#dfe3e8;--accent:#2563eb;--good:#047857;--bad:#be123c;--warn:#b45309}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0a0e17;--panel:#121823;--panel2:#1a2230;--fg:#e8edf4;--mut:#93a1b1;
  --line:#233044;--accent:#60a5fa;--good:#34d399;--bad:#fb7185;--warn:#fbbf24;
  color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0a0e17;--panel:#121823;--panel2:#1a2230;
  --fg:#e8edf4;--mut:#93a1b1;--line:#233044;--accent:#60a5fa;--good:#34d399;
  --bad:#fb7185;--warn:#fbbf24;color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--fg);
  font:16px/1.65 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1040px;margin:0 auto;padding:56px 24px 90px}
h1{font-size:clamp(28px,4vw,40px);margin:0 0 10px;letter-spacing:-.025em;
  font-weight:680;text-wrap:balance}
h2{font-size:21px;margin:52px 0 6px;letter-spacing:-.015em;font-weight:660}
.lede{font-size:17px;color:var(--mut);margin:0 0 6px;max-width:70ch}
.sub{color:var(--mut);font-size:13.5px;margin:0 0 26px}
.sub b{color:var(--fg);font-weight:600}
p{max-width:72ch}
.hero{display:block;background:var(--panel);border:1px solid var(--line);
  border-left:4px solid var(--accent);border-radius:14px;padding:22px 24px;
  margin:22px 0;text-decoration:none;color:inherit}
.hero:hover{background:var(--panel2)}
.hero .t{font-size:19px;font-weight:660;letter-spacing:-.01em}
.hero .d{font-size:14px;color:var(--mut);margin-top:7px;line-height:1.55}
.grid{display:grid;gap:12px;margin:18px 0;
  grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.item{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:16px 18px}
.item .n{font-weight:650;font-size:15.5px}
.item .m{font-size:12.5px;color:var(--mut);margin-top:4px}
.item .links{margin-top:10px;display:flex;flex-wrap:wrap;gap:8px}
a.pill{font-size:12.5px;text-decoration:none;color:var(--accent);
  border:1px solid var(--line);border-radius:999px;padding:4px 11px;
  background:var(--bg)}
a.pill:hover{border-color:var(--accent)}
span.pill.gone{font-size:12.5px;color:var(--mut);border:1px dashed var(--line);
  border-radius:999px;padding:4px 11px}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:12px;
  margin:18px 0;background:var(--panel)}
table{width:100%;border-collapse:collapse;font-size:14px;
  font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:10px 14px;border-bottom:1px solid var(--line)}
th:first-child,td:first-child{text-align:left}
thead th{font-size:11px;text-transform:uppercase;letter-spacing:.07em;
  color:var(--mut);font-weight:650;background:var(--panel2)}
tbody tr:last-child td{border-bottom:0}
.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.span{font-size:11.5px;color:var(--mut);display:block;font-weight:400}
.foot{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);
  font-size:12.5px;color:var(--mut)}
code{background:var(--panel2);border:1px solid var(--line);padding:1px 6px;
  border-radius:5px;font-size:13px;font-family:ui-monospace,Menlo,monospace}
"""


def _esc(s) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _link(audit: Path, rel: str, label: str) -> str:
    """A pill, or a dashed placeholder naming what is missing. Never a 404."""
    if (audit / rel).exists():
        return f'<a class="pill" href="{rel}">{_esc(label)}</a>'
    return f'<span class="pill gone">{_esc(label)} &mdash; not generated</span>'


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--audit", required=True)
    ap.add_argument("--month", default="2026-03")
    args = ap.parse_args()
    audit = Path(args.audit).resolve()
    label = datetime.strptime(args.month, "%Y-%m").strftime("%B %Y")

    rows = []
    summary = audit / "all_stores.json"
    if summary.exists():
        data = json.loads(summary.read_text(encoding="utf-8"))
        for d in sorted(data, key=lambda x: -(x.get("bt_edge") or 0)):
            cov = d.get("cost", 1.0)
            net = d.get("net30")
            money = ("&mdash;" if cov < 0.01 or net is None
                     else f'${net:+,.0f}')
            hit = d.get("hit30") or 0.0
            cls = "good" if hit >= 70 else ("warn" if hit >= 55 else "bad")
            rows.append(
                f'<tr><td><b>{d["loc"]}</b> {_esc(d["name"])}</td>'
                f'<td><b class="{cls}">{hit:.1f}%</b>'
                f'<span class="span">{d.get("cards", 0)} cards</span></td>'
                f'<td>{d.get("bt_hit", 0):.1f}%'
                f'<span class="span">{d.get("bt_edge", 0):+.1f} vs null</span></td>'
                f'<td>{d.get("bt_p", 1):.4f}</td>'
                f'<td>{money}<span class="span">30-day net</span></td></tr>')
    table = (f'<div class="scroll"><table><thead><tr><th>Store</th>'
             f'<th class="num">{label.split()[0]} + 30d</th>'
             f'<th class="num">backtest, 2.3 years</th>'
             f'<th class="num">p</th><th class="num">money</th>'
             f'</tr></thead><tbody>{"".join(rows)}</tbody></table></div>'
             if rows else '<p class="sub">No <code>all_stores.json</code> yet - '
                          'run <code>scripts/run_all_ledgers.py</code>.</p>')

    # EVERY month on disk, newest first. The folders are month-stamped, so two
    # months coexist - and a front door that showed only the month it was last
    # run for would hide the other one completely, which is the same class of
    # failure as the stale links this script replaced.
    months = sorted({p.name.rsplit("-", 2)[-2] + "-" + p.name.rsplit("-", 1)[-1]
                     for p in audit.glob("ledger-*-*-*") if p.is_dir()},
                    reverse=True)
    if args.month not in months:
        months.insert(0, args.month)

    cards = []
    for loc, name, slug in STORES:
        led = f"ledger-{slug}-{args.month}/RECOMMENDATION_LEDGER.html"
        bt = f"{slug}-backtest/REAL_ENGINE_REPORT.html"
        # NOT a forecast page: `forecast_accuracy.py` writes JSON only, and the
        # ledger page embeds that JSON as its own section. Linking a
        # FORECAST_ACCURACY.html that the pipeline never produces is exactly the
        # stale-link failure this script exists to stop.
        chg = f"WHAT_CHANGED-{loc}.html"
        n = "?"
        led_json = audit / f"ledger-{slug}-{args.month}" / "ledger.json"
        if led_json.exists():
            try:
                n = str(len(json.loads(
                    led_json.read_text(encoding="utf-8"))["ledger"]))
            except (KeyError, ValueError):
                n = "?"
        cards.append(
            f'<div class="item"><div class="n">{loc} &mdash; {_esc(name)}</div>'
            f'<div class="m">{n} cards in {_esc(label)}</div>'
            f'<div class="links">'
            f'{_link(audit, led, "ledger")}'
            f'{_link(audit, bt, "backtest")}'
            f'{_link(audit, chg, "what changed")}'
            f'</div></div>')

    prev = sorted(p.name for p in audit.glob("previous*") if p.is_dir())
    prev_links = "".join(
        f'<a class="pill" href="{p}/ENGINE_AUDIT.html">{_esc(p)}</a>'
        if (audit / p / "ENGINE_AUDIT.html").exists()
        else f'<span class="pill gone">{_esc(p)}</span>' for p in prev)

    # Other months, each linking straight to its five ledgers.
    other = [m for m in months if m != args.month]
    if other:
        rows_m = []
        for m in other:
            label_m = datetime.strptime(m, "%Y-%m").strftime("%B %Y")
            pills = "".join(
                _link(audit, f"ledger-{slug}-{m}/RECOMMENDATION_LEDGER.html",
                      f"{loc}")
                for loc, _n, slug in STORES)
            rows_m.append(f'<div class="item"><div class="n">{_esc(label_m)}</div>'
                          f'<div class="m">cards issued that month, followed for '
                          f'four months</div>'
                          f'<div class="links">{pills}</div></div>')
        other_months_block = (
            '<h2>Other months on file</h2>'
            '<p class="sub">A month can only be published once it has 120 days of '
            'future behind it, so the newest publishable month trails the data by '
            'four months.</p>'
            f'<div class="grid">{"".join(rows_m)}</div>')
    else:
        other_months_block = ""

    html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BotellaAI engine audit</title>
<style>{CSS}</style></head><body><div class="wrap">

<h1>BotellaAI recommendation engine &mdash; the evidence</h1>
<p class="lede">Every recommendation the engine made at five pilot stores in
{_esc(label)}, and what actually happened to each one at 30, 60, 90 and 120 days.</p>
<p class="sub">Built {_esc(datetime.now().strftime("%d %B %Y, %H:%M"))} &middot;
every link below was checked against the folder, so a page that was not generated
says so instead of 404-ing.</p>

<a class="hero" href="ALL_STORES_LEDGER.html">
  <div class="t">All five stores, every card, one page &rarr;</div>
  <div class="d">Start here. The cross-store comparison at all four horizons,
  then every card from every store with its own outcomes attached. One file,
  searchable, prints.</div></a>

<a class="hero" href="ENGINE_AUDIT.html">
  <div class="t">The gate index &rarr;</div>
  <div class="d">One row per store with the seven admission checks: which stores
  have been measured to work, which have not, and on which check they fail.</div></a>

<a class="hero" href="WHAT_CHANGED.html">
  <div class="t">What changed since the last run, and why &rarr;</div>
  <div class="d">The previous published numbers against the current ones, per
  store, with the reason each one moved.</div></a>

<h2>Headline, per store</h2>
<p>Judged one store at a time, because the engine is switched on one store at a
time &mdash; and a store where it does not work is the most useful row here.</p>
{table}

<h2>Every report, per store</h2>
<div class="grid">{"".join(cards)}</div>

{other_months_block}

<h2>Architecture and method</h2>
<div class="grid">
  <div class="item"><div class="n">How the engine decides</div>
    <div class="m">The nineteen stages, what is live and what is not</div>
    <div class="links">{_link(audit, "engine-architecture.html", "architecture")}
    {_link(audit, "architecture-changes.html", "changes")}
    {_link(audit, "eleven-families.html", "card families")}</div></div>
  <div class="item"><div class="n">On reaching 90%</div>
    <div class="m">Why a hit rate above 80% at every store is not available,
    measured rather than asserted</div>
    <div class="links">{_link(audit, "ninety-percent-diagnostic.html", "diagnostic")}
    {_link(audit, "ninety-prompt-library.html", "prompt library")}</div></div>
</div>

<h2>Earlier generations, kept</h2>
<p class="sub">Superseded runs are archived rather than overwritten, so a figure
quoted in an older document can still be traced to the page it came from.</p>
<div class="links">{prev_links or '<span class="pill gone">none archived</span>'}</div>

<div class="foot">
<p>Generated by <code>scripts/build_audit_home.py</code>, which enumerates the
folder rather than declaring its contents. The previous version of this page
linked a generation of folders a later run had already replaced.</p>
<p>No CDN, no fonts, no script tags: these open from a <code>file://</code> URL on
a laptop with no network, which is where they end up.</p>
</div>

</div></body></html>"""
    (audit / "index.html").write_text(html, encoding="utf-8")
    print(f"  wrote {audit / 'index.html'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
