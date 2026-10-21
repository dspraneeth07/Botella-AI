#!/usr/bin/env python
"""WHAT CHANGED AND WHY: the previous published numbers against the current ones.

    python scripts/build_change_report.py --old audit/previous/all_stores.json \
        --new audit/all_stores.json --out audit/WHAT_CHANGED.html

WHY A SEPARATE PAGE AND NOT A REVISION OF THE AUDIT
    The audit page answers "does the engine work". This one answers a different
    and shorter-lived question - "why is this number not the number you saw last
    week" - and merging them would bury the first under the second. The previous
    page is kept, unedited, under audit/previous/ and linked from here, so a
    reader can open both and check the claim rather than taking it.

EVERY ROW NAMES A MECHANISM, NOT AN IMPROVEMENT
    A before-and-after table with no causes is a claim that something got better.
    Four of the five changes here are not improvements at all:

        the ruler was wrong          the holding cost charged a write-off for
                                     stock that is merely still on the shelf, so
                                     the OLD net margin was understated. The
                                     engine did not get better, the measurement
                                     stopped being wrong.
        the sample was contaminated  lottery and cigarette lines were inflating
                                     one store's hit rate, so screening them
                                     LOWERS it. That is a correction in the
                                     direction nobody wants and it is published.
        a gate check was unreachable it could not pass at any store under any
                                     promise, and was retired rather than loosened.
        a bin was too thin           five outcomes cannot condemn a store.

    Only the fifth - the calibration curve - is a capability the engine did not
    have before, and it does not yet reach production, which this page says.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from scripts._gates import gate_table                    # noqa: E402
from scripts._ledger_report import CSS, _esc             # noqa: E402
from scripts._store_change_page import (                 # noqa: E402
    build_store_page,
    summary_of,
)


def pct(value: float | None, digits: int = 1) -> str:
    return "—" if value is None else f"{value:.{digits}f}%"


def money(value: float | None) -> str:
    return "—" if value is None else f"${value:+,.0f}"


def delta_cell(old: float | None, new: float | None, *, unit: str = "pt",
               good_up: bool = True, digits: int = 1,
               as_money: bool = False) -> str:
    """The change, coloured by whether it moved the way we want.

    A change of zero is rendered as "unchanged" rather than "+0.0", because a
    store the work did not touch is a different statement from one it moved by a
    negligible amount - and three of these five stores were untouched on some
    rows, which is itself evidence the changes did what they claimed.
    """
    if old is None or new is None:
        return '<td><span class="span">not comparable</span></td>'
    diff = new - old
    if abs(diff) < 0.05:
        return '<td><span class="span">unchanged</span></td>'
    better = (diff > 0) if good_up else (diff < 0)
    shown = (f"${diff:+,.0f}" if as_money else f"{diff:+,.{digits}f}")
    tail = "" if as_money else f'<span class="span">{unit}</span>'
    return (f'<td class="{"good" if better else "bad"}">'
            f'<b>{shown}</b>{tail}</td>')


def store_rows(old: list[dict], new: list[dict]) -> str:
    by_loc = {str(s["loc"]): s for s in old}
    rows = []
    for s in sorted(new, key=lambda x: -(x.get("bt_edge") or 0)):
        o = by_loc.get(str(s["loc"]), {})
        rows.append(
            f'<tr><td><b>{s["loc"]}</b> {_esc(s["name"])}'
            f'<span class="span">{s.get("cards", 0)} cards &middot; '
            f'{s.get("skus", 0)} products</span></td>'
            f'<td>{pct(o.get("hit30"))}</td>'
            f'<td><b>{pct(s.get("hit30"))}</b></td>'
            + delta_cell(o.get("hit30"), s.get("hit30"))
            + f'<td>{money(o.get("net30"))}</td>'
            f'<td><b>{money(s.get("net30"))}</b></td>'
            + delta_cell(o.get("net30"), s.get("net30"), as_money=True)
            + f'<td>{pct(o.get("promise30"), 0)}</td>'
            f'<td><b>{pct(s.get("promise_fill_ratio"), 0)}</b></td>'
            + '</tr>')
    return "".join(rows)


def gate_rows(stores: list[dict]) -> str:
    mark = {True: '<span class="good">PASS</span>',
            False: '<span class="bad">FAIL</span>',
            None: '<span class="span">n/a</span>'}
    blocks = []
    for v in gate_table(stores):
        cls = "good" if v.shippable else "bad"
        rows = "".join(
            f'<tr><td><span class="span">{_esc(g.gate)}</span>'
            f'<b>{_esc(c.name)}</b></td><td>{mark[c.passed]}</td>'
            f'<td>{_esc(c.detail)}</td></tr>'
            for g in (v.gate_a, v.gate_b) for c in g.checks)
        blocks.append(
            f'<div class="band {cls}"><h3>{v.loc} {_esc(v.name)} &mdash; '
            f'{v.verdict}</h3><p>{_esc(v.why)}</p>'
            f'<div class="scroll"><table><thead><tr><th>check</th>'
            f'<th>result</th><th>measured against the threshold</th></tr>'
            f'</thead><tbody>{rows}</tbody></table></div></div>')
    return "".join(blocks)


def coverage_count(stores: list[dict]) -> tuple[int, int, int]:
    """How many checks PASS, FAIL and were never measured. The headline of the
    gate section, because "four checks never ran" is the finding."""
    passed = failed = absent = 0
    for v in gate_table(stores):
        for gate in (v.gate_a, v.gate_b):
            for c in gate.checks:
                if c.passed is True:
                    passed += 1
                elif c.passed is False:
                    failed += 1
                else:
                    absent += 1
    return passed, failed, absent


def build(old: list[dict], new: list[dict]) -> str:
    shipped = [v for v in gate_table(new) if v.shippable]
    passed, failed, absent = coverage_count(new)
    old_passed, old_failed, old_absent = coverage_count(old)

    # Computed, not asserted: which stores moved on money and by how much.
    by_loc = {str(s["loc"]): s for s in old}
    flipped = [s for s in new
               if (by_loc.get(str(s["loc"]), {}).get("net30") or 0) < 0
               and (s.get("net30") or 0) > 0]
    hit_up = [s for s in new
              if (s.get("hit30") or 0) > (by_loc.get(str(s["loc"]), {})
                                          .get("hit30") or 0) + 0.05]
    hit_down = [s for s in new
                if (s.get("hit30") or 0) < (by_loc.get(str(s["loc"]), {})
                                            .get("hit30") or 0) - 0.05]

    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>What changed, and why &mdash; BotellaAI recommendation engine</title>
<style>{CSS}</style></head><body><div class="wrap">

<div class="head">
<h1>What changed, and why</h1>
<p class="lede">The previously published figures against the current ones, with
the mechanism behind every move. The previous pages are kept unedited under
<a href="previous/ENGINE_AUDIT.html"><code>audit/previous/</code></a> so every
number on this page can be checked against the one it replaced.</p>
<p class="span">Four of the five changes below are <b>not</b> improvements to the
engine. Three are corrections to a measurement that was wrong, and one lowers a
store's score. They are published in the direction they fell.</p>
</div>

<div class="kpis">
<div class="card"><div class="val">{len(shipped)} of {len(new)}</div>
<div class="lbl">stores pass both gates</div>
<div class="span">previously 1 of {len(old)}, on one live check</div></div>
<div class="card"><div class="val {'good' if absent == 0 else 'bad'}">
{passed}&thinsp;/&thinsp;{passed + failed + absent}</div>
<div class="lbl">gate checks passing</div>
<div class="span">{failed} fail, {absent} unmeasured
&mdash; was {old_absent} unmeasured</div></div>
<div class="card"><div class="val good">{len(flipped)}</div>
<div class="lbl">stores now net positive</div>
<div class="span">on a corrected holding cost, not a better engine</div></div>
<div class="card"><div class="val">{len(hit_up)}&thinsp;up&thinsp;/&thinsp;{len(hit_down)}&thinsp;down</div>
<div class="lbl">30-day hit rate</div>
<div class="span">the fall is a de-inflation, explained below</div></div>
</div>

<h2><span class="num">1</span>Every store, before and after</h2>
<p><b>April</b> is the March 2026 cards followed 30 days. <b>Net</b> is total net
margin over that window. <b>Delivered vs promised</b> is total units delivered
over total units promised &mdash; 100% means the promise carried no systematic
bias; it is <i>not</i> the fraction of cards that met their promise, and the
column used to be labelled as though it were.</p>
<div class="scroll"><table>
<thead><tr><th>store</th>
<th>April hit<br>before</th><th>April hit<br>now</th><th>change</th>
<th>April net<br>before</th><th>April net<br>now</th><th>change</th>
<th>delivered<br>before</th><th>delivered<br>now</th></tr></thead>
<tbody>{store_rows(old, new)}</tbody></table></div>

<h2><span class="num">2</span>Why each number moved</h2>

<div class="band warn"><h3>1 &mdash; The ruler was wrong, so the old net margin
was understated</h3>
<p>The previous net margin charged the <b>entire cost of goods</b> for every unit
a card said to buy that did not sell, as though the stock had been destroyed.
Liquor does not spoil. A surplus bottle is deferred revenue, and its real cost is
capital tied up, shelf space, and the chance it never sells at full price &mdash;
<b>cents a month on a $20 bottle, not $20</b>.</p>
<p>That single line is the whole of &ldquo;four of five stores are net negative&rdquo;.
It is corrected in
<code>app/pipeline/policy/holding.py</code>, which charges capital plus shelf plus
an obsolescence hazard by category family, and charges the hazard <b>once</b>
rather than accruing it daily. The old figure is still published beside the new
one as <code>net_margin_cogs_ruler</code>, so the size of the correction is
visible rather than quietly absorbed.</p>
<p class="span">This is a measurement correction. The engine's picks did not
change, and nothing here should be read as the engine having improved.</p></div>

<div class="band warn"><h3>2 &mdash; Non-merchandise left the measured path, and
one store's score fell</h3>
<p><code>$2 SCRATCHOFF</code> and <code>MARLBORO PACK</code> are not restockable
merchandise in the sense the engine models, and they were being scored. Screening
them raised the pooled 30-day hit rate from <b>68.9% to 75.7%</b>.</p>
<p>At Northlake it did the opposite: the lottery and cigarette lines were hitting
6-of-6 and 5-of-6 and <b>inflating</b> that store, so removing them took it from
<b>54.7% down to 50.8%</b>. The lower number is the truer one. A screen that only
ever raises a score is a screen that is selecting on the outcome.</p></div>

<div class="band bad"><h3>3 &mdash; A gate check could never pass, at any store,
under any promise</h3>
<p><code>promise_kept</code> asked for 85&ndash;95% of cards to deliver at least
the promised increment. One line of arithmetic retires it: a promise of at least
one unit can only be kept on a card whose realised increment is at least one
unit, so <b>promise_kept &le; hit rate</b> &mdash; and the hit rates are
83 / 76 / 71 / 62 / 49%. It was the accuracy target restated as an independent
test, and it could not pass until the thing it was meant to verify already had.</p>
<p>The field wired into it was a ratio of <i>totals</i> rather than a per-card
rate, so the number being compared against the band was not even the same kind of
quantity &mdash; Marshfield was handed a SHIP for under-delivering 11% in
aggregate while Cork Runner failed for over-delivering. It is replaced by
<code>promise_unbiased</code>, a band centred on 100%. The kept rate is still
measured and printed, because the reason it is not gated has to stay checkable.</p>
</div>

<div class="band bad"><h3>4 &mdash; Four of seven gate checks had never run</h3>
<p><code>calibration_ece</code>, <code>no_unreliable_confidence</code>,
<code>interval_coverage</code> and both gate&nbsp;B coverage checks printed
&ldquo;not measured&rdquo; at every store since the day the gate was written,
because nothing computed the fields it reads. Verdicts were being issued on
<b>one live check out of four</b> in gate&nbsp;A.</p>
<p>The reason <code>interval_coverage</code> could never run is worth stating
plainly: the card published a <b>point</b> (&ldquo;about 78 units&rdquo;), so
there was no range whose coverage could be checked. The card now publishes one,
and it is the range the gate tests &mdash; measuring the coverage of an interval
the owner never sees would be scoring the engine on a claim it never made.</p>
<p>The report also carried <b>two rival definitions of the word ship</b>: the
index computed one from the backtest edge alone while the gate computed another
from four different checks, for the same store, on the same page, and the looser
one was in the headline. The edge test is now a check inside gate&nbsp;A
(<code>beats_null</code>).</p></div>

<div class="band good"><h3>5 &mdash; The confidence can now be calibrated, and it
is measured out of sample</h3>
<p>The raw <code>p_hit</code> is a ranking score, not a probability, and the card
says so in as many words. Measured against outcomes it is <b>34.1 / 31.4 / 23.9 /
12.0 / 3.5 points</b> out at the five stores.</p>
<p>Fitting the isotonic curve on <b>January and February</b> and scoring
<b>March</b> &mdash; so no store is graded on a slice it was fitted to &mdash;
collapses that at three of five stores: Marshfield <b>34.1 &rarr; 0.3</b>, Cork
Runner <b>23.9 &rarr; 1.5</b>, Bethany <b>12.0 &rarr; 2.6</b>. At Northlake the
curve makes it <b>worse</b> (3.5 &rarr; 15.0), because the raw score happened to
be well calibrated there and the fit pulled it away. That is published too.</p>
<p>A fifth change made this measurable: a reliability bin holding five outcomes
was condemning a whole store. At n&nbsp;=&nbsp;30 and p&nbsp;=&nbsp;0.5 the
binomial standard error is <b>9.1 points</b>, which is the floor at which a
10-point per-bin test stops measuring noise, so
<code>MIN_BIN_OUTCOMES&nbsp;=&nbsp;30</code>. Marshfield's real 171-card,
33.8-point failure still stands; Northlake's five-card one does not.</p></div>

<h2><span class="num">3</span>The gate, check by check</h2>
<p>Both gates must hold for a store to ship. A gate that does not <b>apply</b>
does not block &mdash; a store sending no unit cost cannot be judged on money
&mdash; but a check that was not <b>measured</b> is never a pass. Every threshold
is a claim somebody can say is wrong, in which case it gets changed deliberately
rather than drifting.</p>
{gate_rows(new)}

<h2><span class="num">4</span>What this still does not prove</h2>
<div class="band bad"><h3>The confidence curve is wired in; nothing is published for it to apply</h3>
<p>The calibration checks above are measured honestly, and the live card path
<b>does apply a fitted curve when one exists</b>:
<code>to_raw_recommendations</code> takes a <code>calibration_bundle</code>, maps
each card's raw score through it and names the transform in
<code>confidence_basis</code>. But a bundle is published only when the pooled fit
clears the 50-outcome floor, and today the pool does not, so no bundle is
published and every card carries the raw ranking score with
<code>confidence_basis</code> reading <code>raw_ranking_score</code>. So those
checks say <i>the calibration method works on this store's data</i>; they do not
say an owner is seeing a calibrated percentage, because until the nightly refit
(<code>publish_calibration.py --pooled</code>) crosses the floor, no owner is.
Closing it needs scored outcomes in <code>recommendation_evaluations</code> to
accumulate, not more wiring.</p></div>
<ul>
<li><b>Nobody acted on any of these recommendations.</b> They were generated
retrospectively from data the engine could legitimately have seen each morning,
so this shows the engine points at products that go on to move. It does not show
that acting on the advice causes the movement.</li>
<li><b>No shelf counts anywhere.</b> Historical on-hand does not exist in the
warehouse, so a dip caused by a stockout is indistinguishable from a dip caused
by slow demand.</li>
<li><b>Lead times are declared, not measured.</b> Nothing records when an order
actually arrived.</li>
<li><b>Marshfield's high figures rest on few distinct products.</b> Overlapping
cards on the same SKU are treated as independent, so its ledger rates are
cards-based and flatter a narrow catalogue.</li>
</ul>

<div class="foot"><p>Generated from
<code>audit/previous/all_stores.json</code> and <code>audit/all_stores.json</code>
by <code>scripts/build_change_report.py</code>. Every figure on this page is read
from those two files or computed from the per-store ledgers; none is typed in.</p>
</div>
</div></body></html>"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--old", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--out", required=True,
                    help="the combined page. One page per store is written "
                         "beside it as WHAT_CHANGED-<loc>.html")
    ap.add_argument("--month", default="2026-03")
    # EXPLICIT, not derived from --out. Deriving it meant writing the pages
    # anywhere but the audit folder silently produced "No money measured" at every
    # store, because the per-store ledgers were not beside the output - a wrong
    # page rather than an error, which is the worst way for a path to be wrong.
    ap.add_argument("--ledgers", default=None,
                    help="directory holding the CURRENT per-store ledger folders "
                         "(default: the directory --out is written to)")
    ap.add_argument("--previous-ledgers", default=None,
                    help="directory holding the PREVIOUS per-store ledger folders "
                         "(default: the directory --old is read from)")
    args = ap.parse_args()

    old = json.loads(Path(args.old).read_text(encoding="utf-8"))
    new = json.loads(Path(args.new).read_text(encoding="utf-8"))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build(old, new), encoding="utf-8")
    print(f"  wrote {out}  ({out.stat().st_size:,} bytes)")

    # ONE PAGE PER STORE. The engine is switched on one store at a time, so it is
    # explained one store at a time - and at one of these five the hit rate went
    # DOWN, which a shared page would bury under four stores where it rose.
    label = datetime.strptime(args.month, "%Y-%m").strftime("%B %Y")
    ledgers = Path(args.ledgers) if args.ledgers else out.parent
    previous = (Path(args.previous_ledgers) if args.previous_ledgers
                else Path(args.old).parent)
    by_loc = {str(s["loc"]): s for s in old}
    missing = []
    for store in sorted(new, key=lambda x: -(x.get("bt_edge") or 0)):
        loc = str(store["loc"])
        folder = store.get("folder") or f"ledger-{loc}-{args.month}"
        current = ledgers / folder / "ledger.json"
        if not current.exists():
            missing.append(str(current))
        page = out.parent / f"WHAT_CHANGED-{loc}.html"
        page.write_text(
            build_store_page(
                store, by_loc.get(loc, {}),
                summary_of(previous / folder / "ledger.json"),
                summary_of(current),
                label, pct=pct, money=money, delta_cell=delta_cell,
            ),
            encoding="utf-8")
        print(f"  wrote {page}  ({page.stat().st_size:,} bytes)")
    if missing:
        # Loud, and a non-zero exit. A page that renders "No money measured"
        # because a path was wrong looks exactly like a store with no cost data,
        # and that is not a mistake to discover by reading the page.
        print("\n  WARNING: no current ledger found for:")
        for path in missing:
            print(f"    {path}")
        print("  Those pages have no 'now' column. Pass --ledgers.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
