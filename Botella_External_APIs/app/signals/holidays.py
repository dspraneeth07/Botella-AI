"""Static holiday calendar (no external API).

Computes federal + high-impact "drinking" holidays for the current and next
year, then filters to those within the lookahead window. Each emitted holiday
carries a ``key`` that lines up with ``SIGNAL_CATEGORY_MAP`` so it can drive
candidate selection.

Most dates are fixed or "nth weekday of month" rules. The movable Christian
feasts (Easter, and Mardi Gras = Easter − 47 days) are derived with the
Anonymous Gregorian algorithm. Lunar New Year doesn't follow a closed-form
Gregorian rule, so it comes from a small lookup table.
"""

from __future__ import annotations

import calendar
from datetime import UTC, date, datetime, timedelta

from app.config import Settings
from app.schemas.signals import HolidaySignal
from app.schemas.store import StoreProfile

# Lunar New Year has no simple Gregorian formula — table it (extend as needed).
_LUNAR_NEW_YEAR: dict[int, tuple[int, int]] = {
    2025: (1, 29), 2026: (2, 17), 2027: (2, 6), 2028: (1, 26),
    2029: (2, 13), 2030: (2, 3), 2031: (1, 23), 2032: (2, 11),
}


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """The n-th ``weekday`` (Mon=0..Sun=6) of ``month`` in ``year`` (n>=1)."""
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return first + timedelta(days=offset + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    last_day = calendar.monthrange(year, month)[1]
    last = date(year, month, last_day)
    offset = (last.weekday() - weekday) % 7
    return last - timedelta(days=offset)


def _easter(year: int) -> date:
    """Easter Sunday (Gregorian) via the Anonymous/Meeus algorithm."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    le = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * le) // 451
    month = (h + le - 7 * m + 114) // 31
    day = ((h + le - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _holidays_for_year(year: int) -> list[tuple[str, str, date]]:
    """Return (key, display_name, date) tuples for one calendar year."""
    # Thanksgiving = 4th Thursday of November; the eve ("Blackout Wednesday").
    thanksgiving = _nth_weekday(year, 11, calendar.THURSDAY, 4)
    easter = _easter(year)
    out: list[tuple[str, str, date]] = [
        ("valentines", "Valentine's Day", date(year, 2, 14)),
        # Mardi Gras / Fat Tuesday = 47 days before Easter Sunday.
        ("mardi_gras", "Mardi Gras", easter - timedelta(days=47)),
        ("st_patricks", "St. Patrick's Day", date(year, 3, 17)),
        ("easter", "Easter", easter),
        # Super Bowl: 2nd Sunday of February (approximation for recent seasons).
        ("super_bowl", "Super Bowl Sunday", _nth_weekday(year, 2, calendar.SUNDAY, 2)),
        # Kentucky Derby: 1st Saturday of May.
        ("kentucky_derby", "Kentucky Derby", _nth_weekday(year, 5, calendar.SATURDAY, 1)),
        ("cinco_de_mayo", "Cinco de Mayo", date(year, 5, 5)),
        ("mothers_day", "Mother's Day", _nth_weekday(year, 5, calendar.SUNDAY, 2)),
        ("memorial_day", "Memorial Day", _last_weekday(year, 5, calendar.MONDAY)),
        ("fathers_day", "Father's Day", _nth_weekday(year, 6, calendar.SUNDAY, 3)),
        ("july_4th", "Independence Day", date(year, 7, 4)),
        ("labor_day", "Labor Day", _nth_weekday(year, 9, calendar.MONDAY, 1)),
        # Oktoberfest spans mid-Sep to early Oct; anchor on the 3rd Saturday of
        # September (its traditional US-celebration kickoff).
        ("oktoberfest", "Oktoberfest", _nth_weekday(year, 9, calendar.SATURDAY, 3)),
        ("halloween", "Halloween", date(year, 10, 31)),
        ("day_of_dead", "Day of the Dead", date(year, 11, 2)),
        ("thanksgiving_eve", "Thanksgiving Eve", thanksgiving - timedelta(days=1)),
        ("nye", "New Year's Eve", date(year, 12, 31)),
    ]
    lny = _LUNAR_NEW_YEAR.get(year)
    if lny is not None:
        out.append(("lunar_new_year", "Lunar New Year", date(year, lny[0], lny[1])))
    return out


async def fetch(
    store: StoreProfile, settings: Settings
) -> tuple[list[HolidaySignal], list[str]]:
    today = datetime.now(UTC).date()
    horizon = today + timedelta(days=settings.holiday_lookahead_days)

    candidates: list[tuple[str, str, date]] = []
    for year in (today.year, today.year + 1):
        candidates.extend(_holidays_for_year(year))

    upcoming = sorted(
        (h for h in candidates if today <= h[2] <= horizon),
        key=lambda h: h[2],
    )

    signals = [
        HolidaySignal(
            name=name,
            date=day.isoformat(),
            days_away=(day - today).days,
            key=key,
        )
        for key, name, day in upcoming
    ]
    active_keys = [s.key for s in signals]
    return signals, active_keys
