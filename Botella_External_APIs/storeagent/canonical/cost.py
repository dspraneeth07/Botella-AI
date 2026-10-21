"""Cost resolution & imputation.

`sale_items.cost` is 0 across the warehouse, so unit cost must come from
`products.cost`. Where that's missing/zero we fall back to the latest
`purchases.cost` for the SKU, then to a category-median-margin imputation from
the product's retail price. Every value is tagged with its source so downstream
outputs can be honest about what's measured vs. estimated.
"""
from __future__ import annotations

import statistics
from collections import defaultdict

from ..functions.models import SkuStat

PRODUCT = "product"
PURCHASES = "purchases"
IMPUTED = "imputed"
UNKNOWN = "unknown"

# Only learn the category-median margin from plausible (cost, price) pairs. Bad
# warehouse cost data produces below-cost rows (negative margin, e.g. cost > price)
# and near-zero-cost rows (margin -> ~1.0); both would drag the median and, in
# sparse categories, flip it negative -> an imputed cost ABOVE price. Keep the
# learning pool to a sane band; per-SKU real margins (final pass) are unaffected.
MARGIN_LEARN_MIN = 0.0
MARGIN_LEARN_MAX = 0.95


def resolve_and_impute_costs(skus: list[SkuStat], purchases_cost: dict[str, float]) -> None:
    """Fill cost / cost_source / margin_pct on each SkuStat (in place)."""
    pending: list[SkuStat] = []

    # Pass 1: product cost, then purchases fallback.
    for s in skus:
        if s.cost is not None and s.cost > 0:
            s.cost_source = PRODUCT
        elif s.sku in purchases_cost and purchases_cost[s.sku] > 0:
            s.cost = round(purchases_cost[s.sku], 4)
            s.cost_source = PURCHASES
        else:
            s.cost = None
            s.cost_source = UNKNOWN
            pending.append(s)

    # Pass 2: per-canonical-category median gross margin from rows with real cost+price.
    margins: dict[str, list[float]] = defaultdict(list)
    for s in skus:
        if s.cost and s.price and s.price > 0 and s.cost_source in (PRODUCT, PURCHASES):
            m = (s.price - s.cost) / s.price
            if MARGIN_LEARN_MIN < m < MARGIN_LEARN_MAX:
                margins[s.canonical_category].append(m)
    median_margin = {c: statistics.median(v) for c, v in margins.items() if v}
    overall_margin = statistics.median(
        [m for v in margins.values() for m in v]) if margins else None

    # Pass 3: impute pending from price * (1 - category margin).
    for s in pending:
        if s.price and s.price > 0:
            mm = median_margin.get(s.canonical_category, overall_margin)
            if mm is not None:
                s.cost = round(s.price * (1 - mm), 4)
                s.cost_source = IMPUTED

    # Margin% where we have both cost and a positive price.
    for s in skus:
        if s.cost is not None and s.price and s.price > 0:
            s.margin_pct = round((s.price - s.cost) / s.price, 4)
