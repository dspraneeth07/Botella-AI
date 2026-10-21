"""Shrinkage & staff-integrity data.

Three pulls:
  * cashier scorecard — sales, voids, discounts, refunds per cashier (the `sales`
    table carries `cashier`), to spot outliers worth a look.
  * hour-of-day heatmap — when revenue actually happens (staffing/promo timing).
  * book-vs-physical shrinkage — per SKU, received (purchases) − sold − on-hand =
    units unaccounted for. HONEST CAVEAT: there's no opening-count, so this only
    flags SKUs whose receipts far exceed sales+stock; we surface it as 'review'.
"""
from __future__ import annotations

from datetime import timedelta

from .connector import SourceDB
from .inventory_repo import _as_of


def fetch_shrinkage_data(db: SourceDB, client_id: int, window_days: int = 365,
                         top_n: int = 12) -> dict:
    as_of = _as_of(db, client_id)
    if as_of is None:
        return {"as_of": None}
    p = {"cid": client_id, "since": as_of - timedelta(days=window_days),
         "d90": as_of - timedelta(days=90), "topn": top_n}

    cashiers = db.fetch_all(
        """
        SELECT cashier,
               count(*)                                                    AS sales,
               -- Receipt-subtotal basis (pre-tax net) - the per-cashier
               -- revenue convention every Node surface uses (chat rule 7);
               -- total_amount is blank on about one receipt in twenty and
               -- tax-inclusive besides. NO PER-CENT SIGN IN THIS COMMENT:
               -- psycopg scans the whole query for placeholders and does not
               -- understand SQL comments, so the one that used to sit in this
               -- sentence raised ProgrammingError every time this ran. Double
               -- the sign if a literal is ever needed.
               COALESCE(sum(sub_total), 0)                                 AS revenue,
               count(*) FILTER (WHERE upper(sale_status) = 'VOID')         AS voids,
               COALESCE(sum(sub_total) FILTER (WHERE upper(sale_status) = 'VOID'), 0) AS void_amount,
               COALESCE(sum(discount), 0)                                  AS discount,
               COALESCE(sum(COALESCE(refunded_amount, 0)), 0)              AS refunded
        FROM sales
        WHERE client_id = %(cid)s AND sale_date >= %(since)s
          AND cashier IS NOT NULL AND cashier <> ''
        GROUP BY cashier
        ORDER BY count(*) DESC
        """, p)

    shrink = db.fetch_all(
        """
        WITH sold_by_key AS (
            SELECT si.sku, sum(si.quantity) AS sold FROM sale_items si
            WHERE si.client_id = %(cid)s AND si.quantity > 0
              -- Anti-join, not `NOT (sale_id = ANY(array))`: this pull is
              -- deliberately un-windowed (lifetime receipts vs lifetime sales),
              -- so the array form rescanned every void id for every row of the
              -- client's entire sale_items history — the 120s statement timeout
              -- that took lossprev out. NOT EXISTS lets the planner hash-anti-join
              -- instead, and drops the round trip that shipped the ids here.
              AND NOT EXISTS (
                  SELECT 1 FROM sales v
                  WHERE v.client_id = %(cid)s
                    AND v.sale_id = si.sale_id
                    AND v.sale_status = 'VOID'
              )
            GROUP BY si.sku
        )
        SELECT p.sku, max(p.product_name) AS product_name, max(p.category) AS category,
               max(p.stock_qty) AS on_hand, max(p.cost) AS cost,
               COALESCE(max(rc.recv), 0) AS received,
               COALESCE(max(ss.sold), 0) + COALESCE(max(su.sold), 0) AS sold
        FROM products p
        LEFT JOIN (SELECT sku, sum(quantity) AS recv FROM purchases
                   WHERE client_id = %(cid)s GROUP BY sku) rc ON rc.sku = p.sku
        -- Sales ring under EITHER product key (internal sku or barcode); the
        -- barcode join is suppressed when the two keys are the same string.
        LEFT JOIN sold_by_key ss ON ss.sku = p.sku
        LEFT JOIN sold_by_key su ON su.sku = p.upc AND p.upc IS DISTINCT FROM p.sku
        WHERE p.client_id = %(cid)s AND COALESCE(p.is_deleted, false) = false
          AND p.cost > 0
        GROUP BY p.sku
        HAVING COALESCE(max(rc.recv), 0) > 0
        """, p)

    return {
        "as_of": as_of.isoformat(),
        "window_days": window_days,
        "cashiers": cashiers,
        "shrink_rows": shrink,
        "top_n": top_n,
    }
