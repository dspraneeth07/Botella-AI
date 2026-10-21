"""Sheet 03 — the feature store.

The four critical rules, in the order they bite if broken:

  1. closed days are ABSENT, not zero — every rate divides by OPEN days
  2. point-in-time correctness — a read as of D returns what was known on D
  3. windows anchor to ctx.as_of, never to the latest row in the data
  4. one definition — the same code answers training and inference

Numbers here are the measured ones from Bethany Discount Liquor (171:171),
not invented: 1,358 calendar days, 1,158 trading days, 200 closed (191 of
them Sundays), and a 28-day window with 24 open days and 5,945 units.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from app.pipeline import RunContext
from app.pipeline.features import (
    CalendarDay,
    CalendarRequest,
    DayFact,
    FeatureRequest,
    MergeRequest,
    TradingDay,
    derive_calendar,
    incremental_bounds,
    merge_day_facts,
    read_window,
    read_windows,
    visible_at,
    window_bounds,
)

AS_OF = date(2026, 9, 21)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-03", "tenant_id": 171, "store_id": 171, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"features": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def calendar_closing_sundays(days: int, end: date = AS_OF) -> list[CalendarDay]:
    """Bethany's real shape: open every day except Sunday."""
    start = end - timedelta(days=days - 1)
    out = []
    for i in range(days):
        d = start + timedelta(days=i)
        is_sunday = d.weekday() == 6
        out.append(CalendarDay(d, was_open=not is_sunday, has_data=True,
                               open_source="observed" if not is_sunday else "assumed_closed"))
    return out


def facts_every_open_day(cal: list[CalendarDay], sku="SKU1", units=10.0) -> list[DayFact]:
    return [
        DayFact(obs_date=c.obs_date, sku=sku, units_sold=units,
                revenue=units * 20, price=20.0)
        for c in cal if c.was_open
    ]


# ── RULE 1: closed days are absent, not zero ────────────────────────────────


def test_rates_divide_by_open_days_not_calendar_days() -> None:
    """The headline. Bethany's real 28-day window: 24 open days, 5,945 units.
    Per calendar day 212.32; per OPEN day 247.71."""
    cal = calendar_closing_sundays(28)
    open_days = sum(1 for c in cal if c.was_open)
    assert open_days == 24, "28 days spanning 4 Sundays"

    # Distribute the real 5,945 units across the 24 open days.
    per_day = 5945 / 24
    facts = [
        DayFact(obs_date=c.obs_date, sku="SKU1", units_sold=per_day)
        for c in cal if c.was_open
    ]
    result = read_window(FeatureRequest("SKU1", 28, facts, cal), ctx())

    assert result.ok
    w = result.value
    assert w.open_days == 24
    assert w.closed_days == 4
    assert round(w.units) == 5945
    assert round(w.units_per_open_day, 2) == 247.71
    assert round(w.units_per_calendar_day, 2) == 212.32


def test_the_understatement_is_measured_and_reported() -> None:
    """The size of the error this table exists to remove travels WITH the
    answer, so nobody has to take the argument on faith."""
    cal = calendar_closing_sundays(28)
    result = read_window(FeatureRequest("SKU1", 28, facts_every_open_day(cal), cal), ctx())
    assert result.value.calendar_understatement_pct == pytest.approx(14.29, abs=0.05)


def test_the_open_day_count_travels_in_provenance() -> None:
    cal = calendar_closing_sundays(28)
    result = read_window(FeatureRequest("SKU1", 28, facts_every_open_day(cal), cal), ctx())
    assert result.provenance.own_observations == 24, "the denominator, disclosed"


def test_a_closed_day_is_not_a_zero_sales_day() -> None:
    """The distinction the whole sparse design protects. Same units, same
    span - only the calendar differs, and the rate must differ with it."""
    span = 14
    closed_sundays = calendar_closing_sundays(span)
    always_open = [CalendarDay(c.obs_date, was_open=True, has_data=True)
                   for c in closed_sundays]

    facts = [DayFact(obs_date=c.obs_date, sku="S", units_sold=10.0)
             for c in closed_sundays if c.was_open]

    with_closures = read_window(FeatureRequest("S", span, facts, closed_sundays), ctx())
    without = read_window(FeatureRequest("S", span, facts, always_open), ctx())

    assert with_closures.value.units == without.value.units          # same sales
    assert with_closures.value.open_days == 12
    assert without.value.open_days == 14
    assert with_closures.value.units_per_open_day > without.value.units_per_open_day


def test_an_unsynced_day_is_excluded_like_a_closed_one() -> None:
    """A store 4 days behind must not look like a store whose sales collapsed.
    This is what replaces the data-frontier anchor without reintroducing the
    false downtrend the old comment rightly worried about."""
    cal = [CalendarDay(AS_OF - timedelta(days=i), was_open=True,
                       has_data=(i >= 4), open_source="no_sync" if i < 4 else "observed")
           for i in range(14)]
    facts = [DayFact(obs_date=c.obs_date, sku="S", units_sold=10.0)
             for c in cal if c.has_data]

    result = read_window(FeatureRequest("S", 14, facts, cal), ctx())
    assert result.value.open_days == 10
    assert result.value.unsynced_days == 4
    assert result.value.units_per_open_day == 10.0, "the rate is unchanged by the lag"
    assert any("unsynced_days_excluded:4" in r for r in result.reasons)


def test_too_few_open_days_refuses_rather_than_guessing() -> None:
    cal = [CalendarDay(AS_OF - timedelta(days=i), was_open=(i < 2), has_data=True)
           for i in range(14)]
    facts = [DayFact(obs_date=AS_OF, sku="S", units_sold=200.0)]
    result = read_window(FeatureRequest("S", 14, facts, cal), ctx())
    assert result.ok is False
    assert any(r.startswith("insufficient_open_days:2<3") for r in result.reasons)
    assert any(r.startswith("closed_days:") for r in result.reasons)


# ── RULE 2: point-in-time correctness ───────────────────────────────────────


def test_a_read_returns_what_was_known_then_not_what_is_known_now() -> None:
    """Without this every backtest leaks and reports a skill the live system
    will not have."""
    cal = [CalendarDay(AS_OF - timedelta(days=i), was_open=True, has_data=True)
           for i in range(10)]
    early = datetime(2026, 9, 15)
    late = datetime(2026, 9, 25)          # arrived AFTER the as-of date

    facts = [
        DayFact(obs_date=AS_OF - timedelta(days=5), sku="S", units_sold=10.0, known_at=early),
        DayFact(obs_date=AS_OF - timedelta(days=4), sku="S", units_sold=99.0, known_at=late),
    ]
    as_known_then = read_window(
        FeatureRequest("S", 10, facts, cal, known_as_of=datetime(2026, 9, 21, 23, 59)), ctx()
    )
    assert as_known_then.value.units == 10.0, "the late row must be invisible"

    as_known_now = read_window(
        FeatureRequest("S", 10, facts, cal, known_as_of=datetime(2026, 10, 1)), ctx()
    )
    assert as_known_now.value.units == 109.0, "and visible once it has arrived"


def test_visible_at_is_the_one_filter() -> None:
    rows = [
        DayFact(AS_OF, "S", 1.0, known_at=datetime(2026, 9, 1)),
        DayFact(AS_OF, "S", 2.0, known_at=datetime(2026, 9, 30)),
        DayFact(AS_OF, "S", 3.0, known_at=None),      # unstamped = always known
    ]
    kept = visible_at(rows, datetime(2026, 9, 21))
    assert [r.units_sold for r in kept] == [1.0, 3.0]
    assert len(visible_at(rows, None)) == 3           # no filter requested


def test_latest_price_is_the_latest_KNOWN_price_not_todays() -> None:
    """A 'latest' that leaks the present into the past is the same bug wearing
    a different hat."""
    cal = [CalendarDay(AS_OF - timedelta(days=i), was_open=True, has_data=True)
           for i in range(10)]
    facts = [
        DayFact(AS_OF - timedelta(days=6), "S", 1.0, price=20.0,
                known_at=datetime(2026, 9, 10)),
        DayFact(AS_OF - timedelta(days=1), "S", 1.0, price=99.0,
                known_at=datetime(2026, 9, 30)),   # not yet known
    ]
    result = read_window(
        FeatureRequest("S", 10, facts, cal, known_as_of=datetime(2026, 9, 21, 23, 59)), ctx()
    )
    assert result.value.latest_price == 20.0


# ── RULE 3: anchor to ctx.as_of, never the data frontier ────────────────────


def test_the_window_is_anchored_to_ctx_as_of() -> None:
    start, end = window_bounds(ctx(), 30)
    assert end == AS_OF
    assert start == AS_OF - timedelta(days=29)


def test_a_lagging_store_gets_the_SAME_window_as_production() -> None:
    """The bug in app/store_data/__init__.py: anchoring to max(sale_date)
    means a store 4 days behind silently gets a different 30 days."""
    cal = [CalendarDay(AS_OF - timedelta(days=i), was_open=True,
                       has_data=(i >= 4)) for i in range(30)]
    # The freshest fact is 4 days old - the data frontier.
    facts = [DayFact(AS_OF - timedelta(days=i), "S", 5.0) for i in range(4, 30)]

    result = read_window(FeatureRequest("S", 30, facts, cal), ctx())
    assert result.value.end_date == AS_OF, "anchored to the decision date"
    assert result.value.start_date == AS_OF - timedelta(days=29)
    # Had we anchored to the frontier the window would have been
    # [as_of-33, as_of-4] - a different 30 days entirely.
    assert result.value.unsynced_days == 4


def test_changing_as_of_changes_the_window_and_nothing_else() -> None:
    cal = [CalendarDay(date(2026, 9, 21) - timedelta(days=i), was_open=True,
                       has_data=True) for i in range(60)]
    facts = [DayFact(date(2026, 9, 21) - timedelta(days=i), "S", 1.0) for i in range(60)]

    a = read_window(FeatureRequest("S", 7, facts, cal), ctx())
    b = read_window(FeatureRequest("S", 7, facts, cal), ctx(as_of=date(2026, 9, 14)))
    assert a.value.end_date == date(2026, 9, 21)
    assert b.value.end_date == date(2026, 9, 14)
    assert a.value.units == b.value.units == 7.0


def test_incremental_bounds_end_at_as_of_with_a_late_arrival_lookback() -> None:
    start, end = incremental_bounds(ctx())
    assert end == AS_OF
    assert start == AS_OF - timedelta(days=7), "re-read a week to absorb late rows"


# ── The calendar builder ────────────────────────────────────────────────────


def test_sundays_become_closed_days() -> None:
    """Bethany's real shape, derived from observed trading days alone."""
    start, end = date(2026, 8, 24), date(2026, 9, 20)   # 4 full weeks
    traded = [
        TradingDay(start + timedelta(days=i))
        for i in range((end - start).days + 1)
        if (start + timedelta(days=i)).weekday() != 6
    ]
    result = derive_calendar(CalendarRequest(traded, start, end), ctx())
    assert result.ok
    assert result.value["open_days"] == 24
    assert result.value["closed_days"] == 4
    closed = [c for c in result.value["calendar"] if not c.was_open]
    assert all(c.obs_date.weekday() == 6 for c in closed), "every closure is a Sunday"


def test_a_long_silence_is_an_OUTAGE_not_a_closure() -> None:
    """A store does not shut for a week without warning nearly as often as a
    connector dies. Labelling an outage 'closed' hides it behind a
    plausible-looking calendar and quietly shrinks the denominator."""
    start, end = date(2026, 9, 1), date(2026, 9, 20)
    traded = [TradingDay(start + timedelta(days=i)) for i in range(20)
              if not (5 <= i <= 12)]          # an 8-day hole
    result = derive_calendar(CalendarRequest(traded, start, end), ctx())
    gap = [c for c in result.value["calendar"]
           if date(2026, 9, 6) <= c.obs_date <= date(2026, 9, 13)]
    assert all(c.open_source == "no_sync" for c in gap)
    assert all(not c.has_data for c in gap)
    assert result.value["unsynced_days"] == 8
    assert result.value["closed_days"] == 0, "not a closure"


def test_days_after_the_sync_frontier_are_unknown_not_closed() -> None:
    start, end = date(2026, 9, 1), date(2026, 9, 21)
    traded = [TradingDay(start + timedelta(days=i)) for i in range(17)]  # to 09-17
    result = derive_calendar(
        CalendarRequest(traded, start, end, synced_through=date(2026, 9, 17)), ctx()
    )
    tail = [c for c in result.value["calendar"] if c.obs_date > date(2026, 9, 17)]
    assert len(tail) == 4
    assert all(c.has_data is False and c.open_source == "no_sync" for c in tail)
    assert result.value["closed_days"] == 0


def test_an_empty_range_is_refused() -> None:
    result = derive_calendar(
        CalendarRequest([], date(2026, 9, 21), date(2026, 9, 1)), ctx())
    assert result.ok is False and "empty_date_range" in result.reasons


# ── The merge ───────────────────────────────────────────────────────────────


def test_a_missing_cost_stays_NULL_and_is_never_zero_filled() -> None:
    """gokul, square and mpower send 0.00% cost across 31 stores. A zero here
    would yield a 100% margin (sheet 02)."""
    cal = [CalendarDay(AS_OF, was_open=True, has_data=True)]
    facts = [DayFact(AS_OF, "A", 1.0), DayFact(AS_OF, "B", 1.0)]
    result = merge_day_facts(
        MergeRequest(facts, cal, unit_cost_by_sku={"A": 12.5, "B": None}), ctx())

    by_sku = {f.sku: f for f in result.value["facts"]}
    assert by_sku["A"].unit_cost == 12.5
    assert by_sku["B"].unit_cost is None, "absent, not 0.0"
    assert result.value["cost_coverage_pct"] == 50


def test_a_zero_cost_is_treated_as_absent() -> None:
    cal = [CalendarDay(AS_OF, was_open=True, has_data=True)]
    result = merge_day_facts(
        MergeRequest([DayFact(AS_OF, "A", 1.0)], cal, unit_cost_by_sku={"A": 0.0}), ctx())
    assert result.value["facts"][0].unit_cost is None
    assert result.value["cost_coverage_pct"] == 0


def test_a_fact_on_a_closed_day_is_dropped_and_counted() -> None:
    """Usually a timezone-shifted receipt. Writing it would make was_open a
    lie and shrink the denominator in the one direction nobody checks."""
    cal = [CalendarDay(AS_OF, was_open=False, has_data=True),
           CalendarDay(AS_OF - timedelta(days=1), was_open=True, has_data=True)]
    facts = [DayFact(AS_OF, "A", 5.0), DayFact(AS_OF - timedelta(days=1), "A", 3.0)]
    result = merge_day_facts(MergeRequest(facts, cal), ctx())
    assert result.value["rows"] == 1
    assert result.value["dropped_on_closed_days"] == 1
    assert "dropped_facts_on_closed_days:1" in result.reasons


# ── Empty store → full store ────────────────────────────────────────────────


def test_a_store_with_no_data_at_all_refuses_cleanly() -> None:
    result = read_window(FeatureRequest("S", 28, [], []), ctx())
    assert result.ok is False and "no_calendar_for_window" in result.reasons


def test_a_sku_that_never_sold_yields_zero_units_over_real_open_days() -> None:
    """A genuine zero. The store WAS open and this SKU did not sell - which is
    different from the store being closed, and the rate must be 0.0, not NULL."""
    cal = calendar_closing_sundays(28)
    result = read_window(FeatureRequest("GHOST", 28, [], cal), ctx())
    assert result.ok is True
    assert result.value.units == 0
    assert result.value.units_per_open_day == 0.0
    assert result.value.open_days == 24


def test_read_windows_shares_one_calendar_across_every_sku() -> None:
    cal = calendar_closing_sundays(28)
    facts = (facts_every_open_day(cal, "A", 10.0) + facts_every_open_day(cal, "B", 2.0))
    result = read_windows(FeatureRequest("", 28, facts, cal), ctx())
    assert result.ok
    windows = result.value["windows"]
    assert set(windows) == {"A", "B"}
    assert windows["A"]["open_days"] == windows["B"]["open_days"] == 24
    assert windows["A"]["units_per_open_day"] == 10.0
    assert windows["B"]["units_per_open_day"] == 2.0


# ── RULE 4 / sheet-00 conformance ───────────────────────────────────────────


@pytest.mark.parametrize("call", [
    lambda: read_window(FeatureRequest(
        "S", 28, facts_every_open_day(calendar_closing_sundays(28)),
        calendar_closing_sundays(28)), ctx()),
    lambda: derive_calendar(CalendarRequest(
        [TradingDay(date(2026, 9, 1))], date(2026, 9, 1), date(2026, 9, 5)), ctx()),
    lambda: merge_day_facts(MergeRequest(
        [DayFact(AS_OF, "A", 1.0)],
        [CalendarDay(AS_OF, was_open=True, has_data=True)]), ctx()),
])
def test_every_feature_stage_is_a_well_formed_stage(call) -> None:
    result = call()
    assert result.stamped
    assert result.provenance is not None
    assert result.duration_ms >= 0


def test_the_open_day_thresholds_record_themselves() -> None:
    cal = calendar_closing_sundays(28)
    result = read_window(FeatureRequest("S", 28, facts_every_open_day(cal), cal), ctx())
    assert "features.velocity.min_open_days" in result.provenance.config_keys


def test_the_same_code_answers_training_and_inference() -> None:
    """Rule 4. A training read at a past as_of and an inference read today go
    through the identical function - which is the bug that silently poisons
    most forecasting systems."""
    cal = [CalendarDay(date(2026, 9, 21) - timedelta(days=i), was_open=True,
                       has_data=True) for i in range(120)]
    facts = [DayFact(date(2026, 9, 21) - timedelta(days=i), "S", 4.0,
                     known_at=datetime(2026, 9, 21) - timedelta(days=i))
             for i in range(120)]

    training = read_window(
        FeatureRequest("S", 28, facts, cal,
                       known_as_of=datetime(2026, 6, 1, 23, 59)),
        ctx(as_of=date(2026, 6, 1)))
    inference = read_window(FeatureRequest("S", 28, facts, cal), ctx())

    assert training.stage == inference.stage == "feature_window"
    assert training.stage_version == inference.stage_version
    assert training.value.units_per_open_day == inference.value.units_per_open_day == 4.0
