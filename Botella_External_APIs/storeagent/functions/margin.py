"""Money-Leak Finder — deterministic functions over margin/discount aggregates.

Finds cash a POS never surfaces: markdowns that weren't needed, sales below cost,
and SKUs priced to lose. Pure over the rows from margin_repo + a velocity-class
map (so we can tell "clearing slow stock" discounts from wasteful ones).

Heuristic, stated openly: a discount on a SKU that is already FAST/NORMAL was
probably unnecessary (it would have sold at full price); a discount on SLOW/DEAD
stock is legitimate clearance. We quantify the former as "likely-wasted".
"""
from __future__ import annotations

from ..config import MARGIN, MarginThresholds
from ..functions.inventory import FAST, NORMAL

SELLING_WELL = {FAST, NORMAL}


def _f(x) -> float:
    return float(x) if x is not None else 0.0


def money_leaks(rows: list[dict], class_map: dict[str, str],
                window_days: int = 365, top_n: int = 500,
                t: MarginThresholds = MARGIN) -> dict:
    total_discount = sum(_f(r["discount"]) for r in rows)
    gross_margin = sum(_f(r["margin_dollars"]) for r in rows)  # revenue - cost (costed lines)

    # --- 1) Likely-wasted discounts: markdowns on SKUs that sell well anyway ---
    # Price-elasticity sharpening: a markdown on a well-selling SKU is "confirmed"
    # waste only when a small share of its units actually needed the discount to
    # move (it sells fine at full price). If most units were discounted, the
    # markdown may be doing real work -> we flag it "uncertain" instead.
    wasted = [r for r in rows
              if _f(r["discount"]) > 0 and class_map.get(r["sku"]) in SELLING_WELL]
    wasted_discount = sum(_f(r["discount"]) for r in wasted)

    def discount_share(r) -> float | None:
        units = _f(r["units"])
        if units < t.min_units_for_elasticity:
            return None
        return _f(r["units_discounted"]) / units if units else None

    def is_confirmed(r) -> bool:
        sh = discount_share(r)
        return sh is not None and sh <= t.confirmed_waste_max_discount_share

    confirmed_waste = sum(_f(r["discount"]) for r in wasted if is_confirmed(r))

    def _wasted_row(r) -> dict:
        sh = discount_share(r)
        ud = _f(r["units_discounted"])
        return {
            "sku": r["sku"], "product_name": r["product_name"],
            "category": r["category"], "velocity_class": class_map.get(r["sku"]),
            "discount_given": round(_f(r["discount"]), 2),
            "units": int(_f(r["units"])),
            "units_discounted": int(ud),
            "discount_share_pct": round(100 * sh, 1) if sh is not None else None,
            "avg_discount_depth": round(_f(r["discount"]) / ud, 2) if ud else None,
            "confidence": ("confirmed" if is_confirmed(r)
                           else "uncertain" if sh is not None else "low-volume"),
        }

    # Surface confirmed waste first (highest-confidence cash), then by $ given.
    wasted.sort(key=lambda r: (is_confirmed(r), _f(r["discount"])), reverse=True)
    top_wasted = [_wasted_row(r) for r in wasted[:top_n]]

    # --- 2) Below-cost sales: sold for less than it cost you ---
    below_cost_loss = sum(_f(r["below_cost_loss"]) for r in rows)
    below_cost_lines = sum(int(_f(r["below_cost_lines"])) for r in rows)
    bc = [r for r in rows if _f(r["below_cost_loss"]) > 0]
    bc.sort(key=lambda r: _f(r["below_cost_loss"]), reverse=True)
    top_below_cost = [{
        "sku": r["sku"], "product_name": r["product_name"],
        "category": r["category"],
        "margin_lost": round(_f(r["below_cost_loss"]), 2),
        "below_cost_lines": int(_f(r["below_cost_lines"])),
        "unit_cost": _f(r["cost"]), "unit_price": _f(r["price"]),
    } for r in bc[:top_n]]

    # --- 3) Priced-to-lose: regular price below cost (a pricing error) ---
    neg = [r for r in rows if _f(r["cost"]) > 0 and _f(r["price"]) > 0
           and _f(r["price"]) < _f(r["cost"])]
    neg.sort(key=lambda r: _f(r["cost"]) - _f(r["price"]), reverse=True)
    priced_to_lose = [{
        "sku": r["sku"], "product_name": r["product_name"],
        "price": _f(r["price"]), "cost": _f(r["cost"]),
        "loss_per_unit": round(_f(r["cost"]) - _f(r["price"]), 2),
    } for r in neg[:top_n]]

    # Headline recoverable $ = only what we're CONFIDENT about: confirmed-wasted
    # markdowns + below-cost losses, counted once. (A discounted line that also
    # went below cost would otherwise be summed in both buckets, and the
    # elasticity-"uncertain" half of the wasted discounts is excluded — the
    # markdown may be doing real work there.) The everything-included figure is
    # still published, explicitly labeled as an upper bound.
    overlap = sum(min(_f(r["discount"]), _f(r["below_cost_loss"]))
                  for r in wasted if is_confirmed(r) and _f(r["below_cost_loss"]) > 0)
    recoverable = round(max(confirmed_waste + below_cost_loss - overlap, 0.0), 2)
    return {
        "window_days": window_days,
        "gross_margin_dollars": round(gross_margin, 2),
        "total_discount_given": round(total_discount, 2),
        "wasted_discount_estimate": round(wasted_discount, 2),
        "wasted_discount_pct_of_total": round(100 * wasted_discount / total_discount, 1) if total_discount else 0.0,
        "elasticity_confirmed_waste": round(confirmed_waste, 2),
        "elasticity_uncertain_waste": round(wasted_discount - confirmed_waste, 2),
        "below_cost_loss": round(below_cost_loss, 2),
        "below_cost_lines": below_cost_lines,
        "priced_to_lose_sku_count": len(neg),
        "recoverable_estimate": recoverable,
        "recoverable_upper_bound": round(wasted_discount + below_cost_loss, 2),
        "top_wasted_discounts": top_wasted,
        "top_below_cost": top_below_cost,
        "priced_to_lose": priced_to_lose,
    }
