"""Category canonicalizer.

The warehouse `products.category` is fragmented (BEER/Beer/beer, blanks, and
hundreds of granular labels like "Whisky Bourbon", "Tequila Agave Premium").
We map any raw label (falling back to the product name) onto a small, stable
liquor-retail taxonomy so grouping/reporting is meaningful and consistent.

Deterministic, ordered keyword rules — first match wins. Short/ambiguous tokens
(gin, rum, ale, port) use word boundaries to avoid false hits (ginger, virgin).
"""
from __future__ import annotations

import re

# Canonical top-level categories.
BEER = "Beer"
WINE = "Wine"
SPIRITS = "Spirits"
RTD = "RTD/Seltzer"
TOBACCO = "Tobacco"
CANNABIS = "CBD/Cannabis"
MIXERS = "Mixers/NA"
SNACKS = "Snacks/Food"
ACCESSORIES = "Accessories/Other"
OTHER = "Other"

CANONICAL_CATEGORIES = [BEER, WINE, SPIRITS, RTD, TOBACCO, CANNABIS,
                        MIXERS, SNACKS, ACCESSORIES, OTHER]

# (compiled pattern, canonical) — ORDER MATTERS (specific -> general).
_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"cigar|cigarette|tobacco|\bvape\b|juul|nicotine|backwoods|swisher|hemp\s*wrap|rolling\s*paper"), TOBACCO),
    (re.compile(r"\bcbd\b|\bthc\b|delta[\s-]*9|delta[\s-]*8|\bd9\b|\bd8\b|kratom|\d+\s*mg\b"), CANNABIS),
    # RTD before beer/spirits (these often contain "margarita", "vodka", etc.)
    (re.compile(r"seltzer|ready[\s-]*to[\s-]*drink|\brtd\b|hard\s*(cider|tea|seltzer|kombucha)|canned\s*cocktail|can\s*cocktail|white\s*claw|truly|high\s*noon"), RTD),
    (re.compile(r"\bbeer\b|\bipa\b|lager|\bale\b|pilsen|stout|porter|\bcider\b|hefe|saison|kolsch|\bbrew\b|pale\s*lager|malt\b|domestic|imported\s*beer|wild/?sour|sour\b"), BEER),
    (re.compile(r"\bwine\b|cabernet|chardonnay|merlot|pinot|sauvignon|riesling|zinfandel|ros[eé]\b|champagne|prosecco|sparkling|moscato|sangria|red\s*blend|\bsyrah\b|shiraz|malbec|tempranillo|\bport\b|\bsherry\b|vermouth|magnum|chianti|bordeaux|grenache|gamay|verdejo|albarino|gewurz"), WINE),
    (re.compile(r"vodka"), SPIRITS),
    (re.compile(r"whisk|bourbon|scotch|\brye\b"), SPIRITS),
    (re.compile(r"tequila|mezcal|agave"), SPIRITS),
    (re.compile(r"\brum\b|rhum|cacha[cç]a"), SPIRITS),
    (re.compile(r"\bgin\b"), SPIRITS),
    (re.compile(r"brandy|cognac|armagnac|grappa|pisco|calvados"), SPIRITS),
    (re.compile(r"liqueur|schnapps|cordial|aperitif|amaro|triple\s*sec|aperol|campari|sambuca|absinthe"), SPIRITS),
    (re.compile(r"spirit|liquor|alcohol|moonshine|everclear"), SPIRITS),
    (re.compile(r"mixer|tonic|\bsoda\b|\bcola\b|ginger\s*ale|club\s*soda|\bjuice\b|energy\s*drink|red\s*bull|\bwater\b|bitters|grenadine|margarita\s*mix"), MIXERS),
    (re.compile(r"snack|\bchip|\bcandy\b|\bfood\b|jerky|\bnuts?\b|garnish|pretzel|popcorn"), SNACKS),
    (re.compile(r"glass(ware)?|opener|\bcork|\bgift\b|\bbag\b|accessor|lighter|\bice\b|shaker|koozie|novelty"), ACCESSORIES),
]


def _normalize(s: str | None) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def canonicalize_category(raw_category: str | None, product_name: str | None = None) -> str:
    """Map a raw category (or product name fallback) to a canonical category."""
    cat = _normalize(raw_category)
    name = _normalize(product_name)
    for blob in (cat, name):           # prefer the explicit category, then the name
        if not blob:
            continue
        for pattern, canonical in _RULES:
            if pattern.search(blob):
                return canonical
    return OTHER
