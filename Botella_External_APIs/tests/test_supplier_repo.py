"""Supplier cadence reads the purchase DAY, not the `date` column.

WHAT THIS PINS. At every LiquorPOS store (173 Tuscany first among them)
`purchases.date` is the -infinity sentinel on every row and `invoice_date`
holds the real day - the SyncGo extraction aliases ORD_IN.DATE as
`PurchaseDate`, a name the uploader does not bind, so `date` gets the
uploader's default and `invoice_date` gets the value (storeagent/source/
purchase_day.py). Against that feed, `date IS NOT NULL` kept every row and
`date::date - lag(date::date)` produced no gap, so Tuscany had no reorder
cycle for any SKU, and `max(date)` handed psycopg a value it cannot load.

The repo must ask for COALESCE(NULLIF(date, '-infinity'), NULLIF(invoice_date,
'-infinity')) everywhere it filters, orders or aggregates on the day, and keep
only rows at or after the 1990 floor. A bare `date` in any of those places is
the regression this file exists to catch; the SQL is captured through a fake
connector, the way test_shrinkage_repo.py does it.

The mapping from rows to the per-SKU dict is pinned too: a NULL median cycle
stays None (never 0), a .5 median rounds half-to-even as the SQL-check mirror
documents, and the last-bought day attaches to SKUs with and without a cycle.
"""
from __future__ import annotations

import re
from datetime import date

from storeagent.source import inventory_repo, market_repo
from storeagent.source.purchase_day import purchase_day, purchase_day_sane
from storeagent.source.supplier_repo import fetch_sku_supplier_cycles

DAY = "COALESCE(NULLIF(date, '-infinity'), NULLIF(invoice_date, '-infinity'))"


class FakeDB:
    """Captures SQL; answers the cycle query and the last-bought query with
    fixed rows so the row->dict mapping can be checked without a warehouse."""

    def __init__(self) -> None:
        self.sql: list[str] = []
        self.params: list[dict] = []

    def fetch_all(self, sql: str, params=None):
        self.sql.append(sql)
        self.params.append(params or {})
        if "sup_cycle" in sql:
            return [
                {"sku": "A", "supplier_id": "390", "supplier_name": "Southern",
                 "median_cycle": 14.0},
                {"sku": "B", "supplier_id": "391", "supplier_name": "RNDC",
                 "median_cycle": None},
                {"sku": "C", "supplier_id": "392", "supplier_name": "Breakthru",
                 "median_cycle": 20.5},
            ]
        if "last_bought" in sql:
            return [
                {"sku": "A", "last_bought": date(2026, 10, 17)},
                {"sku": "Z", "last_bought": date(2026, 9, 1)},
            ]
        return []


def _bare_date_reads(sql: str) -> list[str]:
    """Every place the SQL reads the `date` column outside the fallback
    expression: `date::date`, `date IS NOT NULL`, `max(date)`, `ORDER BY
    date`, `date >=`. The fallback itself is removed first so what remains
    is exactly the regression."""
    stripped = sql.replace(DAY, "<DAY>")
    # The lookbehind excludes `::date` casts of the fallback and of bind
    # parameters, which are not reads of the column.
    return re.findall(r"(?<![\w.:])date(?:::date| IS NOT NULL| DESC| >=|\))", stripped)


def test_purchase_day_fragment_shape() -> None:
    assert purchase_day() == DAY
    assert purchase_day("pu") == (
        "COALESCE(NULLIF(pu.date, '-infinity'), NULLIF(pu.invoice_date, '-infinity'))")
    assert purchase_day_sane() == f"{DAY} >= DATE '1990-01-01'"


def test_cycle_sql_reads_the_fallback_day_everywhere() -> None:
    db = FakeDB()
    fetch_sku_supplier_cycles(db, 173, 173)
    assert len(db.sql) == 2
    for sql in db.sql:
        assert DAY in sql
        assert f"{DAY} >= DATE '1990-01-01'" in sql
        assert "date IS NOT NULL" not in sql
        assert _bare_date_reads(sql) == [], _bare_date_reads(sql)


def test_cycle_sql_is_location_scoped_when_asked() -> None:
    db = FakeDB()
    fetch_sku_supplier_cycles(db, 173, 173)
    assert all("location_id = %(lid)s" in s for s in db.sql)
    assert all(p["lid"] == 173 for p in db.params)
    db2 = FakeDB()
    fetch_sku_supplier_cycles(db2, 173)
    assert all("location_id" not in s for s in db2.sql)


def test_row_mapping_keeps_nulls_and_rounds_half_even() -> None:
    out = fetch_sku_supplier_cycles(FakeDB(), 173, 173)
    assert out["A"]["reorder_cycle_days"] == 14
    assert out["A"]["supplier_name"] == "Southern"
    assert out["A"]["last_purchase_date"] == date(2026, 10, 17)
    # No median is None, never 0: a zero would read as "reorder every day".
    assert out["B"]["reorder_cycle_days"] is None
    assert out["B"]["last_purchase_date"] is None
    # Python's round() is half-to-even; sql_checks mirrors that on purpose.
    assert out["C"]["reorder_cycle_days"] == 20
    # A SKU bought but with no dominant-supplier row still gets its last day.
    assert out["Z"] == {"supplier_id": None, "supplier_name": None,
                        "reorder_cycle_days": None, "last_purchase_date": date(2026, 9, 1)}


def test_latest_purchase_cost_orders_by_the_fallback_day() -> None:
    """inventory_repo picks each SKU's latest cost; on bare `date` every
    LiquorPOS row tied at -infinity and the winner was arbitrary."""
    db = FakeDB()
    inventory_repo._purchase_costs(db, 173, 173)
    (sql,) = db.sql
    assert f"ORDER BY sku, {DAY} DESC NULLS LAST, id DESC" in sql
    assert _bare_date_reads(sql) == []


def test_market_window_bounds_the_fallback_day() -> None:
    """market_repo's 'what I bought' window must not drop the whole feed."""
    src = open(market_repo.__file__, encoding="utf-8").read()
    assert "pu.date >= %(since)s" not in src
    assert "{purchase_day_sane('pu')}" in src and "{purchase_day('pu')} >= %(since)s" in src
