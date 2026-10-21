"""Tests for the feedback scoring: lift computation, the lift+thumbs blend,
and the winner/loser thresholds."""

from __future__ import annotations

from datetime import date

from app.schemas.feedback import FeedbackParams, PastRecommendation
from app.store_data.feedback import compute_feedback, score_recommendation
from tests.conftest import sale

DATA_AS_OF = date(2026, 6, 3)


def _rec(
    rec_days_ago: int,
    skus: list[str],
    category: str = "weather",
    confidence: float | None = None,
    thumbs_up: int = 0,
    thumbs_down: int = 0,
) -> PastRecommendation:
    return PastRecommendation(
        rec_date=date.fromordinal(DATA_AS_OF.toordinal() - rec_days_ago),
        category=category,
        primary_skus=skus,
        confidence=confidence,
        thumbs_up=thumbs_up,
        thumbs_down=thumbs_down,
    )


def test_no_history_returns_none() -> None:
    assert compute_feedback([], [sale("A", 1, 5)], data_as_of=DATA_AS_OF) is None


def test_lift_doubles_when_post_rate_doubles() -> None:
    # Baseline: 1 unit/day for the 21 days before the rec (days_ago 11..31).
    # Post: 2 units/day for the 7 days after (days_ago 4..10).
    rec = _rec(11, ["A"])
    sales = [sale("A", d, 1) for d in range(12, 33)] + [sale("A", d, 2) for d in range(4, 11)]
    digest = compute_feedback([rec], sales, data_as_of=DATA_AS_OF)
    assert digest is not None
    assert digest.measured_recs == 1
    assert digest.overall_lift is not None and 1.8 <= digest.overall_lift <= 2.2
    assert digest.categories[0].category == "weather"


def test_recent_rec_with_open_post_window_is_excluded() -> None:
    # Rec 3 days ago: its 7-day post window hasn't closed by data_as_of.
    rec = _rec(3, ["A"])
    sales = [sale("A", d, 1) for d in range(1, 30)]
    assert compute_feedback([rec], sales, data_as_of=DATA_AS_OF) is None


def test_recent_rec_with_votes_is_still_scored() -> None:
    # Lift isn't measurable yet, but a thumbs vote is a usable component.
    rec = _rec(3, ["A"], thumbs_up=1)
    digest = compute_feedback([rec], [], data_as_of=DATA_AS_OF)
    assert digest is not None
    assert digest.measured_recs == 1
    assert digest.overall_lift is None  # no closed lift window
    assert digest.winner_skus == ["A"]  # pure-thumbs score 1.0 clears the threshold


def test_sku_with_no_baseline_is_skipped() -> None:
    # All sales are AFTER the rec — no baseline, so lift is unmeasurable.
    rec = _rec(11, ["NEW"])
    sales = [sale("NEW", d, 3) for d in range(4, 11)]
    assert compute_feedback([rec], sales, data_as_of=DATA_AS_OF) is None


def test_score_blend_math() -> None:
    params = FeedbackParams()  # 0.6 lift / 0.4 user
    # Lift only: 1.0x -> squashed 0.5 (neutral).
    assert score_recommendation(1.0, None, params) == 0.5
    # Thumbs only: unanimous up -> 1.0.
    assert score_recommendation(None, 1.0, params) == 1.0
    # Blend: lift 1.5 (0.6) + thumbs down (0.0) -> 0.6*0.6 + 0.4*0 = 0.36.
    assert score_recommendation(1.5, 0.0, params) == 0.36
    # Nothing measurable.
    assert score_recommendation(None, None, params) is None


def test_thumbs_down_demotes_recs() -> None:
    # Moderate lift (~1.35x) + thumbs down -> below the loser threshold.
    sales_mod = [sale("A", d, 1) for d in range(12, 33)] + [
        sale("A", 4, 9)  # 9 units in the post window vs ~6.7 expected
    ]
    digest = compute_feedback(
        [_rec(11, ["A"], thumbs_down=1)], sales_mod, data_as_of=DATA_AS_OF
    )
    assert digest is not None
    assert digest.loser_skus == ["A"]

    # Strong lift (~2.1x) + thumbs down = conflicting evidence -> lands in the
    # neutral middle: neither boosted as proven nor put on the avoid-list.
    sales_strong = [sale("B", d, 1) for d in range(12, 33)] + [
        sale("B", d, 2) for d in range(4, 11)
    ]
    digest2 = compute_feedback(
        [_rec(11, ["B"], thumbs_down=1)], sales_strong, data_as_of=DATA_AS_OF
    )
    assert digest2 is not None
    assert digest2.winner_skus == [] and digest2.loser_skus == []


def test_winner_skus_feed_threshold() -> None:
    # Lift ~2.1 alone -> score ~0.68 >= 0.6 -> winner.
    sales = [sale("A", d, 1) for d in range(12, 33)] + [sale("A", d, 2) for d in range(4, 11)]
    digest = compute_feedback([_rec(11, ["A"])], sales, data_as_of=DATA_AS_OF)
    assert digest is not None
    assert digest.winner_skus == ["A"]
    assert digest.loser_skus == []


def test_confidence_split_populates() -> None:
    sales = (
        [sale("A", d, 1) for d in range(12, 33)]
        + [sale("A", d, 2) for d in range(4, 11)]
        + [sale("B", d, 1) for d in range(12, 33)]
        + [sale("B", d, 1) for d in range(4, 11)]
    )
    history = [
        _rec(11, ["A"], category="weather", confidence=0.9),
        _rec(11, ["B"], category="news", confidence=0.5),
    ]
    digest = compute_feedback(history, sales, data_as_of=DATA_AS_OF)
    assert digest is not None
    assert digest.measured_recs == 2
    assert digest.high_confidence_lift is not None and digest.high_confidence_lift > 1.5
    assert digest.low_confidence_lift is not None and digest.low_confidence_lift <= 1.2


# ----- prioritize_history: bounded, voted-first selection -------------------

from app.store_data.feedback import prioritize_history  # noqa: E402


def test_prioritize_under_limit_passthrough() -> None:
    recs = [_rec(1, ["A"]), _rec(2, ["B"])]
    assert prioritize_history(recs, 20) == recs


def test_prioritize_none_limit_passthrough() -> None:
    recs = [_rec(i, ["A"]) for i in range(50)]
    assert prioritize_history(recs, None) == recs  # no cap -> unchanged


def test_prioritize_keeps_voted_first() -> None:
    # 3 unvoted (recent) + 2 voted (older). limit=2 must keep the 2 voted ones.
    unvoted = [_rec(0, ["U1"]), _rec(1, ["U2"]), _rec(2, ["U3"])]
    voted = [_rec(10, ["V1"], thumbs_up=1), _rec(11, ["V2"], thumbs_down=1)]
    kept = prioritize_history(unvoted + voted, 2)
    assert {r.primary_skus[0] for r in kept} == {"V1", "V2"}


def test_prioritize_fills_with_recent_unvoted() -> None:
    # 1 voted + several unvoted; limit=3 -> the vote plus the 2 most-recent unvoted.
    voted = [_rec(9, ["V"], thumbs_up=2)]
    unvoted = [_rec(0, ["U0"]), _rec(1, ["U1"]), _rec(5, ["U5"])]
    kept = prioritize_history(voted + unvoted, 3)
    skus = {r.primary_skus[0] for r in kept}
    assert "V" in skus  # the vote is never dropped
    assert skus == {"V", "U0", "U1"}  # then the 2 newest unvoted (days 0, 1)


def test_prioritize_no_votes_takes_most_recent() -> None:
    recs = [_rec(d, [f"D{d}"]) for d in (8, 3, 0, 5, 1)]
    kept = prioritize_history(recs, 2)
    assert {r.primary_skus[0] for r in kept} == {"D0", "D1"}  # newest two


def test_prioritize_voted_exceeding_limit_keeps_recent_voted() -> None:
    voted = [_rec(d, [f"V{d}"], thumbs_up=1) for d in (12, 2, 7)]
    kept = prioritize_history(voted, 2)
    assert {r.primary_skus[0] for r in kept} == {"V2", "V7"}  # 2 most-recent voted


def test_node_evaluated_score_supersedes_local_blend() -> None:
    # A rec Node has already measured: its evaluated_score wins outright, so
    # the same thumbs votes are never double-counted.
    rec = _rec(20, ["S1"], thumbs_up=1)
    rec = rec.model_copy(update={"evaluated_score": 0.35})
    digest = compute_feedback([rec], [], data_as_of=DATA_AS_OF)
    assert digest is not None
    assert digest.overall_score == 0.35
    # 0.35 <= loser threshold (0.4) -> the sku lands on the avoid-list even
    # though the local blend (vote-only, 1.0) would have called it a winner.
    assert "S1" in digest.loser_skus


def test_unevaluated_rec_still_uses_local_blend() -> None:
    rec = _rec(20, ["S2"], thumbs_up=1)
    assert rec.evaluated_score is None
    digest = compute_feedback([rec], [], data_as_of=DATA_AS_OF)
    assert digest is not None
    assert digest.overall_score == 1.0  # pure vote, no sales data


# ── Sheet 19: the SHARED lift definition, and what changed ───────────────────


def test_lift_is_pooled_not_a_mean_of_per_sku_ratios() -> None:
    """This module used to compute its own lift and disagree with Node by 1.37x.

        here    21-day baseline, fixed 7-day window, MEAN of per-SKU ratios
        Node    28-day baseline, covered span, POOLED sum/sum

    A recommendation covering a busy SKU and a quiet one is mostly about the
    busy one. The mean of ratios let the quiet SKU - whose ratio swings on a
    single basket - carry half the answer.
    """
    from app.store_data.feedback import _rec_lift

    rec = _rec(11, ["BUSY", "QUIET"])
    daily: dict[str, dict[date, int]] = {"BUSY": {}, "QUIET": {}}
    for d in range(12, 33):          # 21 baseline days
        daily["BUSY"][date.fromordinal(DATA_AS_OF.toordinal() - d)] = 10
        daily["QUIET"][date.fromordinal(DATA_AS_OF.toordinal() - d)] = 0
    # One quiet-SKU basket lands in the window; BUSY sells at its normal rate.
    for d in range(4, 11):           # 7 post days
        daily["BUSY"][date.fromordinal(DATA_AS_OF.toordinal() - d)] = 10
    daily["QUIET"][date.fromordinal(DATA_AS_OF.toordinal() - 5)] = 3
    daily["QUIET"][date.fromordinal(DATA_AS_OF.toordinal() - 20)] = 1

    lift = _rec_lift(rec, daily)
    assert lift is not None
    # BUSY is flat at 1.0x and dominates. The mean of ratios would be dragged
    # far above 1 by QUIET's 3-units-on-a-baseline-of-1.
    assert lift < 1.5, (
        f"lift {lift} - a single quiet-SKU basket must not carry the answer"
    )


def test_a_zero_baseline_sku_no_longer_silently_vanishes() -> None:
    """It used to be `continue`d past. It is still out of the numerator, but
    its sales are now counted as upside rather than discarded."""
    from app.pipeline.outcomes import SkuOutcome, lift_for

    result = lift_for(
        [SkuOutcome("HAS", 20, 25), SkuOutcome("NEW", 0, 9)],
        baseline_open_days=21, window_open_days=7,
    )
    assert result.upside_units == 9
    assert result.baselined_skus == 1 and result.upside_skus == 1


def test_a_uniform_closing_pattern_cancels_out() -> None:
    """Worth pinning, because it is why the bug survived so long.

    When BOTH windows have the same open fraction, dividing by calendar days
    understates the rate and the window equally, and the ratio is unchanged:
    21/21 x 7 and 21/18 x 6 are both 7. A store that simply closes every Sunday
    gets the right lift either way, which is exactly why nobody noticed the
    denominator.
    """
    from app.store_data.feedback import OpenDayCalendar, _rec_lift

    rec = _rec(11, ["A"])
    daily: dict[str, dict[date, int]] = {"A": {}}
    for d in range(12, 33):
        daily["A"][date.fromordinal(DATA_AS_OF.toordinal() - d)] = 1
    for d in range(4, 11):
        daily["A"][date.fromordinal(DATA_AS_OF.toordinal() - d)] = 2

    all_days = {
        date.fromordinal(DATA_AS_OF.toordinal() - d) for d in range(0, 40)
    }
    every_sunday_shut = frozenset(d for d in all_days if d.weekday() != 6)

    assert _rec_lift(rec, daily) == _rec_lift(
        rec, daily, OpenDayCalendar(every_sunday_shut)
    )


def test_an_UNEVEN_closing_pattern_does_not_cancel_and_that_is_the_bug() -> None:
    """The case that bites: the two windows have DIFFERENT open fractions.

    A holiday shutdown falling inside the measurement window but not the
    baseline. Calendar days then project a full window's worth of expected
    sales onto a window the store was mostly shut for, and the recommendation
    is marked a failure for days it could not have sold on.
    """
    from app.store_data.feedback import OpenDayCalendar, _rec_lift

    rec = _rec(11, ["A"])
    daily: dict[str, dict[date, int]] = {"A": {}}
    for d in range(12, 33):
        daily["A"][date.fromordinal(DATA_AS_OF.toordinal() - d)] = 1
    for d in range(4, 11):
        daily["A"][date.fromordinal(DATA_AS_OF.toordinal() - d)] = 1

    all_days = {
        date.fromordinal(DATA_AS_OF.toordinal() - d) for d in range(0, 40)
    }
    # Open throughout the baseline; shut for three days of the post window.
    shutdown = {date.fromordinal(DATA_AS_OF.toordinal() - d) for d in (5, 6, 7)}
    uneven = frozenset(all_days - shutdown)

    calendar_lift = _rec_lift(rec, daily)
    open_lift = _rec_lift(rec, daily, OpenDayCalendar(uneven))

    assert calendar_lift is not None and open_lift is not None
    assert open_lift > calendar_lift, (
        f"calendar={calendar_lift} open={open_lift} - counting the shut days "
        f"as sellable marks the recommendation down for them"
    )


def test_a_store_shut_throughout_the_window_is_unmeasurable() -> None:
    """Not a lift of zero - "we could not tell" is not "it did nothing"."""
    from app.store_data.feedback import OpenDayCalendar, _rec_lift

    rec = _rec(11, ["A"])
    daily: dict[str, dict[date, int]] = {"A": {}}
    for d in range(12, 33):
        daily["A"][date.fromordinal(DATA_AS_OF.toordinal() - d)] = 1

    assert _rec_lift(rec, daily, OpenDayCalendar(frozenset())) is None


def test_the_score_component_is_deliberately_uncapped_here() -> None:
    """The shared `score_from_lift` CAPS at 5x before squashing, which is right
    for the gate's mean - one 40x row must not decide a store's verdict - and
    wrong here, where the score is per recommendation and a genuine 40x is the
    strongest signal available. Same shape, different job."""
    from app.pipeline.outcomes import score_from_lift
    from app.store_data.feedback import _lift_component

    assert _lift_component(40.0) > _lift_component(5.0)
    assert score_from_lift(40.0) == score_from_lift(5.0)
