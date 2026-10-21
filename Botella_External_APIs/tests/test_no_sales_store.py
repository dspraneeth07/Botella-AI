"""A store whose feed has sent no sales must be answered, not crashed.

WHAT THE OWNERS SAW. 111 of the 212 stores in the warehouse have no `sales`
rows at all - onboarded, not yet syncing, or syncing only a product master.
That is a legitimate state. Three capabilities did not handle it, and each
broke differently on the same store, putting its exception text on the page
where the figures belong:

    customers   AttributeError: 'NoneType' object has no attribute 'isoformat'
    overview    AttributeError: 'NoneType' object has no attribute 'get'
    inventory   ValueError: No sales found for client_id=32

Five other capabilities already answered properly, with
`{"available": False, "reason": "no sales data for this store"}`, which is the
shape the frontend turns into "this is not available for your store" plus the
engine's own sentence. So the fix was to make the three agree with the five,
not to invent anything.

THE PART THAT KEPT BITING. Fixing the first crash exposed the second and the
third, all in Overview's action queue, because the three ways a section can
have nothing in it look different to a consumer:

    the engine RAISED      -> the whole payload is None
    the engine REFUSED     -> the payload is a DICT and the section is
                              {"available": False}, which is TRUTHY, so
                              `if payload:` passes and the first real key read
                              is a KeyError
    the section is ABSENT  -> the key is missing or None, so `.get` on it
                              raises AttributeError

`_usable` is one reader for all three. The tests below pin each of them
separately, because each one shipped as a separate crash.

WHAT MUST NOT DRIFT. A MEASURED ZERO IS STILL DATA. A store that really holds
no dead stock, or really sold nothing yesterday, has an answer and is entitled
to read it. Only the absence of any sale date at all - `as_of is None` - may
produce a refusal. The last test here is the one that protects that.
"""

from __future__ import annotations

from datetime import date

from storeagent.functions import no_sales
from storeagent.functions.customers import customer_radar
from storeagent.runtime.pipeline import _INVENTORY_SECTIONS, _usable

AS_OF = date(2026, 10, 10)


# -- The three that used to crash ------------------------------------------


def test_customers_refuses_instead_of_raising_on_a_date_it_does_not_have() -> None:
    """`as_of.isoformat()` on None. Every recency in the radar is measured
    FROM as_of, so without one there is nothing to compute."""
    got = customer_radar([], None)
    assert got["available"] is False
    assert got["reason"] == no_sales.NO_SALES_REASON
    assert got["as_of"] is None
    # The consumers still read these off the section, so a refusal keeps the
    # section's shape rather than becoming a different object.
    assert got["status"] == "no_sales"
    assert got["distinct_customers"] == 0


def test_customers_with_a_date_but_no_rows_is_a_different_refusal() -> None:
    """Not the same case, and it must not be collapsed into it: the store HAS
    sales, just too few customers to say anything about."""
    got = customer_radar([], AS_OF)
    assert got["available"] is False
    assert got["as_of"] == "2026-10-10"
    assert got["status"] == "insufficient_data"
    assert got["reason"] != no_sales.NO_SALES_REASON


def test_the_inventory_refusal_covers_every_section_the_view_needs() -> None:
    """The frontend hides a view only when NOTHING it needs is present, so a
    refusal that omits one section would leave that part drawing its headings
    over nothing - which is the failure mode the whole availability check
    exists to prevent."""
    from storeagent.runtime.pipeline import _no_sales_inventory

    got = _no_sales_inventory(32, 32, "32/32", None, narrate=False)
    for name in _INVENTORY_SECTIONS:
        assert got[name]["available"] is False, name
        assert got[name]["reason"] == no_sales.NO_SALES_REASON, name
    assert got["as_of"] is None
    # Narration is deliberately absent: asking the model to describe an
    # absence spends a call to be told there is nothing there.
    assert "narration" not in got


# -- The three absences a consumer has to read the same way -----------------


def test_a_raised_engine_reads_as_nothing_to_report() -> None:
    assert _usable(None, "buying") is None


def test_A_REFUSAL_IS_TRUTHY_and_still_reads_as_nothing() -> None:
    """The one that caused two of the three crashes.

    `if payload:` passes on a refusal, so the next line read a key that a
    refusal does not carry. KeyError: 'value_basis', in front of an owner.
    """
    payload = {"frozen_capital": {"available": False, "reason": "no sales data"}}
    assert payload["frozen_capital"], "the refusal really is truthy"
    assert _usable(payload, "frozen_capital") is None


def test_an_absent_or_null_section_reads_as_nothing() -> None:
    assert _usable({"lost_sales": None}, "lost_sales") is None
    assert _usable({}, "lost_sales") is None


def test_a_section_with_figures_is_returned_whole() -> None:
    section = {"buy_sku_count": 12, "buy_total_value": 980.0}
    assert _usable({"buying": section}, "buying") == section


def test_a_section_marked_available_is_usable() -> None:
    section = {"available": True, "opportunity_count": 3}
    assert _usable({"market": section}, "market") == section


# -- The direction that matters most ----------------------------------------


def test_A_MEASURED_ZERO_IS_STILL_DATA() -> None:
    """The hazard in the other direction.

    A store that really holds no dead stock and leaks no money is a GOOD
    result, and turning it into "not available" would hide a true answer and
    send the owner to support over nothing. `_usable` must key on the refusal
    flag, never on the figures being zero.
    """
    section = {"actionable_sku_count": 0, "actionable_frozen_capital": 0,
               "actionable_frozen_retail": 0}
    assert _usable({"dead_stock": section}, "dead_stock") == section

    zeroed = {"available": True, "opportunity_count": 0, "total_projected_profit": 0}
    assert _usable({"market": zeroed}, "market") == zeroed


def test_the_sentence_is_the_one_the_other_engines_already_used() -> None:
    """Five capabilities had their own copy of this literal before there was a
    constant. If it drifts, two screens describe the same store differently."""
    assert no_sales.NO_SALES_REASON == "no sales data for this store"
    assert no_sales.unavailable() == {
        "available": False, "reason": "no sales data for this store"}
    assert no_sales.unavailable(status="no_sales")["status"] == "no_sales"
