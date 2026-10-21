"""Market-basket data: which products sell together in the same transaction.

Bounded for cost: we look at a recent window and only the store's top movers
(pairwise co-occurrence across ALL SKUs would be prohibitive), then compute
support / confidence / lift in the pure function. sale_items carries
product_name, so no products join is needed for labels.
"""
from __future__ import annotations

from datetime import timedelta

from .connector import SourceDB
from .inventory_repo import _as_of, _void_sale_ids


def fetch_basket_data(db: SourceDB, client_id: int, window_days: int = 120,
                      top_skus: int = 120, min_support: int = 15,
                      max_pairs: int = 60) -> dict:
    as_of = _as_of(db, client_id)
    if as_of is None:
        return {"as_of": None}
    void = _void_sale_ids(db, client_id)
    data = _fetch_window(db, client_id, as_of, void, window_days,
                         top_skus, min_support, max_pairs)
    # Small/quiet stores often can't clear even the adaptive support floor in
    # one quarter. Retry once over a full year (salvages slower/seasonal pairs)
    # before reporting nothing.
    if window_days < 365 and (data["total_baskets"] < 50 or not data["pairs"]):
        data = _fetch_window(db, client_id, as_of, void, 365,
                             top_skus, min_support, max_pairs)
        data["window_widened"] = True
    return data


def _fetch_window(db: SourceDB, client_id: int, as_of, void, window_days: int,
                  top_skus: int, min_support: int, max_pairs: int) -> dict:
    p = {
        "cid": client_id,
        "since": as_of - timedelta(days=window_days),
        "void": void,
        "k": top_skus,
        "maxpairs": max_pairs,
    }

    top = db.fetch_all(
        """
        SELECT si.sku, max(si.product_name) AS product_name, max(si.category) AS category,
               sum(si.quantity) AS units
        FROM sale_items si
        WHERE si.client_id = %(cid)s AND si.sale_date >= %(since)s AND si.quantity > 0
          AND si.sku IS NOT NULL
          AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(%(void)s::text[])))
        GROUP BY si.sku
        ORDER BY sum(si.quantity) DESC, si.sku
        LIMIT %(k)s
        """, p)
    skus = [r["sku"] for r in top]
    names = {r["sku"]: (r["product_name"], r["category"]) for r in top}
    if len(skus) < 2:
        return {"as_of": as_of.isoformat(), "window_days": window_days,
                "total_baskets": 0, "multi_item_baskets": 0,
                "sku_baskets": {}, "names": names, "pairs": []}
    p["skus"] = skus

    counts = db.fetch_one(
        """
        SELECT count(*) AS total, count(*) FILTER (WHERE lines >= 2) AS multi
        FROM (
            SELECT si.sale_id, count(DISTINCT si.sku) AS lines
            FROM sale_items si
            WHERE si.client_id = %(cid)s AND si.sale_date >= %(since)s AND si.quantity > 0
              AND si.sale_id IS NOT NULL
              AND NOT (si.sale_id = ANY(%(void)s::text[]))
            GROUP BY si.sale_id
        ) t
        """, p)
    total_baskets = counts["total"]
    multi_item_baskets = counts["multi"]

    # Adaptive pair support: a fixed floor of 15 co-occurrences fits the pilot
    # store's volume but zeroes out small stores. Scale with traffic (0.3% of
    # baskets), floored at 4 so a pair still has to repeat, capped at the old
    # fixed value so high-volume stores behave exactly as before.
    minsup = max(4, min(min_support, round(0.003 * (total_baskets or 0))))
    p["minsup"] = minsup

    sku_baskets = {r["sku"]: r["n"] for r in db.fetch_all(
        """
        SELECT si.sku, count(DISTINCT si.sale_id) AS n
        FROM sale_items si
        WHERE si.client_id = %(cid)s AND si.sale_date >= %(since)s AND si.quantity > 0
          AND si.sale_id IS NOT NULL AND si.sku = ANY(%(skus)s::text[])
          AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(%(void)s::text[])))
        GROUP BY si.sku
        """, p)}

    pairs = db.fetch_all(
        """
        WITH b AS (
            SELECT DISTINCT si.sale_id, si.sku
            FROM sale_items si
            WHERE si.client_id = %(cid)s AND si.sale_date >= %(since)s AND si.quantity > 0
              AND si.sale_id IS NOT NULL AND si.sku = ANY(%(skus)s::text[])
              AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(%(void)s::text[])))
        )
        SELECT x.sku AS a, y.sku AS b, count(*) AS pair_count
        FROM b x JOIN b y ON x.sale_id = y.sale_id AND x.sku < y.sku
        GROUP BY x.sku, y.sku
        HAVING count(*) >= %(minsup)s
        ORDER BY pair_count DESC
        LIMIT %(maxpairs)s
        """, p)

    return {
        "as_of": as_of.isoformat(),
        "window_days": window_days,
        "total_baskets": int(total_baskets or 0),
        "multi_item_baskets": int(multi_item_baskets or 0),
        "min_support_used": minsup,
        "sku_baskets": sku_baskets,
        "names": names,
        "pairs": [{"a": r["a"], "b": r["b"], "pair_count": int(r["pair_count"])} for r in pairs],
    }
