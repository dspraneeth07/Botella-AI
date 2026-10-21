"""N2.1 / N2.2 — the velocity band, the fallback chain, and the per-bin rule.

Measured on the March ledger before any of this was built: p_hit states 0.533
pooled and delivers 0.689, and 569 of 610 cards sit in ONE bin (0.5-0.6). So the
stated confidence is not merely miscalibrated in level, it barely discriminates -
which is why the fallback chain matters more than the leaf cell, and why the
per-bin rule currently fires on every populated bin.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.pipeline.calibrate.apply import ApplyRequest, apply_calibration
from app.pipeline.calibrate.fit import (
    ANY,
    MIN_OUTCOMES_TO_FIT,
    FitRequest,
    Outcome,
    fit_calibration,
    pool_adjacent_violators,
)
from app.pipeline.calibrate.monitor import (
    MAX_RELIABILITY_DEVIATION,
    MonitorRequest,
    Prediction,
    monitor_calibration,
)
from app.pipeline.context import RunContext
from app.pipeline.registry import cfg

AS_OF = date(2026, 3, 2)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-n2", "tenant_id": 1, "store_id": 171, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"calibrate_fit": "1.0.0"},
    }
    return RunContext(**{**base, **over})


#: The fitter requires MIN_DISTINCT_CONFIDENCES (4) distinct stated values in a
#: cell before it will fit one - a cell where every card stated 0.9 has no curve
#: to find. So every fixture here spreads across four levels.
LEVELS = (0.50, 0.60, 0.70, 0.80)


def outcomes(n: int, *, family="reorder", demand_class="smooth", band=ANY,
             rate=0.70, slope=0.0) -> list[Outcome]:
    """n outcomes across four distinct stated confidences.

    `rate` is the observed hit rate at the lowest level; `slope` moves it per
    level, so slope=0 gives a flat curve and a negative slope gives a
    deliberately NON-monotone one.
    """
    out: list[Outcome] = []
    per = max(1, n // len(LEVELS))
    for j, stated in enumerate(LEVELS):
        r = min(1.0, max(0.0, rate + slope * j))
        for i in range(per):
            out.append(Outcome(
                family=family, demand_class=demand_class,
                stated_confidence=stated, hit=(i / per) < r,
                velocity_band=band,
            ))
    return out


# ── N2.1 ────────────────────────────────────────────────────────────────────


def test_isotonic_is_monotone() -> None:
    """A calibration curve that fell anywhere would say a higher stated
    confidence can mean a lower real one, which is not a calibration."""
    pts = [(0.1, 1.0, 1.0), (0.2, 0.0, 1.0), (0.3, 1.0, 1.0),
           (0.4, 0.0, 1.0), (0.5, 1.0, 1.0), (0.6, 1.0, 1.0)]
    knots = pool_adjacent_violators(pts)
    ys = [y for _, y in knots]
    assert ys == sorted(ys), f"not non-decreasing: {ys}"

    # And end to end, through a real fit on deliberately non-monotone data.
    # A deliberately DECREASING observed rate as stated confidence rises.
    o = outcomes(200, band="slow", rate=0.9, slope=-0.25)
    bundle = fit_calibration(FitRequest(o), ctx()).value
    fit = bundle.fit_for("reorder", "smooth", "slow")
    assert fit is not None
    assert list(fit.ys) == sorted(fit.ys), f"not non-decreasing: {fit.ys}"
    lo, _ = fit.predict(0.50)
    hi, _ = fit.predict(0.80)
    assert hi >= lo, "a higher stated confidence must never calibrate lower"


def test_velocity_band_separates_slow_and_fast_skus() -> None:
    """A 1-unit-a-month SKU and a 40-unit-a-month SKU do not share a reliability
    curve: the slow one's outcome is mostly Poisson noise. Pooling them fits a
    curve to neither."""
    o = (outcomes(200, band="slow", rate=0.20)
         + outcomes(200, band="fast", rate=0.90))
    bundle = fit_calibration(FitRequest(o), ctx()).value

    slow = bundle.fit_for("reorder", "smooth", "slow")
    fast = bundle.fit_for("reorder", "smooth", "fast")
    assert slow is not None and fast is not None
    assert slow is not fast, "the bands must not resolve to the same curve"

    slow_v, _ = slow.predict(0.60)
    fast_v, _ = fast.predict(0.60)
    assert fast_v > slow_v + 0.3, (
        "the same stated 0.6 must calibrate differently per band, or the band "
        "is in the key and doing nothing"
    )
    # And the pooled parent sits between them - which is exactly why using it
    # for either band would be wrong.
    parent = bundle.fit_for("reorder", "smooth", ANY)
    assert parent is not None
    parent_v, _ = parent.predict(0.60)
    assert slow_v < parent_v < fast_v


def test_cell_falls_back_to_parent_below_minimum() -> None:
    """A thin leaf borrows its parent's curve rather than giving up."""
    c = ctx()
    minimum = int(cfg.get(MIN_OUTCOMES_TO_FIT, c))
    # One band has plenty; a second band has only a handful of its own.
    o = (outcomes(minimum * 4, band="fast")
         + outcomes(8, band="slow"))
    bundle = fit_calibration(FitRequest(o), c).value

    assert ("reorder", "smooth", "slow") not in bundle.fits, "too thin to fit"
    fit, basis = bundle.fit_and_basis("reorder", "smooth", "slow")
    assert fit is not None, "a thin leaf must still get a curve"
    assert basis == "parent_cell"
    assert fit.velocity_band == ANY

    # The leaf that DOES have data uses its own.
    _, own = bundle.fit_and_basis("reorder", "smooth", "fast")
    assert own == "cell"


def test_falls_back_to_the_global_curve_then_to_nothing() -> None:
    """The full chain, in order. The last rung is an ABSENCE - not an identity
    transform dressed up as a fit."""
    c = ctx()
    minimum = int(cfg.get(MIN_OUTCOMES_TO_FIT, c))
    o = outcomes(minimum * 4, family="reorder", demand_class="smooth", band="fast")
    bundle = fit_calibration(FitRequest(o), c).value

    # A family never seen falls all the way to the global pool.
    fit, basis = bundle.fit_and_basis("bundle", "lumpy", "slow")
    assert fit is not None and basis == "global_curve"

    # And an empty bundle has no rung at all.
    empty = fit_calibration(FitRequest([]), c).value
    assert empty.fit_and_basis("reorder", "smooth", "slow") == (None, "no_curve")


def test_reason_is_recorded_on_every_passthrough() -> None:
    """An unexplained passthrough and a fitted curve look identical on the wire,
    and the first would quietly become permanent."""
    c = ctx()
    # 1. no bundle at all
    r = apply_calibration(ApplyRequest(raw_confidence=0.6, family="reorder",
                                       demand_class="smooth", bundle=None), c)
    assert r.value.reasons and "no_calibration_bundle" in r.value.reasons[0]

    # 2. a bundle that could not fit anything - the reason names the SHORTFALL,
    #    not just the absence.
    thin = fit_calibration(FitRequest(outcomes(10)), c).value
    r = apply_calibration(ApplyRequest(raw_confidence=0.6, family="reorder",
                                       demand_class="smooth", bundle=thin), c)
    joined = " ".join(r.value.reasons)
    assert "no_fit_for_cell" in joined
    assert "too_few_outcomes" in joined, (
        "a thin cell and a broken pipeline must not look the same"
    )

    # 3. a suspended family
    r = apply_calibration(
        ApplyRequest(raw_confidence=0.6, family="reorder",
                     demand_class="smooth", bundle=thin,
                     suspended_families=("reorder",)), c)
    assert any("family_suspended" in x for x in r.value.reasons)

    # 4. CALIBRATED, but on a borrowed curve - still a reason.
    minimum = int(cfg.get(MIN_OUTCOMES_TO_FIT, c))
    bundle = fit_calibration(
        FitRequest(outcomes(minimum * 4, band="fast")), c).value
    r = apply_calibration(
        ApplyRequest(raw_confidence=0.6, family="reorder",
                     demand_class="smooth", bundle=bundle,
                     velocity_band="slow"), c)
    assert any("calibrated_on:" in x for x in r.value.reasons), (
        "a curve borrowed from a pooled cell is not the same claim as one "
        "fitted on this cell, and the card must be able to say so"
    )


# ── N2.2 ────────────────────────────────────────────────────────────────────


def preds(n: int, stated: float, observed: float, family="reorder"):
    return [Prediction(family=family, calibrated_confidence=stated,
                       hit=(i / n) < observed) for i in range(n)]


def test_card_with_unreliable_confidence_states_a_band() -> None:
    """A bin out by more than the threshold suspends the family, and a suspended
    family's confidence passes through UNCALIBRATED with its reason - which is
    the signal the card uses to state a band instead of a number.

    Measured: p_hit's populated bins are out by 15.4, 16.9 and 29.8 points
    against a threshold of 10, so today this fires on every card.
    """
    c = ctx()
    report = monitor_calibration(MonitorRequest(preds(200, 0.53, 0.69)), c).value
    score = report.by_family["reorder"]
    assert score.worst_bin_deviation is not None
    assert score.worst_bin_deviation > float(cfg.get(MAX_RELIABILITY_DEVIATION, c))
    assert score.suspended is True
    assert "reorder" in report.suspended_families

    # The card path: a suspended family is not given a calibrated number EVEN
    # WHEN A CURVE EXISTS - which is the only interesting version of the test.
    # (With bundle=None the no-bundle branch fires first and says so, correctly.)
    minimum = int(cfg.get(MIN_OUTCOMES_TO_FIT, c))
    bundle = fit_calibration(FitRequest(outcomes(minimum * 4)), c).value
    assert bundle.fit_for("reorder", "smooth") is not None
    out = apply_calibration(
        ApplyRequest(raw_confidence=0.53, family="reorder",
                     demand_class="smooth", bundle=bundle,
                     suspended_families=report.suspended_families), c).value
    assert out.was_calibrated is False
    assert any("suspended" in r for r in out.reasons)


def test_suspended_family_does_not_reach_a_card() -> None:
    """A suspended family's curve stops being applied. The raw value passes
    through so the slate still ranks, but it is flagged as uncalibrated."""
    c = ctx()
    minimum = int(cfg.get(MIN_OUTCOMES_TO_FIT, c))
    bundle = fit_calibration(FitRequest(outcomes(minimum * 4)), c).value
    assert bundle.fit_for("reorder", "smooth") is not None, "a curve exists"

    out = apply_calibration(
        ApplyRequest(raw_confidence=0.6, family="reorder",
                     demand_class="smooth", bundle=bundle,
                     suspended_families=("reorder",)), c).value
    assert out.was_calibrated is False
    assert out.value == pytest.approx(0.6), "raw, not the curve's output"


def test_suspension_is_per_store_not_global() -> None:
    """A family that works at Bethany and fails at Marshfield is suspended at
    Marshfield only. The monitor is run per store and its report is per store;
    nothing here is module-level, which is what makes that true."""
    c_good = ctx(store_id=171)
    c_bad = ctx(store_id=178)
    good = monitor_calibration(MonitorRequest(preds(200, 0.70, 0.70)), c_good).value
    bad = monitor_calibration(MonitorRequest(preds(200, 0.70, 0.20)), c_bad).value

    assert good.by_family["reorder"].suspended is False
    assert bad.by_family["reorder"].suspended is True
    assert "reorder" not in good.suspended_families
    assert "reorder" in bad.suspended_families

    # And the per-store suspension list is what the card path consumes, so the
    # same family calibrates at one store and not at the other.
    for report, expect_calibrated in ((good, True), (bad, False)):
        minimum = int(cfg.get(MIN_OUTCOMES_TO_FIT, ctx()))
        bundle = fit_calibration(FitRequest(outcomes(minimum * 4)), ctx()).value
        out = apply_calibration(
            ApplyRequest(raw_confidence=0.6, family="reorder",
                         demand_class="smooth", bundle=bundle,
                         suspended_families=report.suspended_families),
            ctx()).value
        assert out.was_calibrated is expect_calibrated


def test_suspension_is_reported_with_its_deviation() -> None:
    """Silent suppression is how a temporary measure becomes permanent."""
    c = ctx()
    report = monitor_calibration(MonitorRequest(preds(200, 0.9, 0.2)), c).value
    score = report.by_family["reorder"]
    assert score.suspended is True
    assert score.reason, "a suspension must carry its reason"
    assert score.worst_bin_deviation is not None and score.worst_bin is not None
    # The number is on the serialised form too, so a report can print it.
    d = score.as_dict()
    assert d["worst_bin_deviation"] is not None
    assert d["worst_bin"] is not None
    assert d["reason"]


def test_deviation_is_reported_even_when_tolerated() -> None:
    """A family inside the threshold still publishes its worst bin, so a curve
    drifting toward the limit is visible before it trips."""
    c = ctx()
    report = monitor_calibration(MonitorRequest(preds(200, 0.70, 0.74)), c).value
    score = report.by_family["reorder"]
    assert score.suspended is False
    assert score.worst_bin_deviation is not None
    assert score.worst_bin_deviation < float(cfg.get(MAX_RELIABILITY_DEVIATION, c))


def test_max_reliability_deviation_is_declared_provisional() -> None:
    assert MAX_RELIABILITY_DEVIATION.status == "PROVISIONAL"
    assert MAX_RELIABILITY_DEVIATION.default == pytest.approx(0.10)
    assert MAX_RELIABILITY_DEVIATION.owner.strip()
    assert "bin" in MAX_RELIABILITY_DEVIATION.why.lower()


# ── A ONE-LEVEL CURVE IS A CONSTANT, AND A CARD MUST SAY SO ─────────────────
#
# Run 294, Bethany: nine reorder cards, raw scores from 0.064 to 0.483, every one
# displayed as 0.444. Pool-adjacent-violators merged 56 noisy outcomes into a
# single block, which is the CORRECT fit and carries no ordering information at
# all. Nine cards reading "44%" is worse for a reader than nine cards reading
# nothing, because a constant that looks like a measurement invites an owner to
# compare two cards on it.


def _constant_fit():
    from datetime import date as _date

    from app.pipeline.calibrate.fit import IsotonicFit

    return IsotonicFit(
        family="reorder", demand_class=ANY,
        xs=(0.05, 0.25, 0.50), ys=(0.444, 0.444, 0.444),
        n_outcomes=56, domain_lo=0.05, domain_hi=0.50,
        fitted_at=_date(2026, 10, 1), velocity_band=ANY,
    )


def _graded_fit():
    from datetime import date as _date

    from app.pipeline.calibrate.fit import IsotonicFit

    return IsotonicFit(
        family="reorder", demand_class=ANY,
        xs=(0.05, 0.25, 0.50), ys=(0.30, 0.50, 0.70),
        n_outcomes=400, domain_lo=0.05, domain_hi=0.50,
        fitted_at=_date(2026, 10, 1), velocity_band=ANY,
    )


def test_a_one_level_curve_reports_itself_as_a_constant() -> None:
    constant, graded = _constant_fit(), _graded_fit()
    assert constant.levels == 1 and constant.is_constant
    assert graded.levels == 3 and not graded.is_constant


def test_a_constant_curve_returns_the_same_value_for_every_input() -> None:
    """The property behind the finding, stated as values rather than as a count."""
    fit = _constant_fit()
    assert {fit.predict(x)[0] for x in (0.064, 0.197, 0.272, 0.431, 0.483)} == {0.444}


def test_the_applied_result_says_it_does_not_discriminate() -> None:
    from app.pipeline.calibrate.apply import ApplyRequest, apply_calibration
    from app.pipeline.calibrate.fit import CalibrationBundle

    for fit, expected in ((_constant_fit(), False), (_graded_fit(), True)):
        bundle = CalibrationBundle(
            version="v-test", fitted_at=fit.fitted_at,
            fits={(fit.family, fit.demand_class, fit.velocity_band): fit},
            skipped={},
        )
        applied = apply_calibration(
            ApplyRequest(raw_confidence=0.272, family="reorder",
                         demand_class=ANY, bundle=bundle,
                         velocity_band=ANY),
            ctx(),
        ).value
        assert applied.was_calibrated is True
        assert applied.discriminates is expected, fit.ys


def test_a_constant_curve_carries_its_reason_and_explains_itself_plainly() -> None:
    from app.pipeline.calibrate.apply import ApplyRequest, apply_calibration
    from app.pipeline.calibrate.fit import CalibrationBundle

    fit = _constant_fit()
    bundle = CalibrationBundle(
        version="v-test", fitted_at=fit.fitted_at,
        fits={(fit.family, fit.demand_class, fit.velocity_band): fit},
        skipped={})
    applied = apply_calibration(
        ApplyRequest(raw_confidence=0.272, family="reorder",
                     demand_class=ANY, bundle=bundle,
                     velocity_band=ANY),
        ctx(),
    ).value
    assert any("constant_curve" in r for r in applied.reasons)
    assert "56" in " ".join(applied.reasons)
    text = applied.explain()
    # It must NOT claim the figure was raised or lowered for THIS card.
    assert "raised" not in text and "lowered" not in text
    assert "overall" in text


def test_the_card_labels_a_constant_basis_differently() -> None:
    """`confidence_basis: "isotonic"` tells a reader the figure was calibrated and
    hides that it is the same figure on every card in the run."""
    from dataclasses import replace as _replace
    from datetime import date as _date

    from app.pipeline.calibrate.fit import CalibrationBundle
    from app.recommender.deterministic import Pick, to_raw_recommendations

    pick = Pick(
        sku="081128005214", rank=1, recent_units=12.0, recent_rate=0.43,
        long_run_rate=3.44, reverted_rate=0.92, uplift=2.14, p_hit=0.272,
        deficit_units=12.0, dispersion_cv=0.47, evidence_state="EMERGING",
        why="because", long_run_days_available=365, family="recovering",
        days_cover=4.0, unit_cost=11.50, horizon_open_days=25.7,
    )
    for fit, expected_basis, discriminates in (
        (_constant_fit(), "isotonic_constant", False),
        (_graded_fit(), "isotonic", True),
    ):
        bundle = CalibrationBundle(
            version="v", fitted_at=_date(2026, 10, 1),
            fits={(fit.family, fit.demand_class, fit.velocity_band): fit},
            skipped={})
        card = to_raw_recommendations(
            [pick], as_of=_date(2026, 10, 6), client_id=1, location_id=171,
            calibration_bundle=bundle.as_dict())[0]
        assert card["confidence_basis"] == expected_basis
        assert card["confidence_discriminates"] is discriminates
        assert card["confidence_levels"] == fit.levels
        assert card["confidence_explain"]


def test_the_level_count_survives_a_round_trip() -> None:
    """It is DERIVED from `ys`, so a bundle read back must report the same thing -
    a persisted copy could otherwise disagree with the curve beside it."""
    from app.pipeline.calibrate.fit import fit_from_dict

    fit = _constant_fit()
    assert fit_from_dict(fit.as_dict()).levels == fit.levels == 1


def test_a_flat_slate_is_reported_even_when_the_curve_has_levels() -> None:
    """A curve-level test was not enough. Run 294: Bethany's bundle has FOUR
    levels, so the curve "discriminates", and eight of nine cards still displayed
    0.444 because every raw score from 0.161 to 0.515 fell inside one step.

    The reader's question is whether the figure tells THIS card apart from the one
    below it, which only the finished slate can answer.
    """
    from dataclasses import replace as _replace
    from datetime import date as _date

    from app.pipeline.calibrate.fit import CalibrationBundle, IsotonicFit
    from app.recommender.deterministic import Pick, to_raw_recommendations

    # Four levels, but the first step spans everything these cards score.
    fit = IsotonicFit(
        family="reorder", demand_class=ANY,
        xs=(0.05, 0.60, 0.75, 0.90), ys=(0.444, 0.55, 0.62, 0.70),
        n_outcomes=200, domain_lo=0.05, domain_hi=0.90,
        fitted_at=_date(2026, 10, 1), velocity_band=ANY,
    )
    assert fit.levels == 4 and not fit.is_constant

    base = Pick(
        sku="081128005214", rank=1, recent_units=12.0, recent_rate=0.43,
        long_run_rate=3.44, reverted_rate=0.92, uplift=2.14, p_hit=0.272,
        deficit_units=12.0, dispersion_cv=0.47, evidence_state="EMERGING",
        why="because", long_run_days_available=365, family="recovering",
        days_cover=4.0, unit_cost=11.50, horizon_open_days=25.7,
    )
    bundle = CalibrationBundle(
        version="v", fitted_at=_date(2026, 10, 1),
        fits={(fit.family, fit.demand_class, fit.velocity_band): fit}, skipped={})

    # Every raw score inside the first step: a flat slate.
    flat = [_replace(base, sku=f"08112800521{i}", rank=i + 1, p_hit=p)
            for i, p in enumerate((0.161, 0.272, 0.431, 0.515))]
    cards = to_raw_recommendations(flat, as_of=_date(2026, 10, 6), client_id=1,
                                   location_id=171,
                                   calibration_bundle=bundle.as_dict())
    assert len({c["confidence"] for c in cards}) == 1
    assert all(c["confidence_discriminates"] is False for c in cards)
    assert all(c["confidence_basis"].endswith("_flat_slate") for c in cards)
    assert all("does not tell them apart" in c["confidence_explain"]
               for c in cards)
    # The VALUE is untouched - it is still whatever the curve returned, which is
    # the store's measured rate for that step. Only the CLAIM about it changes.
    plain = to_raw_recommendations(flat, as_of=_date(2026, 10, 6), client_id=1,
                                   location_id=171)
    assert [c["confidence_raw"] for c in cards] == [c["confidence_raw"]
                                                    for c in plain]
    assert all(c["confidence"] == cards[0]["confidence"] for c in cards)

    # And a slate that DOES spread keeps the ordinary basis.
    spread = [_replace(base, sku=f"08112800522{i}", rank=i + 1, p_hit=p)
              for i, p in enumerate((0.20, 0.65, 0.80, 0.95))]
    varied = to_raw_recommendations(spread, as_of=_date(2026, 10, 6), client_id=1,
                                    location_id=171,
                                    calibration_bundle=bundle.as_dict())
    assert len({c["confidence"] for c in varied}) > 1
    assert all(c["confidence_discriminates"] is True for c in varied)
    assert all(c["confidence_basis"] == "isotonic" for c in varied)


def test_a_single_card_run_is_not_called_flat() -> None:
    """One card cannot fail to tell itself apart from anything, and labelling it
    flat would put a caveat on every store that happens to issue one card."""
    from datetime import date as _date

    from app.pipeline.calibrate.fit import CalibrationBundle, IsotonicFit
    from app.recommender.deterministic import Pick, to_raw_recommendations

    fit = IsotonicFit(
        family="reorder", demand_class=ANY, xs=(0.05, 0.60), ys=(0.444, 0.60),
        n_outcomes=200, domain_lo=0.05, domain_hi=0.60,
        fitted_at=_date(2026, 10, 1), velocity_band=ANY)
    bundle = CalibrationBundle(version="v", fitted_at=_date(2026, 10, 1),
                              fits={(fit.family, fit.demand_class,
                                     fit.velocity_band): fit}, skipped={})
    pick = Pick(
        sku="081128005214", rank=1, recent_units=12.0, recent_rate=0.43,
        long_run_rate=3.44, reverted_rate=0.92, uplift=2.14, p_hit=0.272,
        deficit_units=12.0, dispersion_cv=0.47, evidence_state="EMERGING",
        why="because", long_run_days_available=365, family="recovering",
        days_cover=4.0, unit_cost=11.50, horizon_open_days=25.7)
    card = to_raw_recommendations([pick], as_of=_date(2026, 10, 6), client_id=1,
                                  location_id=171,
                                  calibration_bundle=bundle.as_dict())[0]
    assert card["confidence_discriminates"] is True
    assert not card["confidence_basis"].endswith("_flat_slate")
