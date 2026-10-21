"""Signal orchestration: fan out to every source concurrently, fail soft.

A failure in any single signal source degrades gracefully to "no data from
that source" rather than failing the whole run — a quiet weather day or a
flaky ESPN endpoint should never block recommendations.

Each fetch is optionally routed through a :class:`SignalCache` keyed by the
geography that actually determines its result (weather per gridpoint, sports /
news per state, events per lat/long, holidays globally). Stores in the same
area then share one fetch instead of each hitting the upstream API — see
``app.clients.signal_cache``.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

import httpx
from anthropic import AsyncAnthropic

from app.clients.signal_cache import SignalCache
from app.config import Settings
from app.schemas.signals import EventSignal, NewsSignal, SignalBundle, TrendSignal
from app.schemas.store import StoreProfile
from app.signals import (
    email_analyst,
    email_news,
    event_analyst,
    events,
    google_trends,
    holidays,
    news,
    news_analyst,
    reddit,
    social,
    sports,
    trend_analyst,
    twitter,
    weather,
    youtube,
)
from app.signals.capture import (
    RawPayloadCollector,
    SignalRecorder,
    fetch_scope,
)

T = TypeVar("T")


def _maybe_cached(
    cache: SignalCache | None,
    namespace: str,
    key: str,
    factory: Callable[[], Awaitable[T]],
    *,
    ttl_seconds: float | None = None,
    recorder: SignalRecorder | None = None,
    collector: RawPayloadCollector | None = None,
    scope: str | None = None,
) -> Awaitable[T]:
    """Route ``factory`` through ``cache`` when one is supplied, else call it directly.

    This is also the one place that knows both a source's NAME and the
    GEOGRAPHY its result varies by - they are the cache key - so it is where
    capture belongs. Wrapping here means health and raw attribution can never
    drift from what was actually fetched, and a new signal source gets both for
    free the moment it is added to the fan-out below.

    A failing source still degrades to "no data from that source" exactly as
    before; the difference is that the failure is now recorded instead of
    silently indistinguishable from a quiet day.
    """

    async def _run() -> T:
        with fetch_scope(recorder, collector, namespace, key, scope=scope) as span:
            invoked = False

            async def _tracked() -> T:
                # Only a cache MISS calls the factory. Flipping the flag here
                # is how a hit is detected without the cache having to report
                # one - and a hit means no HTTP happened, so a 2ms "latency"
                # is honest rather than a suspiciously fast fetch.
                nonlocal invoked
                invoked = True
                return await factory()

            try:
                if cache is None:
                    result = await _tracked()
                else:
                    result = await cache.get_or_fetch(
                        namespace, key, _tracked, ttl_seconds=ttl_seconds
                    )
            except Exception as exc:  # noqa: BLE001 - record, then re-raise
                span.failed(exc)
                raise
            span.succeeded(result, cache_hit=not invoked)
            return result

    return _run()


def _geo_key(store: StoreProfile, precision: int) -> str:
    return f"{round(store.latitude or 0.0, precision)},{round(store.longitude or 0.0, precision)}"


async def gather_signals(
    store: StoreProfile,
    http: httpx.AsyncClient,
    settings: Settings,
    *,
    cache: SignalCache | None = None,
    anthropic_client: AsyncAnthropic | None = None,
    recorder: SignalRecorder | None = None,
    collector: RawPayloadCollector | None = None,
) -> SignalBundle:
    """Fan out to every signal source for one store and return the bundle.

    ``recorder`` and ``collector`` are optional capture sinks (see
    app.signals.capture). Passing neither reproduces the previous behaviour
    exactly - capture is additive and never changes what is fetched, cached,
    or returned.
    """
    state_key = (store.state or "none").upper()
    analyze_news = anthropic_client is not None and settings.news_llm_enabled
    analyze_events = anthropic_client is not None and settings.events_llm_enabled
    analyze_email = anthropic_client is not None and settings.email_llm_enabled
    analyze_trends = anthropic_client is not None and settings.trend_llm_enabled

    async def _news_factory() -> tuple[list[NewsSignal], list[str], list[str], list[str]]:
        """Fetch headlines, then (optionally) run the LLM analyst over them.

        Both steps live inside one cache entry keyed by state, so the analyst
        costs one small call per state per TTL — independent of store count.

        Keyword keys are recomputed over the signals that actually SURVIVE
        analysis, mirroring the event analyst's discipline: a headline the
        analyst dropped must not leave an orphan demand key in active_keys
        (a supply-risk story mentioning "festival season" once emitted
        news_festival — beer/seltzer demand semantics — for an article that
        wasn't even kept). Among kept items, the demand-flavored keyword keys
        only apply where the analyst agreed the direction is demand_up;
        analyst-kept items carry their own keys either way. Items without an
        analyst key (the analyst-failed fallback) keep the keyword floor.
        """
        news_signals, keyword_keys = await news.fetch(
            store, http, settings, broad=analyze_news
        )
        if not analyze_news or not news_signals:
            return news_signals, keyword_keys, [], []
        assert anthropic_client is not None
        enriched, llm_keys, categories, keywords = await news_analyst.analyze(
            news_signals, anthropic_client, settings
        )
        kept_keyword_keys = news.keys_for_news(
            [n for n in enriched if n.key is None or n.impact == "demand_up"]
        )
        return enriched, sorted(set(kept_keyword_keys) | set(llm_keys)), categories, keywords

    async def _email_factory() -> tuple[list[NewsSignal], list[str], list[str], list[str]]:
        """Pull the daily industry email, then (optionally) extract its items.

        The mailbox is store-independent, so both steps live inside one
        GLOBAL cache entry: one IMAP round-trip and one analyst call per TTL
        serve the whole network. Without the analyst the raw subject lines
        pass through as soft context (no keys, no eligibility widening).
        """
        email_signals = await email_news.fetch(settings)
        if not analyze_email or not email_signals:
            return email_signals, [], [], []
        assert anthropic_client is not None
        return await email_analyst.analyze(email_signals, anthropic_client, settings)

    async def _discovery_factory() -> tuple[list[TrendSignal], list[str], list[str], list[str]]:
        """Pull the week's top drinks posts (Reddit), videos (YouTube), and
        tweets (X via Apify), then extract trend terms from the combined feed.

        What's trending is store-independent, so everything lives in one
        GLOBAL cache entry: one fetch per platform and ONE analyst call per
        TTL serve the whole network (the mailbox pattern). Each platform is
        dormant without its credentials and fail-soft on error; the keyword
        floor is the no-LLM path AND the fallback when the analyst errors.
        """
        reddit_posts, youtube_posts, twitter_posts, rising_posts = await asyncio.gather(
            reddit.fetch_posts(http, settings),
            youtube.fetch_videos(http, settings),
            twitter.fetch_posts(http, settings),
            # Breakout search queries as discovery evidence — same TrendPost
            # shape, national geo (this cache entry is global). Fail-soft [].
            google_trends.fetch_rising_posts(http, settings),
        )
        posts = reddit_posts + youtube_posts + twitter_posts + rising_posts
        if not posts:
            return [], [], [], []
        if analyze_trends:
            assert anthropic_client is not None
            analyzed = await trend_analyst.analyze(posts, anthropic_client, settings)
            if analyzed is not None:
                return analyzed
        return social.keyword_signals(posts, max_kept=settings.trend_max_kept)

    async def _events_factory() -> tuple[list[EventSignal], list[str], list[str]]:
        """Fetch nearby events, then (optionally) run the LLM analyst over them.

        Both steps live inside one cache entry keyed by geo, so the analyst
        costs one small call per store area per TTL. In analyst mode the fetch
        is broad (more events, deduped) and only events the analyst marks
        relevant survive; on error it degrades to the segment-keyword keys.
        """
        event_signals, segment_keys = await events.fetch(
            store, http, settings, broad=analyze_events
        )
        if not analyze_events or not event_signals:
            return event_signals, segment_keys, []
        assert anthropic_client is not None
        return await event_analyst.analyze(event_signals, anthropic_client, settings)

    # Weather/events are geo-specific and only meaningful with coordinates;
    # cache them by rounded geo so neighboring stores share a fetch. Without
    # geo they short-circuit to empty inside the fetcher, so skip the cache.
    # Both round to 2 decimals (~1.1 km): the events radius is 5+ miles, so a
    # kilometre of key slop is immaterial, and at the previous 3-decimal
    # (~110 m) precision no two stores ever actually shared an events entry —
    # every store paid its own Ticketmaster fetch + event-analyst call.
    weather_geo = _geo_key(store, 2) if store.has_geo else None
    events_geo = (
        f"{_geo_key(store, 2)},r{settings.event_radius_miles},llm={analyze_events}"
        if store.has_geo
        else None
    )

    # The social-trend fetches run as tasks alongside the main gather
    # (asyncio.gather's typed overloads stop at six awaitables).
    # What's trending on Reddit/YouTube is store-independent — one global
    # cache entry per TTL, like the mailbox and the national sports schedule.
    # Search momentum is state-scoped: every store in a state shares one
    # Google Trends fetch per TTL instead of each hitting the free endpoint.
    discovery_task = asyncio.ensure_future(
        _maybe_cached(
            cache, "social_discovery", f"global:llm={analyze_trends}", _discovery_factory,
            recorder=recorder, collector=collector,
        )
    )
    trends_task = asyncio.ensure_future(
        _maybe_cached(
            cache, "google_trends", f"{state_key}:{settings.google_trends_timeframe}",
            lambda: google_trends.fetch(store, http, settings),
            recorder=recorder, collector=collector,
        )
    )

    (
        weather_res,
        national_games,
        events_res,
        holidays_res,
        news_res,
        email_res,
    ) = await asyncio.gather(
        _maybe_cached(
            cache if weather_geo else None, "weather", weather_geo or "_",
            lambda: weather.fetch(store, http, settings),
            recorder=recorder, collector=collector,
        ),
        # The schedule is store-independent — one national cache entry serves
        # the whole network. Locality is computed per store below.
        _maybe_cached(
            cache, "sports", f"national:{settings.signal_lookahead_days}",
            lambda: sports.fetch_national(http, settings),
            recorder=recorder, collector=collector,
        ),
        _maybe_cached(
            cache if events_geo else None, "events", events_geo or "_",
            _events_factory,
            recorder=recorder, collector=collector,
        ),
        _maybe_cached(
            cache, "holidays", str(settings.holiday_lookahead_days),
            lambda: holidays.fetch(store, settings),
            recorder=recorder, collector=collector,
        ),
        _maybe_cached(
            cache, "news", f"{state_key}:llm={analyze_news}",
            _news_factory,
            recorder=recorder, collector=collector,
        ),
        # The subscription mailbox is store-independent — one global cache
        # entry serves the whole network, like the national sports schedule.
        # Short TTL override: the issue lands shortly before the daily cron,
        # so each run re-reads the mailbox instead of reusing a 6h entry
        # that could predate it; stores within a run still share one fetch.
        _maybe_cached(
            cache, "email_news", f"global:llm={analyze_email}",
            _email_factory, ttl_seconds=settings.email_cache_ttl_seconds,
            recorder=recorder, collector=collector,
        ),
    )
    discovery_res = await discovery_task
    trends_res = await trends_task

    weather_signal, weather_keys = weather_res
    sport_signals, sport_keys = sports.localize(national_games, store, settings)
    event_signals, event_keys, event_categories = events_res
    holiday_signals, holiday_keys = holidays_res
    news_signals, news_keys, news_categories, news_keywords = news_res
    email_signals, email_keys, email_categories, email_keywords = email_res
    discovery_signals, _discovery_keys, discovery_categories, discovery_keywords = discovery_res
    gt_signals, gt_categories, gt_keywords = trends_res

    # One entry per term across sources: a Google Trends hit on a discovered
    # term enriches that entry with momentum instead of appearing twice. Keys
    # are recomputed from the merged list so active_keys matches what renders.
    social_signals = social.combine(discovery_signals, gt_signals)
    social_keys = {s.key for s in social_signals if s.key}

    active_keys = sorted(
        set(weather_keys)
        | set(sport_keys)
        | set(event_keys)
        | set(holiday_keys)
        | set(news_keys)
        | set(email_keys)
        | social_keys
    )

    # Explain the silences. A source that returned nothing because it has no
    # credentials, or because the store has no coordinates, is WORKING AS
    # CONFIGURED - recording it as a plain success would make "no events
    # today" and "we never set a Ticketmaster key" the same row, and recording
    # it as a failure would make every store look permanently broken. Both
    # readings have cost real debugging time, so name the condition instead.
    if recorder is not None:
        if weather_signal is not None and weather_signal.timezone:
            recorder.timezone = weather_signal.timezone
        if not store.has_geo:
            recorder.dormant("weather", "no_geo")
            recorder.dormant("events", "no_geo")
        elif not settings.ticketmaster_api_key:
            recorder.dormant("events", "no_api_key")
        if not settings.newsdata_api_key:
            recorder.dormant("news", "no_api_key")
        if not settings.email_signal_enabled:
            recorder.dormant("email_news", "disabled")
        if not settings.social_trends_enabled:
            recorder.dormant("social_discovery", "disabled")
        if not settings.google_trends_enabled:
            recorder.dormant("google_trends", "disabled")

    return SignalBundle(
        weather=weather_signal,
        sports=sport_signals,
        events=event_signals,
        holidays=holiday_signals,
        # Email items ride the news channel (tagged industry_email), placed
        # first so the prompt's per-type display cap cannot drop them.
        news=email_signals + news_signals,
        social=social_signals,
        active_keys=active_keys,
        news_categories=sorted(set(news_categories) | set(email_categories)),
        news_product_keywords=sorted(set(news_keywords) | set(email_keywords)),
        event_categories=event_categories,
        trend_categories=sorted(set(discovery_categories) | set(gt_categories)),
        trend_product_keywords=sorted(set(discovery_keywords) | set(gt_keywords)),
    )


__all__ = ["gather_signals"]
