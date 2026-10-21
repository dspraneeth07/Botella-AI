"""Checklist 16 - lead times: defaults flagged as defaults, measured from receipts.

The reorder quantity rests on a delivery lead time, and that lead time was
seven days declared in three places and measurable in none - nothing recorded
when an order ARRIVED. Node now carries `purchase_orders.received_date` and a
per-vendor median with provenance (migration 037); this is the Python half:

    the feed       `NodeApiClient.get_lead_times` joins Node's vendor and SKU
                   maps into one `LeadTime` per SKU, fail-soft to empty
    the context    `RecommendationContext.lead_times`
    the quantity   `PolicyQuantities` sizes against a MEASURED vendor and the
                   policy's assumption sentence says which basis it used
    the sentence   the stockout card flags the declared seven, and quotes the
                   measured figure with its receipt count where one exists
    the invariant  `choose` without a map is byte-identical to before
"""

from __future__ import annotations

import random
from datetime import date, timedelta
from types import SimpleNamespace

import httpx
import respx

from app.clients.node_api import NodeApiClient
from app.config import Settings
from app.pipeline.context import RunContext
from app.recommender import deterministic as D
from app.recommender.quantity import FIT_WINDOW_DAYS, PolicyQuantities
from app.schemas.context import LeadTime, RecommendationContext

BASE = "http://node.test"
CLIENT_ID = 96
LOC = 1


def _client() -> NodeApiClient:
    return NodeApiClient(
        Settings(node_api_base_url=BASE, anthropic_api_key="x", node_api_max_retries=2)
    )


def _url(path: str) -> str:
    return f"{BASE}/api/clients/{CLIENT_ID}/locations/{LOC}/{path}"


GLAZERS = {
    "lead_time_days": 4, "source": "measured", "observations": 4,
    "vendor_name": "Glazers Beer & Beverage",
    "measured_from": "2026-03-06", "measured_to": "2026-06-05",
}
BREAKTHRU = {
    "lead_time_days": 7, "source": "default", "observations": 0,
    "vendor_name": "Breakthru Beverage", "measured_from": None, "measured_to": None,
}
PAYLOAD = {
    "data": {
        "vendors": {"glazersbeerandbeverage": GLAZERS, "breakthrubeverage": BREAKTHRU},
        "skus": {"MODELO12": "glazersbeerandbeverage", "TITOS750": "breakthrubeverage",
                 "ORPHAN": "nobodyever"},
        "default_days": 7, "min_observations": 3,
    }
}


# ── The feed ─────────────────────────────────────────────────────────────────


@respx.mock
async def test_the_feed_joins_vendors_onto_skus_and_keeps_provenance() -> None:
    respx.get(_url("lead-times")).mock(return_value=httpx.Response(200, json=PAYLOAD))
    client = _client()
    try:
        got = await client.get_lead_times(CLIENT_ID, LOC)
    finally:
        await client.aclose()

    g = got["MODELO12"]
    assert isinstance(g, LeadTime)
    assert g.days == 4 and g.source == "measured" and g.observations == 4
    assert g.vendor == "Glazers Beer & Beverage"
    assert g.vendor_key == "glazersbeerandbeverage"
    assert g.measured_from == date(2026, 3, 6) and g.measured_to == date(2026, 6, 5)
    assert g.is_measured

    b = got["TITOS750"]
    assert b.source == "default" and b.observations == 0 and not b.is_measured
    assert b.measured_from is None

    # A SKU whose vendor has no row is LEFT OUT, not defaulted: absence keeps
    # meaning "nobody has looked".
    assert "ORPHAN" not in got


@respx.mock
async def test_the_feed_is_fail_soft() -> None:
    """A 404 (Node without the route) and a 500 both degrade to empty - the
    quantity then rests on the declared default exactly as it did before."""
    respx.get(_url("lead-times")).mock(return_value=httpx.Response(404))
    client = _client()
    try:
        assert await client.get_lead_times(CLIENT_ID, LOC) == {}
    finally:
        await client.aclose()

    respx.get(_url("lead-times")).mock(return_value=httpx.Response(500))
    client = _client()
    try:
        assert await client.get_lead_times(CLIENT_ID, LOC) == {}
    finally:
        await client.aclose()


@respx.mock
async def test_a_malformed_row_is_skipped_not_turned_into_a_confident_default() -> None:
    bad = {
        "data": {
            "vendors": {
                "x": {"lead_time_days": "soon", "source": "measured", "observations": 3},
                "y": {"lead_time_days": 0, "source": "measured", "observations": 3},
                "z": {"lead_time_days": 5, "source": "guessed", "observations": 3},
                "ok": {"lead_time_days": "3.5", "source": "measured", "observations": 2},
            },
            "skus": {"A": "x", "B": "y", "C": "z", "D": "ok"},
        }
    }
    respx.get(_url("lead-times")).mock(return_value=httpx.Response(200, json=bad))
    client = _client()
    try:
        got = await client.get_lead_times(CLIENT_ID, LOC)
    finally:
        await client.aclose()
    assert set(got) == {"D"}
    assert got["D"].days == 3.5


def test_the_context_carries_the_map_and_defaults_to_empty() -> None:
    """The field has to be DECLARED: RecommendationContext has __slots__, and an
    undeclared assignment in the builder is an AttributeError on every store."""
    from app.schemas.derived import StoreSummary
    from app.schemas.signals import SignalBundle
    from app.schemas.store import StoreProfile

    ctx = RecommendationContext(
        store=StoreProfile(id=1, name="S", city="Austin", state="TX"),
        signals=SignalBundle(), velocity={}, inventory_health=[],
        summary=StoreSummary(), candidates=[], data_as_of=date(2026, 10, 8),
    )
    assert ctx.lead_times == {}
    ctx.lead_times = {"A": LeadTime(days=4, source="measured", observations=4, vendor="G")}
    assert ctx.lead_times["A"].is_measured


# ── The quantity ─────────────────────────────────────────────────────────────

AS_OF = date(2026, 10, 8)
DAYS = [AS_OF - timedelta(days=FIT_WINDOW_DAYS - 1 - i) for i in range(FIT_WINDOW_DAYS)]


def _ctx() -> RunContext:
    return RunContext(
        run_id="test-lt", tenant_id=171, store_id=171, as_of=AS_OF,
        snapshot_id="test-lt", config_version="default", seed=0,
        versions={"forecast_ensemble": "1.0.0", "policy_inventory": "1.0.0",
                  "constraints_apply": "1.0.0"},
    )


def _series(sku: str) -> list[SimpleNamespace]:
    rng = random.Random(7)
    return [SimpleNamespace(sku=sku, sale_date=d, units=max(0.0, 5 + rng.gauss(0, 0.8)))
            for d in DAYS]


def _quantities(sales, lead_times=None) -> PolicyQuantities:
    skus = {s.sku for s in sales}
    return PolicyQuantities(
        sales=sales, ctx=_ctx(), horizon_open_days=14,
        on_hand={s: 10.0 for s in skus}, prices={s: 20.0 for s in skus},
        costs={s: 12.0 for s in skus}, categories={s: "VODKA" for s in skus},
        lead_times=lead_times,
    )


MEASURED = LeadTime(days=3, source="measured", observations=4,
                    vendor="Glazers Beer & Beverage",
                    measured_from=date(2026, 3, 6), measured_to=date(2026, 6, 5))
DEFAULT_ROW = LeadTime(days=7, source="default", observations=0,
                       vendor="Breakthru Beverage")


def test_without_a_map_the_quantity_says_the_lead_time_is_declared() -> None:
    d = _quantities(_series("S")).for_sku("S")
    assert d.units is not None
    joined = " ".join(d.assumptions)
    assert "7-day delivery lead time" in joined
    assert "declared, not measured" in joined
    assert "measured from" not in joined


def test_a_measured_vendor_sizes_the_order_and_says_so() -> None:
    declared = _quantities(_series("S")).for_sku("S")
    measured = _quantities(_series("S"), lead_times={"S": MEASURED}).for_sku("S")
    assert measured.units is not None and declared.units is not None
    # Three days of lead time against seven: less to cover, so less to order.
    assert measured.order_up_to < declared.order_up_to
    joined = " ".join(measured.assumptions)
    assert "a 3-day delivery lead time for Glazers Beer & Beverage" in joined
    assert "measured from 4 receipts between 2026-03-06 and 2026-06-05" in joined
    assert "declared, not measured" not in joined


def test_a_default_row_names_the_vendor_but_keeps_the_registry_figure() -> None:
    """Node's default row and the registry Setting are two declarations of one
    default. The policy orders against the Setting and the sentence names the
    vendor - so the two can never disagree about what "the default" is."""
    declared = _quantities(_series("S")).for_sku("S")
    named = _quantities(_series("S"), lead_times={"S": DEFAULT_ROW}).for_sku("S")
    assert named.order_up_to == declared.order_up_to
    joined = " ".join(named.assumptions)
    assert "for Breakthru Beverage" in joined
    assert "supplier default, declared, not measured" in joined


def test_a_fractional_median_is_rounded_in_the_caller_not_the_policy() -> None:
    half = LeadTime(days=3.5, source="measured", observations=3, vendor="V")
    d = _quantities(_series("S"), lead_times={"S": half}).for_sku("S")
    assert "a 4-day delivery lead time for V" in " ".join(d.assumptions)


# ── The stockout sentence, and the byte-identical invariant ─────────────────


def _stockout_rows(sku: str = "0245") -> list[SimpleNamespace]:
    """A SKU selling steadily, so a thin shelf makes it a stockout pick."""
    out = []
    end = date(2026, 3, 31)
    d = end - timedelta(days=400)
    while d < end:
        out.append(SimpleNamespace(sku=sku, sale_date=d, units=3.0))
        d += timedelta(days=1)
    return out


def _choose(rows, **over):
    base = dict(client_id=1, location_id=171, as_of=date(2026, 3, 31), limit=10,
                on_hand={"0245": 6.0})
    return D.choose(rows, **{**base, **over})


def test_choose_without_a_map_is_byte_identical_to_an_empty_or_absent_one() -> None:
    rows = _stockout_rows()
    plain = _choose(rows)
    assert plain and plain[0].family == "stockout", "fixture must be a stockout"
    assert _choose(rows, lead_times=None) == plain
    assert _choose(rows, lead_times={}) == plain
    # A map that knows OTHER skus changes nothing about this one either.
    assert _choose(rows, lead_times={"OTHER": MEASURED}) == plain


def test_the_stockout_sentence_flags_the_declared_figure() -> None:
    pick = _choose(_stockout_rows())[0]
    assert "a delivery is assumed to take 7 days (declared, not measured)" in pick.why
    assert "A delivery takes 7 days" not in pick.why


def test_the_stockout_sentence_quotes_a_measured_vendor() -> None:
    pick = _choose(_stockout_rows(), lead_times={"0245": MEASURED})[0]
    assert pick.family == "stockout"
    assert ("a delivery from Glazers Beer & Beverage takes about 3 days "
            "(measured from 4 receipts)") in pick.why
    assert "declared" not in pick.why


def test_a_default_row_still_reads_as_declared_on_the_card() -> None:
    pick = _choose(_stockout_rows(), lead_times={"0245": DEFAULT_ROW})[0]
    assert "declared, not measured" in pick.why


def test_the_empty_shelf_form_is_capitalised_as_its_own_sentence() -> None:
    pick = _choose(_stockout_rows(), on_hand={"0245": 0.0})[0]
    assert pick.why.startswith("Out of stock now")
    assert "A delivery is assumed to take 7 days (declared, not measured)." in pick.why


def test_the_module_constant_is_the_same_seven_the_policy_declares() -> None:
    from app.pipeline.policy.inventory import LEAD_TIME_DAYS
    assert D.LEAD_TIME_DAYS == LEAD_TIME_DAYS.default
    assert D.delivery_clause(None).endswith("(declared, not measured)")
