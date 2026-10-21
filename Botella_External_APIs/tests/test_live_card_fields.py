"""The range and the downside, promoted from the harness onto the LIVE card.

Both were measured for weeks in the ledger while no owner ever saw either. These
tests pin the two things that make the promotion safe:

    the card gains a claim it can be HELD to, instead of a bare point estimate
    neither figure may change WHICH products are chosen, or their order
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date, timedelta

import pytest

from app.recommender.deterministic import Pick, to_raw_recommendations

AS_OF = date(2026, 10, 6)

BASE = Pick(
    sku="SKU1", rank=1, recent_units=12.0, recent_rate=0.43, long_run_rate=3.44,
    reverted_rate=0.92, uplift=2.14, p_hit=0.65, deficit_units=17.0,
    dispersion_cv=0.47, evidence_state="EMERGING", why="because",
    long_run_days_available=365, family="recovering", days_cover=4.0,
    unit_cost=11.50, horizon_open_days=25.7,
)


def card(**over) -> dict:
    """One card from the LIVE path - identifiers supplied."""
    return to_raw_recommendations(
        [replace(BASE, **over)], as_of=AS_OF, client_id=1, location_id=171)[0]


def legacy_card(**over) -> dict:
    """One card from a caller that passes no identifiers."""
    return to_raw_recommendations([replace(BASE, **over)], as_of=AS_OF)[0]


# ── The promotion is additive ────────────────────────────────────────────────


def test_an_existing_caller_is_completely_unchanged() -> None:
    """Every consumer downstream - validation, persistence, the day-grain
    archive, the interface - reads this dict. The new fields are ABSENT rather
    than null-filled, so a reader can tell "not computed" from "computed and
    refused"."""
    old = legacy_card()
    for key in ("expected_range_low", "expected_range_high",
                "expected_range_coverage", "expected_range_basis",
                "expected_range_refused", "holding_cost_if_unsold"):
        assert key not in old, key
    # And the hint carries no range.
    assert "land between" not in old["quantity_hint"]


def test_the_decision_figures_are_identical_with_and_without_the_range() -> None:
    """THE safety property. If promoting these changed a decision figure, the
    +16.6-point edge measured on the old ordering would no longer describe what
    ships."""
    old, new = legacy_card(), card()
    for key in ("primary_skus", "confidence", "suggested_order_qty",
                "engine_daily_rate", "engine_days_cover", "engine_on_hand",
                "action_type", "category", "rationale", "rank"):
        assert old[key] == new[key], key


def test_order_is_untouched_by_the_new_fields() -> None:
    picks = [replace(BASE, sku=f"S{i}", rank=i, deficit_units=20.0 - i)
             for i in range(1, 6)]
    plain = [c["primary_skus"] for c in
             to_raw_recommendations(picks, as_of=AS_OF)]
    rich = [c["primary_skus"] for c in to_raw_recommendations(
        picks, as_of=AS_OF, client_id=1, location_id=171)]
    assert plain == rich


# ── The range ────────────────────────────────────────────────────────────────


def test_the_live_card_states_a_range_it_can_be_held_to() -> None:
    c = card()
    assert c["expected_range_low"] < c["expected_range_high"]
    assert c["expected_range_coverage"] == pytest.approx(0.90)
    assert isinstance(c["expected_range_low"], int)
    assert "land between" in c["quantity_hint"]
    assert "90% of the time" in c["quantity_hint"]


def test_the_range_names_its_own_window() -> None:
    """A stockout card's quantity covers COVERAGE_DAYS while the range spans the
    reversion horizon. An unlabelled range put two different horizons in one
    sentence and read as a contradiction."""
    hint = card(family="stockout")["quantity_hint"]
    assert "to cover the next" in hint          # the order quantity's window
    assert "selling days" in hint               # the RANGE's window, named
    # Both windows appear, so neither number can be read against the wrong one.
    assert hint.index("to cover the next") < hint.index("selling days")


def test_the_range_is_wider_for_an_erratic_product() -> None:
    """The whole reason it is negative binomial rather than Poisson."""
    steady = card(dispersion_cv=0.1)
    erratic = card(dispersion_cv=1.2)
    steady_width = steady["expected_range_high"] - steady["expected_range_low"]
    erratic_width = erratic["expected_range_high"] - erratic["expected_range_low"]
    assert erratic_width > steady_width * 2


def test_a_refused_range_is_named_not_silently_dropped() -> None:
    """"No range" and "a range we declined to state, because X" are different
    facts to anyone reading the card."""
    for over, expected in ((dict(dispersion_cv=None), "no_dispersion"),
                           (dict(horizon_open_days=None), "no_inputs"),
                           (dict(reverted_rate=0.0), "no_demand")):
        c = card(**over)
        assert "expected_range_low" not in c, over
        assert c["expected_range_refused"].startswith(expected), over
        # The card still ships - a missing range is not a missing card.
        assert c["primary_skus"] == ["SKU1"]


def test_an_unmeasured_dispersion_does_not_become_the_narrowest_range() -> None:
    """Zero cv is the NARROWEST range there is, so defaulting an unmeasured SKU
    to it would state the most confident possible claim on the least evidence."""
    assert "expected_range_low" not in card(dispersion_cv=None)


# ── The downside ─────────────────────────────────────────────────────────────


def test_the_card_states_what_being_wrong_costs() -> None:
    """Every card until now stated an upside with no downside beside it."""
    c = card()
    assert c["holding_cost_if_unsold"] > 0.0
    # Cents a month on an $11.50 bottle, not $11.50 - it is not a write-off.
    assert c["holding_cost_if_unsold"] < 17.0 * 11.50 * 0.25
    assert "obsolescence" in c["holding_cost_basis"]


def test_no_unit_cost_means_no_figure_rather_than_zero() -> None:
    """Five of ten audited stores send no unit cost at all. A $0.00 downside
    reads as "being wrong is free", which is a claim nobody measured."""
    c = card(unit_cost=None)
    assert "holding_cost_if_unsold" not in c
    assert "expected_range_low" in c, "the range is independent of cost"


def test_a_genuinely_free_item_still_gets_a_real_cost() -> None:
    """The falsy-zero bug: `cost or default` maps a genuine 0.0 to the default.
    A free item ties up no capital but still occupies shelf, so its holding cost
    is small and POSITIVE, never absent."""
    c = card(unit_cost=0.0)
    assert "holding_cost_if_unsold" in c
    assert c["holding_cost_if_unsold"] > 0.0
    assert c["holding_cost_if_unsold"] < card(unit_cost=11.50)[
        "holding_cost_if_unsold"]


def test_an_overstock_card_is_charged_no_holding_cost() -> None:
    """You are not buying this - you are trying to stop owning it. A cost of
    being wrong here would be read as the cost of following advice that says to
    reduce stock."""
    c = card(family="overstock")
    assert "holding_cost_if_unsold" not in c
    assert c["suggested_order_qty"] is None
    assert c["action_type"] == "markdown"


def test_a_stockout_card_is_charged_a_holding_cost() -> None:
    c = card(family="stockout")
    assert c["holding_cost_if_unsold"] > 0.0
    assert c["suggested_order_qty"] is not None


def test_the_card_names_the_family_that_made_it() -> None:
    """A stockout card and a recovering card are both category
    'inventory_understock', action 'reorder'. Only one of them claims "it runs
    out before the next delivery", and the evaluator grades that claim on
    sell-through rather than lift - so the card has to say which it is, on
    every path, including the one that passes no identifiers."""
    for family in ("stockout", "recovering", "overstock"):
        assert card(family=family)["engine_family"] == family
        assert legacy_card(family=family)["engine_family"] == family
    # Same wire shape as the other engine facts: no owner-facing text depends
    # on it, and the two reorder families still share category and action.
    assert card(family="stockout")["action_type"] == card(
        family="recovering")["action_type"] == "reorder"


def test_the_hazard_basis_admits_the_category_is_unknown() -> None:
    """Without a POS category for the SKU the per-family obsolescence hazard
    cannot be applied and the DEFAULT is used. Saying so is the difference
    between an approximation and a silent one. (Checklist 12 put the category
    on the route; a pick built without one still has to say so.)"""
    basis = card()["holding_cost_basis"]
    assert "DEFAULT" in basis
    assert "no POS category" in basis


# ── The deadline, and the lead time it rests on ──────────────────────────────
#
# Weber Ranch 1L, 19 October 2026: the Recommendations card read "Order by
# Mon, Oct 19" and the Purchasing row for the same bottle read "Thu, Oct 22".
# The card's date was browser arithmetic on engine_days_cover with a hard-coded
# seven; the row's was a different formula with a lead of three. Nothing stored
# either. These pin the engine's date as the one source: computed here, with
# the lead time the card quotes, and carried on the payload.

from app.schemas.context import LeadTime  # noqa: E402  (section-local import, as above)

MEASURED = LeadTime(days=3, source="measured", observations=4,
                    vendor="Glazers Beer & Beverage")
DEFAULT_ROW = LeadTime(days=7, source="default", observations=0,
                       vendor="Southern Glazer's")


def test_the_deadline_is_as_of_plus_the_slack_after_the_lead_time() -> None:
    """20.6 days of cover on a seven-day lead: 13.6 days of slack, floored to
    13. The 19th, not the 20th - a deadline is the LAST safe day, and rounding
    up names a day on which the shelf is already short."""
    c = card(days_cover=20.6)
    assert c["order_by"] == "2026-10-19"
    assert c["lead_time_days"] == 7
    assert c["lead_time_basis"] == "declared"


def test_floor_not_round() -> None:
    """13.9 days of cover, lead 7: 6.9 days of slack is six safe days."""
    assert card(days_cover=13.9)["order_by"] == (AS_OF + timedelta(days=6)).isoformat()


def test_a_product_already_inside_its_lead_window_is_due_on_as_of() -> None:
    """Four days of cover against a seven-day lead is -3 days of slack. The
    date is today, never three days ago: an order-by in the past reads as
    broken software or advice that arrived too late."""
    assert card(days_cover=4.0)["order_by"] == AS_OF.isoformat()
    assert card(days_cover=0.0)["order_by"] == AS_OF.isoformat()


def test_unknown_stock_means_no_date_rather_than_todays() -> None:
    """With no cover figure there is no honest deadline. The lead time is still
    stated - it is a fact about the vendor, not about the shelf."""
    c = card(days_cover=None)
    assert "order_by" not in c
    assert c["lead_time_days"] == 7
    assert c["lead_time_basis"] == "declared"


def test_a_measured_vendor_lead_time_moves_the_date_and_says_so() -> None:
    """The same rule the stockout sentence and the policy quantity apply: a
    measured row with receipts is quoted, a default row is the declared
    seven. 20.6 days of cover on a three-day lead is 17 days of slack."""
    measured = to_raw_recommendations(
        [replace(BASE, days_cover=20.6)], as_of=AS_OF, client_id=1,
        location_id=171, lead_times={"SKU1": MEASURED})[0]
    assert measured["lead_time_days"] == 3
    assert measured["lead_time_basis"] == "measured"
    assert measured["order_by"] == "2026-10-23"

    default_row = to_raw_recommendations(
        [replace(BASE, days_cover=20.6)], as_of=AS_OF, client_id=1,
        location_id=171, lead_times={"SKU1": DEFAULT_ROW})[0]
    assert default_row["lead_time_days"] == 7
    assert default_row["lead_time_basis"] == "declared"
    assert default_row["order_by"] == "2026-10-19"

    # A map that knows OTHER skus changes nothing about this one.
    other = to_raw_recommendations(
        [replace(BASE, days_cover=20.6)], as_of=AS_OF, client_id=1,
        location_id=171, lead_times={"OTHER": MEASURED})[0]
    assert other["lead_time_days"] == 7
    assert other["order_by"] == "2026-10-19"


def test_the_deadline_is_a_date_string_not_a_datetime() -> None:
    """Kept as YYYY-MM-DD at every boundary (DAILY-CAPTURE.md section 4): a
    datetime would be read back at local midnight and stringified a day early
    on any host west of UTC."""
    c = card(days_cover=20.6)
    assert isinstance(c["order_by"], str)
    assert len(c["order_by"]) == 10
    assert date.fromisoformat(c["order_by"]) == date(2026, 10, 19)


def test_a_markdown_card_carries_no_deadline_and_no_lead_time() -> None:
    """Nothing to order, so no day to order it by. An "order by" on the card
    that says you own too many would be read as a date to buy more."""
    c = card(family="overstock", days_cover=140.0)
    for key in ("order_by", "lead_time_days", "lead_time_basis"):
        assert key not in c, key


def test_a_stockout_card_carries_the_deadline_too() -> None:
    c = card(family="stockout", days_cover=4.0)
    assert c["order_by"] == AS_OF.isoformat()
    assert c["lead_time_days"] == 7


def test_a_legacy_caller_gets_the_deadline_as_well() -> None:
    """`as_of` is always known, so the date is not conditional on identifiers
    the way the range is. A consumer of the plain path sees the same date."""
    c = legacy_card(days_cover=20.6)
    assert c["order_by"] == "2026-10-19"
    assert c["lead_time_basis"] == "declared"


def test_the_deadline_changes_no_decision_figure() -> None:
    """The safety property this file exists for, restated for the new fields."""
    plain = card(days_cover=20.6)
    with_lead = to_raw_recommendations(
        [replace(BASE, days_cover=20.6)], as_of=AS_OF, client_id=1,
        location_id=171, lead_times={"SKU1": MEASURED})[0]
    for key in ("primary_skus", "confidence", "suggested_order_qty",
                "engine_daily_rate", "engine_days_cover", "engine_on_hand",
                "action_type", "category", "rationale", "rank"):
        assert plain[key] == with_lead[key], key


def test_the_deadline_survives_the_response_model() -> None:
    """The boundary that silently discarded six months of fields (see
    tests/test_card_surface.py). The three new keys are declared, so they
    arrive; an invented basis is refused rather than passed through."""
    from pydantic import ValidationError
    from app.schemas.recommendation import Recommendation

    c = card(days_cover=20.6)
    model = Recommendation.model_validate(c)
    assert model.order_by == c["order_by"] == "2026-10-19"
    assert model.lead_time_days == 7
    assert model.lead_time_basis == "declared"
    dumped = model.model_dump()
    for key in ("order_by", "lead_time_days", "lead_time_basis"):
        assert key in dumped, key

    # Absence stays absent: a markdown card reports None, not a date.
    md = Recommendation.model_validate(card(family="overstock"))
    assert md.order_by is None and md.lead_time_days is None
    assert md.lead_time_basis is None

    with pytest.raises(ValidationError):
        Recommendation.model_validate({**c, "lead_time_basis": "guessed"})
