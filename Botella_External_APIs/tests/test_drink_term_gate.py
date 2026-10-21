"""The deterministic drink-term gate: no more "shrimp cocktail · trending".

A viral food video matched by the literal YouTube query "cocktail recipe"
used to mint an owner-facing trend chip because the analyst's term string was
trusted unchecked. The gate is three-tier: food words reject with no appeal,
drink-lexicon/vocabulary words accept, and an unknown brand needs at least
one enum-valid analyst category to pass.
"""

from __future__ import annotations

from app.signals.social import TrendPost
from app.signals.trend_analyst import apply_analysis
from app.store_data.categorize import is_drink_term


def _post(title: str, platform: str = "youtube", score: int = 100_000) -> TrendPost:
    origin = "YouTube: FoodTube" if platform == "youtube" else "r/cocktails"
    return TrendPost(title=title, origin=origin, platform=platform, score=score)


def test_food_words_reject_with_no_appeal() -> None:
    # Even a (confused) analyst category vote cannot rescue an appetizer.
    assert not is_drink_term("shrimp cocktail", ["rtd"])
    assert not is_drink_term("birria tacos", ["beer_mexican"])
    assert not is_drink_term("chicken wings", [])


def test_cocktail_lexicon_accepts_real_trends() -> None:
    for term in ("espresso martini", "negroni", "mojito", "amaro",
                 "old fashioned", "spicy margarita", "fruit punch",
                 "non alcoholic beer"):
        assert is_drink_term(term, []), term


def test_unknown_brand_needs_an_analyst_category() -> None:
    assert is_drink_term("buzzballz", ["rtd"])
    assert not is_drink_term("buzzballz", [])


def test_apply_analysis_drops_food_terms_before_they_take_slots() -> None:
    posts = [
        _post("INSANE shrimp cocktail recipe", score=5_000_000),
        _post("espresso martini three ways", platform="reddit", score=800),
    ]
    items = [
        {"term": "shrimp cocktail", "relevant": True, "post_indexes": [0],
         "categories": ["rtd"], "product_keywords": []},
        {"term": "espresso martini", "relevant": True, "post_indexes": [1],
         "categories": ["liqueur"], "product_keywords": ["kahlua"]},
    ]
    signals, keys, categories, keywords = apply_analysis(posts, items)
    assert [s.term for s in signals] == ["espresso martini"]
    assert keys == ["trend_espresso_martini"]
    assert "shrimp cocktail" not in keywords


def test_ranking_normalizes_youtube_views_against_reddit_upvotes() -> None:
    # 100k views (=500 normalized) must not outrank 800 upvotes; the raw
    # summed score still displays as-is on the kept signal.
    posts = [
        _post("mojito hacks", platform="youtube", score=100_000),
        _post("negroni week megathread", platform="reddit", score=800),
    ]
    items = [
        {"term": "mojito", "relevant": True, "post_indexes": [0],
         "categories": [], "product_keywords": []},
        {"term": "negroni", "relevant": True, "post_indexes": [1],
         "categories": [], "product_keywords": []},
    ]
    signals, _, _, _ = apply_analysis(posts, items, max_kept=1)
    assert [s.term for s in signals] == ["negroni"]
    assert signals[0].score == 800


def test_solo_modest_video_cannot_mint_a_trend() -> None:
    # The store-171 report: 90k/72k-view videos were anchoring chips. With
    # production floors (min 2 mentions, solo bar 2500 normalized), a lone
    # 90k-view video (450 normalized) is thin evidence and drops; a lone
    # 600k-view video (3000) or a two-supporter term still carries.
    posts = [
        _post("frozen margarita machine", score=90_000),
        _post("dirty martini deep dive", score=600_000),
        _post("ranch water is back", score=72_000),
        _post("ranch water recipes thread", platform="reddit", score=300),
    ]
    items = [
        {"term": "frozen margarita", "relevant": True, "post_indexes": [0],
         "categories": [], "product_keywords": []},
        {"term": "dirty martini", "relevant": True, "post_indexes": [1],
         "categories": [], "product_keywords": []},
        {"term": "ranch water", "relevant": True, "post_indexes": [2, 3],
         "categories": ["rtd"], "product_keywords": []},
    ]
    signals, _, _, _ = apply_analysis(
        posts, items, min_mentions=2, solo_min_score=2500.0
    )
    terms = {s.term for s in signals}
    assert terms == {"dirty martini", "ranch water"}
