"""Checklist 18 - drift. A store below its null for a month is suspended;
one bad week is not; thin data abstains with a reason.

The weeks are built relative to AS_OF with the registry's own bucket width,
so a change to the window Setting cannot silently turn these into tests of a
different rule.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

from app.pipeline.context import RunContext
from app.pipeline.gate import (
    DRIFT_BUCKET_DAYS,
    DRIFT_MIN_BUCKET_OUTCOMES,
    DRIFT_MIN_OUTCOMES,
    DRIFT_WINDOW_DAYS,
    DriftOutcome,
    DriftRequest,
    GateState,
    Outcome,
    evaluate_drift,
)
from app.pipeline.registry import cfg

REPO = Path(__file__).resolve().parents[1]
AS_OF = date(2026, 10, 8)


def ctx() -> RunContext:
    return RunContext(
        run_id="drift-test", tenant_id=171, store_id=171, as_of=AS_OF,
        snapshot_id="snap-drift", config_version="default", seed=0,
        versions={"gate": "1.0.0"},
    )


BUCKET = int(cfg.get(DRIFT_BUCKET_DAYS, ctx()))
WEEKS = int(cfg.get(DRIFT_WINDOW_DAYS, ctx())) // BUCKET
MIN_TOTAL = int(cfg.get(DRIFT_MIN_OUTCOMES, ctx()))
MIN_WEEK = int(cfg.get(DRIFT_MIN_BUCKET_OUTCOMES, ctx()))

#: A null pool whose mean lift is 1.0: half the products did a little better
#: than their baseline, half a little worse. Anything averaging under 1.0
#: is below it; anything over is above it.
NULL_POOL = {"v2": [0.8, 0.9, 1.0, 1.1, 1.2] * 20}


def week_outcomes(week_index: int, lift: float, n: int, *, shown: bool = True):
    """`n` outcomes scored in the middle of week `week_index` (0 = this week)."""
    scored_on = AS_OF - timedelta(days=week_index * BUCKET + BUCKET // 2)
    return [
        DriftOutcome(
            outcome=Outcome(sku=f"W{week_index}S{i}", family="reorder", lift=lift,
                            volume_class="v2", shown=shown),
            scored_on=scored_on,
        )
        for i in range(n)
    ]


def per_week() -> int:
    """Enough per week to clear both floors with room to spare."""
    return max(MIN_WEEK, -(-MIN_TOTAL // WEEKS)) + 2


def run(outcomes, pool=NULL_POOL):
    result = evaluate_drift(
        DriftRequest(client_id=171, location_id=171, outcomes=outcomes,
                     null_pool=pool),
        ctx(),
    )
    assert result.ok, result.reasons
    return result.value


# ── The rule ─────────────────────────────────────────────────────────────────


def test_below_the_null_every_week_for_the_window_is_drift() -> None:
    """Four straight weeks under the null is a store, not a bad week."""
    outcomes = [o for w in range(WEEKS) for o in week_outcomes(w, 0.6, per_week())]
    verdict = run(outcomes)

    assert verdict.drifted is True
    assert verdict.state is GateState.SUSPENDED
    assert verdict.reason == f"drift:below_null_for_{WEEKS * BUCKET}d"
    assert len(verdict.weeks) == WEEKS
    assert all(w.below_null is True for w in verdict.weeks)
    assert verdict.abstained is False


def test_one_bad_week_is_not_drift() -> None:
    """A single dip is a dip. The rule is conjunctive across weeks precisely so
    one catastrophic week of quiet products cannot condemn three good ones."""
    outcomes = []
    for w in range(WEEKS):
        lift = 0.5 if w == 1 else 1.6
        outcomes.extend(week_outcomes(w, lift, per_week()))
    verdict = run(outcomes)

    assert verdict.drifted is False
    assert verdict.state is None, "no drift means NO state - the monitor never promotes"
    assert verdict.reason == f"drift:beat_null_in_{WEEKS - 1}_of_{WEEKS}_weeks"
    assert sum(1 for w in verdict.weeks if w.below_null) == 1


def test_a_healthy_store_is_left_alone() -> None:
    outcomes = [o for w in range(WEEKS) for o in week_outcomes(w, 1.8, per_week())]
    verdict = run(outcomes)
    assert verdict.drifted is False and verdict.abstained is False
    assert all(w.below_null is False for w in verdict.weeks)


# ── Abstentions carry a reason; None is never a pass ────────────────────────


def test_too_few_outcomes_in_the_window_abstains() -> None:
    """A store that issued a handful of cards has been sampled, not measured."""
    outcomes = week_outcomes(0, 0.5, max(1, MIN_TOTAL - 1))
    verdict = run(outcomes)
    assert verdict.drifted is False
    assert verdict.abstained is True
    assert verdict.reason.startswith("drift:thin_evidence:")
    assert f"<{MIN_TOTAL}" in verdict.reason


def test_a_week_with_too_few_outcomes_abstains_rather_than_being_skipped() -> None:
    """Three weeks below and one unread week is NOT four weeks below. Skipping
    the unread week is how four weeks of evidence quietly becomes three."""
    outcomes = []
    for w in range(WEEKS):
        n = MIN_WEEK - 1 if w == 2 else per_week()
        outcomes.extend(week_outcomes(w, 0.5, n))
    # Keep the total above the window floor so the WEEK floor is what fires.
    assert len(outcomes) >= MIN_TOTAL
    verdict = run(outcomes)

    assert verdict.drifted is False
    assert verdict.abstained is True
    thin_start = (AS_OF - timedelta(days=3 * BUCKET)).isoformat()
    assert verdict.reason == f"drift:thin_week:{thin_start}:{MIN_WEEK - 1}<{MIN_WEEK}"


def test_no_matched_null_abstains() -> None:
    """A comparison with nothing to compare against is an absence of evidence,
    not evidence of drift."""
    outcomes = [o for w in range(WEEKS) for o in week_outcomes(w, 0.5, per_week())]
    verdict = run(outcomes, pool={"v0": [1.0] * 10})
    assert verdict.drifted is False
    assert verdict.abstained is True
    assert verdict.reason.startswith("drift:no_matched_null:")


def test_only_the_shown_arm_is_judged() -> None:
    """The holdout arm is the control. Scoring it as a recommendation would
    compare the engine against itself."""
    outcomes = [o for w in range(WEEKS)
                for o in week_outcomes(w, 0.4, per_week(), shown=False)]
    verdict = run(outcomes)
    assert verdict.drifted is False
    assert verdict.abstained is True
    assert verdict.n_outcomes == 0


def test_outcomes_older_than_the_window_do_not_count() -> None:
    outcomes = [o for w in range(WEEKS) for o in week_outcomes(w, 1.7, per_week())]
    stale = week_outcomes(WEEKS + 3, 0.1, per_week() * 3)
    verdict = run(outcomes + stale)
    assert verdict.drifted is False
    assert verdict.n_outcomes == len(outcomes)


# ── The CLI prints what Node persists ───────────────────────────────────────


def test_drift_eval_script_prints_a_suspension_with_its_validity(tmp_path) -> None:
    rows = []
    for w in range(WEEKS):
        for o in week_outcomes(w, 0.6, per_week()):
            rows.append({
                "sku": o.outcome.sku, "family": o.outcome.family,
                "lift": o.outcome.lift, "shown": True, "volume_class": "v2",
                "scored_on": o.scored_on.isoformat(),
            })
    payload = {"client_id": 171, "location_id": 171, "as_of": AS_OF.isoformat(),
               "outcomes": rows, "null_pool": NULL_POOL}
    path = tmp_path / "drift.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    done = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "drift_eval.py"), str(path)],
        cwd=REPO, capture_output=True, text=True,
    )
    assert done.returncode == 0, done.stderr
    out = json.loads(done.stdout)

    assert out["drifted"] is True
    assert out["state"] == "suspended"
    assert out["reason"] == f"drift:below_null_for_{WEEKS * BUCKET}d"
    assert out["verdict_as_of"] == AS_OF.isoformat()
    # The expiry comes from the same Setting the publisher uses, so a drift
    # suspension and a published verdict age out on one rule.
    from app.pipeline.gate.store import VERDICT_VALID_DAYS
    assert out["valid_until"] == (AS_OF + timedelta(days=VERDICT_VALID_DAYS)).isoformat()
    assert len(out["weeks"]) == WEEKS


def test_drift_eval_script_abstains_on_thin_data_without_a_state(tmp_path) -> None:
    payload = {"client_id": 171, "location_id": 171, "as_of": AS_OF.isoformat(),
               "outcomes": [], "null_pool": NULL_POOL}
    path = tmp_path / "thin.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    done = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "drift_eval.py"), str(path)],
        cwd=REPO, capture_output=True, text=True,
    )
    assert done.returncode == 0, done.stderr
    out = json.loads(done.stdout)
    assert out["drifted"] is False and out["abstained"] is True
    assert out["state"] is None
    assert out["reason"].startswith("drift:thin_evidence:")
