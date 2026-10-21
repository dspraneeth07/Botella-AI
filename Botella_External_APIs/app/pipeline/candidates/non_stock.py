"""The third merchandise screen: a real product the engine must not model.

WHY THIS EXISTS, AND WHAT IT COST TO FIND
    Production recommended `MARLBORO GLD` at rank 5. The two live screens both
    passed it, and so did `$2 SCRATCHOFF`, `BLK N MILD $1.19 SPECIAL`, `ICE
    10LBS` and `LIMES`. The gap was never the mechanism - `merchandise.py` has
    had word-boundary matching for months - it was the VOCABULARY:

        `NON_MERCHANDISE_TERMS`  till mechanics. card, coupon, fee, deposit, tax.
                                 Things that are not products at all.
        `NON_STOCK_TERMS`        the taxonomy's POS-category words. Catches
                                 `LOTTO` as a CATEGORY, which the live route
                                 does not receive.

    A carton of cigarettes is neither. It is a real product, with a real SKU, a
    real price and real sales - it simply is not a beverage whose demand this
    engine's reversion model describes. Nothing in either vocabulary said so, and
    `scratch` does not match `SCRATCHOFF` precisely because the word boundary
    that protects `JUICE` from `ICE` also separates `scratch` from `off`.

MEASURED, NOT ASSUMED
    Screening these on the measured path moved the pooled 30-day hit rate from
    68.9% to 75.7%. At Northlake it moved the rate DOWN, from 54.7% to 50.8%,
    because lottery and cigarette lines were hitting 6-of-6 and 5-of-6 and
    inflating that store. A screen that only ever raises a score is a screen
    selecting on its own outcome; this one lowered a store and the lower number
    was published.

WHY CATEGORY WORDS AND A SHORT BRAND LIST, AND NOT A BIG BLOCKLIST
    Category words - cigarette, tobacco, lottery - are safe: no beverage is
    called those things. Brand names are not safe in general, so only brands that
    cannot be anything else are listed, and each is a line this estate actually
    sells. A blocklist that grows by guessing starts refusing real bottles, which
    is the failure `merchandise.py` already paid for twice:

        "rounding" as a substring refused LYNX POLARIZED GROUNDING AD.
        a four-character SKU minimum refused `417 E&J VS Brandy 200ml`

WHAT IS DELIBERATELY *NOT* HERE
    `ice` and `lime`. `Smirnoff Ice` is a real malt beverage and `Bud Light Lime`
    is a real beer, so a bare term for either would refuse genuine stock to catch
    a bag of ice and a tray of limes - a trade that loses more than it wins. They
    are caught by POS CATEGORY where one is supplied, which is the right tool,
    and not caught at all where it is not. Stating that is better than a screen
    that silently eats a product line.

THE POS CATEGORY IS THE STRONGER TEST AND IS USED WHEN PRESENT
    `category_is_non_stock` defers to the taxonomy: if a category names a drink
    type it is stock, whatever else the string contains. That is a better test
    than any name rule and it runs wherever the caller has a category.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from app.pipeline.features.taxonomy import (
    NON_STOCK_TERMS,
    category_family_of,
)
from app.pipeline.registry import ConfigRegistry, Setting, cfg

if TYPE_CHECKING:  # the context is only needed to resolve the setting
    from app.pipeline.context import RunContext

TOBACCO_IN_SCOPE = Setting(
    name="merchandise.tobacco_in_scope",
    default=1.0,
    unit="1 to recommend tobacco, 0 to screen it out",
    owner="commercial",
    why="a liquor store buys, sells and reorders cigarettes, and for a while "
        "this module refused them while the measured harness said in writing "
        "that they ARE real stock - two screens in one selection disagreeing on "
        "the page. Measured on five stores over 117 decision dates before the "
        "change: pooled hit rate 73.2% to 73.3%, margin $16,116 to $16,441, on "
        "29 more cards. So it costs nothing and pays a little. It is a SETTING "
        "rather than a deletion because an operator who does not want to give "
        "tobacco advice has a legitimate reason that is not about accuracy, and "
        "the lottery terms it used to share a list with are still screened - a "
        "scratchcard has a price and a volume and no demand this model describes",
    status="MEASURED",
)

#: NOT STOCK AT ALL. A line with a price and a volume and no demand this model
#: describes - you do not reorder a scratchcard because last month was busy.
#:
#: Every entry is matched on a WORD BOUNDARY. Without one, "cigar" eats
#: "cigarette" harmlessly but "chew" would eat "Chewton" and "pack" would eat
#: "Fireball 10 pack" - which is why `pack` is not here and never should be.
NOT_STOCK_TERMS: tuple[str, ...] = (
    # Lottery. `scratch` alone does NOT match `SCRATCHOFF`, because the word
    # boundary that protects JUICE from ICE also separates scratch from off -
    # which is exactly how `$2 SCRATCHOFF` reached a customer.
    "scratchoff", "scratchoffs", "scratch off", "scratch-off",
    "powerball", "mega millions", "megamillions", "pick 3", "pick 4",
    "instant ticket", "lotto ticket",
)

#: TOBACCO. Real stock a liquor store buys, sells and reorders - and for a while
#: this list sat in the same tuple as the lottery terms above, which is how the
#: two merchandise screens came to disagree in writing:
#:
#:     this module  "a carton of cigarettes ... is not a beverage whose demand
#:                   this engine's reversion model describes"
#:     the harness  "soft drinks, juice, tea, snacks and cigarettes ARE real
#:                   stock a liquor store reorders"
#:
#: Policy resolves it: all categories stay in scope. Measured on five stores over
#: 117 decision dates before the change, pooled hit rate 73.2% -> 73.3% and margin
#: $16,116 -> $16,441 on 29 more cards. The 6.8 points recorded when the original
#: screen went in belong to LOTTERY, which is still screened above.
#:
#: Kept as a named list rather than deleted, because `TOBACCO_IN_SCOPE` can turn
#: it back on for an operator who does not want tobacco advice, and because the
#: brands are the evidence for what the term list is FOR.
TOBACCO_TERMS: tuple[str, ...] = (
    # Tobacco, as categories.
    "cigarette", "cigarettes", "cigar", "cigars", "cigarillo", "cigarillos",
    "tobacco", "snuff", "dip tin", "rolling papers", "hookah", "shisha",
    "vape", "e-cig", "ecig", "e-cigarette",
    # Tobacco, as brands this estate actually stocks. Short, and each one
    # unambiguous - no beverage carries these names.
    "marlboro", "newport", "swisher", "backwoods", "copenhagen", "skoal",
    "winston", "pall mall", "lucky strike", "american spirit",
    # "BLK N MILD", "BLACK N MILD", "BLACK & MILD" - all three spellings appear.
    "blk n mild", "black n mild", "black & mild", "black and mild",
)

#: What the screen refuses by default. Tobacco is NOT in it.
NON_STOCK_PRODUCT_TERMS: tuple[str, ...] = NOT_STOCK_TERMS

#: Single words match on word boundaries; phrases match as substrings, because a
#: phrase is already specific enough that a boundary adds nothing.
_WORD_TERMS = tuple(t for t in NON_STOCK_PRODUCT_TERMS if " " not in t)
_PHRASE_TERMS = tuple(t for t in NON_STOCK_PRODUCT_TERMS if " " in t)

#: The same two lists WITH tobacco, for a caller that has turned it out of scope.
#: Both matchers are compiled at import and the caller picks: rebuilding a regex
#: per call to honour a setting is how a screen becomes the slowest thing in the
#: selection.
_WORD_TERMS_WITH_TOBACCO = _WORD_TERMS + tuple(
    t for t in TOBACCO_TERMS if " " not in t)
_PHRASE_TERMS_WITH_TOBACCO = _PHRASE_TERMS + tuple(
    t for t in TOBACCO_TERMS if " " in t)

#: Built with chr(92) + "b" rather than a literal escape. A regex written
#: through a shell heredoc turned its backslash-b into chr(8), a literal
#: BACKSPACE, which silently disabled every boundary while every test that only
#: checked behaviour still passed. That has happened twice in this repository.
_BOUNDARY = chr(92) + "b"

_WORD_RE = re.compile(
    _BOUNDARY + "(?:"
    + "|".join(re.escape(t) for t in sorted(_WORD_TERMS, key=len, reverse=True))
    + ")" + _BOUNDARY,
    re.IGNORECASE,
) if _WORD_TERMS else None

_WORD_RE_WITH_TOBACCO = re.compile(
    _BOUNDARY + "(?:"
    + "|".join(re.escape(t) for t in
               sorted(_WORD_TERMS_WITH_TOBACCO, key=len, reverse=True))
    + ")" + _BOUNDARY,
    re.IGNORECASE,
) if _WORD_TERMS_WITH_TOBACCO else None

#: The POS-category test, promoted from the harness. Word boundaries for the
#: same reason: without them "tax" matches "TAXABLE".
_NON_STOCK_CATEGORY_RE = re.compile(
    _BOUNDARY + "(?:"
    + "|".join(re.escape(t) for t in sorted(NON_STOCK_TERMS, key=len, reverse=True))
    + ")" + _BOUNDARY,
    re.IGNORECASE,
)


def category_is_non_stock(category: str | None) -> bool:
    """Does this POS category name a line that is not stock at all?

    Defers to the taxonomy first: if the string names a drink type it is stock,
    whatever else it contains. That ordering is why `JAPANESE WHISKEY` survives
    and is the same ordering the harness uses, so the live screen and the
    measured screen cannot disagree.
    """
    text = (category or "").strip()
    if not text:
        return False
    if category_family_of(text) is not None:
        return False            # it named a drink type; it is stock
    return _NON_STOCK_CATEGORY_RE.search(text) is not None


def non_stock_term_in(
    product_name: str | None,
    ctx: "RunContext | None" = None,
    config: ConfigRegistry = cfg,
) -> str | None:
    """The term that refuses this product name, or None.

    Phrases before words, because a phrase match is the more specific statement
    and reporting `black n mild` is more useful than reporting `mild`.

    TOBACCO IS IN SCOPE unless `merchandise.tobacco_in_scope` says otherwise, and
    without a `ctx` the default applies - which keeps every existing caller
    working and in scope. Both matchers are compiled at import; the setting picks
    between them rather than rebuilding a regex per product.
    """
    name = (product_name or "").strip()
    if not name:
        return None
    include_tobacco = False
    if ctx is not None:
        include_tobacco = float(config.get(TOBACCO_IN_SCOPE, ctx)) < 1.0
    phrases = _PHRASE_TERMS_WITH_TOBACCO if include_tobacco else _PHRASE_TERMS
    pattern = _WORD_RE_WITH_TOBACCO if include_tobacco else _WORD_RE
    lowered = name.lower()
    for term in phrases:
        if term in lowered:
            return term
    if pattern is not None:
        match = pattern.search(name)
        if match:
            return match.group(0).lower()
    return None


__all__ = [
    "TOBACCO_IN_SCOPE",
    "TOBACCO_TERMS",
    "NOT_STOCK_TERMS",
    "NON_STOCK_PRODUCT_TERMS",
    "category_is_non_stock",
    "non_stock_term_in",
]
