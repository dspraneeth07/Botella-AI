#!/usr/bin/env node
/**
 * verify-metric-sql.js
 * ---------------------------------------------------------------------------
 * Answers one question: does the query behind each ⛁ icon actually reproduce
 * the figure the icon sits next to?
 *
 *     node backend/scripts/verify-metric-sql.js            # client 171
 *     node backend/scripts/verify-metric-sql.js 204 204    # any client/location
 *
 * WHAT THIS DOES AND DOES NOT CHECK
 *
 * It does NOT check the queries themselves. Those are generated from
 * `sql_checks/` in the Python service (botella_external_apis), where they were
 * row-reproduced against live StoreAgent output figure by figure. That repo
 * ships its own verifier:
 *
 *     python sql_checks/verify_tables.py     # prints ALL EXACT TABLES MATCH
 *     python sql_checks/verify_all.py
 *
 * What this checks is the MAPPING - that the key attached to a given tile is
 * the query for THAT tile and not a neighbouring one. That is the part written
 * by hand in the React screens, and the part nothing else looks at. It already
 * caught one: "Sales, latest day" had been pointed at overview.revenue_30d, a
 * thirty-day total sitting behind a one-day number.
 *
 * READING THE RESULT
 *
 * /api/storeagent/* is a PROXY WITH A CACHE. When the Python service is
 * unreachable the API serves the last computed result, which can be days old,
 * while this script queries the warehouse as it is right now. Comparing those
 * two is meaningless, so the script reads the cache timestamp first and marks
 * anything stale INCONCLUSIVE rather than MISMATCH. A run against a cold cache
 * that reports every figure INCONCLUSIVE has told you nothing except that the
 * recommendation service needs starting.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
require(path.join(ROOT, 'backend', 'node_modules', 'dotenv'))
  .config({ path: path.join(ROOT, 'backend', '.env') });
const { Pool } = require(path.join(ROOT, 'backend', 'node_modules', 'pg'));

const CID = parseInt(process.argv[2] || '171', 10);
const LID = parseInt(process.argv[3] || String(CID), 10);
const API = process.env.VERIFY_API_BASE || 'http://127.0.0.1:3000';
// How old the cached StoreAgent result may be before a comparison against
// today's warehouse stops meaning anything.
const STALE_HOURS = parseFloat(process.env.VERIFY_STALE_HOURS || '6');

/* ── The mapping under test ───────────────────────────────────────────────── */
/* Keep this in step with the sqlKey props in the screens. */
const CASES = [
  { screen: 'Purchasing', label: 'Order needed to cover demand', key: 'buying.buy_total_value', cap: 'buying' },
  { screen: 'Purchasing', label: 'Daily lost sales (est.)', key: 'buying.ongoing_daily_loss', cap: 'buying' },
  { screen: 'Purchasing', label: 'Capital in dead stock', key: 'buying.dont_buy_capital_tied', cap: 'buying' },
  { screen: 'Recommendations', label: 'Gross margin', key: 'overview.gross_margin_pct', cap: 'overview' },
  { screen: 'Recommendations', label: 'Fast movers out of stock', key: 'buying.stockout_sku_count', cap: 'buying' },
  { screen: 'Recommendations', label: 'Capital in dead stock', key: 'buying.dont_buy_capital_tied', cap: 'buying' },
  { screen: 'Customers', label: 'Visit pattern broken', key: 'customers.at_risk_count', cap: 'customers' },
  { screen: 'Customers', label: 'Projected annual revenue at risk', key: 'customers.annual_revenue_at_risk', cap: 'customers' },
];

const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const pad = (s, n) => { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); };
const fmt = (n) => (Math.abs(n) >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(Math.round(n * 100) / 100));

/* Find a key anywhere in a payload, so a wrapper object is not a mismatch. */
function deepFind(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const k of Object.keys(obj)) {
    const v = deepFind(obj[k], key, depth + 1);
    if (v !== undefined) return v;
  }
  return undefined;
}

function loadCheckSql() {
  const src = path.join(ROOT, 'frontend', 'src', 'storeagent', 'checkSql.data.js');
  const tmp = path.join(require('os').tmpdir(), 'checkSql.probe.cjs');
  fs.writeFileSync(tmp, fs.readFileSync(src, 'utf8')
    .replace('export const CHECK_SQL =', 'module.exports.CHECK_SQL ='));
  const mod = require(tmp);
  fs.unlinkSync(tmp);
  return mod.CHECK_SQL;
}

(async () => {
  const CHECK_SQL = loadCheckSql();

  const warehouse = new Pool({
    host: process.env.PG_HOST, port: process.env.PG_PORT, database: process.env.PG_DATABASE,
    user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    ssl: { rejectUnauthorized: false }, max: 3,
  });
  const analytics = new Pool({
    host: process.env.ANALYTICS_PG_HOST, port: process.env.ANALYTICS_PG_PORT,
    database: process.env.ANALYTICS_PG_DATABASE, user: process.env.ANALYTICS_PG_USER,
    password: process.env.ANALYTICS_PG_PASSWORD, max: 3,
  });

  /* How old is each cached capability? This decides whether a comparison is
     worth making at all. */
  const age = {};
  try {
    const r = await analytics.query(
      'SELECT capability, EXTRACT(EPOCH FROM (now() - computed_at)) / 3600 AS hours '
      + 'FROM storeagent_capability_results WHERE client_id=$1', [CID]);
    for (const row of r.rows) age[row.capability] = parseFloat(row.hours);
  } catch (e) {
    console.log('! could not read the StoreAgent cache: ' + e.message.split('\n')[0]);
  }

  console.log('\nclient ' + CID + ' / location ' + LID + '   api ' + API);
  console.log('cached StoreAgent results:');
  const caps = Array.from(new Set(CASES.map(c => c.cap)));
  for (const cap of caps) {
    const h = age[cap];
    console.log('  ' + pad(cap, 12) + (h === undefined ? 'never computed'
      : h.toFixed(1) + 'h old' + (h > STALE_HOURS ? '   << STALE: comparisons below are inconclusive' : '')));
  }
  console.log('');

  const token = process.env.VERIFY_TOKEN
    || (fs.existsSync(path.join(__dirname, '.token')) ? fs.readFileSync(path.join(__dirname, '.token'), 'utf8').trim() : null);
  if (!token) {
    console.log('Set VERIFY_TOKEN to a JWT for this store, or drop one in backend/scripts/.token');
    process.exit(2);
  }

  const cache = new Map();
  const rows = [];

  for (const c of CASES) {
    const sql = CHECK_SQL[c.key];
    if (!sql) { rows.push({ ...c, verdict: 'NO QUERY', detail: c.key + ' is not in checkSql.data.js' }); continue; }

    let dbVal = null, err = null;
    try {
      const r = await warehouse.query(sql.split('%(cid)s').join(String(CID)));
      const first = r.rows[0] || {};
      const cols = Object.keys(first);
      const want = c.key.split('.')[1];
      dbVal = num(cols.includes(want) ? first[want] : first[cols[0]]);
    } catch (e) { err = 'query: ' + e.message.split('\n')[0]; }

    let apiVal = null;
    if (!err) {
      try {
        const p = '/api/storeagent/' + c.cap;
        if (!cache.has(p)) {
          const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + token } });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          cache.set(p, await r.json());
        }
        apiVal = num(deepFind(cache.get(p), c.key.split('.')[1]));
      } catch (e) { err = 'api: ' + e.message; }
    }

    let verdict, detail;
    const stale = age[c.cap] === undefined || age[c.cap] > STALE_HOURS;
    if (err) { verdict = 'ERROR'; detail = err; }
    else if (dbVal === null || apiVal === null) { verdict = 'NO VALUE'; detail = 'db=' + dbVal + ' api=' + apiVal; }
    else {
      const drift = Math.abs(dbVal - apiVal) / Math.max(Math.abs(dbVal), Math.abs(apiVal), 1);
      detail = 'db=' + fmt(dbVal) + '  api=' + fmt(apiVal) + '  drift=' + (drift * 100).toFixed(1) + '%';
      if (drift < 0.01) verdict = 'MATCH';
      else if (stale) verdict = 'INCONCLUSIVE';
      else verdict = 'MISMATCH';
    }
    rows.push({ ...c, verdict, detail });
    console.log('  ' + pad(verdict, 14) + pad(c.screen + ' / ' + c.label, 46) + detail);
  }

  const n = (v) => rows.filter(r => r.verdict === v).length;
  console.log('\n  ' + n('MATCH') + ' match, ' + n('MISMATCH') + ' mismatch, '
    + n('INCONCLUSIVE') + ' inconclusive (stale cache), ' + n('ERROR') + ' error, ' + n('NO VALUE') + ' no value');
  if (n('INCONCLUSIVE')) {
    console.log('\n  Inconclusive means the API served a cached result older than '
      + STALE_HOURS + 'h while the query ran against the warehouse as it is now.');
    console.log('  Start the Python recommendation service and re-run for a real answer.');
  }
  if (n('MISMATCH')) console.log('\n  A MISMATCH against a FRESH cache means the icon is on the wrong query. Fix the sqlKey.');

  await warehouse.end(); await analytics.end();
  process.exit(n('MISMATCH') ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
