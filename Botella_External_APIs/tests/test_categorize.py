from __future__ import annotations

import pytest

from app.store_data.categorize import (
    classify_from_name,
    family_of,
    normalize_category,
    resolve_category,
)


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("BEER", "beer"),
        ("Beer", "beer"),
        ("beer", "beer"),
        ("WINE", "wine"),
        ("Wine", "wine"),
        ("Beer  - IPA", "beer_ipa"),          # double space + leading token
        ("Liquor  - Whiskey", "whiskey"),     # liquor family, whiskey subtype
        ("Wine - Red", "wine_red"),
        ("Wine - White", "wine_white"),
        ("LIQUOR - Tequila", "tequila"),
        ("Liquor - Vodka", "vodka"),
    ],
)
def test_normalize_known_formats(raw: str, expected: str) -> None:
    assert normalize_category(raw) == expected


@pytest.mark.parametrize("junk", ["", "   ", "DNR", "dnr", "N/A", "Misc", "Other", None])
def test_normalize_junk_is_none(junk: str | None) -> None:
    assert normalize_category(junk) is None


@pytest.mark.parametrize(
    "name, expected",
    [
        ("Old Crow Straight Bourbon 750ml", "bourbon"),
        ("Casamigos Blanco Tequila 750ml", "tequila"),
        ("Tito's Handmade Vodka 1L", "vodka"),
        ("White Claw Hard Seltzer Variety", "seltzer"),  # brand beats bare 'white'
        ("La Marca Prosecco", "prosecco"),
        ("Modelo Especial 12pk", "beer_mexican"),
        ("Whispering Angel Rosé 750ml", "wine_rose"),     # accent handled
        ("Kendall-Jackson Chardonnay", "wine_white"),
        ("Josh Cabernet Sauvignon", "wine_red"),          # cabernet beats sauvignon
    ],
)
def test_classify_from_name(name: str, expected: str) -> None:
    assert classify_from_name(name) == expected


def test_resolve_prefers_raw_then_name_then_uncategorized() -> None:
    # raw wins
    assert resolve_category("Beer - IPA", "Random Bourbon") == "beer_ipa"
    # junk raw -> classify from name
    assert resolve_category("DNR", "Old Crow Bourbon") == "bourbon"
    # nothing resolvable
    assert resolve_category("", "Mystery Item 42") == "uncategorized"
    # classifier disabled -> uncategorized even with a clear name
    assert resolve_category("", "Old Crow Bourbon", classify=False) == "uncategorized"


@pytest.mark.parametrize(
    "token, family",
    [
        ("bourbon", "spirits"),
        ("tequila", "spirits"),
        ("beer_ipa", "beer"),
        ("seltzer", "beer"),
        ("wine_red", "wine"),
        ("champagne", "wine"),
        ("uncategorized", "default"),
        (None, "default"),
    ],
)
def test_family_of(token: str | None, family: str) -> None:
    assert family_of(token) == family
