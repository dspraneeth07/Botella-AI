"""LLM news analyst: semantic relevance instead of keyword matching.

The keyword path (``news.keys_for_news``) only recognizes headlines that
contain hardcoded phrases — anything else that could move demand (a tariff on
Spanish imports, a glass-bottle shortage, a local brewery closing) passes
through silently. This module replaces that ceiling with one small, cheap
tool-use call (Haiku by default) that reads the fetched headlines, DROPS the
ones that don't matter to a liquor store (the broad fetch is recall-oriented,
so most headlines are noise), and returns structured analysis per kept
article:

* ``relevant`` / ``impact`` — does it move liquor demand or prices, and how
  (demand_up, demand_down, price_increase_risk, supply_risk).
* ``categories`` — canonical category tokens (the same vocabulary the
  categorizer emits), which widen candidate eligibility exactly like mapped
  signal keys do.
* ``product_keywords`` — words that would appear in affected product names
  ("rioja", "cava"), which drive a name-matched candidate slice tagged
  NEWS_MATCH in the prompt.
* ``key`` / ``note`` — a citable snake_case signal key and a one-line
  so-what, both surfaced on the news line in the prompt.

The analysis runs inside the per-state signal cache, so it costs one Haiku
call per state per TTL (~6h) regardless of store count, and it is fail-soft:
any error falls back to the keyword keys, never sinking a run.
"""

from __future__ import annotations

import re
from typing import Any

from anthropic import AsyncAnthropic

from typing import get_args

from app.config import Settings
from app.logging_config import get_logger
from app.schemas.signals import NewsImpact, NewsSignal
from app.signals.mapping import SIGNAL_CATEGORY_MAP
from app.store_data.categorize import family_members

log = get_logger(__name__)

_TOOL_NAME = "analyze_news"
_IMPACTS = get_args(NewsImpact)
_KEY_SHAPE = re.compile(r"[^a-z0-9_]+")
# Notes reach the owner (prompt line + frontend snapshot); em/en dashes are
# banned from all user-facing and AI-generated text in this product.
_DASHES = re.compile(r"\s*[–—]\s*")


def _clean_note(raw: str | None) -> str | None:
    return _DASHES.sub(", ", (raw or "").strip()) or None


def _vocabulary() -> list[str]:
    cats = family_members("beer") | family_members("wine") | family_members("spirits")
    return sorted(cats | {"beer", "wine", "spirits"})


def _build_tool() -> dict[str, Any]:
    return {
        "name": _TOOL_NAME,
        "description": "Report which headlines affect liquor-store demand or prices, and how.",
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "index": {
                                "type": "integer",
                                "description": "0-based index of the headline being classified.",
                            },
                            "relevant": {"type": "boolean"},
                            "impact": {
                                "type": "string",
                                "enum": list(_IMPACTS),
                                "description": "REQUIRED for every relevant item: "
                                "which way the story moves the store's buying. "
                                "An item without an impact is kept as soft "
                                "context only.",
                            },
                            "categories": {
                                "type": "array",
                                "items": {"type": "string", "enum": _vocabulary()},
                                "description": "Product categories whose demand/price "
                                "this news affects.",
                            },
                            "product_keywords": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Lowercase words/phrases that would appear "
                                "in affected product NAMES on the shelf, e.g. 'rioja', "
                                "'cava', 'tempranillo' for Spanish wine tariffs. Empty if "
                                "the impact is category-wide.",
                            },
                            "key": {
                                "type": "string",
                                "description": "Short snake_case signal key, "
                                "e.g. tariff_spain_wine.",
                            },
                            "note": {
                                "type": "string",
                                "description": "One short sentence: why this moves "
                                "demand/price and what a store should do about it.",
                            },
                        },
                        "required": ["index", "relevant"],
                    },
                }
            },
            "required": ["items"],
        },
    }


_SYSTEM = """You analyze local/national news headlines for a US liquor store's \
recommendation engine. Mark a headline relevant ONLY if it plausibly changes \
what the store should stock, promote, or buy ahead in the next 1-3 weeks. \
Typical relevant shapes: tariffs/import taxes/trade actions hitting drink \
origins (buy affected imports before wholesale prices rise -> \
price_increase_risk), supply/recall/shortage stories (supply_risk), viral \
drink trends or big local events/festivals (demand_up), and economic news that \
clearly shifts buying down-market (demand_down). General politics, sports \
scores, crime, weather (handled elsewhere) are NOT relevant. Be conservative: \
a few strong items beat many weak ones. Every relevant item MUST carry an \
impact; direction is the whole point of the classification (a supply story \
tagged with no impact is treated as mere context). For relevant items, give \
the affected categories from the allowed vocabulary, product-name keywords \
when the impact is origin- or brand-specific, a snake_case key, and a \
one-line actionable note."""


# The broad fetch is '"StateName" OR (topics)' — recall-oriented, mostly
# state-news noise that only exists because the analyst filters it. When the
# analyst is down, fall back to the narrow pipeline's semantics: keep only
# headlines matching a tracked topic, capped like narrow mode, instead of
# shipping every raw headline to the prompt and the owner-facing snapshot.
_TRACKED_TERMS = (
    "tariff", "supply chain", "layoff", "viral cocktail", "cocktail",
    "festival", "distillery", "shortage", "recall",
)


def _tracked_fallback(news_signals: list[NewsSignal], max_kept: int) -> list[NewsSignal]:
    def _tracked(n: NewsSignal) -> bool:
        text = f"{n.headline} {n.description or ''}".lower()
        return any(term in text for term in _TRACKED_TERMS)

    return [n for n in news_signals if _tracked(n)][:max_kept]


def _payload(news_signals: list[NewsSignal]) -> str:
    lines = []
    for i, n in enumerate(news_signals):
        desc = f" — {n.description}" if n.description else ""
        lines.append(f"[{i}] {n.headline}{desc}")
    return "Headlines:\n" + "\n".join(lines) + "\n\nClassify each via the analyze_news tool."


def _slug(raw: str | None, fallback: str) -> str:
    slug = _KEY_SHAPE.sub("_", (raw or "").strip().lower()).strip("_")
    slug = slug or fallback
    slug = slug if slug.startswith("news_") else f"news_{slug}"
    # The hardcoded keyword keys (news_festival, news_viral_cocktail) carry
    # fixed demand-category semantics in SIGNAL_CATEGORY_MAP. An analyst key
    # that lands on one of those names would silently widen demand eligibility
    # regardless of the item's actual impact — suffix it out of the reserved
    # namespace instead.
    if slug in SIGNAL_CATEGORY_MAP:
        slug = f"{slug}_llm"
    return slug


def apply_analysis(
    news_signals: list[NewsSignal], items: list[dict], *, max_kept: int = 5
) -> tuple[list[NewsSignal], list[str], list[str], list[str]]:
    """Pure merge of analyst output into the signals (testable without a client).

    Returns (relevant signals only, keys, categories, product_keywords).
    Headlines the analyst does not mark relevant are DROPPED, same as the
    event analyst: the broad fetch is recall-oriented, so most of what it
    returns is noise ("local journalist wins award") that would otherwise
    reach the prompt and the owner's active-signals view. When the analyst
    errors, ``analyze`` falls back to the untouched keyword pipeline instead.
    """
    vocabulary = set(_vocabulary())
    kept: list[NewsSignal] = []
    keys: set[str] = set()
    categories: set[str] = set()
    keywords: set[str] = set()

    for item in items:
        if len(kept) >= max_kept:
            break
        index = item.get("index")
        if not isinstance(index, int) or not 0 <= index < len(news_signals):
            continue
        if not item.get("relevant"):
            continue
        impact = item.get("impact")
        if impact not in _IMPACTS:
            # A missing or garbled direction must NEVER default to a
            # directional value: coercing to demand_up inverted supply-risk
            # stories into promote-this signals. None = soft context.
            if impact is not None:
                log.warning("news_impact_invalid", impact=impact, index=index)
            impact = None
        key = _slug(item.get("key"), fallback=f"news_item_{index}")
        item_categories = sorted(
            {c for c in item.get("categories") or [] if c in vocabulary}
        )
        item_keywords = sorted({
            kw.strip().lower()
            for kw in item.get("product_keywords") or []
            if isinstance(kw, str) and kw.strip()
        })
        kept.append(
            news_signals[index].model_copy(
                update={
                    "impact": impact,
                    "key": key,
                    "note": _clean_note(item.get("note")),
                    "categories": item_categories,
                    "product_keywords": item_keywords,
                }
            )
        )
        keys.add(key)
        categories.update(item_categories)
        keywords.update(item_keywords)

    return kept, sorted(keys), sorted(categories), sorted(keywords)


async def analyze(
    news_signals: list[NewsSignal],
    client: AsyncAnthropic,
    settings: Settings,
) -> tuple[list[NewsSignal], list[str], list[str], list[str]]:
    """Run the analyst over fetched headlines; fail-soft to no enrichment."""
    if not news_signals:
        return news_signals, [], [], []
    # Built as an untyped dict (like llm_client does) so the raw tool-schema
    # dict doesn't fight the SDK's typed overloads.
    params: dict[str, Any] = {
        "model": settings.news_llm_model,
        "max_tokens": settings.news_llm_max_tokens,
        "system": _SYSTEM,
        "messages": [{"role": "user", "content": _payload(news_signals)}],
        "tools": [_build_tool()],
        "tool_choice": {"type": "tool", "name": _TOOL_NAME},
    }
    try:
        response = await client.messages.create(**params)
        # A response truncated at max_tokens loses the tool input silently
        # (empty dict), which reads as "no relevant headlines" — surface it.
        if getattr(response, "stop_reason", None) == "max_tokens":
            log.warning("news_analysis_truncated", max_tokens=settings.news_llm_max_tokens)
        tool_block = next(
            (b for b in response.content if getattr(b, "type", None) == "tool_use"), None
        )
        items = (tool_block.input or {}).get("items", []) if tool_block else []
        if not isinstance(items, list):
            items = []
    except Exception as exc:  # noqa: BLE001 — optional enrichment must never sink a run
        log.warning("news_analysis_failed", error=str(exc))
        return _tracked_fallback(news_signals, settings.news_max_kept), [], [], []

    kept, keys, categories, keywords = apply_analysis(
        news_signals, items, max_kept=settings.news_max_kept
    )
    log.info(
        "news_analyzed",
        headlines=len(news_signals),
        kept=len(kept),
        keys=keys,
        categories=categories,
    )
    return kept, keys, categories, keywords
