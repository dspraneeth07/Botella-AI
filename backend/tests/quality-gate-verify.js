#!/usr/bin/env node
/**
 * Checklist 13 - the quality gates are wired, and a stalled feed refuses.
 *
 * `store_quality_state` had no writer and `gates.py` had no caller, so every
 * store read as `unknown` and was admitted. This exercises the writer end to
 * end against the local analytics DB: three sentinel stores seeded into
 * `sync_store_state`, evaluated through `scripts/run-quality.js` (which shells
 * out to `quality_eval.py`), persisted, and then read back the way the serving
 * path reads them.
 *
 * The sync HISTORY (the trailing quarter of successful syncs the cadence comes
 * from) lives in syncgo, which this test does not depend on - it is injected
 * the way the script lets a caller inject it, so the test proves the gate and
 * the persistence rather than the network.
 *
 * PREREQ: analytics migrations 016 + 017.
 * Run:  node tests/quality-gate-verify.js
 */
require('dotenv').config();

const { getAnalyticsPool } = require('../database/analytics-connection');
const gate = require('../services/recommendationGateService');
const quality = require('../scripts/run-quality');

const CID = 999913;
const NEVER = 990131;   // never synced
const STALE = 990132;   // 20 days stale on a daily cadence
const FRESH = 990133;   // synced yesterday on a daily cadence
const LOCS = [NEVER, STALE, FRESH];

const AS_OF = '2026-10-08';
const MIDNIGHT = new Date(2026, 9, 8, 0, 0, 0);  // local midnight of AS_OF

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** `count` daily syncs, the newest `endingDaysAgo` days before AS_OF. */
function dailySyncs(endingDaysAgo, count = 30) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(new Date(MIDNIGHT.getTime() - (endingDaysAgo + i) * 86400000));
  }
  return out;
}

async function seed(pool, locationId, entity, lastSuccess) {
  await pool.query(
    `INSERT INTO sync_store_state
       (client_id, location_id, entity, connector, last_successful_sync, updated_at)
     VALUES ($1, $2, $3, 'clover', $4, now())
     ON CONFLICT (client_id, location_id, entity) DO UPDATE SET
       connector = EXCLUDED.connector,
       last_successful_sync = EXCLUDED.last_successful_sync, updated_at = now()`,
    [CID, locationId, entity, lastSuccess]
  );
}

async function cleanup(pool) {
  await pool.query('DELETE FROM data_quality_results WHERE client_id = $1', [CID]);
  await pool.query('DELETE FROM store_quality_state WHERE client_id = $1', [CID]);
  await pool.query('DELETE FROM sync_store_state WHERE client_id = $1', [CID]);
}

(async () => {
  const pool = getAnalyticsPool();
  const ready = await pool.query(
    `SELECT to_regclass('public.store_quality_state')   IS NOT NULL
        AND to_regclass('public.data_quality_results') IS NOT NULL
        AND to_regclass('public.sync_store_state')     IS NOT NULL AS ok`
  );
  if (!ready.rows[0].ok) {
    console.error('Analytics migrations 016/017 are not applied - run `npm run migrate`.');
    process.exit(2);
  }
  await cleanup(pool);

  console.log('\n-- Before the job runs, every store is unknown and admits ----');

  const before = await gate.getStoreQuality(pool, CID, STALE);
  check('1  no row reads as unknown and ungated', before.verdict === 'unknown' && before.ungated);
  check('2  ...and is admitted (the documented fail-open)',
    gate.storeRefusals(before).length === 0);

  console.log('\n-- Seed three sentinel stores ------------------------------');

  await seed(pool, NEVER, 'sales', null);
  await seed(pool, NEVER, 'products', null);
  await seed(pool, STALE, 'sales', dailySyncs(20)[0]);
  await seed(pool, STALE, 'products', dailySyncs(20)[0]);
  await seed(pool, FRESH, 'sales', dailySyncs(1)[0]);
  await seed(pool, FRESH, 'products', dailySyncs(1)[0]);

  const history = (days) => ({
    byEntity: new Map([['sales', dailySyncs(days)], ['products', dailySyncs(days)]]),
    error: null,
  });
  const pools = { analytics: pool, syncgo: null };

  console.log('\n-- A store that never synced is REJECTED --------------------');

  const never = await quality.evaluateStore(pools, { clientId: CID, locationId: NEVER },
    { asOf: AS_OF, history: { byEntity: new Map(), error: null }, anomaly: null });
  check('3  verdict is reject', never.verdict.verdict === 'reject', never.verdict.verdict);
  check('4  never_synced is set and staleness stays NULL, not 0',
    never.verdict.never_synced === true && never.verdict.staleness_days === null);

  let row = await gate.getStoreQuality(pool, CID, NEVER);
  check('5  the row was written and reads back as reject',
    row.ungated === false && row.verdict === 'reject' && row.never_synced === true);
  let refusals = gate.storeRefusals(row);
  check('6  admit() refuses it, naming both the verdict and the never-sync',
    refusals.includes('store_quality:reject') && refusals.includes('store_never_synced'),
    refusals.join(','));

  const neverGates = await pool.query(
    `SELECT gate, entity, verdict FROM data_quality_results
      WHERE client_id = $1 AND location_id = $2 ORDER BY entity`, [CID, NEVER]
  );
  check('7  one freshness audit row per entity, each a fail',
    neverGates.rows.length === 2
    && neverGates.rows.every((g) => g.gate === 'freshness' && g.verdict === 'fail'),
    JSON.stringify(neverGates.rows));

  console.log('\n-- 20 days stale on a daily cadence: degraded, and REFUSED --');

  const stale = await quality.evaluateStore(pools, { clientId: CID, locationId: STALE },
    { asOf: AS_OF, history: history(20), anomaly: null });
  check('8  Python degrades rather than rejects (staleness is attached, not fatal)',
    stale.verdict.verdict === 'degraded', stale.verdict.verdict);

  row = await gate.getStoreQuality(pool, CID, STALE);
  // Within a day, not within an hour: the sync stamps are serialised as UTC
  // and the gate measures against local midnight of as_of, so a box east of
  // Greenwich reads a few hours more. The refusals are at 2.5x and 6x the
  // store's cadence; hours do not move them.
  check('9  staleness_days is filled (about 20)',
    row.staleness_days !== null && Math.abs(row.staleness_days - 20) < 1,
    String(row.staleness_days));
  check('10 median_interval_days is filled (1 day) - the column nothing wrote',
    row.median_interval_days !== null && Math.abs(row.median_interval_days - 1) < 0.01,
    String(row.median_interval_days));
  refusals = gate.storeRefusals(row);
  check('11 admit() now REFUSES with data_too_stale',
    refusals.some((r) => r.startsWith('data_too_stale:')), refusals.join(','));
  check('12 ...and the degraded verdict itself did not refuse (the multiple did)',
    !refusals.some((r) => r.startsWith('store_quality:')));
  const decision = gate.admit(
    { id: 1, rank: 1, action_type: 'cold_box', confidence: 0.9, primary_skus: ['S'] },
    { quality: row, products: [{ sku: 'S', price: 10 }] }
  );
  check('13 a card for that store is withheld, with the owner sentence',
    decision.visible === false && /normal sync interval/.test(decision.explanation || ''),
    JSON.stringify(decision.reasons));
  check('14 the stale reason is on the row for the morning list',
    (row.reasons || []).some((r) => r.startsWith('stale:')), JSON.stringify(row.reasons));

  console.log('\n-- A fresh store passes -------------------------------------');

  const fresh = await quality.evaluateStore(pools, { clientId: CID, locationId: FRESH },
    { asOf: AS_OF, history: history(1), anomaly: null });
  check('15 verdict is pass', fresh.verdict.verdict === 'pass', fresh.verdict.verdict);
  row = await gate.getStoreQuality(pool, CID, FRESH);
  check('16 the row reads back as pass with both numbers',
    row.verdict === 'pass' && row.staleness_days !== null && row.median_interval_days !== null);
  check('17 admit() admits it', gate.storeRefusals(row).length === 0);

  console.log('\n-- Re-running replaces the row, not duplicates it ----------');

  await quality.evaluateStore(pools, { clientId: CID, locationId: FRESH },
    { asOf: AS_OF, history: history(1), anomaly: null });
  const count = await pool.query(
    'SELECT count(*)::int AS n FROM store_quality_state WHERE client_id = $1', [CID]
  );
  check('18 three stores, three rows', count.rows[0].n === 3, String(count.rows[0].n));

  console.log('\n-- syncgo unreachable: evaluated on the default cadence, said so --');

  const noHistory = await quality.evaluateStore(pools, { clientId: CID, locationId: STALE },
    { asOf: AS_OF, history: { byEntity: new Map(), error: 'ECONNREFUSED' }, anomaly: null });
  check('19 the store is still judged (default cadence, still stale)',
    noHistory.verdict.verdict === 'degraded' && noHistory.verdict.median_interval_days !== null);
  check('20 ...and the row says the history was unavailable',
    noHistory.verdict.reasons.some((r) => r.startsWith('sync_history_unavailable:')),
    JSON.stringify(noHistory.verdict.reasons));

  console.log('\n-- Dry run writes nothing ---------------------------------');

  await pool.query('DELETE FROM store_quality_state WHERE client_id = $1 AND location_id = $2',
    [CID, FRESH]);
  await quality.evaluateStore(pools, { clientId: CID, locationId: FRESH },
    { asOf: AS_OF, history: history(1), anomaly: null, dryRun: true });
  const dry = await gate.getStoreQuality(pool, CID, FRESH);
  check('21 a dry run leaves the store unknown', dry.ungated === true);

  await cleanup(pool);


console.log('');
console.log('-- Sales freshness comes from the DATA, not the job log ---');

// The condition that took 182 of 211 stores dark on QA. A `localdb` store has
// its rows already in the warehouse, so no sync job ever runs for sales and
// `last_successful_sync` stays NULL forever. The gate called that
// `never_synced` - a reject - while the sales table held a year of data the
// engine was building ten cards a night from.
{
  const syncState = [
    { entity: 'products', connector: 'localdb', last_successful_sync: new Date('2026-10-12T02:22:00Z') },
    { entity: 'sales', connector: 'localdb', last_successful_sync: null },
    { entity: 'suppliers', connector: 'localdb', last_successful_sync: null },
  ];
  const history = { byEntity: new Map(), error: null };

  const without = quality.buildPayload({
    clientId: CID, locationId: 990199, asOf: '2026-10-12',
    syncState, history, anomaly: null,
  });
  const salesWithout = without.freshness.find((f) => f.entity === 'sales');
  check('22 without a frontier, sales still reads never-synced',
    salesWithout.last_successful_sync === null);

  const frontier = new Date('2026-10-11T00:00:00Z');
  const withF = quality.buildPayload({
    clientId: CID, locationId: 990199, asOf: '2026-10-12',
    syncState, history, anomaly: null,
    frontiers: { sales: frontier, products: null },
  });
  const salesWith = withF.freshness.find((f) => f.entity === 'sales');
  check('23 with a frontier, sales is judged on the newest sale',
    salesWith.last_successful_sync === frontier.toISOString(),
    String(salesWith.last_successful_sync));
  check('24 and the substitution is declared, not silent',
    (withF.notes || []).includes('sales_freshness_from_data_frontier'),
    JSON.stringify(withF.notes));

  // A feed the log CAN speak for is untouched - the frontier is a fallback,
  // not an override, or a store whose sync broke would look fresh forever.
  const prods = withF.freshness.find((f) => f.entity === 'products');
  check('25 a feed with a real sync timestamp keeps it',
    prods.last_successful_sync === new Date('2026-10-12T02:22:00Z').toISOString());
  // And an ancillary feed is not given the sales frontier.
  const sup = withF.freshness.find((f) => f.entity === 'suppliers');
  check('26 an ancillary feed is never given a frontier',
    sup.last_successful_sync === null);

  // PRODUCTS NEEDED IT TOO. Store 171 had a real products sync and passed once
  // sales was grounded; 176 and 181 have no recorded sync for ANY entity and
  // kept rejecting on products while holding 587,000 and 1,063,000 sale_items.
  const bothNull = [
    { entity: 'products', connector: 'localdb', last_successful_sync: null },
    { entity: 'sales', connector: 'localdb', last_successful_sync: null },
  ];
  const pf = new Date('2026-10-12T02:00:00Z');
  const both = quality.buildPayload({
    clientId: CID, locationId: 990199, asOf: '2026-10-12',
    syncState: bothNull, history, anomaly: null,
    frontiers: { sales: frontier, products: pf },
  });
  check('27 products is grounded in the data as well',
    both.freshness.find((f) => f.entity === 'products')
      .last_successful_sync === pf.toISOString());
  check('28 and each substitution is declared separately',
    (both.notes || []).includes('products_freshness_from_data_frontier')
    && (both.notes || []).includes('sales_freshness_from_data_frontier'),
    JSON.stringify(both.notes));
  // No data at all is a REAL never-synced and must keep rejecting.
  const none = quality.buildPayload({
    clientId: CID, locationId: 990199, asOf: '2026-10-12',
    syncState: bothNull, history, anomaly: null,
    frontiers: { sales: null, products: null },
  });
  check('29 a store with no data anywhere still reads never-synced',
    none.freshness.every((f) => f.last_successful_sync === null));
}

  console.log('');
  console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(async (err) => {
  console.error(err.stack || err.message);
  try { await cleanup(getAnalyticsPool()); } catch { /* best effort */ }
  process.exit(1);
});
