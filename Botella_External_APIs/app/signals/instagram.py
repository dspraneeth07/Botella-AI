"""Instagram hashtag velocity -> quantification signals (contract §1.8).

Meta exposes no trending API, so the Node backend polls a FIXED drink-hashtag
vocabulary daily (Graph API hashtag search) and serves each term's post
velocity against its own baseline. This module reduces those rows to the same
term-level :class:`TrendSignal` shape Google Trends emits, so
``social.combine`` can merge them onto Reddit/YouTube-discovered terms — an
Instagram surge on a discovered term enriches that entry; Instagram-only
terms append after and flow into trend validation like any other.

Unlike the other signal sources this one is fetched over the Node integration
API, so the fetch lives in ``context_builder`` (where the Node client and
tenant IDs already are) and only the row -> signal reduction lives here.
Fail-soft by shape: an empty feed just means Node's poller hasn't accrued
baselines yet.
"""

from __future__ import annotations

from app.config import Settings
from app.logging_config import get_logger
from app.schemas.signals import TrendSignal
from app.schemas.store import InstagramTrend
from app.signals.social import trend_key
from app.store_data.categorize import classify_from_name

log = get_logger(__name__)


def to_signals(
    rows: list[InstagramTrend], settings: Settings
) -> tuple[list[TrendSignal], list[str], list[str]]:
    """Accelerating hashtags -> (signals, categories, keywords).

    Rising needs a real baseline (>= ``instagram_min_baseline_points``
    observations) and the latest velocity to beat it by
    ``instagram_min_acceleration`` — the Google Trends momentum gate, restated
    for posts/hour. Flat or thin-baseline terms stay silent.
    """
    if not settings.social_trends_enabled or not settings.instagram_trends_enabled:
        return [], [], []

    rising = [
        row
        for row in rows
        if row.acceleration is not None
        and row.acceleration >= settings.instagram_min_acceleration
        and row.baseline_points >= settings.instagram_min_baseline_points
    ]
    rising.sort(key=lambda r: r.acceleration or 0.0, reverse=True)
    rising = rising[: settings.instagram_max_kept]

    signals: list[TrendSignal] = []
    categories: set[str] = set()
    keywords: set[str] = set()
    for row in rising:
        # The display form ("espresso martini", not "espressomartini") is what
        # everything downstream matches word-bounded: register validation,
        # classification, and the trend key — which then collides with the
        # Google Trends key for the same drink, exactly what combine() wants.
        term = (row.display_term or row.term).strip()
        signals.append(
            TrendSignal(
                term=term,
                source="instagram",
                momentum="rising",
                # score is "the platform's engagement number" (TrendSignal
                # docstring) — here, likes+comments over the top-posts sample.
                score=int(row.engagement or 0),
                evidence=(
                    f"#{row.term} at {(row.posts_per_hour or 0.0):.1f} posts/hr, "
                    f"{row.acceleration:.1f}x its recent baseline"
                ),
                key=trend_key(term),
            )
        )
        token = classify_from_name(term)
        if token:
            categories.add(token)
        keywords.add(term.lower())
    if signals:
        log.info("instagram_trends_rising", terms=[s.term for s in signals])
    return signals, sorted(categories), sorted(keywords)
