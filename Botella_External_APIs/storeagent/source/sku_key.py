"""Per-store product-key resolution (multi-POS normalization).

Different POS systems key line items differently: some stores' `sale_items.sku`
matches `products.sku` (internal id), others match `products.upc` (barcode) —
and a single store can MIX the two (store 46 rings the same product under its
internal sku on most lines and under its barcode on the rest, so a single-key
join dropped ~25% of its volume). Sales are therefore linked to products by
EITHER key: the catalog is exposed once per key (sku and upc), deduped to one
product per key. `products.sku` stays the canonical identifier downstream (so
cost/purchase joins, which use the internal sku, stay consistent).
"""
from __future__ import annotations


def products_join(cols: str, cid_param: str = "cid", lid_param: str | None = None) -> str:
    """A `sale_items si -> products p` join that accepts EITHER product key.

    The catalog appears once under each of its keys (sku and upc), then is
    deduped to exactly ONE product row per key so a sale line can never be
    double-counted: an sku match beats a upc match (the internal id is the
    more specific claim), then the row holding stock (the live one) wins —
    recreated items and pack variants sharing a barcode are common. A sale
    line carries a single key, so a product matched under both of its keys
    aggregates each line exactly once. `cols` must include `sku`; `cid_param`
    names the client-id bind parameter, `lid_param` (when given) the
    location-id one — `sku` is a PER-LOCATION key in this warehouse, so any
    caller that also filters `sale_items` by location must pass it or a
    multi-location client's catalogs bleed into each other. All three are
    code literals, never user input.
    """
    loc = f"\n                  AND location_id = %({lid_param})s" if lid_param else ""
    filt = (f"FROM products WHERE client_id = %({cid_param})s{loc}\n"
            f"                  AND COALESCE(is_deleted, false) = false")
    # Key eligibility matches Node's canonical getSales catalog byte-for-byte
    # (backend/services/integrationService.js): emptiness is TRIM-normalized,
    # and the upc arm also requires a real sku — a row with a barcode but no
    # internal id must not claim lines and remap them to a NULL/blank sku.
    has_sku = "NULLIF(BTRIM(sku), '') IS NOT NULL"
    has_upc = "NULLIF(BTRIM(upc), '') IS NOT NULL"
    return (f"JOIN (SELECT DISTINCT ON (jk) *\n"
            f"      FROM (SELECT {cols}, sku AS jk, 0 AS jk_pri, stock_qty AS jk_stock\n"
            f"            {filt} AND {has_sku}\n"
            f"            UNION ALL\n"
            f"            SELECT {cols}, upc AS jk, 1 AS jk_pri, stock_qty AS jk_stock\n"
            f"            {filt} AND {has_upc} AND {has_sku}) u\n"
            f"      ORDER BY jk, jk_pri, jk_stock DESC NULLS LAST, sku) p\n"
            f"  ON p.jk = si.sku")
