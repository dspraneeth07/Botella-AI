"""Sheet 11 — business constraints. Ideal quantity -> orderable quantity."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from app.pipeline.constraints import (
    ApplyRequest,
    Availability,
    Constraint,
    ConstraintSet,
    apply_constraints,
    budget_unavailable,
    derive_moq,
    known,
    on_hand_from_snapshot,
    parse_many,
    parse_pack_size,
    perishability_unavailable,
    promo_locks_unavailable,
    shelf_capacity_unavailable,
)
from app.pipeline.context import RunContext

AS_OF = date(2026, 9, 23)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-11", "tenant_id": 1, "store_id": 1, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"constraints": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def constraints(**over) -> ConstraintSet:
    base = {
        "case_pack": known("case_pack", 12),
        "on_hand": known("on_hand", 16),
        "moq": known("moq", 1),
        "shelf_capacity": known("shelf_capacity", 40),
        "budget": budget_unavailable(),
    }
    base.update(over)
    return ConstraintSet(**base)


def feasible(ideal: float = 37.4, **over):
    result = apply_constraints(ApplyRequest("X", ideal, constraints(**over)), ctx())
    assert result.ok, result.reasons
    return result.value


# ── The sheet's worked example ───────────────────────────────────────────────


def test_37_4_with_pack_12_and_shelf_40_gives_24_with_both_reasons() -> None:
    """The sheet's first required test, verbatim.

    37.4 rounds up to 4 packs (48); the shelf holds 40 and 16 are already on
    it, so 24 fit - which is exactly 2 whole packs.
    """
    result = feasible(37.4)
    assert result.feasible_qty == 24
    assert len(result.reasons) == 2
    assert any("case pack" in r for r in result.reasons)
    assert any("shelf capacity" in r for r in result.reasons)
    assert "24" in result.explain() and "37.4" in result.explain()


def test_the_reasons_travel_with_the_number() -> None:
    """The card has to explain why it says 24 and not 37 - that is the
    difference between looking wrong and looking careful."""
    text = feasible(37.4).explain()
    assert text.startswith("Order 24 rather than 37.4")
    assert "rounded up" in text and "capped" in text


def test_a_cap_re_rounds_down_to_whole_packs() -> None:
    """Capping AFTER rounding can leave a part-pack the supplier will not
    ship, so the cap forces a re-round."""
    result = feasible(37.4, shelf_capacity=known("shelf_capacity", 39))
    assert result.feasible_qty % 12 == 0, "a part-pack is not orderable"
    assert result.feasible_qty == 12


def test_a_full_shelf_gives_zero_and_that_is_a_legitimate_answer() -> None:
    result = feasible(37.4, on_hand=known("on_hand", 40))
    assert result.feasible_qty == 0
    assert any("capped" in r for r in result.reasons)


def test_moq_raises_a_small_order() -> None:
    result = feasible(2.0, case_pack=known("case_pack", 1),
                      moq=known("moq", 6))
    assert result.feasible_qty == 6
    assert any("supplier minimum" in r for r in result.reasons)


def test_an_unconstrained_quantity_keeps_its_value_and_says_nothing() -> None:
    result = feasible(24.0, case_pack=known("case_pack", 1),
                      shelf_capacity=known("shelf_capacity", 999))
    assert result.feasible_qty == 24
    assert result.reasons == ()
    assert result.explain() == "Order 24."


# ── THE RULE: unavailable is not unbounded ───────────────────────────────────


def test_an_unavailable_shelf_capacity_does_not_cap_and_is_recorded() -> None:
    """`shelf_capacity = None` means "we do not know", NOT infinity.

    It cannot cap anything - but the fact that it could not is recorded, so
    stage 14 and the card can both see the difference between "fits" and "we
    have no idea whether it fits".
    """
    result = feasible(37.4, shelf_capacity=shelf_capacity_unavailable())
    assert result.feasible_qty == 48, "nothing capped it"
    assert not any("shelf" in r for r in result.reasons)
    assert any("shelf_capacity: unavailable" in n for n in result.not_applied)
    assert any("NOT unlimited shelf space" in n for n in result.not_applied)


def test_every_unavailable_constraint_is_named_in_not_applied() -> None:
    result = feasible(
        37.4,
        shelf_capacity=shelf_capacity_unavailable(),
        budget=budget_unavailable(),
        moq=Constraint("moq", None, Availability.INSUFFICIENT_HISTORY, "1 purchase"),
    )
    reported = " ".join(result.not_applied)
    assert "shelf_capacity: unavailable" in reported
    assert "budget: unavailable" in reported
    assert "moq: insufficient_history" in reported


def test_unavailable_and_insufficient_history_are_different_states() -> None:
    """One says the column does not exist; the other says it does and we do
    not have enough of it yet. They call for different actions."""
    assert Availability.UNAVAILABLE is not Availability.INSUFFICIENT_HISTORY
    assert not shelf_capacity_unavailable().binds
    assert not Constraint("moq", None, Availability.INSUFFICIENT_HISTORY).binds
    assert known("shelf_capacity", 40).binds


def test_the_absent_constraints_are_all_named_explicitly() -> None:
    """"We never looked" and "we looked and it is not there" must be
    different states in the code as well as in the prose."""
    for factory in (shelf_capacity_unavailable, budget_unavailable,
                    promo_locks_unavailable, perishability_unavailable):
        constraint = factory()
        assert constraint.availability is Availability.UNAVAILABLE
        assert constraint.value is None
        assert constraint.detail, f"{constraint.name} must say why"


# ── The pack-size parser ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("1", 1), ("12", 12), ("24", 24),           # integers
     ("12.0", 12), ("6.0", 6), ("24.0", 24),     # float-formatted integers
     ("Single", 1), ("SINGLE", 1), ("EACH", 1),  # singular containers
     ("1-PACK Single", 1), ("SINGLE BT", 1),
     ("4 PK", 4), ("6-Pack", 6), ("12 PK", 12)],  # embedded numbers
)
def test_real_pack_size_values_parse(raw, expected) -> None:
    """Every one of these appears in the real column."""
    parsed = parse_pack_size(raw)
    assert parsed.ok, parsed.reason
    assert parsed.units == expected


@pytest.mark.parametrize(
    ("raw", "fragment"),
    [("NULL", "literal_string"),      # 2,142 rows of the four-char STRING
     ("CASE", "container_word"),      # a case of WHAT? 6, 12 and 24 all exist
     ("BOX", "container_word"),
     ("KEGS", "container_word"),
     ("-6", "not_positive"),
     ("0MG", "not_positive"),
     ("12.5", "not_a_whole_number"),
     ("", "empty"),
     (None, "null")],
)
def test_unparseable_values_report_rather_than_defaulting_to_1(raw, fragment) -> None:
    """The sheet's second required test.

    Defaulting to 1 silently DISABLES the case-pack constraint: every quantity
    rounds to itself and the recommendation goes out at 37 when the supplier
    ships twelves.
    """
    parsed = parse_pack_size(raw)
    assert not parsed.ok, f"{raw!r} must not parse"
    assert parsed.units is None, "never a silent 1"
    assert fragment in parsed.reason


def test_a_value_with_two_numbers_refuses_rather_than_picking_one() -> None:
    parsed = parse_pack_size("12 X 750ML")
    assert not parsed.ok
    assert "ambiguous_multiple_numbers" in parsed.reason


def test_the_batch_parser_reports_what_it_could_not_read() -> None:
    """A run that could not parse part of its catalogue has to say so."""
    rows = [("12", None), ("CASE", None), ("NULL", None), ("6.0", None)]
    parsed, report = parse_many(rows)
    assert sum(1 for p in parsed if p.ok) == 2
    assert report["container_word_without_a_count"] == 1
    assert report["pack_size_is_the_literal_string"] == 1


def test_uom_confirms_a_container_but_never_supplies_a_pack_count() -> None:
    """`uom` in this warehouse is container VOLUME, not units per case.

    Its top values are 750ML, 0.0, 1.75L, 375ML, 12OZ. Knowing a bottle is
    750ml says nothing about whether the case holds 6 or 12 of them, so it is
    used only to confirm the row describes a bottle.
    """
    with_volume = parse_pack_size("Single", uom="750ML")
    assert with_volume.units == 1
    assert "uom_confirms_container" in with_volume.reason

    # A zero-volume uom claims nothing.
    assert parse_pack_size("Single", uom="0.0").reason is None
    # And uom never rescues an unparseable pack size.
    assert not parse_pack_size("CASE", uom="750ML").ok


# ── MOQ derived from purchase history ────────────────────────────────────────


def test_moq_uses_the_modal_order_quantity_not_the_minimum() -> None:
    """A single small order - a sample, a partial delivery, a correction -
    would drag the minimum to 1 and switch the constraint off."""
    constraint, evidence = derive_moq([12, 12, 12, 24, 1], "S1", "X", 3)
    assert constraint.binds
    assert constraint.value == 12, "the mode, not the 1"
    assert evidence.minimum == 1, "but the minimum is still reported"
    assert evidence.modal == 12
    assert "smallest seen: 1" in constraint.detail


def test_thin_purchase_history_reports_rather_than_guessing() -> None:
    constraint, evidence = derive_moq([6, 6], "S1", "X", 3)
    assert not constraint.binds
    assert constraint.availability is Availability.INSUFFICIENT_HISTORY
    assert evidence is None
    assert "need 3" in constraint.detail


def test_zero_and_negative_purchase_quantities_are_ignored() -> None:
    constraint, evidence = derive_moq([0, -5, 6, 6, 6], "S1", "X", 3)
    assert constraint.value == 6
    assert evidence.observations == 3


# ── This stage does not do sheet 10's job ────────────────────────────────────


def test_the_ideal_quantity_is_carried_through_unchanged() -> None:
    """The card compares them, so the ideal has to survive intact."""
    result = feasible(37.4)
    assert result.ideal_qty == 37.4
    assert result.feasible_qty != result.ideal_qty
    assert result.was_constrained


def test_a_negative_ideal_never_produces_a_negative_order() -> None:
    assert feasible(-5.0).feasible_qty == 0


# -- On hand: a snapshot that is only sometimes current -----------------------


def test_a_fresh_shelf_count_is_known_and_binds() -> None:
    constraint = on_hand_from_snapshot(48.0, AS_OF, AS_OF, ctx())
    assert constraint.availability is Availability.KNOWN
    assert constraint.value == 48.0
    assert constraint.binds


def test_zero_on_hand_is_a_measurement_and_passes_through() -> None:
    """An empty shelf is the state most likely to deserve a reorder.

    It must not be confused with the absence of a count, which is the state
    that must NOT produce one.
    """
    empty = on_hand_from_snapshot(0.0, AS_OF, AS_OF, ctx())
    assert empty.availability is Availability.KNOWN
    assert empty.value == 0.0

    missing = on_hand_from_snapshot(None, AS_OF, AS_OF, ctx())
    assert missing.availability is Availability.UNAVAILABLE
    assert not missing.binds


def test_a_stale_count_is_stale_not_unavailable_and_says_how_old() -> None:
    """Stores 97, 92 and 106 last synced 2026-06-03 - 112 days before AS_OF.

    UNAVAILABLE would say the warehouse cannot supply a shelf count, which is
    false and unactionable. STALE says a sync stopped, which somebody can go
    and restart.
    """
    constraint = on_hand_from_snapshot(
        120.0, date(2026, 6, 3), AS_OF, ctx()
    )
    assert constraint.availability is Availability.STALE
    assert constraint.availability is not Availability.UNAVAILABLE
    assert not constraint.binds
    assert constraint.value is None, "a stale count supplies no number at all"
    assert "112 days ago" in (constraint.detail or "")
    assert "2026-06-03" in (constraint.detail or "")


def test_the_staleness_limit_comes_from_the_registry() -> None:
    from app.pipeline.constraints import MAX_STOCK_SNAPSHOT_AGE_DAYS
    from app.pipeline.registry import cfg as registry

    eight_days_old = AS_OF - timedelta(days=8)
    assert on_hand_from_snapshot(
        5.0, eight_days_old, AS_OF, ctx()
    ).availability is Availability.STALE

    loose = registry.with_overrides(
        "loose", {MAX_STOCK_SNAPSHOT_AGE_DAYS.name: 30}
    )
    assert on_hand_from_snapshot(
        5.0, eight_days_old, AS_OF, ctx(config_version="loose"), loose
    ).availability is Availability.KNOWN


def test_a_negative_count_is_unparseable_and_never_clamped_to_zero() -> None:
    """83,322 of 911,022 product rows estate-wide report negative stock.

    Clamped to zero it would read as an empty shelf and order the maximum -
    the same failure as a missing count, arrived at more confidently.
    """
    constraint = on_hand_from_snapshot(-7.0, AS_OF, AS_OF, ctx())
    assert constraint.availability is Availability.UNPARSEABLE
    assert constraint.value is None
    assert not constraint.binds


def test_a_count_with_no_sync_time_cannot_be_trusted_to_be_current() -> None:
    constraint = on_hand_from_snapshot(48.0, None, AS_OF, ctx())
    assert constraint.availability is Availability.STALE


def test_a_datetime_sync_time_is_accepted_alongside_a_date() -> None:
    """The exporter carries an ISO timestamp; the pipeline works in dates."""
    synced = datetime(2026, 9, 23, 7, 0, 8, tzinfo=UTC)
    assert on_hand_from_snapshot(
        48.0, synced, AS_OF, ctx()
    ).availability is Availability.KNOWN


def test_a_stale_count_cannot_be_smuggled_into_a_quantity() -> None:
    """The whole point: sheet 11 must refuse rather than size an order."""
    stale_on_hand = on_hand_from_snapshot(120.0, date(2026, 6, 3), AS_OF, ctx())
    result = apply_constraints(
        ApplyRequest("SKU1", 37.4, constraints(on_hand=stale_on_hand)), ctx()
    )
    assert not result.ok or (result.value is not None
                             and "on_hand" in " ".join(result.value.not_applied))
