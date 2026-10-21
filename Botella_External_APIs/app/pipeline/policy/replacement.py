"""What a store spends to stand still, measured from its own receipts.

WHY THIS EXISTS
    `portfolio.CASH_BUDGET` defaulted to $2,000 a cycle for every store in the
    estate, declared rather than measured, with its own `why` admitting that
    nothing in either database recorded a store's free cash. That was honest and
    it was also wrong by an order of magnitude and a half.

    Measured on the five audited stores, cost of goods sold over 28 days scaled to
    one review cycle:

        Bethany      $50,269 a cycle      25x the declared budget
        Northlake    $42,324              21x
        Mango Jo's   $81,172              41x
        Marshfield   $53,446              27x
        Cork Runner  $58,752              29x

    So the budget was binding at three of five stores on a constant that was 4% of
    the right figure. Bethany lost three cards to a $2,000 ceiling while the store
    was spending $50,269 a cycle. That is the engine withholding advice for no
    reason, and it is worse than having no budget at all, because it looks like a
    decision.

WHAT THIS IS, AND WHAT IT IS NOT
    IT IS the store's replacement cost: what leaves the shelf in a window, priced
    at what the store paid, scaled to the review cycle. A store that replaces what
    it sells commits roughly this much every cycle whether the engine says
    anything or not.

    IT IS NOT free cash, and it must never be called that. A store's actual
    borrowing room, supplier terms and cash position are not in either database.
    The purchase-order tables that WOULD measure it hold zero parsed invoices.

    So why is it the right ceiling? Because the slate's cards are REORDERS, and a
    reorder card asks the owner to direct part of a spend they were already going
    to make. The quantity on the card is the canonical order quantity - the same
    figure the Buying tab prints - so the comparison is like with like. A slate
    asking more than the store's entire replacement spend is asking it to double
    its purchasing in one cycle, and THAT is worth refusing. A slate asking 4% of
    it is not, and the previous constant refused those too.

ONE WINDOW, NO NEW CONSTANTS
    The window is the one sheet 20 already reads the demand rate over, so the
    budget and the demand estimate describe the same recent period. The cycle is
    `COVERAGE_DAYS` - lead time plus review period - which is the window the order
    quantity already covers. Nothing here invents a share, a multiplier or a
    buffer: every term is a quantity something else in the pipeline already owns.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Iterable, Mapping

from app.pipeline.candidates.merchandise import is_merchandise
from app.pipeline.context import RunContext
from app.pipeline.registry import ConfigRegistry, Setting, cfg

MIN_PRICED_SHARE = Setting(
    name="replacement.min_priced_share",
    default=0.5,
    unit="share of sold units that must carry a unit cost",
    owner="data",
    why="a replacement cost computed from half a store's catalogue understates it "
        "by whatever the other half sold, and a budget that is too SMALL silently "
        "withholds cards - the exact failure the flat $2,000 produced. Measured "
        "cost coverage on the five audited stores is 86-100%, so this refuses the "
        "shape of store that would be mis-measured rather than the stores that "
        "exist. Below it the figure is refused and the declared default stands, "
        "which is a known-wrong number rather than a quietly-wrong one",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class ReplacementCost:
    """What the store spends to stand still, and how well it is known."""

    #: Dollars per review cycle, at the store's own unit costs.
    per_cycle: float
    #: Dollars over the measurement window, before scaling. Carried so the figure
    #: can be checked against a till rather than taken on trust.
    over_window: float
    window_days: int
    cycle_days: int
    #: Share of sold UNITS that carried a cost. The denominator of the claim.
    priced_share: float
    #: "measured" or a named refusal. Never a silent fallback.
    basis: str
    #: Units excluded as non-merchandise before the share was computed. Carried so
    #: a surprising priced_share can be explained rather than argued about.
    excluded_units: float = 0.0

    @property
    def ok(self) -> bool:
        return self.basis == "measured"

    def explain(self) -> str:
        if not self.ok:
            return f"replacement cost not measured: {self.basis}"
        return (
            f"about ${self.per_cycle:,.0f} of stock every {self.cycle_days} days, "
            f"measured from ${self.over_window:,.0f} of goods sold in the last "
            f"{self.window_days} days at your own costs "
            f"({self.priced_share:.0%} of units priced)"
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "per_cycle": self.per_cycle,
            "over_window": self.over_window,
            "window_days": self.window_days,
            "cycle_days": self.cycle_days,
            "priced_share": self.priced_share,
            "excluded_units": self.excluded_units,
            "basis": self.basis,
        }


def _refused(reason: str, window_days: int, cycle_days: int,
             priced_share: float = 0.0,
             excluded_units: float = 0.0) -> ReplacementCost:
    return ReplacementCost(
        per_cycle=0.0, over_window=0.0, window_days=window_days,
        cycle_days=cycle_days, priced_share=priced_share, basis=reason,
        excluded_units=excluded_units,
    )


def replacement_cost(
    sales: Iterable[Any],
    unit_costs: Mapping[str, float] | None,
    *,
    as_of: date,
    window_days: int,
    cycle_days: int,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
    product_names: Mapping[str, str] | None = None,
    unit_prices: Mapping[str, float] | None = None,
) -> ReplacementCost:
    """Cost of goods sold in the trailing window, scaled to one review cycle.

    Pure function of the rows handed in. Never raises and never guesses: a store
    whose POS sends too few costs gets a NAMED refusal, so the caller falls back
    to a figure it knows is declared rather than to one that looks measured.

    NON-MERCHANDISE IS EXCLUDED WHERE NAMES ALLOW IT, and that is not tidiness.
    A county tax line carries a unit on every liquor sale in the state and has no
    cost, because it is not a good. Counting those units in the denominator pushes
    the priced share down toward the refusal floor, and the refusal falls back to
    the declared $2,000 - which was 4% of the right figure and withheld cards.
    So an unpriced non-product would quietly cost the store the very budget this
    function exists to measure. Found by a fixture, then confirmed against the
    catalogue: 193 tax lines across 621,053 estate-wide names.

    Without `product_names` the screen stands down rather than guessing, and the
    figure is then measured over everything that sold - the behaviour before this
    argument existed.
    """
    if window_days <= 0 or cycle_days <= 0:
        return _refused("non_positive_window", window_days, cycle_days)

    costs = unit_costs or {}
    names = product_names or {}
    start = as_of - timedelta(days=window_days)
    sold_units = 0.0
    priced_units = 0.0
    excluded_units = 0.0
    spend = 0.0
    for row in sales:
        day = getattr(row, "sale_date", None)
        if day is None or not start < day <= as_of:
            continue
        units = float(getattr(row, "units", 0) or 0)
        if units <= 0:
            continue
        sku = (getattr(row, "sku", "") or "").strip()
        if names and not is_merchandise(
            sku, names.get(sku), (unit_prices or {}).get(sku), ctx, config
        ):
            excluded_units += units
            continue
        sold_units += units
        cost = costs.get(sku)
        # A cost of zero is what a POS sends when it sends nothing. Counting it as
        # priced would let a store with no costs at all report 100% coverage of a
        # replacement spend of $0 - measured, and measured as free.
        if cost is not None and cost > 0:
            priced_units += units
            spend += units * float(cost)

    if sold_units <= 0:
        return _refused("no_merchandise_units_sold_in_window", window_days,
                        cycle_days, excluded_units=excluded_units)

    priced_share = priced_units / sold_units
    floor = float(config.get(MIN_PRICED_SHARE, ctx))
    if priced_share < floor:
        return _refused(f"cost_coverage_{priced_share:.0%}_below_{floor:.0%}",
                        window_days, cycle_days, priced_share, excluded_units)
    if spend <= 0.0:
        return _refused("no_priced_spend_in_window", window_days, cycle_days,
                        priced_share, excluded_units)

    return ReplacementCost(
        # Scaled by DAYS, not by open days. A replacement order is placed against
        # the calendar - the delivery lands on a date and the supplier's week does
        # not pause when the shop shuts - and both window and cycle are calendar
        # spans here, so the ratio is consistent either way.
        per_cycle=spend * cycle_days / window_days,
        over_window=spend,
        window_days=window_days,
        cycle_days=cycle_days,
        priced_share=priced_share,
        basis="measured",
        excluded_units=excluded_units,
    )


__all__ = [
    "MIN_PRICED_SHARE",
    "ReplacementCost",
    "replacement_cost",
]
