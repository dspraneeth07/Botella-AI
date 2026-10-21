"""Data for the Executive Overview's AI command center.

NOT a POS rehash. We pull only what feeds synthesis the owner can't get from their
register: a tight business pulse (margin + momentum) and per-SKU momentum so we can
flag what's quietly sliding or surging. The ranked action queue itself is assembled
in the pipeline by orchestrating the other engines.
"""
from __future__ import annotations

from datetime import timedelta

from .connector import SourceDB
from .inventory_repo import _as_of, _void_sale_ids
from .sku_key import products_join


def fetch_overview(db: SourceDB, client_id: int, location_id: int | None = None) -> dict:
    as_of = _as_of(db, client_id, location_id)
    if as_of is None:
        return {"as_of": None}
    loc = " AND si.location_id = %(lid)s" if location_id is not None else ""
    p = {
        "cid": client_id,
        "lid": location_id,
        "d30": as_of - timedelta(days=30),
        "d60": as_of - timedelta(days=60),
        "d90": as_of - timedelta(days=90),
        "d365": as_of - timedelta(days=365),
        "void": _void_sale_ids(db, client_id, location_id),
    }
    nonvoid = "(si.sale_id IS NULL OR NOT (si.sale_id = ANY(%(void)s::text[])))"

    # HEADLINE REVENUE BASIS: receipt subtotal (sales.sub_total, pre-tax net),
    # the SAME basis the Node dashboard KPI, chat get_revenue, and the startup
    # digest report — plain SUM(sub_total) + COUNT(*) over `sales`, no status
    # filter (see backend/lib/metrics.js "Fix 0": total_amount is blank on ~5%
    # of receipts and tax-inclusive, so line-item sums ran high and the pulse
    # disagreed with every other surface). sale_items.total_amount remains the
    # right basis ONLY for per-line splits (the margin ratio and per-SKU
    # momentum below).
    loc_s = " AND s.location_id = %(lid)s" if location_id is not None else ""
    pulse = db.fetch_one(
        f"""
        SELECT
          COALESCE(sum(s.sub_total) FILTER (WHERE s.sale_date >= %(d30)s), 0) AS rev_30,
          COALESCE(sum(s.sub_total) FILTER (WHERE s.sale_date >= %(d60)s AND s.sale_date < %(d30)s), 0) AS rev_prev30,
          count(*) FILTER (WHERE s.sale_date >= %(d30)s) AS tx_30
        FROM sales s
        WHERE s.client_id = %(cid)s{loc_s}
          AND s.sale_date >= %(d60)s
        """, p)

    # COST SANITY (same rule as the Node dashboard/Daily Report/get_margin): a
    # recorded cost above 1.5x the line's own realized value is pack-size
    # corruption (store 177 keeps CASE costs in the per-unit field — "Modelo
    # 24/12" cost 30.80 vs 17.29 unit price), not a unit cost. Such lines
    # count as UNCOSTED here, or the pulse margin goes deeply negative and the
    # dashboard KPI (which prefers this cached figure) shows it.
    sane_cost = "(p.cost > 0 AND p.cost*si.quantity <= 1.5*si.total_amount)"
    margin = db.fetch_one(
        f"""
        SELECT COALESCE(sum(si.total_amount - p.cost*si.quantity) FILTER (WHERE {sane_cost}), 0) AS gross,
               COALESCE(sum(si.total_amount) FILTER (WHERE {sane_cost}), 0) AS rev_costed
        FROM sale_items si
        {products_join("sku, upc, cost", lid_param="lid" if location_id is not None else None)}
        WHERE si.client_id = %(cid)s{loc}
          AND si.sale_date >= %(d90)s AND si.quantity > 0 AND {nonvoid}
        """, p)

    # Per-SKU momentum: last 30d vs the prior 30d, for SKUs with real volume.
    momentum = db.fetch_all(
        f"""
        SELECT si.sku, max(si.product_name) AS product_name, max(si.category) AS category,
               COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= %(d30)s), 0) AS u30,
               COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= %(d60)s AND si.sale_date < %(d30)s), 0) AS uprev,
               COALESCE(sum(si.total_amount) FILTER (WHERE si.sale_date >= %(d30)s), 0) AS rev30
        FROM sale_items si
        WHERE si.client_id = %(cid)s{loc}
          AND si.sale_date >= %(d60)s AND si.quantity > 0 AND {nonvoid}
        GROUP BY si.sku
        HAVING COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= %(d60)s AND si.sale_date < %(d30)s), 0) >= 8
            OR COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= %(d30)s), 0) >= 8
        ORDER BY (COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= %(d30)s), 0)
                  + COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= %(d60)s AND si.sale_date < %(d30)s), 0)) DESC
        LIMIT 400
        """, p)

    return {"as_of": as_of.isoformat(), "pulse": pulse, "margin": margin, "momentum": momentum}
