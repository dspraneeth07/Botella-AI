"""The model writes the sentence; the engine owns every number in it.

WHAT WAS WRONG. `pipeline.py` claimed "The model still writes the prose (sheets
15-16)". On the deterministic path it never ran at all: the only
`_llm.recommend` call sits in the superseded branch, and `app/pipeline/explain/`
- render, prompt, template, precedent, built for exactly this - was imported by
nothing in `app/recommender/`. Every card body was a hardcoded f-string, which is
why the cards read like arithmetic and why a page listing a home game and a heat
advisory mentioned neither on any card.

THESE TESTS PIN THE SAFETY PROPERTY, not the prose. Narration may improve a
sentence; it may never introduce a figure, change a decision, or claim a signal
moves sales. The LLM-choosing arm scored 24.2% against the engine's 75.9% and took
every store to zero cards during a billing failure - narration cannot do either,
and the fallbacks below are why.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.pipeline.context import RunContext
from app.recommender.narrate import (
    MAX_NARRATED_CHARS,
    SYSTEM,
    build_user_prompt,
    figures_for,
    ground,
    literals_for,
)
from app.pipeline.registry import ConfigRegistry

AS_OF = date(2026, 10, 7)
ENGINE_SENTENCE = ("Out of stock now, and it was selling 0.4 a day. "
                   "A delivery takes 7 days.")

CARD = {
    "action_type": "reorder",
    "primary_skus": ["081128005214"],
    "rationale": ENGINE_SENTENCE,
    "quantity_hint": "order 12 units of Fords Gin 1L",
    "suggested_order_qty": 12,
    "engine_daily_rate": 0.365,
    "expected_range_low": 1,
    "expected_range_high": 25,
    "holding_cost_if_unsold": 4.1,
    "confidence": 0.444,
    "valid_through": "2026-10-21",
}
NAMES = {"081128005214": "Fords Gin 1L"}


def ctx() -> RunContext:
    return RunContext(run_id="r", tenant_id=1, store_id=171, as_of=AS_OF,
                      snapshot_id="s", config_version="default", seed=0,
                      versions={"narrate": "1.0.0"})


def g(sentence):
    return ground(sentence, CARD, ctx(), product_names=NAMES)


# -- The allow-list comes off the card, never from a recomputation ------------


def test_the_allowed_figures_are_the_ones_the_card_published() -> None:
    allowed = figures_for(CARD)
    assert allowed["suggested_order_qty"] == 12.0
    assert allowed["engine_daily_rate"] == pytest.approx(0.365)
    assert allowed["holding_cost_if_unsold"] == pytest.approx(4.1)
    # A figure the card does not carry is not permitted in prose about the card.
    assert "promise_floor_units" not in allowed


def test_identifiers_and_sizes_are_literals_not_quantities() -> None:
    """A UPC is thirteen digits and a product name carries its size. Without this
    the verifier reads "1.75" in "Titos 1.75L" as an unaccounted figure and throws
    away a good sentence for naming the bottle.
    """
    literals = literals_for(CARD, NAMES)
    assert "081128005214" in literals
    assert "Fords Gin 1L" in literals
    assert "2026-10-21" in literals
    accepted = g("Order 12 units of Fords Gin 1L (081128005214).")
    assert accepted.narrated, accepted.refused


# -- A number the engine did not compute kills the whole sentence -------------


def test_an_invented_quantity_is_rejected() -> None:
    out = g("Order 40 units of Fords Gin 1L before the weekend.")
    assert not out.narrated
    assert "40" in out.refused
    assert out.sentence == ENGINE_SENTENCE


def test_an_invented_percentage_is_rejected() -> None:
    """The causal claim needs a number, and that is the second line of defence:
    even if the prompt rule were ignored, "will lift beer 15%" cannot survive the
    grounding check.
    """
    out = g("Order 12 units - the home game will lift beer 15%.")
    assert not out.narrated
    assert "15" in out.refused


def test_a_derived_figure_is_rejected_even_though_it_is_arithmetically_true() -> None:
    """0.365 a day over 30 days really is about 11 units. It is still refused,
    because a model allowed to derive is a model allowed to derive WRONGLY, and
    nothing downstream could tell the two apart.
    """
    out = g("It sells 0.365 a day, so about 11 over the next month.")
    assert not out.narrated
    assert "11" in out.refused


def test_the_whole_sentence_goes_not_just_the_bad_figure() -> None:
    out = g("Order 12 units of Fords Gin 1L; expect about 18 to sell.")
    assert out.sentence == ENGINE_SENTENCE
    assert "12" not in out.sentence or out.sentence == ENGINE_SENTENCE


# -- A signal may be MENTIONED and never credited -----------------------------


def test_mentioning_a_live_signal_is_allowed() -> None:
    """The owner can see the signal on the same page. Saying it is live is a fact
    about the world the engine fetched.
    """
    out = g("You are out of Fords Gin 1L and there is an NFL home game on Sunday; "
            "order 12 units.")
    assert out.narrated, out.refused


def test_the_prompt_forbids_the_causal_claim_in_words() -> None:
    """Belt as well as braces: the grounding check catches a QUANTIFIED claim, and
    an unquantified one ("the game will boost beer") carries no numeral at all. So
    the prompt has to forbid it, and this pins that it does.
    """
    assert "never claim they raise demand" in build_user_prompt(
        CARD, store_name="Bethany", product_names=NAMES,
        active_signals=["nfl_home_game"], signal_notes=["none"])
    assert "Do not claim a signal causes sales" in SYSTEM
    assert "may NOT" in SYSTEM


def test_the_prompt_carries_what_was_actually_measured() -> None:
    """So the model is not left to assume a live signal means an effect. For almost
    every signal the honest line is that we looked and the data cannot tell.
    """
    user = build_user_prompt(
        CARD, store_name="Marshfield", product_names=NAMES,
        active_signals=["heat_advisory"],
        signal_notes=["heat_advisory affects beer by +6.3% at this store"])
    assert "heat_advisory affects beer by +6.3%" in user
    assert "0.365" in user and "12" in user


# -- Every failure path lands on the engine's own sentence --------------------


def test_a_model_that_returns_nothing_changes_nothing() -> None:
    out = g(None)
    assert out.sentence == ENGINE_SENTENCE
    assert out.source == "engine"
    assert "nothing" in out.refused


def test_a_model_that_declines_changes_nothing() -> None:
    assert g("SKIP").sentence == ENGINE_SENTENCE
    assert g("   ").sentence == ENGINE_SENTENCE


def test_an_over_long_answer_is_refused_rather_than_truncated() -> None:
    """A sentence cut mid-clause can invert its own meaning, and "do not order"
    truncated at the comma is the worst possible failure on a card about money.
    """
    limit = int(ConfigRegistry().get(MAX_NARRATED_CHARS, ctx()))
    out = g("Order 12 units of Fords Gin 1L. " + ("and so on " * 200))
    assert not out.narrated
    assert "too long" in out.refused
    assert len(out.sentence) < limit


def test_multi_line_output_is_refused() -> None:
    out = g("Order 12 units.\n- also consider a promotion")
    assert not out.narrated
    assert "multi-line" in out.refused


def test_the_engine_sentence_is_always_recoverable() -> None:
    """Whatever happens, the auditable sentence survives. A card that reads well
    and a card you can check are both required.
    """
    for attempt in (None, "SKIP", "Order 999 units", "a\nb",
                    "Order 12 units of Fords Gin 1L."):
        out = ground(attempt, CARD, ctx(), product_names=NAMES)
        assert out.sentence
        assert out.source in ("model", "engine")
        if not out.narrated:
            assert out.sentence == ENGINE_SENTENCE
