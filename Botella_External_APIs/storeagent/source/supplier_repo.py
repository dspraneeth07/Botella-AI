"""Per-supplier replenishment cadence, derived from the purchases ledger.

The warehouse has no order->receive timestamps (purchase `date` == `invoice_date`
where both are populated), so a literal delivery lead time isn't measurable.
What IS measurable, and useful, is how often the store actually restocks each
SKU from each supplier — the median gap between consecutive purchases. That
observed reorder cycle is a defensible, data-grounded replacement for the flat
review period in buy sizing. We pick each SKU's dominant supplier (most
purchase events) and that supplier's median cycle.

THE DAY IS `purchase_day()`, NOT `date`. At every LiquorPOS store the sync
writes -infinity into `date` and the real day into `invoice_date`
(source/purchase_day.py has the mechanism). On bare `date`, `date IS NOT NULL`
kept all 7,646 of Tuscany's rows and every gap was -infinity minus -infinity:
no median, no cycle, and `max(date)` handed psycopg a value it refuses to
load. A cadence is a gap between two order days; an invoice day serves for
that. It is NOT a receipt date and must not be read as a lead time.
"""
from __future__ import annotations

from .connector import SourceDB
from .purchase_day import purchase_day, purchase_day_sane

# Bound the observed cycle to a sane reorder window (days).
_MIN_CYCLE, _MAX_CYCLE = 7, 120
_DAY = purchase_day()
_SANE = purchase_day_sane()


def fetch_sku_supplier_cycles(db: SourceDB, client_id: int,
                              location_id: int | None = None) -> dict[str, dict]:
    """{sku: {supplier_id, supplier_name, reorder_cycle_days}} for the SKU's
    dominant supplier. SKUs absent from purchases are simply not in the map.

    location_id scopes the purchase history (sku is a per-location key, so a
    sibling location's identical sku string must not contribute gaps). The
    `suppliers` lookup itself stays client-level — the supplier relationship
    is a client fact, and that table's location column isn't guaranteed."""
    loc = " AND location_id = %(lid)s" if location_id is not None else ""
    rows = db.fetch_all(
        f"""
        WITH gaps AS (
            SELECT supplier_id, sku,
                   {_DAY}::date
                     - lag({_DAY}::date) OVER (PARTITION BY supplier_id, sku
                                               ORDER BY {_DAY}::date) AS gap
            FROM purchases
            WHERE client_id = %(cid)s{loc} AND {_SANE}
        ),
        sup_cycle AS (
            SELECT supplier_id,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)
                     FILTER (WHERE gap BETWEEN %(lo)s AND %(hi)s) AS median_cycle
            FROM gaps GROUP BY supplier_id
        ),
        sku_sup AS (   -- dominant supplier per sku = most purchase events
            SELECT DISTINCT ON (sku) sku, supplier_id, cnt
            FROM (
                SELECT sku, supplier_id, count(*) AS cnt
                FROM purchases WHERE client_id = %(cid)s{loc} AND {_SANE}
                GROUP BY sku, supplier_id
            ) q
            -- supplier_id breaks count ties DETERMINISTICALLY. Without it a SKU
            -- bought equally often from two suppliers got an arbitrary winner,
            -- so its coverage (and the buy quantity) could change between runs:
            -- store 175 has 419 such SKUs, one tied 10-10 between suppliers
            -- whose median cycles are 35d vs 54d. Which supplier wins is a
            -- judgement call; picking the SAME one every time is not.
            ORDER BY sku, cnt DESC, supplier_id
        )
        SELECT ss.sku, ss.supplier_id,
               s.supplier_name,
               sc.median_cycle
        FROM sku_sup ss
        LEFT JOIN sup_cycle sc ON sc.supplier_id = ss.supplier_id
        LEFT JOIN suppliers s ON s.client_id = %(cid)s AND s.supplier_id = ss.supplier_id
                              AND COALESCE(s.is_deleted, false) = false
        """,
        {"cid": client_id, "lid": location_id, "lo": _MIN_CYCLE, "hi": _MAX_CYCLE},
    )
    out: dict[str, dict] = {}
    for r in rows:
        cycle = r["median_cycle"]
        out[r["sku"]] = {
            "supplier_id": r["supplier_id"],
            "supplier_name": r["supplier_name"],
            "reorder_cycle_days": int(round(float(cycle))) if cycle is not None else None,
            "last_purchase_date": None,
        }

    # Last time each SKU was purchased (for "when did I last buy this?").
    for r in db.fetch_all(
        f"""SELECT sku, max({_DAY})::date AS last_bought FROM purchases
           WHERE client_id = %(cid)s{loc} AND {_SANE} GROUP BY sku""",
        {"cid": client_id, "lid": location_id}):
        out.setdefault(r["sku"], {"supplier_id": None, "supplier_name": None,
                                  "reorder_cycle_days": None})["last_purchase_date"] = r["last_bought"]
    return out
