"""Shrinkage repo: the void anti-join on the one pull that cannot be windowed.

``sold_by_key`` compares lifetime receipts against lifetime sales, so unlike
every other warehouse pull it has no ``sale_date`` bound by design. That made it
the worst place to filter with ``NOT (sale_id = ANY(<array>))``: the array was
rescanned for every row of the client's entire sale_items history. It is the
prime suspect for the 120s statement timeout that took `lossprev` down.

Note the fix here is the anti-join ONLY. Date-bounding the void list — which is
safe for loss_repo, whose every query is windowed — would be a correctness bug
here: a sale voided before the window would silently count as real revenue.
"""
from __future__ import annotations

from datetime import date

from storeagent.source.shrinkage_repo import fetch_shrinkage_data


class FakeDB:
    def __init__(self) -> None:
        self.sql: list[str] = []

    def fetch_one(self, sql: str, params=None):
        self.sql.append(sql)
        return {"d": date(2026, 8, 6)}

    def fetch_all(self, sql: str, params=None):
        self.sql.append(sql)
        return []


def _run() -> FakeDB:
    db = FakeDB()
    fetch_shrinkage_data(db, 171)
    return db


def test_no_void_id_array() -> None:
    joined = "\n".join(_run().sql)
    assert "ANY(%(void)s" not in joined
    assert "::text[]" not in joined


def test_sold_by_key_uses_an_anti_join() -> None:
    sold = next(s for s in _run().sql if "sold_by_key" in s)
    assert "NOT EXISTS" in sold
    assert "v.sale_id = si.sale_id" in sold
    assert "v.sale_status = 'VOID'" in sold


def test_void_id_round_trip_is_gone() -> None:
    """The helper fetched every VOID id for the client on a separate trip."""
    db = _run()
    assert not any("SELECT sale_id" in s for s in db.sql)
    assert len(db.sql) == 3  # as_of + cashiers + shrink


def test_sold_by_key_stays_unwindowed() -> None:
    """Lifetime receipts vs lifetime sales — adding a date bound here would
    break the book-vs-physical math, so guard against a well-meaning 'fix'."""
    sold = next(s for s in _run().sql if "sold_by_key" in s)
    body = sold.split("sold_by_key AS (")[1].split(")")[0]
    assert "%(since)s" not in body


def test_cashier_scorecard_still_windowed() -> None:
    cashiers = next(s for s in _run().sql if "cashier" in s and "GROUP BY cashier" in s)
    assert "%(since)s" in cashiers


def test_no_sales_short_circuits() -> None:
    db = FakeDB()
    db.fetch_one = lambda sql, params=None: {"d": None}  # type: ignore[method-assign]
    assert fetch_shrinkage_data(db, 171) == {"as_of": None}
