"""Verify every per-table reproduction query in table_sql.py against the live
warehouse: runs the SQL and the real StoreAgent computation and compares the row
set (ids) and a key dollar/count sum. Read-only (SELECT only).

    ./.venv/bin/python sql_checks/verify_tables.py
"""
import psycopg
from psycopg.rows import dict_row

from storeagent.config import SOURCE
from storeagent.api.service import run_capability
from sql_checks.table_sql import TABLE_SQL


def _find(d, key):
    """First list found under `key` anywhere in the nested result dict. `key` may
    be a dotted path (e.g. "free_giveaways.items") to disambiguate repeated names."""
    if "." in key:
        head, rest = key.split(".", 1)
        obj = _find_obj(d, head)
        return _find(obj, rest) if isinstance(obj, dict) else None
    if isinstance(d, dict):
        for k, v in d.items():
            if k == key and isinstance(v, list):
                return v
            r = _find(v, key)
            if r is not None:
                return r
    return None


def _find_obj(d, key):
    """First dict found under `key` anywhere in the nested result dict."""
    if isinstance(d, dict):
        for k, v in d.items():
            if k == key and isinstance(v, dict):
                return v
            r = _find_obj(v, key)
            if r is not None:
                return r
    return None


# key -> (store, capability, result_key, id_field, sum_field)
CHECKS = {
    "overview.declining":     (46, "overview",  "declining",      "sku",         "unit_drop"),
    "overview.surging":       (46, "overview",  "surging",        "sku",         "unit_gain"),
    "inventory.brand_concentration": (46, "inventory", "top_frozen_brands", "brand", "frozen_capital"),
    "market.opportunities":   (46, "market",    "opportunities",  "upc",         "projected_annual_profit"),
    "inventory.dead_stock":   (46, "inventory", "dead_stock.items", "sku",       "frozen_capital"),
    "pricing.raise_list":     (46, "pricing",   "raise_list",     "sku",         "est_annual_upside"),
    "pricing.cut_list":       (46, "pricing",   "cut_list",       "sku",         "frozen_capital"),
    "customers.win_back":     (88, "customers", "win_back",       "customer_id", "annual_value"),
    "customers.top_customers":(88, "customers", "top_customers",  "customer_id", "spend"),
    "buying.buy_list":        (46, "buying",    "buy_list",       "sku",         "order_value"),
    "buying.dont_buy_list":   (46, "buying",    "dont_buy_list",  "sku",         "capital_tied"),
    "buying.accelerating":    (46, "buying",    "accelerating",   "sku",         "units_90"),
    "buying.lost_sales":      (46, "buying",    "items",          "sku",         "lost_revenue"),
    "basket.top_bundles":     (46, "basket",    "top_bundles",    "_pair",       "lift"),
    "basket.top_by_volume":   (46, "basket",    "top_by_volume",  "_pair",       "together_count"),
    "lossprev.free_giveaways":(46, "lossprev",  "free_giveaways.items", "sku",         "value_given_away"),
    "lossprev.below_cost":    (46, "lossprev",  "below_cost.items", "sku",       "margin_lost"),
    "market.head_to_head":    (46, "market",    "head_to_head",   "product_name","my_units_sold"),
    "market.priced_above":    (46, "market",    "priced_above",   "product_name","diff_pct"),
    "market.priced_below":    (46, "market",    "priced_below",   "product_name","diff_pct"),
    "money_leaks.top_wasted_discounts": (94, "inventory", "top_wasted_discounts", "sku", "discount_given"),
}
# single-row scalar checks (counts), verified separately from the list tables.
SCALARS = {
    "basket.strong_bundle_count": (46, "basket", lambda m: len(m["basket"]["top_bundles"]), "strong_bundle_count"),
    "market.regional_assortment": (46, "market", lambda m: m["market"]["carried_count"], "carried_count"),
}


def _id(r, field):
    if field == "_pair":
        return f"{r['a_sku']}|{r['b_sku']}"
    return str(r[field])


def main():
    conn = psycopg.connect(**SOURCE.kwargs(), row_factory=dict_row)
    conn.read_only = True
    cache = {}

    def py_list(store, cap, result_key):
        if (store, cap) not in cache:
            cache[(store, cap)] = run_capability(cap, store=store, location=None, use_cache=False)
        return _find(cache[(store, cap)], result_key) or []

    def run(key, store):
        with conn.cursor() as cur:
            cur.execute(TABLE_SQL[key].replace("%(cid)s", str(store)))
            return cur.fetchall()

    from storeagent.api.service import CAPABILITIES

    ok_all = True
    for key, (store, cap, rk, idf, sf) in CHECKS.items():
        if cap not in CAPABILITIES:
            print(f"  SKIP {key:34} capability '{cap}' no longer registered")
            continue
        sql_rows, py = run(key, store), py_list(store, cap, rk)
        sids = sorted(_id(r, idf) for r in sql_rows)
        pids = sorted(_id(r, idf) for r in py)
        # Crash-proof sum: a missing sum_field (config drift / renamed output
        # field) must not abort the whole audit — flag it in-line instead.
        sql_missing = any(sf not in r for r in sql_rows)
        py_missing = any(sf not in r for r in py)
        ssum = round(sum(float(r.get(sf) or 0) for r in sql_rows), 2)
        psum = round(sum(float(r.get(sf) or 0) for r in py), 2)
        field_ok = not (sql_missing or py_missing)
        ok = field_ok and len(sql_rows) == len(py) and sids == pids and abs(ssum - psum) < 1.5
        ok_all &= ok
        miss = '' if field_ok else f"  [sum_field '{sf}' missing: sql={sql_missing} py={py_missing}]"
        print(f"  {'OK  ' if ok else 'FAIL'} {key:34} rows {len(sql_rows):>3}/{len(py):<3} "
              f"ids={'=' if sids==pids else 'X'} sum {ssum} vs {psum}{miss}")

    for key, (store, cap, pyfn, col) in SCALARS.items():
        if cap not in CAPABILITIES:
            print(f"  SKIP {key:34} capability '{cap}' no longer registered")
            continue
        if (store, cap) not in cache:
            cache[(store, cap)] = run_capability(cap, store=store, location=None, use_cache=False)
        sval = run(key, store)[0][col]
        pval = pyfn(cache[(store, cap)])
        ok = int(sval) == int(pval)
        ok_all &= ok
        print(f"  {'OK  ' if ok else 'FAIL'} {key:34} value {sval} vs {pval}")

    conn.close()
    print("\nALL EXACT TABLES MATCH" if ok_all else "\nSOME TABLES FAILED")


if __name__ == "__main__":
    main()
