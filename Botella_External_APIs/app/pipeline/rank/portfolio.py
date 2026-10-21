"""The slate as a portfolio under a budget, and the right to issue nothing.

THE DEFECT
    Selection is top-k by score with a family cap. There is no cash or shelf
    budget across the slate, so an owner with $2,000 of free cash receives $8,000
    of advice and silently picks the ones they can afford.

    That is worse than it sounds. It does not mean the owner gets less than they
    were offered - it means THE ENGINE'S RANKING IS BEING OVERRIDDEN, by whoever
    reads the page, on a criterion nobody recorded. The engine believes it
    chose; what actually shipped was a subset chosen by affordability.

WHY GREEDY RATIO AND NOT TOP-K BY SCORE
    Under a budget, score is the wrong sort key. Score answers "which card is
    worth most"; the budget asks "which cards together are worth most for the
    cash available", and those differ whenever a card's value and its cost are
    not proportional. A $900 case of one thing at $120 of expected margin loses
    to three $300 cases at $60 each - same cash, $180 against $120 - and top-k
    by score picks the case.

    Greedy on expected net margin PER DOLLAR COMMITTED is not optimal. A true
    knapsack is, by a few percent, and it is not worth the explanation cost on a
    card: greedy is deterministic, auditable, and a card can say "this one earns
    more per dollar than the one below it" in a sentence an owner can check.
    Optimality that cannot be explained is not worth more than a ranking that
    can.

ABSTENTION IS AN ANSWER, NOT A FAILURE
    If no candidate clears an expected NET margin of zero, the slate is empty and
    says so. The engine never errors for it and the UI must not treat it as a
    failure.

    AND IT IS NOT THE SAME THING AS RAISING THE CONFIDENCE FLOOR. That path is
    already priced by the engine's own MIN_HIT_PROBABILITY setting over 52
    decision dates, 208 runs and 1,056 cards: 0.50 gives 75.9% at 5.1 cards a
    run, 0.40 fills a ten-card slate and costs about 3 points, and 0.55 buys
    about 1 point while cutting coverage to 2.4 cards and HALVING the margin. A
    floor high enough to print 90% issues almost nothing, and a dashboard reading
    90% beside an empty slate is a worse product than one reading 76% with five
    useful cards.

    Abstention withholds cards whose EXPECTED PROFIT IS NEGATIVE - a different
    test, on a different quantity - and it PUBLISHES the coverage it chose.
    Coverage travels with every accuracy figure this module produces, because an
    accuracy figure without its coverage is the number that path would game.

WHAT "EXPECTED NET" MEANS HERE
        expected_net = p * units * margin  -  (1 - p) * holding_cost(units)

    With probability p the card works and earns the margin; otherwise the stock
    sits and costs what N0.1 measured it costs to hold. Both terms are needed:
    without the second, nothing is ever negative and abstention can never fire.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

from app.pipeline.context import RunContext
from app.pipeline.registry import ConfigRegistry, Setting, cfg

CASH_BUDGET = Setting(
    name="portfolio.cash_budget",
    default=2000.0,
    unit="dollars of stock a store will commit in one review cycle",
    owner="commercial",
    why="provisional, and DECLARED rather than measured - which is why it is "
        "surfaced on the slate so the owner can see what was assumed and say it "
        "is wrong. $2,000 a cycle is an ordinary single-store liquor order and "
        "nothing in either database records a store's actual free cash. It "
        "becomes MEASURED when a real purchase-order value per cycle is "
        "available per store, which is the same capture that would make lead "
        "time measurable",
    status="PROVISIONAL",
)

SHELF_BUDGET_UNITS = Setting(
    name="portfolio.shelf_budget_units",
    default=400,
    unit="units of new stock a store can physically take in one cycle",
    owner="commercial",
    why="provisional. The weaker of the two budgets and the one more likely to "
        "be wrong, because shelf capacity has never been measured here and "
        "depends on whether the store is actually space-constrained. It exists "
        "so a slate cannot ask a store to take 3,000 units of anything, which "
        "the cash budget alone permits for cheap stock. It becomes MEASURED from "
        "on-hand snapshots once those exist - the same capture that unblocks the "
        "stockout inference",
    status="PROVISIONAL",
)

MIN_EXPECTED_NET = Setting(
    name="portfolio.min_expected_net",
    default=0.0,
    unit="dollars of expected net margin for one card",
    owner="commercial",
    why="ZERO on purpose, and it is the abstention threshold. A card whose "
        "expected net margin is negative costs the owner money in expectation, "
        "so there is no coverage argument for showing it - unlike a card with a "
        "small positive expectation, which is worth showing even if it is not "
        "worth much. Raising this above zero would be a coverage decision "
        "wearing a profitability argument, and it is the path "
        "MIN_HIT_PROBABILITY already priced: tightening buys about a point and "
        "halves the margin",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class PortfolioCandidate:
    """One card offered to the slate, with what it costs and what it earns.

    `cash_required` and `units_required` are what the OWNER commits, so they come
    from the order quantity rather than from the deficit - buying 19 to capture a
    gap of 10 commits the cash for 19.
    """

    sku: str
    family: str
    #: Units the card is about, for the margin it could earn.
    units_at_stake: float
    unit_margin: float | None
    #: Sheet 08's calibrated confidence. Never the raw stated figure.
    calibrated_confidence: float
    #: What holding the ordered stock costs if the card does NOT work. From
    #: N0.1's holding_cost; None when the store sends no unit cost.
    holding_cost_if_unsold: float | None
    #: What the owner commits. Zero is legitimate - a bundle or a merchandising
    #: move can earn margin without an order.
    cash_required: float
    units_required: float

    def __post_init__(self) -> None:
        for name in ("units_at_stake", "cash_required", "units_required"):
            value = getattr(self, name)
            if value is None or value < 0:
                raise ValueError(f"{self.sku}: {name} must be >= 0, got {value!r}")
        if not 0.0 <= self.calibrated_confidence <= 1.0:
            raise ValueError(
                f"{self.sku}: calibrated_confidence must be within 0..1, got "
                f"{self.calibrated_confidence}"
            )

    @property
    def expected_net(self) -> float | None:
        """p x upside - (1 - p) x downside. None when there is no margin.

        Both terms, deliberately. Without the downside nothing is ever negative
        and abstention could never fire, which would make this module decoration.
        """
        if self.unit_margin is None:
            return None
        p = self.calibrated_confidence
        upside = p * self.units_at_stake * self.unit_margin
        downside = (1.0 - p) * (self.holding_cost_if_unsold or 0.0)
        return upside - downside

    @property
    def ratio(self) -> float | None:
        """Expected net margin per dollar committed.

        A card that commits NO cash and earns something has no finite ratio, so
        it is ranked above every card that does commit cash - which is correct:
        it is free. `None` means the ratio is undefined, and the caller sorts
        those first rather than dividing by zero.
        """
        net = self.expected_net
        if net is None:
            return None
        if self.cash_required <= 0.0:
            return None
        return net / self.cash_required


@dataclass(frozen=True, slots=True)
class PortfolioSlate:
    """What was chosen, what was not, and what the budget was assumed to be."""

    chosen: tuple[PortfolioCandidate, ...]
    #: (candidate, reason) for everything offered and not taken. Carried rather
    #: than dropped: "we considered it and here is why not" is the difference
    #: between a decision and a silent truncation.
    skipped: tuple[tuple[PortfolioCandidate, str], ...]
    cash_budget: float
    shelf_budget_units: float
    cash_committed: float
    units_committed: float
    #: The coverage this slate CHOSE. Travels with every accuracy figure derived
    #: from it, because an accuracy figure without its coverage is the number a
    #: confidence floor would game.
    offered: int = 0

    @property
    def abstained(self) -> bool:
        """An empty slate. An ANSWER - "nothing worth doing today" - never an
        error, and the UI must not render it as a failure."""
        return not self.chosen

    @property
    def coverage(self) -> int:
        """Cards issued. The number that appears beside every accuracy figure."""
        return len(self.chosen)

    @property
    def expected_net(self) -> float:
        return sum(c.expected_net or 0.0 for c in self.chosen)

    def assumptions(self) -> tuple[str, ...]:
        """What the owner is entitled to see and disagree with."""
        return (
            f"assumes ${self.cash_budget:,.0f} of cash available this cycle "
            f"(declared, not measured)",
            f"assumes room for {self.shelf_budget_units:,.0f} units "
            f"(declared, not measured)",
        )

    def explain(self) -> str:
        if self.abstained:
            return (
                "Nothing worth doing today. Of "
                f"{self.offered} candidate(s), none had a positive expected net "
                "margin once the cost of holding unsold stock was counted."
            )
        return (
            f"{self.coverage} of {self.offered} candidates, committing "
            f"${self.cash_committed:,.0f} of {self.cash_budget:,.0f} and "
            f"{self.units_committed:,.0f} of {self.shelf_budget_units:,.0f} units, "
            f"for ${self.expected_net:,.0f} of expected net margin."
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "coverage": self.coverage,
            "offered": self.offered,
            "abstained": self.abstained,
            "cash_budget": self.cash_budget,
            "shelf_budget_units": self.shelf_budget_units,
            "cash_committed": self.cash_committed,
            "units_committed": self.units_committed,
            "expected_net": self.expected_net,
            "chosen": [c.sku for c in self.chosen],
            "skipped": [{"sku": c.sku, "reason": r} for c, r in self.skipped],
            "assumptions": list(self.assumptions()),
        }


def _sort_key(candidate: PortfolioCandidate) -> tuple[int, float, str]:
    """Best ratio first; zero-cash cards above all of them; SKU breaks ties.

    The SKU tie-break is what makes the slate byte-identical on a rerun, which
    the composer already guarantees and this must not lose.
    """
    ratio = candidate.ratio
    if ratio is None:
        # Free money ranks first, ordered by the size of it.
        return (0, -(candidate.expected_net or 0.0), candidate.sku)
    return (1, -ratio, candidate.sku)


def choose_portfolio(
    candidates: Sequence[PortfolioCandidate],
    ctx: RunContext,
    config: ConfigRegistry = cfg,
    *,
    cash_budget: float | None = None,
    shelf_budget_units: float | None = None,
) -> PortfolioSlate:
    """Greedy on expected net margin per dollar committed, under both budgets.

    Deterministic: the same candidates produce the same slate in the same order
    every time. Never raises - an empty result is an answer.
    """
    cash_cap = (float(cash_budget) if cash_budget is not None
                else float(config.get(CASH_BUDGET, ctx)))
    shelf_cap = (float(shelf_budget_units) if shelf_budget_units is not None
                 else float(config.get(SHELF_BUDGET_UNITS, ctx)))
    floor = float(config.get(MIN_EXPECTED_NET, ctx))

    chosen: list[PortfolioCandidate] = []
    skipped: list[tuple[PortfolioCandidate, str]] = []
    cash_used = 0.0
    units_used = 0.0

    for candidate in sorted(candidates, key=_sort_key):
        net = candidate.expected_net
        if net is None:
            # No margin means no expected value, never an assumed one. The card
            # may still be worth showing, but not by THIS criterion, so it is
            # recorded rather than silently dropped.
            skipped.append((candidate, "no_unit_margin:cannot_price_this_card"))
            continue
        if net <= floor:
            skipped.append((
                candidate,
                f"expected_net_not_positive:{net:+.2f}<={floor:+.2f}",
            ))
            continue
        if cash_used + candidate.cash_required > cash_cap:
            skipped.append((
                candidate,
                f"over_cash_budget:{cash_used + candidate.cash_required:,.0f}"
                f">{cash_cap:,.0f}",
            ))
            continue
        if units_used + candidate.units_required > shelf_cap:
            skipped.append((
                candidate,
                f"over_shelf_budget:{units_used + candidate.units_required:,.0f}"
                f">{shelf_cap:,.0f}",
            ))
            continue
        chosen.append(candidate)
        cash_used += candidate.cash_required
        units_used += candidate.units_required

    return PortfolioSlate(
        chosen=tuple(chosen),
        skipped=tuple(skipped),
        cash_budget=cash_cap,
        shelf_budget_units=shelf_cap,
        cash_committed=cash_used,
        units_committed=units_used,
        offered=len(candidates),
    )


def top_k_by_expected_net(
    candidates: Sequence[PortfolioCandidate], k: int
) -> tuple[PortfolioCandidate, ...]:
    """The ordering this module replaces, kept so the two can be compared.

    Not exported for production use. It exists because "greedy ratio beats top-k"
    is a claim, and a claim needs something to be measured against.
    """
    ranked = sorted(
        candidates,
        key=lambda c: (-(c.expected_net or 0.0), c.sku),
    )
    return tuple(ranked[:k])


__all__ = [
    "CASH_BUDGET",
    "MIN_EXPECTED_NET",
    "SHELF_BUDGET_UNITS",
    "PortfolioCandidate",
    "PortfolioSlate",
    "choose_portfolio",
    "top_k_by_expected_net",
]
