"""Sheet 14 — decision validation. The last gate before the model is called."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.pipeline.candidates import CandidateIdentity, ReorderCandidate
from app.pipeline.constraints import (
    Availability,
    Constraint,
    budget_unavailable,
    known,
    shelf_capacity_unavailable,
)
from app.pipeline.context import RunContext
from app.pipeline.provenance import Provenance
from app.pipeline.registry import cfg
from app.pipeline.validate import (
    INVENTORY_TOLERANCE_UNITS,
    MAX_ORDER_BY_HORIZON_DAYS,
    MAX_PLAUSIBLE_ORDER_MULTIPLE,
    REQUIRED_CONSTRAINTS,
    RISK_TOLERANCE_PCT,
    Check,
    DecisionRequest,
    Severity,
    pageable,
    validate_decision,
)

AS_OF = date(2026, 9, 23)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-14", "tenant_id": 1, "store_id": 1, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"validate": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def candidate():
    return ReorderCandidate(
        CandidateIdentity(1, 1, "080686001904"), "reorder",
        Provenance(own_observations=120, own_weight=0.9,
                   evidence_state="MATURE"),
        None, feasible_qty=24, order_by_date=AS_OF + timedelta(days=7),
        demand_p50=30.0, demand_p90=44.0, on_hand=20.0, on_order=0.0,
        lead_time_days=7, lead_time_assumption="a 7-day lead time (declared)",
    )


def constraints() -> list[Constraint]:
    """Every constraint stage 11 knows about, each in a legitimate state."""
    return [
        known("case_pack", 12),
        known("on_hand", 20),
        Constraint("moq", None, Availability.INSUFFICIENT_HISTORY,
                   "2 purchases, need 3"),
        shelf_capacity_unavailable(),
        budget_unavailable(),
    ]


def request(**over) -> DecisionRequest:
    base = {
        "candidate": candidate(), "quantity": 24,
        "order_by_date": AS_OF + timedelta(days=7),
        "demand_p50": 30.0, "demand_p90": 44.0, "on_hand": 20.0,
        "on_order": 0.0, "safety_stock": 8.0, "lead_time_days": 7,
        "constraints": constraints(), "stated_risk": 150.0,
        "unit_margin": 5.0,
        "assumptions": ("a 7-day lead time (declared, not measured)",),
    }
    base.update(over)
    return DecisionRequest(**base)


def validate(**over):
    return validate_decision(request(**over), ctx())


def reasons_for(check: Check, result) -> list[str]:
    return [r for r in result.reasons if f":{check.value}:" in r]


# ── A valid candidate passes and carries its full record ─────────────────────


def test_a_valid_candidate_passes_and_carries_its_full_record() -> None:
    """The sheet's fifth required test.

    Sheet 16 checks the explanation against THIS record, so it must contain
    every figure the card may display.
    """
    result = validate()
    assert result.ok, result.reasons

    record = result.value
    assert record.sku == "080686001904"
    assert record.quantity == 24
    assert record.order_by_date == AS_OF + timedelta(days=7)

    figures = record.figures()
    for key in ("quantity", "demand_p50", "demand_p90", "on_hand", "on_order",
                "safety_stock", "lead_time_days", "unit_margin", "stated_risk"):
        assert key in figures, f"the card may need {key} and cannot say it"
        assert figures[key] is not None

    # Every constraint accounted for, by name and state.
    assert set(record.constraint_states) >= set(REQUIRED_CONSTRAINTS)
    assert record.constraint_states["shelf_capacity"] == "unavailable"
    assert record.constraint_states["case_pack"] == "known"
    assert record.assumptions


def test_the_record_omits_money_figures_when_there_is_no_money_claim() -> None:
    """A family that states no risk must not carry a null one into sheet 16."""
    record = validate(stated_risk=None, unit_margin=None).value
    assert "stated_risk" not in record.figures()
    assert "unit_margin" not in record.figures()
    assert record.figures()["quantity"] == 24.0


# ── 1. QUANTITY ──────────────────────────────────────────────────────────────


def test_a_negative_quantity_is_rejected() -> None:
    """The sheet's first required test."""
    result = validate(quantity=-5)
    assert not result.ok
    assert result.value is None, "a failed decision produces no record"
    assert reasons_for(Check.QUANTITY, result)
    assert "quantity_is_not_positive:-5" in result.reasons[0]


def test_a_zero_quantity_is_rejected() -> None:
    assert not validate(quantity=0).ok


def test_a_non_integer_quantity_is_rejected() -> None:
    """A fractional order is stage 11's job to round; arriving here unrounded
    means that stage was skipped."""
    result = validate(quantity=24.5)
    assert not result.ok
    assert "quantity_is_not_an_integer" in result.reasons[0]


def test_a_quantity_beyond_the_policy_bound_is_rejected() -> None:
    result = validate(quantity=500, order_up_to=40.0)
    assert not result.ok
    assert any("exceeds_policy_order_up_to" in r for r in result.reasons)


def test_an_implausible_quantity_is_rejected_as_an_arithmetic_error() -> None:
    """A decimal slip, not a large order.

    Sheet 11 caps by shelf and budget where those exist, and neither does
    today - so this is the only thing between a units/cases confusion and a
    purchase order.
    """
    multiple = cfg.get(MAX_PLAUSIBLE_ORDER_MULTIPLE, ctx())
    result = validate(quantity=int(30.0 * multiple) + 1, order_up_to=None)
    assert not result.ok
    assert any("quantity_implausible" in r for r in result.reasons)


# ── 2. DATE ──────────────────────────────────────────────────────────────────


def test_a_past_order_by_date_is_rejected() -> None:
    """The sheet's second required test."""
    past = AS_OF - timedelta(days=3)
    result = validate(order_by_date=past)
    assert not result.ok
    assert reasons_for(Check.DATE, result)
    assert past.isoformat() in result.reasons[0]
    assert AS_OF.isoformat() in result.reasons[0], (
        "both dates must be in the reason so a paged engineer can see the gap"
    )


def test_today_is_not_in_the_past() -> None:
    """An order due today is due today, not overdue."""
    assert validate(order_by_date=AS_OF).ok


def test_a_missing_order_by_date_is_rejected() -> None:
    result = validate(order_by_date=None)
    assert not result.ok
    assert "order_by_date_is_missing" in result.reasons[0]


def test_an_unreachably_distant_deadline_is_rejected() -> None:
    """A deadline years out is date arithmetic that went wrong upstream.

    It would read to an owner as "no hurry" on a card about a stockout.
    """
    horizon = cfg.get(MAX_ORDER_BY_HORIZON_DAYS, ctx())
    result = validate(order_by_date=AS_OF + timedelta(days=horizon + 1))
    assert not result.ok
    assert any("unreachably_far" in r for r in result.reasons)


def test_a_negative_lead_time_is_rejected() -> None:
    result = validate(lead_time_days=-3)
    assert not result.ok
    assert any("lead_time_is_negative" in r for r in result.reasons)


# ── 3. RISK ──────────────────────────────────────────────────────────────────


def test_a_risk_figure_that_does_not_reconcile_is_rejected_with_both_values() -> None:
    """The sheet's third required test.

    A mismatch means two stages disagree about the same quantity. That is a
    BUG, and the reason carries BOTH values so whoever is paged can see which
    stage is wrong without reproducing the run.
    """
    result = validate(stated_risk=900.0)   # 30.0 * 5.0 = 150.0
    assert not result.ok
    reason = reasons_for(Check.RISK, result)[0]
    assert "900.00" in reason, "the stated value must be in the reason"
    assert "150.00" in reason, "and so must the expected one"
    assert "demand_p50=30.00" in reason and "margin=5.00" in reason


def test_a_risk_figure_within_tolerance_passes() -> None:
    """Display rounding is not a disagreement."""
    tolerance = cfg.get(RISK_TOLERANCE_PCT, ctx())
    just_inside = 150.0 * (1 + (tolerance - 1) / 100)
    assert validate(stated_risk=just_inside).ok


def test_a_risk_stated_without_a_margin_is_rejected() -> None:
    """A money figure with nothing to derive it from is the worst kind."""
    result = validate(stated_risk=150.0, unit_margin=None)
    assert not result.ok
    assert "risk_stated_without_a_margin" in reasons_for(Check.RISK, result)[0]


def test_no_risk_claim_means_no_risk_check() -> None:
    assert validate(stated_risk=None, unit_margin=None).ok


# ── 4. CONSTRAINTS — silence is a failure ────────────────────────────────────


def test_a_constraint_that_was_never_evaluated_is_rejected() -> None:
    """The sheet's fourth required test, and the quiet class of bug.

    A constraint nobody evaluated is not a constraint that passed. Sheet 11's
    whole point is that "we do not know your shelf capacity" and "you have
    infinite shelf" are different sentences - a validator that accepts silence
    undoes that in one line.
    """
    partial = [c for c in constraints() if c.name != "shelf_capacity"]
    result = validate(constraints=partial)
    assert not result.ok
    reason = reasons_for(Check.CONSTRAINTS, result)[0]
    assert "constraint_never_evaluated:shelf_capacity" in reason
    assert "silence is not a pass" in reason


def test_every_required_constraint_is_checked_for() -> None:
    for name in REQUIRED_CONSTRAINTS:
        partial = [c for c in constraints() if c.name != name]
        result = validate(constraints=partial)
        assert not result.ok, f"{name} may be omitted silently"
        assert any(f"constraint_never_evaluated:{name}" in r
                   for r in result.reasons)


def test_no_constraints_at_all_is_rejected_not_treated_as_unbounded() -> None:
    result = validate(constraints=())
    assert not result.ok
    assert len(reasons_for(Check.CONSTRAINTS, result)) == len(REQUIRED_CONSTRAINTS)


def test_an_unavailable_constraint_without_a_reason_is_rejected() -> None:
    """An assumed bound wearing an honest label."""
    bare = [c for c in constraints() if c.name != "budget"]
    bare.append(Constraint("budget", None, Availability.UNAVAILABLE, None))
    result = validate(constraints=bare)
    assert not result.ok
    assert any("unavailable_without_a_reason:budget" in r
               for r in result.reasons)


def test_a_constraint_claiming_known_with_no_value_is_rejected() -> None:
    broken = [c for c in constraints() if c.name != "case_pack"]
    broken.append(Constraint("case_pack", None, Availability.KNOWN, "12"))
    result = validate(constraints=broken)
    assert not result.ok
    assert any("claims_known_with_no_value" in r for r in result.reasons)


def test_an_explicitly_unavailable_constraint_passes() -> None:
    """Recorded absence is acceptable; only silence is not."""
    assert validate().ok
    assert "unavailable" in validate().value.constraint_states.values()


# ── 5. INVENTORY — the arithmetic must close ─────────────────────────────────


def test_the_inventory_identity_must_close() -> None:
    """on_hand + order - demand >= safety_stock."""
    result = validate(quantity=1, safety_stock=80.0)
    assert not result.ok
    reason = reasons_for(Check.INVENTORY, result)[0]
    assert "inventory_does_not_close" in reason
    for fragment in ("on_hand=20.0", "order=1", "demand=30.0",
                     "safety_stock=80.0"):
        assert fragment in reason, f"{fragment} missing from the reason"


def test_on_order_counts_toward_closing_the_identity() -> None:
    """Stock already on its way is stock."""
    assert not validate(quantity=1, on_order=0.0, safety_stock=40.0).ok
    assert validate(quantity=1, on_order=60.0, safety_stock=40.0).ok


def test_the_case_pack_rounding_tolerance_is_respected() -> None:
    tolerance = float(cfg.get(INVENTORY_TOLERANCE_UNITS, ctx()))
    # Closing position exactly one unit short - the ceil that produced it.
    assert validate(quantity=24, safety_stock=14.0 + tolerance).ok
    assert not validate(quantity=24, safety_stock=14.0 + tolerance + 1.0).ok


# ── Severity: this sheet pages, sheet 16 logs ────────────────────────────────


def test_every_failure_here_is_page_severity() -> None:
    """A failure here means an upstream stage produced something impossible.

    Sheet 16 failures only log - conflating the two is what made the previous
    single validator useless, because both kinds produced the same dropped
    card and the same log line and neither was ever investigated.
    """
    result = validate(quantity=-5, order_by_date=AS_OF - timedelta(days=1),
                      stated_risk=900.0, constraints=())
    assert not result.ok
    assert all(r.startswith(f"{Severity.PAGE.value}:") for r in result.reasons)
    assert pageable(result.reasons) == list(result.reasons)


def test_the_two_severities_are_distinct_values() -> None:
    assert Severity.PAGE is not Severity.LOG
    assert Severity.PAGE.value == "page" and Severity.LOG.value == "log"


def test_every_check_runs_even_after_one_fails() -> None:
    """A paged engineer should see everything wrong, not the first thing.

    Two stages disagreeing often breaks more than one invariant, and fixing
    them one page at a time is how an incident lasts all afternoon.
    """
    result = validate(
        quantity=-5,
        order_by_date=AS_OF - timedelta(days=1),
        stated_risk=900.0,
        constraints=(),
        safety_stock=500.0,
    )
    assert not result.ok
    caught = {check for check in Check
              if any(f":{check.value}:" in r for r in result.reasons)}
    assert caught == set(Check), f"only {caught} reported"


def test_a_failure_names_which_gate_caught_it() -> None:
    result = validate(quantity=-5)
    assert result.reasons[0].startswith("page:quantity:")


# ── Tolerances come from the registry ────────────────────────────────────────


def test_every_tolerance_is_a_provisional_registry_setting() -> None:
    for setting in (RISK_TOLERANCE_PCT, INVENTORY_TOLERANCE_UNITS,
                    MAX_ORDER_BY_HORIZON_DAYS, MAX_PLAUSIBLE_ORDER_MULTIPLE):
        assert setting.status == "PROVISIONAL", setting.name
        assert setting.why


def test_tightening_the_risk_tolerance_catches_a_smaller_disagreement() -> None:
    near = 150.0 * 1.04   # 4% off - inside the default 5%
    assert validate(stated_risk=near).ok

    strict = cfg.with_overrides("strict", {RISK_TOLERANCE_PCT.name: 1})
    result = validate_decision(
        request(stated_risk=near), ctx(config_version="strict"), strict
    )
    assert not result.ok
    assert "risk_does_not_reconcile" in result.reasons[0]


def test_it_runs_before_any_model_is_called() -> None:
    """The gate exists to spend no tokens on a wrong decision."""
    import ast
    import inspect

    from app.pipeline.validate import decision as decision_module

    tree = ast.parse(inspect.getsource(decision_module))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert not (imported & {"anthropic", "openai", "httpx", "requests"})


# ── The windows must match — found on the first real run ─────────────────────


def test_demand_is_prorated_to_the_window_the_order_covers() -> None:
    """The mismatch this gate caught on its own first real run.

    `demand_p50` is sheet 07's forecast over a 30 OPEN-day horizon. The order
    is sheet 10's, sized for lead time plus review period - 14 days. Checking
    a 14-day order against 30 days of demand compares two different
    quantities, and it paged on all three of store 171's decisions:

        on_hand=48.0 + on_order=0.0 + order=116 - demand=277.8 = -113.8

    The order was right; the comparison was not. A false page is worse than no
    page, because it teaches people to ignore the real one.
    """
    from app.pipeline.validate import coverage_demand

    demand, window = coverage_demand(
        request(demand_p50=300.0, horizon_days=30, coverage_days=14)
    )
    assert demand == pytest.approx(140.0), "300 over 30d is 140 over 14d"
    assert window == 14


def test_the_real_store_171_decision_passes_once_the_windows_match() -> None:
    """The exact numbers that paged, and now do not."""
    # stated_risk is over the FORECAST horizon (277.8 x 5.00), deliberately a
    # different window from the coverage one below: the risk a card displays is
    # the full exposure, while the order only has to cover to the next delivery.
    paging = request(
        quantity=116, on_hand=48.0, on_order=0.0, demand_p50=277.8,
        demand_p90=354.1, safety_stock=30.0, order_up_to=200.0,
        stated_risk=1389.0,
        horizon_days=0, coverage_days=0,   # windows unstated -> compares 30d
    )
    assert not validate_decision(paging, ctx()).ok

    matched = request(
        quantity=116, on_hand=48.0, on_order=0.0, demand_p50=277.8,
        demand_p90=354.1, safety_stock=30.0, order_up_to=200.0,
        stated_risk=1389.0,
        horizon_days=30, coverage_days=14,
    )
    result = validate_decision(matched, ctx())
    assert result.ok, result.reasons


def test_the_failure_reason_names_the_window_it_used() -> None:
    """So a paged engineer can see which window the comparison was over."""
    result = validate_decision(
        request(quantity=1, safety_stock=500.0, horizon_days=30,
                coverage_days=14),
        ctx(),
    )
    assert not result.ok
    assert "_over_14d" in reasons_for(Check.INVENTORY, result)[0]


def test_unstated_windows_fall_back_to_the_forecast_as_given() -> None:
    """Correct only when the caller sized the order over the same window -
    and the reason then names no window, so the ambiguity is visible."""
    from app.pipeline.validate import coverage_demand

    demand, window = coverage_demand(request(demand_p50=42.0, horizon_days=0,
                                             coverage_days=0))
    assert demand == 42.0 and window == 0


def test_risk_stays_on_the_forecast_horizon_and_is_not_prorated() -> None:
    """Two windows, deliberately - and this pins the distinction.

    The risk a card displays is the FULL exposure over the forecast horizon:
    what the store stands to lose if it does nothing. The order only has to
    cover to the next delivery. Pro-rating risk to the coverage window too
    would quietly shrink every risk figure on every card to less than half of
    what is actually at stake.
    """
    stated_over_the_horizon = request(
        demand_p50=100.0, unit_margin=5.0, stated_risk=500.0,
        horizon_days=30, coverage_days=14,
        on_hand=200.0, safety_stock=0.0,
    )
    assert validate_decision(stated_over_the_horizon, ctx()).ok

    stated_over_the_coverage_window = request(
        demand_p50=100.0, unit_margin=5.0, stated_risk=233.0,
        horizon_days=30, coverage_days=14,
        on_hand=200.0, safety_stock=0.0,
    )
    result = validate_decision(stated_over_the_coverage_window, ctx())
    assert not result.ok, "a risk figure over the wrong window is a stage bug"
    assert pageable(result.reasons)


def test_the_record_names_the_window_the_check_compared_over() -> None:
    """A card that says "covers you for N days" must say which N.

    Sheet 16 allows only numerals present in `figures()`, so without this the
    window could not appear on a card at all - and the pro-rated demand would
    be a number the gate used but nobody could see.
    """
    record = validate_decision(
        request(quantity=116, on_hand=48.0, demand_p50=277.8, demand_p90=354.1,
                safety_stock=30.0, stated_risk=1389.0, order_up_to=200.0,
                horizon_days=30, coverage_days=14),
        ctx(),
    ).value
    assert record is not None
    assert record.coverage_days == 14
    assert record.coverage_demand == pytest.approx(129.64, abs=0.01)
    assert record.figures()["coverage_days"] == 14.0
    assert "coverage_demand" in record.figures()


def test_an_unstated_window_puts_no_window_figure_on_the_card() -> None:
    """Better absent than wrong: nothing claims a coverage window that the
    caller never stated."""
    record = validate_decision(request(horizon_days=0, coverage_days=0),
                               ctx()).value
    assert record is not None
    assert "coverage_days" not in record.figures()


def test_a_failed_decision_carries_no_record_to_reword() -> None:
    """A candidate that fails here is DROPPED, not passed on with a caveat.

    The record is what sheet 16 writes a sentence from. Emitting one for a
    decision that failed would let a wrong decision reach the model, where the
    only thing that could happen to it is being worded well.
    """
    result = validate_decision(request(quantity=-5), ctx())
    assert not result.ok
    assert result.value is None
    assert result.reasons
