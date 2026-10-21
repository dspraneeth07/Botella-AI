"""One slate, one budget, and the end of handing out slots by subtraction.

THE DEFECT THIS REMOVES
    The live route sized the stock families by arithmetic:

        limit = max_recommendations - len(extra)

    So how many reorder cards a store received depended on how many signal-family
    cards happened to exist that morning. A heat advisory did not make the slate
    better, it made it one reorder shorter, and nothing recorded the trade. The
    slate was a fixed ten slots divided by subtraction, and `rank/portfolio.py`
    had nothing to allocate because the allocation had already happened.

    After this, `max_recommendations` is a CEILING on the owner's attention and
    no longer a quota to fill. The number of cards is a consequence of the cash
    and shelf the store has, which is the only quantity that was ever scarce.

WHAT THE MEASUREMENT SAID, BEFORE ANY OF THIS WAS WIRED
    The module's premise - "an owner with $2,000 of free cash receives $8,000 of
    advice" - is no longer true of the five audited stores, and the honest reason
    is that something else already fixed it. Measured over 117 real decision
    dates:

        cost x DEFICIT (what ships today)        $231-$910 asked, median
        cost x TOTAL DEMAND (what shipped before) $7,614-$21,326 asked, median

    The $8,000 is real and belongs to the ungated ordering. Sheet 20's deficit
    gating collapsed the ask by a factor of twenty, because a deficit is a GAP
    and not a total. So on the current engine:

        the cash budget binds on       3 of 117 decision dates
        the abstention floor binds on  0 of 811 cards

    AND THE ORDERING CLAIM DOES NOT REPLICATE ON MONEY. Greedy-on-ratio against
    the score order it replaces, both truncated at the same ceiling, over four
    budgets and five stores: the deltas scatter (-$277 to +$398) with no sign
    pattern, and at the declared $2,000 four of five stores are exactly $0.

    What IS systematic is coverage: at a $250 ceiling, ratio order fits 22% to
    73% MORE cards into the same cash (Bethany 74 -> 90, Mango Jo's 101 -> 147).
    More value per dollar is more cards per dollar, which is the knapsack result
    behaving exactly as advertised.

SO WHAT IS THIS FOR
    Not accuracy, and the figures above are why it must not be sold as accuracy.
    It is a correctness guarantee about WHO CHOOSES. Today a store that cannot
    afford the whole slate picks a subset by affordability, which silently
    overrides the engine's ranking on a criterion nobody recorded. After this the
    engine states what it asks for, states the budget it assumed, and when the
    ask exceeds that budget it chooses by expected net margin per dollar instead
    of leaving the choice to whoever reads the page.

WHAT IS DELIBERATELY NOT PRICED
    `portfolio.py` prices a PURCHASE: p x units x margin, less the cost of
    holding stock that does not sell. Three card families are not purchases and
    are not valued by it:

        markdown    a disposal at a CUT price. Its worth is freed capital minus
                    the margin given up, which this formula does not compute.
                    Valuing it at full unit margin would put every markdown at
                    the top of the slate on a number that is simply wrong.
        bundle      two products, and its worth is not one SKU's 30-day run -
                    families.py already says so.
        stock_new   the store has never sold it, so it has no rate to project.

    These are UNPRICED, not refused. An unpriced card has not failed the
    abstention test, because the abstention test is about negative expectation
    and nobody computed an expectation for it. They keep their existing order and
    their existing family protection, and they spend no cash they cannot state.

    This matters in production, not in theory: run as a filter, the portfolio
    dropped 5 of Mango Jo's 229 cards purely because the POS sent no unit cost
    for those SKUs. A data-availability filter wearing a profitability argument
    is exactly the thing this file exists to prevent.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Sequence

from app.logging_config import get_logger
from app.pipeline.context import RunContext
from app.pipeline.policy.holding import holding_cost
from app.pipeline.policy.replacement import ReplacementCost, replacement_cost
from app.pipeline.rank.portfolio import (
    PortfolioCandidate,
    PortfolioSlate,
    choose_portfolio,
)
from app.pipeline.registry import Setting, cfg
from app.recommender.deterministic import (
    BASELINE_WINDOW_DAYS,
    COVERAGE_DAYS,
    Pick,
)
from app.recommender.families import ExtraPick

log = get_logger(__name__)

#: Families whose value is not a purchase, so `expected_net` would be a wrong
#: number rather than an unknown one. See the module docstring.
#:
#: `Pick.family` is one of recovering / stockout / overstock, so only `overstock`
#: can match here today; the other names are the signal families' own, carried so
#: that one list answers the question for every card shape rather than two lists
#: answering it for half each.
UNPRICED_FAMILIES = frozenset({"markdown", "overstock", "bundle", "stock_new"})

UNPRICED_SLATE_FLOOR = Setting(
    name="slate.unpriced_floor",
    default=2,
    unit="slate places held for unpriced families when any are offered",
    owner="commercial",
    why="PROVISIONAL, and an attention-allocation policy rather than a scoring "
        "change. The composer orders priced cards first and then truncates the "
        "whole slate to the attention ceiling, so whenever the budget affords "
        "more priced cards than the ceiling admits, every markdown, bundle and "
        "new-arrival card is cut - measured estate-wide over fourteen days, "
        "reorder is 78.4% of cards issued (1,009 of 1,284) while markdown (173) "
        "and bundle (99) exist and are simply never reached at a ceiling of 8. "
        "The old comment claimed neither group could crowd the other out; that "
        "holds only when the budget binds before the ceiling does, which at "
        "these stores it does not. "
        "TWO AND NOT MORE: the unpriced families carry no unit margin, so every "
        "place held back from the priced ranking has an expected-margin cost "
        "that nothing offsets. Two of eight is the smallest reservation that "
        "guarantees an owner sees that the engine does more than reorder. "
        "Set to 0 to restore the previous behaviour exactly. It becomes MEASURED "
        "when the acceptance rate of an unpriced card is known well enough to "
        "compare against the margin given up",
    status="PROVISIONAL",
)

MIN_ORDER_UNITS = Setting(
    name="slate.min_order_units",
    default=1.0,
    unit="units a card must commit before the budget can charge it anything",
    owner="commercial",
    why="a card that says to order something orders at least one of it. The "
        "deficit is a real number and rounds below 1 for a slow product, and "
        "charging the budget $0 for a card the owner will actually pay for "
        "would let an unbounded number of them through a finite budget. Same "
        "floor the live route already rounds the quantity hint to, lifted here "
        "so one constant feeds both. MEASURED in the only sense that applies to "
        "a unit of account: you cannot order two thirds of a bottle",
    status="MEASURED",
)


@dataclass(frozen=True, slots=True)
class Money:
    """What the POS knows about one product's price and cost.

    Both or neither is the useful case: a margin needs the pair. `cost` is None
    when the POS sends none, which is 78 of 94 trading stores on the inventory
    feed, and it must stay None - a cost of zero is a free product.
    """

    unit_price: float | None = None
    unit_cost: float | None = None

    @property
    def unit_margin(self) -> float | None:
        """price - cost, and only where both are real and the sign is sane.

        The SAME rule the backtest has used for every money figure in the audit
        (`0 < cost < price`), lifted rather than restated: a cost above the price
        is a broken field and not a loss-making product, and a margin derived
        from one would be a negative number presented as evidence.
        """
        price, cost = self.unit_price, self.unit_cost
        if price is None or cost is None:
            return None
        if not 0.0 < cost < price:
            return None
        return price - cost


@dataclass(frozen=True, slots=True)
class SlateDecision:
    """The chosen slate, in order, with what was not chosen and why."""

    #: Stock picks that survived, in the order they are to be shown.
    picks: tuple[Pick, ...]
    #: Signal-family cards that survived, in their existing order.
    extra: tuple[ExtraPick, ...]
    #: The cash decision. None when nothing could be priced at all, which is a
    #: real state at a store whose POS sends no cost: there is no budget to
    #: allocate, so there is no portfolio and the slate says so rather than
    #: pretending a budget was honoured.
    portfolio: PortfolioSlate | None
    #: (sku, reason) for everything offered and not shown. Carried, never
    #: dropped - "considered and here is why not" is the difference between a
    #: decision and a truncation.
    withheld: tuple[tuple[str, str], ...] = ()
    #: How many candidates could not be valued, so a reader can tell a slate the
    #: budget shaped from one it merely passed through.
    unpriced: int = 0
    #: The MEASURED replacement cost, where it could be measured. None means the
    #: budget is the declared default, and the card says so in words rather than
    #: presenting a guess as a measurement.
    replacement: ReplacementCost | None = None

    @property
    def budget_basis(self) -> str:
        if self.replacement is not None and self.replacement.ok:
            return "measured_replacement_cost"
        if self.replacement is not None:
            return f"declared_default:{self.replacement.basis}"
        return "declared_default"


    @property
    def total_cards(self) -> int:
        return len(self.picks) + len(self.extra)

    @property
    def abstained(self) -> bool:
        """Nothing worth doing today. An ANSWER, never an error."""
        return self.total_cards == 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "cards": self.total_cards,
            "stock_cards": len(self.picks),
            "signal_cards": len(self.extra),
            "unpriced": self.unpriced,
            "abstained": self.abstained,
            "withheld": [{"sku": s, "reason": r} for s, r in self.withheld],
            "portfolio": (None if self.portfolio is None
                          else self.portfolio.as_dict()),
            "budget_basis": self.budget_basis,
            "replacement": (None if self.replacement is None
                            else self.replacement.as_dict()),
        }


def order_units(
    pick: Pick,
    ctx: RunContext,
    config: Any = cfg,
    *,
    canonical_qty: dict[str, tuple[int, int]] | None = None,
) -> float:
    """What the owner is ASKED TO BUY on this card, in units.

    THE CANONICAL FIGURE WINS WHERE THERE IS ONE, and that is not a preference -
    it is the only quantity the owner ever sees. `validator._enforce_quantity`
    overwrites `suggested_order_qty` and the hint with the shared demand engine's
    number (the same one the Buying tab prints) AFTER this card is built, so
    pricing the deficit prices a purchase nobody is asked to make.

    Measured on Marshfield, 6 October 2026: the deficit said 227 units and the
    canonical figure said 8. Charging the budget $1,872.75 instead of $66
    collapsed a ten-card slate to one.

    Falls back to the deficit when the warehouse bridge is unavailable or the SKU
    has no canonical row - which is the figure the card then states, so the two
    still agree. A canonical ZERO is not used: the validator drops that card as
    false urgency, and pricing it at nothing would rank it above every card that
    costs something on its way out.
    """
    canonical = (canonical_qty or {}).get(pick.sku)
    if canonical is not None and canonical[0] > 0:
        return float(canonical[0])
    floor = float(config.get(MIN_ORDER_UNITS, ctx))
    return max(floor, float(round(pick.deficit_units)))


def candidate_for(
    pick: Pick,
    money: Money,
    ctx: RunContext,
    config: Any = cfg,
    *,
    canonical_qty: dict[str, tuple[int, int]] | None = None,
) -> PortfolioCandidate | None:
    """Price one stock pick for the budget, or None when it cannot be priced.

    None is an ABSENCE of a valuation and never a refusal - see the module
    docstring on why the two must not be collapsed.
    """
    if pick.family in UNPRICED_FAMILIES:
        return None
    margin = money.unit_margin
    if margin is None:
        return None
    units = order_units(pick, ctx, config, canonical_qty=canonical_qty)
    # The downside, from the same module the card publishes it from, so the
    # number the budget reasons about and the number the owner reads are one
    # number. None when there is no cost - and there is a cost here, because a
    # margin needed one.
    held = holding_cost(units, money.unit_cost, COVERAGE_DAYS, ctx, config)
    return PortfolioCandidate(
        sku=pick.sku,
        family=pick.family,
        units_at_stake=max(0.0, pick.deficit_units),
        unit_margin=margin,
        # p_hit, clamped the way the card clamps it. NOT the calibrated display
        # figure: a build guard forbids expected value reading a confidence that
        # has been through the display curve, and the two must not be confused.
        calibrated_confidence=min(1.0, max(0.0, pick.p_hit)),
        holding_cost_if_unsold=(None if held is None else held.total),
        cash_required=units * float(money.unit_cost or 0.0),
        units_required=units,
    )


def compose(
    picks: Sequence[Pick],
    extra: Sequence[ExtraPick],
    *,
    money: dict[str, Money],
    client_id: int,
    location_id: int,
    as_of: date,
    limit: int,
    cash_budget: float | None = None,
    shelf_budget_units: float | None = None,
    #: {sku: (order_qty, coverage_days)} from the shared demand engine. The
    #: quantity the OWNER is asked to buy, so it is the quantity the budget is
    #: charged for. Empty when the warehouse bridge is unavailable, which falls
    #: back to the deficit - the figure the card then states.
    canonical_qty: dict[str, tuple[int, int]] | None = None,
    #: The store's own sales rows, for MEASURING the cash budget rather than
    #: declaring it. See `policy/replacement.py`: the flat $2,000 was 4% of what
    #: these stores actually spend a cycle, so it withheld cards at three of five
    #: of them for no reason. Omitted, the declared default stands and the card
    #: says so.
    sales: Sequence[Any] = (),
    #: {sku: name}, for keeping register mechanics out of the replacement-cost
    #: measurement. A tax line sells a unit on every transaction and has no cost,
    #: so counting it drags the priced share toward the refusal floor.
    product_names: dict[str, str] | None = None,
    config: Any = cfg,
) -> SlateDecision:
    """Compose one slate under the store's cash and shelf budgets.

    `limit` is a CEILING on the owner's attention, applied last. It is not
    divided between families and nothing is reserved: the budget decides how many
    cards there are, and this only refuses to show more than a person can read.

    Never raises. An empty slate is an answer.
    """
    ctx = RunContext(
        run_id=f"live-slate-{client_id}-{location_id}-{as_of}",
        tenant_id=client_id, store_id=location_id, as_of=as_of,
        snapshot_id=f"snap-{as_of}", config_version="default", seed=0,
        versions={"portfolio": "1.0.0", "holding": "1.0.0"},
    )

    priced: dict[str, Pick] = {}
    candidates: list[PortfolioCandidate] = []
    unpriced_picks: list[Pick] = []
    for pick in picks:
        candidate = candidate_for(pick, money.get(pick.sku, Money()), ctx,
                                  config, canonical_qty=canonical_qty)
        if candidate is None:
            unpriced_picks.append(pick)
            continue
        priced[pick.sku] = pick
        candidates.append(candidate)

    # ── THE BUDGET, MEASURED WHERE IT CAN BE ───────────────────────────────
    #
    # An explicit `cash_budget` from the caller always wins - a test or an owner
    # saying "I have $800 this week" is the most authoritative input there is.
    # Otherwise the store's own replacement cost, and only then the declared
    # default. The ORDER matters: the default is a known-wrong number and must be
    # the last resort, not the first.
    replacement: ReplacementCost | None = None
    if cash_budget is None and sales:
        replacement = replacement_cost(
            sales,
            {sku: m.unit_cost for sku, m in money.items()
             if m.unit_cost and m.unit_cost > 0},
            as_of=as_of, window_days=BASELINE_WINDOW_DAYS,
            cycle_days=COVERAGE_DAYS, ctx=ctx, config=config,
            product_names=product_names,
            unit_prices={sku: m.unit_price for sku, m in money.items()
                         if m.unit_price and m.unit_price > 0},
        )
        if replacement.ok:
            cash_budget = replacement.per_cycle

    slate: PortfolioSlate | None = None
    withheld: list[tuple[str, str]] = []
    chosen_priced: list[Pick] = []
    if candidates:
        slate = choose_portfolio(
            candidates, ctx, config,
            cash_budget=cash_budget, shelf_budget_units=shelf_budget_units,
        )
        chosen_priced = [priced[c.sku] for c in slate.chosen]
        withheld = [(c.sku, reason) for c, reason in slate.skipped]

    # ORDER: the budget's own ranking first, then the cards it could not value.
    #
    # Not an accident of ordering. The priced cards are the ones that spend the
    # money, so the slate reads top-down as "here is what your cash buys, best
    # return per dollar first", and the unpriced cards - a markdown, a bundle, a
    # new arrival - follow in the order they already had. Neither group can crowd
    # the other out of existence, because the budget bounds the first and the
    # ceiling bounds the whole.
    ordered: list[Pick] = chosen_priced + unpriced_picks
    kept_extra = list(extra)

    # The ceiling, applied to the whole slate at once rather than divided.
    # Signal-family cards are counted FIRST, which is the protection they
    # already had: they are a handful, their evidence is independent of the
    # arithmetic families, and a family that appears only when nothing else does
    # is a gap filler rather than a family.
    room = max(0, limit - len(kept_extra))

    # HOLD A FEW PLACES FOR THE UNPRICED FAMILIES.
    #
    # `ordered` is priced-first, so a plain `[:room]` truncation deletes every
    # markdown and bundle whenever the budget affords more reorder cards than the
    # ceiling admits - which is the normal case here, and is why a slate of eight
    # reads as eight reorders at a store that also produced markdowns that day.
    #
    # This reserves places, it does not re-rank: the priced cards that survive are
    # still the top of the budget's own ordering, and the reservation is capped at
    # what the unpriced families actually offered. A card displaced this way is
    # recorded as displaced, with its own reason, rather than vanishing into the
    # generic ceiling count.
    floor = int(config.get(UNPRICED_SLATE_FLOOR, ctx))
    hold = max(0, min(floor, len(unpriced_picks), max(0, room - 1)))
    if hold and len(ordered) > room:
        take_priced = max(0, room - hold)
        head = chosen_priced[:take_priced]
        tail = unpriced_picks[:hold]
        for pick in chosen_priced[take_priced:]:
            withheld.append(
                (pick.sku, f"displaced_by_unpriced_floor:{hold}"))
        for pick in unpriced_picks[hold:]:
            withheld.append((pick.sku, f"over_attention_ceiling:{limit}"))
        ordered = head + tail
    elif len(ordered) > room:
        for pick in ordered[room:]:
            withheld.append((pick.sku, f"over_attention_ceiling:{limit}"))
        ordered = ordered[:room]

    decision = SlateDecision(
        picks=tuple(ordered),
        extra=tuple(kept_extra),
        portfolio=slate,
        withheld=tuple(withheld),
        unpriced=len(unpriced_picks),
        replacement=replacement,
    )
    log.info(
        "slate_composed",
        client_id=client_id, location_id=location_id, as_of=str(as_of),
        offered=len(picks) + len(extra), cards=decision.total_cards,
        priced=len(candidates), unpriced=len(unpriced_picks),
        cash_committed=(None if slate is None else round(slate.cash_committed, 2)),
        cash_budget=(None if slate is None else slate.cash_budget),
        budget_basis=decision.budget_basis,
        abstained=decision.abstained,
    )
    return decision


def money_from_catalogue(catalogue: dict[str, Any]) -> dict[str, Money]:
    """{sku: Money} from `context.catalogue`.

    One map, from the inventory rows the health view and the candidate view are
    both built from, so the three cannot disagree about what a bottle costs.
    """
    return {
        sku: Money(unit_price=getattr(info, "unit_price", None),
                   unit_cost=getattr(info, "unit_cost", None))
        for sku, info in (catalogue or {}).items()
    }


__all__ = [
    "UNPRICED_SLATE_FLOOR",
    "MIN_ORDER_UNITS",
    "order_units",
    "UNPRICED_FAMILIES",
    "Money",
    "SlateDecision",
    "candidate_for",
    "compose",
    "money_from_catalogue",
]
