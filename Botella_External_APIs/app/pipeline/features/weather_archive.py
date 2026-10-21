"""Historical weather days, from an archive — so cold-box can be estimated at all.

WHY THIS EXISTS, AND A CLAIM IT CORRECTS
    `signal_backfill.py` says weather "cannot be backfilled", and the reason given
    is that a past advisory is not recoverable from a date. That is TRUE of a
    calendar and FALSE of the world: daily maximum and minimum temperatures for a
    coordinate are a matter of public record, and a free archive returns them for
    any date. The engine was treating "not derivable by arithmetic" as "not
    obtainable", and the cold-box family sat silent for want of a lookup nobody had
    written.

    So this module reads the archive and reconstructs the SAME two keys the live
    weather module emits, using the SAME thresholds, so a past hot day and a future
    hot day mean the same thing.

ARCHIVED IS NOT CAPTURED, AND THE DIFFERENCE IS NOT BOOKKEEPING
    These rows carry `origin='archived'`, a third value added deliberately:

        computed   follows from the calendar. Reproducible by anyone, forever.
        captured   observed live by this engine and written down at the time.
        archived   read back from a third party's historical record, after the fact.

    An archive is a REANALYSIS. It is revised, it is interpolated to a grid point
    rather than measured at the shop door, and its notion of a hot day is its own.
    An elasticity fitted on archived weather is therefore a weaker claim than one
    fitted on captured weather - "sales rose on days the archive calls hot" is a
    real finding, and it is not the sentence "sales rose on days we recorded a heat
    advisory". The engine must not be able to print the second while holding
    evidence for the first, and `origin` is what makes that impossible rather than
    merely discouraged.

WHAT IT CANNOT RECOVER, AND SAYS SO
    `severe_weather` depends on whether a WARNING WAS ISSUED, which is an
    administrative act and not a temperature. No archive of daily highs recovers
    it, so this module does not emit it and `signal_backfill.NOT_RECONSTRUCTIBLE`
    still refuses it by name. Two of three weather keys become estimable; the third
    needs live capture.

THRESHOLDS ARE IMPORTED, NEVER RESTATED
    `HEAT_THRESHOLD_F` and `COLD_THRESHOLD_F` come from `app/signals/weather.py`.
    Writing 88 and 25 again here would let the live path and the historical path
    drift apart silently, and then the coefficient would describe one definition of
    a hot day while the card fired on another.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Iterable, Mapping

#: The SAME thresholds the live signal uses. Imported rather than restated: a hot
#: day in the fit and a hot day on the card have to be the same thing.
from app.signals.weather import COLD_THRESHOLD_F, HEAT_THRESHOLD_F

#: The Celsius-to-Fahrenheit conversion, as named parts. Physical constants, not
#: settings: changing one does not tune anything, it computes a different
#: temperature and calls it the same. Integers so the no-literals guard - which
#: exists to catch tunables smuggled in as numbers - has nothing to object to.
_C_TO_F_NUMERATOR = 9
_C_TO_F_DENOMINATOR = 5
_FREEZING_F = 32

#: What this module writes. Not 'captured' - see the module docstring.
ARCHIVED_ORIGIN = "archived"
#: Named so a row's provenance survives into the table rather than living only
#: here.
ARCHIVE_SOURCE = "open-meteo.archive"

#: The keys this module CAN reconstruct, and the one it cannot.
RECONSTRUCTIBLE_WEATHER_KEYS = ("heat_advisory", "cold_snap")
#: `severe_weather` depends on an alert being ISSUED, which is an administrative
#: act rather than a temperature. No archive of daily highs recovers it.
UNRECONSTRUCTIBLE_WEATHER_KEYS = ("severe_weather",)


@dataclass(frozen=True, slots=True)
class ArchiveDay:
    """One day's high and low, in Fahrenheit, as the archive reports them."""

    day: date
    high_f: float | None
    low_f: float | None

    def active_keys(self) -> tuple[str, ...]:
        """The weather keys this day would have raised.

        A missing reading yields NO key for that side rather than a False. An
        absent temperature is not a cool day: treating it as one would write a
        fabricated negative into the history and the elasticity would then be
        fitted against days nobody measured.
        """
        keys: list[str] = []
        if self.high_f is not None and self.high_f >= HEAT_THRESHOLD_F:
            keys.append("heat_advisory")
        if self.low_f is not None and self.low_f <= COLD_THRESHOLD_F:
            keys.append("cold_snap")
        return tuple(keys)


def celsius_to_fahrenheit(value: float) -> float:
    return value * _C_TO_F_NUMERATOR / _C_TO_F_DENOMINATOR + _FREEZING_F


def days_from_archive(payload: Mapping[str, Any], *,
                      already_fahrenheit: bool = True) -> list[ArchiveDay]:
    """Parse an Open-Meteo archive response into days.

    Shaped for the caller to feed `rows_for`, and tolerant of a short or ragged
    response: the archive occasionally returns a null for a date, and a null is
    carried as None rather than coerced.
    """
    daily = payload.get("daily") or {}
    dates = daily.get("time") or []
    highs = daily.get("temperature_2m_max") or []
    lows = daily.get("temperature_2m_min") or []
    out: list[ArchiveDay] = []
    for index, raw_date in enumerate(dates):
        high = highs[index] if index < len(highs) else None
        low = lows[index] if index < len(lows) else None
        if not already_fahrenheit:
            high = None if high is None else celsius_to_fahrenheit(float(high))
            low = None if low is None else celsius_to_fahrenheit(float(low))
        try:
            parsed = date.fromisoformat(str(raw_date)[:10])
        except ValueError:
            continue
        out.append(ArchiveDay(
            day=parsed,
            high_f=None if high is None else float(high),
            low_f=None if low is None else float(low),
        ))
    return out


def rows_for(
    days: Iterable[ArchiveDay], *, client_id: int, location_id: int,
    trading_days: Iterable[date] | None = None,
) -> list[dict[str, Any]]:
    """`signal_history` rows for the weather keys these days raised.

    Only days the store was OPEN produce rows when `trading_days` is supplied. A
    closed Sunday that happened to be hot is not an observation about this store's
    response to heat, and including it would dilute the active-day count with days
    that could not have sold anything.

    `strength` carries DEGREES PAST THE THRESHOLD, not the temperature.
    `signal_history.strength` is constrained non-negative because it means an
    intensity, and a Fahrenheit temperature is not one - it is an interval scale
    with an arbitrary zero, and Calumet Park has sub-zero days that violated the
    constraint outright. That was a type error, and the constraint caught it.

    Degrees past the threshold is a real intensity: zero at the threshold, rising
    as the day gets more extreme, and comparable between heat and cold in a way a
    raw temperature is not. 95F on a heat day and 18F on a cold day are both "7
    degrees past", which is the quantity an effect would actually scale with.
    """
    open_days = set(trading_days) if trading_days is not None else None
    rows: list[dict[str, Any]] = []
    for archive_day in days:
        if open_days is not None and archive_day.day not in open_days:
            continue
        for key in archive_day.active_keys():
            if key == "heat_advisory":
                reading = archive_day.high_f
                strength = (None if reading is None
                            else max(0.0, reading - HEAT_THRESHOLD_F))
            else:
                reading = archive_day.low_f
                strength = (None if reading is None
                            else max(0.0, COLD_THRESHOLD_F - reading))
            rows.append({
                "client_id": client_id,
                "location_id": location_id,
                "as_of": archive_day.day.isoformat(),
                "signal_key": key,
                "strength": None if strength is None else round(float(strength), 1),
                "source": ARCHIVE_SOURCE,
                "origin": ARCHIVED_ORIGIN,
            })
    return rows


__all__ = [
    "ARCHIVED_ORIGIN",
    "ARCHIVE_SOURCE",
    "RECONSTRUCTIBLE_WEATHER_KEYS",
    "UNRECONSTRUCTIBLE_WEATHER_KEYS",
    "ArchiveDay",
    "celsius_to_fahrenheit",
    "days_from_archive",
    "rows_for",
]
