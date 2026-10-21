"""The day a syncgo `purchases` row happened on, as SQL.

WHY THIS EXISTS. At every LiquorPOS store (173 Tuscany, 182, 184, 186: 19,428
rows on 19 Oct 2026) `purchases.date` is '-infinity' on EVERY row while
`invoice_date` is populated and sane. The SyncGo extraction query for that
connector reads ONE source column, ORD_IN.DATE, under two aliases::

    SELECT PO_NUM AS PurchaseId, DATE AS PurchaseDate, ..., DATE AS InvoiceDate

Every other connector aliases that field ``AS Date``, the name the uploader
binds `purchases.date` to. ``PurchaseDate`` matches nothing, the uploader
writes its default DateTime (0001-01-01) and the driver stores -infinity. The
POS has the date; the sync drops it. The reverse shows at PCAmerica stores,
whose query says ``null as InvoiceDate`` and whose invoice_date is -infinity
throughout.

The fix that belongs here is a SyncGo config change (alias the column
``AS Date``). Until it lands, every reader that filters, groups or orders on
the purchase day uses this expression: the sync's `date` when it is a real
timestamp, else `invoice_date` (for LiquorPOS the SAME source field), never a
sentinel. A bare ``date IS NOT NULL`` keeps every -infinity row and then
computes gaps of NaN days; a bare ``ORDER BY date DESC`` picks an arbitrary
"latest" cost; a bare ``date >= since`` drops the whole feed. Postgres reads
-infinity happily; psycopg refuses to load it, so the value must never reach
a SELECT list either.

WHAT THIS IS NOT. A receipt date. `invoice_date` is a billing date, and the
lead-time assumption in app/pipeline/policy/inventory.py stays declared, not
measured from this. The expression answers "did an order happen, and roughly
when" - cadence and confirmation - and nothing finer.

The Node side carries the same expression in
backend/services/purchaseDateSql.js; keep the two in step.
"""
from __future__ import annotations

# Nothing in this warehouse predates 1990; anything earlier is a sentinel.
PURCHASE_DAY_FLOOR = "1990-01-01"


def purchase_day(alias: str = "") -> str:
    """The purchase day as a timestamp expression, for SELECT / GROUP BY /
    ORDER BY. `alias` prefixes the columns when the query joins ('pu' ->
    pu.date). A code literal, never user input."""
    a = f"{alias}." if alias else ""
    return f"COALESCE(NULLIF({a}date, '-infinity'), NULLIF({a}invoice_date, '-infinity'))"


def purchase_day_sane(alias: str = "") -> str:
    """The WHERE predicate keeping only rows whose purchase day is real: not
    a sentinel in both columns (COALESCE of two NULLs is NULL, which the
    comparison drops), not before the floor."""
    return f"{purchase_day(alias)} >= DATE '{PURCHASE_DAY_FLOOR}'"
