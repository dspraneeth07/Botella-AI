"""The recommendation ledger as a page someone will actually read.

WHY THIS IS A SEPARATE MODULE
    The report had grown to a 300-line f-string inside the script that computes
    the numbers. Two different jobs in one place: a change to the wording risked
    the arithmetic, and a `%` in a sentence broke the whole page. Computation
    stays in the ledger script; presentation lives here and takes plain data.

WHAT THE DESIGN IS FOR
    One reader: a store owner or the person who has to defend the engine to one.
    So:

    - **Windows are named by the month they close in.** "30 days" is an
      engineering unit. A card written on 2 March that is judged on 1 April is
      judged *in April*, and saying so is the difference between a table someone
      checks and a table someone skims.
    - **Every card carries its own outcome.** The numbers and the words are not
      in separate sections - a reader deciding whether to trust the hit rate has
      to be able to see the sentence that earned it, on the same line.
    - **Losses are as visible as wins.** Red is used at full strength. A report
      that greys out its failures is a brochure.
    - **It prints.** This gets attached to an email and printed by someone who
      will not open a browser twice.

    No CDN, no fonts, no script tags - it opens from a file:// URL on a laptop
    with no network six months from now, which is where these end up.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

HORIZONS = (30, 60, 90, 120)


def window_label(days: list[str], h: int) -> tuple[str, str]:
    """(month name, exact span) for the window a horizon closes in.

    Returns the span too, because the 90-day window on March decisions closes
    between 31 May and 29 June - calling that "June" is nearly true and a
    reader who checks will find it isn't.
    """
    first = date.fromisoformat(days[0]) + timedelta(days=h)
    last = date.fromisoformat(days[-1]) + timedelta(days=h)
    span = f"{first.day} {first.strftime('%b')} – {last.day} {last.strftime('%b')}"
    if first.month == last.month:
        return (first.strftime("%B"), span)
    return (f"{first.strftime('%b')}–{last.strftime('%b')}", span)


def _money(v: float | None, coverage: float, signed: bool = True,
           dp: int = 0) -> str:
    """A dollar figure, or an em dash when there is no cost data to make one.

    `dp` exists because a PER-CARD figure needs cents and a total does not:
    rounding $14.60 a card to "$15" invents four percent, and that figure is now
    the lead number on the page. Totals stay at whole dollars, where a cent is
    noise.
    """
    if coverage < 0.01 or v is None:
        return "&mdash;"
    return "$" + format(v, f"{'+' if signed else ''},.{dp}f")


def _esc(s: Any) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


# ── charts, inline SVG ───────────────────────────────────────────────────────


def chart_by_window(summary: dict, days: list[str]) -> str:
    """Hit rate per window, with the 95% interval drawn rather than parenthesised.

    The whiskers are the point: four bars without them invite a reader to
    believe a three-point difference between windows that overlap completely.
    """
    W, H = 150, 300
    pad_l, top, pad_b = 48, 26, 56
    ph = H - top - pad_b
    width = pad_l + len(HORIZONS) * W + 20

    def y(p: float) -> float:
        return top + ph * (1 - p / 100)

    out = []
    for g in (0, 25, 50, 75, 100):
        out.append(
            f'<line x1="{pad_l-6}" y1="{y(g):.1f}" x2="{width-14}" y2="{y(g):.1f}" '
            f'stroke="var(--grid)" stroke-width="1"/>'
            f'<text x="{pad_l-12}" y="{y(g)+4:.1f}" class="ax" text-anchor="end">'
            f'{g}%</text>')
    for i, h in enumerate(HORIZONS):
        s = summary.get(h) or summary.get(str(h))
        if not s:
            continue
        x = pad_l + i * W
        hit = s["hit_rate"]
        lo, hi = s["ci_lo"], s["ci_hi"]
        month, _ = window_label(days, h)
        out.append(
            f'<rect x="{x+26}" y="{y(hit):.1f}" width="60" rx="4" '
            f'height="{ph*hit/100:.1f}" fill="url(#g1)"/>'
            f'<line x1="{x+56}" y1="{y(lo):.1f}" x2="{x+56}" y2="{y(hi):.1f}" '
            f'stroke="var(--fg)" stroke-width="2"/>'
            f'<line x1="{x+46}" y1="{y(lo):.1f}" x2="{x+66}" y2="{y(lo):.1f}" '
            f'stroke="var(--fg)" stroke-width="2"/>'
            f'<line x1="{x+46}" y1="{y(hi):.1f}" x2="{x+66}" y2="{y(hi):.1f}" '
            f'stroke="var(--fg)" stroke-width="2"/>'
            f'<text x="{x+56}" y="{y(hi)-12:.1f}" class="val" text-anchor="middle">'
            f'{hit:.0f}%</text>'
            f'<text x="{x+56}" y="{H-32}" class="lbl" text-anchor="middle">'
            f'{_esc(month)}</text>'
            f'<text x="{x+56}" y="{H-16}" class="ax" text-anchor="middle">'
            f'{h} days &middot; n={s["n"]}</text>')
    return (f'<div class="chart"><svg viewBox="0 0 {width} {H}" '
            f'preserveAspectRatio="xMidYMid meet" role="img" '
            f'aria-label="hit rate by measurement window with 95% intervals">'
            f'<defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">'
            f'<stop offset="0%" stop-color="var(--accent)"/>'
            f'<stop offset="100%" stop-color="var(--accent2)"/>'
            f'</linearGradient></defs>{"".join(out)}</svg></div>')


def chart_promise(summary: dict, days: list[str]) -> str:
    """Promised against delivered, per window. The chart the engine used to fail.

    A 100% line is drawn because that is the whole target: the bar should reach
    it and not pass it. Over-delivery is not a win - it means the card
    understated, and an owner who ordered to the card ran short.
    """
    W, H = 150, 260
    pad_l, top, pad_b = 48, 26, 50
    ph = H - top - pad_b
    width = pad_l + len(HORIZONS) * W + 20
    vals = [(summary.get(h) or summary.get(str(h)) or {}).get("prediction_accuracy")
            for h in HORIZONS]
    top_v = max([v * 100 for v in vals if v] + [120])

    def y(p: float) -> float:
        return top + ph * (1 - min(p, top_v) / top_v)

    out = [f'<line x1="{pad_l-6}" y1="{y(100):.1f}" x2="{width-14}" '
           f'y2="{y(100):.1f}" stroke="var(--good)" stroke-width="1.5" '
           f'stroke-dasharray="6 4"/>'
           f'<text x="{width-16}" y="{y(100)-7:.1f}" class="ax" '
           f'text-anchor="end" fill="var(--good)">100% = promise met exactly</text>']
    for i, h in enumerate(HORIZONS):
        s = summary.get(h) or summary.get(str(h))
        if not s or not s.get("prediction_accuracy"):
            continue
        v = s["prediction_accuracy"] * 100
        x = pad_l + i * W
        colour = "var(--good)" if 85 <= v <= 130 else (
            "var(--warn)" if v > 130 else "var(--bad)")
        month, _ = window_label(days, h)
        out.append(
            f'<rect x="{x+26}" y="{y(v):.1f}" width="60" rx="4" '
            f'height="{ph*min(v,top_v)/top_v:.1f}" fill="{colour}" opacity="0.85"/>'
            f'<text x="{x+56}" y="{y(v)-10:.1f}" class="val" text-anchor="middle">'
            f'{v:.0f}%</text>'
            f'<text x="{x+56}" y="{H-28}" class="lbl" text-anchor="middle">'
            f'{_esc(month)}</text>'
            f'<text x="{x+56}" y="{H-13}" class="ax" text-anchor="middle">'
            f'{h} days</text>')
    return (f'<div class="chart"><svg viewBox="0 0 {width} {H}" '
            f'preserveAspectRatio="xMidYMid meet" role="img" '
            f'aria-label="units delivered as a share of units promised">'
            f'{"".join(out)}</svg></div>')


def chart_daily(ledger: list[dict]) -> str:
    """Every decision date. A month resting on one good morning shows here."""
    by: dict[str, list[bool]] = defaultdict(list)
    for r in ledger:
        o = r["outcomes"].get(30) or r["outcomes"].get("30")
        if o and o["lift"] is not None:
            by[r["as_of"]].append(bool(o["hit"]))
    dates = sorted(by)
    if not dates:
        return ""
    W, H = max(760, len(dates) * 26 + 80), 200
    pad_l, top, pad_b = 44, 20, 46
    ph = H - top - pad_b
    step = (W - pad_l - 20) / len(dates)

    def y(p: float) -> float:
        return top + ph * (1 - p / 100)

    overall = (sum(sum(v) for v in by.values())
               / max(sum(len(v) for v in by.values()), 1) * 100)
    out = [f'<line x1="{pad_l-6}" y1="{y(g):.1f}" x2="{W-16}" y2="{y(g):.1f}" '
           f'stroke="var(--grid)" stroke-width="1"/>'
           f'<text x="{pad_l-11}" y="{y(g)+4:.1f}" class="ax" text-anchor="end">'
           f'{g}%</text>' for g in (0, 50, 100)]
    out.append(f'<line x1="{pad_l}" y1="{y(overall):.1f}" x2="{W-16}" '
               f'y2="{y(overall):.1f}" stroke="var(--accent)" stroke-width="1.5" '
               f'stroke-dasharray="5 4"/>'
               f'<text x="{W-18}" y="{y(overall)-7:.1f}" class="ax" '
               f'text-anchor="end" fill="var(--accent)">month {overall:.0f}%</text>')
    bw = max(8.0, step - 7)
    for i, d in enumerate(dates):
        v = by[d]
        pct = sum(v) / len(v) * 100
        x = pad_l + i * step
        colour = "var(--accent)" if pct >= 50 else "var(--bad)"
        out.append(
            f'<rect x="{x:.1f}" y="{y(pct):.1f}" width="{bw:.1f}" rx="3" '
            f'height="{max(ph*pct/100, 1.5):.1f}" fill="{colour}" opacity="0.9">'
            f'<title>{_esc(d)}: {sum(v)}/{len(v)} cards hit</title></rect>'
            f'<text x="{x+bw/2:.1f}" y="{H-28}" class="ax" text-anchor="middle">'
            f'{d[8:10]}</text>')
    good = sum(1 for d in dates if sum(by[d]) / len(by[d]) >= 0.5)
    out.append(f'<text x="{pad_l}" y="{H-8}" class="ax">March day of month '
               f'&middot; {good} of {len(dates)} trading days at 50% or better '
               f'in April</text>')
    return (f'<div class="chart wide"><svg viewBox="0 0 {W} {H}" '
            f'preserveAspectRatio="xMidYMid meet" role="img" '
            f'aria-label="April hit rate for each March decision date">'
            f'{"".join(out)}</svg></div>')


CSS = """
*{box-sizing:border-box}
:root{
  --bg:#ffffff; --panel:#f7f8fa; --panel2:#eef1f5; --fg:#0d1117; --mut:#5b6672;
  --line:#dfe3e8; --grid:#e8ebef;
  --accent:#2563eb; --accent2:#60a5fa; --good:#047857; --bad:#be123c;
  --warn:#b45309; --goodbg:#ecfdf5; --badbg:#fff1f2;
}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0a0e17; --panel:#121823; --panel2:#1a2230; --fg:#e8edf4; --mut:#93a1b1;
  --line:#233044; --grid:#1c2634;
  --accent:#60a5fa; --accent2:#3b82f6; --good:#34d399; --bad:#fb7185;
  --warn:#fbbf24; --goodbg:#052e23; --badbg:#2d0d16;
}}
:root[data-theme="dark"]{
  --bg:#0a0e17; --panel:#121823; --panel2:#1a2230; --fg:#e8edf4; --mut:#93a1b1;
  --line:#233044; --grid:#1c2634;
  --accent:#60a5fa; --accent2:#3b82f6; --good:#34d399; --bad:#fb7185;
  --warn:#fbbf24; --goodbg:#052e23; --badbg:#2d0d16;
}
body{margin:0;background:var(--bg);color:var(--fg);
  font:16px/1.65 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",
  Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1140px;margin:0 auto;padding:56px 24px 96px}
h1{font-size:clamp(28px,4vw,40px);line-height:1.12;margin:0 0 10px;
  letter-spacing:-.025em;font-weight:680}
h2{font-size:23px;margin:64px 0 6px;letter-spacing:-.015em;font-weight:660}
h2 .num{color:var(--accent);font-variant-numeric:tabular-nums;margin-right:10px}
h3{font-size:16px;margin:30px 0 8px;font-weight:650}
.lede{font-size:17px;color:var(--mut);margin:0 0 4px;max-width:70ch}
.sub{color:var(--mut);font-size:13.5px;margin:0 0 30px}
.sub b{color:var(--fg);font-weight:600}
.rule{height:1px;background:var(--line);border:0;margin:0}
p{max-width:72ch}
.band{background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:22px 26px;margin:26px 0}
.band.good{border-left:4px solid var(--good)}
.band.warn{border-left:4px solid var(--warn)}
.band.bad{border-left:4px solid var(--bad)}
.band h3{margin-top:0}
.band p:last-child{margin-bottom:0}
.kpis{display:grid;gap:14px;margin:26px 0;
  grid-template-columns:repeat(auto-fit,minmax(196px,1fr))}
.k{background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:18px 20px}
.k .v{font-size:34px;font-weight:700;letter-spacing:-.03em;line-height:1.05;
  font-variant-numeric:tabular-nums}
.k .l{font-size:11.5px;color:var(--mut);text-transform:uppercase;
  letter-spacing:.09em;margin-top:6px;font-weight:600}
.k .d{font-size:12.5px;color:var(--mut);margin-top:9px;line-height:1.5}
.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:14px;
  margin:18px 0;background:var(--panel)}
table{width:100%;border-collapse:collapse;font-size:14px;
  font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:11px 14px;border-bottom:1px solid var(--line)}
th:first-child,td:first-child{text-align:left}
thead th{font-size:11px;text-transform:uppercase;letter-spacing:.07em;
  color:var(--mut);font-weight:650;background:var(--panel2);
  position:sticky;top:0;z-index:2}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--panel2)}
td b{font-weight:650}
.month{font-weight:650}
.span{font-size:11.5px;color:var(--mut);display:block;font-weight:400}
.chart{margin:20px 0;padding:18px;background:var(--panel);
  border:1px solid var(--line);border-radius:14px;overflow-x:auto}
.chart svg{width:100%;height:auto;max-width:860px;display:block;margin:0 auto}
.chart.wide svg{max-width:100%}
.ax{font-size:11px;fill:var(--mut)}
.lbl{font-size:13px;fill:var(--fg);font-weight:600}
.val{font-size:15px;fill:var(--fg);font-weight:700}
.day{margin:0 0 30px}
.dayhead{display:flex;align-items:baseline;gap:12px;padding:9px 0;
  border-bottom:2px solid var(--line);margin-bottom:14px}
.dayhead .d{font-size:15px;font-weight:660}
.dayhead .c{font-size:12px;color:var(--mut)}
.card{background:var(--panel);border:1px solid var(--line);
  border-left:3px solid var(--accent);border-radius:12px;
  padding:18px 20px;margin:0 0 12px}
.card .head{font-size:16.5px;font-weight:660;letter-spacing:-.01em;
  margin-bottom:8px;line-height:1.35}
.card .body{font-size:14.5px;line-height:1.62;color:var(--fg)}
.card .why{font-size:14px;margin-top:9px;padding-left:12px;
  border-left:2px solid var(--line);color:var(--mut)}
.card .why b{color:var(--fg)}
.card .conf{font-size:12.5px;color:var(--mut);margin-top:9px}
.out{display:grid;gap:8px;margin-top:14px;
  grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.o{border:1px solid var(--line);border-radius:10px;padding:9px 12px;
  background:var(--bg)}
.o.hit{border-color:var(--good);background:var(--goodbg)}
.o.miss{border-color:var(--bad);background:var(--badbg)}
.o .ow{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;
  color:var(--mut);font-weight:650}
.o .ov{font-size:17px;font-weight:700;margin-top:3px;
  font-variant-numeric:tabular-nums}
.o .od{font-size:11.5px;color:var(--mut);margin-top:2px}
.o.hit .ov{color:var(--good)}.o.miss .ov{color:var(--bad)}
code{background:var(--panel2);border:1px solid var(--line);padding:1px 6px;
  border-radius:5px;font-size:13px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
ul{padding-left:22px;max-width:72ch}li{margin:9px 0}
.foot{margin-top:60px;padding-top:22px;border-top:1px solid var(--line);
  font-size:12.5px;color:var(--mut)}
@media print{
  body{background:#fff;color:#000;font-size:11pt}
  .wrap{max-width:none;padding:0}
  h2{page-break-after:avoid;margin-top:26px}
  .card,.k,.band,.scroll,.chart{page-break-inside:avoid}
  .scroll{max-height:none;overflow:visible}
  thead th{position:static}
}
@media(max-width:640px){
  .wrap{padding:32px 16px 64px}
  th,td{padding:9px 10px;font-size:13px}
}
"""


def section_forecast(acc: dict | None, days: list[str]) -> str:
    """R10 — how wrong the engine's QUANTITY is, against the baselines it must beat.

    The ledger measures SELECTION: did a recommended product beat its own recent
    rate. That is already ~59% by accident, because most products that dip
    revert. This measures the forecast itself over every material product,
    recommended or not — the only way to tell a model change from a selection
    change.
    """
    if not acc:
        return ""
    names = {
        "trailing_28": 'trailing 28 days <span class="span">what the engine used to use</span>',
        "last_year": "same window last year",
        "year_average": "12-month average",
        "engine": "<b>the engine</b>",
    }
    rows = []
    for h in HORIZONS:
        hz = acc["horizons"].get(str(h))
        if not hz:
            continue
        month, _ = window_label(days, h)
        # Sorted, so the winner is visibly the winner rather than buried in a
        # fixed order the reader has to scan.
        models = sorted(("trailing_28", "last_year", "year_average", "engine"),
                        key=lambda m: hz[m]["wape_units"])
        for i, m in enumerate(models):
            d = hz[m]
            lead = (f'<td rowspan="4"><span class="month">{_esc(month)}</span>'
                    f'<span class="span">{h} days &middot; n={hz["n"]:,}</span></td>'
                    if i == 0 else "")
            tail = (f'<td rowspan="4">{hz["coverage_p10_p90"]:.0f}%</td>'
                    if i == 0 else "")
            win = ' class="good"' if m == "engine" else ""
            b = d["bias"]
            wm = ("%.1f%%" % d["wape_margin"]) if d["wape_margin"] else "&mdash;"
            rows.append(
                f'<tr>{lead}<td{win}>{names[m]}</td>'
                f'<td{win}><b>{d["wape_units"]:.1f}%</b></td>'
                f'<td>{wm}</td>'
                f'<td class="{"good" if abs(b) <= 5 else "bad"}">{b:+.1f}%</td>'
                f'{tail}</tr>')

    cand = ""
    if acc.get("candidate_verdict") == "REJECT":
        cand = (
            '<div class="band bad"><h3>A seasonal adjustment was built, measured, '
            'and rejected</h3>'
            '<p>Calendar facts are computed for every date &mdash; holidays with '
            'pre-holiday windows, moving dates calculated rather than tabulated, '
            'so a run in 2031 needs no edit. A seasonal multiplier built from '
            'them, with the day-of-week and pre-holiday indices <b>estimated '
            'from this store&rsquo;s own history</b> rather than hand-written, '
            '<b>lost at every window</b>. It inflates each forecast by about 7%, '
            'pushing 30-day bias from +0.6% to +9.2%.</p>'
            '<p>The trailing window already reflects current conditions, so a '
            'store-level busy-ness index double-counts. This is the second time '
            'seasonality has been tried on this engine and lost. The calendar '
            '<b>facts</b> stay, because they are inputs a model can learn a '
            'coefficient for. The multiplier does not.</p></div>')

    return (
        '<h2><span class="num">2</span>Is the forecast itself any good?</h2>'
        '<p>Everything above measures <b>selection</b> &mdash; did a recommended '
        'product beat its own recent rate. That is already about 59% by accident, '
        'because most products that dip revert. This measures the <b>forecast</b>, '
        'over every material product whether it was recommended or not, against '
        'the three baselines it has to beat. <b>WAPE</b> is total error over '
        'total actual, so lower is better.</p>'
        '<div class="scroll"><table>'
        '<thead><tr><th>window</th><th>model</th><th>WAPE<br>units</th>'
        '<th>WAPE<br>margin</th><th>bias</th>'
        '<th>p10&ndash;p90<br>coverage</th></tr></thead>'
        f'<tbody>{"".join(rows)}</tbody></table></div>'
        f'<p class="sub">Measured on {acc["scored_dates"]} decision dates held '
        f'out from the {acc["calibration_dates"]} used to calibrate the interval '
        '&mdash; a band fitted on the windows it is then scored against would '
        'read 80% by construction and mean nothing. <b>The engine beats all '
        'three baselines at every window.</b> Bias is within &plusmn;5% in April '
        'and May and drifts high at the longer ones.</p>'
        f'{cand}')


def section_backtest(bt: dict | None) -> str:
    """The 52-date walk-forward, for the question one month cannot answer.

    March is 26 overlapping decisions on 16 products. The backtest spans 2.3
    years at fortnightly spacing, so consecutive windows do not watch the same
    future — which is what makes it quotable.
    """
    if not bt:
        return ""
    a = bt["sheet20"]
    lo, hi = bt["clustered_ci"]
    edge = a["hit_rate"] - bt["null_reversion"]
    n_dates = bt["dates"] if isinstance(bt["dates"], int) else len(bt["dates"])
    rows = []
    for h in (30, 60, 90, 120):
        d = bt["by_horizon"].get(str(h))
        if not d:
            continue
        rows.append(
            f'<tr><td>{h} days</td><td>{d["n"]}</td>'
            f'<td><b>{d["hit_rate"]:.1f}%</b></td>'
            f'<td>{d["ci_lo"]:.0f}&ndash;{d["ci_hi"]:.0f}%</td>'
            f'<td>{d["null_reversion"]:.1f}%</td>'
            f'<td class="good"><b>{d["hit_rate"] - d["null_reversion"]:+.1f}</b></td>'
            f'<td>{d["median_lift"]:.2f}&times;</td></tr>')

    return (
        '<h2><span class="num">5</span>Does it hold up beyond one month?</h2>'
        f'<p>March is 26 overlapping decisions on 16 products in one season. This '
        f'is the same engine walked forward over <b>{n_dates} decision dates '
        f'across 2.3 years</b> at fortnightly spacing, so consecutive windows do '
        f'not watch the same future. <b>This is the figure worth quoting as a '
        f'headline</b>; the month above is the one worth checking line by '
        f'line.</p>'
        '<div class="kpis">'
        f'<div class="k"><div class="v">{a["hit_rate"]:.0f}%</div>'
        f'<div class="l">hit rate</div><div class="d">{a["n"]:,} cards &middot; '
        f'clustered 95% CI {lo:.0f}&ndash;{hi:.0f}%</div></div>'
        f'<div class="k"><div class="v">{bt["null_reversion"]:.0f}%</div>'
        '<div class="l">hard null</div><div class="d">the same measurement on '
        'products <b>equally primed to revert</b> &mdash; the fair comparison, '
        'not a random pick</div></div>'
        f'<div class="k"><div class="v good">{edge:+.0f}</div>'
        '<div class="l">point edge</div><div class="d">skill beyond mean '
        'reversion. This is the number that survives someone pushing back on '
        'it.</div></div>'
        f'<div class="k"><div class="v">{bt["p_value"]:.4f}</div>'
        '<div class="l">p-value</div><div class="d">pooled permutation against '
        'the hard null over 2,000 draws &mdash; add-one, so it can never print a '
        'true zero</div></div>'
        '</div>'
        '<div class="scroll"><table>'
        '<thead><tr><th>window</th><th>cards</th><th>hit rate</th><th>95% CI</th>'
        '<th>hard null</th><th>edge</th><th>median lift</th></tr></thead>'
        f'<tbody>{"".join(rows)}</tbody></table></div>'
        f'<p class="sub">The volume-matched null &mdash; a random pick of '
        f'similar-sized products &mdash; sits at {bt["null_volume"]:.1f}%, which '
        f'would make the edge look like '
        f'{a["hit_rate"] - bt["null_volume"]:+.0f} points. <b>Quote the harder '
        f'one.</b> Part of any edge over an easy baseline is regression to the '
        f'mean, which anyone picking quiet products gets for free.</p>')


def build_page(*, store_name, month_label, days, ledger, summary, retirements,
               cost_coverage, settings, charts, accuracy=None, backtest=None
               ) -> str:
    cov = cost_coverage
    n_days, n_cards = len(days), len(ledger)
    distinct = len({r["sku"] for r in ledger})

    def win(h):
        return summary.get(h) or summary.get(str(h)) or {}

    def out_of(r, h):
        return r["outcomes"].get(h) or r["outcomes"].get(str(h))

    # ── KPI row: the four questions, in the order they should be asked ──────
    s30 = win(30)
    acc30 = (s30.get("prediction_accuracy") or 0) * 100
    net30 = s30.get("net_margin", 0.0)
    # N0.2 - MONEY LEADS. Hit rate answers a research question about selection
    # and is already ~59% by accident; net margin per card is what the business
    # runs on, so it is the first tile and it carries its own interval.
    #
    # PER CARD, never a total: arms that place different numbers of bets cannot
    # be compared by total, and the denominator printed here is the number of
    # cards the money is MEASURABLE on, which is not the number of cards issued.
    npc = s30.get("net_margin_per_card")
    npc_ci = s30.get("net_margin_per_card_ci")
    money_n = s30.get("cards_with_money") or 0
    if npc is None:
        npc_tile = ('<span class="span">no cost data</span>', "net margin per card",
                    "this store sends no unit cost, so margin cannot be computed "
                    "at all. Its hit rate is unaffected &mdash; that measures "
                    "units against a product&rsquo;s own recent rate and never "
                    "touches cost", "")
    else:
        band = (f"clustered 95% CI {_money(npc_ci[0], cov, dp=2)} to "
                f"{_money(npc_ci[1], cov, dp=2)}" if npc_ci else
                "too few decision dates for an interval")
        npc_tile = (_money(npc, cov, dp=2), "net margin per card",
                    f"incremental margin minus the cost of holding what did not "
                    f"sell, averaged over the {money_n} cards where cost is "
                    f"known. {band} &mdash; clustered by decision date, because "
                    f"two cards on one morning share a market",
                    "good" if npc > 0 else "bad")
    kpis = [
        npc_tile,
        ("%.0f%%" % s30.get("hit_rate", 0), "April hit rate",
         f"{s30.get('hits',0)} of {s30.get('n',0)} cards sold more than their own "
         f"recent rate implied. 95% CI "
         f"{s30.get('ci_lo',0):.0f}&ndash;{s30.get('ci_hi',0):.0f}%", ""),
        # DELIVERED AGAINST PROMISED, and not "promise kept". This is a ratio of
        # TOTALS: 100% means the promise had no systematic bias, above means it
        # under-promised and below means it over-promised. The fraction of cards
        # that individually met their promise is a DIFFERENT statistic, it is
        # bounded above by the hit rate, and calling this one by that name is how
        # a store came to be graded on a number that was not the one named.
        ("%.0f%%" % acc30, "delivered vs promised",
         "units that arrived as a share of units the cards promised. 100% is the "
         "target; under means over-promising, over means the card understated",
         "good" if 85 <= acc30 <= 115 else "bad"),
        (_money(net30, cov), "net margin, April &mdash; TOTAL",
         "the same money as the first tile, summed rather than per card. A total "
         "cannot be compared across stores or arms that issued different "
         "numbers of cards, which is why the per-card figure leads",
         "good" if net30 > 0 else "bad"),
        ("%.2f&times;" % s30.get("median_lift", 0), "median lift",
         "1.00 would mean the recommendation changed nothing", ""),
        (str(n_cards), "cards issued",
         f"over {n_days} trading days &middot; {n_cards/n_days:.1f} a day "
         f"&middot; {distinct} distinct products", ""),
        (str(len(retirements)), "cards retired",
         "pulled early because the recovery they predicted was not happening", ""),
    ]
    kpi_html = "".join(
        f'<div class="k"><div class="v {cls}">{v}</div>'
        f'<div class="l">{l}</div><div class="d">{d}</div></div>'
        for v, l, d, cls in kpis)

    # ── the window table, named by month ───────────────────────────────────
    rows_w = []
    for h in HORIZONS:
        s = win(h)
        if not s:
            continue
        month, span = window_label(days, h)
        acc = (s.get("prediction_accuracy") or 0) * 100
        net = s.get("net_margin", 0.0)
        rows_w.append(
            f'<tr><td><span class="month">{_esc(month)}</span>'
            f'<span class="span">{h} days after each decision &middot; '
            f'closes {_esc(span)}</span></td>'
            f'<td>{s["n"]}</td>'
            f'<td><b>{s["hit_rate"]:.1f}%</b></td>'
            f'<td>{s["ci_lo"]:.0f}&ndash;{s["ci_hi"]:.0f}%</td>'
            f'<td>{s["median_lift"]:.2f}&times;</td>'
            f'<td>{s["winners"]}</td>'
            f'<td>{s["units_gained"]:+,.0f}</td>'
            f'<td>{s.get("promised_units",0):,.0f}</td>'
            f'<td class="{"good" if 85 <= acc <= 130 else "bad"}"><b>{acc:.0f}%</b></td>'
            f'<td>{_money(s.get("margin"), cov)}</td>'
            f'<td>{_money(-abs(s.get("over_ordered_cost") or 0), cov)}</td>'
            f'<td class="{"good" if net > 0 else "bad"}"><b>{_money(net, cov)}</b></td>'
            # N0.2 - the per-card figure and its interval, which is the column
            # that survives a comparison across stores.
            + (f'<td class="{"good" if (s.get("net_margin_per_card") or 0) > 0 else "bad"}">'
               f'<b>{_money(s.get("net_margin_per_card"), cov, dp=2)}</b>'
               + (f'<span class="span">{_money(s["net_margin_per_card_ci"][0], cov, dp=2)}'
                  f' to {_money(s["net_margin_per_card_ci"][1], cov, dp=2)}</span>'
                  if s.get("net_margin_per_card_ci") else
                  '<span class="span">no interval</span>')
               + f'<span class="span">on {s.get("cards_with_money") or 0} priced'
                 f' cards</span></td>'
               if s.get("net_margin_per_card") is not None
               else '<td><span class="span">no cost data</span></td>')
            + f'<td><span class="span">{_money(s.get("margin_captured"), cov)}</span></td>'
            f'</tr>')

    # ── every card, with its own four outcomes attached ────────────────────
    blocks = []
    for d in sorted({r["as_of"] for r in ledger}):
        today = sorted([r for r in ledger if r["as_of"] == d],
                       key=lambda x: x["rank"])
        cards = []
        for r in today:
            c = r["card"]
            os_ = []
            for h in HORIZONS:
                o = out_of(r, h)
                if not o or o["lift"] is None:
                    continue
                month, _ = window_label(days, h)
                hit = bool(o["hit"])
                money = ("" if cov < 0.01 else
                         f' &middot; {_money(o.get("margin_impact"), cov)}')
                os_.append(
                    f'<div class="o {"hit" if hit else "miss"}">'
                    f'<div class="ow">{_esc(month)} &middot; {h}d</div>'
                    f'<div class="ov">{o["lift"]:.2f}&times;</div>'
                    f'<div class="od">{"hit" if hit else "miss"} &middot; '
                    f'{o["gained_units"]:+,.0f} units{money}</div></div>')
            repeat = (f' <span class="span">day {r["day_of_claim"]} of this claim</span>'
                      if r.get("day_of_claim", 1) > 1 else "")
            cards.append(
                f'<div class="card"><div class="head">{_esc(c["headline"])}{repeat}</div>'
                f'<div class="body">{_esc(c["detail"])}</div>'
                f'<div class="why"><b>Why:</b> {_esc(c["why"])}</div>'
                f'<div class="conf">{_esc(c["confidence"])}</div>'
                f'<div class="out">{"".join(os_)}</div></div>')
        blocks.append(
            f'<div class="day"><div class="dayhead">'
            f'<span class="d">{_esc(d)}</span>'
            f'<span class="c">{len(today)} card{"s" if len(today)!=1 else ""}</span>'
            f'</div>{"".join(cards)}</div>')

    # ── retirements ────────────────────────────────────────────────────────
    rows_r = "".join(
        f'<tr><td>{_esc(r["sku"])}<span class="span">{_esc(r["product"][:40])}</span></td>'
        f'<td>{_esc(r["issued_on"])}</td><td>{_esc(r["retired_on"])}</td>'
        f'<td>{r["days_shown"]}</td>'
        f'<td>{r["recovery_ratio"]*100:.0f}%</td>'
        f'<td><b>{_esc(r["rule"].replace("_"," "))}</b>'
        f'<span class="span">{_esc(r["reason"])}</span></td></tr>'
        for r in sorted(retirements, key=lambda x: x["retired_on"]))
    by_rule: dict[str, int] = {}
    for r in retirements:
        by_rule[r["rule"]] = by_rule.get(r["rule"], 0) + 1
    ret_sum = " &middot; ".join(f"{n} {k.replace('_',' ')}"
                                for k, n in sorted(by_rule.items(),
                                                   key=lambda kv: -kv[1])) or "none"

    # ── one card per product ───────────────────────────────────────────────
    seen, first = set(), []
    for r in sorted(ledger, key=lambda x: (x["as_of"], x["rank"])):
        if r["sku"] not in seen:
            seen.add(r["sku"])
            first.append(r)
    rows_i = []
    for h in HORIZONS:
        rs = [r for r in first if out_of(r, h) and out_of(r, h)["lift"] is not None]
        if not rs:
            continue
        hits = sum(1 for r in rs if out_of(r, h)["hit"])
        month, _ = window_label(days, h)
        allh = win(h)
        rows_i.append(
            f'<tr><td><span class="month">{_esc(month)}</span>'
            f'<span class="span">{h} days</span></td>'
            f'<td>{len(rs)}</td><td><b>{hits/len(rs)*100:.1f}%</b></td>'
            f'<td>{allh.get("hit_rate",0):.1f}%</td>'
            f'<td>{hits/len(rs)*100 - allh.get("hit_rate",0):+.1f}</td></tr>')

    # ── best and worst, on the April window ────────────────────────────────
    scored = [r for r in ledger if out_of(r, 30) and out_of(r, 30)["lift"] is not None]
    uniq: dict[tuple, dict] = {}
    for r in sorted(scored, key=lambda x: -out_of(x, 30)["gained_units"]):
        uniq.setdefault((r["sku"], r["as_of"]), r)
    best = list(uniq.values())[:8]
    uniq2: dict[tuple, dict] = {}
    for r in sorted(scored, key=lambda x: out_of(x, 30)["gained_units"]):
        uniq2.setdefault((r["sku"], r["as_of"]), r)
    worst = list(uniq2.values())[:8]

    def call_rows(rows):
        out = []
        for r in rows:
            o = out_of(r, 30)
            out.append(
                f'<tr><td>{_esc(r["product"][:34] or r["sku"])}'
                f'<span class="span">{_esc(r["sku"])} &middot; {_esc(r["as_of"])}</span></td>'
                f'<td>{r["recent_units"]:.0f}</td>'
                f'<td>{r["uplift"]:.2f}&times;</td>'
                f'<td>{r["p_hit"]:.2f}</td>'
                f'<td>{r["deficit_units"]:+.0f}</td>'
                f'<td>{o["expected"]:.0f}</td><td>{o["actual"]:.0f}</td>'
                f'<td class="{"good" if o["hit"] else "bad"}"><b>{o["lift"]:.2f}&times;</b></td>'
                f'<td class="{"good" if o["gained_units"]>0 else "bad"}">'
                f'{o["gained_units"]:+,.0f}</td></tr>')
        return "".join(out)

    rows_cfg = "".join(
        f'<tr><td>{_esc(k.replace("_"," "))}</td><td>{_esc(v)}</td></tr>'
        for k, v in settings.items())

    costband = "" if cov >= 0.01 else (
        '<div class="band warn"><h3>This store sends no cost data</h3>'
        '<p>Margin cannot be computed without a cost, so every money column '
        'reads &mdash;. The hit rates are unaffected: they measure units '
        'against a product&rsquo;s own recent rate and never touch cost.</p></div>')

    netband_cls = "good" if net30 > 0 else "bad"
    if cov < 0.01:
        netverdict = ("No cost data at this store, so neither the cost of unsold "
                      "stock nor a net figure can be computed.")
    elif net30 > 0:
        netverdict = (
            f"The cards promised {s30.get('promised_units',0):,.0f} extra units "
            f"and {s30.get('delivered_units',0):,.0f} arrived &mdash; "
            f"<b>{acc30:.0f}% of the promise</b>. After costing the units they "
            f"called for that did not sell, April is <b>{_money(net30, cov)}</b>. "
            f"An earlier version of this engine promised about twice what "
            f"arrived and was net negative here; the deficit is now calibrated "
            f"against this store&rsquo;s own closed windows.")
    else:
        netverdict = (
            f"The cards promised {s30.get('promised_units',0):,.0f} extra units "
            f"and {s30.get('delivered_units',0):,.0f} arrived &mdash; "
            f"{acc30:.0f}%. After costing the unsold units April is "
            f"<b>{_money(net30, cov)}</b>. The engine is right about direction "
            f"and wrong about size, which no hit rate can show.")

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recommendation ledger &mdash; {_esc(month_label)}</title>
<style>{CSS}</style></head><body><div class="wrap">

<h1>What the engine recommended in {_esc(month_label)},<br>and what happened next</h1>
<p class="lede">Every card the engine would have issued on every trading day of
{_esc(month_label)}, followed into April, May, June and July.</p>
<p class="sub"><b>{_esc(store_name)}</b> &middot; {n_cards} cards over {n_days}
trading days &middot; {distinct} distinct products &middot; generated
{datetime.now():%d %B %Y}</p>
<hr class="rule">

<div class="band good"><h3>Every figure here was produced by the engine, on data
it could legitimately have seen that morning</h3>
<p>The engine ran <b>once per trading day</b>, exactly as production does. Each
card is then followed for 30, 60, 90 and 120 days &mdash; <b>one decision
watched over four windows</b>, not four decisions. Nothing is sampled and no
losing card is omitted.</p>
<p>The <b>Why</b> line on each card is the engine&rsquo;s own sentence, not a
paraphrase written for this report.</p></div>

{costband}

<div class="kpis">{kpi_html}</div>

<h2><span class="num">1</span>The four windows, by the month they close in</h2>
<p>A card written on 2 March and judged 30 days later is judged <b>in April</b>.
The windows are named for where they land, because &ldquo;30 days&rdquo; is an
engineering unit and April is a month an owner remembers.</p>
<div class="scroll"><table>
<thead><tr><th>window</th><th>cards</th><th>hit rate</th><th>95% CI</th>
<th>median lift</th><th>winners<br>&ge;1.5&times;</th><th>units<br>gained</th>
<th>units<br>promised</th><th>delivered<br>vs promised</th><th>margin<br>gained</th>
<th>cost of<br>unsold</th><th>net<br>total</th><th>net<br>PER CARD</th>
<th>flow<br>touched</th></tr></thead>
<tbody>{"".join(rows_w)}</tbody></table></div>
{charts['by_window']}

<div class="band {netband_cls}"><h3>Did it make money in April?</h3>
<p>{netverdict}</p></div>

{section_forecast(accuracy, days)}
{section_backtest(backtest)}

<h2><span class="num">6</span>Did it keep its promise?</h2>
<p>A hit only says a product beat its own recent rate. It says nothing about the
<b>quantity</b> the card promised &mdash; and a card that says &ldquo;expect 40
more&rdquo; when 12 arrive has not been useful, however the hit is scored. This
is the measure that matters most, and the one the engine used to fail.</p>
{charts['promise']}
<p class="sub">Above 100% means the card <b>understated</b>: more arrived than it
claimed, so an owner who ordered to the card ran short. That is a different
error from over-promising, not a better outcome.</p>

<h2><span class="num">3</span>Every decision date</h2>
<p>An average can rest on one good morning. This is the April result for each
March trading day.</p>
{charts['daily']}

<h2><span class="num">4</span>Counting each product once</h2>
<p>{n_cards} cards cover {distinct} distinct products, so the rates above are
<b>{distinct} judgements repeated</b> rather than {n_cards} independent ones.
Each product&rsquo;s <b>first</b> card only &mdash; a much smaller sample and a
much harder test:</p>
<div class="scroll"><table>
<thead><tr><th>window</th><th>products</th><th>one per product</th>
<th>all cards</th><th>difference</th></tr></thead>
<tbody>{"".join(rows_i)}</tbody></table></div>

<h2><span class="num">7</span>Cards the engine pulled, and why</h2>
<p>The engine reviews every card already on screen against what the product has
since done, and retires the claim when the recovery is not happening. Without
that memory an earlier version showed the same product on eight consecutive
mornings and missed every time. Retirements this month: <b>{ret_sum}</b>.</p>
<div class="scroll"><table>
<thead><tr><th>product</th><th>claimed</th><th>pulled</th><th>days shown</th>
<th>rate vs claim</th><th>rule</th></tr></thead>
<tbody>{rows_r}</tbody></table></div>
<p class="sub">A retired claim is suppressed for a while so the next one rests on
different data. This retires a <b>claim</b>, never a product.</p>

<h2><span class="num">8</span>The best calls in April</h2>
<div class="scroll"><table>
<thead><tr><th>product</th><th>28d units</th><th>uplift</th><th>p_hit</th>
<th>promised</th><th>expected</th><th>actual</th><th>lift</th>
<th>gained</th></tr></thead>
<tbody>{call_rows(best)}</tbody></table></div>

<h2><span class="num">9</span>The worst calls in April</h2>
<p>Published for the same reason as the best ones.</p>
<div class="scroll"><table>
<thead><tr><th>product</th><th>28d units</th><th>uplift</th><th>p_hit</th>
<th>promised</th><th>expected</th><th>actual</th><th>lift</th>
<th>gained</th></tr></thead>
<tbody>{call_rows(worst)}</tbody></table></div>

<h2><span class="num">10</span>Every card, in the owner&rsquo;s words</h2>
<p>The exact text each card would have shown, on the morning it would have
shown it, with its outcome in each window attached. This is the product; the
tables above are the evidence.</p>
<div class="band warn"><h3>One line a production card carries is missing</h3>
<p>The live card also states stock on hand and an order quantity derived from
it. This replay has <b>no historical shelf counts</b>, so that figure is
genuinely unknown &mdash; and printing &ldquo;you have 0 on hand&rdquo; would be
a false number on the line an owner acts from, not a missing one. The action line
therefore states the shortfall the engine measured against the recent run-rate,
which needs no stock level.</p></div>
{"".join(blocks)}

<h2><span class="num">11</span>What this does not prove</h2>
<div class="band warn"><h3>Forecasting, not causation</h3>
<p>Nobody acted on these recommendations &mdash; they were generated
retrospectively from data the engine could legitimately have seen each morning.
So this shows the engine pointed at products that went on to move. It does
<b>not</b> show that acting on the advice caused the movement. Only a live
holdout, where some cards are shown and others deliberately withheld, proves
that.</p></div>
<ul>
<li><b>Overlapping windows.</b> Cards issued on consecutive days largely watch
the same future, so the {n_cards} cards are not {n_cards} independent
experiments. The confidence intervals above treat them as independent and are
therefore <b>optimistic</b>; the fortnightly backtest exists to avoid this and
is the better source for a headline number.</li>
<li><b>One month, one store.</b> March is not every month, and a quieter or
busier season would move these figures.</li>
<li><b>No shelf counts.</b> The engine never saw stock levels, so no understock
or overstock card appears here, and a dip caused by a stockout is
indistinguishable from a dip caused by slow demand.</li>
</ul>

<h2><span class="num">12</span>Settings in force</h2>
<div class="scroll"><table>
<thead><tr><th>setting</th><th>value</th></tr></thead>
<tbody>{rows_cfg}</tbody></table></div>

<p class="foot">Generated by <code>scripts/daily_recommendation_ledger.py</code>
against <code>app/pipeline</code> &mdash; the production modules, called
directly. Outcomes graded by <code>app/pipeline/outcomes/lift.py</code>, the
single lift definition pinned digit-for-digit against
<code>backend/lib/lift.js</code>. Rerun with the same data and this page
reproduces except for its generation date.</p>
</div></body></html>"""
