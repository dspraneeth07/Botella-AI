"""Data pulls for the Loss & Theft Radar (doubtful sales / shrinkage signals).

Surfaces transaction-integrity red flags a POS rarely highlights:
  * voids/refunds (reversed sales),
  * near-zero-price rings (items sold for ~$0 despite a real shelf price — the
    classic sweethearting / register-theft pattern),
  * below-cost sales (sold under what it cost), and
  * returns/refunds (lines that ring up NEGATIVE money — in this warehouse refunds
    are encoded as a negative total_amount on a POSITIVE quantity, not as a
    negative quantity, so we detect them on the dollar side).
All pulls are read-only, partition-pruned by date, and use the per-store product
key (sku vs upc) so they work across POS systems.
"""
from __future__ import annotations

from datetime import timedelta

from .connector import SourceDB
from .inventory_repo import _as_of
from .sku_key import products_join

# A line is "near-zero" if it rang up at/under this $ despite a real price.
NEAR_ZERO_MAX = 0.01
MIN_REAL_PRICE = 1.00

# Exclude (or select) lines belonging to a VOIDed sale. Previously this shipped
# every VOID sale_id for the client to Python and filtered with
# `NOT (si.sale_id = ANY(array))`, which Postgres evaluates by rescanning the
# whole array per row — O(sale_items x voids), no index usable, and the array
# grew forever because it was never date-bounded. An anti-join lets the planner
# hash it instead, and removes the round trip that fetched the ids.
# `sale_status = 'VOID'` (exact case) matches what _void_sale_ids selected; the
# cashier scorecard in shrinkage_repo uses upper() instead, which is a
# pre-existing inconsistency this change deliberately does not paper over.
_VOID_SALE = """SELECT 1 FROM sales v
                 WHERE v.client_id = %(cid)s
                   AND v.sale_id = si.sale_id
                   AND v.sale_status = 'VOID'"""
# A line with a NULL sale_id can't belong to a void sale, and NOT EXISTS keeps
# it for free — matching the old `si.sale_id IS NULL OR ...` disjunction.
NOT_VOIDED = f"AND NOT EXISTS ({_VOID_SALE})"
IS_VOIDED = f"AND EXISTS ({_VOID_SALE})"


def _num(v):
    """NULL/absent reads as 0, mirroring the COALESCE(..., 0) it replaces."""
    return 0 if v is None else v


def _totals(rows: list[dict], cols: tuple[str, ...]) -> dict:
    """Re-derive a whole-window total from its per-sku groups.

    Exact, not approximate: summing `count(*)` per group gives the same count
    over the ungrouped set, and likewise for sum(). Empty input yields 0 per
    column, which is what COALESCE(sum(...), 0) and count(*) returned.
    """
    return {c: sum(_num(r.get(c)) for r in rows) for c in cols}


def _top(rows: list[dict], key: str, n: int) -> list[dict]:
    """The old `ORDER BY <key> DESC LIMIT n`, applied to the same groups."""
    return sorted(rows, key=lambda r: _num(r.get(key)), reverse=True)[:n]


def fetch_loss_data(db: SourceDB, client_id: int, window_days: int = 365,
                    top_n: int = 50) -> dict:
    as_of = _as_of(db, client_id)
    if as_of is None:
        return {"as_of": None}
    p = {
        "cid": client_id,
        "since": as_of - timedelta(days=window_days),
        "d90": as_of - timedelta(days=90),
        "nz": NEAR_ZERO_MAX,
        "minp": MIN_REAL_PRICE,
    }

    # No void ids means this returns zeros on its own, so the old
    # short-circuit is gone along with the round trip that fed it.
    voids = db.fetch_one(
        f"""
        SELECT count(DISTINCT si.sale_id)                                    AS sales,
               count(*)                                                      AS lines,
               COALESCE(sum(si.total_amount), 0)                             AS amount,
               count(DISTINCT si.sale_id) FILTER (WHERE si.sale_date >= %(d90)s) AS recent_sales,
               COALESCE(sum(si.total_amount) FILTER (WHERE si.sale_date >= %(d90)s), 0) AS recent_amount
        FROM sale_items si
        WHERE si.client_id = %(cid)s
          AND si.sale_date >= %(since)s
          {IS_VOIDED}
        """, p)

    # One scan, not two. The per-sku grouping is a strict refinement of the
    # old totals query, so the totals are recovered by summing the groups here
    # (see _totals) and the top-N by slicing them. That matters because each of
    # these queries had to materialize and sort the whole products_join catalog
    # union; halving the count halves that work. No LIMIT in SQL any more —
    # the totals need every group, and the row count is bounded by the catalog.
    free_by_sku = db.fetch_all(
        f"""
        SELECT p.sku                          AS sku,
               max(p.product_name)            AS product_name,
               max(p.category)                AS category,
               count(*)                       AS lines,
               sum(si.quantity)               AS units,
               max(p.price)                   AS price,
               sum(p.price * si.quantity)     AS would_be_value,
               count(*) FILTER (WHERE si.sale_date >= %(d90)s) AS recent_lines
        FROM sale_items si
        {products_join("sku, upc, product_name, category, price, cost")}
        WHERE si.client_id = %(cid)s
          AND si.sale_date >= %(since)s
          AND si.quantity > 0
          AND si.total_amount >= 0 AND si.total_amount <= %(nz)s
          AND p.price > %(minp)s
          {NOT_VOIDED}
        GROUP BY p.sku
        """, p)
    free_rows = _top(free_by_sku, "would_be_value", top_n)
    free_tot = _totals(free_by_sku, ("lines", "units", "would_be_value", "recent_lines"))

    below_by_sku = db.fetch_all(
        f"""
        SELECT p.sku                       AS sku,
               max(p.product_name)         AS product_name,
               max(p.category)             AS category,
               count(*)                    AS lines,
               sum(si.quantity)            AS units,
               sum(p.cost * si.quantity - si.total_amount) AS loss
        FROM sale_items si
        {products_join("sku, upc, product_name, category, price, cost")}
        WHERE si.client_id = %(cid)s
          AND si.sale_date >= %(since)s
          AND si.quantity > 0
          AND p.cost > 0
          AND si.total_amount < p.cost * si.quantity
          {NOT_VOIDED}
        GROUP BY p.sku
        """, p)
    below_rows = _top(below_by_sku, "loss", top_n)
    below_tot = _totals(below_by_sku, ("lines", "loss"))

    # Refunds/returns are encoded as a NEGATIVE total_amount (on a positive
    # quantity) in this warehouse; there are no negative-quantity lines. Detect
    # them on the dollar side. `amount` is the (negative) refunded total.
    returns = db.fetch_one(
        """
        SELECT count(*) AS lines, COALESCE(sum(si.quantity), 0) AS units,
               COALESCE(sum(si.total_amount), 0) AS amount
        FROM sale_items si
        WHERE si.client_id = %(cid)s AND si.sale_date >= %(since)s AND si.total_amount < 0
        """, p)

    return {
        "as_of": as_of.isoformat(),
        "window_days": window_days,
        "voids": voids,
        "free_total": free_tot,
        "free_items": free_rows,
        "below_total": below_tot,
        "below_items": below_rows,
        "returns": returns,
    }
