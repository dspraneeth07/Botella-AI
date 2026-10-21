#!/usr/bin/env node
/**
 * Ingestion hardening verification (sheet 01).
 *
 * The four properties the sheet asks for, plus the ones whose failure would be
 * invisible in production:
 *
 *   1  a failing store does not abort the batch
 *   2  identical payloads dedupe
 *   3  each failure class routes correctly
 *   4  the digest groups by connector
 *   5  a failed sync does NOT advance last_successful_sync  ← the whole
 *      "do not reintroduce" rule; sheet 02 refuses on this
 *   6  retries happen only for transient failures
 *   7  a disabled job is skipped, not re-attempted
 *
 * Classification cases are taken verbatim from the live warehouse's top
 * failures, not invented.
 *
 * PREREQ: analytics migration 016 applied.
 * Run:  node tests/ingestion-verify.js
 */
require('dotenv').config();

const { getAnalyticsPool } = require('../database/analytics-connection');
const ingest = require('../services/ingestionService');

const CID = 999903;
const LID = 990003;
const CONNECTOR = '__test_clover';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function cleanup(pool) {
  await pool.query('DELETE FROM sync_raw_log WHERE client_id=$1', [CID]);
  await pool.query('DELETE FROM sync_store_state WHERE client_id=$1', [CID]);
  await pool.query("DELETE FROM sync_connector_digest WHERE connector LIKE '__test%'");
}

(async () => {
  const pool = getAnalyticsPool();

  const ready = await pool.query(
    `SELECT to_regclass('public.sync_raw_log')          IS NOT NULL
        AND to_regclass('public.sync_store_state')      IS NOT NULL
        AND to_regclass('public.sync_connector_digest') IS NOT NULL AS ok`
  );
  if (!ready.rows[0].ok) {
    console.error('Analytics migration 016 is not applied — run `npm run migrate` first.');
    process.exit(2);
  }
  await cleanup(pool);

  // ── 3. Failure classification, against REAL warehouse errors ──────────────
  console.log('\n── Failure classification (live corpus) ────────────────────');

  const corpus = [
    // ~27,000 rows in job_runs_history. Retrying a dead token is how one bad
    // credential became tens of thousands of identical failures.
    ['credential', 'Summary | POS service message: Clover fetch failed for /v3/merchants/4TTHJXS8JE0R1/items offset 0. Status: 401 Unauthorized'],
    // ~15,000 rows.
    ['credential', 'Summary | POS service message: EPOSNow product fetch failed at page 1. Status: 403 Forbidden'],
    // ~12,600 rows. The job should never have been scheduled for this entity.
    ['schema', "ValidateService | Service 'GokulService' does not implement method 'ProcessSupplier'."],
    ['schema', "ValidateEntity | Invalid entity 'purchases' on job."],
    ['transient', 'Summary | POS service message: request timed out. Status: 504 Gateway Timeout'],
    ['transient', 'Error: ECONNRESET'],
    ['transient', 'Status: 429 Too Many Requests'],
    ['dead', 'Summary | POS service message: merchant not found. Status: 404 Not Found'],
    ['dead', 'Account closed for this merchant'],
  ];
  for (const [want, text] of corpus) {
    const got = ingest.classifyFailure(text);
    check(`3  ${want.padEnd(10)} ← ${text.slice(0, 62)}`, got === want, `got ${got}`);
  }

  // The preamble must never outvote the real error. `result` in the warehouse
  // opens with "Start | Processing job ..." on EVERY row, failed or not.
  const multiline = [
    'Start | Processing job for ClientId=1, LocationId=2, Entity=products',
    'Loading page 1',
    'Summary | POS service message: Clover fetch failed. Status: 401 Unauthorized',
  ].join('\n');
  check('3b multi-line job log classifies on its TAIL, not its preamble',
    ingest.classifyFailure(multiline) === 'credential');

  check('3c an Error carrying only { status: 401 } is still a credential failure',
    ingest.classifyFailure(Object.assign(new Error('failed'), { status: 401 })) === 'credential');
  check('3d unknown text defaults to transient (wrong-toward-retry is cheap)',
    ingest.classifyFailure('something nobody has seen before') === 'transient');
  check('3e null/empty is transient, never a crash',
    ingest.classifyFailure(null) === 'transient' && ingest.classifyFailure('') === 'transient');
  check('3f only transient is retryable',
    ingest.isRetryable('transient') === true
      && ['credential', 'schema', 'dead'].every((c) => ingest.isRetryable(c) === false));

  // ── 2. Raw-log dedupe ─────────────────────────────────────────────────────
  console.log('\n── Durable raw log ─────────────────────────────────────────');

  const payload = { items: [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2 }] };
  const first = await ingest.landRawPayload(pool, {
    connector: CONNECTOR, clientId: CID, locationId: LID, entity: 'products', payload,
  });
  check('2  first landing is stored as new', first.deduped === false && first.fetch_count === 1);
  check('2b bytes and sha recorded', first.bytes > 0 && /^[0-9a-f]{64}$/.test(first.payload_sha256));

  // Same bytes, different key order — JSON.stringify of the SAME object.
  const second = await ingest.landRawPayload(pool, {
    connector: CONNECTOR, clientId: CID, locationId: LID, entity: 'products', payload,
  });
  check('2c identical payload dedupes to the same row',
    second.id === first.id && second.deduped === true && second.fetch_count === 2);

  const rowCount = await pool.query(
    "SELECT count(*)::int n FROM sync_raw_log WHERE client_id=$1 AND entity='products'", [CID]
  );
  check('2d one row, not two', rowCount.rows[0].n === 1, `${rowCount.rows[0].n}`);

  const changed = await ingest.landRawPayload(pool, {
    connector: CONNECTOR, clientId: CID, locationId: LID, entity: 'products',
    payload: { items: [{ sku: 'A', qty: 9 }] },
  });
  check('2e a genuinely different payload IS a new row', changed.id !== first.id);

  // Same bytes under a DIFFERENT entity must not collide — Gokul can sync
  // products and cannot sync suppliers, so entity is part of the identity.
  const otherEntity = await ingest.landRawPayload(pool, {
    connector: CONNECTOR, clientId: CID, locationId: LID, entity: 'suppliers', payload,
  });
  check('2f same bytes under another entity is a separate row',
    otherEntity.id !== first.id && otherEntity.deduped === false);

  const replayed = await ingest.readRawPayload(pool, {
    clientId: CID, locationId: LID, entity: 'products', sha256: first.payload_sha256,
  });
  // NOT byte-identity: `payload` is jsonb and Postgres does not preserve key
  // order. What must hold is semantic equality plus a hash that still
  // verifies after the round trip - otherwise the integrity check is
  // decorative.
  check('2g replay reads the payload back semantically identical',
    JSON.stringify(replayed.payload.items.map((i) => [i.sku, i.qty]))
      === JSON.stringify(payload.items.map((i) => [i.sku, i.qty])));
  check('2g2 the stored hash STILL VERIFIES after the jsonb round trip',
    ingest._internals.sha256(ingest._internals.canonicalJson(replayed.payload))
      === first.payload_sha256);

  // Key order is the vendor's serializer, not the data. Reordering must not
  // manufacture a second document.
  const reordered = await ingest.landRawPayload(pool, {
    connector: CONNECTOR, clientId: CID, locationId: LID, entity: 'products',
    payload: { items: [{ qty: 1, sku: 'A' }, { qty: 2, sku: 'B' }] },
  });
  check('2g3 a key-reordered but identical payload dedupes',
    reordered.id === first.id && reordered.deduped === true);

  const emptyFetch = await ingest.landRawPayload(pool, {
    connector: CONNECTOR, clientId: CID, locationId: LID, entity: 'customers', payload: null,
  });
  check('2h an empty fetch is still recorded ("we asked and got nothing")',
    emptyFetch.id > 0 && emptyFetch.bytes === 0);

  // ── 5. Staleness: the do-not-reintroduce rule ─────────────────────────────
  console.log('\n── Staleness marker ────────────────────────────────────────');

  const elevenDaysAgo = new Date(Date.now() - 11 * 86400000).toISOString();
  await ingest.recordSuccess(pool, {
    connector: CONNECTOR, clientId: CID, locationId: LID, entity: 'sales', at: elevenDaysAgo,
  });
  await ingest.recordFailure(pool, {
    connector: CONNECTOR, clientId: CID, locationId: LID, entity: 'sales',
    error: 'Status: 401 Unauthorized',
  });

  let fresh = await ingest.getStoreFreshness(pool, CID, LID, 'sales');
  check('5  a FAILED sync leaves last_successful_sync untouched',
    new Date(fresh[0].last_successful_sync).toISOString().slice(0, 10)
      === elevenDaysAgo.slice(0, 10),
    String(fresh[0].last_successful_sync));
  check('5b the store reads as ~11 days stale, not fresh',
    fresh[0].days_stale === 11 && fresh[0].stale === true, `days_stale=${fresh[0].days_stale}`);
  check('5c the failure class is recorded for the digest',
    fresh[0].last_failure_class === 'credential' && fresh[0].consecutive_failures === 1);

  // Never-synced is a DIFFERENT state from "stale by N days", and callers
  // have to be able to tell them apart.
  await ingest.recordFailure(pool, {
    connector: CONNECTOR, clientId: CID, locationId: LID, entity: 'purchases',
    error: "Service 'GokulService' does not implement method 'ProcessPurchaseOrders'.",
  });
  const never = await ingest.getStoreFreshness(pool, CID, LID, 'purchases');
  check('5d never-synced is distinct from stale-by-N (days_stale is null)',
    never[0].never_synced === true && never[0].days_stale === null && never[0].stale === true);
  check('5e schema failures classify as schema, not credential',
    never[0].last_failure_class === 'schema');

  // A success must clear everything, including a disable.
  await ingest.recordSuccess(pool, {
    connector: CONNECTOR, clientId: CID, locationId: LID, entity: 'sales',
  });
  fresh = await ingest.getStoreFreshness(pool, CID, LID, 'sales');
  check('5f a success resets the failure state and un-disables',
    fresh[0].consecutive_failures === 0 && fresh[0].last_failure_class === null
      && fresh[0].disabled === false && fresh[0].days_stale === 0);

  // ── 1 / 6 / 7. Batch isolation ────────────────────────────────────────────
  console.log('\n── Per-store batch isolation ───────────────────────────────');

  const stores = [
    { clientId: CID, locationId: LID, entity: 'e1', connector: CONNECTOR },
    { clientId: CID, locationId: LID, entity: 'e2', connector: CONNECTOR }, // fails
    { clientId: CID, locationId: LID, entity: 'e3', connector: CONNECTOR },
    { clientId: CID, locationId: LID, entity: 'e4', connector: CONNECTOR }, // fails
    { clientId: CID, locationId: LID, entity: 'e5', connector: CONNECTOR },
  ];
  const attempts = {};
  const summary = await ingest.runStoreBatch(
    stores,
    async (store) => {
      attempts[store.entity] = (attempts[store.entity] || 0) + 1;
      if (store.entity === 'e2') throw Object.assign(new Error('Status: 401 Unauthorized'), { status: 401 });
      if (store.entity === 'e4') throw new Error('ECONNRESET');
      return { ok: true };
    },
    { analyticsPool: pool, concurrency: 2, sleepFn: async () => {} }
  );

  check('1  a failing store does not abort the batch',
    summary.attempted === 5 && summary.succeeded === 3 && summary.failed === 2,
    JSON.stringify(summary));
  check('1b the result is a SUMMARY, not a thrown exception',
    typeof summary === 'object' && 'attempted' in summary && 'skipped' in summary);
  check('1c failures are counted by class',
    summary.byClass.credential === 1 && summary.byClass.transient === 1,
    JSON.stringify(summary.byClass));

  check('6  a credential failure is NOT retried (one dead token, one attempt)',
    attempts.e2 === 1, `attempted ${attempts.e2}x`);
  check('6b a transient failure IS retried up to the cap',
    attempts.e4 === ingest.MAX_TRANSIENT_ATTEMPTS, `attempted ${attempts.e4}x`);
  check('6c successful stores run exactly once', attempts.e1 === 1 && attempts.e3 === 1);

  // 7. Disable after N, then skip.
  for (let i = 0; i < ingest.DEAD_AFTER_FAILURES; i += 1) {
    await ingest.recordFailure(pool, {
      connector: CONNECTOR, clientId: CID, locationId: LID, entity: 'e9',
      error: 'Status: 500 Internal Server Error',
    });
  }
  const disabled = await ingest.getStoreFreshness(pool, CID, LID, 'e9');
  check(`7  disabled after ${ingest.DEAD_AFTER_FAILURES} consecutive failures`,
    disabled[0].disabled === true, JSON.stringify(disabled[0]));

  let touched = false;
  const skipRun = await ingest.runStoreBatch(
    [{ clientId: CID, locationId: LID, entity: 'e9', connector: CONNECTOR }],
    async () => { touched = true; return {}; },
    { analyticsPool: pool, sleepFn: async () => {} }
  );
  check('7b a disabled job is SKIPPED, not attempted',
    touched === false && skipRun.skipped === 1 && skipRun.attempted === 0,
    JSON.stringify(skipRun));
  check('7c a skip is not counted as a failure (it would inflate the rate forever)',
    skipRun.failed === 0);

  const empty = await ingest.runStoreBatch([], async () => {}, { sleepFn: async () => {} });
  check('7d an empty estate returns zeros rather than hanging', empty.attempted === 0);

  // ── 4. Connector-level aggregation ────────────────────────────────────────
  console.log('\n── Connector digest ────────────────────────────────────────');

  // Two connectors, three stores, so grouping is observable.
  const digestRows = [
    ['__test_alpha', 1, 'products', 'Status: 401 Unauthorized'],
    ['__test_alpha', 2, 'products', 'Status: 401 Unauthorized'],
    ['__test_alpha', 3, 'sales', "Service 'X' does not implement method 'Y'."],
    ['__test_beta', 4, 'products', 'Status: 504 Gateway Timeout'],
  ];
  for (const [connector, loc, entity, err] of digestRows) {
    await ingest.recordFailure(pool, {
      connector, clientId: CID, locationId: loc, entity, error: err,
    });
  }

  // Digest the analytics side only (no syncgo dependency in this assertion):
  // group the state table the same way the digest does.
  const grouped = await pool.query(
    `SELECT connector,
            count(*)::int AS rows,
            count(*) FILTER (WHERE last_failure_class='credential')::int AS credential,
            count(*) FILTER (WHERE last_failure_class='schema')::int AS schema_,
            count(*) FILTER (WHERE last_successful_sync IS NULL)::int AS never
       FROM sync_store_state
      WHERE connector LIKE '__test%'
      GROUP BY 1 ORDER BY 1`
  );
  const alpha = grouped.rows.find((r) => r.connector === '__test_alpha');
  const beta = grouped.rows.find((r) => r.connector === '__test_beta');

  check('4  failures roll up BY CONNECTOR, not per store',
    grouped.rows.length === 3, JSON.stringify(grouped.rows.map((r) => r.connector)));
  check('4b alpha aggregates its 3 stores into one row',
    alpha.rows === 3 && alpha.credential === 2 && alpha.schema_ === 1, JSON.stringify(alpha));
  check('4c beta is a separate row', beta.rows === 1);
  check('4d never-synced stores are counted', alpha.never === 3);

  // The rendered report is what a human actually receives.
  const text = ingest.formatDigest([{
    digest_date: '2026-09-22', connector: 'gokul', stores: 19, runs: 57520,
    failed: 2281, failure_pct: 4.0, transient_count: 0, credential_count: 0,
    schema_count: 2281, dead_count: 0, stores_stale: 3, stores_never: 1,
    max_stale_days: 11, median_stale_days: 0, skus: 160133,
    cost_coverage_pct: 0, category_coverage_pct: 98.6,
    exemplars: [{ store: '1:2', entity: 'suppliers', class: 'schema', error: "does not implement 'ProcessSupplier'" }],
  }]);
  check('4e the report names the connector, not the stores', text.includes('GOKUL'));
  check('4f zero cost coverage is called a CONNECTOR DEFECT outright',
    text.includes('CONNECTOR DEFECT'), text);
  check('4g staleness and coverage are both on the report',
    text.includes('never synced') && text.includes('cost 0%'));

  await cleanup(pool);
  await pool.end();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nverification aborted:', err);
  process.exit(1);
});
