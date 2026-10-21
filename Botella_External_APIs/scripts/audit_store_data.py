#!/usr/bin/env python
"""Data audit for ONE store: what tables hold its data, how much, and how good.

    python scripts/audit_store_data.py --store 173 --out run/audit_173.json

WHY A SCRIPT AND NOT A HANDFUL OF QUERIES
    The questions that decide whether a store can be modelled at all are not
    the ones a row count answers. A store can hold 37,000 sale lines and still
    be unmodellable because they span 101 days; it can hold a full product
    master and still have no cost on any of it, which turns every margin figure
    into an absence rather than a zero. So this reports three things per feed -
    VOLUME, SPAN and COVERAGE - and never collapses them into one score.

    ABSENCE IS NOT ZERO. Every coverage figure is stated as "n of m rows carry
    this", never as a value with a silent default. A null cost is a thing we do
    not know; a cost of 0.00 is a claim that the item was free. They are
    different facts and the audit keeps them apart.

READ-ONLY. SELECT only, against syncgo, which is how every capability reads.
This holds no analytics credentials and writes nothing anywhere.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import date
from decimal import Decimal
from typing import Any

from storeagent.source.connector import source_db

# Logical tables that carry a client_id, excluding the monthly partitions of
# sales/sale_items (counting a parent counts every partition once; counting
# both double-reports the same rows).
PARTITION = re.compile(r"_(y\d{4}m\d{2}|default)$")


def _jsonable(v: Any) -> Any:
    if isinstance(v, date):
        return v.isoformat()
    # Postgres numeric comes back as Decimal, which json refuses. float() is
    # right here because these are reported figures, not money being arithmetic
    # on - the rounding already happened in SQL.
    if isinstance(v, Decimal):
        return float(v)
    return v


def scoped_tables(db) -> list[str]:
    rows = db.fetch_all(
        """SELECT c.table_name
             FROM information_schema.columns c
             JOIN information_schema.tables t
               ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            WHERE c.table_schema = 'public' AND c.column_name = 'client_id'
              AND t.table_type = 'BASE TABLE'
            ORDER BY c.table_name""")
    return [r["table_name"] for r in rows
            if not PARTITION.search(r["table_name"])]


def date_column(db, table: str) -> str | None:
    """The column that best answers "when is this row from?"."""
    rows = db.fetch_all(
        """SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema='public' AND table_name = %s
              AND data_type IN ('date','timestamp without time zone',
                                'timestamp with time zone')
            ORDER BY ordinal_position""", (table,))
    cols = [r["column_name"] for r in rows]
    for preferred in ("sale_date", "date", "invoice_date", "order_date", "last_updated",
                      "created_at", "updated_at", "run_at", "started_at"):
        if preferred in cols:
            return preferred
    return cols[0] if cols else None


def census(db, store: int) -> list[dict]:
    out = []
    for table in scoped_tables(db):
        row = db.fetch_one(
            f"SELECT count(*)::bigint AS n FROM {table} WHERE client_id = %s",  # noqa: S608 - identifier from information_schema
            (store,))
        n = int(row["n"] or 0)
        entry: dict[str, Any] = {"table": table, "rows": n,
                                 "date_column": None, "first": None, "last": None,
                                 "distinct_days": None, "non_finite_dates": 0}
        if n:
            col = date_column(db, table)
            entry["date_column"] = col
            if col:
                # `isfinite()` is not defensive padding - this store holds
                # '-infinity' in a date column, which Postgres accepts and
                # psycopg then refuses to load ("date too small, before year
                # 1"). An infinite timestamp is a SENTINEL, not an observation:
                # left in, it makes min() claim the feed began before the year
                # 1 and silently widens every span computed from it. So they
                # are excluded from the range and COUNTED, because the count is
                # itself a finding.
                d = db.fetch_one(
                    f"SELECT min({col}) FILTER (WHERE isfinite({col}))::date AS first, "  # noqa: S608
                    f"       max({col}) FILTER (WHERE isfinite({col}))::date AS last, "
                    f"       count(DISTINCT {col}::date) FILTER (WHERE isfinite({col})) AS days, "
                    f"       count(*) FILTER (WHERE NOT isfinite({col})) AS bad "
                    f"FROM {table} WHERE client_id = %s", (store,))
                entry.update(first=_jsonable(d["first"]), last=_jsonable(d["last"]),
                             distinct_days=int(d["days"] or 0),
                             non_finite_dates=int(d["bad"] or 0))
        out.append(entry)
    return out


def sales_quality(db, store: int) -> dict:
    """The facts that decide whether the engine can model this store."""
    q: dict[str, Any] = {}
    q["receipts"] = dict(db.fetch_one(
        """SELECT count(*)::bigint AS rows,
                  count(DISTINCT sale_date::date) AS trading_days,
                  min(sale_date)::date AS first, max(sale_date)::date AS last,
                  count(*) FILTER (WHERE upper(COALESCE(sale_status,'')) = 'VOID') AS voids,
                  count(*) FILTER (WHERE sub_total IS NULL) AS null_subtotal,
                  count(*) FILTER (WHERE COALESCE(customer_id,'') <> '') AS with_customer
             FROM sales WHERE client_id = %s""", (store,)))
    q["lines"] = dict(db.fetch_one(
        """SELECT count(*)::bigint AS rows,
                  count(DISTINCT sku) AS distinct_skus,
                  count(*) FILTER (WHERE item_status = 'Sold') AS sold,
                  count(*) FILTER (WHERE quantity IS NULL) AS null_qty,
                  count(*) FILTER (WHERE quantity <= 0) AS nonpositive_qty,
                  count(*) FILTER (WHERE price IS NOT NULL AND price > 0) AS with_price,
                  count(*) FILTER (WHERE cost IS NOT NULL AND cost > 0) AS with_cost,
                  count(*) FILTER (WHERE COALESCE(sku,'') = '') AS blank_sku
             FROM sale_items WHERE client_id = %s""", (store,)))
    q["products"] = dict(db.fetch_one(
        """SELECT count(*)::bigint AS rows,
                  count(*) FILTER (WHERE COALESCE(product_name,'') <> '') AS named,
                  count(*) FILTER (WHERE cost IS NOT NULL AND cost > 0) AS with_cost,
                  count(*) FILTER (WHERE stock_qty IS NOT NULL) AS with_stock,
                  count(*) FILTER (WHERE COALESCE(category,'') <> '') AS with_category,
                  max(last_updated)::date AS newest
             FROM products WHERE client_id = %s""", (store,)))
    q["customers"] = dict(db.fetch_one(
        """SELECT count(*)::bigint AS rows,
                  count(*) FILTER (WHERE COALESCE(contact_phone,'') <> ''
                                    OR COALESCE(contact_email,'') <> '') AS contactable,
                  count(*) FILTER (WHERE COALESCE(is_deleted,false)) AS deleted
             FROM customers WHERE client_id = %s""", (store,)))
    # `purchases.date`, not `purchase_date`: the receiving feed names it `date`
    # and carries `invoice_date` beside it. Getting this wrong reads as "no
    # purchase history", which is the same shape as a store that truly has none.
    # isfinite() again, and this is the table that needed it: Tuscany's
    # receiving feed carries '-infinity' in `date`. A purchase dated before the
    # year 1 is not an early delivery, it is a missing date written as a
    # sentinel, and it has to be counted rather than averaged into a span.
    q["purchases"] = dict(db.fetch_one(
        """SELECT count(*)::bigint AS rows,
                  count(DISTINCT supplier_id) AS suppliers,
                  count(DISTINCT sku) AS skus,
                  min(date) FILTER (WHERE isfinite(date))::date AS first,
                  max(date) FILTER (WHERE isfinite(date))::date AS last,
                  count(*) FILTER (WHERE NOT isfinite(date)) AS non_finite_dates,
                  count(*) FILTER (WHERE cost IS NOT NULL AND cost > 0) AS with_cost
             FROM purchases WHERE client_id = %s""", (store,)))
    for block in q.values():
        for k, v in list(block.items()):
            block[k] = _jsonable(v)
    return q


def sku_depth(db, store: int) -> dict:
    """How many SKUs have enough observations to forecast at all.

    The engine's demand estimate needs repeated observations of the SAME sku.
    A store can carry thousands of SKUs and still be able to forecast very few,
    which is the figure that actually bounds a backtest.
    """
    rows = db.fetch_all(
        """SELECT days_sold, count(*)::bigint AS skus FROM (
               SELECT sku, count(DISTINCT sale_date::date) AS days_sold
                 FROM sale_items
                WHERE client_id = %s AND item_status = 'Sold'
                  AND COALESCE(sku,'') <> '' AND quantity > 0
                GROUP BY sku) t
            GROUP BY days_sold ORDER BY days_sold""", (store,))
    hist = {int(r["days_sold"]): int(r["skus"]) for r in rows}
    total = sum(hist.values())
    def at_least(n: int) -> int:
        return sum(v for k, v in hist.items() if k >= n)
    return {"distinct_skus": total,
            "sold_on_1_day_only": hist.get(1, 0),
            "at_least_2_days": at_least(2),
            "at_least_5_days": at_least(5),
            "at_least_10_days": at_least(10),
            "at_least_20_days": at_least(20),
            "at_least_30_days": at_least(30)}


def monthly(db, store: int) -> list[dict]:
    rows = db.fetch_all(
        """SELECT to_char(sale_date, 'YYYY-MM') AS month,
                  count(DISTINCT sale_date::date) AS trading_days,
                  count(*)::bigint AS receipts,
                  round(COALESCE(sum(sub_total), 0)::numeric, 2) AS revenue
             FROM sales
            WHERE client_id = %s AND upper(COALESCE(sale_status,'')) <> 'VOID'
            GROUP BY 1 ORDER BY 1""", (store,))
    return [{k: _jsonable(v) for k, v in dict(r).items()} for r in rows]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--store", type=int, required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    with source_db("180s") as db:
        who = db.fetch_one(
            "SELECT username, location_id FROM users WHERE client_id = %s LIMIT 1",
            (args.store,))
        report = {
            "store_id": args.store,
            "username": who["username"] if who else None,
            "location_id": who["location_id"] if who else None,
            "generated_at": date.today().isoformat(),
            "census": census(db, args.store),
            "quality": sales_quality(db, args.store),
            "sku_depth": sku_depth(db, args.store),
            "monthly": monthly(db, args.store),
        }

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(f"wrote {args.out}")

    present = [c for c in report["census"] if c["rows"]]
    print(f"\n{report['username']} (client {args.store})")
    print(f"  {len(present)} of {len(report['census'])} client-scoped tables hold data")
    for c in sorted(present, key=lambda r: -r["rows"]):
        # "no finite dates" is NOT "no date column": purchases has a Thu Oct 15 12:21:32 IST 2026
        # column whose every row is '-infinity', and calling that a missing
        # column would point the reader at the schema instead of the feed.
        if c["first"]:
            span = f"{c['first']} .. {c['last']}"
        elif c["date_column"]:
            span = f"{c['date_column']} present, no finite dates"
        else:
            span = "no date column"
        print(f"    {c['table']:<26} {c['rows']:>10,}  {span}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
