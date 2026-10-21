"""Ticketmaster Discovery API client (free tier: 5,000 calls/day, 5 req/sec).

Returns local concerts / events within a radius of the store over the lookahead
window. Requires ``ticketmaster_api_key``; returns an empty list when the key or
the store's geo is missing.

Events now also emit candidate-selection keys (``event_concert``,
``event_sports``, ...) so a nearby concert or festival actually widens the
signal-aligned candidate slice — see ``app.signals.mapping``. Previously events
were prompt-only context and never influenced which products were eligible.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx

from app.config import Settings
from app.logging_config import get_logger
from app.schemas.signals import EventSignal
from app.schemas.store import StoreProfile

log = get_logger(__name__)

_DISCOVERY_URL = "https://app.ticketmaster.com/discovery/v2/events.json"

# Ticketmaster "segment" (top-level classification) -> candidate-selection key.
# The key must exist in ``SIGNAL_CATEGORY_MAP``.
_SEGMENT_KEYS: dict[str, str] = {
    "music": "event_concert",
    "sports": "event_sports",
    "arts & theatre": "event_arts",
    "arts and theatre": "event_arts",
    "film": "event_arts",
}
# Event names that imply a festival (drinking-heavy crowd). Word-bounded, with
# "-fest" matched as a word ENDING (Oktoberfest, Brewfest, Winefest) — a bare
# substring check matched "fest" inside "Lifestyle Expo". "manifest"-style
# false positives are accepted noise; event names rarely contain them.
_FESTIVAL_RE = re.compile(r"\b(?:\w*fest|festival|festivals|fair|carnival)\b", re.IGNORECASE)

# Every event within the radius is "local" by construction; this broad key
# guarantees beer/wine/spirits eligibility even for an unclassified event.
_NEARBY_KEY = "event_nearby"

# In broad mode (LLM event analyst on) the fetch returns up to this many and
# the analyst trims back to ``settings.events_max_kept`` after dropping
# irrelevant events: recall over precision, filtering is semantic downstream
# (same pattern as the news analyst's broad query).
_BROAD_FETCH_SIZE = 20


def keys_for_event(e: EventSignal) -> set[str]:
    """Segment-derived citable keys for ONE event.

    Single source of truth shared with ``keys_for_events`` AND with the
    snapshot trim's cited-keys retention (``SignalBundle._entry_keys``): a
    recommendation citing ``event_festival`` / ``event_concert`` / ... must
    keep the backing event entry alive, so both sides derive the same keys.
    """
    keys: set[str] = {_NEARBY_KEY}
    segment = (e.category or "").strip().lower()
    if segment in _SEGMENT_KEYS:
        keys.add(_SEGMENT_KEYS[segment])
    if _FESTIVAL_RE.search(e.name or ""):
        keys.add("event_festival")
    return keys


def keys_for_events(events: list[EventSignal]) -> list[str]:
    """Pure mapping of fetched events -> sorted, de-duplicated active keys."""
    keys: set[str] = set()
    for e in events:
        keys |= keys_for_event(e)
    return sorted(keys)


def _coerce_distance(raw: Any) -> float | None:
    try:
        return round(float(raw), 1)
    except (TypeError, ValueError):
        return None


def _parse_date(raw: str | None) -> date | None:
    try:
        return date.fromisoformat(raw) if raw else None
    except ValueError:
        return None


# Max calendar-day gap between performances that still counts as one run.
_RUN_GAP_DAYS = 2


def _dedupe_runs(events: list[EventSignal]) -> list[EventSignal]:
    """Collapse multi-night runs (same name + venue, adjacent dates) into one.

    Ticketmaster returns one entry per performance date, so a 3-night arena
    run would eat 3 of the few event slots. The feed is date-sorted, so the
    first occurrence keeps the earliest date; ``nights`` counts the rest.

    A run is only a run when the dates are actually adjacent: two "Wine
    Tasting" bookings at the same hall three weeks apart are distinct events,
    and merging them inflated the draw judgment (multi-night reads bigger)
    while hiding the later date entirely. Entries without parseable dates
    keep the old collapse-everything behavior — no adjacency can be proven
    either way, and slot conservation wins.
    """
    runs: list[tuple[tuple[str, str], EventSignal, date | None]] = []
    latest: dict[tuple[str, str], int] = {}  # run key -> index of its open run
    for e in events:
        key = ((e.name or "").strip().lower(), (e.venue or "").strip().lower())
        e_date = _parse_date(e.date)
        open_index = latest.get(key)
        if open_index is not None:
            _, existing, last_date = runs[open_index]
            adjacent = (
                e_date is None
                or last_date is None
                or 0 <= (e_date - last_date).days <= _RUN_GAP_DAYS
            )
            if adjacent:
                runs[open_index] = (
                    key,
                    existing.model_copy(update={"nights": existing.nights + 1}),
                    e_date or last_date,
                )
                continue
        latest[key] = len(runs)
        runs.append((key, e, e_date))
    return [signal for _, signal, _ in runs]


async def fetch(
    store: StoreProfile, http: httpx.AsyncClient, settings: Settings, *, broad: bool = False
) -> tuple[list[EventSignal], list[str]]:
    if not settings.ticketmaster_api_key or not store.has_geo:
        return [], []

    now = datetime.now(UTC)
    end = now + timedelta(days=settings.signal_lookahead_days)
    params: dict[str, Any] = {
        "apikey": settings.ticketmaster_api_key,
        "latlong": f"{store.latitude},{store.longitude}",
        "radius": settings.event_radius_miles,
        "unit": "miles",
        "startDateTime": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "endDateTime": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "size": _BROAD_FETCH_SIZE,
        "sort": "date,asc",
    }
    try:
        resp = await http.get(_DISCOVERY_URL, params=params)
        resp.raise_for_status()
        events = (resp.json().get("_embedded") or {}).get("events", [])
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("events_fetch_failed", location_id=store.id, error=str(exc))
        return [], []

    results: list[EventSignal] = []
    for event in events:
        venues = (event.get("_embedded") or {}).get("venues") or []
        venue_name = venues[0].get("name") if venues else None
        classifications = event.get("classifications") or []
        segment = None
        if classifications:
            segment = (classifications[0].get("segment") or {}).get("name")
        dates = (event.get("dates") or {}).get("start") or {}
        results.append(
            EventSignal(
                name=event.get("name", "Event"),
                venue=venue_name,
                date=dates.get("localDate"),
                distance_mi=_coerce_distance(event.get("distance")),
                category=segment,
            )
        )
    deduped = _dedupe_runs(results)
    trimmed = deduped if broad else deduped[: settings.events_max_kept]
    return trimmed, keys_for_events(trimmed)
