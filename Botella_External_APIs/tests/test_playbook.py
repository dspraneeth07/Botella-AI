"""N8.3 — the playbook is ONE card with many lines, trimmed to the budget."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.pipeline.candidates.playbook import (
    ALERT_SAFETY_BUFFER_DAYS,
    MIN_LINES,
    Playbook,
    PlaybookLine,
    alert_date_for,
    build_playbook,
)
from app.pipeline.context import RunContext
from app.pipeline.features.events import EVENTS_BY_KEY
from app.pipeline.registry import cfg

AS_OF = date(2026, 10, 1)
THANKSGIVING = EVENTS_BY_KEY["thanksgiving"]


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-n83", "tenant_id": 1, "store_id": 171, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"playbook": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def line(sku: str, *, order=20.0, promise=12.0, cost=10.0, margin=5.0,
         lift=1.8) -> PlaybookLine:
    return PlaybookLine(
        sku=sku, product=f"Product {sku}", order_units=order,
        promise_units=promise, unit_cost=cost, unit_margin=margin,
        lift_multiple=lift, evidence="your 3 previous at 50% and 14 peers at 50%",
        why=f"{lift:.1f}x its usual rate in this window",
    )


def playbook(lines, *, budget=10_000.0, lead=7, c=None) -> Playbook:
    year = 2026
    start, end = THANKSGIVING.window(year)
    return build_playbook(
        event_key="thanksgiving", event_name="Thanksgiving",
        event_date=THANKSGIVING.date_for(year),
        window_start=start, window_end=end,
        window_pre_days=THANKSGIVING.window_pre_days,
        candidate_lines=lines, lead_time_days=lead,
        evidence="your 3 previous Thanksgivings and 14 Texas peers",
        ctx=c or ctx(), cash_budget=budget,
    )


# ── One card ─────────────────────────────────────────────────────────────────


def test_playbook_is_one_card_not_many() -> None:
    """Thirty products is thirty LINES on one card. One decision, one cash
    commitment, one thing the owner says yes or no to."""
    book = playbook([line(f"sku{i}") for i in range(30)])

    assert isinstance(book, Playbook), "one object, not a list of cards"
    assert len(book.lines) > 1
    # The card's own currency is the SUM, so it ranks as a single candidate.
    assert book.units_at_stake == pytest.approx(
        sum(line_.promise_units for line_ in book.lines))
    assert book.cash_required == pytest.approx(
        sum(line_.cash_required for line_ in book.lines))
    assert "Order" in book.explain()
    # And it serialises as one object with lines inside it.
    d = book.as_dict()
    assert isinstance(d, dict) and isinstance(d["lines"], list)


def test_order_and_promise_are_different_numbers() -> None:
    """The split is visible to the owner here because they commit cash weeks
    early: buy the high quantile, expect the low one."""
    book = playbook([line(f"sku{i}", order=20.0, promise=12.0) for i in range(4)])
    for line_ in book.lines:
        assert line_.order_units > line_.promise_units
        assert line_.as_dict()["order_units"] != line_.as_dict()["promise_units"]
    # The cash commits the ORDER; the margin is claimed on the PROMISE.
    first = book.lines[0]
    assert first.cash_required == pytest.approx(first.order_units * 10.0)
    assert first.expected_margin == pytest.approx(first.promise_units * 5.0)


def test_a_promise_above_the_order_is_refused_at_construction() -> None:
    """The promise is a LOW quantile and the order a HIGH one. That ordering
    cannot be reversed by a caller."""
    with pytest.raises(ValueError, match="exceeds"):
        line("x", order=10.0, promise=15.0)
    with pytest.raises(ValueError, match=">= 0"):
        line("x", order=-1.0, promise=0.0)


# ── The alert date ───────────────────────────────────────────────────────────


def test_alert_date_accounts_for_lead_time_and_window() -> None:
    """event - window_pre - lead_time - safety_buffer, in CALENDAR days: a
    supplier's lead time runs on the supplier's calendar, and a delivery does not
    wait for a Sunday closure."""
    c = ctx()
    buffer_days = int(cfg.get(ALERT_SAFETY_BUFFER_DAYS, c))
    event = THANKSGIVING.date_for(2026)
    pre = THANKSGIVING.window_pre_days

    alert = alert_date_for(event, pre, 7, c)
    assert alert == event - timedelta(days=pre + 7 + buffer_days)

    # A longer lead time alerts EARLIER.
    assert alert_date_for(event, pre, 21, c) < alert
    # A wider selling window alerts earlier too.
    assert alert_date_for(event, 14, 7, c) < alert

    book = playbook([line(f"sku{i}") for i in range(4)], lead=7)
    assert book.alert_on == alert
    assert book.alert_on < book.window_start, (
        "the alert must land before the selling window opens, or it is useless"
    )
    # Four to six weeks of notice for a 3-day run-up at a 7-day declared lead.
    assert 14 <= (event - book.alert_on).days <= 45


def test_the_card_carries_the_lead_time_assumption() -> None:
    """purchase_orders is empty at four of five stores, so the 4-to-6-week promise
    is a consequence of an assumption, not a measurement."""
    book = playbook([line(f"sku{i}") for i in range(4)])
    joined = " ".join(book.assumptions()).lower()
    assert "declared" in joined
    assert "not measured" in joined
    assert "lead time" in joined
    assert "cash available" in joined
    assert book.as_dict()["assumptions"]


# ── The budget ───────────────────────────────────────────────────────────────


def test_playbook_trimmed_to_cash_budget_keeps_best_ratio_lines() -> None:
    """A playbook is the largest single cash ask the engine makes, so the budget
    binds hardest here - and it trims by expected margin per dollar, not by size.
    """
    # Good ratio: $100 of cash for $60 of margin. Bad: $400 for $60.
    # Same promise and the same margin, so the same $60 of expected margin -
    # but the bad lines commit four times the cash to earn it.
    good = [PlaybookLine(sku=f"good{i}", product="g", order_units=10.0,
                         promise_units=8.0, unit_cost=10.0, unit_margin=7.5,
                         lift_multiple=2.0, evidence="e", why="w")
            for i in range(3)]
    bad = [PlaybookLine(sku=f"bad{i}", product="b", order_units=40.0,
                        promise_units=8.0, unit_cost=10.0, unit_margin=7.5,
                        lift_multiple=2.0, evidence="e", why="w")
           for i in range(3)]
    assert good[0].expected_margin == pytest.approx(bad[0].expected_margin)
    assert bad[0].cash_required == pytest.approx(4 * good[0].cash_required)

    assert good[0].ratio > bad[0].ratio
    book = playbook(good + bad, budget=300.0)

    chosen = {line_.sku for line_ in book.lines}
    assert chosen == {"good0", "good1", "good2"}, (
        "the best ratio lines must survive the trim"
    )
    assert book.cash_required <= 300.0
    # Everything dropped is RECORDED with a reason, never silently truncated.
    assert len(book.trimmed) == 3
    assert all("over_cash_budget" in reason for _, reason in book.trimmed)
    assert "trimmed" in book.explain()


def test_the_budget_is_never_exceeded() -> None:
    for budget in (0.0, 50.0, 199.0, 1000.0):
        book = playbook([line(f"sku{i}") for i in range(10)], budget=budget)
        assert book.cash_required <= budget + 1e-9, budget


def test_a_line_with_no_margin_is_recorded_not_counted() -> None:
    priced = [line(f"sku{i}") for i in range(3)]
    unpriced = PlaybookLine(
        sku="nocost", product="n", order_units=10.0, promise_units=5.0,
        unit_cost=None, unit_margin=None, lift_multiple=2.0,
        evidence="e", why="w")
    book = playbook(priced + [unpriced])
    assert "nocost" not in {line_.sku for line_ in book.lines}
    assert any("no_unit_margin" in reason for _, reason in book.trimmed)


def test_the_playbook_is_identical_on_a_rerun() -> None:
    lines = [line(f"sku{i}", order=10.0 + i, promise=5.0, margin=5.0 - i * 0.1)
             for i in range(8)]
    first = playbook(lines, budget=400.0)
    second = playbook(list(reversed(lines)), budget=400.0)
    assert [line_.sku for line_ in first.lines] == \
        [line_.sku for line_ in second.lines]


# ── Emptiness is valid ───────────────────────────────────────────────────────


def test_empty_playbook_is_valid() -> None:
    """A playbook of refused lines is an empty playbook. Not an error."""
    book = playbook([])
    assert book.is_empty is True
    assert book.lines == ()
    assert book.units_at_stake == 0.0
    assert book.cash_required == 0.0
    assert "No playbook" in book.explain()
    assert book.as_dict()["is_empty"] is True
    # It still carries its event and its alert date, so the absence is dated.
    assert book.event_key == "thanksgiving"
    assert book.alert_on < book.event_date


def test_refused_lines_are_excluded() -> None:
    """The caller excludes SKUs whose uplift was refused; a playbook does not
    re-litigate the estimate. With nothing surviving, the result is empty."""
    assert playbook([]).is_empty is True
    # And a budget of zero leaves nothing, which is also empty rather than an
    # error.
    starved = playbook([line(f"sku{i}") for i in range(5)], budget=0.0)
    assert starved.is_empty is True
    assert len(starved.trimmed) == 5


def test_too_few_lines_withholds_the_card() -> None:
    """A 'playbook' of one line is a reorder card wearing a costume - all the
    ceremony of an event plan and none of the breadth that is its value."""
    c = ctx()
    minimum = int(cfg.get(MIN_LINES, c))
    assert minimum == 3

    assert playbook([line("a"), line("b")]).is_empty is True
    assert playbook([line("a"), line("b"), line("c")]).is_empty is False
    # And the reason survives rather than the lines vanishing.
    thin = playbook([line("a")])
    assert any("too_few_lines" in reason for _, reason in thin.trimmed)


def test_every_setting_is_declared_provisional() -> None:
    for setting in (ALERT_SAFETY_BUFFER_DAYS, MIN_LINES):
        assert setting.status == "PROVISIONAL"
        assert setting.why.strip() and setting.owner.strip()
        assert cfg.get(setting, ctx()) is not None
