"""Market Intelligence — pure cross-store opportunity analysis.

Turns peer-store sales into stocking recommendations with a projected annual
profit. Honest about the assumptions: cross-POS matching is by UPC + a name
guard; the profit projection is conservative (we discount peer velocity by an
adoption factor and floor margin from peer cost or a category default).
"""
from __future__ import annotations

import re

from ..canonical.brand import extract_brand

# Conservative: assume we'd capture this fraction of a peer store's per-store rate.
ADOPTION_FACTOR = 0.5
DEFAULT_MARGIN = 0.30          # used when no peer cost is known
NAME_MATCH_TOKENS = 2          # leading significant tokens used to dedupe by name
PRICE_DIFF_FLAG = 0.10        # flag when >=10% off the area
PRICE_DIFF_MAX = 0.60         # beyond this it's almost certainly a mismatched product
NAME_OVERLAP_MIN = 0.5        # how similar two product names must be to be "the same"

_WORD = re.compile(r"[a-z0-9.]+")
_NAME_STOP = {"the", "and", "of", "with", "ml", "l", "oz", "pet", "single", "pk",
              "pack", "ct", "bottle", "btl", "can", "cans", "size"}


def _name_tokens(name: str | None) -> set[str]:
    """Significant tokens (size tokens like '50ml'/'750' kept) for same-product
    matching that doesn't depend on the brand dictionary."""
    if not name:
        return set()
    return {t for t in _WORD.findall(name.lower()) if len(t) > 1 and t not in _NAME_STOP}


def _same_product(a: str | None, b: str | None) -> bool:
    ta, tb = _name_tokens(a), _name_tokens(b)
    if not ta or not tb:
        return False
    overlap = len(ta & tb) / len(ta | tb)
    return overlap >= NAME_OVERLAP_MIN

_SIZE = re.compile(r"\b(\d+(\.\d+)?\s?(ml|l|oz|pk|pack|ct|gal|btl|can|cans|liter|litre)|\d{3,4}|\d+(\.\d+)?l)\b")
_NONALNUM = re.compile(r"[^a-z0-9 ]")


def _token_sig(name: str | None) -> str:
    if not name:
        return ""
    s = _SIZE.sub(" ", name.lower())
    s = _NONALNUM.sub(" ", s)
    toks = [t for t in s.split() if len(t) > 1 and not t.isdigit()]
    return " ".join(toks[:NAME_MATCH_TOKENS])


_SIZE_TOKEN = re.compile(
    r"(\d+(?:\.\d+)?)\s?(ml|l|liter|litre|oz|gal|pk|pack|ct)\b|\b(\d{3,4})\b"
    # POS catalogs truncate names at a fixed width, chopping 'ml' to 'm'
    # ('New Amsterdam Pink Whitney 50m') — accept a bare trailing 'm' as ml,
    # end-of-name only so it can never eat a real word.
    r"|(\d+(?:\.\d+)?)\s?m\s*$"
)


def _size_sig(name: str | None) -> str:
    """Normalized size token ('750ml', '1750ml', '12pk'); '' when none found.

    Liters convert to ml and bare 3-4 digit numbers are assumed ml, so
    '1.75L', '1750ml' and '1750' all dedupe to the same size.
    """
    if not name:
        return ""
    m = _SIZE_TOKEN.search(name.lower())
    if not m:
        return ""
    if m.group(3):
        return f"{m.group(3)}ml"
    if m.group(4):
        return f"{m.group(4)}ml"
    qty, unit = m.group(1), m.group(2)
    if unit in ("l", "liter", "litre"):
        return f"{round(float(qty) * 1000)}ml"
    if unit in ("pack", "pk"):
        return f"{qty}pk"
    return f"{qty}{unit}"


def _dedupe_key(name: str | None) -> str:
    """Brand + size when a brand is detected, else a leading-token signature.

    Keying on brand alone hid every size of a brand once the store carried any
    one of them, which zeroed out real gaps (the 1.75L a peer sells well while
    I only carry the 750ml). A brand key without a size means the name carried
    no size token; the caller treats those as covering the whole brand.
    """
    brand = extract_brand(name)
    if brand:
        size = _size_sig(name)
        return f"brand:{brand}|{size}" if size else f"brand:{brand}"
    return f"name:{_token_sig(name)}"


def _f(x) -> float:
    return float(x) if x is not None else 0.0


def market_intelligence(data: dict, top_n: int = 500) -> dict:
    if not data or not data.get("available"):
        return {"available": False, "status": "insufficient_data",
                "reason": (data or {}).get("reason", "unavailable"),
                "geo": (data or {}).get("geo"), "peer_tier": (data or {}).get("peer_tier"),
                "peer_count": (data or {}).get("peer_count")}

    window = data["window_days"]
    peer_count = data["peer_count"]
    mine = data.get("my_units_by_upc") or {}
    my_bought = data.get("my_bought_by_upc") or {}
    my_price = data.get("my_price_by_upc") or {}
    my_name = data.get("my_name_by_upc") or {}
    cost_map = data.get("cost_by_upc") or {}
    # Sized keys match size-for-size; my products whose names carry no size
    # token cover their whole brand (we can't tell which size is on the shelf).
    my_keys: set[str] = set()
    my_brand_wide: set[str] = set()
    for n in data.get("my_names") or []:
        k = _dedupe_key(n)
        if k == "name:":
            continue
        my_keys.add(k)
        if k.startswith("brand:") and "|" not in k:
            my_brand_wide.add(k)

    opportunities = []
    regional_sku_count = 0
    carried_count = 0
    # Peer rows the catalogue could not name either. Counted, never shown: a
    # nameless row cannot be matched against what the store already carries,
    # so "a gap" would be a guess, and the screen showed exactly that - 177
    # units, $970-1,312 a year, and no product to order.
    unnamed_skipped = 0
    priced_above, priced_below = [], []
    for r in data.get("peer_rows") or []:
        upc = r["upc"]
        my_units = mine.get(upc, 0)
        name = (r.get("product_name") or "").strip()
        if not name:
            unnamed_skipped += 1
            continue
        key = _dedupe_key(name)
        units = _f(r["units"])
        stores = int(r["stores"] or 0)
        avg_price = round(_f(r["avg_price"]), 2)
        if stores <= 0 or avg_price <= 0:
            continue

        regional_sku_count += 1
        brand_part = key.split("|", 1)[0] if key.startswith("brand:") else None
        i_carry = (
            my_units > 0
            or key in my_keys
            or (brand_part is not None and brand_part in my_brand_wide)
        )
        if i_carry:
            carried_count += 1
            continue  # stocking opportunities are only the brands I DON'T carry

        # Conservative projection: peer per-store daily rate -> my annual units.
        # Rounded to whole units (and cent margins) BEFORE the $ math so every
        # displayed multiplication (units x price, units x margin) reproduces
        # by hand from the columns shown in the UI — same contract as the
        # price-positioning section below.
        per_store_daily = units / stores / window
        est_annual_units = round(per_store_daily * 365 * ADOPTION_FACTOR)
        cost = cost_map.get(upc)
        unit_margin = (avg_price - cost) if cost else avg_price * DEFAULT_MARGIN
        if unit_margin <= 0:
            unit_margin = avg_price * DEFAULT_MARGIN
        unit_margin = round(unit_margin, 2)
        projected_profit = est_annual_units * unit_margin

        opportunities.append({
            "upc": upc, "product_name": name, "category": r["category"],
            "peer_units": int(units), "peer_stores": stores,
            "avg_price": avg_price,
            "est_unit_cost": round(cost, 2) if cost else None,
            "est_unit_margin": unit_margin,
            "est_annual_units": est_annual_units,
            # The headline number: what a typical peer store RINGS UP on this
            # product in a year (velocity x price, adoption-discounted) — the
            # honest size of the opportunity. Margin-based profit stays as a
            # secondary figure; with the conservative discounts it reads $20-150
            # and undersells products peers demonstrably move at high prices.
            "est_annual_revenue": round(est_annual_units * avg_price, 2),
            "projected_annual_profit": round(projected_profit, 2),
            "margin_basis": "peer cost" if cost else "category default 30%",
        })

    # ---- You vs your area on products you both sell (exact-UPC match) ----
    # peer_for_mine now covers EVERY product I sell (not just top sellers), so
    # price positioning can surface underperformers — low-volume products with a
    # price gap. Head-to-head keeps its original "your top products" contract via
    # my_top_upcs; older repo payloads without that key behave exactly as before.
    head_to_head = []
    my_top_set = set(data.get("my_top_upcs") or (data.get("peer_for_mine") or {}).keys())
    for upc, pr in (data.get("peer_for_mine") or {}).items():
        my_sold = mine.get(upc, 0)
        stores = int(pr["stores"] or 0)
        area_units = int(pr["units"] or 0)
        if my_sold <= 0 or stores < 2 or area_units <= 0:
            continue
        per_store = round(area_units / stores)
        # Cent-rounded up front: every derived figure (diff %, flags, $/yr) must
        # be reproducible by hand from the my_price/area_price shown in the UI.
        myp = my_price.get(upc)
        myp = round(myp, 2) if myp else myp
        ap = round(_f(pr["avg_price"]), 2)
        # A wild price gap means the shared barcode is a DIFFERENT size/product at
        # the two stores (e.g. my 50ml mini vs the area's 750ml) — not comparable.
        if myp and ap > 0 and abs((myp - ap) / ap) > PRICE_DIFF_MAX:
            continue
        if upc in my_top_set:
            head_to_head.append({
                "product_name": my_name.get(upc) or pr["name"], "category": pr["category"],
                "my_units_sold": my_sold, "my_units_bought": int(my_bought.get(upc, 0)),
                "area_units": area_units, "peer_stores": stores, "peer_units_per_store": per_store,
                "area_index": round(my_sold / per_store, 2) if per_store > 0 else None,
                "my_price": myp or None,
                "area_price": ap or None,
            })

        # Price positioning falls straight out of the matched set: same product I
        # sell and the area sells, with both prices. Flag when >=10% off the area.
        if myp and ap and abs((myp - ap) / ap) <= PRICE_DIFF_MAX:
            diff = (myp - ap) / ap
            # Window actuals only — no annualizing. Both $ figures are
            # reproducible by hand from the displayed columns: units sold in
            # the window x the shown price (gap).
            row = {"product_name": my_name.get(upc) or pr["name"], "category": pr["category"],
                   "my_price": myp, "area_price": ap,
                   "diff_pct": round(100 * diff, 1), "my_units": my_sold,
                   "area_units": area_units, "peer_stores": stores,
                   "peer_units_per_store": per_store,
                   # Sell-through vs the typical peer store carrying this product
                   # (my units ÷ per-store peer units, unrounded denominator).
                   # >= 1 -> the price isn't costing volume; < 1 -> underperforming.
                   # The UI splits the price-position tables on this.
                   "sell_index": round(my_sold * stores / area_units, 2),
                   "margin_left_90d": round(max(ap - myp, 0) * my_sold, 2),
                   "revenue_exposed_90d": round(myp * my_sold, 2) if diff > 0 else 0.0}
            if diff >= PRICE_DIFF_FLAG:
                priced_above.append(row)
            elif diff <= -PRICE_DIFF_FLAG:
                priced_below.append(row)

    head_to_head.sort(key=lambda h: h["my_units_sold"], reverse=True)

    # Rank by revenue power at the peers (sells the most x at the best price),
    # not by the margin-discounted profit projection.
    opportunities.sort(key=lambda o: o["est_annual_revenue"], reverse=True)
    top = opportunities[:top_n]
    priced_above.sort(key=lambda x: x["diff_pct"], reverse=True)
    priced_below.sort(key=lambda x: x["diff_pct"])

    # Tri-state so the caller can tell three very different zeros apart:
    # no matchable peer sales (data problem), full regional coverage (a WIN,
    # not an empty dashboard), or real stocking gaps.
    if regional_sku_count == 0:
        status = "insufficient_data"
    elif not opportunities:
        status = "healthy"
    else:
        status = "opportunities"

    return {
        "available": True,
        "status": status,
        "assortment_coverage_pct": (
            round(100.0 * carried_count / regional_sku_count, 1)
            if regional_sku_count else None
        ),
        "as_of": data["as_of"],
        "window_days": window,
        "geo": data["geo"],
        "peer_tier": data["peer_tier"],
        "peer_count": peer_count,
        # Peers that actually feed the comparison (have barcode-matchable sales),
        # vs peer_count which is every store in the state — so the UI can say
        # "comparing N of M" instead of implying all M are compared.
        "comparable_peer_count": data.get("comparable_peer_count"),
        "regional_sku_count": regional_sku_count,
        "carried_count": carried_count,
        "opportunity_count": len(opportunities),
        # Peer products refused for having no name anywhere (see loop above).
        # Reported so a sudden rise is visible as a feed problem, not a quiet
        # shrink of the list.
        "unnamed_skipped": unnamed_skipped,
        "total_projected_profit": round(sum(o["projected_annual_profit"] for o in top), 2),
        "total_revenue_opportunity": round(sum(o["est_annual_revenue"] for o in top), 2),
        "opportunities": top,
        "head_to_head": head_to_head[:top_n],
        "priced_above_count": len(priced_above),
        "priced_below_count": len(priced_below),
        # Headline $ tiles cover ONLY the underperformers (sell_index < 1, the
        # UI's "Underperforming at this price" group): where the store also
        # out-sells the typical peer, the gap is demonstrably not costing
        # volume, so counting it overstated the actionable money. Window (90d)
        # actuals, not annualized: units actually sold x the actual price (gap).
        "priced_above_underperf_count": sum(1 for x in priced_above if x["sell_index"] < 1),
        "priced_below_underperf_count": sum(1 for x in priced_below if x["sell_index"] < 1),
        "margin_left_total": round(
            sum(x["margin_left_90d"] for x in priced_below if x["sell_index"] < 1), 2),
        "revenue_exposed_total": round(
            sum(x["revenue_exposed_90d"] for x in priced_above if x["sell_index"] < 1), 2),
        "priced_above": _cap_keeping_underperformers(priced_above, top_n),
        "priced_below": _cap_keeping_underperformers(priced_below, top_n),
    }


def _cap_keeping_underperformers(rows: list[dict], top_n: int) -> list[dict]:
    """Cap a price-position list without ever cutting an underperformer.

    The headline totals above sum over ALL underperformers (sell_index < 1),
    but the shipped list feeds the UI table and its CSV export — a plain
    [:top_n] keeps the most price-gapped rows, which is NOT the same set, so
    past the cap the tile and the CSV silently disagree (store 171 sits at
    474 priced-below rows today). Keep every underperformer; the performing
    (green) group absorbs the cap.
    """
    if len(rows) <= top_n:
        return rows
    under = [x for x in rows if x["sell_index"] < 1]
    ok = [x for x in rows if x["sell_index"] >= 1]
    kept = under + ok[: max(0, top_n - len(under))]
    kept.sort(key=lambda x: x["diff_pct"])
    return kept
