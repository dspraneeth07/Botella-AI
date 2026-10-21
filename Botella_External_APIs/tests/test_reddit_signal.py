from __future__ import annotations

import httpx
import respx

from app.config import Settings
from app.signals import reddit, social

_TOKEN_URL = "https://www.reddit.com/api/v1/access_token"


def _settings(**overrides) -> Settings:
    defaults = {
        "reddit_client_id": "cid",
        "reddit_client_secret": "secret",
        "reddit_min_score": 25,
    }
    defaults.update(overrides)
    return Settings(**defaults)


def _listing(children: list[dict]) -> dict:
    return {"data": {"children": [{"data": c} for c in children]}}


async def test_fetch_posts_dormant_without_credentials() -> None:
    async with httpx.AsyncClient() as http:
        assert await reddit.fetch_posts(http, Settings(reddit_client_id=None)) == []


async def test_fetch_posts_disabled_by_master_switch() -> None:
    async with httpx.AsyncClient() as http:
        posts = await reddit.fetch_posts(http, _settings(social_trends_enabled=False))
    assert posts == []


@respx.mock
async def test_fetch_posts_filters_noise() -> None:
    respx.post(_TOKEN_URL).respond(json={"access_token": "tok"})
    listing = respx.get(host="oauth.reddit.com").respond(
        json=_listing(
            [
                {"title": "Espresso martini week", "subreddit": "cocktails", "score": 900},
                {"title": "Low effort", "subreddit": "cocktails", "score": 3},
                {"title": "NSFW thing", "subreddit": "cocktails", "score": 500, "over_18": True},
                {"title": "", "subreddit": "cocktails", "score": 700},
            ]
        )
    )
    async with httpx.AsyncClient() as http:
        posts = await reddit.fetch_posts(http, _settings())
    assert [p.title for p in posts] == ["Espresso martini week"]
    # The bearer token and required descriptive UA both went out.
    request = listing.calls.last.request
    assert request.headers["Authorization"] == "bearer tok"
    assert "botella" in request.headers["User-Agent"]


@respx.mock
async def test_fetch_posts_fail_soft_on_upstream_error() -> None:
    respx.post(_TOKEN_URL).respond(status_code=503)
    async with httpx.AsyncClient() as http:
        assert await reddit.fetch_posts(http, _settings()) == []


@respx.mock
async def test_fetch_posts_fail_soft_on_missing_token() -> None:
    respx.post(_TOKEN_URL).respond(json={"error": "invalid_grant"})
    async with httpx.AsyncClient() as http:
        assert await reddit.fetch_posts(http, _settings()) == []


def _post(
    title: str, score: int, subreddit: str = "cocktails", platform: str = "reddit"
) -> social.TrendPost:
    return social.TrendPost(
        title=title, origin=f"r/{subreddit}", platform=platform, score=score
    )


def test_keyword_signals_groups_posts_by_term() -> None:
    posts = [
        _post("High Noon restock day", 300),
        _post("my high noon shelf", 120, subreddit="rtdcocktails"),
        _post("Best budget bourbon?", 80, subreddit="bourbon"),
        _post("Won the lottery (no drink here)", 999),
    ]
    signals, keys, categories, keywords = social.keyword_signals(posts)
    by_term = {s.term: s for s in signals}
    assert set(by_term) == {"high noon", "bourbon"}
    hn = by_term["high noon"]
    assert hn.mentions == 2 and hn.score == 420
    # Evidence is the strongest supporting post, tagged with its origin.
    assert hn.evidence == 'r/cocktails: "High Noon restock day"'
    assert hn.key == "trend_high_noon" and hn.source == "reddit"
    assert keys == ["trend_bourbon", "trend_high_noon"]
    # The matched keyword's canonical token widens eligibility; the keyword
    # itself is the product-name hint.
    assert categories == ["bourbon", "rtd"]
    assert keywords == ["bourbon", "high noon"]


def test_keyword_signals_mixed_platform_source() -> None:
    posts = [
        _post("High Noon restock day", 300),
        social.TrendPost(
            title="High Noon summer haul", origin="YouTube: BarChannel",
            platform="youtube", score=50000,
        ),
    ]
    signals, _, _, _ = social.keyword_signals(posts)
    assert signals[0].source == "reddit+youtube"
    # Evidence names the strongest supporting item, whichever platform.
    assert signals[0].evidence == 'YouTube: BarChannel: "High Noon summer haul"'


def test_keyword_signals_caps_by_engagement() -> None:
    posts = [
        _post("bourbon night", 10),
        _post("vodka soda", 500),
        _post("gin tasting", 300),
    ]
    signals, keys, _, _ = social.keyword_signals(posts, max_kept=2)
    assert [s.term for s in signals] == ["vodka", "gin"]
    assert keys == ["trend_gin", "trend_vodka"]


def test_keyword_signals_empty_posts() -> None:
    assert social.keyword_signals([]) == ([], [], [], [])
