const router = require('express').Router();
const logger = require('../utils/logger');
const { toSafeError } = require('../utils/errors');
const { getAnalyticsPool } = require('../database/analytics-connection');
const { completedSaleDaySql } = require('../helpers/completedSaleDay');

// ─── In-memory TTL cache ─────────────────────────────────────────────────────
// Dashboard data is read-only and fine to serve slightly stale. The 12 parallel
// queries take ~1-2s cold; cached requests are instant. The cache also coalesces
// concurrent requests for the same tenant so 10 simultaneous loads fire ONE set
// of queries, not 10 × 12 = 120.
// Stock Velocity classes, in the order they are shown (fastest → never sold).
// Keys must match storeagent's inventory payload (functions/inventory.py).
const VELOCITY_CLASSES = [
  { key: 'fast', label: 'Fast' },
  { key: 'normal', label: 'Normal' },
  { key: 'slow', label: 'Slow' },
  { key: 'dead', label: 'Dead' },
  { key: 'never_sold', label: 'Never sold' },
];

// Per-class drill-down rows sent to the Dashboard. The panel scrolls, so this
// is a payload-size bound, not a display one; II itself holds up to 500.
const VELOCITY_ITEM_CAP = 200;

const DASHBOARD_CACHE_TTL_MS = 45_000; // 45s - within the 30-60s window
const dashboardCache = new Map(); // `${clientId}_${locationId}` → { payload, expiresAt }
const dashboardInFlight = new Map(); // `${clientId}_${locationId}` → Promise<payload>

// Helper: run parameterized query with timeout and graceful fallback
async function safeQuery(pool, sql, params = [], timeoutMs = 8000) {
  try {
    const result = await Promise.race([
      pool.query(sql, params),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Query timeout')), timeoutMs)
      ),
    ]);
    return result.rows;
  } catch (err) {
    logger.warn('Dashboard query failed', { error: err.message });
    return null;
  }
}

// ─── Optimized panels query (margin / top products / category) ───────────────
// All three panels come from ONE query that runs the heavy de-dup + product join
// exactly ONCE, then derives top-10 products + category mix (as JSON) + the margin
// scalar from that single pass. Running three separate heavy queries in parallel
// (or the old ROW_NUMBER-over-join) blew the timeout → blank panels. This keeps the
// correctness - both-keys join + cross-sku twin-collapse (so store 46's ~6% twin
// inflation AND repeat-heavy stores' undercount are both right) - while dropping
// the per-row COUNT(DISTINCT) and confidence sub-queries the dashboard never shows.
//
// Tries ALL-TIME first; if a very large store can't finish inside the real-time
// budget (the query hits the pool statement_timeout), it falls back to the last 30
// days and tags the result window:'last_30_days' so the UI can show a "Past 30
// days" badge on those three panels.
function buildPanelsSql(dated) {
  const dateClause = dated ? ' AND sale_date >= $3 AND sale_date < ($4::date + 1)' : '';
  return `
    WITH line_sku AS (
      SELECT sale_id, TRIM(sku) k, product_name, quantity, price, total_amount, COUNT(*) mult
        FROM sale_items
       WHERE client_id=$1 AND location_id=$2${dateClause}
       GROUP BY sale_id, TRIM(sku), product_name, quantity, price, total_amount),
    deduped AS (
      SELECT DISTINCT ON (sale_id, product_name, quantity, price, total_amount) k, quantity, total_amount, mult
        FROM line_sku
       ORDER BY sale_id, product_name, quantity, price, total_amount, mult DESC, k),
    si_agg AS (SELECT k, SUM(total_amount*mult) rev, SUM(quantity*mult) u FROM deduped GROUP BY k),
    -- Normalize product keys ONCE (sku + upc into one column) so the link is a plain
    -- hash join on equality. The old (TRIM(p.sku)=k OR TRIM(p.upc)=k) couldn't use an
    -- index and re-scanned the whole catalog per sku - 57s all-time on the 1.45M store;
    -- this form is ~6s there (and ~1s on most stores). src=0 (sku) beats src=1 (upc).
    prod_keys AS (
      SELECT TRIM(sku) pk, 0 src, product_name name, category cat, cost FROM products
        WHERE client_id=$1 AND location_id=$2 AND NULLIF(TRIM(sku),'') IS NOT NULL
      UNION ALL
      SELECT TRIM(upc) pk, 1 src, product_name name, category cat, cost FROM products
        WHERE client_id=$1 AND location_id=$2 AND NULLIF(TRIM(upc),'') IS NOT NULL),
    pick AS (
      SELECT DISTINCT ON (s.k) s.k, s.rev, s.u, pk.name, pk.cat, pk.cost
        FROM si_agg s
        LEFT JOIN prod_keys pk ON pk.pk = s.k
       ORDER BY s.k, pk.src)
    SELECT
      (SELECT json_agg(t) FROM (
         SELECT name, ROUND(SUM(rev),2) revenue, SUM(u) units
           FROM pick WHERE NULLIF(TRIM(name),'') IS NOT NULL
          GROUP BY name ORDER BY revenue DESC LIMIT 10) t) AS top_products,
      (SELECT json_agg(c) FROM (
         SELECT COALESCE(
                  CASE
                    -- Keep RTD / Seltzer as their OWN bucket instead of letting the
                    -- dash-collapse fold them into the parent ("Liquor - RTD" -> RTD,
                    -- "Beer - Seltzer" -> Seltzer). Everything else still collapses on
                    -- the dash, so "Liquor - Rum/Vodka/..." stay one "Liquor" wedge.
                    WHEN TRIM(SPLIT_PART(cat,'-',2)) ~* '\\yrtd\\y'     THEN 'RTD'
                    WHEN TRIM(SPLIT_PART(cat,'-',2)) ~* '\\yseltzer\\y' THEN 'Seltzer'
                    ELSE NULLIF(TRIM(SPLIT_PART(cat,'-',1)),'')
                  END,
                  'Unmapped / uncategorized') category,
                ROUND(SUM(rev),2) revenue, SUM(u) units,
                -- gross profit; only meaningful when the store records costs
                -- (frontend gates on the same coverage rule as gross margin).
                -- Insane costs (see the sanity rule below) count as uncosted.
                ROUND(SUM(rev) - SUM(CASE WHEN cost > 0 AND cost*u <= 1.5*rev
                                          THEN cost*u ELSE 0 END),2) profit
           FROM pick GROUP BY 1 ORDER BY revenue DESC) c) AS categories,
      -- Margin over the costed subset only: lines with no recorded cost are excluded
      -- from BOTH numerator and denominator (same semantics as the Daily Report /
      -- StoreAgent overview), instead of COALESCE(cost,0) booking them as 100%-margin
      -- revenue - that inflated the headline vs the Daily Report's figure.
      --
      -- COST SANITY: a "costed" sku also requires cost*u <= 1.5*rev, i.e. the
      -- recorded cost may not exceed 1.5× the sku's own realized unit price.
      -- Store 177 keeps CASE costs in the per-unit field ("Modelo 24/12" cost
      -- 30.80 vs 17.29 unit price; 56 of 1628 costed skus, avg 45× price) -
      -- enough to drive the all-time headline to −666%. Such costs are treated
      -- as UNRECORDED: excluded here, and counted against costed coverage.
      (SELECT CASE WHEN COALESCE(SUM(rev) FILTER (WHERE cost > 0 AND cost*u <= 1.5*rev),0) > 0
                THEN ROUND(100.0*(SUM(rev) FILTER (WHERE cost > 0 AND cost*u <= 1.5*rev)
                                  - SUM(cost*u) FILTER (WHERE cost > 0 AND cost*u <= 1.5*rev))
                           /NULLIF(SUM(rev) FILTER (WHERE cost > 0 AND cost*u <= 1.5*rev),0),1)
                ELSE 0 END FROM pick) AS gross_margin_pct,
      -- share of revenue that actually has a (sane) product cost - drives the gate
      -- below (a store with ~no cost data would otherwise read ~100% margin).
      (SELECT CASE WHEN SUM(rev) > 0
                THEN ROUND(100.0*COALESCE(SUM(rev) FILTER (WHERE cost > 0 AND cost*u <= 1.5*rev),0)/NULLIF(SUM(rev),0),1)
                ELSE 0 END FROM pick) AS margin_costed_pct`;
}
const PANELS_SQL_ALLTIME = buildPanelsSql(false);
const PANELS_SQL_DATED = buildPanelsSql(true);

// Shape a panels row and apply the cost-coverage gate to gross margin (mirrors the
// chat get_margin tool): below 5% of revenue costed, margin can't be computed and
// would read a misleading ~100%, so report it unavailable with a note instead;
// 5-95% costed is usable but approximate; ≥95% is clean.
function shapePanels(x, window, label) {
  const costed = x.margin_costed_pct == null ? 0 : Number(x.margin_costed_pct);
  let marginPct = x.gross_margin_pct, note = null;
  if (costed < 5) {
    marginPct = null;
    note = "Product cost isn't recorded for this store, so gross margin can't be computed.";
  } else if (costed < 95) {
    note = `Based on the ${costed}% of sales that have a cost recorded, treat as a close estimate.`;
  }
  return { gross_margin_pct: marginPct, margin_note: note, margin_costed_pct: costed,
           top_products: x.top_products || [], categories: x.categories || [], window, label };
}

async function panelsRecent(pool, clientId, locationId, latestDate) {
  // 1) all-time - the normalized hash-join in buildPanelsSql makes this finish in a
  //    few seconds even on the 1.45M-line store, so no line-count gate is needed.
  try {
    const r = await pool.query(PANELS_SQL_ALLTIME, [clientId, locationId]);
    const x = r.rows[0] || {};
    return shapePanels(x, 'all_time', 'All time');
  } catch (err) {
    logger.warn('Dashboard panels all-time timed out; falling back to 30 days', { error: err.message });
  }

  // 2) last-30-days safety net (rarely hit now), anchored on the latest data day.
  if (!latestDate) return null;
  const end = (latestDate instanceof Date) ? latestDate.toISOString().slice(0, 10) : String(latestDate).slice(0, 10);
  const start = new Date(`${end}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - 29);
  try {
    const r = await pool.query(PANELS_SQL_DATED, [clientId, locationId, start.toISOString().slice(0, 10), end]);
    const x = r.rows[0] || {};
    return shapePanels(x, 'last_30_days', 'Past 30 days');
  } catch (err) {
    logger.warn('Dashboard panels 30-day fallback failed', { error: err.message });
    return null;
  }
}

// POST /api/dashboard/refresh - bust the cache for the caller's tenant
// (wire this to the "Refresh" button on the dashboard UI).
router.post('/refresh', (req, res) => {
  const clientId = req.user.client_id;
  const locationId = req.user.location_id;
  const cacheKey = `${clientId}_${locationId}`;
  dashboardCache.delete(cacheKey);
  res.json({ success: true, message: 'Dashboard cache cleared.' });
});

// GET /api/dashboard
router.get('/', async (req, res) => {
  const pool = req.pool;
  const clientId = req.user.client_id;
  const locationId = req.user.location_id;
  const p = [clientId, locationId];
  const cacheKey = `${clientId}_${locationId}`;
  const bypassCache = req.query.fresh === '1';

  // Compute (single-flighted): registers in dashboardInFlight so concurrent
  // callers share one run; on success the cache row is updated. Declared as a
  // function so the stale path below can fire it WITHOUT awaiting.
  const startCompute = () => {
    const existing = dashboardInFlight.get(cacheKey);
    if (existing) return existing;
    const workPromise = computeDashboard();
    dashboardInFlight.set(cacheKey, workPromise);
    workPromise
      .then((response) => {
        dashboardCache.set(cacheKey, {
          payload: response,
          cachedAt: Date.now(),
          expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS,
        });
      })
      .catch((err) => logger.warn('Dashboard background refresh failed', { error: err.message, clientId, locationId }))
      .finally(() => dashboardInFlight.delete(cacheKey));
    return workPromise;
  };

  // Fast path - fresh cache is served as-is; an EXPIRED cache is served
  // stale-while-revalidate: the ~6s recompute runs in the background and the
  // caller gets the previous payload instantly (same pattern as the storeagent
  // route). Only a tenant with no cached payload at all waits for the compute.
  if (!bypassCache) {
    const cached = dashboardCache.get(cacheKey);
    if (cached) {
      const fresh = cached.expiresAt > Date.now();
      if (!fresh) startCompute(); // fire-and-forget; next viewer gets the new row
      res.setHeader('X-Cache', fresh ? 'HIT' : 'STALE');
      res.setHeader('X-Cache-Age-Ms', String(Date.now() - cached.cachedAt));
      return res.json(cached.payload);
    }

    // Coalesce concurrent cold requests for the same tenant
    const inFlight = dashboardInFlight.get(cacheKey);
    if (inFlight) {
      try {
        const payload = await inFlight;
        res.setHeader('X-Cache', 'COALESCED');
        return res.json(payload);
      } catch {
        // fall through to recompute if the shared promise failed
      }
    }
  }

  async function computeDashboard() {
    // Phase 1: Anchor day for every dated query below. The most recent
    // COMPLETED sales day - never the current (still-filling) date, and never
    // a day established only by a midnight boundary artifact. See
    // helpers/completedSaleDay.js for the two failure modes this fixes.
    const dateRows = await safeQuery(pool,
      `SELECT (${completedSaleDaySql()}) as latest`, p
    );
    const latestDate = dateRows?.[0]?.latest || null;

    if (!latestDate) {
      return {
        latestSaleDate: null,
        kpis: { revenue: 0, transactions: 0, totalProducts: 0, outOfStock: 0, lowStock: 0, grossMarginPct: 0 },
        revenueTrend: [],
        topProducts: [],
        categoryBreakdown: [],
        alerts: { outOfStockCount: 0, restockCost: 0, belowCostCount: 0, topMover: null },
        inventory: { retailValue: 0, costValue: 0, lowStock: [], overstocked: [] },
      };
    }

    // Phase 2: Run all queries in parallel using the latest date
    const dp = [clientId, locationId, latestDate]; // params with date

    // Margin / Top Products / Category all derive from ONE optimized query (de-dup
    // once, all-time → last_30_days fallback). Shared promise so it runs a single
    // time and feeds all three panels + the window marker.
    const panelsPromise = panelsRecent(pool, clientId, locationId, latestDate);

    // Inventory Intelligence's own at-cost figure, read from the storeagent
    // 'inventory' capability cache (analytics DB, kept warm by the 15-min
    // cron). The Dashboard shows THE SAME number, so the two surfaces can
    // never disagree - II resolves missing costs (purchases fallback +
    // category-median imputation) that the plain SUM(cost*stock_qty) below
    // books as $0. Cache miss / retail-basis store → fall back to our SQL.
    // The same read also yields the Stock Velocity breakdown (products grouped
    // by how fast they sell), so the Dashboard shows II's own classification
    // rather than a second, subtly different one computed here.
    const invIntelPromise = (async () => {
      const empty = { costValue: null, velocity: null };
      try {
        const { rows } = await getAnalyticsPool().query(
          `SELECT payload FROM storeagent_capability_results
            WHERE client_id = $1 AND location_id = $2 AND capability = 'inventory'`,
          [clientId, locationId]
        );
        const payload = rows[0]?.payload;
        if (!payload) return empty;

        const fc = payload.frozen_capital;
        const val = fc && fc.value_basis === 'cost'
          ? Number(fc.total_inventory_value_at_cost) : NaN;

        // classes is keyed by class name. Each carries a drill-down list; only
        // the leading VELOCITY_ITEM_CAP are forwarded (already ranked by the
        // engine: movers by 90-day units, the rest by money tied up).
        // `skuCount` stays the FULL count so the bars and the "top N of M"
        // label remain honest.
        const vc = payload.velocity_classes;
        const classes = vc?.classes || {};
        const atCost = payload.frozen_capital?.value_basis === 'cost';
        const velocity = vc && Number(vc.total_skus) > 0 ? {
          totalSkus: Number(vc.total_skus),
          valueBasis: atCost ? 'cost' : 'retail',
          classes: VELOCITY_CLASSES
            .map(({ key, label }) => ({
              key,
              label,
              skuCount: Number(classes[key]?.sku_count) || 0,
              items: (classes[key]?.items || []).slice(0, VELOCITY_ITEM_CAP).map((it) => ({
                sku: it.sku,
                name: (it.product_name || '').trim(),
                onHand: Number(it.on_hand) || 0,
                units90: Number(it.units_90) || 0,
                value: Number(atCost ? it.value_at_cost : it.value_at_retail) || 0,
                // null = never sold
                daysSinceLastSale: it.days_since_last_sale == null
                  ? null : Number(it.days_since_last_sale),
              })),
            }))
            .filter((c) => c.skuCount > 0),
        } : null;

        return { costValue: Number.isFinite(val) ? val : null, velocity };
      } catch {
        return empty; // analytics unavailable → dashboard's own SQL stands
      }
    })();

    // Gross margin, same single-source-of-truth treatment: the Store
    // Intelligence overview computes it over the LAST 90 DAYS on the costed
    // subset ("Gross margin is running at X% where cost is known") - the
    // Dashboard KPI shows THAT figure so the two can never disagree. Cache
    // miss / cost-less store → the panels query's own margin stands.
    const overviewMarginPromise = (async () => {
      try {
        const { rows } = await getAnalyticsPool().query(
          `SELECT payload#>'{overview,pulse,gross_margin_pct}' AS margin
             FROM storeagent_capability_results
            WHERE client_id = $1 AND location_id = $2 AND capability = 'overview'`,
          [clientId, locationId]
        );
        const val = rows[0]?.margin != null ? Number(rows[0].margin) : NaN;
        return Number.isFinite(val) ? val : null;
      } catch {
        return null;
      }
    })();

    const [
      kpiRevenue,
      kpiProducts,
      kpiStockAlerts,
      kpiMargin,
      revenueTrend,
      topProducts,
      categoryBreakdown,
      alertsData,
      topMover,
      inventoryValue,
      lowStockItems,
      overstockedItems,
    ] = await Promise.all([

      // 1. Latest day revenue + transactions
      safeQuery(pool, `
        SELECT COALESCE(SUM(sub_total), 0) as revenue, COUNT(*) as transactions
        FROM sales
        WHERE client_id = $1 AND location_id = $2 AND sale_date::date = $3
      `, dp),

      // 2. Total products in stock
      safeQuery(pool, `
        SELECT COUNT(*) as total
        FROM products
        WHERE client_id = $1 AND location_id = $2 AND stock_qty > 0
      `, p),

      // 3. Out-of-stock + negative-stock + low stock counts.
      //    Out-of-stock is strictly stock_qty = 0. Negative stock (oversold /
      //    unposted receiving / returns) is counted as its OWN bucket rather
      //    than folded into out-of-stock, so the card reports a real zero-shelf
      //    count and surfaces the data-quality signal separately. In Postgres
      //    both `= 0` and `< 0` exclude NULL exactly as the previous `<= 0`
      //    did, so (out_of_stock + negative_stock) is the same set as before
      //    and the Reorder Needed total is unchanged.
      safeQuery(pool, `
        SELECT
          COUNT(*) FILTER (WHERE stock_qty = 0) as out_of_stock,
          COUNT(*) FILTER (WHERE stock_qty < 0) as negative_stock,
          COUNT(*) FILTER (WHERE stock_qty > 0 AND stock_qty < 5) as low_stock
        FROM products
        WHERE client_id = $1 AND location_id = $2
      `, p),

      // 4. Overall gross margin % - from the shared optimized panels query.
      panelsPromise.then(x => (x ? [{ gross_margin_pct: x.gross_margin_pct, note: x.margin_note }] : null)),

      // 5. Revenue trend - daily for last 30 days relative to latest date
      safeQuery(pool, `
        SELECT sale_date::date as date, SUM(sub_total) as revenue
        FROM sales
        WHERE client_id = $1 AND location_id = $2
          AND sale_date::date > ($3::date - INTERVAL '30 days')
          AND sale_date::date <= $3::date
        GROUP BY sale_date::date
        ORDER BY date ASC
      `, dp),

      // 6. Top 10 products by revenue - from the shared optimized panels query.
      panelsPromise.then(x => (x ? x.top_products : null)),

      // 7. Category breakdown - from the shared optimized panels query.
      panelsPromise.then(x => (x ? x.categories : null)),


      // 8. Alerts: OOS count, restock cost, below-cost count
      safeQuery(pool, `
        SELECT
          (SELECT COUNT(*) FROM products WHERE client_id = $1 AND location_id = $2 AND stock_qty = 0) as oos_count,
          (SELECT COALESCE(SUM(cost), 0) FROM products WHERE client_id = $1 AND location_id = $2 AND stock_qty = 0) as restock_cost,
          (SELECT COUNT(*) FROM products WHERE client_id = $1 AND location_id = $2 AND price > 0 AND cost > 0 AND price < cost) as below_cost_count
      `, p),

      // 9. Top mover (last 7 days relative to latest date)
      safeQuery(pool, `
        SELECT product_name as name, SUM(quantity) as units
        FROM sale_items
        WHERE client_id = $1 AND location_id = $2
          AND sale_date::date > ($3::date - INTERVAL '7 days')
          AND sale_date::date <= $3::date
        GROUP BY product_name
        ORDER BY units DESC
        LIMIT 1
      `, dp),

      // 10. Inventory value. uncosted_count backs the cost-value footnote: items with
      //     no recorded cost contribute $0 here, while Inventory Intelligence imputes
      //     a cost for them - that's why its "at cost" figure reads slightly higher.
      safeQuery(pool, `
        SELECT
          SUM(price * stock_qty) as retail_value,
          SUM(cost * stock_qty) as cost_value,
          COUNT(*) FILTER (WHERE cost IS NULL OR cost <= 0) as uncosted_count
        FROM products
        WHERE client_id = $1 AND location_id = $2 AND stock_qty > 0
      `, p),

      // 11. Low stock items - full list (capped at 200 to keep payload bounded
      //     for misconfigured stores with thousands of low-stock SKUs).
      //     Frontend renders all rows in a scrollable container.
      safeQuery(pool, `
        SELECT product_name as name, stock_qty as on_hand, price, cost
        FROM products
        WHERE client_id = $1 AND location_id = $2 AND stock_qty > 0 AND stock_qty < 5 AND price > 0
        ORDER BY stock_qty ASC
        LIMIT 200
      `, p),

      // 12. Overstocked items - standardized on WEEKS OF COVER, the same definition
      //     the recommendation engine uses (inventory_health.py in the Python repo):
      //     weeks = on_hand / (units_sold_30d / 4.3), flagged when cover exceeds the
      //     per-family mild threshold (beer 4 / default 8 / spirits 12 / wine 20 wks;
      //     family matched coarsely from the raw category string). Items with zero
      //     30d sales have infinite cover and are included, as the engine does.
      //     Ranked by tied-up capital (on_hand × price), not unit count - a 400-unit
      //     $3 mixer matters less than 20 units of a $70 spirit.
      safeQuery(pool, `
        WITH sold AS (
          SELECT TRIM(sku) AS k, SUM(quantity) AS units_30d
          FROM sale_items
          WHERE client_id = $1 AND location_id = $2
            AND sale_date::date > ($3::date - INTERVAL '30 days')
            AND sale_date::date <= $3::date
          GROUP BY TRIM(sku)),
        prod AS (
          SELECT p.product_name, p.stock_qty, p.price, p.cost,
                 COALESCE(ss.units_30d, 0) + COALESCE(su.units_30d, 0) AS units_30d,
                 CASE
                   WHEN p.category ~* '\\y(beer|ale|ipa|lager|stout|porter|cider|seltzer|rtd)\\y' THEN 4.0
                   WHEN p.category ~* '\\y(wine|champagne|prosecco|sparkling)\\y' THEN 20.0
                   WHEN p.category ~* '\\y(liquor|spirits?|whisk(e)?y|bourbon|scotch|vodka|gin|rum|tequila|mezcal|brandy|cognac|liqueur)\\y' THEN 12.0
                   ELSE 8.0
                 END AS overstock_weeks
          FROM products p
          LEFT JOIN sold ss ON ss.k = TRIM(p.sku)
          LEFT JOIN sold su ON su.k = TRIM(p.upc) AND TRIM(p.upc) IS DISTINCT FROM TRIM(p.sku)
          WHERE p.client_id = $1 AND p.location_id = $2 AND p.stock_qty > 0)
        SELECT product_name AS name, stock_qty AS on_hand, price, cost,
               CASE WHEN units_30d > 0
                    THEN ROUND((stock_qty / (units_30d / 4.3))::numeric, 1) END AS weeks_on_hand,
               ROUND((stock_qty * COALESCE(price, 0))::numeric, 2) AS tied_up
        FROM prod
        WHERE units_30d = 0 OR stock_qty / (units_30d / 4.3) > overstock_weeks
        ORDER BY stock_qty * COALESCE(price, 0) DESC
        LIMIT 200
      `, dp),
    ]);

    // Build response with raw numbers
    // Already resolved (the panel derivations above awaited it) - instant here.
    const panels = await panelsPromise;

    const response = {
      latestSaleDate: latestDate,
      // Window actually used for Gross Margin / Top Products / Category. When a big
      // store can't compute all-time in real time we fall back to 30 days; the UI
      // shows this label (e.g. "Past 30 days") so the user knows the scope.
      panelsWindow: panels ? { value: panels.window, label: panels.label } : null,
      kpis: {
        revenue: parseFloat(kpiRevenue?.[0]?.revenue) || 0,
        transactions: parseInt(kpiRevenue?.[0]?.transactions) || 0,
        totalProducts: parseInt(kpiProducts?.[0]?.total) || 0,
        outOfStock: parseInt(kpiStockAlerts?.[0]?.out_of_stock) || 0,
        negativeStock: parseInt(kpiStockAlerts?.[0]?.negative_stock) || 0,
        lowStock: parseInt(kpiStockAlerts?.[0]?.low_stock) || 0,
        grossMarginPct: (await overviewMarginPromise)
          ?? (kpiMargin?.[0]?.gross_margin_pct == null ? null : (parseFloat(kpiMargin[0].gross_margin_pct) || 0)),
        grossMarginNote: (await overviewMarginPromise) != null
          ? 'Last 90 days, where cost is known, same figure as Store Intelligence.'
          : (kpiMargin?.[0]?.note || null),
        // 'store_intelligence' → the 90d overview figure; 'panels' → own SQL.
        grossMarginSource: (await overviewMarginPromise) != null ? 'store_intelligence' : 'panels',
      },
      revenueTrend: (revenueTrend || []).map(r => ({
        date: r.date,
        revenue: parseFloat(r.revenue) || 0,
      })),
      topProducts: (topProducts || []).map(r => ({
        name: (r.name || '').trim(),
        revenue: parseFloat(r.revenue) || 0,
        units: parseInt(r.units) || 0,
      })),
      categoryBreakdown: (categoryBreakdown || []).map(r => ({
        category: (r.category || '').trim(),
        revenue: parseFloat(r.revenue) || 0,
        units: parseInt(r.units) || 0,
        profit: parseFloat(r.profit) || 0,
      })),
      alerts: {
        outOfStockCount: parseInt(alertsData?.[0]?.oos_count) || 0,
        restockCost: parseFloat(alertsData?.[0]?.restock_cost) || 0,
        belowCostCount: parseInt(alertsData?.[0]?.below_cost_count) || 0,
        topMover: topMover?.[0] ? {
          name: (topMover[0].name || '').trim(),
          units: parseInt(topMover[0].units) || 0,
        } : null,
      },
      inventory: {
        retailValue: parseFloat(inventoryValue?.[0]?.retail_value) || 0,
        costValue: (await invIntelPromise).costValue ?? (parseFloat(inventoryValue?.[0]?.cost_value) || 0),
        // 'inventory_intelligence' = same figure as the II tab (missing costs
        // estimated there); 'products_table' = strict SUM(cost*stock_qty).
        costValueSource: (await invIntelPromise).costValue != null ? 'inventory_intelligence' : 'products_table',
        uncostedCount: parseInt(inventoryValue?.[0]?.uncosted_count) || 0,
        // null when the storeagent cache is cold - the UI hides the section.
        velocity: (await invIntelPromise).velocity,
        lowStock: (lowStockItems || []).map(r => ({
          name: (r.name || '').trim(),
          onHand: parseInt(r.on_hand) || 0,
          price: parseFloat(r.price) || 0,
          cost: parseFloat(r.cost) || 0,
        })),
        overstocked: (overstockedItems || []).map(r => ({
          name: (r.name || '').trim(),
          onHand: parseInt(r.on_hand) || 0,
          price: parseFloat(r.price) || 0,
          cost: parseFloat(r.cost) || 0,
          // null = no sales in the last 30 days (infinite cover; UI shows ∞)
          weeksOnHand: r.weeks_on_hand == null ? null : parseFloat(r.weeks_on_hand),
          tiedUp: parseFloat(r.tied_up) || 0,
        })),
      },
    };

    return response;
  }

  // No cached payload (or ?fresh=1): compute now. startCompute registers the
  // run and stores the result, so concurrent callers coalesce onto it.
  try {
    const response = await startCompute();
    res.setHeader('X-Cache', bypassCache ? 'BYPASS' : 'MISS');
    res.json(response);
  } catch (err) {
    const safeErr = toSafeError(err);
    logger.error('Dashboard load failed', { error: err.message, clientId, locationId });
    res.status(safeErr.statusCode).json({ error: { code: safeErr.code, message: safeErr.userMessage } });
  }
});

module.exports = router;
