"""Address -> (lat, lng) via the free US Census geocoder.

No API key, US-only (which lines up with NWS weather being US-only). Results are
cached in-process keyed by the normalized address, so each store is geocoded at
most once per process lifetime — at 1,200 stores that's negligible, and a flaky
or no-match lookup simply returns None (weather + events then stay inert).
"""

from __future__ import annotations

import httpx

from app.config import Settings
from app.logging_config import get_logger

log = get_logger(__name__)

Coordinates = tuple[float, float]  # (latitude, longitude)


class Geocoder:
    def __init__(self, http: httpx.AsyncClient, settings: Settings) -> None:
        self._http = http
        self._url = settings.census_geocoder_url
        self._enabled = settings.geocoding_enabled
        # Caches only *definitive* outcomes: successful hits and confirmed
        # no-matches. Transient errors (Census outage, timeout) are NOT cached,
        # so the next run retries instead of leaving weather/events disabled
        # for the rest of the process lifetime.
        self._cache: dict[str, Coordinates | None] = {}

    async def geocode(self, address: str) -> Coordinates | None:
        if not self._enabled:
            return None
        key = " ".join(address.lower().split())
        if not key:
            return None
        if key in self._cache:
            return self._cache[key]
        coords, definitive = await self._lookup(address)
        if definitive:
            self._cache[key] = coords
        return coords

    async def _lookup(self, address: str) -> tuple[Coordinates | None, bool]:
        """Return (coordinates, definitive). Non-definitive results are transient."""
        params = {"address": address, "benchmark": "Public_AR_Current", "format": "json"}
        try:
            resp = await self._http.get(self._url, params=params)
            resp.raise_for_status()
            matches = (resp.json().get("result") or {}).get("addressMatches") or []
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("geocode_failed", address=address, error=str(exc))
            return None, False

        if not matches:
            log.info("geocode_no_match", address=address)
            return None, True

        coords = matches[0].get("coordinates") or {}
        lat, lng = coords.get("y"), coords.get("x")
        if lat is None or lng is None:
            return None, True
        return (float(lat), float(lng)), True
