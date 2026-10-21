"""Pricing & Margin Optimizer — deterministic per-SKU price suggestions.

Pure over an enriched InventoryDataset (reuses the same SkuStat the inventory
capability builds). Two moves, both benchmarked against the SKU's own category:
  * RAISE under-priced fast movers — selling well but below the category's typical
    margin, so you're leaving margin on the table. Suggest a price toward the
    category median (capped), with the annual $ upside if volume holds.
  * CUT over-priced slow movers — priced above the category norm and not moving;
    a lower price may unstick them (we surface the frozen cash, not a $ promise).

Every number is auditable; we never claim a demand response we can't measure, so
the headline $ is the RAISE upside (margin gain at current volume).
"""
from __future__ import annotations

import statistics

from ..config import THRESHOLDS, Thresholds
from .inventory import DEAD, FAST, NEVER, NORMAL, SLOW
from .models import InventoryDataset

RAISE_OK = {FAST, NORMAL}
CUT_OK = {SLOW, DEAD, NEVER}


def _category_median_margins(dataset: InventoryDataset, min_n: int = 5) -> dict[str, float]:
    by: dict[str, list[float]] = {}
    for s in dataset.skus:
        if s.margin_pct is not None and s.cost and s.price and s.price > 0:
            by.setdefault(s.canonical_category, []).append(s.margin_pct)
    return {c: statistics.median(v) for c, v in by.items() if len(v) >= min_n}


def price_optimizer(dataset: InventoryDataset, t: Thresholds = THRESHOLDS,
                    raise_cap: float = 0.20, min_gap: float = 0.05,
                    top_n: int = 500) -> dict:
    cat_med = _category_median_margins(dataset)
    all_margins = [s.margin_pct for s in dataset.skus
                   if s.margin_pct is not None and s.cost and s.price and s.price > 0]
    overall = statistics.median(all_margins) if all_margins else None

    raises: list[dict] = []
    cuts: list[dict] = []
    for s in dataset.skus:
        if s.margin_pct is None or not s.cost or not s.price or s.price <= 0:
            continue
        med = cat_med.get(s.canonical_category, overall)
        if med is None:
            continue
        annual_units = round(s.daily_velocity * 365)

        # ---- RAISE: sells well, priced below category margin ----
        if s.velocity_class in RAISE_OK and annual_units > 0 and s.margin_pct < med - min_gap:
            target_price = s.cost / (1 - med) if med < 1 else s.price
            new_price = round(min(s.price * (1 + raise_cap), target_price), 2)
            if new_price > s.price * 1.005:
                upside = round((new_price - s.price) * annual_units, 2)
                raises.append({
                    "sku": s.sku, "product_name": s.product_name, "category": s.canonical_category,
                    "velocity_class": s.velocity_class,
                    "price": round(s.price, 2), "suggested_price": new_price,
                    "unit_cost": round(s.cost, 2),
                    "current_margin_pct": round(s.margin_pct * 100, 1),
                    "category_margin_pct": round(med * 100, 1),
                    "annual_units": annual_units,
                    "est_annual_upside": upside,
                })

        # ---- CUT: priced above category norm and not moving ----
        elif s.velocity_class in CUT_OK and not s.is_premium and s.on_hand > 0 \
                and s.margin_pct > med + min_gap:
            target_price = max(s.cost * 1.05, s.cost / (1 - med) if med < 1 else s.cost)
            new_price = round(max(target_price, s.price * (1 - raise_cap)), 2)
            if new_price < s.price * 0.995:
                cuts.append({
                    "sku": s.sku, "product_name": s.product_name, "category": s.canonical_category,
                    "velocity_class": s.velocity_class,
                    "price": round(s.price, 2), "suggested_price": new_price,
                    "current_margin_pct": round(s.margin_pct * 100, 1),
                    "category_margin_pct": round(med * 100, 1),
                    "on_hand": s.on_hand,
                    "frozen_capital": round(s.value_at_cost(), 2),
                })

    raises.sort(key=lambda r: r["est_annual_upside"], reverse=True)
    cuts.sort(key=lambda r: r["frozen_capital"], reverse=True)
    return {
        "as_of": dataset.as_of.isoformat(),
        "category_count": len(cat_med),
        "raise_sku_count": len(raises),
        "est_annual_margin_upside": round(sum(r["est_annual_upside"] for r in raises), 2),
        "raise_list": raises[:top_n],
        "cut_sku_count": len(cuts),
        "cut_frozen_capital": round(sum(r["frozen_capital"] for r in cuts), 2),
        "cut_list": cuts[:top_n],
    }
