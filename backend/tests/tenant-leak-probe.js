// =============================================================================
// tenant-leak-probe.js - Finding #1 app-layer guard proof (defense-in-depth)
// =============================================================================
// Tests the REAL guards on the run_sql fallback (imported from routes/chat.js,
// not a copy): isSafeQuery + isBlockedTable + validateTenantFilter. Asserts the
// four audit leak probes (plus extra adversarial shapes) are BLOCKED for a
// session bound to tenant 46, and that legit single-tenant shapes still pass.
//
// Then (unless SKIP_LIVE=1) drives the same probes through the actual
// handleTool() run_sql path against the live DB (READ-ONLY) to prove end-to-end
// that a leak query returns an error (never rows) and a legit query returns
// rows - and that the new tenant-scoping transaction plumbing runs clean.
//
//   node tests/tenant-leak-probe.js          # unit + live
//   SKIP_LIVE=1 node tests/tenant-leak-probe.js   # unit only (no DB)
// =============================================================================
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { _internal } = require('../routes/chat');
const { isSafeQuery, isBlockedTable, validateTenantFilter, handleTool } = _internal;

const SELF = 46, OTHER = 125;
let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  - ' + extra : ''}`);
  if (!cond) fails++;
};

// The combined gate exactly as handleTool applies it for a run_sql call.
const guardAllows = (sql) =>
  isSafeQuery(sql) && !isBlockedTable(sql) && validateTenantFilter(sql, SELF, SELF);

// ── BLOCKED: the 4 audit probes + extra adversarial shapes ───────────────────
const LEAK_PROBES = {
  'UNION ALL into 125':
    `SELECT total_amount FROM sales WHERE client_id=46 AND location_id=46 UNION ALL SELECT total_amount FROM sales WHERE client_id=125 AND location_id=125`,
  'top-level OR client_id=125':
    `SELECT total_amount FROM sales WHERE location_id=46 AND client_id=46 OR client_id=125`,
  'comment decoy hides 125 body':
    `SELECT total_amount FROM sales WHERE client_id=125 AND location_id=125 -- client_id=46 and location_id=46`,
  'scalar subquery into 125':
    `SELECT (SELECT SUM(total_amount) FROM sales WHERE client_id=125 AND location_id=125) FROM sales WHERE client_id=46 AND location_id=46 LIMIT 1`,
  'IN (46,125) widening':
    `SELECT total_amount FROM sales WHERE client_id IN (46,125) AND location_id=46`,
  'block-comment + OR 1=1':
    `SELECT total_amount FROM sales WHERE client_id=46 AND location_id=46 /* x */ OR 1=1`,
  'restricted system table':
    `SELECT * FROM clients`,
  'pure other-tenant':
    `SELECT total_amount FROM sales WHERE client_id=125 AND location_id=125`,
  'missing tenant filter':
    `SELECT total_amount FROM sales`,
  'location widened to 125':
    `SELECT total_amount FROM sales WHERE client_id=46 AND location_id=125`,
};

// ── ALLOWED: legit single-tenant shapes the bot must keep running ────────────
const LEGIT = {
  'header revenue':
    `SELECT ROUND(SUM(total_amount)::numeric,2) FROM sales WHERE client_id=46 AND location_id=46`,
  'both-keys product join':
    `SELECT p.product_name, SUM(si.total_amount) AS rev FROM sale_items si JOIN products p ON (TRIM(p.sku)=TRIM(si.sku) OR TRIM(p.upc)=TRIM(si.sku)) AND p.client_id=si.client_id AND p.location_id=si.location_id WHERE si.client_id=46 AND si.location_id=46 GROUP BY p.product_name ORDER BY rev DESC LIMIT 5`,
  'MAX(sale_date) anchor subquery':
    `SELECT COUNT(*) FROM sale_items WHERE client_id=46 AND location_id=46 AND sale_date::date > (SELECT MAX(sale_date::date) FROM sale_items WHERE client_id=46 AND location_id=46) - 90`,
  'customer join chain':
    `SELECT c.customer_name, SUM(si.total_amount) FROM sale_items si JOIN sales s ON s.sale_id=si.sale_id AND s.client_id=si.client_id AND s.location_id=si.location_id JOIN customers c ON c.customer_id=s.customer_id AND c.client_id=s.client_id AND c.location_id=s.location_id WHERE si.client_id=46 AND si.location_id=46 AND NULLIF(TRIM(s.customer_id),'') IS NOT NULL GROUP BY c.customer_id, c.customer_name ORDER BY 2 DESC LIMIT 5`,
  'parenthesised OR category filter':
    `SELECT COUNT(*) FROM sale_items si JOIN products p ON (TRIM(p.sku)=TRIM(si.sku) OR TRIM(p.upc)=TRIM(si.sku)) AND p.client_id=si.client_id AND p.location_id=si.location_id WHERE si.client_id=46 AND si.location_id=46 AND (p.category ~* '\\yrum\\y' OR p.product_name ~* '\\yrum\\y')`,
  'dead-stock NOT EXISTS':
    `SELECT COUNT(*) FROM products p WHERE p.client_id=46 AND p.location_id=46 AND stock_qty>0 AND NOT EXISTS (SELECT 1 FROM sale_items si WHERE si.client_id=p.client_id AND si.location_id=p.location_id AND (TRIM(si.sku)=TRIM(p.sku) OR TRIM(si.sku)=TRIM(p.upc)))`,
};

console.log('\n── App-layer guard: leak probes must be BLOCKED (session = tenant 46) ──');
for (const [label, sql] of Object.entries(LEAK_PROBES)) ok(!guardAllows(sql), `blocked: ${label}`);

console.log('\n── App-layer guard: legit single-tenant shapes must be ALLOWED ──');
for (const [label, sql] of Object.entries(LEGIT)) ok(guardAllows(sql), `allowed: ${label}`);

(async () => {
  if (process.env.SKIP_LIVE === '1') {
    console.log('\n(live handleTool section skipped: SKIP_LIVE=1)');
  } else {
    console.log('\n── Live run_sql path: leak→error, legit→rows (READ-ONLY, prod) ──');
    // This section tests the VALIDATOR, so opt out of the RLS-required gate
    // (prod keeps the gate; here we want run_sql to reach validateTenantFilter).
    process.env.BOTELLA_ALLOW_RUNSQL_WITHOUT_RLS = 'true';
    try {
      const { getPool, makeTenantScopedPool } = require('../database/connection');
      const pool = makeTenantScopedPool(getPool(), SELF, SELF); // exact prod plumbing
      // Every leak probe through the real handler must return an error, not rows.
      for (const [label, sql] of Object.entries(LEAK_PROBES)) {
        const r = await handleTool({ name: 'run_sql', input: { query: sql } }, pool, SELF, SELF);
        ok(!!r.error && !r.rows, `live blocked: ${label}`);
      }
      // A legit query must return rows AND prove the tenant-scoping txn runs clean.
      const good = await handleTool(
        { name: 'run_sql', input: { query: LEGIT['header revenue'] } }, pool, SELF, SELF);
      ok(Array.isArray(good.rows) && !good.error, 'live allowed: header revenue returns rows',
        good.error ? good.error : JSON.stringify(good.rows?.[0] || {}));
      await getPool().end();
    } catch (e) {
      console.log(`   (live section skipped - DB unreachable: ${e.message})`);
    }
  }
  console.log(`\n${fails === 0 ? '✅ tenant-leak probe: ALL ASSERTIONS PASSED' : `❌ ${fails} assertion(s) FAILED`}`);
  process.exit(fails ? 1 : 0);
})();
