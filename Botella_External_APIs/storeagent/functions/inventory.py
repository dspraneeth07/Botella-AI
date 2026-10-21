"""Inventory Intelligence — deterministic fixed-functions.

Pure over an InventoryDataset (no DB access here), so every number is exact,
explainable, and unit-testable. Classification rules are explicit and tunable
via Thresholds; nothing is inferred by a model.

Public functions:
  enrich()            -> compute per-SKU derived metrics + class (call first)
  velocity_classes()  -> fast/normal/slow/dead/never_sold rollup
  dead_stock()        -> in-stock SKUs not moving, ranked by frozen capital + action
  frozen_capital()    -> cash tied up, with category breakdown + cost honesty
  slow_but_premium()  -> slow/dead but high-value bottles to KEEP, not liquidate
"""
from __future__ import annotations

import dataclasses

from ..canonical.brand import extract_brand
from ..config import THRESHOLDS, Thresholds
from .models import InventoryDataset, SkuStat

FAST, NORMAL, SLOW, DEAD, NEVER = "fast", "normal", "slow", "dead", "never_sold"
NON_MOVING = {DEAD, NEVER}

# Selectable analysis windows (days) for the windowed view; None = the default
# long-horizon analysis (velocity over 90d falling back to 365d, dead > 180d).
ANALYSIS_WINDOWS = (30, 60, 90)


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    xs = sorted(values)
    if len(xs) == 1:
        return xs[0]
    k = p * (len(xs) - 1)
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def _daily_velocity(s: SkuStat, window_days: int | None = None) -> float:
    """Units/day at the current rate.

    Default (window_days=None): prefer last 90d, fall back to last year.
    Windowed: units sold within the window / window — no fallback, so the rate
    reflects only the period the owner chose to analyse.
    """
    if window_days is not None:
        units = {30: s.units_30, 60: s.units_60, 90: s.units_90}[window_days]
        return units / float(window_days) if units > 0 else 0.0
    if s.units_90 > 0:
        return s.units_90 / 90.0
    if s.units_365 > 0:
        return s.units_365 / 365.0
    return 0.0


def _windowed_thresholds(t: Thresholds, window_days: int) -> Thresholds:
    """Scale the recency buckets to the chosen analysis window, preserving the
    default 30:90:180 ratios — active = W/6, cooling = W/2, dead = no sale in
    more than W days. Rate/price rules (fast percentile, overstock days-of-
    supply, premium cut) are horizon-independent and stay as configured."""
    return dataclasses.replace(
        t,
        active_max_days=max(1, window_days // 6),
        cooling_max_days=max(2, window_days // 2),
        slow_max_days=window_days,
    )


def enrich(dataset: InventoryDataset, t: Thresholds = THRESHOLDS,
           window_days: int | None = None) -> InventoryDataset:
    if window_days is not None:
        if window_days not in ANALYSIS_WINDOWS:
            raise ValueError(f"window_days must be one of {ANALYSIS_WINDOWS}")
        t = _windowed_thresholds(t, window_days)
    as_of = dataset.as_of
    # Store-relative cutoffs.
    selling_rates = [_daily_velocity(s, window_days) for s in dataset.skus
                     if _daily_velocity(s, window_days) > 0]
    fast_rate_cut = _percentile(selling_rates, t.fast_velocity_percentile)
    prices_in_stock = [s.price for s in dataset.in_stock() if s.price]
    premium_price_cut = max(t.premium_min_price, _percentile(prices_in_stock, t.premium_price_percentile))

    for s in dataset.skus:
        s.daily_velocity = round(_daily_velocity(s, window_days), 4)
        s.days_since_last_sale = (as_of - s.last_sale_date).days if s.last_sale_date else None
        s.days_of_supply = round(s.on_hand / s.daily_velocity, 1) if s.daily_velocity > 0 else None

        dsl = s.days_since_last_sale
        if s.units_365 == 0 and s.last_sale_date is None:
            s.velocity_class = NEVER
        elif dsl is not None and dsl > t.slow_max_days:
            s.velocity_class = DEAD
        elif (dsl is not None and dsl <= t.active_max_days
              and (s.daily_velocity >= fast_rate_cut > 0
                   or (s.days_of_supply is not None and s.days_of_supply < t.fast_max_days_supply))):
            s.velocity_class = FAST
        elif (dsl is not None and dsl > t.cooling_max_days) or \
             (s.days_of_supply is not None and s.days_of_supply > t.overstock_days_supply):
            s.velocity_class = SLOW
        else:
            s.velocity_class = NORMAL

        s.brand = extract_brand(s.product_name)
        s.is_premium = bool(s.price and s.price >= premium_price_cut)
        s.frozen_capital = round(s.value_at_cost(), 2) if (s.velocity_class in NON_MOVING and s.on_hand > 0) else 0.0

    return dataset


# --------------------------------------------------------------------------- #
# Reporting functions
# --------------------------------------------------------------------------- #

def velocity_classes(dataset: InventoryDataset, items_per_class: int = 500) -> dict:
    rollup: dict[str, dict] = {c: {"sku_count": 0, "onhand_units": 0, "value_at_cost": 0.0}
                              for c in (FAST, NORMAL, SLOW, DEAD, NEVER)}
    members: dict[str, list[SkuStat]] = {c: [] for c in rollup}
    for s in dataset.skus:
        if s.on_hand <= 0 and s.velocity_class in NON_MOVING:
            # not stock we hold; still count its class but no capital
            pass
        r = rollup[s.velocity_class]
        r["sku_count"] += 1
        r["onhand_units"] += s.on_hand
        r["value_at_cost"] += s.value_at_cost()
        members[s.velocity_class].append(s)
    # Per-class drill-down (the products behind each bar). Movers rank by how
    # fast they sell; slow/dead/never rank by the money sitting in them.
    for c, rows in members.items():
        if c in (FAST, NORMAL):
            rows.sort(key=lambda s: (-s.units_90, -s.units_365, s.sku))
        else:
            rows.sort(key=lambda s: (-s.value_at_cost(), -s.units_365, s.sku))

    def _item(s: SkuStat) -> dict:
        return {
            "sku": s.sku, "product_name": s.product_name,
            "category": s.canonical_category,
            "on_hand": s.on_hand,
            "value_at_cost": round(s.value_at_cost(), 2),
            "value_at_retail": round(s.value_at_retail(), 2),
            "units_90": s.units_90, "units_365": s.units_365,
            "last_sale_date": s.last_sale_date.isoformat() if s.last_sale_date else None,
            "days_since_last_sale": s.days_since_last_sale,
            "days_of_supply": round(s.days_of_supply, 1) if s.days_of_supply is not None else None,
        }

    for c, r in rollup.items():
        r["value_at_cost"] = round(r["value_at_cost"], 2)
        r["items"] = [_item(s) for s in members[c][:items_per_class]]
    return {
        "as_of": dataset.as_of.isoformat(),
        "total_skus": len(dataset.skus),
        "classes": rollup,
    }


def _fast_mover_index(dataset: InventoryDataset) -> tuple[dict[str, list[SkuStat]], list[SkuStat]]:
    """Fast/normal in-stock movers, indexed by category + a global ranked list,
    for picking a concrete bundle partner for each dead SKU."""
    by_cat: dict[str, list[SkuStat]] = {}
    allm: list[SkuStat] = []
    for s in dataset.skus:
        if s.velocity_class in (FAST, NORMAL) and s.on_hand > 0 and s.daily_velocity > 0:
            by_cat.setdefault(s.canonical_category, []).append(s)
            allm.append(s)
    for lst in by_cat.values():
        lst.sort(key=lambda s: s.daily_velocity, reverse=True)
    allm.sort(key=lambda s: s.daily_velocity, reverse=True)
    return by_cat, allm


def _bundle_partner(s: SkuStat, by_cat: dict[str, list[SkuStat]],
                    allm: list[SkuStat]) -> SkuStat | None:
    """A fast mover to pair the dead SKU with — same category first (natural
    bundle), else the store's top mover overall."""
    for c in by_cat.get(s.canonical_category, []):
        if c.sku != s.sku:
            return c
    for c in allm:
        if c.sku != s.sku:
            return c
    return None


def _suggested_action(s: SkuStat, partner: SkuStat | None) -> str:
    if s.is_premium:
        return "Hold - premium bottle; feature it or move to a visible shelf rather than discount"
    low_value = (s.margin_pct is not None and s.margin_pct <= 0.15) or (s.cost or 0) == 0 and not s.price
    if partner and not low_value:
        pname = (partner.product_name or partner.sku)[:40]
        return f"Bundle with '{pname}' (a fast {partner.canonical_category} mover) or discount ~20-30%"
    if not low_value:
        return "Bundle with a fast mover or discount ~20-30% to recover cash"
    return "Liquidate / clear - low value, freeing shelf space is worth more"


def _dead_row(s: SkuStat, partner: SkuStat | None) -> dict:
    return {
        "sku": s.sku,
        "product_name": s.product_name,
        "category": s.canonical_category,
        "on_hand": s.on_hand,
        "unit_cost": s.cost,
        "cost_source": s.cost_source,
        "frozen_capital": s.frozen_capital,
        "frozen_capital_retail": round(s.value_at_retail(), 2),
        "days_since_last_sale": s.days_since_last_sale,
        "last_sale_date": s.last_sale_date.isoformat() if s.last_sale_date else None,
        "class": s.velocity_class,
        "is_premium": s.is_premium,
        "bundle_with": ({
            "sku": partner.sku, "product_name": partner.product_name,
            "category": partner.canonical_category,
            "daily_velocity": round(partner.daily_velocity, 3),
        } if partner else None),
        "suggested_action": _suggested_action(s, partner),
    }


def dead_stock(dataset: InventoryDataset, limit: int | None = 50) -> dict:
    """Dead in-stock SKUs, split into actionable (liquidate) vs premium-hold.

    'items' is the actionable (non-premium) list ranked by frozen capital — the
    cash you can realistically free. Premium dead bottles are listed separately
    (you usually hold those; they also surface in slow_but_premium()). Each
    actionable item carries a concrete fast-mover to bundle it with.
    """
    items = [s for s in dataset.skus if s.velocity_class in NON_MOVING and s.on_hand > 0]
    # Rank by whichever basis has signal: cost if we have it, else retail value.
    items.sort(key=lambda s: (-s.frozen_capital, -s.value_at_retail(), s.sku))
    actionable = [s for s in items if not s.is_premium]
    premium_hold = [s for s in items if s.is_premium]
    unknown_cost = [s for s in items if s.cost is None]
    cap = lambda xs: (xs[:limit] if limit else xs)
    by_cat, allm = _fast_mover_index(dataset)
    row = lambda s: _dead_row(s, _bundle_partner(s, by_cat, allm))
    return {
        "as_of": dataset.as_of.isoformat(),
        "dead_sku_count": len(items),
        "total_frozen_capital": round(sum(s.frozen_capital for s in items), 2),
        "total_frozen_retail": round(sum(s.value_at_retail() for s in items), 2),
        "actionable_sku_count": len(actionable),
        "actionable_frozen_capital": round(sum(s.frozen_capital for s in actionable), 2),
        "actionable_frozen_retail": round(sum(s.value_at_retail() for s in actionable), 2),
        "premium_hold_sku_count": len(premium_hold),
        "premium_hold_frozen_capital": round(sum(s.frozen_capital for s in premium_hold), 2),
        "unknown_cost_sku_count": len(unknown_cost),
        "unknown_cost_retail_value": round(sum(s.value_at_retail() for s in unknown_cost), 2),
        "items": [row(s) for s in cap(actionable)],
        "premium_hold_items": [row(s) for s in cap(premium_hold)],
    }


def frozen_capital(dataset: InventoryDataset, t: Thresholds = THRESHOLDS) -> dict:
    in_stock = dataset.in_stock()
    total_value = sum(s.value_at_cost() for s in in_stock)
    total_retail = sum(s.value_at_retail() for s in in_stock)
    non_moving = [s for s in in_stock if s.velocity_class in NON_MOVING]
    slow = [s for s in in_stock if s.velocity_class == SLOW]
    frozen_value = sum(s.value_at_cost() for s in non_moving)
    frozen_retail = sum(s.value_at_retail() for s in non_moving)

    by_cat: dict[str, float] = {}
    for s in non_moving:
        by_cat[s.canonical_category] = by_cat.get(s.canonical_category, 0.0) + s.value_at_cost()
    by_cat_sorted = sorted(((c, round(v, 2)) for c, v in by_cat.items()),
                           key=lambda x: x[1], reverse=True)

    imputed = sum(1 for s in in_stock if s.cost_source == "imputed")
    unknown = sum(1 for s in in_stock if s.cost is None)
    measured = len(in_stock) - imputed - unknown
    cost_known = measured + imputed
    coverage_pct = round(100 * cost_known / len(in_stock), 1) if in_stock else 0.0
    # If we can't cost most of the shelf, report at RETAIL price (clearly flagged)
    # so the store still sees real dollars instead of a misleading $0.
    basis = "cost" if coverage_pct >= t.min_cost_coverage_pct else "retail"
    return {
        "as_of": dataset.as_of.isoformat(),
        "in_stock_sku_count": len(in_stock),
        "value_basis": basis,
        "cost_coverage_pct": coverage_pct,
        "total_inventory_value_at_cost": round(total_value, 2),
        "total_inventory_value_at_retail": round(total_retail, 2),
        "frozen_capital_dead": round(frozen_value, 2),
        "frozen_capital_dead_retail": round(frozen_retail, 2),
        "frozen_pct_of_inventory": round(100 * frozen_value / total_value, 1) if total_value
                                   else (round(100 * frozen_retail / total_retail, 1) if total_retail else 0.0),
        "slow_capital": round(sum(s.value_at_cost() for s in slow), 2),
        "slow_capital_retail": round(sum(s.value_at_retail() for s in slow), 2),
        "frozen_by_category": by_cat_sorted,
        "cost_coverage": {
            "measured": measured,
            "imputed": imputed,
            "unknown": unknown,
        },
    }


def slow_but_premium(dataset: InventoryDataset, limit: int | None = 25) -> dict:
    items = [s for s in dataset.in_stock()
             if s.is_premium and s.velocity_class in (SLOW, DEAD, NEVER)]
    items.sort(key=lambda s: s.value_at_cost(), reverse=True)
    rows = [{
        "sku": s.sku,
        "product_name": s.product_name,
        "category": s.canonical_category,
        "on_hand": s.on_hand,
        "price": s.price,
        "unit_cost": s.cost,
        "margin_pct": round(s.margin_pct * 100, 1) if s.margin_pct is not None else None,
        "value_at_cost": round(s.value_at_cost(), 2),
        "days_since_last_sale": s.days_since_last_sale,
        "class": s.velocity_class,
        "note": "Slow but high-value - keep, don't liquidate. Feature or right-size the qty.",
    } for s in (items[:limit] if limit else items)]
    return {
        "as_of": dataset.as_of.isoformat(),
        "premium_slow_sku_count": len(items),
        "premium_slow_value_at_cost": round(sum(s.value_at_cost() for s in items), 2),
        "items": rows,
    }


def brand_concentration(dataset: InventoryDataset, limit: int = 12) -> dict:
    """Roll up capital by brand: where the money sits, and where it's frozen.

    Lets an owner act at the brand level ("$9k of dead Tito's") and see which
    brands they're over-invested in. Uses the brand parsed in enrich(); SKUs with
    no confident brand are pooled under 'Unbranded/Unknown' (and noted honestly).
    """
    in_stock = dataset.in_stock()
    agg: dict[str, dict] = {}
    unknown = 0
    for s in in_stock:
        if not s.brand:
            unknown += 1
            continue
        a = agg.setdefault(s.brand, {"brand": s.brand, "sku_count": 0, "on_hand": 0,
                                     "value_at_cost": 0.0, "value_at_retail": 0.0,
                                     "frozen_capital": 0.0, "frozen_retail": 0.0})
        a["sku_count"] += 1
        a["on_hand"] += s.on_hand
        a["value_at_cost"] += s.value_at_cost()
        a["value_at_retail"] += s.value_at_retail()
        a["frozen_capital"] += s.frozen_capital
        if s.velocity_class in NON_MOVING:
            a["frozen_retail"] += s.value_at_retail()

    brands = list(agg.values())
    for a in brands:
        for k in ("value_at_cost", "value_at_retail", "frozen_capital", "frozen_retail"):
            a[k] = round(a[k], 2)

    # Rank by cost where we have it, else by retail (stores without cost data).
    have_cost = any(b["frozen_capital"] > 0 for b in brands)
    vkey = "value_at_cost" if any(b["value_at_cost"] > 0 for b in brands) else "value_at_retail"
    fkey = "frozen_capital" if have_cost else "frozen_retail"
    by_value = sorted(brands, key=lambda b: b[vkey], reverse=True)
    by_frozen = [b for b in sorted(brands, key=lambda b: b[fkey], reverse=True)
                 if b[fkey] > 0]
    return {
        "as_of": dataset.as_of.isoformat(),
        "branded_sku_count": len(in_stock) - unknown,
        "unbranded_sku_count": unknown,
        "distinct_brands": len(brands),
        "top_brands_by_value": by_value[:limit],
        "top_frozen_brands": by_frozen[:limit],
    }
