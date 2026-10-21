"""Raw POS category string -> a canonical category family.

WHY THIS EXISTS AND WHY IT IS A FEATURE
    Two settings maps in `app/pipeline/policy/` key on a CATEGORY FAMILY -
    `SERVICE_LEVEL_BY_FAMILY` and `OBSOLESCENCE_HAZARD_BY_FAMILY` - and until
    now nothing in the tree could produce one. The POS sends free text.

    This is a derivation from a raw field, which is what `features/` is for. It
    deliberately does NOT live in `policy/`: a policy module should receive a
    family and price it, not parse strings to discover one.

WHAT THE REAL VOCABULARY LOOKS LIKE
    136 distinct category strings across the five stores that send any. Five of
    ten audited stores send NONE at all, so `None` is the normal answer and not
    an error. A sample of what actually arrives:

        BEER · LIQUOR · Taxes · VODKA · CRV · NONE · ShortCut · SOFT DRINK
        CIGARETTE · TEQUILA · BOURBON · WHISKY · LIQUEUR · LOTTO · WINE
        Domestic Beers · Ready To Drink Mixes · UNITED STATES WINES · COGNAC
        NEW ZEALAND · ITALIAN · CHAMPANGE · SCOTCH WHISKEY · HARD SELTZER

    Three things in that list shape the whole module. Wine arrives as a COUNTRY
    or a GRAPE far more often than as the word "wine". Champagne arrives
    misspelled two different ways. And a third of the strings are not stock at
    all - taxes, bottle deposits, lottery, shortcuts, card settlements.

THE GROUPING IS BY HOW SURPLUS AGES, NOT BY TASTE
    These families exist to answer "what does it cost to be left holding this",
    so the axis is shelf life, not drink category:

        spirits   does not spoil, is not date-coded. surplus is deferred revenue
        wine      keeps for years but turns slowly, so surplus sits far longer
        beer      GENUINELY DATED - 90-120 day freshness coding. this is where
                  hard seltzer, cider, ready-to-drink and pre-mixed cocktails
                  belong, because they age like beer even though nobody would
                  shelve them with it

WORD BOUNDARIES, FOR A REASON ALREADY PAID FOR ONCE
    The merchandise contract nearly shipped a filter that deleted real stock
    because it matched substrings: it refused LYNX POLARIZED GROUNDING AD. for
    containing "rounding". The same trap is live here and worse:

        "JUICE"  contains  "ICE"
        "GINGER BEER"  would contain  "GIN"
        "JAPANESE WHISKEY"  contains  "JAPANESE", a wine-region keyword

    So every term is matched on word boundaries, and drink TYPES are checked
    before regions - which is what keeps Japanese whiskey a spirit.

WHAT IT REFUSES TO GUESS
    Perishable grocery - ICE CREAM, DAIRY, DELI, PASTRIES - returns `None` and
    therefore gets the DEFAULT hazard, which badly understates it: surplus ice
    cream is a near-total loss, not a 3% risk. That is a known gap, stated here
    rather than papered over with a guess. It needs its own family with a much
    higher hazard, and it matters little today because the merchandise contract
    should keep those lines out of candidacy in the first place.

    Returning `None` is always allowed and always safe: `hazard_for` resolves it
    to the default rather than raising, because an unnameable category is the
    normal case - the product master cannot name 43.8% of sold store-SKU pairs.
"""

from __future__ import annotations

import re

#: Families, in the order they are tested. Order is load-bearing: a drink TYPE
#: must win over a REGION, or "JAPANESE WHISKEY" lands in wine.
SPIRITS_TERMS: frozenset[str] = frozenset({
    "liquor", "liquors", "spirit", "spirits", "vodka", "tequila", "mezcal",
    "bourbon", "whisky", "whiskey", "whiskies", "scotch", "rye", "rum",
    "brandy", "cognac", "armagnac", "gin", "liqueur", "liqueurs", "cordial",
    "cordials", "schnapps", "absinthe", "aquavit", "akvavit", "grappa",
    "moonshine", "soju", "shochu", "baijiu", "pisco", "arak", "raki", "ouzo",
    "cachaca", "tequilas", "aperitif", "bitters", "amaro",
})

WINE_TERMS: frozenset[str] = frozenset({
    "wine", "wines", "champagne", "champagn", "champange", "prosecco", "cava",
    "sparkling", "rose", "rosé", "riesling", "malbec", "moscato", "muscat",
    "viognier", "chardonnay", "merlot", "cabernet", "sauvignon", "pinot",
    "syrah", "shiraz", "zinfandel", "tempranillo", "sangiovese", "chianti",
    "bordeaux", "burgundy", "port", "porto", "sherry", "madeira", "marsala",
    "vermouth", "sake", "soave", "lambrusco", "vinho", "vino",
})

#: Checked only AFTER the drink types above. A wine shop files its wine by
#: origin, so these are wine in context - but "JAPANESE WHISKEY" must have
#: already matched as a spirit before "japanese" is ever consulted.
WINE_REGION_TERMS: frozenset[str] = frozenset({
    "italian", "french", "spanish", "german", "austrian", "portuguese",
    "argentina", "argentinian", "chile", "chilean", "australia", "australian",
    "zealand", "african", "armenian", "georgian", "greek", "hungarian",
    "israeli", "lebanese", "japanese", "oregon", "washington", "california",
    "napa", "sonoma", "tuscany", "rioja", "mendoza",
})

#: The DATED family. Grouped by shelf life, so ready-to-drink and hard seltzer
#: sit here rather than with spirits: they carry freshness coding and a surplus
#: case is marked down, which is the thing the hazard is pricing.
BEER_TERMS: frozenset[str] = frozenset({
    "beer", "beers", "ale", "ales", "lager", "lagers", "pilsner", "stout",
    "porter", "ipa", "cider", "ciders", "seltzer", "seltzers", "kombucha",
    "cooler", "coolers", "spritzer", "spritzers", "rtd", "rtds", "malt",
    "microbrewery", "brewery", "brew", "radler", "shandy",
})

#: Not stock. A deposit, a tax line, a lottery payout or a register shortcut has
#: no shelf and no holding cost, and must never be given a liquor family.
NON_STOCK_TERMS: frozenset[str] = frozenset({
    "tax", "taxes", "taxable", "nontaxable", "crv", "deposit", "lotto",
    "lottery", "scratch", "scratcher", "scratchers", "shortcut", "coupon",
    "manual", "payout", "vendor", "credit", "card", "delivery", "fee",
    "none", "misc", "miscellaneous", "other", "n/a", "na",
})


def _boundary_re(terms: frozenset[str]) -> re.Pattern[str]:
    """Match any term as a whole word.

    `re.escape` because "n/a" and "rosé" are in there, and `\\b` because
    substring matching is the defect this module was written to avoid. Built
    once at import; these sets never change at runtime.
    """
    joined = "|".join(re.escape(t) for t in sorted(terms, key=len, reverse=True))
    return re.compile(r"\b(?:" + joined + r")\b", re.IGNORECASE)


_SPIRITS_RE = _boundary_re(SPIRITS_TERMS)
_WINE_RE = _boundary_re(WINE_TERMS)
_WINE_REGION_RE = _boundary_re(WINE_REGION_TERMS)
_BEER_RE = _boundary_re(BEER_TERMS)
_NON_STOCK_RE = _boundary_re(NON_STOCK_TERMS)


def category_family_of(category: str | None) -> str | None:
    """The canonical family for a raw POS category string, or None.

    None means "this cannot be named", and that is a legitimate answer in three
    distinct situations which the caller does not need to tell apart: the store
    sends no category at all (five of ten audited stores), the string is not
    stock (a tax line, a deposit, a lottery payout), or it is stock this module
    will not guess at (perishable grocery).

    Returns one of "spirits", "wine", "beer", or None - exactly the keys that
    `OBSOLESCENCE_HAZARD_BY_FAMILY` and `SERVICE_LEVEL_BY_FAMILY` share, minus
    "default", which is the caller's fallback rather than a classification.
    """
    if not category:
        return None
    text = category.strip()
    if not text:
        return None

    # Drink types first, most specific axis first. A string naming a spirit is a
    # spirit even if it also names a wine region.
    if _SPIRITS_RE.search(text):
        return "spirits"
    if _BEER_RE.search(text):
        return "beer"
    if _WINE_RE.search(text):
        return "wine"

    # Not stock, checked BEFORE regions: "TAX GROC" must not fall through to a
    # region match, and a bare "NONE" must not be classified at all.
    if _NON_STOCK_RE.search(text):
        return None

    # Only now a region, because by here nothing has named a drink type.
    if _WINE_REGION_RE.search(text):
        return "wine"
    return None


__all__ = [
    "BEER_TERMS",
    "NON_STOCK_TERMS",
    "SPIRITS_TERMS",
    "WINE_REGION_TERMS",
    "WINE_TERMS",
    "category_family_of",
]
