"""The cash budget, measured instead of declared.

WHAT WAS WRONG, AND IT WAS NOT SUBTLE. `portfolio.CASH_BUDGET` defaulted to
$2,000 a cycle for every store in the estate. Measured on the five audited stores,
cost of goods sold over 28 days scaled to one review cycle:

    Bethany      $50,269 a cycle      25x the declared budget
    Northlake    $42,324              21x
    Mango Jo's   $81,172              41x
    Marshfield   $53,446              27x
    Cork Runner  $58,752              29x

So the budget bound at three of five stores on a constant that was 4% of the right
figure. Bethany lost three cards to a $2,000 ceiling while spending $50,269 a
cycle. That is worse than having no budget at all, because it looks like a
decision.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

import pytest

from app.pipeline.context import RunContext
from app.pipeline.policy.replacement import (
    MIN_PRICED_SHARE,
    replacement_cost,
)
from app.pipeline.registry import ConfigRegistry

AS_OF = date(2026, 10, 6)
WINDOW, CYCLE = 28, 14


def ctx() -> RunContext:
    return RunContext(run_id="r", tenant_id=1, store_id=171, as_of=AS_OF,
                      snapshot_id="s", config_version="default", seed=0,
                      versions={"replacement": "1.0.0"})


@dataclass(frozen=True)
class Row:
    sku: str
    sale_date: date
    units: float


def rows(sku: str, units_per_day: float, days: int, *,
         offset: int = 0) -> list[Row]:
    """`days` rows ending ON `AS_OF`.

    The window is half-open - `start < day <= as_of` - so a fixture that starts at
    AS_OF-1 and runs back `days` steps lands one day OUTSIDE it and measures
    `days - 1`. Worth stating: it cost two wrong expectations in this file.
    """
    return [Row(sku, AS_OF - timedelta(days=offset + d), units_per_day)
            for d in range(days)]


def measured(sales, costs, **kw):
    return replacement_cost(sales, costs, as_of=AS_OF, window_days=WINDOW,
                            cycle_days=CYCLE, ctx=ctx(), **kw)


# ── The arithmetic ───────────────────────────────────────────────────────────


def test_the_figure_is_cogs_scaled_from_the_window_to_the_cycle() -> None:
    """28 days of spend, halved onto a 14-day cycle. Nothing else."""
    result = measured(rows("081128005214", 10.0, WINDOW), {"081128005214": 5.0})
    assert result.ok
    assert result.over_window == pytest.approx(28 * 10.0 * 5.0)
    assert result.per_cycle == pytest.approx(28 * 10.0 * 5.0 * CYCLE / WINDOW)


def test_only_the_window_counts() -> None:
    """A row older than the window is not this cycle's spend. Including it would
    overstate the budget, which is the safer direction and still wrong."""
    inside = rows("081128005214", 10.0, WINDOW)
    outside = rows("081128005214", 1000.0, 30, offset=WINDOW + 1)
    assert (measured(inside + outside, {"081128005214": 5.0}).over_window
            == pytest.approx(measured(inside, {"081128005214": 5.0}).over_window))


def test_the_store_pays_its_own_costs_not_the_shelf_price() -> None:
    """A budget priced at retail overstates what the owner commits by the whole
    margin - the same confusion that made the live route read
    `tied_up_capital / on_hand` as a unit cost."""
    result = measured(rows("081128005214", 10.0, WINDOW), {"081128005214": 5.0})
    retail = measured(rows("081128005214", 10.0, WINDOW), {"081128005214": 8.0})
    assert result.over_window < retail.over_window


# ── Refusals, every one named ────────────────────────────────────────────────


def test_a_store_with_no_costs_is_refused_rather_than_measured_at_zero() -> None:
    """A spend of $0 would be a budget of $0, which withholds everything. The
    caller must fall back to a number it KNOWS is declared."""
    result = measured(rows("081128005214", 10.0, WINDOW), {})
    assert not result.ok
    assert "cost_coverage" in result.basis
    assert result.per_cycle == 0.0


def test_a_cost_of_zero_is_not_a_free_product() -> None:
    """It is what a POS sends when it sends nothing. Counting it as priced would
    let a store with no costs report full coverage of a spend of zero."""
    result = measured(rows("081128005214", 10.0, WINDOW), {"081128005214": 0.0})
    assert not result.ok
    assert result.priced_share == pytest.approx(0.0)


def test_partial_cost_coverage_below_the_floor_is_refused() -> None:
    sales = rows("081128005214", 10.0, WINDOW) + rows("088004063702", 40.0, WINDOW)
    result = measured(sales, {"081128005214": 5.0})          # 20% of units priced
    assert not result.ok
    assert result.priced_share == pytest.approx(0.2)


def test_coverage_at_or_above_the_floor_is_measured() -> None:
    sales = rows("081128005214", 40.0, WINDOW) + rows("088004063702", 10.0, WINDOW)
    result = measured(sales, {"081128005214": 5.0})          # 80% of units priced
    assert result.ok
    # Spend counts only what was PRICED. The unpriced units are not valued at a
    # guess, so the figure is an understatement with a known cause.
    assert result.over_window == pytest.approx(28 * 40.0 * 5.0)


def test_an_empty_window_is_refused_not_zero() -> None:
    assert not measured([], {"081128005214": 5.0}).ok
    assert not measured(rows("081128005214", 10.0, 5, offset=WINDOW + 10), {"081128005214": 5.0}).ok


def test_a_non_positive_window_is_refused_rather_than_dividing_by_it() -> None:
    result = replacement_cost(rows("081128005214", 10.0, WINDOW), {"081128005214": 5.0}, as_of=AS_OF,
                              window_days=0, cycle_days=CYCLE, ctx=ctx())
    assert result.basis == "non_positive_window"


# ── Non-merchandise must not drag the share down ─────────────────────────────


def test_a_tax_line_is_excluded_from_the_measurement() -> None:
    """A county tax line carries a unit on every liquor sale in the state and has
    no cost, because it is not a good. Counting those units pushes the priced
    share toward the refusal floor, and the refusal falls back to the $2,000 that
    was 4% of the right figure - so an unpriced non-product would cost the store
    the very budget this function exists to measure."""
    sales = rows("081128005214", 10.0, WINDOW) + rows("077777700022", 90.0, WINDOW)
    names = {"081128005214": "Tito's Handmade Vodka 1L", "077777700022": "1 Liter Liquor Tax"}
    blind = measured(sales, {"081128005214": 5.0})
    screened = measured(sales, {"081128005214": 5.0}, product_names=names)
    assert not blind.ok, "10% coverage, refused - correctly, on what it was told"
    assert screened.ok, "the tax units are not stock to replace"
    assert screened.priced_share == pytest.approx(1.0)
    assert screened.excluded_units == pytest.approx(28 * 90.0)


def test_a_real_product_whose_name_merely_contains_tax_is_kept() -> None:
    """Metaxa, Syntax and Paketaxo are why "tax " was removed from the term list
    once already. The word-boundary rule is what makes restoring it safe."""
    sales = rows("099999900011", 10.0, WINDOW)
    result = measured(sales, {"099999900011": 5.0},
                      product_names={"099999900011": "750ml Metaxa Ouzo Liqueur"})
    assert result.ok
    assert result.excluded_units == 0.0


def test_without_names_the_screen_stands_down_rather_than_guessing() -> None:
    sales = rows("081128005214", 10.0, WINDOW)
    assert measured(sales, {"081128005214": 5.0}).ok
    assert measured(sales, {"081128005214": 5.0}).excluded_units == 0.0


# ── The figure explains itself ───────────────────────────────────────────────


def test_the_explanation_is_checkable_against_a_till() -> None:
    result = measured(rows("081128005214", 10.0, WINDOW), {"081128005214": 5.0})
    text = result.explain()
    assert "$700" in text          # per cycle
    assert "$1,400" in text        # over the window
    assert "28 days" in text and "14 days" in text
    assert "100%" in text          # the denominator of the claim


def test_a_refusal_explains_itself_too() -> None:
    assert "not measured" in measured(rows("081128005214", 10.0, WINDOW), {}).explain()


def test_the_threshold_is_a_registry_setting() -> None:
    """Every tunable is a Setting carrying the reason it holds that value."""
    assert MIN_PRICED_SHARE.name == "replacement.min_priced_share"
    assert MIN_PRICED_SHARE.status in ("PROVISIONAL", "FITTED", "MEASURED")
    assert "withholds cards" in MIN_PRICED_SHARE.why
    overridden = ConfigRegistry(overrides={MIN_PRICED_SHARE.name: 0.1})
    sales = rows("081128005214", 10.0, WINDOW) + rows("088004063702", 40.0, WINDOW)
    assert replacement_cost(sales, {"081128005214": 5.0}, as_of=AS_OF, window_days=WINDOW,
                            cycle_days=CYCLE, ctx=ctx(), config=overridden).ok
