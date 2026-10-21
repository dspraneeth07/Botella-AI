"""Basket affinity — pure support/confidence/lift over co-occurrence counts.

lift > 1 means the two sell together MORE than chance would predict — a real
cross-sell/bundle signal. confidence(A->B) = P(B in basket | A in basket).
"""
from __future__ import annotations


def _label(names: dict, sku: str) -> str:
    nm = names.get(sku)
    return (nm[0] if nm and nm[0] else sku)


def basket_affinity(data: dict, top_n: int = 500, min_lift: float = 1.2) -> dict:
    if not data or data.get("as_of") is None:
        return {"available": False, "status": "insufficient_data",
                "reason": "no sales data for this store"}

    total = data.get("total_baskets") or 0
    multi = data.get("multi_item_baskets") or 0
    window = data.get("window_days")
    sku_baskets = data.get("sku_baskets") or {}
    names = data.get("names") or {}
    raw = data.get("pairs") or []
    # How much of the traffic is single-bottle trips — context the UI shows
    # both as an insight and as the honest reason bundles are thin.
    single_item_pct = round(100 * (1 - multi / total), 1) if total else None
    diag = {
        "window_days": window,
        "total_baskets": total,
        "multi_item_baskets": multi,
        "single_item_pct": single_item_pct,
        "min_support_used": data.get("min_support_used"),
        "window_widened": bool(data.get("window_widened")),
    }

    if total < 50:
        return {"available": False, "status": "insufficient_data",
                "reason": f"only {total} transactions in the last {window} days", **diag}
    if not raw:
        # Plenty of traffic but no pair repeats enough to trust: a real finding
        # about how this store sells (mostly single-item trips), not an error.
        return {"available": True, "status": "healthy", "as_of": data["as_of"],
                "reason": "no recurring co-purchase pairs",
                "pairs_analyzed": 0, "top_bundles": [], "top_by_volume": [], **diag}

    pairs = []
    for r in raw:
        a, b, pc = r["a"], r["b"], r["pair_count"]
        na, nb = sku_baskets.get(a, 0), sku_baskets.get(b, 0)
        if na == 0 or nb == 0:
            continue
        # Same product rung under two codes (e.g. its UPC and its internal SKU
        # both carry one product_name) co-occurs as a spurious self-pair with a
        # huge lift — "bundle X with X" is never a real cross-sell, so drop it.
        name_a, name_b = (names.get(a) or (None,))[0], (names.get(b) or (None,))[0]
        if name_a and name_b and name_a == name_b:
            continue
        lift = (pc * total) / (na * nb)
        pairs.append({
            "a_sku": a, "b_sku": b,
            "a_name": _label(names, a), "b_name": _label(names, b),
            "a_category": (names.get(a) or (None, None))[1],
            "b_category": (names.get(b) or (None, None))[1],
            "together_count": pc,
            "support_pct": round(100 * pc / total, 2),
            "confidence_a_to_b": round(100 * pc / na, 1),
            "confidence_b_to_a": round(100 * pc / nb, 1),
            "lift": round(lift, 2),
        })

    by_lift = sorted([p for p in pairs if p["lift"] >= min_lift],
                     key=lambda p: p["lift"], reverse=True)
    by_volume = sorted(pairs, key=lambda p: p["together_count"], reverse=True)

    return {
        "available": True,
        "status": "opportunities" if pairs else "healthy",
        "as_of": data["as_of"],
        "pairs_analyzed": len(pairs),
        "top_bundles": by_lift[:top_n],      # strongest affinity -> best bundle ideas
        "top_by_volume": by_volume[:top_n],  # most frequent co-purchases
        **diag,
    }
