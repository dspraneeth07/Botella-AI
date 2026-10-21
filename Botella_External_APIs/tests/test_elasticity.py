"""Sheet 09 — elasticity with an interval, and the refusal that matters."""

from __future__ import annotations

import ast
import inspect
import math
import random
from datetime import date, timedelta

import pytest

from app.pipeline import elasticity as elasticity_package
from app.pipeline.blend import PATTERNS as BLEND_PATTERNS
from app.pipeline.context import RunContext
from app.pipeline.elasticity import (
    PRICE_EFFECT_FAMILIES,
    ElasticityRequest,
    GuardRequest,
    Interval,
    PriceObservation,
    blocked_categories,
    estimate_elasticity,
    filter_price_claims,
    guard_price_claim,
    ols_with_robust_se,
)
from app.pipeline.elasticity.estimate import (
    CRITICAL_VALUE_95,
    MIN_OBSERVATIONS,
    MIN_PRICE_LEVELS,
)
from app.pipeline.evidence import PATTERNS as EVIDENCE_PATTERNS
from app.pipeline.patterns import CANONICAL, canonical
from app.pipeline.priors import PATTERNS as PRIOR_PATTERNS
from app.pipeline.registry import cfg

AS_OF = date(2026, 9, 23)
STORE = (1, 1)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-09", "tenant_id": 1, "store_id": 1, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"elasticity": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def series(
    true_beta: float, *, days: int = 400, noise: float = 0.15,
    price_levels: int = 8, seed: str = "x",
) -> list[PriceObservation]:
    """A synthetic category with a KNOWN elasticity.

    Weekend uplift and log-normal noise, so the fit has to work through the
    same controls it will face on real data.
    """
    # SEPARATE streams for price and noise. Drawing both from one generator
    # couples them through the draw order, and with a weekly control cycling
    # every 7 days that coupling shows up as a spurious elasticity - a true
    # beta of 0.0 came back +0.20 with an interval excluding zero. Which is a
    # neat miniature of this sheet's whole identification problem, but a
    # useless test fixture.
    price_rng = random.Random(f"{seed}-price")
    noise_rng = random.Random(f"{seed}-noise")
    out = []
    for i in range(days):
        day = AS_OF - timedelta(days=i)
        price = round(10.0 * (1 + 0.05 * price_rng.randrange(price_levels)), 2)
        weekend = 1.25 if day.weekday() >= 4 else 1.0
        base = 40.0 * weekend * (price / 10.0) ** true_beta
        units = max(1.0, base * math.exp(noise_rng.gauss(0, noise)))
        out.append(PriceObservation(day, price, units))
    return out


def estimate(observations, **kw):
    return estimate_elasticity(
        ElasticityRequest(STORE, "whiskey", observations, **kw), ctx()
    )


# ── The estimator recovers a known elasticity ────────────────────────────────


@pytest.mark.parametrize("true_beta", [-2.0, -1.5, -1.0, -0.5])
def test_a_synthetic_series_recovers_its_known_elasticity(true_beta) -> None:
    """The sheet's first required test."""
    result = estimate(series(true_beta, seed=f"s{true_beta}"))
    assert result.ok, result.reasons
    value = result.value
    assert value.interval.low <= true_beta <= value.interval.high, (
        f"true {true_beta} outside [{value.interval.low:.3f}, "
        f"{value.interval.high:.3f}]"
    )
    assert value.beta == pytest.approx(true_beta, abs=0.25)


def test_the_interval_is_always_returned_never_a_bare_point() -> None:
    """'A point estimate alone is not an acceptable output.'"""
    value = estimate(series(-1.2)).value
    assert value.interval.low < value.beta < value.interval.high
    assert value.interval.width > 0
    assert set(value.as_dict()) >= {"beta", "interval", "own_interval"}


def test_a_truly_zero_elasticity_produces_an_interval_spanning_zero() -> None:
    """The estimator must not invent an effect that is not there."""
    value = estimate(series(0.0, seed="flat-beta")).value
    assert value.interval.spans_zero
    assert not value.usable


def test_more_noise_widens_the_interval() -> None:
    """The interval has to be doing work, not decoration."""
    tight = estimate(series(-1.5, noise=0.05, seed="t")).value
    loose = estimate(series(-1.5, noise=0.60, seed="l")).value
    assert loose.interval.width > tight.interval.width


# ── Flat prices refuse rather than inventing a beta ──────────────────────────


def test_a_flat_price_series_refuses_rather_than_returning_a_spurious_beta() -> None:
    """The sheet's second required test."""
    rng = random.Random("flat")
    flat = [
        PriceObservation(AS_OF - timedelta(days=i), 9.99,
                         max(1.0, 40 * math.exp(rng.gauss(0, 0.2))))
        for i in range(400)
    ]
    result = estimate(flat)
    assert not result.ok
    assert "price_does_not_vary" in result.reasons[0]
    assert result.value is None, "no beta at all, not a beta with a wide interval"


def test_rounding_noise_is_not_price_variation() -> None:
    """Five 'levels' spanning half a cent are still a flat price."""
    rng = random.Random("noise")
    near_flat = [
        PriceObservation(AS_OF - timedelta(days=i), 9.99 + 0.001 * (i % 5),
                         max(1.0, 40 * math.exp(rng.gauss(0, 0.2))))
        for i in range(400)
    ]
    result = estimate(near_flat)
    assert not result.ok


def test_too_few_observations_refuses() -> None:
    few = [
        PriceObservation(AS_OF - timedelta(days=i), 10.0 + i % 7, 20.0)
        for i in range(30)
    ]
    result = estimate(few)
    assert not result.ok
    assert "too_few_observations" in result.reasons[0]


def test_an_absurd_beta_is_refused_rather_than_reported() -> None:
    """An absurd number with a tight interval is the most dangerous output."""
    result = estimate(series(-30.0, noise=0.01, seed="absurd"))
    assert not result.ok
    assert "implausible_beta" in result.reasons[0]


def test_the_floors_come_from_the_registry() -> None:
    assert MIN_OBSERVATIONS.default == 60
    assert MIN_PRICE_LEVELS.default == 5
    strict = cfg.with_overrides("strict", {MIN_PRICE_LEVELS.name: 99})
    result = estimate_elasticity(
        ElasticityRequest(STORE, "whiskey", series(-1.0)),
        ctx(config_version="strict"), strict,
    )
    assert not result.ok


# ── The guard: the important half ────────────────────────────────────────────


def test_a_zero_spanning_interval_blocks_the_downstream_claim() -> None:
    """The sheet's third required test."""
    unusable = estimate(series(0.0, seed="zero")).value
    assert unusable.interval.spans_zero

    for family in sorted(PRICE_EFFECT_FAMILIES):
        verdict = guard_price_claim(
            GuardRequest(family, "whiskey", unusable), ctx()
        )
        assert not verdict.ok, f"{family} must be blocked"
        assert "elasticity_interval_spans_zero" in verdict.reasons[0]


def test_a_usable_negative_elasticity_permits_the_claim() -> None:
    usable = estimate(series(-1.8, seed="neg")).value
    assert usable.usable
    verdict = guard_price_claim(GuardRequest("markdown", "whiskey", usable), ctx())
    assert verdict.ok
    assert verdict.value.may_cite
    assert verdict.value.beta < 0
    assert "may cite" in verdict.value.explain()


def test_a_positive_elasticity_is_blocked_even_though_it_excludes_zero() -> None:
    """The hole a naive spans-zero test leaves, found on real data.

    Store 122's Tobacco estimates +0.38 [+0.15, +0.61] and store 125's CIGAR
    +0.76 [+0.51, +1.02]. Neither interval spans zero, so a spans-zero test
    passes them - and both are evidence AGAINST the markdown they would be
    cited for. Almost certainly confounding: retail prices rise in exactly the
    periods demand is already high.
    """
    positive = estimate(series(+0.8, seed="pos")).value
    assert not positive.interval.spans_zero, "the naive test would pass this"
    assert not positive.usable, "but it is not a reason to cut price"

    verdict = guard_price_claim(GuardRequest("markdown", "whiskey", positive), ctx())
    assert not verdict.ok
    assert "elasticity_is_positive" in verdict.reasons[0]


def test_a_missing_estimate_blocks_a_price_claim() -> None:
    verdict = guard_price_claim(GuardRequest("markdown", "whiskey", None), ctx())
    assert not verdict.ok
    assert "no_elasticity_estimate" in verdict.reasons[0]


def test_families_that_make_no_price_claim_are_never_blocked() -> None:
    """Blocking them would cost a store recommendations it was entitled to.

    A reorder claims availability, not a demand curve. A store whose prices
    happen not to vary must not lose its reorders.
    """
    for family in ("reorder", "pre_stock", "promote", "endcap", "cold_box",
                   "stock_new"):
        verdict = guard_price_claim(GuardRequest(family, "whiskey", None), ctx())
        assert verdict.ok, f"{family} makes no price claim and must pass"
        assert verdict.value.reason == "family_makes_no_price_claim"


def test_exactly_the_discount_families_are_gated() -> None:
    assert PRICE_EFFECT_FAMILIES == {"markdown", "liquidate", "bundle"}


# ── Filtering a whole run ────────────────────────────────────────────────────


def test_blocked_categories_covers_missing_spanning_and_positive() -> None:
    estimates = {
        "whiskey": estimate(series(-1.8, seed="w")).value,      # usable
        "vodka": estimate(series(0.0, seed="v")).value,         # spans zero
        "cigars": estimate(series(+0.9, seed="c")).value,       # positive
        "gin": None,                                            # no estimate
    }
    blocked = blocked_categories(estimates)
    assert blocked == {"vodka", "cigars", "gin"}
    assert "whiskey" not in blocked


def test_filter_withholds_price_claims_with_a_reason_and_keeps_the_rest() -> None:
    """Withheld, not dropped: the reason travels with the card (sheet 02)."""
    estimates = {
        "whiskey": estimate(series(-1.8, seed="w2")).value,
        "vodka": estimate(series(0.0, seed="v2")).value,
    }
    recs = [
        {"action_type": "markdown", "category": "whiskey"},   # allowed
        {"action_type": "markdown", "category": "vodka"},     # withheld
        {"action_type": "liquidate", "category": "vodka"},    # withheld
        {"action_type": "reorder", "category": "vodka"},      # allowed: no claim
        {"action_type": "cold_box", "category": "vodka"},     # allowed: no claim
    ]
    allowed, withheld = filter_price_claims(recs, estimates)

    assert [r["action_type"] for r in allowed] == ["markdown", "reorder", "cold_box"]
    assert len(withheld) == 2
    assert all(reason for _, reason in withheld), "every refusal states a reason"
    assert all("spans_zero" in reason for _, reason in withheld)


# ── Shrinkage is sheet 06's, not a second implementation ─────────────────────


def test_elasticity_is_a_first_class_pattern_in_the_shared_vocabulary() -> None:
    """Sheet 07's bijection test would fail if it were bolted on."""
    assert "elasticity" in CANONICAL
    assert set(PRIOR_PATTERNS) == set(BLEND_PATTERNS) == set(CANONICAL)
    assert canonical("elasticity") == "elasticity"
    assert "elasticity" in EVIDENCE_PATTERNS


def test_the_cohort_pulls_a_thin_own_estimate_toward_it() -> None:
    """Shrinkage runs through blend(); nothing here re-implements it."""
    thin = series(-0.4, days=150, noise=0.6, price_levels=6, seed="thin")
    alone = estimate(thin).value
    blended = estimate(
        thin, cohort_beta=-2.0,
        cohort_interval=Interval(-2.3, -1.7),
        cohort_level="state", cohort_size=40,
    ).value

    assert alone.own_weight == 1.0
    assert blended.own_weight < 1.0
    assert blended.own_beta == pytest.approx(alone.own_beta)
    assert blended.beta < alone.beta, "pulled toward the cohort's -2.0"
    assert blended.cohort_level == "state"


def test_the_interval_endpoints_shrink_with_the_point_estimate() -> None:
    """Shrinking only the centre would leave an interval describing an
    estimate that is no longer being reported."""
    thin = series(-0.4, days=150, noise=0.6, price_levels=6, seed="thin2")
    blended = estimate(
        thin, cohort_beta=-2.0, cohort_interval=Interval(-2.1, -1.9),
        cohort_level="state", cohort_size=40,
    ).value
    assert blended.interval.low < blended.beta < blended.interval.high
    # Each endpoint is a CONVEX COMBINATION of the own and cohort endpoints -
    # it lies between them, in whichever direction the cohort sits. Asserting
    # it merely narrows toward zero would be wrong: this cohort is centred at
    # -2.0, so shrinkage moves both endpoints DOWN.
    for blended_end, own_end, cohort_end in (
        (blended.interval.low, blended.own_interval.low, -2.1),
        (blended.interval.high, blended.own_interval.high, -1.9),
    ):
        assert min(own_end, cohort_end) - 1e-9 <= blended_end <= max(
            own_end, cohort_end) + 1e-9


def test_a_cohort_can_rescue_an_unidentified_own_estimate_and_says_so() -> None:
    """A judgement call, recorded rather than left implicit.

    A thin own estimate whose interval spans zero, shrunk toward a confident
    cohort, can come back with an interval that EXCLUDES zero - and the guard
    will then let a markdown cite it. Is that legitimate?

    Under this architecture, yes: borrowing from a cohort is what sheets 05
    and 06 exist for, it is the same mechanism that serves a brand-new store,
    and `own_weight` says out loud how much of the answer is the store's own.
    `elasticity.min_own_weight_to_cite` exists so that choice is visible and
    tunable rather than buried - it is 0 today, and raising it would mean
    refusing to borrow, which would contradict the cold-start design.

    What must NOT happen is the borrowing being invisible. This test pins
    that: the own interval still spans zero, and the record still says so.
    """
    thin = series(-0.4, days=150, noise=0.6, price_levels=6, seed="rescue")
    blended = estimate(
        thin, cohort_beta=-2.0, cohort_interval=Interval(-2.1, -1.9),
        cohort_level="state", cohort_size=40,
    ).value

    assert blended.own_interval.spans_zero, "the store's own data identifies nothing"
    assert not blended.interval.spans_zero, "the cohort carries it"
    assert blended.own_weight < 0.3, "and the record says it is mostly borrowed"
    assert blended.cohort_level == "state" and blended.cohort_size == 40


def test_nothing_in_the_package_reimplements_a_weighted_average() -> None:
    """The sheet says so explicitly: use blend(), do not write a second one."""
    for module in (elasticity_package.estimate_elasticity.__module__,
                   elasticity_package.guard_price_claim.__module__):
        source = inspect.getsource(__import__(module, fromlist=["_"]))
        tree = ast.parse(source)
        names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
        assert "shrink" not in names
    from app.pipeline.elasticity import estimate as estimate_module
    assert "blend" in inspect.getsource(estimate_module)


# ── The regression itself ────────────────────────────────────────────────────


def test_ols_recovers_a_known_linear_relationship() -> None:
    design = [[1.0, float(x)] for x in range(50)]
    y = [3.0 + 2.0 * x for x in range(50)]
    coefficients, standard_errors, r_squared = ols_with_robust_se(design, y)
    assert coefficients[0] == pytest.approx(3.0, abs=1e-6)
    assert coefficients[1] == pytest.approx(2.0, abs=1e-6)
    assert r_squared == pytest.approx(1.0, abs=1e-9)
    assert all(se >= 0 for se in standard_errors)


def test_ols_returns_none_on_a_singular_design() -> None:
    """A collinear design is a data condition to report, not a crash."""
    design = [[1.0, 2.0, 4.0] for _ in range(50)]   # column 2 == 2 * column 1
    assert ols_with_robust_se(design, [1.0] * 50) is None


def test_ols_returns_none_when_there_are_fewer_rows_than_columns() -> None:
    assert ols_with_robust_se([[1.0, 2.0, 3.0]], [1.0]) is None


def test_the_critical_value_is_conservative_for_every_accepted_fit() -> None:
    """One multiplier replaces a lookup table only because it errs WIDE.

    t at 30 df is 2.042 and t decreases as df rises, so for every fit the
    stage accepts (>= 30 residual df) this is at least as wide as exact.
    """
    assert CRITICAL_VALUE_95.default == 2.042
    assert CRITICAL_VALUE_95.status == "MEASURED"
    assert "wide" in CRITICAL_VALUE_95.why


# ── Stage 14: decision validation enforces it ────────────────────────────────


def _recs() -> list[dict]:
    return [
        {"action_type": "markdown", "category": "whiskey", "confidence": 0.8,
         "primary_skus": ["A"], "rank": 1},
        {"action_type": "markdown", "category": "vodka", "confidence": 0.9,
         "primary_skus": ["B"], "rank": 2},
        {"action_type": "reorder", "category": "vodka", "confidence": 0.7,
         "primary_skus": ["C"], "rank": 3},
    ]


def test_decision_validation_withholds_an_unsupported_markdown() -> None:
    """The sheet: 'make sure stage 14 (decision validation) enforces it'."""
    from app.recommender.validator import _withhold_unsupported_price_claims

    estimates = {
        "whiskey": estimate(series(-1.8, seed="v-w")).value,   # usable
        "vodka": estimate(series(0.0, seed="v-v")).value,      # spans zero
    }
    kept, withheld = _withhold_unsupported_price_claims(_recs(), estimates)

    assert [r["category"] for r in kept] == ["whiskey", "vodka"]
    assert [r["action_type"] for r in kept] == ["markdown", "reorder"]
    assert len(withheld) == 1
    rec, reason = withheld[0]
    assert rec["category"] == "vodka" and rec["action_type"] == "markdown"
    assert "spans_zero" in reason
    assert rec["withheld_reason"] == reason, "the reason travels with the card"


def test_no_elasticity_evidence_at_all_blocks_every_price_claim() -> None:
    """The safe default. A markdown with nothing behind its price claim is
    exactly what this sheet exists to stop."""
    from app.recommender.validator import _withhold_unsupported_price_claims

    kept, withheld = _withhold_unsupported_price_claims(_recs(), {})
    assert [r["action_type"] for r in kept] == ["reorder"]
    assert len(withheld) == 2
    assert all(r["withheld_reason"] == "no_elasticity_estimate"
               for r, _ in withheld)


def test_the_gate_is_off_until_a_caller_opts_in() -> None:
    """`enforce_elasticity=False` keeps existing callers working unchanged.

    Turning a store-wide markdown block on by default, before any caller
    supplies elasticity evidence, would silently delete most of the
    recommendations the engine produces today.
    """
    from app.recommender.validator import validate_recommendations

    signature = inspect.signature(validate_recommendations)
    assert signature.parameters["enforce_elasticity"].default is False
    assert signature.parameters["elasticity_by_category"].default is None


# ── Every pattern's handler must actually run ────────────────────────────────


def test_every_evidence_pattern_handler_runs_without_crashing() -> None:
    """The gap the bijection test left.

    Sheet 07's `test_the_three_sheets_agree_on_the_pattern_vocabulary` proves
    the four modules AGREE on the list of patterns. It does not prove each
    pattern's handler works - and sheet 09's `_count_elasticity` shipped
    constructing `EvidenceCount` without four of its required arguments.

    It failed silently: the @stage envelope catches the TypeError and returns
    ok=False with an `exception:` reason, which reads exactly like a legitimate
    refusal. Nothing in the suite called it, so nothing noticed.

    This walks the whole vocabulary, so adding a seventh pattern without a
    working handler fails here rather than in production.
    """
    from app.pipeline.evidence import EvidenceRequest, count_evidence
    from app.pipeline.features.store import CalendarDay, DayFact
    from app.pipeline.patterns import for_evidence

    days = 420
    calendar = [
        CalendarDay(AS_OF - timedelta(days=i), was_open=True, has_data=True)
        for i in range(days)
    ]
    facts = [
        DayFact(obs_date=AS_OF - timedelta(days=i), sku="A",
                units_sold=3.0, price=10.0 + (i % 9))
        for i in range(days)
    ]

    for pattern in (for_evidence(p) for p in CANONICAL):
        result = count_evidence(
            EvidenceRequest(pattern, calendar, facts, window_days=364,
                            sku="A", category="whiskey",
                            category_by_sku={"A": "whiskey"}),
            ctx(),
        )
        assert result.ok, f"{pattern}: {result.reasons}"
        assert not any("exception:" in r for r in (result.reasons or ())), (
            f"{pattern} raised inside the envelope: {result.reasons}"
        )
        assert result.value.pattern == pattern
        assert isinstance(result.value.n, int)
        # The four fields that were missing, exercised on every handler.
        assert result.value.as_dict()["open_days_in_window"] >= 0
        assert result.value.as_dict()["start_date"] <= result.value.as_dict()["end_date"]


def test_elasticity_evidence_counts_price_levels_not_days() -> None:
    """n is the identifying variation, not the sample size."""
    from app.pipeline.evidence import EvidenceRequest, count_evidence
    from app.pipeline.features.store import CalendarDay, DayFact

    days = 300
    calendar = [
        CalendarDay(AS_OF - timedelta(days=i), was_open=True, has_data=True)
        for i in range(days)
    ]
    # 300 days, but only 4 distinct prices.
    facts = [
        DayFact(obs_date=AS_OF - timedelta(days=i), sku="A",
                units_sold=3.0, price=10.0 + (i % 4))
        for i in range(days)
    ]
    result = count_evidence(
        EvidenceRequest("elasticity", calendar, facts, window_days=364, sku="A"),
        ctx(),
    )
    assert result.ok
    assert result.value.n == 4, "four price levels, not three hundred days"
    assert result.value.breakdown["usable_observations"] == days
    assert result.value.sufficiency == "insufficient"


# ── Statistically real is not the same as economically right ─────────────────


def test_an_inelastic_estimate_is_blocked_even_with_a_tight_interval() -> None:
    """The constraint that actually binds on real data.

    A beta of -0.5 with an interval nowhere near zero is a solid, honest
    estimate: a 10% price cut moves 5% more volume. Acting on it gives up ten
    points of price to buy five of volume, which LOSES revenue.

    Measured: 79 of the 84 cells whose interval excluded zero were still
    inside unit elasticity. Store 171's Vodka is -0.107 [-0.21,-0.00] - a 10%
    cut buys 1.1% more volume and surrenders about 9% of revenue. The
    zero-spanning test passes it; profitability does not.
    """
    weak = estimate(series(-0.5, seed="weak")).value
    assert not weak.interval.spans_zero, "a solid estimate, statistically"
    assert weak.interval.entirely_below_zero
    assert not weak.usable, "and still not a reason to discount"

    verdict = guard_price_claim(GuardRequest("markdown", "whiskey", weak), ctx())
    assert not verdict.ok
    assert "elasticity_is_inelastic" in verdict.reasons[0]
    assert "loses_revenue" in verdict.reasons[0]


def test_unit_elasticity_is_the_revenue_break_even_and_is_measured() -> None:
    """Arithmetic, not judgement: at |beta| = 1 revenue is flat."""
    from app.pipeline.elasticity.estimate import UNIT_ELASTIC

    assert UNIT_ELASTIC.default == 1
    assert UNIT_ELASTIC.status == "MEASURED"
    assert "break-even" in UNIT_ELASTIC.why
    assert "STRICTER" in UNIT_ELASTIC.why, (
        "margin break-even is stricter than revenue break-even and the "
        "setting must say so, or this reads as the whole test"
    )


def test_the_threshold_comes_from_the_registry() -> None:
    """Relaxing it admits the inelastic cells - proof nothing is hardcoded."""
    weak = estimate(series(-0.5, seed="weak2")).value
    assert not weak.usable

    from app.pipeline.elasticity.estimate import UNIT_ELASTIC
    lenient = cfg.with_overrides("lenient", {UNIT_ELASTIC.name: 0})
    verdict = guard_price_claim(
        GuardRequest("markdown", "whiskey", weak),
        ctx(config_version="lenient"), lenient,
    )
    assert verdict.ok, "with the floor at zero, the old rule applies again"


def test_an_elastic_estimate_still_passes() -> None:
    strong = estimate(series(-2.0, seed="strong")).value
    assert strong.usable
    assert guard_price_claim(
        GuardRequest("markdown", "whiskey", strong), ctx()
    ).ok


def test_explain_is_never_empty_on_any_outcome() -> None:
    """A blank on an owner-facing card is what sheet 02 outlawed.

    The first version computed a redundant percentage and returned "" when it
    rounded to zero, so a genuine estimate with a small beta rendered blank -
    reached by arithmetic rather than by a missing field.
    """
    from app.pipeline.elasticity.estimate import Elasticity

    def make(beta, low, high):
        return Elasticity(STORE, "whiskey", beta, Interval(low, high), beta,
                          Interval(low, high), 1.0, 300, 12, 8.0, 0.4, None, None)

    cases = [
        make(-1.8, -2.4, -1.2),     # usable
        make(-0.3, -1.1, 0.5),      # spans zero
        make(+0.7, 0.5, 0.9),       # positive
        make(-0.02, -0.04, -0.001),  # tiny but entirely negative
    ]
    for value in cases:
        text = value.explain()
        assert text and text.strip(), f"empty explanation for beta={value.beta}"
        assert value.category in text


def test_a_positive_elasticity_says_so_rather_than_claiming_no_effect() -> None:
    """'No effect' would be a different untruth - the interval excludes zero."""
    from app.pipeline.elasticity.estimate import Elasticity

    positive = Elasticity(STORE, "cigars", 0.7, Interval(0.5, 0.9), 0.7,
                          Interval(0.5, 0.9), 1.0, 300, 12, 8.0, 0.4, None, None)
    text = positive.explain()
    assert "WITH price" in text
    assert "includes no effect" not in text
