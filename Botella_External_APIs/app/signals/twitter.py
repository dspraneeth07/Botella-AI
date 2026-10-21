"""Twitter/X discovery source (Apify pay-per-result actor).

The official X API has had no free read tier since Feb 2026 ($0.005 per post
read), so this source rides an Apify Store actor instead: one synchronous
actor run per cache TTL searches every configured drink query and returns the
tweets as dataset items. At ~$0.20 per 1,000 tweets a daily ~100-tweet fetch
costs about two cents, inside Apify's free $5/month plan credit.

Same contract as the YouTube fetcher: reduces the platform to
:class:`TrendPost` evidence for the discovery channel, dormant until
``apify_token`` is set, fail-soft on every error (the free credit hard-stops
runs when exhausted mid-month; that surfaces here as an HTTP error and the
channel simply degrades to the other platforms). ``score`` is the tweet's
like count, which rides at rough Reddit-upvote parity in the analyst's
ranking (no divisor branch needed, unlike YouTube views).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx

from app.config import Settings
from app.logging_config import get_logger
from app.signals.social import TrendPost

log = get_logger(__name__)

_RUN_SYNC_URL = "https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items"
# A synchronous actor run blocks until the scrape finishes (typically well
# under a minute for ~100 tweets); the shared signal client's default timeout
# is sized for plain REST calls, so this request carries its own.
_RUN_TIMEOUT = httpx.Timeout(180.0, connect=30.0)


def _week_ago() -> str:
    return (datetime.now(UTC) - timedelta(days=7)).strftime("%Y-%m-%d")


async def fetch_posts(http: httpx.AsyncClient, settings: Settings) -> list[TrendPost]:
    """This week's high-engagement drink tweets across the configured queries.

    Each query is sent with X advanced-search operators baked in (`since:` a
    week back, `min_faves:` the like floor, `lang:en`) so the pay-per-result
    actor is not billed for junk, and the like floor is applied again on the
    returned counts because search operators are advisory on scraped data.
    Retweets are skipped (duplicate content) and tweets are deduped by id
    across queries.
    """
    if (
        not settings.social_trends_enabled
        or not settings.apify_token
        or not settings.twitter_queries
    ):
        return []

    since = _week_ago()
    run_input = {
        "searchTerms": [
            f"{query} min_faves:{settings.twitter_min_likes} since:{since} lang:en"
            for query in settings.twitter_queries
        ],
        "maxItems": settings.twitter_max_items,
        "queryType": "Top",
        "lang": "en",
    }
    try:
        resp = await http.post(
            _RUN_SYNC_URL.format(actor=settings.twitter_apify_actor),
            params={"token": settings.apify_token},
            json=run_input,
            timeout=_RUN_TIMEOUT,
        )
        resp.raise_for_status()
        items = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("twitter_fetch_failed", error=str(exc))
        return []
    if not isinstance(items, list):
        log.warning("twitter_fetch_failed", error="unexpected payload shape")
        return []

    posts: list[TrendPost] = []
    seen: set[str] = set()
    notices = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        # An empty scrape is padded to the actor's 15-item billing minimum
        # with "mock_tweet" pricing-notice rows; anything explicitly typed as
        # a non-tweet is a notice, never evidence. (Real tweets carry
        # type "tweet"; absent type is tolerated for forward compat.)
        if item.get("type") not in (None, "tweet"):
            notices += 1
            continue
        text = " ".join(str(item.get("text") or "").split())
        likes = int(item.get("likeCount") or 0)
        tweet_id = str(item.get("id") or "")
        # The like floor drops anything the search operators let through.
        if not text or likes < settings.twitter_min_likes or item.get("isRetweet"):
            continue
        if tweet_id and tweet_id in seen:
            continue
        seen.add(tweet_id)
        author = (item.get("author") or {}).get("userName") or "X"
        posts.append(
            TrendPost(
                title=text,
                origin=f"X: @{author}",
                platform="twitter",
                score=likes,
            )
        )
    posts.sort(key=lambda p: p.score, reverse=True)
    del posts[settings.twitter_max_posts:]
    if not posts and notices:
        # The scrape matched nothing and we still paid the billing minimum —
        # the queries are too narrow (X search ANDs space-separated words).
        log.warning(
            "twitter_actor_returned_no_tweets",
            notice_rows=notices,
            queries=settings.twitter_queries,
        )
    else:
        log.info(
            "twitter_fetched", tweets=len(posts),
            queries=len(settings.twitter_queries), notice_rows=notices,
        )
    return posts
