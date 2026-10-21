"""Sheet 15 — explanation. The model writes; it does not decide."""

from __future__ import annotations

import ast
import inspect
from datetime import date, timedelta

import pytest

from app.pipeline.candidates import CandidateIdentity, ReorderCandidate
from app.pipeline.constraints import budget_unavailable, known, shelf_capacity_unavailable
from app.pipeline.context import RunContext
from app.pipeline.explain import (
    DISPLAY_ROUNDING_TOLERANCE,
    MAX_SENTENCE_CHARS,
    PROMPT_TEMPLATE_VERSION,
    CohortPrecedent,
    Explanation,
    ExplanationRequest,
    Precedent,
    RetrievalContainsFigure,
    RetrievedText,
    StoreOutcome,
    build_prompt,
    build_provenance_sentence,
    numerals_in,
    render_explanation,
    safe_passages,
    template_sentence,
    unaccounted_numerals,
    vector_retrieval_is_useful,
)
from app.pipeline.provenance import Provenance
from app.pipeline.registry import cfg
from app.pipeline.validate import DecisionRequest, validate_decision

AS_OF = date(2026, 9, 23)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-15", "tenant_id": 1, "store_id": 1, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"explain": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def provenance(**over) -> Provenance:
    base = {"own_observations": 120, "own_weight": 1.0,
            "evidence_state": "MATURE"}
    return Provenance(**{**base, **over})


def record(**over):
    """A REAL stage-14 record: built by running the gate, not hand-made.

    Hand-building one would let this sheet drift from the contract it depends
    on - the whole premise is that every figure was fixed and validated
    upstream.
    """
    candidate = ReorderCandidate(
        CandidateIdentity(1, 1, "080686001904"), "reorder", provenance(),
        None, feasible_qty=116, order_by_date=AS_OF + timedelta(days=7),
        demand_p50=277.8, demand_p90=354.1, on_hand=48.0, on_order=0.0,
        lead_time_days=7, lead_time_assumption="a 7-day lead time (declared)",
    )
    base = {
        "candidate": candidate, "quantity": 116,
        "order_by_date": AS_OF + timedelta(days=7),
        "demand_p50": 277.8, "demand_p90": 354.1, "on_hand": 48.0,
        "on_order": 0.0, "safety_stock": 30.0, "lead_time_days": 7,
        "constraints": [
            known("case_pack", 12), known("on_hand", 48),
            known("moq", 1), shelf_capacity_unavailable(), budget_unavailable(),
        ],
        "stated_risk": 1389.0, "unit_margin": 5.0,
        "assumptions": ("a 7-day lead time (declared, not measured)",),
        "order_up_to": 200.0, "horizon_days": 30, "coverage_days": 14,
    }
    base.update(over)
    result = validate_decision(DecisionRequest(**base), ctx())
    assert result.ok, result.reasons
    return result.value


# ── Retrieval supplies words and precedent, NEVER a figure ───────────────────


def test_retrieved_text_carrying_a_digit_cannot_be_constructed() -> None:
    """The rule made structural.

    A passage quoting a real figure from a real document is the worst case,
    not the best: sheet 16 would see a numeral it cannot account for, or -
    worse - one that happens to match.
    """
    with pytest.raises(RetrievalContainsFigure):
        RetrievedText(text="this SKU sold 400 units last March", source="doc:1")


def test_retrieved_text_carrying_a_number_WORD_is_also_refused() -> None:
    """A digit check alone has an obvious bypass."""
    with pytest.raises(RetrievalContainsFigure):
        RetrievedText(text="customers usually buy two at a time", source="doc:2")


def test_prose_with_no_figure_is_accepted() -> None:
    passage = RetrievedText(
        text="shoppers reach for this brand when the weather turns warm",
        source="doc:3",
    )
    assert passage.source == "doc:3"


def test_an_unattributed_passage_is_refused() -> None:
    """A card's wording must be traceable to a document."""
    with pytest.raises(ValueError):
        RetrievedText(text="a perfectly ordinary sentence", source="  ")


def test_safe_passages_keeps_the_clean_ones_and_reports_the_rest() -> None:
    kept, dropped = safe_passages([
        ("a crisp lager that sells through the summer", "doc:a"),
        ("moved 90 cases in July", "doc:b"),
        ("often bought alongside mixers", "doc:c"),
    ])
    assert len(kept) == 2
    assert len(dropped) == 1
    assert "doc:b" in dropped[0]


def test_a_store_without_category_data_is_not_searched_at_all() -> None:
    """31 stores have no category data. A nearest neighbour over a catalogue
    with no categories is a confident-looking irrelevance, so the vector store
    is not queried rather than queried for noise."""
    assert vector_retrieval_is_useful(has_category_data=True) is True
    assert vector_retrieval_is_useful(has_category_data=False) is False


def test_no_figure_from_retrieval_ever_reaches_the_prompt() -> None:
    """The end-to-end form of the rule, asserted on the built prompt."""
    kept, _ = safe_passages([
        ("a crisp lager that sells through the summer", "doc:a"),
        ("moved 90 cases in July", "doc:b"),
    ])
    prompt = build_prompt(record(), Precedent(passages=tuple(kept)))
    context = prompt.user.split("CONTEXT")[1]
    assert "90" not in context, "a retrieved figure reached the prompt"
    assert "cases" not in context, "the dropped passage reached the prompt"
    assert "crisp lager" in context


# ── The prompt carries the record and nothing else ───────────────────────────


def test_the_prompt_contains_no_warehouse_rows() -> None:
    """The sheet's fourth required test.

    Only labelled figures from the validated record. No SQL, no table names,
    no raw row shapes - there is nothing here to reach through.
    """
    prompt = build_prompt(record())
    lowered = prompt.user.lower() + prompt.system.lower()
    # Markers a warehouse row or a query would carry. Not bare English words:
    # the system text legitimately says "from it", and a check that cannot
    # tell prose from SQL is a check that gets deleted.
    for leak in ("select ", "sale_items", "feature_daily", "client_id",
                 "location_id", "obs_date", "insert into", " join ",
                 "where ", "::", "$1"):
        assert leak not in lowered, f"prompt leaks {leak!r}"


def test_the_prompt_cannot_query_anything() -> None:
    """No connection, no cursor, no fetcher reaches the prompt builder."""
    from app.pipeline.explain import prompt as prompt_module

    tree = ast.parse(inspect.getsource(prompt_module))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert not (imported & {"asyncpg", "psycopg", "psycopg2", "sqlalchemy",
                            "httpx", "requests", "anthropic", "openai"})


def test_the_prompt_states_that_no_figure_may_be_computed() -> None:
    prompt = build_prompt(record())
    system = prompt.system.lower()
    assert "may not compute" in system
    assert "derive" in system and "round" in system
    assert "not deciding" in system


def test_the_prompt_shows_figures_in_their_display_form() -> None:
    """Handing the model 277.79999999999995 invites a 'correction' to 277.8 -
    which would be the model computing, and sheet 16 rejecting a numeral that
    is arguably more right than the one it was given."""
    prompt = build_prompt(record(demand_p50=277.79999999999995))
    assert "277.79999" not in prompt.user
    assert "277.8" in prompt.user


def test_the_prompt_carries_the_exact_figures_sheet_16_will_check() -> None:
    built = record()
    prompt = build_prompt(built)
    assert prompt.allowed_figures == built.figures()
    assert prompt.template_version == PROMPT_TEMPLATE_VERSION


def test_the_prompt_template_is_versioned() -> None:
    """A card written six months ago was written by a specific template."""
    assert PROMPT_TEMPLATE_VERSION
    assert render_explanation(
        ExplanationRequest(record=record(), provenance=provenance(),
                           model_sentence="Order 116."),
        ctx(),
    ).value.template_version == PROMPT_TEMPLATE_VERSION


# ── Degraded mode: a missing explanation is never a missing card ─────────────


def test_a_model_timeout_still_produces_a_card_with_every_number_intact() -> None:
    """The sheet's second required test.

    The decision was computed, constrained and validated before the model was
    called. Withholding the card would punish the store for an outage in the
    one part of the system that contributes no arithmetic.
    """
    built = record()
    result = render_explanation(
        ExplanationRequest(record=built, provenance=provenance(),
                           model_sentence=None),
        ctx(),
    )
    assert result.ok
    card = result.value
    assert card.source == "template"
    assert card.degraded_reason
    assert card.sentence

    # Parity: the figures a model card would carry are all here.
    for name in ("quantity", "on_hand", "coverage_demand", "coverage_days"):
        assert name in card.allowed_figures
    assert "116" in card.sentence
    assert "48" in card.sentence


def test_an_empty_or_refusing_model_sentence_falls_back() -> None:
    for unusable in ("", "   ", "I cannot write this recommendation.",
                     "As an AI, I do not have enough information."):
        card = render_explanation(
            ExplanationRequest(record=record(), provenance=provenance(),
                               model_sentence=unusable),
            ctx(),
        ).value
        assert card.source == "template", unusable
        assert card.degraded_reason


def test_a_sentence_longer_than_the_limit_falls_back() -> None:
    limit = int(cfg.get(MAX_SENTENCE_CHARS, ctx()))
    card = render_explanation(
        ExplanationRequest(record=record(), provenance=provenance(),
                           model_sentence="word " * (limit // 2)),
        ctx(),
    ).value
    assert card.source == "template"
    assert "over the" in card.degraded_reason


def test_a_usable_model_sentence_is_used() -> None:
    card = render_explanation(
        ExplanationRequest(
            record=record(), provenance=provenance(),
            model_sentence="  Order 116 of 080686001904 by 2026-09-30.  ",
        ),
        ctx(),
    ).value
    assert card.source == "model"
    assert card.degraded_reason == ""
    assert card.sentence == "Order 116 of 080686001904 by 2026-09-30."


def test_the_template_never_raises_on_an_unknown_family() -> None:
    """Raising would turn a model outage into a lost card."""
    built = record()
    object.__setattr__(built, "family", "some_future_family")
    assert template_sentence(built)


# ── The provenance sentence is generated, never written by the model ─────────


def test_a_cohort_weighted_card_always_carries_a_provenance_sentence() -> None:
    """The sheet's third required test."""
    card = render_explanation(
        ExplanationRequest(
            record=record(),
            provenance=provenance(own_weight=0.4, own_observations=21,
                                  cohort_level="state", cohort_size=14,
                                  evidence_state="EMERGING"),
            model_sentence="Order 116.",
            precedent=Precedent(
                cohort=CohortPrecedent(level="state", size=14, region="Texas")
            ),
        ),
        ctx(),
    ).value
    assert card.provenance_sentence
    assert "14 similar stores in Texas" in card.provenance_sentence
    assert "3 weeks of your own history" in card.provenance_sentence
    assert card.provenance_sentence in card.full_text


def test_a_card_on_its_own_data_carries_no_hedge() -> None:
    """A hedge on a card that does not need one trains owners to ignore the
    hedge on cards that do."""
    card = render_explanation(
        ExplanationRequest(record=record(), provenance=provenance(own_weight=1.0),
                           model_sentence="Order 116."),
        ctx(),
    ).value
    assert card.provenance_sentence == ""
    assert card.full_text == card.sentence


def test_the_cold_start_card_says_it_is_the_first_data() -> None:
    sentence = build_provenance_sentence(
        Provenance(own_observations=0, own_weight=0.0, cohort_level="state",
                   cohort_size=9, evidence_state="NEW"),
        CohortPrecedent(level="state", size=9, region="Texas"),
    )
    assert "9 similar stores in Texas" in sentence
    assert "first data" in sentence


def test_the_national_rung_invents_no_place() -> None:
    sentence = build_provenance_sentence(
        Provenance(own_observations=40, own_weight=0.5, cohort_level="national",
                   cohort_size=88, evidence_state="ESTABLISHED"),
        CohortPrecedent(level="national", size=88, region="Texas"),
    )
    assert "88 similar stores" in sentence
    assert "Texas" not in sentence, "the national rung covers everywhere"
    assert " in national" not in sentence


def test_one_store_is_singular() -> None:
    sentence = build_provenance_sentence(
        Provenance(own_observations=8, own_weight=0.2, cohort_level="state",
                   cohort_size=1, evidence_state="NEW"),
        CohortPrecedent(level="state", size=1, region="Texas"),
    )
    assert "1 similar store in Texas" in sentence


def test_the_provenance_sentence_is_not_written_by_the_model() -> None:
    """It is generated from Provenance even when the model wrote nothing."""
    card = render_explanation(
        ExplanationRequest(
            record=record(),
            provenance=provenance(own_weight=0.4, own_observations=21,
                                  cohort_level="state", cohort_size=14),
            model_sentence=None,
            precedent=Precedent(
                cohort=CohortPrecedent(level="state", size=14, region="Texas")
            ),
        ),
        ctx(),
    ).value
    assert card.source == "template"
    assert "14 similar stores in Texas" in card.provenance_sentence


def test_the_rung_is_never_printed_as_if_it_were_a_place() -> None:
    """The first version read `cohort_level` as a place name and would have
    printed "based on 14 similar stores in state"."""
    card = render_explanation(
        ExplanationRequest(
            record=record(),
            provenance=provenance(own_weight=0.4, own_observations=21,
                                  cohort_level="state", cohort_size=14),
            model_sentence="Order 116.",
        ),
        ctx(),
    ).value
    assert "14 similar stores" in card.provenance_sentence
    for rung in ("in state", "in region", "in national", "in store"):
        assert rung not in card.provenance_sentence


# ── The contract with sheet 16 ───────────────────────────────────────────────


def test_allowed_figures_is_the_record_plus_the_provenance_figures() -> None:
    built = record()
    prov = provenance(own_weight=0.4, own_observations=21,
                      cohort_level="state", cohort_size=14)
    card = render_explanation(
        ExplanationRequest(record=built, provenance=prov,
                           model_sentence="Order 116."),
        ctx(),
    ).value
    for name, value in built.figures().items():
        assert card.allowed_figures[name] == value
    assert card.allowed_figures["cohort_size"] == 14.0
    assert card.allowed_figures["own_weeks"] == 3.0


def test_an_invented_figure_is_unaccounted_for() -> None:
    card = render_explanation(
        ExplanationRequest(record=record(), provenance=provenance(),
                           model_sentence="Order 116 and expect 900 in profit."),
        ctx(),
    ).value
    assert unaccounted_numerals(card.sentence, card.allowed_figures, ctx()) == ["900"]


def test_a_rounded_figure_is_caught_because_rounding_is_computing() -> None:
    card = render_explanation(
        ExplanationRequest(record=record(), provenance=provenance(),
                           model_sentence="Order about 120 units."),
        ctx(),
    ).value
    assert unaccounted_numerals(card.sentence, card.allowed_figures, ctx(),
                                literals=card.allowed_literals) == ["120"]


def test_provenance_figures_are_allowed_only_when_the_clause_is_printed() -> None:
    """A permitted numeral that appears nowhere on the card is a hole.

    Found by a fixture whose `own_observations` happened to be 120, which let
    an invented "about 120 units" pass on a card carrying no hedge at all.
    """
    no_hedge = render_explanation(
        ExplanationRequest(record=record(),
                           provenance=provenance(own_weight=1.0,
                                                 own_observations=120),
                           model_sentence="Order 116."),
        ctx(),
    ).value
    assert no_hedge.provenance_sentence == ""
    assert "own_observations" not in no_hedge.allowed_figures

    hedged = render_explanation(
        ExplanationRequest(record=record(),
                           provenance=provenance(own_weight=0.4,
                                                 own_observations=120,
                                                 cohort_level="state",
                                                 cohort_size=14),
                           model_sentence="Order 116."),
        ctx(),
    ).value
    assert hedged.provenance_sentence
    assert hedged.allowed_figures["own_observations"] == 120.0


def test_display_rounding_is_absorbed() -> None:
    allowed = {"demand": 277.79999999999995}
    assert unaccounted_numerals("expect 277.8", allowed, ctx()) == []


def test_the_template_sentence_invents_no_figure() -> None:
    """The floor the model has to beat must itself be faithful."""
    card = render_explanation(
        ExplanationRequest(record=record(), provenance=provenance(),
                           model_sentence=None),
        ctx(),
    ).value
    assert unaccounted_numerals(card.full_text, card.allowed_figures, ctx(),
                                literals=card.allowed_literals) == []


def test_a_thousands_separator_is_one_figure_not_two() -> None:
    assert numerals_in("recover 1,389 dollars") == ["1,389"]
    assert unaccounted_numerals("recover 1,389", {"risk": 1389.0}, ctx()) == []


def test_the_rounding_tolerance_is_a_registry_setting() -> None:
    assert DISPLAY_ROUNDING_TOLERANCE.status == "PROVISIONAL"
    assert DISPLAY_ROUNDING_TOLERANCE.owner
    tight = cfg.with_overrides("tight",
                               {DISPLAY_ROUNDING_TOLERANCE.name: 0.0})
    assert unaccounted_numerals("expect 277.8", {"d": 277.79999999999995},
                                ctx(config_version="tight"), tight) == ["277.8"]


# ── The model does not decide ────────────────────────────────────────────────


def test_the_explain_stage_cannot_change_the_decision() -> None:
    """Quantity, date and action come from the record, whatever the model
    wrote. A model that disagreed with a validated decision could only be
    wrong."""
    built = record()
    card = render_explanation(
        ExplanationRequest(record=built, provenance=provenance(),
                           model_sentence="Order 9000 of something else."),
        ctx(),
    ).value
    assert card.allowed_figures["quantity"] == 116.0
    assert unaccounted_numerals(card.sentence, card.allowed_figures, ctx(),
                                literals=card.allowed_literals)


def test_the_module_calls_no_model_and_reads_no_clock() -> None:
    from app.pipeline.explain import precedent as precedent_module
    from app.pipeline.explain import prompt as prompt_module
    from app.pipeline.explain import render as render_module
    from app.pipeline.explain import template as template_module

    banned_modules = {"random", "anthropic", "openai", "requests", "httpx",
                      "secrets", "time"}
    banned_calls = {"now", "today", "monotonic", "shuffle", "choice", "uniform"}
    for module in (precedent_module, prompt_module, render_module,
                   template_module):
        tree = ast.parse(inspect.getsource(module))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert alias.name.split(".")[0] not in banned_modules
            elif isinstance(node, ast.ImportFrom) and node.module:
                assert node.module.split(".")[0] not in banned_modules
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                assert node.func.attr not in banned_calls, module.__name__


def test_the_stage_never_fails_for_a_model_problem() -> None:
    """A writing failure must not delete a correct recommendation."""
    for sentence in (None, "", "I cannot.", "x" * 5000):
        result = render_explanation(
            ExplanationRequest(record=record(), provenance=provenance(),
                               model_sentence=sentence),
            ctx(),
        )
        assert result.ok, sentence
        assert result.value.sentence


def test_the_card_records_what_was_sent() -> None:
    """A card written months ago is unexplainable without all three."""
    card = render_explanation(
        ExplanationRequest(record=record(), provenance=provenance(),
                           model_sentence="Order 116.",
                           model_id="claude-sonnet-4-6", temperature=0.0),
        ctx(),
    ).value
    assert card.model_id == "claude-sonnet-4-6"
    assert card.temperature == 0.0
    assert card.template_version == PROMPT_TEMPLATE_VERSION


def test_retrieval_use_is_recorded_on_the_card() -> None:
    """"we retrieved five passages and used two" is something the card's
    provenance should be able to say."""
    kept, dropped = safe_passages([
        ("a crisp lager for warm afternoons", "doc:a"),
        ("moved 90 cases in July", "doc:b"),
    ])
    card = render_explanation(
        ExplanationRequest(
            record=record(), provenance=provenance(),
            model_sentence="Order 116.",
            precedent=Precedent(passages=tuple(kept), dropped=tuple(dropped)),
        ),
        ctx(),
    ).value
    assert card.retrieval_sources == ("doc:a",)
    assert card.retrieval_dropped == 1


def test_store_outcome_distinguishes_never_measured_from_never_acted() -> None:
    assert not StoreOutcome("reorder", times_recommended=4).has_history
    assert StoreOutcome("reorder", 4, times_acted=0).has_history


def test_the_outcome_context_carries_no_counts_into_the_prompt() -> None:
    """The numbers behind a store's history belong to the deterministic
    provenance sentence, not to prose the model rewrites."""
    prompt = build_prompt(
        record(),
        Precedent(outcome=StoreOutcome("reorder", 4, times_acted=3)),
    )
    context = prompt.user.split("CONTEXT")[1]
    assert "4" not in context and "3" not in context
    assert "some recommendations" in context


def test_an_explanation_serialises_for_the_card() -> None:
    card = Explanation(sentence="Order 116.", source="model",
                       provenance_sentence="(based on 14 similar stores)")
    payload = card.as_dict()
    assert payload["full_text"] == "Order 116. (based on 14 similar stores)"
    assert payload["source"] == "model"
