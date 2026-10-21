/**
 * bottleSenseService.js
 * ---------------------------------------------------------------------------
 * The measurement models from the BottleSense research (August 2026), rebuilt
 * for a single store and run on the one thing BottleSense does not have: cost.
 *
 * The finding that shapes this whole screen: a column search across all 133
 * BottleSense datasets for /cost|margin|profit|purchase_price|landed|wholesale/
 * returned exactly two matches, both `ShippingCost` on marketplace order
 * tables. Against 194 price/revenue-like columns. BottleSense can slice revenue
 * by store, brand, category, size, varietal, hour, weekday, channel and
 * campaign - and cannot tell you whether any of it made money.
 *
 * Botella has `cost` on sale_items, products AND purchases. So the brief is not
 * to copy their tiles. It is to take their measurement ENGINEERING - the health
 * score with a named driver, trend classification, the rolling comparison, the
 * coverage disclosure - and run it on margin.
 *
 * THREE HABITS FROM THE RESEARCH DELIBERATELY NOT COPIED
 *
 *   1. No time bound. Most of their 161 tiles render all history, so a "top
 *      products" list ranks five years cumulatively and something that stopped
 *      selling in 2022 outranks a current seller. EVERY figure here carries an
 *      explicit window, and every window is returned to the client so the UI can
 *      print it.
 *
 *   2. Hardcoded dates. 28 of their charts pin a range typed at build time; one
 *      SEO tile is bounded 2020-01-01 to 2021-01-01 and reports a five-year-old
 *      number beside two live ones. Every window here is derived from the
 *      store's own latest sale date, never from a literal and never from now()
 *      (a POS that stopped syncing yesterday must not silently report zeroes).
 *
 *   3. One name, several meanings. "Total Orders" is computed independently in
 *      sixteen of their datasets and "Total Stores" in twelve, so two dashboards
 *      can disagree and both be right. Every metric here is defined once, in
 *      this file, and the screen renders what this returns.
 */

const WINDOW_DAYS = 30;      // the rolling window, and its comparison period
const LONG_WINDOW_DAYS = 90; // margin and velocity need a longer base
const DEAD_DAYS = 90;        // no sale in this many days = dead stock
const NINE_LITRES_ML = 9000; // the liquor industry's standard case volume

/* ── Health score weights ────────────────────────────────────────────────────
 * Published, because the research is blunt about this: "Publish the weights;
 * never ship a score without its driver." A score with no visible cause is not
 * actionable - it is a number to argue with. Each driver below returns 0-100
 * and carries its own one-line reason.
 */
const WEIGHTS = [
  { key: 'margin', label: 'Gross margin', weight: 25 },
  { key: 'trend', label: 'Revenue trend', weight: 20 },
  { key: 'stockouts', label: 'Shelf availability', weight: 20 },
  { key: 'deadstock', label: 'Capital efficiency', weight: 20 },
  { key: 'coverage', label: 'Cost data coverage', weight: 15 },
];

/** Score a value on a linear scale between a floor and a target. */
function scale(value, floor, target) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  if (target === floor) return 100;
  const pct = ((value - floor) / (target - floor)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

const num = (v) => (v === null || v === undefined ? null : Number(v));
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

/**
 * The as-of date is the store's OWN latest sale, not today. A POS that stopped
 * syncing on Friday must report Friday's window, not a week of zeroes that
 * looks like a collapse in trade.
 */
async function asOf(pool, clientId, locationId) {
  const { rows } = await pool.query(
    'SELECT max(sale_date)::date AS d FROM sale_items WHERE client_id=$1 AND location_id=$2',
    [clientId, locationId],
  );
  return rows[0] && rows[0].d ? rows[0].d : null;
}

/* ── 1. Rolling window vs the one before it ─────────────────────────────────
 * The research calls this "the cheapest fix for context-free KPIs": materialise
 * the comparison alongside the level so no tile can ship without one.
 */
const SQL_WINDOW = `
WITH bounds AS (SELECT $3::date AS as_of),
lines AS (
  SELECT si.sale_date, si.sale_id, si.quantity, si.total_amount, si.cost
  FROM sale_items si, bounds b
  WHERE si.client_id=$1 AND si.location_id=$2
    AND si.sale_date > b.as_of - ($4::int * 2)
    AND si.sale_date <= b.as_of + 1
    AND si.quantity > 0
)
SELECT
  COALESCE(sum(total_amount) FILTER (WHERE sale_date > (SELECT as_of FROM bounds) - $4::int), 0)::numeric(16,2) AS revenue,
  COALESCE(sum(total_amount) FILTER (WHERE sale_date <= (SELECT as_of FROM bounds) - $4::int), 0)::numeric(16,2) AS revenue_prev,
  count(DISTINCT sale_id) FILTER (WHERE sale_date > (SELECT as_of FROM bounds) - $4::int)::int AS orders,
  count(DISTINCT sale_id) FILTER (WHERE sale_date <= (SELECT as_of FROM bounds) - $4::int)::int AS orders_prev,
  COALESCE(sum(quantity) FILTER (WHERE sale_date > (SELECT as_of FROM bounds) - $4::int), 0)::int AS units,
  COALESCE(sum(quantity) FILTER (WHERE sale_date <= (SELECT as_of FROM bounds) - $4::int), 0)::int AS units_prev
FROM lines`;

/* ── 2. Margin, and the coverage that qualifies it ──────────────────────────
 * The coverage figure is not decoration. The research singles this out as the
 * pattern Botella most needs: "publish cost coverage next to gross margin, so
 * an inflated margin discloses itself." A 40% margin computed over 30% of
 * revenue is not a 40% margin.
 */
const SQL_MARGIN = `
WITH bounds AS (SELECT $3::date AS as_of),
lines AS (
  SELECT si.total_amount, si.cost, si.quantity
  FROM sale_items si, bounds b
  WHERE si.client_id=$1 AND si.location_id=$2
    AND si.sale_date > b.as_of - $4::int AND si.sale_date <= b.as_of + 1
    AND si.quantity > 0 AND si.total_amount > 0
)
SELECT
  count(*)::int AS lines_total,
  count(*) FILTER (WHERE cost IS NOT NULL AND cost > 0)::int AS lines_costed,
  COALESCE(sum(total_amount), 0)::numeric(16,2) AS revenue_total,
  COALESCE(sum(total_amount) FILTER (WHERE cost IS NOT NULL AND cost > 0), 0)::numeric(16,2) AS revenue_costed,
  COALESCE(sum(cost * quantity) FILTER (WHERE cost IS NOT NULL AND cost > 0), 0)::numeric(16,2) AS cogs
FROM lines`;

/* ── 3. Trend classification, not a raw slope ───────────────────────────────
 * Research item #3: "Classify SKUs as growing / stable / declining / dying
 * rather than showing a slope. Directly answers 'which products are dying',
 * which nothing currently answers."
 *
 * Compares each SKU's latest window against the one before, and treats a SKU
 * that sold before and not at all now as DYING rather than as a -100% slope
 * hiding among the rest.
 */
const SQL_TREND = `
WITH bounds AS (SELECT $3::date AS as_of),
per_sku AS (
  SELECT si.sku,
         max(si.product_name) AS product_name,
         COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date > (SELECT as_of FROM bounds) - $4::int), 0) AS u_now,
         COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date <= (SELECT as_of FROM bounds) - $4::int), 0) AS u_prev,
         COALESCE(sum(si.total_amount) FILTER (WHERE si.sale_date > (SELECT as_of FROM bounds) - $4::int), 0) AS r_now,
         COALESCE(sum(si.total_amount) FILTER (WHERE si.sale_date <= (SELECT as_of FROM bounds) - $4::int), 0) AS r_prev
  FROM sale_items si, bounds b
  WHERE si.client_id=$1 AND si.location_id=$2
    AND si.sale_date > b.as_of - ($4::int * 2) AND si.sale_date <= b.as_of + 1
    AND si.quantity > 0
  GROUP BY si.sku
),
classified AS (
  SELECT *,
    CASE
      WHEN u_prev > 0 AND u_now = 0 THEN 'dying'
      WHEN u_prev = 0 AND u_now > 0 THEN 'growing'
      WHEN u_prev > 0 AND u_now::numeric / u_prev >= 1.20 THEN 'growing'
      WHEN u_prev > 0 AND u_now::numeric / u_prev <= 0.80 THEN 'declining'
      ELSE 'stable'
    END AS trend
  FROM per_sku
)
SELECT trend, count(*)::int AS skus,
       COALESCE(sum(r_now), 0)::numeric(16,2) AS revenue_now,
       COALESCE(sum(r_prev), 0)::numeric(16,2) AS revenue_prev
FROM classified GROUP BY trend`;

/* The individual products behind the two classifications worth acting on. */
const SQL_TREND_ROWS = `
WITH bounds AS (SELECT $3::date AS as_of),
per_sku AS (
  SELECT si.sku, max(si.product_name) AS product_name, max(si.category) AS category,
         COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date > (SELECT as_of FROM bounds) - $4::int), 0) AS u_now,
         COALESCE(sum(si.quantity) FILTER (WHERE si.sale_date <= (SELECT as_of FROM bounds) - $4::int), 0) AS u_prev,
         COALESCE(sum(si.total_amount) FILTER (WHERE si.sale_date > (SELECT as_of FROM bounds) - $4::int), 0) AS r_now,
         COALESCE(sum(si.total_amount) FILTER (WHERE si.sale_date <= (SELECT as_of FROM bounds) - $4::int), 0) AS r_prev
  FROM sale_items si, bounds b
  WHERE si.client_id=$1 AND si.location_id=$2
    AND si.sale_date > b.as_of - ($4::int * 2) AND si.sale_date <= b.as_of + 1
    AND si.quantity > 0
  GROUP BY si.sku
)
SELECT sku, product_name, category, u_now, u_prev, r_now::numeric(14,2) AS r_now, r_prev::numeric(14,2) AS r_prev,
  CASE
    WHEN u_prev > 0 AND u_now = 0 THEN 'dying'
    WHEN u_prev = 0 AND u_now > 0 THEN 'growing'
    WHEN u_prev > 0 AND u_now::numeric / u_prev >= 1.20 THEN 'growing'
    WHEN u_prev > 0 AND u_now::numeric / u_prev <= 0.80 THEN 'declining'
    ELSE 'stable'
  END AS trend
FROM per_sku
WHERE (u_prev > 0 AND u_now = 0 AND r_prev >= 50)
   OR (u_prev > 0 AND u_now::numeric / u_prev >= 1.20 AND r_now >= 50)
ORDER BY GREATEST(r_prev, r_now) DESC
LIMIT 40`;

/* ── 4. Shelf availability and dead capital ─────────────────────────────────
 * Both are inputs to the health score, and both are things BottleSense cannot
 * compute at all: its inventory dataset carries on-hand, price and sale price -
 * no cost, no age, no velocity - which is why its inventory dashboards are
 * listings rather than analysis.
 */
const SQL_STOCK = `
WITH bounds AS (SELECT $3::date AS as_of),
sold AS (
  SELECT si.sku, sum(si.quantity) AS units, max(si.sale_date)::date AS last_sale
  FROM sale_items si, bounds b
  WHERE si.client_id=$1 AND si.location_id=$2
    AND si.sale_date > b.as_of - $4::int AND si.sale_date <= b.as_of + 1 AND si.quantity > 0
  GROUP BY si.sku
),
prod AS (
  SELECT p.sku, GREATEST(COALESCE(p.stock_qty,0),0) AS on_hand, COALESCE(p.cost,0) AS cost
  FROM products p
  WHERE p.client_id=$1 AND p.location_id=$2 AND COALESCE(p.is_deleted,false)=false AND p.sku IS NOT NULL
),
joined AS (
  SELECT p.sku, p.on_hand, p.cost, COALESCE(s.units,0) AS units, s.last_sale
  FROM prod p LEFT JOIN sold s ON s.sku = p.sku
)
SELECT
  count(*)::int AS skus,
  -- Out of stock AND selling. NOT "out of stock": this store has 7,286 products
  -- at zero on hand, most of which are catalogue lines nobody has bought in
  -- years, and counting those would make shelf availability meaningless.
  --
  -- The AI Recommendations home shows a SMALLER number for what reads as the
  -- same thing (79 against ~295) because its bar is "fast mover", not "sold at
  -- all". Both are right and the file header above warns about exactly this
  -- failure - the research's habit-not-to-copy is one metric name computed
  -- independently until two dashboards disagree. Ours disagree ACROSS screens
  -- rather than within one, which is the same bug at a wider scale, so both
  -- labels now state their threshold instead of both saying "out of stock".
  count(*) FILTER (WHERE units > 0 AND on_hand = 0)::int AS stockout_skus,
  count(*) FILTER (WHERE units > 0)::int AS moving_skus,
  count(*) FILTER (WHERE units = 0 AND on_hand > 0)::int AS dead_skus,
  COALESCE(sum(on_hand * cost), 0)::numeric(16,2) AS inventory_at_cost,
  COALESCE(sum(on_hand * cost) FILTER (WHERE units = 0), 0)::numeric(16,2) AS dead_at_cost
FROM joined`;

/* ── 5. Nine-litre case normalisation ───────────────────────────────────────
 * Research item #5. The nine-litre case is the liquor trade's standard volume
 * unit; it puts beer, wine and spirits on one scale, which counting units does
 * not - 24 beers and 24 magnums are not the same quantity of drink.
 *
 * BottleSense carries this as a column (9Lt_Cases_Sold, Measurement). Botella's
 * products table has pack_size and uom, but on the audited tenant every row is
 * pack_size='1' and uom='0.0' - present but unpopulated. So the size is parsed
 * out of the product name, which is where it actually lives.
 *
 * The capture group takes the WHOLE number: '1750ml' must read 1750, not 50.
 * Bare 'L' is treated as litres only when it is a word boundary, so 'XL' and
 * 'CL' do not become volumes.
 */
const SQL_NINE_LITRE = `
WITH bounds AS (SELECT $3::date AS as_of),
lines AS (
  SELECT si.category, si.quantity, si.total_amount, si.product_name,
         substring(si.product_name from '(?i)([0-9]+(?:\\.[0-9]+)?)\\s*(?:ml|ML)\\M') AS ml_txt,
         substring(si.product_name from '(?i)([0-9]+(?:\\.[0-9]+)?)\\s*(?:l|lt|ltr|liter|litre)s?\\M') AS l_txt
  FROM sale_items si, bounds b
  WHERE si.client_id=$1 AND si.location_id=$2
    AND si.sale_date > b.as_of - $4::int AND si.sale_date <= b.as_of + 1 AND si.quantity > 0
),
sized AS (
  SELECT category, quantity, total_amount,
    CASE WHEN ml_txt IS NOT NULL THEN ml_txt::numeric
         WHEN l_txt  IS NOT NULL THEN l_txt::numeric * 1000
         ELSE NULL END AS ml
  FROM lines
)
SELECT
  COALESCE(NULLIF(trim(category), ''), 'Uncategorised') AS category,
  sum(quantity)::int AS units,
  sum(total_amount)::numeric(16,2) AS revenue,
  count(*) FILTER (WHERE ml IS NOT NULL)::int AS lines_sized,
  count(*)::int AS lines_total,
  ROUND(COALESCE(sum(quantity * ml) FILTER (WHERE ml IS NOT NULL), 0) / ${NINE_LITRES_ML}.0, 1) AS cases_9l
FROM sized
GROUP BY 1
HAVING sum(total_amount) > 0
ORDER BY cases_9l DESC NULLS LAST
LIMIT 12`;

/* ── 6. Average days to return ──────────────────────────────────────────────
 * Research item #10, and the one customer metric the document says to build
 * now: "a genuinely good metric ... it directly informs when to contact a
 * lapsing customer." Needs identity at checkout, so coverage ships with it.
 */
const SQL_RETURN_DAYS = `
WITH bounds AS (SELECT $3::date AS as_of),
s AS (
  SELECT customer_id, sale_date::date AS d
  FROM sales, bounds b
  WHERE client_id=$1 AND location_id=$2 AND customer_id IS NOT NULL
    AND sale_date > b.as_of - $4::int AND sale_date <= b.as_of + 1
  GROUP BY customer_id, sale_date::date
),
gaps AS (
  SELECT customer_id, d - lag(d) OVER (PARTITION BY customer_id ORDER BY d) AS gap FROM s
)
SELECT
  ROUND(AVG(gap)::numeric, 1) AS avg_days_to_return,
  ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)::numeric, 1) AS median_days_to_return,
  count(DISTINCT customer_id)::int AS customers_with_repeat
FROM gaps WHERE gap IS NOT NULL AND gap > 0`;

const SQL_CUSTOMER_COVERAGE = `
WITH bounds AS (SELECT $3::date AS as_of)
SELECT count(*)::int AS sales,
       count(*) FILTER (WHERE customer_id IS NOT NULL)::int AS identified,
       count(DISTINCT customer_id)::int AS customers
FROM sales, bounds b
WHERE client_id=$1 AND location_id=$2
  AND sale_date > b.as_of - $4::int AND sale_date <= b.as_of + 1`;

/* ── 7. Day-part ────────────────────────────────────────────────────────────
 * Research item #9: they materialise Week_Day and Hour_By_CST as columns, which
 * "removes a whole class of timezone bugs from downstream queries". We derive
 * them here rather than at ingest, but in ONE place, so every consumer agrees.
 */
const SQL_DAYPART = `
WITH bounds AS (SELECT $3::date AS as_of)
SELECT extract(dow  from si.sale_date)::int AS dow,
       extract(hour from si.sale_date)::int AS hour,
       sum(si.total_amount)::numeric(14,2) AS revenue,
       count(DISTINCT si.sale_id)::int AS orders
FROM sale_items si, bounds b
WHERE si.client_id=$1 AND si.location_id=$2
  AND si.sale_date > b.as_of - $4::int AND si.sale_date <= b.as_of + 1 AND si.quantity > 0
GROUP BY 1, 2`;

/* ── The health score ───────────────────────────────────────────────────────── */

function buildHealth({ margin, windowNow, stock, coveragePct }) {
  const drivers = [];

  // Margin: 15% is the floor of viability for liquor retail, 30% a strong store.
  const marginPct = margin.marginPct;
  drivers.push({
    key: 'margin',
    label: 'Gross margin',
    score: scale(marginPct, 15, 30),
    value: marginPct === null ? null : marginPct + '%',
    reason: marginPct === null ? 'No cost data to measure margin from'
      : marginPct >= 30 ? 'Healthy for liquor retail'
        : marginPct >= 22 ? 'Workable, with room to improve on pricing'
          : 'Thin - check pricing and supplier terms',
  });

  // Trend: -20% is a bad month, +10% a good one.
  const growth = windowNow.revenueGrowthPct;
  drivers.push({
    key: 'trend',
    label: 'Revenue trend',
    score: scale(growth, -20, 10),
    value: growth === null ? null : (growth > 0 ? '+' : '') + growth + '%',
    reason: growth === null ? 'Not enough history to compare two windows'
      : growth >= 5 ? 'Growing against the previous window'
        : growth > -5 ? 'Broadly flat against the previous window'
          : 'Falling against the previous window',
  });

  // Availability: what share of the products that ARE selling have stock.
  const stockoutRate = stock.movingSkus ? (stock.stockoutSkus / stock.movingSkus) * 100 : null;
  drivers.push({
    key: 'stockouts',
    label: 'Shelf availability',
    score: stockoutRate === null ? null : scale(stockoutRate, 20, 0),
    value: stockoutRate === null ? null : Math.round(stockoutRate * 10) / 10 + '% out',
    reason: stockoutRate === null ? 'No stock data'
      : stockoutRate <= 5 ? 'Almost everything that sells is on the shelf'
        : stockoutRate <= 12 ? `${stock.stockoutSkus} selling products have nothing on hand`
          : `${stock.stockoutSkus} selling products are out - losing sales daily`,
  });

  // Capital efficiency: what share of stock value has not moved at all.
  const deadShare = stock.inventoryAtCost ? (stock.deadAtCost / stock.inventoryAtCost) * 100 : null;
  drivers.push({
    key: 'deadstock',
    label: 'Capital efficiency',
    score: deadShare === null ? null : scale(deadShare, 60, 15),
    value: deadShare === null ? null : Math.round(deadShare * 10) / 10 + '% idle',
    reason: deadShare === null ? 'No stock valuation available'
      : deadShare <= 20 ? 'Most of your stock is working'
        : deadShare <= 40 ? 'A meaningful share of capital is sitting still'
          : 'Most of your stock value has not moved in this window',
  });

  // Coverage: the disclosure driver. A store whose POS records no cost cannot
  // be scored honestly, and the score should say so rather than quietly
  // averaging over a hole.
  drivers.push({
    key: 'coverage',
    label: 'Cost data coverage',
    score: coveragePct === null ? 0 : scale(coveragePct, 50, 95),
    value: coveragePct === null ? null : coveragePct + '%',
    reason: coveragePct === null ? 'No cost recorded against sales'
      : coveragePct >= 95 ? 'Cost is recorded on almost every sale'
        : coveragePct >= 80 ? 'Some sales carry no cost - margin is an estimate'
          : 'Cost is missing on much of your sales - treat margin with caution',
  });

  const weighted = drivers.map((d) => {
    const w = WEIGHTS.find((x) => x.key === d.key);
    return { ...d, weight: w ? w.weight : 0 };
  });

  const usable = weighted.filter((d) => d.score !== null);
  const totalWeight = usable.reduce((a, d) => a + d.weight, 0);
  const score = totalWeight
    ? Math.round(usable.reduce((a, d) => a + d.score * d.weight, 0) / totalWeight)
    : null;

  // The named reason: the weakest driver by weighted shortfall. The research is
  // explicit that a score alone is not actionable - "Inactive - Declining Trend"
  // is what makes their version usable.
  const worst = usable.slice().sort((a, b) =>
    ((a.score - b.score) * 1) || (b.weight - a.weight))[0];

  const band = score === null ? 'unknown'
    : score >= 75 ? 'healthy' : score >= 55 ? 'watch' : 'action';

  return {
    score,
    band,
    headline: worst ? worst.reason : 'Not enough data to score this store',
    headlineDriver: worst ? worst.label : null,
    drivers: weighted,
    weights: WEIGHTS,
  };
}

/* ── Entry point ────────────────────────────────────────────────────────────── */

async function getBottleSense(pool, clientId, locationId) {
  const as_of = await asOf(pool, clientId, locationId);
  if (!as_of) {
    return { available: false, reason: 'No sales have synced for this store yet.' };
  }
  const A = [clientId, locationId, as_of];

  const [win, marg, trend, trendRows, stock, nine, retDays, custCov, daypart] = await Promise.all([
    pool.query(SQL_WINDOW, [...A, WINDOW_DAYS]),
    pool.query(SQL_MARGIN, [...A, LONG_WINDOW_DAYS]),
    pool.query(SQL_TREND, [...A, WINDOW_DAYS]),
    pool.query(SQL_TREND_ROWS, [...A, WINDOW_DAYS]),
    pool.query(SQL_STOCK, [...A, DEAD_DAYS]),
    pool.query(SQL_NINE_LITRE, [...A, WINDOW_DAYS]),
    pool.query(SQL_RETURN_DAYS, [...A, 365]),
    pool.query(SQL_CUSTOMER_COVERAGE, [...A, WINDOW_DAYS]),
    pool.query(SQL_DAYPART, [...A, WINDOW_DAYS]),
  ]);

  const w = win.rows[0] || {};
  const windowNow = {
    revenue: num(w.revenue), revenuePrev: num(w.revenue_prev),
    orders: num(w.orders), ordersPrev: num(w.orders_prev),
    units: num(w.units), unitsPrev: num(w.units_prev),
    revenueGrowthPct: num(w.revenue_prev) ? Math.round(((num(w.revenue) - num(w.revenue_prev)) / num(w.revenue_prev)) * 1000) / 10 : null,
    ordersGrowthPct: num(w.orders_prev) ? Math.round(((num(w.orders) - num(w.orders_prev)) / num(w.orders_prev)) * 1000) / 10 : null,
    aov: num(w.orders) ? Math.round((num(w.revenue) / num(w.orders)) * 100) / 100 : null,
    aovPrev: num(w.orders_prev) ? Math.round((num(w.revenue_prev) / num(w.orders_prev)) * 100) / 100 : null,
  };
  windowNow.aovGrowthPct = windowNow.aovPrev
    ? Math.round(((windowNow.aov - windowNow.aovPrev) / windowNow.aovPrev) * 1000) / 10 : null;

  const m = marg.rows[0] || {};
  // Coverage is capped at 100: refund lines can push revenue_costed marginally
  // over revenue_total, and a coverage figure above 100% is nonsense on its face.
  const coveragePct = num(m.revenue_total)
    ? Math.min(100, pct(num(m.revenue_costed), num(m.revenue_total))) : null;
  const margin = {
    revenue: num(m.revenue_total),
    revenueCosted: num(m.revenue_costed),
    cogs: num(m.cogs),
    grossProfit: num(m.revenue_costed) - num(m.cogs),
    marginPct: num(m.revenue_costed) ? Math.round(((num(m.revenue_costed) - num(m.cogs)) / num(m.revenue_costed)) * 1000) / 10 : null,
    coveragePct,
    linesTotal: num(m.lines_total),
    linesCosted: num(m.lines_costed),
  };

  const s = stock.rows[0] || {};
  const stockSummary = {
    skus: num(s.skus), stockoutSkus: num(s.stockout_skus), movingSkus: num(s.moving_skus),
    deadSkus: num(s.dead_skus), inventoryAtCost: num(s.inventory_at_cost), deadAtCost: num(s.dead_at_cost),
  };

  const trendBuckets = { growing: 0, stable: 0, declining: 0, dying: 0 };
  const trendRevenue = { growing: 0, stable: 0, declining: 0, dying: 0 };
  for (const r of trend.rows) {
    trendBuckets[r.trend] = num(r.skus);
    trendRevenue[r.trend] = num(r.revenue_prev);
  }

  const cc = custCov.rows[0] || {};
  const rd = retDays.rows[0] || {};

  return {
    available: true,
    asOf: as_of,
    windows: {
      rolling: WINDOW_DAYS,
      margin: LONG_WINDOW_DAYS,
      dead: DEAD_DAYS,
      // Every window is stated so the UI can print it. The research's first
      // "habit not to copy" is tiles with no time bound at all.
      label: `${WINDOW_DAYS} days to ${as_of}`,
    },
    health: buildHealth({ margin, windowNow, stock: stockSummary, coveragePct }),
    window: windowNow,
    margin,
    stock: stockSummary,
    trend: { buckets: trendBuckets, revenueAtRisk: trendRevenue.dying + trendRevenue.declining, rows: trendRows.rows },
    nineLitre: nine.rows.map((r) => ({
      category: r.category,
      units: num(r.units),
      revenue: num(r.revenue),
      cases9l: num(r.cases_9l),
      sizedPct: pct(num(r.lines_sized), num(r.lines_total)),
    })),
    customers: {
      sales: num(cc.sales),
      identified: num(cc.identified),
      customers: num(cc.customers),
      coveragePct: pct(num(cc.identified), num(cc.sales)),
      avgDaysToReturn: num(rd.avg_days_to_return),
      medianDaysToReturn: num(rd.median_days_to_return),
      customersWithRepeat: num(rd.customers_with_repeat),
    },
    dayPart: daypart.rows.map((r) => ({ dow: num(r.dow), hour: num(r.hour), revenue: num(r.revenue), orders: num(r.orders) })),
  };
}

module.exports = { getBottleSense, WEIGHTS, WINDOW_DAYS, LONG_WINDOW_DAYS, DEAD_DAYS };
