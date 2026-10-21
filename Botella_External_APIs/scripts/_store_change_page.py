"""One page per store: what changed here, and why THIS store's numbers moved.

WHY PER STORE AND NOT ONE SHARED LIST OF CAUSES
    A single list of five causes tells a reader what happened across the estate.
    It does not tell them why THEIR store moved, and at one of these five stores
    the hit rate went DOWN while the estate's went up - so a shared page would be
    actively misleading exactly where a reader most needs the truth.

    Every reason block here is therefore selected and filled from the store's own
    figures. Where a cause did not apply - the merchandise screen had nothing to
    remove at three of the five - the page says so rather than reciting it.

THE ENGINE IS JUDGED ONE STORE AT A TIME
    It is switched on one store at a time, so a pooled average would let the
    largest store carry the result: Cork Runner has four times Bethany's line
    items, and a units-weighted mean is mostly one store wearing five hats.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from scripts._gates import gate_table
from scripts._ledger_report import CSS, _esc

HORIZONS = ("30", "60", "90", "120")


def summary_of(path: Path) -> dict[str, Any]:
    """A ledger's summary block, or {} when that generation does not exist."""
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8")).get("summary") or {}


def horizon_rows(old: dict[str, Any], new: dict[str, Any], pct, money,
                 delta_cell) -> str:
    """One row per horizon.

    These four rows are ONE decision watched for longer, not four decisions. A
    rate that climbs down the table is that single decision playing out, which is
    why all four are published rather than whichever reads best.
    """
    rows = []
    for h in HORIZONS:
        o, n = old.get(h) or {}, new.get(h) or {}
        if not n:
            continue
        rows.append(
            f'<tr><td><b>{h} days</b>'
            f'<span class="span">after each decision</span></td>'
            f'<td>{pct(o.get("hit_rate"))}'
            f'<span class="span">n={o.get("n", 0)}</span></td>'
            f'<td><b>{pct(n.get("hit_rate"))}</b>'
            f'<span class="span">n={n.get("n", 0)}</span></td>'
            + delta_cell(o.get("hit_rate"), n.get("hit_rate"))
            + f'<td>{money(o.get("net_margin"))}</td>'
            f'<td><b>{money(n.get("net_margin"))}</b></td>'
            + delta_cell(o.get("net_margin"), n.get("net_margin"), as_money=True)
            + "</tr>")
    return "".join(rows)


def per_card_block(new: dict[str, Any]) -> str:
    """Net margin PER CARD with its date-clustered interval.

    The figure to compare stores on, and the one that decides whether a store is
    SIGNIFICANTLY positive rather than merely positive. A total mostly measures
    which store issued more cards.
    """
    s30 = new.get("30") or {}
    npc, ci = s30.get("net_margin_per_card"), s30.get("net_margin_per_card_ci")
    if npc is None:
        return ('<div class="band warn"><h3>No money measured</h3>'
                '<p>No card at this store carried both a margin and a holding '
                'cost, so there is no net figure &mdash; reported as absence '
                'rather than as zero.</p></div>')
    if ci is None:
        interval = ("no clustered interval &mdash; fewer than two decision dates "
                    "carried measurable money")
        cls, verdict = "warn", "not testable"
    else:
        interval = f"95% interval ${ci[0]:+,.2f} to ${ci[1]:+,.2f}"
        excludes_zero = ci[0] > 0 or ci[1] < 0
        cls = "good" if (excludes_zero and npc > 0) else "warn"
        verdict = ("significantly positive" if excludes_zero and npc > 0
                   else "significantly negative" if excludes_zero
                   else "spans zero &mdash; not significant")
    return (f'<div class="band {cls}"><h3>Net margin per card: ${npc:+,.2f} '
            f'&mdash; {verdict}</h3>'
            f'<p>{interval}, clustered by decision date because two cards issued '
            f'on the same morning share a market. Measured on '
            f'{s30.get("cards_with_money", 0)} of {s30.get("n", 0)} cards '
            f'&mdash; a card with no unit cost is excluded, not counted as '
            f'zero.</p></div>')


def _money_reason(old_net, new_net, cogs, money) -> str:
    correction = ""
    if cogs is not None and new_net is not None:
        correction = (f" On the old ruler the same month reads {money(cogs)}, so "
                      f"the correction here is worth {money(new_net - cogs)}.")
    return (
        f'<div class="band warn"><h3>1 &mdash; The money moved because the ruler '
        f'was wrong, not because the picks changed</h3>'
        f'<p>This store read <b>{money(old_net)}</b> and now reads '
        f'<b>{money(new_net)}</b>. The old figure charged the <b>entire cost of '
        f'goods</b> for every unit a card said to buy that did not sell, as '
        f'though the stock had been destroyed. Liquor does not spoil: a surplus '
        f'bottle is deferred revenue, and its real cost is capital tied up, shelf '
        f'space and the chance it never sells at full price &mdash; cents a month '
        f'on a $20 bottle, not $20.{correction}</p>'
        f'<p class="span">The engine picked the same products. Nothing in this '
        f'row should be read as the engine having improved.</p></div>')


def _screen_reason(old_cards, new_cards, old_hit, new_hit, pct) -> str:
    if not old_cards or not new_cards:
        return ""
    if old_cards == new_cards:
        return (
            f'<div class="band"><h3>2 &mdash; The card set did not change</h3>'
            f'<p>{new_cards} cards before and after, and the 30-day hit rate is '
            f'<b>{pct(new_hit)}</b> either way. This store had no lottery or '
            f'cigarette lines among its recommendations, so the merchandise '
            f'screen had nothing to remove here. Its money still moved, for the '
            f'reason above.</p></div>')
    direction = "fewer" if new_cards < old_cards else "more"
    moved = ("" if old_hit is None or new_hit is None else
             f" Its 30-day hit rate went from <b>{pct(old_hit)}</b> to "
             f"<b>{pct(new_hit)}</b>.")
    fell = (old_hit is not None and new_hit is not None and new_hit < old_hit)
    if fell:
        return (
            f'<div class="band bad"><h3>2 &mdash; This store&rsquo;s score FELL, '
            f'and the fall is the honest number</h3>'
            f'<p>{old_cards} cards became {new_cards} &mdash; '
            f'{abs(new_cards - old_cards)} {direction}.{moved} Lottery and '
            f'cigarette lines such as <code>$2 SCRATCHOFF</code> and '
            f'<code>MARLBORO PACK</code> are not restockable merchandise in the '
            f'sense this engine models, and they were being scored. At this store '
            f'they were hitting almost every time and <b>inflating</b> the rate, '
            f'so screening them took it down.</p>'
            f'<p>A screen that only ever raises a score is a screen that is '
            f'selecting on the outcome. This one lowered a store, and the lower '
            f'number is what is published.</p></div>')
    return (
        f'<div class="band warn"><h3>2 &mdash; Non-merchandise left the measured '
        f'path</h3>'
        f'<p>{old_cards} cards became {new_cards} &mdash; '
        f'{abs(new_cards - old_cards)} {direction}. Lottery and cigarette lines '
        f'are not restockable merchandise in the sense this engine models, and '
        f'they were being scored.{moved}</p>'
        f'<p class="span">At Northlake the same screen LOWERED the rate, because '
        f'those lines had been inflating it there. The screen is not tuned per '
        f'store.</p></div>')


def _promise_reason(old_fill, new_fill, kept, pct) -> str:
    kept_note = ("" if kept is None else
                 f" For comparison, the fraction of individual cards that met "
                 f"their promise is <b>{pct(kept)}</b> &mdash; a different "
                 f"statistic, bounded above by the hit rate, and the one the "
                 f"retired check was demanding 85&ndash;95% of.")
    return (
        f'<div class="band bad"><h3>3 &mdash; The promise column changed its '
        f'meaning, not just its value</h3>'
        f'<p>It read <b>{pct(old_fill, 0)}</b> and now reads '
        f'<b>{pct(new_fill, 0)}</b>, and it was labelled <i>promise kept</i>. It '
        f'never was a kept rate: it is total units delivered over total units '
        f'promised, so <b>100% means the promise carried no systematic bias</b>, '
        f'below means over-promising and above means under-promising.{kept_note}'
        f'</p>'
        f'<p>The old gate banded this 85&ndash;95%, which excluded an unbiased '
        f'promise and demanded a permanent 5&ndash;15% shortfall. It is now banded '
        f'85&ndash;115% and renamed <code>promise_unbiased</code>.</p></div>')


def _calibration_reason(ece, fitted, scored, transform) -> str:
    if "isotonic" not in str(transform):
        return (
            f'<div class="band warn"><h3>4 &mdash; No curve could be fitted, so '
            f'this is the RAW score</h3>'
            f'<p>The {ece:.1f}-point figure describes the raw ranking score, not '
            f'a calibrated one. Reported as raw, because the same number means '
            f'opposite things in those two cases.</p></div>')
    ok = ece < 5.0
    tail = "" if ok else " That is a real failure and it is published."
    return (
        f'<div class="band {"good" if ok else "bad"}">'
        f'<h3>4 &mdash; The stated confidence is now a measured probability '
        f'&mdash; {"and it holds" if ok else "and it fails"}</h3>'
        f'<p>The raw <code>p_hit</code> is a ranking score, not a probability, '
        f'and the card says so in as many words. Fitting the isotonic curve on '
        f'<b>{fitted} cards from January and February</b> and scoring '
        f'<b>{scored} cards in March</b> &mdash; so this store is not graded on a '
        f'slice it was fitted to &mdash; gives an expected calibration error of '
        f'<b>{ece:.1f} points</b> against a bar of 5.{tail}</p>'
        f'<p class="span">A reliability bin needs 30 outcomes to count: at n=30 '
        f'and p=0.5 the binomial standard error is 9.1 points, which is the floor '
        f'at which a 10-point per-bin test stops measuring noise. A five-card bin '
        f'was condemning a whole store before this.</p></div>')


_RANGE_REASON = (
    '<div class="band good"><h3>5 &mdash; The card now publishes a range it can '
    'be held to</h3>'
    '<p>Every card used to state a point &mdash; &ldquo;about 78 units&rdquo; '
    '&mdash; which invites &ldquo;you said 78 and I got 61, you were '
    'wrong&rdquo;. It now also states a two-sided 90% range sized to that '
    'product&rsquo;s own measured scatter, and that range is what the '
    '<code>interval_coverage</code> check tests. Measuring the coverage of an '
    'interval the owner never sees would be scoring the engine on a claim it '
    'never made.</p></div>')


def store_reasons(store, old, old_sum, new_sum, pct, money, delta_cell) -> str:
    """The reasons that apply to THIS store, filled with this store's numbers."""
    blocks = []
    o30, n30 = old_sum.get("30") or {}, new_sum.get("30") or {}
    old_net, new_net = o30.get("net_margin"), n30.get("net_margin")

    if old_net is not None and new_net is not None:
        blocks.append(_money_reason(
            old_net, new_net, n30.get("net_margin_cogs_ruler"), money))

    screen = _screen_reason(o30.get("n"), n30.get("n"), o30.get("hit_rate"),
                            n30.get("hit_rate"), pct)
    if screen:
        blocks.append(screen)

    new_fill = store.get("promise_fill_ratio")
    if new_fill is not None:
        blocks.append(_promise_reason(
            old.get("promise30"), new_fill, store.get("promise_kept_rate"), pct))

    ece = store.get("ece")
    if ece is not None:
        blocks.append(_calibration_reason(
            ece, store.get("calibration_fitted") or 0,
            store.get("calibration_scored") or 0,
            store.get("calibration_transform") or "identity"))

    blocks.append(_RANGE_REASON)
    return "".join(blocks)


def build_store_page(store, old, old_sum, new_sum, month_label, *,
                     pct, money, delta_cell) -> str:
    loc, name = store["loc"], store["name"]
    verdict = gate_table([store])[0]
    mark = {True: '<span class="good">PASS</span>',
            False: '<span class="bad">FAIL</span>',
            None: '<span class="span">n/a</span>'}
    checks = "".join(
        f'<tr><td><span class="span">{_esc(g.gate)}</span>'
        f'<b>{_esc(c.name)}</b></td><td>{mark[c.passed]}</td>'
        f'<td>{_esc(c.detail)}</td></tr>'
        for g in (verdict.gate_a, verdict.gate_b) for c in g.checks)
    cls = "good" if verdict.shippable else "bad"
    n30, o30 = new_sum.get("30") or {}, old_sum.get("30") or {}

    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{_esc(name)} &mdash; what changed, and why</title>
<style>{CSS}</style></head><body><div class="wrap">

<div class="head">
<h1>{loc} {_esc(name)}</h1>
<p class="lede">What changed since the last published report, and the mechanism
behind every move. {month_label} cards, followed 30 to 120 days.</p>
<p class="span">
<a href="ledger-{loc}-2026-03/RECOMMENDATION_LEDGER.html">Full card-by-card
ledger</a> &middot;
<a href="previous/ledger-{loc}-2026-03/RECOMMENDATION_LEDGER.html">The previous
version of this report, unedited</a> &middot;
<a href="WHAT_CHANGED.html">All five stores</a></p>
</div>

<div class="kpis">
<div class="card"><div class="val {cls}">{verdict.verdict}</div>
<div class="lbl">gate verdict</div>
<div class="span">{_esc(verdict.why)}</div></div>
<div class="card"><div class="val">{pct(n30.get("hit_rate"))}</div>
<div class="lbl">30-day hit rate</div>
<div class="span">was {pct(o30.get("hit_rate"))} on {o30.get("n", 0)} cards</div>
</div>
<div class="card"><div class="val">{money(n30.get("net_margin"))}</div>
<div class="lbl">30-day net margin</div>
<div class="span">was {money(o30.get("net_margin"))}</div></div>
<div class="card"><div class="val">{pct(store.get("bt_hit"))}</div>
<div class="lbl">2.3-year backtest</div>
<div class="span">{store.get("bt_edge") or 0:+.1f} points over a matched null,
p = {store.get("bt_p") or 1:.4f}</div></div>
</div>

{per_card_block(new_sum)}

<h2><span class="num">1</span>The same cards, followed for longer</h2>
<p>These four rows are <b>one</b> decision watched for longer, not four separate
decisions. That is why all four are published rather than whichever reads best.</p>
<div class="scroll"><table>
<thead><tr><th>horizon</th><th>hit rate<br>before</th><th>hit rate<br>now</th>
<th>change</th><th>net<br>before</th><th>net<br>now</th><th>change</th></tr>
</thead><tbody>{horizon_rows(old_sum, new_sum, pct, money, delta_cell)}</tbody>
</table></div>

<h2><span class="num">2</span>Why this store&rsquo;s numbers moved</h2>
{store_reasons(store, old, old_sum, new_sum, pct, money, delta_cell)}

<h2><span class="num">3</span>The gate for this store</h2>
<p>Both gates must hold to ship. A gate that does not <b>apply</b> does not block,
but a check that was not <b>measured</b> is never a pass. Four of these checks
printed &ldquo;not measured&rdquo; at every store until this run.</p>
<div class="band {cls}"><h3>{verdict.verdict}</h3><p>{_esc(verdict.why)}</p>
<div class="scroll"><table><thead><tr><th>check</th><th>result</th>
<th>measured against the threshold</th></tr></thead>
<tbody>{checks}</tbody></table></div></div>

<h2><span class="num">4</span>What these numbers do not prove</h2>
<div class="band bad"><h3>The confidence curve is wired in; nothing is published for it to apply</h3>
<p>The calibration checks above are measured out of sample, and the live card
path <b>does apply a fitted curve when one exists</b>:
<code>to_raw_recommendations</code> takes a <code>calibration_bundle</code> and
names the transform in <code>confidence_basis</code>. But a bundle is published
only when the pooled fit clears the 50-outcome floor, and today the pool does
not, so no bundle is published and every card carries the raw ranking score with
<code>confidence_basis</code> reading <code>raw_ranking_score</code>. So these
checks say the method works on this store&rsquo;s data; they do not say an owner
is seeing a calibrated percentage, because until the nightly refit crosses the
floor, no owner is.</p></div>
<ul>
<li><b>Nobody acted on any of these recommendations.</b> They were generated
retrospectively from data the engine could legitimately have seen each morning.
This shows the engine points at products that go on to move; it does not show that
acting on the advice causes the movement.</li>
<li><b>No shelf counts.</b> Historical on-hand does not exist in the warehouse, so
a dip caused by a stockout is indistinguishable from a dip caused by slow
demand.</li>
<li><b>Lead times are declared, not measured.</b> Nothing records when an order
actually arrived, so every order quantity rests on an assumption.</li>
<li><b>{store.get("cards", 0)} cards across {store.get("skus", 0)} products.</b>
Overlapping cards on the same product are treated as independent, so a narrow
catalogue flatters these rates.</li>
</ul>

<div class="foot"><p>Generated by <code>scripts/build_change_report.py</code> from
<code>audit/all_stores.json</code> and this store&rsquo;s ledger. Every figure is
read from those files; none is typed in.</p></div>
</div></body></html>"""


__all__ = ["build_store_page", "summary_of"]
