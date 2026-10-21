"""Loss & Theft Radar — deterministic transaction-integrity signals.

Pure over the aggregates from loss_repo. Flags 'doubtful sales' a POS buries:
voids/refunds, near-zero-price rings (sweethearting), below-cost sales, and
returns. Honest by design: these are signals to REVIEW, not proof of theft — we
quantify the dollar exposure and surface the worst offenders so an owner can look.
"""
from __future__ import annotations


def _f(x) -> float:
    return float(x) if x is not None else 0.0


def _i(x) -> int:
    return int(x) if x is not None else 0


def loss_signals(data: dict) -> dict:
    if not data or data.get("as_of") is None:
        return {"available": False, "reason": "no sales data for this store"}

    voids = data.get("voids") or {}
    free_tot = data.get("free_total") or {}
    below_tot = data.get("below_total") or {}
    returns = data.get("returns") or {}

    void_amount = _f(voids.get("amount"))
    free_value = _f(free_tot.get("would_be_value"))
    below_loss = _f(below_tot.get("loss"))
    returns_amount = abs(_f(returns.get("amount")))

    free_items = [{
        "sku": r["sku"], "product_name": r["product_name"], "category": r["category"],
        "lines": _i(r["lines"]), "units": _i(r["units"]),
        "price": _f(r["price"]), "value_given_away": round(_f(r["would_be_value"]), 2),
    } for r in (data.get("free_items") or [])]

    below_items = [{
        "sku": r["sku"], "product_name": r["product_name"], "category": r["category"],
        "lines": _i(r["lines"]), "units": _i(r["units"]),
        "margin_lost": round(_f(r["loss"]), 2),
    } for r in (data.get("below_items") or [])]

    # Dollar exposure worth a manual look = giveaways + below-cost loss + refunds.
    # (Voids aren't summed in — many are legit corrections — but are surfaced.)
    review_exposure = round(free_value + below_loss + returns_amount, 2)
    flagged_lines = (_i(free_tot.get("lines")) + _i(below_tot.get("lines"))
                     + _i(returns.get("lines")))

    return {
        "available": True,
        "as_of": data["as_of"],
        "window_days": data.get("window_days"),
        "review_exposure": review_exposure,
        "flagged_line_count": flagged_lines,
        "signals": {
            "voids": {
                "sales": _i(voids.get("sales")),
                "lines": _i(voids.get("lines")),
                "amount": round(void_amount, 2),
                "recent_sales": _i(voids.get("recent_sales")),
                "recent_amount": round(_f(voids.get("recent_amount")), 2),
            },
            "free_giveaways": {
                "lines": _i(free_tot.get("lines")),
                "units": _i(free_tot.get("units")),
                "recent_lines": _i(free_tot.get("recent_lines")),
                "value_given_away": round(free_value, 2),
                "items": free_items,
            },
            "below_cost": {
                "lines": _i(below_tot.get("lines")),
                "margin_lost": round(below_loss, 2),
                "items": below_items,
            },
            "returns": {
                "lines": _i(returns.get("lines")),
                "units": _i(returns.get("units")),
                "amount": round(returns_amount, 2),
            },
        },
    }
