from __future__ import annotations

import json

import httpx
import respx

from app.config import Settings
from app.signals import twitter

_ACTOR = "kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest"
_RUN_URL = f"https://api.apify.com/v2/acts/{_ACTOR}/run-sync-get-dataset-items"


def _settings(**overrides) -> Settings:
    defaults = {
        "apify_token": "apify-token",
        "twitter_queries": ["cocktail trend"],
        "twitter_min_likes": 100,
    }
    defaults.update(overrides)
    return Settings(**defaults)


def _tweet(
    tweet_id: str, text: str, likes: int, *, retweet: bool = False,
    author: str = "drinkstagram",
) -> dict:
    return {
        "id": tweet_id,
        "text": text,
        "likeCount": likes,
        "retweetCount": likes // 10,
        "isRetweet": retweet,
        "author": {"userName": author, "name": author.title()},
    }


async def test_fetch_posts_dormant_without_token() -> None:
    async with httpx.AsyncClient() as http:
        assert await twitter.fetch_posts(http, Settings(apify_token=None)) == []


async def test_fetch_posts_disabled_by_master_switch() -> None:
    async with httpx.AsyncClient() as http:
        posts = await twitter.fetch_posts(http, _settings(social_trends_enabled=False))
    assert posts == []


@respx.mock
async def test_fetch_posts_maps_floors_and_dedups() -> None:
    run = respx.post(_RUN_URL).respond(
        json=[
            _tweet("t1", "Espresso  martini\nis back", 2400),
            _tweet("t2", "Tiny account cocktail", 40),
            _tweet("t3", "RT of the viral one", 5000, retweet=True),
            _tweet("t1", "Espresso martini is back", 2400),
            {"id": "notice", "text": "", "likeCount": 0},
        ]
    )
    async with httpx.AsyncClient() as http:
        posts = await twitter.fetch_posts(http, _settings())
    # Floor drops t2 and the empty notice row, retweets are skipped, and the
    # duplicate t1 (same id via a second query) collapses to one post.
    assert [(p.title, p.score) for p in posts] == [("Espresso martini is back", 2400)]
    assert posts[0].platform == "twitter"
    assert posts[0].origin == "X: @drinkstagram"
    # The actor input carried the operators that keep billing lean.
    body = json.loads(run.calls.last.request.content)
    assert body["queryType"] == "Top" and body["maxItems"] == 100
    assert "min_faves:100" in body["searchTerms"][0]
    assert "since:" in body["searchTerms"][0]


@respx.mock
async def test_fetch_posts_sorts_and_caps() -> None:
    respx.post(_RUN_URL).respond(
        json=[_tweet(f"t{i}", f"Drink {i}", 100 + i) for i in range(4)]
    )
    async with httpx.AsyncClient() as http:
        posts = await twitter.fetch_posts(http, _settings(twitter_max_posts=2))
    assert [p.score for p in posts] == [103, 102]


@respx.mock
async def test_fetch_posts_skips_actor_billing_notice_rows() -> None:
    # An empty scrape is padded to the actor's 15-item billing minimum with
    # "mock_tweet" pricing reminders (observed 2026-08-27: ten straight
    # fetches of nothing but notices). They are never evidence, even if a
    # future notice shape carried text and a likeCount.
    notice = {
        "id": "-1",
        "type": "mock_tweet",
        "text": "From KaitoEasyAPI, a reminder: our pricing is based on volume",
        "likeCount": 99999,
    }
    respx.post(_RUN_URL).respond(
        json=[notice, _tweet("t1", "Margarita weekend", 900) | {"type": "tweet"}]
    )
    async with httpx.AsyncClient() as http:
        posts = await twitter.fetch_posts(http, _settings())
    assert [(p.title, p.score) for p in posts] == [("Margarita weekend", 900)]


@respx.mock
async def test_fetch_posts_all_notices_yields_empty() -> None:
    respx.post(_RUN_URL).respond(
        json=[{"id": "-1", "type": "mock_tweet", "text": "pricing reminder"}] * 15
    )
    async with httpx.AsyncClient() as http:
        assert await twitter.fetch_posts(http, _settings()) == []


@respx.mock
async def test_fetch_posts_fail_soft_on_exhausted_credit() -> None:
    # Apify replies 402 when the free monthly credit is spent mid-month.
    respx.post(_RUN_URL).respond(status_code=402)
    async with httpx.AsyncClient() as http:
        assert await twitter.fetch_posts(http, _settings()) == []


@respx.mock
async def test_fetch_posts_fail_soft_on_unexpected_payload() -> None:
    respx.post(_RUN_URL).respond(json={"error": "actor changed its output"})
    async with httpx.AsyncClient() as http:
        assert await twitter.fetch_posts(http, _settings()) == []
