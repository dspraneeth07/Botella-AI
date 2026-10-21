"""Item 2: a missing or negative shelf count must never read as an empty shelf.

AN EMPTY SHELF IS A BUY SIGNAL. That is the whole reason this matters: every
place that turned "we do not know" into zero was manufacturing the most urgent
card the engine issues out of a gap in the data.

Four distinct places did it, on one path:

    integrationService.js   an absent stock_qty became 0 on the way out of Node
    schemas/store.py        the validator coerced None to 0 on the way in
    store_data/candidates   `on_hand <= 0` put an unknown level in the
                            STOCKED-OUT pool, which is the strongest reorder case
    buying.py               `max(on_hand, 0)` ordered the full target against a
                            NEGATIVE count

Marshfield reports stock_qty below zero on 3,657 of its 11,393 SKUs, worst case
-91,647, so none of this is theoretical.
"""

from __future__ import annotations

import pytest

from app.schemas.derived import HealthInfo
from app.schemas.store import InventoryItem
from app.store_data.inventory_health import compute_inventory_health


def item(sku: str, on_hand, price: float = 10.0, **kw) -> InventoryItem:
    return InventoryItem(sku=sku, product_name=f"Product {sku}", price=price,
                         on_hand=on_hand, category="VODKA", **kw)


# -- The schema keeps the distinction -----------------------------------------


def test_an_absent_count_survives_as_none() -> None:
    """The validator returned 0 for a missing count, so an honest null from Node
    became an empty shelf the moment it was parsed."""
    assert item("A", None).on_hand is None
    assert item("A", "").on_hand is None


def test_a_measured_zero_is_still_zero() -> None:
    """The distinction only matters if a real zero still reads as a real zero."""
    assert item("A", 0).on_hand == 0


def test_a_negative_count_is_preserved_not_clamped() -> None:
    """Clamping here would hide the broken record from every consumer. The
    engine refuses to reason from it instead, which it can only do if it can
    still see it."""
    assert item("A", -40).on_hand == -40


def test_a_decimal_string_still_degrades_to_whole_units() -> None:
    """Keg partials arrive as "2.0" and must not fail the row."""
    assert item("A", "2.0").on_hand == 2


def test_an_unparseable_count_is_unknown_rather_than_zero() -> None:
    assert item("A", "lots").on_hand is None


# -- The health view produces absences, not numbers ---------------------------


def test_an_unknown_level_yields_no_cover_no_capital_and_no_stock_status() -> None:
    """Each of the three is a CLAIM about the shelf. The status an absent count
    used to fall into was the one that reads as "order now"."""
    rows = compute_inventory_health([item("A", None)], {})
    assert len(rows) == 1
    row = rows[0]
    assert row.on_hand is None
    assert row.tied_up_capital is None, "a zero reads as 'no capital at risk'"
    assert row.weeks_on_hand is None
    assert row.status == "unknown"


def test_a_real_zero_still_reports_as_out_of_stock() -> None:
    rows = compute_inventory_health([item("A", 0)], {})
    assert rows[0].status != "unknown"
    assert rows[0].tied_up_capital == 0.0


def test_health_info_accepts_an_absent_level() -> None:
    row = HealthInfo(sku="A", category="VODKA", on_hand=None, weekly_rate=0.0,
                     weeks_on_hand=None, tied_up_capital=None, status="unknown")
    assert row.on_hand is None and row.tied_up_capital is None


# -- Candidate selection puts it in NEITHER pool ------------------------------


def test_an_unknown_level_joins_neither_the_stocked_nor_the_stocked_out_pool() -> None:
    """The stocked-out pool is "nothing on the shelf and it was selling", which
    is the strongest reorder case the engine has. A SKU the feed never mentioned
    must not land there."""
    from app.schemas.signals import SignalBundle
    from app.store_data.candidates import select_candidates

    inventory = [item("KNOWN", 5), item("EMPTY", 0), item("UNKNOWN", None)]
    picked = {c.sku for c in select_candidates(
        inventory, {}, compute_inventory_health(inventory, {}), SignalBundle())}
    assert "UNKNOWN" not in picked, (
        "a SKU the feed never reported was treated as an empty shelf")


# -- The order policy refuses rather than ordering the full target ------------


def test_an_order_is_refused_against_an_unknown_or_negative_shelf() -> None:
    """`max(on_hand, 0)` clamped a negative to zero and ordered the whole target.
    Returning 0 is the honest answer: we cannot size an order without knowing
    what is already there."""
    from storeagent.functions.buying import order_quantity

    class _Demand:
        def __init__(self, on_hand):
            self.on_hand = on_hand

        def coverage_days(self, _t):
            return 14

        def forecast(self, _days, _t):
            return 100.0

    class _T:
        safety_buffer = 0.2
        lead_time_days = 7

    qty, _cov = order_quantity(_Demand(-91647), _T())
    assert qty == 0, "a broken record must not become a 120-unit order"
    qty, _cov = order_quantity(_Demand(None), _T())
    assert qty == 0
    # ...and a known shelf still orders normally.
    qty, _cov = order_quantity(_Demand(10), _T())
    assert qty == 110, qty
