from __future__ import annotations

import httpx
import respx

from app.config import Settings
from app.signals import youtube

_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"
_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels"


def _settings(**overrides) -> Settings:
    defaults = {
        "youtube_api_key": "yt-key",
        "youtube_queries": ["cocktail trend"],
        "youtube_min_views": 10000,
    }
    defaults.update(overrides)
    return Settings(**defaults)


def _search_item(
    video_id: str, title: str, channel: str = "DrinkLab", channel_id: str = "ch-us"
) -> dict:
    return {
        "id": {"videoId": video_id},
        "snippet": {"title": title, "channelTitle": channel, "channelId": channel_id},
    }


def _stats_item(video_id: str, views: int) -> dict:
    return {"id": video_id, "statistics": {"viewCount": str(views)}}


def _channel_item(channel_id: str, country: str | None) -> dict:
    snippet: dict = {}
    if country is not None:
        snippet["country"] = country
    return {"id": channel_id, "snippet": snippet}


def _mock_channels(items: list[dict] | None = None) -> None:
    respx.get(_CHANNELS_URL).respond(json={"items": items or []})


async def test_fetch_videos_dormant_without_key() -> None:
    async with httpx.AsyncClient() as http:
        assert await youtube.fetch_videos(http, Settings(youtube_api_key=None)) == []


async def test_fetch_videos_disabled_by_master_switch() -> None:
    async with httpx.AsyncClient() as http:
        posts = await youtube.fetch_videos(http, _settings(social_trends_enabled=False))
    assert posts == []


@respx.mock
async def test_fetch_videos_joins_stats_and_filters_noise() -> None:
    search = respx.get(_SEARCH_URL).respond(
        json={
            "items": [
                _search_item("vid1", "BuzzBallz taste test"),
                _search_item("vid2", "Tiny channel cocktail", channel="Small"),
                {"id": {}, "snippet": {"title": "no video id"}},
            ]
        }
    )
    _mock_channels([_channel_item("ch-us", "US")])
    respx.get(_VIDEOS_URL).respond(
        json={"items": [_stats_item("vid1", 120000), _stats_item("vid2", 300)]}
    )
    async with httpx.AsyncClient() as http:
        posts = await youtube.fetch_videos(http, _settings())
    # vid2 is under the view floor; the id-less item never counts.
    assert [(p.title, p.score) for p in posts] == [("BuzzBallz taste test", 120000)]
    assert posts[0].platform == "youtube"
    assert posts[0].origin == "YouTube: DrinkLab"
    # The search was week-bounded, view-ordered, US-scoped video search.
    params = dict(search.calls.last.request.url.params)
    assert params["order"] == "viewCount" and params["type"] == "video"
    assert params["regionCode"] == "US" and "publishedAfter" in params


@respx.mock
async def test_fetch_videos_caps_and_sorts_by_views() -> None:
    respx.get(_SEARCH_URL).respond(
        json={"items": [_search_item(f"v{i}", f"Cocktail {i}") for i in range(4)]}
    )
    _mock_channels()
    respx.get(_VIDEOS_URL).respond(
        json={"items": [_stats_item(f"v{i}", 10000 + i * 1000) for i in range(4)]}
    )
    async with httpx.AsyncClient() as http:
        posts = await youtube.fetch_videos(http, _settings(youtube_max_videos=2))
    assert [p.score for p in posts] == [13000, 12000]


@respx.mock
async def test_fetch_videos_drops_declared_foreign_channels() -> None:
    """regionCode only biases search — foreign-market mega channels still
    surface. A channel DECLARING a non-US country is dropped; a channel with
    no declared country passes (the analyst's US-market rule handles those)."""
    respx.get(_SEARCH_URL).respond(
        json={
            "items": [
                _search_item("vid-us", "Espresso martini batch", channel_id="ch-us"),
                _search_item("vid-in", "Kingfisher Ultra Max", channel="Wala",
                             channel_id="ch-in"),
                _search_item("vid-anon", "Ranch water hack", channel_id="ch-anon"),
            ]
        }
    )
    _mock_channels([
        _channel_item("ch-us", "US"),
        _channel_item("ch-in", "IN"),
        _channel_item("ch-anon", None),
    ])
    respx.get(_VIDEOS_URL).respond(
        json={
            "items": [
                _stats_item("vid-us", 50000),
                _stats_item("vid-in", 2000000),
                _stats_item("vid-anon", 40000),
            ]
        }
    )
    async with httpx.AsyncClient() as http:
        posts = await youtube.fetch_videos(http, _settings())
    assert [p.title for p in posts] == ["Espresso martini batch", "Ranch water hack"]


@respx.mock
async def test_fetch_videos_fail_soft_on_quota_error() -> None:
    respx.get(_SEARCH_URL).respond(status_code=403)
    async with httpx.AsyncClient() as http:
        assert await youtube.fetch_videos(http, _settings()) == []
