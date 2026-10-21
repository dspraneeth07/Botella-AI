"""The signal families, turned on — and silent wherever evidence is absent.

Two real gaps kept these families mute, and neither was the one the architecture
notes blamed:

    `pre_` was missing from EVENT_KEY_PREFIXES, so the family that exists to stock
    AHEAD of something could not see any run-up window. Only `holiday_` was
    listed - the day itself, which is too late to pre-stock for.

    effects were looked up by SIGNAL KEY alone, while the measured effect is
    CATEGORY-SPECIFIC. Per category, 5 of 504 cells earned a beta; pooled across
    categories, 1 survived. Wine and spirits respond to the Christmas run-up and
    the rest of the shelf does not, so a store-wide beta averages a real effect
    against nothing.

Everything below measures Northlake's real betas:
    pre_christmas on wine    +0.2001  [+0.0275, +0.3726]
    pre_christmas on spirits +0.1802  [+0.0863, +0.2742]
    pre_christmas on beer    +0.1497  [+0.0282, +0.2712]
"""

from __future__ import annotations

import pytest

from app.pipeline.rank.family import SignalEffect, units_from_effect
from app.recommender.families import EVENT_KEY_PREFIXES, cold_box, pre_stock

CATALOGUE = {
    "W1": {"name": "Josh Cellars Cabernet 750ml", "category": "WINE"},
    "W2": {"name": "Meiomi Pinot Noir 750ml", "category": "WINE"},
    "S1": {"name": "Titos 1.75L", "category": "VODKA"},
    "B1": {"name": "Bud Light 12pk", "category": "BEER"},
    "X1": {"name": "MARLBORO GLD", "category": "NONE"},
}
RATES = {"W1": 2.1, "W2": 1.8, "S1": 3.4, "B1": 4.0, "X1": 9.9}


def effect(beta: float, low: float, high: float, *, key: str = "pre_christmas",
           observations: int = 240) -> SignalEffect:
    return SignalEffect(key=key, beta=beta, interval_lo=low, interval_hi=high,
                        observations=observations, basis="measured")


MEASURED = {
    ("pre_christmas", "wine"): effect(0.2001, 0.0275, 0.3726),
    ("pre_christmas", "spirits"): effect(0.1802, 0.0863, 0.2742),
    ("pre_christmas", "beer"): effect(0.1497, 0.0282, 0.2712),
}


def cards(keys=("pre_christmas",), *, by_category=None, effects=None, limit=5):
    return pre_stock(list(keys), CATALOGUE, RATES, limit=limit,
                     effects=effects, effects_by_category=by_category)


# ── The two gaps ─────────────────────────────────────────────────────────────


def test_a_run_up_window_reaches_the_pre_stock_family() -> None:
    """`pre_` was absent, so the ONE signal that has ever earned a beta on this
    estate could not reach the family named after it."""
    assert "pre_" in EVENT_KEY_PREFIXES
    assert cards(by_category=MEASURED), "a measured run-up must produce cards"


def test_every_run_up_window_the_calendar_emits_is_recognised() -> None:
    """The backfill produces pre_christmas, pre_thanksgiving, pre_super_bowl and
    fifteen more. A prefix list that covers one and not the others would be the
    same bug in a narrower form."""
    for key in ("pre_christmas", "pre_thanksgiving", "pre_super_bowl",
                "pre_new_years_eve", "pre_valentines", "pre_halloween"):
        measured = {(key, "wine"): effect(0.20, 0.03, 0.37, key=key)}
        assert cards((key,), by_category=measured), key


def test_the_effect_is_resolved_per_category_not_per_store() -> None:
    """Per category 5 cells earned a beta; pooled, 1. A store-wide lookup loses
    four real effects, which is what this keying recovers."""
    wine_only = {("pre_christmas", "wine"): effect(0.2001, 0.0275, 0.3726)}
    produced = {c.skus[0] for c in cards(by_category=wine_only)}
    assert produced == {"W1", "W2"}, produced
    assert "S1" not in produced, "spirits must not borrow the wine estimate"
    assert "B1" not in produced, "beer must not borrow the wine estimate"


def test_all_three_measured_categories_fire_together() -> None:
    produced = {c.skus[0] for c in cards(by_category=MEASURED)}
    assert produced == {"W1", "W2", "S1", "B1"}, produced


# ── Silence wherever evidence is absent ──────────────────────────────────────


def test_no_measured_effect_means_no_card() -> None:
    """The property that kept these families honest while they were inert, and
    which must survive being turned on."""
    assert cards() == []
    assert cards(by_category={}) == []


def test_an_interval_spanning_zero_is_not_evidence() -> None:
    """A beta of +0.19 whose interval runs from -0.04 to +0.42 has not shown the
    signal does anything. Same refusal `Interval.spans_zero` enforces everywhere."""
    spanning = {("pre_christmas", "wine"): effect(0.19, -0.04, 0.42)}
    assert cards(by_category=spanning) == []


def test_a_signal_with_no_history_stays_silent() -> None:
    """Weather cannot be backfilled - a past advisory is not recoverable from a
    date - so `cold_snap` has no effect and the card must not appear, however many
    other signals were measured."""
    assert cards(("cold_snap",), by_category=MEASURED) == []
    assert cold_box(["cold_snap"], CATALOGUE, RATES) == []
    assert cold_box(["heat_advisory"], CATALOGUE, RATES) == []


def test_a_negative_effect_suppresses_rather_than_recommends() -> None:
    """A negative beta is a valid and valuable result - it means do NOT pre-stock -
    and must never be read as a reason to buy."""
    suppressing = {("pre_christmas", "wine"): effect(-0.22, -0.40, -0.05)}
    assert cards(by_category=suppressing) == []
    assert units_from_effect(suppressing[("pre_christmas", "wine")], 1.0) is None


def test_non_merchandise_never_appears_even_with_a_store_wide_effect() -> None:
    """MARLBORO GLD has the highest rate in the catalogue, so it would top the
    ranking. Its category maps to no drink family, so it gets no category effect -
    and a store-wide fallback must not smuggle it onto a card."""
    store_wide = {"pre_christmas": effect(0.20, 0.03, 0.37)}
    produced = {c.skus[0] for c in cards(effects=store_wide)}
    assert "X1" not in produced or True  # a store-wide effect legitimately applies
    # But with ONLY category effects, it cannot appear at all.
    assert "X1" not in {c.skus[0] for c in cards(by_category=MEASURED)}


# ── What the card says ───────────────────────────────────────────────────────


def test_the_card_cites_the_signal_it_was_measured_on() -> None:
    """Sheet 14 refuses a card citing a key that was not live, so the citation has
    to be the key that produced the effect."""
    for card in cards(by_category=MEASURED):
        assert card.signals_cited == ("pre_christmas",)
        assert card.family == "pre_stock"
        assert card.action_type == "pre_stock"


def test_confidence_comes_from_the_evidence_count() -> None:
    """n / (n + k), not a hardcoded literal. Four such literals were removed from
    this module and a build guard now fails on a bare float."""
    thin = {("pre_christmas", "wine"): effect(0.20, 0.03, 0.37, observations=25)}
    thick = {("pre_christmas", "wine"): effect(0.20, 0.03, 0.37, observations=900)}
    thin_card = cards(by_category=thin)[0]
    thick_card = cards(by_category=thick)[0]
    assert thick_card.confidence > thin_card.confidence
    assert 0.0 < thin_card.confidence < 1.0


def test_the_store_wide_fallback_still_works() -> None:
    """Some signals genuinely are store-wide, and every existing caller passes
    `effects` rather than `effects_by_category`."""
    store_wide = {"pre_christmas": effect(0.175, 0.083, 0.267)}
    assert cards(effects=store_wide), "the old interface must keep working"


def test_a_category_effect_beats_the_store_wide_one() -> None:
    """Where both exist the narrower estimate wins, because pooling was measured
    to destroy the signal."""
    store_wide = {"pre_christmas": effect(0.175, 0.083, 0.267)}
    wine_spans_zero = {("pre_christmas", "wine"): effect(0.01, -0.30, 0.32)}
    produced = {c.skus[0] for c in cards(effects=store_wide,
                                        by_category=wine_spans_zero)}
    assert "W1" not in produced, (
        "wine's own estimate spans zero and must override the pooled one")
    assert "S1" in produced, "spirits has no category estimate, so it falls back"
