"""N7.2 — the two targets as hard gates, per store, never pooled."""

from __future__ import annotations

import pytest

from scripts._gates import (
    MAX_ECE_POINTS,
    MIN_INTERVAL_COVERAGE,
    MAX_NULL_P_VALUE,
    MIN_EDGE_POINTS,
    MIN_NET_MARGIN_PER_MONTH,
    PROMISE_FILL_BAND,
    cost_coverage,
    gate_a,
    gate_b,
    gate_table,
    has_cost_data,
    verdict_for,
)


def store(**over) -> dict:
    """A store that passes everything, so each test can break exactly one thing."""
    base = dict(
        loc="171", name="Bethany",
        promise_fill_ratio=100.0, ece=3.0, interval_coverage=92.0,
        worst_bin_deviation=4.0,
        bt_edge=16.6, bt_p=0.0005,
        # DENOMINATORS. Every rate check now needs one, because a rate without
        # its sample size cannot be told from noise - which is how a store came
        # to fail interval_coverage by 0.05 standard errors.
        cards=183, money_cards30=183, calibration_scored=183,
        interval_considered=183,
        cost=0.95, net30=1500.0, cards_per_run=5.1,
        family_nets={"understock": 14.6},
    )
    return {**base, **over}


# ── Gate A ───────────────────────────────────────────────────────────────────


def test_the_promise_check_never_decides_a_store_either_way() -> None:
    """THIS TEST USED TO ASSERT THE DEFECT, so it is rewritten rather than moved.

    It previously required a 20% store to FAIL on `promise_unbiased`. That is
    what the check did, and the check was comparing two different quantities:
    `sum(gained_units) / sum(promised_units)`, where the numerator is
    actual - expected (a DEVIATION) and the denominator is `deficit_units` (a
    TOTAL restock figure). Verified on the April ledgers - median promised runs
    62-85% of median expected at every store, so the denominator is total-scale
    while the numerator sits around zero.

    It is INVERTED for the dominant card type. A Bethany card forecast 31.4 units
    and sold 30.0 - a near-perfect reorder call - and contributed -8%. The ratio
    being far from 100 therefore carried no information about bias, and the
    ranking it produced ran backwards: Northlake delivered 150% of baseline and
    failed at 60%, Marshfield delivered 141% and passed at 83%.

    Matching the units does not rescue it. Total-against-total the five stores
    read 148-288%, all outside the band, INCLUDING both stores the old check was
    passing. A reorder card's claim is counterfactual - units saved from a
    stockout - and the shown arm cannot measure it at any precision.

    So the check reports NOT TESTABLE at every ratio, and
    `test_the_band_survives_for_the_withheld_arm` keeps the band maths covered.
    """
    # A store that is otherwise sound still passes: removing a check that could
    # only mislead must not take the gate's ability to say yes along with it.
    assert gate_a(store()).passed is True

    for ratio in (20.0, 45.0, 53.0, 84.9, 100.0, 115.1, 300.0):
        result = gate_a(store(promise_fill_ratio=ratio))
        check = next(c for c in result.checks if c.name == "promise_unbiased")
        assert check.passed is None, f"{ratio}% must not decide the gate"
        assert "NOT TESTABLE" in check.detail
        # The figure is still PRINTED. A number nobody can check is worth seeing
        # beside the reason it cannot be checked.
        assert f"{ratio:.0f}%" in check.detail
        assert check not in result.failures
        assert result.passed is True, f"{ratio}% must not fail a sound store"


def test_the_band_survives_for_the_withheld_arm() -> None:
    """The threshold is UNCHANGED and still centred on an unbiased promise.

    Nothing was loosened: `rate_in_band` and `PROMISE_FILL_BAND` stay intact so
    that re-enabling this against the withheld arm is a wiring change rather than
    a re-derivation. A band that had been deleted would have to be argued from
    scratch, and this one was argued once already.
    """
    from app.pipeline.gate.power import rate_in_band

    assert PROMISE_FILL_BAND == (85.0, 115.0)
    assert PROMISE_FILL_BAND[0] < 100.0 < PROMISE_FILL_BAND[1]

    ok, detail = rate_in_band(100.0, total=200,
                              low_bar=PROMISE_FILL_BAND[0],
                              high_bar=PROMISE_FILL_BAND[1],
                              minimum_outcomes=30)
    assert ok is True, detail
    # Confidently below the band is still a failure OF THE BAND, even though no
    # gate consumes that answer today.
    low, _ = rate_in_band(20.0, total=200, low_bar=PROMISE_FILL_BAND[0],
                          high_bar=PROMISE_FILL_BAND[1], minimum_outcomes=30)
    assert low is False


def test_the_band_is_centred_on_an_unbiased_promise() -> None:
    """The point of the replacement. 100% is a promise with no systematic bias,
    and the band must admit it - the check it replaced banded 85-95%, which
    EXCLUDED an unbiased promise and demanded a permanent 5-15% shortfall."""
    assert PROMISE_FILL_BAND[0] < 100.0 < PROMISE_FILL_BAND[1]
    # Still passes - but on the checks that ARE testable, not on the promise
    # ratio, which no longer votes. See
    # `test_the_promise_check_never_decides_a_store_either_way`.
    assert gate_a(store(promise_fill_ratio=100.0)).passed is True


def test_the_old_promise_key_is_not_silently_accepted() -> None:
    """`promise30` held a ratio of TOTALS and was compared against a band written
    for a per-card kept rate. Reading a differently-named field is what makes that
    mix-up unrepeatable: a caller still passing the old key gets "not measured",
    which is NOT a pass, rather than a verdict computed from the wrong statistic.
    """
    stale = store()
    del stale["promise_fill_ratio"]
    stale["promise30"] = 89.0        # would have PASSED the old 85-95 band

    result = gate_a(stale)
    check = next(c for c in result.checks if c.name == "promise_unbiased")
    assert check.passed is None, "a missing measurement is never a pass"
    assert "not measured" in check.detail
    # And the gate does not hold on the strength of the remaining checks alone
    # being silent about it - the store cannot ship on an unmeasured promise.
    assert "promise30" not in str(check.detail)


def test_a_promise_kept_rate_is_not_gated_because_it_cannot_pass() -> None:
    """promise_kept <= hit rate, by arithmetic: a promise of at least one unit can
    only be kept on a card whose increment is at least one unit. With hit rates of
    83 / 76 / 71 / 62 / 49%, banding a kept rate at 85-95% is the accuracy target
    restated as an independent check. No gate A check may carry that name."""
    names = {c.name for c in gate_a(store()).checks}
    assert "promise_kept" not in names


def test_gate_a_fails_on_ece_coverage_and_reliability() -> None:
    assert gate_a(store(ece=MAX_ECE_POINTS)).passed is False
    assert gate_a(store(ece=12.0)).passed is False
    # 80% against a 90% bar on 183 outcomes: the interval clears it, so it fails.
    assert gate_a(store(interval_coverage=80.0)).passed is False
    assert gate_a(store(worst_bin_deviation=15.4)).passed is False


def test_no_check_may_fail_on_a_single_card() -> None:
    """THE defect gate/power.py exists for. Cork Runner failed interval_coverage
    at 89.8% against a 90.0% bar on 59 scored cards. The binomial standard error
    there is 3.9 points, so that is a failure by 0.05 standard errors - and the
    same store PASSED at 90.3% one run earlier with nothing about the engine
    changed between the two numbers."""
    marginal = store(interval_coverage=89.8, interval_considered=59)
    check = next(c for c in gate_a(marginal).checks
                 if c.name == "interval_coverage")
    assert check.passed is None, "one card must not decide a verdict"
    assert "not testable" in check.detail
    assert "straddles" in check.detail


def test_a_genuinely_bad_store_still_fails() -> None:
    """The bar did not move. Only the evidence required to call it failed did, so
    a store that is really below it must still fail - otherwise this change would
    have quietly disabled the check."""
    bad = store(interval_coverage=70.0, interval_considered=120)
    check = next(c for c in gate_a(bad).checks if c.name == "interval_coverage")
    assert check.passed is False
    assert "whole 95% interval" in check.detail
    assert gate_a(bad).passed is False


def test_a_thin_store_reports_not_testable_rather_than_passing() -> None:
    """Below the minimum a Wilson interval is so wide that nothing could ever
    fail, which would silently turn the check into a pass for every thin store."""
    thin = store(interval_coverage=50.0, interval_considered=8)
    check = next(c for c in gate_a(thin).checks if c.name == "interval_coverage")
    assert check.passed is None
    assert "not testable below" in check.detail
    # And each failure names itself.
    failed = {c.name for c in gate_a(store(ece=12.0, interval_coverage=41.0)).failures}
    assert failed == {"calibration_ece", "interval_coverage"}


def test_an_unmeasured_check_is_not_a_pass() -> None:
    """None is NOT a pass. A gate cannot be cleared by failing to measure."""
    result = gate_a(store(ece=None))
    ece = next(c for c in result.checks if c.name == "calibration_ece")
    assert ece.passed is None
    assert "no holdout outcomes" in ece.detail
    # The remaining applicable checks still decide the gate.
    assert result.passed is True
    # But if NOTHING is measurable the gate is None, not True.
    nothing = gate_a({"loc": "x", "name": "y"})
    assert nothing.passed is None


def test_gate_a_applies_to_a_store_with_no_cost_data() -> None:
    """Accuracy does not need cost. Hit rate and promise measure units against a
    product's own recent rate and never touch margin."""
    assert gate_a(store(cost=0.0)).passed is True


# ── Gate B ───────────────────────────────────────────────────────────────────


def test_gate_b_skipped_for_a_store_without_cost() -> None:
    """Five of ten audited stores send no unit cost. No margin, no profit gate."""
    result = gate_b(store(cost=0.0))
    assert result.passed is None, "skipped, which is not a pass and not a fail"
    assert all(c.passed is None for c in result.checks)
    assert all("no cost data" in c.detail for c in result.checks)

    # And such a store can still ship, on accuracy alone, with money unjudged.
    v = verdict_for(store(cost=0.0))
    assert v.shippable is True
    assert v.gate_b.passed is None


def test_gate_b_fails_below_the_monthly_target() -> None:
    assert gate_b(store(net30=MIN_NET_MARGIN_PER_MONTH)).passed is True
    assert gate_b(store(net30=999.0)).passed is False
    assert gate_b(store(net30=-5099.0)).passed is False
    assert any(c.name == "net_margin_per_month"
               for c in gate_b(store(net30=120.0)).failures)


def test_no_cost_store_prints_absence_not_zero() -> None:
    """`s.get("cost") or 1.0` maps a genuine 0.0 to 1.0, which would have shown a
    no-cost store's money columns as if they were measured. Explicit None check."""
    assert cost_coverage({"cost": 0.0}) == 0.0
    assert cost_coverage({"cost": None}) == 1.0     # unknown, assume present
    assert cost_coverage({}) == 1.0
    assert has_cost_data({"cost": 0.0}) is False
    assert has_cost_data({"cost": 0.005}) is False
    assert has_cost_data({"cost": 0.95}) is True

    # The detail string says "no cost data" and never "$0".
    for check in gate_b(store(cost=0.0)).checks:
        assert "no cost data" in check.detail
        assert "$0" not in check.detail


# ── The table ────────────────────────────────────────────────────────────────


def test_failing_store_is_published_not_dropped() -> None:
    """The most useful row on the page is the store where it does not work."""
    stores = [
        store(loc="171", name="Bethany"),
        store(loc="178", name="Marshfield", promise_fill_ratio=20.0,
              net30=-5099.0),
        store(loc="177", name="Mango Jo's", promise_fill_ratio=113.0),
    ]
    table = gate_table(stores)

    assert len(table) == 3, "nothing is dropped"
    locs = [v.loc for v in table]
    assert set(locs) == {"171", "177", "178"}

    # Failures sort FIRST, where they are read.
    assert table[0].shippable is False
    assert table[-1].shippable is True

    marshfield = next(v for v in table if v.loc == "178")
    assert marshfield.verdict == "DO NOT SHIP"
    # On the MONEY gate alone now. `promise_unbiased` no longer votes, so a store
    # that used to fail on both fails on the one real, measured criterion - which
    # is the point: a published reason has to be one a reader can act on, and
    # "your cards earned $318 against a $1,000 bar" is actionable in a way a
    # mis-scaled ratio never was.
    assert "net_margin_per_month" in marshfield.why
    assert "promise_unbiased" not in marshfield.why
    # The figure is still carried, so the verdict can be argued with.
    assert any("20%" in c.detail for c in marshfield.gate_a.checks)


def test_a_passing_store_says_both_gates_hold() -> None:
    v = verdict_for(store())
    assert v.verdict == "SHIP"
    assert v.why == "both gates hold"


def test_the_table_is_deterministic() -> None:
    stores = [store(loc=str(i), promise_fill_ratio=100.0 if i % 2 else 20.0)
              for i in range(6)]
    first = [v.loc for v in gate_table(stores)]
    second = [v.loc for v in gate_table(list(reversed(stores)))]
    assert first == second


def test_every_verdict_serialises_with_its_checks() -> None:
    d = verdict_for(store(promise_fill_ratio=20.0)).as_dict()
    # SHIP, and that is the fix rather than a regression: 20% is what an ACCURATE
    # reorder engine scores on a check that divides an increment by a total, so
    # it may no longer condemn an otherwise sound store.
    assert d["verdict"] == "SHIP"
    assert d["gate_a"]["gate"].startswith("A")
    assert d["gate_b"]["gate"].startswith("B")
    names = {c["name"] for c in d["gate_a"]["checks"]}
    assert names == {"promise_unbiased", "calibration_ece", "interval_coverage",
                     "beats_null", "no_unreliable_confidence"}
    assert all("detail" in c for c in d["gate_a"]["checks"])


def test_the_edge_check_lives_in_the_gate_not_beside_it() -> None:
    """It gated the published page from outside this module, so the report carried
    two rival definitions of the word ship: the index computed one from the edge
    alone while this table computed another from four different checks, for the
    same store, on the same page."""
    assert gate_a(store()).passed is True
    # A big edge that could be luck is not evidence.
    assert gate_a(store(bt_p=0.08)).passed is False
    # A certain edge of half a point is not worth a card.
    assert gate_a(store(bt_edge=0.5)).passed is False
    assert any(c.name == "beats_null"
               for c in gate_a(store(bt_edge=0.5)).failures)
    # And an unmeasured backtest is not a pass.
    unmeasured = store()
    del unmeasured["bt_edge"]
    check = next(c for c in gate_a(unmeasured).checks if c.name == "beats_null")
    assert check.passed is None


def test_the_thresholds_are_the_ones_the_prompt_named() -> None:
    assert PROMISE_FILL_BAND == (85.0, 115.0)
    assert MAX_ECE_POINTS == 5.0
    assert MIN_INTERVAL_COVERAGE == 90.0
    assert MIN_NET_MARGIN_PER_MONTH == 1000.0
    assert MIN_EDGE_POINTS == 5.0
    assert MAX_NULL_P_VALUE == 0.05
