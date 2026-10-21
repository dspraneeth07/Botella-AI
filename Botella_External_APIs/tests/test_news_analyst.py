"""Tests for the LLM news analyst: the pure merge logic and its fail-soft
wrapper. The tariff-on-Spain shape is the canonical example: a headline the
keyword pipeline would silently drop becomes categories + product keywords +
a citable key that flow into candidate eligibility."""

from __future__ import annotations

from types import SimpleNamespace

from app.config import Settings
from app.schemas.signals import NewsSignal
from app.signals.news_analyst import analyze, apply_analysis


def _headlines() -> list[NewsSignal]:
    return [
        NewsSignal(headline="Trump announces 25% tariffs on Spanish imports", category="business"),
        NewsSignal(headline="Local team wins big", category="sports"),
    ]


def test_apply_analysis_keeps_only_relevant_items() -> None:
    items = [
        {
            "index": 0,
            "relevant": True,
            "impact": "price_increase_risk",
            "categories": ["wine", "sparkling"],
            "product_keywords": ["Rioja", "cava ", ""],
            "key": "Tariff Spain wine!",
            "note": "Buy Spanish imports before wholesale prices rise.",
        },
        {"index": 1, "relevant": False},
    ]
    kept, keys, categories, keywords = apply_analysis(_headlines(), items)

    assert len(kept) == 1  # the irrelevant headline is dropped entirely
    spain = kept[0]
    assert spain.impact == "price_increase_risk"
    assert spain.key == "news_tariff_spain_wine"  # slugged + news_ prefixed
    assert spain.note == "Buy Spanish imports before wholesale prices rise."
    assert keys == ["news_tariff_spain_wine"]
    assert categories == ["sparkling", "wine"]
    assert keywords == ["cava", "rioja"]  # cleaned + lowercased


def test_apply_analysis_filters_junk() -> None:
    items = [
        {"index": 99, "relevant": True},  # out of range
        {"index": 0, "relevant": True, "impact": "made_up",  # bad impact -> soft context
         "categories": ["wine", "not_a_category"], "key": ""},
    ]
    kept, keys, categories, _ = apply_analysis(_headlines(), items)
    assert len(kept) == 1
    # A garbled direction must never coerce to a directional value: demand_up
    # here once inverted supply-risk stories into promote-this signals.
    assert kept[0].impact is None
    assert kept[0].key == "news_item_0"  # fallback slug
    assert categories == ["wine"]  # unknown vocab dropped
    assert keys == ["news_item_0"]


def test_only_marked_relevant_survive() -> None:
    items = [{"index": 1, "relevant": True, "impact": "demand_up", "key": "local_win"}]
    kept, _, _, _ = apply_analysis(_headlines(), items)
    assert [n.headline for n in kept] == ["Local team wins big"]


async def test_analyze_fail_soft_on_error() -> None:
    class _BoomMessages:
        async def create(self, **_: object) -> object:
            raise RuntimeError("api down")

    client = SimpleNamespace(messages=_BoomMessages())
    settings = Settings(node_api_base_url="http://x", anthropic_api_key="x")
    signals = _headlines()
    enriched, keys, categories, keywords = await analyze(signals, client, settings)  # type: ignore[arg-type]
    # Fail-soft is now fail-quiet: only tracked-topic headlines survive the
    # analyst outage (the broad fetch is recall noise by design), so the
    # tariff story stays and "Local team wins big" is dropped.
    assert [n.headline for n in enriched] == [signals[0].headline]
    assert keys == [] and categories == [] and keywords == []


async def test_analyze_parses_tool_block() -> None:
    tool_block = SimpleNamespace(
        type="tool_use",
        input={
            "items": [
                {"index": 0, "relevant": True, "impact": "price_increase_risk",
                 "categories": ["wine"], "product_keywords": ["rioja"],
                 "key": "tariff_spain", "note": "Buy ahead."}
            ]
        },
    )

    class _Messages:
        async def create(self, **kwargs: object) -> object:
            assert kwargs["tool_choice"] == {"type": "tool", "name": "analyze_news"}
            return SimpleNamespace(content=[tool_block])

    client = SimpleNamespace(messages=_Messages())
    settings = Settings(node_api_base_url="http://x", anthropic_api_key="x")
    enriched, keys, categories, keywords = await analyze(_headlines(), client, settings)  # type: ignore[arg-type]
    assert enriched[0].key == "news_tariff_spain"
    assert keys == ["news_tariff_spain"]
    assert categories == ["wine"] and keywords == ["rioja"]


def test_apply_analysis_caps_kept_items() -> None:
    """max_kept bounds the bundle so every kept item renders in the prompt."""
    signals = [
        NewsSignal(headline=f"Headline {i}", category="business") for i in range(8)
    ]
    items = [
        {"index": i, "relevant": True, "impact": "demand_up", "key": f"k{i}"}
        for i in range(8)
    ]
    kept, keys, _, _ = apply_analysis(signals, items, max_kept=5)
    assert len(kept) == 5
    assert len(keys) == 5  # dropped items contribute no orphan keys
