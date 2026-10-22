"""Predictive Buying - concrete buy list and don't-buy list.

Turns the demand forecast into action: how many units to order now to cover the
lead time + review period (plus a safety buffer), and which SKUs to STOP buying
(overstocked + declining, or dead). Deterministic; every number traceable to the
demand model and on-hand stock.
"""
from __future__ import annotations

import math
from datetime import date, timedelta

from ..canonical.size import SMALL_FORMAT_MAX_ML, is_small_format
from ..config import FORECAST, THRESHOLDS, ForecastThresholds
from ..forecasting.demand import SkuDemand
from .inventory import _percentile

# Below this much store history, "accelerating" is not a question the data can
# answer: two 28-day windows is the minimum for a recent-vs-earlier ratio.
MIN_TREND_HISTORY_DAYS = 56


def order_quantity(d: SkuDemand, t: ForecastThresholds = FORECAST) -> tuple[int, int]:
    """THE canonical reorder size for one SKU: ``(order_qty, coverage_days)``.

    Every surface that tells the owner how much to buy - the Buying tab, the
    Daily Report action queue, and the AI recommendations' quantity hints -
    must get its number from here, so the same product can never carry two
    different reorder figures. Order enough to cover the delivery lead plus
    the supplier's observed reorder cycle (or the flat review period), with a
    safety buffer, minus what's on hand. The float is settled before rounding
    UP to whole units: ceil is a cliff at every integer, so accumulated dust
    on a target that is truly 13 must not order 14 (see forecast()).
    """
    coverage = d.coverage_days(t)
    demand_cover = d.forecast(coverage, t)
    if demand_cover <= 0:
        return 0, coverage
    safety = demand_cover * t.safety_buffer
    target = demand_cover + safety
    # AN UNKNOWN SHELF CANNOT BE ORDERED AGAINST.
    #
    # This read `max(d.on_hand, 0)`, so a NEGATIVE count - which means the
    # inventory record is broken, not that the shelf is empty - was clamped to
    # zero and the full target was ordered. Marshfield reports stock_qty below
    # zero on 3,657 of its 11,393 SKUs, worst case -91,647, so this was not a
    # theoretical path.
    #
    # Returning 0 is the honest answer: "we cannot size an order without knowing
    # what is on the shelf" is a refusal, and the alternative is a confident
    # order for the entire target.
    if d.on_hand is None or d.on_hand < 0:
        return 0, coverage
    return max(0, math.ceil(round(target - d.on_hand, 9))), coverage


def _buy_row(d: SkuDemand, order_qty: int, coverage: int, dos: float | None,
             t: ForecastThresholds, today: date) -> dict:
    lead = t.lead_time_days
    # The forward-looking fields (order_by, run_out, stockout_risk) run at the
    # PROJECTED pace - trend included, the same pace the order quantity is
    # sized on - so a row never mixes two paces (days_of_supply stays the
    # un-trended classification figure, labeled as such, with `trend` beside
    # it). order_by is an instruction to a human acting in WALL-CLOCK time:
    # when the data frontier lags (or a fast seller is already inside its lead
    # window), the engine date lands in the past - clamp to today so the owner
    # reads "order today", never "the reorder date was three days ago".
    # run_out is the transparency companion: the day stock hits zero at the
    # projected pace, so the owner sees WHY the order date is what it is.
    dos_t = d.days_of_supply_at_trend(t)
    order_by_in = max(0, int((dos_t - lead))) if dos_t is not None else 0
    order_by = max(d.as_of + timedelta(days=order_by_in), today)
    run_out = (d.as_of + timedelta(days=int(dos_t))) if dos_t is not None else None
    return {
        "sku": d.sku, "product_name": d.product_name, "category": d.category,
        "on_hand": max(d.on_hand, 0),
        "forecast_units_coverage": round(d.forecast(coverage), 1),
        "coverage_days": coverage,
        "order_qty": order_qty,
        "unit_cost": d.cost,
        "order_value": round(order_qty * (d.cost or 0.0), 2),
        "days_of_supply": round(dos, 1) if dos is not None else None,
        "order_by": order_by.isoformat(),
        "run_out": run_out.isoformat() if run_out is not None else None,
        "stockout_risk": dos_t is not None and dos_t < coverage,
        "trend": round(d.trend_factor(t), 2),
        "supplier": d.supplier_name,
        "reorder_cycle_days": d.reorder_cycle_days,
        "lead_time_days": t.lead_time_days,
        "units_90": d.units_90,
        "last_sold": d.last_sale.isoformat() if d.last_sale else None,
        "last_bought": d.last_purchase_date.isoformat() if d.last_purchase_date else None,
    }


def buy_recommendations(demands: list[SkuDemand], as_of: date,
                        t: ForecastThresholds = FORECAST, top_n: int = 500,
                        today: date | None = None,
                        small_format_max_ml: float = SMALL_FORMAT_MAX_ML) -> dict:
    # `today` = the wall-clock date order_by dates are clamped to (tests pin
    # it; production omits it). Distinct from `as_of`, the data frontier.
    today = today or date.today()

    # Minis never make the buy list or the accelerating list: a nip's unit
    # count outruns every real bottle on the shelf, so it wins a rate-ranked
    # list on format alone. The DON'T-BUY list deliberately still shows them
    # - cash frozen in dead nips is a fact the owner should keep seeing.
    def _mini(d: SkuDemand) -> bool:
        return is_small_format(d.product_name, category=d.category,
                               max_ml=small_format_max_ml)
    default_coverage = t.lead_time_days + t.review_period_days
    buy: list[dict] = []
    dont: list[dict] = []

    # The buy list is FAST SELLERS ONLY - same store-relative rule as the
    # Inventory tab's "Fast" class, so the two views agree: sold within the
    # last 30 days AND (top-20% selling rate among products that sell, or
    # under ~3 weeks of stock at the current rate).
    fast_rates = [r for d in demands if (r := d.base_daily()) > 0]
    fast_cut = _percentile(fast_rates, THRESHOLDS.fast_velocity_percentile)

    for d in demands:
        on_hand = max(d.on_hand, 0)
        dos = d.days_of_supply()
        days_since = (as_of - d.last_sale).days if d.last_sale else None
        days_since_bought = (as_of - d.last_purchase_date).days if d.last_purchase_date else None
        declining = 0 < d.trend_factor(t) < t.decline_factor
        is_dead = (d.units_365 == 0) or (days_since is not None and days_since > t.overstock_days_supply)

        # ---- DON'T BUY: dead, or overstocked & declining ----
        if on_hand > 0 and (is_dead or (declining and dos is not None and dos > t.overstock_days_supply)):
            sold_txt = f"no sale in {days_since}d" if days_since is not None else "never sold"
            dos_txt = f"{int(dos)} days of supply on hand" if dos is not None else f"{on_hand} units on hand"
            if is_dead:
                reason = f"Stop ordering - {sold_txt}; {dos_txt}. Cash is frozen and demand is gone."
            else:
                reason = (f"Stop ordering - {dos_txt} and demand is falling "
                          f"(selling at {round(d.trend_factor(t), 2)}x its lifetime pace).")
            dont.append({
                "sku": d.sku, "product_name": d.product_name, "category": d.category,
                "on_hand": on_hand, "days_of_supply": round(dos, 1) if dos is not None else None,
                "trend": round(d.trend_factor(t), 2),
                "capital_tied": round(on_hand * (d.cost or 0.0), 2),
                "supplier": d.supplier_name,
                "units_365": d.units_365,
                "last_sold": d.last_sale.isoformat() if d.last_sale else None,
                "days_since_sold": days_since,
                "last_bought": d.last_purchase_date.isoformat() if d.last_purchase_date else None,
                "days_since_bought": days_since_bought,
                "reason": reason,
            })
            continue

        # ---- BUY: enough demand, and coverage demand exceeds what's on hand ----
        if d.units_90 < t.min_units_90_to_buy:
            continue
        # Fast sellers only (see fast_cut above): recently sold + high rate or
        # nearly out. Everything else is deliberately left off the buy list.
        is_fast = (days_since is not None and days_since <= THRESHOLDS.active_max_days
                   and (d.base_daily() >= fast_cut > 0
                        or (dos is not None and dos < THRESHOLDS.fast_max_days_supply)))
        if not is_fast:
            continue
        # Per-supplier coverage: order enough to last until the next realistic
        # reorder from THIS SKU's supplier (observed cadence), not a flat window.
        # order_quantity() is this TAB's reorder formula. It was the one
        # formula, shared with the recommendation cards so both surfaces quoted
        # one number - and that is no longer true, so the comment should not
        # keep saying it.
        #
        # The cards now size orders with `app/pipeline/policy/inventory.py`,
        # fed by the ensemble's p10/p50/p90, because the formula below takes a
        # POINT forecast and multiplies it by a flat safety_buffer - and a
        # buffer is a statement about dispersion, which a point estimate does
        # not have. Measured against the real forecaster it over-buys a
        # predictable SKU (67 where the policy says 59) and under-buys a
        # volatile one (25 where the policy says 49).
        #
        # WHY THIS TAB HAS NOT MOVED WITH THEM: the policy needs a per-SKU
        # DAILY series and this tab's pull has none. `forecast_repo` gives
        # SkuDemand weekday totals (d0..d6) and 28/90/365-day aggregates, and
        # `fetch_store_daily` is store-wide rather than per-SKU. Getting one
        # here means a new 365-day per-SKU query against the remote warehouse
        # on a user-facing path, when the right source is analytics
        # `feature_daily` - which is what the backtest already reads. That is a
        # separate change, and until it lands this tab and a card can quote
        # different numbers for the same SKU.
        if _mini(d):
            continue
        order_qty, coverage = order_quantity(d, t)
        if order_qty > 0:
            buy.append(_buy_row(d, order_qty, coverage, dos, t, today))

    # Rank: stockout risk first, then by order value (cash + importance).
    buy.sort(key=lambda r: (r["stockout_risk"], r["order_value"]), reverse=True)
    dont.sort(key=lambda r: r["capital_tied"], reverse=True)

    # ---- Demand heating up: accelerating sellers to prioritize ----
    # Three gates, because "trend >= 1.3" alone let two kinds of impostor
    # through. (1) A SKU that stopped selling can still carry a high 90d-vs-year
    # ratio for weeks, so it must also be selling NOW: sold within 30 days (the
    # buy list's own rule) and holding at least its baseline pace over the last
    # 28. (2) A brand-new listing used to score the 3.0 clamp ceiling
    # automatically - units_90 == units_365 divided by a year it wasn't stocked
    # for. Shelf-age-aware rates kill that; what survives for a young SKU is a
    # real ramp inside its own short life.
    accel: list[dict] = []
    for d in demands:
        trend = d.trend_factor(t)
        rf28 = d.recent_factor(t)
        days_since = (as_of - d.last_sale).days if d.last_sale else None
        if trend < 1.3 or d.units_90 < 6:
            continue
        if days_since is None or days_since > THRESHOLDS.active_max_days:
            continue
        if rf28 < 1.0:
            continue
        if _mini(d):
            continue
        dos = d.days_of_supply_at_trend(t)
        base_dos = d.days_of_supply()
        accel.append({
            "sku": d.sku, "product_name": d.product_name, "category": d.category,
            "trend": round(trend, 2), "units_28": d.units_28, "units_90": d.units_90,
            "units_365": d.units_365,
            # Expected units over the next 30 days: each day's weekday-average
            # demand scaled by the trend factor. Same forecast the reorder math
            # uses, so the projection moves WITH the trend.
            "proj_30d": round(d.forecast(30, t), 1),
            "on_hand": max(d.on_hand, 0),
            # Cover at the PROJECTED pace, so supply and proj_30d agree on this
            # row; days_of_supply_base is the un-trended figure the Inventory
            # tab classifies on, kept for traceability.
            "days_of_supply": round(dos, 1) if dos is not None else None,
            "days_of_supply_base": round(base_dos, 1) if base_dos is not None else None,
            "supplier": d.supplier_name,
            "stockout_risk": dos is not None and dos < default_coverage,
            # Why this row's trend is believable: which window it came from, how
            # long the SKU has been on the shelf, and both components.
            "trend_basis": d.trend_basis(),
            "days_live": d.days_live,
            "trend_90d": round(d.recency_factor(t), 2),
            "trend_28d": round(rf28, 2),
            "days_since_sold": days_since,
        })
    # rounded trend + sku tiebreak: deterministic and SQL-reproducible
    accel.sort(key=lambda a: (-a["trend"], -a["units_90"], a["sku"]))

    # An empty list has two very different causes and the UI must not render
    # them the same way (or, worse, hide the section). A trend is a RATIO of a
    # recent window to an earlier one, so a store whose whole sales history is
    # shorter than two 28-day windows cannot produce one: recent rate and
    # lifetime rate are the same number, and every SKU scores exactly 1.00.
    # That is a fact about the data feed, not a finding about the products.
    history_days = max((d.days_live for d in demands), default=0)
    if accel:
        accel_status, accel_reason = "opportunities", None
    elif history_days < MIN_TREND_HISTORY_DAYS:
        accel_status = "insufficient_history"
        accel_reason = (f"only {history_days} days of sales history - measuring "
                        f"acceleration needs a recent window to compare against "
                        f"an earlier one")
    else:
        accel_status = "healthy"
        accel_reason = "no product is outselling its own baseline right now"

    suppliers = {r["supplier"] for r in buy if r.get("supplier")}
    return {
        "as_of": as_of.isoformat(),
        "coverage_days": default_coverage,
        "supplier_aware_sku_count": sum(1 for r in buy if r["reorder_cycle_days"]),
        "lead_time_days": t.lead_time_days,
        "buy_sku_count": len(buy),
        "buy_total_value": round(sum(r["order_value"] for r in buy), 2),
        "buy_units_total": sum(r["order_qty"] for r in buy),
        "buy_urgent_count": sum(1 for r in buy if r["stockout_risk"]),
        "supplier_count": len(suppliers),
        "dont_buy_sku_count": len(dont),
        "dont_buy_capital_tied": round(sum(r["capital_tied"] for r in dont), 2),
        "dont_buy_units_total": sum(r["on_hand"] for r in dont),
        "dont_buy_dead_count": sum(1 for r in dont if r["units_365"] == 0),
        "accelerating_count": len(accel),
        # Why the list is the length it is - so an empty section can say so
        # instead of vanishing. history_days is the store's own sales span.
        "accelerating_status": accel_status,
        "accelerating_reason": accel_reason,
        "history_days": history_days,
        "buy_list": buy[:top_n],
        "dont_buy_list": dont[:top_n],
        "accelerating": accel[:40],
    }
