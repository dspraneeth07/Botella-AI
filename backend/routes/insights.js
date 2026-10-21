const router = require('express').Router();
const logger = require('../utils/logger');
const { completedSaleDaySql } = require('../helpers/completedSaleDay');
const { toSafeError } = require('../utils/errors');

// ============================================
// INSIGHTS API - Live predictive analysis
// ============================================

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
    logger.warn('Insights query failed', { error: err.message });
    return null;
  }
}

// Format money values
function fmt(val) {
  if (val == null) return '$0';
  const n = parseFloat(val);
  if (isNaN(n)) return '$0';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtK(val) {
  if (val == null) return '$0';
  const n = parseFloat(val);
  if (isNaN(n)) return '$0';
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}

function pct(val) {
  if (val == null) return '0%';
  const n = parseFloat(val);
  if (isNaN(n)) return '0%';
  return n.toFixed(1) + '%';
}

router.get('/', async (req, res) => {
  const pool = req.pool;
  const clientId = req.user.client_id;
  const locationId = req.user.location_id;
  const p = [clientId, locationId];

  try {
    // Run all queries in parallel
    const [
      overview,
      topSellers,
      salesByCategory,
      recentSalesTotal,
      highMargin,
      lowMargin,
      marginByCategory,
      lowStock,
      inventoryValue,
      overstocked,
      latestDate,
    ] = await Promise.all([
      // --- STORE OVERVIEW ---
      safeQuery(pool, `
        SELECT
          (SELECT COUNT(*) FROM products WHERE client_id = $1 AND location_id = $2) as total_products,
          (SELECT COUNT(DISTINCT category) FROM products WHERE client_id = $1 AND location_id = $2 AND category IS NOT NULL) as total_categories,
          (SELECT COUNT(*) FROM suppliers WHERE client_id = $1 AND location_id = $2) as total_suppliers,
          (SELECT COUNT(*) FROM customers WHERE client_id = $1 AND location_id = $2) as total_customers
      `, p),

      // --- SALES: Top 5 products by total revenue (from sale_items directly) ---
      safeQuery(pool, `
        SELECT si.product_name as name, SUM(si.total_amount) as revenue,
               SUM(si.quantity) as units, si.category
        FROM sale_items si
        WHERE si.client_id = $1 AND si.location_id = $2
        GROUP BY si.product_name, si.category
        HAVING SUM(si.total_amount) > 0
        ORDER BY revenue DESC
        LIMIT 5
      `, p),

      // --- SALES: Revenue by category (top 5, from sale_items directly) ---
      safeQuery(pool, `
        SELECT si.category,
               SUM(si.total_amount) as revenue,
               SUM(si.quantity) as units
        FROM sale_items si
        WHERE si.client_id = $1 AND si.location_id = $2
          AND si.category IS NOT NULL
        GROUP BY si.category
        HAVING SUM(si.total_amount) > 0
        ORDER BY revenue DESC
        LIMIT 5
      `, p),

      // --- SALES: Most recent day's sales total (from sales header) ---
      safeQuery(pool, `
        SELECT sale_date::date as date, SUM(total_amount) as daily_total,
               COUNT(*) as transactions
        FROM sales
        WHERE client_id = $1 AND location_id = $2
          AND sale_date::date = (SELECT MAX(sale_date::date) FROM sales WHERE client_id = $1 AND location_id = $2)
        GROUP BY sale_date::date
      `, p),

      // --- MARGINS: Highest margin products (top 5) ---
      safeQuery(pool, `
        SELECT product_name as name,
               price, cost,
               CASE WHEN price > 0
                    THEN ROUND(((price - cost) / price) * 100, 1)
                    ELSE 0 END as margin_pct,
               category
        FROM products
        WHERE client_id = $1 AND location_id = $2
          AND price > 0 AND cost > 0
          AND stock_qty > 0
        ORDER BY margin_pct DESC
        LIMIT 5
      `, p),

      // --- MARGINS: Lowest margin products (top 5) ---
      safeQuery(pool, `
        SELECT product_name as name,
               price, cost,
               CASE WHEN price > 0
                    THEN ROUND(((price - cost) / price) * 100, 1)
                    ELSE 0 END as margin_pct,
               category
        FROM products
        WHERE client_id = $1 AND location_id = $2
          AND price > 0 AND cost > 0
          AND stock_qty > 0
        ORDER BY margin_pct ASC
        LIMIT 5
      `, p),

      // --- MARGINS: Average margin by category ---
      safeQuery(pool, `
        SELECT category,
               ROUND(AVG(
                 CASE WHEN price > 0
                      THEN ((price - cost) / price) * 100
                      ELSE 0 END
               ), 1) as avg_margin,
               SUM((price - cost) * stock_qty) as total_profit
        FROM products
        WHERE client_id = $1 AND location_id = $2
          AND price > 0 AND cost > 0
          AND category IS NOT NULL
        GROUP BY category
        ORDER BY avg_margin DESC
        LIMIT 5
      `, p),

      // --- INVENTORY: Low stock items (stock_qty < 5) ---
      safeQuery(pool, `
        SELECT product_name as name,
               stock_qty as on_hand,
               price
        FROM products
        WHERE client_id = $1 AND location_id = $2
          AND stock_qty < 5 AND stock_qty >= 0
          AND price > 0
        ORDER BY stock_qty ASC
        LIMIT 5
      `, p),

      // --- INVENTORY: Total value ---
      safeQuery(pool, `
        SELECT SUM(price * stock_qty) as total_retail_value,
               SUM(cost * stock_qty) as total_cost_value,
               COUNT(*) as total_skus
        FROM products
        WHERE client_id = $1 AND location_id = $2
          AND stock_qty > 0
      `, p),

      // --- INVENTORY: Overstocked items - weeks-of-cover definition, matching the
      //     dashboard tile and the recommendation engine (not a raw unit threshold):
      //     cover = stock / (units_30d / 4.3), flagged past the per-family mild
      //     threshold, ranked by tied-up capital.
      safeQuery(pool, `
        WITH latest AS (
          SELECT MAX(sale_date::date) AS d FROM sales WHERE client_id = $1 AND location_id = $2),
        sold AS (
          SELECT TRIM(sku) AS k, SUM(quantity) AS units_30d
          FROM sale_items, latest
          WHERE client_id = $1 AND location_id = $2
            AND sale_date::date > (latest.d - INTERVAL '30 days')
            AND sale_date::date <= latest.d
          GROUP BY TRIM(sku)),
        prod AS (
          SELECT p.product_name, p.stock_qty, p.price,
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
        SELECT product_name AS name, stock_qty AS on_hand, price,
               CASE WHEN units_30d > 0
                    THEN ROUND((stock_qty / (units_30d / 4.3))::numeric, 1) END AS weeks_on_hand
        FROM prod
        WHERE units_30d = 0 OR stock_qty / (units_30d / 4.3) > overstock_weeks
        ORDER BY stock_qty * COALESCE(price, 0) DESC
        LIMIT 5
      `, p),

      // --- Get latest date for context ---
      // The most recent COMPLETED sales day, not MAX(sale_date).
      //
      // helpers/completedSaleDay.js opens with "Dashboards AND REPORTS must
      // anchor on the most recent COMPLETED sales day, never on a day that is
      // still filling" - and this route was the one place that did not. The
      // dashboard anchored on Sep 11 while Reports, reading a plain MAX over a
      // store whose POS syncs intraday, anchored on a part-filled Sep 12. Two
      // screens, one store, two "data through" dates, and a margin computed
      // over a different span on each.
      safeQuery(pool, `SELECT (${completedSaleDaySql()}) as latest`, p),
    ]);

    // Build structured response
    const latestSaleDate = latestDate?.[0]?.latest || null;

    const response = {
      timestamp: new Date().toISOString(),
      latestSaleDate,
      categories: [
        {
          id: 'overview',
          title: 'Store Overview',
          icon: 'Store',
          insights: buildOverview(overview, recentSalesTotal, latestSaleDate),
        },
        {
          id: 'sales',
          title: 'Sales Analysis',
          icon: 'TrendingUp',
          insights: buildSales(topSellers, salesByCategory, recentSalesTotal, latestSaleDate),
        },
        {
          id: 'margins',
          title: 'Margin & Profitability',
          icon: 'DollarSign',
          insights: buildMargins(highMargin, lowMargin, marginByCategory),
        },
        {
          id: 'inventory',
          title: 'Inventory Analysis',
          icon: 'Package',
          insights: buildInventory(lowStock, inventoryValue, overstocked),
        },
      ],
    };

    res.json(response);
  } catch (err) {
    const safeErr = toSafeError(err);
    logger.error('Insights load failed', { error: err.message });
    res.status(safeErr.statusCode).json({ error: { code: safeErr.code, message: safeErr.userMessage } });
  }
});

// ---- Builder functions ----

function buildOverview(overview, recentSales, latestDate) {
  const items = [];
  const o = overview?.[0];
  if (o) {
    items.push({ label: 'Total Products', value: Number(o.total_products).toLocaleString(), type: 'metric' });
    items.push({ label: 'Categories', value: o.total_categories, type: 'metric' });
    items.push({ label: 'Suppliers', value: o.total_suppliers, type: 'metric' });
    items.push({ label: 'Customers', value: Number(o.total_customers).toLocaleString(), type: 'metric' });
  }
  const s = recentSales?.[0];
  if (s) {
    items.push({ label: `Latest Sales (${formatDate(latestDate)})`, value: fmtK(s.daily_total), type: 'metric', highlight: true });
    items.push({ label: 'Transactions', value: Number(s.transactions).toLocaleString(), type: 'metric' });
  }
  if (items.length === 0) {
    items.push({ label: 'Status', value: 'Database not available', type: 'text' });
  }
  return items;
}

function buildSales(topSellers, byCategory, recentSales, latestDate) {
  const items = [];

  // Recent day total
  const s = recentSales?.[0];
  if (s) {
    items.push({
      label: `Day Revenue (${formatDate(latestDate)})`,
      value: fmtK(s.daily_total),
      sub: `${s.transactions} transactions`,
      type: 'metric',
      highlight: true,
    });
  }

  // Top sellers
  if (topSellers && topSellers.length > 0) {
    items.push({
      label: 'Top Sellers',
      type: 'table',
      columns: ['Product', 'Revenue', 'Units'],
      rows: topSellers.map(r => [
        (r.name || '').trim().substring(0, 30),
        fmtK(r.revenue),
        Number(r.units || 0).toLocaleString(),
      ]),
    });
  }

  // By category
  if (byCategory && byCategory.length > 0) {
    items.push({
      label: 'Revenue by Category',
      type: 'table',
      columns: ['Category', 'Revenue', 'Units'],
      rows: byCategory.map(r => [
        (r.category || '').trim().substring(0, 20),
        fmtK(r.revenue),
        Number(r.units || 0).toLocaleString(),
      ]),
    });
  }

  if (items.length === 0) {
    items.push({ label: 'Sales data', value: 'No data available', type: 'text' });
  }
  return items;
}

function buildMargins(highMargin, lowMargin, byCategory) {
  const items = [];

  if (highMargin && highMargin.length > 0) {
    items.push({
      label: 'Highest Margin Products',
      type: 'table',
      columns: ['Product', 'Price', 'Margin'],
      rows: highMargin.map(r => [
        (r.name || '').trim().substring(0, 28),
        fmt(r.price),
        pct(r.margin_pct),
      ]),
    });
  }

  if (lowMargin && lowMargin.length > 0) {
    items.push({
      label: 'Lowest Margin Products',
      type: 'table',
      columns: ['Product', 'Price', 'Margin'],
      rows: lowMargin.map(r => [
        (r.name || '').trim().substring(0, 28),
        fmt(r.price),
        pct(r.margin_pct),
      ]),
      warning: true,
    });
  }

  if (byCategory && byCategory.length > 0) {
    items.push({
      label: 'Avg Margin by Category',
      type: 'table',
      columns: ['Category', 'Avg Margin', 'Potential Profit'],
      rows: byCategory.map(r => [
        (r.category || '').trim().substring(0, 20),
        pct(r.avg_margin),
        fmtK(r.total_profit),
      ]),
    });
  }

  if (items.length === 0) {
    items.push({ label: 'Margin data', value: 'No data available', type: 'text' });
  }
  return items;
}

function buildInventory(lowStock, inventoryValue, overstocked) {
  const items = [];

  const iv = inventoryValue?.[0];
  if (iv) {
    items.push({ label: 'Total Retail Value', value: fmtK(iv.total_retail_value), type: 'metric', highlight: true });
    items.push({ label: 'Total Cost Value', value: fmtK(iv.total_cost_value), type: 'metric' });
    items.push({ label: 'Active SKUs', value: Number(iv.total_skus).toLocaleString(), type: 'metric' });
  }

  if (lowStock && lowStock.length > 0) {
    items.push({
      label: `Low Stock Alert (${lowStock.length} items)`,
      type: 'table',
      columns: ['Product', 'On Hand', 'Price'],
      rows: lowStock.map(r => [
        (r.name || '').trim().substring(0, 28),
        String(r.on_hand),
        fmt(r.price),
      ]),
      warning: true,
    });
  }

  if (overstocked && overstocked.length > 0) {
    items.push({
      label: `Overstocked (${overstocked.length} items)`,
      type: 'table',
      columns: ['Product', 'On Hand', 'Wks Cover'],
      rows: overstocked.map(r => [
        (r.name || '').trim().substring(0, 28),
        String(r.on_hand),
        r.weeks_on_hand == null ? '∞' : String(r.weeks_on_hand),
      ]),
    });
  }

  if (items.length === 0) {
    items.push({ label: 'Inventory data', value: 'No data available', type: 'text' });
  }
  return items;
}

function formatDate(d) {
  if (!d) return 'N/A';
  try {
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return String(d);
  }
}

module.exports = router;
