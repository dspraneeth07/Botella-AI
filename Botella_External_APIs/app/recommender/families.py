"""The card families that come from signals and the catalogue, not from stock.

`deterministic.py` answers two questions from stock and sales alone: what is
running out, and what is not moving. Those are the whole of the reorder job and
none of the rest of it.

This module adds the families that need something else - an upcoming event, a
co-purchase pair, a product the store does not yet carry - and it is separate
from `deterministic.py` because the evidence is of a different KIND. A stockout
is arithmetic on the store's own receipts. "It will be hot on Friday, so chill
the seltzer" is a real signal joined to a plausible product, and the join is
weaker than the arithmetic. Keeping them in one file would make it easy to
forget which is which.

WHAT IS AND IS NOT CLAIMED HERE
    Every card states the SIGNAL (measured, from a live source) and the
    PRODUCT's own sales rate (measured, from the store's receipts). Neither is
    invented.

    What is NOT claimed is a lift: no card here says "this sells 40% more on
    game days", because nothing in the warehouse measures that. The card says
    there is a home game and that this product sells; the owner knows their own
    trade well enough to judge the rest. Inventing the middle step is how a
    recommendation engine gets a reputation.

    The honest upgrade is same-window-last-year evidence per SKU, which the
    365-day sales history could support. It is not built here because doing it
    properly means handling a store's first year, moving holidays and the
    difference between a one-off festival and an annual one - and a half-built
    version would produce exactly the confident-sounding number this module is
    written to avoid.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Iterable, NamedTuple, Sequence

import structlog

from app.pipeline.features.taxonomy import category_family_of
from app.pipeline.rank.family import SignalEffect, units_from_effect
from app.recommender.deterministic import is_orderable_sku

log = structlog.get_logger(__name__)

#: Formats that go in a cold box. Chilling a 1.75L handle is not a thing a
#: store does, so a heat card about one is noise however hot it gets.
CHILLABLE_HINTS = ("seltzer", "beer", "cider", "rtd", "canned", "cocktail",
                   "hard tea", "lemonade", "malt")
CHILLABLE_MAX_ML = 750

#: Sports and event keys the pre-stock card understands. Matched against
#: `signals.active_keys`, which is the list a recommendation is ALLOWED to
#: cite - sheet 14 refuses a card citing a key that was not live.
#:
#: `pre_` IS HERE, AND ITS ABSENCE WAS A REAL GAP. This family exists to stock
#: AHEAD of something, and the run-up windows the calendar emits are all named
#: `pre_christmas`, `pre_thanksgiving`, `pre_super_bowl` and so on. Only
#: `holiday_` was listed - the day itself, which is too late to pre-stock for -
#: so the one signal that has ever earned a beta on this estate could not reach
#: the family named after it. `pre_christmas` scored +0.20 on wine and +0.18 on
#: spirits with intervals clear of zero, and was silently unreachable.
EVENT_KEY_PREFIXES = ("pre_", "nhl_", "nfl_", "nba_", "mlb_", "ncaa_",
                      "news_festival",
                      "holiday_")
HEAT_KEYS = ("heat_advisory", "heat_", "hot_")

#: A co-purchase pair needs to have happened often enough to be a pattern.
#: Twelve baskets is roughly one a month over the year the pairs are drawn
#: from; below that it is a coincidence with a support count attached.
MIN_BUNDLE_SUPPORT = 12

#: An area winner has to be winning somewhere real. One store carrying it is an
#: anecdote; five is a pattern worth a card.
MIN_AREA_STORES = 5

#: The evidence count at which a signal effect is trusted as much as it is
#: doubted, for `confidence_from_evidence`. Twenty active days of a signal is the
#: same floor N4.3 reports weekly as the leading indicator of how many signals
#: will ever become usable.
MIN_SIGNAL_OBSERVATIONS = 20


@dataclass(frozen=True, slots=True)
class ExtraPick:
    """One non-stock card, with the evidence that produced it."""

    family: str
    category: str
    action_type: str
    skus: tuple[str, ...]
    rationale: str
    signals_cited: tuple[str, ...]
    confidence: float
    reference_upc: str | None = None
    product_name: str | None = None
    #: Units per day for the product this card is about, where the card is
    #: about ONE product with a measured rate.
    #:
    #: Carried for the same reason migration 022 carries it on the stock
    #: families: the card already states this rate in its own sentence, and
    #: without it the frontend re-derives a rival figure from the buy list's
    #: 90-day average - or, for a SKU the buy list has no row for, derives
    #: nothing, values the card at $0 and folds it under "lower estimated
    #: value". Every signal-family card was landing in that fold.
    #:
    #: None for `bundle` (two products, and its worth is not one SKU's 30-day
    #: run) and `stock_new` (the store has never sold it, so it has no rate).
    daily_rate: float | None = None


def confidence_from_evidence(observations: float, k: float) -> float:
    """n / (n + k) - the same shrinkage form sheets 06, 20 and this file's own
    thresholds already use.

    N3.1 REPLACED FOUR HARDCODED LITERALS WITH THIS. `confidence=0.55` said
    nothing about the card it was attached to: a pair seen in 12 baskets and a
    pair seen in 400 stated the same 0.7. This at least rises with the evidence
    the family actually holds, and `k` is the family's own existing minimum - so
    a card sitting exactly on the minimum states 0.5 and one with ten times the
    minimum states 0.91.

    IT IS STILL NOT A CALIBRATED PROBABILITY and must not be read as one. It is
    an ORDERING signal that goes through sheet 08 like every other raw
    confidence. Measured on the March ledger, the stock families' own p_hit is
    out by 12 to 26 points, so nothing here is claiming better.
    """
    n = max(0.0, float(observations))
    denom = n + max(1e-9, float(k))
    return n / denom


def _rate_of(rates: dict[str, float], sku: str) -> float:
    return float(rates.get(sku) or 0.0)


def _is_chillable(name: str, size_ml: float | None) -> bool:
    n = (name or "").lower()
    if size_ml and size_ml > CHILLABLE_MAX_ML:
        return False
    return any(h in n for h in CHILLABLE_HINTS)


def cold_box(active_keys: Sequence[str], catalogue: dict[str, dict],
             rates: dict[str, float], *, limit: int = 1,
             effects: Mapping[str, SignalEffect] | None = None,
             effects_by_category: Mapping[
                 tuple[str, str], SignalEffect] | None = None,
             ) -> list[ExtraPick]:
    """Heat is coming and these sell cold - IF that has ever been measured here.

    Capped at one card by default because sheet 14 caps it: a slate of "chill
    this, chill that" is one observation about the weather repeated, and the
    owner only has so much cold box.

    N3.1 - THIS FAMILY NOW REFUSES WITHOUT AN ESTIMATED EFFECT, and that is a
    deliberate reduction in coverage. It used to fire on nothing more than "a
    heat key is active", pick the fastest-selling chillable SKU, and state 0.55.
    Nothing asked whether heat moves THIS store's seltzer or by how much.
    Measured over 155 signal-driven recommendations, that layer scored 6 to 10
    points BELOW random - so a card priced at a guess is worse than no card.

    `effects` is filled by N4.1 (signal elasticity, with the interval, refusing
    where it spans zero). Until it exists this returns nothing, which is the
    honest state rather than a silent downgrade.
    """
    key = next((k for k in active_keys
                if any(k.startswith(h) or k == h for h in HEAT_KEYS)), None)
    if not key:
        return []
    # PER CATEGORY FIRST, exactly as pre_stock resolves it, and for the same
    # measured reason: pooling destroys the signal. With real archived weather
    # history the pooled fit at Marshfield gave cold_snap beta = -0.083, while the
    # per-category fit gave -0.118 on BEER specifically - sharper, and attributed
    # to the shelf it actually describes.
    by_category = effects_by_category or {}
    store_wide = (effects or {}).get(key)

    def effect_for(sku: str) -> SignalEffect | None:
        family = category_family_of(
            (catalogue.get(sku) or {}).get("category", "") or "")
        if family is not None:
            specific = by_category.get((key, family))
            if specific is not None:
                return specific
        return store_wide

    ranked = sorted(
        (
            (sku, meta) for sku, meta in catalogue.items()
            if _is_chillable(meta.get("name", ""), meta.get("size_ml"))
            and _rate_of(rates, sku) > 0
            # No estimate, an interval spanning zero, or a SUPPRESSOR. All three
            # mean the same thing here: there is no card. The suppressor case is
            # the one this engine actually measures - beer FALLS 11.8% in a
            # Marshfield cold snap - and reading that as a reason to stock up
            # would be the exact inversion the interval test exists to prevent.
            and units_from_effect(effect_for(sku), 1.0) is not None
        ),
        key=lambda t: -_rate_of(rates, t[0]),
    )
    if not ranked:
        return []
    out = []
    for sku, meta in ranked[:limit]:
        rate = _rate_of(rates, sku)
        # Per SKU, because the effect is per category and the confidence below is
        # derived from THAT estimate's evidence count rather than a store-wide one.
        effect = effect_for(sku)
        out.append(ExtraPick(
            family="cold_box", category="weather", action_type="cold_box",
            skus=(sku,),
            rationale=(
                f"A heat advisory is live and {meta.get('name', sku)} sells "
                f"{rate * 7:.1f} a week. Get it cold before the weekend."
            ),
            signals_cited=(key,),
            # N3.1 - derived from the effect's own evidence, not written down.
            confidence=confidence_from_evidence(effect.observations,
                                                MIN_SIGNAL_OBSERVATIONS),
            product_name=meta.get("name"),
            daily_rate=rate,
        ))
    return out


def pre_stock(active_keys: Sequence[str], catalogue: dict[str, dict],
              rates: dict[str, float], *, limit: int = 2,
              effects: Mapping[str, SignalEffect] | None = None,
              effects_by_category: Mapping[
                  tuple[str, str], SignalEffect] | None = None,
              ) -> list[ExtraPick]:
    """Something is on locally; stock the things people buy for it - IF measured.

    N3.1 - refuses without an estimated effect, for the same reason cold_box
    does, and with a sharper confound: a festival or a home fixture is SCHEDULED
    for a weekend that was going to be busy anyway, so the naive version is
    measuring the weekend and crediting the event.

    THE EFFECT IS CATEGORY-SPECIFIC, AND THAT WAS MEASURED THE HARD WAY
        `effects_by_category` is keyed on (signal_key, drink family) and is
        preferred over `effects` where it has an entry, because pooling the
        categories destroys the signal:

            per category   5 of 504 cells earned a beta - pre_christmas on wine
                           at Mango Jo's and Northlake, spirits at Cork Runner
                           and Northlake, beer at Northlake
            pooled         1 cell survived

        Wine and spirits respond to the Christmas run-up and the rest of the shelf
        does not, so a single store-wide beta averages a real effect against
        nothing and the interval then straddles zero. Looking the effect up per
        SKU's own category is what recovers the four that pooling lost.

        `effects` is kept as the fallback for signals that genuinely are
        store-wide, and so every existing caller keeps working.
    """
    key = next((k for k in active_keys
                if any(k.startswith(p) for p in EVENT_KEY_PREFIXES)), None)
    if not key:
        return []
    by_category = effects_by_category or {}
    store_wide = (effects or {}).get(key)

    def effect_for(sku: str) -> SignalEffect | None:
        """This SKU's category first, then the store-wide estimate."""
        family = category_family_of(
            (catalogue.get(sku) or {}).get("category", "") or "")
        if family is not None:
            specific = by_category.get((key, family))
            if specific is not None:
                return specific
        return store_wide

    # A card is only worth ranking for if SOMETHING here has a usable effect.
    # Checked before the sort so a store with no measured response does no work
    # and, more importantly, emits nothing.
    candidates = [
        (sku, meta) for sku, meta in catalogue.items()
        if _rate_of(rates, sku) > 0
        and units_from_effect(effect_for(sku), 1.0) is not None
    ]
    if not candidates:
        return []
    ranked = sorted(candidates, key=lambda t: -_rate_of(rates, t[0]))
    out = []
    for sku, meta in ranked[:limit]:
        rate = _rate_of(rates, sku)
        effect = effect_for(sku)
        out.append(ExtraPick(
            family="pre_stock",
            category="calendar_sports" if key[:3] in {"nhl", "nfl", "nba", "mlb"} or key.startswith("ncaa") else "news",
            action_type="pre_stock",
            skus=(sku,),
            rationale=(
                f"{key.replace('_', ' ')} is on locally. "
                f"{meta.get('name', sku)} is one of your fastest sellers at "
                f"{rate * 7:.1f} a week - make sure there is depth on it."
            ),
            signals_cited=(key,),
            # N3.1 - derived from the effect's own evidence, not written down.
            confidence=confidence_from_evidence(effect.observations,
                                                MIN_SIGNAL_OBSERVATIONS),
            product_name=meta.get("name"),
            daily_rate=rate,
        ))
    return out


def bundles(pairs: Iterable[Any], catalogue: dict[str, dict],
            rates: dict[str, float], *, limit: int = 1) -> list[ExtraPick]:
    """Two products the register keeps ringing up together.

    The only family here whose evidence is entirely the store's own: `support`
    is a count of real baskets. No signal, no inference - just "these go
    together at YOUR till, put them near each other".
    """
    out = []
    for p in sorted(pairs, key=lambda x: -(getattr(x, "support", 0) or 0)):
        if len(out) >= limit:
            break
        support = int(getattr(p, "support", 0) or 0)
        a, b = getattr(p, "sku_a", None), getattr(p, "sku_b", None)
        if support < MIN_BUNDLE_SUPPORT or not a or not b:
            continue
        # THE BIGGEST NUMBERS HERE ARE NOT PRODUCTS.
        #
        # Store 171's three best-supported pairs are GIFT_C + "2" (119
        # baskets), 619947000037 + non_inventory (26) and "22" + GIFT_C (22) -
        # a gift card rung with a discount key, and a bottle rung against a
        # non-inventory line. Sorting by support puts them first every time,
        # so "these two sell each other, site them together" would name a till
        # key. Same blocklist the reorder path uses, so the two families agree
        # on what counts as a product.
        if not is_orderable_sku(a, None) or not is_orderable_sku(b, None):
            continue
        if a not in catalogue or b not in catalogue:
            continue
        na = catalogue[a].get("name", a)
        nb = catalogue[b].get("name", b)
        out.append(ExtraPick(
            family="bundle", category="bundle", action_type="bundle",
            skus=(a, b),
            rationale=(
                f"{na} and {nb} were bought together in {support} baskets. "
                f"Sited side by side they sell each other."
            ),
            signals_cited=(),
            # The strongest evidence in this module - a measured count from
            # this store's own receipts - and the confidence says so.
            # N3.1 - rises with the baskets actually observed: a pair seen in
            # 12 baskets and one seen in 400 no longer state the same number.
            confidence=confidence_from_evidence(support, MIN_BUNDLE_SUPPORT),
        ))
    return out


def stock_new(winners: Iterable[Any], *, limit: int = 1) -> list[ExtraPick]:
    """A product doing well at comparable stores that this one does not carry.

    SKU-LESS BY NECESSITY. The store has never sold it, so it has no SKU here;
    sheet 14 sanctions that shape for `new_arrival` picks citing `area_winner`,
    stamps the peer UPC as `reference_upc`, and strips anything that was put in
    primary_skus rather than passing a fake SKU downstream.
    """
    out = []
    for w in sorted(winners, key=lambda x: -(getattr(x, "avg_weekly_units", 0) or 0)):
        if len(out) >= limit:
            break
        if getattr(w, "carried", True):
            continue
        stores = int(getattr(w, "store_count", 0) or 0)
        if stores < MIN_AREA_STORES:
            continue
        name = getattr(w, "product_name", None)
        upc = getattr(w, "upc", None)
        if not name or not upc:
            continue
        weekly = float(getattr(w, "avg_weekly_units", 0) or 0)
        out.append(ExtraPick(
            family="stock_new", category="new_arrival", action_type="stock_new",
            skus=(),
            rationale=(
                f"{name} sells about {weekly:.1f} a week across {stores} "
                f"comparable stores and you do not carry it."
            ),
            signals_cited=("area_winner",),
            # N3.1 - rises with how many area stores agree, against the
            # family's own existing minimum.
            confidence=confidence_from_evidence(stores, MIN_AREA_STORES),
            reference_upc=str(upc),
            product_name=name,
        ))
    return out


#: Shrinkage constant for an EVENT's confidence, in OCCURRENCES - not days.
#:
#: `MIN_SIGNAL_OBSERVATIONS` is 20 and is right for a daily signal, where twenty
#: active days is a thin but real sample. An event happens ONCE A YEAR: four past
#: Thanksgivings is strong evidence for a Thanksgiving, and n/(n+20) would score it
#: 0.167 - indistinguishable from no evidence at all. That is a unit mismatch,
#: days against years, and it would have put a near-zero confidence on the
#: best-evidenced playbook this estate can produce.
#:
#: Three gives 2 occurrences 0.40, 3 gives 0.50, and 4 gives 0.57 - which reads as
#: "some evidence, not conclusive", and is what two to four annual observations
#: actually support. It becomes MEASURED when playbook outcomes can be compared by
#: occurrence count.
MIN_EVENT_OCCURRENCES = 3


def event_playbook(playbook: Any, *, occurrences: int,
                   limit: int = 1) -> list[ExtraPick]:
    """One event playbook as ONE card carrying many SKUs.

    N8.3's whole point: thirty products for Thanksgiving is thirty LINES on one
    card, not thirty cards. The owner makes one decision and commits cash once, so
    `skus` carries the whole order list and the rationale carries the plan.

    An EMPTY playbook produces no card. That is a real and common answer - a store
    with one past occurrence of an event cannot estimate it, and `MIN_OCCURRENCES`
    refuses rather than guessing from one year. Marshfield's export begins in
    February 2025, so it has exactly one Thanksgiving and correctly gets no
    Thanksgiving playbook.

    `occurrences` is how many past instances of the event the THINNEST line rests
    on, and it is passed in rather than read off the lines because `PlaybookLine`
    does not carry a count - it carries `evidence` as a sentence. Reaching for a
    field that does not exist returned 0, which made
    `confidence_from_evidence(0, 20)` exactly 0.0 and would have put a
    zero-confidence card in front of an owner. Caught by checking the arithmetic
    rather than the test, which passed.

    A playbook built on two Thanksgivings is a weaker claim than one built on four,
    and a hardcoded number would hide that - which is what the build guard exists
    to prevent.
    """
    if playbook is None or getattr(playbook, "is_empty", True):
        return []
    lines = list(playbook.lines)[:]
    if not lines:
        return []
    if occurrences <= 0:
        # Every usable uplift rests on at least MIN_OCCURRENCES instances, so a
        # zero here means the caller lost the count rather than the evidence being
        # absent. Refusing is safer than printing a 0.00-confidence plan.
        return []

    # The thinnest line's evidence governs, not the best one: a plan is only as
    # trustworthy as the weakest row an owner is being asked to act on. The caller
    # computes it from the uplifts it already holds.
    top = ", ".join(f"{line.order_units:.0f} x {line.product}"
                    for line in lines[:3])
    more = (f", and {len(lines) - 3} more line(s)" if len(lines) > 3 else "")
    return [ExtraPick(
        family="event_playbook",
        category="calendar_sports",
        action_type="pre_stock",
        skus=tuple(line.sku for line in lines),
        rationale=(
            f"{playbook.explain()} Order by {playbook.alert_on:%d %b}: "
            f"{top}{more}. Based on {playbook.evidence}."
        ),
        signals_cited=(f"event_{playbook.event_key}",),
        # In OCCURRENCES, not days - see MIN_EVENT_OCCURRENCES.
        confidence=confidence_from_evidence(occurrences, MIN_EVENT_OCCURRENCES),
        product_name=None,
        daily_rate=None,
    )][:limit]


def to_raw(picks: Sequence[ExtraPick], *, as_of: date,
           valid_days: int = 14, start_rank: int = 1) -> list[dict]:
    """The same dict shape the stock families produce, so one assembler works."""
    through = (as_of + timedelta(days=valid_days)).isoformat()
    out = []
    for i, p in enumerate(picks, start=start_rank):
        row: dict[str, Any] = {
            "rank": i,
            "category": p.category,
            "action_type": p.action_type,
            "primary_skus": list(p.skus),
            "quantity_hint": None,
            "rationale": p.rationale,
            "signals_cited": list(p.signals_cited),
            "confidence": p.confidence,
            # WHAT THAT NUMBER IS. `confidence_from_evidence` above: n / (n + k)
            # over the family's own evidence count. It rises with evidence and
            # is not a probability of anything, and until this label every one
            # of these cards reached Node with no basis at all - 352 rows in the
            # analytics store said nothing about what their figure meant. One
            # of the closed set in app/schemas/recommendation.py.
            "confidence_basis": "family_evidence_count",
            "valid_through": through,
            "suggested_order_qty": None,
        }
        if p.daily_rate is not None:
            row["engine_daily_rate"] = round(p.daily_rate, 4)
        if p.reference_upc:
            row["reference_upc"] = p.reference_upc
        out.append(row)
    return out


__all__ = [
    "ExtraPick",
    "signal_effects_from_rows",
    "signal_status_from_rows",
    "SignalStatus",
    "bundles",
    "cold_box",
    "pre_stock",
    "stock_new",
    "to_raw",
]


# ── THE PUBLISHED EFFECTS, PARSED ───────────────────────────────────────────


def signal_effects_from_rows(
    rows: Sequence[Any],
) -> dict[tuple[str, str], SignalEffect]:
    """{(signal_key, drink family): SignalEffect} from migration 029's rows.

    THE REFUSAL RULE IS APPLIED TWICE ON PURPOSE. The endpoint already filters on
    its `usable` column, and every row is checked again here against
    `SignalEffect`'s own interval test. That is not belt-and-braces for its own
    sake: the two live in different languages on different sides of a network hop,
    and the whole reason this feed exists is that a card may not cite an effect
    whose interval includes zero. A single implementation of that rule, reachable
    from only one of the two, is how the rule stops being enforced.

    A row that cannot be parsed is DROPPED, not defaulted. A SignalEffect built
    from a missing beta would be an effect of zero presented as a measurement, and
    `cold_box` would then read it as "measured, and not worth acting on" when the
    truth is "we do not know".
    """
    out: dict[tuple[str, str], SignalEffect] = {}
    for row in rows or ():
        get = row.get if isinstance(row, dict) else lambda k, d=None: getattr(row, k, d)
        key = (get("signal_key") or "").strip()
        family = (get("category_family") or "").strip()
        if not key or not family:
            continue
        beta, lo, hi = get("beta"), get("interval_lo"), get("interval_hi")
        if beta is None or lo is None or hi is None:
            continue
        try:
            beta, lo, hi = float(beta), float(lo), float(hi)
        except (TypeError, ValueError):
            continue
        # An interval spanning zero is not an effect. The endpoint says it already
        # excluded these; this is the check that makes that claim unnecessary.
        if lo <= 0.0 <= hi:
            continue
        # ── ACTIVE DAYS, NOT TOTAL DAYS ────────────────────────────────────
        #
        # `MIN_SIGNAL_OBSERVATIONS = 20` is denominated in ACTIVE days - its own
        # comment above says so - and the fit reports both: 1,363 days observed of
        # which 21 had pre_christmas on. Feeding the total made a card claim
        # confidence 0.99 on an effect resting on twenty-one days, because
        # 1363/(1363+20) is 0.986. The contrast is what carries the information, so
        # the contrast is the evidence count: 21/(21+20) is 0.51.
        #
        # This is the same unit mismatch the event playbook hit from the other
        # direction, where four annual Thanksgivings scored 0.167 against a
        # daily-signal constant. Both times the number looked plausible and was
        # measuring the wrong thing.
        active = get("active_days")
        observations = get("observations")
        count = active if active is not None else observations
        try:
            out[(key, family)] = SignalEffect(
                key=key, beta=beta, interval_lo=lo, interval_hi=hi,
                observations=int(count or 0),
                basis=str(get("basis") or "measured"),
            )
        except (TypeError, ValueError):
            # SignalEffect refuses an inverted interval or a negative count. A
            # malformed row must cost its own cell and nothing else.
            continue
    return out


# ── THE SAME ROWS, FOR DISPLAY, REFUSALS KEPT ───────────────────────────────


#: What is known about one (signal, family) cell. `beta` is set only when the
#: cell is citable; `reason` only when it is not. Exactly one of them is present,
#: which is what stops a reader treating an unmeasured cell as a zero effect.
SignalStatus = NamedTuple("SignalStatus", [
    ("key", str),
    ("family", str),
    ("state", str),            # measured | not_measurable | not_fitted
    ("beta", float | None),
    ("interval_lo", float | None),
    ("interval_hi", float | None),
    ("reason", str | None),
    ("active_days", int | None),
    ("observations", int | None),
])


def signal_status_from_rows(
    rows: Sequence[Any],
) -> dict[tuple[str, str], SignalStatus]:
    """{(signal_key, family): SignalStatus} over EVERY row, refusals included.

    WHY THIS EXISTS ALONGSIDE `signal_effects_from_rows` AND DOES NOT REPLACE IT.
    That function answers "may a card cite this?" and must keep dropping every
    refused cell - a card may not act on an effect whose interval spans zero, and
    that rule is the reason this whole feed exists. This one answers a different
    question: "did you look, and what did you find?" An owner with three live
    events on screen and nothing on any card was being told, in effect, that the
    engine ignores the events. It did not ignore them; it looked at 639 cells,
    found ten citable, and had no way to say the other 635 had been examined.

    SO `beta` IS SET ONLY WHERE THE CELL IS CITABLE. A refused cell carries its
    reason and a null beta, never 0.0. A zero would read as "measured, and the
    signal does nothing", which is a claim this data does not support - the
    commonest refusal is `too_few_active_days:4<20`, meaning the event has not
    happened often enough to measure AT ALL. Those are different facts and the
    second one is the true one.

    The citability test is re-applied here rather than trusted from the row's
    `usable` column, for the same reason `signal_effects_from_rows` re-applies it:
    one rule, enforced wherever it is read.
    """
    out: dict[tuple[str, str], SignalStatus] = {}
    for row in rows or ():
        get = row.get if isinstance(row, dict) else lambda k, d=None: getattr(row, k, d)
        key = (get("signal_key") or "").strip()
        family = (get("category_family") or "").strip()
        if not key or not family:
            continue

        def _int(value: Any) -> int | None:
            try:
                return int(value)
            except (TypeError, ValueError):
                return None

        active, obs = _int(get("active_days")), _int(get("observations"))
        reason = (get("refused_reason") or "").strip() or None
        beta, lo, hi = get("beta"), get("interval_lo"), get("interval_hi")
        try:
            beta = None if beta is None else float(beta)
            lo = None if lo is None else float(lo)
            hi = None if hi is None else float(hi)
        except (TypeError, ValueError):
            beta = lo = hi = None

        citable = (reason is None and beta is not None
                   and lo is not None and hi is not None
                   and not (lo <= 0.0 <= hi))
        if citable:
            state = "measured"
        else:
            state = "not_measurable"
            # An interval that straddles zero is a refusal even when the fit
            # recorded none, and it has to SAY so: dropping the beta without a
            # reason produces a cell that looks unexamined when it was examined
            # and found inconclusive.
            if reason is None and beta is not None:
                reason = "interval_spans_zero"
            beta = None
        out[(key, family)] = SignalStatus(
            key=key, family=family, state=state, beta=beta,
            interval_lo=lo if citable else None,
            interval_hi=hi if citable else None,
            reason=reason, active_days=active, observations=obs,
        )
    return out
