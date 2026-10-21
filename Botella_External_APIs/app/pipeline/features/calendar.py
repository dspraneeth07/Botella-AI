"""Calendar effects — the signal the engine currently reads as mean reversion.

WHY THIS IS NOT A NICE-TO-HAVE
    A product that goes quiet in early March and recovers around St Patrick's
    Day is a CALENDAR effect. The current engine sees a depressed trailing
    window followed by a recovery and records it as mean reversion: right about
    direction, wrong about mechanism, and therefore wrong about timing.

    The M5 competition organisers called calendar, special-day and price
    variables critical, and liquor is more seasonal than most retail - one
    retailer puts the holiday period at 15-18% of annual sales. Separating
    "this dips every year in week 9" from "this dipped and will revert" is the
    difference between a signal and a coincidence.

A WARNING WRITTEN FROM A FAILED ATTEMPT
    Seasonality has already been tried on this engine ONCE, as a raw ratio
    feature in the ranking, and it made every horizon WORSE - the 90-day hit
    rate fell from 70.0% to 58.4%. Its decile spread was ~11 points against
    reversion's 49-61.

    The lesson is not "seasonality does not work". It is that a ratio of two
    noisy windows is a terrible estimator, and that a ranking term is the wrong
    place for it. This module therefore produces FLAGS AND DISTANCES - facts
    about the date - and leaves the weighting to whatever consumes them. A
    forecaster can learn that Thanksgiving Eve matters at this store and not at
    that one; a hand-written ranking multiplier cannot.

MOVING DATES ARE COMPUTED, NEVER TABULATED
    A hardcoded list of holiday dates is correct for one year and silently
    wrong afterwards, and the failure is invisible because the dates still
    parse. Thanksgiving is the fourth Thursday in November. Memorial Day is the
    last Monday in May. The Super Bowl is the second Sunday in February from
    2022 onward. Easter needs the anonymous Gregorian algorithm. All of it is
    arithmetic on a year, so a backtest over 2023-2026 and a run in 2031 agree
    without anybody editing a table.

NO CLOCK READ. Every function takes a date. `check_no_literals.py` already
forbids ambient clock reads in this package, and a calendar module is exactly
where someone would be tempted.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

# ── Fixed-date holidays ──────────────────────────────────────────────────────
# (month, day, name). Deliberately a small list: a holiday earns its place by
# moving liquor, not by being on a calendar.
FIXED_HOLIDAYS: tuple[tuple[int, int, str], ...] = (
    (1, 1, "new_years_day"),
    (2, 14, "valentines"),
    (3, 17, "st_patricks"),
    (5, 5, "cinco_de_mayo"),
    (7, 4, "independence_day"),
    (10, 31, "halloween"),
    (12, 24, "christmas_eve"),
    (12, 25, "christmas"),
    (12, 31, "new_years_eve"),
)

#: Days BEFORE a holiday that carry its demand. A liquor store sells
#: Thanksgiving drink on the Wednesday, not on the Thursday - most of the
#: estate is shut on the day itself. The window is where the money is.
PRE_HOLIDAY_WINDOW: dict[str, int] = {
    "thanksgiving": 3,
    "christmas": 7,
    "christmas_eve": 5,
    "new_years_eve": 4,
    "new_years_day": 2,
    "independence_day": 3,
    "memorial_day": 3,
    "labor_day": 3,
    "super_bowl": 3,
    "st_patricks": 2,
    "cinco_de_mayo": 2,
    "valentines": 2,
    "halloween": 2,
    "easter": 3,
    "mothers_day": 2,
    "fathers_day": 2,
}

DEFAULT_PRE_WINDOW = 1
#: Days after a holiday where demand is suppressed - the shelf was stocked and
#: the party happened. Reported so a forecaster can learn the dip rather than
#: the engine mistaking it for a product going bad.
POST_HOLIDAY_WINDOW = 2


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """The nth `weekday` of a month. n=-1 means the last one.

    `weekday` is Monday=0, matching `date.weekday()`.
    """
    if n > 0:
        first = date(year, month, 1)
        offset = (weekday - first.weekday()) % 7
        return first + timedelta(days=offset + 7 * (n - 1))
    # Last: step back from the first of the next month.
    nxt = date(year + (month == 12), 1 if month == 12 else month + 1, 1)
    last = nxt - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def easter(year: int) -> date:
    """Anonymous Gregorian computus. Needed for Easter and Good Friday, both of
    which move wine."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    lmb = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * lmb) // 451
    month = (h + lmb - 7 * m + 114) // 31
    day = ((h + lmb - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def moving_holidays(year: int) -> dict[str, date]:
    """Every holiday whose date is a rule rather than a number."""
    e = easter(year)
    return {
        "thanksgiving": _nth_weekday(year, 11, 3, 4),      # 4th Thursday, Nov
        "memorial_day": _nth_weekday(year, 5, 0, -1),      # last Monday, May
        "labor_day": _nth_weekday(year, 9, 0, 1),          # 1st Monday, Sep
        # The Super Bowl moved to the second Sunday in February in 2022 when
        # the season went to 17 games. Before that it was the first.
        "super_bowl": _nth_weekday(year, 2, 6, 2 if year >= 2022 else 1),
        "mothers_day": _nth_weekday(year, 5, 6, 2),        # 2nd Sunday, May
        "fathers_day": _nth_weekday(year, 6, 6, 3),        # 3rd Sunday, Jun
        "easter": e,
        "good_friday": e - timedelta(days=2),
    }


def holidays_for(year: int) -> dict[str, date]:
    """Every holiday in a year, fixed and moving, name -> date."""
    out = {name: date(year, m, d) for m, d, name in FIXED_HOLIDAYS}
    out.update(moving_holidays(year))
    return out


@dataclass(frozen=True, slots=True)
class CalendarFacts:
    """What this date IS. Facts, not weights.

    Every field is something a forecaster can learn a coefficient for. None of
    them is a multiplier, because the last attempt to hand-weight seasonality
    cost twelve points at ninety days.
    """

    obs_date: date
    day_of_week: int
    #: 0 = Monday. Separate from `is_weekend` because a liquor store's Friday
    #: and Saturday differ from each other as much as from a Tuesday.
    is_weekend: bool
    week_of_year: int
    month: int
    season: str
    #: The holiday ON this date, if any.
    holiday: str | None
    #: The nearest UPCOMING holiday and how many days away. This is the field
    #: that matters most: demand builds BEFORE the day.
    next_holiday: str | None
    days_to_next_holiday: int | None
    #: True when inside that holiday's own pre-window - which is 7 days for
    #: Christmas and 2 for Valentine's, because they are not comparable.
    in_pre_holiday_window: bool
    #: The holiday just past, for the suppression that follows one.
    days_since_last_holiday: int | None
    in_post_holiday_window: bool
    is_month_start: bool
    is_mid_month: bool
    is_month_end: bool
    #: Mid-February to mid-April in the US. Marked, NOT assumed to matter -
    #: whether a refund window moves a given store's demand is a question for
    #: the data, and some stores will show nothing.
    in_tax_refund_window: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "obs_date": self.obs_date.isoformat(),
            "day_of_week": self.day_of_week,
            "is_weekend": self.is_weekend,
            "week_of_year": self.week_of_year,
            "month": self.month,
            "season": self.season,
            "holiday": self.holiday,
            "next_holiday": self.next_holiday,
            "days_to_next_holiday": self.days_to_next_holiday,
            "in_pre_holiday_window": self.in_pre_holiday_window,
            "days_since_last_holiday": self.days_since_last_holiday,
            "in_post_holiday_window": self.in_post_holiday_window,
            "is_month_start": self.is_month_start,
            "is_mid_month": self.is_mid_month,
            "is_month_end": self.is_month_end,
            "in_tax_refund_window": self.in_tax_refund_window,
        }


def _season(d: date) -> str:
    """Meteorological seasons, which match retail better than astronomical
    ones - nobody's buying pattern changes on the 21st."""
    return {12: "winter", 1: "winter", 2: "winter",
            3: "spring", 4: "spring", 5: "spring",
            6: "summer", 7: "summer", 8: "summer",
            9: "autumn", 10: "autumn", 11: "autumn"}[d.month]


def facts_for(d: date) -> CalendarFacts:
    """Everything calendar-shaped about one date.

    Spans the year boundary on purpose: on 28 December the next holiday is New
    Year's Eve of the same year, but on 30 December 2026 the nearest upcoming
    holiday after New Year's Day is in 2027, and a function that only looked at
    `d.year` would return None for the busiest week of the trade.
    """
    cal: dict[str, date] = {}
    for y in (d.year - 1, d.year, d.year + 1):
        for name, hd in holidays_for(y).items():
            # Keep the occurrence nearest to d for each name.
            if name not in cal or abs((hd - d).days) < abs((cal[name] - d).days):
                cal[name] = hd

    on_day = next((n for n, hd in cal.items() if hd == d), None)

    upcoming = sorted(((hd - d).days, n) for n, hd in cal.items() if hd >= d)
    past = sorted(((d - hd).days, n) for n, hd in cal.items() if hd < d)

    next_name = upcoming[0][1] if upcoming else None
    next_days = upcoming[0][0] if upcoming else None
    in_pre = False
    if next_name is not None and next_days is not None:
        in_pre = next_days <= PRE_HOLIDAY_WINDOW.get(next_name, DEFAULT_PRE_WINDOW)

    since = past[0][0] if past else None
    in_post = since is not None and 0 < since <= POST_HOLIDAY_WINDOW

    return CalendarFacts(
        obs_date=d,
        day_of_week=d.weekday(),
        is_weekend=d.weekday() >= 5,
        week_of_year=d.isocalendar().week,
        month=d.month,
        season=_season(d),
        holiday=on_day,
        next_holiday=next_name,
        days_to_next_holiday=next_days,
        in_pre_holiday_window=in_pre,
        days_since_last_holiday=since,
        in_post_holiday_window=in_post,
        is_month_start=d.day <= 3,
        is_mid_month=13 <= d.day <= 17,
        is_month_end=d.day >= 26,
        in_tax_refund_window=(d.month == 2 and d.day >= 15) or d.month == 3
        or (d.month == 4 and d.day <= 15),
    )


def peak_season_share(start: date, end: date) -> float:
    """What fraction of the days in a window sit inside a pre-holiday build-up.

    The quantity a FORECAST needs, as opposed to the quantity a date carries: a
    60-day window ending 2 January is mostly Christmas, and a 60-day window
    ending 2 September is mostly nothing. Comparing those two with the same
    trailing rate is the mistake this exists to let a caller avoid.
    """
    if end < start:
        return 0.0
    days = (end - start).days + 1
    hits = sum(1 for i in range(days)
               if facts_for(start + timedelta(days=i)).in_pre_holiday_window)
    return hits / days if days else 0.0


__all__ = [
    "DEFAULT_PRE_WINDOW",
    "FIXED_HOLIDAYS",
    "POST_HOLIDAY_WINDOW",
    "PRE_HOLIDAY_WINDOW",
    "CalendarFacts",
    "easter",
    "facts_for",
    "holidays_for",
    "moving_holidays",
    "peak_season_share",
]
