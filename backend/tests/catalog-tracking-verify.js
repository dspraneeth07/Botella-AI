/**
 * Catalog tracking verification - exercises services/catalogTrackingService.js
 * against the real analytics DB using a sentinel tenant, then cleans up.
 *
 * PREREQ: database/analytics-migrations/001_product_first_seen.sql applied.
 * Run:  ANALYTICS_PG_HOST=localhost node tests/catalog-tracking-verify.js
 * (host override needed outside docker; .env points at host.docker.internal)
 *
 * Covers: baseline seeding (nothing "new" on first sight), detection of an
 * added SKU with its UPC, idempotent re-runs, the add+remove-same-pass case
 * (caught immediately - the always-diff design has no count blind spot), and
 * the cross-tenant getRecentNewProducts seed used by area winners.
 */
require('dotenv').config();

const { getAnalyticsPool } = require('../database/analytics-connection');
const svc = require('../services/catalogTrackingService');

// Sentinel tenant far outside real client ids; safe to insert + delete.
const CID = 999901;
const LID = 990001;

const prod = (sku, upc = null) => ({ sku, upc });

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
}

async function cleanup(pool) {
  await pool.query(
    'DELETE FROM product_first_seen WHERE client_id = $1 AND location_id = $2', [CID, LID]
  );
}

(async () => {
  const pool = getAnalyticsPool();
  try {
    await cleanup(pool); // in case a previous run died mid-way

    // 1. First sight: whole catalog is baseline, nothing is "new".
    let map = await svc.syncCatalog(pool, CID, LID, [prod('A', '111'), prod('B'), prod('C', '333')]);
    check('first run seeds baseline, reports nothing new', Object.keys(map).length === 0,
      `got ${JSON.stringify(Object.keys(map))}`);

    // 2. Same set again: idempotent, still nothing new.
    map = await svc.syncCatalog(pool, CID, LID, [prod('A', '111'), prod('B'), prod('C', '333')]);
    check('unchanged catalog reports nothing new', Object.keys(map).length === 0);

    // 3. A SKU appears: detected as new, upc recorded, first_seen fresh.
    map = await svc.syncCatalog(pool, CID, LID, [prod('A', '111'), prod('B'), prod('C', '333'), prod('D', '444')]);
    check('added SKU is detected', Object.keys(map).join(',') === 'D',
      `got ${JSON.stringify(Object.keys(map))}`);
    const ageMs = map.D ? Date.now() - new Date(map.D).getTime() : Infinity;
    check('first_seen_at is fresh', ageMs < 60_000, `age ${ageMs}ms`);
    const upcRow = await pool.query(
      'SELECT upc, is_baseline FROM product_first_seen WHERE client_id=$1 AND location_id=$2 AND sku=$3',
      [CID, LID, 'D']
    );
    check('upc stored with the new SKU', upcRow.rows[0]?.upc === '444' && upcRow.rows[0]?.is_baseline === false);

    // 4. Re-run same set: D still reported (inside the 90d window), no dupes.
    map = await svc.syncCatalog(pool, CID, LID, [prod('A', '111'), prod('B'), prod('C', '333'), prod('D', '444')]);
    check('re-run still reports the recent addition once', Object.keys(map).join(',') === 'D');

    // 5. E added while A disappears in the same pass - the always-diff design
    //    catches it immediately (no count short-circuit, no blind spot).
    map = await svc.syncCatalog(pool, CID, LID, [prod('B'), prod('C', '333'), prod('D', '444'), prod('E', '555')]);
    const found = Object.keys(map).sort().join(',');
    check('add+remove in one pass is still detected', found === 'D,E', `got ${found}`);

    // 6. Baseline rows never resurface as new.
    const baseline = await pool.query(
      `SELECT count(*)::int AS n FROM product_first_seen
        WHERE client_id=$1 AND location_id=$2 AND is_baseline`,
      [CID, LID]
    );
    check('baseline rows kept flagged', baseline.rows[0].n === 3);

    // 7. Cross-tenant seed for area winners: non-baseline rows WITH a upc only.
    const recent = await svc.getRecentNewProducts(pool, 30);
    const mine = recent.filter((r) => r.client_id === CID && r.location_id === LID);
    const skus = mine.map((r) => r.sku).sort().join(',');
    check('getRecentNewProducts returns upc-bearing non-baseline rows', skus === 'D,E',
      `got ${skus}`);
  } finally {
    try { await cleanup(pool); } catch (e) { console.warn('cleanup failed:', e.message); }
    await pool.end();
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('verification crashed:', err);
  process.exit(1);
});
