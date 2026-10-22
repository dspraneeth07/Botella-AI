"""Grounded narration: compact facts in, owner-friendly prose out.

The model receives ONLY the deterministic numbers (as JSON) and a hard rule:
quote those figures, never invent new ones. We trim each capability's payload to
the handful of narratable facts so the prompt is small, cheap, and auditable.
"""
from __future__ import annotations

import json
import re

from ..config import NARRATION, NarrationConfig
from .client import NarrationError, complete

SYSTEM = """You are StoreAgent, an AI advisor for an independent liquor-store owner.
You will be given a JSON object of FACTS that were computed by deterministic
analytics functions over the store's own sales ledger.

Hard rules:
- Use ONLY numbers that appear in the FACTS. Never invent, round differently, or
  extrapolate a figure that is not present.
- Lead with money and action. The owner wants to know what to DO and what it is
  worth, not how the math works.
- Be concrete and specific: name the products/customers and dollar amounts in the
  FACTS. No filler, no generic retail advice.
- Plain, confident, friendly shopkeeper-to-shopkeeper tone. No emojis, no jargon.

Format: 2-4 short paragraphs OR a few tight bullet lines. Under 180 words. Do not
restate the data as a table; interpret it and tell the owner the next move."""

_INSTRUCTIONS = {
    "inventory": "Brief the owner on cash tied up in stock and money left on the table. "
                 "Prioritise the single biggest action.",
    "buying": "Tell the owner what to reorder now (and why it's urgent), what to stop "
              "buying, and what stockouts are costing per day.",
    "customers": "Tell the owner which regulars are slipping away, what that's worth per "
                 "year, and who to call first.",
    "loss": "Flag the doubtful sales worth reviewing - items rung up as free, below-cost "
            "sales, voids, returns - and the dollar exposure. Be careful: these are signals "
            "to review, not proof of theft. Tell the owner what to check first.",
    "lossprev": "One loss-prevention read: doubtful sales at the register (items rung as "
                "free, below-cost, voids, returns) AND stock/staff signals (cashier "
                "void-rate outliers, bought-sold-on-shelf gaps). All are signals to "
                "REVIEW, never proof of theft. Tell the owner the one or two things to "
                "check first, with the dollar exposure.",
    "pricing": "Tell the owner where to raise prices (under-priced fast movers) for the "
               "biggest annual margin gain, and which over-priced slow movers to cut. Lead "
               "with the total upside and the top few moves.",
    "basket": "Tell the owner which products sell together so they can bundle, co-locate, "
              "and cross-sell. Lead with the strongest, most actionable pairings.",
    "overview": "Give the owner a tight morning read on the business: revenue and its trend, "
                "margin, basket size, and the top movers. Call out what's notable.",
    "shrinkage": "Tell the owner which cashiers to review (above-norm voids/discounts) and the "
                 "book-vs-physical shrinkage exposure. These are signals to review, not proof.",
    "market": "Tell the owner which products nearby stores sell well that THEY don't carry, and "
              "make a strong, specific case to stock the top few - how many nearby stores sell it "
              "and the projected annual profit. Note the projection is conservative.",
}


def _money_facts_inventory(result: dict) -> dict:
    fc = result["frozen_capital"]
    vc = result["velocity_classes"]["classes"]
    ds = result["dead_stock"]
    ml = result.get("money_leaks") or {}
    brands = (result.get("brand_concentration") or {}).get("top_frozen_brands", [])
    return {
        "store": result.get("store_label") or f"{result['client_id']}/{result['location_id']}",
        "as_of": result.get("as_of"),
        "total_inventory_at_cost": fc["total_inventory_value_at_cost"],
        "frozen_in_dead_stock": fc["frozen_capital_dead"],
        "frozen_pct_of_inventory": fc["frozen_pct_of_inventory"],
        "tied_in_slow_overstock": fc["slow_capital"],
        "sku_counts": {k: vc[k]["sku_count"] for k in vc},
        "actionable_dead_skus": ds["actionable_sku_count"],
        "freeable_cash": ds["actionable_frozen_capital"],
        "top_dead_items": [
            {"name": it["product_name"] or it["sku"], "frozen": it["frozen_capital"],
             "days_since_sale": it["days_since_last_sale"], "action": it["suggested_action"]}
            for it in ds.get("items", [])[:5]
        ],
        "top_frozen_brands": brands[:5],
        "money_leaks": {
            "recoverable": ml.get("recoverable_estimate"),
            "recoverable_note": "high-confidence figure; excludes markdowns whose effect is uncertain",
            "recoverable_upper_bound": ml.get("recoverable_upper_bound"),
            "wasted_discounts": ml.get("wasted_discount_estimate"),
            "wasted_pct": ml.get("wasted_discount_pct_of_total"),
            "below_cost_loss": ml.get("below_cost_loss"),
            "below_cost_sales": ml.get("below_cost_lines"),
            "priced_to_lose_skus": ml.get("priced_to_lose_sku_count"),
            "elasticity_confirmed_waste": ml.get("elasticity_confirmed_waste"),
            "top_wasted": [
                {"name": it["product_name"] or it["sku"], "given_away": it["discount_given"],
                 "class": it["velocity_class"], "discount_share_pct": it.get("discount_share_pct"),
                 "confidence": it.get("confidence")}
                for it in ml.get("top_wasted_discounts", [])[:3]
            ],
        } if ml else None,
    }


def _money_facts_buying(result: dict) -> dict:
    buy = result["buying"]
    bt = result.get("forecast_backtest") or {}
    lost = result.get("lost_sales") or {}
    return {
        "store": result.get("store_label") or f"{result['client_id']}/{result['location_id']}",
        "as_of": result.get("as_of"),
        "forecast_accuracy_pct": bt.get("accuracy_pct"),
        "forecast_wape_pct": bt.get("wape_pct"),
        "coverage_days": buy["coverage_days"],
        "lead_time_days": buy["lead_time_days"],
        "buy_sku_count": buy["buy_sku_count"],
        "buy_total_value": buy["buy_total_value"],
        "urgent_count": buy["buy_urgent_count"],
        "top_buys": [
            {"name": r["product_name"] or r["sku"], "order_qty": r["order_qty"],
             "order_value": r["order_value"], "on_hand": r["on_hand"],
             "order_by": r["order_by"], "urgent": r["stockout_risk"],
             "lead_time_days": r.get("lead_time_days"), "supplier": r.get("supplier")}
            for r in buy["buy_list"][:6]
        ],
        "dont_buy_sku_count": buy["dont_buy_sku_count"],
        "capital_tied_in_dont_buy": buy["dont_buy_capital_tied"],
        "lost_sales": {
            "stockout_skus": lost.get("stockout_sku_count"),
            "daily_loss": lost.get("ongoing_daily_loss"),
            "revenue_missed": lost.get("lost_revenue_estimate"),
        } if lost.get("stockout_sku_count") else None,
    }


def _money_facts_customers(result: dict) -> dict:
    radar = result["customer_radar"]
    if not radar.get("available"):
        return {"available": False, "reason": radar.get("reason")}
    return {
        "store": result.get("store_label") or f"{result['client_id']}/{result['location_id']}",
        "as_of": result.get("as_of"),
        "available": True,
        "total_customers": radar["total_customers"],
        "at_risk_count": radar["at_risk_count"],
        "annual_revenue_at_risk": radar["annual_revenue_at_risk"],
        "win_back_first": [
            {"name": c["name"] or f"cust {c['customer_id'][:8]}", "visits": c["visits"],
             "annual_value": c["annual_value"], "days_since_last": c["days_since_last"],
             "usual_gap_days": round(c["cadence_days"]), "likes": c.get("favorite_category")}
            for c in radar["win_back"][:6]
        ],
    }


def _money_facts_loss(result: dict) -> dict:
    loss = result["loss"]
    if not loss.get("available"):
        return {"available": False, "reason": loss.get("reason")}
    s = loss["signals"]
    return {
        "store": result.get("store_label"),
        "as_of": result.get("as_of"),
        "available": True,
        "window_days": loss["window_days"],
        "review_exposure": loss["review_exposure"],
        "flagged_lines": loss["flagged_line_count"],
        "rung_as_free": {
            "lines": s["free_giveaways"]["lines"],
            "value_given_away": s["free_giveaways"]["value_given_away"],
            "recent_lines": s["free_giveaways"]["recent_lines"],
            "top": [{"name": it["product_name"] or it["sku"], "units": it["units"],
                     "given": it["value_given_away"]}
                    for it in s["free_giveaways"]["items"][:5]],
        },
        "below_cost": {"lines": s["below_cost"]["lines"], "margin_lost": s["below_cost"]["margin_lost"]},
        "voids": {"sales": s["voids"]["sales"], "amount": s["voids"]["amount"],
                  "recent_sales": s["voids"]["recent_sales"]},
        "returns": {"lines": s["returns"]["lines"], "amount": s["returns"]["amount"]},
    }


def _money_facts_pricing(result: dict) -> dict:
    pr = result["pricing"]
    return {
        "store": result.get("store_label"), "as_of": result.get("as_of"),
        "est_annual_margin_upside": pr["est_annual_margin_upside"],
        "raise_sku_count": pr["raise_sku_count"],
        "cut_sku_count": pr["cut_sku_count"], "cut_frozen_capital": pr["cut_frozen_capital"],
        "top_raises": [{"name": r["product_name"] or r["sku"], "from": r["price"],
                        "to": r["suggested_price"], "annual_upside": r["est_annual_upside"],
                        "margin": r["current_margin_pct"], "category_margin": r["category_margin_pct"]}
                       for r in pr["raise_list"][:6]],
        "top_cuts": [{"name": r["product_name"] or r["sku"], "from": r["price"],
                      "to": r["suggested_price"], "on_hand": r["on_hand"]}
                     for r in pr["cut_list"][:4]],
    }


def _money_facts_basket(result: dict) -> dict:
    b = result["basket"]
    if not b.get("available"):
        return {"available": False, "reason": b.get("reason")}
    return {
        "store": result.get("store_label"), "as_of": result.get("as_of"), "available": True,
        "total_baskets": b["total_baskets"],
        "top_bundles": [{"a": p["a_name"], "b": p["b_name"], "lift": p["lift"],
                         "confidence_a_to_b": p["confidence_a_to_b"], "together": p["together_count"]}
                        for p in b["top_bundles"][:8]],
    }


def _money_facts_overview(result: dict) -> dict:
    o = result["overview"]
    if not o.get("available"):
        return {"available": False, "reason": o.get("reason")}
    pl = o.get("pulse") or {}
    an = o.get("anomalies") or {}
    return {
        "store": result.get("store_label"), "as_of": result.get("as_of"), "available": True,
        "total_opportunity": o.get("total_opportunity"),
        "action_queue": [{"rank": a["rank"], "title": a["title"], "value": a["value"],
                          "value_label": a["value_label"], "severity": a["severity"],
                          "recommendation": a["recommendation"]}
                         for a in (o.get("action_queue") or [])],
        "pulse": {"revenue_mom_pct": pl.get("revenue_mom_pct"),
                  "gross_margin_pct": pl.get("gross_margin_pct"),
                  "avg_basket_value": pl.get("avg_basket_value")},
        "sliding": [{"name": d["product_name"], "change_pct": d["change_pct"]} for d in an.get("declining", [])[:4]],
        "surging": [{"name": s["product_name"], "change_pct": s["change_pct"]} for s in an.get("surging", [])[:4]],
    }


def _money_facts_shrinkage(result: dict) -> dict:
    sh = result["shrinkage_report"]
    if not sh.get("available"):
        return {"available": False, "reason": sh.get("reason")}
    c = sh["cashiers"]
    sk = sh["shrinkage"]
    return {
        "store": result.get("store_label"), "as_of": result.get("as_of"), "available": True,
        "team_size": c["team_size"],
        "flagged_cashiers": [{"cashier": f["cashier"], "void_rate_pct": f["void_rate_pct"],
                              "voids": f["voids"], "sales": f["sales"], "discount_pct": f["discount_pct"]}
                             for f in c["flagged"][:5]],
        "shrinkage_value": sk["shrink_value"], "shrink_skus": sk["skus_flagged"],
        "top_shrink": [{"name": it["product_name"] or it["sku"], "received": it["received"],
                        "sold": it["sold"], "on_hand": it["on_hand"],
                        "unaccounted": it["units_unaccounted"], "value": it["shrink_value"]}
                       for it in sk["items"][:5]],
    }


def _money_facts_market(result: dict) -> dict:
    mk = result["market"]
    if not mk.get("available"):
        return {"available": False, "reason": mk.get("reason")}
    g = mk.get("geo") or {}
    return {
        "store": result.get("store_label"), "as_of": result.get("as_of"), "available": True,
        "location": g.get("location_name"), "city": g.get("city"), "state": g.get("state"),
        "peer_tier": mk["peer_tier"], "peer_count": mk["peer_count"],
        "opportunity_count": mk["opportunity_count"],
        "total_projected_profit": mk["total_projected_profit"],
        "top_opportunities": [{"name": o["product_name"], "nearby_stores": o["peer_stores"],
                               "peer_units": o["peer_units"], "price": o["avg_price"],
                               "projected_annual_profit": o["projected_annual_profit"],
                               "est_annual_units": o["est_annual_units"]}
                              for o in mk["opportunities"][:8]],
    }


_FACTS = {
    "inventory": _money_facts_inventory,
    "buying": _money_facts_buying,
    "customers": _money_facts_customers,
    "loss": _money_facts_loss,
    "lossprev": lambda result: {
        "at_the_register": _money_facts_loss(result),
        "stock_and_staff": _money_facts_shrinkage(result),
    },
    "pricing": _money_facts_pricing,
    "basket": _money_facts_basket,
    "overview": _money_facts_overview,
    "shrinkage": _money_facts_shrinkage,
    "market": _money_facts_market,
}


def build_facts(capability: str, result: dict) -> dict:
    builder = _FACTS.get(capability)
    if builder is None:
        raise ValueError(f"Unknown capability for narration: {capability}")
    return builder(result)


def narration_available(cfg: NarrationConfig = NARRATION) -> bool:
    return cfg.enabled


# ---------------------------------------------------------------------------
# Numeric grounding check. The SYSTEM prompt's "use ONLY numbers in the FACTS"
# is an instruction, not a guarantee - this makes it one. Every number the
# model wrote must appear in the FACTS payload (exactly, or as a plain
# rounding of a fact value); otherwise the narration is dropped and the UI
# falls back to the deterministic briefing. A missing paragraph costs nothing;
# a confident wrong dollar figure costs trust in every real one.
# ---------------------------------------------------------------------------

_NUM_TOKEN = re.compile(r"\d[\d,]*(?:\.\d+)?")
# Small counts read as language, not data: "your top 3", "one of two cashiers",
# "first 5 items" - enumeration the model derives from list LENGTHS, which the
# facts never carry as literals. Bounded low so real quantities stay checked.
_SMALL_COUNT_MAX = 12


def _numbers_in_text(text: str) -> list[float]:
    out: list[float] = []
    for m in _NUM_TOKEN.finditer(text or ""):
        try:
            out.append(float(m.group().replace(",", "")))
        except ValueError:  # pragma: no cover - the regex shouldn't allow this
            pass
    return out


def _fact_numbers(node: object) -> set[float]:
    """Every number a FACTS payload can justify: numeric leaves (plus their
    plain roundings - "about $4,613" for 4612.75 is quoting, not inventing)
    and numbers embedded in string leaves (dates, "24/12" pack names)."""
    nums: set[float] = set()
    if isinstance(node, bool):
        return nums
    if isinstance(node, (int, float)):
        v = float(node)
        nums.update({v, float(round(v)), round(v, 1), round(v, 2), abs(v)})
        return nums
    if isinstance(node, str):
        nums.update(_numbers_in_text(node))
        return nums
    if isinstance(node, dict):
        for v in node.values():
            nums |= _fact_numbers(v)
    elif isinstance(node, (list, tuple)):
        for v in node:
            nums |= _fact_numbers(v)
    return nums


def ungrounded_numbers(text: str, facts: dict) -> list[float]:
    """Numbers in the narration that the FACTS cannot justify (deduped, in
    order of first appearance). Empty list = the prose is fully grounded."""
    allowed = _fact_numbers(facts)
    bad: list[float] = []
    for n in _numbers_in_text(text):
        if n in allowed or n in bad:
            continue
        if n == int(n) and 0 <= n <= _SMALL_COUNT_MAX:
            continue
        bad.append(n)
    return bad


def narrate_capability(capability: str, result: dict,
                       cfg: NarrationConfig = NARRATION) -> dict:
    """Return {available, text, model, error}. Never raises - narration is additive."""
    facts = build_facts(capability, result)
    instruction = _INSTRUCTIONS.get(capability, "Brief the owner on these facts.")
    user = (f"{instruction}\n\nFACTS (the only numbers you may use):\n"
            f"{json.dumps(facts, default=str, indent=2)}")
    try:
        text = complete(SYSTEM, user, cfg=cfg)
    except NarrationError as e:
        return {"available": False, "text": None, "error": str(e)}
    bad = ungrounded_numbers(text, facts)
    if bad:
        return {
            "available": False,
            "text": None,
            "error": "narration_ungrounded: model wrote numbers not in FACTS: "
                     + ", ".join(f"{n:g}" for n in bad[:8]),
        }
    return {"available": True, "text": text, "error": None}
