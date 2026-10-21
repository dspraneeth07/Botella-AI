#!/usr/bin/env node
/**
 * The purchase day a reader asks the warehouse for.
 *
 * WHAT THIS PINS. At every LiquorPOS store `purchases.date` is '-infinity' on
 * every row and `invoice_date` carries the real day (the SyncGo extraction
 * aliases ORD_IN.DATE as `PurchaseDate`, a name the uploader does not bind -
 * services/purchaseDateSql.js has the mechanism and the numbers). A reader
 * that filters, groups or orders on bare `date` reads Tuscany's 7,646-row
 * feed as empty, which is the one thing an empty result must never mean
 * here: "no order for this SKU" is action evidence.
 *
 *   1  the shared fragment has the shape every reader and both test mocks
 *      (fulfilment-verify, rec-eval-verify) recognise: COALESCE of the two
 *      NULLIF'd columns, a 1990 floor, an alias prefix when asked
 *   2  the sentinel through a mocked pool: a row whose `date` is -infinity
 *      and whose invoice_date is inside the window is RETURNED by the SQL
 *      the services build, and LOST by the SQL they used to build - the
 *      mock applies the fragment's semantics to each query text, so a
 *      regression to bare `date` fails here without a warehouse
 *   3  no Node reader of `FROM purchases` still filters, groups or orders on
 *      bare `date` (source scan over services/, routes/, scripts/)
 *
 * No database. Run: node tests/purchase-date-verify.js
 */
const fs = require('fs');
const path = require('path');
const { purchaseDaySql, purchaseDaySaneSql, PURCHASE_DAY_FLOOR } = require('../services/purchaseDateSql');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
}

// ── 1  the fragment ─────────────────────────────────────────────────────────
const DAY = "COALESCE(NULLIF(date, '-infinity'), NULLIF(invoice_date, '-infinity'))";
check('1a the day expression is the two-column COALESCE with both sentinels removed', purchaseDaySql() === DAY, purchaseDaySql());
check('1b the sanity predicate bounds it at the floor', purchaseDaySaneSql() === `${DAY} >= DATE '1990-01-01'` && PURCHASE_DAY_FLOOR === '1990-01-01');
check('1c an alias prefixes both columns', purchaseDaySql('p') === "COALESCE(NULLIF(p.date, '-infinity'), NULLIF(p.invoice_date, '-infinity'))");

// ── 2  the sentinel through a mocked pool ───────────────────────────────────
//
// The mock is a tiny model of Postgres on the one point under test. A row's
// day is `date` when that is a real timestamp; when it is the sentinel, the
// row has a day ONLY if the query text asks for the fallback expression. The
// floor predicate drops rows with no real day on either column. Everything
// else (tenant scoping, the SKU list, the lower bound) is applied literally.
const SENTINEL = '-infinity';
const ROWS = [
  { sku: 'A', date: '2026-10-10', invoice_date: '2026-10-10', quantity: 6, purchase_id: 'P1' },   // a normal connector
  { sku: 'B', date: SENTINEL, invoice_date: '2026-10-12', quantity: 9, purchase_id: 'P2' },       // LiquorPOS
  { sku: 'C', date: SENTINEL, invoice_date: SENTINEL, quantity: 3, purchase_id: 'P3' },           // no day at all
  { sku: 'D', date: SENTINEL, invoice_date: '1899-12-30', quantity: 2, purchase_id: 'P4' },       // a VFP empty date
];
function mockPool(sql, params) {
  const [, , skus, since] = params;
  const usesFallback = sql.includes(DAY);
  const hasFloor = sql.includes(`>= DATE '${PURCHASE_DAY_FLOOR}'`);
  const dayOf = (r) => {
    if (r.date !== SENTINEL) return r.date;
    if (!usesFallback) return null;                 // bare `date` reads -infinity: before any bound
    return r.invoice_date !== SENTINEL ? r.invoice_date : null;
  };
  return ROWS
    .map((r) => ({ ...r, day: dayOf(r) }))
    .filter((r) => skus.includes(r.sku))
    .filter((r) => (hasFloor ? r.day != null && r.day >= PURCHASE_DAY_FLOOR : true))
    .filter((r) => r.day != null && r.day >= since)
    .map((r) => ({ sku: r.sku, day: r.day, units: r.quantity, purchase_ids: [r.purchase_id] }));
}
const evaluatorSql = `SELECT sku, to_char(${purchaseDaySql()}::date, 'YYYY-MM-DD') AS day, SUM(quantity)::int AS units
           FROM purchases
          WHERE client_id = $1 AND location_id = $2 AND sku = ANY($3)
            AND ${purchaseDaySaneSql()}
            AND ${purchaseDaySql()} >= $4::date
          GROUP BY sku, ${purchaseDaySql()}::date`;
const legacySql = `SELECT sku, to_char(date::date, 'YYYY-MM-DD') AS day, SUM(quantity)::int AS units
           FROM purchases
          WHERE client_id = $1 AND location_id = $2 AND sku = ANY($3) AND date >= $4::date
          GROUP BY sku, date::date`;
const params = [173, 173, ['A', 'B', 'C', 'D'], '2026-10-01'];
const now = mockPool(evaluatorSql, params);
const before = mockPool(legacySql, params);
check('2a the LiquorPOS row (date -infinity, invoice_date in window) is returned by the new SQL',
  now.some((r) => r.sku === 'B' && r.day === '2026-10-12' && r.units === 9), JSON.stringify(now));
check('2b ...and was lost by the old SQL, which is the defect', !before.some((r) => r.sku === 'B'), JSON.stringify(before));
check('2c a row with a sentinel in BOTH columns is dropped, not dated', !now.some((r) => r.sku === 'C'));
check('2d a VFP empty date (1899-12-30) in invoice_date falls under the floor', !now.some((r) => r.sku === 'D'));
check('2e a normal connector\'s row reads the same under both', now.some((r) => r.sku === 'A') && before.some((r) => r.sku === 'A'));

// ── 3  no reader still filters on bare `date` ───────────────────────────────
//
// Every Node file that selects FROM purchases. The scan strips the fragment
// first, then looks for the forms a date filter/group/order takes on the
// table's own column. `sale_date` and `invoice_date` are not matches.
const roots = ['services', 'routes', 'scripts'].map((d) => path.join(__dirname, '..', d));
const files = [];
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  for (const f of fs.readdirSync(root)) if (f.endsWith('.js')) files.push(path.join(root, f));
}
const offenders = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  if (!/FROM purchases\b/.test(src)) continue;
  const stripped = src.split(DAY).join('<DAY>').split('${purchaseDaySql()}').join('<DAY>').split('${purchaseDaySaneSql()}').join('<SANE>');
  // Only the purchases queries: the template literal(s) containing FROM purchases.
  const literals = stripped.match(/`[^`]*FROM purchases\b[^`]*`/g) || [];
  for (const lit of literals) {
    // The lookbehind also excludes `::date` casts (of the fragment, of a
    // bind parameter), which are not reads of the column.
    const bare = lit.match(/(?<![\w.$:])date(?:::date| >=| >| <| IS NOT NULL| DESC| ASC)/g);
    if (bare) offenders.push(`${path.relative(path.join(__dirname, '..'), f)}: ${bare.join(', ')}`);
  }
}
check('3  no Node purchases reader filters, groups or orders on bare `date`', offenders.length === 0, offenders.join(' | '));
check('3b the scan saw the two services that read the feed',
  files.some((f) => /recommendationEvalService/.test(f)) && files.some((f) => /poEffectivenessService/.test(f)));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
