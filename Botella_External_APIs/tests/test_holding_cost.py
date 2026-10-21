"""N0.1 — what it costs to hold surplus stock, and what it does NOT cost.

These tests are the contract for the measurement correction that has to land
before any sizing change can be judged. The old model charged the entire cost
of goods for unsold stock; the figure "four of five stores are net negative in
April" was computed with it, and that sentence is currently steering the
roadmap.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.pipeline.context import RunContext
from app.pipeline.features.taxonomy import category_family_of
from app.pipeline.policy.holding import (
    COST_OF_CAPITAL_ANNUAL,
    OBSOLESCENCE_HAZARD_BY_FAMILY,
    SHELF_OPPORTUNITY_PER_UNIT_DAY,
    HoldingCost,
    hazard_for,
    holding_cost,
)
from app.pipeline.registry import cfg

AS_OF = date(2026, 10, 5)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-n01", "tenant_id": 1, "store_id": 171, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"holding": "1.0.0"},
    }
    return RunContext(**{**base, **over})


# ── The correction itself ────────────────────────────────────────────────────


def test_holding_cost_is_not_cogs() -> None:
    """A $20 bottle held 30 extra days costs under $1, not $20.

    This is the whole point of the module. The old model charged $20 - the
    entire cost of goods - for a bottle that is still on the shelf and still
    saleable.
    """
    held = holding_cost(1.0, 20.0, 30, ctx(), category_family="spirits")
    assert held is not None
    assert held.total < 1.0, f"a held bottle should cost cents, got {held.total}"
    assert held.total > 0.0, "holding stock is not free either"
    # And the deleted model's number is kept so a report can show the ratio.
    assert held.cost_of_goods == pytest.approx(20.0)
    assert held.total < held.cost_of_goods / 10, (
        "the correction should be an order of magnitude or more, which is the "
        "finding that makes this prompt worth doing"
    )


def test_the_three_terms_sum_to_the_total() -> None:
    """The breakdown is not decoration - a reader must be able to argue with
    one term rather than the whole number."""
    held = holding_cost(4.0, 25.0, 60, ctx(), category_family="wine")
    assert held is not None
    assert held.total == pytest.approx(
        held.capital + held.shelf + held.obsolescence
    )
    assert held.capital > 0 and held.shelf > 0 and held.obsolescence > 0


def test_capital_scales_with_time_and_obsolescence_does_not() -> None:
    """The hazard is charged ONCE, not accrued daily.

    Accruing it per day would make a bottle held a year cost more than the
    bottle is worth, which is how a plausible model produces an absurd number.
    """
    short = holding_cost(1.0, 20.0, 30, ctx(), category_family="spirits")
    longer = holding_cost(1.0, 20.0, 300, ctx(), category_family="spirits")
    assert short is not None and longer is not None
    assert longer.capital > short.capital * 5, "capital must scale with days"
    assert longer.obsolescence == pytest.approx(short.obsolescence)
    assert longer.total < 20.0, (
        "even held for ten months a $20 bottle must not reach its own cost of "
        "goods - if it does, the model has reinvented the write-off"
    )


def test_cost_scales_with_units() -> None:
    one = holding_cost(1.0, 20.0, 30, ctx(), category_family="spirits")
    ten = holding_cost(10.0, 20.0, 30, ctx(), category_family="spirits")
    assert one is not None and ten is not None
    assert ten.total == pytest.approx(one.total * 10)


# ── Absence is not zero, and a genuine zero is not absence ───────────────────


def test_holding_cost_absent_without_cost() -> None:
    """No unit cost gives None. Five of ten audited stores send none at all,
    and a 0.0 here would print as "$0 of downside" - a measurement nobody made.
    """
    assert holding_cost(5.0, None, 30, ctx()) is None


def test_none_does_not_become_zero_downstream() -> None:
    """The ledger's own pattern: a None holding cost stays None in the row."""
    held = holding_cost(5.0, None, 30, ctx())
    recorded = held.total if held else None
    assert recorded is None
    assert recorded != 0.0
    assert recorded is not False  # and it is not falsy-equal to a real zero


def test_zero_cost_is_not_treated_as_missing() -> None:
    """A genuine 0.0 unit cost is distinguishable from None.

    The line this replaces read `(over * cost) if cost else None`, which maps a
    real 0.0 to None. That is the falsy-zero class already caught once in the
    index generator, where `s.get("cost") or 1.0` would have shown a no-cost
    store's money columns as if they were measured.
    """
    held = holding_cost(5.0, 0.0, 30, ctx(), category_family="spirits")
    assert held is not None, "a free item has a known cost of zero, not an absence"
    # Capital and obsolescence are proportional to unit cost, so both vanish;
    # the shelf facing is still occupied, so that term does not.
    assert held.capital == 0.0
    assert held.obsolescence == 0.0
    assert held.shelf > 0.0, "a free item still takes up a facing"


def test_no_surplus_is_a_measured_zero() -> None:
    """Nothing left over is a real zero, not an absence - a report may print
    "$0" for it."""
    held = holding_cost(0.0, 20.0, 30, ctx(), category_family="spirits")
    assert held is not None
    assert held.total == 0.0


def test_negative_inputs_are_refused() -> None:
    with pytest.raises(ValueError):
        holding_cost(1.0, -1.0, 30, ctx())
    with pytest.raises(ValueError):
        holding_cost(1.0, 20.0, -1, ctx())


# ── The hazard is per category family, and beer is the dated one ─────────────


def test_beer_hazard_exceeds_spirits() -> None:
    """Beer is the family that is genuinely date-coded. This ordering is what
    will make beer's critical fractile lower than a spirit's once the service
    level is derived from these same terms."""
    c = ctx()
    assert hazard_for("beer", c) > hazard_for("wine", c) > hazard_for("spirits", c)


def test_unknown_family_resolves_to_default_rather_than_raising() -> None:
    """The product master cannot name 43.8% of sold store-SKU pairs, so an
    unnameable category is the normal case, not an error."""
    c = ctx()
    assert hazard_for(None, c) == hazard_for("default", c)
    assert hazard_for("", c) == hazard_for("default", c)
    assert hazard_for("not-a-family", c) == hazard_for("default", c)
    # And a RECOMMENDATION family passed here by mistake must not blow up -
    # "family" means two different things in this codebase and only the
    # parameter name guards against the confusion.
    assert hazard_for("reorder", c) == hazard_for("default", c)


def test_family_lookup_is_case_insensitive() -> None:
    c = ctx()
    assert hazard_for("SPIRITS", c) == hazard_for("spirits", c)
    assert hazard_for("  Beer  ", c) == hazard_for("beer", c)


def test_hazard_map_mirrors_the_service_level_map() -> None:
    """The critical fractile that will replace the declared service level is the
    ratio of these two maps, so identical keys make that a lookup rather than a
    migration."""
    from app.pipeline.policy.inventory import SERVICE_LEVEL_BY_FAMILY

    assert set(OBSOLESCENCE_HAZARD_BY_FAMILY) == set(SERVICE_LEVEL_BY_FAMILY)


def test_every_setting_is_declared_and_provisional() -> None:
    """Three new judgements, each visible in cfg.report() as still a guess."""
    for setting in (
        COST_OF_CAPITAL_ANNUAL,
        SHELF_OPPORTUNITY_PER_UNIT_DAY,
        *OBSOLESCENCE_HAZARD_BY_FAMILY.values(),
    ):
        assert setting.status == "PROVISIONAL"
        assert setting.why.strip()
        assert setting.owner.strip()
        assert setting.unit.strip()
        assert cfg.get(setting, ctx()) is not None


# ── The taxonomy, and the substring traps it exists to avoid ────────────────


@pytest.mark.parametrize(
    "raw,expected",
    [
        # The real vocabulary, as exported from the five stores that send any.
        ("VODKA", "spirits"), ("LIQUOR", "spirits"), ("BOURBON", "spirits"),
        ("WHISKY", "spirits"), ("Whiskey", "spirits"), ("TEQUILA", "spirits"),
        ("LIQUEUR", "spirits"), ("RUM", "spirits"), ("BRANDY", "spirits"),
        ("COGNAC", "spirits"), ("GIN", "spirits"), ("SCOTCH", "spirits"),
        ("MEZCAL", "spirits"), ("MOONSHINE", "spirits"), ("SOJU", "spirits"),
        ("CORDIALS/SPIRITS", "spirits"), ("Cordials & Liqueurs", "spirits"),
        ("AMERICAN WHISKEY", "spirits"), ("IRISH WHISKEY", "spirits"),
        ("BEER", "beer"), ("Domestic Beers", "beer"), ("Imported Beers", "beer"),
        ("Microbrewery Beers", "beer"), ("HARD SELTZER", "beer"),
        ("HARD CIDER", "beer"), ("HARD KOMBUCHA", "beer"), ("Coolers", "beer"),
        ("RTD", "beer"), ("RTD'S", "beer"), ("SPRITZERS", "beer"),
        ("WINE", "wine"), ("UNITED STATES WINES", "wine"),
        ("Standard Wines", "wine"), ("Vintage Wines", "wine"),
        ("SPARKLING WINE", "wine"), ("PROSECCO", "wine"), ("ROSE", "wine"),
        ("RIESLING", "wine"), ("MALBEC", "wine"), ("MOSCATO", "wine"),
        ("SAKE", "wine"), ("PORTO", "wine"), ("SHERRY", "wine"),
        ("VERMOUTH", "wine"),
        # Misspellings that really arrive.
        ("CHAMPANGE", "wine"), ("CHAMPAGN", "wine"),
        # Wine filed by origin - the majority of wine lines at store 181.
        ("NEW ZEALAND", "wine"), ("ITALIAN", "wine"), ("FRENCH", "wine"),
        ("AUSTRALIA", "wine"), ("ARGENTINA", "wine"), ("SPANISH", "wine"),
        ("OREGON", "wine"), ("CHILE", "wine"),
        # Not stock. None, never a liquor family.
        ("Taxes", None), ("CRV", None), ("NONE", None), ("ShortCut", None),
        ("LOTTO", None), ("SCRATCH OFF", None), ("SCRATCHER", None),
        ("LOTTERY PAY OUT", None), ("CREDIT CARD", None), ("DELIVERY", None),
        ("NONTAXABLE", None), ("NON-TAX", None), ("VENDOR PAID OUT", None),
        ("COUPON", None), ("MANUAL", None), ("MISCELLANEOUS", None),
        ("OTHER", None), ("TAX GROC", None),
        # Stock this module refuses to guess at. A known gap, not an accident.
        ("ICE CREAM", None), ("DAIRY", None), ("DELI", None),
        ("PASTRIES", None), ("CIGARETTE", None), ("SOFT DRINK", None),
        ("CANDY / SNACKS", None), ("ENERGY DRINK", None), ("MIXERS", None),
        # Absence.
        (None, None), ("", None), ("   ", None),
    ],
)
def test_category_family_of_real_vocabulary(raw, expected) -> None:
    assert category_family_of(raw) == expected


def test_juice_does_not_match_ice() -> None:
    """"JUICE" contains "ICE". Substring matching would classify juice as ice,
    and the merchandise contract already nearly shipped exactly this class of
    bug - it refused LYNX POLARIZED GROUNDING AD. for containing "rounding"."""
    assert category_family_of("JUICE") is None
    assert category_family_of("ICE") is None


def test_ginger_beer_is_not_gin() -> None:
    """A mixer is not a spirit. "GINGER" contains "GIN", so only word-boundary
    matching gets this right - and "GINGER BEER" is a mixer the moment a store
    adds it, which no store in the export has yet."""
    assert category_family_of("GINGER") is None
    # It does contain the whole word "beer", and a dated mixer ages like beer,
    # so beer is the correct answer here - what must NOT happen is "spirits".
    assert category_family_of("GINGER BEER") == "beer"


def test_japanese_whiskey_is_a_spirit_not_a_wine_region() -> None:
    """"JAPANESE WHISKEY" names both a spirit and a wine-region keyword. Drink
    types are tested before regions, which is the only thing that keeps this
    right."""
    assert category_family_of("JAPANESE WHISKEY") == "spirits"
    assert category_family_of("SCOTCH WHISKEY") == "spirits"
    assert category_family_of("CANADIAN WHISKEY") == "spirits"


def test_families_returned_are_exactly_the_settings_keys() -> None:
    """Whatever this returns must be a key the hazard map can resolve, or the
    taxonomy and the pricing would drift apart silently."""
    returned = {
        category_family_of(c)
        for c in ("VODKA", "BEER", "WINE", "ITALIAN", "Taxes", None)
    } - {None}
    assert returned <= set(OBSOLESCENCE_HAZARD_BY_FAMILY)


def test_holding_cost_result_is_serialisable() -> None:
    held = holding_cost(3.0, 18.0, 45, ctx(), category_family="beer")
    assert held is not None
    d = held.as_dict()
    assert d["total"] == pytest.approx(held.total)
    assert d["cost_of_goods_would_have_been"] == pytest.approx(3.0 * 18.0)
    assert isinstance(held, HoldingCost)
