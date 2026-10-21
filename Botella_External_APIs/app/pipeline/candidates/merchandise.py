"""Is this line a product, or a till mechanic wearing a SKU?

THE DEFECT, FROM THE BACKTEST REPORTS
    Top-earning "recommendations" included SKU `0123456789` moving 3,506 units
    per 28 days, `S50`, `SKU 12` priced at ten cents (California's CRV bottle
    deposit), and bags of ice. None of them is a purchasing decision. Ice is not
    ordered from a distributor on a four-week lead time, a deposit is not
    stocked, and `0123456789` is a placeholder somebody typed.

    They dominated the top of the table precisely BECAUSE they are mechanics:
    a deposit rung on every transaction has enormous volume and a trailing
    window that wobbles with footfall, which is exactly the shape sheet 20 is
    looking for. The engine was working correctly on data that should never
    have reached it.

WHY THIS IS A CONTRACT AND NOT A BLOCKLIST
    A hand-maintained list of bad SKUs is a list that is correct on the day it
    is written. These are RULES about what a product looks like, so a new till
    mechanic at a new store is caught without anyone adding it:

      - a SKU that is an obvious placeholder (0123456789, 1234, all zeros)
      - a name that says what it is (deposit, CRV, bag of ice, gift card, fee)
      - a price at or below a deposit threshold, which no bottle has
      - a SKU too short to be a barcode or an internal code

    Each rule carries its own name in the refusal so a store owner asking "why
    is my biggest seller missing" gets an answer rather than a shrug.

WHAT THIS DELIBERATELY DOES NOT DO
    It does not judge a product by its margin, its category, or how slowly it
    sells - those are commercial decisions that belong to the materiality floor
    and the ranking. This answers one question: is the thing on this line
    something the store BUYS. Nothing more.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from app.pipeline.candidates.non_stock import (
    category_is_non_stock,
    non_stock_term_in,
)
from app.pipeline.context import RunContext
from app.pipeline.registry import ConfigRegistry, Setting, cfg

MIN_MERCHANDISE_PRICE = Setting(
    name="merchandise.min_price",
    default=0.5,
    unit="currency per unit",
    owner="commercial",
    why="MEASURED, and demoted from a refusal to a FLAG once measured. "
        "California's CRV is 5-10 cents and was reaching the top of the "
        "recommendation table on volume alone, so a price floor looked like a "
        "clean way to exclude deposits. Run against Bethany it refused 187 "
        "lines that were real bottles with broken price fields - St. George "
        "Baller Single Malt, Ilegal Joven Mezcal, Monte Cristo Espada. The "
        "name and placeholder rules catch every mechanic on their own, so this "
        "now marks a suspect price for someone to look at instead of deleting "
        "the product",
    status="MEASURED",
)

MIN_SKU_LENGTH = Setting(
    name="merchandise.min_sku_length",
    default=2,
    unit="characters",
    owner="data quality",
    why="MEASURED, and cut from 4 to 2 after auditing all ten stores. At 4 it "
        "refused `417 E&J VS Brandy 200ml`, `443 Bud Light 12pk`, `105 Keg "
        "Miller Lite` and `3A Adictivo Anejo 50ml` - plenty of stores number "
        "their own stock in three digits and kegs almost always do. Only a "
        "single character is safe to refuse: that is a department key on the "
        "till, not an item. Length turned out to carry almost no signal here",
    status="MEASURED",
)

#: Names that say plainly they are not merchandise. Substring, case-insensitive.
#: Written as words rather than SKUs so a new store's spelling is caught too.
NON_MERCHANDISE_TERMS: tuple[str, ...] = (
    # Deposits and container charges.
    "crv", "deposit", "bottle fee", "bag fee", "keg deposit", "tap deposit",
    "tub deposit", "tap rental", "corkage",
    # Not stock at all.
    "gift card", "gift cert", "store credit", "calling card",
    "lottery", "lotto", "scratch off", "scratch-off",
    "cash back", "cashback", "paid-out", "paid out",
    "delivery fee", "service fee", "convenience fee", "surcharge",
    "bar transfer", "general merchandise", "non_inventory", "non inventory",
    # Ice, as a phrase - never the bare word, which is inside "juice",
    # "spiced", "Prosecco Ice" and a hundred real products.
    "ice bag", "bag of ice", "bagged ice", "cubed ice", "block ice",
    # Catch-all departments, prefixed so "Miscellaneous" alone is not enough.
    "misc wine", "misc beer", "misc liquor", "misc spirits",
    "open item", "open dept",
    # Register corrections.
    "manual entry", "rounding", "adjustment",
    # TAX, AS A WORD. Restored after a second audit, against the whole estate.
    #
    # `REMOVED_TERMS` below records "tax " being dropped as "too close to real
    # words to be worth the risk". That was right about the SUBSTRING and wrong
    # about the word, and the trailing space also let every name ENDING in tax
    # through - "1 Liter Liquor Tax", "10*50ML LIQUOR TAX", "Cnty Tax".
    #
    # Audited over 621,053 distinct names estate-wide:
    #
    #   as a WORD        193 names, and every one is a register tax line -
    #                    "TAX GROCERY", "TOBACCO TAX", "VODKA MIX TAX 355ML",
    #                    "Variable Price NO TAX", "1/2 KEG COUNTY TAX"
    #   as a SUBSTRING   179 further names, and every one is a REAL product:
    #                    Metaxa Ouzo Liqueur, CyderPunk Syntax Cider, Paketaxo
    #                    chips, 7 STAX tablets, and the lottery tickets named
    #                    "$100,000 TAXES PAID"
    #
    # The word-boundary machinery below - built for the GROUNDING/rounding
    # lesson - is exactly what separates the two, which is why this belongs here
    # and not in REMOVED_TERMS.
    "tax",
)

#: TERMS DELIBERATELY REMOVED AFTER AUDITING ALL TEN STORES' CATALOGUES.
#: Each of these matched real, orderable stock:
#:
#:   "department"  -> "Department 66 Others Grenache" is a WINERY
#:   "discount"    -> a store called "Bethany Discount Liquor" names products
#:                    after itself
#:   "tax "        -> as a SUBSTRING, yes. Superseded: the bare word "tax" is
#:                    in NON_MERCHANDISE_TERMS above, where the word-boundary
#:                    rule spares Metaxa, Syntax and Paketaxo while still
#:                    catching the 193 real tax lines - including the ones
#:                    ending in it, which this trailing space let through
#:   "void"        -> a substring of ordinary English
#:   "misc "       -> "MISC WINE" is a department; "Miscellany" is a gin
#:   "coupon"      -> matched nothing real here, but it is a promotion on a
#:                    line rather than a thing on a shelf, and the line still
#:                    carries units that belong in a rate
#:
#: The list above is therefore phrases, not words. That is the whole lesson.
REMOVED_TERMS: tuple[str, ...] = (
    "department", "discount", "tax ", "void", "misc ", "coupon", "refund",
    "atm ", "recycl", "sundry",
)


#: SKUs that are unambiguously not product codes. EXACT forms only.
#:
#: THE FIRST VERSION OF THIS WAS A DISASTER AND IT IS WORTH RECORDING WHY.
#: It tried to match "an ascending run of digits" as `0*1?2?3?4?5?6?7?8?9?0?`,
#: which looks reasonable and matches almost every number: 1690 (Absolut
#: Mandrin), 1389 (Paul Masson brandy), 12390 (Moet & Chandon Imperial Rose).
#: Audited against all ten stores it would have deleted real bottles across the
#: estate to tidy up a handful of placeholders.
#:
#: A filter that removes real stock is worse than the mess it cleans up, so
#: this now lists forms rather than describing a shape.
PLACEHOLDER_SKU = re.compile(
    r"""^(?:
          0{3,}                      # 000, 00000000 - a real store uses these
        | 0123456789
        | 1234567890
        | 123456789?
        | (\d){3,}                # 1111, 99999 - one digit four or more times
        | test\W*\d*
        | dummy\W*\d*
        | sample\W*\d*
        | temp\W*\d*
        | manual\W*\d*
        | sku\W*\d*
        | item\W*\d*
        | n/?a
        | unknown
        | none
        )$""",
    re.IGNORECASE | re.VERBOSE)



#: Single words are matched on WORD BOUNDARIES; phrases as substrings.
#:
#: WHY, AND IT COST A REAL PRODUCT TO LEARN. Matching "rounding" as a plain
#: substring refused "LYNX POLARIZED GROUNDING AD." - g-rounding. A bare
#: substring test on short words silently eats anything that contains them, and
#: the failure is invisible because the refused line simply never appears.
_WORD_TERMS = tuple(t for t in NON_MERCHANDISE_TERMS if " " not in t.strip())
_PHRASE_TERMS = tuple(t for t in NON_MERCHANDISE_TERMS if " " in t.strip())
_WORD_RE = re.compile(
    r"\b(?:" + "|".join(re.escape(t.strip()) for t in _WORD_TERMS)
    + r")\b",
    re.IGNORECASE) if _WORD_TERMS else None


def _name_hit(name: str) -> str | None:
    """The term that refuses this name, or None. Phrases first, because a
    phrase match is the more specific statement."""
    lowered = name.lower()
    for term in _PHRASE_TERMS:
        if term in lowered:
            return term.strip()
    if _WORD_RE is not None:
        m = _WORD_RE.search(name)
        if m:
            return m.group(0).lower()
    return None


@dataclass(frozen=True, slots=True)
class MerchandiseVerdict:
    """Whether a line is a product, and which rule decided."""

    is_merchandise: bool
    rule: str | None
    detail: str | None

    def as_dict(self) -> dict[str, Any]:
        return {"is_merchandise": self.is_merchandise, "rule": self.rule,
                "detail": self.detail}


def classify(
    sku: str,
    product_name: str | None,
    unit_price: float | None,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
    *,
    pos_category: str | None = None,
) -> MerchandiseVerdict:
    """Is this something the store buys from a distributor?

    Returns the RULE that refused it, never a bare False. A store owner asking
    why a line is missing from their recommendations deserves the reason, and a
    refusal nobody can explain is a refusal nobody can appeal.
    """
    code = (sku or "").strip()
    name = (product_name or "").strip()

    if not code:
        return MerchandiseVerdict(False, "no_sku", "the line carries no SKU")

    if PLACEHOLDER_SKU.match(code):
        return MerchandiseVerdict(
            False, "placeholder_sku",
            f"{code!r} is a placeholder or keypad shortcut, not a product code")

    # LENGTH IS ALMOST USELESS HERE, AND THAT WAS ALSO MEASURED.
    # A four-character minimum refused `417 E&J VS Brandy 200ml`,
    # `105 Keg Miller Lite`, `443 Bud Light 12pk` and `3A Adictivo Anejo 50ml`.
    # Plenty of stores number their own stock in three digits, and kegs almost
    # always are. Only a single character is safe to refuse - that is a
    # department key on the till, not an item.
    min_len = int(config.get(MIN_SKU_LENGTH, ctx))
    if len(code) < min_len:
        return MerchandiseVerdict(
            False, "sku_too_short",
            f"{code!r} is a single character - a till department key, not a "
            f"product code")

    hit = _name_hit(name)
    if hit:
        return MerchandiseVerdict(
            False, "non_merchandise_name",
            f"{name!r} contains {hit!r} - a till mechanic, not stock")

    # THE THIRD SCREEN. A real product that is not a beverage this engine models.
    #
    # The two rules above catch till mechanics - card, coupon, fee. They do not
    # catch a carton of cigarettes, which has a real SKU, a real price and real
    # sales, and which reached a customer at rank 5 as `MARLBORO GLD`. On the
    # measured path, screening this class moved the pooled 30-day hit rate from
    # 68.9% to 75.7% - and LOWERED Northlake from 54.7% to 50.8%, because its
    # lottery lines had been inflating it.
    #
    # The POS CATEGORY is tested first because it is the stronger test: it defers
    # to the taxonomy, so a category naming a drink type is stock whatever else
    # the string says. The live route does not always carry one, which is why the
    # name test exists at all rather than instead.
    if pos_category and category_is_non_stock(pos_category):
        return MerchandiseVerdict(
            False, "non_stock_category",
            f"POS category {pos_category!r} is not a stocked line")

    # TOBACCO IS IN SCOPE, and the setting is resolved here because this is where
    # the context lives. The sentence below no longer says "not a beverage" about
    # a carton of cigarettes: what is refused here is a line with a price and a
    # volume and no demand this model describes - a scratchcard, not a product
    # the store reorders.
    term = non_stock_term_in(name, ctx, config)
    if term:
        return MerchandiseVerdict(
            False, "non_stock_product",
            f"{name!r} contains {term!r} - priced and sold, and not a line whose "
            f"demand this engine models")

    # PRICE IS A FLAG, NOT A REFUSAL - and this was measured the hard way.
    #
    # A sub-floor price looked like a reliable deposit signal. Run against
    # Bethany it refused 187 lines, and they were REAL BOTTLES: St. George
    # Baller Single Malt 750ml, Ilegal Joven Mezcal 375ml, Monte Cristo Espada.
    # Those are not deposits priced at ten cents; they are real stock with a
    # broken price field, and excluding them would have deleted genuine
    # merchandise to tidy up a data error.
    #
    # The name and placeholder rules above already catch every mechanic the
    # reports surfaced - CRV, deposits, ice, gift cards, `SKU 12`, `S50`,
    # `0123456789`. The price rule added nothing except false negatives, so it
    # reports rather than refuses. A mispriced bottle is a data-quality finding
    # worth showing someone, not a line to drop silently.
    floor = float(config.get(MIN_MERCHANDISE_PRICE, ctx))
    if unit_price is not None and 0 < unit_price < floor:
        return MerchandiseVerdict(
            True, None,
            f"kept, but unit price {unit_price:.2f} is below {floor:.2f} - "
            f"probably a broken price field rather than a real price")

    return MerchandiseVerdict(True, None, None)


def is_merchandise(
    sku: str,
    product_name: str | None,
    unit_price: float | None,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
    *,
    pos_category: str | None = None,
) -> bool:
    """`classify(...)` reduced to a boolean, for callers that only filter."""
    return classify(sku, product_name, unit_price, ctx, config,
                    pos_category=pos_category).is_merchandise


__all__ = [
    "MIN_MERCHANDISE_PRICE",
    "MIN_SKU_LENGTH",
    "NON_MERCHANDISE_TERMS",
    "REMOVED_TERMS",
    "PLACEHOLDER_SKU",
    "MerchandiseVerdict",
    "classify",
    "is_merchandise",
]
