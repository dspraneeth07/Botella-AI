from __future__ import annotations

from app.signals.social import TrendPost
from app.signals.trend_analyst import apply_analysis


def _reddit(title: str, subreddit: str, score: int) -> TrendPost:
    return TrendPost(title=title, origin=f"r/{subreddit}", platform="reddit", score=score)


POSTS = [
    _reddit("BuzzBallz haul", "cocktails", 400),
    _reddit("BuzzBallz review megathread", "alcohol", 900),
    _reddit("Rate my home bar", "cocktails", 50),
    _reddit("Sleepy girl mocktail everywhere", "Mixology", 700),
    TrendPost(title="BuzzBallz taste test", origin="YouTube: DrinkLab",
              platform="youtube", score=120000),
]


def test_apply_analysis_grounds_terms_in_cited_posts() -> None:
    items = [
        {
            "term": "BuzzBallz",
            "relevant": True,
            "post_indexes": [0, 1],
            "categories": ["rtd"],
            "product_keywords": ["Buzzballz"],
            "note": "Stock the multipacks — they move fast.",
        }
    ]
    signals, keys, categories, keywords = apply_analysis(POSTS, items)
    assert len(signals) == 1
    signal = signals[0]
    # mentions/score/evidence come from the cited posts, never the model.
    assert signal.term == "buzzballz" and signal.mentions == 2 and signal.score == 1300
    assert signal.evidence == 'r/alcohol: "BuzzBallz review megathread"'
    assert signal.key == "trend_buzzballz"
    # The dash ban applies to analyst notes (owner-facing text).
    assert signal.note == "Stock the multipacks, they move fast."
    assert keys == ["trend_buzzballz"]
    assert categories == ["rtd"]
    # The term itself is always a product-name hint, alongside the analyst's.
    assert keywords == ["buzzballz"]


def test_apply_analysis_discards_ungrounded_and_irrelevant_terms() -> None:
    items = [
        {"term": "invented drink", "relevant": True, "post_indexes": [99]},
        {"term": "no posts", "relevant": True, "post_indexes": []},
        {"term": "home bars", "relevant": False, "post_indexes": [2]},
        {"term": "", "relevant": True, "post_indexes": [0]},
        {"relevant": True, "post_indexes": [0]},
    ]
    assert apply_analysis(POSTS, items) == ([], [], [], [])


def test_apply_analysis_filters_categories_to_vocabulary() -> None:
    items = [
        {
            "term": "sleepy girl mocktail",
            "relevant": True,
            "post_indexes": [3],
            "categories": ["rtd", "tart cherry juice"],
            "product_keywords": ["Tart Cherry", ""],
        }
    ]
    signals, _, categories, keywords = apply_analysis(POSTS, items)
    assert categories == ["rtd"]  # off-vocabulary tokens dropped
    assert keywords == ["sleepy girl mocktail", "tart cherry"]
    assert signals[0].key == "trend_sleepy_girl_mocktail"


def test_apply_analysis_keeps_strongest_terms_first() -> None:
    items = [
        {"term": "weak spritz", "relevant": True, "post_indexes": [2]},
        {"term": "strong negroni", "relevant": True, "post_indexes": [1]},
        {"term": "medium sangria", "relevant": True, "post_indexes": [3]},
    ]
    signals, _, _, _ = apply_analysis(POSTS, items, max_kept=2)
    assert [s.term for s in signals] == ["strong negroni", "medium sangria"]


def test_apply_analysis_dedupes_repeated_indexes() -> None:
    items = [{"term": "buzzballz", "relevant": True,
              "post_indexes": [1, 1, 1], "categories": ["rtd"]}]
    signals, _, _, _ = apply_analysis(POSTS, items)
    assert signals[0].mentions == 1 and signals[0].score == 900


def test_apply_analysis_mixed_platform_source_and_evidence() -> None:
    items = [{"term": "buzzballz", "relevant": True,
              "post_indexes": [0, 1, 4], "categories": ["rtd"]}]
    signals, _, _, _ = apply_analysis(POSTS, items)
    signal = signals[0]
    assert signal.source == "reddit+youtube"
    assert signal.mentions == 3 and signal.score == 121300
    # Evidence is the strongest supporting item across platforms.
    assert signal.evidence == 'YouTube: DrinkLab: "BuzzBallz taste test"'
