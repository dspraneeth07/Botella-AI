"""A card may name a live signal, and the writeup gets told what they are.

THE COMPLAINT THIS ANSWERS. An owner at Bethany had ten live signals on screen -
a Mavericks home game on 9 October, a Stars game on the 13th, an event on the
10th, four social trends, a forecast - and not one card mentioned any of them.
On the last live run, 0 of 44 cards cited a signal at five stores.

Three faults, and all three had to be fixed for a mention to reach a card:

    THE PROMPT ONLY GOT TOKENS. `active_keys` are `nba_home_game`,
    `event_nearby`, `trend_vodka`. Nothing an owner recognises, and nothing
    with a date in it, so the model had nothing concrete it was allowed to say.

    THE GUARD DISCARDED THE MENTION. `ground` throws away the WHOLE sentence
    over any numeral the engine does not own. "the Mavericks are home on Oct 9"
    died on the "9" - so obeying the invitation to mention a signal cost the
    sentence, every time.

    THE CARD RECORDED NOTHING. `deterministic.py` set `signals_cited: []` and
    nothing ever filled it, so even a surviving mention left no label behind.

What must NOT change: the model still cannot invent a figure, and still cannot
claim a signal causes sales. The tests below pin both.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.pipeline.context import RunContext
from app.recommender import narrate
from app.schemas.signals import (
    EventSignal,
    GameSignal,
    SignalBundle,
    TrendSignal,
    WeatherSignal,
)

AS_OF = date(2026, 10, 9)


def ctx() -> RunContext:
    return RunContext(
        run_id="test-narrate", tenant_id=171, store_id=171, as_of=AS_OF,
        snapshot_id="test", config_version="default", seed=0,
        versions={"narrate": "1.0.0"},
    )


def bethany_bundle() -> SignalBundle:
    """What was actually live at store 171 on 9 October 2026."""
    return SignalBundle(
        weather=WeatherSignal(summary="Mostly Clear", summary_date="2026-10-09"),
        sports=[
            GameSignal(league="nba", home="Dallas Mavericks",
                       away="Houston Rockets", date="2026-10-09"),
            GameSignal(league="nhl", home="Dallas Stars",
                       away="Colorado Avalanche", date="2026-10-13"),
        ],
        events=[EventSignal(name="Share the Arrows 2026",
                            venue="Credit Union of Texas Event Center",
                            date="2026-10-10")],
        social=[TrendSignal(term="vodka", source="youtube")],
        active_keys=["nba_home_game", "nhl_home_game", "event_nearby",
                     "trend_vodka"],
    )


CARD = {
    "action_type": "reorder",
    "primary_skus": ["619947000013"],
    "suggested_order_qty": 22,
    "holding_cost_if_unsold": 2.88,
    "rationale": "Order 22 units of Titos 1L.",
    "quantity_hint": "order 22 units",
}
NAMES = {"619947000013": "Titos 1L"}


# -- The signals reach the prompt, with their dates -------------------------


def test_the_lines_name_the_thing_an_owner_would_recognise() -> None:
    lines = narrate.signal_lines(bethany_bundle())
    joined = " | ".join(lines)
    assert "Houston Rockets at Dallas Mavericks" in joined
    assert "Share the Arrows 2026" in joined
    assert "Credit Union of Texas Event Center" in joined
    assert "vodka" in joined
    assert "Mostly Clear" in joined
    # Each carries its own date, which is the part a bare key never had - and
    # written the way a card writes it, because the model copies these verbatim
    # and an ISO string in prose would be both ugly and unmatched.
    assert "Oct 9" in joined
    assert "Oct 13" in joined
    assert "Oct 10" in joined
    assert "2026-10-09" not in joined


def test_an_empty_or_absent_bundle_yields_nothing() -> None:
    assert narrate.signal_lines(None) == ()
    assert narrate.signal_lines(SignalBundle()) == ()


def test_one_game_reported_by_two_clients_appears_once() -> None:
    g = GameSignal(league="nba", home="Dallas Mavericks",
                   away="Houston Rockets", date="2026-10-09")
    lines = narrate.signal_lines(SignalBundle(sports=[g, g]))
    assert len(lines) == 1


def test_the_prompt_carries_the_lines_and_forbids_a_causal_claim() -> None:
    prompt = narrate.build_user_prompt(
        CARD, store_name="Bethany", product_names=NAMES,
        active_signals=["nba_home_game"],
        signal_notes=["no signal has a measured effect on sales at this store"],
        signal_facts=narrate.signal_lines(bethany_bundle()),
    )
    assert "Houston Rockets at Dallas Mavericks" in prompt
    assert "VERBATIM" in prompt
    # The invitation and the prohibition must both be present: the whole point
    # is that a signal may be NAMED and never credited.
    assert "never claim they raise demand" in prompt
    assert "never as a cause" in prompt
    assert "no signal has a measured effect" in prompt


# -- The mention now survives the numeral check ------------------------------


def accepted(sentence: str, *, facts: bool) -> bool:
    lines = narrate.signal_lines(bethany_bundle())
    kw = {"signal_facts": narrate.signal_literals(lines)} if facts else {}
    got = narrate.ground(sentence, CARD, ctx(), product_names=NAMES, **kw)
    return got.source == "model"


def test_a_signals_own_date_was_what_killed_the_sentence() -> None:
    sentence = ("Order 22 units of Titos 1L; the Mavericks are home on Oct 9.")
    assert accepted(sentence, facts=False) is False, (
        "this is the bug: the 9 reads as an unaccounted figure")
    assert accepted(sentence, facts=True) is True, (
        "a date that came from ESPN is a fact we hold")


def test_a_temperature_from_the_forecast_survives_too() -> None:
    bundle = SignalBundle(weather=WeatherSignal(summary="Mostly Clear, high 89F"))
    lits = narrate.signal_literals(narrate.signal_lines(bundle))
    got = narrate.ground("Order 22 units of Titos 1L; it is 89F and clear.",
                         CARD, ctx(), product_names=NAMES, signal_facts=lits)
    assert got.source == "model"


def test_an_invented_figure_is_still_refused() -> None:
    """The guard must not have been widened into uselessness."""
    sentence = "Order 22 units of Titos 1L; expect 35% more sales on Oct 9."
    assert accepted(sentence, facts=True) is False


def test_a_date_no_signal_reported_is_still_refused() -> None:
    sentence = "Order 22 units of Titos 1L; the Mavericks are home on Oct 30."
    assert accepted(sentence, facts=True) is False


def test_a_quantity_the_card_does_not_carry_is_still_refused() -> None:
    sentence = "Order 40 units of Titos 1L before the game on Oct 9."
    assert accepted(sentence, facts=True) is False


# -- The card records which signal it named ----------------------------------


@pytest.mark.parametrize("sentence,expected", [
    ("The Mavericks are home on Oct 9, so keep Titos stocked.", True),
    ("Order 22 units of Titos 1L.", False),
    ("Vodka is trending; order 22 units of Titos 1L.", True),
])
def test_cited_means_the_sentence_actually_names_it(sentence, expected) -> None:
    lines = narrate.signal_lines(bethany_bundle())
    cited = [ln for ln in lines if narrate.mentions(sentence, ln)]
    assert bool(cited) is expected


def test_a_generic_word_does_not_count_as_a_mention() -> None:
    """Matching on "game" or "event" would credit almost every card."""
    lines = narrate.signal_lines(bethany_bundle())
    for sentence in ("There is a game this week.",
                     "This is a big event for the store.",
                     "Run a clearance on slow movers."):
        assert not [ln for ln in lines if narrate.mentions(sentence, ln)], sentence


def test_only_the_signal_that_was_named_is_cited() -> None:
    lines = narrate.signal_lines(bethany_bundle())
    sentence = "Stock up before the Avalanche visit the Stars on Oct 13."
    cited = [ln for ln in lines if narrate.mentions(sentence, ln)]
    assert len(cited) == 1
    assert "Colorado Avalanche" in cited[0]
    assert "Houston Rockets" not in cited[0]


# -- Each line says where it came from and what is known about it -----------


def test_every_line_carries_provenance_and_measured_status() -> None:
    """The answer to "why am I being shown this?", for both readers.

    The model needs it so it does not present a live signal as a reason to buy.
    The owner needs it because a game on the schedule and a game that moves
    sales at their store are different claims, and only one of them is being
    made.
    """
    for line in narrate.signal_lines(bethany_bundle()):
        assert "(" in line and line.rstrip().endswith(")"), line
        assert "measured effect" in line, line


def test_a_measured_effect_is_stated_as_measured() -> None:
    class Eff:
        beta = 0.18

    lines = narrate.signal_lines(
        SignalBundle(social=[TrendSignal(term="vodka", source="youtube")]),
        {("trend_vodka", "spirits"): Eff()},
    )
    assert "measured +18.0% on sales here" in lines[0], lines


def test_the_status_clause_cannot_credit_a_card_with_a_mention() -> None:
    """The parenthetical is provenance, not identity.

    Its words - "sales", "schedule", "feed", "measured" - are not identifying,
    and matching on them would record every card that used the word "sales" as
    citing every signal at the store.
    """
    line = ("NBA: Houston Rockets at Dallas Mavericks on Oct 9 "
            "(schedule feed; no measured effect on sales here)")
    assert narrate.mentions("Sales are up this week.", line) is False
    assert narrate.mentions("A scheduled delivery arrives Friday.", line) is False
    assert narrate.mentions("The Mavericks are home on Oct 9.", line) is True
