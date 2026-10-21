#!/usr/bin/env python
"""Backtest every pilot store and build one index over the results.

    node ../backend/scripts/export-store-sales.js all --out ../audit/data
    python scripts/run_pilot_audit.py --data ../audit/data --out ../audit

WHY PER STORE AND NOT POOLED
    A pooled figure across five stores answers a question nobody asked. The
    engine is switched on per store, so it has to be judged per store - and a
    store where it does NOT work is the most valuable row in the table, because
    finding it here costs a paragraph and finding it in a pilot costs a
    customer.

    Pooling would also let the largest store carry the result: Cork Runner has
    four times Bethany's line items, so a units-weighted average is mostly one
    store wearing five hats.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent

#: The five stores fit for purpose - the only ones where the engine can be
#: switched on without a data remediation step first.
PILOT = [
    (171, "Bethany Discount Liquor", "171-bethany"),
    (176, "Northlake Liquors North", "176-northlake"),
    (177, "Mango Jo's Bar & Liquors", "177-mangojos"),
    (178, "Marshfield Wine & Spirits", "178-marshfield"),
    (181, "Cork Runner Wine & Spirits", "181-corkrunner"),
]

#: Graded POOR on ECOSYSTEM data - customers, purchases and suppliers all zero.
#:
#: THAT GRADE DOES NOT MEASURE WHAT THIS ENGINE READS. The reorder engine uses
#: sales history and nothing else: no customer table, no purchase order, no
#: supplier record. A store can be useless for basket analysis or for supplier
#: negotiation and still be perfectly forecastable, and the only way to find
#: out is to run it rather than infer it from a grade.
#:
#: Route 106 alone carries 1,567,681 line items - more than any store in the
#: pilot set.
TIER2 = [
    (105, "Local Vine - Atlanta", "105-localvine"),
    (111, "Hanson Market & Liquors", "111-hanson"),
    (119, "Smart Mart", "119-smartmart"),
    (122, "Big Hollow Convenient", "122-bighollow"),
    (125, "Route 106 Wine & Spirits", "125-route106"),
]

COHORTS = {"pilot": PILOT, "tier2": TIER2, "all": PILOT + TIER2}


def run_one(loc: int, name: str, folder: str, data: Path, out: Path,
            every: int) -> dict | None:
    dest = out / folder
    cmd = [sys.executable, str(HERE / "real_engine_backtest.py"),
           "--data", str(data), "--file", f"store_{loc}_sale_items.csv.gz",
           "--store", name, "--every", str(every), "--out", str(dest)]
    print(f"\n{'=' * 78}\n  {loc}  {name}\n{'=' * 78}")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stdout[-2000:])
        print(proc.stderr[-2000:])
        print(f"  FAILED ({proc.returncode}) - continuing with the rest")
        return None
    for line in proc.stdout.splitlines():
        if any(k in line for k in ("HIT RATE", "REVERSION-matched", "p-value  ",
                                   "clustered by date", "cards per run",
                                   "DATA CONTRACT", "HARD null earned",
                                   "decision dates:")):
            print(line)
    summary = json.loads((dest / "summary.json").read_text(encoding="utf-8"))
    summary["location_id"] = loc
    summary["folder"] = folder
    return summary


def verdict(s: dict) -> tuple[str, str]:
    """Does the engine earn its place at this store?

    Two conditions, and both have to hold. A big edge that could be luck is not
    evidence, and a certain edge of half a point is not worth a card.
    """
    edge = s["sheet20"]["hit_rate"] - s["null_reversion"]
    sig = s["p_value"] < 0.05
    if edge >= 10 and sig:
        return ("SHIP", "good")
    if edge >= 5 and sig:
        return ("SHIP - smaller edge", "good")
    if sig:
        return ("MARGINAL", "warn")
    return ("DO NOT SHIP", "bad")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--every", type=int, default=14)
    ap.add_argument("--cohort", default="pilot", choices=sorted(COHORTS),
                    help="which set of stores to audit")
    ap.add_argument("--index", default="index.html",
                    help="filename for the comparison page")
    args = ap.parse_args()

    data, out = Path(args.data).resolve(), Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    results = []
    for loc, name, folder in COHORTS[args.cohort]:
        if not (data / f"store_{loc}_sale_items.csv.gz").exists():
            print(f"  {loc} {name}: export missing, skipped")
            continue
        r = run_one(loc, name, folder, data, out, args.every)
        if r:
            results.append(r)

    if not results:
        print("nothing ran")
        return 1

    (out / f"{args.cohort}_summary.json").write_text(
        json.dumps(results, indent=1, default=str), encoding="utf-8")
    write_index(results, out, args.index, args.cohort)

    print(f"\n{'=' * 78}\n  PILOT SUMMARY\n{'=' * 78}")
    print(f"{'store':>28} {'hit':>7} {'null':>7} {'edge':>7} {'p':>8} "
          f"{'cards/run':>10} {'verdict':>20}")
    for s in sorted(results, key=lambda x: -(x["sheet20"]["hit_rate"] - x["null_reversion"])):
        v, _ = verdict(s)
        print(f"{s['store_name'][:28]:>28} {s['sheet20']['hit_rate']:>6.1f}% "
              f"{s['null_reversion']:>6.1f}% "
              f"{s['sheet20']['hit_rate'] - s['null_reversion']:>+6.1f} "
              f"{s['p_value']:>8.4f} {s.get('cards_per_run', 0):>10.1f} {v:>20}")
    print(f"\n  wrote {out / args.index}")
    return 0


def write_index(results: list[dict], out: Path,
                filename: str = "index.html", cohort: str = "pilot") -> None:
    rows = []
    for s in sorted(results, key=lambda x: -(x["sheet20"]["hit_rate"] - x["null_reversion"])):
        v, cls = verdict(s)
        a = s["sheet20"]
        edge = a["hit_rate"] - s["null_reversion"]
        lo, hi = s["clustered_ci"]
        drops = len(s.get("dropped_lines") or [])
        # No cost in the feed means no margin. Printing "$0" for that would
        # read as a measurement of nothing earned rather than nothing known.
        money = ("<span class='sm'>no cost data</span>"
                 if s.get("cost_coverage", 1.0) < 0.01
                 else f'${a["impact_per_card"]:+,.0f}')
        rows.append(
            f'<tr><td><a href="{s["folder"]}/REAL_ENGINE_REPORT.html">'
            f'<b>{s["location_id"]}</b> {s["store_name"]}</a>'
            + (f'<br><span class="flag">{drops} bad line(s) refused</span>'
               if drops else "")
            + f'</td>'
            f'<td><b>{a["hit_rate"]:.1f}%</b><br><span class="sm">'
            f'{lo:.0f}&ndash;{hi:.0f}</span></td>'
            f'<td>{s["null_reversion"]:.1f}%</td>'
            f'<td class="{cls}"><b>{edge:+.1f}</b></td>'
            f'<td>{s["p_value"]:.4f}</td>'
            f'<td>{a["n"]:,}</td>'
            f'<td>{s.get("cards_per_run", 0):.1f}</td>'
            f'<td>{money}</td>'
            f'<td class="{cls}">{v}</td></tr>')

    shipped = sum(1 for s in results if verdict(s)[0].startswith("SHIP"))
    total_drop = sum(len(s.get("dropped_lines") or []) for s in results)
    cohort_note = ("" if cohort != "tier2" else
                   "<p><b>These five were graded POOR</b> on ecosystem data - "
                   "customers, purchases and suppliers all zero. That grade "
                   "does not measure what this engine reads: it uses sales "
                   "history and nothing else. Whether that makes them "
                   "unusable is a question to answer by running them, which "
                   "is what this page is.</p>")
    heading = {"pilot": "Pilot store audit",
               "tier2": "Second-cohort store audit",
               "all": "Estate-wide store audit"}.get(cohort, "Store audit")
    best = max(results, key=lambda x: x["sheet20"]["hit_rate"] - x["null_reversion"])
    worst = min(results, key=lambda x: x["sheet20"]["hit_rate"] - x["null_reversion"])

    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Botella - Pilot Store Audit</title><style>
:root{{background:#fff;--bg:#fff;--fg:#0f172a;--mut:#64748b;--line:#e2e8f0;
--card:#f8fafc;--good:#059669;--bad:#dc2626;--warn:#d97706}}
@media(prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#0b1120;
--fg:#e2e8f0;--mut:#94a3b8;--line:#1e293b;--card:#111827}}}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}}
.wrap{{max-width:1080px;margin:0 auto;padding:40px 22px 80px}}
h1{{font-size:30px;margin:0 0 6px;letter-spacing:-.02em}}
h2{{font-size:20px;margin:40px 0 12px;padding-top:20px;
border-top:1px solid var(--line)}}
.sub{{color:var(--mut);font-size:13px;margin:0 0 24px}}
table{{width:100%;border-collapse:collapse;font-size:14px;margin:14px 0}}
th,td{{text-align:right;padding:9px 10px;border-bottom:1px solid var(--line);
vertical-align:top}}
th:first-child,td:first-child{{text-align:left}}
th{{font-size:12px;text-transform:uppercase;letter-spacing:.04em;
color:var(--mut)}}
a{{color:#2563eb;text-decoration:none}}a:hover{{text-decoration:underline}}
.good{{color:var(--good)}}.bad{{color:var(--bad)}}.warn{{color:var(--warn)}}
.sm{{font-size:11px;color:var(--mut)}}
.flag{{font-size:11px;color:var(--warn)}}
.note{{background:var(--card);border:1px solid var(--line);border-radius:8px;
padding:14px 18px;margin:18px 0;font-size:14px}}
.warnbox{{border-left:4px solid var(--warn)}}
.scroll{{overflow-x:auto}}
code{{background:var(--card);border:1px solid var(--line);padding:1px 5px;
border-radius:4px;font-size:13px}}
</style></head><body><div class="wrap">

<h1>{heading}</h1>
<p class="sub">Five stores, each backtested separately against the production
modules in <code>app/pipeline</code> &middot; generated
{datetime.now():%d %B %Y}</p>

<div class="note"><b>Per store, not pooled.</b> The engine is switched on one
store at a time, so it is judged one store at a time. A pooled average would
also let the largest store carry the result. <b>Click any store for its full
report.</b>{cohort_note}</div>

<div class="scroll"><table>
<tr><th>store</th><th>hit rate<br><span class="sm">95% CI</span></th>
<th>hard null</th><th>edge</th><th>p</th><th>cards</th>
<th>cards/run</th><th>$/card</th><th>verdict</th></tr>
{"".join(rows)}</table></div>

<p class="sm"><b>hard null</b> = the same measurement on randomly chosen
products that were <em>equally primed to revert</em>. It is deliberately harder
than a plain random baseline, because the engine picks products whose recent
sales have dipped and the metric asks whether they bounce &mdash; so part of any
edge is regression to the mean, free to anyone. <b>The edge column is the
number that survives scrutiny.</b></p>

<h2>What this says</h2>
<ul>
<li><b>{shipped} of {len(results)} stores clear the bar</b> &mdash; a
statistically significant edge of at least 5 points over the hard null.</li>
<li><b>Strongest: {best["store_name"]}</b> at
{best["sheet20"]["hit_rate"] - best["null_reversion"]:+.1f} points.</li>
<li><b>Weakest: {worst["store_name"]}</b> at
{worst["sheet20"]["hit_rate"] - worst["null_reversion"]:+.1f} points. Published
rather than dropped &mdash; a store where the engine adds little is the most
useful row here.</li>
</ul>

{"" if not total_drop else f'''<div class="note warnbox">
<b>{total_drop} line item(s) across the estate were refused by the data
contract</b> before any figure was computed &mdash; single sale lines of more
than 1,000 units, where the median line across these stores is 1 unit and the
99th percentile is 20.
<p>Worth raising with whoever owns the till: one of them recorded
<b>8,245,805 units of a 50ml Tito's at $0.00</b>. Before the contract was
applied it alone produced a reported incremental margin of <b>$98.6M</b> on a
store turning over $7M a year. The danger is not that one &mdash; it is the same
defect an order of magnitude smaller, which would look plausible.</p></div>'''}

<h2>How to reproduce every number here</h2>
<div class="scroll"><pre style="background:var(--card);border:1px solid
var(--line);border-radius:8px;padding:14px;font-size:13px;overflow-x:auto"
>cd backend
node scripts/export-store-sales.js all --out ../audit/data

cd ../Botella_External_APIs
python scripts/run_pilot_audit.py --data ../audit/data --out ../audit</pre></div>
<p class="sm">The export is one SELECT against <code>syncgo</code>, which is
read-only by design. Everything after it is a pure function of those files, so
this whole audit replays months from now from the same inputs.</p>

<h2>What none of this proves</h2>
<div class="note warnbox"><b>This measures forecasting, not causation.</b>
Nobody acted on these recommendations &mdash; they were generated
retrospectively. It shows the engine can point at products that were about to
move. It does not show that following the advice causes extra sales. Only a
live holdout, where some recommendations are shown and others deliberately
withheld, proves that. The mechanism exists in production
(<code>REC_HOLDOUT_PCT</code>) and needs switching on.</div>
<ul>
<li><b>No live inventory.</b> No historical shelf counts exist, so understock
and overstock recommendations are absent from every figure here. The engine is
judged on less than it normally sees.</li>
<li><b>The 7-day lead time is declared, never measured.</b> Nothing in the
warehouse records when an order actually arrived.</li>
<li><b>Marshfield has only 568 trading days</b>, starting February 2025. It
needs a year of history before a decision date, so it yields far fewer decision
dates than the others and its interval is correspondingly weaker.</li>
</ul>
</div></body></html>"""
    (out / filename).write_text(html, encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
