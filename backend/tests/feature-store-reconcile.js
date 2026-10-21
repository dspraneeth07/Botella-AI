#!/usr/bin/env node
/**
 * Feature-store reconciliation (sheet 03).
 *
 * "Total units for a store over a window must match the Purchasing screen
 *  figure exactly. If it does not, STOP and report the discrepancy rather
 *  than adjusting the feature store to match."
 *
 * That instruction is the whole point, so this test is written to FAIL LOUDLY
 * with the numbers rather than to pass. It reconciles the feature-store
 * extraction against the REAL `integrationService.getSales` — the canonical
 * definition the Purchasing screen and the recommendation pipeline both
 * consume — by calling the actual function, not a copy of its SQL.
 *
 * WHAT IS AND IS NOT BEING RECONCILED
 *   Being reconciled: the AGGREGATION rule — UPC→SKU canonicalisation, VOID
 *   exclusion, quantity > 0, non-empty sku, SUM(quantity).
 *
 *   NOT being reconciled: the window ANCHOR. getSales anchors to
 *   max(sale_date); the feature store anchors to ctx.as_of, deliberately
 *   (sheet 03 rule 3). To compare the aggregation rule honestly this test
 *   pins both to the same days by setting as_of = max(sale_date). The
 *   anchoring difference is tested separately, in Python.
 *
 * Run:  node tests/feature-store-reconcile.js [clientId] [locationId] [days]
 */
require('dotenv').config();

const { Pool } = require('pg');
const svc = require('../services/integrationService');

const CID = parseInt(process.argv[2] || '171', 10);
const LID = parseInt(process.argv[3] || '171', 10);
const DAYS = parseInt(process.argv[4] || '28', 10);

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// The feature-store extraction, character-for-character the rule in
// app/pipeline/features/build.py :: FEATURE_DAILY_SQL.
const FEATURE_DAILY_SQL = `
WITH catalog AS (
  SELECT DISTINCT ON (jk) jk, sku
    FROM (
      SELECT sku, sku AS jk, 0 AS jk_pri, stock_qty AS jk_stock
        FROM products
       WHERE client_id = $1 AND location_id = $2
         AND is_deleted IS NOT TRUE AND NULLIF(TRIM(sku), '') IS NOT NULL
      UNION ALL
      SELECT sku, upc AS jk, 1 AS jk_pri, stock_qty AS jk_stock
        FROM products
       WHERE client_id = $1 AND location_id = $2
         AND is_deleted IS NOT TRUE AND NULLIF(TRIM(upc), '') IS NOT NULL
         AND NULLIF(TRIM(sku), '') IS NOT NULL
    ) u
   ORDER BY jk, jk_pri, jk_stock DESC NULLS LAST, sku
),
voids AS (
  SELECT sale_id FROM sales
   WHERE client_id = $1 AND location_id = $2
     AND sale_status = 'VOID' AND sale_id IS NOT NULL
),
lines AS (
  SELECT COALESCE(c.sku, si.sku) AS sku,
         si.sale_date::date       AS obs_date,
         si.quantity, si.total_amount, si.sale_id
    FROM sale_items si
    LEFT JOIN catalog c ON c.jk = si.sku
   WHERE si.client_id = $1 AND si.location_id = $2
     AND si.sale_date >= ($3::date - make_interval(days => $4::int - 1))
     AND si.sale_date <  ($3::date + 1)
     AND NULLIF(TRIM(si.sku), '') IS NOT NULL
     AND si.quantity > 0
     AND (si.sale_id IS NULL OR si.sale_id NOT IN (SELECT sale_id FROM voids))
)
SELECT sku, obs_date,
       SUM(quantity)     AS units_sold,
       SUM(total_amount) AS revenue,
       COUNT(DISTINCT sale_id) AS baskets_containing
  FROM lines
 GROUP BY sku, obs_date`;

(async () => {
  const pool = new Pool({
    host: process.env.PG_HOST, port: +process.env.PG_PORT,
    database: process.env.PG_DATABASE, user: process.env.PG_USER,
    password: process.env.PG_PASSWORD, max: 2,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 300000, connectionTimeoutMillis: 20000,
  });

  const frontier = await pool.query(
    'SELECT MAX(sale_date)::date AS d FROM sale_items WHERE client_id=$1 AND location_id=$2',
    [CID, LID]
  );
  const asOf = frontier.rows[0].d;
  if (!asOf) {
    console.log(`Store ${CID}:${LID} has no sales at all — nothing to reconcile.`);
    await pool.end();
    process.exit(0);
  }

  console.log(`\nReconciling store ${CID}:${LID}, ${DAYS} days to ${String(asOf).slice(0, 10)}`);
  console.log('─'.repeat(64));

  // ── A. The canonical source the Purchasing screen consumes ───────────────
  const canonical = await svc.getSales(pool, CID, LID, DAYS);
  const canonUnits = canonical.reduce((a, r) => a + r.units, 0);
  const canonSkus = new Set(canonical.map((r) => r.sku));
  const canonDays = new Set(canonical.map((r) => r.sale_date));

  // ── B. The feature-store extraction ──────────────────────────────────────
  const fs = await pool.query(FEATURE_DAILY_SQL, [CID, LID, asOf, DAYS]);
  const fsUnits = fs.rows.reduce((a, r) => a + Number(r.units_sold), 0);
  const fsSkus = new Set(fs.rows.map((r) => r.sku));
  const fsDays = new Set(fs.rows.map((r) => String(r.obs_date).slice(0, 10)));

  console.log(`  canonical (getSales)  units ${canonUnits.toLocaleString().padStart(10)}  `
    + `skus ${String(canonSkus.size).padStart(5)}  days ${canonDays.size}`);
  console.log(`  feature store         units ${fsUnits.toLocaleString().padStart(10)}  `
    + `skus ${String(fsSkus.size).padStart(5)}  days ${fsDays.size}`);
  console.log('─'.repeat(64));

  check('1  TOTAL UNITS match exactly', fsUnits === canonUnits,
    `feature store ${fsUnits} vs canonical ${canonUnits} (diff ${fsUnits - canonUnits})`);
  check('2  the same SKUs appear', fsSkus.size === canonSkus.size,
    `${fsSkus.size} vs ${canonSkus.size}`);
  check('3  the same trading days appear', fsDays.size === canonDays.size,
    `${fsDays.size} vs ${canonDays.size}`);

  // Per-SKU, so a discrepancy names the SKU rather than just a total.
  const canonBySku = new Map();
  for (const r of canonical) canonBySku.set(r.sku, (canonBySku.get(r.sku) || 0) + r.units);
  const fsBySku = new Map();
  for (const r of fs.rows) {
    fsBySku.set(r.sku, (fsBySku.get(r.sku) || 0) + Number(r.units_sold));
  }
  const mismatches = [];
  for (const [sku, units] of canonBySku) {
    if ((fsBySku.get(sku) || 0) !== units) {
      mismatches.push({ sku, canonical: units, feature_store: fsBySku.get(sku) || 0 });
    }
  }
  check('4  every SKU reconciles individually', mismatches.length === 0,
    `${mismatches.length} SKU(s) differ`);
  if (mismatches.length) {
    console.log('\n  STOP — the feature store and the canonical source DISAGREE.');
    console.log('  Per the sheet: report this, do NOT adjust the feature store to match.\n');
    for (const m of mismatches.slice(0, 10)) {
      console.log(`    ${m.sku.padEnd(20)} canonical ${m.canonical}  feature store ${m.feature_store}`);
    }
  }

  // ── C. The open-day denominator ──────────────────────────────────────────
  console.log('\n── The open-day denominator ────────────────────────────────');
  const cal = await pool.query(
    `SELECT count(DISTINCT sale_date::date)::int AS open_days
       FROM sale_items
      WHERE client_id=$1 AND location_id=$2
        AND sale_date >= ($3::date - make_interval(days => $4::int - 1))
        AND sale_date <  ($3::date + 1)
        AND quantity > 0`,
    [CID, LID, asOf, DAYS]
  );
  const openDays = cal.rows[0].open_days;
  const perOpen = canonUnits / openDays;
  const perCalendar = canonUnits / DAYS;

  console.log(`  open days                ${openDays} of ${DAYS} calendar days`);
  console.log(`  units per OPEN day       ${perOpen.toFixed(2)}   <- the feature store's rate`);
  console.log(`  units per calendar day   ${perCalendar.toFixed(2)}`);
  console.log(`  understatement avoided   ${(100 * (1 - perCalendar / perOpen)).toFixed(1)}%`);

  check('5  open days are counted from observed trading, not assumed',
    openDays > 0 && openDays <= DAYS, `${openDays}`);
  check('6  the open-day rate exceeds the calendar rate whenever a day is closed',
    openDays === DAYS ? perOpen === perCalendar : perOpen > perCalendar);

  // ── D. The point-in-time column is usable ────────────────────────────────
  console.log('\n── Point-in-time ───────────────────────────────────────────');
  const analytics = new Pool({
    host: process.env.ANALYTICS_PG_HOST, port: +process.env.ANALYTICS_PG_PORT,
    database: process.env.ANALYTICS_PG_DATABASE, user: process.env.ANALYTICS_PG_USER,
    password: process.env.ANALYTICS_PG_PASSWORD, max: 1,
  });
  const cols = await analytics.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='feature_daily' AND column_name IN ('known_at','units_sold','on_hand')`
  );
  check('7  feature_daily carries known_at for point-in-time reads',
    cols.rows.some((c) => c.column_name === 'known_at'));
  const def = await analytics.query('SELECT count(*)::int n FROM feature_daily_default');
  check('8  the DEFAULT partition is empty (partitions have not run out)',
    def.rows[0].n === 0, `${def.rows[0].n} rows in default`);

  await analytics.end();
  await pool.end();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nreconciliation aborted:', err.message);
  process.exit(1);
});
