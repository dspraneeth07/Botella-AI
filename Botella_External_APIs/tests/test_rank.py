"""Sheet 13 — deterministic ranking. Code, not a model."""

from __future__ import annotations

import ast
import inspect
from datetime import date, timedelta

import pytest

from app.pipeline.candidates import CandidateIdentity, ReorderCandidate
from app.pipeline.context import RunContext
from app.pipeline.provenance import Provenance
from app.pipeline.rank import (
    MAX_PER_FAMILY_IN_TOP_N,
    TOP_N,
    URGENCY_FLOOR,
    URGENCY_HORIZON_DAYS,
    WEIGHT_CONFIDENCE,
    WEIGHT_EXPECTED_VALUE,
    RankRequest,
    ScoreInputs,
    apply_family_cap,
    expected_value_of,
    rank_candidates,
    score_candidate,
    sort_key,
    urgency_of,
)
from app.pipeline.rank import order as order_module
from app.pipeline.rank import score as score_module
from app.pipeline.registry import cfg

AS_OF = date(2026, 9, 23)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-13", "tenant_id": 1, "store_id": 1, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"rank": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def candidate(sku: str, family: str = "reorder"):
    return ReorderCandidate(
        CandidateIdentity(1, 1, sku), family,
        Provenance(own_observations=10, own_weight=1.0,
                   evidence_state="MATURE"),
        None, feasible_qty=10, order_by_date=AS_OF, demand_p50=10.0,
        demand_p90=15.0, on_hand=0.0, on_order=0.0, lead_time_days=7,
        lead_time_assumption="declared",
    )


def inputs(sku: str, *, margin: float | None = 5.0, units: float = 20.0,
           confidence: float = 0.8, days: int = 5,
           family: str = "reorder") -> ScoreInputs:
    return ScoreInputs(
        candidate=candidate(sku, family),
        calibrated_confidence=confidence,
        units_at_stake=units,
        unit_margin=margin,
        decision_by=AS_OF + timedelta(days=days),
    )


def rank(*items, **over):
    result = rank_candidates(RankRequest(items), ctx(**over))
    assert result.ok, result.reasons
    return result.value


# ── Byte-identical across runs ───────────────────────────────────────────────


def test_two_runs_produce_byte_identical_output() -> None:
    """The sheet's first required test.

    This stage is one of the few in the pipeline where bitwise determinism is
    ACHIEVABLE - no bootstrap, no model, no clock - so it is asserted rather
    than hoped for. The day somebody sorts on a dict, reads a clock, or lets a
    set's iteration order leak into the output, this fails.
    """
    items = [
        inputs("CCC", margin=10.0, units=30.0, confidence=0.5, days=1),
        inputs("AAA", margin=5.0, units=20.0, confidence=0.8, days=3),
        inputs("BBB", margin=2.0, units=10.0, confidence=0.9, days=25),
    ]
    first = rank(*items)
    second = rank(*items)

    assert first.to_bytes() == second.to_bytes(), "serialised output differs"
    assert [r.score.sku for r in first.ranked] == [
        r.score.sku for r in second.ranked
    ]
    assert [r.rank for r in first.ranked] == [1, 2, 3]


def test_input_order_does_not_change_the_output() -> None:
    """Reproducible by construction, not by accident.

    Python's sort is stable, so without an explicit tie-break the order would
    be whatever order the caller happened to build the list in.
    """
    a = inputs("AAA", margin=5.0)
    b = inputs("BBB", margin=5.0)
    c = inputs("CCC", margin=5.0)
    assert rank(a, b, c).to_bytes() == rank(c, b, a).to_bytes()


def test_ties_break_on_ascending_sku() -> None:
    """A property of the DATA, not of the caller."""
    identical = [inputs(sku) for sku in ("ZZZ", "AAA", "MMM")]
    ranked = rank(*identical)
    scores = {r.score.score for r in ranked.ranked}
    assert len(scores) == 1, "fixture must produce a genuine tie"
    assert [r.score.sku for r in ranked.ranked] == ["AAA", "MMM", "ZZZ"]


def test_the_sort_key_is_negated_score_then_sku() -> None:
    high = score_candidate(inputs("ZZZ", margin=10.0), ctx())
    low = score_candidate(inputs("AAA", margin=1.0), ctx())
    assert sort_key(high) < sort_key(low), "higher score sorts first"
    assert sort_key(high)[0] == -high.score


# ── Changing one number moves it predictably ─────────────────────────────────


def test_raising_a_candidates_margin_moves_it_up() -> None:
    """The sheet's second required test."""
    before = rank(inputs("AAA", margin=1.0), inputs("BBB", margin=5.0))
    assert [r.score.sku for r in before.ranked] == ["BBB", "AAA"]

    after = rank(inputs("AAA", margin=50.0), inputs("BBB", margin=5.0))
    assert [r.score.sku for r in after.ranked] == ["AAA", "BBB"]


def test_each_term_moves_the_score_in_the_expected_direction() -> None:
    base = score_candidate(inputs("X"), ctx()).score
    assert score_candidate(inputs("X", margin=10.0), ctx()).score > base
    assert score_candidate(inputs("X", units=40.0), ctx()).score > base
    assert score_candidate(inputs("X", confidence=0.95), ctx()).score > base
    assert score_candidate(inputs("X", days=1), ctx()).score > base
    assert score_candidate(inputs("X", days=90), ctx()).score < base


def test_a_zero_in_any_term_zeroes_the_score() -> None:
    """Multiplied, not summed: two strong terms must not carry a zero third.

    A certain, urgent recommendation worth nothing is worth nothing.
    """
    assert score_candidate(
        inputs("X", margin=0.0, confidence=0.99, days=1), ctx()
    ).score == 0.0
    assert score_candidate(
        inputs("X", margin=100.0, confidence=0.0, days=1), ctx()
    ).score == 0.0


# ── Calibrated, never raw ────────────────────────────────────────────────────


def test_raw_confidence_is_never_used_in_place_of_calibrated() -> None:
    """The sheet's fourth required test - asserted, not reviewed.

    Sheet 08 measured stated confidence at 0.48 against a 0.23 hit rate.
    Ranking on that would order cards by how confident the engine SOUNDS
    rather than by how often it is right.
    """
    # The AST, not the source text: both docstrings legitimately NAME the
    # thing they forbid, and a substring grep cannot tell an explanation from
    # a violation.
    for module in (score_module, order_module):
        tree = ast.parse(inspect.getsource(module))
        names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
        names |= {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
        assert "raw" not in names, f"{module.__name__} reads a raw value"
        assert "raw_confidence" not in names


def test_the_input_field_is_the_calibrated_one() -> None:
    field_names = set(ScoreInputs.__dataclass_fields__)
    assert "calibrated_confidence" in field_names
    assert "raw_confidence" not in field_names
    assert "confidence" not in field_names, (
        "an ambiguous name is how the raw value gets used by accident"
    )


def test_a_confidence_outside_zero_to_one_is_refused() -> None:
    with pytest.raises(ValueError, match="within 0..1"):
        ScoreInputs(candidate("X"), 1.5, 10.0, 5.0, AS_OF)


# ── The family cap ───────────────────────────────────────────────────────────


def test_the_family_cap_holds() -> None:
    """The sheet third required test.

    The guarantee is precise: EVERY family present gets up to `cap` slots in
    the window before ANY family gets more than `cap`. A store that receives
    ten reorder cards and nothing else has been told one thing ten times.
    """
    cap = cfg.get(MAX_PER_FAMILY_IN_TOP_N, ctx())
    top = cfg.get(TOP_N, ctx())

    # Eight reorders scoring above eight clears. Without the cap the clears
    # would be invisible; with it they get their reserved share.
    reorders = [inputs(f"R{i:02d}", margin=10.0 - i * 0.1, family="reorder")
                for i in range(8)]
    clears = [inputs(f"C{i:02d}", margin=9.0 - i * 0.1, family="clear")
              for i in range(8)]
    window = [r.score.family for r in rank(*reorders, *clears).ranked[:top]]

    assert window.count("clear") >= cap, (
        "the lower-scoring family must get its reserved share"
    )
    assert "clear" in window[:cap + 2], "and get it EARLY, not at the bottom"


def test_a_lone_other_family_is_never_crowded_out() -> None:
    """Eight reorders and one clear: the clear must still be seen."""
    reorders = [inputs(f"R{i:02d}", margin=10.0 - i * 0.1) for i in range(8)]
    lone_clear = inputs("CLEAR1", margin=1.0, family="clear")
    top = cfg.get(TOP_N, ctx())
    window = [r.score.family for r in rank(*reorders, lone_clear).ranked[:top]]
    assert "clear" in window


def test_the_window_is_backfilled_rather_than_left_half_empty() -> None:
    """A store with only reorders is not helped by being shown three cards.

    The cap reserves room for other families; where there are none, the room
    goes back to the family that has something to say.
    """
    only_reorders = [inputs(f"R{i:02d}", margin=10.0 - i * 0.1)
                     for i in range(8)]
    ranked = rank(*only_reorders)
    top = cfg.get(TOP_N, ctx())
    assert len(ranked.ranked[:top]) == 8, (
        "all eight are visible - none held back for a family that does not exist"
    )
    assert ranked.overflow == ()


def test_held_back_candidates_are_recorded_and_never_deleted() -> None:
    """The cap changes what is SEEN first; it deletes nothing."""
    reorders = [inputs(f"R{i:02d}", margin=10.0 - i * 0.1) for i in range(12)]
    clears = [inputs(f"C{i:02d}", margin=9.0 - i * 0.1, family="clear")
              for i in range(6)]
    ranked = rank(*reorders, *clears)
    assert len(ranked.ranked) == 18, "every candidate is still present"
    assert ranked.overflow, "and the ones held out are recorded"
    for sku, family, reason in ranked.overflow:
        assert sku and family in {"reorder", "clear"}
        assert "family_cap" in reason


def test_the_cap_is_not_a_quota() -> None:
    """It limits one family; it does not reserve slots for absent ones.

    A quota would manufacture a markdown to fill a slot, which is the
    opposite of every other rule in this programme.
    """
    only_reorders = [inputs(f"R{i:02d}") for i in range(3)]
    ranked = rank(*only_reorders)
    assert len(ranked.ranked) == 3
    assert ranked.overflow == (), "nothing displaced, nothing invented"


def test_the_cap_comes_from_the_registry() -> None:
    reorders = [inputs(f"R{i:02d}", margin=10.0 - i * 0.1) for i in range(12)]
    clears = [inputs(f"C{i:02d}", margin=9.0 - i * 0.1, family="clear")
              for i in range(6)]
    assert rank(*reorders, *clears).overflow, "the default cap holds some back"
    loose = cfg.with_overrides("loose", {MAX_PER_FAMILY_IN_TOP_N.name: 99})
    result = rank_candidates(
        RankRequest((*reorders, *clears)), ctx(config_version="loose"), loose
    ).value
    assert result.overflow == ()


# ── Urgency ──────────────────────────────────────────────────────────────────


def test_urgency_decays_from_now_to_the_horizon() -> None:
    floor = cfg.get(URGENCY_FLOOR, ctx())
    horizon = cfg.get(URGENCY_HORIZON_DAYS, ctx())
    values = [
        urgency_of(AS_OF + timedelta(days=d), AS_OF, horizon, floor)
        for d in (0, 1, 10, 29, 30, 60)
    ]
    assert values[0] == 1.0, "due today is maximally urgent"
    assert values == sorted(values, reverse=True)
    assert values[-1] == floor


def test_a_past_deadline_is_maximally_urgent_not_worthless() -> None:
    """The window closing is the most urgent state there is."""
    floor = cfg.get(URGENCY_FLOOR, ctx())
    horizon = cfg.get(URGENCY_HORIZON_DAYS, ctx())
    assert urgency_of(AS_OF - timedelta(days=5), AS_OF, horizon, floor) == 1.0


def test_no_deadline_scores_the_floor_not_zero() -> None:
    """A floor of zero would silently delete every card without a deadline."""
    floor = cfg.get(URGENCY_FLOOR, ctx())
    horizon = cfg.get(URGENCY_HORIZON_DAYS, ctx())
    assert urgency_of(None, AS_OF, horizon, floor) == floor
    assert floor > 0.0
    assert URGENCY_FLOOR.default > 0.0


# ── Missing margin is not an assumed margin ──────────────────────────────────


def test_a_candidate_without_cost_scores_zero_value_and_says_which_zero() -> None:
    """31 stores send 0.00% cost, so this is common - and a zero from missing
    data must not look like a zero from a worthless candidate."""
    value, available = expected_value_of(inputs("X", margin=None))
    assert value == 0.0 and available is False

    value, available = expected_value_of(inputs("X", margin=0.0))
    assert value == 0.0 and available is True

    scored = score_candidate(inputs("X", margin=None), ctx())
    assert scored.margin_available is False
    assert "no cost data" in scored.explain()


def test_no_default_margin_rate_is_applied() -> None:
    from app.pipeline.rank.score import DEFAULT_MARGIN_RATE
    assert DEFAULT_MARGIN_RATE.default == 0
    assert "ZERO on purpose" in DEFAULT_MARGIN_RATE.why


# ── No model, no randomness, no clock ────────────────────────────────────────


def test_the_module_calls_no_model_reads_no_clock_and_uses_no_randomness() -> None:
    banned_modules = {"random", "anthropic", "openai", "requests", "httpx",
                      "secrets", "time"}
    banned_calls = {"now", "today", "monotonic", "random", "shuffle",
                    "choice", "uniform"}

    for module in (score_module, order_module):
        tree = ast.parse(inspect.getsource(module))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert alias.name.split(".")[0] not in banned_modules, (
                        f"{module.__name__} imports {alias.name}"
                    )
            elif isinstance(node, ast.ImportFrom) and node.module:
                assert node.module.split(".")[0] not in banned_modules, (
                    f"{module.__name__} imports from {node.module}"
                )
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                assert node.func.attr not in banned_calls, (
                    f"{module.__name__} calls {node.func.attr}()"
                )


def test_every_date_comes_from_the_run_context() -> None:
    """Two runs over the same snapshot rank identically months apart."""
    items = [inputs("AAA", days=3), inputs("BBB", days=20)]
    today = rank(*items)
    # A different run_id and seed must not change the ordering.
    later = rank_candidates(
        RankRequest(items), ctx(run_id="another", seed=99)
    ).value
    assert today.to_bytes() == later.to_bytes()


# ── Weights ──────────────────────────────────────────────────────────────────


def test_every_weight_is_a_provisional_registry_setting() -> None:
    for setting in (WEIGHT_EXPECTED_VALUE, WEIGHT_CONFIDENCE,
                    URGENCY_HORIZON_DAYS, URGENCY_FLOOR,
                    MAX_PER_FAMILY_IN_TOP_N, TOP_N):
        assert setting.status == "PROVISIONAL", setting.name
        assert setting.why


def test_raising_the_confidence_weight_favours_the_certain_candidate() -> None:
    """A commercial preference, expressed as a setting rather than a constant."""
    # 60*20*0.3 = 360 against 8*20*0.99 = 158: BIG wins on money at weight 1.
    big_risky = inputs("BIG", margin=60.0, confidence=0.3)
    small_sure = inputs("SURE", margin=8.0, confidence=0.99)

    assert [r.score.sku for r in rank(big_risky, small_sure).ranked][0] == "BIG"

    conservative = cfg.with_overrides("cons", {WEIGHT_CONFIDENCE.name: 6.0})
    result = rank_candidates(
        RankRequest((big_risky, small_sure)),
        ctx(config_version="cons"), conservative,
    ).value
    assert [r.score.sku for r in result.ranked][0] == "SURE"


def test_the_ranking_is_empty_without_candidates_rather_than_failing() -> None:
    result = rank_candidates(RankRequest(()), ctx())
    assert result.ok
    assert result.value.ranked == ()
    assert result.value.to_bytes()


def test_apply_family_cap_is_a_no_op_when_disabled() -> None:
    scores = [score_candidate(inputs(f"R{i}"), ctx()) for i in range(5)]
    kept, overflow = apply_family_cap(scores, 0, 10)
    assert len(kept) == 5 and overflow == []


# ── Sheet 20 at the ranking seam ─────────────────────────────────────────────
#
# The old engine ranked on the demand rate. That orders by how big a seller
# is, so it picks the biggest sellers - whose trailing windows are the most
# inflated - and those are exactly the SKUs that fall back. Measured on
# Bethany: 39.3% and MINUS $13,783, against 65.6% and PLUS $14,508. The whole
# difference is which quantity reaches `units_at_stake`.


def _reverted(sku: str, recent_units: float, long_units: float):
    from app.pipeline.blend import ReversionRequest, revert

    result = revert(
        ReversionRequest(
            sku=sku, recent_units=recent_units, recent_open_days=24,
            long_run_units=long_units, long_run_open_days=300,
            weekly_rates=(1.0,) * 6, horizon_days=30,
        ),
        ctx(versions={"temporal_reversion": "1.0.0"}),
    )
    assert result.ok, result.reasons
    return result.value


def test_from_reversion_puts_the_deficit_in_units_at_stake_not_the_rate() -> None:
    """The one mistake this constructor exists to prevent."""
    quiet = _reverted("A", 12.0, 300.0)
    si = ScoreInputs.from_reversion(candidate("A"), quiet, 0.8, unit_margin=5.0)

    assert si.units_at_stake == pytest.approx(quiet.deficit_units)
    assert si.units_at_stake != pytest.approx(quiet.rate_per_open_day)
    assert si.units_at_stake > 0.0


def test_a_falling_sku_scores_zero_value_rather_than_negative() -> None:
    """A negative deficit is a real answer and belongs at the bottom of the
    list, not as an exception and not as a negative score - a negative value
    multiplied by an exponent weight is not even well defined."""
    hot = _reverted("B", 72.0, 300.0)
    assert hot.deficit_units < 0.0

    si = ScoreInputs.from_reversion(candidate("B"), hot, 0.8, unit_margin=5.0)
    assert si.units_at_stake == 0.0
    scored = score_candidate(si, ctx())
    assert scored.expected_value == 0.0
    assert scored.score == 0.0


def test_the_quiet_sku_outranks_the_hot_one() -> None:
    """End to end, and the inverse of what the old engine did. The hot SKU
    sells six times as fast; it still must not be recommended over the one
    whose evidence says it is about to recover."""
    quiet = _reverted("A", 12.0, 300.0)
    hot = _reverted("B", 72.0, 300.0)
    assert hot.recent_rate > quiet.recent_rate      # B really is the big seller

    a = ScoreInputs.from_reversion(candidate("A"), quiet, 0.8, unit_margin=5.0,
                                   decision_by=AS_OF + timedelta(days=5))
    b = ScoreInputs.from_reversion(candidate("B"), hot, 0.8, unit_margin=5.0,
                                   decision_by=AS_OF + timedelta(days=5))
    assert score_candidate(a, ctx()).score > score_candidate(b, ctx()).score


def test_p_hit_cannot_be_passed_as_the_calibrated_confidence() -> None:
    """p_hit is ORDERED but not numerically calibrated - 0.55 corresponds to a
    42% outcome. Sheet 08 measured the cost of trusting a stated confidence:
    0.48 claimed against 0.23 actual. The constructor takes the calibrated
    value as a separate argument precisely so p_hit cannot slide into it.
    """
    import inspect as _inspect

    sig = _inspect.signature(ScoreInputs.from_reversion)
    assert "calibrated_confidence" in sig.parameters
    source = _inspect.getsource(ScoreInputs.from_reversion)
    body = source.split('"""')[-1]
    assert "p_hit" not in body, (
        "from_reversion must not read reverted.p_hit - the caller supplies "
        "the sheet-08 calibrated value"
    )
