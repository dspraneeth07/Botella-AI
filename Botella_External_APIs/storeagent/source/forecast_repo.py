"""Data pulls for predictive buying: per-SKU demand profiles + store daily series."""
from __future__ import annotations

from datetime import date, timedelta

from ..canonical.category import canonicalize_category
from ..forecasting.demand import SkuDemand
from .connector import SourceDB, parallel_fetch, source_db
from .inventory_repo import _as_of, _as_of_and_voids
from .sku_key import products_join
from .supplier_repo import fetch_sku_supplier_cycles


def fetch_sku_demand(db: SourceDB, client_id: int, location_id: int | None = None,
                     window_days: int = 365) -> tuple[date, list[SkuDemand]]:
    # One round trip for as_of + voids; supplier cycles ride a parallel
    # connection while the (heavy) demand join runs on the caller's.
    # location_id scopes everything (house tenancy rule; also what makes these
    # figures agree with the location-scoped Node feed the rec service uses).
    as_of, void_ids = _as_of_and_voids(db, client_id, location_id)
    if as_of is None:
        return None, []
    loc = " AND si.location_id = %(lid)s" if location_id is not None else ""
    params = {
        "cid": client_id,
        "lid": location_id,
        "since": as_of - timedelta(days=window_days),
        "d28": as_of - timedelta(days=28),
        "d30": as_of - timedelta(days=30),
        "d90": as_of - timedelta(days=90),
        "void": void_ids,
    }
    demand_sql = f"""
        SELECT p.sku             AS sku,
               max(p.product_name) AS product_name,
               max(p.category)     AS category,
               max(p.stock_qty)    AS on_hand,
               max(p.cost)         AS cost,
               max(p.price)        AS price,
               sum(si.quantity) FILTER (WHERE si.sale_date >= %(d28)s) AS u28,
               sum(si.quantity) FILTER (WHERE si.sale_date >= %(d30)s) AS u30,
               sum(si.quantity) FILTER (WHERE si.sale_date >= %(d90)s) AS u90,
               sum(si.quantity)    AS u365,
               max(si.sale_date)::date AS last_sale,
               -- Shelf age: rates divide by the days a SKU has actually been
               -- selling, not by the whole window it was mostly absent from.
               min(si.sale_date)::date AS first_sale,
               sum(si.quantity) FILTER (WHERE extract(dow from si.sale_date)=0) AS d0,
               sum(si.quantity) FILTER (WHERE extract(dow from si.sale_date)=1) AS d1,
               sum(si.quantity) FILTER (WHERE extract(dow from si.sale_date)=2) AS d2,
               sum(si.quantity) FILTER (WHERE extract(dow from si.sale_date)=3) AS d3,
               sum(si.quantity) FILTER (WHERE extract(dow from si.sale_date)=4) AS d4,
               sum(si.quantity) FILTER (WHERE extract(dow from si.sale_date)=5) AS d5,
               sum(si.quantity) FILTER (WHERE extract(dow from si.sale_date)=6) AS d6
        FROM sale_items si
        {products_join("sku, upc, product_name, category, stock_qty, cost, price",
                       lid_param="lid" if location_id is not None else None)}
        WHERE si.client_id = %(cid)s{loc}
          AND si.sale_date >= %(since)s
          AND si.quantity > 0
          AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(%(void)s::text[])))
        GROUP BY p.sku
        """

    def _cycles():
        with source_db("120s") as db2:
            return fetch_sku_supplier_cycles(db2, client_id, location_id)

    rows, cycles = parallel_fetch(lambda: db.fetch_all(demand_sql, params), _cycles)

    def i(x):
        return int(x) if x is not None else 0

    demands = []
    for r in rows:
        sup = cycles.get(r["sku"], {})
        demands.append(SkuDemand(
            sku=r["sku"], product_name=r["product_name"],
            category=canonicalize_category(r["category"], r["product_name"]),
            on_hand=i(r["on_hand"]),
            cost=float(r["cost"]) if r["cost"] is not None else None,
            price=float(r["price"]) if r["price"] is not None else None,
            units_28=i(r["u28"]), units_30=i(r["u30"]), units_90=i(r["u90"]), units_365=i(r["u365"]),
            last_sale=r["last_sale"], first_sale=r["first_sale"],
            dow_units=[float(i(r[f"d{w}"])) for w in range(7)],
            as_of=as_of, window_days=window_days,
            supplier_id=sup.get("supplier_id"),
            supplier_name=sup.get("supplier_name"),
            reorder_cycle_days=sup.get("reorder_cycle_days"),
            last_purchase_date=sup.get("last_purchase_date"),
        ))
    return as_of, demands


def fetch_store_daily(db: SourceDB, client_id: int, location_id: int | None = None,
                      days: int = 420) -> list[tuple[date, float]]:
    as_of = _as_of(db, client_id, location_id)
    if as_of is None:  # no sales at this store (e.g. a just-onboarded location)
        return []
    loc = " AND si.location_id = %(lid)s" if location_id is not None else ""
    rows = db.fetch_all(
        f"""
        SELECT si.sale_date::date AS d, sum(si.quantity) AS units
        FROM sale_items si
        WHERE si.client_id = %(cid)s{loc} AND si.sale_date >= %(since)s AND si.quantity > 0
        GROUP BY si.sale_date::date ORDER BY d
        """, {"cid": client_id, "lid": location_id,
              "since": as_of - timedelta(days=days)})
    return [(r["d"], float(r["units"])) for r in rows]
