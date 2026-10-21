"""The effects pipe: fit -> publish -> store -> serve -> parse -> card.

WHAT WAS BROKEN. `cold_box` and `pre_stock` refuse without a measured effect,
which is correct - a festival is SCHEDULED for a weekend that was going to be busy
anyway, so the confound runs TOWARD finding an effect. The measurement existed in
`elasticity/signal.py`. What did not exist was anywhere to put the answer: no
table, no endpoint, nothing in `app/recommender` that read one.

So the engine gathered five to thirteen live signals a store - home fixtures for
four leagues, heat advisories, severe weather, concerts, social trends - and cited
ZERO of them on ZERO cards, at every store, forever.

These tests pin the pipe and, more importantly, pin the REFUSALS: supplying the
effects must not make the families talkative. 499 of 504 cells refused on the
estate-wide fit, and the engine declining to say "there is a game tonight, stock
beer" is the system working.
"""

from __future__ import annotations

import pytest

from app.recommender.families import (
    MIN_SIGNAL_OBSERVATIONS,
    cold_box,
    confidence_from_evidence,
    pre_stock,
    signal_effects_from_rows,
)

CATALOGUE = {
    "W1": {"name": "Barefoot Pinot Grigio 750ml", "category": "WINE",
           "size_ml": 750},
    "S1": {"name": "Titos Vodka 750ml", "category": "VODKA", "size_ml": 750},
    "B1": {"name": "Bud Light 12pk", "category": "BEER", "size_ml": 355},
}
RATES = {"W1": 3.0, "S1": 4.0, "B1": 6.0}


def row(key: str, family: str, beta, lo, hi, *,
        observations: int = 1363, active_days: int = 21,
        refused: str | None = None) -> dict:
    """One row in the shape migration 029 stores and the endpoint serves."""
    return {"signal_key": key, "category_family": family, "beta": beta,
            "own_beta": beta, "interval_lo": lo, "interval_hi": hi,
            "own_weight": 1.0, "observations": observations,
            "active_days": active_days, "refused_reason": refused,
            "basis": "own_only", "fit_from": "2023-01-01",
            "fit_to": "2026-09-24", "usable": refused is None}


# -- Parsing, and the refusal rule applied a second time ----------------------


def test_a_usable_row_becomes_an_effect() -> None:
    effects = signal_effects_from_rows(
        [row("pre_christmas", "wine", 0.2001, 0.0275, 0.3726)])
    assert ("pre_christmas", "wine") in effects
    assert effects[("pre_christmas", "wine")].beta == pytest.approx(0.2001)


def test_an_interval_spanning_zero_is_dropped_even_when_the_row_claims_usable() -> None:
    """The endpoint filters on its own `usable` column and every row is checked
    again here. Not belt-and-braces: the two live in different languages on
    opposite sides of a network hop, and a single implementation of "an effect that
    might be negative is not an effect", reachable from only one of them, is how
    the rule stops being enforced.
    """
    lying = row("heat_advisory", "beer", 0.04, -0.02, 0.10)
    lying["usable"] = True                      # the row insists
    assert signal_effects_from_rows([lying]) == {}


def test_a_refused_row_contributes_nothing() -> None:
    assert signal_effects_from_rows(
        [row("nfl_home_game", "beer", None, None, None,
             refused="too_few_active_days:3<20")]) == {}


def test_a_missing_beta_is_dropped_rather_than_defaulted_to_zero() -> None:
    """A SignalEffect built from a missing beta would be an effect of zero
    presented as a measurement, and `cold_box` would read it as "measured, and not
    worth acting on" when the truth is "we do not know".
    """
    assert signal_effects_from_rows(
        [row("cold_snap", "beer", None, 0.1, 0.2)]) == {}


def test_a_negative_effect_is_kept_because_it_is_a_result() -> None:
    """Marshfield has one usable weather effect and it is beer FALLING 11.8% in a
    cold snap. That says do not pre-stock, and do not read the dip afterwards as
    something to recover from.
    """
    effects = signal_effects_from_rows(
        [row("cold_snap", "beer", -0.1180, -0.1784, -0.0577)])
    assert effects[("cold_snap", "beer")].beta == pytest.approx(-0.1180)


def test_one_malformed_row_costs_its_own_cell_and_nothing_else() -> None:
    good = row("pre_christmas", "wine", 0.20, 0.08, 0.32)
    bad = row("pre_christmas", "spirits", "not-a-number", 0.08, 0.32)
    worse = {"signal_key": "", "category_family": "beer"}
    assert set(signal_effects_from_rows([bad, good, worse])) == {
        ("pre_christmas", "wine")}


def test_empty_input_is_an_empty_map_not_an_error() -> None:
    """The normal state. 499 of 504 cells refused estate-wide, so most stores
    legitimately publish nothing a card may cite.
    """
    assert signal_effects_from_rows([]) == {}
    assert signal_effects_from_rows(None) == {}


# -- THE UNIT MISMATCH, which made a card claim 0.99 on 21 days ---------------


def test_confidence_rests_on_active_days_not_total_days() -> None:
    """MIN_SIGNAL_OBSERVATIONS is denominated in ACTIVE days - its own comment in
    families.py says so. The fit reports both: 1,363 days observed of which 21 had
    pre_christmas on. Feeding the total made a card state confidence 0.99 on an
    effect resting on twenty-one days.

    Same mismatch the event playbook hit from the other direction, where four
    annual Thanksgivings scored 0.167 against a daily-signal constant. Both times
    the number looked plausible and measured the wrong thing.
    """
    effects = signal_effects_from_rows(
        [row("pre_christmas", "wine", 0.2001, 0.0275, 0.3726,
             observations=1363, active_days=21)])
    effect = effects[("pre_christmas", "wine")]
    assert effect.observations == 21, "the contrast is the evidence, not the span"
    card = pre_stock(["pre_christmas"], CATALOGUE, RATES, limit=1,
                     effects_by_category=effects)[0]
    assert card.confidence == pytest.approx(
        confidence_from_evidence(21, MIN_SIGNAL_OBSERVATIONS), abs=1e-9)
    assert 0.45 < card.confidence < 0.60, card.confidence
    # The figure it used to report, recorded so the regression is legible.
    assert confidence_from_evidence(1363, MIN_SIGNAL_OBSERVATIONS) > 0.98


def test_a_row_without_active_days_falls_back_rather_than_failing() -> None:
    """An older publisher, or a hand-written row, has no `active_days`. A
    too-generous confidence beats no card and no explanation.
    """
    legacy = row("pre_christmas", "wine", 0.20, 0.08, 0.32)
    legacy.pop("active_days")
    assert signal_effects_from_rows([legacy])[
        ("pre_christmas", "wine")].observations == 1363


# -- What reaches a card ------------------------------------------------------


def test_the_measured_effect_produces_cards_for_the_right_families() -> None:
    effects = signal_effects_from_rows([
        row("pre_christmas", "wine", 0.2001, 0.0275, 0.3726),
        row("pre_christmas", "spirits", 0.1802, 0.0863, 0.2742),
    ])
    cards = pre_stock(["pre_christmas"], CATALOGUE, RATES, limit=3,
                      effects_by_category=effects)
    cited = {sku for c in cards for sku in c.skus}
    assert "W1" in cited and "S1" in cited
    # Beer earned no effect in this fit, so it gets no card.
    assert "B1" not in cited
    assert all(c.signals_cited == ("pre_christmas",) for c in cards)


def test_a_signal_that_measured_nothing_still_produces_nothing() -> None:
    """THE POINT. Supplying the effects must not make the families talkative.
    "There is a home game tonight, stock beer" is a claim this estate data does not
    support - 488 of 489 cells refused against day-of-week, month and trend
    controls - and the engine declining to make it is the system working.
    """
    effects = signal_effects_from_rows(
        [row("pre_christmas", "wine", 0.2001, 0.0275, 0.3726)])
    for key in ("nfl_home_game", "nba_home_game", "heat_advisory",
                "trend_bourbon", "severe_weather", "event_concert"):
        assert pre_stock([key], CATALOGUE, RATES,
                         effects_by_category=effects) == [], key
        assert cold_box([key], CATALOGUE, RATES,
                        effects_by_category=effects) == [], key


def test_the_families_are_still_silent_with_no_effects_at_all() -> None:
    """The state the live route was stuck in, pinned so a later change cannot
    quietly turn these families into guessers.
    """
    assert pre_stock(["pre_christmas"], CATALOGUE, RATES) == []
    assert cold_box(["heat_advisory"], CATALOGUE, RATES) == []


def test_a_negative_effect_produces_no_cold_box_card() -> None:
    """Reading "beer falls 11.8% in a cold snap" as a reason to stock up would be
    the exact inversion the interval test exists to prevent.
    """
    effects = signal_effects_from_rows(
        [row("cold_snap", "beer", -0.1180, -0.1784, -0.0577)])
    assert cold_box(["cold_snap"], CATALOGUE, RATES,
                    effects_by_category=effects) == []
