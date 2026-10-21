from __future__ import annotations

from storeagent.functions.basket import basket_affinity


def _data(pairs, names, sku_baskets, total=200):
    return {
        "as_of": "2026-06-01",
        "window_days": 120,
        "total_baskets": total,
        "sku_baskets": sku_baskets,
        "names": names,
        "pairs": pairs,
    }


def test_same_product_under_two_codes_is_not_a_bundle():
    # A real product sold under both its UPC and its internal SKU shares one
    # product_name; the two codes co-occur with a huge lift but it's the same
    # bottle — never a "bundle X with X" recommendation.
    data = _data(
        pairs=[
            {"a": "704228011212", "b": "9GAP0PEYNRDF0", "pair_count": 16},  # self-pair
            {"a": "SKU_A", "b": "SKU_B", "pair_count": 20},                 # real pair
        ],
        names={
            "704228011212": ("Tequila Arette Blanco 1L", "Liquor - Tequila"),
            "9GAP0PEYNRDF0": ("Tequila Arette Blanco 1L", "Liquor - Tequila"),
            "SKU_A": ("Lime Wedge", "Garnish"),
            "SKU_B": ("Tequila Arette Blanco 1L", "Liquor - Tequila"),
        },
        sku_baskets={"704228011212": 16, "9GAP0PEYNRDF0": 26, "SKU_A": 40, "SKU_B": 50},
    )
    out = basket_affinity(data, min_lift=1.0)
    skus = {(p["a_sku"], p["b_sku"]) for p in out["top_bundles"]}
    assert ("704228011212", "9GAP0PEYNRDF0") not in skus  # self-pair dropped
    assert ("SKU_A", "SKU_B") in skus                     # genuine pair kept
    assert out["pairs_analyzed"] == 1


def test_distinct_products_with_null_names_are_kept():
    # Two genuinely different SKUs that both lack a name must NOT be treated as
    # the same product (the SKU fallback differs, so they aren't collapsed).
    data = _data(
        pairs=[{"a": "X", "b": "Y", "pair_count": 20}],
        names={"X": (None, None), "Y": (None, None)},
        sku_baskets={"X": 40, "Y": 50},
    )
    out = basket_affinity(data, min_lift=1.0)
    assert out["pairs_analyzed"] == 1
