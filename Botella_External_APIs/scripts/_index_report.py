"""The index over every store's combined report.

ONE RULE SHAPES THIS PAGE: per store, never pooled.
    The engine is switched on one store at a time, so it is judged one store at
    a time. A pooled average would also let the largest store carry the result -
    Cork Runner has four times Bethany's line items, so a units-weighted mean is
    mostly one store wearing five hats.

    And a store where the engine does NOT work is the most useful row here.
    Finding it on this page costs a paragraph; finding it in a pilot costs a
    customer. So the table sorts by edge and the failures sit at the top of the
    bottom, in red, with a verdict that says DO NOT SHIP.

THE EDGE IS THE COLUMN TO READ, not the hit rate.
    A hit rate of 72% sounds like skill until you learn that products which have
    just dipped beat their own recent rate about 59% of the time anyway. The
    edge over a reversion-matched null is what is left after that, and it is the
    number that survives someone pushing back.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from scripts._gates import gate_table, verdict_for
from scripts._ledger_report import CSS, _esc


def verdict(d: dict) -> tuple[str, str]:
    """Does the engine earn its place at this store? THE GATE decides.

    This function used to decide on its own, from the edge and its p-value alone,
    while `_gates.py` decided differently from four other checks - so the report
    printed two rival verdicts for the same store on the same page, and the looser
    one was the one in the headline. The edge test is now a check INSIDE gate A
    (`beats_null`) and this function reports the gate's verdict rather than
    competing with it.
    """
    v = verdict_for(d)
    if v.shippable:
        return ("ship", "good")
    failed = len(v.gate_a.failures) + len(v.gate_b.failures)
    return (f"do not ship — {failed} check{'s' if failed != 1 else ''} failed",
            "bad")


def gate_table_html(stores: list[dict]) -> str:
    """Every check, every store, with the measured value beside it.

    The table was computed but never rendered, so the page carried verdicts whose
    basis a reader could not see - and four of the seven checks were printed
    "not measured" at every store for want of anything computing them. A gate
    whose checks the reader cannot inspect is a dashboard with an opinion.
    """
    mark = {True: ('<span class="good">PASS</span>', "good"),
            False: ('<span class="bad">FAIL</span>', "bad"),
            None: ('<span class="span">n/a</span>', "warn")}
    blocks = []
    for v in gate_table(stores):
        cls = "good" if v.shippable else "bad"
        rows = []
        for gate in (v.gate_a, v.gate_b):
            for c in gate.checks:
                flag, _ = mark[c.passed]
                rows.append(
                    f'<tr><td><span class="span">{_esc(gate.gate)}</span>'
                    f'<b>{_esc(c.name)}</b></td>'
                    f'<td>{flag}</td><td>{_esc(c.detail)}</td></tr>')
        blocks.append(
            f'<div class="band {cls}"><h3>{v.loc} {_esc(v.name)} &mdash; '
            f'{v.verdict}</h3>'
            f'<p>{_esc(v.why)}</p>'
            f'<div class="scroll"><table><thead><tr><th>check</th>'
            f'<th>result</th><th>measured against the threshold</th></tr></thead>'
            f'<tbody>{"".join(rows)}</tbody></table></div></div>')
    return "".join(blocks)


def build_index(stores: list[dict], month_label: str) -> str:
    shipped = sum(1 for s in stores if verdict(s)[0].startswith("ship"))
    ranked = sorted(stores, key=lambda s: -(s.get("bt_edge") or -99))
    best, worst = ranked[0], ranked[-1]
    # `s.get("cost") or 1.0` would map a genuine 0.0 to 1.0 - the falsy-zero
    # class - and a store with NO cost data would then have shown money figures
    # as if they were measured. Explicit None check, every time.
    def _cov(st: dict) -> float:
        v = st.get("cost")
        return 1.0 if v is None else float(v)

    no_cost = [s for s in stores if _cov(s) < 0.01]

    rows = []
    for s in ranked:
        v, cls = verdict(s)
        money = ('<span class="span">no cost data</span>'
                 if _cov(s) < 0.01
                 else "$" + format(s.get("net30") or 0, "+,.0f"))
        # N0.2 - net margin PER CARD, with its date-clustered interval. The
        # column to compare stores on: Cork Runner has four times Bethany's
        # line items, so a total mostly measures which store is bigger.
        npc, npc_ci = s.get("net_per_card30"), s.get("net_per_card30_ci")
        if _cov(s) < 0.01 or npc is None:
            per_card = '<td><span class="span">no cost data</span></td>'
        else:
            ci = (f'<span class="span">${npc_ci[0]:+,.0f} to ${npc_ci[1]:+,.0f}'
                  f'</span>' if npc_ci else
                  '<span class="span">no interval</span>')
            per_card = (f'<td class="{"good" if npc > 0 else "bad"}">'
                        f'<b>${npc:+,.2f}</b>{ci}'
                        f'<span class="span">on {s.get("money_cards30") or 0}'
                        f' priced cards</span></td>')
        promise = s.get("promise_fill_ratio")
        rows.append(
            f'<tr><td><a href="{_esc(s["folder"])}/RECOMMENDATION_LEDGER.html">'
            f'<b>{s["loc"]}</b> {_esc(s["name"])}</a>'
            f'<span class="span">{s["cards"]} cards &middot; {s["skus"]} products'
            f' &middot; {s["retired"]} retired</span></td>'
            f'<td>{s["bt_hit"]:.1f}%</td>'
            f'<td>{s["bt_null"]:.1f}%</td>'
            f'<td class="{cls}"><b>{s["bt_edge"]:+.1f}</b></td>'
            f'<td>{s["bt_p"]:.4f}</td>'
            f'<td>{(s.get("hit30") or 0):.1f}%</td>'
            + (f'<td class="{"good" if 85 <= promise <= 115 else "bad"}">'
               f'{promise:.0f}%</td>' if promise is not None
               else '<td><span class="span">not measured</span></td>')
            + per_card
            + f'<td>{money}</td>'
            + f'<td class="{cls}">{v}</td></tr>')

    # THE FINDING THAT MATTERS MOST, computed rather than asserted.
    kept = [(s_["name"], s_.get("promise_fill_ratio") or 0) for s_ in stores]
    in_band = [n for n, v in kept if 85 <= v <= 115]
    neg = [s_ for s_ in stores
           if _cov(s_) >= 0.01 and (s_.get("net30") or 0) < 0]
    promise_band = (
        f'<div class="band bad"><h3>The promise is calibrated at '
        f'{len(in_band)} of {len(stores)} stores, and that is the open '
        f'problem</h3>'
        f'<p>A hit only says a product beat its own recent rate. It says nothing '
        f'about the <b>quantity</b> the card promised &mdash; and a card saying '
        f'&ldquo;expect 40 more&rdquo; when 12 arrive has not been useful, '
        f'however the hit is scored. Measured per store:</p>'
        f'<p>' + " &middot; ".join(
            f'<b>{_esc(n)}</b> {v:.0f}%' for n, v in
            sorted(kept, key=lambda kv: -kv[1])) + '</p>'
        f'<p>A per-store scaling factor, fitted on each store&rsquo;s own closed '
        f'windows, was validated out-of-sample at Bethany &mdash; 50% to 93% on '
        f'dates it never saw. <b>It does not generalise.</b> Only '
        f'{len(in_band)} store(s) land in a defensible band, and the conclusion '
        f'is that one scalar per store is not enough: where the reversion '
        f'relationship shifts between the calibration period and the measured '
        f'month, the factor is stale.</p>'
        f'<p>Marshfield shows the fallback working as designed &mdash; it has '
        f'history only from February 2025, so there are not enough closed '
        f'windows to fit on and every card uses the identity. That is the right '
        f'behaviour (do not invent a correction) and it is why its promise is '
        f'the worst of the five.</p>'
        f'<p><b>Consequence:</b> {len(neg)} of '
        f'{len([s_ for s_ in stores if _cov(s_) >= 0.01])} stores with cost data '
        f'are <b>net negative in April</b> once the stock the cards called for '
        f'and did not sell is costed. The engine is right about DIRECTION almost '
        f'everywhere and wrong about SIZE almost everywhere, and no hit rate can '
        f'show that.</p></div>')

    costnote = ""
    if no_cost:
        names = ", ".join(f'{s["loc"]}' for s in no_cost)
        costnote = (
            f'<div class="band warn"><h3>{len(no_cost)} store(s) send no cost '
            f'data</h3><p>Locations {names}. Without a cost there is no margin, '
            f'so every money figure for them is an <b>absence, not a zero</b> '
            f'&mdash; printing &ldquo;$0&rdquo; would read as a measurement. '
            f'Their hit rates are unaffected: those measure units against a '
            f'product&rsquo;s own recent rate and never touch cost.</p></div>')

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Botella &mdash; engine audit across {len(stores)} stores</title>
<style>{CSS}</style></head><body><div class="wrap">

<h1>Does the recommendation engine work,<br>store by store?</h1>
<p class="lede">Three layers of evidence for each store: every card issued in
{_esc(month_label)} and what it did, how wrong the forecast is against three
baselines, and a walk-forward backtest across 2.3 years.</p>
<p class="sub">{len(stores)} stores &middot; generated
{datetime.now():%d %B %Y} &middot; every figure produced by
<code>app/pipeline</code>, the production modules, called directly</p>
<hr class="rule">

<div class="band good"><h3>Per store, never pooled</h3>
<p>The engine is switched on one store at a time, so it is judged one store at a
time. A pooled average would also let the largest store carry the result &mdash;
Cork Runner has four times Bethany&rsquo;s line items, so a units-weighted mean
is mostly one store wearing five hats.</p>
<p><b>Read the edge column, not the hit rate.</b> A hit rate of 72% sounds like
skill until you learn that products which have just dipped beat their own recent
rate about 59% of the time anyway. The edge over a reversion-matched null is
what is left after that.</p></div>

{costnote}
{promise_band}

<div class="kpis">
<div class="k"><div class="v">{shipped}<span style="font-size:20px;color:var(--mut)">/{len(stores)}</span></div>
<div class="l">stores clear the bar</div>
<div class="d">a statistically significant edge of at least 5 points over the
hard null</div></div>
<div class="k"><div class="v good">{best["bt_edge"]:+.1f}</div>
<div class="l">strongest edge</div>
<div class="d">{_esc(best["name"])}</div></div>
<div class="k"><div class="v {"bad" if (worst["bt_edge"] or 0) < 5 else ""}">{worst["bt_edge"]:+.1f}</div>
<div class="l">weakest edge</div>
<div class="d">{_esc(worst["name"])} &mdash; published rather than dropped</div></div>
<div class="k"><div class="v">{sum(s["cards"] for s in stores):,}</div>
<div class="l">cards examined</div>
<div class="d">across all stores in {_esc(month_label)}, every one with its
outcome</div></div>
</div>

<h2><span class="num">1</span>Every store</h2>
<p>Click a store for its full report. <b>Backtest</b> columns are the 2.3-year
walk-forward; <b>April</b> columns are the {_esc(month_label)} cards measured 30
days on.</p>
<div class="scroll"><table>
<thead><tr><th>store</th><th>backtest<br>hit rate</th><th>hard<br>null</th>
<th>edge</th><th>p-value</th><th>April<br>hit rate</th><th>promise<br>kept</th>
<th>April net<br>PER CARD</th><th>April net<br>total</th><th>verdict</th></tr></thead>
<tbody>{"".join(rows)}</tbody></table></div>

<h2><span class="num">2</span>The gate, check by check</h2>
<p>Both gates must hold for a store to ship. A gate that does not <b>apply</b>
does not block &mdash; a store sending no unit cost cannot be judged on money
&mdash; but a check that was not <b>measured</b> is never a pass. Every
threshold here is a claim somebody can say is wrong, in which case it gets
changed deliberately rather than drifting.</p>
<div class="band warn"><h3>One check was retired, and this is why</h3>
<p><b>promise_kept</b> asked for 85&ndash;95% of cards to deliver at least the
promised increment. That is unreachable at any store under any promise, by one
line of arithmetic: a promise of at least one unit can only be kept on a card
whose realised increment is at least one unit, so <b>promise_kept &le; hit
rate</b> &mdash; and the hit rates are 83 / 76 / 71 / 62 / 49%. It was the
accuracy target restated as an independent test, and it could not pass until the
thing it was meant to verify already had. The field wired into it was a ratio of
<i>totals</i> rather than a per-card rate, so the number being compared to the
band was not even the same kind of quantity.</p>
<p>It is replaced by <b>promise_unbiased</b>, which asks the separable question
it had buried: is the stated quantity systematically too big or too small? The
kept rate is still measured and printed, because the reason it is not gated has
to stay checkable.</p></div>
{gate_table_html(stores)}

<h2><span class="num">3</span>What this does not prove</h2>
<div class="band bad"><h3>The confidence curve is wired in; nothing is published for it to apply yet</h3>
<p>The <b>calibration_ece</b> and <b>no_unreliable_confidence</b> checks above are
measured honestly &mdash; the curve is fitted on January and February and scored
on March, so no store is graded on a slice it was fitted to. And the live card
path <b>does apply a fitted curve when one exists</b>:
<code>to_raw_recommendations</code> takes a <code>calibration_bundle</code>, maps
each card's raw score through it and names the transform in
<code>confidence_basis</code>. What is missing is the bundle. One is published
only when the pooled fit clears the 50-outcome floor, and today the pool does
not, so no bundle is published and every card carries the raw ranking score with
<code>confidence_basis</code> reading <code>raw_ranking_score</code> &mdash; a
number that orders cards against each other and is deliberately not presented to
an owner as a percentage.</p>
<p>So these two checks say <i>the calibration method works on this store's
data</i>. They do <b>not</b> say an owner is currently seeing a calibrated
percentage, because until the nightly refit
(<code>publish_calibration.py --pooled</code>) crosses the floor, no owner is.
Closing that gap needs scored outcomes in
<code>recommendation_evaluations</code> to accumulate, not more wiring. Until
then a passing ECE is a statement about the engine's capacity, not about today's
cards.</p></div>
<div class="band warn"><h3>Forecasting, not causation</h3>
<p>Nobody acted on any of these recommendations. They were generated
retrospectively from data the engine could legitimately have seen each morning,
so this shows the engine points at products that go on to move. It does
<b>not</b> show that acting on the advice causes the movement. Only a live
holdout &mdash; some cards shown, others deliberately withheld &mdash; proves
that, and production has the mechanism but it is not switched on.</p></div>
<ul>
<li><b>No shelf counts anywhere.</b> Historical on-hand does not exist in the
warehouse, so a dip caused by a stockout is indistinguishable from a dip caused
by slow demand. That contaminates the measurement in both directions, and it is
the single thing most likely to change these numbers once captured.</li>
<li><b>Lead times are declared, not measured.</b> Nothing records when an order
actually arrived, so every order quantity rests on an assumption.</li>
<li><b>One month per store for the ledger.</b> The backtest spans 2.3 years and
is the quotable figure; the month is the one worth checking line by line.</li>
</ul>

<h2><span class="num">4</span>How to reproduce every number</h2>
<div class="scroll"><table>
<thead><tr><th>step</th><th>command</th></tr></thead>
<tbody>
<tr><td>export each store</td>
<td><code>node backend/scripts/export-store-sales.js all --out audit/data</code></td></tr>
<tr><td>all three layers, per store</td>
<td><code>python scripts/run_all_ledgers.py --data ../audit/data --out ../audit
--month 2026-03</code></td></tr>
<tr><td>one store&rsquo;s forecast accuracy</td>
<td><code>python scripts/forecast_accuracy.py --data ../audit/data --file
store_171_sale_items.csv.gz --every 21</code></td></tr>
</tbody></table></div>

<p class="foot">Outcomes graded by <code>app/pipeline/outcomes/lift.py</code>,
the single lift definition pinned digit-for-digit against
<code>backend/lib/lift.js</code>. Rerun with the same exports and these pages
reproduce except for their generation date.</p>
</div></body></html>"""
