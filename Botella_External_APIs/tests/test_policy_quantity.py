"""The card's quantity comes from the order policy, not from a flat buffer.

WHAT THIS REPLACED. The number on a reorder card came from
``storeagent/functions/buying.py::order_quantity``:

    target = forecast(lead_time + coverage) * (1 + safety_buffer)
    qty    = ceil(target - on_hand)

A single-point forecast times a flat 20%. A buffer is a statement about
DISPERSION and a point estimate has none, so two SKUs both selling five a day -
one steady, one swinging between zero and thirty - got the same 20% and the
same order. The flat percentage was doing a quantile's job, identically for
every demand shape in the catalogue.

The decisive test here is `test_the_buffer_tracks_dispersion_not_the_mean`:
with the means deliberately held equal, the flat rule must give both SKUs the
same answer and the policy must not.
"""

from __future__ import annotations

import random
from datetime import date, timedelta

import pytest

from app.pipeline.context import RunContext
from app.recommender.quantity import (
    FIT_WINDOW_DAYS,
    PolicyQuantities,
    QuantityDecision,
)

AS_OF = date(2026, 10, 8)
DAYS = [AS_OF - timedelta(days=FIT_WINDOW_DAYS - 1 - i)
        for i in range(FIT_WINDOW_DAYS)]


class Sale:
    """The shape `context.sales` carries (SaleRecord), minus the validation."""

    __slots__ = ("sku", "sale_date", "units")

    def __init__(self, sku: str, sale_date: date, units: float) -> None:
        self.sku = sku
        self.sale_date = sale_date
        self.units = units


def ctx_for(seed: int = 0) -> RunContext:
    return RunContext(
        run_id="test-qty", tenant_id=171, store_id=171, as_of=AS_OF,
        snapshot_id="test-qty", config_version="default", seed=seed,
        versions={"forecast_ensemble": "1.0.0", "policy_inventory": "1.0.0",
                  "constraints_apply": "1.0.0"},
    )


def series_for(sku: str, fn) -> list[Sale]:
    return [Sale(sku, d, fn(i)) for i, d in enumerate(DAYS)]


def quantities(sales, **kw) -> PolicyQuantities:
    skus = {s.sku for s in sales}
    defaults = {
        "on_hand": {s: 10.0 for s in skus},
        "prices": {s: 20.0 for s in skus},
        "costs": {s: 12.0 for s in skus},
        "categories": {s: "VODKA" for s in skus},
    }
    defaults.update(kw)
    return PolicyQuantities(sales=sales, ctx=ctx_for(), horizon_open_days=14,
                            **defaults)


# -- The reason the change was made ------------------------------------------


def test_the_buffer_tracks_dispersion_not_the_mean() -> None:
    """Equal means, different spreads, and the quantities must differ.

    This is the whole argument. Both SKUs average about five units a day over
    the year; one is steady and one is lumpy. The retired formula multiplies a
    point forecast by one constant, so it cannot tell them apart - whatever it
    says about the steady SKU it says about the volatile one. The policy sizes
    the buffer from the forecast's own p10/p90 spread, so it must.
    """
    rng = random.Random(4)
    steady = series_for("STEADY", lambda i: max(0.0, 5 + rng.gauss(0, 0.8)))
    rng2 = random.Random(4)
    # Same long-run mean, concentrated into occasional bursts.
    lumpy = series_for("LUMPY",
                       lambda i: (50.0 if rng2.random() < 0.1 else 0.0))

    q = quantities(steady + lumpy)
    a = q.for_sku("STEADY")
    b = q.for_sku("LUMPY")

    assert a.units is not None and b.units is not None
    # The means really are close, so the test is about spread and not level.
    assert a.p50 is not None and b.p50 is not None
    assert abs(a.p50 - b.p50) / max(a.p50, b.p50) < 0.5, (a.p50, b.p50)
    # And the intervals really are different widths.
    assert (b.p90 - b.p10) > (a.p90 - a.p10) * 2, (
        a.p90 - a.p10, b.p90 - b.p10)
    # Which the quantities reflect. The flat rule could not have.
    assert a.units != b.units


def test_both_decisions_name_the_policy_as_their_basis() -> None:
    q = quantities(series_for("S", lambda i: max(0.0, 5 + (i % 3))))
    d = q.for_sku("S")
    assert d.units is not None
    assert d.basis == "policy_inventory_on_ensemble_interval"
    # The interval is carried, so a card can quote the range it was sized from
    # rather than asserting a quantity with nothing behind it.
    assert d.p10 is not None and d.p50 is not None and d.p90 is not None
    assert d.p10 <= d.p50 <= d.p90
    assert d.horizon_open_days == 14


# -- Refusals are answers, and must not become quantities --------------------


def test_an_unknown_shelf_count_refuses_rather_than_ordering_the_maximum() -> None:
    """`ideal_qty = order_up_to - on_hand - on_order`.

    A missing count read as zero does not order a little - it orders the
    order-up-to point in FULL, which is the largest order the policy can
    produce. Refusing is the only safe answer.
    """
    q = quantities(series_for("X", lambda i: max(0.0, 5 + (i % 3))),
                   on_hand={"X": None})
    d = q.for_sku("X")
    assert d.units is None
    assert d.refused_reason == "shelf_count_unknown:cannot_size_an_order"
    # The forecast still happened and is still reported - what is refused is
    # the ORDER, not the demand estimate.
    assert d.p50 is not None


def test_a_negative_shelf_count_refuses_and_is_not_clamped() -> None:
    q = quantities(series_for("X", lambda i: max(0.0, 5 + (i % 3))),
                   on_hand={"X": -7.0})
    d = q.for_sku("X")
    assert d.units is None
    assert "shelf_count_negative" in (d.refused_reason or "")


def test_a_sku_with_no_history_refuses() -> None:
    q = quantities(series_for("HAS", lambda i: 5.0))
    d = q.for_sku("NEVER_SOLD")
    assert d.units is None
    assert d.refused_reason == "no_sales_history_for_this_sku"


def test_a_refusal_is_never_a_zero() -> None:
    """The distinction the whole module rests on.

    "Order none" is a recommendation; "we cannot size this" is not. A caller
    that cannot tell them apart will print one as the other.
    """
    q = quantities(series_for("X", lambda i: 5.0), on_hand={"X": None})
    refused = q.for_sku("X")
    assert refused.units is None
    assert refused.usable is False

    # A genuine zero: plenty on the shelf already.
    q2 = quantities(series_for("Y", lambda i: 0.1 if i % 30 == 0 else 0.0),
                    on_hand={"Y": 5000.0})
    zero = q2.for_sku("Y")
    assert zero.units == 0
    assert zero.refused_reason is None
    assert zero.basis == "policy_stocked_above_reorder_point"
    assert zero.usable is False


# -- Mechanics ---------------------------------------------------------------


def test_the_same_sku_is_computed_once() -> None:
    q = quantities(series_for("S", lambda i: max(0.0, 5 + (i % 3))))
    first = q.for_sku("S")
    again = q.for_sku("S")
    # Identity, not equality: the knapsack asks for the same quantity more than
    # once per run and a bootstrap forecast is not free.
    assert first is again


def test_refusals_are_reported_for_every_sku_asked_about() -> None:
    q = quantities(series_for("GOOD", lambda i: max(0.0, 5 + (i % 3))),
                   on_hand={"GOOD": 10.0})
    q.for_sku("GOOD")
    q.for_sku("MISSING_A")
    q.for_sku("MISSING_B")
    refused = q.refusals()
    assert set(refused) == {"MISSING_A", "MISSING_B"}
    assert "GOOD" not in refused


def test_the_trading_calendar_comes_from_the_sales_themselves() -> None:
    """A trading day is a day the store sold something.

    The same definition `deterministic._daily` uses. Deriving it differently
    here would give the forecast a different idea of the store's opening
    pattern from the selector's, which is how two halves of one run come to
    disagree about a rate.
    """
    sparse = [Sale("S", d, 3.0) for d in DAYS[::2]]  # every other day
    q = quantities(sparse)
    assert q.trading_days == len(DAYS[::2])


def test_the_fit_window_is_bounded() -> None:
    """Sales older than the window do not stretch the calendar."""
    old = [Sale("S", AS_OF - timedelta(days=900), 5.0)]
    recent = series_for("S", lambda i: 5.0)
    q = quantities(old + recent)
    assert q.trading_days == FIT_WINDOW_DAYS


@pytest.mark.parametrize("horizon", [0, -5])
def test_a_non_positive_horizon_refuses(horizon: int) -> None:
    q = PolicyQuantities(
        sales=series_for("S", lambda i: 5.0), ctx=ctx_for(),
        horizon_open_days=horizon, on_hand={"S": 10.0},
        prices={"S": 20.0}, costs={"S": 12.0}, categories={"S": "VODKA"},
    )
    d = q.for_sku("S")
    assert d.units is None
    assert "horizon_not_positive" in (d.refused_reason or "")


def test_the_decision_serialises_for_a_card() -> None:
    q = quantities(series_for("S", lambda i: max(0.0, 5 + (i % 3))))
    body = q.for_sku("S").as_dict()
    for key in ("sku", "units", "basis", "p10", "p50", "p90",
                "horizon_open_days", "ideal_qty", "order_up_to",
                "demand_class", "assumptions", "constrained_by"):
        assert key in body, key


def test_a_decision_is_reproducible_for_one_store_and_day() -> None:
    """Same inputs, same quantity - the forecast bootstraps, so this matters.

    A quantity that moved between two runs of the same day would make a card
    unarguable: nobody could check it against anything.
    """
    sales = series_for("S", lambda i: max(0.0, 5 + (i % 7)))
    first = quantities(sales).for_sku("S")
    second = quantities(sales).for_sku("S")
    assert first.units == second.units
    assert (first.p10, first.p50, first.p90) == (second.p10, second.p50, second.p90)


def test_every_decision_states_its_lead_time_basis() -> None:
    """Checklist 16. The live path never passed a vendor, so every card sized
    against the declared seven - and the policy only said so when the figure
    was absent. It now says so always, and the quantity carries it."""
    q = quantities(series_for("S", lambda i: max(0.0, 5 + (i % 3))))
    d = q.for_sku("S")
    assert d.units is not None
    lead = [a for a in d.assumptions if "lead time" in a]
    assert len(lead) == 1
    assert "declared, not measured" in lead[0]


def test_a_measured_vendor_changes_the_quantity_and_the_sentence() -> None:
    from types import SimpleNamespace

    sales = series_for("S", lambda i: max(0.0, 5 + (i % 3)))
    base = quantities(sales).for_sku("S")
    # Duck-typed on purpose: the harness hands in a namespace, not a LeadTime.
    vendor = SimpleNamespace(days=14, source="measured", observations=6,
                             vendor="Southern Glazer's",
                             measured_from=None, measured_to=None)
    slow = quantities(sales, lead_times={"S": vendor}).for_sku("S")
    assert slow.units is not None and base.units is not None
    assert slow.order_up_to > base.order_up_to, "two weeks of lead time needs more cover"
    joined = " ".join(slow.assumptions)
    assert "a 14-day delivery lead time for Southern Glazer's (measured from 6 receipts)" in joined


def test_an_unpriced_sku_is_still_sized() -> None:
    """Price and cost refine the service level; their absence must not refuse.

    The policy derives the service level from the newsvendor fractile when both
    are supplied and falls back to the declared family level when they are not,
    saying so in its assumptions. 78 of 94 trading stores send no cost at all,
    so refusing here would leave almost the whole estate unsized.
    """
    q = quantities(series_for("S", lambda i: max(0.0, 5 + (i % 3))),
                   prices={"S": None}, costs={"S": None})
    d = q.for_sku("S")
    assert d.units is not None
    assert d.assumptions, "the fallback service level should be declared"
