"""Run every section's reproduction SQL against the live warehouse and compare
to StoreAgent (read-only). Single command: ./.venv/bin/python sql_checks/verify_all.py"""
import psycopg
from psycopg.rows import dict_row
from storeagent.config import SOURCE
from storeagent.api.service import run_capability

SQLS = {
  'inventory': r'''WITH params AS (SELECT %(cid)s::int AS cid),
asof AS (
  SELECT max(s.sale_date)::date AS as_of FROM sales s, params WHERE s.client_id = params.cid
),
void_ids AS (
  SELECT COALESCE(array_agg(sale_id), '{}'::text[]) AS ids
  FROM sales, params WHERE client_id = params.cid AND sale_status='VOID' AND sale_id IS NOT NULL
),
vel AS (
  SELECT si.sku,
         trunc(COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof) - 30), 0))::bigint  AS u30,
         trunc(COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof) - 90), 0))::bigint  AS u90,
         trunc(COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof) - 365), 0))::bigint AS u365,
         max(si.sale_date)::date AS last_sale
  FROM sale_items si, params, void_ids
  WHERE si.client_id = params.cid
    AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(void_ids.ids)))
  GROUP BY si.sku
),
pcost AS (
  SELECT DISTINCT ON (sku) sku, cost::float AS pcost
  FROM purchases, params
  WHERE client_id = params.cid AND sku IS NOT NULL AND cost IS NOT NULL AND cost > 0
  -- purchase day = COALESCE(date, invoice_date) minus sentinels: LiquorPOS
  -- stores carry -infinity in `date` (storeagent/source/purchase_day.py)
  ORDER BY sku, COALESCE(NULLIF(date, '-infinity'), NULLIF(invoice_date, '-infinity')) DESC NULLS LAST, id DESC
),
prod AS (
  SELECT sku, upc, product_name, category, price::float AS price,
         cost::float AS raw_cost,
         COALESCE(stock_qty,0)::int AS stock_raw,
         GREATEST(COALESCE(stock_qty,0),0)::int AS on_hand
  FROM (
    SELECT *, row_number() OVER (PARTITION BY sku ORDER BY stock_qty DESC NULLS LAST, sku) AS rn_sku
    FROM products, params
    WHERE client_id=params.cid AND COALESCE(is_deleted,false)=false AND sku IS NOT NULL
  ) d WHERE rn_sku = 1
),
-- Each sale key claimed by ONE product: a sale line's key can be the product's
-- internal sku OR its barcode, so both keys claim; sku match beats upc match,
-- then the row holding stock wins (mirrors inventory_repo's two-pass claim).
key_claim AS (
  SELECT DISTINCT ON (jk) jk, psku FROM (
    SELECT sku AS jk, 0 AS jk_pri, stock_raw, sku AS psku FROM prod WHERE sku IS NOT NULL AND sku <> ''
    UNION ALL
    SELECT upc AS jk, 1 AS jk_pri, stock_raw, sku AS psku FROM prod WHERE upc IS NOT NULL AND upc <> ''
  ) q ORDER BY jk, jk_pri, stock_raw DESC, psku
),
pvel AS (  -- velocity claimed under BOTH keys, summed per product
  SELECT k.psku AS sku, sum(v.u30) AS u30, sum(v.u90) AS u90, sum(v.u365) AS u365,
         max(v.last_sale) AS last_sale
  FROM key_claim k JOIN vel v ON v.sku = k.jk
  GROUP BY k.psku
),
base AS (
  SELECT p.sku, p.product_name, p.price, p.on_hand,
    regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g')     AS ncat_dbg,
    COALESCE(
    CASE
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'cigar|cigarette|tobacco|\yvape\y|juul|nicotine|backwoods|swisher|hemp\s*wrap|rolling\s*paper' THEN 'Tobacco'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ '\ycbd\y|\ythc\y|delta[\s-]*9|delta[\s-]*8|\yd9\y|\yd8\y|kratom|\d+\s*mg\y' THEN 'CBD/Cannabis'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'seltzer|ready[\s-]*to[\s-]*drink|\yrtd\y|hard\s*(cider|tea|seltzer|kombucha)|canned\s*cocktail|can\s*cocktail|white\s*claw|truly|high\s*noon' THEN 'RTD/Seltzer'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ '\ybeer\y|\yipa\y|lager|\yale\y|pilsen|stout|porter|\ycider\y|hefe|saison|kolsch|\ybrew\y|pale\s*lager|malt\y|domestic|imported\s*beer|wild/?sour|sour\y' THEN 'Beer'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ '\ywine\y|cabernet|chardonnay|merlot|pinot|sauvignon|riesling|zinfandel|ros[eé]\y|champagne|prosecco|sparkling|moscato|sangria|red\s*blend|\ysyrah\y|shiraz|malbec|tempranillo|\yport\y|\ysherry\y|vermouth|magnum|chianti|bordeaux|grenache|gamay|verdejo|albarino|gewurz' THEN 'Wine'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'vodka' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'whisk|bourbon|scotch|\yrye\y' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'tequila|mezcal|agave' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ '\yrum\y|rhum|cacha[cç]a' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ '\ygin\y' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'brandy|cognac|armagnac|grappa|pisco|calvados' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'liqueur|schnapps|cordial|aperitif|amaro|triple\s*sec|aperol|campari|sambuca|absinthe' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'spirit|liquor|alcohol|moonshine|everclear' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'mixer|tonic|\ysoda\y|\ycola\y|ginger\s*ale|club\s*soda|\yjuice\y|energy\s*drink|red\s*bull|\ywater\y|bitters|grenadine|margarita\s*mix' THEN 'Mixers/NA'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'snack|\ychip|\ycandy\y|\yfood\y|jerky|\ynuts?\y|garnish|pretzel|popcorn' THEN 'Snacks/Food'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'glass(ware)?|opener|\ycork|\ygift\y|\ybag\y|accessor|lighter|\yice\y|shaker|koozie|novelty' THEN 'Accessories/Other'
      ELSE NULL END,
    CASE
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'cigar|cigarette|tobacco|\yvape\y|juul|nicotine|backwoods|swisher|hemp\s*wrap|rolling\s*paper' THEN 'Tobacco'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ '\ycbd\y|\ythc\y|delta[\s-]*9|delta[\s-]*8|\yd9\y|\yd8\y|kratom|\d+\s*mg\y' THEN 'CBD/Cannabis'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'seltzer|ready[\s-]*to[\s-]*drink|\yrtd\y|hard\s*(cider|tea|seltzer|kombucha)|canned\s*cocktail|can\s*cocktail|white\s*claw|truly|high\s*noon' THEN 'RTD/Seltzer'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ '\ybeer\y|\yipa\y|lager|\yale\y|pilsen|stout|porter|\ycider\y|hefe|saison|kolsch|\ybrew\y|pale\s*lager|malt\y|domestic|imported\s*beer|wild/?sour|sour\y' THEN 'Beer'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ '\ywine\y|cabernet|chardonnay|merlot|pinot|sauvignon|riesling|zinfandel|ros[eé]\y|champagne|prosecco|sparkling|moscato|sangria|red\s*blend|\ysyrah\y|shiraz|malbec|tempranillo|\yport\y|\ysherry\y|vermouth|magnum|chianti|bordeaux|grenache|gamay|verdejo|albarino|gewurz' THEN 'Wine'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'vodka' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'whisk|bourbon|scotch|\yrye\y' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'tequila|mezcal|agave' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ '\yrum\y|rhum|cacha[cç]a' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ '\ygin\y' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'brandy|cognac|armagnac|grappa|pisco|calvados' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'liqueur|schnapps|cordial|aperitif|amaro|triple\s*sec|aperol|campari|sambuca|absinthe' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'spirit|liquor|alcohol|moonshine|everclear' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'mixer|tonic|\ysoda\y|\ycola\y|ginger\s*ale|club\s*soda|\yjuice\y|energy\s*drink|red\s*bull|\ywater\y|bitters|grenadine|margarita\s*mix' THEN 'Mixers/NA'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'snack|\ychip|\ycandy\y|\yfood\y|jerky|\ynuts?\y|garnish|pretzel|popcorn' THEN 'Snacks/Food'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'glass(ware)?|opener|\ycork|\ygift\y|\ybag\y|accessor|lighter|\yice\y|shaker|koozie|novelty' THEN 'Accessories/Other'
      ELSE NULL END,
    'Other') AS canonical_category,
    CASE WHEN p.raw_cost IS NOT NULL AND p.raw_cost > 0 THEN p.raw_cost
         WHEN pc.pcost IS NOT NULL AND pc.pcost > 0 THEN round(pc.pcost::numeric, 4)::float
         ELSE NULL END AS cost0,
    CASE WHEN p.raw_cost IS NOT NULL AND p.raw_cost > 0 THEN 'product'
         WHEN pc.pcost IS NOT NULL AND pc.pcost > 0 THEN 'purchases'
         ELSE 'unknown' END AS cost_source0,
    COALESCE(v.u30,0) AS units_30,
    COALESCE(v.u90,0) AS units_90,
    COALESCE(v.u365,0) AS units_365,
    v.last_sale AS last_sale_date
  FROM prod p
  LEFT JOIN pcost pc ON pc.sku = p.sku
  LEFT JOIN pvel v ON v.sku = p.sku
),
cat_margin AS (
  SELECT canonical_category,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY (price - cost0)/price) AS mm
  FROM base
  WHERE cost0 IS NOT NULL AND price IS NOT NULL AND price > 0 AND cost_source0 IN ('product','purchases')
    AND (price - cost0)/price > 0 AND (price - cost0)/price < 0.95
  GROUP BY canonical_category
),
overall_margin AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (price - cost0)/price) AS mm
  FROM base
  WHERE cost0 IS NOT NULL AND price IS NOT NULL AND price > 0 AND cost_source0 IN ('product','purchases')
    AND (price - cost0)/price > 0 AND (price - cost0)/price < 0.95
),
imputed AS (
  SELECT b.*,
    CASE WHEN b.cost0 IS NOT NULL THEN b.cost0
         WHEN b.price IS NOT NULL AND b.price > 0 AND COALESCE(cm.mm, om.mm) IS NOT NULL
           THEN round((b.price * (1 - COALESCE(cm.mm, om.mm)))::numeric, 4)::float
         ELSE NULL END AS cost,
    CASE WHEN b.cost0 IS NOT NULL THEN b.cost_source0
         WHEN b.price IS NOT NULL AND b.price > 0 AND COALESCE(cm.mm, om.mm) IS NOT NULL THEN 'imputed'
         ELSE 'unknown' END AS cost_source
  FROM base b
  LEFT JOIN cat_margin cm ON cm.canonical_category = b.canonical_category
  CROSS JOIN overall_margin om
),
fast_cut AS (
  SELECT percentile_cont(0.8) WITHIN GROUP (ORDER BY dv) AS c FROM (
    SELECT CASE WHEN units_90>0 THEN units_90/90.0 WHEN units_365>0 THEN units_365/365.0 ELSE 0 END AS dv
    FROM imputed
  ) r WHERE dv > 0
),
prem_cut AS (
  SELECT GREATEST(40.0, COALESCE(percentile_cont(0.8) WITHIN GROUP (ORDER BY price), 0)) AS c
  FROM imputed WHERE on_hand > 0 AND price IS NOT NULL AND price > 0
),
enriched AS (
  SELECT i.*,
    ((SELECT as_of FROM asof) - last_sale_date) AS dsl,
    -- s.daily_velocity = round(_daily_velocity(s), 4); days_of_supply uses this rounded value
    round((CASE WHEN units_90>0 THEN units_90/90.0 WHEN units_365>0 THEN units_365/365.0 ELSE 0 END)::numeric, 4) AS daily_velocity
  FROM imputed i
),
enriched2 AS (
  SELECT e.*,
    CASE WHEN daily_velocity > 0 THEN round((on_hand/daily_velocity)::numeric, 1) ELSE NULL END AS days_of_supply
  FROM enriched e
),
classed AS (
  SELECT e.*,
    CASE
      WHEN units_365 = 0 AND last_sale_date IS NULL THEN 'never_sold'
      WHEN dsl IS NOT NULL AND dsl > 180 THEN 'dead'
      WHEN dsl IS NOT NULL AND dsl <= 30 AND (
             (daily_velocity >= (SELECT c FROM fast_cut) AND (SELECT c FROM fast_cut) > 0)
             OR (days_of_supply IS NOT NULL AND days_of_supply < 21)
           ) THEN 'fast'
      WHEN (dsl IS NOT NULL AND dsl > 90) OR (days_of_supply IS NOT NULL AND days_of_supply > 180) THEN 'slow'
      ELSE 'normal'
    END AS velocity_class,
    (price IS NOT NULL AND price >= (SELECT c FROM prem_cut)) AS is_premium
  FROM enriched2 e
),
final AS (
  SELECT c.*,
    on_hand * COALESCE(cost,0) AS value_at_cost,
    CASE WHEN velocity_class IN ('dead','never_sold') AND on_hand>0
         THEN round((on_hand * COALESCE(cost,0))::numeric, 2) ELSE 0 END AS frozen_capital
  FROM classed c
)
SELECT
  round(sum(value_at_cost) FILTER (WHERE on_hand>0)::numeric, 2) AS inventory_at_cost,
  round(sum(value_at_cost) FILTER (WHERE on_hand>0 AND velocity_class IN ('dead','never_sold'))::numeric, 2) AS frozen_dead,
  round(sum(value_at_cost) FILTER (WHERE on_hand>0 AND velocity_class='slow')::numeric, 2) AS slow_capital,
  count(*) FILTER (WHERE velocity_class='fast') AS fast_skus,
  count(*) FILTER (WHERE velocity_class='normal') AS normal_skus,
  count(*) FILTER (WHERE velocity_class='slow') AS slow_skus,
  count(*) FILTER (WHERE velocity_class='dead') AS dead_skus,
  count(*) FILTER (WHERE velocity_class='never_sold') AS never_skus,
  count(*) AS total_skus,
  count(*) FILTER (WHERE velocity_class IN ('dead','never_sold') AND on_hand>0) AS dead_sku_count,
  count(*) FILTER (WHERE velocity_class IN ('dead','never_sold') AND on_hand>0 AND NOT is_premium) AS actionable_sku_count,
  round(sum(frozen_capital) FILTER (WHERE velocity_class IN ('dead','never_sold') AND on_hand>0 AND NOT is_premium)::numeric, 2) AS actionable_frozen_capital
FROM final;''',
  'pricing': r'''WITH params AS (SELECT %(cid)s::int AS cid),
asof AS (SELECT max(s.sale_date)::date AS as_of FROM sales s, params WHERE s.client_id = params.cid),
void_ids AS (
  SELECT COALESCE(array_agg(sale_id), '{}'::text[]) AS ids
  FROM sales, params WHERE client_id = params.cid AND sale_status='VOID' AND sale_id IS NOT NULL
),
vel AS (
  SELECT si.sku,
         trunc(COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof) - 30), 0))::bigint  AS u30,
         trunc(COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof) - 90), 0))::bigint  AS u90,
         trunc(COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof) - 365), 0))::bigint AS u365,
         max(si.sale_date)::date AS last_sale
  FROM sale_items si, params, void_ids
  WHERE si.client_id = params.cid
    AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(void_ids.ids)))
  GROUP BY si.sku
),
pcost AS (
  SELECT DISTINCT ON (sku) sku, cost::float AS pcost
  FROM purchases, params
  WHERE client_id = params.cid AND sku IS NOT NULL AND cost IS NOT NULL AND cost > 0
  -- purchase day = COALESCE(date, invoice_date) minus sentinels: LiquorPOS
  -- stores carry -infinity in `date` (storeagent/source/purchase_day.py)
  ORDER BY sku, COALESCE(NULLIF(date, '-infinity'), NULLIF(invoice_date, '-infinity')) DESC NULLS LAST, id DESC
),
prod AS (
  SELECT sku, upc, product_name, category, price::float AS price, cost::float AS raw_cost,
         COALESCE(stock_qty,0)::int AS stock_raw,
         GREATEST(COALESCE(stock_qty,0),0)::int AS on_hand
  FROM (
    SELECT *, row_number() OVER (PARTITION BY sku ORDER BY stock_qty DESC NULLS LAST, sku) AS rn_sku
    FROM products, params
    WHERE client_id=params.cid AND COALESCE(is_deleted,false)=false AND sku IS NOT NULL
  ) d WHERE rn_sku = 1
),
key_claim AS (  -- one product per sale key: sku match beats upc match, then stock
  SELECT DISTINCT ON (jk) jk, psku FROM (
    SELECT sku AS jk, 0 AS jk_pri, stock_raw, sku AS psku FROM prod WHERE sku IS NOT NULL AND sku <> ''
    UNION ALL
    SELECT upc AS jk, 1 AS jk_pri, stock_raw, sku AS psku FROM prod WHERE upc IS NOT NULL AND upc <> ''
  ) q ORDER BY jk, jk_pri, stock_raw DESC, psku
),
pvel AS (  -- velocity claimed under BOTH keys, summed per product
  SELECT k.psku AS sku, sum(v.u30) AS u30, sum(v.u90) AS u90, sum(v.u365) AS u365,
         max(v.last_sale) AS last_sale
  FROM key_claim k JOIN vel v ON v.sku = k.jk
  GROUP BY k.psku
),
base AS (
  SELECT p.sku, p.product_name, p.price, p.on_hand,
    COALESCE(
    CASE
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'cigar|cigarette|tobacco|\yvape\y|juul|nicotine|backwoods|swisher|hemp\s*wrap|rolling\s*paper' THEN 'Tobacco'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ '\ycbd\y|\ythc\y|delta[\s-]*9|delta[\s-]*8|\yd9\y|\yd8\y|kratom|\d+\s*mg\y' THEN 'CBD/Cannabis'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'seltzer|ready[\s-]*to[\s-]*drink|\yrtd\y|hard\s*(cider|tea|seltzer|kombucha)|canned\s*cocktail|can\s*cocktail|white\s*claw|truly|high\s*noon' THEN 'RTD/Seltzer'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ '\ybeer\y|\yipa\y|lager|\yale\y|pilsen|stout|porter|\ycider\y|hefe|saison|kolsch|\ybrew\y|pale\s*lager|malt\y|domestic|imported\s*beer|wild/?sour|sour\y' THEN 'Beer'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ '\ywine\y|cabernet|chardonnay|merlot|pinot|sauvignon|riesling|zinfandel|ros[eé]\y|champagne|prosecco|sparkling|moscato|sangria|red\s*blend|\ysyrah\y|shiraz|malbec|tempranillo|\yport\y|\ysherry\y|vermouth|magnum|chianti|bordeaux|grenache|gamay|verdejo|albarino|gewurz' THEN 'Wine'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'vodka' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'whisk|bourbon|scotch|\yrye\y' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'tequila|mezcal|agave' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ '\yrum\y|rhum|cacha[cç]a' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ '\ygin\y' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'brandy|cognac|armagnac|grappa|pisco|calvados' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'liqueur|schnapps|cordial|aperitif|amaro|triple\s*sec|aperol|campari|sambuca|absinthe' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'spirit|liquor|alcohol|moonshine|everclear' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'mixer|tonic|\ysoda\y|\ycola\y|ginger\s*ale|club\s*soda|\yjuice\y|energy\s*drink|red\s*bull|\ywater\y|bitters|grenadine|margarita\s*mix' THEN 'Mixers/NA'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'snack|\ychip|\ycandy\y|\yfood\y|jerky|\ynuts?\y|garnish|pretzel|popcorn' THEN 'Snacks/Food'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'glass(ware)?|opener|\ycork|\ygift\y|\ybag\y|accessor|lighter|\yice\y|shaker|koozie|novelty' THEN 'Accessories/Other'
      ELSE NULL END,
    CASE
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'cigar|cigarette|tobacco|\yvape\y|juul|nicotine|backwoods|swisher|hemp\s*wrap|rolling\s*paper' THEN 'Tobacco'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ '\ycbd\y|\ythc\y|delta[\s-]*9|delta[\s-]*8|\yd9\y|\yd8\y|kratom|\d+\s*mg\y' THEN 'CBD/Cannabis'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'seltzer|ready[\s-]*to[\s-]*drink|\yrtd\y|hard\s*(cider|tea|seltzer|kombucha)|canned\s*cocktail|can\s*cocktail|white\s*claw|truly|high\s*noon' THEN 'RTD/Seltzer'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ '\ybeer\y|\yipa\y|lager|\yale\y|pilsen|stout|porter|\ycider\y|hefe|saison|kolsch|\ybrew\y|pale\s*lager|malt\y|domestic|imported\s*beer|wild/?sour|sour\y' THEN 'Beer'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ '\ywine\y|cabernet|chardonnay|merlot|pinot|sauvignon|riesling|zinfandel|ros[eé]\y|champagne|prosecco|sparkling|moscato|sangria|red\s*blend|\ysyrah\y|shiraz|malbec|tempranillo|\yport\y|\ysherry\y|vermouth|magnum|chianti|bordeaux|grenache|gamay|verdejo|albarino|gewurz' THEN 'Wine'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'vodka' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'whisk|bourbon|scotch|\yrye\y' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'tequila|mezcal|agave' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ '\yrum\y|rhum|cacha[cç]a' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ '\ygin\y' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'brandy|cognac|armagnac|grappa|pisco|calvados' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'liqueur|schnapps|cordial|aperitif|amaro|triple\s*sec|aperol|campari|sambuca|absinthe' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'spirit|liquor|alcohol|moonshine|everclear' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'mixer|tonic|\ysoda\y|\ycola\y|ginger\s*ale|club\s*soda|\yjuice\y|energy\s*drink|red\s*bull|\ywater\y|bitters|grenadine|margarita\s*mix' THEN 'Mixers/NA'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'snack|\ychip|\ycandy\y|\yfood\y|jerky|\ynuts?\y|garnish|pretzel|popcorn' THEN 'Snacks/Food'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'glass(ware)?|opener|\ycork|\ygift\y|\ybag\y|accessor|lighter|\yice\y|shaker|koozie|novelty' THEN 'Accessories/Other'
      ELSE NULL END,
    'Other') AS canonical_category,
    CASE WHEN p.raw_cost IS NOT NULL AND p.raw_cost > 0 THEN p.raw_cost
         WHEN pc.pcost IS NOT NULL AND pc.pcost > 0 THEN round(pc.pcost::numeric, 4)::float
         ELSE NULL END AS cost0,
    CASE WHEN p.raw_cost IS NOT NULL AND p.raw_cost > 0 THEN 'product'
         WHEN pc.pcost IS NOT NULL AND pc.pcost > 0 THEN 'purchases' ELSE 'unknown' END AS cost_source0,
    COALESCE(v.u30,0) AS units_30,
    COALESCE(v.u90,0) AS units_90,
    COALESCE(v.u365,0) AS units_365,
    v.last_sale AS last_sale_date
  FROM prod p
  LEFT JOIN pcost pc ON pc.sku = p.sku
  LEFT JOIN pvel v ON v.sku = p.sku
),
cat_margin AS (
  SELECT canonical_category, percentile_cont(0.5) WITHIN GROUP (ORDER BY (price - cost0)/price) AS mm
  FROM base WHERE cost0 IS NOT NULL AND price IS NOT NULL AND price > 0 AND cost_source0 IN ('product','purchases')
    AND (price - cost0)/price > 0 AND (price - cost0)/price < 0.95
  GROUP BY canonical_category
),
overall_margin AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (price - cost0)/price) AS mm
  FROM base WHERE cost0 IS NOT NULL AND price IS NOT NULL AND price > 0 AND cost_source0 IN ('product','purchases')
    AND (price - cost0)/price > 0 AND (price - cost0)/price < 0.95
),
imputed AS (
  SELECT b.*,
    CASE WHEN b.cost0 IS NOT NULL THEN b.cost0
         WHEN b.price IS NOT NULL AND b.price > 0 AND COALESCE(cm.mm, om.mm) IS NOT NULL
           THEN round((b.price * (1 - COALESCE(cm.mm, om.mm)))::numeric, 4)::float
         ELSE NULL END AS cost,
    CASE WHEN b.cost0 IS NOT NULL THEN b.cost_source0
         WHEN b.price IS NOT NULL AND b.price > 0 AND COALESCE(cm.mm, om.mm) IS NOT NULL THEN 'imputed'
         ELSE 'unknown' END AS cost_source
  FROM base b
  LEFT JOIN cat_margin cm ON cm.canonical_category = b.canonical_category
  CROSS JOIN overall_margin om
),
fast_cut AS (
  SELECT percentile_cont(0.8) WITHIN GROUP (ORDER BY dv) AS c FROM (
    SELECT CASE WHEN units_90>0 THEN units_90/90.0 WHEN units_365>0 THEN units_365/365.0 ELSE 0 END AS dv FROM imputed
  ) r WHERE dv > 0
),
prem_cut AS (
  SELECT GREATEST(40.0, COALESCE(percentile_cont(0.8) WITHIN GROUP (ORDER BY price), 0)) AS c
  FROM imputed WHERE on_hand > 0 AND price IS NOT NULL AND price > 0
),
enriched AS (
  SELECT i.*,
    ((SELECT as_of FROM asof) - last_sale_date) AS dsl,
    round((CASE WHEN units_90>0 THEN units_90/90.0 WHEN units_365>0 THEN units_365/365.0 ELSE 0 END)::numeric, 4) AS daily_velocity,
    CASE WHEN cost IS NOT NULL AND price IS NOT NULL AND price > 0
         THEN round(((price - cost)/price)::numeric, 4) ELSE NULL END AS margin_pct
  FROM imputed i
),
enriched2 AS (
  SELECT e.*, CASE WHEN daily_velocity > 0 THEN round((on_hand/daily_velocity)::numeric, 1) ELSE NULL END AS days_of_supply
  FROM enriched e
),
ds AS (
  SELECT c.*,
    CASE
      WHEN units_365 = 0 AND last_sale_date IS NULL THEN 'never_sold'
      WHEN dsl IS NOT NULL AND dsl > 180 THEN 'dead'
      WHEN dsl IS NOT NULL AND dsl <= 30 AND (
             (daily_velocity >= (SELECT c FROM fast_cut) AND (SELECT c FROM fast_cut) > 0)
             OR (days_of_supply IS NOT NULL AND days_of_supply < 21)) THEN 'fast'
      WHEN (dsl IS NOT NULL AND dsl > 90) OR (days_of_supply IS NOT NULL AND days_of_supply > 180) THEN 'slow'
      ELSE 'normal'
    END AS velocity_class,
    (price IS NOT NULL AND price >= (SELECT c FROM prem_cut)) AS is_premium,
    on_hand * COALESCE(cost,0) AS value_at_cost
  FROM enriched2 c
),
cat_med AS (
  SELECT canonical_category, percentile_cont(0.5) WITHIN GROUP (ORDER BY margin_pct) AS med
  FROM ds WHERE margin_pct IS NOT NULL AND cost IS NOT NULL AND cost <> 0 AND price IS NOT NULL AND price > 0
  GROUP BY canonical_category HAVING count(*) >= 5
),
overall AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY margin_pct) AS med
  FROM ds WHERE margin_pct IS NOT NULL AND cost IS NOT NULL AND cost <> 0 AND price IS NOT NULL AND price > 0
),
elig AS (
  -- Python round() is half-to-even on floats; double-precision round() matches it.
  SELECT d.*, COALESCE(cm.med, ov.med) AS med, round((d.daily_velocity*365)::double precision) AS annual_units
  FROM ds d
  LEFT JOIN cat_med cm ON cm.canonical_category = d.canonical_category
  CROSS JOIN overall ov
  WHERE d.margin_pct IS NOT NULL AND d.cost IS NOT NULL AND d.cost <> 0 AND d.price IS NOT NULL AND d.price > 0
    AND COALESCE(cm.med, ov.med) IS NOT NULL
),
raises AS (
  SELECT *, round((LEAST(price*1.20, CASE WHEN med < 1 THEN cost/(1-med) ELSE price END)*100)::double precision)/100 AS new_price
  FROM elig WHERE velocity_class IN ('fast','normal') AND annual_units > 0 AND margin_pct < med - 0.05
),
raises2 AS (
  SELECT *, round((((new_price - price) * annual_units)*100)::double precision)/100 AS upside
  FROM raises WHERE new_price > price * 1.005
),
cuts AS (
  SELECT *, round((GREATEST(GREATEST(cost*1.05, CASE WHEN med<1 THEN cost/(1-med) ELSE cost END), price*0.80)*100)::double precision)/100 AS new_price
  FROM elig WHERE velocity_class IN ('slow','dead','never_sold') AND NOT is_premium AND on_hand > 0 AND margin_pct > med + 0.05
),
cuts2 AS (
  SELECT *, round(value_at_cost::numeric, 2) AS frozen_capital FROM cuts WHERE new_price < price * 0.995
)
SELECT
  (SELECT count(*) FROM cat_med) AS category_count,
  (SELECT count(*) FROM raises2) AS raise_sku_count,
  (SELECT round(COALESCE(sum(upside),0)::numeric,2) FROM raises2) AS est_annual_margin_upside,
  (SELECT count(*) FROM cuts2) AS cut_sku_count,
  (SELECT round(COALESCE(sum(frozen_capital),0)::numeric,2) FROM cuts2) AS cut_frozen_capital''',
  'money_leaks': r'''WITH params AS (SELECT %(cid)s::int AS cid),
asof AS (SELECT max(s.sale_date)::date AS as_of FROM sales s, params WHERE s.client_id = params.cid),
void_ids AS (
  SELECT COALESCE(array_agg(sale_id), '{}'::text[]) AS ids
  FROM sales, params WHERE client_id = params.cid AND sale_status='VOID' AND sale_id IS NOT NULL
),
vel AS (
  SELECT si.sku,
         trunc(COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof) - 30), 0))::bigint  AS u30,
         trunc(COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof) - 90), 0))::bigint  AS u90,
         trunc(COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof) - 365), 0))::bigint AS u365,
         max(si.sale_date)::date AS last_sale
  FROM sale_items si, params, void_ids
  WHERE si.client_id = params.cid
    AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(void_ids.ids)))
  GROUP BY si.sku
),
pcost AS (
  SELECT DISTINCT ON (sku) sku, cost::float AS pcost
  FROM purchases, params
  WHERE client_id = params.cid AND sku IS NOT NULL AND cost IS NOT NULL AND cost > 0
  -- purchase day = COALESCE(date, invoice_date) minus sentinels: LiquorPOS
  -- stores carry -infinity in `date` (storeagent/source/purchase_day.py)
  ORDER BY sku, COALESCE(NULLIF(date, '-infinity'), NULLIF(invoice_date, '-infinity')) DESC NULLS LAST, id DESC
),
prod AS (
  SELECT sku, upc, product_name, category, price::float AS price, cost::float AS raw_cost,
         COALESCE(stock_qty,0)::int AS stock_raw,
         GREATEST(COALESCE(stock_qty,0),0)::int AS on_hand
  FROM (
    SELECT *, row_number() OVER (PARTITION BY sku ORDER BY stock_qty DESC NULLS LAST, sku) AS rn_sku
    FROM products, params
    WHERE client_id=params.cid AND COALESCE(is_deleted,false)=false AND sku IS NOT NULL
  ) d WHERE rn_sku = 1
),
key_claim AS (  -- one product per sale key: sku match beats upc match, then stock
  SELECT DISTINCT ON (jk) jk, psku FROM (
    SELECT sku AS jk, 0 AS jk_pri, stock_raw, sku AS psku FROM prod WHERE sku IS NOT NULL AND sku <> ''
    UNION ALL
    SELECT upc AS jk, 1 AS jk_pri, stock_raw, sku AS psku FROM prod WHERE upc IS NOT NULL AND upc <> ''
  ) q ORDER BY jk, jk_pri, stock_raw DESC, psku
),
pvel AS (  -- velocity claimed under BOTH keys, summed per product
  SELECT k.psku AS sku, sum(v.u30) AS u30, sum(v.u90) AS u90, sum(v.u365) AS u365,
         max(v.last_sale) AS last_sale
  FROM key_claim k JOIN vel v ON v.sku = k.jk
  GROUP BY k.psku
),
base AS (
  SELECT p.sku, p.product_name, p.price, p.on_hand,
    COALESCE(
    CASE
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'cigar|cigarette|tobacco|\yvape\y|juul|nicotine|backwoods|swisher|hemp\s*wrap|rolling\s*paper' THEN 'Tobacco'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ '\ycbd\y|\ythc\y|delta[\s-]*9|delta[\s-]*8|\yd9\y|\yd8\y|kratom|\d+\s*mg\y' THEN 'CBD/Cannabis'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'seltzer|ready[\s-]*to[\s-]*drink|\yrtd\y|hard\s*(cider|tea|seltzer|kombucha)|canned\s*cocktail|can\s*cocktail|white\s*claw|truly|high\s*noon' THEN 'RTD/Seltzer'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ '\ybeer\y|\yipa\y|lager|\yale\y|pilsen|stout|porter|\ycider\y|hefe|saison|kolsch|\ybrew\y|pale\s*lager|malt\y|domestic|imported\s*beer|wild/?sour|sour\y' THEN 'Beer'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ '\ywine\y|cabernet|chardonnay|merlot|pinot|sauvignon|riesling|zinfandel|ros[eé]\y|champagne|prosecco|sparkling|moscato|sangria|red\s*blend|\ysyrah\y|shiraz|malbec|tempranillo|\yport\y|\ysherry\y|vermouth|magnum|chianti|bordeaux|grenache|gamay|verdejo|albarino|gewurz' THEN 'Wine'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'vodka' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'whisk|bourbon|scotch|\yrye\y' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'tequila|mezcal|agave' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ '\yrum\y|rhum|cacha[cç]a' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ '\ygin\y' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'brandy|cognac|armagnac|grappa|pisco|calvados' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'liqueur|schnapps|cordial|aperitif|amaro|triple\s*sec|aperol|campari|sambuca|absinthe' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'spirit|liquor|alcohol|moonshine|everclear' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'mixer|tonic|\ysoda\y|\ycola\y|ginger\s*ale|club\s*soda|\yjuice\y|energy\s*drink|red\s*bull|\ywater\y|bitters|grenadine|margarita\s*mix' THEN 'Mixers/NA'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'snack|\ychip|\ycandy\y|\yfood\y|jerky|\ynuts?\y|garnish|pretzel|popcorn' THEN 'Snacks/Food'
      WHEN regexp_replace(lower(trim(COALESCE(p.category,''))), '\s+', ' ', 'g') ~ 'glass(ware)?|opener|\ycork|\ygift\y|\ybag\y|accessor|lighter|\yice\y|shaker|koozie|novelty' THEN 'Accessories/Other'
      ELSE NULL END,
    CASE
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'cigar|cigarette|tobacco|\yvape\y|juul|nicotine|backwoods|swisher|hemp\s*wrap|rolling\s*paper' THEN 'Tobacco'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ '\ycbd\y|\ythc\y|delta[\s-]*9|delta[\s-]*8|\yd9\y|\yd8\y|kratom|\d+\s*mg\y' THEN 'CBD/Cannabis'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'seltzer|ready[\s-]*to[\s-]*drink|\yrtd\y|hard\s*(cider|tea|seltzer|kombucha)|canned\s*cocktail|can\s*cocktail|white\s*claw|truly|high\s*noon' THEN 'RTD/Seltzer'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ '\ybeer\y|\yipa\y|lager|\yale\y|pilsen|stout|porter|\ycider\y|hefe|saison|kolsch|\ybrew\y|pale\s*lager|malt\y|domestic|imported\s*beer|wild/?sour|sour\y' THEN 'Beer'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ '\ywine\y|cabernet|chardonnay|merlot|pinot|sauvignon|riesling|zinfandel|ros[eé]\y|champagne|prosecco|sparkling|moscato|sangria|red\s*blend|\ysyrah\y|shiraz|malbec|tempranillo|\yport\y|\ysherry\y|vermouth|magnum|chianti|bordeaux|grenache|gamay|verdejo|albarino|gewurz' THEN 'Wine'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'vodka' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'whisk|bourbon|scotch|\yrye\y' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'tequila|mezcal|agave' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ '\yrum\y|rhum|cacha[cç]a' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ '\ygin\y' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'brandy|cognac|armagnac|grappa|pisco|calvados' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'liqueur|schnapps|cordial|aperitif|amaro|triple\s*sec|aperol|campari|sambuca|absinthe' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'spirit|liquor|alcohol|moonshine|everclear' THEN 'Spirits'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'mixer|tonic|\ysoda\y|\ycola\y|ginger\s*ale|club\s*soda|\yjuice\y|energy\s*drink|red\s*bull|\ywater\y|bitters|grenadine|margarita\s*mix' THEN 'Mixers/NA'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'snack|\ychip|\ycandy\y|\yfood\y|jerky|\ynuts?\y|garnish|pretzel|popcorn' THEN 'Snacks/Food'
      WHEN regexp_replace(lower(trim(COALESCE(p.product_name,''))), '\s+', ' ', 'g') ~ 'glass(ware)?|opener|\ycork|\ygift\y|\ybag\y|accessor|lighter|\yice\y|shaker|koozie|novelty' THEN 'Accessories/Other'
      ELSE NULL END,
    'Other') AS canonical_category,
    CASE WHEN p.raw_cost IS NOT NULL AND p.raw_cost > 0 THEN p.raw_cost
         WHEN pc.pcost IS NOT NULL AND pc.pcost > 0 THEN round(pc.pcost::numeric, 4)::float
         ELSE NULL END AS cost0,
    CASE WHEN p.raw_cost IS NOT NULL AND p.raw_cost > 0 THEN 'product'
         WHEN pc.pcost IS NOT NULL AND pc.pcost > 0 THEN 'purchases' ELSE 'unknown' END AS cost_source0,
    COALESCE(v.u30,0) AS units_30,
    COALESCE(v.u90,0) AS units_90,
    COALESCE(v.u365,0) AS units_365,
    v.last_sale AS last_sale_date
  FROM prod p
  LEFT JOIN pcost pc ON pc.sku = p.sku
  LEFT JOIN pvel v ON v.sku = p.sku
),
cat_margin AS (
  SELECT canonical_category, percentile_cont(0.5) WITHIN GROUP (ORDER BY (price - cost0)/price) AS mm
  FROM base WHERE cost0 IS NOT NULL AND price IS NOT NULL AND price > 0 AND cost_source0 IN ('product','purchases')
    AND (price - cost0)/price > 0 AND (price - cost0)/price < 0.95
  GROUP BY canonical_category
),
overall_margin AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (price - cost0)/price) AS mm
  FROM base WHERE cost0 IS NOT NULL AND price IS NOT NULL AND price > 0 AND cost_source0 IN ('product','purchases')
    AND (price - cost0)/price > 0 AND (price - cost0)/price < 0.95
),
imputed AS (
  SELECT b.*,
    CASE WHEN b.cost0 IS NOT NULL THEN b.cost0
         WHEN b.price IS NOT NULL AND b.price > 0 AND COALESCE(cm.mm, om.mm) IS NOT NULL
           THEN round((b.price * (1 - COALESCE(cm.mm, om.mm)))::numeric, 4)::float
         ELSE NULL END AS cost,
    CASE WHEN b.cost0 IS NOT NULL THEN b.cost_source0
         WHEN b.price IS NOT NULL AND b.price > 0 AND COALESCE(cm.mm, om.mm) IS NOT NULL THEN 'imputed'
         ELSE 'unknown' END AS cost_source
  FROM base b
  LEFT JOIN cat_margin cm ON cm.canonical_category = b.canonical_category
  CROSS JOIN overall_margin om
),
fast_cut AS (
  SELECT percentile_cont(0.8) WITHIN GROUP (ORDER BY dv) AS c FROM (
    SELECT CASE WHEN units_90>0 THEN units_90/90.0 WHEN units_365>0 THEN units_365/365.0 ELSE 0 END AS dv FROM imputed
  ) r WHERE dv > 0
),
prem_cut AS (
  SELECT GREATEST(40.0, COALESCE(percentile_cont(0.8) WITHIN GROUP (ORDER BY price), 0)) AS c
  FROM imputed WHERE on_hand > 0 AND price IS NOT NULL AND price > 0
),
enriched AS (
  SELECT i.*,
    ((SELECT as_of FROM asof) - last_sale_date) AS dsl,
    round((CASE WHEN units_90>0 THEN units_90/90.0 WHEN units_365>0 THEN units_365/365.0 ELSE 0 END)::numeric, 4) AS daily_velocity,
    CASE WHEN cost IS NOT NULL AND price IS NOT NULL AND price > 0
         THEN round(((price - cost)/price)::numeric, 4) ELSE NULL END AS margin_pct
  FROM imputed i
),
enriched2 AS (
  SELECT e.*, CASE WHEN daily_velocity > 0 THEN round((on_hand/daily_velocity)::numeric, 1) ELSE NULL END AS days_of_supply
  FROM enriched e
),
ds AS (
  SELECT c.*,
    CASE
      WHEN units_365 = 0 AND last_sale_date IS NULL THEN 'never_sold'
      WHEN dsl IS NOT NULL AND dsl > 180 THEN 'dead'
      WHEN dsl IS NOT NULL AND dsl <= 30 AND (
             (daily_velocity >= (SELECT c FROM fast_cut) AND (SELECT c FROM fast_cut) > 0)
             OR (days_of_supply IS NOT NULL AND days_of_supply < 21)) THEN 'fast'
      WHEN (dsl IS NOT NULL AND dsl > 90) OR (days_of_supply IS NOT NULL AND days_of_supply > 180) THEN 'slow'
      ELSE 'normal'
    END AS velocity_class,
    (price IS NOT NULL AND price >= (SELECT c FROM prem_cut)) AS is_premium,
    on_hand * COALESCE(cost,0) AS value_at_cost
  FROM enriched2 c
),
mprod AS (
  SELECT DISTINCT ON (jk) jk, sku, price::float AS price, cost::float AS cost
  FROM (
    SELECT *, sku AS jk, 0 AS jk_pri FROM products, params
    WHERE client_id=params.cid AND COALESCE(is_deleted,false)=false AND sku IS NOT NULL AND sku<>''
    UNION ALL
    SELECT *, upc AS jk, 1 AS jk_pri FROM products, params
    WHERE client_id=params.cid AND COALESCE(is_deleted,false)=false AND upc IS NOT NULL AND upc<>''
  ) q
  WHERE jk IS NOT NULL
  ORDER BY jk, jk_pri, stock_qty DESC NULLS LAST, sku
),
margin AS (
  SELECT p.sku, max(p.price) AS price, max(p.cost) AS cost,
    sum(si.quantity) AS units,
    sum(si.discount) AS discount,
    sum(si.quantity) FILTER (WHERE si.discount > 0) AS units_discounted,
    sum(GREATEST(p.cost*si.quantity - si.total_amount, 0)) FILTER (WHERE p.cost > 0) AS below_cost_loss,
    count(*) FILTER (WHERE p.cost > 0 AND si.total_amount < p.cost*si.quantity) AS below_cost_lines
  FROM sale_items si
  JOIN mprod p ON p.jk = si.sku
  CROSS JOIN params CROSS JOIN asof CROSS JOIN void_ids
  WHERE si.client_id = params.cid AND si.sale_date >= (SELECT as_of FROM asof) - 365
    AND si.quantity > 0 AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(void_ids.ids)))
  GROUP BY p.sku
),
ml AS (
  SELECT m.*, d.velocity_class AS klass,
    CASE WHEN COALESCE(m.units,0) < 10 THEN NULL ELSE m.units_discounted::float / NULLIF(m.units,0) END AS share
  FROM margin m LEFT JOIN ds d ON d.sku = m.sku
),
ml2 AS (
  SELECT *,
    (share IS NOT NULL AND share <= 0.50) AS is_confirmed,
    (COALESCE(discount,0) > 0 AND klass IN ('fast','normal')) AS is_wasted
  FROM ml
),
agg AS (
  SELECT
    sum(discount) AS td,
    sum(discount) FILTER (WHERE is_wasted) AS wd,
    sum(discount) FILTER (WHERE is_wasted AND is_confirmed) AS cw,
    sum(below_cost_loss) AS bcl,
    sum(below_cost_lines) AS bcln,
    count(*) FILTER (WHERE cost > 0 AND price > 0 AND price < cost) AS ptl,
    COALESCE(sum(LEAST(discount, below_cost_loss)) FILTER (WHERE is_wasted AND is_confirmed AND below_cost_loss > 0), 0) AS ov
  FROM ml2
)
SELECT
  round((COALESCE(td,0)*100)::double precision)/100 AS total_discount_given,
  round((COALESCE(wd,0)*100)::double precision)/100 AS wasted_discount_estimate,
  CASE WHEN COALESCE(td,0)>0 THEN round((100*wd/td*10)::double precision)/10 ELSE 0 END AS wasted_discount_pct_of_total,
  round((COALESCE(cw,0)*100)::double precision)/100 AS elasticity_confirmed_waste,
  round(((COALESCE(wd,0)-COALESCE(cw,0))*100)::double precision)/100 AS elasticity_uncertain_waste,
  round((COALESCE(bcl,0)*100)::double precision)/100 AS below_cost_loss,
  COALESCE(bcln,0) AS below_cost_lines,
  ptl AS priced_to_lose_sku_count,
  round((GREATEST(COALESCE(cw,0) + COALESCE(bcl,0) - ov, 0)*100)::double precision)/100 AS recoverable_estimate,
  round(((COALESCE(wd,0) + COALESCE(bcl,0))*100)::double precision)/100 AS recoverable_upper_bound
FROM agg''',
  'basket': r'''WITH params AS (SELECT %(cid)s::int AS cid),
asof AS (SELECT max(sale_date)::date AS as_of FROM sales, params WHERE client_id=params.cid),
void_ids AS (SELECT COALESCE(array_agg(sale_id),'{}'::text[]) AS ids FROM sales, params WHERE client_id=params.cid AND sale_status='VOID' AND sale_id IS NOT NULL),
win AS (SELECT (SELECT as_of FROM asof) - 120 AS since),
top AS (
  SELECT si.sku, max(si.product_name) AS name
  FROM sale_items si, params, void_ids, win
  WHERE si.client_id=params.cid AND si.sale_date >= win.since AND si.quantity>0 AND si.sku IS NOT NULL
    AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(void_ids.ids)))
  GROUP BY si.sku ORDER BY sum(si.quantity) DESC, si.sku LIMIT 120
),
total AS (
  SELECT count(DISTINCT si.sale_id) AS n
  FROM sale_items si, params, void_ids, win
  WHERE si.client_id=params.cid AND si.sale_date>=win.since AND si.quantity>0 AND si.sale_id IS NOT NULL
    AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(void_ids.ids)))
),
b AS (  -- pair basis; excludes voids to match top + total (and the repo)
  SELECT DISTINCT si.sale_id, si.sku
  FROM sale_items si, params, win, void_ids
  WHERE si.client_id=params.cid AND si.sale_date>=win.since AND si.quantity>0 AND si.sale_id IS NOT NULL
    AND si.sku = ANY(ARRAY(SELECT sku FROM top))
    AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(void_ids.ids)))
),
pairs AS (  -- drop same-product self-pairs (one product under two codes share a name)
  SELECT x.sku AS a, y.sku AS b, count(*) AS pc
  FROM b x JOIN b y ON x.sale_id=y.sale_id AND x.sku < y.sku
  JOIN top ta ON ta.sku=x.sku JOIN top tb ON tb.sku=y.sku
  WHERE ta.name IS NULL OR tb.name IS NULL OR ta.name <> tb.name
  GROUP BY x.sku, y.sku HAVING count(*) >= GREATEST(4, LEAST(15, round(0.003 * (SELECT n FROM total)))) ORDER BY count(*) DESC LIMIT 60
)
SELECT (SELECT n FROM total) AS total_baskets, (SELECT count(*) FROM pairs) AS pairs_analyzed''',
  'overview': r'''WITH params AS (SELECT %(cid)s::int AS cid),
asof AS (SELECT max(sale_date)::date AS as_of FROM sales, params WHERE client_id=params.cid),
void_ids AS (SELECT COALESCE(array_agg(sale_id),'{}'::text[]) AS ids FROM sales, params WHERE client_id=params.cid AND sale_status='VOID' AND sale_id IS NOT NULL),
mprod AS (
  SELECT DISTINCT ON (jk) jk, cost::float AS cost FROM (
    SELECT *, sku AS jk, 0 AS jk_pri FROM products, params
    WHERE client_id=params.cid AND COALESCE(is_deleted,false)=false AND sku IS NOT NULL AND sku<>''
    UNION ALL
    SELECT *, upc AS jk, 1 AS jk_pri FROM products, params
    WHERE client_id=params.cid AND COALESCE(is_deleted,false)=false AND upc IS NOT NULL AND upc<>''
  ) q WHERE jk IS NOT NULL ORDER BY jk, jk_pri, stock_qty DESC NULLS LAST, sku
),
pulse AS (
  -- Receipt-subtotal basis (sales.sub_total, pre-tax net) + COUNT(*), the
  -- same query shape as the Node dashboard KPI / chat get_revenue, so the
  -- pulse can never disagree with those surfaces (overview_repo.py).
  SELECT
    COALESCE(sum(s.sub_total) FILTER (WHERE s.sale_date >= (SELECT as_of FROM asof)-30),0) AS rev_30,
    COALESCE(sum(s.sub_total) FILTER (WHERE s.sale_date >= (SELECT as_of FROM asof)-60 AND s.sale_date < (SELECT as_of FROM asof)-30),0) AS rev_prev30,
    count(*) FILTER (WHERE s.sale_date >= (SELECT as_of FROM asof)-30) AS tx_30
  FROM sales s, params
  WHERE s.client_id=params.cid AND s.sale_date >= (SELECT as_of FROM asof)-60
),
margin AS (
  SELECT COALESCE(sum(si.total_amount - p.cost*si.quantity) FILTER (WHERE p.cost>0),0) AS gross,
         COALESCE(sum(si.total_amount) FILTER (WHERE p.cost>0),0) AS rev_costed
  FROM sale_items si JOIN mprod p ON p.jk = si.sku
  CROSS JOIN params CROSS JOIN asof CROSS JOIN void_ids
  WHERE si.client_id=params.cid AND si.sale_date >= (SELECT as_of FROM asof)-90 AND si.quantity>0
    AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(void_ids.ids)))
)
SELECT
  round((rev_30*100)::double precision)/100 AS revenue_30d,
  CASE WHEN rev_prev30<>0 THEN round((100*(rev_30-rev_prev30)/rev_prev30*10)::double precision)/10 ELSE NULL END AS revenue_mom_pct,
  tx_30 AS transactions_30d,
  CASE WHEN tx_30<>0 THEN round((rev_30/tx_30*100)::double precision)/100 ELSE 0 END AS avg_basket_value,
  CASE WHEN rev_costed<>0 THEN round((100*gross/rev_costed*10)::double precision)/10 ELSE NULL END AS gross_margin_pct
FROM pulse, margin''',
  'loss': r'''WITH params AS (SELECT %(cid)s::int AS cid),
asof AS (SELECT max(sale_date)::date AS as_of FROM sales, params WHERE client_id=params.cid),
void_ids AS (SELECT COALESCE(array_agg(sale_id),'{}'::text[]) AS ids FROM sales, params WHERE client_id=params.cid AND sale_status='VOID' AND sale_id IS NOT NULL),
since AS (SELECT (SELECT as_of FROM asof) - 365 AS d, (SELECT as_of FROM asof) - 90 AS d90),
mprod AS (
  SELECT DISTINCT ON (jk) jk, price::float AS price, cost::float AS cost FROM (
    SELECT *, sku AS jk, 0 AS jk_pri FROM products, params
    WHERE client_id=params.cid AND COALESCE(is_deleted,false)=false AND sku IS NOT NULL AND sku<>''
    UNION ALL
    SELECT *, upc AS jk, 1 AS jk_pri FROM products, params
    WHERE client_id=params.cid AND COALESCE(is_deleted,false)=false AND upc IS NOT NULL AND upc<>''
  ) q WHERE jk IS NOT NULL ORDER BY jk, jk_pri, stock_qty DESC NULLS LAST, sku
),
voids AS (
  SELECT count(DISTINCT si.sale_id) AS sales, count(*) AS lines, COALESCE(sum(si.total_amount),0) AS amount
  FROM sale_items si CROSS JOIN params CROSS JOIN void_ids CROSS JOIN since
  WHERE si.client_id=params.cid AND si.sale_date >= since.d AND si.sale_id = ANY(void_ids.ids)
),
free_tot AS (
  SELECT count(*) AS lines, COALESCE(sum(si.quantity),0) AS units, COALESCE(sum(p.price*si.quantity),0) AS wbv
  FROM sale_items si JOIN mprod p ON p.jk=si.sku CROSS JOIN params CROSS JOIN void_ids CROSS JOIN since
  WHERE si.client_id=params.cid AND si.sale_date >= since.d AND si.quantity>0
    AND si.total_amount >= 0 AND si.total_amount <= 0.01 AND p.price > 1.00
    AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(void_ids.ids)))
),
below_tot AS (
  SELECT count(*) AS lines, COALESCE(sum(p.cost*si.quantity - si.total_amount),0) AS loss
  FROM sale_items si JOIN mprod p ON p.jk=si.sku CROSS JOIN params CROSS JOIN void_ids CROSS JOIN since
  WHERE si.client_id=params.cid AND si.sale_date >= since.d AND si.quantity>0
    AND p.cost>0 AND si.total_amount < p.cost*si.quantity
    AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(void_ids.ids)))
),
rets AS (  -- refunds are negative total_amount on positive qty, not negative qty
  SELECT count(*) AS lines, COALESCE(sum(si.total_amount),0) AS amount
  FROM sale_items si CROSS JOIN params CROSS JOIN since
  WHERE si.client_id=params.cid AND si.sale_date >= since.d AND si.total_amount < 0
)
SELECT
  round((((SELECT wbv FROM free_tot)+(SELECT loss FROM below_tot)+abs((SELECT amount FROM rets)))*100)::double precision)/100 AS review_exposure,
  (SELECT lines FROM free_tot)+(SELECT lines FROM below_tot)+(SELECT lines FROM rets) AS flagged_line_count,
  round(((SELECT amount FROM voids)*100)::double precision)/100 AS void_amount,
  round(((SELECT wbv FROM free_tot))::numeric,2) AS free_value_given_away,
  round(((SELECT loss FROM below_tot))::numeric,2) AS below_margin_lost,
  (SELECT lines FROM below_tot) AS below_lines,
  round((abs((SELECT amount FROM rets)))::numeric,2) AS returns_amount''',
  'customers': r'''WITH params AS (SELECT %(cid)s::int AS cid),
asof AS (SELECT max(sale_date)::date AS as_of FROM sales, params WHERE client_id=params.cid),
cust AS (
  SELECT s.customer_id, max(c.customer_name) AS name,
         COALESCE(bool_or(COALESCE(c.contact_phone, '') <> '' OR COALESCE(c.contact_email, '') <> ''), false) AS has_contact,
         count(DISTINCT s.sale_date::date) AS visits,
         min(s.sale_date)::date AS first_visit, max(s.sale_date)::date AS last_visit,
         sum(s.sub_total) AS spend
  FROM sales s
  LEFT JOIN customers c ON c.client_id=s.client_id AND c.customer_id=s.customer_id AND COALESCE(c.is_deleted,false)=false
  CROSS JOIN params
  WHERE s.client_id=params.cid AND s.customer_id <> '' AND s.sale_status <> 'VOID'
  GROUP BY s.customer_id
),
persons AS (
  SELECT * FROM cust WHERE name IS NULL OR NOT (name ~* '^[\s\-\./,]*((visa|master ?card|amex|american express|discover|credit|debit|card ?holder|cash|gift ?card|walk[ -]?in|guest|default|unknown|n/?a|manual(ly)?[ -]?(entered|entry)|no ?name|house ?account|customer|account|acct|sale|payment)[\s\-\./,]*)+$')
),
book AS (
  SELECT count(*) AS n
  FROM customers, params
  WHERE client_id=params.cid AND COALESCE(is_deleted,false)=false
    AND (COALESCE(contact_phone,'') <> '' OR COALESCE(contact_email,'') <> '')
    AND (customer_name IS NULL OR NOT (customer_name ~* '^[\s\-\./,]*((visa|master ?card|amex|american express|discover|credit|debit|card ?holder|cash|gift ?card|walk[ -]?in|guest|default|unknown|n/?a|manual(ly)?[ -]?(entered|entry)|no ?name|house ?account|customer|account|acct|sale|payment)[\s\-\./,]*)+$'))
),
enr AS (
  SELECT *, GREATEST((last_visit - first_visit), 0) AS span, ((SELECT as_of FROM asof) - last_visit) AS recency FROM persons
),
enr2 AS (
  SELECT *,
    CASE WHEN visits >= 2 THEN span::float / (visits - 1) ELSE NULL END AS cadence,
    round((spend::double precision / GREATEST(span, 90) * 365) * 100)/100 AS annual_value,
    (visits >= 4) AS is_regular
  FROM enr
),
enr3 AS (SELECT *, GREATEST(30, COALESCE(cadence,0)*2) AS churn_gap FROM enr2),
flagged AS (SELECT *, (is_regular AND cadence IS NOT NULL AND recency > churn_gap AND recency <= 180) AS at_risk FROM enr3)
SELECT
  (SELECT n FROM book) AS total_customers,
  (SELECT count(*) FROM cust) - (SELECT count(*) FROM persons) AS non_person_excluded,
  (SELECT count(*) FROM flagged WHERE at_risk) AS at_risk_count,
  round((COALESCE((SELECT sum(annual_value) FROM flagged WHERE at_risk),0))::numeric, 2) AS annual_revenue_at_risk''',
  'market': r'''WITH params AS (SELECT %(cid)s::int AS cid),
asof AS (SELECT max(sale_date)::date AS as_of FROM sales, params WHERE client_id=params.cid),
geo AS (SELECT state FROM client_locations, params WHERE client_id=params.cid LIMIT 1),
-- Statewide peers only, matching market_repo._peer_ids: liquor regulation is
-- set at the state level, so tighter city/zip tiers are intentionally not used.
peers AS (SELECT array_agg(DISTINCT cl.client_id) AS ids FROM client_locations cl, geo, params
  WHERE cl.state=geo.state AND cl.client_id<>params.cid AND COALESCE(cl.is_active,true)),
-- One catalog row per (store, sku) for barcode resolution; DISTINCT ON prefers
-- the row holding stock so recreated skus can't fan a sale line into duplicates.
pmap AS (
  SELECT DISTINCT ON (client_id, sku) client_id, sku, upc FROM products, peers, params
  WHERE (client_id = ANY(peers.ids) OR client_id = params.cid)
    AND COALESCE(is_deleted,false)=false AND sku IS NOT NULL
  ORDER BY client_id, sku, stock_qty DESC NULLS LAST
),
-- Sale lines with a canonical barcode, mirroring market_repo._canon_lines: the
-- line's upc when it is a real 8-14 digit barcode, else the store catalog's upc
-- for the line's sku (authoritative), else the sku itself when barcode-shaped
-- (internal skus can be 8+ digits, so the catalog outranks the raw sku). Many
-- POS write internal skus into sale_items.upc; NULL upc = unresolvable, excluded.
plines AS (
  SELECT COALESCE(CASE WHEN si.upc ~ '^[0-9]{8,14}$' THEN si.upc END,
                  CASE WHEN p.upc ~ '^[0-9]{8,14}$' THEN p.upc END,
                  CASE WHEN si.sku ~ '^[0-9]{8,14}$' THEN si.sku END) AS upc,
         si.client_id, si.sale_date, si.quantity, si.total_amount, si.product_name, si.category
  FROM sale_items si LEFT JOIN pmap p ON p.client_id=si.client_id AND p.sku=si.sku, peers, asof
  WHERE si.client_id = ANY(peers.ids) AND si.sale_date >= (SELECT as_of FROM asof)-90 AND si.quantity>0
),
mylines AS (
  SELECT COALESCE(CASE WHEN si.upc ~ '^[0-9]{8,14}$' THEN si.upc END,
                  CASE WHEN p.upc ~ '^[0-9]{8,14}$' THEN p.upc END,
                  CASE WHEN si.sku ~ '^[0-9]{8,14}$' THEN si.sku END) AS upc,
         si.sale_date, si.quantity, si.total_amount, si.product_name, si.category
  FROM sale_items si LEFT JOIN pmap p ON p.client_id=si.client_id AND p.sku=si.sku, params, asof
  WHERE si.client_id = params.cid AND si.sale_date >= (SELECT as_of FROM asof)-90 AND si.quantity>0
),
peer_rows AS (
  SELECT si.upc, sum(si.quantity) AS units, count(DISTINCT si.client_id) AS stores, array_agg(DISTINCT si.client_id) AS store_ids, sum(si.total_amount)/NULLIF(sum(si.quantity),0) AS avg_price
  FROM plines si, peers, asof, params
  WHERE si.upc IS NOT NULL
  GROUP BY si.upc HAVING count(DISTINCT si.client_id) >= 3 AND sum(si.quantity) >= 40
    -- still selling now (any peer sale in the last 14 days) ...
    AND sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof)-14) > 0
    -- ... and in stock at >= 1 active peer today (drops out-of-stock/negative-stock items)
    AND EXISTS (SELECT 1 FROM products pk, peers pe
                WHERE pk.client_id = ANY(pe.ids) AND pk.upc = si.upc
                  AND pk.stock_qty > 0 AND COALESCE(pk.is_deleted,false)=false)
  ORDER BY sum(si.quantity) DESC LIMIT 80
),
my_upc AS (
  SELECT upc, sum(quantity) AS units, sum(total_amount) AS revenue
  FROM mylines si, params, asof
  WHERE si.upc IS NOT NULL
  GROUP BY upc
),
my_top AS (SELECT array_agg(upc) AS ids FROM (SELECT upc FROM my_upc WHERE units>0 ORDER BY units DESC LIMIT 80) t),
pfm AS (  -- peer stats for EVERY UPC I sell (widened from top-80 so price
          -- positioning surfaces underperformers; head_to_head restricts to my_top)
  SELECT si.upc, sum(si.quantity) AS units, count(DISTINCT si.client_id) AS stores, array_agg(DISTINCT si.client_id) AS store_ids, sum(si.total_amount)/NULLIF(sum(si.quantity),0) AS avg_price
  FROM plines si, peers, asof, params
  WHERE si.upc IN (SELECT upc FROM my_upc WHERE units > 0)
  GROUP BY si.upc
),
pp AS (  -- price positioning over matched UPCs (my top sellers that peers also sell)
         -- prices cent-rounded FIRST so diff is reproducible from the displayed prices.
         -- Double-precision round() (banker's) mirrors Python round(float, 2); exact-
         -- NUMERIC round(x, 2) is half-AWAY-FROM-ZERO, drifts one cent on half-cent
         -- price ties, and can flip a row across the +-10% flag boundary.
  SELECT r.*, (myp - ap) / NULLIF(ap, 0) AS diff,
    -- sell-through vs the typical peer store (market.py sell_index, 2dp):
    -- < 1 = underperforming; the headline $ tiles sum ONLY those rows.
    round(((my_sold * pf_stores)::double precision / pf_units) * 100) / 100 AS sell_idx
  FROM (
    SELECT m.upc,
      round((m.revenue::double precision / m.units) * 100) / 100 AS myp,
      round(pfm.avg_price::double precision * 100) / 100 AS ap,
      m.units AS my_sold, pfm.units AS pf_units, pfm.stores AS pf_stores
    FROM pfm JOIN my_upc m ON m.upc = pfm.upc
    WHERE m.units > 0 AND pfm.stores >= 2 AND pfm.units > 0 AND m.revenue IS NOT NULL
  ) r
  WHERE ap > 0 AND abs((myp - ap) / NULLIF(ap, 0)) <= 0.60
)
SELECT
  COALESCE(array_length((SELECT ids FROM peers),1),0) AS peer_count,
  (SELECT count(*) FROM peer_rows WHERE round(avg_price::numeric,2) > 0 AND stores > 0) AS regional_sku_count,
  (SELECT count(*) FROM pp WHERE diff >= 0.10) AS priced_above_count,
  (SELECT count(*) FROM pp WHERE diff <= -0.10) AS priced_below_count,
  (SELECT count(*) FROM pp WHERE diff >= 0.10 AND sell_idx < 1) AS priced_above_underperf_count,
  (SELECT count(*) FROM pp WHERE diff <= -0.10 AND sell_idx < 1) AS priced_below_underperf_count,
  -- 90d-window actuals (units sold x price gap / price), not annualized.
  -- Underperformers only (sell_idx < 1) — matches the market.py headline tiles.
  (SELECT round((COALESCE(sum(round((GREATEST(ap-myp,0)*my_sold)*100)/100),0))::numeric,2) FROM pp WHERE diff <= -0.10 AND sell_idx < 1) AS margin_left_total,
  (SELECT round((COALESCE(sum(round((myp*my_sold)*100)/100),0))::numeric,2) FROM pp WHERE diff >= 0.10 AND sell_idx < 1) AS revenue_exposed_total''',
  'buying': r'''WITH params AS (SELECT %(cid)s::int AS cid),
asof AS (SELECT max(sale_date)::date AS as_of FROM sales, params WHERE client_id=params.cid),
void_ids AS (SELECT COALESCE(array_agg(sale_id),'{}'::text[]) AS ids FROM sales, params WHERE client_id=params.cid AND sale_status='VOID' AND sale_id IS NOT NULL),
-- Per-SKU supplier reorder cadence, mirroring source/supplier_repo.py: the
-- median gap between consecutive purchases of a SKU from its dominant supplier,
-- bounded to a sane reorder window. This is what makes coverage per-SKU instead
-- of a flat 14 days (lead 7 + review 7, the card policy's window; it was 21
-- until the review period was aligned); without it this query disagrees with
-- the app on every store that has purchase history (18 of 86 at time of writing).
-- The day is COALESCE(date, invoice_date) minus the -infinity sentinel, as in
-- supplier_repo.py: LiquorPOS stores carry -infinity in `date` on every row.
gaps AS (
  SELECT supplier_id, sku,
         COALESCE(NULLIF(date, '-infinity'), NULLIF(invoice_date, '-infinity'))::date
           - lag(COALESCE(NULLIF(date, '-infinity'), NULLIF(invoice_date, '-infinity'))::date)
             OVER (PARTITION BY supplier_id, sku
                   ORDER BY COALESCE(NULLIF(date, '-infinity'), NULLIF(invoice_date, '-infinity'))::date) AS gap
  FROM purchases, params
  WHERE client_id = params.cid
    AND COALESCE(NULLIF(date, '-infinity'), NULLIF(invoice_date, '-infinity')) >= DATE '1990-01-01'
),
sup_cycle AS (
  SELECT supplier_id,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)
           FILTER (WHERE gap BETWEEN 7 AND 120) AS median_cycle
  FROM gaps GROUP BY supplier_id
),
sku_sup AS (   -- dominant supplier per sku; supplier_id breaks count ties
  SELECT DISTINCT ON (sku) sku, supplier_id FROM (
    SELECT sku, supplier_id, count(*) AS cnt
    FROM purchases, params WHERE client_id = params.cid
      AND COALESCE(NULLIF(date, '-infinity'), NULLIF(invoice_date, '-infinity')) >= DATE '1990-01-01'
    GROUP BY sku, supplier_id
  ) q ORDER BY sku, cnt DESC, supplier_id
),
sku_cov AS (   -- coverage = lead_time(7) + reorder cycle, else review_period(14)
  -- supplier_repo.py uses int(round(float)), which is round-half-to-EVEN, while
  -- Postgres round() is half-away-from-zero. percentile_cont over an even number
  -- of gaps yields exact .5 medians, so the two disagree by a day without this.
  SELECT ss.sku, 7 + COALESCE((
    CASE WHEN sc.median_cycle - floor(sc.median_cycle) = 0.5
         THEN (floor(sc.median_cycle) + mod(floor(sc.median_cycle)::int, 2))::int
         ELSE round(sc.median_cycle::numeric)::int END), 14) AS coverage
  FROM sku_sup ss LEFT JOIN sup_cycle sc ON sc.supplier_id = ss.supplier_id
),
mprod AS (
  SELECT DISTINCT ON (jk) jk, sku, stock_qty, cost::float AS cost, price::float AS price FROM (
    SELECT *, sku AS jk, 0 AS jk_pri FROM products, params
    WHERE client_id=params.cid AND COALESCE(is_deleted,false)=false AND sku IS NOT NULL AND sku<>''
    UNION ALL
    SELECT *, upc AS jk, 1 AS jk_pri FROM products, params
    WHERE client_id=params.cid AND COALESCE(is_deleted,false)=false AND upc IS NOT NULL AND upc<>''
  ) q WHERE jk IS NOT NULL ORDER BY jk, jk_pri, stock_qty DESC NULLS LAST, sku
),
covdays AS (SELECT k AS coverage,
  count(*) FILTER (WHERE extract(dow from g.d)=0) AS n0, count(*) FILTER (WHERE extract(dow from g.d)=1) AS n1,
  count(*) FILTER (WHERE extract(dow from g.d)=2) AS n2, count(*) FILTER (WHERE extract(dow from g.d)=3) AS n3,
  count(*) FILTER (WHERE extract(dow from g.d)=4) AS n4, count(*) FILTER (WHERE extract(dow from g.d)=5) AS n5,
  count(*) FILTER (WHERE extract(dow from g.d)=6) AS n6
  -- weekday counts for EVERY coverage length a SKU can have (7 + cycle 7..120,
  -- plus the 14-day fallback), joined per SKU below. Was a single fixed
  -- window, which is only correct for SKUs with no supplier history.
  -- 7..127: the young-SKU cap (max(lead, days_live*2), days_live < 14)
  -- produces windows down to the 7-day lead; supplier cycles reach 127.
  FROM generate_series(7, 127) k
  CROSS JOIN LATERAL generate_series((SELECT as_of FROM asof)+1,
                                     (SELECT as_of FROM asof)+k, interval '1 day') g(d)
  GROUP BY k),
next30 AS (SELECT   -- weekday counts for the next 30 days (the proj_30d horizon)
  count(*) FILTER (WHERE extract(dow from d)=0) AS m0, count(*) FILTER (WHERE extract(dow from d)=1) AS m1,
  count(*) FILTER (WHERE extract(dow from d)=2) AS m2, count(*) FILTER (WHERE extract(dow from d)=3) AS m3,
  count(*) FILTER (WHERE extract(dow from d)=4) AS m4, count(*) FILTER (WHERE extract(dow from d)=5) AS m5,
  count(*) FILTER (WHERE extract(dow from d)=6) AS m6
  FROM generate_series((SELECT as_of FROM asof)+1, (SELECT as_of FROM asof)+30, interval '1 day') g(d)),
demand AS (
  SELECT p.sku, max(p.stock_qty) AS stock, max(p.cost)::float AS cost, max(p.price)::float AS price,
    COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof)-28),0) AS u28,
    COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof)-30),0) AS u30,
    COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date >= (SELECT as_of FROM asof)-90),0) AS u90,
    COALESCE(sum(si.quantity),0) AS u365,
    max(si.sale_date)::date AS last_sale,
    min(si.sale_date)::date AS first_sale,
    COALESCE(sum(si.quantity) FILTER (WHERE extract(dow from si.sale_date)=0),0) AS d0,
    COALESCE(sum(si.quantity) FILTER (WHERE extract(dow from si.sale_date)=1),0) AS d1,
    COALESCE(sum(si.quantity) FILTER (WHERE extract(dow from si.sale_date)=2),0) AS d2,
    COALESCE(sum(si.quantity) FILTER (WHERE extract(dow from si.sale_date)=3),0) AS d3,
    COALESCE(sum(si.quantity) FILTER (WHERE extract(dow from si.sale_date)=4),0) AS d4,
    COALESCE(sum(si.quantity) FILTER (WHERE extract(dow from si.sale_date)=5),0) AS d5,
    COALESCE(sum(si.quantity) FILTER (WHERE extract(dow from si.sale_date)=6),0) AS d6
  FROM sale_items si JOIN mprod p ON p.jk = si.sku CROSS JOIN params CROSS JOIN asof CROSS JOIN void_ids
  WHERE si.client_id=params.cid AND si.sale_date >= (SELECT as_of FROM asof)-365 AND si.quantity>0
    AND (si.sale_id IS NULL OR NOT (si.sale_id = ANY(void_ids.ids)))
  GROUP BY p.sku
),
-- Per-SKU weekday counts over the days that SKU has actually been selling
-- (mirrors SkuDemand._dow_counts). Was one store-wide 365-day count, which
-- spreads a four-week-old listing's sales over a year it wasn't stocked for.
dowc AS (SELECT dm.sku,
  count(*) FILTER (WHERE extract(dow from g.dt)=0) AS c0, count(*) FILTER (WHERE extract(dow from g.dt)=1) AS c1,
  count(*) FILTER (WHERE extract(dow from g.dt)=2) AS c2, count(*) FILTER (WHERE extract(dow from g.dt)=3) AS c3,
  count(*) FILTER (WHERE extract(dow from g.dt)=4) AS c4, count(*) FILTER (WHERE extract(dow from g.dt)=5) AS c5,
  count(*) FILTER (WHERE extract(dow from g.dt)=6) AS c6
  FROM demand dm CROSS JOIN LATERAL generate_series(
         GREATEST(dm.first_sale, (SELECT as_of FROM asof)-365),
         (SELECT as_of FROM asof), interval '1 day') g(dt)
  GROUP BY dm.sku),
calc AS (
  -- days_live = shelf age within the window; every rate divides by the SHORTER
  -- of its nominal window and that (SkuDemand._span). rf90 is the smoothed
  -- 90d-vs-lifetime trend, rf28 the 28d one; a SKU younger than 90 days has
  -- u90 = u365 so rf90 is identically 1.0 and rf28 is the only real signal.
  SELECT d.*, GREATEST(COALESCE(d.stock,0),0)::int AS on_hand,
    GREATEST(1, ((SELECT as_of FROM asof) - GREATEST(d.first_sale, (SELECT as_of FROM asof)-365)) + 1) AS days_live,
    ((SELECT as_of FROM asof) - d.last_sale) AS days_since
  FROM demand d
),
rates AS (
  SELECT c.*,
    GREATEST(1, LEAST(28,  c.days_live)) AS sp28,
    GREATEST(1, LEAST(90,  c.days_live)) AS sp90,
    GREATEST(1, LEAST(365, c.days_live)) AS sp365
  FROM calc c
),
trend AS (
  SELECT r.*,
    CASE WHEN r.u365>0 THEN GREATEST(0.3::double precision, LEAST(3.0::double precision,
            (CASE WHEN r.u90>0 THEN r.u90::double precision/r.sp90 ELSE 0 END)/(r.u365::double precision/r.sp365)))
         ELSE (CASE WHEN r.u90>0 THEN 1.0 ELSE 0.0 END) END AS rf90,
    CASE WHEN r.u365>0 THEN GREATEST(0.3::double precision, LEAST(3.0::double precision,
            (CASE WHEN r.u28>0 THEN r.u28::double precision/r.sp28 ELSE 0 END)/(r.u365::double precision/r.sp365)))
         ELSE (CASE WHEN r.u28>0 THEN 1.0 ELSE 0.0 END) END AS rf28,
    CASE WHEN r.u90>0 THEN r.u90::double precision/r.sp90
         WHEN r.u365>0 THEN r.u365::double precision/r.sp365 ELSE 0 END AS base_daily
  FROM rates r
),
trended AS (
  SELECT t.*, CASE WHEN t.days_live > 90 THEN t.rf90 ELSE t.rf28 END AS rf FROM trend t
),
covd AS (   -- attach each SKU's own coverage window (14 = no supplier history:
            -- ForecastThresholds lead 7 + review 7), capped for young SKUs at
            -- max(7, days_live*2) below 14 days of history (mirrors
            -- SkuDemand.coverage_days' young-SKU rule)
  SELECT c.*, CASE WHEN c.days_live < 14
                   THEN LEAST(COALESCE(sv.coverage, 14), GREATEST(7, (c.days_live*2)::int))
                   ELSE COALESCE(sv.coverage, 14) END AS coverage
  FROM trended c LEFT JOIN sku_cov sv ON sv.sku = c.sku
),
fc AS (
  SELECT c.*,
    CASE WHEN base_daily>0 THEN GREATEST(on_hand,0)::double precision/base_daily ELSE NULL END AS dos,
    rf * (
      (CASE WHEN dw.c0>0 THEN d0::float/dw.c0 ELSE base_daily END)*cd.n0 +
      (CASE WHEN dw.c1>0 THEN d1::float/dw.c1 ELSE base_daily END)*cd.n1 +
      (CASE WHEN dw.c2>0 THEN d2::float/dw.c2 ELSE base_daily END)*cd.n2 +
      (CASE WHEN dw.c3>0 THEN d3::float/dw.c3 ELSE base_daily END)*cd.n3 +
      (CASE WHEN dw.c4>0 THEN d4::float/dw.c4 ELSE base_daily END)*cd.n4 +
      (CASE WHEN dw.c5>0 THEN d5::float/dw.c5 ELSE base_daily END)*cd.n5 +
      (CASE WHEN dw.c6>0 THEN d6::float/dw.c6 ELSE base_daily END)*cd.n6
    ) AS demand_cover
  FROM covd c JOIN dowc dw ON dw.sku = c.sku JOIN covdays cd ON cd.coverage = c.coverage
),
flags AS (
  SELECT f.*,
    (rf>0 AND rf<0.5) AS declining,
    (u365=0 OR (days_since IS NOT NULL AND days_since>180)) AS is_dead,
    f.rf * (
      (CASE WHEN dw.c0>0 THEN f.d0::float/dw.c0 ELSE f.base_daily END)*n3.m0 +
      (CASE WHEN dw.c1>0 THEN f.d1::float/dw.c1 ELSE f.base_daily END)*n3.m1 +
      (CASE WHEN dw.c2>0 THEN f.d2::float/dw.c2 ELSE f.base_daily END)*n3.m2 +
      (CASE WHEN dw.c3>0 THEN f.d3::float/dw.c3 ELSE f.base_daily END)*n3.m3 +
      (CASE WHEN dw.c4>0 THEN f.d4::float/dw.c4 ELSE f.base_daily END)*n3.m4 +
      (CASE WHEN dw.c5>0 THEN f.d5::float/dw.c5 ELSE f.base_daily END)*n3.m5 +
      (CASE WHEN dw.c6>0 THEN f.d6::float/dw.c6 ELSE f.base_daily END)*n3.m6
    ) AS proj_30d
  FROM fc f JOIN dowc dw ON dw.sku = f.sku CROSS JOIN next30 n3
),
-- "Demand heating up" rows: trend >= 1.3x with real volume, still selling now,
-- and the last 28 days at or above the SKU's own baseline (a mover that just
-- stopped keeps a high 90d ratio for weeks; rf28 is what rules it out).
-- days_of_supply here is cover at the PROJECTED pace, so it agrees with proj_30d.
accel AS (
  SELECT *, CASE WHEN proj_30d > 0 THEN GREATEST(on_hand,0)::double precision/(proj_30d/30.0) ELSE NULL END AS dos_trend
  FROM flags
  WHERE rf >= 1.3 AND u90 >= 6 AND days_since IS NOT NULL AND days_since <= 30 AND rf28 >= 1.0
),
-- Buy list is FAST SELLERS only: top-quintile selling rate among products that sell
-- (same cut as the Inventory "Fast" class), or nearly out (<21 days of supply),
-- and sold within the last 30 days.
fastcut AS (
  SELECT percentile_cont(0.8) WITHIN GROUP (ORDER BY base_daily) AS c FROM trended WHERE base_daily > 0
),
classified AS (
  SELECT f.*,
    (on_hand>0 AND (is_dead OR (declining AND dos IS NOT NULL AND dos>180))) AS is_dont,
    (NOT (on_hand>0 AND (is_dead OR (declining AND dos IS NOT NULL AND dos>180)))
      AND u90 >= 2 AND demand_cover > 0
      AND days_since IS NOT NULL AND days_since <= 30
      AND ((base_daily >= (SELECT c FROM fastcut) AND (SELECT c FROM fastcut) > 0)
           OR (dos IS NOT NULL AND dos < 21))
      AND GREATEST(0, ceil(demand_cover*1.25 - on_hand)) > 0) AS is_buy,
    GREATEST(0, ceil(demand_cover*1.25 - on_hand))::int AS order_qty,
    -- forward-looking fields run at the PROJECTED pace (trend included), the
    -- same pace the order quantity is sized on — mirrors _buy_row's dos_t.
    CASE WHEN proj_30d > 0 THEN GREATEST(on_hand,0)::double precision/(proj_30d/30.0) END AS dos_t,
    -- urgent = runs out before the NEXT reorder lands, i.e. this SKU's own
    -- coverage window (buy_row uses `coverage`, not the flat fast-mover 21d).
    (CASE WHEN proj_30d > 0 THEN GREATEST(on_hand,0)::double precision/(proj_30d/30.0) END IS NOT NULL
     AND CASE WHEN proj_30d > 0 THEN GREATEST(on_hand,0)::double precision/(proj_30d/30.0) END < coverage) AS stockout_risk
  FROM flags f
),
buy AS (
  SELECT *, round((order_qty * COALESCE(cost,0) * 100)::double precision)/100 AS order_value FROM classified WHERE is_buy
),
dont AS (
  SELECT *, round((on_hand * COALESCE(cost,0) * 100)::double precision)/100 AS capital_tied FROM classified WHERE is_dont
),
-- lost sales: out of stock (on_hand<=0), real mover, recently stopped selling
lost AS (
  SELECT *, base_daily*days_since AS lost_units, COALESCE(price,0) AS p2
  FROM flags
  WHERE GREATEST(on_hand,0) <= 0 AND u90 >= 4 AND last_sale IS NOT NULL
    AND days_since > 0 AND days_since <= 45 AND base_daily > 0
)
SELECT
  (SELECT count(*) FROM buy) AS buy_sku_count,
  (SELECT round((COALESCE(sum(order_value),0)*100)::double precision)/100 FROM buy) AS buy_total_value,
  (SELECT COALESCE(sum(order_qty),0) FROM buy) AS buy_units_total,
  (SELECT count(*) FROM buy WHERE stockout_risk) AS buy_urgent_count,
  (SELECT count(*) FROM dont) AS dont_buy_sku_count,
  (SELECT round((COALESCE(sum(capital_tied),0)*100)::double precision)/100 FROM dont) AS dont_buy_capital_tied,
  (SELECT COALESCE(sum(on_hand),0) FROM dont) AS dont_buy_units_total,
  (SELECT count(*) FROM dont WHERE u365=0) AS dont_buy_dead_count,
  (SELECT count(*) FROM accel) AS accelerating_count,
  (SELECT count(*) FROM lost) AS stockout_sku_count,
  (SELECT round((COALESCE(sum(round((lost_units*p2)*100)/100),0))::numeric,2) FROM lost) AS lost_revenue_estimate,
  (SELECT round((COALESCE(sum(CASE WHEN cost IS NOT NULL AND price IS NOT NULL AND price<>0 THEN round((lost_units*(p2-cost))*100)/100 ELSE 0 END),0))::numeric,2) FROM lost) AS lost_margin_estimate,
  (SELECT round((COALESCE(sum(round((base_daily*p2)*100)/100),0))::numeric,2) FROM lost) AS ongoing_daily_loss''',
  'backtest': r'''WITH params AS (SELECT %(cid)s::int AS cid),
asof AS (SELECT max(sale_date)::date AS as_of FROM sales, params WHERE client_id=params.cid),
daily AS (  -- store daily totals (no void exclusion, matching fetch_store_daily)
  SELECT si.sale_date::date AS d, sum(si.quantity) AS u
  FROM sale_items si, params, asof
  WHERE si.client_id=params.cid AND si.sale_date >= (SELECT as_of FROM asof)-420 AND si.quantity>0
  GROUP BY si.sale_date::date
),
targets AS (SELECT generate_series((SELECT as_of FROM asof)-27, (SELECT as_of FROM asof), interval '1 day')::date AS t),
fcd AS (
  SELECT tg.t,
    COALESCE((SELECT u FROM daily WHERE d=tg.t),0)::double precision AS actual,
    (
      WITH agg AS (
        SELECT COALESCE(sum(u),0)::double precision AS long_sum,
               COALESCE(sum(u) FILTER (WHERE (tg.t - d) <= 90),0)::double precision AS recent_sum,
               COALESCE(sum(u) FILTER (WHERE extract(dow from d)::int = extract(dow from tg.t)::int),0)::double precision AS dow_sum
        FROM daily WHERE d >= tg.t-365 AND d <= tg.t-1
      ),
      cnt AS (
        SELECT count(*) FILTER (WHERE extract(dow from gd)::int = extract(dow from tg.t)::int) AS dow_cnt
        FROM generate_series(tg.t-365, tg.t-1, interval '1 day') g(gd)
      )
      SELECT (CASE WHEN cnt.dow_cnt>0 THEN agg.dow_sum/cnt.dow_cnt ELSE 0 END)
             * (CASE WHEN agg.long_sum/365 > 0
                     THEN GREATEST(0.3::double precision, LEAST(3.0::double precision, (agg.recent_sum/90)/(agg.long_sum/365)))
                     ELSE (CASE WHEN agg.recent_sum>0 THEN 1.0 ELSE 0.0 END) END)
      FROM agg, cnt
    )::double precision AS fc
  FROM targets tg
),
tot AS (SELECT sum(abs(actual-fc)) AS abs_err, sum(actual) AS total_actual FROM fcd)
SELECT
  round((100*abs_err/NULLIF(total_actual,0)*10))/10 AS wape_pct,
  round((100 - 100*abs_err/NULLIF(total_actual,0))*10)/10 AS accuracy_pct
FROM tot''',
}

CONFIG = [
  ('inventory', 'Inventory', 'inventory', 46, [('inventory_at_cost', ('frozen_capital', 'total_inventory_value_at_cost')), ('frozen_dead', ('frozen_capital', 'frozen_capital_dead')), ('slow_capital', ('frozen_capital', 'slow_capital')), ('fast_skus', ('velocity_classes', 'classes', 'fast', 'sku_count')), ('normal_skus', ('velocity_classes', 'classes', 'normal', 'sku_count')), ('slow_skus', ('velocity_classes', 'classes', 'slow', 'sku_count')), ('dead_skus', ('velocity_classes', 'classes', 'dead', 'sku_count')), ('never_skus', ('velocity_classes', 'classes', 'never_sold', 'sku_count')), ('total_skus', ('velocity_classes', 'total_skus')), ('dead_sku_count', ('dead_stock', 'dead_sku_count')), ('actionable_sku_count', ('dead_stock', 'actionable_sku_count')), ('actionable_frozen_capital', ('dead_stock', 'actionable_frozen_capital'))]),
  ('pricing', 'Pricing & Margin', 'pricing', 46, [('category_count', ('pricing', 'category_count')), ('raise_sku_count', ('pricing', 'raise_sku_count')), ('est_annual_margin_upside', ('pricing', 'est_annual_margin_upside')), ('cut_sku_count', ('pricing', 'cut_sku_count')), ('cut_frozen_capital', ('pricing', 'cut_frozen_capital'))]),
  ('money_leaks', 'Inventory: Money left', 'inventory', 46, [('total_discount_given', ('money_leaks', 'total_discount_given')), ('wasted_discount_estimate', ('money_leaks', 'wasted_discount_estimate')), ('wasted_discount_pct_of_total', ('money_leaks', 'wasted_discount_pct_of_total')), ('elasticity_confirmed_waste', ('money_leaks', 'elasticity_confirmed_waste')), ('elasticity_uncertain_waste', ('money_leaks', 'elasticity_uncertain_waste')), ('below_cost_loss', ('money_leaks', 'below_cost_loss')), ('below_cost_lines', ('money_leaks', 'below_cost_lines')), ('priced_to_lose_sku_count', ('money_leaks', 'priced_to_lose_sku_count')), ('recoverable_estimate', ('money_leaks', 'recoverable_estimate')), ('recoverable_upper_bound', ('money_leaks', 'recoverable_upper_bound'))]),
  ('basket', 'Basket & Cross-sell', 'basket', 46, [('total_baskets', ('basket', 'total_baskets')), ('pairs_analyzed', ('basket', 'pairs_analyzed'))]),
  ('overview', 'Executive Overview (pulse)', 'overview', 46, [('revenue_30d', ('overview', 'pulse', 'revenue_30d')), ('revenue_mom_pct', ('overview', 'pulse', 'revenue_mom_pct')), ('transactions_30d', ('overview', 'pulse', 'transactions_30d')), ('avg_basket_value', ('overview', 'pulse', 'avg_basket_value')), ('gross_margin_pct', ('overview', 'pulse', 'gross_margin_pct'))]),
  ('loss', 'Loss Prevention', 'lossprev', 46, [('review_exposure', ('loss', 'review_exposure')), ('flagged_line_count', ('loss', 'flagged_line_count')), ('void_amount', ('loss', 'signals', 'voids', 'amount')), ('free_value_given_away', ('loss', 'signals', 'free_giveaways', 'value_given_away')), ('below_margin_lost', ('loss', 'signals', 'below_cost', 'margin_lost')), ('below_lines', ('loss', 'signals', 'below_cost', 'lines')), ('returns_amount', ('loss', 'signals', 'returns', 'amount'))]),
  ('customers', 'Customer Win-Back', 'customers', 88, [('total_customers', ('customer_radar', 'total_customers')), ('non_person_excluded', ('customer_radar', 'non_person_excluded')), ('at_risk_count', ('customer_radar', 'at_risk_count')), ('annual_revenue_at_risk', ('customer_radar', 'annual_revenue_at_risk'))]),
  ('market', 'Market Intelligence', 'market', 46, [('peer_count', ('market', 'peer_count')), ('regional_sku_count', ('market', 'regional_sku_count')), ('priced_above_count', ('market', 'priced_above_count')), ('priced_below_count', ('market', 'priced_below_count')), ('margin_left_total', ('market', 'margin_left_total')), ('revenue_exposed_total', ('market', 'revenue_exposed_total'))]),
  ('buying', 'Predictive Buying', 'buying', 46, [('buy_sku_count', ('buying', 'buy_sku_count')), ('buy_total_value', ('buying', 'buy_total_value')), ('buy_units_total', ('buying', 'buy_units_total')), ('buy_urgent_count', ('buying', 'buy_urgent_count')), ('dont_buy_sku_count', ('buying', 'dont_buy_sku_count')), ('dont_buy_capital_tied', ('buying', 'dont_buy_capital_tied')), ('dont_buy_units_total', ('buying', 'dont_buy_units_total')), ('dont_buy_dead_count', ('buying', 'dont_buy_dead_count')), ('accelerating_count', ('buying', 'accelerating_count')), ('stockout_sku_count', ('lost_sales', 'stockout_sku_count')), ('lost_revenue_estimate', ('lost_sales', 'lost_revenue_estimate')), ('lost_margin_estimate', ('lost_sales', 'lost_margin_estimate')), ('ongoing_daily_loss', ('lost_sales', 'ongoing_daily_loss'))]),
  ('backtest', 'Predictive Buying: backtest', 'buying', 46, [('wape_pct', ('forecast_backtest', 'wape_pct')), ('accuracy_pct', ('forecast_backtest', 'accuracy_pct'))]),
]

def _get(d, path):
    for k in path: d = d[k]
    return d

def main():
    from storeagent.api.service import CAPABILITIES
    conn = psycopg.connect(**SOURCE.kwargs(), row_factory=dict_row); conn.read_only = True
    grand = True
    for key, title, cap, store, checks in CONFIG:
        if cap not in CAPABILITIES:
            print(f"===== {title} (store {store}) ===== SKIPPED (capability '{cap}' no longer registered)\n")
            continue
        r = run_capability(cap, store=store, location=None,  # client-wide: this harness's SQL is client-scoped
                           narrate=False, use_cache=False)
        with conn.cursor() as cur:
            cur.execute(SQLS[key], {"cid": store}); got = cur.fetchone()
        print(f"===== {title} (store {store}) =====")
        for col, path in checks:
            want = _get(r, tuple(path)); g = got[col]
            gf = float(g) if g is not None else None
            ok = gf is not None and abs(gf - float(want)) < 0.05
            grand = grand and ok
            print(f"  {col:28} {str(want):>14} {str(gf):>14}  {'OK' if ok else 'XXXX'}")
        print()
    conn.close()
    print("ALL SECTIONS MATCH" if grand else "SOME MISMATCHES (see above)")

if __name__ == "__main__":
    main()
