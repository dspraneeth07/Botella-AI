"""A markdown is never judged on a recovery it did not predict.

Measured at Bethany, 20 October 2026: two overstock SKUs holding $1,150 and
$774 of capital, each issued as a markdown, each retired under `no_recovery`
("the recovery this card predicted has not started"), each then suppressed for
seventeen days - and a slate of ten reorders with no markdown. `review_card`
never looked at what kind of card it was judging: the two recovery rules ask
whether the product is selling again at the rate that justified the card, and a
markdown's whole premise is that it is not.
"""
from __future__ import annotations

from datetime import date, timedelta

from app.pipeline.candidates.card_history import from_rows
from app.pipeline.candidates.lifecycle import (
    CARD_MAX_OPEN_DAYS,
    CARD_REVIEW_OPEN_DAYS,
    DISCOUNT_ACTIONS,
    MIN_OPEN_DAYS_TO_JUDGE,
    RECOVERY_RULES,
    CardHistory,
    review_card,
)
from app.pipeline.context import RunContext

AS_OF = date(2026, 10, 6)
TRADING = [AS_OF - timedelta(days=n) for n in range(40, -1, -1)
           if (AS_OF - timedelta(days=n)).weekday() != 6]

REVIEW = int(CARD_REVIEW_OPEN_DAYS.default)
MAX = int(CARD_MAX_OPEN_DAYS.default)
MIN_JUDGE = int(MIN_OPEN_DAYS_TO_JUDGE.default)
#: Past both the judging floor and the review window, short of stale.
JUDGED = max(REVIEW, MIN_JUDGE + 1)


def _ctx() -> RunContext:
    return RunContext(run_id="r", tenant_id=1, store_id=171, as_of=AS_OF,
                      snapshot_id="s", config_version="default", seed=0,
                      versions={})


def _flat(kind: str | None, *, seen: int) -> CardHistory:
    """A product that has NOT recovered: zero sales since the card, well past the
    review window. For a reorder that is the claim failing; for a markdown it is
    the premise holding. Same product either way - only the claim differs."""
    return CardHistory(sku="X", first_issued=AS_OF - timedelta(days=seen + 2),
                       baseline_rate=10.0, units_since=0.0,
                       open_days_since=seen, action_type=kind)


def test_the_constants_say_what_the_fix_relies_on() -> None:
    assert RECOVERY_RULES == frozenset({"declining", "no_recovery"})
    assert {"markdown", "liquidate"} <= DISCOUNT_ACTIONS
    assert JUDGED < MAX, "the fixtures below assume review precedes stale"


def test_a_reorder_that_did_not_recover_is_still_retired() -> None:
    """The control. Nothing changed for the cards the recovery rules were
    written for."""
    v = review_card(_flat("reorder", seen=JUDGED), _ctx())
    assert v.retire is True
    assert v.rule in RECOVERY_RULES


def test_an_unknown_kind_keeps_the_rules_it_always_had() -> None:
    """None is an absence - not "markdown" and not "reorder". Rows from before
    Node sent `action_type` change nothing, in either direction."""
    v = review_card(_flat(None, seen=JUDGED), _ctx())
    assert v.retire is True
    assert v.rule in RECOVERY_RULES


def test_a_markdown_is_not_retired_for_a_recovery_it_never_predicted() -> None:
    """THE FIX. Identical history to the two tests above; the only difference is
    what the card claimed."""
    v = review_card(_flat("markdown", seen=JUDGED), _ctx())
    assert v.retire is False, v.reason
    assert v.rule is None


def test_a_markdown_still_goes_stale() -> None:
    """Not immortal. Once it has been up for the maximum, the case for clearing
    the stock is re-made on current evidence, like every other kind."""
    v = review_card(_flat("markdown", seen=MAX), _ctx())
    assert v.retire is True
    assert v.rule == "stale"
    assert "markdown" in v.reason


def test_the_owner_still_outranks_the_markdown_guard() -> None:
    """Acting or dismissing is about the card, not the product, and comes first
    for every kind - the guard sits after both."""
    done = CardHistory(sku="X", first_issued=AS_OF - timedelta(days=3),
                       baseline_rate=10.0, units_since=0.0, open_days_since=2,
                       action_type="markdown", accepted=True)
    assert review_card(done, _ctx()).rule == "acted_on"
    gone = CardHistory(sku="X", first_issued=AS_OF - timedelta(days=3),
                       baseline_rate=10.0, units_since=0.0, open_days_since=2,
                       action_type="markdown", dismissed=True)
    assert review_card(gone, _ctx()).rule == "dismissed"


# ── The kind of card travels from Node's row into the history ───────────────


def _row(**over) -> dict:
    base = {"sku": "SKU1", "first_issued": "2026-09-29", "times_shown": 3,
            "baseline_rate": 0.68}
    base.update(over)
    return base


def _daily() -> dict:
    return {"SKU1": {d: 0.5 for d in TRADING}}


def test_from_rows_carries_the_kind_of_card() -> None:
    out, _ = from_rows([_row(action_type="markdown")], daily_by_sku=_daily(),
                       trading_days=TRADING, as_of=AS_OF)
    assert out[0].action_type == "markdown"


def test_from_rows_reads_an_absent_kind_as_none_never_as_reorder() -> None:
    out, _ = from_rows([_row()], daily_by_sku=_daily(),
                       trading_days=TRADING, as_of=AS_OF)
    assert out[0].action_type is None
    blank, _ = from_rows([_row(action_type="")], daily_by_sku=_daily(),
                         trading_days=TRADING, as_of=AS_OF)
    assert blank[0].action_type is None
