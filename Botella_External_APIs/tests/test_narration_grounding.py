"""Narration numeric grounding: prose numbers must exist in the FACTS.

The narration prompt's "use ONLY numbers in the FACTS" was instruction-only;
``ungrounded_numbers`` is the enforcement. These pin what counts as grounded
(exact facts, plain roundings, numbers inside string facts like dates) and
what does not (invented figures), plus the small-count carve-out for natural
language ("your top 3", "one of two").
"""

from __future__ import annotations

from storeagent.narration.narrate import ungrounded_numbers

FACTS = {
    "store": "96/42",
    "as_of": "2026-08-24",
    "buy_total_value": 4612.75,
    "urgent_count": 3,
    "top_buys": [
        {"name": "Modelo 24/12", "order_qty": 45, "order_value": 1387.5,
         "on_hand": 42, "order_by": "2026-08-27"},
    ],
}


def test_fully_grounded_prose_passes() -> None:
    text = ("Order 45 units of Modelo 24/12 by 2026-08-27 - you have 42 on hand. "
            "The full buy list is worth $4,612.75 across your urgent items.")
    assert ungrounded_numbers(text, FACTS) == []


def test_plain_rounding_of_a_fact_is_grounded() -> None:
    # "about $4,613" quotes 4612.75; that is quoting, not inventing.
    assert ungrounded_numbers("about $4,613 to reorder", FACTS) == []


def test_invented_dollar_figure_is_flagged() -> None:
    bad = ungrounded_numbers("that frees up roughly $9,800 in cash", FACTS)
    assert bad == [9800.0]


def test_invented_quantity_is_flagged() -> None:
    assert ungrounded_numbers("order about 60 units", FACTS) == [60.0]


def test_small_counts_read_as_language() -> None:
    # List-length talk the facts never carry as literals.
    assert ungrounded_numbers("your top 3 buys, starting with one urgent item", FACTS) == []


def test_numbers_inside_string_facts_are_grounded() -> None:
    # 24 and 12 come from the product name; 27 from the order-by date.
    assert ungrounded_numbers("the 24/12 pack, in by the 27th", FACTS) == []


def test_duplicates_reported_once() -> None:
    assert ungrounded_numbers("$500 now and $500 later", FACTS) == [500.0]
