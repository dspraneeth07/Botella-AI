"""Reddit discovery source (official OAuth API, client-credentials grant).

Pulls the week's top posts from a configured list of drinks subreddits as
:class:`TrendPost` evidence for the social-trend channel (see
``app.signals.social`` for the keyword floor and ``app.signals.trend_analyst``
for the LLM extraction that runs over the combined discovery feed).

The whole network shares ONE fetch per cache TTL (the mailbox pattern): what
is trending on Reddit is not store-specific. Free tier allows 100 requests a
minute with OAuth — two requests per TTL (token + listing) is nowhere near it.
Dormant until ``reddit_client_id`` / ``reddit_client_secret`` are set.
"""

from __future__ import annotations

import httpx

from app.config import Settings
from app.logging_config import get_logger
from app.signals.social import TrendPost

log = get_logger(__name__)

_TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
_LISTING_URL = "https://oauth.reddit.com/r/{subreddits}/top"


def _headers(settings: Settings, token: str | None = None) -> dict[str, str]:
    # Reddit requires a descriptive User-Agent and throttles the default
    # library ones — override the shared client's NWS agent per-request.
    headers = {"User-Agent": settings.reddit_user_agent}
    if token:
        headers["Authorization"] = f"bearer {token}"
    return headers


async def fetch_posts(http: httpx.AsyncClient, settings: Settings) -> list[TrendPost]:
    """This week's top posts across the configured subreddits, fail-soft.

    One multireddit listing call (``r/a+b+c/top?t=week``) instead of one call
    per subreddit. NSFW posts and posts under ``reddit_min_score`` are
    dropped — below real engagement a post title is noise, not a trend.
    """
    if (
        not settings.social_trends_enabled
        or not settings.reddit_client_id
        or not settings.reddit_client_secret
        or not settings.reddit_subreddits
    ):
        return []

    try:
        token_resp = await http.post(
            _TOKEN_URL,
            data={"grant_type": "client_credentials"},
            auth=(settings.reddit_client_id, settings.reddit_client_secret),
            headers=_headers(settings),
        )
        token_resp.raise_for_status()
        token = token_resp.json().get("access_token")
        if not token:
            raise ValueError("no access_token in Reddit token response")

        listing_resp = await http.get(
            _LISTING_URL.format(subreddits="+".join(settings.reddit_subreddits)),
            params={"t": "week", "limit": settings.reddit_top_limit},
            headers=_headers(settings, token),
        )
        listing_resp.raise_for_status()
        children = (listing_resp.json().get("data") or {}).get("children") or []
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("reddit_fetch_failed", error=str(exc))
        return []

    posts: list[TrendPost] = []
    for child in children:
        data = child.get("data") or {}
        title = (data.get("title") or "").strip()
        if not title or data.get("over_18"):
            continue
        score = int(data.get("score") or 0)
        if score < settings.reddit_min_score:
            continue
        posts.append(
            TrendPost(
                title=title,
                origin=f"r/{data.get('subreddit') or 'reddit'}",
                platform="reddit",
                score=score,
            )
        )
    log.info("reddit_fetched", posts=len(posts), subreddits=len(settings.reddit_subreddits))
    return posts
