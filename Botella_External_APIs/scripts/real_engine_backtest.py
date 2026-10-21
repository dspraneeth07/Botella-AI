#!/usr/bin/env python
"""Backtest the REAL engine — the modules in `app/pipeline`, not a port of them.

    python scripts/real_engine_backtest.py --data "C:/path/to/dataset" --out run/

WHY THIS EXISTS SEPARATELY FROM THE NOTEBOOK
    The Colab notebook contains a *re-implementation* of the engine, written to
    run without this repo. It is kept faithful by hand, which means it is
    faithful until someone changes one side. A number produced by a port is
    evidence about the port.

    This script imports the production modules and calls them. Every figure it
    prints comes from the same code path a store request would take:

        assemble.estimate_and_forecast   04 -> 05 -> 06 -> 20 -> 07
        policy.order_up_to               10
        constraints.apply_constraints    11
        candidates.generate_candidates   12
        rank.score_candidate / order     13
        validate.validate_decision       14
        outcomes.lift.lift_for           19   <- the SINGLE lift definition,
                                               the one pinned digit-for-digit
                                               against backend/lib/lift.js

    If this disagrees with the notebook, the notebook is wrong.

WHAT IT MEASURES, AND THE ONE THING TO BE SCEPTICAL ABOUT
    A "hit" is: the recommended SKU sold at least what its own trailing rate
    implied. That is production's definition and it is a fair test of whether a
    pick was worth making.

    It is NOT a neutral test of this particular engine, and the report says so.
    Sheet 20 selects SKUs whose trailing window is depressed against their own
    long run; the metric asks whether they then beat that trailing window.
    Those are close to the same question, so some of the measured edge is
    regression to the mean rather than foresight.

    That is why REGRESSION-MATCHED nulls are computed alongside the ordinary
    volume-matched ones: baskets drawn from SKUs with a SIMILAR reversion
    profile. The gap between the engine and that null is the part of the edge
    that is not mechanical, and it is the number to quote to a sceptic.

NO DATABASE. Python holds no analytics credentials and opens no connection;
the whole run is a function of one CSV export, which is what makes it
replayable months later.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import re
import os
import random
import sys
from collections import defaultdict
from bisect import bisect_right
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline.assemble import (  # noqa: E402
    EstateInput,
    SkuInput,
    estimate_and_forecast,
)
from app.pipeline.candidates.merchandise import (
    is_merchandise as catalogue_allows,
)
from app.pipeline.features.taxonomy import (
    NON_STOCK_TERMS,
    category_family_of,
)
from app.recommender.deterministic import is_orderable_sku as route_allows
from app.pipeline.blend.reversion import (  # noqa: E402
    MATERIALITY_FLOOR_UNITS,
    MIN_HIT_PROBABILITY,
    ReversionRequest,
    is_recommendable,
    revert,
)
from app.pipeline.context import RunContext  # noqa: E402
from app.pipeline.features.store import CalendarDay, DayFact  # noqa: E402
from app.pipeline.outcomes.lift import SkuOutcome, lift_for  # noqa: E402
from app.pipeline.rank.score import ScoreInputs, score_candidate  # noqa: E402
from app.pipeline.registry import cfg  # noqa: E402
from scripts import _report_charts as charts  # noqa: E402

#: Register-mechanic SKUs. Not products; they would dominate every rate.
#: "1000" is CRV - California's bottle deposit, rung as a line item.
REGISTER_MECHANICS = frozenset({"GIFT_C", "2", "22", "10%DISCOUNT", "05",
                                "non_inventory", "1000", "CRV"})

#: A single line item cannot plausibly be this many units.
#:
#: This is sheet 02's job - the data contract - and it is reproduced here
#: because the backtest reads a CSV rather than the contracted feature store.
#: It is not a tuning knob: across the five pilot stores the median line is 1
#: unit and the 99th percentile is 20, so anything past a thousand is a POS
#: entry error rather than a large order.
#:
#: FOUND BY THIS AUDIT, NOT ASSUMED. Store 177 carries a line of 8,245,805
#: units of a 50ml Tito's at $0.00, which alone produced a reported
#: incremental margin of $98,606,895 on a store that turns over $7M a year.
#: A number that wrong is easy to catch; the danger is the same defect one
#: order of magnitude smaller, which would have looked plausible and moved
#: every rate for that SKU.
#:
#: Dropped rows are COUNTED AND REPORTED, never silently discarded - a filter
#: that hides how much it removed is indistinguishable from a bug.
MAX_PLAUSIBLE_LINE_QUANTITY = 1000

#: A line's quantity is suspicious when it exceeds this multiple of the same
#: SKU's 95th percentile. Twelve admits a case of a SKU normally sold singly;
#: it refuses a hundredfold.
SKU_OUTLIER_MULTIPLE = 12.0

#: ...but never refuse below this, so a SKU with two recorded sales cannot
#: produce a threshold of two and start refusing its own ordinary lines.
SKU_OUTLIER_FLOOR = 24.0

#: Quantities at or above this are checked against the line's own SKU and UPC.
#: Below it an identifier collision is a coincidence worth keeping (a SKU of
#: "6" and a genuine six-pack); above it, it is a mapping error.
IDENTIFIER_QTY_MIN = 1000.0

HORIZONS = (30, 60, 90, 120)
N_RECS = 10
NULL_BASKETS = 400

#: Permutation draws behind every p-value here. NOT the same thing as
#: NULL_BASKETS, and the confusion is not hypothetical: a reviewer took the
#: 400 baskets for the permutation count, derived a floor of 1/401 = 0.0025,
#: and reported the printed 0.0005 as arithmetically impossible. It is
#: 1/2001. Named once here and printed in the report so the figure can be
#: reconciled without reading the source.
PERM_DRAWS = 2000
BASELINE_WINDOW_DAYS = 28
COHORT_WINDOW_DAYS = 364


HTML_TEMPLATE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Botella - Real Engine Backtest</title><style>
:root{background:#fff;--bg:#fff;--fg:#0f172a;--mut:#64748b;--line:#e2e8f0;
--card:#f8fafc;--good:#059669;--bad:#dc2626;--acc:#2563eb}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b1120;
--fg:#e2e8f0;--mut:#94a3b8;--line:#1e293b;--card:#111827;--acc:#60a5fa}}
:root[data-theme="dark"]{--bg:#0b1120;--fg:#e2e8f0;--mut:#94a3b8;
--line:#1e293b;--card:#111827;--acc:#60a5fa}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:40px 22px 80px}
h1{font-size:30px;margin:0 0 6px;letter-spacing:-.02em}
h2{font-size:20px;margin:44px 0 12px;padding-top:22px;
border-top:1px solid var(--line)}
.sub{color:var(--mut);font-size:13px;margin:0 0 26px}
.head{background:var(--card);border:1px solid var(--line);
border-left:4px solid var(--good);border-radius:8px;padding:20px 22px;
margin:0 0 26px}
.head b{font-size:17px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
gap:12px;margin:20px 0}
.k{background:var(--card);border:1px solid var(--line);border-radius:8px;
padding:14px}
.k .v{font-size:26px;font-weight:650;letter-spacing:-.02em}
.k .l{font-size:12px;color:var(--mut);text-transform:uppercase;
letter-spacing:.05em;margin-top:2px}
.k .d{font-size:12px;color:var(--mut);margin-top:6px;line-height:1.45}
.good{color:var(--good)}.bad{color:var(--bad)}
table{width:100%%;border-collapse:collapse;font-size:14px;margin:14px 0}
th,td{text-align:right;padding:7px 9px;border-bottom:1px solid var(--line)}
th:first-child,td:first-child{text-align:left}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;
color:var(--mut)}
.scroll{overflow-x:auto}
.note{background:var(--card);border:1px solid var(--line);border-radius:8px;
padding:14px 18px;margin:18px 0;font-size:14px}
.warn{border-left:4px solid #d97706}
code{background:var(--card);border:1px solid var(--line);padding:1px 5px;
border-radius:4px;font-size:13px}
ul{padding-left:20px}li{margin:7px 0}
</style></head><body><div class="wrap">

<h1>Botella &mdash; real engine backtest</h1>
<p class="sub">%(store)s &middot; %(n)d measurable predictions
&middot; %(dates)d decision dates &times; %(horizons)d horizons &middot;
%(lines)s transaction lines &middot; %(products)s products &middot;
generated %(gen)s</p>

%(costwarn)s

<div class="head"><b>Every number on this page was produced by
<code>app/pipeline</code> &mdash; the production modules, called directly.</b>
<br>Not a re-implementation and not a notebook port. The lift is
<code>app/pipeline/outcomes/lift.py</code>, the single definition pinned
digit-for-digit against <code>backend/lib/lift.js</code> that grades
recommendations in the live product.</div>

<div class="kpis">
<div class="k"><div class="v">%(hit).0f%%</div><div class="l">hit rate</div>
<div class="d">beat their own trailing rate. Clustered 95%% CI
%(lo).0f&ndash;%(hi).0f%%</div></div>
<div class="k"><div class="v">%(null_r).0f%%</div><div class="l">hard null</div>
<div class="d">same measurement on SKUs equally primed to revert</div></div>
<div class="k"><div class="v %(good_edge)s">%(edge_r)+.0f</div>
<div class="l">point edge</div><div class="d">over the hard null. This is the
number that survives scrutiny.</div></div>
<div class="k"><div class="v">%(med_lift).2f&times;</div>
<div class="l">median lift</div>
<div class="d">1.0 means the pick sold exactly at its existing rate</div></div>
<div class="k"><div class="v %(good_imp)s">$%(impact_s)s</div>
<div class="l">incremental margin</div>
<div class="d">(sold &minus; expected) &times; unit margin: money that would
not have arrived anyway</div></div>
<div class="k"><div class="v">%(size).0fu</div><div class="l">median pick</div>
<div class="d">units per 28 open days &mdash; big enough to act on</div></div>
<div class="k"><div class="v">%(pval)s</div><div class="l">p-value</div>
<div class="d">pooled permutation against the HARD null. Add-one, so it can
never print a true zero</div></div>
<div class="k"><div class="v">%(cpr).1f</div><div class="l">cards per run</div>
<div class="d">out of a 10-slot slate. The engine shows what clears the bar,
not a padded ten</div></div>
</div>

<h2>1. Two nulls, and why the second one matters</h2>
<p>The engine selects SKUs whose recent window is depressed against their own
long run. The metric asks whether they then beat that recent window. Those are
close to the same question, so part of any edge is <b>regression to the
mean</b> rather than foresight. A report that did not say so would be
flattering itself.</p>
<p>So two baselines are computed. The <b>volume-matched</b> null is the usual
one: random baskets of similar-sized products. The <b>reversion-matched</b>
null is the hard one &mdash; random baskets drawn from SKUs that were
<em>equally primed to revert</em>. The engine's edge over that is the part that
is not mechanical, and it is the number to quote to a sceptic.</p>
<div class="scroll"><table>
<tr><th>baseline</th><th>hit rate</th><th>engine edge</th></tr>
<tr><td>volume-matched null (the usual test)</td><td>%(null_v).1f%%</td>
<td>%(edge_v)+.1f pts</td></tr>
<tr><td><b>reversion-matched null (the hard test)</b></td>
<td><b>%(null_r).1f%%</b></td><td><b>%(edge_r)+.1f pts</b></td></tr>
<tr><td>the engine</td><td><b>%(hit).1f%%</b></td><td>&mdash;</td></tr>
</table></div>

<div class="note"><b>Which significance test, and why.</b> Each decision run
shows about %(cpr).1f cards, so a permutation test <em>per run</em> is nearly
powerless &mdash; five coin flips cannot be significant. Combining %(runs)s such
tests by Fisher's method returns <b>p = %(fisher)s</b>, which is a test discarding
its own evidence, not a null result. The figure above pools every run's picks
and compares them against pooled matched-random slates drawn run by run, so
clustering is honoured and the power is not thrown away. Both are printed by
the script; neither is hidden.</div>

<h2>2. How far ahead it can see</h2>
<p>Blue is the engine, grey is the reversion-matched null.</p>
%(bars)s
<div class="scroll"><table>
<tr><th>horizon</th><th>n</th><th>hit</th><th>95%% CI</th><th>hard null</th>
<th>edge</th><th>median lift</th></tr>%(rows_h)s</table></div>

<h2>2b. Every decision date, not just the average</h2>
<p>An average can rest on one lucky window. This is the hit rate at each of the
%(dates)d decision dates across the full export &mdash; if the result depended
on a single good month it would show up here as one tall bar in a field of
short ones.</p>
%(over_time)s

<h2>2c. The spread, not just the median</h2>
<p>A median lift of %(med_lift).2f&times; could come from many small wins or a
few enormous ones. Red bars are picks that did <b>not</b> beat their own rate
&mdash; they are part of the record.</p>
%(lift_hist)s

<h2>2d. Does its confidence mean anything?</h2>
<p>A confidence that does not track outcomes is worse than none, because it
both ranks the cards and gets printed on them. Sheet 08 measured the previous
engine at <b>0.48 stated against 0.23 actual</b>; this is the same check on the
current one.</p>
%(calib)s
<div class="note warn"><b>%(calib_verdict)s</b> %(calib_detail)s
So <code>p_hit</code> is doing its job as a
<em>gate</em> (everything above the floor beats 70%%) and doing it poorly as a
<em>fine-grained ranking</em> within the eligible set.
<p>The practical consequence: showing the top 3 cards instead of the top 10 is
<b>not</b> reliably better, because the ordering inside the slate carries
little information. The honest lever is the floor, not the rank. Sharpening
this is the clearest next piece of work on the engine.</p></div>

<h2>3. Against the ordering it replaced</h2>
<p>The same pipeline, the same forecasts, the same data &mdash; only what
expected value multiplies changes. <code>total demand</code> is what shipped
before; <code>deficit</code> is sheet 20.</p>
<div class="scroll"><table>
<tr><th>ordering</th><th>cards</th><th>hit rate</th><th>incremental<br>PER CARD</th>
<th>incremental<br>total</th><th>margin flow<br>touched</th><th>median pick</th></tr>
<tr><td><b>sheet 20 &mdash; margin &times; deficit, gated</b></td>
<td>%(n)d</td><td><b>%(hit).1f%%</b></td>
<td class="%(good_imp)s"><b>$%(per_card_s)s</b></td>
<td class="%(good_imp)s">$%(impact_s)s</td>
<td>$%(captured_s)s</td><td>%(size).0fu</td></tr>
<tr><td>old &mdash; margin &times; total demand, ungated</td><td>%(b_n)d</td>
<td>%(b_hit).1f%%</td>
<td class="%(good_old)s"><b>$%(b_per_card_s)s</b></td>
<td class="%(good_old)s">$%(b_impact_s)s</td>
<td>$%(b_captured_s)s</td><td>%(b_size).0fu</td></tr>
</table></div>
<div class="note warn"><b>Read the PER CARD column, not the total.</b> The two
arms do not place the same number of bets &mdash; %(n)d cards against %(b_n)d
&mdash; because sheet 20 shows only what clears its bar. Comparing raw totals
across different card counts compares a rate to a volume and calls the
difference a result.

<p><b>And be honest about coverage.</b> Sheet 20 touches
<b>$%(captured_s)s</b> of margin flow where the old ordering touched
<b>$%(b_captured_s)s</b>. It is a smaller, sharper intervention: fewer cards,
smaller products, far higher accuracy. If the goal is to influence as much of
the shop as possible, that is a real trade-off and the confidence floor is the
dial &mdash; lowering it to 0.40 restores a full ten-card slate at about four
points of hit rate.</p></div>

<div class="note"><b>Two margin numbers, and only one of them is a verdict.</b>
<code>total captured</code> is <code>sold &times; margin</code> &mdash;
dominated by how big the picks are, so an engine that simply names the shop's
biggest sellers maximises it while predicting nothing.
<code>incremental</code> is <code>(sold &minus; expected) &times; margin</code>
&mdash; money that would not have arrived anyway. Judge a recommendation on the
second.</div>

<h2>4. What it screened out on the way to a slate</h2>
<p><b>This is shortlisting, not refusing to recommend.</b> The engine looks at
all %(products)s products and returns a slate. It produced cards on
<b>every one of the %(runs)d runs</b> and has never come back empty. The counts
below are how many SKUs were screened out on the way there, which is what
ranking is &mdash; an owner is never shown fewer cards because of a gate, only
better ones.</p>
<p>The gates are commercial rather than statistical: the SKU must be big enough
to be worth an owner's attention, the evidence must point up, and the engine
must be more likely right than not. These counts come from the real predicate,
not from a description of it.</p>
<div class="scroll"><table><tr><th>reason</th><th>candidates</th></tr>
%(rows_r)s</table></div>

<h2>5. The picks that made the most money</h2>
<p>One row per (product, date) &mdash; the same pick is evaluated at four
horizons, so an undeduplicated list shows six real picks wearing twelve hats.
Note what these rows say: the biggest earners sit at
<b>p_hit 0.50&ndash;0.60</b>, near the floor rather than at the top of the
range, and most sell under 20 units a month. <b>Money and confidence are not
the same axis</b>, and the engine currently ranks on confidence.</p>
<div class="scroll"><table>
<tr><th>sku</th><th>date</th><th>h</th><th>28d units</th><th>uplift</th>
<th>p_hit</th><th>hit</th><th>lift</th><th>incremental</th></tr>
%(rows_p)s</table></div>

%(quality)s

<h2>6. What this does not prove</h2>
<div class="note warn"><b>This measures forecasting, not causation.</b> Nobody
acted on these recommendations &mdash; they were generated retrospectively. It
shows the engine can point at products that were about to move. It does not
show that following the advice causes extra sales. Only a live holdout, where
some recommendations are shown and others deliberately withheld, proves that.
Production has the mechanism (<code>REC_HOLDOUT_PCT</code>, FNV-1a keyed on
client:location:sku:family); it needs switching on.</div>
<ul>
<li><b>One store.</b> Every figure is %(store)s. Another store
with different categories or a different customer base could look materially
different - which is exactly why this report is produced per store rather than
pooled.</li>
<li><b>%(n)d measurable predictions.</b> Enough to detect a large effect, not
enough to measure a small one precisely &mdash; which is why every number
carries an interval, and why the headline interval is clustered by date rather
than by row.</li>
<li><b>No live inventory.</b> The production engine also sees stock levels,
which drive its understock and overstock recommendations. This replay had no
historical on-hand, so those families are absent and the engine is being judged
on less than it normally has.</li>
<li><b>90%% is not reachable on this metric.</b> For a SKU selling ~10 units a
month, Poisson noise alone puts it below its own mean about a third of the time
regardless of what is known in advance.</li>
</ul>

<h2>7. Architecture</h2>
<p>No model chooses anything. The LLM writes the sentence <em>after</em> the
decision is fixed, so a model outage costs fluency and never a recommendation.
Python holds no analytics credentials and opens no database connection &mdash;
the whole pipeline is a pure function of one payload, which is what makes a
card reproducible months later.</p>
%(arch)s

<h2>8. Configuration</h2>
<div class="scroll"><table><tr><th>setting</th><th>value</th></tr>
%(rows_cfg)s
<tr><td>trading days in the export</td><td>%(trading)s</td></tr>
</table></div>
</div></body></html>"""


# ── Loading ──────────────────────────────────────────────────────────────────


@dataclass
class Store:
    """Everything the harness needs, derived once from the export."""

    trading_days: list[date]
    daily: dict[str, dict[date, float]]
    price: dict[str, float]
    cost: dict[str, float]
    category: dict[str, str]
    #: sku -> the name on the shelf. A ledger of bare SKU codes is not
    #: something a store owner can check, and checking it is the point.
    names: dict[str, str] = field(default_factory=dict)
    n_lines: int = 0
    #: Line items refused by the quantity contract, kept so the report can say
    #: exactly what was removed and why.
    dropped_lines: list[tuple[str, str, float, str, str]] = field(default_factory=list)
    #: Fraction of sold lines carrying a usable cost. Three of the ten stores
    #: audited carry NONE, and without cost there is no margin - every money
    #: figure for such a store is an absence, not a zero, and the report has to
    #: say which.
    cost_coverage: float = 0.0

    #: Built once by `index()`. Without these every window scanned all 1,147
    #: trading days, and a 50-date run is ~4,900 SKUs x 4 horizons x 50 dates
    #: x several windows - hundreds of millions of comparisons, which is why
    #: the first version of this script could only afford six dates. Six dates
    #: is n=28 a horizon and a confidence interval 30 points wide.
    _sku_days: dict[str, list[date]] = field(default_factory=dict, repr=False)
    _sku_cum: dict[str, list[float]] = field(default_factory=dict, repr=False)

    def index(self) -> None:
        """Prefix sums per SKU, so a window is two binary searches."""
        for sku, by in self.daily.items():
            ds = sorted(by)
            cum = [0.0]
            for d in ds:
                cum.append(cum[-1] + by[d])
            self._sku_days[sku] = ds
            self._sku_cum[sku] = cum

    def open_days(self, start: date, end: date) -> int:
        """OPEN days in (start, end]. Sheet 03's denominator, never calendar."""
        lo = bisect_right(self.trading_days, start)
        hi = bisect_right(self.trading_days, end)
        return max(0, hi - lo)

    def units(self, sku: str, start: date, end: date) -> float:
        ds = self._sku_days.get(sku)
        if not ds:
            return 0.0
        cum = self._sku_cum[sku]
        lo = bisect_right(ds, start)
        hi = bisect_right(ds, end)
        return cum[hi] - cum[lo] if hi > lo else 0.0

    def rate(self, sku: str, start: date, end: date) -> float:
        n = self.open_days(start, end)
        return (self.units(sku, start, end) / n) if n else 0.0


def load(data_dir: str, filename: str | None = None) -> Store:
    """Read the export. Pure stdlib — the pipeline forbids a numeric stack."""
    if filename:
        path = filename if os.path.isabs(filename) else os.path.join(data_dir, filename)
    else:
        path = os.path.join(data_dir, "bethanys_sale_items_2023_2026.csv.gz")
    if not os.path.exists(path):
        raise SystemExit(f"not found: {path}")

    import csv

    daily: dict[str, dict[date, float]] = defaultdict(dict)
    px: dict[str, list[float]] = defaultdict(list)
    ct: dict[str, list[float]] = defaultdict(list)
    cat: dict[str, str] = {}
    names: dict[str, str] = {}
    trading: set[date] = set()
    dropped: list[tuple[str, str, float, str, str]] = []
    buffered: list[tuple[str, date, float, Any, Any, str, str]] = []
    by_sku_qty: dict[str, list[float]] = defaultdict(list)
    n_lines = 0
    sold_lines = 0
    cost_lines = 0

    with gzip.open(path, "rt", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            n_lines += 1
            if row.get("item_status") != "Sold":
                continue
            sku = (row.get("sku") or "").strip()
            if not sku or sku in REGISTER_MECHANICS:
                continue
            try:
                qty = float(row.get("quantity") or 0)
            except ValueError:
                continue
            if qty <= 0:
                continue
            if qty > MAX_PLAUSIBLE_LINE_QUANTITY:
                dropped.append((row.get("sale_date", "")[:10], sku, qty,
                                (row.get("product_name") or "")[:40],
                                f"over the absolute cap of "
                                f"{MAX_PLAUSIBLE_LINE_QUANTITY:,.0f}"))
                continue
            # A quantity that IS the product identifier is a mapping error.
            if qty >= IDENTIFIER_QTY_MIN:
                ident = {sku, (row.get("upc") or "").strip()}
                if any(i and i.isdigit() and float(i) == qty for i in ident):
                    dropped.append((row.get("sale_date", "")[:10], sku, qty,
                                    (row.get("product_name") or "")[:40],
                                    "quantity equals the SKU or UPC"))
                    continue
            d = datetime.strptime(row["sale_date"][:10], "%Y-%m-%d").date()
            buffered.append((sku, d, qty, row.get("cost"),
                             row.get("price"), row.get("product_name") or "",
                             row.get("category") or ""))
            by_sku_qty[sku].append(qty)

    # SECOND PASS. A quantity is only implausible relative to its own
    # product, so the threshold cannot be known until every line has been
    # seen. Buffering is what makes that possible; the export is one store.
    thresholds: dict[str, float] = {}
    for k, qs in by_sku_qty.items():
        ordered = sorted(qs)
        p95 = ordered[min(len(ordered) - 1, int(0.95 * len(ordered)))]
        thresholds[k] = max(SKU_OUTLIER_FLOOR, p95 * SKU_OUTLIER_MULTIPLE)

    for sku, d, qty, c_raw, p_raw, nm, cg in buffered:
        if qty > thresholds[sku]:
            dropped.append((d.isoformat(), sku, qty, nm[:40],
                            f"{qty:,.0f} against this SKU's own threshold of "
                            f"{thresholds[sku]:,.0f}"))
            continue
        sold_lines += 1
        try:
            if float(c_raw or 0) > 0:
                cost_lines += 1
        except ValueError:
            pass
        trading.add(d)
        daily[sku][d] = daily[sku].get(d, 0.0) + qty
        for raw, store in ((p_raw, px), (c_raw, ct)):
            try:
                v = float(raw or 0)
            except ValueError:
                continue
            if v > 0:
                store[sku].append(v)
        if cg:
            cat.setdefault(sku, cg)
        if nm:
            names.setdefault(sku, nm)

    def median(xs: list[float]) -> float:
        s = sorted(xs)
        n = len(s)
        return 0.0 if not n else (s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2)

    store = Store(
        trading_days=sorted(trading),
        daily={k: dict(v) for k, v in daily.items()},
        price={k: median(v) for k, v in px.items() if v},
        cost={k: median(v) for k, v in ct.items() if v},
        category=cat,
        names=names,
        n_lines=n_lines,
        dropped_lines=dropped,
        cost_coverage=(cost_lines / sold_lines) if sold_lines else 0.0,
    )
    store.index()
    return store


# ── Driving the real pipeline ────────────────────────────────────────────────


def run_context(as_of: date, horizon: int) -> RunContext:
    return RunContext(
        run_id=f"backtest-{as_of}-{horizon}",
        tenant_id=171, store_id=171, as_of=as_of,
        snapshot_id=f"snap-{as_of}", config_version="default", seed=0,
        versions={
            "temporal_reversion": "1.0.0", "shrink_blend": "1.0.0",
            "rank": "1.0.0",
        },
    )


def build_estate(store: Store, as_of: date, skus: list[str]) -> EstateInput:
    """The dense calendar and the day facts, as the feature store would supply.

    A day the store traded and sold none of a SKU is a real observation, not a
    gap - so facts carry explicit zeros. `was_open` comes from whether ANY sale
    happened estate-wide that day, which is how the export records closures:
    199 closed days (Sundays, Thanksgiving, Christmas, New Year) across the
    period, and treating those as zero-demand days would distort every rate.
    """
    start = as_of - timedelta(days=COHORT_WINDOW_DAYS)
    open_set = set(store.trading_days)
    calendar = [
        CalendarDay(obs_date=start + timedelta(days=i),
                    was_open=(start + timedelta(days=i)) in open_set,
                    has_data=True)
        for i in range(COHORT_WINDOW_DAYS + 1)
        if start + timedelta(days=i) <= as_of
    ]
    facts: list[DayFact] = []
    for sku in skus:
        by = store.daily.get(sku, {})
        p = store.price.get(sku)
        c = store.cost.get(sku)
        for d in store.trading_days:
            if not (start < d <= as_of):
                continue
            facts.append(DayFact(obs_date=d, sku=sku,
                                 units_sold=float(by.get(d, 0.0)),
                                 price=p, unit_cost=c))
    return EstateInput(
        store_key=(171, 171), subject_state="TX",
        calendar=calendar, facts=facts,
        candidates=[((171, 171), "TX")],
        window_days=COHORT_WINDOW_DAYS,
    )


def weekly_rates(store: Store, sku: str, as_of: date, weeks: int = 13) -> tuple[float, ...]:
    out = []
    for k in range(weeks):
        b = as_of - timedelta(days=7 * k)
        a = as_of - timedelta(days=7 * (k + 1))
        n = store.open_days(a, b)
        if n:
            out.append(store.units(sku, a, b) / n)
    return tuple(out)


def build_sku_inputs(store: Store, as_of: date, skus: list[str]) -> list[SkuInput]:
    """Sheet 20's four windows, per SKU. OPEN days throughout."""
    recent_start = as_of - timedelta(days=BASELINE_WINDOW_DAYS)
    long_start = as_of - timedelta(days=365)
    recent_open = store.open_days(recent_start, as_of)
    long_open = store.open_days(long_start, as_of)
    out = []
    for sku in skus:
        recent_u = store.units(sku, recent_start, as_of)
        out.append(SkuInput(
            sku=sku,
            category=store.category.get(sku),
            own_rate=(recent_u / recent_open) if recent_open else None,
            observations={},
            recent_units=recent_u,
            recent_open_days=recent_open,
            long_run_units=store.units(sku, long_start, as_of),
            long_run_open_days=long_open,
            weekly_rates=weekly_rates(store, sku, as_of),
        ))
    return out


def calibrate_deficit(store: "Store", as_of: date, horizon: int,
                     lookback_dates: int = 12, every: int = 14,
                     track_record: Any = None) -> float:
    """What fraction of its promised deficit this store has historically
    delivered. Fitted on dates BEFORE `as_of`, so it never sees its own future.

    One number per store, not per SKU: a single SKU contributes a handful of
    windows, which is nowhere near enough to estimate a ratio from. Pooling is
    the honest resolution available, and the factor is a property of the
    estimator at this store rather than of any one bottle.

    Returns 1.0 - the identity, not a guess - when there is too little history.
    That says "not calibrated here" rather than inventing a correction.

    `track_record` MUST be the same screen the factor will be used alongside.
    Fitting on the unscreened population and applying to the screened one is a
    real bug that shipped once and was caught by its own symptom: the screen
    removes cards where delivered fell SHORT of promised, so the survivors
    over-deliver, and a factor fitted before the screen sent Bethany's fill ratio
    from 104% to 158% and cost it a gate verdict it had been holding. The factor
    has to describe the population it will actually correct.
    """
    cal_dates = [as_of - timedelta(days=every * (i + 1))
                 for i in range(lookback_dates)]
    cal_dates = [d for d in cal_dates
                 if d >= store.trading_days[0] + timedelta(days=370)]
    promised = delivered = 0.0
    seen = 0
    for d in cal_dates:
        # Only windows that have CLOSED. An open window has no label and would
        # silently contribute a partial actual against a full promise.
        if d + timedelta(days=horizon) > as_of:
            continue
        picks, _ = engine_picks(store, d, horizon, track_record=track_record)
        for pick in picks:
            o = score_pick(store, pick["sku"], d, horizon)
            if o["lift"] is None:
                continue
            promised += pick["raw_deficit_units"]
            delivered += o["gained_units"]
            seen += 1
    if seen < 20 or promised <= 0:
        return 1.0
    # Bounded. An unbounded factor from a thin sample can produce a card
    # promising a tenth of a unit, or triple what the estimator said.
    return max(0.25, min(2.0, delivered / promised))


def category_is_non_stock(category: str) -> bool:
    """Does this POS category name a line that is not stock at all?

    Uses the taxonomy's own NON_STOCK_TERMS with the same word-boundary
    matching, so "JUICE" is never caught by "ICE" and the one place that owns
    the vocabulary stays the one place.
    """
    text = (category or "").strip()
    if not text:
        return False
    if category_family_of(text) is not None:
        return False            # it named a drink type; it is stock
    return _NON_STOCK_CATEGORY_RE.search(text) is not None


#: Built once. Word boundaries, for the reason the merchandise filter already
#: paid for: without them "tax" matches "TAXABLE", and the same substring trap
#: that refused LYNX POLARIZED GROUNDING AD. for containing "rounding" is live
#: here too.
_NON_STOCK_CATEGORY_RE = re.compile(
    r"\b(?:" + "|".join(
        re.escape(t) for t in sorted(NON_STOCK_TERMS, key=len, reverse=True)
    ) + r")\b",
    re.IGNORECASE,
)


def engine_picks(store: Store, as_of: date, horizon: int,
                 ordering: str = "sheet20",
                 deficit_calibration: float | None = None,
                 track_record: Any = None,
                 ) -> tuple[list[dict], dict[str, int]]:
    """One decision date through the REAL pipeline. Returns picks and refusals.

    `ordering` selects what expected value multiplies, which is the whole of
    sheet 20:
        sheet20       margin x DEFICIT, with the materiality and p_hit gates
        total_demand  margin x TOTAL demand, ungated - what shipped before
    """
    ctx = run_context(as_of, horizon)
    skus = [s for s in sorted(store.daily)
            if store.units(s, as_of - timedelta(days=365), as_of) > 0]
    if not skus:
        return [], {}

    horizon_open = store.open_days(as_of, as_of + timedelta(days=horizon))
    if horizon_open <= 0:
        return [], {}

    refused: dict[str, int] = defaultdict(int)
    scored: list[dict] = []

    recent_start = as_of - timedelta(days=BASELINE_WINDOW_DAYS)
    long_start = as_of - timedelta(days=365)
    recent_open = store.open_days(recent_start, as_of)
    long_open = store.open_days(long_start, as_of)

    for sku in skus:
        # THE HARNESS HAD NO MERCHANDISE SCREEN AT ALL, and it is the only path
        # that produces every accuracy figure in the audit. So the measured
        # engine was allowed to recommend things no owner can order:
        #
        #   Marshfield, March 2026 - 262 units of "Ice Bag Ex Large", 385 of
        #   "Ice Bag Large", 439 of "1 Liter Liquor Tax" (a tax line, not a
        #   product), and 2,055 units of a 12-cent item.
        #
        # Those have exactly the shape sheet 20 hunts - huge volume on a
        # wobbling trailing window - so they ranked, and they diluted both the
        # hit rate and the money. Two screens, for the reason recorded in
        # deterministic.choose: the catalogue contract screens NAME and PRICE,
        # the blocklist screens SKU SHAPE, and neither subsumes the other.
        if not catalogue_allows(sku, store.names.get(sku), store.price.get(sku),
                                ctx):
            refused["not_merchandise_catalogue"] += 1
            continue
        if not route_allows(sku, None):
            refused["not_merchandise_blocklist"] += 1
            continue
        # A THIRD screen, and a NARROW one: the POS category itself says this
        # line is not stock. Lottery, scratchcards, tax lines, bottle deposits
        # and register shortcuts have perfectly ordinary names and prices, so
        # neither screen above has any reason to refuse them - "$2 SCRATCHOFF"
        # in category LOTTO passed both and took 6 cards at Northlake.
        #
        # Narrow ON PURPOSE. Soft drinks, juice, tea, snacks and cigarettes ARE
        # real stock a liquor store reorders, and refusing them would be the
        # over-broad filter that nearly deleted 187 real bottles. Only the
        # categories that are not merchandise at all are screened, and the
        # taxonomy names them in one place.
        if sku in store.category and category_is_non_stock(store.category[sku]):
            refused["not_merchandise_category"] += 1
            continue

        # TRACK RECORD. A SKU whose OWN past cards at THIS store lost money is
        # skipped, and because this sits INSIDE selection the slate fills with the
        # next candidate instead of simply getting shorter. That distinction is the
        # whole value: suppression alone raises the hit rate about five points and
        # cuts total net margin 17-24%, because a removed card is both a miss
        # removed and an earning removed. Backfilling is how both move the same way.
        #
        # Every outcome behind this was scored BEFORE `as_of`. An earlier version
        # keyed on the first card's 30-day result, which is not known the next
        # morning, and scored +12.1 points of pure look-ahead.
        if track_record is not None and not track_record.allows(sku):
            refused["losing_track_record"] += 1
            continue

        recent_u = store.units(sku, recent_start, as_of)
        if recent_open <= 0:
            refused["no_open_days"] += 1
            continue

        # SHEET 20 - the real stage, not a copy of it.
        rv = revert(ReversionRequest(
            sku=sku,
            recent_units=recent_u, recent_open_days=recent_open,
            long_run_units=store.units(sku, long_start, as_of),
            long_run_open_days=long_open,
            weekly_rates=weekly_rates(store, sku, as_of),
            horizon_days=horizon,
            deficit_calibration=deficit_calibration,
        ), ctx)
        if not rv.ok or rv.value is None:
            refused["reversion_failed"] += 1
            continue
        reverted = rv.value

        if ordering == "sheet20":
            # SHEET 20's gate - the real predicate.
            if not is_recommendable(reverted, ctx):
                if not reverted.material:
                    refused["below_materiality_floor"] += 1
                elif reverted.deficit_units <= 0:
                    refused["trailing_window_inflated"] += 1
                else:
                    refused["p_hit_below_floor"] += 1
                continue
            units_at_stake = max(0.0, reverted.deficit_units)
        else:
            units_at_stake = reverted.recent_rate * horizon_open

        p = store.price.get(sku)
        c = store.cost.get(sku)
        if p is None:
            refused["no_price"] += 1
            continue
        unit_margin = (p - c) if (c is not None and 0 < c < p) else None
        unit_value = unit_margin if unit_margin is not None else p

        # SHEET 13 - the real scorer. A deadline inside the horizon, so urgency
        # is a real term rather than pinned at its floor for every candidate.
        confidence = min(0.99, max(0.01, reverted.p_hit))
        score = (unit_value * units_at_stake) * confidence

        scored.append({
            "sku": sku, "score": score,
            "units_at_stake": units_at_stake,
            "unit_margin": unit_margin, "unit_value": unit_value,
            "expected_value": unit_value * units_at_stake,
            "p_hit": reverted.p_hit,
            "confidence": confidence,
            "uplift": reverted.uplift,
            "deficit_units": reverted.deficit_units,
            "raw_deficit_units": reverted.raw_deficit_units,
            "deficit_calibration": reverted.deficit_calibration,
            "recent_units": recent_u,
            "recent_rate": reverted.recent_rate,
            "reverted_rate": reverted.rate_per_open_day,
            "long_run_rate": reverted.long_run_rate,
            "dispersion_cv": reverted.dispersion_cv,
            "evidence_state": rv.provenance.evidence_state,
            # THE SENTENCE THE ENGINE ITSELF WRITES. Sheet 20's own explain(),
            # not a paraphrase of it - a report that re-words the card is
            # reporting on something the owner never saw.
            "why": reverted.explain(),
            "recent_weight": reverted.recent_weight,
        })

    # Sheet 13's sort, tie-break included: scores collide constantly and
    # without an explicit one the order is whatever the caller built.
    scored.sort(key=lambda r: (-r["score"], r["sku"]))
    return scored[:N_RECS], dict(refused)


# ── Scoring, through the pinned lift definition ──────────────────────────────


def score_pick(store: Store, sku: str, as_of: date, horizon: int) -> dict[str, Any]:
    """Grade one pick with `app/pipeline/outcomes/lift.py` - THE definition."""
    b_start = as_of - timedelta(days=BASELINE_WINDOW_DAYS)
    w_end = as_of + timedelta(days=horizon)
    baseline_open = store.open_days(b_start, as_of)
    window_open = store.open_days(as_of, w_end)
    baseline_units = store.units(sku, b_start, as_of)
    actual = store.units(sku, as_of, w_end)

    result = lift_for(
        [SkuOutcome(sku=sku, baseline_units=baseline_units, actual_units=actual)],
        baseline_open_days=baseline_open,
        window_open_days=window_open,
    )
    p, c = store.price.get(sku), store.cost.get(sku)
    margin = (p - c) if (p is not None and c is not None and 0 < c < p) else None
    gained = actual - result.expected
    return {
        "sku": sku, "lift": result.lift, "measurable": result.measurable,
        "expected": result.expected, "actual": actual,
        "hit": (result.lift is not None and result.lift >= 1.0),
        "gained_units": gained,
        "margin_impact": (gained * margin) if margin is not None else None,
        "margin_captured": (actual * margin) if margin is not None else None,
        "baseline_units": baseline_units,
    }


def volume_class(units: float) -> int:
    """Bucket by baseline volume. A SKU selling 2 a month is far more volatile
    in percentage terms than one selling 200, so an unmatched null flatters
    whichever side happened to pick the quieter products."""
    if units <= 0:
        return 0
    return int(math.floor(math.log10(units) * 2))


def reversion_class(uplift: float) -> int:
    """Bucket by how depressed the trailing window is. THIS is the one that
    makes the null hard: it draws SKUs that were equally primed to revert."""
    return int(round(min(3.0, max(0.5, uplift)) * 4))


def null_for(store: Store, picks: list[dict], as_of: date, horizon: int,
             universe: list[dict], rng: random.Random,
             match: str = "volume") -> float:
    """Hit rate of matched random baskets. `match` decides how hard it is."""
    if not picks:
        return float("nan")
    if match == "volume":
        keyed = defaultdict(list)
        for u in universe:
            keyed[volume_class(u["baseline_units"])].append(u)
        wanted = [volume_class(p["baseline_units"]) for p in picks]
    else:
        keyed = defaultdict(list)
        for u in universe:
            keyed[reversion_class(u["uplift"])].append(u)
        wanted = [reversion_class(p["uplift"]) for p in picks]

    hits = 0
    total = 0
    for _ in range(NULL_BASKETS):
        for k in wanted:
            pool = keyed.get(k) or universe
            pick = rng.choice(pool)
            total += 1
            hits += 1 if pick["hit"] else 0
    return (hits / total * 100) if total else float("nan")


def percentile_and_p(store: "Store", picks: list[dict], universe: list[dict],
                     rng: random.Random, match: str = "reversion",
                     draws: int = 2000) -> tuple[float, float]:
    """Where the engine's slate lands among matched random slates, and the
    add-one p-value of getting there by luck.

    The p-value is (wins + 1) / (draws + 1) - NEVER exactly zero. A permutation
    test cannot prove impossibility; it can only report that in `draws` tries
    nothing did better, and the resolution of that statement is 1/(draws+1).
    Printing 0.000 claims more than the experiment can support.
    """
    if not picks or not universe:
        return (float("nan"), float("nan"))
    keyed: dict[int, list[dict]] = defaultdict(list)
    bucket = (reversion_class if match == "reversion" else
              (lambda u: volume_class(u)))
    for u in universe:
        k = (reversion_class(u["uplift"]) if match == "reversion"
             else volume_class(u["baseline_units"]))
        keyed[k].append(u)
    wanted = [(reversion_class(p_["uplift"]) if match == "reversion"
               else volume_class(p_["baseline_units"])) for p_ in picks]

    observed = sum(1 for p_ in picks if p_["hit"]) / len(picks)
    beaten = 0
    tied = 0
    at_least = 0
    for _ in range(draws):
        drawn = []
        for k in wanted:
            pool = keyed.get(k) or universe
            drawn.append(rng.choice(pool))
        r = sum(1 for d in drawn if d["hit"]) / len(drawn)
        if r < observed:
            beaten += 1
        elif r == observed:
            tied += 1
        if r >= observed:
            at_least += 1
    # MID-RANK FOR TIES, and it is not a cosmetic choice.
    #
    # A run shows ~9 cards, so its hit rate can only take ten values and a
    # matched-random slate lands on EXACTLY the same value often. Counting
    # every tie as "not beaten" biases the percentile down hard: store 177
    # reported 49.1 - below the 50 that means no skill - while the pooled test
    # on the same data returned p = 0.0005 and a +6 point edge. The percentile
    # was wrong, not the edge.
    #
    # Half-crediting ties is the standard correction and makes a no-skill
    # engine score 50 rather than something below it.
    return ((beaten + tied / 2) / draws * 100, (at_least + 1) / (draws + 1))


def pooled_permutation(slates: list[tuple[list[dict], list[dict]]],
                       rng: random.Random, draws: int = 2000) -> tuple[float, float]:
    """The right test for this shape of evidence.

    There are 24 runs of ~5 cards each. A permutation test PER RUN is almost
    powerless - five coin flips cannot be significant - and Fisher over 24
    powerless tests stays powerless (it returned p = 0.73 while the
    date-clustered interval comfortably excluded the null, which is the
    signature of a test throwing away its own evidence).

    So: build ONE matched null slate for every run, pool them exactly as the
    engine's picks are pooled, and compare the pooled hit rates. Every draw
    respects the run structure - a null slate for a run is drawn from that
    run's own universe, matched on reversion class - so clustering is honoured
    while the power is pooled.

    Add-one p-value: (wins + 1) / (draws + 1). Never exactly zero, because a
    permutation test cannot prove impossibility - it can only say that in
    `draws` attempts nothing did better, at a resolution of 1/(draws+1).
    """
    all_picks = [p_ for picks, _ in slates for p_ in picks]
    if not all_picks:
        return (float("nan"), float("nan"))
    observed = sum(1 for p_ in all_picks if p_["hit"]) / len(all_picks)

    prepared = []
    for picks, universe in slates:
        if not picks or not universe:
            continue
        keyed: dict[int, list[dict]] = defaultdict(list)
        for u in universe:
            keyed[reversion_class(u["uplift"])].append(u)
        wanted = [reversion_class(p_["uplift"]) for p_ in picks]
        prepared.append((wanted, keyed, universe))

    at_least = 0
    beaten = 0
    tied_pool = 0
    null_money: list[float] = []
    for _ in range(draws):
        hits = total = 0
        money = 0.0
        for wanted, keyed, universe in prepared:
            for k in wanted:
                pool = keyed.get(k) or universe
                pick = rng.choice(pool)
                total += 1
                hits += 1 if pick["hit"] else 0
                money += pick.get("margin_impact") or 0.0
        null_money.append(money)
        r = (hits / total) if total else 0.0
        if r > observed:
            at_least += 1
        elif r == observed:
            at_least += 1
            tied_pool += 1
        else:
            beaten += 1
    # What a matched-random slate would have earned. The engine's own
    # margin_impact is measured against each SKU's trailing rate; THIS is what
    # it is worth against a baseline that already knows about reversion.
    global NULL_MARGIN
    NULL_MARGIN = sum(null_money) / len(null_money) if null_money else 0.0
    return ((beaten + tied_pool / 2) / draws * 100,
            (at_least + 1) / (draws + 1))


NULL_MARGIN = 0.0


def fisher_combined(pvalues: list[float]) -> float:
    """Combine independent per-run p-values. Fisher's method, exactly.

    Each decision run gets its own permutation test over its own slate, so
    there are 24 p-values and no single one of them is the answer. Taking the
    MAX (the first version of this) lets one noisy five-card run pin the
    result at 1.0 and throw away everything the other 23 measured. Taking the
    min would be the opposite sin.

        chi2 = -2 * sum(ln p_i),  df = 2k

    For even df the survival function is closed-form and needs no library:

        P(chi2 > x) = exp(-x/2) * sum_{i<k} (x/2)^i / i!

    The runs are treated as independent, which they nearly are - different
    decision dates and different horizons over largely different SKUs. Where
    they are not (four horizons share a date) this is slightly anti-
    conservative, and the date-clustered interval is the figure that does not
    make that assumption.
    """
    usable = [min(max(p, 1e-12), 1.0) for p in pvalues if p == p]
    if not usable:
        return float("nan")
    chi2 = -2.0 * sum(math.log(p) for p in usable)
    k = len(usable)
    half = chi2 / 2.0
    term = 1.0
    total = 1.0
    for i in range(1, k):
        term *= half / i
        total += term
    return min(1.0, math.exp(-half) * total)


def wilson(k: int, n: int) -> tuple[float, float]:
    if n == 0:
        return (float("nan"), float("nan"))
    z = 1.96
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    s = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - s) / d * 100, (c + s) / d * 100)


def clustered_ci(by_date: list[list[bool]], rng: random.Random,
                 draws: int = 2000) -> tuple[float, float]:
    """Bootstrap clustered BY DATE. Two picks on the same date share a market;
    resampling rows would report an interval far tighter than the evidence."""
    if len(by_date) < 2:
        return (float("nan"), float("nan"))
    means = []
    for _ in range(draws):
        drawn: list[bool] = []
        for _ in range(len(by_date)):
            drawn.extend(rng.choice(by_date))
        means.append(sum(drawn) / len(drawn) * 100 if drawn else 0.0)
    means.sort()
    return (means[int(0.025 * draws)], means[int(0.975 * draws)])


def clustered_mean_ci(by_date: list[list[float]], rng: random.Random,
                      draws: int = 2000) -> tuple[float, float]:
    """The same clustering, for a mean of DOLLARS rather than a rate of hits.

    `clustered_ci` above takes booleans and returns a percentage. Net margin per
    card is a mean of signed floats, so it needs its own entry point.

    DELIBERATELY NOT A REFACTOR OF `clustered_ci`. The obvious move is to make
    one generic function and have the boolean version delegate to it. The
    arithmetic would almost certainly come out identical - but `clustered_ci`
    produces the clustered 95% interval that is published in every per-store
    report and quoted in the audit, and "almost certainly identical" is not a
    standard this codebase holds itself to for a number already in print. Eight
    duplicated lines with a stated reason beat a refactor that could move a
    published figure without anyone noticing.

    The clustering itself is the point, and it is the same point: two cards
    issued on the same morning share a market, so resampling CARDS would report
    an interval far tighter than the evidence. A row-wise bootstrap here once
    reported 82.9% off 41 observations and was thrown away.
    """
    if len(by_date) < 2:
        return (float("nan"), float("nan"))
    means = []
    for _ in range(draws):
        drawn: list[float] = []
        for _ in range(len(by_date)):
            drawn.extend(rng.choice(by_date))
        means.append(sum(drawn) / len(drawn) if drawn else 0.0)
    means.sort()
    return (means[int(0.025 * draws)], means[int(0.975 * draws)])


# ── The run ──────────────────────────────────────────────────────────────────


def decision_dates(store: Store, every: int = 14) -> list[date]:
    """Every `every` trading days across the whole export.

    TWO BOUNDS, AND BOTH ARE NECESSARY.
      - a date needs 365 days of history behind it, because sheet 20's long-run
        rate is a 365-day window. Starting earlier would silently compare a
        28-day window against a 90-day one and call it a year.
      - a date needs `max(HORIZONS)` days ahead of it, because the LABEL does
        not exist until the window closes. Including later dates would score
        picks against a truncated future and flatter every one of them.

    Sampling every ~2 weeks rather than every day keeps consecutive windows
    from overlapping so heavily that they are effectively one observation -
    the date-clustered bootstrap assumes runs carry independent information.
    """
    first = store.trading_days[0] + timedelta(days=370)
    last = store.trading_days[-1] - timedelta(days=max(HORIZONS) + 2)
    usable = [d for d in store.trading_days if first <= d <= last]
    if not usable:
        raise SystemExit("not enough history for a walk-forward backtest")
    return usable[::max(1, every)]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", required=True, help="folder holding the .csv.gz")
    ap.add_argument("--file", help="the .csv.gz itself (default: Bethany's)")
    ap.add_argument("--store", default="Bethany's Discount Liquor",
                    help="store name for the report header")
    ap.add_argument("--out", default="run_real_engine")
    ap.add_argument("--every", type=int, default=14,
                    help="decision date every N trading days (default 14)")
    args = ap.parse_args(argv)

    os.makedirs(args.out, exist_ok=True)
    rng = random.Random(171)

    print("loading export ...")
    store = load(args.data, args.file)
    print(f"  {store.n_lines:,} lines - {len(store.trading_days):,} trading days "
          f"- {len(store.daily):,} products")
    if store.cost_coverage < 0.01:
        print(f"  NO COST DATA - cost is present on {store.cost_coverage*100:.1f}% "
              f"of sold lines.")
        print(f"    Every margin figure below is an ABSENCE, not a zero. The hit "
              f"rate is unaffected.")
    if store.dropped_lines:
        # The REASON is printed per line now. A single count against one cap
        # could not distinguish an identifier-shaped quantity from a genuine
        # bulk sale, and the two want different follow-up.
        print(f"  DATA CONTRACT refused {len(store.dropped_lines)} line(s):")
        for d, sku, q, nm, why in sorted(store.dropped_lines,
                                         key=lambda r: -r[2])[:8]:
            print(f"    {d}  {sku:>16}  {q:>12,.0f} units  {nm[:28]:<28} {why}")

    dates = decision_dates(store, args.every)
    span = (dates[-1] - dates[0]).days / 365.25
    print(f"  {len(dates)} decision dates: {dates[0]} .. {dates[-1]} "
          f"({span:.1f} years)")
    print("")

    rows: list[dict] = []
    slates: list[tuple[list[dict], list[dict]]] = []
    refusals: dict[str, int] = defaultdict(int)
    for as_of in dates:
        for h in HORIZONS:
            # The whole universe, scored, so the null draws from reality.
            universe = []
            for sku in store.daily:
                if store.units(sku, as_of - timedelta(days=BASELINE_WINDOW_DAYS),
                               as_of) <= 0:
                    continue
                s = score_pick(store, sku, as_of, h)
                if not s["measurable"]:
                    continue
                r28 = store.rate(sku, as_of - timedelta(days=BASELINE_WINDOW_DAYS), as_of)
                r365 = store.rate(sku, as_of - timedelta(days=365), as_of)
                s["uplift"] = (r365 / r28) if r28 > 0 else 1.0
                universe.append(s)

            for arm in ("sheet20", "total_demand"):
                picks, ref = engine_picks(store, as_of, h, ordering=arm)
                if arm == "sheet20":
                    for k, v in ref.items():
                        refusals[k] += v
                for rank, pick in enumerate(picks, 1):
                    out = score_pick(store, pick["sku"], as_of, h)
                    rows.append({**pick, **out, "arm": arm, "rank": rank,
                                 "as_of": as_of.isoformat(), "horizon": h})
                if arm == "sheet20":
                    scored_picks = [r for r in rows
                                    if r["arm"] == arm and r["as_of"] == as_of.isoformat()
                                    and r["horizon"] == h]
                    nv = null_for(store, scored_picks, as_of, h, universe, rng, "volume")
                    nr = null_for(store, scored_picks, as_of, h, universe, rng, "reversion")
                    pct, pval = percentile_and_p(store, scored_picks, universe, rng)
                    slates.append((scored_picks, universe))
                    for r in scored_picks:
                        r["null_volume"] = nv
                        r["null_reversion"] = nr
                        r["percentile"] = pct
                        r["p_value"] = pval
        done = dates.index(as_of) + 1
        if done % 10 == 0 or done == len(dates):
            print(f"  {done}/{len(dates)} dates  ({len(rows):,} rows so far)")

    json.dump(rows, open(f"{args.out}/predictions.json", "w"), indent=1, default=str)
    return report(rows, dict(refusals), store, dates, args.out, slates,
                  store_name=args.store)


# ── Report ───────────────────────────────────────────────────────────────────


def _agg(rows: list[dict]) -> dict[str, Any]:
    m = [r for r in rows if r["measurable"] and r["lift"] is not None]
    if not m:
        return {"n": 0}
    k = sum(1 for r in m if r["hit"])
    lo, hi = wilson(k, len(m))
    lifts = sorted(r["lift"] for r in m)
    impact = [r["margin_impact"] for r in m if r["margin_impact"] is not None]
    captured = [r["margin_captured"] for r in m if r["margin_captured"] is not None]
    return {
        "n": len(m), "hits": k, "hit_rate": k / len(m) * 100,
        "ci_lo": lo, "ci_hi": hi,
        "median_lift": lifts[len(lifts) // 2],
        "margin_impact": sum(impact) if impact else 0.0,
        "margin_captured": sum(captured) if captured else 0.0,
        "median_size": sorted(r["baseline_units"] for r in m)[len(m) // 2],
        # PER CARD, because the two arms do not place the same number of bets.
        # Comparing raw totals across 112 cards and 240 cards is comparing a
        # rate to a volume and calling the difference a result.
        "impact_per_card": (sum(impact) / len(m)) if impact else 0.0,
    }


def report(rows: list[dict], refusals: dict[str, int], store: Store,
           dates: list[date], out: str,
           slates: list[tuple[list[dict], list[dict]]] | None = None,
           store_name: str = "Bethany's Discount Liquor") -> int:
    rng = random.Random(171)
    s20 = [r for r in rows if r["arm"] == "sheet20"]
    old = [r for r in rows if r["arm"] == "total_demand"]
    A, B = _agg(s20), _agg(old)

    if not A["n"]:
        print("no measurable predictions - nothing to report")
        return 1

    by_date: dict[str, list[bool]] = defaultdict(list)
    for r in s20:
        if r["measurable"] and r["lift"] is not None:
            by_date[r["as_of"]].append(bool(r["hit"]))
    cl_lo, cl_hi = clustered_ci(list(by_date.values()), rng)

    nulls_v = [r["null_volume"] for r in s20 if r.get("null_volume") == r.get("null_volume")]
    nulls_r = [r["null_reversion"] for r in s20 if r.get("null_reversion") == r.get("null_reversion")]
    null_v = sum(nulls_v) / len(nulls_v) if nulls_v else float("nan")
    null_r = sum(nulls_r) / len(nulls_r) if nulls_r else float("nan")

    W = 92
    print("")
    print("=" * W)
    print("  BOTELLA - REAL ENGINE BACKTEST".center(W))
    print("  every figure below comes from app/pipeline, not from a port".center(W))
    print("=" * W)
    print(f"\n  {len(dates)} decision dates x {len(HORIZONS)} horizons"
          f"   {store.n_lines:,} lines   {len(store.daily):,} products")
    # M2: the engine is re-run per horizon, so the pooled n counts each
    # DECISION once per horizon. Stated here rather than left to be inferred
    # from runs = dates x horizons, because "n=1,092 cards" reads as 1,092
    # independent judgements when it is 273 judgements scored four ways.
    _dec_per_h = len(s20) // max(len(HORIZONS), 1)
    print(f"  THE POOLED n COUNTS EACH DECISION ONCE PER HORIZON: "
          f"{_dec_per_h:,} decisions x {len(HORIZONS)} horizons = {len(s20):,}.")
    print(f"  Treat {_dec_per_h:,} as the sample size, not {len(s20):,}.")
    print(f"\n  HIT RATE              {A['hit_rate']:5.1f}%   "
          f"(Wilson {A['ci_lo']:.0f}-{A['ci_hi']:.0f}%, n={A['n']})")
    print(f"  clustered by date     {cl_lo:5.1f}% - {cl_hi:.1f}%   "
          f"<- the interval to quote")
    print(f"  NULL, volume-matched  {null_v:5.1f}%   edge {A['hit_rate']-null_v:+5.1f} pts")
    print(f"  NULL, REVERSION-matched {null_r:5.1f}%   edge "
          f"{A['hit_rate']-null_r:+5.1f} pts  <- the honest one")
    pcts = [r["percentile"] for r in s20 if r.get("percentile") == r.get("percentile")]
    pvs = [r["p_value"] for r in s20 if r.get("p_value") == r.get("p_value")]
    PCT = sum(pcts) / len(pcts) if pcts else float("nan")
    # ONE p-value per run; Fisher combines them. Taking the max let a
    # single noisy five-card run pin the result at 1.0.
    per_run_p = sorted({(r["as_of"], r["horizon"]): r["p_value"]
                        for r in s20 if r.get("p_value") == r.get("p_value")}.values())
    FISHER = fisher_combined(per_run_p)
    POOLED_PCT, PV = (pooled_permutation(slates, rng) if slates
                      else (float("nan"), float("nan")))
    runs = len({(r["as_of"], r["horizon"]) for r in s20})
    print("")
    print(f"  PERCENTILE            {PCT:5.1f}   (50 = no skill, against the HARD null)")
    print(f"  p-value               {PV:.4f}   pooled permutation vs the HARD "
          f"null, {PERM_DRAWS:,} draws, floor 1/{PERM_DRAWS + 1:,}="
          f"{1 / (PERM_DRAWS + 1):.5f}")
    print(f"    (per-run Fisher {FISHER:.3f} - near-powerless at ~5 cards a run)")
    print(f"  pooled percentile     {POOLED_PCT:5.1f}")
    print(f"  cards per run         {len(s20)/max(runs,1):5.1f}   across {runs} runs")
    print(f"\n  median lift           {A['median_lift']:.2f}x")
    # M1: THE POOLED MONEY IS A SUM OVER FOUR OVERLAPPING WINDOWS OF THE
    # SAME PICKS, not margin earned. At Bethany it is exactly
    # 5,498 + 10,575 + 15,705 + 21,286, and the 120-day row dominates purely
    # because it has the longest window. The label now says so, and the
    # shortest horizon is printed beside it as the figure to quote, because
    # the pooled number was being read as revenue.
    _head_h = min(HORIZONS)
    _head = _agg([r for r in s20 if r["horizon"] == _head_h])
    print(f"  margin SUMMED over {len(HORIZONS)} overlapping horizons  "
          f"${A['margin_impact']:+,.0f}")
    print(f"    ^ NOT money earned - the same picks counted once per horizon")
    if _head["n"]:
        print(f"  margin at {_head_h}d, the headline horizon      "
              f"${_head['margin_impact']:+,.0f}   <- quote this one")
    print(f"  the HARD null earned  ${NULL_MARGIN:+,.0f}   "
          f"=> engine advantage ${A['margin_impact'] - NULL_MARGIN:+,.0f} "
          f"(also summed)")
    print(f"  total captured        ${A['margin_captured']:,.0f}   (summed)")
    print(f"  median pick size      {A['median_size']:.0f} units / 28 open days")
    print(f"  per card              ${A['impact_per_card']:+,.0f}   "
          f"<- the like-for-like figure")

    print(f"\n  OLD ORDERING (rank on total demand, ungated), same pipeline:")
    if B["n"]:
        print(f"    hit {B['hit_rate']:5.1f}%  (n={B['n']})   "
              f"incremental ${B['margin_impact']:+,.0f}   "
              f"total ${B['margin_captured']:,.0f}   "
              f"median size {B['median_size']:.0f}u")
        print(f"    PER CARD: sheet 20 ${A['impact_per_card']:+,.0f} vs "
              f"old ${B['impact_per_card']:+,.0f}   "
              f"({len(s20)} cards vs {len(old)} - totals are NOT comparable)")
        print(f"    COVERAGE: sheet 20 touches ${A['margin_captured']:,.0f} of "
              f"margin flow against the old ordering's ${B['margin_captured']:,.0f}")

    print("\n  BY HORIZON")
    print(f"    {'h':>4} {'n':>4} {'hit':>7} {'95% CI':>12} {'null(rev)':>10} "
          f"{'edge':>6} {'med lift':>9}")
    per_h = {}
    for h in HORIZONS:
        sub = [r for r in s20 if r["horizon"] == h]
        a = _agg(sub)
        if not a["n"]:
            continue
        nr = [r["null_reversion"] for r in sub
              if r.get("null_reversion") == r.get("null_reversion")]
        nn = sum(nr) / len(nr) if nr else float("nan")
        per_h[h] = {**a, "null_reversion": nn}
        print(f"    {h:>4} {a['n']:>4} {a['hit_rate']:>6.1f}% "
              f"{a['ci_lo']:>5.0f}-{a['ci_hi']:<5.0f} {nn:>9.1f}% "
              f"{a['hit_rate']-nn:>+6.1f} {a['median_lift']:>9.2f}")

    print("\n  WHY CANDIDATES WERE REFUSED (sheet 20's gates, real predicate)")
    for reason, n in sorted(refusals.items(), key=lambda kv: -kv[1]):
        print(f"    {reason:<28} {n:>8,}")

    payload = {
        "generated": datetime.now().isoformat(timespec="seconds"),
        "dates": [d.isoformat() for d in dates], "horizons": list(HORIZONS),
        "sheet20": A, "old_ordering": B,
        "clustered_ci": [cl_lo, cl_hi],
        "null_volume": null_v, "null_reversion": null_r,
        "percentile": PCT, "p_value": PV,
        "cards_per_run": len(s20) / max(runs, 1), "runs": runs,
        # Recorded so the HTML narrative can quote the REAL Fisher value. It
        # used to assert p = 0.73 in prose for every store.
        "fisher_p": FISHER,
        # The hard null's own earnings, so a report can state the engine's
        # ADVANTAGE without the figure having to be typed in by hand.
        "null_margin": NULL_MARGIN,
        "by_horizon": {str(k): v for k, v in per_h.items()},
        "refusals": refusals,
        "store_name": store_name,
        "lines": store.n_lines, "products": len(store.daily),
        "cost_coverage": store.cost_coverage,
        "dropped_lines": [
            {"date": d, "sku": k, "quantity": q, "product": n, "reason": w}
            for d, k, q, n, w in sorted(store.dropped_lines, key=lambda r: -r[2])],
        "trading_days": len(store.trading_days),
        "settings": {
            "materiality_floor_units": cfg.get(
                MATERIALITY_FLOOR_UNITS, run_context(dates[0], 30)),
            "min_hit_probability": cfg.get(
                MIN_HIT_PROBABILITY, run_context(dates[0], 30)),
            "baseline_window_days": BASELINE_WINDOW_DAYS,
            "n_recs": N_RECS, "null_baskets": NULL_BASKETS,
            "permutation_draws": PERM_DRAWS,
            "p_value_floor": 1 / (PERM_DRAWS + 1),
        },
    }
    json.dump(payload, open(f"{out}/summary.json", "w"), indent=1, default=str)
    write_html(payload, s20, f"{out}/REAL_ENGINE_REPORT.html")
    print(f"\n  wrote {out}/summary.json")
    print(f"  wrote {out}/REAL_ENGINE_REPORT.html")
    print("=" * W)
    return 0


def _cost_warning(coverage: float) -> str:
    """Say it at the TOP, not in a footnote.

    Without a cost there is no margin, so every money figure becomes an
    absence. Rendering that absence as "$0" is the worst of both worlds: it
    looks like a measurement and it is not one. A reader who scrolls past a
    footnote and quotes "$0 incremental margin" has been misled by the report
    rather than by the data.
    """
    if coverage >= 0.01:
        return ""
    return ("""<div class="note warn"><b>This store's feed carries NO COST DATA</b>
&mdash; cost is present on %.1f%% of sold lines. Every money figure on this page
is therefore an <b>absence, not a zero</b>: margin cannot be computed without a
cost, so the engine ranks on units at risk valued at PRICE, and the incremental
margin columns read $0 because there is nothing to compute, not because nothing
was earned.
<p><b>The hit rate is unaffected</b> &mdash; it measures units against a
product's own trailing rate and never touches cost. Read this report for
accuracy and ignore its money.</p></div>""" % (coverage * 100))


def _quality_section(dropped: list[dict]) -> str:
    """What the data contract refused. Printed whether or not it found
    anything, because "we checked and it was clean" is itself a result."""
    if not dropped:
        return ("<h2>5b. Data quality</h2><p>No line item in this store's "
                "history exceeded the plausible-quantity contract "
                f"({MAX_PLAUSIBLE_LINE_QUANTITY} units on one line). "
                "Nothing was removed.</p>")
    rows = "".join(
        "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>"
        % (d["date"], d["sku"], format(d["quantity"], ",.0f"),
           d["product"].replace("<", "&lt;"))
        for d in dropped[:10])
    return f"""<h2>5b. Data quality &mdash; what this store's feed got wrong</h2>
<div class="note warn"><b>{len(dropped)} line item(s) were refused before any
figure on this page was computed.</b> A line is refused when it exceeds the
absolute cap of {MAX_PLAUSIBLE_LINE_QUANTITY} units, when its quantity equals
its own SKU or UPC (a field-mapping error, never a sale), or when it exceeds
{SKU_OUTLIER_MULTIPLE:.0f}x that SKU's own 95th percentile with a floor of
{SKU_OUTLIER_FLOOR:.0f} units. Across the pilot stores the median line is 1
unit and the 99th percentile is 20, so the absolute cap alone caught almost
nothing and the per-SKU rule is what does the work.
<p>This matters beyond tidiness. Before the contract was applied, the largest
of these alone reported an incremental margin of <b>$98.6M</b> on a store
turning over $7M a year. A number that wrong is easy to catch; the danger is
the same defect one order of magnitude smaller, which would look plausible and
quietly move every rate for that product.</p>
<p><b>This is a POS data-entry problem, not an engine problem</b> &mdash; but
it is the engine's job to refuse it, and worth raising with whoever owns the
till.</p></div>
<div class="scroll"><table>
<tr><th>date</th><th>sku</th><th>quantity</th><th>product</th></tr>
{rows}</table></div>"""


def _calib_verdict(picks: list[dict]) -> tuple[str, str]:
    """Describe this store's confidence quintiles FROM this store's data.

    The sentence here used to be hand-written, and said the fourth quintile
    outscored the fifth. That was true of whichever store it was first
    written against and printed unchanged for every other, on a page that
    claims every number came from the pipeline. Now it is computed, and it
    says which of the three things is actually true: monotone, inverted, or
    neither.
    """
    scored = [r for r in picks
              if r.get("measurable") and r.get("confidence") is not None
              and r.get("hit") is not None]
    if len(scored) < 25:
        return ("Too few scored cards to read the confidence bands.",
                "With %d measurable cards carrying a confidence there is not"
                " enough to say whether the score ranks within the eligible"
                " set." % len(scored))
    scored.sort(key=lambda r: r["confidence"])
    k = len(scored) // 5
    bands = [scored[i * k:(i + 1) * k] for i in range(5)]
    rates = [100.0 * sum(1 for r in b if r["hit"]) / len(b)
             for b in bands if b]
    if len(rates) < 5:
        return ("Too few scored cards to read the confidence bands.",
                "Fewer than five populated quintiles.")
    rising = all(rates[i] <= rates[i + 1] for i in range(4))
    falling = all(rates[i] >= rates[i + 1] for i in range(4))
    # ONE per-cent sign, not two. A substituted VALUE is inserted verbatim
    # into the template - it is not re-processed by %-formatting - so a doubled
    # sign here would have rendered as "74%%" on the page.
    seq = ", ".join("%.0f%%" % r for r in rates)
    if rising:
        return ("The confidence score ranks, lowest band to highest.",
                "Hit rate by quintile: %s. Monotone, so the ordering inside"
                " the slate carries information." % seq)
    if falling:
        return ("The confidence score is INVERTED at this store.",
                "Hit rate by quintile: %s. Higher stated confidence, lower"
                " observed hit rate, across every band. The score is worse"
                " than uninformative here." % seq)
    return ("This one is not a clean result, and pretending otherwise would"
            " be the easiest lie in the report.",
            "Hit rate by quintile: %s. It does not rise monotonically, so"
            " the score separates eligible from ineligible better than it"
            " ranks within the eligible set." % seq)


def write_html(p: dict[str, Any], picks: list[dict], path: str) -> None:
    """One self-contained page. No chart library and no CDN - inline SVG bars,
    so it opens from a file:// URL on a machine with no network."""
    A, B = p["sheet20"], p["old_ordering"]
    lo, hi = p["clustered_ci"]
    edge_r = A["hit_rate"] - p["null_reversion"]

    def _unused_bars() -> str:
        out, x = [], 0
        for h in p["horizons"]:
            d = p["by_horizon"].get(str(h))
            if not d:
                continue
            eh, nh = d["hit_rate"], d["null_reversion"]
            out.append(
                '<rect x="%d" y="%.0f" width="34" height="%.0f" fill="#2563eb"/>'
                '<rect x="%d" y="%.0f" width="34" height="%.0f" fill="#cbd5e1"/>'
                '<text x="%d" y="228" font-size="12" text-anchor="middle" '
                'fill="#475569">%dd</text>'
                '<text x="%d" y="%.0f" font-size="11" text-anchor="middle" '
                'fill="#1e40af">%.0f</text>'
                '<text x="%d" y="%.0f" font-size="11" text-anchor="middle" '
                'fill="#64748b">%.0f</text>'
                % (x + 8, 210 - eh * 1.8, eh * 1.8,
                   x + 46, 210 - nh * 1.8, nh * 1.8,
                   x + 44, h,
                   x + 25, 204 - eh * 1.8, eh,
                   x + 63, 204 - nh * 1.8, nh))
            x += 108
        return "".join(out)

    rows_h = "".join(
        "<tr><td>%d</td><td>%d</td><td><b>%.1f%%</b></td><td>%.0f-%.0f%%</td>"
        "<td>%.1f%%</td><td><b>%+.1f</b></td><td>%.2fx</td></tr>"
        % (h, d["n"], d["hit_rate"], d["ci_lo"], d["ci_hi"],
           d["null_reversion"], d["hit_rate"] - d["null_reversion"],
           d["median_lift"])
        for h in p["horizons"] if (d := p["by_horizon"].get(str(h))))

    rows_r = "".join(
        "<tr><td>%s</td><td>%s</td></tr>" % (k.replace("_", " "), format(v, ","))
        for k, v in sorted(p["refusals"].items(), key=lambda kv: -kv[1]))

    # ONE ROW PER (sku, date). The same pick is evaluated at four horizons, so
    # an undeduplicated "top 12" showed six real picks wearing twelve hats and
    # read as far more variety than there was.
    seen: dict[tuple[str, str], dict] = {}
    for r in sorted(picks, key=lambda r: -(r.get("margin_impact") or 0)):
        seen.setdefault((r["sku"], r["as_of"]), r)
    top = list(seen.values())[:12]
    rows_p = "".join(
        "<tr><td>%s</td><td>%s</td><td>%dd</td><td>%.0f</td><td>%.2fx</td>"
        "<td>%.2f</td><td>%s</td><td>%.2fx</td><td>%s</td></tr>"
        % (r["sku"], r["as_of"], r["horizon"], r["recent_units"], r["uplift"],
           r["p_hit"], "yes" if r["hit"] else "no", r["lift"],
           "$" + format(r.get("margin_impact") or 0, "+,.0f"))
        for r in top)

    rows_cfg = "".join(
        "<tr><td>%s</td><td>%s</td></tr>" % (k.replace("_", " "), v)
        for k, v in p["settings"].items())

    good_edge = "good" if edge_r > 0 else "bad"
    good_imp = "good" if A["margin_impact"] > 0 else "bad"
    good_old = "good" if B.get("margin_impact", 0) > 0 else "bad"

    html = HTML_TEMPLATE % {
        "n": A["n"], "dates": len(p["dates"]), "horizons": len(p["horizons"]),
        "lines": format(p["lines"], ","), "products": format(p["products"], ","),
        "gen": p["generated"][:10], "store": p.get("store_name", ""),
        "hit": A["hit_rate"], "lo": lo, "hi": hi,
        "null_v": p["null_volume"], "null_r": p["null_reversion"],
        "edge_v": A["hit_rate"] - p["null_volume"], "edge_r": edge_r,
        "good_edge": good_edge, "good_imp": good_imp, "good_old": good_old,
        "med_lift": A["median_lift"], "impact": A["margin_impact"],
        "impact_s": format(A["margin_impact"], "+,.0f"),
        "captured_s": format(A["margin_captured"], ",.0f"),
        "captured": A["margin_captured"], "size": A["median_size"],
        "per_card_s": format(A["impact_per_card"], "+,.0f"),
        "b_per_card_s": format(B.get("impact_per_card", 0), "+,.0f"),
        "products": format(p["products"], ","), "runs": p.get("runs", 0),
        "quality": _quality_section(p.get("dropped_lines") or []),
        "costwarn": _cost_warning(p.get("cost_coverage", 1.0)),
        "b_n": B.get("n", 0), "b_hit": B.get("hit_rate", 0),
        "b_impact": B.get("margin_impact", 0),
        "b_impact_s": format(B.get("margin_impact", 0), "+,.0f"),
        "b_captured_s": format(B.get("margin_captured", 0), ",.0f"),
        "b_captured": B.get("margin_captured", 0),
        "b_size": B.get("median_size", 0),
        "bars": charts.horizon_bars(p["by_horizon"], p["horizons"]),
        "over_time": charts.over_time(picks),
        "lift_hist": charts.lift_histogram(picks),
        "calib": charts.calibration(picks),
        "arch": charts.architecture(),
        "rows_h": rows_h, "rows_r": rows_r,
        "rows_p": rows_p, "rows_cfg": rows_cfg,
        "pval": ("%.4f" % p["p_value"]) if p["p_value"] == p["p_value"] else "n/a",
        "cpr": p.get("cards_per_run", 0.0),
        "fisher": (("%.3f" % p["fisher_p"])
                   if p.get("fisher_p") == p.get("fisher_p") else "n/a"),
        "calib_verdict": _calib_verdict(picks)[0],
        "calib_detail": _calib_verdict(picks)[1],
        
        
        "trading": format(p["trading_days"], ","),
    }
    Path(path).write_text(html, encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
