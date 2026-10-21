"""Sheet 22 — calendar facts, and the two things that make them trustworthy.

Every moving date is COMPUTED. A hardcoded table of holiday dates is correct
for one year and silently wrong afterwards, and the failure is invisible because
the dates still parse. So these tests pin known-good values across four years:
if the arithmetic drifts, this fails rather than the forecast quietly degrading.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.pipeline.features.calendar import (
    PRE_HOLIDAY_WINDOW,
    easter,
    facts_for,
    holidays_for,
    moving_holidays,
    peak_season_share,
)


@pytest.mark.parametrize("year,expected", [
    (2023, date(2023, 11, 23)), (2024, date(2024, 11, 28)),
    (2025, date(2025, 11, 27)), (2026, date(2026, 11, 26)),
    (2027, date(2027, 11, 25)),
])
def test_thanksgiving_is_the_fourth_thursday(year: int, expected: date) -> None:
    got = moving_holidays(year)["thanksgiving"]
    assert got == expected
    assert got.weekday() == 3


@pytest.mark.parametrize("year,expected", [
    (2023, date(2023, 4, 9)), (2024, date(2024, 3, 31)),
    (2025, date(2025, 4, 20)), (2026, date(2026, 4, 5)),
])
def test_easter_matches_the_published_dates(year: int, expected: date) -> None:
    """The computus is easy to get subtly wrong and impossible to notice."""
    assert easter(year) == expected
    assert easter(year).weekday() == 6


@pytest.mark.parametrize("year,expected", [
    (2024, date(2024, 5, 27)), (2025, date(2025, 5, 26)),
    (2026, date(2026, 5, 25)),
])
def test_memorial_day_is_the_last_monday_in_may(year: int, expected: date) -> None:
    got = moving_holidays(year)["memorial_day"]
    assert got == expected
    assert got.weekday() == 0
    assert (got + timedelta(days=7)).month == 6, "must be the LAST Monday"


def test_labor_day_is_the_first_monday_in_september() -> None:
    for year, expected in ((2025, date(2025, 9, 1)), (2026, date(2026, 9, 7))):
        got = moving_holidays(year)["labor_day"]
        assert got == expected
        assert got.weekday() == 0
        assert got.day <= 7


def test_the_super_bowl_moved_in_2022_and_the_code_knows() -> None:
    """It became the second Sunday in February when the season went to 17
    games. A table written in 2021 is wrong for every year since."""
    assert moving_holidays(2021)["super_bowl"] == date(2021, 2, 7)
    assert moving_holidays(2026)["super_bowl"] == date(2026, 2, 8)
    for y in (2022, 2023, 2024, 2025, 2026):
        assert moving_holidays(y)["super_bowl"].weekday() == 6


# ── Pre-holiday windows, which is where liquor money actually is ────────────


def test_the_window_matters_more_than_the_day() -> None:
    """A liquor store sells Thanksgiving drink on the Wednesday - most of the
    estate is shut on the Thursday."""
    thanksgiving = moving_holidays(2026)["thanksgiving"]
    eve = thanksgiving - timedelta(days=1)
    f = facts_for(eve)
    assert f.next_holiday == "thanksgiving"
    assert f.days_to_next_holiday == 1
    assert f.in_pre_holiday_window is True


def test_windows_differ_by_holiday_because_the_holidays_differ() -> None:
    """Christmas builds for a week; Valentine's does not. One shared window
    would be wrong for both."""
    assert PRE_HOLIDAY_WINDOW["christmas"] > PRE_HOLIDAY_WINDOW["valentines"]
    six_before = date(2026, 12, 19)          # 6 days before Christmas
    assert facts_for(six_before).in_pre_holiday_window is True
    six_before_vday = date(2026, 2, 8)       # 6 days before Valentine's
    f = facts_for(six_before_vday)
    assert f.next_holiday in ("valentines", "super_bowl")


def test_the_st_patricks_case_from_the_march_ledger() -> None:
    """The engine read a dip-then-recover around 17 March as mean reversion.
    These are the facts that let a forecaster tell the two apart."""
    assert facts_for(date(2026, 3, 2)).in_pre_holiday_window is False
    for d in (date(2026, 3, 15), date(2026, 3, 16), date(2026, 3, 17)):
        f = facts_for(d)
        assert f.next_holiday == "st_patricks"
        assert f.in_pre_holiday_window is True
    assert facts_for(date(2026, 3, 17)).holiday == "st_patricks"


def test_the_year_boundary_does_not_blank_the_busiest_week() -> None:
    """On 30 December the nearest upcoming holiday after New Year's Day is in
    the FOLLOWING year. A function that only looked at d.year would return None
    for the busiest week of the trade."""
    for d in (date(2026, 12, 28), date(2026, 12, 30), date(2026, 12, 31)):
        f = facts_for(d)
        assert f.next_holiday is not None, d
        assert f.days_to_next_holiday is not None and f.days_to_next_holiday >= 0


def test_post_holiday_suppression_is_recorded() -> None:
    """The shelf was stocked and the party happened. A forecaster should learn
    the dip rather than the engine mistaking it for a product going bad."""
    f = facts_for(date(2026, 1, 2))
    assert f.days_since_last_holiday is not None
    assert f.in_post_holiday_window is True


def test_peak_share_separates_two_windows_the_engine_treats_alike() -> None:
    """The quantity a forecast needs. A 60-day window ending 2 January is
    mostly Christmas; one ending 2 September is mostly nothing. Today's engine
    projects the same trailing rate across both."""
    december = peak_season_share(date(2025, 11, 4), date(2026, 1, 2))
    september = peak_season_share(date(2026, 7, 5), date(2026, 9, 2))
    assert december > september
    assert september == pytest.approx(0.0)
    assert 0.0 < december < 1.0


def test_facts_are_a_pure_function_of_the_date() -> None:
    """No clock read, so a backtest in 2026 and a replay in 2031 agree."""
    d = date(2026, 3, 17)
    assert facts_for(d).as_dict() == facts_for(d).as_dict()


def test_every_holiday_resolves_for_every_year_in_the_export() -> None:
    for year in range(2022, 2031):
        h = holidays_for(year)
        assert len(h) >= 15, year
        for name, when in h.items():
            assert when.year == year, f"{name} in {year} resolved to {when}"
