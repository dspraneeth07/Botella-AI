"""Executive Overview — business pulse + 'what changed' anomaly detection.

The ranked action queue is assembled in the pipeline (it orchestrates the other
engines). Here we compute the cheap, differentiated signals: a momentum-aware
pulse and the SKUs quietly sliding or surging that an owner would otherwise miss.
"""
from __future__ import annotations


def _f(x) -> float:
    return float(x) if x is not None else 0.0


def _i(x) -> int:
    return int(x) if x is not None else 0


def _momentum(rows: list[dict], min_base: int = 8) -> dict:
    declining, surging = [], []
    for r in rows:
        u30, uprev = _i(r["u30"]), _i(r["uprev"])
        name = r["product_name"] or r["sku"]
        if uprev >= min_base and u30 <= uprev * 0.6:
            declining.append({
                "sku": r["sku"], "product_name": name, "category": r["category"],
                "units_now": u30, "units_before": uprev,
                "change_pct": round(100 * (u30 - uprev) / uprev, 0),
                "unit_drop": uprev - u30,
            })
        elif u30 >= max(min_base, 1) and u30 >= uprev * 2 and uprev >= 2:
            surging.append({
                "sku": r["sku"], "product_name": name, "category": r["category"],
                "units_now": u30, "units_before": uprev,
                "change_pct": round(100 * (u30 - uprev) / uprev, 0),
                "unit_gain": u30 - uprev,
            })
    # sku tiebreak so the top-6 cut is deterministic (and SQL-reproducible)
    declining.sort(key=lambda d: (-d["unit_drop"], d["sku"]))
    surging.sort(key=lambda d: (-d["unit_gain"], d["sku"]))
    return {"declining": declining[:6], "surging": surging[:6]}


def overview(data: dict) -> dict:
    if not data or data.get("as_of") is None:
        return {"available": False, "reason": "no sales data for this store"}

    pl = data.get("pulse") or {}
    mg = data.get("margin") or {}
    rev_30 = _f(pl.get("rev_30"))
    rev_prev30 = _f(pl.get("rev_prev30"))
    tx_30 = _i(pl.get("tx_30"))
    rev_costed = _f(mg.get("rev_costed"))
    gross = _f(mg.get("gross"))

    return {
        "available": True,
        "as_of": data["as_of"],
        "pulse": {
            "revenue_30d": round(rev_30, 2),
            "revenue_mom_pct": round(100 * (rev_30 - rev_prev30) / rev_prev30, 1) if rev_prev30 else None,
            "transactions_30d": tx_30,
            "avg_basket_value": round(rev_30 / tx_30, 2) if tx_30 else 0.0,
            "gross_margin_pct": round(100 * gross / rev_costed, 1) if rev_costed else None,
        },
        "anomalies": _momentum(data.get("momentum") or []),
        # action_queue is attached by the pipeline (cross-engine synthesis).
        "action_queue": [],
    }
