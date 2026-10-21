"""N4.3 — the computable half of signal_history, and the line it will not cross.

The table itself is Node's
(backend/database/analytics-migrations/025_signal_history.sql). It was moved there
from database/migrations/, which targets the SELECT-only syncgo warehouse - a real
mistake that would have created the table where Node could never write to it.
This is the Python half: which keys are derivable from a date, which are not, and
the shape the writer is handed.
"""

from __future__ import annotations

import pathlib
import re
from datetime import date, timedelta

import pytest

from app.pipeline.features.calendar import PRE_HOLIDAY_WINDOW, holidays_for
from app.pipeline.features.signal_backfill import (
    NOT_RECONSTRUCTIBLE,
    WEEKDAY_PROBE_KEY,
    backfill_rows,
    computable_keys,
    is_reconstructible,
)

MIGRATION = (
    pathlib.Path(__file__).resolve().parents[2]
    / "backend" / "database" / "analytics-migrations" / "025_signal_history.sql"
)


# ── Append-only ──────────────────────────────────────────────────────────────


def test_signal_history_is_append_only() -> None:
    """A corrected signal is a NEW ROW. If a row can be amended then the table is
    a current-state cache, not a history, and an estimate fitted on it cannot be
    reproduced - which defeats the only reason it exists.

    Enforced by a trigger rather than left to convention, so this test reads the
    migration and asserts the trigger is there.
    """
    assert MIGRATION.exists(), f"missing migration: {MIGRATION}"
    sql = MIGRATION.read_text(encoding="utf-8")

    assert re.search(r"BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+signal_history",
                     sql, re.IGNORECASE), "no append-only trigger"
    assert "RAISE EXCEPTION" in sql
    assert "append-only" in sql.lower()
    # And no UNIQUE constraint on the natural key, which would block the
    # correction row the design depends on.
    assert not re.search(
        r"UNIQUE\s*\(\s*client_id\s*,\s*location_id\s*,\s*as_of\s*,\s*signal_key",
        sql, re.IGNORECASE), "a unique natural key would block corrections"


def test_strength_is_nullable_and_origin_is_distinguishable() -> None:
    """A binary advisory has no intensity, and a fabricated 1.0 would later be
    averaged with a real temperature anomaly and called measured."""
    sql = MIGRATION.read_text(encoding="utf-8")
    strength = re.search(r"strength\s+NUMERIC([^,]*)", sql, re.IGNORECASE)
    assert strength is not None
    assert "NOT NULL" not in strength.group(1).upper()

    # 'computed' vs 'captured' must be separable, or a backfill gets quoted as
    # evidence that capture was running.
    assert "origin" in sql
    assert "'computed'" in sql and "'captured'" in sql


def test_node_is_named_as_the_writer() -> None:
    """Node is the sole writer of bottleai_analytics; Python is stateless and
    holds no analytics credentials."""
    sql = MIGRATION.read_text(encoding="utf-8").lower()
    assert "node" in sql
    assert "sole writer" in sql or "nightly" in sql


# ── What backfills exactly ───────────────────────────────────────────────────


def test_computable_keys_backfill_exactly() -> None:
    """Holidays and their run-ups are arithmetic, so they reconstruct exactly for
    any past or future date - no capture needed."""
    for year in (2024, 2025, 2026, 2027):
        for name, holiday in holidays_for(year).items():
            keys = computable_keys(holiday)
            assert f"holiday_{name}" in keys, (
                f"{name} {holiday} did not reconstruct"
            )
            window = PRE_HOLIDAY_WINDOW.get(name, 0)
            if window:
                eve = holiday - timedelta(days=1)
                assert f"pre_{name}" in computable_keys(eve), (
                    f"the day before {name} is not in its run-up"
                )
                # And the day AFTER is not in the run-up.
                assert f"pre_{name}" not in computable_keys(
                    holiday + timedelta(days=1))

    # Deterministic: the same date gives the same keys every time.
    d = date(2026, 11, 26)
    assert computable_keys(d) == computable_keys(d)


def test_a_pre_holiday_window_crosses_the_year_boundary() -> None:
    """28 December sits inside the run-up to New Year's Day, which belongs to the
    NEXT year's holiday set. Looking only at `day.year` loses it."""
    # Data-driven rather than guessing a key name: find every 2027 holiday whose
    # run-up reaches back into 2026 and assert each one reconstructs there.
    crossing = [
        (name, holiday, PRE_HOLIDAY_WINDOW[name])
        for name, holiday in holidays_for(2027).items()
        if PRE_HOLIDAY_WINDOW.get(name)
        and (holiday - timedelta(days=PRE_HOLIDAY_WINDOW[name])).year < holiday.year
    ]
    assert crossing, "no holiday run-up crosses the year boundary in this calendar"
    for name, holiday, window in crossing:
        inside = holiday - timedelta(days=window)        # the earliest day in it
        assert inside.year == holiday.year - 1
        assert f"pre_{name}" in computable_keys(inside), (
            f"{name} run-up did not reach back into {inside.year}"
        )
        # And one day earlier is outside the window.
        outside = holiday - timedelta(days=window + 1)
        assert f"pre_{name}" not in computable_keys(outside)


def test_payday_and_the_weekday_probe_are_emitted() -> None:
    assert "payday_window" in computable_keys(date(2026, 3, 15))
    assert "payday_window" not in computable_keys(date(2026, 3, 10))
    # The probe is a Friday, emitted ON PURPOSE: a working estimator must refuse
    # it, because the day-of-week control absorbs it by construction. It is the
    # cheapest available proof the controls do something.
    friday = date(2026, 3, 6)
    assert friday.weekday() == 4
    assert WEEKDAY_PROBE_KEY in computable_keys(friday)
    assert WEEKDAY_PROBE_KEY not in computable_keys(date(2026, 3, 4))


def test_non_reconstructible_keys_are_not_backfilled() -> None:
    """Weather and news are not derivable from a date. Capture starts now and
    beta for those keys stays REFUSED until enough history exists - said plainly
    rather than backfilled as a guess."""
    for key in ("heat_advisory", "cold_snap", "storm", "news_festival",
                "competitor_promo", "tax_change"):
        assert is_reconstructible(key) is False, key

    # And none of them ever appears in a backfill, over a full year of dates.
    days = [date(2026, 1, 1) + timedelta(days=i) for i in range(365)]
    produced = {r["signal_key"] for r in
                backfill_rows(days, client_id=1, location_id=171)}
    for key in produced:
        assert is_reconstructible(key), f"backfilled a non-derivable key: {key}"
    assert not produced & set(NOT_RECONSTRUCTIBLE)

    # The refusals are NAMED with a reason, not silently absent.
    for key, reason in NOT_RECONSTRUCTIBLE.items():
        assert reason.strip(), key


def test_null_strength_is_preserved() -> None:
    """Every computable key is a binary "the date is in this window"."""
    days = [date(2026, 3, 1) + timedelta(days=i) for i in range(40)]
    rows = backfill_rows(days, client_id=1, location_id=171)
    assert rows, "a month of dates should produce some keys"
    assert all(r["strength"] is None for r in rows)
    # Not 0.0, which would read as a measured intensity of zero.
    assert not any(r["strength"] == 0.0 for r in rows)


def test_backfill_rows_are_shaped_for_the_node_writer() -> None:
    rows = backfill_rows([date(2026, 11, 26)], client_id=7, location_id=178)
    assert rows
    for r in rows:
        assert set(r) == {"client_id", "location_id", "as_of", "signal_key",
                          "strength", "source", "origin"}
        assert r["client_id"] == 7 and r["location_id"] == 178
        assert r["as_of"] == "2026-11-26"
        assert r["origin"] == "computed", (
            "a backfill must be distinguishable from a live capture"
        )
        assert r["source"] == "features.calendar"


def test_the_backfill_writes_nothing_itself() -> None:
    """Python is stateless and holds no analytics credentials. This module returns
    data; Node writes it."""
    src = (pathlib.Path(__file__).resolve().parents[1]
           / "app" / "pipeline" / "features" / "signal_backfill.py"
           ).read_text(encoding="utf-8")
    for forbidden in ("psycopg", "sqlite3", "INSERT", "execute(", "connect("):
        assert forbidden not in src, f"backfill must not write: found {forbidden}"
