"""NWS weather client (api.weather.gov — free, no key, US-only).

Lookup chain: lat/lng -> gridpoint -> (a) the latest observation from the
nearest reporting station, (b) forecast periods, (c) active alerts. Produces a
``WeatherSignal`` and the active keys (heat_advisory / cold_snap /
severe_weather) that drive candidate selection.

The observation in (a) is the "current conditions" weather.gov shows and is
what the owner-facing chip renders. Forecast-derived figures are scoped to the
store's own local day, never a week-wide peak — a peak from four days out
presented next to live conditions reads as the current temperature.
"""

from __future__ import annotations

import httpx

from app.config import Settings
from app.logging_config import get_logger
from app.schemas.signals import WeatherSignal
from app.schemas.store import StoreProfile

log = get_logger(__name__)

HEAT_THRESHOLD_F = 88
COLD_THRESHOLD_F = 25

# How many nearest stations to try before giving up on a live observation.
# The closest station is often a small ASOS site that reports intermittently.
_MAX_STATION_ATTEMPTS = 5

# Only alerts that change *buying* behavior (the "stock up before it hits"
# class) activate the severe_weather candidate-eligibility key. Air-quality
# alerts, rip-current statements, flood watches, etc. still appear in the
# prompt as context but never widen the candidate pool.
_IMPACT_ALERT_TERMS = (
    "winter storm",
    "winter weather",
    "blizzard",
    "ice storm",
    "heavy snow",
    "snow squall",
    "hurricane",
    "tropical storm",
    "tornado",
    "severe thunderstorm",
    "high wind",
    "extreme cold",
    "excessive heat",
    "extreme heat",
)


def _is_impactful(alert_event: str) -> bool:
    lowered = alert_event.lower()
    return any(term in lowered for term in _IMPACT_ALERT_TERMS)


def _period_date(period: dict) -> str | None:
    """Local calendar date (YYYY-MM-DD) of a forecast period.

    NWS ``startTime`` carries the local offset ("2026-08-07T06:00:00-05:00"),
    so the date prefix IS the store-local date — no tz math needed.
    """
    start = period.get("startTime") or ""
    return start[:10] or None


def _to_fahrenheit(value: float, unit_code: str | None) -> float:
    """Observations report Celsius (``wmoUnit:degC``); the forecast reports F."""
    if unit_code and "degC" in unit_code:
        return round(value * 9 / 5 + 32, 1)
    return round(float(value), 1)


async def _current_conditions(
    stations_url: str | None, http: httpx.AsyncClient, headers: dict[str, str]
) -> tuple[float | None, str | None, str | None]:
    """Latest observed (temp_f, conditions, timestamp) from the nearest station.

    Stations are returned nearest-first. The closest one frequently reports a
    null temperature (not every station reports every hour), so walk the list
    until one carries an actual reading rather than dropping current conditions
    entirely. Failing soft to ``(None, None, None)`` is deliberate: a missing
    observation must degrade the chip, not sink the whole weather signal.
    """
    if not stations_url:
        return None, None, None
    try:
        resp = await http.get(stations_url, headers=headers)
        resp.raise_for_status()
        features = resp.json().get("features", [])[:_MAX_STATION_ATTEMPTS]
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        log.warning("weather_stations_failed", error=str(exc))
        return None, None, None

    for feature in features:
        station_id = (feature.get("properties") or {}).get("stationIdentifier")
        if not station_id:
            continue
        try:
            obs = await http.get(
                f"https://api.weather.gov/stations/{station_id}/observations/latest",
                headers=headers,
            )
            obs.raise_for_status()
            props = obs.json().get("properties") or {}
        except (httpx.HTTPError, KeyError, ValueError):
            continue
        temperature = props.get("temperature") or {}
        value = temperature.get("value")
        if value is None:
            continue
        return (
            _to_fahrenheit(value, temperature.get("unitCode")),
            props.get("textDescription") or None,
            props.get("timestamp"),
        )
    return None, None, None


async def fetch(
    store: StoreProfile, http: httpx.AsyncClient, settings: Settings
) -> tuple[WeatherSignal | None, list[str]]:
    if not store.has_geo:
        return None, []

    headers = {"User-Agent": settings.nws_user_agent, "Accept": "application/geo+json"}
    # NWS /points 301-redirects coordinates with more than 4 decimal places,
    # and redirects are not followed, so a geocoded store (Census returns ~12
    # decimals) would fail outright. Round to NWS's documented precision.
    lat = round(store.latitude or 0.0, 4)
    lng = round(store.longitude or 0.0, 4)
    try:
        point = await http.get(
            f"https://api.weather.gov/points/{lat},{lng}",
            headers=headers,
        )
        point.raise_for_status()
        point_props = point.json()["properties"]
        forecast_url = point_props["forecast"]

        forecast = await http.get(forecast_url, headers=headers)
        forecast.raise_for_status()
        # NWS returns up to 14 half-day periods (~7 days). Scan the whole
        # signal window so a Friday heatwave is visible on Tuesday's run,
        # matching the lookahead the rest of the system uses.
        max_periods = max(1, settings.signal_lookahead_days * 2)
        periods = forecast.json()["properties"]["periods"][:max_periods]

        alerts_resp = await http.get(
            "https://api.weather.gov/alerts/active",
            params={"point": f"{lat},{lng}"},
            headers=headers,
        )
        alerts_resp.raise_for_status()
        alert_features = alerts_resp.json().get("features", [])
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        log.warning("weather_fetch_failed", location_id=store.id, error=str(exc))
        return None, []

    if not periods:
        return None, []

    # Live observed conditions — fetched after the forecast so a station outage
    # cannot cost us the forecast, which the alert keys still depend on.
    current_f, current_summary, observed_at = await _current_conditions(
        point_props.get("observationStations"), http, headers
    )

    # Scope the high/low to the store's OWN local day. ``periods[0]`` is the
    # period in progress right now, so its date is today's date locally.
    today = _period_date(periods[0])
    todays = [p for p in periods if _period_date(p) == today] or periods[:1]

    # A run after sunset has no daytime period left today (and one just after
    # midnight has no evening period). Fall back to the NEXT such period in
    # chronological order — never max()/min() over the remainder of the week,
    # which would reintroduce the week-wide peak this scoping exists to remove.
    day_today = [p for p in todays if p.get("isDaytime")]
    night_today = [p for p in todays if not p.get("isDaytime")]
    high_period = (
        max(day_today, key=lambda p: p["temperature"])
        if day_today
        else next((p for p in periods if p.get("isDaytime")), periods[0])
    )
    low_period = (
        min(night_today, key=lambda p: p["temperature"])
        if night_today
        else next((p for p in periods if not p.get("isDaytime")), periods[0])
    )
    high_f = high_period["temperature"]
    low_f = low_period["temperature"]

    alert_events = [a["properties"]["event"] for a in alert_features]

    active_keys: list[str] = []
    if high_f >= HEAT_THRESHOLD_F:
        active_keys.append("heat_advisory")
    if low_f <= COLD_THRESHOLD_F:
        active_keys.append("cold_snap")
    if any(_is_impactful(event) for event in alert_events):
        active_keys.append("severe_weather")

    signal = WeatherSignal(
        summary=periods[0].get("shortForecast", "n/a"),
        # The /points response already carries the gridpoint's IANA zone, so
        # the store's own calendar date costs us nothing extra. Everything
        # downstream that keys a day - the daily capture tables above all -
        # reads it from here rather than assuming the server's timezone.
        timezone=point_props.get("timeZone") or None,
        summary_date=_period_date(periods[0]),
        current_f=current_f,
        current_summary=current_summary,
        observed_at=observed_at,
        high_f=float(high_f),
        high_date=_period_date(high_period),
        low_f=float(low_f),
        low_date=_period_date(low_period),
        window_start=_period_date(periods[0]),
        window_end=_period_date(periods[-1]),
        alerts=alert_events[:5],
    )
    return signal, active_keys
