"""LLM email analyst: turn the daily industry email into citable news items.

A newsletter issue is a document, not a headline: the observed daily issue
("Industry News Update", ~85K chars of stripped text) summarizes fifteen-odd
published articles — scan data, market reports, harvest news, brand stories,
retail and policy pieces — and could also carry direct rep notes like
allocations or price changes. Classifying the whole message
relevant/irrelevant (the news analyst's shape) would either drop the good
parts with the noise or ship the noise with the good parts. So this analyst
EXTRACTS instead: one small, cheap tool-use call (Haiku by default) reads the
fetched email bodies and returns zero or more demand-relevant items, each
with:

* ``headline`` — a short store-facing restatement of the item.
* ``impact`` — how it moves demand or prices (demand_up, demand_down,
  price_increase_risk, supply_risk).
* ``categories`` — canonical category tokens (the categorizer's vocabulary),
  which widen candidate eligibility exactly like mapped signal keys do.
* ``product_keywords`` — words that would appear in affected product names
  ("buffalo trace", "fireball"), driving the NEWS_MATCH candidate slice.
* ``key`` / ``note`` — a citable snake_case signal key and a one-line
  so-what, both surfaced on the NEWS line in the prompt.

Extracted items ride the news channel (category ``industry_email``), so they
render as NEWS lines, land in the snapshot, and feed eligibility the same way
analyzed headlines do. The analysis runs inside the global email cache entry
(short ``email_cache_ttl_seconds`` override — fresh each run), so it costs one
Haiku call per run regardless of store count, and it is fail-soft: any error
falls back to the raw subject lines as soft context, never sinking a run.
"""

from __future__ import annotations

import re
from typing import Any

from anthropic import AsyncAnthropic

from typing import get_args

from app.config import Settings
from app.logging_config import get_logger
from app.schemas.signals import NewsImpact, NewsSignal
from app.signals.email_news import EMAIL_CATEGORY
from app.store_data.categorize import family_members

log = get_logger(__name__)

_TOOL_NAME = "analyze_email"
_IMPACTS = get_args(NewsImpact)
_KEY_SHAPE = re.compile(r"[^a-z0-9_]+")
# Notes reach the owner (prompt line + frontend snapshot); em/en dashes are
# banned from all user-facing and AI-generated text in this product.
_DASHES = re.compile(r"\s*[–—]\s*")

# Hard cap on extracted items. The prompt shows at most 5 news lines total;
# capping the email's share keeps slots free for state news headlines.
_MAX_ITEMS = 3


def _clean_text(raw: str | None) -> str | None:
    return _DASHES.sub(", ", (raw or "").strip()) or None


def _vocabulary() -> list[str]:
    cats = family_members("beer") | family_members("wine") | family_members("spirits")
    return sorted(cats | {"beer", "wine", "spirits"})


def _build_tool() -> dict[str, Any]:
    return {
        "name": _TOOL_NAME,
        "description": "Report the items in these industry emails that affect "
        "liquor-store demand or prices, and how. At most 3 items (the "
        "strongest); return an empty list when nothing is actionable.",
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "email_index": {
                                "type": "integer",
                                "description": "0-based index of the email this "
                                "item was extracted from.",
                            },
                            "headline": {
                                "type": "string",
                                "description": "Short store-facing restatement of "
                                "the item, e.g. 'Buffalo Trace allocation "
                                "arriving next week'.",
                            },
                            "impact": {
                                "type": "string",
                                "enum": list(_IMPACTS),
                                "description": "REQUIRED for every item: which "
                                "way it moves the store's buying. An item "
                                "without an impact is kept as soft context "
                                "only.",
                            },
                            "categories": {
                                "type": "array",
                                "items": {"type": "string", "enum": _vocabulary()},
                                "description": "Product categories whose demand/price "
                                "this item affects.",
                            },
                            "product_keywords": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Lowercase words/phrases that would "
                                "appear in affected product NAMES on the shelf, "
                                "e.g. 'buffalo trace', 'fireball'. Empty if the "
                                "impact is category-wide.",
                            },
                            "key": {
                                "type": "string",
                                "description": "Short snake_case signal key, "
                                "e.g. email_buffalo_trace_allocation.",
                            },
                            "note": {
                                "type": "string",
                                "description": "One short sentence: why this moves "
                                "demand/price and what a store should do about it.",
                            },
                        },
                        "required": ["email_index", "headline"],
                    },
                }
            },
            "required": ["items"],
        },
    }


_SYSTEM = """You read a daily liquor-industry email digest for a US liquor \
store's recommendation engine. The sender is an industry contact; a typical \
issue summarizes many published articles (market reports, retail scan data, \
harvest and supply news, brand stories, retail and policy pieces) and may also \
carry direct notes like allocations, price changes, or promotions. Extract \
ONLY items that plausibly change what a store should stock, promote, or buy \
ahead in the next 1-3 weeks: brand or category momentum with numbers behind it \
(scan data, market reports -> demand_up or demand_down for the named brands or \
categories); announced or reported price increases, tariffs, or category \
inflation (buy ahead -> price_increase_risk); harvest shortfalls, shortages, \
recalls, discontinuations, or distillery closures (supply_risk); allocated or \
limited releases arriving and viral drink trends (demand_up). Skip corporate \
finance and M&A, lawsuits and trademark fights, grocery-chain business news, \
opinion essays, and health or policy stories: nothing a store can act on at \
the shelf. Be selective, not timid: report AT MOST 3 items, the strongest ones; a \
typical issue yields 1 to 3, and an empty list is right only when truly \
nothing is actionable. For each kept item give a short headline, the affected categories \
from the allowed vocabulary, product-name keywords when the impact is brand- \
or origin-specific (e.g. 'modelo', 'michelob'), a snake_case key, and a \
one-line actionable note."""


def _payload(emails: list[NewsSignal]) -> str:
    blocks = []
    for i, e in enumerate(emails):
        blocks.append(
            f"[{i}] From: {e.source or 'unknown'} | Subject: {e.headline}\n"
            f"{e.description or '(no body text)'}"
        )
    return (
        "Emails:\n\n" + "\n\n".join(blocks)
        + "\n\nExtract the actionable items via the analyze_email tool."
    )


def _slug(raw: str | None, fallback: str) -> str:
    slug = _KEY_SHAPE.sub("_", (raw or "").strip().lower()).strip("_")
    slug = slug or fallback
    return slug if slug.startswith("email_") else f"email_{slug}"


def apply_analysis(
    emails: list[NewsSignal], items: list[dict]
) -> tuple[list[NewsSignal], list[str], list[str], list[str]]:
    """Pure merge of analyst output into signals (testable without a client).

    Returns (extracted items as news signals, keys, categories,
    product_keywords). The raw emails themselves are DROPPED: what survives is
    the analyst's restatement, one signal per actionable item. An issue with
    nothing actionable therefore contributes nothing to the prompt. When the
    analyst errors, ``analyze`` falls back to the raw subject lines instead.
    """
    vocabulary = set(_vocabulary())
    kept: list[NewsSignal] = []
    keys: set[str] = set()
    categories: set[str] = set()
    keywords: set[str] = set()

    for item in items:
        if len(kept) >= _MAX_ITEMS:
            break
        index = item.get("email_index")
        if not isinstance(index, int) or not 0 <= index < len(emails):
            continue
        headline = _clean_text(item.get("headline"))
        if not headline:
            continue
        impact = item.get("impact")
        if impact not in _IMPACTS:
            # Same rule as the news analyst: an unknown direction stays None
            # (soft context) rather than silently inverting a supply story
            # into a demand_up one.
            if impact is not None:
                log.warning("email_impact_invalid", impact=impact, index=index)
            impact = None
        key = _slug(item.get("key"), fallback=f"email_item_{index}")
        item_categories = sorted(
            {c for c in item.get("categories") or [] if c in vocabulary}
        )
        item_keywords = sorted({
            kw.strip().lower()
            for kw in item.get("product_keywords") or []
            if isinstance(kw, str) and kw.strip()
        })
        kept.append(
            NewsSignal(
                headline=headline,
                category=EMAIL_CATEGORY,
                source=emails[index].source,
                impact=impact,
                key=key,
                note=_clean_text(item.get("note")),
                categories=item_categories,
                product_keywords=item_keywords,
            )
        )
        keys.add(key)
        categories.update(item_categories)
        keywords.update(item_keywords)

    return kept, sorted(keys), sorted(categories), sorted(keywords)


async def analyze(
    emails: list[NewsSignal],
    client: AsyncAnthropic,
    settings: Settings,
) -> tuple[list[NewsSignal], list[str], list[str], list[str]]:
    """Run the analyst over fetched emails; fail-soft to subject-line context."""
    if not emails:
        return emails, [], [], []
    params: dict[str, Any] = {
        "model": settings.email_llm_model,
        "max_tokens": settings.email_llm_max_tokens,
        "system": _SYSTEM,
        "messages": [{"role": "user", "content": _payload(emails)}],
        "tools": [_build_tool()],
        "tool_choice": {"type": "tool", "name": _TOOL_NAME},
    }
    try:
        response = await client.messages.create(**params)
        # A response truncated at max_tokens loses the tool input silently
        # (empty dict), which reads as "nothing actionable" — surface it.
        if getattr(response, "stop_reason", None) == "max_tokens":
            log.warning("email_analysis_truncated", max_tokens=settings.email_llm_max_tokens)
        tool_block = next(
            (b for b in response.content if getattr(b, "type", None) == "tool_use"), None
        )
        items = (tool_block.input or {}).get("items", []) if tool_block else []
        if not isinstance(items, list):
            items = []
    except Exception as exc:  # noqa: BLE001 — optional enrichment must never sink a run
        log.warning("email_analysis_failed", error=str(exc))
        return emails, [], [], []

    kept, keys, categories, keywords = apply_analysis(emails, items)
    log.info(
        "email_analyzed",
        emails=len(emails),
        items=len(kept),
        keys=keys,
        categories=categories,
    )
    return kept, keys, categories, keywords
