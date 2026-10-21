"""A curve that cannot be read back is a curve that was never applied.

`as_dict` existed from the start and nothing could reverse it, so every curve the
harness fitted was serialised and thrown away. That is the whole reason stage 8
stayed inert in production after its data blocker cleared.

The most important test here is `test_the_round_trip_is_checked_on_the_applied
_value`, because the first version of the deserialiser round-tripped a bundle whose
fit COUNT matched perfectly while every lookup missed and silently fell back to
identity.
"""

from __future__ import annotations

import json
from datetime import date

import pytest

from app.pipeline.calibrate.apply import ApplyRequest, apply_calibration
from app.pipeline.calibrate.fit import (
    ANY,
    FitRequest,
    Outcome,
    bundle_from_dict,
    fit_calibration,
    fit_from_dict,
)
from app.pipeline.context import RunContext


def ctx() -> RunContext:
    return RunContext(
        run_id="run-cc", tenant_id=1, store_id=171, as_of=date(2026, 10, 6),
        snapshot_id="snap-1", config_version="default", seed=0,
        versions={"calibrate_fit": "1.0.0", "calibrate_apply": "1.0.0"},
    )


def fitted_bundle(*, family: str = "reorder", scale: int = 20):
    """A bundle fitted on an over-confident score, like production's.

    Four confidence levels because the fitter refuses fewer distinct values than
    MIN_DISTINCT_CONFIDENCES - a curve through one point is a constant.
    """
    outcomes = []
    for raw, true_rate in ((0.55, 0.45), (0.72, 0.50), (0.91, 0.65), (0.95, 0.67)):
        hits = int(round(true_rate * scale))
        outcomes += [Outcome(family=family, demand_class=ANY,
                             stated_confidence=raw, hit=True, velocity_band=ANY)
                     for _ in range(hits)]
        outcomes += [Outcome(family=family, demand_class=ANY,
                             stated_confidence=raw, hit=False, velocity_band=ANY)
                     for _ in range(scale - hits)]
    result = fit_calibration(FitRequest(outcomes=outcomes), ctx())
    assert result.ok and result.value is not None and result.value.fits
    return result.value


def applied(bundle, raw: float, family: str = "reorder"):
    return apply_calibration(
        ApplyRequest(raw_confidence=raw, family=family, demand_class=ANY,
                     bundle=bundle, velocity_band=ANY), ctx()).value


# ── The bug that made the first version useless ──────────────────────────────


def test_the_round_trip_is_checked_on_the_applied_value() -> None:
    """THE test. The first deserialiser built two-part keys while `cell_for` walks
    three-part ones, so every lookup missed and the bundle fell back to identity -
    which is indistinguishable from "no curve exists yet".

    Comparing fit COUNTS passed. Comparing applied VALUES is what caught it.
    """
    original = fitted_bundle()
    restored = bundle_from_dict(json.loads(json.dumps(original.as_dict())))

    for raw in (0.50, 0.55, 0.65, 0.72, 0.85, 0.91, 0.95, 0.99):
        before, after = applied(original, raw), applied(restored, raw)
        assert before.transform == after.transform, (
            f"at {raw}: {before.transform} became {after.transform} - a key "
            f"mismatch falls back to identity silently")
        assert before.value == pytest.approx(after.value), raw


def test_the_lookup_keys_are_three_part() -> None:
    """Pinned directly, because the chain is
    (family, class, band) -> (family, class, ANY) -> (ANY, ANY, ANY)."""
    restored = bundle_from_dict(fitted_bundle().as_dict())
    assert restored.fits, "something must be there to look up"
    for key in restored.fits:
        assert isinstance(key, tuple) and len(key) == 3, key


def test_a_restored_bundle_is_not_identity() -> None:
    """The failure mode spelled out: if this ever reads `identity`, the curve is
    being thrown away exactly as it was before this carriage existed."""
    restored = bundle_from_dict(fitted_bundle().as_dict())
    assert applied(restored, 0.95).transform != "identity"


# ── It is a faithful copy, not an approximation ──────────────────────────────


def test_version_and_fit_date_survive() -> None:
    """A card cites the version it was scored under and must be replayable."""
    original = fitted_bundle()
    restored = bundle_from_dict(original.as_dict())
    assert restored.version == original.version
    assert restored.fitted_at == original.fitted_at


def test_breakpoints_come_back_as_immutable_tuples() -> None:
    """A list would compare unequal to a freshly fitted curve and would be
    mutable - and a curve that can be edited after it was fitted is not a record
    of anything."""
    restored = bundle_from_dict(fitted_bundle().as_dict())
    fit = next(iter(restored.fits.values()))
    assert isinstance(fit.xs, tuple) and isinstance(fit.ys, tuple)
    assert list(fit.ys) == sorted(fit.ys), "isotonic means non-decreasing"


def test_the_skipped_cells_survive_with_their_reasons() -> None:
    """"We looked at this cell and there was not enough" is information. Its
    absence would read as "we never looked"."""
    original = fitted_bundle(scale=20)
    restored = bundle_from_dict(original.as_dict())
    assert len(restored.skipped) == len(original.skipped)
    for key, reason in restored.skipped.items():
        assert isinstance(key, tuple) and len(key) == 3, key
        assert reason


def test_one_fit_round_trips_on_its_own() -> None:
    original = next(iter(fitted_bundle().fits.values()))
    restored = fit_from_dict(json.loads(json.dumps(original.as_dict())))
    assert restored == original


# ── What it does to production's numbers ─────────────────────────────────────


def test_it_corrects_the_over_confidence_measured_in_production() -> None:
    """Production states 0.85-0.97 and hits about two thirds of the time. The
    curve is what turns a ranking score into a number an owner can read."""
    restored = bundle_from_dict(fitted_bundle().as_dict())
    for raw in (0.85, 0.91, 0.95, 0.97):
        assert applied(restored, raw).value < raw, raw
    # And it does not invert the ordering it was fitted on.
    values = [applied(restored, raw).value for raw in (0.55, 0.72, 0.91, 0.95)]
    assert values == sorted(values), values


def test_a_score_outside_the_fitted_domain_is_clipped_not_extrapolated() -> None:
    """Outside the range the curve actually saw there is no evidence, so the
    endpoint is held rather than a trend being continued off the end."""
    restored = bundle_from_dict(fitted_bundle().as_dict())
    below = applied(restored, 0.01).value
    above = applied(restored, 0.99).value
    inside_low = applied(restored, 0.55).value
    inside_high = applied(restored, 0.95).value
    assert below == pytest.approx(inside_low)
    assert above == pytest.approx(inside_high)


# ── Malformed input must not sink a run ──────────────────────────────────────


def test_an_empty_bundle_reads_back_as_empty_not_broken() -> None:
    empty = {"version": "2026-10-06.none", "fitted_at": "2026-10-06",
             "fits": [], "skipped": {}}
    restored = bundle_from_dict(empty)
    assert restored.fits == {}
    # And applying it is the identity transform, which is the correct fallback.
    assert applied(restored, 0.95).transform == "identity"


def test_a_malformed_fit_raises_rather_than_being_guessed() -> None:
    """A half-read curve applied to real cards is worse than no curve. The CALLER
    catches this and falls back to identity, which is a deliberate split: the
    parser does not get to invent values."""
    for broken in ({"family": "reorder"},
                   {"family": "reorder", "demand_class": ANY, "xs": [0.5]}):
        with pytest.raises((KeyError, TypeError, ValueError)):
            fit_from_dict(broken)


def test_the_bundle_survives_a_json_round_trip_through_a_database() -> None:
    """It is stored as jsonb, so it passes through a serialiser that turns tuples
    into lists and dates into strings."""
    original = fitted_bundle()
    through_db = json.loads(json.dumps(original.as_dict()))
    assert isinstance(through_db["fits"][0]["xs"], list)
    restored = bundle_from_dict(through_db)
    assert applied(restored, 0.95).value == pytest.approx(
        applied(original, 0.95).value)
