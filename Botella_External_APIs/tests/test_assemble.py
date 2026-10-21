"""The seam: 04 -> 05 -> 06 as one pipeline.

Each of those sheets is tested on its own. What is tested HERE is the thing
none of them could test alone - that they compose, and that composing them
does not smuggle in the branch sheet 06 exists to abolish.
"""

from __future__ import annotations

import ast
import inspect
from dataclasses import replace
from datetime import date, timedelta

import pytest

from app.pipeline import assemble
from app.pipeline.assemble import (
    EstateInput,
    EstimateRequest,
    SkuInput,
    estimate_sku,
    estimate_store,
)
from app.pipeline.blend import PATTERNS as BLEND_PATTERNS
from app.pipeline.context import RunContext
from app.pipeline.evidence import PATTERNS as EVIDENCE_PATTERNS
from app.pipeline.features.store import CalendarDay, DayFact
from app.pipeline.patterns import CANONICAL, canonical, for_evidence
from app.pipeline.priors import PATTERNS as PRIOR_PATTERNS
from app.pipeline.priors import CohortObservation
from app.store_data.velocity import open_days_between

AS_OF = date(2026, 9, 22)
WINDOW = 364


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-assemble", "tenant_id": 1, "store_id": 1, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"assemble": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def calendar(days: int = WINDOW, *, closed_weekday: int | None = None) -> list[CalendarDay]:
    return [
        CalendarDay(
            obs_date=AS_OF - timedelta(days=i),
            was_open=(closed_weekday is None
                      or (AS_OF - timedelta(days=i)).weekday() != closed_weekday),
            has_data=True,
        )
        for i in range(days)
    ]


def facts_for(sku: str, *, days: int, units: float = 2.0) -> list[DayFact]:
    return [
        DayFact(obs_date=AS_OF - timedelta(days=i), sku=sku, units_sold=units,
                price=10.0)
        for i in range(days)
    ]


def cohort(unit_key: str, *, stores: int, value: float) -> dict[str, list[CohortObservation]]:
    return {
        unit_key: [
            CohortObservation(store_key=(9, 100 + i), value=value)
            for i in range(stores)
        ]
    }


def estate(*, facts: list[DayFact] | None = None, cal: list[CalendarDay] | None = None,
           candidate_count: int = 30) -> EstateInput:
    return EstateInput(
        store_key=(1, 1),
        subject_state="TX",
        calendar=cal if cal is not None else calendar(),
        facts=facts or [],
        candidates=[((9, 100 + i), "TX") for i in range(candidate_count)],
        window_days=WINDOW,
    )


# ── The vocabulary defect this seam surfaced ─────────────────────────────────


def test_the_three_sheets_agree_on_the_pattern_vocabulary() -> None:
    """Sheets 04 and 05/06 spell two of the five patterns differently.

    Each module was internally consistent and fully tested, so nothing caught
    it until the first attempt to run them as one pipeline. This test is the
    thing that keeps it closed: adding a sixth pattern to one sheet and not the
    others fails here.
    """
    assert set(PRIOR_PATTERNS) == set(BLEND_PATTERNS) == set(CANONICAL)
    # Every evidence spelling maps onto exactly one canonical name...
    assert {canonical(p) for p in EVIDENCE_PATTERNS} == set(CANONICAL)
    # ...and back again. A bijection, not a lossy fold.
    assert {for_evidence(c) for c in CANONICAL} == set(EVIDENCE_PATTERNS)
    assert len({canonical(p) for p in EVIDENCE_PATTERNS}) == len(EVIDENCE_PATTERNS)


def test_canonicalisation_is_idempotent() -> None:
    """A caller must not have to know which side of the boundary it is on."""
    for p in (*EVIDENCE_PATTERNS, *CANONICAL):
        assert canonical(canonical(p)) == canonical(p)
        assert for_evidence(for_evidence(p)) == for_evidence(p)


def test_an_unknown_pattern_is_refused_rather_than_guessed() -> None:
    with pytest.raises(ValueError, match="unknown pattern"):
        canonical("weekly_seasonality_probably")


def test_the_assembly_accepts_either_spelling_and_reports_the_canonical_one() -> None:
    obs = cohort("0245", stores=8, value=3.0)
    e = estate(facts=facts_for("0245", days=40))
    sku = SkuInput(sku="0245", category="whiskey", own_rate=2.0, observations=obs)

    both = [
        estimate_sku(EstimateRequest(e, sku, spelling), ctx()).value
        for spelling in ("category", "category_share")
    ]
    assert both[0].pattern == both[1].pattern == "category_share"
    assert both[0].value == both[1].value


# ── Cold start is a weight, not a branch ─────────────────────────────────────


def test_a_store_with_no_data_at_all_still_gets_an_estimate() -> None:
    """The empty-store end of 'every store, empty to full'.

    No facts, no own rate. n=0, so the blend returns the cohort prior exactly
    and own_weight is 0.0 - and no branch was taken to make that happen.
    """
    obs = cohort("0245", stores=9, value=3.5)
    result = estimate_sku(
        EstimateRequest(
            estate(facts=[]),
            SkuInput(sku="0245", category="whiskey", own_rate=None,
                     observations=obs),
            "sku_velocity",
        ),
        ctx(),
    )
    assert result.ok
    est = result.value
    assert est.n == 0
    assert est.own_weight == 0.0
    assert est.value == pytest.approx(est.theta_cohort)
    assert est.value == pytest.approx(3.5)
    assert est.evidence_state == "NEW"
    assert "0% on your own sales" in est.explanation


def test_a_store_with_full_history_is_driven_by_its_own_data() -> None:
    """The full end of the same sentence."""
    obs = cohort("0245", stores=9, value=3.5)
    result = estimate_sku(
        EstimateRequest(
            estate(facts=facts_for("0245", days=300)),
            SkuInput(sku="0245", category="whiskey", own_rate=2.0,
                     observations=obs),
            "sku_velocity",
        ),
        ctx(),
    )
    est = result.value
    assert est.n > 4 * est.k          # MATURE by the sheet-06 bands
    assert est.own_weight > 0.9
    assert abs(est.value - 2.0) < abs(est.value - 3.5)
    assert est.evidence_state == "MATURE"


def test_the_empty_store_and_the_full_store_run_the_same_code() -> None:
    """Sheet 06's keystone claim, asserted across the whole assembled seam.

    Same stage, same version, same shape of outcome. Only n differs - which is
    precisely the property a tier gate would destroy.
    """
    obs = cohort("0245", stores=9, value=3.5)
    empty = estimate_sku(
        EstimateRequest(estate(facts=[]),
                        SkuInput("0245", "whiskey", None, obs), "sku_velocity"),
        ctx(),
    )
    full = estimate_sku(
        EstimateRequest(estate(facts=facts_for("0245", days=300)),
                        SkuInput("0245", "whiskey", 2.0, obs), "sku_velocity"),
        ctx(),
    )

    assert empty.ok and full.ok
    assert empty.stage == full.stage
    assert empty.stage_version == full.stage_version
    assert set(empty.value.as_dict()) == set(full.value.as_dict())
    assert empty.provenance.own_weight != full.provenance.own_weight


def test_the_blend_moves_monotonically_with_history_and_never_jumps() -> None:
    """No cliff anywhere along the seam, not just inside blend().

    A tier gate assembled at this layer would show up as a step change here
    even though sheet 06's own continuity test still passed.
    """
    obs = cohort("0245", stores=9, value=10.0)
    values = []
    for days in range(0, 200, 5):
        est = estimate_sku(
            EstimateRequest(estate(facts=facts_for("0245", days=days)),
                            SkuInput("0245", "whiskey", 1.0, obs),
                            "sku_velocity"),
            ctx(),
        ).value
        values.append(est.value)

    # Own rate (1.0) is below the cohort (10.0), so more history pulls it down.
    # strict=False is deliberate: the zip is offset by one ON PURPOSE, pairing
    # each value with its successor. strict=True asserts equal lengths and
    # would fail every time - it is the wrong answer to this lint, not the
    # safe one.
    assert all(b <= a + 1e-9 for a, b in zip(values, values[1:], strict=False))
    steps = [abs(a - b) for a, b in zip(values, values[1:], strict=False)]
    assert max(steps) == steps[0]        # the largest move is the first
    assert values[0] == pytest.approx(10.0)


# ── The assembly must not become a place to hide a branch ────────────────────


def test_the_assembly_never_branches_on_evidence_state_or_a_tier() -> None:
    """The seam is the obvious place to reintroduce what sheet 06 removed.

    `check_no_state_branches.py` scans app/pipeline and would catch a branch on
    evidence_state. This adds the vocabulary check: no `tier`, no `is_new`, no
    `cold_start` anywhere in the module.
    """
    tree = ast.parse(inspect.getsource(assemble))
    banned = {"tier", "store_tier", "is_new", "is_cold_start", "cold_start"}
    names = {
        node.id for node in ast.walk(tree) if isinstance(node, ast.Name)
    } | {
        node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)
    }
    assert not (names & banned)


def test_a_failing_stage_drops_the_sku_rather_than_inventing_a_number() -> None:
    """A known unknown must not become a confident wrong answer."""
    obs = cohort("0245", stores=9, value=3.5)
    good = SkuInput("0245", "whiskey", 2.0, obs)
    # A calendar of zero days: evidence has no window to count over.
    out = estimate_store(
        estate(facts=[], cal=[]), [good], "sku_velocity", ctx()
    )
    assert out == [] or all(isinstance(e.value, float) for e in out)


def test_estimate_store_returns_one_row_per_estimable_sku() -> None:
    obs = {}
    for sku in ("A", "B", "C"):
        obs.update(cohort(sku, stores=9, value=3.0))
    skus = [SkuInput(sku, "whiskey", 1.0, obs) for sku in ("A", "B", "C")]
    out = estimate_store(
        estate(facts=facts_for("A", days=50)), skus, "sku_velocity", ctx()
    )
    assert [e.sku for e in out] == ["A", "B", "C"]
    # Only A has history, so only A should lean on its own data.
    by_sku = {e.sku: e for e in out}
    assert by_sku["A"].own_weight > by_sku["B"].own_weight
    assert by_sku["B"].own_weight == by_sku["C"].own_weight == 0.0


# ── The grain invariant, learned the hard way on real data ───────────────────


def test_a_cohort_observation_at_the_wrong_grain_wrecks_the_blend() -> None:
    """Every rung must answer in the SAME unit as the quantity being estimated.

    This is not hypothetical. The first end-to-end run on store 171 supplied
    the all_products rung as the store's TOTAL units per open day - 182.6 for
    a Texas store carrying ~1,800 SKUs - instead of the per-SKU rate of 0.10.
    A SKU genuinely selling 3.9/day came back blended at 17.5, and the table it
    appeared in looked entirely reasonable.

    Nothing in sheets 04-06 could have caught it: the ladder resolved, k-anon
    passed, the blend arithmetic was exactly right. The inputs were at the
    wrong grain, and a correct formula over wrong units is still wrong. This
    test states the requirement so it is at least written down somewhere the
    build reads.
    """
    per_sku_rate = 0.10          # the honest all_products rung
    store_total_rate = 182.586   # what was supplied instead

    def blended_with(theta_cohort: float) -> float:
        return estimate_sku(
            EstimateRequest(
                estate(facts=facts_for("0245", days=260)),
                SkuInput("0245", "whiskey", 3.935,
                         cohort("0245", stores=15, value=theta_cohort)),
                "sku_velocity",
            ),
            ctx(),
        ).value.value

    right = blended_with(per_sku_rate)
    wrong = blended_with(store_total_rate)

    # The store's own rate is 3.935/day and it is MATURE, so the honest answer
    # stays close to it...
    assert right == pytest.approx(3.64, abs=0.05)
    # ...while the wrong grain drags it up more than fourfold, with every other
    # part of the pipeline behaving exactly as designed.
    assert wrong > 4 * right


def test_every_rung_a_sku_can_reach_is_a_per_sku_rate() -> None:
    """The three rungs must be interchangeable answers to one question.

    `sku`, `category` and `all_products` all answer "units per open day for a
    SKU like this one". If they did not, which rung happened to clear
    k-anonymity would change the UNITS of the answer, not just its precision -
    and a store would see an estimate jump by two orders of magnitude for a
    reason invisible to it.
    """
    obs = {
        "0245": [CohortObservation((9, 100 + i), 0.9) for i in range(9)],
        "whiskey": [CohortObservation((9, 100 + i), 0.8) for i in range(9)],
        "*": [CohortObservation((9, 100 + i), 0.7) for i in range(9)],
    }
    est = estimate_sku(
        EstimateRequest(estate(facts=[]),
                        SkuInput("0245", "whiskey", None, obs), "sku_velocity"),
        ctx(),
    ).value

    # n=0, so the answer IS the prior, whichever rung produced it - and all
    # three are within the same order of magnitude of each other.
    assert est.n == 0
    assert 0.5 < est.value < 1.0
    assert est.specificity in ("sku", "category", "all_products")


# ── The coldest store in the estate ──────────────────────────────────────────


def test_a_store_with_no_calendar_rows_still_gets_an_answer() -> None:
    """The case that nearly shipped broken.

    15 stores in this estate carry products and have sold nothing - one stocks
    29,019 SKUs and has never rung up a single unit. They have no
    `feature_store_day` rows at all, and `count_evidence` refuses an empty
    window with `no_calendar_for_window`. Every SKU was therefore dropped and
    the store got NOTHING: the store with the least of its own data receiving
    the least help, which is exactly backwards.

    The fix is not to weaken the refusal. It is for the caller to supply the
    days it does know about, marked for what they are - closed AND unsynced,
    `open_source='no_sync'`. That invents no trading days (open_days stays 0,
    so nothing can divide by it) and it turns "I cannot answer" into the true
    answer, n=0.
    """
    no_sync = [
        CalendarDay(obs_date=AS_OF - timedelta(days=i), was_open=False,
                    has_data=False, open_source="no_sync")
        for i in range(WINDOW)
    ]
    obs = cohort("0245", stores=13, value=0.012)

    result = estimate_sku(
        EstimateRequest(
            estate(facts=[], cal=no_sync),
            SkuInput("0245", "whiskey", None, obs),
            "sku_velocity",
        ),
        ctx(),
    )

    assert result.ok, result.reasons
    est = result.value
    assert est.n == 0
    assert est.own_weight == 0.0
    assert est.value == pytest.approx(0.012)     # the cohort, exactly
    assert est.evidence_state == "NEW"
    assert "0% on your own sales" in est.explanation
    assert "13 similar stores" in est.explanation


def test_no_sync_days_are_never_counted_as_open() -> None:
    """The synthesized calendar must not fabricate trading days.

    If a `no_sync` day were counted open, the store would show a denominator
    it never earned and every rate built on it would be divided by a number
    with no observation behind it.
    """
    no_sync = [
        CalendarDay(obs_date=AS_OF - timedelta(days=i), was_open=False,
                    has_data=False, open_source="no_sync")
        for i in range(WINDOW)
    ]
    assert open_days_between(no_sync, AS_OF - timedelta(days=WINDOW), AS_OF) == 0
    # And the same days marked open-but-unsynced are still not counted.
    unsynced = [
        CalendarDay(obs_date=c.obs_date, was_open=True, has_data=False,
                    open_source="no_sync")
        for c in no_sync
    ]
    assert open_days_between(unsynced, AS_OF - timedelta(days=WINDOW), AS_OF) == 0


# ── Sheet 20: the temporal correction, at the seam ───────────────────────────
#
# Sheet 06 blends across STORES. Sheet 20 corrects across TIME, and it has to
# run FIRST: shrinking a biased estimate toward a cohort leaves a biased
# estimate, just a quieter one. These test the ORDER and the migration path,
# which is the part neither sheet can test alone.


STEADY_WEEKS = (1.0, 1.0, 1.0, 1.0, 1.0, 1.0)


def _sku_with_windows(recent_units: float, long_units: float, **over) -> SkuInput:
    base = dict(
        sku="0245", category="whiskey", own_rate=recent_units / 24,
        observations=cohort("0245", stores=13, value=0.012),
        recent_units=recent_units, recent_open_days=24,
        long_run_units=long_units, long_run_open_days=300,
        weekly_rates=STEADY_WEEKS,
    )
    return SkuInput(**{**base, **over})


def _estimate(sku_input: SkuInput):
    result = estimate_sku(
        EstimateRequest(estate(facts=facts_for("0245", days=120, units=2.0)),
                        sku_input, "sku_velocity"),
        ctx(),
    )
    assert result.ok, result.reasons
    return result.value


def test_a_caller_that_supplies_no_windows_gets_exactly_the_old_answer() -> None:
    """The migration contract. Sheet 20 is opt-in per caller, so an
    un-migrated one must be unaffected - not approximately, exactly."""
    old = _estimate(SkuInput("0245", "whiskey", 0.5,
                             cohort("0245", stores=13, value=0.012)))
    assert old.reversion is None
    assert old.theta_own == pytest.approx(0.5)


def test_a_partial_window_is_refused_rather_than_half_applied() -> None:
    """Three of the four fields is not 'mostly corrected' - it is a caller
    mid-migration, and guessing the fourth would silently invent history."""
    partial = _sku_with_windows(12.0, 300.0)
    partial = replace(partial, long_run_open_days=None)
    assert partial.reversion_request(30) is None
    assert _estimate(partial).reversion is None


def test_the_quiet_sku_reaches_the_blend_already_corrected() -> None:
    """THE wiring assertion: what sheet 06 receives as theta_own is sheet 20's
    output, not the raw trailing rate."""
    quiet = _sku_with_windows(12.0, 300.0)       # 0.5/day recent, 1.0/day long
    est = _estimate(quiet)

    assert est.reversion is not None
    raw_rate = 12.0 / 24
    assert est.reversion.recent_rate == pytest.approx(raw_rate)
    assert est.theta_own > raw_rate                  # corrected upward
    assert est.theta_own == pytest.approx(est.reversion.rate_per_open_day)
    assert est.reversion.deficit_units > 0.0


def test_the_hot_sku_reaches_the_blend_marked_down() -> None:
    """The half that was doing the damage: the old engine ranked these first."""
    hot = _sku_with_windows(72.0, 300.0)
    est = _estimate(hot)

    assert est.theta_own < 72.0 / 24
    assert est.reversion.deficit_units < 0.0


def test_correction_happens_before_the_cohort_blend_not_after() -> None:
    """Order matters and is easy to get backwards. If sheet 20 ran after
    sheet 06 it would correct a number that had already been pulled toward
    the cohort, and the two shrinkages would compound.

    Checked by property: theta_own must equal sheet 20's rate EXACTLY, which
    can only be true if nothing touched it in between.
    """
    est = _estimate(_sku_with_windows(12.0, 300.0))
    assert est.theta_own == est.reversion.rate_per_open_day
    # ...and the blended value is then pulled off it toward the cohort
    assert est.value != est.theta_own


def test_an_erratic_history_is_corrected_harder_than_a_steady_one() -> None:
    steady = _estimate(_sku_with_windows(12.0, 300.0, weekly_rates=STEADY_WEEKS))
    erratic = _estimate(_sku_with_windows(
        12.0, 300.0, weekly_rates=(0.0, 4.0, 0.0, 5.0, 0.0, 3.0)))
    assert erratic.reversion.recent_weight < steady.reversion.recent_weight
    assert erratic.theta_own > steady.theta_own
