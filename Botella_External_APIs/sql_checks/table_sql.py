"""Dedicated per-table reproduction queries (the rows shown in each frontend
table), keyed "<section>.<table>". %(cid)s is the store. These reuse the verified
section CTEs and select the row-level columns the table displays."""
from sql_checks.verify_all import SQLS
from storeagent.canonical.brand import _BRANDS as _BRANDS_MAP, _SORTED_ALIASES as _BRAND_ALIASES


def _sqlq(s):
    return s.replace("'", "''")


# Faithful SQL port of canonical.brand.extract_brand for a lowercased-name expr
# `lpn`: the 90-alias dictionary (longest-first, \y word boundaries) then the
# leading-words / size-noise-stripped / title-cased heuristic fallback. Verified
# to reproduce brand_concentration's top frozen brands exactly (store 46).
def brand_expr(lpn):
    dict_case = "CASE " + " ".join(
        f"WHEN {lpn} ~ '\\y{_sqlq(a)}\\y' THEN '{_sqlq(_BRANDS_MAP[a])}'" for a in _BRAND_ALIASES
    ) + " ELSE NULL END"
    noise = (r"\y(\d+(\.\d+)?\s*(ml|l|liter|litre|oz|ounce|pk|pack|ct|count|can|cans|bottle|btl|"
             r"btls|gal|gallon|case|cs|pet|nr|loose|single|each|ea)|\d+\s*x\s*\d+|\d+pk|\d+pack|"
             r"750|375|1\.75|50ml|\d{2,4})\y")
    heur = (f"(SELECT CASE WHEN char_length(j) >= 3 THEN initcap(j) ELSE NULL END FROM ("
            f"SELECT array_to_string(CASE WHEN cardinality(ws)>=2 AND char_length(ws[1])<=4 "
            f"THEN ws[1:2] ELSE ws[1:1] END, ' ') AS j FROM (SELECT array(SELECT w FROM unnest("
            f"regexp_split_to_array(btrim(regexp_replace(regexp_replace({lpn}, "
            f"'[^a-z0-9''&[:space:]-]', ' ', 'g'), '{noise}', ' ', 'gi')), '\\s+')) w "
            f"WHERE char_length(w)>=2 AND w !~ '^[0-9]+$') AS ws) z) y)")
    return f"COALESCE({dict_case}, {heur})"


# SQL port of canonical market._token_sig: strip size tokens + non-alnum, take the
# leading 2 significant tokens (NAME_MATCH_TOKENS). Used for the dedupe key that
# decides which peer products a store already carries (brand if known, else sig).
def token_sig_expr(name):
    size = (r"\y(\d+(\.\d+)?\s?(ml|l|oz|pk|pack|ct|gal|btl|can|cans|liter|litre)|"
            r"\d{3,4}|\d+(\.\d+)?l)\y")
    return (f"array_to_string((array(SELECT t FROM unnest(regexp_split_to_array(btrim("
            f"regexp_replace(regexp_replace(lower({name}), '{size}', ' ', 'g'), "
            f"'[^a-z0-9 ]', ' ', 'g')), '\\s+')) t WHERE char_length(t) > 1 "
            f"AND t !~ '^[0-9]+$'))[1:2], ' ')")


# SQL port of market._size_sig: the first size token in the name, normalized
# ('1.75L'/'1750ml'/'1750' all -> '1750ml'; '4pk' stays '4pk'); '' when none.
# Backs the size-aware carried-key so "I carry the 750ml" no longer hides the
# 1.75L a peer sells well (mirrors the sized _dedupe_key).
def size_sig_expr(name):
    rx = r"(\d+(?:\.\d+)?)\s?(ml|l|liter|litre|oz|gal|pk|pack|ct)\y|\y(\d{3,4})\y"
    return ("(SELECT CASE WHEN z.m IS NULL THEN ''"
            " WHEN z.m[3] IS NOT NULL THEN z.m[3] || 'ml'"
            " WHEN z.m[2] IN ('l','liter','litre') THEN round(z.m[1]::numeric*1000)::text || 'ml'"
            " WHEN z.m[2] IN ('pk','pack') THEN z.m[1] || 'pk'"
            " ELSE z.m[1] || z.m[2] END"
            f" FROM (SELECT regexp_match(lower({name}), '{rx}') AS m) z)")


def _prefix(section):
    """The CTE chain of a section query (everything before its final SELECT)."""
    sql = SQLS[section]
    depth = 0
    for i in range(len(sql)):
        c = sql[i]
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
        elif depth == 0 and sql[i:i + 6].upper() == 'SELECT' and (i == 0 or not (sql[i - 1].isalnum() or sql[i - 1] == '_')):
            return sql[:i]
    raise ValueError(section)


INV = _prefix("inventory")
PRI = _prefix("pricing")
CUS = _prefix("customers")
# Buying CTE chain with product_name surfaced in mprod and aggregated in demand
# (it then propagates through calc/fc/flags/classified/buy/dont/lost via .*).
BUY = (_prefix("buying")
       .replace("SELECT DISTINCT ON (jk) jk, sku, stock_qty,",
                "SELECT DISTINCT ON (jk) jk, sku, product_name, stock_qty,", 1)
       .replace("SELECT p.sku, max(p.stock_qty) AS stock,",
                "SELECT p.sku, max(p.product_name) AS product_name, max(p.stock_qty) AS stock,", 1))
# Loss CTE chain with product_name + category surfaced in mprod.
LOSSX = _prefix("loss").replace(
    "SELECT DISTINCT ON (jk) jk, price::float AS price, cost::float AS cost FROM (",
    "SELECT DISTINCT ON (jk) jk, sku, product_name, category, price::float AS price, cost::float AS cost FROM (", 1)
# Basket prefix + the per-pair enrichment (lift/support/confidence + names) the
# repo computes in Python. sku_b/names append cleanly after the pairs CTE.
BSK_E = _prefix("basket") + """, sku_b AS (SELECT sku, count(*) AS n FROM b GROUP BY sku),
names AS (SELECT sku, max(product_name) AS name, max(category) AS category FROM products, params WHERE client_id=params.cid GROUP BY sku),
enriched AS (
  SELECT p.a AS a_sku, p.b AS b_sku, na.name AS a_name, nb.name AS b_name,
    na.category AS a_category, nb.category AS b_category, p.pc AS together_count,
    round((100.0*p.pc/(SELECT n FROM total))::numeric, 2) AS support_pct,
    round((100.0*p.pc/sa.n)::numeric, 1) AS confidence_a_to_b,
    round((100.0*p.pc/sb.n)::numeric, 1) AS confidence_b_to_a,
    round((p.pc*(SELECT n FROM total)::double precision/(sa.n*sb.n))::numeric, 2) AS lift
  FROM pairs p JOIN sku_b sa ON sa.sku=p.a JOIN sku_b sb ON sb.sku=p.b
    LEFT JOIN names na ON na.sku=p.a LEFT JOIN names nb ON nb.sku=p.b
)
"""
# Market prefix with product_name + category surfaced in peer_rows / pfm / my_upc
# and carried into pp (the matched head-to-head / price-positioning set).
MKT = (_prefix("market")
       .replace("AS avg_price\n  FROM plines si, peers, asof",
                "AS avg_price, max(si.product_name) AS product_name, max(si.category) AS category\n  FROM plines si, peers, asof", 1)
       .replace("AS avg_price\n  FROM plines si, peers, asof, params\n  WHERE si.upc IN (SELECT upc FROM my_upc WHERE units > 0)",
                "AS avg_price, max(si.product_name) AS name, max(si.category) AS category\n  FROM plines si, peers, asof, params\n  WHERE si.upc IN (SELECT upc FROM my_upc WHERE units > 0)", 1)
       .replace("SELECT upc, sum(quantity) AS units, sum(total_amount) AS revenue",
                "SELECT upc, sum(quantity) AS units, sum(total_amount) AS revenue, max(product_name) AS product_name", 1)
       .replace("SELECT m.upc,",
                "SELECT m.upc, COALESCE(m.product_name, pfm.name) AS product_name, pfm.category AS category, pfm.units AS area_units, pfm.stores AS peer_stores, pfm.store_ids AS store_ids,", 1))
# Market opportunity / carried dedupe: append my-catalog dedupe keys (brand if
# known, else token signature) + peer cost, then classify each regional SKU as
# carried or a stocking opportunity. Reproduces carried_count / opportunities /
# total_projected_profit exactly (verified store 46).
MKT_OPP = MKT + (", mynames AS (SELECT DISTINCT product_name FROM sale_items, params, asof"
   " WHERE client_id=params.cid AND sale_date >= (SELECT as_of FROM asof)-90 AND quantity>0 AND product_name IS NOT NULL),\n"
   "mk0 AS (SELECT " + brand_expr("lower(product_name)") + " AS br, " + token_sig_expr("product_name") + " AS sig, " + size_sig_expr("product_name") + " AS size FROM mynames),\n"
   # Sized keys match size-for-size; my products with NO size token cover their
   # whole brand (mybrandwide) — mirrors market._dedupe_key + my_brand_wide.
   "mykeys AS (SELECT DISTINCT CASE WHEN br IS NOT NULL THEN 'brand:'||br||(CASE WHEN size<>'' THEN '|'||size ELSE '' END) ELSE 'name:'||sig END AS k FROM mk0),\n"
   "mybrandwide AS (SELECT DISTINCT 'brand:'||br AS k FROM mk0 WHERE br IS NOT NULL AND size=''),\n"
   "peer_cost AS (SELECT p.upc, percentile_cont(0.5) WITHIN GROUP (ORDER BY p.cost) AS cost\n"
   "   FROM products p, peers WHERE p.client_id = ANY(peers.ids) AND p.upc IN (SELECT upc FROM peer_rows)\n"
   "     AND p.cost > 0 AND COALESCE(p.is_deleted,false)=false GROUP BY p.upc),\n"
   # dp round (banker's) to mirror Python round(float, 2) — see the pp CTE note.
   "opp0 AS (SELECT pr.upc, pr.product_name, pr.category, pr.units, pr.stores, pr.store_ids, round(pr.avg_price::double precision*100)/100 AS avg_price,\n"
   "     COALESCE(mu.units,0) AS my_units, " + brand_expr("lower(pr.product_name)") + " AS br, " + token_sig_expr("pr.product_name") + " AS sig, " + size_sig_expr("pr.product_name") + " AS size, pc.cost AS peer_cost\n"
   "   FROM peer_rows pr LEFT JOIN my_upc mu ON mu.upc=pr.upc LEFT JOIN peer_cost pc ON pc.upc=pr.upc\n"
   "   WHERE pr.stores>0 AND round(pr.avg_price::double precision*100)/100>0),\n"
   "opp1 AS (SELECT *, (CASE WHEN br IS NOT NULL THEN 'brand:'||br||(CASE WHEN size<>'' THEN '|'||size ELSE '' END) ELSE 'name:'||sig END) AS pkey,\n"
   "     (CASE WHEN br IS NOT NULL THEN 'brand:'||br END) AS bkey,\n"
   "     (units::double precision/stores/90.0)*365*0.5 AS est_annual_units FROM opp0),\n"
   "opp2 AS (SELECT *, (my_units>0 OR pkey IN (SELECT k FROM mykeys WHERE k<>'name:')\n"
   "       OR (bkey IS NOT NULL AND bkey IN (SELECT k FROM mybrandwide))) AS i_carry,\n"
   "     CASE WHEN peer_cost IS NOT NULL AND (avg_price-peer_cost)>0 THEN (avg_price-peer_cost) ELSE avg_price*0.30 END AS unit_margin FROM opp1)\n")

# Money-leaks CTE chain with product_name + category surfaced (mprod -> margin -> ml2).
MLK = (_prefix("money_leaks")
       .replace("SELECT DISTINCT ON (jk) jk, sku, price::float AS price, cost::float AS cost",
                "SELECT DISTINCT ON (jk) jk, sku, product_name, category, price::float AS price, cost::float AS cost", 1)
       .replace("SELECT p.sku, max(p.price) AS price, max(p.cost) AS cost,",
                "SELECT p.sku, max(p.product_name) AS product_name, max(p.category) AS category, max(p.price) AS price, max(p.cost) AS cost,", 1))

# Overview momentum: per-SKU units in the last 30d vs the prior 30d (the rows
# behind the "What's slipping" / "What's heating up" lists on the Executive Overview).
_MOM = """WITH params AS (SELECT %(cid)s::int AS cid),
asof AS (SELECT max(sale_date)::date AS as_of FROM sales, params WHERE client_id=params.cid),
void_ids AS (SELECT COALESCE(array_agg(sale_id),'{}'::text[]) AS ids FROM sales, params WHERE client_id=params.cid AND sale_status='VOID' AND sale_id IS NOT NULL),
mom AS (
  SELECT si.sku, max(si.product_name) AS product_name, max(si.category) AS category,
    COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof)-30), 0) AS u30,
    COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof)-60 AND si.sale_date < (SELECT as_of FROM asof)-30), 0) AS uprev
  FROM sale_items si, params, void_ids
  WHERE si.client_id=params.cid AND si.sale_date >= (SELECT as_of FROM asof)-60 AND si.quantity>0
    AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(void_ids.ids)))
  GROUP BY si.sku
  HAVING COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof)-60 AND si.sale_date < (SELECT as_of FROM asof)-30), 0) >= 8
      OR COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof)-30), 0) >= 8
)
"""

TABLE_SQL = {
    # Overview: "What's slipping" - sellers down to <= 60% of their prior-30d pace.
    "overview.declining": _MOM + """SELECT sku, product_name, category,
       u30 AS units_now, uprev AS units_before,
       round((100.0*(u30-uprev)/uprev), 0) AS change_pct, (uprev-u30) AS unit_drop
FROM mom WHERE uprev >= 8 AND u30 <= uprev*0.6 ORDER BY (uprev-u30) DESC, sku LIMIT 6""",

    # Overview: "What's heating up" - sellers at >= 2x their prior-30d pace.
    "overview.surging": _MOM + """SELECT sku, product_name, category,
       u30 AS units_now, uprev AS units_before,
       round((100.0*(u30-uprev)/uprev), 0) AS change_pct, (u30-uprev) AS unit_gain
FROM mom WHERE u30 >= 8 AND u30 >= uprev*2 AND uprev >= 2 ORDER BY (u30-uprev) DESC, sku LIMIT 6""",

    # Inventory: "How stock is moving" - one row per velocity class.
    "inventory.velocity_classes": INV + """SELECT velocity_class,
       count(*) AS sku_count, sum(on_hand) AS onhand_units,
       round(sum(value_at_cost)::numeric, 2) AS value_at_cost
FROM final GROUP BY velocity_class
ORDER BY array_position(ARRAY['fast','normal','slow','dead','never_sold'], velocity_class)""",

    # Inventory: brand concentration - frozen capital rolled up by extracted brand,
    # top brands by frozen capital (reproduces extract_brand faithfully in SQL).
    "inventory.brand_concentration": INV + """, _bitems AS (
  SELECT sku, frozen_capital, lower(product_name) AS lpn FROM final WHERE on_hand > 0
), _branded AS (
  SELECT sku, frozen_capital, """ + brand_expr("lpn") + """ AS brand FROM _bitems
)
SELECT brand, count(*) AS sku_count,
       round(sum(frozen_capital)::numeric, 2) AS frozen_capital
FROM _branded WHERE brand IS NOT NULL GROUP BY brand HAVING sum(frozen_capital) > 0
ORDER BY frozen_capital DESC LIMIT 12""",

    # Inventory: top dead stock (actionable, non-premium), ranked by frozen capital.
    "inventory.dead_stock": INV + """SELECT sku, product_name, canonical_category AS category, on_hand,
       round(frozen_capital::numeric, 2) AS frozen_capital,
       dsl AS days_since_last_sale, last_sale_date
FROM final
WHERE velocity_class IN ('dead','never_sold') AND on_hand > 0 AND NOT is_premium
ORDER BY frozen_capital DESC, (on_hand * COALESCE(price,0)) DESC, sku
LIMIT 50""",

    # Pricing: raise candidates (under-priced fast movers), by annual upside.
    "pricing.raise_list": PRI + """SELECT sku, product_name,
       round(price::numeric, 2) AS price, new_price AS suggested_price,
       round((margin_pct*100)::numeric, 1) AS current_margin_pct,
       round((med*100)::numeric, 1) AS category_margin_pct,
       annual_units, upside AS est_annual_upside
FROM raises2 ORDER BY upside DESC LIMIT 500""",

    # Pricing: cut candidates (over-priced slow movers), by frozen capital.
    "pricing.cut_list": PRI + """SELECT sku, product_name,
       round(price::numeric, 2) AS price, new_price AS suggested_price,
       on_hand, frozen_capital
FROM cuts2 ORDER BY frozen_capital DESC LIMIT 500""",

    # Customers: win-back list (at-risk regulars), by annual value.
    "customers.win_back": CUS + """SELECT customer_id, name, visits,
       round(spend::numeric, 2) AS spend, annual_value,
       recency AS days_since_last, round(cadence::numeric, 1) AS cadence_days
FROM flagged WHERE at_risk ORDER BY annual_value DESC LIMIT 500""",

    # Customers: top customers by spend.
    "customers.top_customers": CUS + """SELECT customer_id, name,
       round(spend::numeric, 2) AS spend, visits, at_risk, recency AS days_since_last
FROM flagged ORDER BY spend DESC LIMIT 500""",

    # Buying: "Buy now" - urgent first, then by order value.
    "buying.buy_list": BUY + """SELECT sku, product_name, on_hand, u90 AS units_90, order_qty,
       round(order_value::numeric, 2) AS order_value,
       round(dos::numeric, 1) AS days_of_supply,
       round(demand_cover::numeric, 1) AS forecast_units_coverage,
       stockout_risk, round(rf::numeric, 2) AS trend,
       -- order_by runs at the PROJECTED pace (dos_t, trend included — the pace
       -- the order is sized on) and clamps to wall-clock CURRENT_DATE like
       -- _buy_row: an order-by date is an instruction to a human, never
       -- rendered in the past.
       GREATEST((SELECT as_of FROM asof) + CASE WHEN dos_t IS NOT NULL THEN GREATEST(0, floor(dos_t - 7))::int ELSE 0 END, CURRENT_DATE) AS order_by
FROM buy ORDER BY stockout_risk DESC, order_value DESC LIMIT 500""",

    # Buying: "Stop buying" / don't-buy - by capital tied up.
    "buying.dont_buy_list": BUY + """SELECT sku, product_name, on_hand,
       round(dos::numeric, 1) AS days_of_supply,
       round(capital_tied::numeric, 2) AS capital_tied,
       round(rf::numeric, 2) AS trend, u365 AS units_365, days_since AS days_since_sold
FROM dont ORDER BY capital_tied DESC LIMIT 500""",

    # Buying: "Demand heating up" - accelerating sellers (trend >= 1.3x, real
    # volume, still selling, last 28d at or above their own baseline). trend is
    # the 90d factor once a SKU has >90 days on the shelf, else the 28d one;
    # days_of_supply is cover at the projected pace (agrees with proj_30d).
    "buying.accelerating": BUY + """SELECT sku, product_name, round(rf::numeric, 2) AS trend,
       u28 AS units_28, u90 AS units_90, u365 AS units_365,
       round(proj_30d::numeric, 1) AS proj_30d, on_hand,
       round(dos_trend::numeric, 1) AS days_of_supply,
       round(dos::numeric, 1) AS days_of_supply_base,
       CASE WHEN days_live > 90 THEN '90d' ELSE '28d' END AS trend_basis,
       days_live, round(rf90::numeric, 2) AS trend_90d, round(rf28::numeric, 2) AS trend_28d,
       days_since AS days_since_sold
FROM accel ORDER BY round(rf::numeric, 2) DESC, u90 DESC, sku LIMIT 40""",

    # Buying: "What's slipping" - lost sales while out of stock.
    "buying.lost_sales": BUY + """SELECT sku, product_name, days_since AS days_out,
       u30 AS units_30, u90 AS units_90,
       round(base_daily::numeric, 2) AS daily_rate,
       round(lost_units::numeric, 1) AS lost_units,
       round((lost_units * p2)::numeric, 2) AS lost_revenue,
       round((base_daily * p2)::numeric, 2) AS ongoing_daily_loss
FROM lost
ORDER BY COALESCE(CASE WHEN cost IS NOT NULL AND p2 <> 0 THEN lost_units * (p2 - cost) END, lost_units * p2) DESC
LIMIT 500""",

    # Basket: count of strong bundle ideas (pairs with lift > 1.2).
    "basket.strong_bundle_count": BSK_E + "SELECT count(*) AS strong_bundle_count FROM enriched WHERE lift >= 1.2",

    # Basket: strongest bundle ideas (lift >= 1.2), then most frequent co-purchases.
    "basket.top_bundles": BSK_E + "SELECT * FROM enriched WHERE lift >= 1.2 ORDER BY lift DESC LIMIT 500",
    "basket.top_by_volume": BSK_E + "SELECT * FROM enriched ORDER BY together_count DESC LIMIT 500",

    # Loss: items rung as free (price > $1 but $0 collected), by value given away.
    "lossprev.free_giveaways": LOSSX + """SELECT p.sku, max(p.product_name) AS product_name,
       max(p.category) AS category, count(*) AS lines, sum(si.quantity) AS units,
       max(p.price) AS price, round(sum(p.price*si.quantity)::numeric, 2) AS value_given_away
FROM sale_items si JOIN mprod p ON p.jk=si.sku CROSS JOIN params CROSS JOIN void_ids CROSS JOIN since
WHERE si.client_id=params.cid AND si.sale_date >= since.d AND si.quantity>0
  AND si.total_amount >= 0 AND si.total_amount <= 0.01 AND p.price > 1.00
  AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(void_ids.ids)))
GROUP BY p.sku ORDER BY value_given_away DESC LIMIT 50""",

    # Loss: items sold below cost, by margin lost.
    "lossprev.below_cost": LOSSX + """SELECT p.sku, max(p.product_name) AS product_name,
       max(p.category) AS category, count(*) AS lines, sum(si.quantity) AS units,
       round(sum(p.cost*si.quantity - si.total_amount)::numeric, 2) AS margin_lost
FROM sale_items si JOIN mprod p ON p.jk=si.sku CROSS JOIN params CROSS JOIN void_ids CROSS JOIN since
WHERE si.client_id=params.cid AND si.sale_date >= since.d AND si.quantity>0
  AND p.cost>0 AND si.total_amount < p.cost*si.quantity
  AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(void_ids.ids)))
GROUP BY p.sku ORDER BY margin_lost DESC LIMIT 50""",

    # Market: you vs your area on YOUR top products (exact-UPC, both sell it).
    "market.head_to_head": MKT + """SELECT product_name, category, my_sold AS my_units_sold,
       area_units, peer_stores, array_to_string(store_ids, ',') AS selling_store_ids,
       round(area_units::numeric/peer_stores) AS peer_units_per_store,
       round((my_sold::numeric / NULLIF(round(area_units::numeric/peer_stores), 0)), 2) AS area_index,
       round(myp::numeric, 2) AS my_price, round(ap::numeric, 2) AS area_price
FROM pp WHERE upc IN (SELECT unnest(ids) FROM my_top) ORDER BY my_sold DESC LIMIT 500""",

    # Market: your top sellers priced >= 10% ABOVE the area (revenue exposed).
    "market.priced_above": MKT + """SELECT product_name, category,
       round(myp::numeric, 2) AS my_price, round(ap::numeric, 2) AS area_price,
       round((100*diff)::numeric, 1) AS diff_pct, my_sold AS my_units, area_units, peer_stores,
       round(area_units::numeric/peer_stores) AS peer_units_per_store,
       round((my_sold::numeric * peer_stores / NULLIF(area_units, 0)), 2) AS sell_index,
       array_to_string(store_ids, ',') AS selling_store_ids,
       round((GREATEST(ap-myp, 0)*my_sold)::numeric, 2) AS margin_left_90d,
       round((myp*my_sold)::numeric, 2) AS revenue_exposed_90d
FROM pp WHERE diff >= 0.10 ORDER BY round((100*diff)::numeric, 1) DESC LIMIT 500""",

    # Market: your top sellers priced >= 10% BELOW the area (margin left on table).
    "market.priced_below": MKT + """SELECT product_name, category,
       round(myp::numeric, 2) AS my_price, round(ap::numeric, 2) AS area_price,
       round((100*diff)::numeric, 1) AS diff_pct, my_sold AS my_units, area_units, peer_stores,
       round(area_units::numeric/peer_stores) AS peer_units_per_store,
       round((my_sold::numeric * peer_stores / NULLIF(area_units, 0)), 2) AS sell_index,
       array_to_string(store_ids, ',') AS selling_store_ids,
       round((GREATEST(ap-myp, 0)*my_sold)::numeric, 2) AS margin_left_90d,
       0.0 AS revenue_exposed_90d
FROM pp WHERE diff <= -0.10 ORDER BY round((100*diff)::numeric, 1) ASC LIMIT 500""",

    # Market: stocking opportunities (regional sellers I don't carry by UPC or by
    # brand/name dedupe), by projected annual profit. Sum of profit = "Stocking upside".
    "market.opportunities": MKT_OPP + """SELECT upc, product_name, category,
       units::int AS peer_units, stores AS peer_stores,
       array_to_string(store_ids, ',') AS selling_store_ids, avg_price,
       round(peer_cost::numeric, 2) AS est_unit_cost, round(unit_margin::numeric, 2) AS est_unit_margin,
       round(est_annual_units::numeric) AS est_annual_units,
       round((est_annual_units*avg_price)::numeric, 2) AS est_annual_revenue,
       round((est_annual_units*unit_margin)::numeric, 2) AS projected_annual_profit,
       CASE WHEN peer_cost IS NOT NULL THEN 'peer cost' ELSE 'category default 30%' END AS margin_basis
FROM opp2 WHERE NOT i_carry ORDER BY round((est_annual_units*avg_price)::numeric, 2) DESC LIMIT 500""",

    # Market: "Regional assortment" - of the top area SKUs, how many you carry.
    "market.regional_assortment": MKT_OPP + """SELECT count(*) AS regional_sku_count,
       count(*) FILTER (WHERE i_carry) AS carried_count,
       count(*) FILTER (WHERE NOT i_carry) AS opportunity_count
FROM opp2""",

    # Inventory money-leaks: biggest likely-wasted markdowns (discount on SKUs that
    # sell well anyway), confirmed first then by dollars given away.
    "money_leaks.top_wasted_discounts": MLK + """SELECT sku, product_name, category,
       klass AS velocity_class, round(discount::numeric, 2) AS discount_given,
       units::int AS units, COALESCE(units_discounted, 0)::int AS units_discounted,
       round((100*share)::numeric, 1) AS discount_share_pct,
       CASE WHEN is_confirmed THEN 'confirmed'
            WHEN share IS NOT NULL THEN 'uncertain' ELSE 'low-volume' END AS confidence
FROM ml2 WHERE is_wasted ORDER BY is_confirmed DESC, discount DESC LIMIT 500""",
}
