"""Sheet 10 — reorder point and safety stock, the ideal quantity."""

from __future__ import annotations

import ast
import inspect
import math
from datetime import date

import pytest

from app.pipeline.context import RunContext
from app.pipeline.policy import inventory as inventory_module
from app.pipeline.policy.inventory import (
    LEAD_TIME_DAYS,
    REVIEW_PERIOD_DAYS,
    SERVICE_LEVEL_BY_FAMILY,
    InventoryPolicy,
    PolicyRequest,
    estimate_policy,
    normal_cdf,
    service_level_for,
    sigma_from_interval,
    z_for,
)
from app.pipeline.registry import cfg

AS_OF = date(2026, 9, 23)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-10", "tenant_id": 1, "store_id": 1, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"policy": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def policy(**over) -> InventoryPolicy:
    result = request(**over)
    assert result.ok, result.reasons
    return result.value


def request(**over):
    base = {"sku": "X", "family": "default", "p10": 20.0, "p50": 30.0,
            "p90": 40.0, "horizon_open_days": 30, "on_hand": 10.0}
    base.update(over)
    return estimate_policy(PolicyRequest(**base), ctx())


# ── The four the sheet asks for ──────────────────────────────────────────────


def test_a_higher_service_level_produces_more_safety_stock() -> None:
    """The sheet's first required test."""
    by_family = {f: policy(family=f) for f in ("wine", "default", "spirits", "beer")}

    levels = [p.service_level for p in by_family.values()]
    safety = [p.safety_stock for p in by_family.values()]
    assert levels == sorted(levels), "fixture ordering assumption"
    assert safety == sorted(safety), "more service must mean more buffer"

    assert by_family["beer"].service_level > by_family["wine"].service_level
    assert by_family["beer"].safety_stock > by_family["wine"].safety_stock
    assert by_family["beer"].ideal_qty > by_family["wine"].ideal_qty


def test_a_wider_forecast_interval_produces_more_safety_stock() -> None:
    """The sheet's second required test - and why sheet 07 had to return one.

    The point estimate is IDENTICAL in every case here (p50 = 30). Only the
    spread moves, and the buffer moves with it. A point estimate alone cannot
    do this, which is the whole reason sheet 07 returns p10/p50/p90.
    """
    widths = [(29.0, 31.0), (25.0, 35.0), (15.0, 45.0), (5.0, 55.0)]
    results = [policy(p10=lo, p90=hi) for lo, hi in widths]

    assert all(p.mu_daily == pytest.approx(1.0) for p in results), (
        "the point estimate must be constant across this test"
    )
    safety = [p.safety_stock for p in results]
    assert safety == sorted(safety)
    assert safety[-1] > safety[0] * 10, "a 25x wider interval must bite hard"


def test_a_missing_interval_refuses_rather_than_defaulting_sigma() -> None:
    """The sheet's third required test.

    Substituting a default sigma would produce a confident-looking quantity
    resting on a number nobody measured.
    """
    for missing in ("p10", "p90"):
        result = request(**{missing: None})
        assert not result.ok
        assert "forecast_has_no_interval" in result.reasons[0]
        assert "default_sigma" in result.reasons[0]
        assert result.value is None, "no quantity at all, not a guessed one"


def test_a_missing_forecast_refuses_too() -> None:
    result = request(p50=None)
    assert not result.ok
    assert "no_forecast" in result.reasons[0]


def test_an_inverted_interval_refuses() -> None:
    result = request(p10=40.0, p90=20.0)
    assert not result.ok
    assert "interval_is_inverted" in result.reasons[0]


def test_on_order_is_subtracted() -> None:
    """The sheet's fourth required test, and a real bug class.

    `storeagent/functions/buying.py` computes `target - on_hand` and never
    subtracts stock already on its way, so a store that ordered yesterday
    orders the same quantity again today.
    """
    nothing_coming = policy(on_order=0.0)
    some_coming = policy(on_order=5.0)
    plenty_coming = policy(on_order=25.0)

    assert some_coming.ideal_qty == pytest.approx(
        nothing_coming.ideal_qty - 5.0
    )
    assert plenty_coming.ideal_qty == 0.0, "never a negative order"
    assert plenty_coming.should_order is False


def test_unknown_on_order_is_recorded_as_an_assumption_not_a_measured_zero() -> None:
    """None is UNKNOWN. Zero is a measurement. They must not be the same.

    `purchase_orders` exists in the analytics database with 0 rows, so nothing
    records outstanding orders anywhere. Unknown is the normal state, and it
    is said out loud.
    """
    unknown = policy(on_order=None)
    known_zero = policy(on_order=0.0)

    assert unknown.ideal_qty == known_zero.ideal_qty, "same arithmetic"
    assert len(unknown.assumptions) == len(known_zero.assumptions) + 1
    assert any("on order" in a for a in unknown.assumptions)
    assert not any("on order" in a for a in known_zero.assumptions)


# ── Lead time is a declared assumption ───────────────────────────────────────


def test_the_review_period_is_declared_too_and_says_so() -> None:
    """The order-up-to level covers lead time PLUS the wait to reorder.

    Without the review period every cycle runs short by exactly the gap
    between ordering opportunities.
    """
    assumed = policy()
    assert REVIEW_PERIOD_DAYS.status == "PROVISIONAL"
    assert any("ordering again in" in a for a in assumed.assumptions)
    supplied = policy(review_period_days=3)
    assert not any("ordering again in" in a for a in supplied.assumptions)
    assert supplied.order_up_to < assumed.order_up_to, (
        "a shorter wait to reorder means less to hold"
    )


def test_the_declared_lead_time_travels_in_the_result_and_the_card() -> None:
    """With no override the figure is the registry's, and the sentence says it
    is a supplier default - declared, not measured."""
    assumed = policy()
    assert any("lead time" in a for a in assumed.assumptions)
    assert "supplier default, declared, not measured" in " ".join(assumed.assumptions)
    assert "Assumes:" in assumed.explain()
    assert LEAD_TIME_DAYS.status == "PROVISIONAL"
    assert "DECLARED ASSUMPTION" in LEAD_TIME_DAYS.why


# ── Checklist 16: the sentence is ALWAYS there, and says which basis ─────────
#
# A supplied override used to record NO lead-time sentence at all. That left a
# measured vendor's card unable to say it was measured, and `generate.py`
# withholds a reorder whose `lead_time_assumption` is empty - so the first
# vendor anyone measured would have silently lost its cards.


def test_a_measured_lead_time_is_reported_as_measured_with_its_receipts() -> None:
    measured = policy(
        lead_time_days=3, vendor="Southern Glazer's",
        lead_time_source="measured", lead_time_observations=4,
        lead_time_measured_from=date(2026, 3, 6),
        lead_time_measured_to=date(2026, 6, 5),
    )
    assert measured.lead_time_days == 3
    sentence = next(a for a in measured.assumptions if "lead time" in a)
    assert sentence == (
        "a 3-day delivery lead time for Southern Glazer's "
        "(measured from 4 receipts between 2026-03-06 and 2026-06-05)"
    )
    assert "declared" not in sentence
    # And the card prints it in the same sentence as the number.
    assert "measured from 4 receipts" in measured.explain()


def test_a_declared_and_a_measured_lead_time_are_distinguishable_by_substring() -> None:
    """`run_decisions.py` picks the sentence by the word "lead"; the card prints
    it verbatim. The two bases must never share a marker."""
    declared = " ".join(policy().assumptions)
    measured = " ".join(policy(lead_time_days=4, lead_time_source="measured",
                               lead_time_observations=3).assumptions)
    assert "declared, not measured" in declared and "measured from" not in declared
    assert "measured from" in measured and "declared, not measured" not in measured


def test_a_default_row_from_node_reads_as_declared_and_names_the_vendor() -> None:
    """A vendor Node knows but has too few receipts for: the figure is still
    the declared default, and the sentence says so - with the vendor."""
    named = policy(vendor="Breakthru", lead_time_source="default")
    sentence = next(a for a in named.assumptions if "lead time" in a)
    assert sentence == ("a 7-day delivery lead time for Breakthru "
                        "(supplier default, declared, not measured)")


def test_an_override_without_provenance_is_neither_declared_nor_measured() -> None:
    """The harness and the older tests hand in a figure and nothing else. That
    must not read as measured - nobody said it was - and must not read as the
    default either, because it is not the registry's number."""
    supplied = policy(lead_time_days=3)
    sentence = next(a for a in supplied.assumptions if "lead time" in a)
    assert "supplied by the caller, provenance not stated" in sentence
    assert "measured from" not in sentence and "declared" not in sentence
    assert supplied.lead_time_days == 3


def test_measured_with_zero_receipts_is_not_believed() -> None:
    """A row that says "measured" on no observations is a malformed row, and
    the sentence must not claim receipts it cannot count."""
    claimed = policy(lead_time_days=3, lead_time_source="measured",
                     lead_time_observations=0)
    sentence = next(a for a in claimed.assumptions if "lead time" in a)
    assert "measured from" not in sentence
    assert "provenance not stated" in sentence


def test_the_measured_sentence_reads_one_receipt_in_the_singular() -> None:
    one = policy(lead_time_days=5, lead_time_source="measured",
                 lead_time_observations=1)
    assert "measured from 1 receipt)" in " ".join(one.assumptions)


def test_a_longer_lead_time_raises_both_the_buffer_and_the_order() -> None:
    """The scaling the flat-percentage buffer in buying.py cannot do.

    safety grows as sqrt(lead_time) while the cycle stock grows linearly, so
    a vendor who takes three weeks needs more of both than one who takes
    three days - and buying.py gives them the same buffer.
    """
    quick = policy(lead_time_days=3)
    slow = policy(lead_time_days=21)
    assert slow.safety_stock > quick.safety_stock
    assert slow.safety_stock == pytest.approx(
        quick.safety_stock * math.sqrt(21 / 3)
    )
    assert slow.ideal_qty > quick.ideal_qty


def test_the_vendor_is_named_in_the_assumption_when_one_is_given() -> None:
    named = policy(vendor="Southern Glazer's")
    assert any("Southern Glazer's" in a for a in named.assumptions)


def test_a_zero_or_negative_lead_time_refuses() -> None:
    assert not request(lead_time_days=0).ok
    assert not request(lead_time_days=-5).ok


# ── Service level is a business decision ─────────────────────────────────────


def test_every_family_has_its_own_setting_and_none_is_signed_off() -> None:
    assert set(SERVICE_LEVEL_BY_FAMILY) == {"beer", "wine", "spirits", "default"}
    for family, setting in SERVICE_LEVEL_BY_FAMILY.items():
        assert setting.status == "PROVISIONAL", family
        assert "SIGN-OFF" in setting.why, (
            f"{family}: a service level is a commercial decision and the "
            "setting must say it has not been made yet"
        )
        assert 0.0 < setting.default < 1.0


def test_the_seeds_follow_measured_turnover_not_a_single_global_number() -> None:
    """Wine turns at 18.0 units/SKU against beer's 51.3, so wine gets less.

    95% service on a slow mover ties up capital for a year - the sheet's own
    mezcal example, and the reason a single global figure is wrong.
    """
    beer = SERVICE_LEVEL_BY_FAMILY["beer"].default
    wine = SERVICE_LEVEL_BY_FAMILY["wine"].default
    assert beer > wine
    assert len({s.default for s in SERVICE_LEVEL_BY_FAMILY.values()}) > 1, (
        "one number for every family would be the buried global this sheet "
        "exists to replace"
    )


def test_an_unknown_family_falls_back_to_the_default_setting() -> None:
    assert service_level_for("tobacco", ctx()) == pytest.approx(
        SERVICE_LEVEL_BY_FAMILY["default"].default
    )


def test_the_service_level_comes_from_the_registry() -> None:
    strict = cfg.with_overrides(
        "strict", {SERVICE_LEVEL_BY_FAMILY["default"].name: 0.99}
    )
    raised = estimate_policy(
        PolicyRequest("X", "default", 20.0, 30.0, 40.0, 30, 10.0),
        ctx(config_version="strict"), strict,
    ).value
    assert raised.service_level == pytest.approx(0.99)
    assert raised.safety_stock > policy().safety_stock


# ── The arithmetic ───────────────────────────────────────────────────────────


def test_the_formula_is_the_one_the_sheet_states() -> None:
    p = policy(family="beer", lead_time_days=7, review_period_days=7,
               on_hand=10.0, on_order=2.0)

    assert p.safety_stock == pytest.approx(
        p.z * p.sigma_daily * math.sqrt(p.lead_time_days)
    )
    assert p.reorder_point == pytest.approx(
        p.mu_daily * p.lead_time_days + p.safety_stock
    )
    assert p.order_up_to == pytest.approx(
        p.reorder_point + p.review_period_days * p.mu_daily
    )
    assert p.ideal_qty == pytest.approx(
        p.order_up_to - p.on_hand - p.on_order
    )


def test_sigma_is_derived_from_the_quantile_levels_not_a_hardcoded_divisor() -> None:
    """If sheet 07's quantiles change, every safety stock follows."""
    sigma = sigma_from_interval(20.0, 40.0, 0.10, 0.90)
    expected = 20.0 / (z_for(0.90) - z_for(0.10))
    assert sigma == pytest.approx(expected)
    # A wider pair of levels implies a SMALLER sigma for the same spread.
    assert sigma_from_interval(20.0, 40.0, 0.01, 0.99) < sigma


def test_sigma_from_an_inverted_quantile_pair_raises() -> None:
    with pytest.raises(ValueError, match="must exceed"):
        sigma_from_interval(20.0, 40.0, 0.90, 0.10)


def test_a_zero_width_interval_gives_zero_safety_stock_not_an_error() -> None:
    """A genuinely certain forecast needs no buffer. That is an answer."""
    certain = policy(p10=30.0, p90=30.0)
    assert certain.sigma_daily == 0.0
    assert certain.safety_stock == 0.0
    assert certain.ideal_qty > 0, "cycle stock is still needed"


def test_the_ideal_quantity_is_never_negative() -> None:
    assert policy(on_hand=10_000.0).ideal_qty == 0.0


# ── z(p) ─────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("probability", "published"),
    [(0.85, 1.0364), (0.90, 1.2816), (0.95, 1.6449), (0.975, 1.9600),
     (0.99, 2.3263)],
)
def test_the_inverse_normal_matches_published_values(probability, published) -> None:
    assert z_for(probability) == pytest.approx(published, abs=1e-3)


def test_z_is_symmetric_and_zero_at_the_median() -> None:
    assert z_for(0.5) == pytest.approx(0.0, abs=1e-9)
    assert z_for(0.75) == pytest.approx(-z_for(0.25), abs=1e-9)


def test_z_refuses_a_probability_outside_the_open_unit_interval() -> None:
    for bad in (0.0, 1.0, -0.1, 1.5):
        with pytest.raises(ValueError, match="strictly between"):
            z_for(bad)


def test_the_normal_cdf_and_its_inverse_round_trip() -> None:
    for probability in (0.05, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99):
        assert normal_cdf(z_for(probability)) == pytest.approx(
            probability, abs=1e-9
        )


# ── This stage does NOT do sheet 11's job ────────────────────────────────────


def test_the_ideal_quantity_is_not_rounded_capped_or_moq_adjusted() -> None:
    """Keeping them separate is what lets the card explain why 37.4 became 24.

    Rounding here would destroy the information sheet 11 needs to explain
    itself, and the owner would see a number with no derivation.
    """
    p = policy(p10=21.7, p50=33.3, p90=44.9, on_hand=3.0)
    assert p.ideal_qty != int(p.ideal_qty), "a fractional ideal must survive"

    source = inspect.getsource(inventory_module)
    tree = ast.parse(source)
    called = {
        node.func.id for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert "round" not in called, "rounding belongs to sheet 11"
    assert not {"ceil", "floor"} & called, "case packs belong to sheet 11"

    banned = {"case_pack", "moq", "shelf_capacity", "minimum_order"}
    names = {n.id.lower() for n in ast.walk(tree) if isinstance(n, ast.Name)}
    assert not (names & banned), f"sheet 11's concerns leaked in: {names & banned}"


def test_the_card_states_the_assumptions_in_the_same_sentence_as_the_number() -> None:
    """A quantity resting on a declared lead time and one resting on a
    measured lead time look identical once they are both integers."""
    text = policy().explain()
    assert "Order" in text
    assert "Assumes:" in text
    assert "declared, not measured" in text
    measured = policy(lead_time_days=4, vendor="RNDC", lead_time_source="measured",
                      lead_time_observations=5).explain()
    assert "measured from 5 receipts" in measured
    assert "declared, not measured" not in measured
