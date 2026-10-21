"""The gate, finally on the serving path.

For weeks this logic decided which stores were fit to ship from inside
`scripts/`, which the deployed application cannot import. The verdict existed, an
audit page published it, and the engine it was a verdict ABOUT had no way of
reading it. These tests pin the three properties that make the promotion safe.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date

from app.pipeline.gate.state import GateState
from app.pipeline.gate.store import (
    ServingDecision,
    gate_table,
    serving_decision,
    verdict_for,
)
from app.recommender.deterministic import Pick, to_raw_recommendations

AS_OF = date(2026, 10, 6)

PICK = Pick(
    sku="SKU1", rank=1, recent_units=12.0, recent_rate=0.43, long_run_rate=3.44,
    reverted_rate=0.92, uplift=2.14, p_hit=0.65, deficit_units=17.0,
    dispersion_cv=0.47, evidence_state="EMERGING", why="because",
    long_run_days_available=365, family="recovering", days_cover=4.0,
    unit_cost=11.50, horizon_open_days=25.7,
)


def passing_store(**over) -> dict:
    """A store that holds every check, so a test can break exactly one."""
    base = dict(
        loc="171", name="Bethany", promise_fill_ratio=104.0, ece=2.6,
        interval_coverage=97.0, worst_bin_deviation=4.4,
        bt_edge=16.6, bt_p=0.0005,
        # DENOMINATORS. Every rate check needs one, and so does the ECE check -
        # a figure computed from bins too thin to be evidence is not a
        # measurement. Omitting these made a high ECE read as "not testable",
        # which the power guard correctly exposed.
        cards=183, money_cards30=183, calibration_scored=183,
        interval_considered=183,
        cost=0.95, net30=1500.0, cards_per_run=3.3,
        family_nets={"reorder": 14.6},
    )
    return {**base, **over}


def card(gate_inputs=None, **over) -> dict:
    return to_raw_recommendations(
        [replace(PICK, **over)], as_of=AS_OF, client_id=1, location_id=171,
        gate_inputs=gate_inputs)[0]


# ── 1. It is importable from the application at all ──────────────────────────


def test_the_gate_is_importable_from_the_pipeline_not_only_scripts() -> None:
    """The entire point of the move. `scripts/` is not on the deployed path, so a
    verdict that lived there could never be consulted by the thing it judged."""
    from app.pipeline.gate import store as live_gate

    assert callable(live_gate.serving_decision)
    assert callable(live_gate.gate_table)


def test_the_scripts_shim_still_works_for_every_existing_caller() -> None:
    """Twenty call sites in the harness and the report generators import
    `scripts._gates`. Moving the logic should not have been a reason to touch
    them."""
    from scripts import _gates

    assert _gates.verdict_for is verdict_for
    assert _gates.gate_table is gate_table
    assert _gates.PROMISE_FILL_BAND == (85.0, 115.0)
    assert _gates.MIN_NET_MARGIN_PER_MONTH == 1000.0


def test_the_gate_is_pure_stdlib_so_it_can_live_in_the_pipeline() -> None:
    """`app/pipeline` holds no third-party imports, which is what lets a card be
    reproduced months later from one payload."""
    import pathlib

    source = (pathlib.Path(__file__).parent.parent
              / "app" / "pipeline" / "gate" / "store.py").read_text(encoding="utf-8")
    for banned in ("import structlog", "import psycopg", "import numpy",
                   "import pandas", "import requests"):
        assert banned not in source, banned


# ── 2. Measured-and-failed is not the same as never-measured ─────────────────


def test_an_unmeasured_store_is_shadow_but_not_an_instruction() -> None:
    """BOTH cases are SHADOW, and conflating them is how a rollout goes dark. A
    consumer that treats "nobody measured this" as "this failed" withholds every
    card at every store the moment it starts reading the flag."""
    unmeasured = serving_decision(None)
    assert unmeasured.state is GateState.SHADOW
    assert unmeasured.displayed is False
    assert unmeasured.measured is False, "no verdict exists, so there is no opinion"
    assert "no_gate_inputs" in unmeasured.reason

    failed = serving_decision(passing_store(net30=100.0, promise_fill_ratio=20.0))
    assert failed.state is GateState.SHADOW
    assert failed.displayed is False
    assert failed.measured is True, "this one IS an instruction"
    assert "failed:" in failed.reason


def test_a_dict_with_nothing_measured_is_also_not_an_instruction() -> None:
    """A store row that exists but carries no measurements - every field None -
    must not read as a failure."""
    empty = serving_decision({"loc": "999", "name": "New Store"})
    assert empty.measured is False
    assert empty.displayed is False
    assert "nothing_measured" in empty.reason


def test_a_passing_store_is_live() -> None:
    decision = serving_decision(passing_store())
    assert decision.state is GateState.LIVE
    assert decision.displayed is True
    assert decision.measured is True
    assert decision.reason == "both_gates_hold"


def test_the_decision_carries_the_verdict_it_came_from() -> None:
    """So a reader can see WHICH checks failed, not only that something did."""
    # A high ECE now needs a testable bin behind it to count as a failure - the
    # same power guard the coverage check has. The fixture already carries
    # worst_bin_deviation and 183 scored outcomes, so this IS testable.
    decision = serving_decision(passing_store(ece=18.0))
    assert decision.verdict is not None
    assert "calibration_ece" in decision.reason, decision.reason
    d = decision.as_dict()
    assert d["verdict"]["gate_a"]["checks"]
    assert d["measured"] is True and d["displayed"] is False


# ── 3. Nothing is dropped, ever ──────────────────────────────────────────────


def test_a_failing_store_still_produces_cards() -> None:
    """SHADOW means computed, stored and scored - NOT displayed. An engine that
    quietly returns nothing is indistinguishable from an engine that is broken,
    and "nobody noticed" is the exact failure this guards against."""
    failing = passing_store(promise_fill_ratio=20.0, ece=15.0, net30=100.0)
    cards = to_raw_recommendations(
        [PICK], as_of=AS_OF, client_id=1, location_id=176, gate_inputs=failing)
    assert len(cards) == 1
    assert cards[0]["suggested_order_qty"] == 17
    assert cards[0]["gate_displayed"] is False
    # The outcome machinery can still score it, which is how a shadow store ever
    # earns its way out of shadow.
    assert cards[0]["primary_skus"] == ["SKU1"]


def test_the_card_count_is_identical_whatever_the_gate_says() -> None:
    picks = [replace(PICK, sku=f"S{i}", rank=i) for i in range(1, 5)]
    for gate_inputs in (None, passing_store(),
                        passing_store(net30=1.0, promise_fill_ratio=20.0)):
        cards = to_raw_recommendations(
            picks, as_of=AS_OF, client_id=1, location_id=1,
            gate_inputs=gate_inputs)
        assert len(cards) == 4


def test_every_card_carries_the_reason() -> None:
    """"Not shown" with no reason is the kind of refusal nobody can act on."""
    for gate_inputs in (None, passing_store(), passing_store(ece=19.0)):
        c = card(gate_inputs)
        assert c["gate_reason"], gate_inputs
        assert c["gate_state"] in ("shadow", "live", "suspended")
        assert isinstance(c["gate_displayed"], bool)
        assert isinstance(c["gate_measured"], bool)


def test_the_gate_does_not_change_a_single_decision_figure() -> None:
    """It decides whether cards are SHOWN. It must not touch what they say."""
    shown = card(passing_store())
    hidden = card(passing_store(promise_fill_ratio=20.0, net30=1.0))
    for key in ("primary_skus", "confidence", "suggested_order_qty",
                "quantity_hint", "engine_daily_rate", "rationale",
                "expected_range_low", "expected_range_high",
                "holding_cost_if_unsold"):
        assert shown[key] == hidden[key], key


def test_gate_state_values_are_the_same_vocabulary_as_the_family_gate() -> None:
    """`GateState` is reused rather than redefined, so the store-level answer and
    the per-family answer in gate/state.py speak one vocabulary and Node persists
    one set of strings."""
    assert isinstance(serving_decision(passing_store()).state, GateState)
    assert card(passing_store())["gate_state"] == "live"
    assert card(None)["gate_state"] == "shadow"


def test_a_no_cost_store_can_still_go_live_on_accuracy_alone() -> None:
    """Five of ten audited stores send no unit cost. Gate B does not APPLY there,
    and a gate that does not apply does not block."""
    no_cost = passing_store(cost=0.0, net30=None)
    decision = serving_decision(no_cost)
    assert decision.verdict is not None
    assert decision.verdict.gate_b.passed is None, "profit cannot be judged"
    assert decision.displayed is True
    assert decision.measured is True
