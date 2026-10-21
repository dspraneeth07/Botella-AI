"""Shared shapes and helpers for the social-trend signal channel.

The channel has two roles, each fed by pluggable sources:

* **Discovery** — "what drinks are people talking about?" Reddit posts and
  YouTube videos both reduce to a :class:`TrendPost` (title + origin +
  engagement), so the keyword floor and the LLM trend analyst work on any mix
  of platforms in one pass.
* **Quantification** — "is interest actually rising?" Google Trends emits
  term-level signals directly; ``combine`` merges them onto discovered terms.

Every source names its citable keys the same way (``trend_<term_slug>``), so
the slug helper and the cross-source merge live here rather than in any one
source module.
"""

from __future__ import annotations

import re

from pydantic import BaseModel

from app.schemas.signals import TrendSignal
from app.store_data.categorize import match_keywords

_KEY_SHAPE = re.compile(r"[^a-z0-9_]+")


class TrendPost(BaseModel):
    """One piece of discovery evidence: a Reddit post or a YouTube video.

    ``origin`` is the human-readable place it came from ("r/cocktails",
    "YouTube: Vlad SlickBartender"); ``platform`` is the machine label used to
    build ``TrendSignal.source`` ("reddit" / "youtube"). ``score`` is the
    platform's engagement number (upvotes or views).
    """

    title: str
    origin: str
    platform: str
    score: int = 0


def trend_key(term: str) -> str:
    """Citable snake_case key for a trend term: ``"Aperol Spritz"`` -> ``trend_aperol_spritz``.

    Deterministic across sources so the same term observed anywhere resolves
    to ONE key (and one merged signal entry).
    """
    slug = _KEY_SHAPE.sub("_", term.strip().lower()).strip("_") or "unknown"
    return f"trend_{slug}"


def source_of(posts: list[TrendPost]) -> str:
    return "+".join(sorted({p.platform for p in posts})) or "social"


def keyword_signals(
    posts: list[TrendPost], *, max_kept: int = 5
) -> tuple[list[TrendSignal], list[str], list[str], list[str]]:
    """Pure keyword floor: posts -> (signals, keys, categories, product_keywords).

    Groups posts/videos by the drink keyword found in their titles; each
    keyword becomes one term-level signal with its mentions, summed
    engagement, and the strongest supporting title as evidence. The matched
    keyword doubles as the product-name hint and its canonical token widens
    candidate eligibility — exactly what the analyst produces, minus the
    semantic reach. Always available, no LLM; also the analyst's fallback.
    """
    grouped: dict[str, dict] = {}
    for post in posts:
        for keyword, token in match_keywords(post.title):
            entry = grouped.setdefault(
                keyword, {"token": token, "supporting": [], "score": 0}
            )
            entry["supporting"].append(post)
            entry["score"] += post.score

    ranked = sorted(grouped.items(), key=lambda kv: kv[1]["score"], reverse=True)[:max_kept]
    signals: list[TrendSignal] = []
    keys: list[str] = []
    categories: set[str] = set()
    keywords: set[str] = set()
    for term, entry in ranked:
        key = trend_key(term)
        supporting: list[TrendPost] = entry["supporting"]
        best = max(supporting, key=lambda p: p.score)
        signals.append(
            TrendSignal(
                term=term,
                source=source_of(supporting),
                mentions=len(supporting),
                score=entry["score"],
                evidence=f'{best.origin}: "{best.title}"',
                key=key,
            )
        )
        keys.append(key)
        categories.add(entry["token"])
        keywords.add(term)
    return signals, sorted(set(keys)), sorted(categories), sorted(keywords)


def combine(
    discovery_signals: list[TrendSignal], trends_signals: list[TrendSignal]
) -> list[TrendSignal]:
    """Merge discovery and quantification into one term-deduplicated list.

    Discovery entries lead (they carry post/video evidence and analyst
    notes); a Google Trends entry for the same key enriches the discovery
    entry with momentum and interest instead of appearing twice. Trends-only
    terms append after.
    """
    combined: list[TrendSignal] = []
    by_key: dict[str, int] = {}
    for signal in discovery_signals:
        # Two discovery entries sharing one key must merge — one citable key
        # backing two divergent lines meant only the last got GT enrichment
        # and the snapshot's cited-key retention kept both.
        index = by_key.get(signal.key) if signal.key else None
        if index is not None:
            base = combined[index]
            merged_score = (
                (base.score or 0) + (signal.score or 0)
                if base.score is not None or signal.score is not None
                else None
            )
            combined[index] = base.model_copy(
                update={
                    "mentions": base.mentions + signal.mentions,
                    "score": merged_score,
                }
            )
            continue
        if signal.key is not None:
            by_key[signal.key] = len(combined)
        combined.append(signal)
    for signal in trends_signals:
        index = by_key.get(signal.key) if signal.key else None
        if index is None:
            # Register the appended entry too, so a duplicate trends-only key
            # enriches this one instead of appending a second copy.
            if signal.key is not None:
                by_key[signal.key] = len(combined)
            combined.append(signal)
            continue
        base = combined[index]
        # Enrich, never erase: a source that lacks a field (Instagram carries
        # momentum but no 0-100 interest) must not blank what another source
        # already contributed to the same term.
        combined[index] = base.model_copy(
            update={
                "source": f"{base.source}+{signal.source}",
                "momentum": signal.momentum or base.momentum,
                "interest": signal.interest if signal.interest is not None else base.interest,
            }
        )
    return combined


def cap_by_evidence(
    social: list[TrendSignal], max_n: int, *, register_max: int | None = None
) -> list[TrendSignal]:
    """Cap the merged social channel, strongest evidence class first.

    Register-measured entries (real purchases at nearby stores) outrank
    Instagram hashtag velocity (measured posting), which outranks social
    chatter (Reddit/YouTube/Google Trends). The sort is stable, so within a
    tier the upstream order (analyst ranking / acceleration order) holds.
    The strip has room for weather, sports, events, holidays, news, and
    email only when trends don't sprawl — this is the trends' budget.

    ``register_max`` additionally rations PURE register entries (source is
    registers alone) BEFORE the tier sort and regardless of the total count:
    they are one metric read many times, and their top-tier rank otherwise
    lets them fill every kept slot (observed: 4 of 4 strip chips
    register-measured). A register row that merged into a social term
    ("twitter+registers") is corroboration of that trend, not another
    register reading, so it never counts against this ration.
    """
    if register_max is not None:
        rationed: list[TrendSignal] = []
        pure_seen = 0
        for t in social:
            if all(tok == "registers" for tok in (t.source or "registers").split("+")):
                pure_seen += 1
                if pure_seen > max(0, register_max):
                    continue
            rationed.append(t)
        social = rationed
    if len(social) <= max_n:
        return social

    def _tier(t: TrendSignal) -> int:
        if "registers" in t.source:
            return 0
        if "instagram" in t.source:
            return 1
        return 2

    return sorted(social, key=_tier)[:max_n]
