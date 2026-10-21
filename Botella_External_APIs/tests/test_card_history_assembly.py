"""Assembling the lifecycle feed. The screen was complete and starved of input.

`choose()` has accepted `card_history` for weeks and no caller ever sent any, so
production showed one store the same product FIFTEEN times. These tests pin the
assembly, and especially the cases where a SKU must be SKIPPED rather than
guessed at.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.pipeline.candidates.card_history import PriorCard, assemble, from_rows
from app.pipeline.candidates.lifecycle import CardHistory

AS_OF = date(2026, 10, 6)
#: A store that trades every day except Sunday, for 40 days back.
TRADING = [AS_OF - timedelta(days=n) for n in range(40, -1, -1)
           if (AS_OF - timedelta(days=n)).weekday() != 6]


def row(sku="SKU1", first="2026-09-29", shown=15, rate=0.68) -> dict:
    return {"sku": sku, "first_issued": first, "times_shown": shown,
            "baseline_rate": rate}


def daily(sku="SKU1", units_per_day=0.5) -> dict:
    return {sku: {d: units_per_day for d in TRADING}}


# ── It builds what the lifecycle needs ───────────────────────────────────────


def test_a_real_node_row_becomes_a_usable_history() -> None:
    """The shape Node actually returns, taken from the live query."""
    out, skipped = from_rows([row()], daily_by_sku=daily(),
                             trading_days=TRADING, as_of=AS_OF)
    assert skipped == {}
    assert len(out) == 1
    h = out[0]
    assert isinstance(h, CardHistory)
    assert h.sku == "SKU1"
    assert h.first_issued == date(2026, 9, 29)
    assert h.baseline_rate == pytest.approx(0.68)
    assert h.open_days_since > 0
    assert h.units_since > 0


def test_open_days_are_counted_not_calendar_days() -> None:
    """The suppression window is counted in OPEN days. A store shut on Sundays
    reaches 14 open days LATER than a calendar count implies, and getting this
    denominator wrong brings a suppressed card back a fortnight early."""
    first = date(2026, 9, 29)
    out, _ = from_rows([row(first=first.isoformat())], daily_by_sku=daily(),
                       trading_days=TRADING, as_of=AS_OF)
    calendar_days = (AS_OF - first).days
    expected_open = sum(1 for d in TRADING if first < d <= AS_OF)
    assert out[0].open_days_since == expected_open
    assert out[0].open_days_since < calendar_days, (
        "a Sunday-closed store must have fewer open days than calendar days")


def test_units_since_counts_only_sales_after_the_card_went_up() -> None:
    """Sales from before the card was issued are not evidence about the card."""
    first = date(2026, 10, 1)
    series = {"SKU1": {d: (10.0 if d <= first else 1.0) for d in TRADING}}
    out, _ = from_rows([row(first=first.isoformat())], daily_by_sku=series,
                       trading_days=TRADING, as_of=AS_OF)
    after = sum(1.0 for d in TRADING if first < d <= AS_OF)
    assert out[0].units_since == pytest.approx(after)


def test_the_realised_rate_is_computable_and_comparable() -> None:
    """The whole point: the lifecycle divides realised BY baseline."""
    out, _ = from_rows([row(rate=0.5)], daily_by_sku=daily(units_per_day=1.0),
                       trading_days=TRADING, as_of=AS_OF)
    h = out[0]
    assert h.realised_rate == pytest.approx(1.0)
    assert h.realised_rate / h.baseline_rate == pytest.approx(2.0)


# ── Absence is skipped, never defaulted ──────────────────────────────────────


def test_a_sku_with_no_baseline_rate_is_skipped_not_defaulted() -> None:
    """34 of 49 SKUs at the first store checked predate the `engine_daily_rate`
    column. A default of zero makes `realised / baseline` either a divide-by-zero
    or an infinite recovery ratio, and either one retires or rescues a card on no
    evidence at all."""
    out, skipped = from_rows([row(rate=None)], daily_by_sku=daily(),
                             trading_days=TRADING, as_of=AS_OF)
    assert out == ()
    assert skipped == {"no_baseline_rate": 1}


def test_a_zero_or_negative_baseline_is_skipped() -> None:
    for bad in (0.0, -1.0):
        out, skipped = from_rows([row(rate=bad)], daily_by_sku=daily(),
                                 trading_days=TRADING, as_of=AS_OF)
        assert out == (), bad
        assert "baseline_rate_not_positive" in skipped, bad


def test_a_card_issued_in_the_future_is_skipped() -> None:
    """A clock skew between Node and Python must not produce a negative window."""
    out, skipped = from_rows(
        [row(first=(AS_OF + timedelta(days=3)).isoformat())],
        daily_by_sku=daily(), trading_days=TRADING, as_of=AS_OF)
    assert out == ()
    assert skipped == {"issued_in_the_future": 1}


def test_an_unparseable_row_is_counted_not_raised() -> None:
    """A malformed row in an OPTIONAL feed must never sink a run."""
    bad_rows = [
        {},                                        # nothing at all
        {"sku": "", "first_issued": "2026-09-29"},  # no sku
        {"sku": "A"},                               # no date
        {"sku": "B", "first_issued": "not-a-date"},
    ]
    out, skipped = from_rows(bad_rows, daily_by_sku=daily(),
                            trading_days=TRADING, as_of=AS_OF)
    assert out == ()
    assert skipped.get("unparseable_row") == 4


def test_a_sku_with_no_sales_at_all_still_gets_a_history() -> None:
    """Zero sales since the card went up is the STRONGEST evidence the card is
    failing, so it must produce a history rather than be skipped for having no
    series - which would protect exactly the cards that deserve retiring."""
    out, skipped = from_rows([row(sku="GHOST")], daily_by_sku={},
                             trading_days=TRADING, as_of=AS_OF)
    assert len(out) == 1
    assert out[0].units_since == 0.0
    assert out[0].realised_rate == 0.0
    assert skipped == {}


def test_zero_open_days_is_a_zero_rate_never_a_divide() -> None:
    """Same guard sheet 19 needed after an unguarded version turned a closed
    store's lift into Infinity."""
    out, _ = from_rows([row(first=AS_OF.isoformat())], daily_by_sku=daily(),
                       trading_days=[AS_OF], as_of=AS_OF)
    assert len(out) == 1
    assert out[0].open_days_since == 0
    assert out[0].realised_rate == 0.0


# ── The real production data ──────────────────────────────────────────────────


def test_the_products_production_showed_fifteen_times() -> None:
    """The exact rows the live query returned for store 171. These are what the
    lifecycle screen now sees, and what it was blind to before."""
    real = [
        {"sku": "088110151058", "first_issued": "2026-09-23",
         "times_shown": 15, "baseline_rate": 0.304},
        {"sku": "854493005710", "first_issued": "2026-09-29",
         "times_shown": 15, "baseline_rate": 0.6743},
        {"sku": "088004063849", "first_issued": "2026-09-29",
         "times_shown": 15, "baseline_rate": 0.2811},
        {"sku": "080432500149", "first_issued": "2026-09-09",
         "times_shown": 12, "baseline_rate": 0.3399},
        # 34 of 49 real rows look like this - older than the column.
        {"sku": "OLD1", "first_issued": "2026-09-01",
         "times_shown": 4, "baseline_rate": None},
    ]
    series = {r["sku"]: {d: 0.1 for d in TRADING} for r in real}
    out, skipped = from_rows(real, daily_by_sku=series,
                            trading_days=TRADING, as_of=AS_OF)
    assert len(out) == 4, "the four with a usable rate"
    assert skipped == {"no_baseline_rate": 1}
    # Each one is now a card the lifecycle can judge.
    for h in out:
        assert h.baseline_rate > 0
        assert h.open_days_since >= 1


def test_times_shown_is_carried_even_though_the_screen_recomputes_it() -> None:
    """Node counts the cards; the lifecycle counts open days. Both are kept
    because they answer different questions, and a mismatch between them is a
    signal worth being able to see."""
    card = PriorCard.from_row(row(shown=15))
    assert card is not None
    assert card.times_shown == 15
    assert PriorCard.from_row(row(shown=0)).times_shown == 1, "floored at one"


def test_an_empty_feed_produces_no_histories_and_no_error() -> None:
    """A 404 from Node leaves the selector with no memory, which is exactly how
    it behaved before this existed."""
    out, skipped = assemble((), daily_by_sku={}, trading_days=TRADING,
                            as_of=AS_OF)
    assert out == () and skipped == {}


# -- WHAT THE OWNER DID, which never reached the selector ---------------------


def test_an_accepted_card_retires_as_done_not_as_failing() -> None:
    """`recommendations` has carried `vote` and `action_claim` all along and the
    card-history feed returned neither, so the engine could not tell "ordered on
    day one" from "ignored for a month" and re-issued both identically.

    This is NOT a judgement on the recommendation. It retires a card that WORKED,
    and the suppression afterwards is the gap in which the order lands and sells.
    """
    from datetime import date as _date

    from app.pipeline.candidates.lifecycle import CardHistory, review_card
    from app.pipeline.context import RunContext

    ctx = RunContext(run_id="r", tenant_id=1, store_id=171,
                     as_of=_date(2026, 10, 7), snapshot_id="s",
                     config_version="default", seed=0, versions={})
    base = dict(sku="X", first_issued=_date(2026, 10, 1), baseline_rate=1.0,
                units_since=6.0, open_days_since=5)

    # Recovering nicely: every claim-based rule would keep it.
    assert review_card(CardHistory(**base), ctx).retire is False

    accepted = review_card(CardHistory(**base, accepted=True), ctx)
    assert accepted.retire is True and accepted.rule == "acted_on"
    assert "ordered this" in accepted.reason

    dismissed = review_card(CardHistory(**base, dismissed=True), ctx)
    assert dismissed.retire is True and dismissed.rule == "dismissed"


def test_the_owner_outranks_the_arithmetic() -> None:
    """A card can be recovering AND finished. Whether the claim is holding up is a
    question about the product; whether the advice has been dealt with is a
    question about the card, and only the second one decides if it stays on screen.
    """
    from datetime import date as _date

    from app.pipeline.candidates.lifecycle import CardHistory, review_card
    from app.pipeline.context import RunContext

    ctx = RunContext(run_id="r", tenant_id=1, store_id=171,
                     as_of=_date(2026, 10, 7), snapshot_id="s",
                     config_version="default", seed=0, versions={})
    # Collapsing - `declining` would fire - but the owner already ordered it.
    collapsing = CardHistory(sku="X", first_issued=_date(2026, 10, 1),
                             baseline_rate=10.0, units_since=0.0,
                             open_days_since=5, accepted=True)
    assert review_card(collapsing, ctx).rule == "acted_on"


def test_a_row_carrying_accepted_reaches_the_history() -> None:
    """a2ae0b8 dropped the plumbing for `accepted`/`dismissed` from PriorCard
    and assemble while Node kept sending both, so the selector was back to
    reading every owner decision as "not acted". The existing test only covered
    the default; this one covers a row that carries the field."""
    days = [date(2026, 10, d) for d in range(1, 8)]
    rows = [{"sku": "A", "first_issued": "2026-10-01", "times_shown": 4,
             "baseline_rate": 1.0, "accepted": True, "dismissed": False,
             "last_action_on": "2026-10-03"},
            {"sku": "B", "first_issued": "2026-10-01", "times_shown": 4,
             "baseline_rate": 1.0, "accepted": False, "dismissed": True}]
    histories, skipped = from_rows(rows, daily_by_sku={}, trading_days=days,
                                   as_of=date(2026, 10, 7))
    assert skipped == {}
    by = {h.sku: h for h in histories}
    assert by["A"].accepted is True and by["A"].dismissed is False
    assert by["B"].accepted is False and by["B"].dismissed is True
    card = PriorCard.from_row(rows[0])
    assert card is not None and card.last_action_on == date(2026, 10, 3)
    # A string "true" is not acceptance. `is True`, not truthiness.
    assert PriorCard.from_row({**rows[0], "accepted": "true"}).accepted is False


def test_a_stored_retirement_is_carried_through() -> None:
    """Migration 034: Node hands back the latest stored retirement per SKU,
    and the route honours it instead of re-deciding. All three fields travel;
    a feed that predates the column yields None for each."""
    days = [date(2026, 10, d) for d in range(1, 8)]
    rows = [{"sku": "A", "first_issued": "2026-09-20", "times_shown": 9,
             "baseline_rate": 1.0, "retired_at": "2026-09-28",
             "suppressed_until": "2026-10-12", "retirement_rule": "declining"}]
    (h,), _ = from_rows(rows, daily_by_sku={}, trading_days=days,
                        as_of=date(2026, 10, 7))
    assert h.retired_at == date(2026, 9, 28)
    assert h.suppressed_until == date(2026, 10, 12)
    assert h.retirement_rule == "declining"
    assert h.already_retired is True
    (old,), _ = from_rows([row()], daily_by_sku={}, trading_days=TRADING,
                          as_of=AS_OF)
    assert old.retired_at is None and old.suppressed_until is None
    assert old.retirement_rule is None and old.already_retired is False
    # A malformed stored date is absence, never a crash in an optional feed.
    bad = PriorCard.from_row({**rows[0], "retired_at": "soon"})
    assert bad is not None and bad.retired_at is None


def test_dispersion_comes_from_the_caller_as_of_issue() -> None:
    """The declining rule needs the SKU's own scatter, measured by the selector's
    weekly bucketing and anchored at first_issued. The callback is called with
    exactly that, and None from it leaves the cv UNMEASURED rather than zero."""
    calls: list[tuple[str, date]] = []

    def dispersion_of(sku: str, as_of: date) -> float | None:
        calls.append((sku, as_of))
        return 0.7 if sku == "SKU1" else None

    rows = [row(sku="SKU1"), row(sku="SKU2", first="2026-10-01")]
    out, _ = from_rows(rows, daily_by_sku=daily(), trading_days=TRADING,
                       as_of=AS_OF, dispersion_of=dispersion_of)
    by = {h.sku: h for h in out}
    assert by["SKU1"].dispersion_cv == pytest.approx(0.7)
    assert by["SKU2"].dispersion_cv is None
    assert calls == [("SKU1", date(2026, 9, 29)), ("SKU2", date(2026, 10, 1))]
    # No callback at all: unmeasured, exactly like a feed before this existed.
    out, _ = from_rows(rows, daily_by_sku=daily(), trading_days=TRADING,
                       as_of=AS_OF)
    assert all(h.dispersion_cv is None for h in out)


def test_a_feed_without_the_fields_behaves_exactly_as_before() -> None:
    """Every caller that predates these columns keeps its behaviour: not knowing
    whether the owner acted must never be read as knowing that they did.
    """
    from datetime import date as _date

    from app.pipeline.candidates.card_history import from_rows

    days = [_date(2026, 10, d) for d in range(1, 8)]
    rows = [{"sku": "A", "first_issued": "2026-10-01", "times_shown": 4,
             "baseline_rate": 1.0}]
    histories, _ = from_rows(rows, daily_by_sku={"A": {}}, trading_days=days,
                             as_of=_date(2026, 10, 7))
    assert histories[0].accepted is False
    assert histories[0].dismissed is False
