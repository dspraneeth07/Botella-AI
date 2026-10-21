"""Weather history from an archive — and what it actually measured.

This corrects a claim this codebase made about itself. `signal_backfill` says
weather "cannot be backfilled", because a past advisory is not recoverable from a
date. That is true of a CALENDAR and false of the world: daily highs and lows for a
coordinate are public record, and a free archive returns them for any date. The
cold-box family sat silent for want of a lookup nobody had written.

With the real archive fetched for five stores over 1,361 days, the answer is a
negative one, and it is worth more than a card would have been:

    heat     earns NO usable effect at any store, despite 241-458 hot days
    cold     earns one, at Marshfield, and it is NEGATIVE: beer falls 11.8%
"""

from __future__ import annotations

from datetime import date

import pytest

from app.pipeline.features.signal_backfill import is_reconstructible
from app.pipeline.features.weather_archive import (
    ARCHIVED_ORIGIN,
    ARCHIVE_SOURCE,
    UNRECONSTRUCTIBLE_WEATHER_KEYS,
    ArchiveDay,
    celsius_to_fahrenheit,
    days_from_archive,
    rows_for,
)
from app.pipeline.rank.family import SignalEffect
from app.recommender.families import cold_box
from app.signals.weather import COLD_THRESHOLD_F, HEAT_THRESHOLD_F


# ── The thresholds must be the live ones ─────────────────────────────────────


def test_the_thresholds_are_imported_not_restated() -> None:
    """A hot day in the fit and a hot day on the card have to be the same thing.
    Writing 88 and 25 again in the archive module would let the historical path
    and the live path drift apart silently, and then the coefficient would describe
    one definition while the card fired on another."""
    import pathlib

    source = (pathlib.Path(__file__).parent.parent / "app" / "pipeline"
              / "features" / "weather_archive.py").read_text(encoding="utf-8")
    assert "from app.signals.weather import" in source
    assert "HEAT_THRESHOLD_F" in source and "COLD_THRESHOLD_F" in source
    # And the numbers themselves are NOT written in this module.
    assert "= 88" not in source and "= 25" not in source


def test_a_day_raises_exactly_the_keys_the_live_module_would() -> None:
    hot = ArchiveDay(date(2026, 7, 1), float(HEAT_THRESHOLD_F), 70.0)
    cold = ArchiveDay(date(2026, 1, 15), 40.0, float(COLD_THRESHOLD_F))
    mild = ArchiveDay(date(2026, 4, 1), float(HEAT_THRESHOLD_F) - 1,
                      float(COLD_THRESHOLD_F) + 1)
    assert hot.active_keys() == ("heat_advisory",)
    assert cold.active_keys() == ("cold_snap",)
    assert mild.active_keys() == ()


def test_a_missing_reading_is_absence_not_a_cool_day() -> None:
    """An absent temperature must not become a False. Treating it as one would
    write a fabricated negative into the history, and the elasticity would then be
    fitted against days nobody measured."""
    no_high = ArchiveDay(date(2026, 7, 1), None, 70.0)
    assert "heat_advisory" not in no_high.active_keys()
    no_low = ArchiveDay(date(2026, 1, 1), 40.0, None)
    assert "cold_snap" not in no_low.active_keys()
    assert ArchiveDay(date(2026, 1, 1), None, None).active_keys() == ()


# ── strength is an INTENSITY, which is what the constraint caught ────────────


def test_strength_is_degrees_past_the_threshold_never_the_temperature() -> None:
    """A type error the database caught. `signal_history.strength` is constrained
    non-negative because it means an intensity; a Fahrenheit temperature is an
    interval scale with an arbitrary zero, and Calumet Park has sub-zero days that
    violated the constraint outright."""
    rows = rows_for([ArchiveDay(date(2026, 1, 20), 10.0, -8.0)],
                    client_id=178, location_id=178)
    assert len(rows) == 1
    # -8F against a 25F threshold is 33 degrees past, not -8.
    assert rows[0]["strength"] == pytest.approx(33.0)
    assert rows[0]["strength"] >= 0.0


def test_every_strength_is_non_negative_across_a_realistic_range() -> None:
    """The constraint is `strength IS NULL OR strength >= 0`. This is the property
    that has to hold for every row the module can emit, not just the one that
    failed."""
    days = [ArchiveDay(date(2026, 1, 1) if low < 30 else date(2026, 7, 1),
                       high, low)
            for high, low in ((120.0, 95.0), (10.0, -30.0), (88.0, 25.0),
                              (89.0, 24.0), (-5.0, -40.0))]
    for row in rows_for(days, client_id=1, location_id=1):
        assert row["strength"] is None or row["strength"] >= 0.0, row


def test_heat_and_cold_intensities_are_comparable() -> None:
    """95F on a heat day and 18F on a cold day are both 7 degrees past, which is
    the quantity an effect would actually scale with."""
    hot = rows_for([ArchiveDay(date(2026, 7, 1), 95.0, 70.0)],
                   client_id=1, location_id=1)[0]
    cold = rows_for([ArchiveDay(date(2026, 1, 1), 40.0, 18.0)],
                    client_id=1, location_id=1)[0]
    assert hot["strength"] == pytest.approx(7.0)
    assert cold["strength"] == pytest.approx(7.0)


# ── Provenance: archived is neither computed nor captured ────────────────────


def test_rows_are_marked_archived_not_captured() -> None:
    """An archive is a REANALYSIS - revised, interpolated to a grid point rather
    than measured at the shop door. Calling it 'captured' would assert the engine
    was watching at the time, which is exactly the claim `origin` exists to stop
    being made falsely."""
    row = rows_for([ArchiveDay(date(2026, 7, 1), 95.0, 70.0)],
                   client_id=1, location_id=1)[0]
    assert row["origin"] == ARCHIVED_ORIGIN == "archived"
    assert row["origin"] != "captured"
    assert row["origin"] != "computed"
    assert row["source"] == ARCHIVE_SOURCE


def test_severe_weather_is_still_not_recoverable() -> None:
    """It depends on whether a WARNING WAS ISSUED, which is an administrative act
    and not a temperature. No archive of daily highs recovers it."""
    assert "severe_weather" in UNRECONSTRUCTIBLE_WEATHER_KEYS
    assert is_reconstructible("severe_weather") is False
    emitted = {r["signal_key"] for r in rows_for(
        [ArchiveDay(date(2026, 7, 1), 120.0, -20.0)], client_id=1, location_id=1)}
    assert "severe_weather" not in emitted


# ── Only open days count ─────────────────────────────────────────────────────


def test_only_trading_days_produce_rows() -> None:
    """A closed Sunday that happened to be hot is not an observation about this
    store's response to heat, and including it would dilute the active-day count
    with days that could not have sold anything."""
    open_day, shut_day = date(2026, 7, 1), date(2026, 7, 5)
    days = [ArchiveDay(open_day, 95.0, 70.0), ArchiveDay(shut_day, 99.0, 75.0)]
    rows = rows_for(days, client_id=1, location_id=1, trading_days=[open_day])
    assert [r["as_of"] for r in rows] == [open_day.isoformat()]
    # Without a trading calendar, both are kept - the caller decides.
    assert len(rows_for(days, client_id=1, location_id=1)) == 2


# ── Parsing a real archive response ──────────────────────────────────────────


def test_a_ragged_archive_response_is_tolerated() -> None:
    """The archive occasionally returns a null for a date, and the arrays can be
    short. A null is carried as None rather than coerced."""
    payload = {"daily": {
        "time": ["2026-07-01", "2026-07-02", "not-a-date", "2026-07-04"],
        "temperature_2m_max": [95.0, None, 90.0],
        "temperature_2m_min": [70.0, 68.0],
    }}
    days = days_from_archive(payload)
    assert [d.day.isoformat() for d in days] == [
        "2026-07-01", "2026-07-02", "2026-07-04"]
    assert days[1].high_f is None
    assert days[2].low_f is None


def test_celsius_is_converted_when_asked() -> None:
    assert celsius_to_fahrenheit(0) == pytest.approx(32.0)
    assert celsius_to_fahrenheit(100) == pytest.approx(212.0)
    assert celsius_to_fahrenheit(35) == pytest.approx(95.0)
    payload = {"daily": {"time": ["2026-07-01"],
                         "temperature_2m_max": [35.0],
                         "temperature_2m_min": [20.0]}}
    day = days_from_archive(payload, already_fahrenheit=False)[0]
    assert day.high_f == pytest.approx(95.0)


def test_an_empty_response_is_empty_not_an_error() -> None:
    assert days_from_archive({}) == []
    assert days_from_archive({"daily": {}}) == []


# ── What cold_box does with the measured answer ──────────────────────────────


def CHILLABLE() -> dict[str, dict]:
    return {
        "B1": {"name": "Bud Light Beer 12pk", "category": "BEER", "size_ml": 355},
        "S1": {"name": "White Claw Seltzer", "category": "SELTZER", "size_ml": 355},
        "L1": {"name": "Titos 1.75L", "category": "VODKA", "size_ml": 1750},
    }


RATES = {"B1": 4.0, "S1": 2.4, "L1": 3.4}


def effect(beta, low, high, key="cold_snap", n=568):
    return SignalEffect(key=key, beta=beta, interval_lo=low, interval_hi=high,
                        observations=n, basis="measured")


def test_the_measured_cold_effect_produces_no_card() -> None:
    """Marshfield's real number: beer FALLS 11.8% in a cold snap. Reading that as
    a reason to stock up would be the exact inversion the interval test exists to
    prevent, and it is the only usable weather effect in the estate."""
    measured = {("cold_snap", "beer"): effect(-0.1180, -0.1784, -0.0577)}
    assert cold_box(["cold_snap"], CHILLABLE(), RATES,
                    effects_by_category=measured) == []


def test_a_positive_effect_of_the_same_size_would_produce_cards() -> None:
    """So the silence above is the EVIDENCE talking, not the wiring being broken.
    Without this test, "no cards" and "not connected" look identical."""
    positive = {("heat_advisory", "beer"): effect(
        0.1180, 0.0577, 0.1784, key="heat_advisory")}
    cards = cold_box(["heat_advisory"], CHILLABLE(), RATES, limit=3,
                     effects_by_category=positive)
    assert cards, "a positive measured effect must produce a card"
    assert all(c.family == "cold_box" for c in cards)


def test_seltzer_inherits_the_beer_estimate_because_the_taxonomy_says_so() -> None:
    """SELTZER, MALT and HARD SELTZER all map to the `beer` family, so a beer
    estimate legitimately covers them. Worth pinning: it looks like a leak until
    you check the taxonomy."""
    from app.pipeline.features.taxonomy import category_family_of

    assert category_family_of("SELTZER") == "beer"
    positive = {("heat_advisory", "beer"): effect(
        0.12, 0.06, 0.18, key="heat_advisory")}
    produced = {c.skus[0] for c in cold_box(
        ["heat_advisory"], CHILLABLE(), RATES, limit=3,
        effects_by_category=positive)}
    assert "S1" in produced


def test_a_large_bottle_is_never_a_cold_box_card() -> None:
    """Whatever the effect says. A 1.75L bottle does not go in the cooler."""
    everything = {("heat_advisory", "beer"): effect(0.12, 0.06, 0.18,
                                                    key="heat_advisory"),
                  ("heat_advisory", "spirits"): effect(0.12, 0.06, 0.18,
                                                       key="heat_advisory")}
    produced = {c.skus[0] for c in cold_box(
        ["heat_advisory"], CHILLABLE(), RATES, limit=3,
        effects_by_category=everything)}
    assert "L1" not in produced
