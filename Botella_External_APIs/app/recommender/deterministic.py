"""Choose the recommendations in code. No model, no sampler, no API call.

WHAT THIS REPLACES
    `pipeline.py` used to hand the model a set of tables and ask it which
    products to recommend. That single fact explained most of the backtest
    result: the ordering was unstable, unexplainable and unimprovable, because
    nobody could say what it optimised. It also meant an Anthropic billing
    problem produced ZERO recommendations - which is not a hypothetical, it is
    what happened on 29 September 2026.

    Selection now runs through `app/pipeline` - the engine measured in
    ENGINE-ARCHITECTURE-AND-RESULTS.md at 75.9% against a 31.9% random pick,
    and +16.7 points against a null that already knows about mean reversion.

WHAT THE MODEL STILL DOES, AND WHY THAT IS FINE
    Writes the sentence, after the decision is fixed (sheets 15-16). Every
    numeral in that sentence is checked against the computed figures. So a
    model outage now costs FLUENCY and never a recommendation: the template
    path carries identical numbers.

THE ONE INPUT THIS NEEDS THAT THE OLD PATH DID NOT
    365 days of per-SKU daily sales. Sheet 20 compares a 28-day window against
    the SKU's own long run, and with only 90 days of history the "long run" is
    a quarter - which is a materially weaker signal (the audit measured a 41.4
    point decile spread for rev_28_90 against 47.2 for rev_28_365).

    `node_sales_window_days` is therefore raised to 365. Node already supports
    it: SALES_DAYS_MAX is 365 and /sales returns one row per (sku, date).

    If a store returns less history than asked for, this degrades rather than
    refusing - the long-run window becomes whatever arrived, and
    `long_run_days_available` records what that was, so a weak signal is
    visible in the output instead of being mistaken for a strong one.

TWO ENTRY POINTS, ONE DECISION (checklist 17)
    `choose()` returns the picks and is what every harness and test calls.
    `select()` returns the same picks inside a `Selection` that also carries
    the claims the lifecycle RETIRED this morning and the screen counts. The
    live route uses `select`, because a retirement has to leave this process
    to mean anything: Node stores it, and tomorrow's card-history feed hands
    the stored date back so the suppression is honoured rather than recomputed
    as "today + 14" every morning.
"""

from __future__ import annotations

from bisect import bisect_left
from collections import defaultdict
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from math import floor
from typing import Any, Iterable, Mapping, Sequence

import structlog

from app.pipeline.candidates.lifecycle import (
    MIN_CANDIDATE_POOL,
    CardHistory,
    CardRetirement,
    DISCOUNT_ACTIONS,
    RECOVERY_RULES,
    review_card,
    suppressed_until,
    suppression_end_date,
)
from app.pipeline.blend.predictive_interval import (
    PredictiveInterval,
    predictive_interval,
)
from app.pipeline.calibrate.apply import ApplyRequest, apply_calibration
from app.pipeline.calibrate.fit import ANY as CALIBRATION_ANY, bundle_from_dict
from app.pipeline.blend.promise_floor import (
    PromiseFloor,
    increment_promise_basis,
    promise_floor,
)
from app.pipeline.candidates.card_history import (
    from_rows as card_history_from_rows,
)
from app.pipeline.candidates.merchandise import classify as catalogue_verdict
from app.pipeline.features.taxonomy import category_family_of
from app.pipeline.gate.store import ServingDecision, serving_decision
from app.pipeline.policy.holding import holding_cost
from app.pipeline.blend.reversion import (
    MATERIALITY_FLOOR_UNITS,
    MIN_WEEKS_FOR_DISPERSION,
    REVERSION_HORIZON_DAYS,
    ReversionRequest,
    dispersion_cv,
    is_recommendable,
    revert,
)
from app.pipeline.context import RunContext
from app.pipeline.registry import cfg

log = structlog.get_logger(__name__)

#: The trailing window sheet 20 corrects. Fixed, and deliberately NOT the
#: forecast horizon: the demand LEVEL is a property of current trading, not of
#: how far ahead you are looking. Tying the two together cost 19.9 points at
#: the 90-day horizon when the backtest did it by accident.
BASELINE_WINDOW_DAYS = 28

#: How far back the long-run rate looks. Clamped to what actually arrived.
LONG_RUN_WINDOW_DAYS = 365

#: Weekly buckets for the dispersion estimate.
STABILITY_WEEKS = 13

#: The largest share of one slate a single family may take before others get a
#: look in. Two thirds: enough that a store with mostly stockouts still sees
#: mostly stockouts, not so much that a second family never appears.
FAMILY_CAP_SHARE = 2 / 3

#: Slate places held for the DISCOUNT group when it has anything to offer.
#:
#: PROVISIONAL. The family cap above is per LABEL, and the buy side spans several
#: labels, so between them they take every slot and the discount side - which
#: scores below every stockout on purpose - is never reached. Measured at
#: Bethany: 15 overstock-flagged SKUs, $774-$1,901 of capital each, and ten
#: reorder cards with no markdown.
#:
#: TWO, and only where there is something to hold them for. A place given to a
#: markdown is a place taken from the highest-returning stockout, so the
#: reservation is small and never takes the last slot. It becomes MEASURED when
#: the acceptance rate of a markdown card can be compared against the margin
#: given up.
OVERSTOCK_SLOT_FLOOR = 2

#: The families that are a decision about stock already paid for, rather than a
#: purchase. Grouped because the cap has to act on the GROUP: capping
#: "overstock" against "recovering" alone is what let the buy side spread itself
#: across labels and crowd the group out entirely.
DISCOUNT_FAMILIES = frozenset({"overstock"})

#: Cover beyond which stock is capital sitting on a shelf rather than inventory.
#:
#: Ninety OPEN days is roughly four months of trading. Deliberately far above
#: the reorder threshold and not a mirror of it: being a fortnight short is an
#: operational problem you fix this week, while being four months long is a
#: buying decision that has already been made and is now costing carry. A
#: tighter number here would flag ordinary seasonal depth as dead stock.
OVERSTOCK_DAYS = 90

#: Below this there is nothing worth an owner's attention tied up, whatever the
#: cover reads. Twenty units of something that sells twice a year is not a
#: markdown, it is a long tail, and a card about it wastes a slot.
OVERSTOCK_MIN_CAPITAL_USD = 150.0

#: Open days an order must cover: lead time + review period (sheet 10).
#:
#: Both DECLARED - the same seven `inventory.py` declares as a registry
#: Setting - and until checklist 16 the stockout card printed the first one
#: as a fact: "A delivery takes 7 days." Nothing had measured it; nothing
#: could, because no receipt date existed. Now one does (migration 037), and
#: `choose` accepts a per-SKU lead-time map: where the pick's vendor has a
#: MEASURED figure the sentence quotes it with its receipt count, and where it
#: does not the sentence says the seven is declared. See `delivery_clause`.
#:
#: SCREENING DOES NOT MOVE WITH THE MAP, deliberately. `COVERAGE_DAYS` decides
#: who is "already covered" and how urgent a stockout is, and a per-SKU cover
#: window would make the slate's membership depend on which vendors happen to
#: have receipts this month. The quantity on the card already sizes against
#: the measured figure (quantity.py); the selection stays comparable across
#: stores. So the behaviour of `choose` without a map is byte-identical to
#: before, which `test_lead_times.py` asserts.
LEAD_TIME_DAYS = 7
REVIEW_PERIOD_DAYS = 7
COVERAGE_DAYS = LEAD_TIME_DAYS + REVIEW_PERIOD_DAYS


def delivery_clause(lead: Any | None) -> str:
    """The stockout card's lead-time clause, flagged with its provenance.

        "a delivery is assumed to take 7 days (declared, not measured)"
        "a delivery from Glazer's takes about 4 days (measured from 4 receipts)"

    `lead` is a `LeadTime` (or anything with `.days`, `.source`,
    `.observations`, `.vendor`) or None. Only a MEASURED row with at least one
    receipt earns the second form; a default row from Node is still the
    declared seven and reads as such.
    """
    if (lead is not None and getattr(lead, "source", None) == "measured"
            and int(getattr(lead, "observations", 0) or 0) > 0):
        n = int(lead.observations)
        vendor = getattr(lead, "vendor", None)
        who = f" from {vendor}" if vendor else ""
        receipts = "receipt" if n == 1 else "receipts"
        return (f"a delivery{who} takes about {float(lead.days):.0f} days "
                f"(measured from {n} {receipts})")
    return f"a delivery is assumed to take {LEAD_TIME_DAYS} days (declared, not measured)"


#: The two values `lead_time_basis` may carry. Mirrors the policy's
#: LEAD_TIME_SOURCE_MEASURED / "declared" wording on the card's assumption
#: sentence, so a reader meets one vocabulary for one fact.
LEAD_TIME_BASIS_MEASURED = "measured"
LEAD_TIME_BASIS_DECLARED = "declared"


def lead_time_for(lead: Any | None) -> tuple[int, str]:
    """The lead time a card's deadline rests on, and where it came from.

    THE SAME RULE AS THE SENTENCE AND THE QUANTITY. `delivery_clause` quotes a
    measured per-vendor figure when the row has at least one receipt and the
    declared seven otherwise; `quantity.PolicyQuantities._lead_time_overrides`
    orders against the same rounded integer. A deadline computed from a third
    reading of the row would be the two-screens defect again, one layer down:
    "a delivery from Glazer's takes about 4 days" beside an order-by date
    worked out on seven.

    Rounded here exactly as the policy rounds it - `max(1, int(round(days)))` -
    so the quantity and the date rest on one integer. A measured row that does
    not parse falls back to the declared figure rather than to zero: zero lead
    time would say "order the day it runs out", which is advice that arrives
    too late by construction.
    """
    if (lead is not None and getattr(lead, "source", None) == "measured"
            and int(getattr(lead, "observations", 0) or 0) > 0):
        try:
            return max(1, int(round(float(lead.days)))), LEAD_TIME_BASIS_MEASURED
        except (TypeError, ValueError):
            pass
    return LEAD_TIME_DAYS, LEAD_TIME_BASIS_DECLARED


def order_by_for(as_of: date, days_cover: float | None,
                 lead_time_days: int) -> str | None:
    """The calendar date the owner must order by, as a YYYY-MM-DD string.

    WHY THE ENGINE AND NOT THE SCREEN. Until this existed the card's "Order by"
    was arithmetic the browser did on `engine_days_cover` with a hard-coded
    seven, and the Purchasing row's was `utils/cover.js` with a lead of three
    on a 90-day average. Weber Ranch 1L, 19 October 2026: the card said Mon,
    Oct 19 and the row said Thu, Oct 22, for the same bottle on the same
    morning. Nothing stored the date, so nothing else - Purchasing, a digest,
    the effectiveness ledger - could show the one the card showed. Computed
    once, here, with the lead time the card actually quotes, and persisted,
    the two screens agree because they are reading one number.

    THE ARITHMETIC. `as_of + max(0, floor(days_cover - lead_time_days))`.
    Floor, not round: a deadline is the LAST safe day, and rounding 6.6 days of
    slack up to 7 names a day on which the shelf is already short. Never before
    `as_of`: a product already inside its lead window is due now, and a date in
    the past reads as either broken software or advice that arrived too late
    (the same rule `storeagent/functions/buying.py::_buy_row` applies).

    `days_cover` is in OPEN days (the engine's rate is per open day) and the
    result is a CALENDAR date, because a deadline is read off a wall calendar.
    For a store that closes some days this lands the date early rather than
    late, which is the safe side of a deadline to be wrong on. None when stock
    was unknown at decision time: with no cover figure there is no honest date,
    and an invented one is how a bottle nobody counted acquires a deadline.
    """
    if days_cover is None:
        return None
    due_in = max(0, floor(float(days_cover) - lead_time_days))
    return (as_of + timedelta(days=due_in)).isoformat()


#: Till mechanics that ring through `sale_items` as if they were products.
#:
#: Found live, not theorised: a first run of this selector put GIFT_C and the
#: SKU "2" at ranks 2 and 3 for Bethany. Gift cards and a discount code, told
#: to an owner as "order 46 more". They pass every statistical test in the
#: engine because they genuinely do sell and genuinely do fluctuate - the
#: engine has no way to know they are not merchandise.
#:
#: This is the belt. The braces is `orderable` below, which is strictly better
#: because it generalises across stores; the blocklist exists because the
#: product master is missing 43.8% of sold store-SKU pairs estate-wide, so
#: catalogue membership cannot be the ONLY filter without silently dropping
#: real products at the stores with the worst data.
REGISTER_MECHANICS = frozenset({
    "GIFT_C", "GIFTCARD", "GIFT CARD", "2", "22", "05", "10%DISCOUNT",
    "DISCOUNT", "NON_INVENTORY", "non_inventory", "CRV", "DEPOSIT",
})


def is_orderable_sku(sku: str, orderable: frozenset[str] | None) -> bool:
    """Could an owner actually place an order for this SKU?

    A recommendation to reorder something the store cannot buy is not a weak
    recommendation, it is a nonsensical one, and no amount of statistical
    strength behind it helps.

    NOT A MERCHANDISE TEST, despite being called `is_merchandise` until the
    categories policy landed. It screens SKU SHAPE and ORDERABILITY and knows
    nothing about what the product is - `candidates/merchandise.py` owns that, by
    name, price and POS category. Both run in the same selection and neither
    subsumes the other, which is why every call site had to alias one of them to
    keep them apart. An import alias is a comment that does not survive being
    moved, so the name says it instead.
    """
    key = sku.strip()
    if not key or key.upper() in {m.upper() for m in REGISTER_MECHANICS}:
        return False
    # A bare number is a till key, not a barcode. Real SKUs here are UPCs or
    # vendor codes; "2" and "22" are the discount and deposit keys.
    if key.isdigit() and len(key) <= 3:
        return False
    if orderable is not None and key not in orderable:
        return False
    return True


@dataclass(frozen=True, slots=True)
class Pick:
    """One chosen product and every figure behind the choice."""

    sku: str
    rank: int
    recent_units: float
    recent_rate: float
    long_run_rate: float
    reverted_rate: float
    uplift: float
    p_hit: float
    deficit_units: float
    dispersion_cv: float
    evidence_state: str
    why: str
    long_run_days_available: int
    #: "recovering" - quiet now, its own year says it comes back (sheet 20)
    #: "stockout"   - running out at the current pace, whichever way it trends
    family: str = "recovering"
    #: Open days of stock left at the corrected rate. None when stock is unknown.
    days_cover: float | None = None
    #: What one unit costs. None is a real absence - five of ten audited stores
    #: send no cost at all - and it must stay None rather than becoming 0.0, or
    #: the holding cost of being wrong reads as free.
    unit_cost: float | None = None
    #: Forward OPEN days the claim covers, projected from the trailing open-day
    #: rate. Never the calendar horizon: a store shut on Sundays does not get 30
    #: selling days in 30 days, and using the calendar figure overstates every
    #: rate by about 17% at the store where that was first measured.
    horizon_open_days: float | None = None
    #: The CATEGORY family (beer, wine, spirits...) named by the POS category,
    #: for the per-family obsolescence hazard. None when the store sends no
    #: category or it names no drink type; the holding-cost basis says which.
    category_family: str | None = None
    #: The raw POS category the family was read from, so the basis can tell
    #: "no category was supplied" from "the category names no drink type".
    pos_category: str | None = None


@dataclass(frozen=True, slots=True)
class Selection:
    """The picks, plus what the selector decided on the way to them.

    `choose()` returns only the picks and every existing caller keeps that.
    The live route needs two more things that have no home on a card: the
    retirements decided this morning (Node stores them - checklist 17) and the
    screen counts, which are what makes a short slate explicable.
    """

    picks: list[Pick]
    #: Claims retired THIS run. Empty when no card history arrived.
    retirements: tuple[CardRetirement, ...] = ()
    #: SKUs whose suppression was relaxed to meet the candidate-pool floor.
    #: Never silent: each is also counted in `screened`.
    relaxed: tuple[str, ...] = ()
    screened: dict[str, int] = field(default_factory=dict)


def daily_series(
    sales: Iterable[Any],
) -> tuple[dict[str, dict[date, float]], list[date]]:
    """Public name for `_daily`, for callers outside this module.

    The event playbook needs exactly this shape - {sku: {date: units}} plus the
    store's trading days - and re-deriving it elsewhere would give the playbook a
    different idea of which days the store was open from the one the selector
    uses, which is how two parts of one run come to disagree about a rate.
    """
    return _daily(sales)


def _daily(sales: Iterable[Any]) -> tuple[dict[str, dict[date, float]], list[date]]:
    """{sku: {date: units}} plus the store's trading days.

    A trading day is a day the store sold SOMETHING - which is the only
    definition available from sales alone. It is the same one the backtest
    uses, so the live path and the measured path count denominators alike.
    """
    by_sku: dict[str, dict[date, float]] = defaultdict(dict)
    days: set[date] = set()
    for row in sales:
        sku = (getattr(row, "sku", "") or "").strip()
        units = float(getattr(row, "units", 0) or 0)
        d = getattr(row, "sale_date", None)
        if not sku or units <= 0 or d is None:
            continue
        by_sku[sku][d] = by_sku[sku].get(d, 0.0) + units
        days.add(d)
    return dict(by_sku), sorted(days)


def _open_days(trading: list[date], start: date, end: date) -> int:
    """OPEN days in (start, end]. Never calendar days."""
    return sum(1 for d in trading if start < d <= end)


def _units(by_day: dict[date, float], start: date, end: date) -> float:
    return sum(u for d, u in by_day.items() if start < d <= end)


def _weekly_rates(by_day: dict[date, float], trading: list[date],
                  as_of: date) -> tuple[float, ...]:
    out: list[float] = []
    for k in range(STABILITY_WEEKS):
        b = as_of - timedelta(days=7 * k)
        a = as_of - timedelta(days=7 * (k + 1))
        n = _open_days(trading, a, b)
        if n:
            out.append(_units(by_day, a, b) / n)
    return tuple(out)


def choose(sales: Iterable[Any], **kwargs: Any) -> list[Pick]:
    """The engine's picks for one store, ranked. Pure function of the sales.

    The original entry point, kept for every caller and test that wants a
    list. `select` is the same decision with its audit attached; this is its
    `.picks`.
    """
    return select(sales, **kwargs).picks


def select(
    sales: Iterable[Any],
    *,
    client_id: int,
    location_id: int,
    as_of: date,
    limit: int,
    orderable: frozenset[str] | None = None,
    on_hand: dict[str, float] | None = None,
    unit_costs: dict[str, float] | None = None,
    overstocked: frozenset[str] | None = None,
    #: N5.1 - cards already issued for this store, newest irrelevant: what
    #: matters is when each SKU was FIRST shown and what has sold since.
    #:
    #: SUPPLIED, NEVER FETCHED - the same contract as `on_hand`. Python is
    #: stateless and holds no analytics credentials, so Node reads the
    #: `recommendations` table (which already carries `engine_daily_rate` from
    #: migration 022, the rate that justified each card) and hands the rows over.
    #: An empty tuple means "no memory available", which is today's behaviour and
    #: is why this is a reduction in repetition rather than a new failure mode.
    card_history: Sequence[CardHistory] = (),
    #: N5.1 - raw rows from Node's card-history feed, assembled here rather than
    #: by the caller: the second half of each record (units sold since, over how
    #: many OPEN days) is measured from the sales this function already holds, so
    #: assembling it anywhere else would need the series fetched twice and could
    #: disagree with the rate the card was built from.
    card_history_rows: Sequence[Any] = (),
    #: Product names, for the catalogue merchandise filter. Without them it falls
    #: back to SKU-shape screening only.
    product_names: dict[str, str] | None = None,
    unit_prices: dict[str, float] | None = None,
    #: The POS category AS THE TILL SENDS IT, per SKU, for the same screen. This
    #: is the one input that knows "LOTTO" is a lottery ticket and "1 LITER
    #: LIQUOR TAX" is a tax line; the name and price tests catch most of those
    #: but not all, and the measured path has screened on it since the +6.8
    #: point finding. The policy on what a category refuses lives in ONE place,
    #: `candidates/non_stock.py` - this only hands the string over.
    pos_categories: dict[str, str] | None = None,
    config=cfg,
    #: Checklist 16 - per-SKU delivery lead time with provenance
    #: (`RecommendationContext.lead_times`). Read ONLY by the stockout
    #: sentence; screening keeps the declared COVERAGE_DAYS, see the note at
    #: the constants. None means no vendor is known, and the sentence says the
    #: figure is declared. Trailing on purpose: every existing caller is
    #: unchanged.
    lead_times: dict[str, Any] | None = None,
) -> Selection:
    """The engine's picks for one store, ranked, with the decisions behind them.

    No model is called and no clock is read - `as_of` comes from the caller, so
    two runs over one snapshot produce the same list months apart.
    """
    by_sku, trading = _daily(sales)
    if not trading:
        log.warning("deterministic_no_trading_days", client_id=client_id,
                    location_id=location_id)
        return Selection(picks=[])

    ctx = RunContext(
        run_id=f"live-{client_id}-{location_id}-{as_of}",
        tenant_id=client_id, store_id=location_id, as_of=as_of,
        snapshot_id=f"snap-{as_of}", config_version="default", seed=0,
        versions={"temporal_reversion": "1.1.0"},
    )
    horizon = int(config.get(REVERSION_HORIZON_DAYS, ctx))
    floor = float(config.get(MATERIALITY_FLOOR_UNITS, ctx))

    # However much history actually arrived. Asking for 365 and being handed 90
    # is a weaker signal, not an error - but it must be VISIBLE as weaker.
    earliest = trading[0]
    long_span = min(LONG_RUN_WINDOW_DAYS, max(1, (as_of - earliest).days))

    recent_start = as_of - timedelta(days=BASELINE_WINDOW_DAYS)
    long_start = as_of - timedelta(days=long_span)
    recent_open = _open_days(trading, recent_start, as_of)
    long_open = _open_days(trading, long_start, as_of)
    # FORWARD open days, projected from the trailing open-day rate. The horizon is
    # in the future so its open days cannot be counted, only estimated - and the
    # store's own recent trading pattern is the only honest estimator available.
    # Labelled a projection on the card, because it is one.
    horizon_open = (horizon * recent_open / BASELINE_WINDOW_DAYS
                    if BASELINE_WINDOW_DAYS > 0 else None)
    if recent_open <= 0 or long_open <= 0:
        log.warning("deterministic_no_open_days", client_id=client_id,
                    location_id=location_id, recent=recent_open, long=long_open)
        return Selection(picks=[])

    # ── N5.1: REVIEW WHAT IS ALREADY UP, BEFORE ISSUING ANYTHING ───────────
    #
    # The engine had no memory. Stroyski 1.75L was recommended on EIGHT
    # consecutive trading days and missed every one, because each morning
    # recomputed the same depressed window with no idea it had already said this
    # or that the prediction was visibly failing.
    #
    # And retirement without SUPPRESSION does nothing: the next morning re-earns
    # the card from exactly the evidence just shown to be wrong. Suppression is
    # the only transition that makes the state machine terminate.
    #
    # Every count here is in OPEN days. A store shut on Sundays reaches its
    # day-7 review after EIGHT calendar days, and the rule must not fire early
    # because of that - which is why `open_index` is built from the trading
    # calendar rather than from date arithmetic.
    open_index = {d: i for i, d in enumerate(trading)}
    today_index = open_index.get(as_of, len(trading) - 1 if trading else 0)
    retirements: list[CardRetirement] = []
    suppressed: dict[str, int] = {}
    # THE SKU'S OWN SCATTER, AS OF THE DAY THE CARD WENT UP. The declining rule
    # is a tail probability under the SKU's count model, and the dispersion it
    # needs is the one the card's range was published under - the same weekly
    # bucketing `revert` uses, anchored at `first_issued` rather than today.
    # Fewer buckets than the reversion engine trusts is NOT MEASURED, and the
    # rule then says Poisson out loud rather than assuming the narrowest case.
    min_weeks = int(config.get(MIN_WEEKS_FOR_DISPERSION, ctx))

    def issue_time_dispersion(sku: str, issued: date) -> float | None:
        weekly = _weekly_rates(by_sku.get(sku, {}), trading, issued)
        return dispersion_cv(weekly) if len(weekly) >= min_weeks else None

    # Assemble the lifecycle feed if raw rows arrived. `card_history` passed
    # directly still wins, so the harness and every test keep their own path.
    if card_history_rows and not card_history:
        assembled, skipped = card_history_from_rows(
            card_history_rows, daily_by_sku=by_sku, trading_days=trading,
            as_of=as_of, dispersion_of=issue_time_dispersion)
        card_history = assembled
        log.info("card_history_assembled", client_id=client_id,
                 location_id=location_id, rows=len(card_history_rows),
                 usable=len(assembled), skipped=skipped)

    # ── A VERDICT IS MADE ONCE (checklist 17) ───────────────────────────────
    #
    # This used to set `retired_index = issued_index + open_days_since`, which
    # is TODAY, and then suppress until today + 14 - every morning, from a card
    # it re-judged every morning. So a suppression either rolled forever (the
    # rule kept firing on the same stale card) or ended the moment the rule
    # stopped firing. Neither is fourteen days.
    #
    # Now a retirement Node has STORED is honoured as written - the stored
    # date is compared against `as_of`, and the suppression is live while
    # today is before it - and the card is not re-judged. A fresh retirement
    # is decided only for a card with no stored verdict, or one issued AFTER
    # the stored verdict, which is a new claim.
    #
    # The index map below is what the SKU loop tests against; it is derived
    # from the date, never the other way round. A stored date beyond this
    # morning's calendar is the future, and `bisect_left` returns
    # len(trading) for it - greater than any today, which is correct. A
    # stored date ON OR BEFORE as_of is over, whether or not the store traded
    # on it, which is why the date comparison comes first.
    #
    # The trailing open-day density turns "fourteen open days" into the
    # calendar date that gets stored; see `suppression_end_date`.
    density = recent_open / BASELINE_WINDOW_DAYS
    suppression_ends: dict[str, date] = {}
    carried = 0
    voided = 0
    for history in card_history:
        if history.already_retired:
            carried += 1
            # A STORED RETIREMENT UNDER A RULE THAT COULD NOT APPLY IS VOID.
            #
            # The lifecycle used to judge every card by the recovery rules,
            # kind unseen, so a markdown was retired for "no recovery" - a
            # recovery it never predicted - and then suppressed. The rule is
            # fixed in `review_card`; this is the same correction applied to
            # verdicts already in the store, so the SKUs it hid come back
            # this morning by logic rather than by someone editing rows.
            # Only the two recovery rules, only for a discount card, and only
            # when the kind is KNOWN - None is an absence and keeps its
            # suppression.
            if (history.retirement_rule in RECOVERY_RULES
                    and history.action_type in DISCOUNT_ACTIONS):
                voided += 1
                log.info("retirement_voided_wrong_family",
                         client_id=client_id, location_id=location_id,
                         sku=history.sku, rule=history.retirement_rule,
                         action_type=history.action_type,
                         suppressed_until=str(history.suppressed_until))
                continue
            until = history.suppressed_until
            if until is not None and as_of < until:
                suppressed[history.sku] = max(
                    today_index + 1, bisect_left(trading, until))
                suppression_ends[history.sku] = until
            continue
        verdict = review_card(history, ctx, config)
        if not verdict.retire or verdict.rule is None:
            continue
        suppressed[history.sku] = suppressed_until(today_index, ctx, config)
        end_date = suppression_end_date(as_of, density, ctx, config)
        suppression_ends[history.sku] = end_date
        retirements.append(CardRetirement(
            sku=history.sku,
            retired_at=as_of,
            suppressed_until=end_date,
            rule=verdict.rule,
            reason=verdict.reason,
            first_issued=history.first_issued,
            open_days_since=history.open_days_since,
            recovery_ratio=verdict.recovery_ratio,
            tail_probability=verdict.tail_probability,
            distribution=verdict.distribution,
        ))
    if retirements or carried:
        log.info("deterministic_cards_retired", client_id=client_id,
                 location_id=location_id, retired=len(retirements),
                 carried_from_store=carried, voided_wrong_family=voided,
                 rules=sorted({r.rule for r in retirements}))

    scored: list[tuple[float, Pick]] = []
    screened: dict[str, int] = defaultdict(int)
    # ── THE CANDIDATE-POOL FLOOR (checklist 17) ─────────────────────────────
    #
    # A suppressed SKU is still SCORED, into `held_suppressed` rather than
    # `scored`, with its screen counts sent to a throwaway so the published
    # counts are byte-identical to the old skip. If the pool after suppression
    # falls below the floor, the nearest-to-expiry held cards are released
    # below - and counted. With a pool above the floor nothing here changes
    # what the route returns.
    held_lists: dict[str, list[tuple[float, Pick]]] = {}
    discard: dict[str, int] = defaultdict(int)

    for sku, by_day in by_sku.items():
        is_suppressed = today_index < suppressed.get(sku, -1)
        counter = discard if is_suppressed else screened
        sink: list[tuple[float, Pick]] = scored
        if is_suppressed:
            # Retired recently. The next claim must rest on different data, not
            # on the same data reconsidered. Counted here, on the way in, so a
            # suppressed SKU that would also have failed a later screen reads
            # as suppressed - exactly as it did when this was a bare `continue`.
            screened["suppressed_after_retirement"] += 1
            # Its own sink, registered BEFORE the screens so that a SKU which
            # fails one leaves an empty list rather than nothing. The body
            # below exits through `continue` at every screen and never
            # reaches a common tail, so this is the only place to hook it.
            sink = held_lists.setdefault(sku, [])
        # TWO SCREENS, AND THE SECOND IS NOT A REPLACEMENT FOR THE FIRST.
        #
        # `catalogue_verdict` is the audited catalogue contract: 45 of 44,398 SKUs
        # refused, 0.10%, after a first version that would have deleted real
        # stock - 1690 Absolut Mandrin, 417 E&J Brandy, Department 66 Grenache
        # which is a winery, and LYNX POLARIZED GROUNDING AD. caught by the word
        # "rounding". It screens on NAME and PRICE.
        #
        # `is_orderable_sku` is this route's own blocklist. It screens on SKU SHAPE
        # and orderability, and it catches register mechanics the catalogue filter
        # does not - a bare "2" or "22" is a discount or deposit key with a
        # perfectly ordinary-looking name. Keeping both is deliberate; dropping
        # either would let one class of non-product back in.
        verdict = catalogue_verdict(
            sku,
            (product_names or {}).get(sku),
            (unit_prices or {}).get(sku),
            ctx, config,
            pos_category=(pos_categories or {}).get(sku),
        )
        if not verdict.is_merchandise:
            # Two counters for one contract: a category refusal is the screen
            # this route ran without for its first month, so its count has to
            # be legible on its own rather than folded into the name/price one.
            if verdict.rule == "non_stock_category":
                counter["not_merchandise_category"] += 1
            else:
                counter["not_merchandise_catalogue"] += 1
            continue
        if not is_orderable_sku(sku, orderable):
            counter["not_merchandise_blocklist"] += 1
            continue
        pos_category = (pos_categories or {}).get(sku)
        family_key = category_family_of(pos_category)
        recent_units = _units(by_day, recent_start, as_of)
        if recent_units < floor:
            counter["below_materiality_floor"] += 1
            continue

        result = revert(
            ReversionRequest(
                sku=sku,
                recent_units=recent_units,
                recent_open_days=recent_open,
                long_run_units=_units(by_day, long_start, as_of),
                long_run_open_days=long_open,
                weekly_rates=_weekly_rates(by_day, trading, as_of),
                horizon_days=horizon,
            ),
            ctx, config,
        )
        if not result.ok or result.value is None:
            counter["reversion_failed"] += 1
            continue
        r = result.value

        unit_cost = None if not unit_costs else unit_costs.get(sku)
        unit_cost = unit_cost if (unit_cost and unit_cost > 0) else None
        # A MISSING KEY IS UNKNOWN, NOT ZERO. This read `.get(sku, 0.0)`, so a SKU
        # the stock feed never mentioned was indistinguishable from one it
        # reported as empty - and empty is a buy signal.
        _raw_stock = None if on_hand is None else on_hand.get(sku)
        have_units = None if _raw_stock is None else float(_raw_stock)
        # ── A NEGATIVE STOCK COUNT IS A BROKEN RECORD, NOT A SHORTFALL ─────
        #
        # Marshfield reports stock_qty < 0 on 3,657 of 11,393 SKUs, worst case
        # -91,647. Every arithmetic use of that figure is wrong, and not subtly:
        #
        #   need_units  = rate x COVERAGE_DAYS - have_units
        #   urgency     = (COVERAGE_DAYS - cover_days_left) / COVERAGE_DAYS
        #
        # Subtracting a negative INFLATES the order by the whole deficit - the
        # live card asking for 227 units of Margaritaville Gold was
        # rate x 14 + 224 - and a cover of -1,120 days scores an urgency of 81
        # against a maximum of 1, so the broken rows sort above every real
        # stockout in the store.
        #
        # NOT CLAMPED TO ZERO, which was the obvious fix and is worse. Zero means
        # "the shelf is empty", a positive claim: at Marshfield it would turn 32%
        # of the catalogue into stockout candidates at maximum urgency, and the
        # slate would be nothing but false alarms. A count below zero is evidence
        # the inventory record for that SKU cannot be trusted, so the honest
        # reading is that the level is UNKNOWN - exactly what `None` already means
        # here, and every downstream branch already handles it.
        #
        # The SKU is not dropped. It keeps its reversion path and can still earn a
        # card on sales evidence alone; it just makes no claim about stock.
        if have_units is not None and have_units < 0.0:
            counter["negative_stock_record"] += 1
            have_units = None
        cover_days_left = (
            None if (have_units is None or r.rate_per_open_day <= 0)
            else have_units / r.rate_per_open_day
        )

        # ── OVERSTOCK ────────────────────────────────────────────────────
        #
        # RUNS BEFORE THE ALREADY-COVERED GUARD, and that ordering is the whole
        # reason this family works. That guard skips anything holding two weeks
        # or more of stock - which is every overstock candidate by definition,
        # so with the check below it the family produced nothing at all and the
        # slate stayed 100% reorders.
        #
        # The mirror of the stockout card, and the other half of the question
        # an owner actually has. Sheet 20 asks what to buy; this asks what has
        # already been bought and is not moving.
        #
        # Ranked by CAPITAL TIED UP, not by how extreme the cover is: 400 days
        # of a $4 mixer is a curiosity, 120 days of a $60 bottle is money. The
        # card exists to free cash, so cash is what orders it.
        #
        # Needs a cost. Without one there is no capital figure and no claim -
        # the SKU is skipped rather than shown with a blank, which is the same
        # rule sheet 02 applies to every profit claim.
        # THE STORE'S OWN CLASSIFICATION HAS THE CASTING VOTE.
        #
        # Sheet 14 refuses a markdown whose SKU is not already flagged
        # overstock_mild or overstock_severe by the inventory view - three of
        # four cards from the first run were dropped as
        # price_cut_without_overstock. That check is right: a price cut is a
        # decision about money the store has already spent, and a second
        # opinion derived from a different window should not be the one that
        # triggers it. Ninety days of cover now NARROWS an existing verdict
        # rather than reaching its own.
        if (cover_days_left is not None and cover_days_left > OVERSTOCK_DAYS
                and unit_cost is not None
                and (overstocked is None or sku in overstocked)):
            capital = have_units * unit_cost
            if capital >= OVERSTOCK_MIN_CAPITAL_USD:
                sink.append((
                    500.0 + min(capital, 100000.0) / 1000.0,  # below stockouts
                    Pick(
                        sku=sku, rank=0, recent_units=recent_units,
                        recent_rate=r.recent_rate, long_run_rate=r.long_run_rate,
                        reverted_rate=r.rate_per_open_day, uplift=r.uplift,
                        p_hit=r.p_hit, deficit_units=have_units,
                        dispersion_cv=r.dispersion_cv,
                        evidence_state=result.provenance.evidence_state,
                        why=(f"About {cover_days_left:.0f} days of stock at the "
                             f"current rate - roughly "
                             f"{cover_days_left / 30:.0f} months. That is "
                             f"${capital:,.0f} tied up on the shelf."),
                        long_run_days_available=long_span,
                        family="overstock", days_cover=cover_days_left,
                        category_family=family_key, pos_category=pos_category,
                        unit_cost=(None if not unit_costs
                                   else unit_costs.get(sku)),
                        horizon_open_days=horizon_open,
                    ),
                ))
                continue

        # STOCK. Sheet 20 answers "will this sell more than it has been"; it
        # does not answer "do you need to buy any". Those are different
        # questions and only the second one is a reorder card.
        #
        # Found live: the first three picks on store 171 were all vetoed
        # downstream as `reorder_not_needed` - the shared demand engine said
        # current stock already covered them. The veto was right and the
        # engine was asking an incomplete question, so it now asks the whole
        # one rather than being corrected afterwards.
        #
        # Cover is measured in the SAME units as the deficit: what the store
        # will sell over the horizon at the corrected rate, minus what is on
        # the shelf. A SKU with more on hand than it can sell needs nothing.

        # `have_units`, not `on_hand`: a store CAN send a stock feed in which this
        # SKU's row is unusable, and comparing None against a float raises.
        if have_units is not None:
            have = have_units
            # Sheet 10's rule, not "a full horizon of stock".
            #
            # An order has to cover the LEAD TIME plus the wait until the next
            # chance to order - you are not buying 30 days of stock, you are
            # buying enough to reach the next delivery. Testing against the
            # whole horizon demanded a month of cover before it would suggest
            # anything, and screened out all 88 viable candidates at store 171.
            #
            # Both figures are declared, never measured: nothing in the
            # warehouse records when an order actually arrived
            # (`purchase_orders` has the right columns and zero rows), which is
            # why R3 of the independent review asks the pilot stores directly.
            cover_days = COVERAGE_DAYS
            need = r.rate_per_open_day * cover_days
            if have >= need:
                counter["already_covered"] += 1
                continue

        # ── STOCKOUT RISK ────────────────────────────────────────────────
        #
        # A SECOND QUESTION, and the one that was missing.
        #
        # Sheet 20 asks "is this quiet now but about to pick back up". For a
        # product selling twice its yearly rate the answer is no - it is hot
        # and will cool - so it was screened out as trailing_window_inflated.
        #
        # But that product had 48 on the shelf against 240 sold in 28 days:
        # FOUR DAYS of cover, against a seven-day lead time. It runs out before
        # the next delivery lands. It needs ordering, and not because it will
        # recover - because the shelf is nearly empty.
        #
        # Measured at store 171: of 120 products worth an owner's attention,
        # 109 held two weeks or more of stock and 11 were running low. All 11
        # were rejected - 8 as "heading down", 3 on confidence - so the screen
        # showed nothing while a top seller was four days from empty.
        #
        # This check runs BEFORE the reversion gate and is independent of it:
        # which way the trend points does not change whether you can sell from
        # an empty shelf.
        if cover_days_left is not None and cover_days_left < COVERAGE_DAYS:
            need_units = max(1.0, r.rate_per_open_day * COVERAGE_DAYS - have_units)
            # Urgency, not size: a product three days from empty outranks one
            # ten days out, whatever the margin. Running out is the loss.
            urgency = (COVERAGE_DAYS - cover_days_left) / COVERAGE_DAYS
            # The lead time the sentence quotes, with its provenance. This
            # used to print "A delivery takes 7 days." as a fact.
            delivery = delivery_clause(
                None if not lead_times else lead_times.get(sku))
            sink.append((
                1000.0 + urgency * 100.0,   # stockouts sort above recoveries
                Pick(
                    sku=sku, rank=0, recent_units=recent_units,
                    recent_rate=r.recent_rate, long_run_rate=r.long_run_rate,
                    reverted_rate=r.rate_per_open_day, uplift=r.uplift,
                    p_hit=r.p_hit, deficit_units=need_units,
                    dispersion_cv=r.dispersion_cv,
                    evidence_state=result.provenance.evidence_state,
                    # "About 0 days of stock left" is what an owner reads as
                    # a broken card. Already-empty and nearly-empty are
                    # different facts and they get different sentences.
                    why=(
                        f"Out of stock now, and it was selling "
                        f"{r.rate_per_open_day:.1f} a day. "
                        f"{delivery[0].upper()}{delivery[1:]}."
                        if cover_days_left < 1
                        else f"About {cover_days_left:.0f} days of stock left at "
                             f"the current rate, and {delivery}. It runs out "
                             f"before the next one lands."
                    ),
                    long_run_days_available=long_span,
                    family="stockout", days_cover=cover_days_left,
                    category_family=family_key, pos_category=pos_category,
                    unit_cost=(None if not unit_costs
                               else unit_costs.get(sku)),
                    horizon_open_days=horizon_open,
                ),
            ))
            continue

        if not is_recommendable(r, ctx, config):
            counter["trailing_window_inflated" if r.deficit_units <= 0
                    else "p_hit_below_floor"] += 1
            continue

        sink.append((
            r.p_hit * max(0.0, r.deficit_units),
            Pick(
                sku=sku, rank=0,
                recent_units=recent_units,
                recent_rate=r.recent_rate,
                long_run_rate=r.long_run_rate,
                reverted_rate=r.rate_per_open_day,
                uplift=r.uplift,
                p_hit=r.p_hit,
                deficit_units=r.deficit_units,
                dispersion_cv=r.dispersion_cv,
                evidence_state=result.provenance.evidence_state,
                why=r.explain(),
                long_run_days_available=long_span,
                family="recovering", days_cover=cover_days_left,
                category_family=family_key, pos_category=pos_category,
                unit_cost=(None if not unit_costs else unit_costs.get(sku)),
                horizon_open_days=horizon_open,
            ),
        ))

    # ── RELAX SUPPRESSION ONLY WHEN THE POOL WOULD OTHERWISE BE EMPTY ──────
    #
    # Nearest the END of its window first, by the suppression's end DATE then
    # by SKU, so the order is deterministic and so the card released is the
    # one whose trailing window has turned over most - the claim that rests on
    # the most DIFFERENT data from the one retired. Releasing the most recent
    # retirement first would re-show the card retired yesterday on yesterday's
    # evidence, which is the exact loop the lifecycle exists to break. The
    # date and not the index, because every date past this morning's calendar
    # maps to the same index and the order between them would be lost.
    #
    # Counted, never silent: `suppressed_after_retirement` is decremented and
    # `suppression_relaxed_for_pool_floor` incremented for each release, so the
    # two together still account for every suppressed SKU.
    min_pool = int(config.get(MIN_CANDIDATE_POOL, ctx))
    relaxed: list[str] = []
    held_suppressed = {sku: entries[0] for sku, entries in held_lists.items()
                       if entries}
    if held_suppressed and len(scored) < min_pool:
        for sku in sorted(held_suppressed,
                          key=lambda s: (suppression_ends[s], s)):
            if len(scored) >= min_pool:
                break
            scored.append(held_suppressed[sku])
            screened["suppressed_after_retirement"] -= 1
            screened["suppression_relaxed_for_pool_floor"] += 1
            relaxed.append(sku)
        log.warning("deterministic_pool_floor_relaxed", client_id=client_id,
                    location_id=location_id, floor=min_pool,
                    pool_before=len(scored) - len(relaxed),
                    relaxed=relaxed, still_held=len(held_suppressed) - len(relaxed))

    # Sheet 13's sort, tie-break included: scores collide, and without an
    # explicit one the order would be whatever order the dict happened to
    # iterate in - reproducible only by accident.
    scored.sort(key=lambda t: (-t[0], t[1].sku))
    # SHEET 13'S FAMILY CAP, and it is not decoration.
    #
    # Stockouts score above overstock by design - running out costs a sale
    # today, slow stock costs carry. But a single ranked list means the louder
    # family takes every slot: this store had more than ten stockouts, so the
    # first run after adding overstock showed ten reorders and not one
    # markdown. A store told one thing ten times has been told one thing.
    #
    # The cap BINDS ONLY WHERE THERE IS COMPETITION. Candidates of an
    # over-represented family are held back first; if the slate is still short
    # afterwards because nothing else qualifies, they are backfilled in score
    # order rather than leaving it half empty. A store with ten genuine
    # stockouts and no dead stock still gets ten reorders.
    cap = max(1, int(limit * FAMILY_CAP_SHARE))
    chosen: list[Pick] = []
    held: list[Pick] = []
    seen: dict[str, int] = defaultdict(int)

    # THE DISCOUNT GROUP GETS ITS PLACES FIRST, or it never gets them at all.
    #
    # Overstock scores about 500 against a stockout's thousands, by design - so
    # in a single pass down the score order the loop hits `limit` long before it
    # reaches one. The cap above cannot save it either: the cap is per LABEL and
    # the buy side spans several, so each stays under its own allowance while the
    # group takes every slot.
    #
    # Taken in score order within the group, so the biggest pile of dead capital
    # is the one that gets the place. Never the last slot (`limit - 1`): a
    # markdown with no measured uplift must not displace the single
    # best-returning card a store has.
    discount = [p for _, p in scored if p.family in DISCOUNT_FAMILIES]
    take = max(0, min(OVERSTOCK_SLOT_FLOOR, len(discount), limit - 1))
    for p in discount[:take]:
        seen[p.family] += 1
        chosen.append(p)
    reserved = {p.sku for p in chosen}

    for _, p in scored:
        if len(chosen) >= limit:
            break
        if p.sku in reserved:           # already placed by the reservation
            continue
        if seen[p.family] >= cap:
            held.append(p)
            continue
        seen[p.family] += 1
        chosen.append(p)
    for p in held:                      # backfill rather than under-fill
        if len(chosen) >= limit:
            break
        if p.sku in reserved:
            continue
        chosen.append(p)
    # Re-sorted so the slate still READS in score order: the reservation decides
    # which cards appear, never the order an owner meets them in.
    order = {p.sku: i for i, (_, p) in enumerate(scored)}
    chosen.sort(key=lambda p: order.get(p.sku, len(order)))

    # Rank is only knowable after the sort, so it is stamped here rather than
    # guessed during scoring.
    picks = [replace(p, rank=i) for i, p in enumerate(chosen, start=1)]

    log.info(
        "deterministic_selection",
        client_id=client_id, location_id=location_id, as_of=str(as_of),
        considered=len(by_sku), picked=len(picks),
        long_run_days=long_span, screened=dict(screened),
    )
    return Selection(picks=picks, retirements=tuple(retirements),
                     relaxed=tuple(relaxed), screened=dict(screened))


def _budget_sentences(portfolio: Any, budget_basis: str | None,
                      replacement: Any) -> list[str]:
    """What the owner is entitled to see about the budget, and disagree with.

    Two different sentences, because two different things are true. A MEASURED
    budget is the store's own replacement spend read off its own receipts, and
    saying "assumed" about it would invite an owner to dismiss their own number. A
    DECLARED one is a constant somebody chose, and saying anything else about it
    would be a lie.
    """
    shelf = (f"assumes room for {portfolio.shelf_budget_units:,.0f} units "
             f"(declared, not measured)")
    if budget_basis == "measured_replacement_cost" and replacement is not None:
        return [f"budget is your own replacement spend: {replacement.explain()}",
                shelf]
    return list(portfolio.assumptions())


def to_raw_recommendations(picks: list[Pick], *, as_of: date,
                           valid_days: int = 14,
                           client_id: int | None = None,
                           location_id: int | None = None,
                           gate_inputs: dict[str, Any] | None = None,
                           calibration_bundle: dict[str, Any] | None = None,
                           portfolio: Any = None,
                           budget_basis: str | None = None,
                           replacement: Any = None,
                           canonical_qty: dict[str, tuple[int, int]] | None = None,
                           lead_times: Mapping[str, Any] | None = None,
                           config: Any = cfg) -> list[dict]:
    """The picks in the shape the run assembler already consumes.

    Deliberately the SAME dict shape the model used to return, so everything
    downstream - validation, persistence, the day-grain archive, the interface
    - is unchanged. The only difference is who filled it in.

    `rationale` is sheet 20's own sentence. `confidence` is p_hit, which is
    ORDERED but not numerically calibrated (sheet 08 measured the previous
    engine at 0.48 stated against 0.23 actual), so it ranks cards and is not
    presented to an owner as a percentage.

    TWO FIGURES PROMOTED FROM THE HARNESS, BOTH ADDITIVE
        `expected_range_*`      the two-sided 90% predictive range. A point
                                estimate invites "you said 78 and I got 61, you
                                were wrong"; a range is a claim that can be KEPT,
                                and it is the claim the gate's coverage check
                                tests. Measured coverage is 90-97% at four of
                                five stores.
        `holding_cost_if_unsold` what being wrong costs, in money. Every card
                                until now stated an upside with no downside
                                beside it.

        Neither touches selection or ordering. `client_id` and `location_id` are
        optional so every existing caller keeps working and simply gets no range
        - the fields are ABSENT rather than null-filled, so a consumer can tell
        "not computed" from "computed and refused".

    THE GATE, FINALLY ON THE SERVING PATH
        `gate_inputs` is the store's measured gate inputs, computed offline by
        `scripts/_gate_inputs.py` and stored. Every card gains `gate_state` and
        `gate_reason`, and `gate_displayed` says whether this store has been shown
        to work. No card is DROPPED here - a store that fails gets SHADOW, so the
        cards are still computed, stored and scored against outcomes, and the
        reason travels with them. An engine that quietly returns nothing is
        indistinguishable from an engine that is broken.

        Passing nothing yields SHADOW with `no_gate_inputs`, because an unmeasured
        check is not a pass. The caller holds the rollout decision and can
        override, but has to do so explicitly.

    THE BUDGET THE SLATE WAS CHOSEN UNDER
        `portfolio` is the `PortfolioSlate` from `slate.compose`, and the fields
        it adds are a DISCLOSURE rather than a decision - the choosing already
        happened, and nothing here can change which cards arrived.

        It is on every card rather than once per run because a card is the unit
        that travels: one gets voted on, screenshotted, forwarded, and read six
        weeks later with no run envelope attached. A card that says to commit
        $340 of a $2,000 assumed budget can be argued with. The same card with
        the budget recorded somewhere else cannot.

        Absent, not null-filled, when nothing could be priced - which is a real
        state at a store whose POS sends no cost. There is no budget to honour
        there, and claiming one was honoured would be the worst of the three.

    THE DEADLINE, AND THE LEAD TIME IT RESTS ON
        Every buy card (stockout, recovering) carries `lead_time_days` and
        `lead_time_basis` - the per-vendor measured figure when `lead_times`
        has a measured row for the SKU, the declared seven otherwise, which is
        exactly what the stockout sentence quotes - and, where stock was known,
        `order_by`: `as_of + max(0, floor(days_cover - lead_time_days))` as a
        calendar date string. See `order_by_for` for why this moved out of the
        browser. A markdown card carries none of the three: there is nothing to
        order, so there is no day to order it by.

        Additive like everything above it. No selection or ordering reads any
        of them.
    """
    through = (as_of + timedelta(days=valid_days)).isoformat()
    decision: ServingDecision = serving_decision(gate_inputs)

    # SHEET 08. The fitted curve, deserialised once per run rather than per card.
    # None is the normal case until a curve has been fitted, and `apply` then runs
    # the identity transform - which is what the engine did for months.
    #
    # Measured on the first 56 pooled production outcomes: the raw score states
    # 0.85-0.97 and the curve maps all of those to about 0.65. An owner reading
    # 0.95 was reading a number right about two thirds of the time.
    curve = None
    if calibration_bundle:
        try:
            curve = bundle_from_dict(calibration_bundle.get("bundle")
                                     or calibration_bundle)
        except (KeyError, TypeError, ValueError) as exc:
            # A malformed bundle must not sink a run. Identity is the safe
            # fallback and the card keeps its existing disclaimer.
            log.warning("calibration_bundle_unreadable",
                        client_id=client_id, location_id=location_id,
                        error=str(exc))
            curve = None
    # The registry needs a context to resolve a setting against. Built here from
    # the same identifiers `choose` uses, so a range published on a card resolves
    # the same settings the decision did.
    ctx: RunContext | None = None
    if client_id is not None and location_id is not None:
        ctx = RunContext(
            run_id=f"live-card-{client_id}-{location_id}-{as_of}",
            tenant_id=client_id, store_id=location_id, as_of=as_of,
            snapshot_id=f"snap-{as_of}", config_version="default", seed=0,
            versions={"predictive_interval": "1.0.0", "holding": "1.0.0"},
        )
    # THE BUDGET, RESOLVED ONCE. Identical on every card of a run, because it is
    # a property of the slate and not of any card in it.
    budget: dict[str, Any] = {}
    if portfolio is not None:
        budget = {
            "portfolio_cash_committed": round(portfolio.cash_committed, 2),
            "portfolio_cash_budget": portfolio.cash_budget,
            "portfolio_units_committed": round(portfolio.units_committed, 2),
            "portfolio_shelf_budget_units": portfolio.shelf_budget_units,
            "portfolio_coverage": portfolio.coverage,
            "portfolio_offered": portfolio.offered,
            # WHERE THE BUDGET CAME FROM. The assumptions sentence used to say
            # "declared, not measured" unconditionally, which stopped being true
            # the moment the budget could be measured from the store's own
            # receipts - and a card that says "assumed" about a measured figure
            # invites an owner to dismiss a number that is actually theirs.
            "portfolio_cash_budget_basis": budget_basis or "declared_default",
            "portfolio_assumptions": _budget_sentences(
                portfolio, budget_basis, replacement),
        }

    out: list[dict] = []
    for p in picks:
        # THE QUANTITY THE OWNER IS ASKED TO BUY.
        #
        # The canonical figure where the shared demand engine has one, because
        # `validator._enforce_quantity` overwrites the hint and
        # `suggested_order_qty` with it a moment later. Pricing the deficit here
        # meant `holding_cost_if_unsold` described a different purchase from the
        # one the card asks for: Marshfield, 6 October 2026, published $79.26 of
        # downside for an order worth $66, because the deficit said 227 units and
        # the card said 8.
        #
        # The deficit remains the quantity the DECISION was taken on and is
        # untouched - it is still what `deficit_units` reports and what the
        # expected value is measured on. This is only about what the owner pays.
        canonical = (canonical_qty or {}).get(p.sku)
        qty = (int(canonical[0]) if canonical and canonical[0] > 0
               else max(1, int(round(p.deficit_units))))
        # SAY "UNITS", and it is not decoration.
        #
        # `validator._enforce_quantity` keeps the one-number rule by checking that
        # the canonical figure is quoted IN UNITS - "19" on its own is how an
        # owner comes to order nineteen CASES. A hint that does not quote it is
        # rebuilt from a template, and the rebuild replaces the whole string.
        #
        # These three lines did not carry the word, so every buy card at every
        # store with a canonical quantity was rebuilt - and the rebuild deleted
        # the predictive range appended below, which is the one claim on the card
        # that can be held to. Measured on the last live run: 26 of 31 reorder
        # cards lost it. The five that kept it were at the one store the
        # warehouse bridge does not cover, which is exactly backwards.
        if p.family == "stockout":
            hint = f"about {qty} units to cover the next {COVERAGE_DAYS} days"
        elif p.family == "overstock":
            # Not a buy card, so the rule does not apply - but a bare number is
            # just as ambiguous to a reader here.
            hint = (f"{int(round(p.deficit_units))} units on the shelf, "
                    f"moving slowly")
        else:
            hint = f"about {qty} units more than the last four weeks imply"

        # THE RANGE. Only when a context is supplied, because the interval is a
        # registry-configured calculation and a silent default would publish a
        # claim nobody chose the coverage for.
        extra: dict[str, Any] = {}
        if ctx is not None:
            band = predictive_interval(
                rate=p.reverted_rate,
                horizon_open_days=p.horizon_open_days,
                dispersion_cv=p.dispersion_cv,
                ctx=ctx, config=config,
            )
            if isinstance(band, PredictiveInterval):
                extra["expected_range_low"] = band.low
                extra["expected_range_high"] = band.high
                extra["expected_range_coverage"] = band.nominal_coverage
                extra["expected_range_basis"] = (
                    f"{band.distribution} on {p.horizon_open_days:.0f} projected "
                    f"open days"
                )
                # NAME THE WINDOW. A stockout card's quantity covers
                # COVERAGE_DAYS while this range spans the reversion horizon, so
                # an unlabelled range put two different horizons in one sentence
                # and read as a contradiction.
                hint = (f"{hint}. Over the next {band.mean / p.reverted_rate:.0f} "
                        f"selling days total sales should land between {band.low} "
                        f"and {band.high} units "
                        f"{band.nominal_coverage * 100:.0f}% of the time")
            else:
                # A named refusal, carried. "No range" and "range we declined to
                # state, because X" are different facts to a reader.
                extra["expected_range_refused"] = band.basis

            # N1.1 - THE PROMISE, in the only form the arithmetic permits.
            #
            # A floor on the TOTAL, not on the increment. The increment form is
            # refuted: a low quantile of a count sits far below its mean, and the
            # uplift needed to clear the baseline rises with dispersion faster
            # than the engine's candidates supply it - 0 of 513 measured cards.
            # `promise_floor.py` carries the arithmetic.
            #
            # This form holds 95.5% of the time across the same 513 cards, and
            # it is positive and checkable against a till.
            floor = promise_floor(
                rate=p.reverted_rate, horizon_open_days=p.horizon_open_days,
                dispersion_cv=p.dispersion_cv, ctx=ctx, config=config,
            )
            if isinstance(floor, PromiseFloor):
                extra["promise_floor_units"] = floor.units
                extra["promise_floor_coverage"] = floor.coverage
                extra["promise_floor_basis"] = "low_end_of_published_interval"
            else:
                extra["promise_floor_refused"] = floor.basis

            # And WHY no increase is promised, with a figure in it. "Not
            # implemented" sends a reader looking for a fit that does not exist;
            # "needs a 4.3x lift at cv 0.60 and has 1.67x" is checkable.
            extra["increment_promise_basis"] = increment_promise_basis(
                rate=p.reverted_rate, horizon_open_days=p.horizon_open_days,
                dispersion_cv=p.dispersion_cv, baseline_rate=p.recent_rate,
                uplift=p.uplift, ctx=ctx, config=config,
            )

            # WHAT BEING WRONG COSTS. An overstock card is not buying anything,
            # so there is no unsold surplus to carry - a number here would be
            # read as a cost of following advice that says to STOP owning stock.
            if p.family != "overstock":
                # The obsolescence hazard is per CATEGORY FAMILY, and the
                # family comes from the POS category now that the route carries
                # one. A SKU whose category names no drink type falls back to
                # the default rate, and the basis says which happened.
                family_key = p.category_family
                held = holding_cost(
                    float(qty), p.unit_cost, COVERAGE_DAYS, ctx, config=config,
                    category_family=family_key,
                )
                if held is not None:
                    extra["holding_cost_if_unsold"] = round(held.total, 2)
                    if family_key:
                        why_rate = f"{family_key} rate, from the POS category"
                    elif p.pos_category:
                        why_rate = ("DEFAULT rate; the POS category "
                                    f"{p.pos_category!r} names no drink family")
                    else:
                        why_rate = ("DEFAULT rate; no POS category was "
                                    "supplied for this SKU")
                    extra["holding_cost_basis"] = (
                        "capital + shelf + a one-off obsolescence hazard at the "
                        + why_rate
                    )

        # THE DAY TO ORDER BY, on every card that asks for an order. Not on a
        # markdown: an "order by" on the card that says you own too many would
        # be read as a date to buy more. The lead time travels with the date so
        # a reader can see what the date rests on, and the basis says whether
        # that figure was measured from this vendor's receipts or declared.
        if p.family != "overstock":
            lead_days, lead_basis = lead_time_for(
                None if not lead_times else lead_times.get(p.sku))
            extra["lead_time_days"] = lead_days
            extra["lead_time_basis"] = lead_basis
            due = order_by_for(as_of, p.days_cover, lead_days)
            if due is not None:
                extra["order_by"] = due

        # Per card, because the fallback chain is keyed on the family.
        raw_confidence = min(0.99, max(0.01, p.p_hit))
        calibrated_value, calibrated_basis = raw_confidence, "raw_ranking_score"
        if curve is not None and ctx is not None:
            applied = apply_calibration(
                ApplyRequest(raw_confidence=raw_confidence,
                             family=("markdown" if p.family == "overstock"
                                     else "reorder"),
                             demand_class=CALIBRATION_ANY, bundle=curve,
                             velocity_band=CALIBRATION_ANY),
                ctx, config,
            ).value
            calibrated_value = applied.value
            # NOT just the transform name. "isotonic" on a curve with one level
            # tells a reader the figure was calibrated and hides that it is the
            # same figure on every card in the run.
            #
            # And not the transform name at all when the transform was the
            # IDENTITY: a bundle with no fit for this card's cell returns the
            # raw score untouched, and "identity_constant" would tell a reader
            # the figure was calibrated to a constant when it was not calibrated
            # to anything. The value on the card is the raw ranking score, so
            # the label is the raw ranking score's - one of the closed set in
            # app/schemas/recommendation.py.
            if not applied.was_calibrated:
                calibrated_basis = "raw_ranking_score"
            else:
                calibrated_basis = (
                    applied.transform if applied.discriminates
                    else f"{applied.transform}_constant")
            # The CURVE's resolution. A run-level pass below decides whether the
            # figure actually separates the cards in THIS slate, which is the
            # question a reader is asking.
            extra["confidence_levels"] = applied.levels
            extra["confidence_discriminates"] = applied.discriminates
            extra["confidence_explain"] = applied.explain()

        out.append({
            "rank": p.rank,
            # The vocabulary the validator enforces, not a plausible-looking
            # word. "inventory" is not one of CATEGORIES and every card was
            # dropped as an enum_violation on the first live run.
            "category": ("inventory_overstock" if p.family == "overstock"
                         else "inventory_understock"),
            "action_type": "markdown" if p.family == "overstock" else "reorder",
            "primary_skus": [p.sku],
            "quantity_hint": hint,
            "rationale": p.why,
            # No external signal was consulted. Saying so is the honest answer;
            # citing one the engine did not read is how a card acquires a
            # reason nobody can check.
            "signals_cited": [],
            # CALIBRATED where a curve exists, raw where none does - and the
            # card says which, because "0.65" means a different thing in each
            # case. The ORDERING is untouched either way: `calibrated` below is
            # for display only, and expected value never reads a confidence (a
            # build guard enforces that).
            "confidence": round(min(0.99, max(0.01, calibrated_value)), 3),
            "confidence_basis": calibrated_basis,
            "confidence_raw": round(min(0.99, max(0.01, p.p_hit)), 3),
            "valid_through": through,
            # An ORDER quantity, so null on a markdown: you are not buying
            # this, you are trying to stop owning it. A number here would be
            # read as "order 61 more" on the card that says you have too many.
            "suggested_order_qty": None if p.family == "overstock" else qty,
            # The figures the DECISION was taken on. Carried so the card can
            # state them instead of deriving a rival answer from the Buying
            # screen's 90-day average - which, for a product whose sales have
            # just collapsed, is a different and worse number.
            "engine_daily_rate": round(p.reverted_rate, 4),
            "engine_days_cover": (None if p.days_cover is None
                                  else round(p.days_cover, 2)),
            "engine_on_hand": (None if p.days_cover is None
                               else round(p.days_cover * p.reverted_rate, 2)),
            # WHICH FAMILY MADE THIS CARD. Stockout and recovering cards both
            # travel as category 'inventory_understock' / action 'reorder', so
            # nothing downstream could tell "it runs out before the next
            # delivery" from "it is selling below its long run". The stockout
            # claim is graded differently (sell-through before inflow, not
            # lift), and the grader has to know which card it is holding.
            "engine_family": p.family,
            # THE GATE'S ANSWER, on every card. `displayed` is False until a
            # store has been MEASURED to work, and the reason is always carried -
            # "not shown" with no reason is the kind of refusal nobody can act on.
            "gate_state": str(decision.state),
            "gate_reason": decision.reason,
            "gate_displayed": decision.displayed,
            # HONOUR `gate_displayed` ONLY WHERE THIS IS TRUE. False means no
            # verdict was computed for this store, which is an absence and not an
            # instruction to withhold. A consumer that treats an unmeasured store
            # as a failing one withholds every card at every store the moment it
            # starts reading the flag, which is how a rollout goes dark.
            "gate_measured": decision.measured,
            # The range and the downside, present only when they were computed.
            # Spread LAST so a future key collision is a visible test failure
            # rather than a silently overwritten decision figure.
            **extra,
            **budget,
        })

    # ── DOES THE FIGURE SEPARATE THESE CARDS AT ALL? ───────────────────────
    #
    # A curve-level test was not enough, and run 294 is why. Bethany's bundle has
    # FOUR levels - so `applied.discriminates` was True - and eight of nine cards
    # still displayed 0.444, because every raw score from 0.161 to 0.515 fell
    # inside one step of it.
    #
    # The reader's question is not "could this curve ever return something else".
    # It is "does this number tell this card apart from the one below it", and only
    # the finished slate answers that. So the flag is corrected here, where every
    # card is known, rather than per card where it cannot be.
    #
    # The VALUE is untouched: it is the store's measured rate and the best figure
    # available. What changes is the claim made about it.
    # Only rows a CURVE priced (confidence_levels > 0) take part. A row the
    # identity transform passed through carries the raw score under the
    # raw_ranking_score label, and "raw_ranking_score_flat_slate" is not a
    # claim this vocabulary makes - the raw score's failure to separate cards is
    # a different finding, measured in audit/calibration/, not a slate event.
    priced = [row for row in out if row.get("confidence_levels")]
    shown = {row["confidence"] for row in priced}
    # Two or more priced cards on one value. A single priced card is not a flat
    # slate; it is one card, and "does not tell them apart" needs a them.
    if len(priced) > 1 and len(shown) == 1:
        only = next(iter(shown))
        for row in priced:
            row["confidence_discriminates"] = False
            row["confidence_basis"] = f"{row['confidence_basis']}_flat_slate"
            row["confidence_explain"] = (
                f"{only:.0%} is how often this kind of recommendation has worked "
                f"at this store overall. Every card in today's slate scores the "
                f"same, so this figure does not tell them apart."
            )
    return out


__all__ = [
    "BASELINE_WINDOW_DAYS",
    "daily_series",
    "LONG_RUN_WINDOW_DAYS",
    "OVERSTOCK_DAYS",
    "REGISTER_MECHANICS",
    "Pick",
    "Selection",
    "is_orderable_sku",
    "choose",
    "lead_time_for",
    "order_by_for",
    "select",
    "to_raw_recommendations",
]
