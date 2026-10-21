#!/usr/bin/env node
/*
  ground-truth.js - INDEPENDENT expected-value builder for the grader.

  Writes its OWN canonical SQL (it does NOT import lib/metrics.js or routes/chat.js),
  runs it read-only against PostgreSQL, and emits a snapshot of expected values the
  grader compares answers against. This is the "independent + grounded in real DB
  rows" half of the verifier - if a bot tool returned wrong rows, the answer would
  match the captured rows but DISAGREE with this independent ground truth, and the
  grader would fail it.

  Data here is historical/frozen, so the snapshot is stable. It is written to
  eval-results/ground-truth.json and reused by grade-eval.js for deterministic
  re-grading without re-hitting the DB.
*/
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const CLIENT_ID = Number(process.env.EVAL_CLIENT_ID || 125);
const LOCATION_ID = Number(process.env.EVAL_LOCATION_ID || 125);
const WHISKEY_RE = '\\y(whiskey|whisky|bourbon|scotch|rye|single malt)\\y';
const SCOTCH_RE = '\\yscotch\\y';  // strict scotch (by name): "scotch" is a specific type, not the whole whiskey family. Single-malt-only labels are a documented edge case.
const ACTIVE = `(s.sale_status IS NULL OR LOWER(TRIM(s.sale_status)) NOT IN ('voided','void','returned','cancelled','canceled','refunded'))`;

function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function iso(d) { return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }

async function build({ pool, clientId = CLIENT_ID, locationId = LOCATION_ID } = {}) {
  const ownPool = pool || new Pool({
    host: process.env.PG_HOST, port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    options: '-c default_transaction_read_only=on', statement_timeout: 30000, connectionTimeoutMillis: 8000, max: 3,
  });
  const q = (sql, params) => ownPool.query(sql, params);
  const P = [clientId, locationId];
  const gt = { clientId, locationId, generatedAt: new Date().toISOString() };

  // latest / range
  const range = (await q(`SELECT MIN(sale_date::date) mn, MAX(sale_date::date) mx FROM sales WHERE client_id=$1 AND location_id=$2`, P)).rows[0];
  gt.latestDate = iso(range.mx); gt.earliestDate = iso(range.mn);

  // daily for last 45 days -> dateToWeekday, salesExistByDate, bestDay(last7)
  const daily = (await q(
    `SELECT sale_date::date d, TRIM(TO_CHAR(sale_date,'Day')) wd, COUNT(*) n, ROUND(SUM(total_amount::numeric),2) rev
       FROM sales WHERE client_id=$1 AND location_id=$2
        AND sale_date::date > (SELECT MAX(sale_date::date)-45 FROM sales WHERE client_id=$1 AND location_id=$2)
      GROUP BY 1,2 ORDER BY 1`, P)).rows;
  gt.dateToWeekday = {}; gt.salesExistByDate = { __latest__: 0 };
  for (const row of daily) {
    const d = iso(row.d);
    gt.dateToWeekday[d] = row.wd;
    gt.salesExistByDate[d] = parseInt(row.n, 10);
  }
  gt.salesExistByDate.__latest__ = gt.salesExistByDate[gt.latestDate] || 0;

  const last7 = daily.filter(row => {
    const dd = new Date(`${iso(row.d)}T00:00:00Z`);
    const end = new Date(`${gt.latestDate}T00:00:00Z`);
    const start = new Date(end); start.setUTCDate(end.getUTCDate() - 6);
    return dd >= start && dd <= end;
  }).map(row => ({ date: iso(row.d), weekday: row.wd, revenue: r2(row.rev) }));
  gt.last7 = last7;
  gt.bestDay = last7.slice().sort((a, b) => b.revenue - a.revenue)[0] || null;
  gt.worstDay = last7.slice().sort((a, b) => a.revenue - b.revenue)[0] || null;

  // today's totals
  const today = (await q(`SELECT COUNT(*) n, ROUND(SUM(total_amount::numeric),2) rev FROM sales WHERE client_id=$1 AND location_id=$2 AND sale_date::date=$3`, [...P, gt.latestDate])).rows[0];
  gt.todaySales = parseInt(today.n, 10); gt.todayRevenue = r2(today.rev);

  // category breakdown for latest date (independent UPC join) -> {CAT: rev} + pct map
  const catRows = (await q(
    `SELECT COALESCE(NULLIF(TRIM(p.category),''),'UNMAPPED') cat, ROUND(SUM(si.total_amount::numeric),2) rev
       FROM sales s JOIN sale_items si ON s.sale_id=si.sale_id AND s.client_id=si.client_id AND s.location_id=si.location_id
       LEFT JOIN products p ON TRIM(p.upc)=TRIM(si.sku) AND p.client_id=si.client_id AND p.location_id=si.location_id
      WHERE s.client_id=$1 AND s.location_id=$2 AND s.sale_date::date=$3 AND ${ACTIVE}
      GROUP BY 1 ORDER BY rev DESC`, [...P, gt.latestDate])).rows;
  const catMap = {}; let catTotal = 0;
  for (const row of catRows) { catMap[row.cat] = r2(row.rev); catTotal += Number(row.rev); }
  gt.cat_today = catMap;
  gt.cat_today_pct = {}; for (const [k, v] of Object.entries(catMap)) gt.cat_today_pct[k] = r2((v / catTotal) * 100);
  gt.cat_today_topLabel = catRows[0]?.cat || null;
  gt.cat_today_date = gt.latestDate;

  // top product by revenue, last 30 days (line-item level)
  const topProd = (await q(
    `SELECT MAX(NULLIF(TRIM(product_name),'')) name, ROUND(SUM(total_amount::numeric),2) rev
       FROM sale_items WHERE client_id=$1 AND location_id=$2
        AND sale_date::date > (SELECT MAX(sale_date::date)-30 FROM sale_items WHERE client_id=$1 AND location_id=$2)
      GROUP BY sku ORDER BY rev DESC LIMIT 1`, P)).rows[0];
  gt.topProduct30d = topProd ? (topProd.name || '').trim() : null;

  // search recall counts
  gt.whiskeyUnder200 = parseInt((await q(
    `SELECT COUNT(*) n FROM products WHERE client_id=$1 AND location_id=$2 AND price<200 AND (product_name ~* $3 OR sub_category ~* $3 OR category ~* $3)`,
    [...P, WHISKEY_RE])).rows[0].n, 10);
  gt.scotchCount = parseInt((await q(
    `SELECT COUNT(*) n FROM products WHERE client_id=$1 AND location_id=$2 AND (product_name ~* $3 OR sub_category ~* $3 OR category ~* $3)`,
    [...P, SCOTCH_RE])).rows[0].n, 10);
  gt.bourbonInStock = parseInt((await q(
    `SELECT COUNT(*) n FROM products WHERE client_id=$1 AND location_id=$2 AND stock_qty>0 AND (product_name ~* '\\ybourbon\\y' OR sub_category ~* '\\ybourbon\\y' OR category ~* '\\ybourbon\\y')`,
    P)).rows[0].n, 10);

  // inventory + entity counts (for simple factual checks)
  const inv = (await q(
    `SELECT (SELECT COUNT(*) FROM products WHERE client_id=$1 AND location_id=$2) products,
            (SELECT COUNT(*) FROM products WHERE client_id=$1 AND location_id=$2 AND stock_qty>0 AND stock_qty<5) low_stock,
            (SELECT COUNT(*) FROM products WHERE client_id=$1 AND location_id=$2 AND stock_qty=0) oos,
            (SELECT COUNT(*) FROM products WHERE client_id=$1 AND location_id=$2 AND stock_qty<0) negative_stock,
            (SELECT COUNT(DISTINCT NULLIF(TRIM(category),'')) FROM products WHERE client_id=$1 AND location_id=$2) categories,
            (SELECT COUNT(*) FROM customers WHERE client_id=$1 AND location_id=$2) customers,
            (SELECT COUNT(*) FROM suppliers WHERE client_id=$1 AND location_id=$2) suppliers,
            (SELECT COUNT(*) FROM sales WHERE client_id=$1 AND location_id=$2) sales`, P)).rows[0];
  gt.counts = {
    products: +inv.products, lowStock: +inv.low_stock, oos: +inv.oos,
    negativeStock: +inv.negative_stock, categories: +inv.categories,
    customers: +inv.customers, suppliers: +inv.suppliers, sales: +inv.sales,
  };

  // field availability (for honest-decline correctness)
  const fa = (await q(
    `SELECT COUNT(NULLIF(TRIM(cashier),'')) cashier, COUNT(NULLIF(TRIM(register),'')) register,
            COUNT(NULLIF(TRIM(pay_mode),'')) pay_mode, COUNT(NULLIF(TRIM(customer_id),'')) customer_id
       FROM sales WHERE client_id=$1 AND location_id=$2`, P)).rows[0];
  const pc = (await q(
    `SELECT COUNT(*) FILTER (WHERE cost IS NOT NULL AND cost>0) cost,
            COUNT(*) FILTER (WHERE sale_price IS NOT NULL AND sale_price>0 AND sale_price<price) on_sale
       FROM products WHERE client_id=$1 AND location_id=$2`, P)).rows[0];
  const custEmail = (await q(`SELECT COUNT(NULLIF(TRIM(contact_email),'')) e, COUNT(*) t FROM customers WHERE client_id=$1 AND location_id=$2`, P)).rows[0];
  gt.availability = {
    cashier: +fa.cashier, register: +fa.register, pay_mode: +fa.pay_mode, customer_id_on_sales: +fa.customer_id,
    cost: +pc.cost, on_sale: +pc.on_sale, customers_with_email: +custEmail.e, customers_total: +custEmail.t,
  };

  if (!pool) await ownPool.end();
  return gt;
}

async function cli() {
  const out = process.argv[2] || path.join(__dirname, '..', 'eval-results', 'ground-truth.json');
  const gt = await build({});
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(gt, null, 2));
  console.log(`Ground truth written to ${out}`);
  console.log(JSON.stringify({
    latestDate: gt.latestDate, todaySales: gt.todaySales, todayRevenue: gt.todayRevenue,
    bestDay: gt.bestDay, topProduct30d: gt.topProduct30d, whiskeyUnder200: gt.whiskeyUnder200,
    counts: gt.counts, availability: gt.availability,
  }, null, 2));
}

module.exports = { build };
if (require.main === module) cli().catch(e => { console.error(e); process.exit(1); });
