from __future__ import annotations

import httpx
import respx

from app.clients.geocode import Geocoder
from app.config import Settings
from app.schemas.store import StoreProfile

URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"


def _settings() -> Settings:
    return Settings(node_api_base_url="http://node.test", anthropic_api_key="x")


def _match_response() -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "result": {
                "addressMatches": [
                    {"coordinates": {"x": -74.1296, "y": 44.3267}}  # x=lng, y=lat
                ]
            }
        },
    )


def test_profile_builds_oneline_address_from_parts() -> None:
    p = StoreProfile(
        id=1, name="Shop", address="251 Broadway", city="Saranac Lake",
        state="NY", postal_code="12983", country="USA",
    )
    assert p.oneline_address == "251 Broadway, Saranac Lake, NY, 12983"
    assert p.zip_code == "12983"  # parsed from postal_code alias
    assert p.has_geo is False
    assert p.is_us is True


@respx.mock
async def test_geocode_returns_lat_lng_and_caches() -> None:
    route = respx.get(URL).mock(return_value=_match_response())
    geocoder = Geocoder(httpx.AsyncClient(), _settings())
    try:
        coords = await geocoder.geocode("251 Broadway, Saranac Lake, NY, 12983")
        assert coords == (44.3267, -74.1296)  # (lat, lng)
        # Second call is served from cache — no extra HTTP request.
        await geocoder.geocode("251 Broadway, Saranac Lake, NY, 12983")
        assert route.call_count == 1
    finally:
        await geocoder._http.aclose()


@respx.mock
async def test_geocode_no_match_returns_none() -> None:
    respx.get(URL).mock(return_value=httpx.Response(200, json={"result": {"addressMatches": []}}))
    geocoder = Geocoder(httpx.AsyncClient(), _settings())
    try:
        assert await geocoder.geocode("nowhere") is None
    finally:
        await geocoder._http.aclose()


@respx.mock
async def test_geocode_no_match_is_cached() -> None:
    route = respx.get(URL).mock(
        return_value=httpx.Response(200, json={"result": {"addressMatches": []}})
    )
    geocoder = Geocoder(httpx.AsyncClient(), _settings())
    try:
        assert await geocoder.geocode("nowhere") is None
        assert await geocoder.geocode("nowhere") is None  # definitive miss -> cached
        assert route.call_count == 1
    finally:
        await geocoder._http.aclose()


@respx.mock
async def test_geocode_transient_error_is_not_cached() -> None:
    # A Census outage must not permanently disable weather/events for the
    # store: the failed lookup is retried on the next call.
    route = respx.get(URL)
    route.side_effect = [httpx.Response(503), _match_response()]
    geocoder = Geocoder(httpx.AsyncClient(), _settings())
    try:
        assert await geocoder.geocode("251 Broadway") is None  # outage
        assert await geocoder.geocode("251 Broadway") == (44.3267, -74.1296)  # retried
        assert route.call_count == 2
    finally:
        await geocoder._http.aclose()


@respx.mock
async def test_geocode_disabled_short_circuits() -> None:
    route = respx.get(URL).mock(return_value=_match_response())
    settings = Settings(
        node_api_base_url="http://node.test", anthropic_api_key="x", geocoding_enabled=False
    )
    geocoder = Geocoder(httpx.AsyncClient(), settings)
    try:
        assert await geocoder.geocode("251 Broadway") is None
        assert route.call_count == 0
    finally:
        await geocoder._http.aclose()


@respx.mock
async def test_ensure_geo_populates_from_address() -> None:
    from app.recommender.context_builder import _ensure_geo

    respx.get(URL).mock(return_value=_match_response())
    geocoder = Geocoder(httpx.AsyncClient(), _settings())
    store = StoreProfile(
        id=1, name="S", address="251 Broadway", city="Saranac Lake",
        state="NY", postal_code="12983", country="USA",
    )
    try:
        updated = await _ensure_geo(store, geocoder)
        assert updated.has_geo is True
        assert updated.latitude == 44.3267 and updated.longitude == -74.1296
    finally:
        await geocoder._http.aclose()


@respx.mock
async def test_ensure_geo_skips_non_us() -> None:
    from app.recommender.context_builder import _ensure_geo

    route = respx.get(URL).mock(return_value=_match_response())
    geocoder = Geocoder(httpx.AsyncClient(), _settings())
    store = StoreProfile(id=1, name="S", address="10 Downing St", city="London", country="UK")
    try:
        updated = await _ensure_geo(store, geocoder)
        assert updated.has_geo is False  # non-US -> not geocoded via Census
        assert route.call_count == 0
    finally:
        await geocoder._http.aclose()
