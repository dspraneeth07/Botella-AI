from __future__ import annotations

from datetime import UTC

import httpx
import pytest
import respx

from app.clients.node_api import NodeApiClient
from app.config import Settings
from app.exceptions import NodeApiError

BASE = "http://node.test"
CLIENT_ID = 96
LOC = 1


def _client() -> NodeApiClient:
    return NodeApiClient(
        Settings(node_api_base_url=BASE, anthropic_api_key="x", node_api_max_retries=2)
    )


def _url(path: str, *, client_id: int = CLIENT_ID, loc: int = LOC) -> str:
    return f"{BASE}/api/clients/{client_id}/locations/{loc}/{path}"


@respx.mock
async def test_get_profile_parses_alias_zip_and_null_geo() -> None:
    respx.get(_url("profile")).mock(
        return_value=httpx.Response(
            200,
            json={
                "id": 1, "name": "Shop", "city": "Austin", "state": "TX",
                "latitude": None, "longitude": None, "dma_code": None, "zip": "78701",
            },
        )
    )
    client = _client()
    try:
        profile = await client.get_profile(CLIENT_ID, LOC)
        assert profile.zip_code == "78701"
        assert profile.has_geo is False  # null lat/long degrades weather + events
    finally:
        await client.aclose()


@respx.mock
async def test_inventory_accepts_data_envelope_and_null_created_at() -> None:
    respx.get(_url("inventory")).mock(
        return_value=httpx.Response(
            200,
            json={"data": [
                {"sku": "A", "product_name": "Beer", "on_hand": 5, "price": "9.99",
                 "category": "beer_mexican", "created_at": None},
            ]},
        )
    )
    client = _client()
    try:
        inv = await client.get_inventory(CLIENT_ID, LOC)
        assert inv[0].sku == "A"
        assert inv[0].price == 9.99  # string price coerced
        assert inv[0].created_at is None
    finally:
        await client.aclose()


@respx.mock
async def test_inventory_null_product_name_does_not_refuse_the_store() -> None:
    """Store 214, 22 Oct 2026: one `product_name: null` row and every run for
    the store answered 500. An unnamed SKU is still a SKU."""
    respx.get(_url("inventory")).mock(
        return_value=httpx.Response(
            200,
            json=[
                {"sku": "A", "product_name": None, "on_hand": 5, "price": 9.99},
                {"sku": "B", "product_name": "Beer", "on_hand": 1, "price": 4.5},
            ],
        )
    )
    client = _client()
    try:
        inv = await client.get_inventory(CLIENT_ID, LOC)
        assert [(r.sku, r.product_name) for r in inv] == [("A", ""), ("B", "Beer")]
    finally:
        await client.aclose()


@respx.mock
async def test_inventory_created_at_tolerates_postgres_text_and_junk() -> None:
    """A raw ``timestamptz`` render must parse, and junk must not sink the run.

    Regression: Node served Postgres's own text form, whose bare two-digit
    offset ("+00") strict ISO parsing rejects — one such row 500'd the whole
    /run-recommendations call for the store.
    """
    respx.get(_url("inventory")).mock(
        return_value=httpx.Response(
            200,
            json=[
                {"sku": "PG", "on_hand": 1, "created_at": "2026-08-06 09:52:55.394577+00"},
                {"sku": "ISO", "on_hand": 1, "created_at": "2026-08-06T09:52:55.394577Z"},
                {"sku": "NAIVE", "on_hand": 1, "created_at": "2026-08-06 09:52:55.394577"},
                {"sku": "JUNK", "on_hand": 1, "created_at": "not-a-timestamp"},
            ],
        )
    )
    client = _client()
    try:
        inv = {row.sku: row.created_at for row in await client.get_inventory(CLIENT_ID, LOC)}
        assert inv["PG"] == inv["ISO"]  # both land on the same instant
        assert inv["PG"].tzinfo is not None
        assert inv["NAIVE"].tzinfo is UTC  # naive input gets stamped UTC
        assert inv["JUNK"] is None  # degrades to "not a new arrival", never raises
    finally:
        await client.aclose()


@respx.mock
async def test_404_raises_node_error() -> None:
    respx.get(_url("profile", loc=99)).mock(return_value=httpx.Response(404))
    client = _client()
    try:
        with pytest.raises(NodeApiError) as exc:
            await client.get_profile(CLIENT_ID, 99)
        assert exc.value.status_code == 404
    finally:
        await client.aclose()


@respx.mock
async def test_5xx_retried_then_raises() -> None:
    route = respx.get(_url("sales")).mock(return_value=httpx.Response(503))
    client = _client()
    try:
        with pytest.raises(NodeApiError):
            await client.get_sales(CLIENT_ID, LOC)
        assert route.call_count == 2  # node_api_max_retries
    finally:
        await client.aclose()


@respx.mock
async def test_optional_endpoints_degrade_to_empty_on_404() -> None:
    # Node hasn't shipped these endpoints yet — that must never sink a run.
    respx.get(_url("recommendation-history")).mock(return_value=httpx.Response(404))
    respx.get(_url("co-purchases")).mock(return_value=httpx.Response(404))
    client = _client()
    try:
        feed = await client.get_recommendation_history(CLIENT_ID, LOC)
        assert feed.rows == []
        assert feed.learned.is_empty()
        assert await client.get_co_purchases(CLIENT_ID, LOC) == []
    finally:
        await client.aclose()


@respx.mock
async def test_optional_endpoints_parse_rows() -> None:
    respx.get(_url("recommendation-history")).mock(
        return_value=httpx.Response(
            200,
            json=[{"date": "2026-05-20", "category": "weather",
                   "primary_skus": ["A"], "confidence": 0.8,
                   "thumbs_up": 2, "thumbs_down": 1}],
        )
    )
    respx.get(_url("co-purchases")).mock(
        return_value=httpx.Response(
            200, json={"data": [{"sku_a": "A", "sku_b": "B", "support": 17}]}
        )
    )
    client = _client()
    try:
        feed = await client.get_recommendation_history(CLIENT_ID, LOC)
        assert feed.rows[0].rec_date.isoformat() == "2026-05-20"
        assert feed.rows[0].primary_skus == ["A"]
        assert feed.rows[0].user_score == 2 / 3  # thumbs parsed into a vote share
        # Bare-array response (older Node): measured fields and learned lists
        # degrade to their inert defaults.
        assert feed.rows[0].action_taken is None
        assert feed.rows[0].verdict is None
        assert feed.learned.is_empty()
        pairs = await client.get_co_purchases(CLIENT_ID, LOC)
        assert (pairs[0].sku_a, pairs[0].sku_b, pairs[0].support) == ("A", "B", 17)
    finally:
        await client.aclose()


@respx.mock
async def test_recommendation_history_parses_envelope_and_measured_fields() -> None:
    """Contract §1.4 envelope: {data: [rows...], effectiveness: {proven, avoid}}.
    Rows carry the additive measured fields; the learned lists parse alongside."""
    respx.get(_url("recommendation-history")).mock(
        return_value=httpx.Response(
            200,
            json={
                "data": [
                    {"date": "2026-07-01", "category": "weather",
                     "primary_skus": ["A"], "confidence": 0.8,
                     "thumbs_up": 0, "thumbs_down": 0,
                     "evaluated_score": 0.21, "action_taken": False,
                     "action_claim": "did_not", "verdict": "underperformer",
                     "lift": 0.4},
                    {"date": "2026-07-02", "category": "bundle",
                     "primary_skus": ["B"], "action_taken": None,
                     "action_claim": "dismissed", "verdict": "insufficient_data",
                     "lift": None},
                ],
                "effectiveness": {
                    "proven": [{"sku": "A", "name": "Modelo 12pk",
                                "category": "weather",
                                "evidence": "worked 2 of 2 times, avg lift 2.1x"}],
                    "avoid": [{"sku": "B", "name": None, "category": "bundle",
                               "evidence": "worked 0 of 2 times"}],
                },
            },
        )
    )
    client = _client()
    try:
        feed = await client.get_recommendation_history(CLIENT_ID, LOC)
        first, second = feed.rows
        assert first.action_taken is False  # provably not done — we checked
        assert first.action_claim == "did_not"
        assert first.verdict == "underperformer"
        assert first.lift == 0.4
        assert second.action_taken is None  # can't tell — never rounded up
        assert second.verdict == "insufficient_data"
        assert feed.learned.proven[0].evidence == "worked 2 of 2 times, avg lift 2.1x"
        assert feed.learned.avoid[0].name is None  # warehouse-down degradation
        assert feed.learned.avoid[0].category == "bundle"
    finally:
        await client.aclose()


@respx.mock
async def test_recommendation_history_bad_effectiveness_never_sinks_rows() -> None:
    respx.get(_url("recommendation-history")).mock(
        return_value=httpx.Response(
            200,
            json={
                "data": [{"date": "2026-07-01", "category": "weather",
                          "primary_skus": ["A"]}],
                "effectiveness": {"proven": [{"name": "missing sku"}], "avoid": []},
            },
        )
    )
    client = _client()
    try:
        feed = await client.get_recommendation_history(CLIENT_ID, LOC)
        assert len(feed.rows) == 1  # rows still parse
        assert feed.learned.is_empty()  # malformed lists degrade to empty
    finally:
        await client.aclose()


@respx.mock
async def test_optional_endpoint_bad_rows_degrade_to_empty() -> None:
    respx.get(_url("co-purchases")).mock(
        return_value=httpx.Response(200, json=[{"wrong": "shape"}])
    )
    client = _client()
    try:
        assert await client.get_co_purchases(CLIENT_ID, LOC) == []
    finally:
        await client.aclose()


# ── A calibration curve belongs to ONE engine (migration 032) ────────────────
#
# The curve maps a RAW RANKING SCORE onto an observed hit rate, so it is a
# statement about the engine that produced those scores. Change how candidates
# are selected or scored and the same raw 0.4 means something else: the old
# curve is then not a weaker claim about the new cards, it is a claim about a
# different quantity. Applying it turns a number nobody measured into a
# percentage wearing the word "confidence".
#
# Refusing costs nothing, because None here is the SAME absence as "no curve
# fitted yet" - the identity transform runs and the card declines to present
# its score as a probability until the next nightly refit.

_BUNDLE = {"version": "2026-10-06.abc", "fitted_at": "2026-10-06",
           "bundle": {"version": "2026-10-06.abc", "fits": [], "skipped": {}},
           "outcomes_fitted": 56, "cells_fitted": 1, "cells_skipped": 8}


@respx.mock
async def test_a_bundle_fitted_for_this_engine_is_accepted() -> None:
    from app import __version__

    respx.get(_url("calibration-bundle")).mock(return_value=httpx.Response(
        200, json={"data": {**_BUNDLE, "engine_version": __version__}}))
    client = _client()
    try:
        got = await client.get_calibration_bundle(CLIENT_ID, LOC)
    finally:
        await client.aclose()
    assert got is not None
    assert got["version"] == "2026-10-06.abc"


@respx.mock
async def test_a_bundle_fitted_for_another_engine_is_refused() -> None:
    respx.get(_url("calibration-bundle")).mock(return_value=httpx.Response(
        200, json={"data": {**_BUNDLE, "engine_version": "0.9.9-other"}}))
    client = _client()
    try:
        got = await client.get_calibration_bundle(CLIENT_ID, LOC)
    finally:
        await client.aclose()
    assert got is None, (
        "a curve fitted on another engine's raw scores was applied to this "
        "engine's cards"
    )


@respx.mock
async def test_a_bundle_with_no_engine_version_is_still_used() -> None:
    """Published before migration 032 - unknown provenance, not a mismatch.

    The estate has had exactly one engine version in its whole history, so
    treating the gap as a mismatch would discard the only curve there is in
    order to answer a question nobody has asked yet. It is logged instead.
    """
    respx.get(_url("calibration-bundle")).mock(
        return_value=httpx.Response(200, json={"data": dict(_BUNDLE)}))
    client = _client()
    try:
        got = await client.get_calibration_bundle(CLIENT_ID, LOC)
    finally:
        await client.aclose()
    assert got is not None and "engine_version" not in got
