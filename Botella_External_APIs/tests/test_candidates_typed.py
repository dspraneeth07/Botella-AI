"""Sheet 12 — typed candidates carrying every figure they will display."""

from __future__ import annotations

import ast
import inspect
from datetime import date, timedelta

import pytest

from app.pipeline.candidates import (
    FAMILIES,
    CandidateIdentity,
    ClearCandidate,
    GenerateRequest,
    MarkdownCandidate,
    RangeCandidate,
    ReorderCandidate,
    SkuInputs,
    SubstituteCandidate,
    generate_candidates,
)
from app.pipeline.candidates import generate as generate_module
from app.pipeline.candidates import types as types_module
from app.pipeline.candidates.generate import (
    CLEAR_MIN_CAPITAL,
    CLEAR_MIN_DAYS_SINCE_SALE,
    RANGE_MIN_PEER_ADOPTION,
)
from app.pipeline.context import RunContext
from app.pipeline.elasticity.estimate import Elasticity, Interval
from app.pipeline.provenance import Provenance
from app.pipeline.registry import cfg

AS_OF = date(2026, 9, 23)
IDENTITY = CandidateIdentity(171, 171, "080686001904")
OTHER = CandidateIdentity(171, 171, "088004045456")


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-12", "tenant_id": 171, "store_id": 171, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"candidates": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def prov(**over) -> Provenance:
    base = {"own_observations": 120, "own_weight": 0.9,
            "evidence_state": "MATURE"}
    base.update(over)
    return Provenance(**base)


def elasticity(beta: float, low: float, high: float) -> Elasticity:
    return Elasticity(
        store_key=(171, 171), category="whiskey", beta=beta,
        interval=Interval(low, high), own_beta=beta,
        own_interval=Interval(low, high), own_weight=1.0,
        n_observations=300, n_price_levels=12, price_cv_pct=8.0,
        r_squared=0.3, cohort_level=None, cohort_size=None,
    )


def sku(**over) -> SkuInputs:
    base = {"identity": IDENTITY, "provenance": prov(),
            "display_name": "Fireball 750ml"}
    base.update(over)
    return SkuInputs(**base)


def generate(*items) -> tuple:
    result = generate_candidates(GenerateRequest(items, AS_OF), ctx())
    assert result.ok, result.reasons
    return result.value


# ── The rule: every figure present and non-null ──────────────────────────────


def test_every_candidates_numbers_are_all_present_and_non_null() -> None:
    """The sheet's second required test.

    A candidate with a missing number produces a card with a blank where a
    quantity should be - or a sentence that silently drops the figure and
    reads as a confident claim with nothing behind it.
    """
    built = [
        ReorderCandidate(IDENTITY, "reorder", prov(), None, feasible_qty=24,
                         order_by_date=AS_OF, demand_p50=30.0, demand_p90=44.0,
                         on_hand=10.0, on_order=0.0, lead_time_days=7,
                         lead_time_assumption="declared 7 days"),
        ClearCandidate(IDENTITY, "clear", prov(), None, units=40.0,
                       capital=800.0, days_since_last_sale=180,
                       rule_applied="no sale in 180 days"),
        MarkdownCandidate(IDENTITY, "markdown", prov(), None, beta=-1.8,
                          beta_interval_low=-2.4, beta_interval_high=-1.2),
        RangeCandidate(IDENTITY, "range", prov(), None, cohort_level="state",
                       cohort_size=24, peer_adoption_rate=0.7),
        SubstituteCandidate(IDENTITY, "substitute", prov(), None,
                            replaces=OTHER, evidence_kind="basket",
                            co_purchase_count=40.0, shared_basket_rate=0.3),
    ]
    for candidate in built:
        values = candidate.figures()
        assert values, f"{candidate.family} carries no figures at all"
        for key in candidate.REQUIRED_FIGURES:
            assert key in values, f"{candidate.family} is missing {key}"
            assert values[key] is not None
            assert isinstance(values[key], float)


def test_a_candidate_missing_a_required_figure_cannot_be_constructed() -> None:
    """The mechanism, not the instruction: it fails at construction."""
    with pytest.raises(ValueError, match="must say WHEN to order by"):
        ReorderCandidate(IDENTITY, "reorder", prov(), None, feasible_qty=24,
                         order_by_date=None, demand_p50=30.0, demand_p90=44.0,
                         on_hand=10.0, on_order=0.0, lead_time_days=7,
                         lead_time_assumption="declared")

    with pytest.raises(ValueError, match="lead time"):
        ReorderCandidate(IDENTITY, "reorder", prov(), None, feasible_qty=24,
                         order_by_date=AS_OF, demand_p50=30.0, demand_p90=44.0,
                         on_hand=10.0, on_order=0.0, lead_time_days=7,
                         lead_time_assumption="")

    with pytest.raises(ValueError, match="clearing rule"):
        ClearCandidate(IDENTITY, "clear", prov(), None, units=40.0,
                       capital=800.0, days_since_last_sale=180,
                       rule_applied="")


def test_figures_is_the_contract_stage_16_will_check_against() -> None:
    """Any numeral in a generated sentence must be in this mapping."""
    candidate = ReorderCandidate(
        IDENTITY, "reorder", prov(), None, feasible_qty=24,
        order_by_date=AS_OF, demand_p50=30.0, demand_p90=44.0,
        on_hand=10.0, on_order=2.0, lead_time_days=7,
        lead_time_assumption="declared 7 days",
    )
    values = set(candidate.figures().values())
    assert 24.0 in values and 44.0 in values and 2.0 in values
    # A number nobody computed is not sayable.
    assert 999.0 not in values


# ── MARKDOWN is not generated when the elasticity does not support it ────────


def test_a_markdown_candidate_is_not_generated_when_beta_spans_zero() -> None:
    """The sheet's first required test.

    Not "generated and flagged" - not generated. A markdown that exists at
    all is already the claim that cutting the price pays.
    """
    result = generate(sku(elasticity=elasticity(-0.3, -1.1, 0.5)))
    assert result.by_family("markdown") == []
    assert any(
        family == "markdown" and "spans_zero" in reason
        for _, family, reason in result.withheld
    ), "withheld WITH a reason, not silently dropped"


def test_a_markdown_is_not_generated_for_a_positive_elasticity() -> None:
    """The interval excludes zero and is still not a reason to discount."""
    result = generate(sku(elasticity=elasticity(0.7, 0.5, 0.9)))
    assert result.by_family("markdown") == []
    assert any("positive" in r for _, f, r in result.withheld if f == "markdown")


def test_a_markdown_is_not_generated_for_an_inelastic_estimate() -> None:
    """Sheet 09's binding constraint: a 10% cut moving 5% loses revenue."""
    result = generate(sku(elasticity=elasticity(-0.5, -0.7, -0.3)))
    assert result.by_family("markdown") == []
    assert any("inelastic" in r for _, f, r in result.withheld if f == "markdown")


def test_a_markdown_is_generated_when_the_elasticity_supports_it() -> None:
    result = generate(sku(elasticity=elasticity(-1.8, -2.4, -1.2)))
    markdowns = result.by_family("markdown")
    assert len(markdowns) == 1
    assert markdowns[0].beta == -1.8
    assert markdowns[0].beta_interval_high == -1.2


def test_the_type_itself_refuses_a_zero_spanning_interval() -> None:
    """A second line of defence: the generator checks, and so does the class."""
    with pytest.raises(ValueError, match="spans zero"):
        MarkdownCandidate(IDENTITY, "markdown", prov(), None, beta=-0.3,
                          beta_interval_low=-1.1, beta_interval_high=0.5)


# ── A zero-history store still gets a RANGE candidate ────────────────────────


def test_a_zero_history_store_carries_cohort_level_and_size() -> None:
    """The sheet's third required test.

    RANGE is the most cohort-dependent family and the only one a brand-new
    store can act on - it is a claim about what comparable stores do, not
    about this store's own past.
    """
    new_store = sku(
        provenance=prov(own_observations=0, own_weight=0.0,
                        evidence_state="NEW", cohort_level="state",
                        cohort_size=24),
        is_ranged=False, cohort_level="state", cohort_size=24,
        peer_adoption_rate=0.75,
    )
    result = generate(new_store)
    ranges = result.by_family("range")
    assert len(ranges) == 1
    candidate = ranges[0]
    assert candidate.cohort_level == "state"
    assert candidate.cohort_size == 24
    assert candidate.peer_adoption_rate == 0.75
    # And the provenance says it is entirely borrowed.
    assert candidate.provenance.own_weight == 0.0
    assert candidate.provenance.evidence_state == "NEW"
    assert candidate.provenance.cohort_level == "state"


def test_a_range_candidate_must_name_which_cohort() -> None:
    with pytest.raises(ValueError, match="WHICH comparable stores"):
        RangeCandidate(IDENTITY, "range", prov(), None, cohort_level="",
                       cohort_size=24, peer_adoption_rate=0.7)


def test_a_range_candidate_is_not_generated_for_a_sku_already_stocked() -> None:
    """'Stock something you do not' - it has to be something they do not."""
    result = generate(sku(is_ranged=True, cohort_level="state",
                          cohort_size=24, peer_adoption_rate=0.9))
    assert result.by_family("range") == []


def test_weak_peer_adoption_is_withheld_with_its_number() -> None:
    result = generate(sku(is_ranged=False, cohort_level="state",
                          cohort_size=24, peer_adoption_rate=0.1))
    assert result.by_family("range") == []
    assert any("peer_adoption_below_floor" in r
               for _, f, r in result.withheld if f == "range")


# ── Identity is (client_id, location_id, sku). Never a name. ─────────────────


def test_no_name_based_matching_anywhere_in_the_package() -> None:
    """The sheet's fourth required test - asserted, not reviewed.

    Two SKUs are not the same product because their names share a word. A
    search for "gin" matches "ginger ale" and "virgin mary" unless the pattern
    is word-bounded - and even bounded, a name is not an identifier.

    This walks both modules' ASTs for any comparison, containment test, regex
    or lookup involving a name-shaped attribute.
    """
    banned_calls = {"match", "search", "fullmatch", "findall", "startswith",
                    "endswith", "ilike", "like"}
    name_words = {"name", "display_name", "product_name", "title",
                  "description"}

    for module in (types_module, generate_module):
        tree = ast.parse(inspect.getsource(module))
        for node in ast.walk(tree):
            # A regex or string search whose receiver is a name attribute.
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr in banned_calls:
                    target = node.func.value
                    attr = getattr(target, "attr", None) or getattr(target, "id", None)
                    assert attr not in name_words, (
                        f"{module.__name__}: {node.func.attr}() on {attr} - "
                        "candidate identity must never be a name match"
                    )
            # `x in some_name` / `some_name == other`
            if isinstance(node, ast.Compare):
                for side in [node.left, *node.comparators]:
                    attr = getattr(side, "attr", None)
                    if attr in name_words and not isinstance(
                        node.ops[0], (ast.Is, ast.IsNot)
                    ):
                        raise AssertionError(
                            f"{module.__name__}: comparison on {attr} - "
                            "identity is (client_id, location_id, sku)"
                        )

    # And the `re` module is not imported at all in either.
    for module in (types_module, generate_module):
        source = inspect.getsource(module)
        assert "import re" not in source, f"{module.__name__} imports re"


def test_identity_is_the_triple_and_requires_a_sku() -> None:
    assert IDENTITY.store_key == (171, 171)
    assert IDENTITY.as_dict() == {
        "client_id": 171, "location_id": 171, "sku": "080686001904",
    }
    with pytest.raises(ValueError, match="non-empty"):
        CandidateIdentity(171, 171, "")
    with pytest.raises(ValueError, match="non-empty"):
        CandidateIdentity(171, 171, "   ")


def test_two_stores_holding_the_same_sku_are_different_candidates() -> None:
    assert CandidateIdentity(171, 171, "X") != CandidateIdentity(122, 122, "X")


def test_a_substitute_links_identities_not_names() -> None:
    candidate = SubstituteCandidate(
        IDENTITY, "substitute", prov(), None, replaces=OTHER,
        evidence_kind="basket", co_purchase_count=40.0,
        shared_basket_rate=0.3,
    )
    assert isinstance(candidate.replaces, CandidateIdentity)
    with pytest.raises(ValueError, match="cannot substitute for itself"):
        SubstituteCandidate(IDENTITY, "substitute", prov(), None,
                            replaces=IDENTITY, evidence_kind="basket",
                            co_purchase_count=1.0, shared_basket_rate=0.1)


def test_a_substitute_must_state_its_evidence() -> None:
    """A link with no stated evidence is name-matching wearing a hat."""
    with pytest.raises(ValueError, match="basket.*category"):
        SubstituteCandidate(IDENTITY, "substitute", prov(), None,
                            replaces=OTHER, evidence_kind="",
                            co_purchase_count=1.0, shared_basket_rate=0.1)


# ── Generation reads only from earlier stages ────────────────────────────────


def test_generation_never_touches_a_database() -> None:
    """A stage that reads a database cannot be replayed, only re-run."""
    source = inspect.getsource(generate_module)
    for forbidden in ("psycopg", "connect(", "cursor", "SELECT ", "execute("):
        assert forbidden not in source, (
            f"generate.py contains {forbidden!r} - it must read only from "
            "earlier stage outputs"
        )


def test_reorder_carries_every_figure_the_sheet_lists() -> None:
    result = generate(sku(
        feasible_qty=24, constraint_reasons=("rounded up to 2 packs of 12",),
        demand_p50=30.0, demand_p90=44.0, on_hand=10.0, on_order=2.0,
        lead_time_days=7,
        lead_time_assumption="a 7-day lead time (declared, not measured)",
    ))
    reorders = result.by_family("reorder")
    assert len(reorders) == 1
    candidate = reorders[0]
    assert candidate.feasible_qty == 24
    assert candidate.order_by_date == AS_OF + timedelta(days=7)
    assert candidate.constraint_reasons == ("rounded up to 2 packs of 12",)
    assert "declared" in candidate.lead_time_assumption
    for key in ("feasible_qty", "demand_p50", "demand_p90", "on_hand",
                "on_order", "lead_time_days"):
        assert key in candidate.figures()


def test_a_reorder_without_a_forecast_interval_is_withheld() -> None:
    result = generate(sku(feasible_qty=24, demand_p50=30.0, demand_p90=None,
                          lead_time_days=7, lead_time_assumption="declared"))
    assert result.by_family("reorder") == []
    assert any("no_forecast_interval" in r for _, f, r in result.withheld)


def test_a_zero_quantity_produces_no_reorder() -> None:
    result = generate(sku(feasible_qty=0, demand_p50=30.0, demand_p90=44.0,
                          lead_time_days=7, lead_time_assumption="declared"))
    assert result.by_family("reorder") == []


# ── CLEAR ────────────────────────────────────────────────────────────────────


def test_clear_requires_both_age_and_capital_to_matter() -> None:
    stuck = generate(sku(days_since_last_sale=180, capital=800.0, on_hand=40.0))
    assert len(stuck.by_family("clear")) == 1
    assert "180 days" in stuck.by_family("clear")[0].rule_applied

    too_recent = generate(sku(days_since_last_sale=10, capital=800.0))
    assert too_recent.by_family("clear") == []

    too_small = generate(sku(days_since_last_sale=180, capital=8.0))
    assert too_small.by_family("clear") == []
    assert any("capital_below_floor" in r for _, f, r in too_small.withheld)


def test_the_clear_thresholds_come_from_the_registry() -> None:
    assert CLEAR_MIN_DAYS_SINCE_SALE.status == "PROVISIONAL"
    assert CLEAR_MIN_CAPITAL.status == "PROVISIONAL"
    assert RANGE_MIN_PEER_ADOPTION.status == "PROVISIONAL"
    lenient = cfg.with_overrides("lenient", {CLEAR_MIN_CAPITAL.name: 1})
    result = generate_candidates(
        GenerateRequest((sku(days_since_last_sale=180, capital=8.0),), AS_OF),
        ctx(config_version="lenient"), lenient,
    ).value
    assert len(result.by_family("clear")) == 1


# ── Shape ────────────────────────────────────────────────────────────────────


def test_every_family_is_represented_and_named_once() -> None:
    assert set(FAMILIES) == {"reorder", "clear", "markdown", "range",
                             "substitute"}
    assert len(FAMILIES) == len(set(FAMILIES))


def test_withheld_candidates_carry_a_reason_not_just_an_absence() -> None:
    """'We considered a markdown and the elasticity did not support it' is
    information; its absence reads as 'we never looked'."""
    result = generate(sku(elasticity=elasticity(-0.3, -1.1, 0.5)))
    assert result.withheld
    for sku_id, family, reason in result.withheld:
        assert sku_id and family and reason
        assert family in FAMILIES


def test_every_candidate_carries_its_provenance() -> None:
    result = generate(sku(elasticity=elasticity(-1.8, -2.4, -1.2)))
    for candidate in result.candidates:
        assert candidate.provenance is not None
        assert candidate.provenance.evidence_state
        assert 0.0 <= candidate.provenance.own_weight <= 1.0
        assert "provenance" in candidate.as_dict()
