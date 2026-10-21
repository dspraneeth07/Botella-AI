"""Sheet 20 — temporal shrinkage, and the defect it exists to kill.

The arithmetic is four lines, so these tests are mostly not about arithmetic.
They are about the failure mode: the engine used to rank on the trailing rate,
which SELECTS the SKUs whose recent window is most inflated, which are exactly
the ones that fall back next month. Measured on Bethany that ordering scored a
39.3% hit rate and MINUS $13,783 of realised margin.

`test_ranking_on_raw_rate_is_anti_correlated_and_reversion_fixes_it` rebuilds
that situation from first principles and fails if the sign ever comes back. It
is the test this sheet is for; everything else guards a way of breaking it.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.pipeline import RunContext
from app.pipeline.blend import (
    MATERIALITY_FLOOR_UNITS,
    MIN_HIT_PROBABILITY,
    ReversionRequest,
    dispersion_cv,
    effective_observations,
    is_recommendable,
    revert,
    steadiness_of,
)
from app.pipeline.blend.reversion import VELOCITY_PATTERN
from app.pipeline.registry import cfg

AS_OF = date(2026, 9, 21)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-20", "tenant_id": 171, "store_id": 171, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"temporal_reversion": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def req(recent_units: float, long_units: float, *, sku: str = "SKU-1",
        recent_days: int = 24, long_days: int = 300,
        weekly: tuple[float, ...] = (), horizon: int = 30) -> ReversionRequest:
    return ReversionRequest(
        sku=sku, recent_units=recent_units, recent_open_days=recent_days,
        long_run_units=long_units, long_run_open_days=long_days,
        weekly_rates=weekly, horizon_days=horizon,
    )


STEADY = (1.0, 1.0, 1.0, 1.0, 1.0, 1.0)
ERRATIC = (0.0, 4.0, 0.0, 5.0, 0.0, 3.0)


# ── The direction of the correction ──────────────────────────────────────────


def test_a_quiet_recent_window_is_revised_upward() -> None:
    """The whole point. 24 units recently, but 300 over the long run: the
    recent window caught a lull and under-states what to expect."""
    out = revert(req(24.0, 300.0, weekly=STEADY), ctx()).value
    assert out.recent_rate == pytest.approx(1.0)
    assert out.long_run_rate == pytest.approx(1.0)
    # equal rates -> no correction at all
    assert out.uplift == pytest.approx(1.0)

    quiet = revert(req(12.0, 300.0, weekly=STEADY), ctx()).value
    assert quiet.recent_rate < quiet.long_run_rate
    assert quiet.rate_per_open_day > quiet.recent_rate
    assert quiet.uplift > 1.0
    assert quiet.deficit_units > 0.0


def test_an_inflated_recent_window_is_revised_downward() -> None:
    """The half nobody asks for and the half that was doing the damage. A SKU
    running hot gets a NEGATIVE deficit, which is how it stops being ranked
    first."""
    hot = revert(req(72.0, 300.0, weekly=STEADY), ctx()).value
    assert hot.recent_rate > hot.long_run_rate
    assert hot.rate_per_open_day < hot.recent_rate
    assert hot.uplift < 1.0
    assert hot.deficit_units < 0.0


def test_the_estimate_is_always_between_the_two_rates() -> None:
    """A shrinkage estimate that leaves the interval is not a shrinkage
    estimate. Checked across a wide sweep rather than at a chosen point."""
    for recent in (0.0, 6.0, 24.0, 60.0, 240.0):
        for long_units in (0.0, 50.0, 300.0, 1200.0):
            out = revert(req(recent, long_units, weekly=STEADY), ctx()).value
            lo = min(out.recent_rate, out.long_run_rate)
            hi = max(out.recent_rate, out.long_run_rate)
            assert lo - 1e-9 <= out.rate_per_open_day <= hi + 1e-9


# ── Dispersion decides how hard to shrink ────────────────────────────────────


def test_an_erratic_sku_is_shrunk_harder_than_a_steady_one() -> None:
    """Identical totals, different shapes. The erratic one's recent window
    carries less information, so it moves further toward the long run."""
    steady = revert(req(12.0, 300.0, weekly=STEADY), ctx()).value
    erratic = revert(req(12.0, 300.0, weekly=ERRATIC), ctx()).value

    assert erratic.dispersion_cv > steady.dispersion_cv
    assert erratic.effective_observations < steady.effective_observations
    assert erratic.recent_weight < steady.recent_weight
    # shrunk harder toward the (higher) long-run rate
    assert erratic.rate_per_open_day > steady.rate_per_open_day
    # ...but trusted LESS, which is the half that keeps it off the card
    assert erratic.p_hit < steady.p_hit


def test_unmeasured_dispersion_is_pessimistic_never_optimistic() -> None:
    """A SKU with too little history must be ranked DOWN, not up. Returning a
    cv of zero would have made the unknown look like the steadiest seller in
    the shop."""
    unknown = revert(req(12.0, 300.0, weekly=()), ctx()).value
    perfect = revert(req(12.0, 300.0, weekly=STEADY), ctx()).value

    assert unknown.dispersion_measured is False
    assert perfect.dispersion_measured is True
    assert unknown.dispersion_cv > perfect.dispersion_cv
    assert unknown.p_hit < perfect.p_hit


def test_too_few_weekly_buckets_falls_back_rather_than_pretending() -> None:
    """Two buckets can produce a confident-looking cv that means nothing."""
    out = revert(req(12.0, 300.0, weekly=(1.0, 3.0)), ctx()).value
    assert out.dispersion_measured is False


def test_dispersion_cv_returns_none_rather_than_zero_when_unmeasurable() -> None:
    assert dispersion_cv(()) is None
    assert dispersion_cv((2.0,)) is None
    assert dispersion_cv((0.0, 0.0, 0.0)) is None      # mean zero, not steady
    assert dispersion_cv((1.0, 1.0, 1.0)) == pytest.approx(0.0)


def test_effective_observations_deflates_by_overdispersion() -> None:
    assert effective_observations(24.0, 0.0) == pytest.approx(24.0)
    assert effective_observations(24.0, 1.0) == pytest.approx(12.0)
    assert effective_observations(24.0, 2.0) == pytest.approx(4.8)
    assert steadiness_of(0.0) == pytest.approx(1.0)
    assert steadiness_of(1.0) == pytest.approx(0.5)


# ── Division, closure, and the guards sheet 19 had to learn ──────────────────


def test_a_shut_store_yields_zero_rate_not_infinity() -> None:
    """Sheet 19 shipped an unguarded divide that turned a closed store's lift
    into Infinity and then into 'this did nothing'. Both windows, here."""
    out = revert(req(0.0, 300.0, recent_days=0), ctx()).value
    assert out.recent_rate == 0.0
    assert out.uplift == 1.0                     # no claim, not an infinite one
    out2 = revert(req(24.0, 0.0, long_days=0), ctx()).value
    assert out2.long_run_rate == 0.0


def test_no_sales_anywhere_is_finite_and_immaterial() -> None:
    out = revert(req(0.0, 0.0), ctx()).value
    assert out.rate_per_open_day == 0.0
    assert out.deficit_units == 0.0
    assert out.material is False


def test_negative_windows_are_refused_at_the_boundary() -> None:
    with pytest.raises(ValueError):
        req(10.0, 10.0, recent_days=-1)


# ── Materiality and the recommendation gate ──────────────────────────────────


def test_materiality_floor_excludes_the_sku_that_sold_once() -> None:
    """Without this the selection's median pick sold ONE unit in 28 days: the
    ratio r_long/r_recent is noise amplified by division down there."""
    floor = float(cfg.get(MATERIALITY_FLOOR_UNITS, ctx()))
    tiny = revert(req(1.0, 300.0, weekly=STEADY), ctx()).value
    assert tiny.material is False
    assert is_recommendable(tiny, ctx()) is False

    big = revert(req(floor, 300.0, weekly=STEADY), ctx()).value
    assert big.material is True


def test_a_falling_sku_is_never_recommendable() -> None:
    """The defect, at the gate. A SKU running above its long-run rate has
    p_hit below the floor and cannot become a card however large it is."""
    hot = revert(req(300.0, 300.0 * 2, weekly=STEADY, long_days=600),
                 ctx()).value
    assert hot.material is True                  # plenty big
    assert hot.deficit_units < 0.0               # but heading down
    assert is_recommendable(hot, ctx()) is False


def test_a_perfectly_steady_decliner_is_caught_by_the_floor_itself() -> None:
    """The trap the AVERAGE form could not catch, and the product form does.

    p_hit used to average a squashed uplift with steadiness. An average lets
    either term carry a candidate alone, and steadiness alone is not evidence
    of anything - a perfectly steady seller has steadiness = 1.0 whether it is
    climbing or dying. So cv = 0 forced p_hit >= 0.5 however hard the SKU was
    falling, and only the direction gate kept it off a card.

    The product form cannot do that: a low uplift drags the whole score down.
    Both guards are asserted here, because the floor doing its job is not a
    reason to remove the explicit one.
    """
    dying = revert(req(300.0, 600.0, weekly=STEADY, long_days=600), ctx()).value
    floor = float(cfg.get(MIN_HIT_PROBABILITY, ctx()))

    assert dying.steadiness == pytest.approx(1.0)   # as steady as it gets
    assert dying.material is True                   # and plenty big
    assert dying.deficit_units < 0.0                # but heading down

    assert dying.p_hit < floor, (
        "the floor must catch a steady decliner on its own now - that is the "
        "whole point of multiplying rather than averaging"
    )
    assert is_recommendable(dying, ctx()) is False


def test_the_floor_reads_as_a_plain_sentence() -> None:
    """p_hit >= 0.5 is exactly uplift * steadiness >= 1.

    Which is: the long-run rate must exceed the recent rate by at least
    (1 + cv). An erratic SKU has to be further depressed than a steady one to
    qualify. A threshold a person can say out loud is one they can argue with.
    """
    for cv_weeks, label in ((STEADY, "steady"), (ERRATIC, "erratic")):
        out = revert(req(12.0, 300.0, weekly=cv_weeks), ctx()).value
        s = out.uplift * out.steadiness
        assert out.p_hit == pytest.approx(s / (1.0 + s)), label
        assert (out.p_hit >= 0.5) == (s >= 1.0), label


def test_p_hit_floor_is_a_real_gate_not_a_formality() -> None:
    floor = float(cfg.get(MIN_HIT_PROBABILITY, ctx()))
    assert 0.0 < floor < 1.0
    erratic_and_falling = revert(
        req(200.0, 300.0, weekly=ERRATIC, long_days=600), ctx()).value
    assert erratic_and_falling.p_hit < floor


# ── p_hit is a probability shape, and is NOT confidence ──────────────────────


def test_p_hit_stays_inside_zero_and_one_under_extremes() -> None:
    """It multiplies a score, so an unbounded value would let one SKU with a
    freak ratio dominate every ordering — which is exactly how the tuned
    version of this collapsed from 74% to 50%."""
    for recent, long_units in ((0.5, 5000.0), (5000.0, 0.5), (1.0, 1.0),
                               (0.0, 5000.0), (5000.0, 0.0)):
        out = revert(req(recent, long_units, weekly=ERRATIC), ctx()).value
        assert 0.0 <= out.p_hit <= 1.0


def test_p_hit_is_not_exposed_as_confidence() -> None:
    """Sheet 08 measured stated confidence at 0.48 against a 0.23 hit rate.
    p_hit is ORDERED but not numerically calibrated, so a caller must not be
    able to reach for it by that name and print it on a card."""
    out = revert(req(12.0, 300.0, weekly=STEADY), ctx()).value
    assert not hasattr(out, "confidence")
    assert not hasattr(out, "calibrated_confidence")
    assert "confidence" not in out.as_dict()


def test_explanation_never_invents_a_figure_it_did_not_compute() -> None:
    """Two fabricated-dollar defects have already shipped on this engine."""
    quiet = revert(req(12.0, 300.0, weekly=STEADY), ctx()).value
    text = quiet.explain()
    assert f"{quiet.deficit_units:.0f}" in text
    assert "$" not in text

    tiny = revert(req(1.0, 300.0, weekly=STEADY), ctx()).value
    assert "$" not in tiny.explain()
    hot = revert(req(72.0, 300.0, weekly=STEADY), ctx()).value
    assert "$" not in hot.explain()


# ── Determinism, and the batch-relative score that must not come back ────────


def test_scoring_depends_only_on_this_candidates_own_history() -> None:
    """An earlier version scored a candidate by its percentile among the rest
    of the batch. It measured well and is unshippable: the same SKU on the
    same data would score differently depending on its company."""
    one = revert(req(12.0, 300.0, sku="A", weekly=STEADY), ctx()).value
    again = revert(req(12.0, 300.0, sku="A", weekly=STEADY), ctx()).value
    assert one.as_dict() == again.as_dict()


def test_two_runs_over_one_snapshot_agree() -> None:
    a = revert(req(12.0, 300.0, weekly=ERRATIC), ctx(run_id="r1")).value
    b = revert(req(12.0, 300.0, weekly=ERRATIC), ctx(run_id="r2")).value
    assert a.as_dict() == b.as_dict()


def test_k_is_sheet_06s_and_is_not_redeclared() -> None:
    """One k for 'how fast a SKU's own velocity becomes trustworthy'. A second
    declaration would let the two axes drift apart silently."""
    from app.pipeline.blend.shrink import K_BY_PATTERN

    assert VELOCITY_PATTERN in K_BY_PATTERN
    assert K_BY_PATTERN[VELOCITY_PATTERN].name == "shrink.k.sku_velocity"


# ── THE TEST THIS SHEET EXISTS FOR ───────────────────────────────────────────


def _population() -> list[tuple[float, float, float]]:
    """(recent_units, long_run_units, next_period_units) for a synthetic shop.

    Built from the one property the audit established on real data: a SKU's
    next period tracks its LONG-RUN rate, not its trailing four weeks. So the
    outcome is generated from the long-run rate and the recent window is
    noise around it — which is the situation the old ranker inverted.
    """
    out: list[tuple[float, float, float]] = []
    for i in range(40):
        long_rate = 1.0 + (i % 8)                  # units per open day
        long_units = long_rate * 300
        # half the shop is running hot, half is running quiet
        recent_rate = long_rate * (1.6 if i % 2 == 0 else 0.5)
        recent_units = recent_rate * 24
        # what actually happens next: the long-run rate, near enough
        actual = long_rate * 30
        out.append((recent_units, long_units, actual))
    return out


def test_ranking_on_raw_rate_is_anti_correlated_and_reversion_fixes_it() -> None:
    """The defect, end to end.

    A "hit" is: the SKU sold at least what its trailing window implied. Rank
    the same shop two ways and count hits in the top ten.

    Ranking on the raw trailing rate picks the hot half — every one of which
    falls back. Ranking on the corrected estimate picks the quiet half. On
    real data this was 39.3% against 68.7%, and minus $13,783 against plus
    $14,508 of realised margin.
    """
    pop = _population()
    rows = []
    for idx, (recent_units, long_units, actual) in enumerate(pop):
        out = revert(req(recent_units, long_units, sku=f"S{idx}",
                         weekly=STEADY), ctx()).value
        implied = out.recent_rate * 30
        rows.append({
            "raw_rate": out.recent_rate,
            "reverted": out.p_hit,
            "recommendable": is_recommendable(out, ctx()),
            "hit": actual >= implied,
        })

    def hits(key: str, n: int = 10) -> int:
        top = sorted(rows, key=lambda r: r[key], reverse=True)[:n]
        return sum(1 for r in top if r["hit"])

    old_engine = hits("raw_rate")
    new_engine = hits("reverted")

    # The old ordering does not merely underperform - it is anti-correlated.
    assert old_engine == 0, (
        f"ranking on the raw trailing rate scored {old_engine}/10; it is "
        "supposed to be structurally wrong, so a non-zero score means the "
        "fixture no longer reproduces the defect"
    )
    assert new_engine >= 9, f"reversion ordering scored only {new_engine}/10"

    # And the gate refuses the falling half outright, rather than merely
    # ranking it lower - a card that appears at position 40 is still a card.
    gated = [r for r in rows if r["recommendable"]]
    assert gated, "the gate rejected everything"
    assert all(r["hit"] for r in gated), (
        "every recommendation that passed the gate should have been a hit in "
        "a population where the outcome tracks the long-run rate"
    )


def test_the_gate_trades_coverage_for_precision_in_the_right_direction() -> None:
    """Raising the floor must reduce coverage. If it ever raised coverage the
    floor would not be a floor, and the dial in the documentation would be a
    lie."""
    pop = _population()
    reverted = [
        revert(req(r, lo, sku=f"S{i}", weekly=STEADY), ctx()).value
        for i, (r, lo, _) in enumerate(pop)
    ]
    counts = []
    for floor in (0.0, 0.5, 0.6, 0.7):
        version = f"floor-{floor}"
        tuned = cfg.with_overrides(version, {MIN_HIT_PROBABILITY.name: floor})
        c = ctx(config_version=version)
        counts.append(sum(1 for x in reverted if is_recommendable(x, c, tuned)))
    assert counts == sorted(counts, reverse=True), counts
