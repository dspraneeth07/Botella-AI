"""Category resolution: normalize messy POS categories, classify from product
name as a fallback.

Real stores send categories in inconsistent shapes — ``BEER`` / ``Beer`` /
``beer``, ``Liquor  - Whiskey`` (leading-token + double space), ``Beer  - IPA``,
plus junk like ``DNR`` or empty strings. ~74% of rows carry a category; the rest
need to be inferred from the product name.

Both paths funnel into one controlled vocabulary of canonical tokens, which is
what ``SIGNAL_CATEGORY_MAP`` keys off and what ``family_of`` maps to the
beer/wine/spirits health-threshold families.

Resolution order for each product:
    normalize_category(raw)  →  classify_from_name(name)  →  "uncategorized"
"""

from __future__ import annotations

import re
import unicodedata

# Values that mean "no category" — coerced to None so the classifier kicks in.
_JUNK = {
    "", "dnr", "do not reorder", "na", "n a", "none", "null", "misc",
    "miscellaneous", "other", "unknown", "uncategorized", "general", "default",
}

# Ordered most-specific → least-specific. The first keyword found (matched on
# word boundaries) wins, so multiword phrases and disambiguators come first
# (e.g. "cabernet" before "sauvignon"; "white claw" before bare "white").
_KEYWORDS: list[tuple[str, str]] = [
    # --- beer brands that imply a style ---
    ("modelo", "beer_mexican"), ("corona", "beer_mexican"), ("pacifico", "beer_mexican"),
    ("tecate", "beer_mexican"), ("dos equis", "beer_mexican"), ("negra modelo", "beer_mexican"),
    # Disambiguator: must precede the bare "red" color fallback below, which
    # would otherwise classify Red Stripe as red wine.
    ("red stripe", "beer_lager"),
    # --- RTD / seltzer brands ---
    ("white claw", "seltzer"), ("truly", "seltzer"), ("high noon", "rtd"),
    ("twisted tea", "rtd"), ("cutwater", "rtd"), ("on the rocks", "rtd"),
    # --- spirits (multiword first) ---
    ("irish whiskey", "irish_whiskey"), ("irish whisky", "irish_whiskey"),
    ("single malt", "scotch"), ("bourbon", "bourbon"), ("rye", "rye"),
    ("scotch", "scotch"), ("whiskey", "whiskey"), ("whisky", "whiskey"),
    ("tequila", "tequila"), ("mezcal", "mezcal"), ("vodka", "vodka"),
    ("gin", "gin"), ("spiced rum", "rum"), ("rum", "rum"),
    ("cognac", "brandy"), ("brandy", "brandy"), ("fireball", "fireball"),
    ("baileys", "baileys"), ("irish cream", "baileys"),
    ("triple sec", "liqueur"), ("amaretto", "liqueur"), ("schnapps", "liqueur"),
    ("vermouth", "liqueur"), ("sambuca", "liqueur"), ("kahlua", "liqueur"),
    ("cointreau", "liqueur"), ("liqueur", "liqueur"), ("aperitif", "liqueur"),
    # --- beer (multiword first) ---
    ("hard seltzer", "seltzer"), ("seltzer", "seltzer"), ("pale ale", "beer_ale"),
    ("ipa", "beer_ipa"), ("lager", "beer_lager"), ("pilsner", "beer_lager"),
    ("pils", "beer_lager"), ("stout", "stout"), ("porter", "porter"),
    ("hefeweizen", "beer_ale"), ("wheat", "beer_ale"), ("ale", "beer_ale"),
    ("cider", "cider"),
    # --- wine: reds (before whites so "cabernet sauvignon" -> red; "white
    # zinfandel" before bare "zinfandel" or first-match-wins calls it red) ---
    ("white zinfandel", "wine_rose"),
    ("cabernet", "wine_red"), ("merlot", "wine_red"), ("pinot noir", "wine_red"),
    ("malbec", "wine_red"), ("syrah", "wine_red"), ("shiraz", "wine_red"),
    ("zinfandel", "wine_red"), ("sangiovese", "wine_red"), ("tempranillo", "wine_red"),
    ("red blend", "wine_red"),
    # --- wine: whites ---
    ("chardonnay", "wine_white"), ("sauvignon blanc", "wine_white"), ("sauvignon", "wine_white"),
    ("pinot grigio", "wine_white"), ("pinot gris", "wine_white"), ("riesling", "wine_white"),
    ("moscato", "wine_white"), ("gewurztraminer", "wine_white"),
    # --- sparkling ---
    ("champagne", "champagne"), ("prosecco", "prosecco"), ("cava", "sparkling"),
    ("spumante", "sparkling"), ("sparkling", "sparkling"), ("brut", "sparkling"),
    # --- wine color words (last, after varietals/brands) ---
    ("rose", "wine_rose"), ("blush", "wine_rose"),
    ("red", "wine_red"), ("white", "wine_white"),
]

# canonical token -> health-threshold family
_FAMILY: dict[str, str] = {}
for _t in ("beer", "beer_ipa", "beer_ale", "beer_lager", "beer_mexican",
           "stout", "porter", "cider", "seltzer", "rtd"):
    _FAMILY[_t] = "beer"
for _t in ("wine", "wine_red", "wine_white", "wine_rose", "champagne", "prosecco", "sparkling"):
    _FAMILY[_t] = "wine"
for _t in ("spirits", "bourbon", "rye", "scotch", "whiskey", "irish_whiskey", "tequila",
           "mezcal", "vodka", "gin", "rum", "brandy", "fireball", "baileys", "liqueur"):
    _FAMILY[_t] = "spirits"

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def norm_text(s: str) -> str:
    """Lowercase, strip accents, collapse non-alphanumerics to single spaces,
    and pad with spaces so keyword checks match on word boundaries. Public:
    candidate selection uses it to match analyst product keywords to names."""
    ascii_s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    return " " + " ".join(_NON_ALNUM.sub(" ", ascii_s.lower()).split()) + " "


def _resolve_text(text: str) -> str | None:
    padded = norm_text(text)
    for keyword, token in _KEYWORDS:
        if f" {keyword} " in padded:
            return token
    # Generic family fallback.
    if " beer " in padded:
        return "beer"
    if " wine " in padded:
        return "wine"
    if any(w in padded for w in (" liquor ", " spirits ", " spirit ")):
        return "spirits"
    return None


def normalize_category(raw: str | None) -> str | None:
    """Map a raw POS category string to a canonical token, or None if junk/empty."""
    if not raw:
        return None
    if norm_text(raw).strip() in _JUNK:
        return None
    return _resolve_text(raw)


def classify_from_name(product_name: str | None) -> str | None:
    """Infer a canonical token from the product name (fallback path)."""
    if not product_name:
        return None
    return _resolve_text(product_name)


def resolve_category(
    raw: str | None, product_name: str | None, *, classify: bool = True
) -> str:
    """Resolve to a canonical token: raw category first, then product name,
    then ``"uncategorized"``."""
    token = normalize_category(raw)
    if token:
        return token
    if classify:
        token = classify_from_name(product_name)
        if token:
            return token
    return "uncategorized"


def family_of(token: str | None) -> str:
    """beer / wine / spirits / default — drives inventory-health thresholds."""
    return _FAMILY.get((token or "").lower(), "default")


def match_keywords(text: str) -> list[tuple[str, str]]:
    """All (keyword, canonical token) pairs found word-bounded in ``text``.

    Public: the social-trend keyword floor uses it to spot drink terms in
    Reddit post titles ("high noon", "espresso martini") without the LLM
    analyst, reusing the same vocabulary the categorizer matches shelf
    products with — so a matched term is by construction name-matchable
    back to inventory.
    """
    padded = norm_text(text)
    return [(kw, token) for kw, token in _KEYWORDS if f" {kw} " in padded]


def family_members(family: str) -> set[str]:
    """All canonical tokens belonging to a beer/wine/spirits family.

    Used by ``app.signals.mapping`` to expand a generic family token (a signal
    mapped to ``"beer"``) into every granular token the categorizer can emit
    (``beer_ipa``, ``stout``, ...), so well-categorized inventories don't fall
    out of signal eligibility on an exact-token comparison.
    """
    return {token for token, fam in _FAMILY.items() if fam == family}


# ─── Drink-term gate (trend signals) ─────────────────────────────────────────
# The product vocabulary above is BRAND/style-oriented: it classifies shelf
# names ("High Noon Peach 4pk"), not cocktail culture ("negroni", "espresso
# martini" -> None). Trend terms minted from social media need their own
# deterministic gate, or a viral "shrimp cocktail recipe" food video becomes
# an owner-facing "shrimp cocktail · trending" chip (store-171 report — the
# YouTube discovery query is literally "cocktail recipe", and the analyst's
# term string was previously trusted unchecked).

# Drink words social trends are actually made of: cocktail names, drink nouns,
# and generic spirit/style words. Word-bounded matching via norm_text.
_DRINK_TERMS: frozenset[str] = frozenset({
    # cocktails / serves
    "cocktail", "margarita", "martini", "mojito", "negroni", "spritz",
    "sangria", "paloma", "daiquiri", "mimosa", "cosmopolitan", "manhattan",
    "old fashioned", "aperol", "amaro", "amaretto", "highball", "mule",
    "toddy", "punch", "sour", "fizz", "spritzer", "michelada", "mai tai",
    "pina colada", "bloody mary", "espresso martini", "gimlet", "julep",
    "sazerac", "boulevardier", "shandy", "radler", "sgroppino", "bellini",
    "shot", "shooter", "chaser", "nightcap", "aperitivo", "aperitif",
    "digestif", "hard seltzer", "hard cider", "hard lemonade", "hard tea",
    # drink nouns / categories
    "beer", "wine", "vodka", "whiskey", "whisky", "bourbon", "scotch", "rye",
    "tequila", "mezcal", "rum", "gin", "brandy", "cognac", "liqueur",
    "ipa", "lager", "stout", "pilsner", "ale", "rose", "champagne",
    "prosecco", "cava", "seltzer", "cider", "sake", "soju", "mead",
    "vermouth", "bitters", "absinthe", "schnapps", "moonshine", "spirits",
    "drink", "drinks", "mocktail", "non alcoholic", "zero proof",
})

# Food words that OVERRIDE everything: "shrimp cocktail" contains "cocktail"
# but shrimp makes it an appetizer, and no analyst category vote rescues it.
# Deliberately concrete dishes/proteins — never drink-adjacent words.
_FOOD_TERMS: frozenset[str] = frozenset({
    "shrimp", "prawn", "chicken", "beef", "steak", "pork", "bacon", "ham",
    "salmon", "tuna", "fish", "crab", "lobster", "oyster", "ceviche",
    "pasta", "noodle", "noodles", "salad", "sandwich", "burger", "pizza",
    "taco", "tacos", "burrito", "wings", "meatball", "meatballs", "sausage",
    "cake", "cookie", "cookies", "brownie", "dessert", "pie", "cupcake",
    "sauce", "dressing", "marinade", "dip", "soup", "stew", "casserole",
    "latte", "smoothie", "milkshake", "boba", "frappuccino",
})


def is_drink_term(term: str, analyst_categories: list[str] | None = None) -> bool:
    """Deterministic gate: may this trend term reach the owner as a signal?

    Three tiers, food-denial first:
      1. Any food word in the term -> REJECTED, no appeal ("shrimp cocktail").
      2. Any drink-lexicon word or product-vocabulary keyword in the term ->
         accepted ("espresso martini", "spicy margarita", "white claw").
      3. Neither hit (an unknown brand like "buzzballz"): accepted ONLY when
         the analyst supplied at least one canonical drink category — the one
         LLM output that is enum-validated. No category, no chip.
    """
    padded = norm_text(term)
    if any(f" {food} " in padded for food in _FOOD_TERMS):
        return False
    if any(f" {word} " in padded for word in _DRINK_TERMS):
        return True
    if any(f" {kw} " in padded for kw, _ in _KEYWORDS):
        return True
    return bool(analyst_categories)
