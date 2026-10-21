"""Lost-Sales from stockouts (opportunity cost a POS never shows).

We don't have historical stock levels (only a current snapshot), so we INFER it:
a SKU that is a proven mover but is currently out of stock (on_hand <= 0) and has
stopped selling is bleeding sales. Estimated lost units = its normal daily rate x
days since it last sold. Clearly an estimate, and bounded (a mover "out" for many
months is treated as discontinued, not a stockout).
"""
from __future__ import annotations

from datetime import date

from ..forecasting.demand import SkuDemand

MIN_UNITS_90 = 4      # must be a real mover to claim lost sales
MAX_DAYS_OUT = 45     # beyond this, treat as discontinued (don't over-count)


def lost_sales(demands: list[SkuDemand], as_of: date,
               min_units_90: int = MIN_UNITS_90, max_days_out: int = MAX_DAYS_OUT,
               top_n: int = 500) -> dict:
    items = []
    for d in demands:
        if max(d.on_hand, 0) > 0:                 # in stock -> not losing sales now
            continue
        if d.units_90 < min_units_90 or d.last_sale is None:
            continue
        days_out = (as_of - d.last_sale).days
        if days_out <= 0 or days_out > max_days_out:
            continue
        base = d.base_daily()
        if base <= 0:
            continue
        lost_units = base * days_out
        price = d.price or 0.0
        margin_per = (price - d.cost) if (d.cost is not None and price) else None
        items.append({
            "sku": d.sku, "product_name": d.product_name, "category": d.category,
            "days_out": days_out,
            # The velocity behind the estimate, on the row so the revenue is
            # reproducible: avg/day (last 90d, else 365d) x days out = lost
            # units; x price = lost revenue.
            "units_30": d.units_30,
            "units_90": d.units_90,
            "daily_rate": round(base, 2),
            "lost_units": round(lost_units, 1),
            "lost_revenue": round(lost_units * price, 2),
            "lost_margin": round(lost_units * margin_per, 2) if margin_per is not None else None,
            "ongoing_daily_loss": round(base * price, 2),    # $/day still bleeding
        })

    items.sort(key=lambda r: (r["lost_margin"] if r["lost_margin"] is not None
                              else r["lost_revenue"]), reverse=True)
    total_rev = round(sum(r["lost_revenue"] for r in items), 2)
    total_margin = round(sum(r["lost_margin"] or 0.0 for r in items), 2)
    daily_bleed = round(sum(r["ongoing_daily_loss"] for r in items), 2)
    return {
        "as_of": as_of.isoformat(),
        "stockout_sku_count": len(items),
        "lost_revenue_estimate": total_rev,
        "lost_margin_estimate": total_margin,
        "ongoing_daily_loss": daily_bleed,
        "items": items[:top_n],
    }
