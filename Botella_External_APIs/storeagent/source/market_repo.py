"""Cross-store Market Intelligence data (uses the multi-tenant warehouse).

Finds products that NEARBY peer stores sell well but this store doesn't carry,
so we can recommend stocking them with a projected profit. Geography comes from
`client_locations` (city/state/postal); products are matched across stores by UPC
(the universal barcode) since per-store sku/upc keying differs. We also pull the
store's own sold product NAMES to suppress false "you don't carry this" hits when
the same item is sold under a different UPC encoding.

Many POS systems write their INTERNAL sku into `sale_items.upc` (store 46 rings
~80% of its volume that way; several statewide peers ring 100% that way), so
filtering sale lines on a barcode regex silently drops most of the market. Every
sale line is therefore resolved to a canonical barcode first — the line's own
upc when it is a real barcode, else the store catalog's upc for the line's sku
(`products.sku -> products.upc`; the catalog mapping is authoritative), else the
line's sku itself when it is barcode-shaped. The catalog outranks the raw sku
because internal POS skus can be 8+ numeric digits and pass the barcode shape
test (store 101 rings 'Proper Twelve 50ML' as sku 27776822 with empty upc — a
sku-first order canonicalized it to itself and hid the store from every
cross-store match). Lines that still don't resolve are excluded as before.
"""
from __future__ import annotations

from datetime import timedelta

from .connector import SourceDB, parallel_fetch, source_db
from .inventory_repo import _as_of
from .purchase_day import purchase_day, purchase_day_sane

MIN_PEER_STORES = 3      # a product must sell at >= this many peers to count as "regional"
MIN_PEER_UNITS = 40      # and move at least this many units in the window
RECENT_DAYS = 14         # and still be moving: sold at a peer within this many days

# Real barcodes only (8-14 numeric digits). Excludes store-local pseudo-UPCs
# (e.g. '0PS1FREN8XAFR') and short internal codes, which aren't comparable
# across stores until resolved through the store's catalog.
_BARCODE = "^[0-9]{8,14}$"


def _canon_lines(ids_param: str) -> str:
    """Subquery: sale lines for the %(ids_param)s stores since %(since)s, each
    with a canonical barcode in `upc` (NULL when unresolvable — callers filter).

    DISTINCT ON keeps one catalog row per (store, sku) — preferring the row
    holding stock — so the LEFT JOIN can't fan a sale line into duplicates when
    a store has recreated a product under the same sku (see sku_key.products_join
    for the same guard on single-store joins). `ids_param` is a code literal,
    never user input.
    """
    # product_name falls back to the store's own catalogue. Four stores (101,
    # 102, 103, 2) sync 34k lines a quarter with upc='' and an empty name, and
    # the 8-digit sku becomes the barcode above - so a peer group built only
    # from their lines had max(product_name) = NULL, and the Market screen
    # rendered a row with 177 units, a price, a projection and no product. The
    # catalogue names ~97% of those skus at 101/102/103; the rest stay NULL
    # here and the caller refuses them rather than showing a nameless row.
    return f"""
        SELECT COALESCE(CASE WHEN si.upc ~ '{_BARCODE}' THEN si.upc END,
                        CASE WHEN p.upc ~ '{_BARCODE}' THEN p.upc END,
                        CASE WHEN si.sku ~ '{_BARCODE}' THEN si.sku END) AS upc,
               si.client_id, si.sale_date, si.quantity, si.total_amount,
               COALESCE(NULLIF(si.product_name, ''), p.product_name) AS product_name,
               si.category
        FROM sale_items si
        LEFT JOIN (SELECT DISTINCT ON (client_id, sku) client_id, sku, upc,
                          NULLIF(product_name, '') AS product_name
                   FROM products
                   WHERE client_id = ANY(%({ids_param})s)
                     AND COALESCE(is_deleted, false) = false AND sku IS NOT NULL
                   ORDER BY client_id, sku, stock_qty DESC NULLS LAST) p
          ON p.client_id = si.client_id AND p.sku = si.sku
        WHERE si.client_id = ANY(%({ids_param})s) AND si.sale_date >= %(since)s
          AND si.quantity > 0"""


def _store_geo(db: SourceDB, client_id: int) -> dict | None:
    return db.fetch_one(
        """SELECT location_name, address, city, state, postal_code, country
           FROM client_locations WHERE client_id = %s LIMIT 1""", (client_id,))


def _peer_ids(db: SourceDB, client_id: int, geo: dict) -> tuple[str, list[int]]:
    """All other active stores in the SAME STATE.

    Liquor regulation (allowed SKUs, pricing rules, taxes) is set at the state
    level, so a state-wide peer set is the only apples-to-apples comparison.
    Tighter city/zip tiers are intentionally not used, and stores outside the
    state are never compared against.
    """
    rows = db.fetch_all(
        """SELECT DISTINCT client_id FROM client_locations
           WHERE state = %(state)s AND client_id <> %(self)s
             AND COALESCE(is_active, true)""",
        {"state": geo.get("state"), "self": client_id})
    return "statewide", [r["client_id"] for r in rows if r["client_id"] != client_id]


def fetch_market_data(db: SourceDB, client_id: int, window_days: int = 90,
                      max_candidates: int = 80) -> dict:
    geo = _store_geo(db, client_id)
    if geo is None or not geo.get("state"):
        return {"available": False, "reason": "no location/geography on file for this store"}
    as_of = _as_of(db, client_id)
    if as_of is None:
        return {"available": False, "reason": "no sales data for this store"}

    tier, peers = _peer_ids(db, client_id, geo)
    if len(peers) < MIN_PEER_STORES:
        return {"available": False, "reason": f"not enough nearby peer stores ({len(peers)})",
                "geo": geo, "peer_tier": tier, "peer_count": len(peers)}

    p = {"self": client_id, "selves": [client_id], "peers": peers,
         "since": as_of - timedelta(days=window_days),
         "recent": as_of - timedelta(days=RECENT_DAYS),
         "minstores": MIN_PEER_STORES, "minunits": MIN_PEER_UNITS, "lim": max_candidates}

    # The remaining pulls run as three parallel chains on separate connections
    # (the warehouse round trip dominates; see connector.parallel_fetch).

    def _chain_peers() -> tuple[list[dict], dict[str, float]]:
        # What peers sell regionally (by UPC). avg_price is the realized unit
        # price (revenue / units), NOT avg(price): `price` is the extended line
        # total at ~2/3 of stores and the per-unit price at the rest, so
        # avg(price) mixes units across POS systems. sum(total)/sum(qty) is the
        # only cross-store-safe unit price and matches my own price below.
        peer_rows = db.fetch_all(
            f"""
            WITH lines AS ({_canon_lines('peers')})
            SELECT upc,
                   max(product_name)            AS product_name,
                   max(category)                AS category,
                   sum(quantity)                AS units,
                   count(DISTINCT client_id)    AS stores,
                   sum(total_amount) / NULLIF(sum(quantity), 0) AS avg_price
            FROM lines
            WHERE upc IS NOT NULL
            GROUP BY upc
            HAVING count(DISTINCT client_id) >= %(minstores)s AND sum(quantity) >= %(minunits)s
              -- Still selling now, not just a strong quarter: a product peers ran
              -- out of (or dropped) weeks ago is not a stocking recommendation.
              AND sum(quantity) FILTER (WHERE sale_date >= %(recent)s) > 0
              -- And actually available nearby: at least one active peer has it in
              -- stock today (drops statewide out-of-stock / negative-stock items).
              AND EXISTS (SELECT 1 FROM products pk
                          WHERE pk.client_id = ANY(%(peers)s) AND pk.upc = lines.upc
                            AND pk.stock_qty > 0 AND COALESCE(pk.is_deleted, false) = false)
            ORDER BY sum(quantity) DESC
            LIMIT %(lim)s
            """, p)
        # Peer cost for the candidate UPCs (for margin), median where available.
        upcs = [r["upc"] for r in peer_rows]
        cost_map: dict[str, float] = {}
        if upcs:
            for r in db.fetch_all(
                """SELECT p.upc, percentile_cont(0.5) WITHIN GROUP (ORDER BY p.cost) AS cost
                   FROM products p
                   WHERE p.client_id = ANY(%(peers)s) AND p.upc = ANY(%(upcs)s)
                     AND p.cost > 0 AND COALESCE(p.is_deleted, false) = false
                   GROUP BY p.upc""", {"peers": peers, "upcs": upcs}):
                if r["cost"] is not None:
                    cost_map[r["upc"]] = float(r["cost"])
        return peer_rows, cost_map

    def _chain_mine() -> tuple[dict, dict, dict, dict]:
        with source_db() as db2:
            # What I already sell (by UPC): units + my realized unit price (for
            # price positioning), plus the names I carry (to suppress dupes).
            mine: dict[str, int] = {}
            my_price: dict[str, float] = {}
            my_name: dict[str, str] = {}
            for r in db2.fetch_all(
                f"""WITH lines AS ({_canon_lines('selves')})
                    SELECT upc, sum(quantity) AS units, sum(total_amount) AS revenue,
                           max(product_name) AS name
                    FROM lines WHERE upc IS NOT NULL GROUP BY upc""", p):
                u = int(r["units"] or 0)
                mine[r["upc"]] = u
                if r["name"]:
                    my_name[r["upc"]] = r["name"]
                if u > 0 and r["revenue"] is not None:
                    my_price[r["upc"]] = float(r["revenue"]) / u
            # Peer stats for EVERY product I genuinely sell (same UPC), fetched
            # once. Head-to-head consumes only my top sellers (my_top, below);
            # price positioning needs the FULL sold set — restricting it to top
            # sellers made "underperforming at this price" structurally empty,
            # because a store's own best sellers rarely trail the typical peer
            # store. The low-volume products are exactly the underperformers.
            my_top = [u for u, _ in sorted(mine.items(), key=lambda kv: kv[1], reverse=True)[:80]]
            sold_upcs = [u for u, n in mine.items() if n > 0]
            peer_for_mine: dict[str, dict] = {}
            if sold_upcs:
                peer_for_mine = {r["upc"]: r for r in db2.fetch_all(
                    f"""WITH lines AS ({_canon_lines('peers')})
                        SELECT upc, sum(quantity) AS units, count(DISTINCT client_id) AS stores,
                               sum(total_amount) / NULLIF(sum(quantity), 0) AS avg_price,
                               max(product_name) AS name, max(category) AS category
                        FROM lines WHERE upc = ANY(%(myupc)s)
                        GROUP BY upc""", {"peers": peers, "since": p["since"], "myupc": sold_upcs})}
            return mine, my_price, my_name, my_top, peer_for_mine

    def _chain_rest() -> tuple[list[str], dict[str, int], int]:
        with source_db() as db3:
            my_names = [r["product_name"] for r in db3.fetch_all(
                """SELECT DISTINCT product_name FROM sale_items
                   WHERE client_id = %(self)s AND sale_date >= %(since)s AND quantity > 0
                     AND product_name IS NOT NULL""", p)]
            # What I BOUGHT per UPC in the window — purchases key on the
            # internal product sku, so map through products to the UPC. The
            # window is on purchase_day(), not pu.date: at LiquorPOS stores
            # `date` is -infinity throughout and a bare bound dropped every
            # purchase, so the store read as having bought nothing.
            my_bought: dict[str, int] = {}
            for r in db3.fetch_all(
                f"""SELECT pr.upc, sum(pu.quantity) AS qty
                   FROM purchases pu
                   JOIN products pr ON pr.client_id = pu.client_id AND pr.sku = pu.sku
                                    AND COALESCE(pr.is_deleted, false) = false
                   WHERE pu.client_id = %(self)s
                     AND {purchase_day_sane('pu')} AND {purchase_day('pu')} >= %(since)s
                     AND pr.upc IS NOT NULL AND pr.upc <> ''
                   GROUP BY pr.upc""", p):
                my_bought[r["upc"]] = int(r["qty"] or 0)
            # How many peers actually contribute barcode-matchable sales — vs
            # len(peers), which counts every store in the state regardless.
            comparable = db3.fetch_one(
                f"""WITH lines AS ({_canon_lines('peers')})
                    SELECT count(DISTINCT client_id) AS n
                    FROM lines WHERE upc IS NOT NULL""", p)["n"]
            return my_names, my_bought, int(comparable or 0)

    ((peer_rows, cost_map),
     (mine, my_price, my_name, my_top, peer_for_mine),
     (my_names, my_bought, comparable_peer_count)) = parallel_fetch(
        _chain_peers, _chain_mine, _chain_rest)

    return {
        "available": True,
        "as_of": as_of.isoformat(),
        "window_days": window_days,
        "geo": geo,
        "peer_tier": tier,
        "peer_count": len(peers),
        "comparable_peer_count": int(comparable_peer_count or 0),
        "peer_rows": peer_rows,
        "my_units_by_upc": mine,
        "my_bought_by_upc": my_bought,
        "my_price_by_upc": my_price,
        "my_name_by_upc": my_name,
        "my_top_upcs": my_top,
        "peer_for_mine": peer_for_mine,
        "my_names": my_names,
        "cost_by_upc": cost_map,
    }
