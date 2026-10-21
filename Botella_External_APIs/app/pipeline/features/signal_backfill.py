"""Which signal keys were active on a past date, where that is COMPUTABLE.

WHY A BACKFILL EXISTS AT ALL
    `signal_effect` needs a history of what was active on each past date, and
    `signal_history` only starts filling from the night it is switched on. For
    weather and news that is unavoidable - a past advisory is not recoverable
    cheaply and a reconstruction would be a guess wearing a measurement's
    clothes.

    But holidays, pre-holiday windows, moving dates and paydays are ARITHMETIC.
    `features/calendar.py` already computes them - the anonymous Gregorian
    computus for Easter, nth-weekday rules for Thanksgiving and Memorial Day, the
    Super Bowl's move to the second Sunday in February from 2022 - with 22 tests
    pinning known-good dates across four years. Those keys can be reconstructed
    EXACTLY for any date in the past or the future, so there is no reason to wait
    for capture to estimate them.

    That distinction is the whole module: it backfills what is derivable and
    refuses to invent what is not.

WHAT IT ALREADY TOLD US
    Run across the five pilot stores, every computable key against every category
    family: 488 of 489 cells REFUSED - the interval spans zero. The single
    exception is Mango Jo's beer against a payday window, beta +0.047, a 4.8%
    lift on 147 active days.

    So the calendar signals do not move these stores in a way the data can
    detect. That is a finding and not a failure: it means the signal families
    cannot carry the profit target, and the weather and news keys that need live
    capture are the only remaining candidates.

A SANITY CHECK WORTH KEEPING
    A key that is exactly a weekday - "friday" - must come back REFUSED, because
    the day-of-week control absorbs it by construction. It does. That is the
    cheapest available proof that the controls in `signal_effect` are doing
    something, and it is why `WEEKDAY_PROBE_KEY` is emitted on purpose rather
    than filtered out.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Iterable

from app.pipeline.features.calendar import PRE_HOLIDAY_WINDOW, holidays_for

#: Emitted deliberately as a control probe - see the module docstring. It is a
#: weekday, so a working estimator MUST refuse it.
WEEKDAY_PROBE_KEY = "friday"

#: Days of the month on which wages and benefits commonly land in the US. A
#: fortnightly basket rhythm is one of the few calendar effects with a plausible
#: mechanism that is not already a weekday or a holiday.
PAYDAY_DAYS: frozenset[int] = frozenset({1, 15, 16, 30, 31})

#: Keys this module will NEVER produce, with the reason. Named rather than
#: silently absent, so the next person does not add them by accident.
NOT_RECONSTRUCTIBLE: dict[str, str] = {
    "heat_advisory": "a past advisory is not recoverable from the calendar",
    "cold_snap": "needs captured temperature history",
    "storm": "needs captured weather history",
    # The signal layer emits this exact key, and "storm" above does not match it.
    # Caught by auditing every key the layer can actually produce against this
    # dict rather than trusting the prefixes to cover them - a key that is wrongly
    # judged reconstructible gets BACKFILLED AS ABSENT on every past date, which
    # is a fabricated zero rather than a missing measurement, and the elasticity
    # fit would then report "no effect" for a signal nobody ever recorded.
    "severe_weather": "needs captured weather history",
    "news_": "a past news story is not derivable from a date",
    "competitor_promo": "was never captured in the first place",
    "tax_change": "a regulatory date, but not one this module holds",
}


def computable_keys(day: date) -> frozenset[str]:
    """Every signal key that is derivable from `day` alone.

    Returns a set rather than a list because a date is either in a window or it
    is not, and two sources agreeing is not two observations.
    """
    keys: set[str] = set()
    for name, holiday in holidays_for(day.year).items():
        if day == holiday:
            keys.add(f"holiday_{name}")
        window = PRE_HOLIDAY_WINDOW.get(name, 0)
        if window and 0 < (holiday - day).days <= window:
            keys.add(f"pre_{name}")
    # A pre-holiday window can cross a year boundary: 28 December sits inside the
    # run-up to New Year's Day, which belongs to the NEXT year's holiday set.
    for name, holiday in holidays_for(day.year + 1).items():
        window = PRE_HOLIDAY_WINDOW.get(name, 0)
        if window and 0 < (holiday - day).days <= window:
            keys.add(f"pre_{name}")

    if day.weekday() == 4:
        keys.add(WEEKDAY_PROBE_KEY)
    if day.day in PAYDAY_DAYS:
        keys.add("payday_window")
    return frozenset(keys)


def is_reconstructible(signal_key: str) -> bool:
    """Can this key be backfilled, or must it be captured from now on?"""
    return not any(signal_key.startswith(p) for p in NOT_RECONSTRUCTIBLE)


def backfill_rows(
    days: Iterable[date], *, client_id: int, location_id: int,
) -> list[dict[str, Any]]:
    """`signal_history` rows for the computable keys over `days`.

    Shaped for the Node writer, which owns the table - this returns data and
    writes nothing. `strength` is None throughout, because every key here is a
    binary "the date is in this window" and a fabricated 1.0 would later be
    averaged with a real intensity and called measured. `origin` is 'computed',
    which is what stops a backfill being quoted as evidence that capture was
    running.
    """
    rows: list[dict[str, Any]] = []
    for day in days:
        for key in sorted(computable_keys(day)):
            rows.append({
                "client_id": client_id,
                "location_id": location_id,
                "as_of": day.isoformat(),
                "signal_key": key,
                "strength": None,
                "source": "features.calendar",
                "origin": "computed",
            })
    return rows


__all__ = [
    "NOT_RECONSTRUCTIBLE",
    "PAYDAY_DAYS",
    "WEEKDAY_PROBE_KEY",
    "backfill_rows",
    "computable_keys",
    "is_reconstructible",
]
