"""Sheet 05 — the cohort prior engine (cold start).

The four tests the sheet calls out as mattering most, plus the ones that
guard the guarantee itself: **estimate_prior must always resolve.** If it can
be made to return ok=False, every downstream stage needs a branch for "no
prior available", and eliminating that branch is the point.

Estate numbers used here are measured: 188 stores across 27 states, 13 of
which hold fewer than 5 stores; 282,068 of 313,990 UPCs (89.8%) are carried by
fewer than 5 stores.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.pipeline import RunContext
from app.pipeline.priors import (
    CohortObservation,
    PriorRequest,
    check,
    dominant_share_pct,
    estimate_prior,
    measure_dispersion,
    members_for,
    region_for,
    rungs_for,
)
from app.pipeline.priors.ladder import Rung

AS_OF = date(2026, 9, 21)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-05", "tenant_id": 46, "store_id": 46, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"priors": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def obs(store: int, value: float, n: int = 1) -> list[CohortObservation]:
    return [CohortObservation((store, store), value) for _ in range(n)]


def estate(states: dict[int, str]) -> list[tuple[tuple[int, int], str | None]]:
    return [((s, s), st) for s, st in states.items()]


# ── The headline guarantee ──────────────────────────────────────────────────


def test_a_store_with_NO_history_still_gets_a_usable_prior() -> None:
    """The sheet's first and most important test. A store that opened
    yesterday contributes nothing and must still receive a sourced answer."""
    newcomer = (999, 999)
    candidates = estate({1: "TX", 2: "TX", 3: "TX", 4: "TX", 5: "TX", 6: "TX"})
    candidates.append((newcomer, "TX"))
    observations = {"*": sum((obs(s, 100.0 + s) for s in range(1, 7)), [])}

    result = estimate_prior(
        PriorRequest(newcomer, "day_of_week", candidates, observations,
                     subject_state="TX"), ctx())

    assert result.ok is True
    assert result.value.basis == "cohort"
    assert result.value.cohort_level == "state"
    assert result.value.cohort_size == 6
    assert result.value.value > 0
    # And the numbers downstream actually reads:
    assert result.provenance.cohort_level == "state"
    assert result.provenance.cohort_size == 6
    assert result.provenance.own_weight == 0.0, "a prior is borrowed, never own"


def test_the_national_rung_always_resolves() -> None:
    """A store in a state with no peers at all still gets an answer."""
    lone = (999, 999)
    candidates = estate(dict.fromkeys(range(1, 8), "TX"))
    candidates.append((lone, "WY"))     # only store in Wyoming, and in the west
    observations = {"*": sum((obs(s, 50.0) for s in range(1, 8)), [])}

    result = estimate_prior(
        PriorRequest(lone, "day_of_week", candidates, observations,
                     subject_state="WY"), ctx())
    assert result.ok is True
    assert result.value.cohort_level == "national"
    assert "state/all_products" in result.value.rungs_rejected


def test_nothing_can_make_it_return_ok_false() -> None:
    """The guarantee, attacked from every angle. Each of these would have been
    a downstream `if prior is None:` branch."""
    cases = [
        ("no candidates at all", PriorRequest((1, 1), "day_of_week", [], {}, "TX")),
        ("no observations", PriorRequest(
            (1, 1), "day_of_week", estate({2: "TX", 3: "TX"}), {}, "TX")),
        ("unmappable state", PriorRequest(
            (1, 1), "day_of_week", estate({2: "TX"}), {"*": obs(2, 5.0)}, "DM")),
        ("blank state", PriorRequest(
            (1, 1), "day_of_week", estate({2: "TX"}), {"*": obs(2, 5.0)}, "")),
        ("None state", PriorRequest(
            (1, 1), "day_of_week", estate({2: "TX"}), {"*": obs(2, 5.0)}, None)),
        ("sku with no sku supplied", PriorRequest(
            (1, 1), "sku_velocity", estate({2: "TX"}), {"*": obs(2, 5.0)}, "TX")),
        ("everybody is the subject", PriorRequest(
            (1, 1), "day_of_week", estate({1: "TX"}), {"*": obs(1, 5.0)}, "TX")),
    ]
    for label, request in cases:
        result = estimate_prior(request, ctx())
        assert result.ok is True, f"{label} must still resolve"
        assert result.value is not None, label
        assert result.value.cohort_level in ("state", "region", "national"), label


def test_the_terminal_floor_is_marked_as_not_a_measurement() -> None:
    """When no real cohort exists anywhere it still resolves - but says so, so
    nothing downstream mistakes it for evidence."""
    result = estimate_prior(
        PriorRequest((1, 1), "day_of_week", [], {}, "TX"), ctx())
    assert result.value.basis == "structural_default"
    assert result.value.cohort_size == 0
    assert result.provenance.evidence_state == "NEW"
    assert result.provenance.own_weight == 0.0
    assert any("structural_default" in r for r in result.reasons)


# ── k-anonymity ─────────────────────────────────────────────────────────────


def test_a_cohort_of_two_is_never_returned_the_ladder_widens_instead() -> None:
    """The sheet's second named test, and a legal boundary."""
    subject = (999, 999)
    # Two Texas peers, six more nationally in other southern states.
    candidates = estate({1: "TX", 2: "TX", 3: "GA", 4: "GA", 5: "FL",
                         6: "FL", 7: "TN", 8: "TN"})
    candidates.append((subject, "TX"))
    observations = {"*": sum((obs(s, 10.0 * s) for s in range(1, 9)), [])}

    result = estimate_prior(
        PriorRequest(subject, "day_of_week", candidates, observations,
                     subject_state="TX"), ctx())

    assert result.value.cohort_level != "state", "2 Texas peers must be refused"
    assert result.value.cohort_size >= 5
    assert "k_anonymity:2<5_distinct_stores" in result.value.rungs_rejected[
        "state/all_products"]


def test_fifty_rows_from_two_stores_is_still_a_cohort_of_two() -> None:
    """k counts STORES, not rows. Collapsing per store first is what makes
    that true - otherwise a two-store cohort with 500 rows sails past."""
    subject = (999, 999)
    candidates = estate({1: "TX", 2: "TX"}) + [(subject, "TX")]
    observations = {"*": obs(1, 10.0, n=25) + obs(2, 12.0, n=25)}
    result = estimate_prior(
        PriorRequest(subject, "day_of_week", candidates, observations, "TX"), ctx())
    assert result.value.cohort_level != "state"


def test_a_cohort_dominated_by_one_store_is_refused() -> None:
    """Five members where one is 96% of the weight is a cohort of one wearing
    a disguise - the mean IS that store's number."""
    heavy = [CohortObservation((1, 1), 100.0, weight=96.0)]
    light = [CohortObservation((s, s), 100.0, weight=1.0) for s in range(2, 6)]
    verdict = check(heavy + light, ctx())
    assert verdict.ok is False
    assert verdict.distinct_stores == 5, "bare k passes..."
    assert "single_store_is" in (verdict.reason or ""), "...the share check does not"


def test_dominant_share_aggregates_per_store_first() -> None:
    many_rows = [CohortObservation((1, 1), 1.0) for _ in range(30)]
    one_each = [CohortObservation((s, s), 1.0) for s in range(2, 6)]
    assert dominant_share_pct(many_rows + one_each) == 88


def test_k_is_a_registry_setting_so_it_is_auditable() -> None:
    result = estimate_prior(
        PriorRequest((999, 999), "day_of_week",
                     estate({1: "TX", 2: "TX"}) + [((999, 999), "TX")],
                     {"*": obs(1, 5.0) + obs(2, 5.0)}, "TX"), ctx())
    assert "priors.k_anonymity.min_stores" in result.provenance.config_keys


# ── The second axis the data forced ─────────────────────────────────────────


def test_a_thin_sku_cohort_widens_to_CATEGORY_not_just_geography() -> None:
    """MEASURED: 282,068 of 313,990 UPCs (89.8%) are carried by fewer than 5
    stores. For sku_velocity, k fails at the NATIONAL rung - the top of the
    geography ladder - so widening the map cannot rescue it. Widening the UNIT
    can: beer spans 71 stores, wine 67, vodka 57."""
    subject = (999, 999)
    candidates = estate(dict.fromkeys(range(1, 9), "TX")) + [(subject, "TX")]
    observations = {
        "RARE_SKU": obs(1, 3.0) + obs(2, 4.0),          # only 2 stores carry it
        "whiskey": sum((obs(s, 20.0 + s) for s in range(1, 9)), []),
    }
    result = estimate_prior(
        PriorRequest(subject, "sku_velocity", candidates, observations,
                     subject_state="TX", sku="RARE_SKU", category="whiskey"), ctx())

    assert result.ok is True
    assert result.value.specificity == "category"
    assert result.value.unit_key == "whiskey"
    assert result.value.cohort_size == 8
    assert any("widened_to_category" in r for r in result.reasons)


def test_geography_is_walked_before_specificity() -> None:
    """A same-state CATEGORY prior beats a national SKU prior: stores in one
    state share tax, licensing and weather, which move demand more than a
    barcode does."""
    ladder = rungs_for("sku_velocity")
    assert ladder[0] == Rung("state", "sku")
    assert ladder[1] == Rung("region", "sku")
    assert ladder[2] == Rung("national", "sku")
    assert ladder[3] == Rung("state", "category")


def test_every_ladder_ends_at_the_terminal_rung() -> None:
    for pattern in ("day_of_week", "weekly_trend", "monthly_seasonality",
                    "sku_velocity", "category_share"):
        for has_region in (True, False):
            ladder = rungs_for(pattern, has_region=has_region)
            assert ladder[-1].is_terminal, f"{pattern} has_region={has_region}"


def test_a_store_pattern_does_not_shred_the_cohort_by_sku() -> None:
    """A day-of-week shape is a property of the STORE. Asking for a per-SKU
    Tuesday effect would thin every cohort for no gain."""
    assert rungs_for("day_of_week")[0] == Rung("state", "all_products")


# ── Dispersion ──────────────────────────────────────────────────────────────


def test_dispersion_is_higher_for_a_disagreeing_cohort() -> None:
    """The sheet's third named test. Sheet 07 turns this into interval width."""
    agreeing = measure_dispersion([100.0, 101.0, 99.0, 100.0, 100.5], ctx())
    disagreeing = measure_dispersion([10.0, 200.0, 45.0, 300.0, 5.0], ctx())

    assert disagreeing.cv_pct > agreeing.cv_pct
    assert disagreeing.iqr > agreeing.iqr
    assert disagreeing.high_dispersion is True
    assert agreeing.high_dispersion is False


def test_dispersion_travels_on_the_prior() -> None:
    subject = (999, 999)
    candidates = estate(dict.fromkeys(range(1, 7), "TX")) + [(subject, "TX")]
    spread = {"*": sum((obs(s, v) for s, v in
                        zip(range(1, 7), [5.0, 300.0, 12.0, 250.0, 8.0, 190.0],
                            strict=True)), [])}
    result = estimate_prior(
        PriorRequest(subject, "day_of_week", candidates, spread, "TX"), ctx())
    assert result.value.dispersion.high_dispersion is True
    assert any("high_dispersion" in r for r in result.reasons)


def test_a_single_store_reports_dispersion_as_UNKNOWN_not_zero() -> None:
    """One store cannot disagree with itself. Reporting 0 would claim perfect
    agreement and produce a confidently narrow interval downstream."""
    d = measure_dispersion([42.0], ctx())
    assert d.cv_pct is None and d.iqr is None
    assert d.high_dispersion is False
    assert d.p50 == 42.0


def test_the_prior_is_the_MEDIAN_so_one_outlier_store_cannot_move_it() -> None:
    subject = (999, 999)
    candidates = estate(dict.fromkeys(range(1, 7), "TX")) + [(subject, "TX")]
    # Five stores near 10, one wild outlier.
    values = [10.0, 11.0, 9.0, 10.5, 9.5, 10_000.0]
    observations = {"*": sum((obs(s, v) for s, v in
                              zip(range(1, 7), values, strict=True)), [])}
    result = estimate_prior(
        PriorRequest(subject, "day_of_week", candidates, observations, "TX"), ctx())
    assert result.value.value < 20, "median holds"
    assert result.value.mean > 1000, "the mean does not - reported for contrast"


# ── Determinism ─────────────────────────────────────────────────────────────


def test_the_same_query_twice_returns_identical_output() -> None:
    """The sheet's fourth named test. Without it replay is meaningless."""
    subject = (999, 999)
    candidates = estate(dict.fromkeys(range(1, 9), "TX")) + [(subject, "TX")]
    observations = {"*": sum((obs(s, 10.0 * s) for s in range(1, 9)), [])}
    request = PriorRequest(subject, "day_of_week", candidates, observations, "TX")

    first = estimate_prior(request, ctx())
    second = estimate_prior(request, ctx())
    assert first.value.as_dict() == second.value.as_dict()
    assert first.same_decision_as(second)


def test_candidate_order_does_not_change_the_answer() -> None:
    subject = (999, 999)
    base = estate(dict.fromkeys(range(1, 9), "TX")) + [(subject, "TX")]
    observations = {"*": sum((obs(s, 10.0 * s) for s in range(1, 9)), [])}

    a = estimate_prior(PriorRequest(subject, "day_of_week", base, observations, "TX"), ctx())
    b = estimate_prior(
        PriorRequest(subject, "day_of_week", list(reversed(base)), observations, "TX"), ctx())
    assert a.value.as_dict() == b.value.as_dict()


# ── Regions ─────────────────────────────────────────────────────────────────


def test_state_names_are_normalised_before_region_lookup() -> None:
    """MEASURED: store 170:170 records its state as "Texas", spelled out. A
    naive two-letter lookup drops it to national for no reason."""
    assert region_for("TX") == "south"
    assert region_for("Texas") == "south"
    assert region_for("texas") == "south"
    assert region_for("  tx  ") == "south"
    assert region_for("DM") is None      # store 190:190's bogus state
    assert region_for("") is None
    assert region_for(None) is None


def test_the_region_rung_is_skipped_when_the_state_cannot_be_placed() -> None:
    ladder = rungs_for("day_of_week", has_region=False)
    assert not any(r.geo_level == "region" for r in ladder)
    assert ladder[-1].is_terminal


def test_members_are_resolved_per_rung() -> None:
    candidates = estate({1: "TX", 2: "GA", 3: "NY", 4: "Texas"})
    assert members_for(Rung("state", "all_products"), "TX", candidates) == ((1, 1), (4, 4))
    assert members_for(Rung("region", "all_products"), "TX", candidates) == (
        (1, 1), (2, 2), (4, 4))
    assert len(members_for(Rung("national", "all_products"), "TX", candidates)) == 4


# ── Housekeeping ────────────────────────────────────────────────────────────


def test_the_subject_store_is_excluded_when_borrowing() -> None:
    subject = (1, 1)
    candidates = estate(dict.fromkeys(range(1, 8), "TX"))
    observations = {"*": sum((obs(s, 10.0) for s in range(1, 8)), [])}
    result = estimate_prior(
        PriorRequest(subject, "day_of_week", candidates, observations, "TX",
                     exclude_self=True), ctx())
    assert result.value.cohort_size == 6, "7 candidates minus the subject"


def test_rungs_tried_and_rejected_are_reported() -> None:
    """A reader must be able to see WHY the answer came from where it did."""
    subject = (999, 999)
    candidates = estate({1: "TX", 2: "TX"}) + [(subject, "TX")] + \
        estate(dict.fromkeys(range(3, 10), "GA"))
    observations = {"*": sum((obs(s, 10.0) for s in range(1, 10)), [])}
    result = estimate_prior(
        PriorRequest(subject, "day_of_week", candidates, observations, "TX"), ctx())
    assert "state/all_products" in result.value.rungs_rejected
    assert result.value.rungs_tried[0] == "state/all_products"


@pytest.mark.parametrize("pattern", [
    "day_of_week", "weekly_trend", "monthly_seasonality",
    "sku_velocity", "category_share",
])
def test_every_pattern_resolves(pattern: str) -> None:
    subject = (999, 999)
    candidates = estate(dict.fromkeys(range(1, 9), "TX")) + [(subject, "TX")]
    observations = {
        "*": sum((obs(s, 10.0 * s) for s in range(1, 9)), []),
        "whiskey": sum((obs(s, 5.0 * s) for s in range(1, 9)), []),
        "0245": sum((obs(s, 2.0 * s) for s in range(1, 9)), []),
    }
    result = estimate_prior(
        PriorRequest(subject, pattern, candidates, observations, "TX",
                     sku="0245", category="whiskey"), ctx())
    assert result.ok is True and result.value.cohort_size >= 5


def test_the_prior_stage_is_well_formed() -> None:
    result = estimate_prior(
        PriorRequest((999, 999), "day_of_week",
                     estate(dict.fromkeys(range(1, 9), "TX")),
                     {"*": sum((obs(s, 1.0) for s in range(1, 9)), [])}, "TX"), ctx())
    assert result.stamped and result.provenance is not None
    assert result.duration_ms >= 0


# ── The guarantee, fuzzed ───────────────────────────────────────────────────


def test_estimate_prior_never_returns_ok_false_under_randomised_input() -> None:
    """The guarantee is structural, so prove it structurally rather than by
    example. 600 randomised shapes - empty estates, bogus states, missing
    units, single-store cohorts, wildly skewed weights - and not one of them
    may produce ok=False, because each would become a downstream
    `if prior is None:` branch that nobody tests.

    Seeded, so a failure is reproducible.
    """
    import random

    rng = random.Random(20260921)
    states = ["TX", "GA", "NY", "CA", "WY", "Texas", "DM", "", None]
    patterns = ["day_of_week", "weekly_trend", "monthly_seasonality",
                "sku_velocity", "category_share"]

    for i in range(600):
        n_stores = rng.randint(0, 12)
        candidates = [((s, s), rng.choice(states)) for s in range(1, n_stores + 1)]
        subject = (999, 999)
        if rng.random() < 0.5:
            candidates.append((subject, rng.choice(states)))

        units = rng.choice([["*"], ["*", "whiskey"], ["whiskey"], ["0245"], []])
        observations = {
            unit: [
                CohortObservation((rng.randint(1, max(1, n_stores)),) * 2,
                                  rng.uniform(-50, 500),
                                  weight=rng.choice([1.0, 0.0, 99.0]))
                for _ in range(rng.randint(0, 9))
            ]
            for unit in units
        }
        request = PriorRequest(
            store_key=subject,
            pattern=rng.choice(patterns),
            candidates=candidates,
            observations=observations,
            subject_state=rng.choice(states),
            sku=rng.choice(["0245", None, ""]),
            category=rng.choice(["whiskey", None, ""]),
            exclude_self=rng.random() < 0.5,
        )
        result = estimate_prior(request, ctx())

        assert result.ok is True, f"case {i} returned ok=False: {result.reasons}"
        assert result.value is not None, f"case {i}"
        assert result.value.cohort_level in ("state", "region", "national"), f"case {i}"
        assert result.value.basis in ("cohort", "structural_default"), f"case {i}"
        # And k is never violated when a real cohort IS returned.
        if result.value.basis == "cohort":
            assert result.value.cohort_size >= 5, f"case {i} leaked a thin cohort"
