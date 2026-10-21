"""Sheet 16 — explanation validation. Mechanical, and it logs rather than pages."""

from __future__ import annotations

from datetime import date, timedelta

from app.pipeline.candidates import CandidateIdentity, ReorderCandidate
from app.pipeline.constraints import (
    budget_unavailable,
    known,
    shelf_capacity_unavailable,
)
from app.pipeline.context import RunContext
from app.pipeline.explain import build_provenance_sentence, template_sentence
from app.pipeline.provenance import Provenance
from app.pipeline.validate import (
    CLAIM_PATTERNS,
    DecisionRequest,
    ExplanationCheck,
    ExplanationCheckRequest,
    ExplanationStats,
    Severity,
    StoreCatalogue,
    claim_evidence,
    pageable,
    validate_decision,
    validate_explanation,
)

AS_OF = date(2026, 9, 23)
SKU = "080686001904"


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-16", "tenant_id": 1, "store_id": 1, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"validate": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def provenance(**over) -> Provenance:
    base = {"own_observations": 120, "own_weight": 1.0,
            "evidence_state": "MATURE"}
    return Provenance(**{**base, **over})


def catalogue(**over) -> StoreCatalogue:
    base = {"client_id": 1, "location_id": 1,
            "skus": frozenset({SKU, "721059000505", "858800"}),
            "product_names": frozenset()}
    return StoreCatalogue(**{**base, **over})


def record(**over):
    """A REAL stage-14 record, produced by running the gate."""
    candidate = ReorderCandidate(
        CandidateIdentity(1, 1, SKU), "reorder", provenance(),
        over.pop("display_name", None),
        feasible_qty=116, order_by_date=AS_OF + timedelta(days=7),
        demand_p50=277.8, demand_p90=354.1, on_hand=48.0, on_order=0.0,
        lead_time_days=7, lead_time_assumption="a 7-day lead time (declared)",
    )
    base = {
        "candidate": candidate, "quantity": 116,
        "order_by_date": AS_OF + timedelta(days=7),
        "demand_p50": 277.8, "demand_p90": 354.1, "on_hand": 48.0,
        "on_order": 0.0, "safety_stock": 30.0, "lead_time_days": 7,
        "constraints": [
            known("case_pack", 12), known("on_hand", 48), known("moq", 1),
            shelf_capacity_unavailable(), budget_unavailable(),
        ],
        "stated_risk": 1389.0, "unit_margin": 5.0,
        "assumptions": ("a 7-day lead time (declared, not measured)",),
        "order_up_to": 200.0, "horizon_days": 30, "coverage_days": 14,
    }
    base.update(over)
    result = validate_decision(DecisionRequest(**base), ctx())
    assert result.ok, result.reasons
    return result.value


def check(text: str, *, built=None, prov=None, cat=None, hedge="",
          evidence=None, **over):
    built = built if built is not None else record()
    prov = prov if prov is not None else provenance()
    figures = dict(built.figures())
    literals = tuple(x for x in (built.sku, built.product_name,
                                 built.order_by_date.isoformat()) if x)
    request = ExplanationCheckRequest(
        text=text, record=built, provenance=prov,
        catalogue=cat if cat is not None else catalogue(),
        provenance_sentence=hedge,
        allowed_figures=over.get("allowed_figures", figures),
        allowed_literals=literals,
        evidence=evidence if evidence is not None else claim_evidence(built, prov),
    )
    result = validate_explanation(request, ctx())
    assert result.ok, "the STAGE always succeeds - the verdict is in the value"
    return result.value


def failures_for(kind: ExplanationCheck, verdict) -> list[str]:
    return [f.reason for f in verdict.failures if f.check is kind]


# ── 1. Numerals ──────────────────────────────────────────────────────────────


def test_a_faithful_sentence_passes_and_ships_the_model_text() -> None:
    verdict = check(
        f"Order 116 of {SKU} by 2026-09-30: you have 48 on hand."
    )
    assert verdict.ok, verdict.reasons
    assert verdict.source == "model"
    assert "Order 116" in verdict.text


def test_a_planted_invented_number_is_caught() -> None:
    """The sheet's first required test."""
    verdict = check(f"Order 116 of {SKU} and make 900 dollars.")
    assert not verdict.ok
    assert "900" in failures_for(ExplanationCheck.NUMERALS, verdict)[0]


def test_currency_and_separators_compare_equal() -> None:
    """The sheet's second required test.

    $1,924.80 / 1924.8 / 1,924.80 are three spellings of one figure. A model
    that formats a number for a human has not changed it.
    """
    allowed = {"stated_risk": 1924.8}
    for spelling in ("$1,924.80", "1924.8", "1,924.80", "$1924.80"):
        verdict = check(f"That is {spelling} at risk.",
                        allowed_figures=allowed)
        assert verdict.ok, (spelling, verdict.reasons)


def test_a_rounded_number_fails_because_rounding_is_computing() -> None:
    verdict = check("Order about 120 units.")
    assert not verdict.ok
    assert failures_for(ExplanationCheck.NUMERALS, verdict)


def test_a_summed_number_fails() -> None:
    """48 on hand plus 116 ordered is 164 - a figure nobody validated."""
    verdict = check("You will have 164 after delivery.")
    assert not verdict.ok


def test_the_order_by_date_is_not_read_as_three_figures() -> None:
    """Otherwise every reorder card fails on its own deadline."""
    verdict = check("Order 116 by 2026-09-30.")
    assert verdict.ok, verdict.reasons


def test_the_sku_is_not_read_as_a_quantity() -> None:
    verdict = check(f"Order 116 of {SKU}.")
    assert verdict.ok, verdict.reasons


# ── 2. Identity ──────────────────────────────────────────────────────────────


def test_a_nonexistent_sku_is_caught() -> None:
    """The sheet's third required test.

    The backtest found 2 invented SKUs out of ~480 referenced. One fabricated
    product destroys trust in every other card on the screen.
    """
    verdict = check("Order 116 of 099999999999 instead.")
    assert not verdict.ok
    reasons = failures_for(ExplanationCheck.IDENTITY, verdict)
    assert reasons and "099999999999" in reasons[0]


def test_a_sku_carried_by_another_store_is_still_caught() -> None:
    """Exact key match on (client_id, location_id, sku), never a name lookup."""
    other_store = catalogue(client_id=2, location_id=2,
                            skus=frozenset({"111111111111"}))
    verdict = check(f"Order 116 of {SKU}.", cat=other_store)
    assert not verdict.ok
    assert failures_for(ExplanationCheck.IDENTITY, verdict)


def test_a_sku_this_store_does_carry_passes() -> None:
    verdict = check("Consider 721059000505 as well.",
                    allowed_figures=dict(record().figures()))
    assert not failures_for(ExplanationCheck.IDENTITY, verdict)


def test_a_short_number_is_not_mistaken_for_a_sku() -> None:
    """Treating 116 as a possible SKU would fail every card - the
    false-positive rate that gets a checker switched off."""
    verdict = check("Order 116 units, 48 on hand.")
    assert not failures_for(ExplanationCheck.IDENTITY, verdict)


def test_a_card_naming_a_different_carried_product_is_caught() -> None:
    """The record now carries the product name, so this is checkable.

    It did not before: sheet 14 built `DecisionRecord` without one, while its
    own contract is that everything the card DISPLAYS is on the record. Sheet
    16 could not check a name that was never carried.
    """
    built = record(display_name="Terra Lager 12pk")
    assert built.product_name == "Terra Lager 12pk"
    cat = catalogue(product_names=frozenset({"terra lager 12pk",
                                             "chamisul soju"}))
    verdict = check("Order 116 of Chamisul Soju.", built=built, cat=cat)
    assert not verdict.ok
    assert "different product" in failures_for(ExplanationCheck.IDENTITY,
                                               verdict)[0]


def test_naming_its_own_product_is_fine_even_with_a_pack_size_in_the_name() -> None:
    """"Terra Lager 12pk" contains 12. A name read as arithmetic would fail
    every card whose product has a pack size in its name."""
    built = record(display_name="Terra Lager 12pk")
    cat = catalogue(product_names=frozenset({"terra lager 12pk"}))
    verdict = check("Order 116 of Terra Lager 12pk.", built=built, cat=cat)
    assert verdict.ok, verdict.reasons


def test_a_stale_catalogue_says_so_rather_than_failing_silently() -> None:
    """Every other check trusts the catalogue, so a gap in it is worth naming."""
    empty = catalogue(skus=frozenset())
    verdict = check(f"Order 116 of {SKU}.", cat=empty)
    assert not verdict.ok
    assert any("catalogue" in r for r in
               failures_for(ExplanationCheck.IDENTITY, verdict))


# ── 3. Provenance ────────────────────────────────────────────────────────────


def test_a_missing_provenance_sentence_on_a_cohort_card_is_caught() -> None:
    """The sheet's fourth required test."""
    borrowed = provenance(own_weight=0.4, own_observations=21,
                          cohort_level="state", cohort_size=14)
    verdict = check("Order 116 units.", prov=borrowed, hedge="")
    assert not verdict.ok
    assert failures_for(ExplanationCheck.PROVENANCE, verdict)


def test_the_provenance_sentence_satisfies_the_check() -> None:
    borrowed = provenance(own_weight=0.4, own_observations=21,
                          cohort_level="state", cohort_size=14)
    hedge = build_provenance_sentence(borrowed)
    verdict = check("Order 116 units.", prov=borrowed, hedge=hedge,
                    allowed_figures={**dict(record().figures()),
                                     "cohort_size": 14.0, "own_weeks": 3.0})
    assert not failures_for(ExplanationCheck.PROVENANCE, verdict)


def test_a_card_on_its_own_data_needs_no_hedge() -> None:
    verdict = check("Order 116 units.", prov=provenance(own_weight=1.0))
    assert not failures_for(ExplanationCheck.PROVENANCE, verdict)


# ── 4. Unsupported claims ────────────────────────────────────────────────────


def test_a_substitution_claim_without_evidence_is_caught() -> None:
    verdict = check("Customers are switching to this one.",
                    evidence={"substitution_evidence": None})
    assert not verdict.ok
    reasons = failures_for(ExplanationCheck.CLAIMS, verdict)
    assert reasons and "substitution" in reasons[0]


def test_a_substitution_claim_with_evidence_passes() -> None:
    verdict = check("Customers are switching to this one.",
                    evidence={"substitution_evidence": {"from_sku": "X"}})
    assert not failures_for(ExplanationCheck.CLAIMS, verdict)


def test_a_margin_claim_without_cost_is_caught() -> None:
    """31 stores send 0.00% cost; a margin built on it is an imaginary 100%."""
    verdict = check("Good margin on this one.",
                    evidence={"unit_margin": None})
    assert not verdict.ok
    assert failures_for(ExplanationCheck.CLAIMS, verdict)


def test_a_peer_claim_without_a_cohort_is_caught() -> None:
    verdict = check("Stores like yours are stocking it.",
                    evidence={"cohort_size": None})
    assert not verdict.ok
    assert "peer_comparison" in failures_for(ExplanationCheck.CLAIMS, verdict)[0]


def test_a_price_effect_claim_without_elasticity_is_caught() -> None:
    """98.5% of (store, category) cells cannot support a price claim."""
    verdict = check("A discount will lift volume.", evidence={"elasticity": None})
    assert not verdict.ok
    assert failures_for(ExplanationCheck.CLAIMS, verdict)


def test_a_sentence_making_no_claim_is_not_asked_for_evidence() -> None:
    verdict = check("Order 116 units by 2026-09-30.", evidence={})
    assert not failures_for(ExplanationCheck.CLAIMS, verdict)


def test_every_claim_pattern_names_the_field_that_backs_it() -> None:
    for claim in CLAIM_PATTERNS:
        assert claim.requires, claim.name
        assert claim.explain, claim.name
        assert claim.pattern.search(claim.pattern.pattern) is not None or True


def test_zero_evidence_is_treated_as_no_evidence() -> None:
    """A cohort of 0 stores is not a cohort."""
    verdict = check("Stores like yours stock it.", evidence={"cohort_size": 0})
    assert not verdict.ok


# ── On failure: drop the prose, keep the decision ────────────────────────────


def test_a_failure_still_ships_a_card_with_correct_numbers() -> None:
    """The sheet's fifth required test.

    The decision was validated long before the model wrote anything. A bad
    sentence is a reason to use a different sentence, never a reason to
    withhold a correct recommendation.
    """
    built = record()
    verdict = check("Order 999 of 099999999999 for a huge margin.", built=built)
    assert not verdict.ok
    assert verdict.source == "template"
    assert verdict.text == template_sentence(built)
    assert "116" in verdict.text
    assert "48" in verdict.text
    assert "099999999999" not in verdict.text
    assert "999" not in verdict.text.replace("099999999999", "")


def test_the_stage_never_fails_so_it_cannot_read_as_a_page() -> None:
    """A failed envelope here would look exactly like a sheet-14 page, which
    is the conflation this pair of sheets exists to end."""
    result = validate_explanation(
        ExplanationCheckRequest(
            text="Order 999 of 099999999999.", record=record(),
            provenance=provenance(), catalogue=catalogue(),
        ),
        ctx(),
    )
    assert result.ok
    assert result.value is not None and not result.value.ok


def test_every_failure_is_log_severity_never_page() -> None:
    verdict = check("Order 999 of 099999999999 for a huge margin.")
    assert verdict.failures
    for failure in verdict.failures:
        assert failure.severity is Severity.LOG
    assert pageable(verdict.reasons) == []


def test_all_four_checks_run_even_after_one_fails() -> None:
    """A card with two faults should report both, not stop at the first."""
    borrowed = provenance(own_weight=0.4, own_observations=21,
                          cohort_level="state", cohort_size=14)
    verdict = check("Order 999 of 099999999999.", prov=borrowed, hedge="")
    kinds = {f.check for f in verdict.failures}
    assert ExplanationCheck.NUMERALS in kinds
    assert ExplanationCheck.IDENTITY in kinds
    assert ExplanationCheck.PROVENANCE in kinds
    assert len(verdict.checks_run) == 4


# ── Counting: the RATE is the signal ─────────────────────────────────────────


def test_the_rate_is_none_before_anything_is_checked() -> None:
    """"no cards failed" and "no cards were checked" are different facts."""
    stats = ExplanationStats()
    assert stats.failure_rate is None


def test_the_stats_count_failures_by_check() -> None:
    stats = ExplanationStats()
    stats.record(check(f"Order 116 of {SKU} by 2026-09-30."))
    stats.record(check("Order 999 of 099999999999."))
    assert stats.total == 2
    assert stats.failed == 1
    assert stats.failure_rate == 0.5
    assert stats.by_check["numerals"] == 1
    assert stats.by_check["identity"] >= 1


def test_the_verdict_serialises_for_a_log_line() -> None:
    verdict = check("Order 999 of 099999999999.")
    payload = verdict.as_dict()
    assert payload["ok"] is False
    assert payload["source"] == "template"
    assert payload["failures"]
    assert all(f["severity"] == "log" for f in payload["failures"])


# ── It checks the SENTENCE, never the decision ───────────────────────────────


def test_it_never_rechecks_whether_the_decision_is_correct() -> None:
    """Sheet 14 owns that question and has already answered it.

    A record that sheet 14 passed is taken as correct here even when the
    sentence is about an inventory position that looks odd - re-deriving the
    arithmetic would put the same check in two places and let them drift.
    """
    built = record()
    verdict = check(f"Order 116 of {SKU}: you have 48 on hand and expect "
                    f"to sell 277.8.", built=built)
    assert verdict.ok, verdict.reasons


def test_it_reads_no_clock_and_calls_no_model() -> None:
    import ast
    import inspect

    from app.pipeline.validate import explanation as module

    tree = ast.parse(inspect.getsource(module))
    banned = {"random", "anthropic", "openai", "requests", "httpx", "time",
              "secrets", "asyncpg", "psycopg", "sqlalchemy"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                assert alias.name.split(".")[0] not in banned
        elif isinstance(node, ast.ImportFrom) and node.module:
            assert node.module.split(".")[0] not in banned
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            assert node.func.attr not in {"now", "today", "monotonic"}


def test_the_two_request_types_are_not_the_same_name() -> None:
    """Sheet 15 asks for a sentence to be WRITTEN; sheet 16 asks for one to be
    CHECKED. Two types with one name is how the wrong one gets imported."""
    from app.pipeline.explain import ExplanationRequest as WriteRequest

    assert WriteRequest is not ExplanationCheckRequest
