"""The event playbook, wired from a store's own history to one card.

The chain is `features/events.py` (when) -> `blend/event_uplift.py` (how much) ->
`candidates/playbook.py` (the order list) -> one card. All three existed and
nothing connected them.

Measured across five pilot stores: 453 usable (event x SKU) uplifts whose intervals
exclude zero. They read like liquor retail rather than noise - Super Bowl on
flavoured shots at 4.27x, Thanksgiving Eve on Corona and Titos at 2.45x, Christmas
Eve on Hennessy at 2.16x, Cinco de Mayo on New Amsterdam Pineapple at 3.07x.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.pipeline.blend.event_uplift import Occurrence
from app.pipeline.candidates.event_playbook_builder import (
    MIN_LINE_ORDER_UNITS,
    SkuFacts,
    build_for_event,
    due_events,
    occurrences_for,
)
from app.pipeline.candidates.playbook import PlaybookLine, build_playbook
from app.pipeline.context import RunContext
from app.pipeline.registry import cfg
from app.recommender.families import (
    MIN_EVENT_OCCURRENCES,
    MIN_SIGNAL_OBSERVATIONS,
    confidence_from_evidence,
    event_playbook,
)

AS_OF = date(2026, 10, 6)


def ctx(as_of: date = AS_OF) -> RunContext:
    return RunContext(
        run_id="run-pb", tenant_id=1, store_id=171, as_of=as_of,
        snapshot_id="snap-1", config_version="default", seed=0,
        versions={"playbook": "1.0.0", "event_uplift": "1.0.0"},
    )


def trading(start: date, days: int) -> list[date]:
    """Open every day except Sunday, so open days differ from calendar days."""
    out, day = [], start
    while len(out) < days:
        if day.weekday() != 6:
            out.append(day)
        day += timedelta(days=1)
    return out


DAYS = trading(date(2023, 1, 2), 1200)


def series_with_event_lift(*, event_window_lift: float, base: float = 4.0,
                          seed: int = 0) -> dict[date, float]:
    """A SKU selling `base` a day, lifting during every Thanksgiving Eve window.

    The lift VARIES between years, which is not decoration. `event_uplift` refuses
    three identical observations as `zero_dispersion` - a spread of zero gives an
    interval of zero width, which would pass `spans_zero` and let the card state a
    perfectly certain number from three data points. A fixture with a deterministic
    lift produces an empty playbook, and the first version of this file did exactly
    that and looked like a wiring bug.
    """
    import random

    from app.pipeline.features.events import EVENTS_BY_KEY

    event = EVENTS_BY_KEY["thanksgiving_eve"]
    rng = random.Random(seed)
    windows = []
    for year in sorted({d.year for d in DAYS}):
        try:
            # A different realised lift each year, around the true one.
            windows.append((*event.window(year),
                            event_window_lift * rng.uniform(0.75, 1.25)))
        except Exception:
            continue
    out = {}
    for day in DAYS:
        lift = 1.0
        for start, end, year_lift in windows:
            if start <= day <= end:
                lift = year_lift
        # A little day-to-day noise too, so the baseline is not a constant either.
        out[day] = base * lift * rng.uniform(0.9, 1.1)
    return out


def facts(n: int = 40) -> dict[str, SkuFacts]:
    return {f"S{i}": SkuFacts(name=f"Product {i}", unit_cost=10.0,
                              unit_margin=6.0) for i in range(n)}


def catalogue_with_lift(lift: float, n: int = 40) -> dict[str, dict]:
    # A distinct seed per SKU, so the catalogue is not 40 copies of one series.
    return {f"S{i}": series_with_event_lift(event_window_lift=lift, seed=i)
            for i in range(n)}


# ── The alert schedule ───────────────────────────────────────────────────────


def test_nothing_is_due_until_the_alert_date_arrives() -> None:
    """The whole value of a playbook is lead time, so firing late is the one
    failure that makes it worthless. Halloween is 25 days away on 6 October and its
    alert has NOT fired; it fires around the 20th."""
    assert due_events(as_of=date(2026, 10, 6), lead_time_days=7,
                      ctx=ctx(date(2026, 10, 6))) == []
    later = due_events(as_of=date(2026, 10, 20), lead_time_days=7,
                       ctx=ctx(date(2026, 10, 20)))
    assert ("halloween", 2026) in later


def test_the_calendar_walks_from_event_to_event() -> None:
    expected = {
        date(2026, 10, 20): "halloween",
        date(2026, 11, 10): "thanksgiving",
        date(2026, 12, 5): "christmas",
    }
    for day, key in expected.items():
        keys = {k for k, _ in due_events(as_of=day, lead_time_days=7,
                                         ctx=ctx(day))}
        assert key in keys, (day, keys)


def test_a_longer_lead_time_alerts_earlier() -> None:
    """A supplier taking three weeks has to be told three weeks sooner."""
    day = date(2026, 10, 14)
    short = due_events(as_of=day, lead_time_days=3, ctx=ctx(day))
    long = due_events(as_of=day, lead_time_days=21, ctx=ctx(day))
    assert len(long) >= len(short)


def test_a_past_event_is_never_due() -> None:
    keys = {k for k, _ in due_events(as_of=date(2026, 12, 28), lead_time_days=7,
                                     ctx=ctx(date(2026, 12, 28)))}
    assert "halloween" not in keys
    assert "thanksgiving" not in keys


# ── Matched weekdays, which is the whole validity of the estimate ────────────


def test_the_baseline_is_matched_weekdays_only() -> None:
    """Thanksgiving Eve is always a Wednesday. Compare it to "the usual day" and
    the usual day averages in Sundays, so the uplift measures Wednesday and credits
    Thanksgiving."""
    series = {d: 4.0 for d in DAYS}   # perfectly flat: no lift, no noise
    found = occurrences_for(series=series, trading_days=DAYS,
                            event_key="thanksgiving_eve",
                            years=sorted({d.year for d in DAYS}), ctx=ctx())
    assert found, "the windows must be found at all"
    for occurrence in found:
        # With no lift and a matched baseline, the two rates must agree.
        event_rate = occurrence.event_units / occurrence.event_open_days
        base_rate = occurrence.baseline_units / occurrence.baseline_open_days
        assert event_rate == pytest.approx(base_rate, rel=0.02), occurrence


def test_a_window_outside_the_export_is_skipped_not_estimated() -> None:
    short = trading(date(2026, 1, 5), 60)
    found = occurrences_for(series={d: 4.0 for d in short}, trading_days=short,
                            event_key="thanksgiving_eve", years=[2026], ctx=ctx())
    assert found == []


def test_open_days_are_the_denominator() -> None:
    """A store shut on Sundays has fewer baseline days than a calendar count
    implies, and the wrong denominator inflates every uplift the same way."""
    found = occurrences_for(series=series_with_event_lift(event_window_lift=2.0),
                            trading_days=DAYS, event_key="thanksgiving_eve",
                            years=sorted({d.year for d in DAYS}), ctx=ctx())
    for occurrence in found:
        assert occurrence.baseline_open_days > 0
        assert occurrence.event_open_days > 0
        # No Sundays were counted: the window is 3 calendar days.
        assert occurrence.event_open_days <= 3


# ── Order and promise are different numbers ──────────────────────────────────


def test_order_exceeds_promise_on_every_line() -> None:
    """The one card where an owner feels the split, because they commit cash weeks
    early. Both come from the same interval, so the promise cannot exceed the
    order - and PlaybookLine refuses that at construction too."""
    book = build_for_event(
        event_key="thanksgiving_eve", year=2025,
        daily_by_sku=catalogue_with_lift(2.5), trading_days=DAYS,
        facts_by_sku=facts(), lead_time_days=7, cash_budget=5000.0, ctx=ctx())
    assert book is not None and book.lines, "a 2.5x lift must produce lines"
    for line in book.lines:
        assert line.order_units >= line.promise_units


def test_a_bigger_lift_orders_more() -> None:
    small = build_for_event(
        event_key="thanksgiving_eve", year=2025,
        daily_by_sku=catalogue_with_lift(1.6), trading_days=DAYS,
        facts_by_sku=facts(), lead_time_days=7, cash_budget=50_000.0, ctx=ctx())
    large = build_for_event(
        event_key="thanksgiving_eve", year=2025,
        daily_by_sku=catalogue_with_lift(3.0), trading_days=DAYS,
        facts_by_sku=facts(), lead_time_days=7, cash_budget=50_000.0, ctx=ctx())
    assert small is not None and large is not None
    assert large.units_at_stake > small.units_at_stake


# ── Materiality: the bug the measurement exposed ─────────────────────────────


def test_no_line_orders_fewer_than_the_materiality_floor() -> None:
    """Without this floor, 16 to 28 of every 30 lines ordered under 3 units and
    11 to 27 ordered exactly ONE. A line saying "order 1 extra bottle" is
    indistinguishable from the owner's ordinary reorder, and thirty of them crowd
    out the handful that are real."""
    floor = float(cfg.get(MIN_LINE_ORDER_UNITS, ctx()))
    assert floor >= 3.0
    book = build_for_event(
        event_key="thanksgiving_eve", year=2025,
        daily_by_sku=catalogue_with_lift(2.5), trading_days=DAYS,
        facts_by_sku=facts(), lead_time_days=7, cash_budget=50_000.0, ctx=ctx())
    assert book is not None
    for line in book.lines:
        assert line.order_units >= floor, line


def test_a_trivial_seller_produces_no_line() -> None:
    """A 6x lift on a product selling 0.15 a day is three units over a weekend,
    and rounding made it one. Those lines were sorted FIRST because their margin
    per dollar was high on a trivial base."""
    tiny = {"S0": {d: 0.02 for d in DAYS}}
    book = build_for_event(
        event_key="thanksgiving_eve", year=2025, daily_by_sku=tiny,
        trading_days=DAYS, facts_by_sku=facts(1), lead_time_days=7,
        cash_budget=50_000.0, ctx=ctx())
    assert book is not None
    assert book.is_empty or all(l.order_units >= 3 for l in book.lines)


# ── One card, many lines ─────────────────────────────────────────────────────


def test_a_playbook_is_one_card_carrying_every_sku() -> None:
    """Thirty products for Thanksgiving is thirty LINES on one card, not thirty
    cards. The owner makes one decision and commits cash once."""
    lines = [PlaybookLine(sku=f"s{i}", product=f"Product {i}", order_units=12.0,
                          promise_units=8.0, unit_cost=10.0, unit_margin=5.0,
                          lift_multiple=2.1, evidence="your 3 previous", why="w")
             for i in range(9)]
    book = build_playbook(
        event_key="thanksgiving", event_name="Thanksgiving",
        event_date=date(2026, 11, 26), window_start=date(2026, 11, 23),
        window_end=date(2026, 11, 26), window_pre_days=3,
        candidate_lines=lines, lead_time_days=7,
        evidence="your 3 previous Thanksgivings", ctx=ctx(), cash_budget=5000.0)
    cards = event_playbook(book, occurrences=3)
    assert len(cards) == 1, "ONE card"
    assert len(cards[0].skus) == len(book.lines)
    assert cards[0].action_type == "pre_stock"
    assert cards[0].signals_cited == ("event_thanksgiving",)
    # The rationale carries the plan, the date to order by, and the evidence.
    assert "Order by" in cards[0].rationale
    assert "Based on" in cards[0].rationale


def test_an_empty_playbook_produces_no_card() -> None:
    """A store with one past occurrence of an event cannot estimate it, and
    MIN_OCCURRENCES refuses rather than guessing from one year. Marshfield's export
    begins in February 2025, so it has exactly one Thanksgiving."""
    empty = build_playbook(
        event_key="thanksgiving", event_name="Thanksgiving",
        event_date=date(2026, 11, 26), window_start=date(2026, 11, 23),
        window_end=date(2026, 11, 26), window_pre_days=3,
        candidate_lines=[], lead_time_days=7, evidence="e", ctx=ctx(),
        cash_budget=5000.0)
    assert empty.is_empty
    assert event_playbook(empty, occurrences=3) == []
    assert event_playbook(None, occurrences=3) == []


# ── Confidence is in OCCURRENCES, not days ───────────────────────────────────


def test_the_shrinkage_constant_is_in_event_occurrences() -> None:
    """A unit mismatch that would have shipped. MIN_SIGNAL_OBSERVATIONS is 20 and
    right for a DAILY signal; an event happens once a year, so four Thanksgivings
    through n/(n+20) scores 0.167 - indistinguishable from no evidence."""
    assert MIN_EVENT_OCCURRENCES < MIN_SIGNAL_OBSERVATIONS
    assert confidence_from_evidence(4, MIN_EVENT_OCCURRENCES) > 0.5
    assert confidence_from_evidence(4, MIN_SIGNAL_OBSERVATIONS) < 0.2


def test_more_occurrences_means_more_confidence() -> None:
    lines = [PlaybookLine(sku="s1", product="P", order_units=12.0,
                          promise_units=8.0, unit_cost=10.0, unit_margin=5.0,
                          lift_multiple=2.1, evidence="e", why="w")
             for _ in range(1)] * 3
    book = build_playbook(
        event_key="thanksgiving", event_name="Thanksgiving",
        event_date=date(2026, 11, 26), window_start=date(2026, 11, 23),
        window_end=date(2026, 11, 26), window_pre_days=3,
        candidate_lines=lines, lead_time_days=7, evidence="e", ctx=ctx(),
        cash_budget=5000.0)
    scores = [event_playbook(book, occurrences=n)[0].confidence
              for n in (2, 3, 4, 6)]
    assert scores == sorted(scores)
    assert all(0.0 < s < 1.0 for s in scores)


def test_a_lost_occurrence_count_refuses_rather_than_scoring_zero() -> None:
    """Every usable uplift rests on at least MIN_OCCURRENCES instances, so zero
    means the caller lost the count. The first version read a field PlaybookLine
    does not have, got 0, and would have put a 0.00-confidence plan in front of an
    owner."""
    lines = [PlaybookLine(sku="s1", product="P", order_units=12.0,
                          promise_units=8.0, unit_cost=10.0, unit_margin=5.0,
                          lift_multiple=2.1, evidence="e", why="w")] * 3
    book = build_playbook(
        event_key="thanksgiving", event_name="Thanksgiving",
        event_date=date(2026, 11, 26), window_start=date(2026, 11, 23),
        window_end=date(2026, 11, 26), window_pre_days=3,
        candidate_lines=lines, lead_time_days=7, evidence="e", ctx=ctx(),
        cash_budget=5000.0)
    assert event_playbook(book, occurrences=0) == []


# ── The luni-solar horizon is a refusal, not a guess ─────────────────────────


def test_an_event_past_its_tabulated_horizon_returns_none() -> None:
    """`events.py` raises past 2030 for the four luni-solar events rather than
    extrapolating a date, and this must surface as "no playbook" rather than a
    wrong one."""
    book = build_for_event(
        event_key="diwali", year=2099, daily_by_sku=catalogue_with_lift(2.0),
        trading_days=DAYS, facts_by_sku=facts(), lead_time_days=7,
        cash_budget=5000.0, ctx=ctx())
    assert book is None


def test_an_unknown_event_key_returns_none() -> None:
    assert build_for_event(
        event_key="not_an_event", year=2026,
        daily_by_sku=catalogue_with_lift(2.0), trading_days=DAYS,
        facts_by_sku=facts(), lead_time_days=7, cash_budget=5000.0,
        ctx=ctx()) is None


def test_the_budget_is_never_exceeded() -> None:
    for budget in (0.0, 100.0, 500.0, 2000.0):
        book = build_for_event(
            event_key="thanksgiving_eve", year=2025,
            daily_by_sku=catalogue_with_lift(2.5), trading_days=DAYS,
            facts_by_sku=facts(), lead_time_days=7, cash_budget=budget,
            ctx=ctx())
        assert book is not None
        assert book.cash_required <= budget + 1e-9, budget
