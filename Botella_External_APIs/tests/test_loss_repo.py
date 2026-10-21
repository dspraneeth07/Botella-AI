"""Loss-prevention repo: the void anti-join rewrite and the merged scans.

Background — the `lossprev` capability was dying on the warehouse's 120s
statement timeout. Two causes, both fixed here and both asserted below:

  * every void-exclusion filtered with ``NOT (sale_id = ANY(<array>))``, which
    Postgres evaluates by rescanning the whole array per row, and the array was
    every VOID sale_id the client had ever produced (no date bound, no limit);
  * the four heaviest queries each rebuilt the ``products_join`` catalog union,
    which has to be materialized and sorted in full.

The warehouse is not reachable from CI, so these tests pin the two things that
CAN be checked without it: the SQL no longer contains the pathological shapes,
and the totals/top-N now computed in Python are arithmetically identical to
what the dropped aggregate queries returned.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from storeagent.source import loss_repo
from storeagent.source.loss_repo import _top, _totals, fetch_loss_data


class FakeDB:
    """Records every statement and replays canned rows, matched on SQL shape."""

    def __init__(self, free: list[dict] | None = None, below: list[dict] | None = None) -> None:
        self.sql: list[str] = []
        self._free = free or []
        self._below = below or []

    def fetch_one(self, sql: str, params=None):
        self.sql.append(sql)
        if "max(sale_date)" in sql:
            return {"d": date(2026, 8, 6)}
        return {"sales": 0, "lines": 0, "amount": 0, "recent_sales": 0, "recent_amount": 0}

    def fetch_all(self, sql: str, params=None):
        self.sql.append(sql)
        if "would_be_value" in sql:
            return self._free
        if "AS loss" in sql:
            return self._below
        return []


def _run(**kw) -> tuple[dict, FakeDB]:
    db = FakeDB(**kw)
    return fetch_loss_data(db, 171), db


# ---- the shapes that caused the timeout are gone ---------------------------

def test_no_void_id_array_anywhere() -> None:
    """The O(rows x voids) per-row array rescan must not come back."""
    _, db = _run()
    joined = "\n".join(db.sql)
    assert "ANY(%(void)s" not in joined
    assert "::text[]" not in joined
    # ...and the round trip that built that array is gone too.
    assert not any("sale_status='VOID'" in s and "SELECT sale_id" in s for s in db.sql)


def test_void_exclusion_is_an_anti_join() -> None:
    _, db = _run()
    joined = "\n".join(db.sql)
    assert "NOT EXISTS" in joined
    assert "v.sale_id = si.sale_id" in joined
    # Exact-case 'VOID', matching what _void_sale_ids selected before.
    assert "v.sale_status = 'VOID'" in joined


def test_products_join_materialized_twice_not_four_times() -> None:
    """Each products_join query re-sorts the whole catalog union; halving the
    count is the point of merging the row/total pairs."""
    _, db = _run()
    assert sum("DISTINCT ON (jk)" in s for s in db.sql) == 2


def test_round_trips_dropped_from_eight_to_five() -> None:
    """as_of + voids + 2 merged scans + returns. The three that went away: the
    void-id fetch and the two standalone totals queries."""
    _, db = _run()
    assert len(db.sql) == 5


# ---- the Python-side aggregation matches the SQL it replaced --------------

FREE = [
    {"sku": "A", "product_name": "Rum", "category": "spirits", "lines": 3,
     "units": 4, "price": Decimal("9.99"), "would_be_value": Decimal("39.96"),
     "recent_lines": 1},
    {"sku": "B", "product_name": "Gin", "category": "spirits", "lines": 2,
     "units": 2, "price": Decimal("21.50"), "would_be_value": Decimal("43.00"),
     "recent_lines": 2},
    {"sku": "C", "product_name": "Ale", "category": "beer", "lines": 5,
     "units": 9, "price": Decimal("3.00"), "would_be_value": Decimal("27.00"),
     "recent_lines": 0},
]


def test_totals_equal_the_dropped_aggregate_query() -> None:
    """count(*) and sum() over the ungrouped set == summing the per-sku groups."""
    data, _ = _run(free=FREE)
    tot = data["free_total"]
    assert tot["lines"] == 10  # 3 + 2 + 5
    assert tot["units"] == 15  # 4 + 2 + 9
    assert tot["would_be_value"] == Decimal("109.96")
    assert tot["recent_lines"] == 3  # the FILTER (WHERE sale_date >= d90) count


def test_top_n_orders_by_value_desc_and_limits() -> None:
    data, _ = _run(free=FREE)
    assert [r["sku"] for r in data["free_items"]] == ["B", "A", "C"]

    db = FakeDB(free=FREE)
    assert [r["sku"] for r in fetch_loss_data(db, 171, top_n=2)["free_items"]] == ["B", "A"]


def test_totals_span_every_group_not_just_the_top_n() -> None:
    """The old totals query had no LIMIT; truncating before summing would
    silently under-report exposure."""
    db = FakeDB(free=FREE)
    data = fetch_loss_data(db, 171, top_n=1)
    assert len(data["free_items"]) == 1
    assert data["free_total"]["lines"] == 10  # all three groups still counted


def test_empty_result_gives_zeros_like_coalesce() -> None:
    data, _ = _run()
    assert data["free_total"] == {"lines": 0, "units": 0, "would_be_value": 0,
                                  "recent_lines": 0}
    assert data["below_total"] == {"lines": 0, "loss": 0}
    assert data["free_items"] == []


def test_null_aggregate_reads_as_zero() -> None:
    """A NULL sum() stood in for COALESCE(..., 0); it must not become None."""
    rows = [{"lines": 2, "loss": None}, {"lines": 1, "loss": Decimal("5")}]
    assert _totals(rows, ("lines", "loss")) == {"lines": 3, "loss": Decimal("5")}
    assert [r["lines"] for r in _top(rows, "loss", 2)] == [1, 2]


def test_below_cost_totals_and_ordering() -> None:
    below = [
        {"sku": "X", "lines": 1, "units": 1, "loss": Decimal("2.00")},
        {"sku": "Y", "lines": 4, "units": 6, "loss": Decimal("11.25")},
    ]
    data, _ = _run(below=below)
    assert data["below_total"] == {"lines": 5, "loss": Decimal("13.25")}
    assert [r["sku"] for r in data["below_items"]] == ["Y", "X"]


def test_no_sales_short_circuits_before_any_scan() -> None:
    db = FakeDB()
    db.fetch_one = lambda sql, params=None: {"d": None}  # type: ignore[method-assign]
    assert fetch_loss_data(db, 171) == {"as_of": None}


def test_void_totals_need_no_short_circuit() -> None:
    """The old code skipped the voids query when the id list was empty; the
    EXISTS form returns the same zeros without that special case."""
    data, _ = _run()
    assert data["voids"]["sales"] == 0
    assert data["voids"]["amount"] == 0


def test_module_constants_compose_the_same_predicate() -> None:
    assert loss_repo.NOT_VOIDED.startswith("AND NOT EXISTS")
    assert loss_repo.IS_VOIDED.startswith("AND EXISTS")
    assert "v.client_id = %(cid)s" in loss_repo.NOT_VOIDED
