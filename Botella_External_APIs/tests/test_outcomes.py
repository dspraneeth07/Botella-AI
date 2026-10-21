"""Sheet 19 — THE definition of lift. The one both languages use."""

from __future__ import annotations

import pytest

from app.pipeline.outcomes import (
    DEFAULT_LIFT_CAP,
    LIFT_CAP,
    SkuOutcome,
    lift_for,
    score_from_lift,
)


def sku(name: str, baseline: float, actual: float) -> SkuOutcome:
    return SkuOutcome(sku=name, baseline_units=baseline, actual_units=actual)


# ── Open days, never calendar days ───────────────────────────────────────────


def test_open_days_are_used_in_both_windows() -> None:
    """A 28-calendar-day window at Bethany holds 23 open days, so a rate
    divided by 28 is understated by 21.7%. Stores 101-103 are worse at 27.3%.
    """
    open_days = lift_for([sku("A", 230, 60)], baseline_open_days=23,
                         window_open_days=6)
    calendar = lift_for([sku("A", 230, 60)], baseline_open_days=28,
                        window_open_days=7)
    assert open_days.lift != calendar.lift, "open days must change the answer"
    # 230 over 23 open days is 10/day; 6 open days expects 60; lift 1.0.
    assert open_days.lift == pytest.approx(1.0)


def test_a_closed_baseline_window_is_unmeasurable_not_infinite() -> None:
    result = lift_for([sku("A", 50, 10)], baseline_open_days=0,
                      window_open_days=6)
    assert result.lift is None
    assert not result.measurable
    assert "closed or unsynced" in (result.reason or "")


def test_a_closed_measurement_window_is_unmeasurable() -> None:
    result = lift_for([sku("A", 50, 0)], baseline_open_days=23,
                      window_open_days=0)
    assert result.lift is None
    assert "nothing could have sold" in (result.reason or "")


# ── A pooled ratio, not a mean of ratios ─────────────────────────────────────


def test_the_ratio_is_pooled_so_a_quiet_sku_cannot_carry_the_answer() -> None:
    """The difference that made the two implementations disagree by 1.37x.

    A recommendation covering a 100-unit SKU and a 1-unit SKU is mostly about
    the 100-unit one. The mean of ratios lets the quiet SKU - whose ratio
    swings wildly on a single basket - carry half the answer.
    """
    skus = [sku("BUSY", 100, 110), sku("QUIET", 1, 3)]
    pooled = lift_for(skus, baseline_open_days=28, window_open_days=7)

    mean_of_ratios = sum(
        s.actual_units / ((s.baseline_units / 28) * 7) for s in skus
    ) / len(skus)

    assert pooled.lift is not None
    assert abs(pooled.lift - mean_of_ratios) > 0.5, (
        "the two statistics must be visibly different - that is the point"
    )
    # The pooled answer is dominated by the SKU that actually moves volume.
    assert pooled.lift < mean_of_ratios


# ── A zero baseline is not a zero denominator ────────────────────────────────


def test_a_zero_baseline_sku_is_upside_not_a_numerator() -> None:
    result = lift_for([sku("HAS", 20, 25), sku("NEW", 0, 9)],
                      baseline_open_days=23, window_open_days=6)
    assert result.upside_units == 9
    assert result.actual == 25, "the new SKU's sales stay out of the numerator"
    assert result.baselined_skus == 1
    assert result.upside_skus == 1
    assert result.measurable


def test_all_new_skus_is_unmeasurable_with_a_reason() -> None:
    result = lift_for([sku("NEW", 0, 12)], baseline_open_days=23,
                      window_open_days=6)
    assert result.lift is None
    assert not result.measurable
    assert "trailing baseline" in (result.reason or "")
    assert result.upside_units == 12, "the sales are real and are reported"


def test_no_skus_at_all_is_unmeasurable() -> None:
    result = lift_for([], baseline_open_days=23, window_open_days=6)
    assert result.lift is None
    assert result.reason


# ── None means unmeasurable, never "no effect" ───────────────────────────────


def test_every_unmeasurable_result_states_why() -> None:
    """"unmeasurable" with no reason is a refusal nobody can act on."""
    for args in (
        ([sku("A", 50, 10)], 0, 6),
        ([sku("A", 50, 0)], 23, 0),
        ([sku("NEW", 0, 5)], 23, 6),
        ([], 23, 6),
    ):
        result = lift_for(args[0], baseline_open_days=args[1],
                          window_open_days=args[2])
        assert result.lift is None
        assert result.reason, args


def test_unmeasurable_is_never_reported_as_one() -> None:
    """A caller reading None as 1.0 turns "we could not tell" into "it did
    nothing" - the same class of error as reading a missing count as zero."""
    result = lift_for([sku("NEW", 0, 5)], baseline_open_days=23,
                      window_open_days=6)
    assert result.lift is not 1.0  # noqa: F632 - identity is the point
    assert result.lift is None


# ── The score agrees with the lift it came from ──────────────────────────────


def test_neutral_lift_squashes_to_the_midpoint() -> None:
    assert score_from_lift(1.0) == 0.5


def test_the_score_is_capped_so_one_row_cannot_decide_a_verdict() -> None:
    """A lift of 40x is a data error or a one-off case buy."""
    assert score_from_lift(40.0) == score_from_lift(DEFAULT_LIFT_CAP)


def test_an_unmeasurable_lift_has_no_score() -> None:
    assert score_from_lift(None) is None


def test_the_cap_is_a_provisional_registry_setting() -> None:
    assert LIFT_CAP.status == "PROVISIONAL"
    assert LIFT_CAP.owner and LIFT_CAP.unit and LIFT_CAP.why
    assert DEFAULT_LIFT_CAP == LIFT_CAP.default


def test_the_raw_lift_is_never_capped_only_the_score() -> None:
    """Nothing is lost, so the cap can be refitted from history later."""
    result = lift_for([sku("A", 1, 100)], baseline_open_days=1,
                      window_open_days=1)
    assert result.lift == 100.0
    assert score_from_lift(result.lift) == score_from_lift(DEFAULT_LIFT_CAP)


# ── Rounding, so the two languages agree to the last digit ───────────────────


def test_results_round_to_two_decimals() -> None:
    result = lift_for([sku("A", 7, 3)], baseline_open_days=23,
                      window_open_days=6)
    assert result.lift == round(result.lift, 2)
    assert result.expected == round(result.expected, 2)


def test_a_result_serialises_for_the_node_side() -> None:
    payload = lift_for([sku("A", 100, 130)], baseline_open_days=23,
                       window_open_days=6).as_dict()
    assert set(payload) == {
        "lift", "expected", "actual", "upside_units", "baselined_skus",
        "upside_skus", "measurable", "reason",
    }
