"""The 25+ named events a playbook can be built for, with their selling windows.

READ THIS BEFORE CHANGING ANYTHING HERE
    Seasonality has lost on this engine TWICE, measured:

        as a RANKING ratio        90-day hit rate 70.0% -> 58.4%
        as a FORECAST multiplier  lost at 0 of 4 horizons;
                                  30-day bias +0.6% -> +9.2%

    Both failures had the same cause: a continuous, store-level busy-ness index
    applied to the daily forecast, when the trailing 28-day window already
    reflects current conditions - so the adjustment double-counted.

    THIS MODULE DOES NOT ADJUST A DAILY RATE. It names discrete, dated events and
    the window of days around each one. Nothing here multiplies `rate_hat`,
    nothing here returns an index, and if a future change starts scaling a daily
    forecast from these facts it will lose for the third time.

WHY IT EXTENDS features/calendar.py RATHER THAN REPLACING IT
    That module already computes every moving date this one needs - the anonymous
    Gregorian computus for Easter, nth-weekday rules for Thanksgiving and Memorial
    Day, and the Super Bowl's move to the second Sunday in February from 2022 -
    with 22 tests pinning known-good dates across four years. A run in 2031 needs
    no edit, and that property is kept by CALLING it rather than by copying it.

THE LUNI-SOLAR TRAP, AND THE ONE PLACE A TABLE IS ALLOWED
    Diwali, Eid al-Fitr, Chinese New Year and the start of Ramadan are not
    nth-weekday rules. Diwali follows the Hindu lunisolar calendar (Amanta
    Kartika), Chinese New Year the Chinese lunisolar calendar, and the two
    Islamic dates the Hijri calendar - whose OBSERVED start depends on a local
    moon sighting and is therefore not fully computable at all.

    Implementing those properly needs ephemeris data that pure standard library
    cannot supply. So they are TABULATED, and the price of a table is paid
    explicitly: `LUNISOLAR_VALID_THROUGH` is a hard stop, `date_for` RAISES past
    it, and a test fails while there is still a year of runway. A silent wrong
    date in 2031 is worse than a build error in 2030.

MAY_SUPPRESS IS NOT A COURTESY
    Ramadan reduces alcohol demand in some trade areas, and the days after a big
    event are quiet because the shelf was already stocked and the party happened.
    A negative uplift for those is a CORRECT and valuable result: it tells the
    engine not to pre-stock, and not to read the subsequent dip as something to
    recover. Nothing here clamps an uplift at zero.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Callable

from app.pipeline.features.calendar import (
    DEFAULT_PRE_WINDOW,
    POST_HOLIDAY_WINDOW,
    PRE_HOLIDAY_WINDOW,
    _nth_weekday,
    holidays_for,
)

#: The last year the tabulated luni-solar dates are good for. `date_for` raises
#: beyond it rather than guessing, and `test_tabulated_event_fails_loudly_past_
#: validity` fails while there is still runway to extend the table.
LUNISOLAR_VALID_THROUGH = 2030


class EventDateUnavailable(LookupError):
    """A tabulated date was asked for beyond the table's validity.

    A LookupError rather than a ValueError because the date is not wrong - it is
    ABSENT, and the caller's correct response is to skip the event rather than to
    substitute anything.
    """


#: Diwali - the main Lakshmi Puja day. Hindu lunisolar (Amanta Kartika), not
#: derivable without ephemeris data.
_DIWALI: dict[int, tuple[int, int]] = {
    2022: (10, 24), 2023: (11, 12), 2024: (11, 1), 2025: (10, 20),
    2026: (11, 8), 2027: (10, 29), 2028: (11, 16), 2029: (11, 5),
    2030: (10, 26),
}

#: Chinese New Year - Chinese lunisolar calendar.
_CHINESE_NEW_YEAR: dict[int, tuple[int, int]] = {
    2022: (2, 1), 2023: (1, 22), 2024: (2, 10), 2025: (1, 29),
    2026: (2, 17), 2027: (2, 6), 2028: (1, 26), 2029: (2, 13),
    2030: (2, 3),
}

#: First day of Ramadan. The Hijri calendar's OBSERVED start depends on a local
#: moon sighting, so even a perfect arithmetic implementation can be a day out -
#: which is itself a reason a table with a stated limit is the honest choice.
_RAMADAN_START: dict[int, tuple[int, int]] = {
    2022: (4, 2), 2023: (3, 23), 2024: (3, 11), 2025: (3, 1),
    2026: (2, 18), 2027: (2, 8), 2028: (1, 28), 2029: (1, 16),
    2030: (1, 6),
}

#: Eid al-Fitr - the end of Ramadan, and in a liquor store's trade area the day
#: demand RESUMES rather than a selling event of its own.
_EID_AL_FITR: dict[int, tuple[int, int]] = {
    2022: (5, 2), 2023: (4, 21), 2024: (4, 10), 2025: (3, 30),
    2026: (3, 20), 2027: (3, 9), 2028: (2, 26), 2029: (2, 14),
    2030: (2, 4),
}

_TABLES: dict[str, dict[int, tuple[int, int]]] = {
    "diwali": _DIWALI,
    "chinese_new_year": _CHINESE_NEW_YEAR,
    "ramadan_start": _RAMADAN_START,
    "eid_al_fitr": _EID_AL_FITR,
}


def _tabulated(key: str) -> Callable[[int], date]:
    """A date_for that refuses past the table rather than extrapolating."""
    def date_for(year: int) -> date:
        table = _TABLES[key]
        if year > LUNISOLAR_VALID_THROUGH or year not in table:
            raise EventDateUnavailable(
                f"{key} is tabulated only through {LUNISOLAR_VALID_THROUGH} and "
                f"{year} is not in the table. Extend "
                f"app/pipeline/features/events.py - a silent wrong date is worse "
                f"than this error."
            )
        month, day = table[year]
        return date(year, month, day)
    return date_for


def _from_calendar(name: str) -> Callable[[int], date]:
    """A date_for backed by `features/calendar.py`, so moving dates stay in one
    place and a 2031 run still needs no edit."""
    def date_for(year: int) -> date:
        holidays = holidays_for(year)
        if name not in holidays:
            raise EventDateUnavailable(f"{name} is not in holidays_for({year})")
        return holidays[name]
    return date_for


def _black_friday(year: int) -> date:
    """The day after the fourth Thursday in November. Computed, not tabulated."""
    return _nth_weekday(year, 11, 3, 4) + timedelta(days=1)


def _graduation_season(year: int) -> date:
    """The last Saturday in May - the centre of US high-school graduations.

    A SEASON rather than a day, which is why its window is the widest here. The
    anchor is a convention, not a fact, and the window is what carries the
    meaning.
    """
    return _nth_weekday(year, 5, 5, -1)


def _oktoberfest_us(year: int) -> date:
    """The first Saturday in October - when US retail runs Oktoberfest.

    Deliberately NOT the Munich dates (mid-September to the first Sunday in
    October). American stores merchandise it in October, and the event here is
    the trade, not the festival.
    """
    return _nth_weekday(year, 10, 5, 1)


@dataclass(frozen=True, slots=True)
class Event:
    """One named, dated event and the window of days that carries its demand."""

    key: str
    name: str
    #: COMPUTED. A callable, never a lookup from the caller's side - a tabulated
    #: event hides its table behind this and raises past its validity.
    date_for: Callable[[int], date]
    #: The selling run-up. Per event, never global: Christmas sells for a week,
    #: Valentine's for two days.
    window_pre_days: int
    window_post_days: int
    #: True where the effect can legitimately be NEGATIVE. Not a courtesy - see
    #: the module docstring.
    may_suppress: bool = False
    #: False for the four luni-solar events, so a caller can tell a computed date
    #: from a tabulated one without catching an exception.
    computed: bool = True

    def window(self, year: int) -> tuple[date, date]:
        """(first day, last day) inclusive. Raises if the date is unavailable."""
        day = self.date_for(year)
        return (day - timedelta(days=self.window_pre_days),
                day + timedelta(days=self.window_post_days))

    def covers(self, day: date) -> bool:
        """Is `day` inside this event's window in its own year?

        Checks the year on either side as well, because a window can cross a
        boundary - 29 December is inside the run-up to New Year's Day.
        """
        for year in (day.year - 1, day.year, day.year + 1):
            try:
                start, end = self.window(year)
            except (EventDateUnavailable, ValueError):
                continue
            if start <= day <= end:
                return True
        return False

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key, "name": self.name,
            "window_pre_days": self.window_pre_days,
            "window_post_days": self.window_post_days,
            "may_suppress": self.may_suppress,
            "computed": self.computed,
        }


def _pre(name: str) -> int:
    """The run-up this holiday already has in `calendar.py`, so one place owns
    it. Falls back to the module's own default rather than inventing a number."""
    return PRE_HOLIDAY_WINDOW.get(name, DEFAULT_PRE_WINDOW)


def _holiday_event(key: str, name: str, *, pre: int | None = None,
                   post: int | None = None, may_suppress: bool = False) -> Event:
    return Event(
        key=key, name=name, date_for=_from_calendar(key),
        window_pre_days=_pre(key) if pre is None else pre,
        window_post_days=POST_HOLIDAY_WINDOW if post is None else post,
        may_suppress=may_suppress,
    )


#: Every event a playbook can be built for. Twenty-five.
#:
#: The windows are NOT uniform and that is the point: a 7-day Christmas run-up
#: and a 2-day Valentine's run-up are different trades, and a single global
#: window would average a week of Christmas buying into a two-day flower-shop
#: rhythm.
EVENTS: tuple[Event, ...] = (
    # ── The big drinking occasions ───────────────────────────────────────────
    _holiday_event("new_years_eve", "New Year's Eve"),
    _holiday_event("new_years_day", "New Year's Day", may_suppress=True),
    _holiday_event("super_bowl", "Super Bowl"),
    _holiday_event("valentines", "Valentine's Day"),
    _holiday_event("st_patricks", "St Patrick's Day"),
    _holiday_event("easter", "Easter"),
    _holiday_event("cinco_de_mayo", "Cinco de Mayo"),
    _holiday_event("memorial_day", "Memorial Day"),
    _holiday_event("mothers_day", "Mother's Day"),
    _holiday_event("fathers_day", "Father's Day"),
    _holiday_event("independence_day", "July 4th"),
    _holiday_event("labor_day", "Labor Day"),
    _holiday_event("halloween", "Halloween"),
    _holiday_event("thanksgiving", "Thanksgiving"),
    _holiday_event("christmas_eve", "Christmas Eve"),
    _holiday_event("christmas", "Christmas Day", may_suppress=True),
    _holiday_event("good_friday", "Good Friday"),

    # ── The Wednesday before Thanksgiving ────────────────────────────────────
    # Named separately because it is the single biggest liquor trading day of the
    # American year and most of the estate is SHUT on the Thursday. Folding it
    # into "thanksgiving" would put the money on a day the doors are closed.
    Event(
        key="thanksgiving_eve", name="Thanksgiving Eve",
        date_for=lambda y: _nth_weekday(y, 11, 3, 4) - timedelta(days=1),
        window_pre_days=2, window_post_days=0,
    ),

    # ── Computed, but not holidays ───────────────────────────────────────────
    Event(key="black_friday", name="Black Friday", date_for=_black_friday,
          window_pre_days=1, window_post_days=2),
    Event(key="graduation_season", name="Graduation season",
          date_for=_graduation_season, window_pre_days=14, window_post_days=14),
    Event(key="oktoberfest", name="Oktoberfest (US retail)",
          date_for=_oktoberfest_us, window_pre_days=7, window_post_days=14),

    # ── Luni-solar: TABULATED, with a hard validity limit ────────────────────
    Event(key="diwali", name="Diwali", date_for=_tabulated("diwali"),
          window_pre_days=5, window_post_days=2, computed=False),
    Event(key="chinese_new_year", name="Chinese New Year",
          date_for=_tabulated("chinese_new_year"),
          window_pre_days=5, window_post_days=3, computed=False),
    # Ramadan SUPPRESSES in some trade areas, which is the whole reason
    # may_suppress exists. Its window is the month, not a run-up.
    Event(key="ramadan_start", name="Ramadan begins",
          date_for=_tabulated("ramadan_start"),
          window_pre_days=0, window_post_days=29,
          may_suppress=True, computed=False),
    Event(key="eid_al_fitr", name="Eid al-Fitr",
          date_for=_tabulated("eid_al_fitr"),
          window_pre_days=2, window_post_days=2, computed=False),
)

EVENTS_BY_KEY: dict[str, Event] = {e.key: e for e in EVENTS}


def events_for(year: int) -> list[tuple[Event, date]]:
    """Every event in `year` with its date, earliest first.

    An event whose date is unavailable is SKIPPED rather than raising, because one
    expired table must not take the whole calendar down - but `date_for` still
    raises when asked directly, which is what the test relies on.
    """
    out: list[tuple[Event, date]] = []
    for event in EVENTS:
        try:
            out.append((event, event.date_for(year)))
        except (EventDateUnavailable, ValueError):
            continue
    return sorted(out, key=lambda pair: pair[1])


def events_covering(day: date) -> list[Event]:
    """Every event whose window contains `day`. Usually none, sometimes two."""
    return [e for e in EVENTS if e.covers(day)]


def unavailable_events(year: int) -> list[str]:
    """Keys whose date cannot be supplied for `year`. The honest gap report."""
    missing: list[str] = []
    for event in EVENTS:
        try:
            event.date_for(year)
        except (EventDateUnavailable, ValueError):
            missing.append(event.key)
    return missing


__all__ = [
    "EVENTS",
    "EVENTS_BY_KEY",
    "LUNISOLAR_VALID_THROUGH",
    "Event",
    "EventDateUnavailable",
    "events_covering",
    "events_for",
    "unavailable_events",
]
