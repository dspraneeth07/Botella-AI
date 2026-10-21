"""The test that was missing, and the reason two silent failures shipped.

WHAT THE SUITE COULD NOT SEE
    1,829 tests passed while BOTH of these were true:

      * the live route returned a 500 for every store, because
        `context_builder` assigned three attributes to a
        `@dataclass(slots=True)` that never declared them;
      * every decision figure the engine computes - the gate verdict, the
        predictive range, the promise floor, the holding cost, the calibration
        basis, the slate's budget - was silently deleted by
        `Recommendation.model_validate` before it reached anyone.

    Neither is subtle. Both were invisible for the same reason: every test that
    touches the pipeline monkeypatches `_build_context`, and every test that
    checks a card asserts on the dict `to_raw_recommendations` RETURNS. So the
    real builder was executed by nothing, and the schema boundary was crossed by
    nothing. The failures were not in the code the tests ran.

WHAT THIS DOES INSTEAD
    Stubs at the HTTP boundary - an `httpx.MockTransport` serving recorded-shape
    Node payloads - and then runs the REAL `build_context`, the REAL selector, the
    REAL card builder and the REAL response model. Everything between the socket
    and the `RunResult` is the production path.

    That is the only place a stub belongs. A stub one layer in is a stub around
    the code you are trying to test.
"""

from __future__ import annotations

import json
from datetime import date, timedelta

import httpx
import pytest

from app.clients.node_api import NodeApiClient
from app.config import Settings
from app.recommender.pipeline import RecommendationPipeline
from app.schemas.recommendation import Recommendation

AS_OF = date(2026, 10, 5)
STORE, CLIENT = 171, 171

#: Enough products that the family cap, the budget and the merchandise screen all
#: have something to do, with the money fields the budget needs.
PRODUCTS = [
    {"sku": "0001", "product_name": "Tito's Handmade Vodka 1L", "category": "VODKA",
     "price": 24.99, "cost": 17.50, "stock_qty": 2},
    {"sku": "0002", "product_name": "Crown Royal 1.75L", "category": "WHISKY",
     "price": 49.99, "cost": 36.00, "stock_qty": 1},
    {"sku": "0003", "product_name": "Bud Light 12pk", "category": "BEER",
     "price": 14.99, "cost": 11.00, "stock_qty": 4},
    {"sku": "0004", "product_name": "Jameson Irish Whiskey 750ml", "category": "WHISKY",
     "price": 29.99, "cost": 21.00, "stock_qty": 0},
    {"sku": "0005", "product_name": "Barefoot Pinot Grigio 750ml", "category": "WINE",
     "price": 9.99, "cost": 6.50, "stock_qty": 3},
    # A BROKEN ROW, deliberately. Marshfield reports stock_qty < 0 on 3,657 of
    # 11,393 SKUs; the engine must make no stock claim about it rather than
    # treating -40 as forty units of shortfall to make up.
    {"sku": "0006", "product_name": "Margaritaville Gold Tequila 750ml",
     "category": "TEQUILA", "price": 15.49, "cost": 8.25, "stock_qty": -40},
    # NOT A PRODUCT. The catalogue merchandise screen runs on NAME and PRICE and
    # was passed neither on the live route until today.
    {"sku": "0007", "product_name": "1 Liter Liquor Tax", "category": "TAX",
     "price": 0.05, "cost": None, "stock_qty": 0},
]


def _sales() -> list[dict]:
    """Fourteen months of daily rows, with a deliberate recent collapse on 0001.

    The long window matters: sheet 20 compares a 28-day window against the SKU's
    own 365-day run, and a fixture shorter than that silently exercises the
    "not enough history" path instead of the one in production.
    """
    rows: list[dict] = []
    start = AS_OF - timedelta(days=420)
    for offset in range(420):
        day = start + timedelta(days=offset)
        if day.weekday() == 6:          # shut Sundays: open days must not be
            continue                    # calendar days anywhere downstream
        recent = (AS_OF - day).days <= 28
        for sku, base in (("0001", 6), ("0002", 3), ("0003", 9),
                          ("0004", 4), ("0005", 5), ("0006", 2)):
            units = base
            if sku == "0001" and recent:
                units = 1               # collapsed: the reversion candidate
            rows.append({"sku": sku, "sale_date": day.isoformat(),
                         "units": units, "unit_price": 20.0})
    # The tax line sells constantly and must never reach a card.
    for offset in range(420):
        day = start + timedelta(days=offset)
        rows.append({"sku": "0007", "sale_date": day.isoformat(),
                     "units": 50, "unit_price": 0.05})
    return rows


PROFILE = {"id": STORE, "name": "Bethany Discount Liquor", "city": "Fort Worth",
           "state": "TX", "country": "US", "latitude": 32.75, "longitude": -97.33}

HEALTH_EMPTY: list = []


def _handler(request: httpx.Request) -> httpx.Response:
    """Serve the Node contract. Anything not named here 404s, which is the
    behaviour the optional feeds are built to degrade through."""
    path = request.url.path
    if path.endswith("/profile"):
        return httpx.Response(200, json=PROFILE)
    if path.endswith("/inventory"):
        return httpx.Response(200, json=PRODUCTS)
    if path.endswith("/sales"):
        return httpx.Response(200, json=_sales())
    return httpx.Response(404, json={"error": "not implemented"})


@pytest.fixture
def pipeline() -> RecommendationPipeline:
    """The real pipeline, stubbed ONLY at the socket.

    The transport is swapped on the clients the pipeline is GIVEN, rather than
    monkeypatching `httpx.AsyncClient` globally - a global patch would also
    silence any outbound call a stage makes on a client of its own, which is
    exactly the kind of thing this test exists to notice.
    """
    settings = Settings(
        node_api_base_url="http://node.test",
        anthropic_api_key="x",
        use_deterministic_engine=True,
        max_recommendations=10,
    )
    node = NodeApiClient(settings)
    node._client = httpx.AsyncClient(
        base_url="http://node.test", transport=httpx.MockTransport(_handler))
    # Every signal source 404s. The bundle then carries no active keys, which is
    # the state the signal families are built to stand down in - and keeps this
    # test from depending on the actual weather.
    signal_http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(404, json={})))
    return RecommendationPipeline(
        settings, node_client=node, signal_http=signal_http,
        # The profile carries coordinates, so `_ensure_geo` returns before it
        # would touch the geocoder, and no model is consulted on this path.
        anthropic_client=None, geocoder=None,  # type: ignore[arg-type]
        signal_cache=None,
    )


# ── The route runs at all ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_real_route_returns_a_run_for_a_real_store(pipeline) -> None:
    """THE test that was missing. `build_context` assigning to a slotted
    dataclass made this a 500 for every store in the estate, and nothing in the
    suite executed that function."""
    result = await pipeline.run(CLIENT, STORE)
    assert result.client_id == CLIENT
    assert result.recommendations_generated == len(result.recommendations)
    assert result.dropped_invalid == 0, "a real payload must not drop cards"
    assert result.recommendations, "the route produced no cards at all"


@pytest.mark.asyncio
async def test_the_context_carries_the_three_fields_that_were_never_declared(
    pipeline,
) -> None:
    """Assigning an undeclared attribute to a slotted dataclass raises. These
    three are set by the builder on every run, so this is the regression."""
    context = await pipeline._build_context(CLIENT, STORE, None)
    assert context.card_history_rows == []
    assert context.gate_verdict is None
    assert context.calibration_bundle is None
    # And the money the budget needs reached the catalogue.
    assert context.catalogue["0001"].unit_cost == pytest.approx(17.50)
    assert context.catalogue["0001"].unit_price == pytest.approx(24.99)


# ── The decision figures survive the schema boundary ─────────────────────────


@pytest.mark.asyncio
async def test_the_decision_figures_reach_the_response(pipeline) -> None:
    """The second silent failure. These were computed, tested and deleted by
    `Recommendation.model_validate` on their way out."""
    result = await pipeline.run(CLIENT, STORE)
    reorders = [r for r in result.recommendations if r.action_type == "reorder"]
    assert reorders, "no reorder card to check"
    card = reorders[0]
    assert isinstance(card, Recommendation)
    # The gate always answers, even when no verdict exists for the store.
    assert card.gate_state is not None
    assert card.gate_measured is False      # nobody has measured this store
    assert card.gate_reason
    # The range is a claim the card can be held to.
    assert card.expected_range_low is not None
    assert card.expected_range_high >= card.expected_range_low
    # And the budget it was chosen under.
    assert card.portfolio_cash_budget is not None
    assert card.portfolio_cash_committed <= card.portfolio_cash_budget
    assert card.portfolio_assumptions


@pytest.mark.asyncio
async def test_the_response_serialises_with_the_figures_intact(pipeline) -> None:
    """What Node actually receives. A field present on the model and absent from
    the dump would be the same bug one layer further out."""
    result = await pipeline.run(CLIENT, STORE)
    payload = json.loads(result.model_dump_json())
    card = next(r for r in payload["recommendations"]
                if r["action_type"] == "reorder")
    for key in ("gate_state", "gate_measured", "expected_range_low",
                "portfolio_cash_budget", "portfolio_cash_budget_basis",
                "confidence_raw", "confidence_basis"):
        assert key in card, key


# ── The data-quality defects, through the real route ─────────────────────────


@pytest.mark.asyncio
async def test_a_negative_stock_row_makes_no_stock_claim(pipeline) -> None:
    """stock_qty -40 must not become forty units of shortfall. Before the fix
    `need = rate x COVERAGE_DAYS - have_units` inflated the order by the whole
    deficit, and `urgency` scored it above every genuine stockout in the store."""
    result = await pipeline.run(CLIENT, STORE)
    for card in result.recommendations:
        if "0006" in card.primary_skus:
            # It may still earn a card on SALES evidence - it just cannot claim
            # anything about the shelf.
            assert card.engine_on_hand is None or card.engine_on_hand >= 0
            assert (card.suggested_order_qty or 0) < 40, (
                "the order was inflated by the negative stock figure")


@pytest.mark.asyncio
async def test_the_tax_line_never_reaches_a_card(pipeline) -> None:
    """"1 Liter Liquor Tax" sells 50 a day for 420 days, which is exactly the
    shape sheet 20 hunts. The catalogue screen runs on NAME and PRICE, and
    neither was passed to the selector on the live route until today."""
    result = await pipeline.run(CLIENT, STORE)
    cited = {sku for card in result.recommendations for sku in card.primary_skus}
    assert "0007" not in cited


@pytest.mark.asyncio
async def test_the_budget_is_measured_from_the_stores_own_receipts(pipeline) -> None:
    """A flat $2,000 was 4% of what the audited stores spend a cycle, and it
    withheld cards at three of five of them for no reason."""
    result = await pipeline.run(CLIENT, STORE)
    card = next(r for r in result.recommendations if r.action_type == "reorder")
    assert card.portfolio_cash_budget_basis == "measured_replacement_cost"
    # Sanity, not a pinned value: this fixture's cost of goods is real arithmetic
    # and a budget near the declared $2,000 default would mean it fell back.
    assert card.portfolio_cash_budget > 0
    assert card.portfolio_cash_budget != pytest.approx(2000.0)


# ── Determinism, end to end ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_two_runs_over_one_snapshot_agree(pipeline) -> None:
    """No clock is read inside a stage and no model is consulted, so the same
    payload must produce the same slate - including the order."""
    first = await pipeline.run(CLIENT, STORE)
    second = await pipeline.run(CLIENT, STORE)
    assert ([(r.rank, r.primary_skus, r.action_type) for r in first.recommendations]
            == [(r.rank, r.primary_skus, r.action_type)
                for r in second.recommendations])


# -- Narration must run on the path that SHIPS --------------------------------


@pytest.mark.asyncio
async def test_narration_is_attempted_on_the_deterministic_path(pipeline) -> None:
    """The test that catches wiring narration to a branch nothing reaches.

    The first version of the call sat inside the `else` - the superseded LLM arm,
    which is switched off - so narration ran on no card that ships. The unit tests
    could not see it, because they call `_narrate_cards` directly and it worked
    perfectly in isolation. Only running the real route shows which branch it is in.

    This asserts the ATTEMPT, not the result. There is no Anthropic client in this
    fixture, so every card falls back to the engine sentence - and that fallback is
    itself the thing worth pinning: a missing model must cost prose and nothing
    else.
    """
    result = await pipeline.run(CLIENT, STORE)
    assert result.recommendations
    for card in result.recommendations:
        assert card.rationale, "a card must always carry a sentence"
        assert card.rationale_source in ("model", "engine"), (
            "rationale_source is unset, so narration never ran on this path")
    # With no model reachable, every sentence is the engine's own.
    assert all(c.rationale_source == "engine" for c in result.recommendations)
    assert all(c.rationale == c.rationale_engine
               for c in result.recommendations if c.rationale_engine)


# ── The signal impact block ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_every_card_discloses_what_the_signals_were_found_to_do(
    pipeline,
) -> None:
    """The defect: three live events on screen, nothing on any card.

    An owner cannot tell "we looked at tonight's game and cannot measure it yet"
    from "we never looked" when both render as nothing. 639 cells are fitted at
    the pilot stores and 10 are citable, so the empty-looking case is the normal
    one and it has to SAY something.

    Asserting it here is what pins the field to a branch that actually runs.
    `_attach_signal_impact` works perfectly in isolation, which is exactly what
    was true of narration both times it was wired into the dead arm.

    THE CALENDAR SIGNALS ARE LIVE IN THIS FIXTURE EVEN THOUGH EVERY HTTP SOURCE
    404s, and the first version of this test asserted an empty block for that
    reason and failed. `day_of_dead` and `halloween` are computed from the date,
    not fetched, so they are active with no network at all - which makes this the
    useful case: live signals, no effects served, so every entry must come back
    `not_fitted` WITH a reason rather than as a silent gap.
    """
    result = await pipeline.run(CLIENT, STORE)
    assert result.recommendations
    for card in result.recommendations:
        assert card.signal_impact_summary, (
            "a card with no summary is the silence this field exists to end")
        assert card.signal_impact, (
            "signals were live, so the block may not be empty")
        for entry in card.signal_impact:
            assert entry["signal_key"]
            # No effects are served here, so nothing may claim measurement.
            assert entry["state"] == "not_fitted"
            assert entry["beta"] is None
            assert entry["reason"], "an unmeasured cell must name its reason"
        assert "none measurable yet" in card.signal_impact_summary


@pytest.mark.asyncio
async def test_the_signal_block_survives_the_response_boundary(pipeline) -> None:
    """Declared on the model AND present in the dump.

    `Recommendation` sets `extra="ignore"`, which has already deleted twenty-four
    computed figures on their way out (migration 028). A block that exists on the
    card dict and not in the JSON is that same bug, one layer further out.
    """
    result = await pipeline.run(CLIENT, STORE)
    payload = json.loads(result.model_dump_json())
    assert payload["recommendations"]
    for card in payload["recommendations"]:
        assert "signal_impact" in card
        assert "signal_impact_summary" in card
        assert card["signal_impact_summary"]


def test_a_refused_cell_reaches_the_card_without_a_number() -> None:
    """The one way this block could become a lie.

    `too_few_active_days:4<20` means the event has not happened often enough to
    measure AT ALL. Rendering that as an effect of 0.0 would claim the signal was
    measured and found inert, which is a different statement and a false one. So a
    refused cell carries its reason and a null beta, and an interval straddling
    zero is refused even when the fit recorded no reason.
    """
    from app.recommender.families import signal_status_from_rows

    statuses = signal_status_from_rows([
        {"signal_key": "nfl_home_game", "category_family": "wine",
         "beta": -0.1705, "interval_lo": -0.2829, "interval_hi": -0.0582,
         "refused_reason": None, "active_days": 24, "observations": 400},
        {"signal_key": "holiday_valentines", "category_family": "wine",
         "beta": None, "interval_lo": None, "interval_hi": None,
         "refused_reason": "too_few_active_days:4<20",
         "active_days": 4, "observations": 400},
        {"signal_key": "trend_gin", "category_family": "wine",
         "beta": 0.05, "interval_lo": -0.02, "interval_hi": 0.12,
         "refused_reason": None, "active_days": 30, "observations": 400},
    ])

    cited = statuses[("nfl_home_game", "wine")]
    assert cited.state == "measured"
    assert cited.beta == pytest.approx(-0.1705)

    thin = statuses[("holiday_valentines", "wine")]
    assert thin.state == "not_measurable"
    assert thin.beta is None, "a refusal must never carry a number"
    assert thin.reason == "too_few_active_days:4<20"
    assert thin.active_days == 4

    # Fitted, examined, inconclusive - and it must say which.
    straddles = statuses[("trend_gin", "wine")]
    assert straddles.state == "not_measurable"
    assert straddles.beta is None
    assert straddles.reason == "interval_spans_zero"



# ── The signal families are handed a catalogue they can resolve ─────────────


@pytest.mark.asyncio
async def test_the_signal_families_are_told_each_products_category(
    pipeline, monkeypatch,
) -> None:
    """The dict the route hands cold_box / pre_stock carried name and size only.

    `families.effect_for` reads .get("category") off it, got "", resolved no
    family, never found the (signal, family) cell that effects_by_category
    supplies two lines later, and so returned None for every SKU - the families
    refused unconditionally at every store, with a usable +15.8% heat_advisory x
    beer cell sitting published at Bethany and unread. The unit tests never saw
    it because they hand the families a catalogue that already carries
    "category". This spies on the real call from the real route and checks what
    actually arrives.
    """
    from app.recommender import families

    seen: list[dict] = []

    def spy(*args, **kwargs):
        seen.append(args[1])          # (active_keys, catalogue, ...)
        return []

    monkeypatch.setattr(families, "pre_stock", spy)
    monkeypatch.setattr(families, "cold_box", spy)
    await pipeline.run(CLIENT, STORE)

    assert seen, "neither signal family was called on the deterministic path"
    catalogue = seen[0]
    assert "0003" in catalogue
    assert catalogue["0003"].get("category") == "BEER", catalogue["0003"]
    # Every stocked product, not one: a family is resolved per SKU, and a SKU
    # with no category is a SKU no signal can ever price.
    missing = [s for s, e in catalogue.items() if not e.get("category")]
    assert missing == [], missing
