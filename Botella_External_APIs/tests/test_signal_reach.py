"""Track-1 tests: events & news drive eligibility, and the expanded calendar."""

from __future__ import annotations

import calendar
from datetime import date

from app.schemas.signals import EventSignal, NewsSignal
from app.signals.events import keys_for_events
from app.signals.holidays import _easter, _holidays_for_year
from app.signals.mapping import SIGNAL_CATEGORY_MAP, active_categories
from app.signals.news import keys_for_news

# ----- events -> keys -----------------------------------------------------


def test_event_concert_and_nearby_keys() -> None:
    events = [EventSignal(name="Live in Concert", category="Music")]
    keys = keys_for_events(events)
    assert "event_concert" in keys
    assert "event_nearby" in keys  # any nearby event widens the broad pool


def test_event_festival_detected_from_name() -> None:
    events = [EventSignal(name="Downtown Beer Fest 2026", category=None)]
    assert "event_festival" in keys_for_events(events)


def test_event_sports_and_arts_segments() -> None:
    assert "event_sports" in keys_for_events([EventSignal(name="Game", category="Sports")])
    assert "event_arts" in keys_for_events(
        [EventSignal(name="Ballet", category="Arts & Theatre")]
    )


def test_no_events_no_keys() -> None:
    assert keys_for_events([]) == []


def test_event_keys_widen_candidate_pool() -> None:
    # The whole point: a concert must make beer/seltzer eligible.
    cats = active_categories(keys_for_events([EventSignal(name="Show", category="Music")]))
    assert "beer" in cats and "seltzer" in cats


# ----- news -> keys -------------------------------------------------------


def test_news_viral_cocktail_key() -> None:
    news = [NewsSignal(headline="This viral cocktail is everywhere", category="lifestyle")]
    assert keys_for_news(news) == ["news_viral_cocktail"]


def test_news_festival_key() -> None:
    news = [NewsSignal(headline="Annual music festival returns downtown", category="local")]
    assert "news_festival" in keys_for_news(news)


def test_news_macro_stories_emit_no_keys() -> None:
    # Tariffs/layoffs are ambiguous in direction -> soft context only, no keys.
    news = [
        NewsSignal(headline="New tariff hits imports", category="business"),
        NewsSignal(headline="Local plant announces layoffs", category="business"),
    ]
    assert keys_for_news(news) == []


# ----- expanded calendar --------------------------------------------------


def test_easter_known_dates() -> None:
    assert _easter(2026) == date(2026, 4, 5)
    assert _easter(2027) == date(2027, 3, 28)


def test_mardi_gras_is_47_days_before_easter() -> None:
    by_key = {k: d for k, _n, d in _holidays_for_year(2026)}
    assert (by_key["easter"] - by_key["mardi_gras"]).days == 47


def test_new_holidays_present() -> None:
    keys = {k for k, _n, _d in _holidays_for_year(2026)}
    for expected in (
        "valentines", "mardi_gras", "easter", "mothers_day", "fathers_day",
        "oktoberfest", "day_of_dead", "lunar_new_year",
    ):
        assert expected in keys, expected


def test_fathers_day_2026_is_third_sunday_june() -> None:
    by_key = {k: d for k, _n, d in _holidays_for_year(2026)}
    assert by_key["fathers_day"] == date(2026, 6, 21)


def test_every_holiday_key_is_mapped() -> None:
    # Invariant: an emitted holiday key with no category map yields an empty
    # signal-aligned slice. Covers the newly added keys too.
    for year in (2026, 2027):
        for key, _name, _day in _holidays_for_year(year):
            assert key in SIGNAL_CATEGORY_MAP, f"{key} missing from category map"


def test_lunar_new_year_skipped_outside_table() -> None:
    keys = {k for k, _n, _d in _holidays_for_year(1999)}
    assert "lunar_new_year" not in keys  # no table entry -> not emitted


def test_oktoberfest_is_saturday() -> None:
    by_key = {k: d for k, _n, d in _holidays_for_year(2026)}
    assert by_key["oktoberfest"].weekday() == calendar.SATURDAY


def test_event_festival_matching_is_word_bounded() -> None:
    # "fest" inside "Lifestyle" must not fire; words ENDING in -fest must.
    assert "event_festival" not in keys_for_events(
        [EventSignal(name="Healthy Lifestyle Expo")]
    )
    assert "event_festival" in keys_for_events([EventSignal(name="Oktoberfest 2026")])
    assert "event_festival" in keys_for_events([EventSignal(name="Fall Brewfest")])
