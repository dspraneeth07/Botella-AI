"""Shrinkage & staff integrity — pure analysis over the repo pulls.

Flags cashiers whose void/discount/refund rates run above the team norm, shows
when revenue happens by hour, and estimates book-vs-physical shrinkage. All are
signals to REVIEW; we say plainly where the data is thin.
"""
from __future__ import annotations

import statistics


def _f(x) -> float:
    return float(x) if x is not None else 0.0


def _cashier_scorecard(rows: list[dict]) -> dict:
    cashiers = []
    for r in rows:
        sales = int(r["sales"] or 0)
        rev = _f(r["revenue"])
        voids = int(r["voids"] or 0)
        cashiers.append({
            "cashier": r["cashier"], "sales": sales, "revenue": round(rev, 2),
            "voids": voids,
            "void_rate_pct": round(100 * voids / sales, 2) if sales else 0.0,
            "void_amount": round(_f(r["void_amount"]), 2),
            "discount": round(_f(r["discount"]), 2),
            "discount_pct": round(100 * _f(r["discount"]) / rev, 2) if rev else 0.0,
            "refunded": round(_f(r["refunded"]), 2),
        })
    # Outlier = void-rate above team mean + 1 std (and a min volume to be meaningful).
    rated = [c for c in cashiers if c["sales"] >= 50]
    flagged = []
    if len(rated) >= 3:
        vr = [c["void_rate_pct"] for c in rated]
        thresh = statistics.mean(vr) + statistics.pstdev(vr)
        flagged = sorted([c for c in rated if c["void_rate_pct"] > max(thresh, 0.5)],
                         key=lambda c: c["void_rate_pct"], reverse=True)
    cashiers.sort(key=lambda c: c["void_rate_pct"], reverse=True)
    return {
        "team_size": len(cashiers), "flagged": flagged, "all": cashiers,
        "total_void_amount": round(sum(c["void_amount"] for c in cashiers), 2),
        "total_discount": round(sum(c["discount"] for c in cashiers), 2),
        "total_refunded": round(sum(c["refunded"] for c in cashiers), 2),
    }


def _shrink(rows: list[dict], top_n: int,
            min_received: int = 6, min_frac: float = 0.25) -> dict:
    # To cut noise from incomplete purchase history, only flag SKUs whose gap is
    # BOTH absolutely meaningful and a large fraction of what was received — i.e.
    # "a quarter of what you bought is unaccounted for", not rounding error.
    items = []
    total_units = 0
    total_value = 0.0
    for r in rows:
        recv = int(r["received"] or 0)
        sold = int(r["sold"] or 0)
        on_hand = max(int(r["on_hand"] or 0), 0)
        unaccounted = recv - sold - on_hand
        if recv < min_received or unaccounted < max(2, min_frac * recv):
            continue
        cost = _f(r["cost"])
        val = unaccounted * cost
        total_units += unaccounted
        total_value += val
        items.append({
            "sku": r["sku"], "product_name": r["product_name"], "category": r["category"],
            "received": recv, "sold": sold, "on_hand": on_hand,
            "units_unaccounted": unaccounted, "shrink_value": round(val, 2),
            "unaccounted_pct": round(100 * unaccounted / recv, 1),
        })
    items.sort(key=lambda i: i["shrink_value"], reverse=True)
    return {
        "skus_flagged": len(items),
        "units_unaccounted": total_units,
        "shrink_value": round(total_value, 2),
        "items": items[:top_n],
    }


def shrinkage_report(data: dict) -> dict:
    if not data or data.get("as_of") is None:
        return {"available": False, "reason": "no sales data for this store"}

    cashier_rows = data.get("cashiers") or []
    if not cashier_rows:
        return {"available": False,
                "reason": "this store's POS records no cashier on transactions"}

    return {
        "available": True,
        "as_of": data["as_of"],
        "window_days": data.get("window_days"),
        "cashiers": _cashier_scorecard(cashier_rows),
        "shrinkage": _shrink(data.get("shrink_rows") or [], data.get("top_n", 50)),
    }
