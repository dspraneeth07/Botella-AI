"""Per-SKU margin & discount aggregates for the Money-Leak Finder.

Line-level economics the Phase-1 snapshot doesn't carry: discounts given,
below-cost sales, realised gross margin. Margin uses products.cost joined by SKU
(sale_items.cost is 0). VOID sales excluded.
"""
from __future__ import annotations

from datetime import timedelta

from .connector import SourceDB
from .inventory_repo import _as_of, _void_sale_ids
from .sku_key import products_join


def fetch_margin_rows(db: SourceDB, client_id: int, location_id: int | None = None,
                      window_days: int = 365) -> list[dict]:
    # location_id scopes everything: these rows join against the (location-
    # scoped) inventory dataset's velocity classes by sku, and sku is a
    # PER-LOCATION key — a client-wide pull would attribute sibling
    # locations' discounts and losses to this store.
    as_of = _as_of(db, client_id, location_id)
    if as_of is None:
        return []
    loc = " AND si.location_id = %(lid)s" if location_id is not None else ""
    params = {
        "cid": client_id,
        "lid": location_id,
        "since": as_of - timedelta(days=window_days),
        "void": _void_sale_ids(db, client_id, location_id),
    }
    return db.fetch_all(
        f"""
        SELECT p.sku                                                  AS sku,
               max(p.product_name)                                    AS product_name,
               max(p.category)                                        AS category,
               max(p.price)                                           AS price,
               max(p.cost)                                            AS cost,
               sum(si.quantity)                                       AS units,
               sum(si.total_amount)                                   AS revenue,
               sum(si.discount)                                       AS discount,
               count(*)                                               AS lines,
               count(*) FILTER (WHERE si.discount > 0)                AS discount_lines,
               sum(si.quantity) FILTER (WHERE si.discount > 0)        AS units_discounted,
               sum((si.total_amount - p.cost*si.quantity))
                   FILTER (WHERE p.cost > 0)                          AS margin_dollars,
               sum(GREATEST(p.cost*si.quantity - si.total_amount, 0))
                   FILTER (WHERE p.cost > 0)                          AS below_cost_loss,
               count(*) FILTER (WHERE p.cost > 0
                                AND si.total_amount < p.cost*si.quantity) AS below_cost_lines
        FROM sale_items si
        {products_join("sku, upc, product_name, category, price, cost",
                       lid_param="lid" if location_id is not None else None)}
        WHERE si.client_id = %(cid)s{loc}
          AND si.sale_date >= %(since)s
          AND si.quantity > 0
          AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(%(void)s::text[])))
        GROUP BY p.sku
        """, params)
