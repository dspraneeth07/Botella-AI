"""Google Trends client (unofficial widget API — the endpoints pytrends wraps).

Quantifies search momentum for a curated seed list of drink terms, scoped to
the store's STATE (``geo=US-XX``) so a trend building in Texas doesn't page a
Vermont store. Only terms whose recent interest clearly outruns their own
baseline become signals; flat or fading terms stay silent.

There is no official public API, so this source is deliberately the fragile
one: OFF by default (``google_trends_enabled``), fail-soft on every error, and
cached per state so a whole state's stores share one fetch per TTL. A 429
aborts the remaining batches instead of hammering the endpoint. If Google
breaks the widget shape, the channel degrades to Reddit-only.

Two requests per batch of up to 5 terms (the comparison limit): ``explore``
issues widget tokens, ``widgetdata/multiline`` returns the timeseries.
Responses carry an anti-JSON prefix (``)]}'``) that must be stripped.
"""

from __future__ import annotations

import asyncio
import json

import httpx

from app.config import Settings
from app.logging_config import get_logger
from app.schemas.signals import TrendSignal
from app.schemas.store import StoreProfile
from app.signals.social import TrendPost, trend_key
from app.signals.us_states import STATE_NAMES
from app.store_data.categorize import classify_from_name

log = get_logger(__name__)

_EXPLORE_URL = "https://trends.google.com/trends/api/explore"
_WIDGET_URL = "https://trends.google.com/trends/api/widgetdata/multiline"
_RELATED_URL = "https://trends.google.com/trends/api/widgetdata/relatedsearches"
_WARMUP_URL = "https://trends.google.com/trends/explore"
_BATCH_SIZE = 5  # Google Trends compares at most 5 terms per request.
# Points averaged for "recent" interest. The default timeframe (today 3-m)
# returns daily points, so 7 points = the trailing week.
_RECENT_POINTS = 7


def _strip_prefix(text: str) -> dict:
    """Widget responses are JSON behind an anti-hijacking prefix line."""
    return json.loads(text[text.index("{"):])


def momentum_of(values: list[int], *, threshold: float, min_interest: int) -> tuple[str, int]:
    """(momentum verdict, recent interest) from one term's timeseries.

    Recent = mean of the trailing week; baseline = mean of everything before
    it. Rising needs the recent level to beat the baseline by ``threshold``
    AND clear ``min_interest`` — a term drifting from 1 to 2 interest is
    noise, not a trend.
    """
    if len(values) <= _RECENT_POINTS:
        return "stable", round(sum(values) / len(values)) if values else 0
    recent_values = values[-_RECENT_POINTS:]
    base_values = values[:-_RECENT_POINTS]
    recent = sum(recent_values) / len(recent_values)
    base = sum(base_values) / len(base_values)
    if recent >= max(base, 0.1) * threshold and recent >= min_interest:
        return "rising", round(recent)
    if base >= min_interest and recent <= base * 0.75:
        return "declining", round(recent)
    return "stable", round(recent)


async def _batch_series(
    terms: list[str], geo: str, http: httpx.AsyncClient, settings: Settings
) -> dict[str, list[int]]:
    """Timeseries per term for one explore+widget round trip."""
    explore_req = {
        "comparisonItem": [
            {"keyword": term, "geo": geo, "time": settings.google_trends_timeframe}
            for term in terms
        ],
        "category": 0,
        "property": "",
    }
    explore_resp = await http.get(
        _EXPLORE_URL,
        params={"hl": "en-US", "tz": "0", "req": json.dumps(explore_req)},
    )
    explore_resp.raise_for_status()
    widgets = _strip_prefix(explore_resp.text).get("widgets") or []
    timeseries = next((w for w in widgets if w.get("id") == "TIMESERIES"), None)
    if timeseries is None:
        raise ValueError("no TIMESERIES widget in explore response")

    widget_resp = await http.get(
        _WIDGET_URL,
        params={
            "hl": "en-US",
            "tz": "0",
            "req": json.dumps(timeseries["request"]),
            "token": timeseries["token"],
        },
    )
    widget_resp.raise_for_status()
    timeline = (_strip_prefix(widget_resp.text).get("default") or {}).get("timelineData") or []

    series: dict[str, list[int]] = {term: [] for term in terms}
    for point in timeline:
        values = point.get("value") or []
        for term, value in zip(terms, values, strict=False):
            series[term].append(int(value))
    return series


async def _seed_rising_queries(
    seed: str, http: httpx.AsyncClient, settings: Settings
) -> list[dict]:
    """Rising related queries for one seed term (national geo), raw entries."""
    explore_req = {
        "comparisonItem": [{"keyword": seed, "geo": "US", "time": settings.google_trends_timeframe}],
        "category": 0,
        "property": "",
    }
    explore_resp = await http.get(
        _EXPLORE_URL,
        params={"hl": "en-US", "tz": "0", "req": json.dumps(explore_req)},
    )
    explore_resp.raise_for_status()
    widgets = _strip_prefix(explore_resp.text).get("widgets") or []
    related = next((w for w in widgets if w.get("id") == "RELATED_QUERIES"), None)
    if related is None:
        raise ValueError("no RELATED_QUERIES widget in explore response")

    resp = await http.get(
        _RELATED_URL,
        params={
            "hl": "en-US",
            "tz": "0",
            "req": json.dumps(related["request"]),
            "token": related["token"],
        },
    )
    resp.raise_for_status()
    ranked = (_strip_prefix(resp.text).get("default") or {}).get("rankedList") or []
    # rankedList[0] = top queries (steady favorites), rankedList[-1] = rising.
    rising = ranked[-1].get("rankedKeyword") or [] if ranked else []
    return rising


async def fetch_rising_posts(
    http: httpx.AsyncClient, settings: Settings
) -> list[TrendPost]:
    """DISCOVERY: breakout search queries around broad drink seeds -> TrendPosts.

    Feeds the same discovery channel as Reddit/YouTube (the trend analyst and
    the keyword floor both work on any TrendPost mix), so drink names nobody
    curated can surface from search behavior. National geo (discovery is
    cached globally); the state-scoped momentum fetch above stays the
    quantification side. Fail-soft like everything on this endpoint: any
    error returns [] and the channel degrades to Reddit/YouTube.
    """
    if (
        not settings.social_trends_enabled
        or not settings.google_trends_enabled
        or not settings.google_trends_discovery_seeds
    ):
        return []

    try:
        await http.get(_WARMUP_URL, params={"geo": "US"})
    except httpx.HTTPError:
        pass

    posts: list[TrendPost] = []
    seen: set[str] = set()
    retried_429 = False
    for seed in settings.google_trends_discovery_seeds:
        await asyncio.sleep(settings.google_trends_batch_pause_seconds)
        try:
            rising = await _seed_rising_queries(seed, http, settings)
        except httpx.HTTPStatusError as exc:
            # Same quirk as the momentum fetch above: the first call from a
            # fresh process 429s while setting the cookies later calls need —
            # one paused retry then succeeds. A second 429 is a real throttle
            # window: stop hammering and keep what we have.
            if exc.response.status_code == 429 and not retried_429:
                retried_429 = True
                log.info("google_trends_rising_retry_after_429", seed=seed)
                await asyncio.sleep(settings.google_trends_batch_pause_seconds)
                try:
                    rising = await _seed_rising_queries(seed, http, settings)
                except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc2:
                    log.warning("google_trends_rising_failed", seed=seed, error=str(exc2))
                    break
            else:
                log.warning(
                    "google_trends_rising_failed", seed=seed,
                    status=exc.response.status_code,
                )
                if exc.response.status_code == 429:
                    break
                continue
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            log.warning("google_trends_rising_failed", seed=seed, error=str(exc))
            continue
        for entry in rising:
            query = str(entry.get("query") or "").strip().lower()
            value = int(entry.get("value") or 0)
            if not query or query in seen or value < settings.google_trends_rising_min_growth:
                continue
            seen.add(query)
            posts.append(TrendPost(
                title=query,
                origin=f'Google Trends breakout (US, around "{seed}")',
                platform="search",
                score=value,
            ))
    posts.sort(key=lambda p: p.score, reverse=True)
    posts = posts[: settings.google_trends_rising_max]
    if posts:
        log.info("google_trends_rising_fetched", queries=[p.title for p in posts])
    return posts


async def fetch(
    store: StoreProfile, http: httpx.AsyncClient, settings: Settings
) -> tuple[list[TrendSignal], list[str], list[str]]:
    """Rising seed terms for the store's state -> (signals, categories, keywords).

    Keys ride on the signals themselves (``trend_<term>``), matching the
    Reddit channel so ``social.combine`` can merge same-term entries.
    """
    if (
        not settings.social_trends_enabled
        or not settings.google_trends_enabled
        or not settings.google_trends_seed_terms
    ):
        return [], [], []

    state = (store.state or "").strip().upper()
    geo = f"US-{state}" if state in STATE_NAMES else "US"
    seed_terms = settings.google_trends_seed_terms

    series: dict[str, list[int]] = {}
    try:
        # Warm up the cookie jar; without Google's NID cookie the API 429s.
        await http.get(_WARMUP_URL, params={"geo": "US"})
    except httpx.HTTPError:
        pass
    retried_429 = False
    for start in range(0, len(seed_terms), _BATCH_SIZE):
        batch = seed_terms[start : start + _BATCH_SIZE]
        # The endpoint throttles rapid-fire requests. One fetch per state per
        # TTL means pausing before EVERY batch costs seconds a day, not per
        # request.
        await asyncio.sleep(settings.google_trends_batch_pause_seconds)
        try:
            series.update(await _batch_series(batch, geo, http, settings))
        except httpx.HTTPStatusError as exc:
            # Known quirk: the FIRST call from a fresh process gets a 429
            # that itself sets the cookies later calls need — a single
            # paused retry then succeeds (observed: probe attempt 1 429'd,
            # attempt 2 in the same process passed). Retry once per fetch;
            # a second 429 means a real throttle window, so stop hammering
            # and keep what we have.
            if exc.response.status_code == 429 and not retried_429:
                retried_429 = True
                log.info("google_trends_retry_after_429", terms=batch)
                await asyncio.sleep(settings.google_trends_batch_pause_seconds)
                try:
                    series.update(await _batch_series(batch, geo, http, settings))
                    continue
                except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc2:
                    log.warning("google_trends_batch_failed", error=str(exc2), terms=batch)
                    break
            log.warning(
                "google_trends_batch_failed",
                status=exc.response.status_code,
                terms=batch,
            )
            break
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            log.warning("google_trends_batch_failed", error=str(exc), terms=batch)
            continue

    signals: list[TrendSignal] = []
    categories: set[str] = set()
    keywords: set[str] = set()
    for term, values in series.items():
        verdict, interest = momentum_of(
            values,
            threshold=settings.google_trends_rising_threshold,
            min_interest=settings.google_trends_min_interest,
        )
        if verdict != "rising":
            continue
        signals.append(
            TrendSignal(
                term=term,
                source="google_trends",
                momentum="rising",
                interest=interest,
                evidence=f"search interest rising in {geo}",
                key=trend_key(term),
            )
        )
        token = classify_from_name(term)
        if token:
            categories.add(token)
        keywords.add(term.strip().lower())
    if signals:
        log.info("google_trends_fetched", rising=[s.term for s in signals], geo=geo)
    return signals, sorted(categories), sorted(keywords)
