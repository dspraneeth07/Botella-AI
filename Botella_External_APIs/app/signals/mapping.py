"""Signal -> product-category mapping.

This is the only "rules" in the system. It does NOT decide what to recommend;
it only shapes which product categories are *eligible* to be considered for the
signal-aligned candidate slice. The LLM still does the actual reasoning.

The right-hand-side tokens are the **canonical** category vocabulary produced by
``app.store_data.categorize`` (which normalizes messy POS categories and
classifies from the product name when needed) — not raw DB strings. Add tokens
here only if you also teach the categorizer to emit them.
"""

from __future__ import annotations

from app.store_data.categorize import family_members

SIGNAL_CATEGORY_MAP: dict[str, list[str]] = {
    # Weather
    "heat_advisory": [
        "beer", "beer_lager", "beer_mexican", "seltzer", "vodka", "tequila",
        "wine_rose", "wine_white", "wine", "rtd",
    ],
    "cold_snap": [
        "bourbon", "scotch", "rye", "whiskey", "irish_whiskey", "brandy",
        "wine_red", "wine", "stout", "porter", "spirits",
    ],
    "severe_weather": ["beer", "spirits", "wine", "rtd"],
    # Sports
    "nfl_home_game": ["beer", "beer_lager", "beer_mexican", "seltzer", "rtd", "tequila", "vodka"],
    "nba_home_game": ["beer", "rtd", "seltzer"],
    "mlb_home_game": ["beer", "beer_lager", "beer_ale"],
    "nhl_home_game": ["beer", "rtd"],
    # Calendar / holidays
    "valentines": ["champagne", "prosecco", "sparkling", "wine_red", "wine"],
    "mardi_gras": ["beer", "bourbon", "rum", "rtd", "vodka"],
    "cinco_de_mayo": ["tequila", "mezcal", "beer_mexican"],
    "st_patricks": ["irish_whiskey", "stout", "baileys", "beer"],
    "easter": ["wine", "wine_white", "champagne", "prosecco", "sparkling"],
    "mothers_day": ["champagne", "prosecco", "sparkling", "wine_rose", "wine_white"],
    "fathers_day": ["bourbon", "scotch", "rye", "whiskey", "beer"],
    "oktoberfest": ["beer", "beer_lager", "beer_ale"],
    "day_of_dead": ["tequila", "mezcal", "beer_mexican"],
    "lunar_new_year": ["brandy", "champagne", "sparkling", "vodka"],
    "thanksgiving_eve": ["beer", "tequila", "vodka", "wine_red", "wine"],
    "nye": ["champagne", "prosecco", "sparkling", "vodka", "tequila", "wine"],
    "super_bowl": ["beer", "beer_lager", "beer_mexican", "tequila", "bourbon", "rtd"],
    "kentucky_derby": ["bourbon"],
    "memorial_day": ["beer", "seltzer", "vodka", "tequila"],
    "labor_day": ["beer", "seltzer", "vodka"],
    "july_4th": ["beer", "seltzer", "vodka", "rum"],
    "halloween": ["fireball", "rtd", "whiskey"],
    # Local events (Ticketmaster) — see app.signals.events
    "event_concert": ["beer", "seltzer", "rtd", "vodka", "tequila"],
    "event_sports": ["beer", "beer_lager", "beer_mexican", "rtd", "seltzer"],
    "event_festival": ["beer", "seltzer", "rtd", "wine"],
    "event_arts": ["wine", "wine_red", "wine_white", "champagne", "sparkling"],
    "event_nearby": ["beer", "wine", "spirits", "rtd"],
    # Local news (NewsData) — see app.signals.news
    "news_viral_cocktail": ["vodka", "tequila", "rum", "gin", "liqueur", "rtd"],
    "news_festival": ["beer", "seltzer", "rtd", "wine"],
}

# Generic fallback when no signal maps to anything specific.
FALLBACK_CATEGORIES: set[str] = {"beer", "wine", "spirits"}

# The generic tokens that double as family names. A mapping entry of "beer"
# means "any beer", not "products whose canonical token is literally 'beer'".
_GENERIC_FAMILIES = ("beer", "wine", "spirits")


def expand_families(cats: set[str]) -> set[str]:
    """Expand generic family tokens to every granular token in that family.

    Candidate selection compares canonical tokens exactly, and a well-
    categorized inventory carries granular tokens (``beer_ipa``, ``bourbon``,
    ``wine_red``). Without expansion, a signal mapped to ``"beer"`` would skip
    every IPA/ale/stout, and the quiet-day fallback would match almost nothing.
    Public: the LLM news analyst's category output goes through this too.
    """
    expanded = set(cats)
    for family in _GENERIC_FAMILIES:
        if family in cats:
            expanded |= family_members(family)
    return expanded


def active_categories(active_keys: list[str]) -> set[str]:
    cats: set[str] = set()
    for key in active_keys:
        cats.update(SIGNAL_CATEGORY_MAP.get(key, []))
    return expand_families(cats or set(FALLBACK_CATEGORIES))
