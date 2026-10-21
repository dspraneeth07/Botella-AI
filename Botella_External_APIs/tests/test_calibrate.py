"""Sheet 08 — calibration fitted from outcomes and applied before the decision."""

from __future__ import annotations

import random
from datetime import date

import pytest

from app.pipeline.calibrate import (
    COIN_FLIP_BRIER,
    IDENTITY,
    IDENTITY_VERSION,
    ISOTONIC,
    ApplyRequest,
    CalibrationBundle,
    FitRequest,
    MonitorRequest,
    Outcome,
    Prediction,
    apply_calibration,
    brier_score,
    calibrate_many,
    expected_calibration_error,
    fit_calibration,
    monitor_calibration,
    pool_adjacent_violators,
    rank_key,
    reliability_curve,
)
from app.pipeline.calibrate.fit import ANY, MIN_OUTCOMES_TO_FIT
from app.pipeline.calibrate.monitor import (
    ECE_SUSPEND_THRESHOLD,
    MAX_RELIABILITY_DEVIATION,
    MIN_OUTCOMES_TO_SCORE,
    RELIABILITY_BINS,
)
from app.pipeline.context import RunContext
from app.pipeline.registry import cfg

AS_OF = date(2026, 9, 23)

#: The measured miscalibration this sheet exists for: states high, hits low.
TRUE_RATE = {0.60: 0.25, 0.70: 0.28, 0.80: 0.30, 0.90: 0.34, 0.95: 0.36}


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-08", "tenant_id": 1, "store_id": 1, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"calibrate": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def overconfident(
    n: int = 400, family: str = "reorder", demand_class: str = "smooth",
    seed: str = "cal",
) -> list[Outcome]:
    """Outcomes that state ~0.8 and hit ~0.3 — the measured shape."""
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        stated = rng.choice(list(TRUE_RATE))
        out.append(Outcome(family, demand_class, stated,
                           rng.random() < TRUE_RATE[stated]))
    return out


def bundle_from(outcomes) -> CalibrationBundle:
    result = fit_calibration(FitRequest(outcomes), ctx())
    assert result.ok, result.reasons
    return result.value


# ── The headline claim ───────────────────────────────────────────────────────


def test_a_deliberately_overconfident_input_is_pulled_toward_truth() -> None:
    """The sheet's first required test.

    The backtest measured mean stated confidence 0.48 against an actual hit
    rate of 0.23 - Brier 0.255 where 0.25 is a coin flip. A number that says
    80% and is right 23% of the time is WORSE than no number, because the
    interface and the owner both treat it as meaningful.
    """
    bundle = bundle_from(overconfident())
    result = apply_calibration(
        ApplyRequest(0.90, "reorder", "smooth", bundle), ctx()
    )
    assert result.ok
    calibrated = result.value

    assert calibrated.transform == ISOTONIC
    assert calibrated.raw == 0.90
    # Pulled hard toward the true ~0.34, not nudged.
    assert calibrated.value < 0.5
    assert calibrated.value == pytest.approx(TRUE_RATE[0.90], abs=0.12)
    assert "lowered" in calibrated.explain()


def test_the_curve_is_monotone_and_never_inverts_the_ordering() -> None:
    """Isotonic asserts only that more stated confidence is not fewer hits.

    That is the one thing we are willing to claim, and it is what keeps
    calibration from scrambling the ranking into nonsense.
    """
    bundle = bundle_from(overconfident())
    values = [
        apply_calibration(ApplyRequest(s, "reorder", "smooth", bundle),
                          ctx()).value.value
        for s in (0.60, 0.70, 0.80, 0.90, 0.95)
    ]
    assert values == sorted(values), "calibration must not invert the order"


def test_calibration_compresses_confidences_the_engine_cannot_distinguish() -> None:
    """The real finding, not just a smaller number.

    Stated 0.60 and stated 0.80 map to nearly the same calibrated value
    because their observed hit rates barely differ. That is the curve saying
    the engine cannot tell those cases apart - which is more useful than any
    single rescaled figure.
    """
    bundle = bundle_from(overconfident())
    low = apply_calibration(ApplyRequest(0.60, "reorder", "smooth", bundle),
                            ctx()).value.value
    mid = apply_calibration(ApplyRequest(0.80, "reorder", "smooth", bundle),
                            ctx()).value.value
    assert abs(mid - low) < 0.1
    assert 0.20 < low < 0.45


# ── Never extrapolate ────────────────────────────────────────────────────────


def test_a_confidence_above_the_fitted_range_is_clipped_and_says_so() -> None:
    """Extrapolating continues the last segment into a region where no outcome
    was ever observed - the exact unearned claim this sheet removes, made
    most often precisely where the engine is most overconfident."""
    bundle = bundle_from(overconfident())
    fit = bundle.fit_for("reorder", "smooth")
    top = apply_calibration(ApplyRequest(fit.domain_hi, "reorder", "smooth",
                                         bundle), ctx()).value

    beyond = apply_calibration(ApplyRequest(1.0, "reorder", "smooth", bundle),
                               ctx()).value
    assert beyond.value == top.value, "clipped, not extrapolated"
    assert any("clipped_above_fitted_range" in r for r in beyond.reasons)


def test_a_confidence_below_the_fitted_range_is_clipped_and_says_so() -> None:
    bundle = bundle_from(overconfident())
    below = apply_calibration(ApplyRequest(0.0, "reorder", "smooth", bundle),
                              ctx()).value
    assert any("clipped_below_fitted_range" in r for r in below.reasons)
    assert below.value >= 0.0


# ── Too few outcomes returns identity, never a guessed curve ─────────────────


def test_too_few_outcomes_returns_identity_with_a_reason() -> None:
    """The sheet's second required test."""
    bundle = bundle_from(overconfident(n=10))
    assert bundle.fits == {}, "10 outcomes must not produce a curve"
    # N2.1: the parent and global rungs are fitted too, so a thin run
    # now records the SAME shortfall against each rung it tried.
    assert ("reorder", "smooth", ANY) in bundle.skipped

    result = apply_calibration(
        ApplyRequest(0.90, "reorder", "smooth", bundle), ctx()
    )
    calibrated = result.value
    assert calibrated.transform == IDENTITY
    assert calibrated.value == 0.90, "identity means UNCHANGED"
    assert calibrated.reasons, "an identity transform must say why"
    assert "too_few_outcomes" in calibrated.reasons[0]


def test_a_cell_where_confidence_never_varies_gets_no_curve() -> None:
    """A transform through one point is a constant, not a calibration.

    Not hypothetical: `reorder` in the live table spans 0.87 to 0.95 across
    15 rows, and a fit on that would be a horizontal line dressed as a model.
    """
    flat = [Outcome("reorder", "smooth", 0.9, i % 3 == 0) for i in range(200)]
    bundle = bundle_from(flat)
    assert bundle.fits == {}
    assert "too_few_distinct_confidences" in bundle.skipped[("reorder", "smooth", ANY)]


def test_no_bundle_at_all_is_the_normal_starting_state() -> None:
    """`recommendation_evaluations` currently holds ZERO rows."""
    calibrated = apply_calibration(
        ApplyRequest(0.90, "reorder", "smooth", None), ctx()
    ).value
    assert calibrated.transform == IDENTITY
    assert calibrated.value == 0.90
    assert calibrated.reasons == ("no_calibration_bundle",)
    assert "no calibration curve" in calibrated.explain()


def test_the_floor_comes_from_the_registry() -> None:
    outcomes = overconfident(n=60)
    assert bundle_from(outcomes).fits, "60 outcomes clears the default floor"
    strict = cfg.with_overrides("strict", {MIN_OUTCOMES_TO_FIT.name: 500})
    result = fit_calibration(FitRequest(outcomes), ctx(config_version="strict"),
                             strict)
    assert result.value.fits == {}


# ── Per family AND per demand class; pooling hides both ──────────────────────


def test_families_are_fitted_separately() -> None:
    """They make different claims and are wrong in different directions."""
    outcomes = overconfident(n=300, family="reorder", seed="a")
    # A well-calibrated family: states 0.3, hits 0.3.
    rng = random.Random("b")
    for _ in range(300):
        stated = rng.choice([0.25, 0.30, 0.35, 0.40])
        outcomes.append(Outcome("cold_box", "smooth", stated,
                                rng.random() < stated))
    bundle = bundle_from(outcomes)

    assert ("reorder", "smooth", ANY) in bundle.fits
    assert ("cold_box", "smooth", ANY) in bundle.fits

    over = apply_calibration(ApplyRequest(0.90, "reorder", "smooth", bundle),
                             ctx()).value
    honest = apply_calibration(ApplyRequest(0.35, "cold_box", "smooth", bundle),
                               ctx()).value
    # The overconfident family is pulled down hard; the honest one barely moves.
    assert over.raw - over.value > 0.4
    assert abs(honest.raw - honest.value) < 0.2


def test_demand_classes_are_fitted_separately_within_a_family() -> None:
    """A reorder on a smooth SKU and one on a lumpy SKU are not the same claim."""
    outcomes = overconfident(n=300, demand_class="smooth", seed="s")
    outcomes += overconfident(n=300, demand_class="lumpy", seed="l")
    bundle = bundle_from(outcomes)
    assert ("reorder", "smooth", ANY) in bundle.fits
    assert ("reorder", "lumpy", ANY) in bundle.fits
    assert bundle.fits[("reorder", "smooth", ANY)] is not bundle.fits[("reorder", "lumpy", ANY)]


# ── The version is auditable ─────────────────────────────────────────────────


def test_the_calibration_version_lands_in_provenance() -> None:
    """So any past card can be traced to the curve that shaped it."""
    bundle = bundle_from(overconfident())
    result = apply_calibration(
        ApplyRequest(0.90, "reorder", "smooth", bundle), ctx()
    )
    assert result.provenance.calibration_version == bundle.version
    assert result.provenance.to_dict()["calibration_version"] == bundle.version


def test_an_uncalibrated_card_is_distinguishable_from_a_pre_sheet_one() -> None:
    """Identity carries a real version, not None.

    None means "this provenance predates calibration entirely". Identity means
    "calibration ran and had nothing to apply". Collapsing them would lose the
    difference between never asking and asking and being told no.
    """
    calibrated = apply_calibration(
        ApplyRequest(0.9, "reorder", "smooth", None), ctx()
    )
    assert calibrated.provenance.calibration_version == IDENTITY_VERSION
    assert calibrated.provenance.calibration_version is not None


def test_two_fits_on_the_same_day_over_different_data_get_different_versions() -> None:
    """A version carrying only the date makes a refit indistinguishable from
    the fit it replaced."""
    a = bundle_from(overconfident(seed="one"))
    b = bundle_from(overconfident(seed="two"))
    assert a.fitted_at == b.fitted_at == AS_OF
    assert a.version != b.version
    assert a.version.startswith(AS_OF.isoformat())


def test_the_same_outcomes_always_produce_the_same_version() -> None:
    outcomes = overconfident()
    assert bundle_from(outcomes).version == bundle_from(list(reversed(outcomes))).version


# ── Ranking uses the calibrated value. End to end. ───────────────────────────


def test_ranking_receives_the_calibrated_value_not_the_raw_one() -> None:
    """The sheet's third required test, and the point of the whole sheet.

    Calibration is applied BEFORE ranking, so it shapes WHAT GETS
    RECOMMENDED rather than annotating what already was. Here a `reorder`
    states 0.90 and a `cold_box` states 0.40. On raw confidence the reorder
    wins. Calibrated, the cold_box does - because it is the one that actually
    works.
    """
    outcomes = overconfident(n=300, family="reorder", seed="r")
    rng = random.Random("c")
    for _ in range(300):
        stated = rng.choice([0.30, 0.35, 0.40, 0.45])
        # cold_box UNDER-states: says 0.4, hits 0.6.
        outcomes.append(Outcome("cold_box", "smooth", stated,
                                rng.random() < 0.6))
    bundle = bundle_from(outcomes)

    requests = [
        ApplyRequest(0.90, "reorder", "smooth", bundle),
        ApplyRequest(0.40, "cold_box", "smooth", bundle),
    ]
    calibrated = calibrate_many(requests, ctx())
    assert [c.raw for c in calibrated] == [0.90, 0.40], "order preserved"

    by_raw = sorted(calibrated, key=lambda c: c.raw, reverse=True)
    by_calibrated = sorted(calibrated, key=rank_key, reverse=True)

    assert by_raw[0].family == "reorder", "raw ranking puts the loud one first"
    assert by_calibrated[0].family == "cold_box", (
        "calibrated ranking puts the one that actually works first - this is "
        "the decision changing, which is the only outcome worth the work"
    )


def test_calibrate_many_preserves_order_so_ranking_is_not_silently_permuted() -> None:
    bundle = bundle_from(overconfident())
    requests = [
        ApplyRequest(v, "reorder", "smooth", bundle)
        for v in (0.95, 0.60, 0.90, 0.70)
    ]
    assert [c.raw for c in calibrate_many(requests, ctx())] == [0.95, 0.60, 0.90, 0.70]


# ── Pool Adjacent Violators ──────────────────────────────────────────────────


def test_pava_leaves_an_already_monotone_series_alone() -> None:
    points = [(0.1, 0.1, 1.0), (0.2, 0.2, 1.0), (0.3, 0.9, 1.0)]
    assert [y for _, y in pool_adjacent_violators(points)] == [0.1, 0.2, 0.9]


def test_pava_pools_a_violation_into_the_weighted_mean() -> None:
    # 0.9 then 0.1 violates monotonicity; both become 0.5.
    points = [(0.1, 0.9, 1.0), (0.2, 0.1, 1.0)]
    assert [y for _, y in pool_adjacent_violators(points)] == [pytest.approx(0.5)]


def test_pava_output_is_always_non_decreasing() -> None:
    rng = random.Random("pava")
    for _ in range(50):
        points = [(i / 20, rng.random(), 1.0) for i in range(20)]
        ys = [y for _, y in pool_adjacent_violators(points)]
        assert ys == sorted(ys)


def test_pava_respects_weights() -> None:
    """A heavily-weighted observation should dominate the pooled mean."""
    points = [(0.1, 1.0, 9.0), (0.2, 0.0, 1.0)]
    pooled = pool_adjacent_violators(points)[0][1]
    assert pooled == pytest.approx(0.9)


# ── Monitor ──────────────────────────────────────────────────────────────────


def preds(n: int, stated: float, true_rate: float, family: str = "reorder",
          seed: str = "m") -> list[Prediction]:
    rng = random.Random(seed)
    return [Prediction(family, stated, rng.random() < true_rate) for _ in range(n)]


def test_brier_of_a_coin_flip_is_the_reference_line() -> None:
    flips = [Prediction("x", 0.5, i % 2 == 0) for i in range(100)]
    assert brier_score(flips) == pytest.approx(COIN_FLIP_BRIER)
    assert brier_score([]) is None


def test_a_perfect_forecast_scores_zero_and_a_confident_wrong_one_scores_one() -> None:
    assert brier_score([Prediction("x", 1.0, True)]) == pytest.approx(0.0)
    assert brier_score([Prediction("x", 1.0, False)]) == pytest.approx(1.0)


def test_ece_is_weighted_by_how_many_landed_in_each_bin() -> None:
    """A bin holding two recommendations being 40 points out matters far less
    than a bin holding two hundred being 10 points out."""
    many = [Prediction("x", 0.9, False) for _ in range(198)]
    few = [Prediction("x", 0.1, True) for _ in range(2)]
    curve = reliability_curve(many + few, 10)
    ece = expected_calibration_error(curve, len(many) + len(few))
    # Dominated by the 198 that stated 0.9 and never hit.
    assert ece == pytest.approx(0.9 * 0.99 + 0.9 * 0.01, abs=0.05)


def test_the_reliability_curve_keeps_empty_bins() -> None:
    """Dropping them would make a family that only ever states 0.9 look like
    it covers the whole range - which is the shape `reorder` has."""
    curve = reliability_curve(preds(50, 0.9, 0.3), 10)
    assert len(curve) == 10
    populated = [b for b in curve if b.count]
    assert len(populated) == 1
    assert all(b.mean_stated is None for b in curve if not b.count)


def test_a_drifted_family_is_suspended_and_a_refit_requested() -> None:
    """Suspension is a NORMAL state, not an incident."""
    drifted = preds(200, 0.9, 0.2, family="reorder")
    report = monitor_calibration(MonitorRequest(drifted), ctx()).value
    score = report.by_family["reorder"]
    assert score.suspended is True
    assert score.ece > cfg.get(ECE_SUSPEND_THRESHOLD, ctx())
    assert report.suspended_families == ("reorder",)
    assert report.refit_requested is True
    assert "SUSPENDED" in report.summary()


def test_a_well_calibrated_family_is_not_suspended() -> None:
    honest = preds(200, 0.3, 0.3, family="cold_box", seed="h")
    report = monitor_calibration(MonitorRequest(honest), ctx()).value
    assert report.by_family["cold_box"].suspended is False
    assert report.suspended_families == ()
    assert report.refit_requested is False


def test_too_few_outcomes_is_unscored_and_unscored_is_not_a_pass() -> None:
    report = monitor_calibration(MonitorRequest(preds(5, 0.9, 0.2)), ctx()).value
    score = report.by_family["reorder"]
    assert score.suspended is None, "None is not False"
    assert score.brier is None, "never a Brier over five outcomes"
    assert "too_few_outcomes" in score.reason
    assert report.unscored_families == ("reorder",)
    assert report.suspended_families == ()


def test_a_suspended_family_falls_back_to_identity_at_apply_time() -> None:
    """The monitor's verdict actually reaches the online path."""
    bundle = bundle_from(overconfident())
    assert bundle.fit_for("reorder", "smooth") is not None

    calibrated = apply_calibration(
        ApplyRequest(0.90, "reorder", "smooth", bundle,
                     suspended_families=("reorder",)),
        ctx(),
    ).value
    assert calibrated.transform == IDENTITY
    assert calibrated.value == 0.90
    assert calibrated.reasons == ("family_suspended:reorder",)


def test_the_monitor_thresholds_come_from_the_registry() -> None:
    assert ECE_SUSPEND_THRESHOLD.default == 0.15
    assert RELIABILITY_BINS.default == 10
    assert MIN_OUTCOMES_TO_SCORE.default == 30
    # N2.2 added a SECOND, independent rule - the per-bin gap - so a lenient
    # ECE alone no longer clears a family. Both have to be relaxed for this test
    # to still be asking its original question, which was "do the thresholds
    # come from the registry rather than from the code".
    lenient = cfg.with_overrides("lenient", {
        ECE_SUSPEND_THRESHOLD.name: 0.95,
        MAX_RELIABILITY_DEVIATION.name: 0.95,
    })
    report = monitor_calibration(
        MonitorRequest(preds(200, 0.9, 0.2)), ctx(config_version="lenient"),
        lenient,
    ).value
    assert report.by_family["reorder"].suspended is False
    # And the deviation is still REPORTED even when it is tolerated, because a
    # suspension without its number is a decision nobody can check.
    assert report.by_family["reorder"].worst_bin_deviation > 0.6


def test_the_per_bin_rule_suspends_independently_of_ece() -> None:
    """A curve can be respectable on average and badly wrong in one bin. The two
    rules catch different failures and neither subsumes the other."""
    # ECE tolerated, bin rule at its default: stated 0.9, observed 0.2.
    only_ece_lenient = cfg.with_overrides(
        "ece_only", {ECE_SUSPEND_THRESHOLD.name: 0.95})
    report = monitor_calibration(
        MonitorRequest(preds(200, 0.9, 0.2)), ctx(config_version="ece_only"),
        only_ece_lenient,
    ).value
    score = report.by_family["reorder"]
    assert score.suspended is True
    assert "bin_deviation" in (score.reason or "")
    assert score.worst_bin is not None


# ── End to end, through the real ranking path ────────────────────────────────


def test_the_validators_caps_rank_on_the_calibrated_value() -> None:
    """The sheet's "verified end to end", against the actual call site.

    `validate_recommendations` caps cold_box and endcap by confidence, and
    those caps decide what an owner sees. `_rank_confidence` is what they
    sort on, and it must read the calibrated value.
    """
    from app.recommender.validator import _apply_calibration, _rank_confidence

    loud = {"action_type": "reorder", "confidence": 0.90, "primary_skus": ["A"]}
    quiet = {"action_type": "cold_box", "confidence": 0.40, "primary_skus": ["B"]}

    # Before calibration the loud one ranks first.
    assert _rank_confidence(loud) > _rank_confidence(quiet)

    outcomes = overconfident(n=300, family="reorder", seed="v")
    rng = random.Random("w")
    for _ in range(300):
        stated = rng.choice([0.30, 0.35, 0.40, 0.45])
        outcomes.append(Outcome("cold_box", "smooth", stated, rng.random() < 0.6))
    bundle = bundle_from(outcomes)

    _apply_calibration([loud, quiet], bundle,
                       {"A": "smooth", "B": "smooth"}, ())

    assert _rank_confidence(quiet) > _rank_confidence(loud), (
        "after calibration the one that actually works ranks first"
    )
    assert loud["calibrated_confidence"] < loud["confidence"]
    assert loud["calibration_version"] == bundle.version


def test_the_validator_stamps_a_reason_when_it_cannot_calibrate() -> None:
    """Today's real state: no bundle, so identity, and every rec says why."""
    from app.recommender.validator import _apply_calibration, _rank_confidence

    recs = [{"action_type": "reorder", "confidence": 0.9, "primary_skus": ["A"]}]
    _apply_calibration(recs, None, None, ())
    rec = recs[0]
    assert rec["calibrated_confidence"] == 0.9, "identity means unchanged"
    assert rec["calibration_version"] == IDENTITY_VERSION
    assert rec["calibration_reasons"] == ["no_calibration_bundle"]
    assert _rank_confidence(rec) == 0.9


def test_a_rec_with_no_confidence_is_left_alone_rather_than_defaulted() -> None:
    """A missing confidence is not a zero confidence.

    Stamping 0.0 would silently sink the rec to the bottom of every cap - a
    decision made by a plumbing default rather than by evidence.
    """
    from app.recommender.validator import _apply_calibration

    recs = [{"action_type": "reorder", "primary_skus": ["A"]}]
    _apply_calibration(recs, None, None, ())
    assert "calibrated_confidence" not in recs[0]


def test_calibration_survives_a_rec_with_no_skus() -> None:
    """Some families (cold_box) are store-level and carry no primary_skus."""
    from app.recommender.validator import UNKNOWN_DEMAND_CLASS, _apply_calibration

    recs = [{"action_type": "cold_box", "confidence": 0.8, "primary_skus": []}]
    _apply_calibration(recs, None, None, ())
    assert recs[0]["calibrated_confidence"] == 0.8
    assert UNKNOWN_DEMAND_CLASS == "unknown"


def test_the_identity_path_costs_nothing_in_the_ranking_it_shipped_with() -> None:
    """Shipping the plumbing early must not change today's output.

    With no bundle, every calibrated value equals its raw value, so the caps
    rank exactly as they did before sheet 08. That is what makes it safe to
    ship the path before the curve exists.
    """
    from app.recommender.validator import _apply_calibration, _rank_confidence

    recs = [
        {"action_type": "endcap", "confidence": c, "primary_skus": [f"S{i}"]}
        for i, c in enumerate((0.31, 0.92, 0.55, 0.74))
    ]
    before = sorted(recs, key=lambda r: r["confidence"], reverse=True)
    _apply_calibration(recs, None, None, ())
    after = sorted(recs, key=_rank_confidence, reverse=True)
    assert [r["confidence"] for r in before] == [r["confidence"] for r in after]
