"""The merchandise screens on the MEASURED path, which had none at all.

Every accuracy figure in the audit comes from `engine_picks`, and it screened
nothing - so the measured engine was free to recommend bags of ice, a tax line
and a 12-cent item, all of which have exactly the shape sheet 20 hunts: huge
volume on a wobbling trailing window.
"""

from __future__ import annotations

import pathlib

import pytest

from scripts.real_engine_backtest import (
    _NON_STOCK_CATEGORY_RE,
    category_is_non_stock,
)

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "real_engine_backtest.py"


@pytest.mark.parametrize("category", [
    "LOTTO", "LOTTERY", "LOTTERY PAY OUT", "LOTTO CASH", "SCRATCH OFF",
    "SCRATCHER", "Taxes", "TAX GROC", "NONTAXABLE", "NON-TAX", "CRV",
    "ShortCut", "CREDIT CARD", "DELIVERY", "COUPON", "MANUAL",
    "VENDOR PAID OUT", "MISCELLANEOUS", "NONE",
])
def test_non_stock_categories_are_refused(category: str) -> None:
    assert category_is_non_stock(category) is True


@pytest.mark.parametrize("category", [
    # REAL STOCK a liquor store reorders. The screen is narrow on purpose: an
    # over-broad version is the one that nearly deleted 187 real bottles.
    "VODKA", "BEER", "WINE", "Domestic Beers", "TEQUILA", "BOURBON",
    "SOFT DRINK", "SODA", "JUICE", "WATER", "ENERGY DRINK", "MIXERS",
    "CIGARETTE", "Tobacco", "CANDY / SNACKS", "CHIPS", "ICE CREAM",
    "HARD SELTZER", "Ready To Drink Mixes", "UNITED STATES WINES",
])
def test_real_stock_is_not_refused(category: str) -> None:
    assert category_is_non_stock(category) is False


def test_a_drink_type_always_wins_over_a_non_stock_word() -> None:
    """"NON-ALCOHOLIC BEER" names a drink type AND a non-stock-looking word.
    The drink type decides, as it does in the taxonomy itself."""
    assert category_is_non_stock("NON-ALCOHOLIC BEER") is False
    assert category_is_non_stock("") is False
    assert category_is_non_stock("   ") is False


def test_the_word_boundary_is_a_real_backslash_b() -> None:
    """A REGRESSION GUARD FOR A BUG I REINTRODUCED WHILE WRITING THIS.

    Written through a shell heredoc, `\b` became chr(8) - a literal backspace -
    which matches nothing. The compiled pattern silently refused NOTHING and
    every category came back as stock. `merchandise.py` records the identical
    bug from the identical cause, which is why that module escapes explicitly.

    Two assertions, because either alone can pass while the filter is dead:
    the source must contain no backspace byte, and the pattern must actually
    carry word boundaries.
    """
    assert chr(8) not in SOURCE.read_text(encoding="utf-8"), (
        "a literal backspace is in the source - the heredoc ate a backslash"
    )
    assert _NON_STOCK_CATEGORY_RE.pattern.startswith(chr(92) + "b")
    assert _NON_STOCK_CATEGORY_RE.pattern.endswith(chr(92) + "b")
    # And the boundary does its job: "tax" must not match inside a longer word
    # that is real stock.
    assert category_is_non_stock("TAXIDERMY SUPPLIES") is False


def test_the_screen_is_narrower_than_the_taxonomy() -> None:
    """It refuses only what is not stock at all. Anything the taxonomy can name
    as a drink family is stock by definition."""
    from app.pipeline.features.taxonomy import category_family_of
    for category in ("VODKA", "BEER", "WINE", "ITALIAN", "PROSECCO", "RUM"):
        assert category_family_of(category) is not None
        assert category_is_non_stock(category) is False
