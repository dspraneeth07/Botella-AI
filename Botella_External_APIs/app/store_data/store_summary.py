"""90-day store summary — a compact (~300 token) shape of the store's overall
profile for the LLM, without dumping 90 days of raw data."""

from __future__ import annotations

from collections import defaultdict

from app.schemas.derived import HealthInfo, StoreSummary, VelocityInfo
from app.schemas.store import InventoryItem, SaleRecord


def compute_summary(
    inventory: list[InventoryItem],
    sales: list[SaleRecord],
    velocity: dict[str, VelocityInfo],
    health: list[HealthInfo],
) -> StoreSummary:
    category_by_sku = {i.sku: (i.category or "uncategorized") for i in inventory}
    name_by_sku = {i.sku: i.product_name for i in inventory}

    # Category revenue mix over the full window (units * unit_price).
    revenue_by_category: dict[str, float] = defaultdict(float)
    units_30d_by_sku: dict[str, int] = defaultdict(int)
    for record in sales:
        category = category_by_sku.get(record.sku, "uncategorized")
        revenue_by_category[category] += record.units * record.unit_price

    total_revenue = sum(revenue_by_category.values()) or 1.0
    category_pct = {
        category: round(rev / total_revenue * 100, 1)
        for category, rev in revenue_by_category.items()
    }

    # Units-weighted gross margin % per category, over the SKUs that carry cost.
    # Weighting by 30d units ties margin to the actual sales mix; categories with
    # no cost data are omitted so the prompt shows "n/a" rather than a fake 0%.
    # Zero-sellers contribute nothing — a shelf of dead SKUs must not outvote
    # the products that actually sell (a weight-1.0 fallback once let hundreds
    # of dormant SKUs swamp a category's real sales mix). A category where
    # nothing sold in 30 days simply shows no margin figure.
    margin_weight: dict[str, float] = defaultdict(float)
    margin_accum: dict[str, float] = defaultdict(float)
    for inv_item in inventory:
        margin = inv_item.margin_pct
        if margin is None:
            continue
        v = velocity.get(inv_item.sku)
        if not v or v.units_30d <= 0:
            continue
        category = inv_item.category or "uncategorized"
        weight = float(v.units_30d)
        margin_weight[category] += weight
        margin_accum[category] += margin * weight
    category_margin_pct = {
        category: round(margin_accum[category] / w, 1)
        for category, w in margin_weight.items()
        if w > 0
    }

    # Top movers (30d) by units — pulled from velocity (already windowed).
    for sku, v in velocity.items():
        units_30d_by_sku[sku] = v.units_30d
    top_movers = sorted(units_30d_by_sku.items(), key=lambda kv: kv[1], reverse=True)[:5]
    top_mover_names = [name_by_sku.get(sku, sku) for sku, units in top_movers if units > 0]

    rising = sorted(
        ((sku, v) for sku, v in velocity.items() if v.trend == "rising" and v.units_30d >= 5),
        key=lambda kv: kv[1].units_7d,
        reverse=True,
    )[:8]
    falling = sorted(
        ((sku, v) for sku, v in velocity.items() if v.trend == "falling" and v.units_90d >= 10),
        key=lambda kv: kv[1].units_90d,
        reverse=True,
    )[:8]

    slow_with_stock = sorted(
        (h for h in health if h.status in ("overstock_mild", "overstock_severe")),
        key=lambda h: h.tied_up_capital,
        reverse=True,
    )[:15]

    return StoreSummary(
        category_revenue_pct=dict(
            sorted(category_pct.items(), key=lambda kv: kv[1], reverse=True)
        ),
        category_margin_pct=dict(
            sorted(category_margin_pct.items(), key=lambda kv: kv[1], reverse=True)
        ),
        top_movers_30d=top_mover_names,
        recent_winners=[name_by_sku.get(sku, sku) for sku, _ in rising],
        recent_losers=[name_by_sku.get(sku, sku) for sku, _ in falling],
        slow_movers_with_stock=[
            {
                "sku": h.sku,
                "product_name": name_by_sku.get(h.sku, h.sku),
                "weeks_on_hand": h.weeks_on_hand,
                "tied_up_capital": h.tied_up_capital,
            }
            for h in slow_with_stock
        ],
    )
