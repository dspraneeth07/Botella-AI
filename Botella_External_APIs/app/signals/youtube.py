"""YouTube discovery source (official Data API v3, plain API key).

Searches this week's most-viewed drink/cocktail videos for a small set of
broad queries and reduces them to :class:`TrendPost` evidence, alongside the
Reddit feed, for the social-trend channel. YouTube (and Shorts) is where many
drink trends actually surface, and the Data API needs only an API key from
Google Cloud Console — no approval process.

Quota discipline: search.list costs 100 units per call against a free 10,000
units/day quota, so the query list stays small (default 3) and the whole
network shares ONE fetch per cache TTL (the mailbox pattern). A videos.list
statistics batch costs 1 unit. Dormant until ``youtube_api_key`` is set.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx

from app.config import Settings
from app.logging_config import get_logger
from app.signals.social import TrendPost

log = get_logger(__name__)

_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"
_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels"
_RESULTS_PER_QUERY = 25  # search.list maximum is 50; 25 keeps the analyst payload sane


async def fetch_videos(http: httpx.AsyncClient, settings: Settings) -> list[TrendPost]:
    """This week's top drink videos across the configured queries, fail-soft.

    Two phases: search.list per query (IDs + titles, view-ordered), then one
    batched videos.list for real view counts — search results don't carry
    statistics. Videos under ``youtube_min_views`` are dropped; below real
    reach a title is noise, not a trend.
    """
    if (
        not settings.social_trends_enabled
        or not settings.youtube_api_key
        or not settings.youtube_queries
    ):
        return []

    published_after = (
        (datetime.now(UTC) - timedelta(days=7)).replace(microsecond=0).isoformat()
    ).replace("+00:00", "Z")

    by_id: dict[str, dict] = {}
    try:
        for query in settings.youtube_queries:
            resp = await http.get(
                _SEARCH_URL,
                params={
                    "key": settings.youtube_api_key,
                    "part": "snippet",
                    "q": query,
                    "type": "video",
                    "order": "viewCount",
                    "publishedAfter": published_after,
                    "maxResults": _RESULTS_PER_QUERY,
                    "regionCode": "US",
                    "relevanceLanguage": "en",
                    "safeSearch": "moderate",
                },
            )
            resp.raise_for_status()
            for item in resp.json().get("items") or []:
                video_id = (item.get("id") or {}).get("videoId")
                snippet = item.get("snippet") or {}
                title = (snippet.get("title") or "").strip()
                if not video_id or not title:
                    continue
                by_id.setdefault(
                    video_id,
                    {
                        "title": title,
                        "channel": snippet.get("channelTitle") or "YouTube",
                        "channel_id": snippet.get("channelId") or "",
                    },
                )

        if not by_id:
            return []

        # regionCode only BIASES search toward a region, it does not filter —
        # view-ordered results still surface foreign-market mega channels
        # (observed: Indian drink channels dominating a US fetch). Drop videos
        # whose channel DECLARES a non-US country; channels with no declared
        # country pass through, and the trend analyst's US-market relevance
        # rule catches what this metadata filter cannot.
        channel_ids = sorted({m["channel_id"] for m in by_id.values() if m["channel_id"]})
        foreign_channels: set[str] = set()
        if channel_ids:
            channels_resp = await http.get(
                _CHANNELS_URL,
                params={
                    "key": settings.youtube_api_key,
                    "part": "snippet",
                    "id": ",".join(channel_ids[:50]),
                },
            )
            channels_resp.raise_for_status()
            for item in channels_resp.json().get("items") or []:
                country = ((item.get("snippet") or {}).get("country") or "").strip().upper()
                if country and country != "US":
                    foreign_channels.add(item.get("id") or "")
        if foreign_channels:
            dropped = [
                video_id for video_id, meta in by_id.items()
                if meta["channel_id"] in foreign_channels
            ]
            for video_id in dropped:
                del by_id[video_id]
            log.info("youtube_foreign_channels_dropped", videos=len(dropped))
        if not by_id:
            return []

        # One statistics batch (IDs comma-joined, API max 50 per call).
        ids = list(by_id)[:50]
        stats_resp = await http.get(
            _VIDEOS_URL,
            params={
                "key": settings.youtube_api_key,
                "part": "statistics",
                "id": ",".join(ids),
            },
        )
        stats_resp.raise_for_status()
        views_by_id = {
            item.get("id"): int((item.get("statistics") or {}).get("viewCount") or 0)
            for item in stats_resp.json().get("items") or []
        }
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("youtube_fetch_failed", error=str(exc))
        return []

    posts: list[TrendPost] = []
    for video_id, meta in by_id.items():
        views = views_by_id.get(video_id, 0)
        if views < settings.youtube_min_views:
            continue
        posts.append(
            TrendPost(
                title=meta["title"],
                origin=f"YouTube: {meta['channel']}",
                platform="youtube",
                score=views,
            )
        )
    posts.sort(key=lambda p: p.score, reverse=True)
    del posts[settings.youtube_max_videos:]
    log.info("youtube_fetched", videos=len(posts), queries=len(settings.youtube_queries))
    return posts
