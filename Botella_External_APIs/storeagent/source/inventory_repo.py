"""Build a store's fully-resolved InventoryDataset from the warehouse.

Pulls raw products + per-SKU velocity (VOID sales excluded) + latest purchase
costs, then applies the canonicalization layer (category, size, cost). The
result is a list of SkuStat ready for the pure deterministic functions.
"""
from __future__ import annotations

from datetime import date, timedelta

from ..canonical.category import canonicalize_category
from ..canonical.cost import resolve_and_impute_costs
from ..canonical.size import parse_pack_count, parse_size_ml
from ..functions.models import InventoryDataset, SkuStat
from .connector import SourceDB, parallel_fetch, source_db
from .purchase_day import purchase_day


# Tenancy note: `lid` is optional on these helpers only so legacy client-wide
# callers (customers/market/retired tabs, swept separately) keep compiling.
# Every NUMBER-BEARING path (buying, inventory, overview) passes it: the house
# rule is client_id AND location_id on every query, and the Node feed the rec
# service consumes is location-scoped — a client-wide figure here can never
# match it on a multi-location client.
def _loc(lid: int | None, alias: str = "") -> str:
    col = f"{alias}.location_id" if alias else "location_id"
    return f" AND {col} = %(lid)s" if lid is not None else ""


def _as_of(db: SourceDB, cid: int, lid: int | None = None) -> date | None:
    row = db.fetch_one(
        f"SELECT max(sale_date)::date AS d FROM sales WHERE client_id=%(cid)s{_loc(lid)}",
        {"cid": cid, "lid": lid})
    return row["d"] if row else None


def _void_sale_ids(db: SourceDB, cid: int, lid: int | None = None) -> list[str]:
    rows = db.fetch_all(
        f"SELECT sale_id FROM sales WHERE client_id=%(cid)s{_loc(lid)}"
        f" AND sale_status='VOID' AND sale_id IS NOT NULL",
        {"cid": cid, "lid": lid})
    return [r["sale_id"] for r in rows]


def _as_of_and_voids(db: SourceDB, cid: int,
                     lid: int | None = None) -> tuple[date | None, list[str]]:
    """One pass over the store's sales for both facts — one round trip
    instead of two on a high-latency link."""
    row = db.fetch_one(
        f"""
        SELECT max(sale_date)::date AS as_of,
               array_remove(array_agg(sale_id) FILTER (WHERE sale_status = 'VOID'), NULL) AS void_ids
        FROM sales WHERE client_id = %(cid)s{_loc(lid)}
        """, {"cid": cid, "lid": lid})
    if not row or row["as_of"] is None:
        return None, []
    return row["as_of"], list(row["void_ids"] or [])


def _velocity(db: SourceDB, cid: int, as_of: date, void_ids: list[str],
              lid: int | None = None) -> dict[str, dict]:
    params = {
        "cid": cid,
        "lid": lid,
        "d30": as_of - timedelta(days=30),
        "d60": as_of - timedelta(days=60),
        "d90": as_of - timedelta(days=90),
        "d365": as_of - timedelta(days=365),
        "void": void_ids,
    }
    rows = db.fetch_all(
        f"""
        SELECT si.sku,
               COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= %(d30)s), 0)  AS u30,
               COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= %(d60)s), 0)  AS u60,
               COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= %(d90)s), 0)  AS u90,
               COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= %(d365)s), 0) AS u365,
               max(si.sale_date)::date AS last_sale,
               count(*) FILTER (WHERE si.sale_date >= %(d90)s) AS lines90
        FROM sale_items si
        WHERE si.client_id = %(cid)s{_loc(lid, "si")}
          AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(%(void)s::text[])))
        GROUP BY si.sku
        """, params)
    return {r["sku"]: r for r in rows if r["sku"] is not None}


def _purchase_costs(db: SourceDB, cid: int, lid: int | None = None) -> dict[str, float]:
    # "Latest" is by purchase_day(), not `date`: at LiquorPOS stores `date` is
    # -infinity on every row, so ORDER BY date DESC returned whichever row the
    # planner met first and the imputed cost changed between runs. Rows with
    # no real day on either column sort last rather than being dropped - a
    # cost with no date is still a cost, it just never beats a dated one.
    rows = db.fetch_all(
        f"""
        SELECT DISTINCT ON (sku) sku, cost
        FROM purchases
        WHERE client_id = %(cid)s{_loc(lid)} AND sku IS NOT NULL AND cost IS NOT NULL AND cost > 0
        ORDER BY sku, {purchase_day()} DESC NULLS LAST, id DESC
        """, {"cid": cid, "lid": lid})
    return {r["sku"]: float(r["cost"]) for r in rows}


def _products(db: SourceDB, cid: int, lid: int | None = None) -> list[dict]:
    return db.fetch_all(
        f"""
        SELECT sku, upc, product_name, category, price, sale_price, cost, stock_qty, pack_size, uom
        FROM products
        WHERE client_id = %(cid)s{_loc(lid)}
          AND COALESCE(is_deleted, false) = false AND sku IS NOT NULL
        """, {"cid": cid, "lid": lid})


# Some POS exports write an "unknown stock" sentinel into stock_qty — we've seen
# INT32_MIN (-2147483648) at live stores. An implausible magnitude is not real
# stock: treat it as unknown (None) so it neither inflates on-hand nor wins the
# duplicate-key velocity-claim priority below.
STOCK_SENTINEL_MAX = 1_000_000


def _clean_stock(raw) -> int | None:
    if raw is None:
        return None
    v = int(raw)
    return None if abs(v) >= STOCK_SENTINEL_MAX else v


def build_inventory_dataset(db: SourceDB, client_id: int, location_id: int) -> InventoryDataset:
    # The warehouse round trip dominates this build, so the pulls run as three
    # parallel chains on separate connections: the passed `db` serves the
    # velocity chain (as_of + voids feed the velocity aggregate), while
    # products and costs/join-key each get their own connection.
    def _chain_velocity() -> tuple[date | None, dict[str, dict]]:
        as_of, void_ids = _as_of_and_voids(db, client_id, location_id)
        if as_of is None:
            return None, {}
        return as_of, _velocity(db, client_id, as_of, void_ids, location_id)

    def _chain_products() -> list[dict]:
        with source_db() as db2:
            return _products(db2, client_id, location_id)

    def _chain_costs() -> dict[str, float]:
        with source_db() as db3:
            return _purchase_costs(db3, client_id, location_id)

    (as_of, velocity), products, purchase_costs = parallel_fetch(
        _chain_velocity, _chain_products, _chain_costs)
    if as_of is None:
        raise ValueError(f"No sales found for client_id={client_id}")

    # When two product rows share a sale key (duplicate UPCs are common), only
    # ONE may claim that key's sales — otherwise every shared sale line counts
    # once per product and the store's velocity totals double-count. The row
    # holding stock is the live one, so it gets priority.
    products.sort(key=lambda p: (-(_clean_stock(p["stock_qty"]) or 0), p["sku"]))
    uniq: list[dict] = []
    seen: set[str] = set()
    for p in products:
        if p["sku"] in seen:   # defensive de-dup (store 10 has none, but be safe)
            continue
        seen.add(p["sku"])
        uniq.append(p)

    # A sale line's key can be the product's internal sku OR its barcode (store
    # 46 rings the same product both ways), so each product claims velocity
    # under BOTH keys and the rows are summed. Claims run sku-first across all
    # products (matching products_join's jk_pri: a key that is one product's
    # sku and another's upc belongs to the sku owner), each key claimed once.
    claims: dict[int, list[dict]] = {}
    velocity_claimed: set[str] = set()
    for keyfield in ("sku", "upc"):
        for i, p in enumerate(uniq):
            k = p[keyfield]
            if not k or k in velocity_claimed:
                continue
            row = velocity.get(k)
            if row is not None:
                velocity_claimed.add(k)
                claims.setdefault(i, []).append(row)

    skus: list[SkuStat] = []
    for i, p in enumerate(uniq):
        clean_stock = _clean_stock(p["stock_qty"])
        sentinel = clean_stock is None and p["stock_qty"] is not None
        raw_stock = clean_stock if clean_stock is not None else 0
        vrows = claims.get(i, [])
        v = None
        if vrows:
            v = {
                "u30": sum(int(r["u30"]) for r in vrows),
                "u60": sum(int(r["u60"]) for r in vrows),
                "u90": sum(int(r["u90"]) for r in vrows),
                "u365": sum(int(r["u365"]) for r in vrows),
                "lines90": sum(int(r["lines90"]) for r in vrows),
                "last_sale": max(r["last_sale"] for r in vrows if r["last_sale"] is not None)
                             if any(r["last_sale"] is not None for r in vrows) else None,
            }
        cost = float(p["cost"]) if p["cost"] is not None else None
        skus.append(SkuStat(
            sku=p["sku"],
            product_name=p["product_name"],
            raw_category=p["category"],
            canonical_category=canonicalize_category(p["category"], p["product_name"]),
            size_ml=parse_size_ml(p["product_name"], p["pack_size"], p["uom"]),
            pack_count=parse_pack_count(p["pack_size"], p["product_name"]),
            on_hand=max(raw_stock, 0),
            on_hand_raw=raw_stock,
            stock_flag=("sentinel_unknown" if sentinel
                        else "negative_clamped" if raw_stock < 0 else None),
            cost=cost,
            cost_source="product" if (cost and cost > 0) else "unknown",
            price=float(p["price"]) if p["price"] is not None else None,
            sale_price=float(p["sale_price"]) if p["sale_price"] is not None else None,
            units_30=int(v["u30"]) if v else 0,
            units_60=int(v["u60"]) if v else 0,
            units_90=int(v["u90"]) if v else 0,
            units_365=int(v["u365"]) if v else 0,
            last_sale_date=v["last_sale"] if v else None,
            lines_90=int(v["lines90"]) if v else 0,
        ))

    resolve_and_impute_costs(skus, purchase_costs)
    return InventoryDataset(client_id=client_id, location_id=location_id, as_of=as_of, skus=skus)
