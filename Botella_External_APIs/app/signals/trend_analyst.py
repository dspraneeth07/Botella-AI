"""LLM trend analyst: extract trending drinks from raw discovery evidence.

The keyword floor (``social.keyword_signals``) only spots terms already in
the categorizer's vocabulary — an emerging trend ("sleepy girl mocktail",
"BuzzBallz") passes through silently. This module replaces that ceiling with
one small tool-use call (Haiku by default) that reads the week's top Reddit
post and YouTube video titles (any :class:`TrendPost` mix), groups them into
drink/brand/cocktail TERMS that are genuinely trending, and returns per term:

* ``post_indexes`` — the supporting posts/videos. Terms must be grounded in
  real evidence; an index-less term is discarded, so the analyst cannot
  invent a trend the feed doesn't show.
* ``categories`` — canonical category tokens (the categorizer vocabulary),
  which widen candidate eligibility exactly like mapped signal keys do.
* ``product_keywords`` — words that would appear in matching product names on
  the shelf ("buzzballz", "espresso martini"), driving the SOCIAL_TREND
  candidate slice.
* ``note`` — a one-line so-what for the prompt and the owner-facing snapshot.

Runs inside the global discovery cache entry, so it costs one Haiku call per
TTL for the whole network. Fail-soft: any error returns ``None`` and the
caller falls back to the keyword floor.
"""

from __future__ import annotations

import re
from typing import Any

from anthropic import AsyncAnthropic

from app.config import Settings
from app.logging_config import get_logger
from app.schemas.signals import TrendSignal
from app.signals.social import TrendPost, source_of, trend_key
from app.store_data.categorize import family_members, is_drink_term

log = get_logger(__name__)

_TOOL_NAME = "analyze_trends"
# Same no-dash rule as the other analysts: notes reach the owner.
_DASHES = re.compile(r"\s*[–—]\s*")


def _clean_note(raw: str | None) -> str | None:
    return _DASHES.sub(", ", (raw or "").strip()) or None


def _vocabulary() -> list[str]:
    cats = family_members("beer") | family_members("wine") | family_members("spirits")
    return sorted(cats | {"beer", "wine", "spirits"})


def _build_tool() -> dict[str, Any]:
    return {
        "name": _TOOL_NAME,
        "description": "Report which specific drinks are genuinely trending in these posts.",
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "term": {
                                "type": "string",
                                "description": "Lowercase drink/brand/cocktail name, "
                                "e.g. 'espresso martini', 'buzzballz'.",
                            },
                            "relevant": {"type": "boolean"},
                            "post_indexes": {
                                "type": "array",
                                "items": {"type": "integer"},
                                "description": "0-based indexes of the posts supporting "
                                "this term. Required; a term with no supporting post "
                                "is discarded.",
                            },
                            "categories": {
                                "type": "array",
                                "items": {"type": "string", "enum": _vocabulary()},
                                "description": "Product categories the trending drink "
                                "belongs to.",
                            },
                            "product_keywords": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Lowercase words/phrases that would appear "
                                "in matching product NAMES on a liquor-store shelf, e.g. "
                                "'aperol', 'high noon'. Include the base spirit or an "
                                "RTD brand when the trend is a cocktail.",
                            },
                            "note": {
                                "type": "string",
                                "description": "One short sentence: what is trending and "
                                "what a store should stock or feature because of it.",
                            },
                        },
                        "required": ["term", "relevant", "post_indexes"],
                    },
                }
            },
            "required": ["items"],
        },
    }


_SYSTEM = """You analyze this week's top drinks-community posts and videos \
(Reddit, YouTube, X) for a US liquor store's recommendation engine. Group them \
into specific drink, brand, or cocktail TERMS that are genuinely trending, \
meaning several items or very high engagement around the same drink, and mark \
a term relevant ONLY if a US liquor store could act on it by stocking, \
chilling, or featuring matching products in the next 1-3 weeks. The audience \
is US stores serving US shoppers: the trend must reflect US or global \
consumer interest. Content clearly aimed at another country's market, such as \
regional brands not distributed in the US or videos from foreign-market \
channels chasing their home audience, is NOT relevant no matter how many \
views it has. Home-bar gear, glassware, memes, career or legal questions, and \
one-off bottle photos or reviews with modest engagement are also NOT \
relevant. Be conservative: a few strong terms beat many weak ones. For each \
relevant term give the supporting item indexes, the affected categories from \
the allowed vocabulary, product-name keywords a US store's shelf labels would \
contain (the base spirit for a cocktail, the brand for a product), and a \
one-line actionable note."""


def _payload(posts: list[TrendPost]) -> str:
    lines = [
        f"[{i}] ({p.origin}, {p.score} engagement) {p.title}" for i, p in enumerate(posts)
    ]
    return (
        "This week's top posts and videos:\n"
        + "\n".join(lines)
        + "\n\nExtract the trending drink terms via the analyze_trends tool."
    )


def apply_analysis(
    posts: list[TrendPost], items: list[dict], *, max_kept: int = 5,
    min_mentions: int = 1, solo_min_score: float = 0.0,
) -> tuple[list[TrendSignal], list[str], list[str], list[str]]:
    """Pure merge of analyst output into signals (testable without a client).

    Returns (signals, keys, categories, product_keywords). Terms are grounded
    in their supporting posts/videos: mentions/score/evidence/source come from
    the cited items themselves, not from the model, and a term citing no valid
    item is dropped. Strongest terms (by summed engagement) are kept first.
    """
    vocabulary = set(_vocabulary())
    scored: list[tuple[float, TrendSignal, list[str], list[str]]] = []
    for item in items:
        term = (item.get("term") or "").strip().lower()
        if not term or not item.get("relevant"):
            continue
        # Deterministic drink gate: the analyst's relevance verdict is one
        # model's opinion, and the term is a free string — a viral "shrimp
        # cocktail recipe" food video must never mint an owner-facing chip.
        # Enum-valid categories are the term's only appeal for unknown brands.
        enum_cats = [c for c in item.get("categories") or [] if c in vocabulary]
        if not is_drink_term(term, enum_cats):
            log.warning("trend_term_rejected", term=term, reason="not_a_drink")
            continue
        indexes = [
            i for i in item.get("post_indexes") or []
            if isinstance(i, int) and 0 <= i < len(posts)
        ]
        if not indexes:
            continue
        supporting = [posts[i] for i in dict.fromkeys(indexes)]
        best = max(supporting, key=lambda p: p.score)
        score = sum(p.score for p in supporting)
        # Rank on a per-source NORMALIZED score: raw YouTube views dwarf
        # Reddit upvotes ~1000:1, so one viral video outranked every genuine
        # discussion trend for the kept slots. Views scale to rough upvote
        # parity (the 10k-view floor ~ the 25-upvote floor at /200); the
        # displayed score stays the raw sum. Twitter likes already ride at
        # upvote scale, so they take the raw branch with Reddit.
        rank_score = sum(
            (p.score / 200 if p.platform == "youtube" else p.score) for p in supporting
        )
        # Thin-evidence floor: a term carried by fewer than ``min_mentions``
        # supporters must clear the solo bar in normalized engagement — one
        # modest video (a 90k-view upload is niche content, not a trend)
        # never mints an owner-facing chip by itself.
        if len(supporting) < min_mentions and rank_score < solo_min_score:
            log.warning(
                "trend_term_rejected", term=term, reason="thin_evidence",
                mentions=len(supporting), normalized_score=round(rank_score, 1),
            )
            continue
        signal = TrendSignal(
            term=term,
            source=source_of(supporting),
            mentions=len(supporting),
            score=score,
            evidence=f'{best.origin}: "{best.title}"',
            key=trend_key(term),
            note=_clean_note(item.get("note")),
        )
        categories = enum_cats
        keywords = [
            kw.strip().lower()
            for kw in item.get("product_keywords") or []
            if isinstance(kw, str) and kw.strip()
        ]
        scored.append((rank_score, signal, categories, [term, *keywords]))

    scored.sort(key=lambda entry: entry[0], reverse=True)
    kept = scored[:max_kept]
    signals = [signal for _, signal, _, _ in kept]
    keys = sorted({s.key for s in signals if s.key})
    categories_out = sorted({c for _, _, cats, _ in kept for c in cats})
    keywords_out = sorted({kw for _, _, _, kws in kept for kw in kws})
    return signals, keys, categories_out, keywords_out


async def analyze(
    posts: list[TrendPost],
    client: AsyncAnthropic,
    settings: Settings,
) -> tuple[list[TrendSignal], list[str], list[str], list[str]] | None:
    """Run the analyst over fetched posts; ``None`` on failure so the caller
    can fall back to the keyword floor."""
    if not posts:
        return [], [], [], []
    params: dict[str, Any] = {
        "model": settings.trend_llm_model,
        "max_tokens": settings.trend_llm_max_tokens,
        "system": _SYSTEM,
        "messages": [{"role": "user", "content": _payload(posts)}],
        "tools": [_build_tool()],
        "tool_choice": {"type": "tool", "name": _TOOL_NAME},
    }
    try:
        response = await client.messages.create(**params)
        # A response truncated at max_tokens loses the tool input silently
        # (empty dict), which reads as "nothing trending" — surface it.
        if getattr(response, "stop_reason", None) == "max_tokens":
            log.warning("trend_analysis_truncated", max_tokens=settings.trend_llm_max_tokens)
        tool_block = next(
            (b for b in response.content if getattr(b, "type", None) == "tool_use"), None
        )
        items = (tool_block.input or {}).get("items", []) if tool_block else []
        if not isinstance(items, list):
            items = []
    except Exception as exc:  # noqa: BLE001 — optional enrichment must never sink a run
        log.warning("trend_analysis_failed", error=str(exc))
        return None

    signals, keys, categories, keywords = apply_analysis(
        posts, items, max_kept=settings.trend_max_kept,
        min_mentions=settings.trend_min_mentions,
        solo_min_score=settings.trend_solo_min_score,
    )
    log.info("trends_analyzed", posts=len(posts), kept=len(signals), keys=keys)
    return signals, keys, categories, keywords
