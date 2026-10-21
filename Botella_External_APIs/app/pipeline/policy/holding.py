"""What it costs to hold stock that did not sell — which is NOT its cost of goods.

THE DEFECT THIS REPLACES
    The ledger charged over-ordering at ``over_units * unit_cost``: the ENTIRE
    cost of goods, as though the unsold stock had been destroyed. Liquor does
    not spoil. A case of bourbon unsold in April is on the shelf in May and
    sells then.

    On a $20 bottle held one extra month the real cost is about fifty cents.
    The old model charged $20 - overstating the downside by one to two ORDERS
    OF MAGNITUDE, on exactly the products this engine recommends most.

    That matters well beyond bookkeeping. "Four of five stores are net negative
    in April" was computed with it, and that sentence is currently driving the
    roadmap. Nothing about the engine's SIZING can be judged until the ruler is
    repaired, which is why this module lands before the sizing work.

WHAT HOLDING ACTUALLY COSTS - three terms, and only three
    capital       the money sits in a bottle instead of the bank, for as long
                  as the bottle sits:  unit_cost * wacc * days / 365
    shelf         the facing could have held something that turns faster. A
                  rent per unit per day: small, real, and the term most likely
                  to be wrong because nobody has measured a facing's worth.
    obsolescence  the chance this unit never sells at full price. Near zero for
                  spirits - which is the whole point of this module - and real
                  for dated or seasonal stock, so it is PER CATEGORY FAMILY.

        holding = over_units * (capital + shelf * days + hazard * unit_cost)

WHY THE HAZARD IS CHARGED ONCE AND DOES NOT ACCRUE DAILY
    It is the probability that a unit the card told the owner to buy ends up
    marked down. That is a property of the PRODUCT (dated or not) and of the
    fact that the units were surplus - not of how long the measurement window
    happened to be. Accruing it per day would make a bottle held a year cost
    more than the bottle is worth, which is how a plausible-looking model
    produces an absurd number. The simplification is stated rather than hidden:
    what would refine it is each category's measured markdown history, and
    until that exists the hazard stays PROVISIONAL.

ABSENCE IS NOT ZERO, AND A GENUINE ZERO IS NOT ABSENCE
    No unit cost means no holding cost - ``None``, never ``0.0``. Five of ten
    audited stores send no cost at all, and a 0.0 here would print as "$0 of
    downside", which reads as a measurement that nobody made.

    A unit cost that is GENUINELY 0.0 is a different thing and returns 0.0: a
    free item ties up no capital. The call site this replaced got that wrong -
    ``(over * cost) if cost else None`` maps a real 0.0 to None - and it is the
    same falsy-zero class already caught once in the index generator.

WHAT THIS MODULE DOES NOT DO
    It does not decide a quantity. It prices one. The order quantity belongs to
    ``inventory.py``, and the critical fractile that will be derived FROM these
    same three terms belongs there too - a holding cost is an input to that
    decision, not the decision.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.registry import ConfigRegistry, Setting, cfg

#: Days in a year. A calendar fact, not a judgement, so not a Setting - the
#: same reason `sigma_from_interval` computes its divisor rather than declaring
#: it: there is nothing here for an owner to disagree with.
DAYS_PER_YEAR = 365


# ── The three terms, declared ────────────────────────────────────────────────

COST_OF_CAPITAL_ANNUAL = Setting(
    name="policy.holding.cost_of_capital_annual",
    default=0.10,
    unit="fraction of unit cost, per year",
    owner="finance",
    why="provisional. The cost of money tied up in stock rather than available "
        "to the business, annualised. 10% is an ordinary small-retail working "
        "capital rate and nobody has measured what these owners actually pay "
        "for money. It becomes MEASURED when a real borrowing or opportunity "
        "rate is supplied per client. Note the sensitivity is low: on a $20 "
        "bottle held a month the whole capital term is about sixteen cents, so "
        "doubling this setting moves the holding cost less than the "
        "obsolescence hazard does",
    status="PROVISIONAL",
)

SHELF_OPPORTUNITY_PER_UNIT_DAY = Setting(
    name="policy.holding.shelf_opportunity_per_unit_day",
    default=0.005,
    unit="dollars per unit per day",
    owner="commercial",
    why="provisional, and the WEAKEST of the three terms. A facing occupied by "
        "a slow unit could have held a faster one, and that forgone margin is "
        "real - but a facing's worth has never been measured here and it "
        "depends on whether the store is actually space-constrained. Half a "
        "cent a unit a day is fifteen cents a month, deliberately small enough "
        "that it cannot dominate the arithmetic while still refusing to claim "
        "shelf space is free. It becomes MEASURED from the realised margin per "
        "facing-day once on-hand snapshots exist, which is also what makes "
        "space constraints observable at all",
    status="PROVISIONAL",
)

OBSOLESCENCE_HAZARD_SPIRITS = Setting(
    name="policy.holding.obsolescence_hazard.spirits",
    default=0.01,
    unit="probability a surplus unit never sells at full price",
    owner="commercial",
    why="provisional, and near zero ON PURPOSE - this is the setting that "
        "carries the whole argument of this module. Spirits do not spoil and "
        "are not date-coded, so a surplus bottle is deferred revenue rather "
        "than a loss. 1% allows for breakage, theft and delisting. It becomes "
        "MEASURED from each category's realised markdown history",
    status="PROVISIONAL",
)

OBSOLESCENCE_HAZARD_WINE = Setting(
    name="policy.holding.obsolescence_hazard.wine",
    default=0.02,
    unit="probability a surplus unit never sells at full price",
    owner="commercial",
    why="provisional. Most table wine keeps for years, so the hazard is low - "
        "but wine turns slowest in the estate at 18.0 units per SKU against "
        "beer's 51.3, so a surplus unit sits far longer and has more time to "
        "be damaged, delisted or superseded by the next vintage. Twice spirits "
        "for that reason, not because the liquid degrades",
    status="PROVISIONAL",
)

OBSOLESCENCE_HAZARD_BEER = Setting(
    name="policy.holding.obsolescence_hazard.beer",
    default=0.04,
    unit="probability a surplus unit never sells at full price",
    owner="commercial",
    why="provisional, and the HIGHEST of the named families, because beer is "
        "the one that is genuinely dated - freshness coding is typically 90 to "
        "120 days and a stale case is marked down or returned. Beer also turns "
        "fastest (51.3 units per SKU), which cuts the other way by shortening "
        "the time a surplus unit sits. Four times spirits is a judgement "
        "between those two forces and it is the single most consequential "
        "number in this module: it is what will make beer's critical fractile "
        "lower than a spirit's once the service level is derived",
    status="PROVISIONAL",
)

OBSOLESCENCE_HAZARD_DEFAULT = Setting(
    name="policy.holding.obsolescence_hazard.default",
    default=0.03,
    unit="probability a surplus unit never sells at full price",
    owner="commercial",
    why="provisional. The fallback for a SKU whose category family is unknown, "
        "which is common: the product master is missing 43.8% of sold "
        "store-SKU pairs estate-wide. Set ABOVE spirits and wine and below "
        "beer on purpose - an unknown product should not be assumed to be the "
        "safest thing on the shelf. Dated, seasonal and limited stock carry a "
        "far higher hazard than any of these and deserve their own family; "
        "that family is deliberately NOT declared here because nothing in the "
        "catalogue can currently identify such a SKU, and a setting nothing "
        "can populate is worse than an honest default",
    status="PROVISIONAL",
)

#: Mirrors `SERVICE_LEVEL_BY_FAMILY` key for key. The two maps describe the same
#: families from opposite ends - how badly a stockout hurts, and how badly
#: surplus hurts - and the critical fractile that will replace the declared
#: service level is the ratio of exactly those two. Keeping the keys identical
#: is what makes that substitution a lookup rather than a migration.
OBSOLESCENCE_HAZARD_BY_FAMILY: dict[str, Setting[float]] = {
    "beer": OBSOLESCENCE_HAZARD_BEER,
    "spirits": OBSOLESCENCE_HAZARD_SPIRITS,
    "wine": OBSOLESCENCE_HAZARD_WINE,
    "default": OBSOLESCENCE_HAZARD_DEFAULT,
}


def hazard_for(
    category_family: str | None, ctx: RunContext, config: ConfigRegistry = cfg
) -> float:
    """The obsolescence hazard for a CATEGORY family, from the registry.

    The argument is named `category_family` rather than `family` deliberately.
    "family" means two different things in this codebase: the RECOMMENDATION
    family (`reorder`, `clear`, `markdown`, `range`, `substitute`, which is what
    `candidates/generate.py` and `calibrate/apply.py` mean) and the CATEGORY
    family (`beer`, `spirits`, `wine`, which is what
    `inventory.service_level_for` means). They are both strings and neither
    validates, so passing "reorder" here would silently return the default
    hazard and nothing would ever complain. The parameter name is the only
    guard available, so it carries its weight.

    An unknown or absent family resolves to the default rather than raising: the
    product master cannot name 43.8% of sold store-SKU pairs, so an unnameable
    category is the normal case, not an error.
    """
    setting = OBSOLESCENCE_HAZARD_BY_FAMILY.get(
        (category_family or "").strip().lower(), OBSOLESCENCE_HAZARD_DEFAULT
    )
    return float(config.get(setting, ctx))


# ── The answer ───────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class HoldingCost:
    """The cost of holding surplus stock, with its three terms kept apart.

    The breakdown is not decoration. A single number cannot be argued with, and
    the three terms have very different standing: `capital` rests on a rate
    somebody can look up, `shelf` on a quantity nobody has measured, and
    `obsolescence` on a category judgement. A reader who disagrees with the
    total should be able to see which term they are disagreeing with.
    """

    units: float
    unit_cost: float
    days_held: int
    capital: float
    shelf: float
    obsolescence: float

    @property
    def total(self) -> float:
        """What it cost to hold these units for this long."""
        return self.capital + self.shelf + self.obsolescence

    @property
    def cost_of_goods(self) -> float:
        """What the DELETED model would have charged, for comparison.

        Kept so a report can print both and show the ratio. The gap between
        `total` and this is the whole point of the module, and a reader who
        sees only the new number has no way to judge how big the correction was.
        """
        return self.units * self.unit_cost

    def as_dict(self) -> dict[str, Any]:
        return {
            "units": self.units,
            "unit_cost": self.unit_cost,
            "days_held": self.days_held,
            "capital": self.capital,
            "shelf": self.shelf,
            "obsolescence": self.obsolescence,
            "total": self.total,
            "cost_of_goods_would_have_been": self.cost_of_goods,
        }


def holding_cost(
    over_units: float,
    unit_cost: float | None,
    days_held: int,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
    *,
    category_family: str | None = None,
) -> HoldingCost | None:
    """Price the surplus. Returns None when the store sends no unit cost.

    `over_units` is units the card said to buy that did not sell in the window.
    `days_held` is how long they have been sitting, in days - a holding cost is
    one of the few quantities here that is genuinely calendar-based, because
    capital is charged by the bank on closed days too.
    """
    if unit_cost is None:
        return None            # absence. not zero, and not a default.
    cost = float(unit_cost)
    if cost < 0:
        raise ValueError(f"unit_cost must not be negative, got {cost}")
    if days_held < 0:
        raise ValueError(f"days_held must not be negative, got {days_held}")

    units = max(0.0, float(over_units))
    if units == 0.0:
        # A measured zero: there was no surplus. Distinct from the None above,
        # and the report may legitimately print "$0" for it.
        return HoldingCost(
            units=0.0, unit_cost=cost, days_held=days_held,
            capital=0.0, shelf=0.0, obsolescence=0.0,
        )

    wacc = float(config.get(COST_OF_CAPITAL_ANNUAL, ctx))
    rent = float(config.get(SHELF_OPPORTUNITY_PER_UNIT_DAY, ctx))
    hazard = hazard_for(category_family, ctx, config)

    return HoldingCost(
        units=units,
        unit_cost=cost,
        days_held=days_held,
        capital=units * cost * wacc * (days_held / DAYS_PER_YEAR),
        shelf=units * rent * days_held,
        obsolescence=units * cost * hazard,
    )


__all__ = [
    "COST_OF_CAPITAL_ANNUAL",
    "DAYS_PER_YEAR",
    "OBSOLESCENCE_HAZARD_BEER",
    "OBSOLESCENCE_HAZARD_BY_FAMILY",
    "OBSOLESCENCE_HAZARD_DEFAULT",
    "OBSOLESCENCE_HAZARD_SPIRITS",
    "OBSOLESCENCE_HAZARD_WINE",
    "SHELF_OPPORTUNITY_PER_UNIT_DAY",
    "HoldingCost",
    "hazard_for",
    "holding_cost",
]
