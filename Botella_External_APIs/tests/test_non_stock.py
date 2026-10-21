"""The third merchandise screen. Production recommended MARLBORO GLD at rank 5.

The two existing screens catch till mechanics - card, coupon, fee. They do not
catch a carton of cigarettes, which has a real SKU, a real price and real sales.
These tests pin both halves of the fix: the lines that must now be refused, and
the much longer list of real products that must survive it.
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path

import pytest

from app.pipeline.candidates.merchandise import classify, is_merchandise
from app.pipeline.registry import cfg
from app.pipeline.candidates.non_stock import (
    NON_STOCK_PRODUCT_TERMS,
    category_is_non_stock,
    non_stock_term_in,
)
from app.pipeline.context import RunContext


def ctx() -> RunContext:
    return RunContext(
        run_id="run-ns", tenant_id=1, store_id=171, as_of=date(2026, 10, 6),
        snapshot_id="snap-1", config_version="default", seed=0,
        versions={"merchandise": "1.0.0"},
    )


def verdict(name: str, *, sku: str = "0881280052", price: float | None = 19.99,
            category: str | None = None, config=cfg):
    return classify(sku, name, price, ctx(), config, pos_category=category)


# ── The lines that reached a customer ────────────────────────────────────────


def test_the_lines_that_are_not_stock_at_all_are_refused() -> None:
    """Every one of these was returned by the live engine and passed both of the
    existing screens. They stay refused: a scratchcard, a bag of ice and a tray of
    limes have a price and a volume and no demand this model describes."""
    cases = [
        ("$2 SCRATCHOFF", "LOTTO"),
        ("ICE 10LBS", "OTHER"),
        ("LIMES", "OTHER"),
    ]
    for name, category in cases:
        v = verdict(name, category=category)
        assert v.is_merchandise is False, name
        assert v.rule in ("non_stock_product", "non_stock_category"), name
        # The reason is always carried; a refusal nobody can explain is a
        # refusal nobody can appeal.
        assert v.detail, name


def test_tobacco_is_in_scope_by_default() -> None:
    """THE POLICY, and the thing two screens used to disagree about in writing.

    `non_stock.py` said a carton of cigarettes "is not a beverage whose demand
    this engine models" while the measured harness said beside it that cigarettes
    ARE real stock a liquor store reorders. All categories stay in scope, and the
    change was measured first: pooled hit rate 73.2% to 73.3% over 117 decision
    dates at five stores, margin $16,116 to $16,441, on 29 more cards.
    """
    for name in ("MARLBORO GLD", "BLK N MILD $1.19 SPECIAL",
                 "SWISHER SWEETS 2PK", "Copenhagen Long Cut"):
        assert verdict(name).is_merchandise is True, name


def test_candy_soda_and_snacks_were_already_in_scope() -> None:
    """Verified rather than assumed when the policy landed. Only tobacco moved -
    which is worth pinning, because "all categories in scope" invites someone to
    go looking for a screen that never existed."""
    for name, category in (("Snickers Bar", "CANDY"), ("Coca Cola 2L", "SODA"),
                           ("Red Bull 12oz", "ENERGY"),
                           ("Lays Classic", "SNACKS")):
        assert verdict(name, category=category).is_merchandise is True, name


def test_an_operator_can_still_opt_out_of_tobacco_advice() -> None:
    """Not an accuracy argument - a store that does not want to be told what
    cigarettes to buy has a legitimate reason, and the vocabulary is kept so the
    setting has something to turn on."""
    from app.pipeline.candidates.non_stock import TOBACCO_IN_SCOPE
    from app.pipeline.registry import ConfigRegistry

    off = ConfigRegistry(overrides={TOBACCO_IN_SCOPE.name: 0.0})
    for name in ("MARLBORO GLD", "BLK N MILD $1.19 SPECIAL",
                 "SWISHER SWEETS 2PK"):
        assert verdict(name, config=off).is_merchandise is False, name
    # And a real bottle is unaffected either way.
    assert verdict("Fords Gin 1L", config=off).is_merchandise is True


def test_scratchoff_needed_its_own_term_because_of_the_word_boundary() -> None:
    """THE subtle one. The taxonomy already had `scratch`, and the word boundary
    that protects JUICE from ICE also separates `scratch` from `off` - so
    `$2 SCRATCHOFF` passed a vocabulary that appeared to cover it."""
    assert non_stock_term_in("$2 SCRATCHOFF") is not None
    assert non_stock_term_in("SCRATCH OFF $5") is not None
    assert non_stock_term_in("Scratch-Off Ticket") is not None


def test_all_three_spellings_of_the_cigarillo_brand() -> None:
    """`BLK N MILD`, `BLACK N MILD` and `BLACK & MILD` all appear in this
    estate's exports."""
    from app.pipeline.candidates.non_stock import (
        TOBACCO_IN_SCOPE,
        _PHRASE_TERMS_WITH_TOBACCO,
    )
    from app.pipeline.registry import ConfigRegistry

    off = ConfigRegistry(overrides={TOBACCO_IN_SCOPE.name: 0.0})
    for spelling in ("BLK N MILD $1.19 SPECIAL", "BLACK N MILD WINE",
                     "Black & Mild Original", "BLACK AND MILD JAZZ"):
        # In scope by default, so nothing is refused...
        assert non_stock_term_in(spelling) is None, spelling
        # ...and every spelling is still RECOGNISED, which is what keeps the
        # vocabulary honest once the default stopped exercising it.
        assert non_stock_term_in(spelling, ctx(), off) is not None, spelling
    assert all(s in _PHRASE_TERMS_WITH_TOBACCO
               for s in ("blk n mild", "black n mild", "black & mild",
                         "black and mild"))


# ── The much longer list that must SURVIVE ───────────────────────────────────


REAL_STOCK = [
    # The ones a careless term would eat. These are the whole reason `ice`,
    # `lime` and `pack` are deliberately absent from the vocabulary.
    "Smirnoff Ice 6pk",
    "Smirnoff Ice Original 24oz",
    "Bud Light Lime 12pk",
    "Bud Light Lime-A-Rita",
    "Fireball 10 pack",
    "Corona 12 pack",
    "Mike's Hard Lemonade Variety Pack",
    # Previously-measured false negatives from the other two screens.
    "417 E&J VS Brandy 200ml",
    "105 Keg Miller Lite",
    "443 Bud Light 12pk",
    "3A Adictivo Anejo 50ml",
    "LYNX POLARIZED GROUNDING AD.",
    # Ordinary stock, including names containing substrings of banned terms.
    "Fords Gin 1L",
    "Eh Taylor Single Barrel",
    "Hennessy VSOP 750ml",
    "Titos 1.75L",
    "New Amsterdam Pink Whitney 50ml",
    "Yamazaki 12 Year",
    "Ironroot Industrial Luciano",
    "Chewton Glen Pinot Noir",        # contains "chew"
    "Winstead Cellars Chardonnay",    # contains "winst"
    "Camus XO Cognac",                # contains "cam"
    "Dipsomania Red Blend",           # contains "dip"
    "Papillon Rose",                  # contains "pap"
    "Vapor Distilled Gin",            # contains "vap"
]


@pytest.mark.parametrize("name", REAL_STOCK)
def test_real_stock_survives_the_screen(name: str) -> None:
    """A blocklist that grows by guessing starts refusing real bottles. This is
    the list that keeps it honest, and it is deliberately longer than the list of
    things refused."""
    assert non_stock_term_in(name) is None, name
    assert is_merchandise("0881280052", name, 19.99, ctx()) is True, name


def test_a_drink_category_is_stock_whatever_else_the_string_says() -> None:
    """`category_is_non_stock` defers to the taxonomy FIRST: if the string names
    a drink type it is stock. That ordering is why JAPANESE WHISKEY survives, and
    it is the same ordering the harness uses - so the live screen and the measured
    screen cannot disagree."""
    for category in ("BOURBON", "GIN", "JAPANESE WHISKEY", "MALT", "BEER",
                     "WINE", "LIQUEUR", "RUM", "VODKA", "BRANDY"):
        assert category_is_non_stock(category) is False, category


def test_an_absent_category_is_not_a_refusal() -> None:
    """The live route does not always carry a POS category. Absence must mean
    "this test did not run", never "refused"."""
    assert category_is_non_stock(None) is False
    assert category_is_non_stock("") is False
    assert category_is_non_stock("   ") is False
    # And a product with no category still reaches the name test.
    assert verdict("Fords Gin 1L", category=None).is_merchandise is True


# ── The bug that has bitten this repository twice ────────────────────────────


def test_the_word_boundary_is_a_real_backslash_b() -> None:
    """A regex written through a shell heredoc turned its backslash-b into
    chr(8), a literal BACKSPACE, which silently disabled every boundary while
    every behaviour test still passed. Twice. So this asserts BOTH that the
    source carries no backspace byte and that the compiled pattern really
    carries boundaries."""
    source = (Path(__file__).parent.parent / "app" / "pipeline" / "candidates"
              / "non_stock.py").read_bytes()
    assert b"\x08" not in source, "a literal backspace byte is in the source"

    from app.pipeline.candidates import non_stock

    assert non_stock._WORD_RE is not None
    assert non_stock._WORD_RE.pattern.startswith(chr(92) + "b")
    # BOTH matchers, because tobacco moved out of the default one and an
    # unexercised regex is exactly where a backspace hides.
    assert non_stock._WORD_RE_WITH_TOBACCO is not None
    assert non_stock._WORD_RE_WITH_TOBACCO.pattern.startswith(chr(92) + "b")
    # And they behave like boundaries: a term in the set matches on its own...
    assert non_stock._WORD_RE.search("powerball") is not None
    assert non_stock._WORD_RE_WITH_TOBACCO.search("marlboro") is not None
    assert non_stock._WORD_RE.search("premarlboroesque") is None


def test_every_single_word_term_is_boundary_matched() -> None:
    """Embedding any single-word term inside a longer word must not match it."""
    single = [t for t in NON_STOCK_PRODUCT_TERMS if " " not in t and "-" not in t]
    assert single, "there are single-word terms to check"
    for term in single:
        assert non_stock_term_in(f"xx{term}xx") is None, term
        assert non_stock_term_in(f"A {term} B") is not None, term


def test_the_vocabulary_contains_nothing_a_beverage_could_be_called() -> None:
    """The safety property of the whole list. `pack`, `ice` and `lime` are the
    three that were considered and rejected, and a regression that adds one of
    them back fails here rather than in production."""
    banned_from_the_banlist = {"pack", "ice", "lime", "limes", "box", "can",
                               "bottle", "case", "mild", "gold", "crush"}
    for term in NON_STOCK_PRODUCT_TERMS:
        assert term not in banned_from_the_banlist, (
            f"{term!r} can appear in a real beverage name")


def test_phrases_are_reported_before_words() -> None:
    """Reporting `black n mild` is more useful than reporting a bare word."""
    from app.pipeline.candidates.non_stock import TOBACCO_IN_SCOPE
    from app.pipeline.registry import ConfigRegistry

    off = ConfigRegistry(overrides={TOBACCO_IN_SCOPE.name: 0.0})
    term = non_stock_term_in("BLACK N MILD WINE TIP", ctx(), off)
    assert term == "black n mild"


# ── Interaction with the two existing screens ────────────────────────────────


def test_the_existing_screens_still_fire_first() -> None:
    """Order matters only for which REASON is reported, but the reason is the
    point: a store owner asking why a line is missing deserves the real one."""
    # A placeholder lives in the SKU field, not the product name.
    assert verdict("Fords Gin 1L", sku="SKU 12").rule == "placeholder_sku"
    assert verdict("Fords Gin 1L", sku="S").rule == "sku_too_short"
    # A till mechanic lives in the name.
    assert verdict("CRV DEPOSIT").rule == "non_merchandise_name"


def test_a_cheap_real_bottle_is_still_kept() -> None:
    """The price rule reports and does not refuse - it refused 187 real bottles
    at Bethany when it did. The new screen must not have changed that."""
    v = verdict("St. George Baller Single Malt 750ml", price=0.10)
    assert v.is_merchandise is True
    assert v.detail and "below" in v.detail
