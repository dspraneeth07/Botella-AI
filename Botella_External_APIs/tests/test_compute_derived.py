from __future__ import annotations

from datetime import date

from app.schemas.signals import SignalBundle
from app.schemas.store import StoreProfile
from app.store_data import compute_derived
from tests.conftest import NOW, item, sale

STORE = StoreProfile(id=1, name="Test")


def _run(sales, inventory):
    return compute_derived(
        store=STORE,
        signals=SignalBundle(),
        inventory=inventory,
        sales=sales,
        now=NOW,
        candidate_pool_size=150,
    )


def test_velocity_anchors_to_data_frontier_not_wall_clock() -> None:
    """If the source DB lags, the 7-day window must follow the latest sale_date,
    not wall-clock — otherwise recent sales fall outside the window and every
    SKU looks like it's trending down."""
    # All sales are 10-16 days before `now`; the data frontier is `now - 10`.
    sales = [sale("A", days_ago=offset, units=10) for offset in range(10, 17)]
    inventory = [item("A", category="beer", on_hand=20)]

    ctx = _run(sales, inventory)

    assert ctx.data_as_of == date.fromordinal(NOW.date().toordinal() - 10)
    # Anchored to the frontier, the most recent sale lands inside the 7d window.
    assert ctx.velocity["A"].units_7d > 0
    assert ctx.velocity["A"].trend != "falling"


def test_data_as_of_falls_back_to_now_without_sales() -> None:
    ctx = _run([], [item("A", on_hand=5)])
    assert ctx.data_as_of == NOW.date()


def test_empty_category_is_classified_from_product_name() -> None:
    """Store 96 case: category is '' but the product name carries the type."""
    inv = [item("A", category="", name="Old Crow Straight Bourbon 750ml", on_hand=5)]
    ctx = _run([], inv)
    # category resolved to a canonical token...
    assert inv[0].category == "bourbon"
    # ...and inventory health used the spirits family (not the default family).
    assert ctx.inventory_health[0].category == "bourbon"


def test_junk_category_with_unrecognizable_name_is_uncategorized() -> None:
    inv = [item("A", category="DNR", name="Mystery Item 42", on_hand=5)]
    _run([], inv)
    assert inv[0].category == "uncategorized"


def test_the_raw_pos_category_survives_the_canonical_rewrite() -> None:
    """Checklist 12. `_resolve_categories` rewrites `item.category` to a drink
    token and a lottery line comes out as "uncategorized" - which is why the
    live route's category screen never fired. The catalogue keeps the string
    the till sent, so the merchandise screen can read it."""
    inv = [item("L", category="LOTTERY", name="MEGA MILLIONS $2", on_hand=5),
           item("B", category="BOURBON", name="Old Crow 750ml", on_hand=5),
           item("N", category="", name="Mystery Item 42", on_hand=5)]
    ctx = _run([], inv)
    assert inv[0].category == "uncategorized"
    assert ctx.catalogue["L"].pos_category == "LOTTERY"
    assert ctx.catalogue["B"].pos_category == "BOURBON"
    assert ctx.catalogue["N"].pos_category is None
