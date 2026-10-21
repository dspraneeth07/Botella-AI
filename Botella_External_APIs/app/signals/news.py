"""Local/regional news client (NewsData.io free tier — commercial use OK).

Filters to the store's region and a small set of tracked categories that can
move liquor demand (tariffs, supply chain, layoffs, viral cocktail trends,
local festivals). Requires ``newsdata_api_key``; returns empty without it.

Most news stays soft context for the LLM. Two headline shapes that move demand
in a clear *direction* — a viral cocktail trend and a local festival — also emit
candidate-selection keys (``news_viral_cocktail``, ``news_festival``). Macro
stories (tariffs, layoffs) are left as soft context only: their effect on what
to stock is ambiguous, so they should inform the model's reasoning without
forcing a category into the eligible pool.
"""

from __future__ import annotations

import httpx

from app.config import Settings
from app.logging_config import get_logger
from app.schemas.signals import NewsSignal
from app.schemas.store import StoreProfile
from app.signals.us_states import STATE_NAMES

log = get_logger(__name__)

_NEWSDATA_URL = "https://newsdata.io/api/1/news"
_TRACKED_QUERY = (
    "tariff OR \"supply chain\" OR layoffs OR \"viral cocktail\" OR festival OR distillery"
)

# Two-letter state code -> full name, used to scope the query to the store's
# state. The full name is AND-ed as a quoted phrase; the bare abbreviation
# would be useless as a keyword ("OR", "IN", "HI" and "OK" are English words,
# and "... OR OR" is a malformed query).
_STATE_NAMES = STATE_NAMES

# Headline substring -> candidate-selection key. Only strong, direction-clear
# demand signals get a key; each key must exist in ``SIGNAL_CATEGORY_MAP``.
# Deliberately narrow phrases: a bare "cocktail" would match e.g. "Molotov
# cocktail" headlines and trigger a vodka/tequila eligibility wave — and a
# bare "festival" had the same shape ("film festival canceled", "disease may
# pause wine imports during festival season" all fired demand-up
# news_festival), so only festival phrases that imply a drinking crowd
# actually gathering qualify.
_HEADLINE_KEYS: list[tuple[str, str]] = [
    ("viral cocktail", "news_viral_cocktail"),
    ("cocktail trend", "news_viral_cocktail"),
    ("cocktail recipe", "news_viral_cocktail"),
    ("trending cocktail", "news_viral_cocktail"),
    ("music festival", "news_festival"),
    ("beer festival", "news_festival"),
    ("wine festival", "news_festival"),
    ("food festival", "news_festival"),
    ("street festival", "news_festival"),
    ("arts festival", "news_festival"),
    ("festival this weekend", "news_festival"),
    ("festival returns", "news_festival"),
]


def build_query(state: str | None, *, broad: bool = False) -> str:
    """The NewsData ``q`` value.

    Narrow mode (keyword pipeline): ``(topics) AND "New York"`` — the topical
    filter stays intact while results localize.

    Broad mode (LLM analyst downstream): ``"New York" OR (topics)`` — recall
    over precision, because the analyst filters relevance semantically and a
    keyword pre-filter at the *source* would silently drop demand-moving news
    the keyword list never anticipated. The full state name is quoted, so this
    never degenerates into the old malformed ``... OR OR`` shape.
    """
    state_name = _STATE_NAMES.get((state or "").strip().upper())
    if not state_name:
        return _TRACKED_QUERY
    if broad:
        return f'"{state_name}" OR ({_TRACKED_QUERY})'
    return f'({_TRACKED_QUERY}) AND "{state_name}"'


def keys_for_news(news: list[NewsSignal]) -> list[str]:
    """Pure mapping of fetched news -> sorted, de-duplicated active keys."""
    keys: set[str] = set()
    for item in news:
        headline = (item.headline or "").lower()
        for needle, key in _HEADLINE_KEYS:
            if needle in headline:
                keys.add(key)
    return sorted(keys)


async def fetch(
    store: StoreProfile,
    http: httpx.AsyncClient,
    settings: Settings,
    *,
    broad: bool = False,
) -> tuple[list[NewsSignal], list[str]]:
    """Fetch headlines + keyword-derived keys.

    ``broad=True`` (set when the LLM analyst will post-process) widens the
    query and keeps more headlines, since relevance filtering happens
    downstream semantically instead of here lexically.
    """
    if not settings.newsdata_api_key:
        return [], []

    params = {
        "apikey": settings.newsdata_api_key,
        "language": "en",
        "country": "us",
        "q": build_query(store.state, broad=broad),
    }

    try:
        resp = await http.get(_NEWSDATA_URL, params=params)
        resp.raise_for_status()
        results = resp.json().get("results", []) or []
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("news_fetch_failed", location_id=store.id, error=str(exc))
        return [], []

    # Dedupe syndicated copies of one wire story (same title from N outlets)
    # before slicing, so duplicates can't eat the whole headline window.
    signals: list[NewsSignal] = []
    seen_titles: set[str] = set()
    limit = 10 if broad else 5
    for item in results:
        title = (item.get("title") or "").strip()
        title_norm = title.lower()
        if not title or title_norm in seen_titles:
            continue
        seen_titles.add(title_norm)
        signals.append(
            NewsSignal(
                headline=title,
                category=(item.get("category") or ["general"])[0],
                source=item.get("source_id"),
                url=item.get("link"),
                description=item.get("description"),
            )
        )
        if len(signals) >= limit:
            break
    return signals, keys_for_news(signals)
