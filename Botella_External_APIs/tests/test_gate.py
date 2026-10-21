"""Sheet 17 — the gate. Per store, per family: has this actually worked here?"""

from __future__ import annotations

from datetime import date

import pytest

from app.pipeline.context import RunContext
from app.pipeline.gate import (
    MATCHED_BASKETS,
    MIN_OUTCOMES,
    P_THRESHOLD,
    SUSPEND_P_THRESHOLD,
    GateReason,
    GateRequest,
    GateState,
    Outcome,
    compare_to_matched_null,
    displayable,
    evaluate_gate,
    volume_class,
)
from app.pipeline.registry import cfg

AS_OF = date(2026, 9, 23)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-17", "tenant_id": 171, "store_id": 171, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"gate": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def outcomes(n: int, lift: float, *, cls: str = "v2", shown: bool = True):
    return [Outcome(sku=f"SKU{i}", family="reorder", lift=lift,
                    volume_class=cls, shown=shown) for i in range(n)]


def pool(values, cls: str = "v2") -> dict[str, list[float]]:
    return {cls: list(values)}


def gate(**over):
    base = {"client_id": 171, "location_id": 171, "family": "reorder"}
    base.update(over)
    result = evaluate_gate(GateRequest(**base), ctx())
    assert result.ok, result.reasons
    return result.value


MINIMUM = int(cfg.get(MIN_OUTCOMES, ctx()))


# ── Volume matching: the reason the null is credible ─────────────────────────


def test_volume_classes_separate_the_quiet_from_the_busy() -> None:
    """A SKU selling 2 a month and one selling 200 are not comparable in
    percentage terms."""
    slow = volume_class(0.05, ctx())
    fast = volume_class(50.0, ctx())
    assert slow != fast


def test_an_unmeasured_rate_is_its_own_class_not_the_slowest() -> None:
    """"we never measured this SKU" and "it sells almost nothing" are
    different facts, and matching one against the other assumes the answer."""
    assert volume_class(None, ctx()) == "unmeasured"
    assert volume_class(None, ctx()) != volume_class(0.01, ctx())


def test_the_null_is_drawn_from_the_same_class() -> None:
    result = compare_to_matched_null(
        outcomes(MINIMUM, 1.5, cls="v2"),
        {"v2": [1.0] * 50, "v0": [99.0] * 50},
        ctx(),
    )
    assert result is not None
    # v0's 99.0 never enters the null: it is a different volume class.
    assert result.null_mean == pytest.approx(1.0)


def test_no_comparable_products_is_a_refusal_not_a_pass() -> None:
    """A comparison with nothing to compare against is not a p-value of 1."""
    assert compare_to_matched_null(outcomes(MINIMUM, 5.0), {}, ctx()) is None


def test_the_p_value_can_never_be_reported_as_zero() -> None:
    """With B draws the strongest claim available is 1/(B+1). Pretending to
    more precision than the simulation has is how a gate opens on noise."""
    result = compare_to_matched_null(
        outcomes(MINIMUM, 1000.0), pool([0.0] * 100), ctx()
    )
    assert result is not None
    assert result.p_value > 0
    assert result.p_value == pytest.approx(result.resolution)
    assert result.baskets == int(cfg.get(MATCHED_BASKETS, ctx()))


def test_the_same_snapshot_gives_the_same_p_value() -> None:
    """Determinism: "the gate opened" has to be a reproducible fact."""
    args = (outcomes(MINIMUM, 1.2), pool([1.0, 0.9, 1.1, 1.3] * 25))
    first = compare_to_matched_null(*args, ctx())
    second = compare_to_matched_null(*args, ctx())
    assert first is not None and second is not None
    assert first.p_value == second.p_value


def test_a_different_snapshot_draws_differently() -> None:
    """Otherwise a re-run over new data reuses the old draw and looks more
    stable than it is."""
    args = (outcomes(MINIMUM, 1.2), pool([1.0, 0.5, 1.5, 2.0] * 25))
    a = compare_to_matched_null(*args, ctx(snapshot_id="snap-1"))
    b = compare_to_matched_null(*args, ctx(snapshot_id="snap-2"))
    assert a is not None and b is not None
    assert a.p_value != b.p_value or a.null_mean != b.null_mean


# ── A family below the null does not go live ─────────────────────────────────


def test_a_family_below_the_null_does_not_go_live() -> None:
    """The sheet's first required test."""
    verdict = gate(
        outcomes=outcomes(MINIMUM, 0.5),
        null_pool=pool([1.0, 1.2, 0.9, 1.1] * 25),
        current=GateState.SHADOW,
    )
    assert verdict.state is GateState.SHADOW
    assert verdict.reason is GateReason.DID_NOT_BEAT_THE_NULL
    assert not verdict.displayed


def test_a_family_that_beats_the_null_goes_live() -> None:
    verdict = gate(
        outcomes=outcomes(MINIMUM, 5.0),
        null_pool=pool([1.0, 0.8, 1.2, 0.9] * 25),
        current=GateState.SHADOW,
    )
    assert verdict.state is GateState.LIVE
    assert verdict.reason is GateReason.BEAT_THE_NULL
    assert verdict.displayed
    assert verdict.evidence is not None and verdict.evidence.beats_null


def test_beating_the_null_by_luck_does_not_go_live() -> None:
    """Above the null but well inside the noise: p is nowhere near the bar."""
    verdict = gate(
        outcomes=outcomes(MINIMUM, 1.01),
        null_pool=pool([0.2, 0.6, 1.0, 1.4, 1.8] * 20),
        current=GateState.SHADOW,
    )
    assert verdict.state is GateState.SHADOW
    assert verdict.evidence is not None
    assert verdict.evidence.p_value > float(cfg.get(P_THRESHOLD, ctx()))


# ── Shadow is the default, and it still computes everything ──────────────────


def test_a_new_store_family_pair_starts_in_shadow() -> None:
    verdict = gate(outcomes=(), null_pool={})
    assert verdict.state is GateState.SHADOW
    assert verdict.reason is GateReason.NOT_ENOUGH_OUTCOMES
    assert not verdict.displayed


def test_too_few_outcomes_is_a_verdict_not_an_error() -> None:
    """Shadow is the correct and expected state for most pairs most of the
    time, so it must not look like a failure."""
    result = evaluate_gate(
        GateRequest(client_id=1, location_id=1, family="reorder",
                    outcomes=outcomes(3, 9.0), null_pool=pool([0.1] * 50)),
        ctx(),
    )
    assert result.ok
    assert result.value is not None
    assert result.value.state is GateState.SHADOW


def test_no_matched_null_keeps_it_in_shadow_with_a_stated_reason() -> None:
    verdict = gate(outcomes=outcomes(MINIMUM, 9.0), null_pool={})
    assert verdict.state is GateState.SHADOW
    assert verdict.reason is GateReason.NO_MATCHED_NULL


# ── A live family that drifts is suspended automatically ─────────────────────


def test_a_live_family_that_drifts_is_suspended() -> None:
    """The sheet's second required test."""
    verdict = gate(
        outcomes=outcomes(MINIMUM, 0.4),
        null_pool=pool([1.0, 1.1, 0.9, 1.2] * 25),
        current=GateState.LIVE,
    )
    assert verdict.state is GateState.SUSPENDED
    assert verdict.reason is GateReason.FELL_BELOW_THE_NULL
    assert verdict.transitioned
    assert verdict.previous is GateState.LIVE


def test_a_live_family_whose_evidence_decays_is_suspended() -> None:
    """Above the null, but no longer separable from it.

    This is the band BETWEEN the going-live bar and the maintenance bar, and
    it is the whole reason the two differ. The first version of this test
    could never pass: the suspend threshold defaulted to 0.5, and a roughly
    symmetric null puts p below 0.5 whenever the observed value is above the
    null mean at all - so the condition was unreachable and only the
    below-the-null check ever fired.
    """
    verdict = gate(
        outcomes=outcomes(MINIMUM, 1.05),
        null_pool=pool([0.2, 0.6, 1.0, 1.4, 1.8] * 24),
        current=GateState.LIVE,
    )
    assert verdict.evidence is not None
    assert verdict.evidence.beats_null, "still above the null"
    assert verdict.evidence.p_value >= float(cfg.get(SUSPEND_P_THRESHOLD, ctx()))
    assert verdict.state is GateState.SUSPENDED
    assert verdict.reason is GateReason.EVIDENCE_DECAYED


def test_the_maintenance_bar_sits_between_going_live_and_a_coin_flip() -> None:
    """Below 0.5, or it can never fire: a symmetric null puts p under 0.5
    whenever the observed value is above the null mean at all."""
    suspend = float(cfg.get(SUSPEND_P_THRESHOLD, ctx()))
    assert float(cfg.get(P_THRESHOLD, ctx())) < suspend < 0.5


def test_a_live_family_still_working_stays_live() -> None:
    verdict = gate(
        outcomes=outcomes(MINIMUM, 5.0),
        null_pool=pool([1.0, 0.9, 1.1] * 40),
        current=GateState.LIVE,
    )
    assert verdict.state is GateState.LIVE
    assert verdict.reason is GateReason.STILL_BEATING_THE_NULL
    assert not verdict.transitioned


def test_suspension_is_looser_than_going_live_so_it_does_not_flap() -> None:
    """Symmetric thresholds would flap a family in and out of view on noise,
    which reads to an owner as the system being broken."""
    assert (float(cfg.get(SUSPEND_P_THRESHOLD, ctx()))
            > float(cfg.get(P_THRESHOLD, ctx())))


def test_a_suspended_family_can_recover() -> None:
    """Automatic AND reversible."""
    verdict = gate(
        outcomes=outcomes(MINIMUM, 5.0),
        null_pool=pool([1.0, 0.9, 1.1] * 40),
        current=GateState.SUSPENDED,
    )
    assert verdict.state is GateState.LIVE
    assert verdict.previous is GateState.SUSPENDED


def test_a_suspended_family_clears_the_same_bar_as_a_new_one() -> None:
    """Having once been live earns no benefit of the doubt."""
    verdict = gate(
        outcomes=outcomes(MINIMUM, 1.01),
        null_pool=pool([0.2, 0.6, 1.0, 1.4, 1.8] * 20),
        current=GateState.SUSPENDED,
    )
    assert verdict.state is GateState.SUSPENDED


def test_suspended_is_not_the_same_state_as_shadow() -> None:
    """Shadow means "we have not learned anything yet"; suspended means "we
    learned something and it stopped being true"."""
    assert GateState.SUSPENDED is not GateState.SHADOW
    assert not GateState.SUSPENDED == GateState.SHADOW


# ── A new store inherits its cohort, then earns its own ──────────────────────


def test_a_new_store_inherits_cohort_state_then_transitions() -> None:
    """The sheet's fourth required test."""
    inherited = gate(
        outcomes=outcomes(2, 5.0),
        null_pool=pool([1.0] * 50),
        cohort_state=GateState.LIVE,
    )
    assert inherited.state is GateState.LIVE
    assert inherited.inherited
    assert inherited.reason is GateReason.INHERITED_FROM_COHORT

    # Once it has its own N outcomes, its own verdict takes over.
    own = gate(
        outcomes=outcomes(MINIMUM, 5.0),
        null_pool=pool([1.0, 0.9, 1.1] * 40),
        cohort_state=GateState.LIVE,
    )
    assert own.state is GateState.LIVE
    assert not own.inherited
    assert own.reason is GateReason.BEAT_THE_NULL


def test_inheritance_is_not_a_free_pass() -> None:
    """An unproven family is unproven everywhere."""
    verdict = gate(outcomes=outcomes(2, 99.0), null_pool=pool([1.0] * 50),
                   cohort_state=GateState.SHADOW)
    assert verdict.state is GateState.SHADOW
    assert verdict.inherited


def test_a_new_store_can_contradict_its_cohort() -> None:
    """Inherited LIVE, but its own outcomes say otherwise once it has them."""
    verdict = gate(
        outcomes=outcomes(MINIMUM, 0.3),
        null_pool=pool([1.0, 1.1, 0.9] * 40),
        cohort_state=GateState.LIVE,
    )
    assert verdict.state is GateState.SHADOW
    assert not verdict.inherited


def test_without_a_cohort_a_new_store_waits_in_shadow() -> None:
    verdict = gate(outcomes=outcomes(2, 99.0), null_pool=pool([1.0] * 50))
    assert verdict.state is GateState.SHADOW
    assert not verdict.inherited


# ── Only the shown arm is under test ─────────────────────────────────────────


def test_the_holdout_arm_is_the_control_not_a_worse_recommendation() -> None:
    """Scoring the holdout as if it were a recommendation would compare the
    engine against itself."""
    mixed = (outcomes(MINIMUM, 5.0, shown=True)
             + outcomes(MINIMUM, 0.1, shown=False))
    verdict = gate(outcomes=mixed, null_pool=pool([1.0] * 50),
                   current=GateState.SHADOW)
    assert verdict.n_outcomes == MINIMUM
    assert verdict.state is GateState.LIVE


def test_a_family_of_only_holdouts_has_no_evidence() -> None:
    verdict = gate(outcomes=outcomes(MINIMUM, 5.0, shown=False),
                   null_pool=pool([1.0] * 50))
    assert verdict.n_outcomes == 0
    assert verdict.state is GateState.SHADOW


# ── The serving contract ─────────────────────────────────────────────────────


def test_only_live_families_are_displayed() -> None:
    live = gate(outcomes=outcomes(MINIMUM, 5.0),
                null_pool=pool([1.0] * 50), current=GateState.SHADOW)
    shadow = gate(family="markdown", outcomes=(), null_pool={})
    suspended = gate(family="clear", outcomes=outcomes(MINIMUM, 0.2),
                     null_pool=pool([1.0, 1.1] * 50),
                     current=GateState.LIVE)

    assert displayable([live, shadow, suspended]) == {"reorder"}
    assert live.displayed
    assert not shadow.displayed
    assert not suspended.displayed


def test_every_verdict_states_a_reason() -> None:
    """"not shown" with no reason is the kind of refusal nobody can act on."""
    for verdict in (
        gate(outcomes=(), null_pool={}),
        gate(outcomes=outcomes(MINIMUM, 9.0), null_pool={}),
        gate(outcomes=outcomes(MINIMUM, 5.0), null_pool=pool([1.0] * 50)),
        gate(outcomes=outcomes(2, 5.0), null_pool=pool([1.0] * 50),
             cohort_state=GateState.LIVE),
    ):
        assert verdict.reason
        assert verdict.as_dict()["reason"]


def test_a_verdict_serialises_for_node_to_persist() -> None:
    verdict = gate(outcomes=outcomes(MINIMUM, 5.0), null_pool=pool([1.0] * 50),
                   current=GateState.SHADOW)
    payload = verdict.as_dict()
    assert payload["state"] == "live"
    assert payload["displayed"] is True
    assert payload["evidence"]["beats_null"] is True
    assert payload["evidence"]["p_value"] > 0


def test_every_threshold_is_a_provisional_registry_setting() -> None:
    for setting in (MIN_OUTCOMES, P_THRESHOLD, SUSPEND_P_THRESHOLD,
                    MATCHED_BASKETS):
        assert setting.status == "PROVISIONAL"
        assert setting.owner and setting.unit and setting.why


def test_raising_the_bar_keeps_a_marginal_family_in_shadow() -> None:
    """The thresholds actually change the outcome."""
    args = {"outcomes": outcomes(MINIMUM, 2.0),
            "null_pool": pool([0.5, 1.0, 1.5, 2.5] * 25),
            "current": GateState.SHADOW}
    strict = cfg.with_overrides("strict", {P_THRESHOLD.name: 0.0001})
    result = evaluate_gate(
        GateRequest(client_id=1, location_id=1, family="reorder", **args),
        ctx(config_version="strict"), strict,
    )
    assert result.value is not None
    assert result.value.state is GateState.SHADOW
