#!/usr/bin/env node
/**
 * Store-spectrum verification — the whole new architecture, empty store to full store.
 *
 * Everything built so far has to hold across the real estate, which is not
 * uniform: of 188 configured stores, **79 have zero products and zero sales**
 * and 88 have thousands of both. A pipeline that only works on the healthy
 * middle is a pipeline that silently produces nonsense for 42% of the network.
 *
 * Three layers, three store shapes:
 *
 *              EMPTY                PARTIAL                 FULL
 *   ingest     never synced         some entities stale     all fresh
 *   capture    0 recs, {} signals   some signals, few recs  full bundle
 *   envelope   ok=false + reason    degraded provenance     ok=true
 *
 * The failure this guards against is not a crash. It is a store with no data
 * quietly producing a confident-looking answer — a zero that reads as a
 * measurement, a "fresh" that means "never checked".
 *
 * PREREQ: analytics migrations 014, 015, 016.
 * Run:  node tests/store-spectrum-verify.js
 */
require('dotenv').config();

const { getAnalyticsPool } = require('../database/analytics-connection');
const ingest = require('../services/ingestionService');
const dailySvc = require('../services/dailySnapshotService');
const recSvc = require('../services/recommendationService');

// Three sentinel stores, one per shape.
const CID = 999905;
const EMPTY = 990010;
const PARTIAL = 990011;
const FULL = 990012;
const CONNECTOR = '__test_spectrum';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function cleanup(pool) {
  for (const t of ['sync_raw_log', 'sync_store_state', 'daily_store_signals',
    'daily_store_recommendations']) {
    await pool.query(`DELETE FROM ${t} WHERE client_id=$1`, [CID]);
  }
  await pool.query('DELETE FROM recommendation_runs WHERE client_id=$1', [CID]);
}

const iso = (d) => new Date(d).toISOString();
const daysAgo = (n) => iso(Date.now() - n * 86400000);

function makeRun(locationId, { recs = [], bundle = null, tz = 'America/Chicago' } = {}) {
  return {
    client_id: CID,
    location_id: locationId,
    generated_at: '2026-09-22T04:00:00.000Z',
    data_as_of: '2026-09-21',
    candidate_count: recs.length ? 150 : 0,
    recommendations_generated: recs.length,
    dropped_invalid: 0,
    signal_snapshot: bundle || {},
    recommendations: recs,
    signal_capture: bundle
      ? { timezone: tz, bundle, source_health: { weather: { ok: true, items: 1 } } }
      : { timezone: tz, bundle: {}, source_health: {} },
  };
}

const REC = {
  rank: 1, category: 'weather', action_type: 'cold_box', primary_skus: ['SKU1'],
  rationale: 'hot', signals_cited: ['heat_advisory'], confidence: 0.9,
  valid_through: '2026-09-29',
};

(async () => {
  const pool = getAnalyticsPool();
  await cleanup(pool);
  dailySvc._resetProbes();

  // ══ LAYER 1 — ingestion / freshness ══════════════════════════════════════
  console.log('\n── Layer 1: ingestion across the spectrum ──────────────────');

  // EMPTY: a configured store that has never synced anything.
  // The critical property: it must read as STALE, never as fresh. Absence of
  // evidence is not evidence of freshness.
  await ingest.recordFailure(pool, {
    connector: CONNECTOR, clientId: CID, locationId: EMPTY, entity: 'products',
    error: "ResolveService | Service '' not found or not registered.",
  });
  let f = await ingest.getStoreFreshness(pool, CID, EMPTY, 'products');
  check('E1 an empty store reads STALE, not fresh', f[0].stale === true);
  check('E2 never_synced is true and days_stale is NULL (not 0, not 9999)',
    f[0].never_synced === true && f[0].days_stale === null,
    `never=${f[0].never_synced} days=${f[0].days_stale}`);
  check('E3 the reason is classified, not just "failed"',
    f[0].last_failure_class === 'dead', f[0].last_failure_class);

  // A store with NO state row at all — never even configured.
  const unknown = await ingest.getStoreFreshness(pool, CID, 999999);
  check('E4 a completely unknown store returns [] rather than throwing',
    Array.isArray(unknown) && unknown.length === 0);

  // PARTIAL: products fresh, sales eleven days stale. The dangerous shape —
  // anything reasoning about sales must not be told the store is fine.
  await ingest.recordSuccess(pool, {
    connector: CONNECTOR, clientId: CID, locationId: PARTIAL, entity: 'products',
  });
  await ingest.recordSuccess(pool, {
    connector: CONNECTOR, clientId: CID, locationId: PARTIAL, entity: 'sales',
    at: daysAgo(11),
  });
  await ingest.recordFailure(pool, {
    connector: CONNECTOR, clientId: CID, locationId: PARTIAL, entity: 'sales',
    error: 'Status: 401 Unauthorized',
  });
  f = await ingest.getStoreFreshness(pool, CID, PARTIAL);
  const products = f.find((r) => r.entity === 'products');
  const sales = f.find((r) => r.entity === 'sales');
  check('P1 a partially-stale store is fresh on one entity and stale on another',
    products.stale === false && sales.stale === true,
    `products=${products.stale} sales=${sales.stale}`);
  check('P2 the failed entity keeps its OLD success date (11 days), not now()',
    sales.days_stale === 11, `days_stale=${sales.days_stale}`);

  // FULL: everything fresh.
  for (const entity of ['products', 'sales', 'customers', 'purchases', 'suppliers']) {
    await ingest.recordSuccess(pool, {
      connector: CONNECTOR, clientId: CID, locationId: FULL, entity,
    });
  }
  f = await ingest.getStoreFreshness(pool, CID, FULL);
  check('F1 a fully-synced store is fresh on every entity',
    f.length === 5 && f.every((r) => r.stale === false && r.days_stale === 0));

  // ══ LAYER 2 — daily capture ══════════════════════════════════════════════
  console.log('\n── Layer 2: daily capture across the spectrum ──────────────');

  // EMPTY: a run that produced NOTHING. This must still be recorded — "we ran
  // and found nothing to say" is a fact, and a missing row is indistinguishable
  // from "the cron never fired".
  const emptyRun = makeRun(EMPTY);
  const emptyPersist = await recSvc.persistRun(pool, emptyRun);
  check('E5 a run with ZERO recommendations persists without throwing',
    emptyPersist.runId > 0 && emptyPersist.archived.length === 0);

  const emptyArchive = await pool.query(
    `SELECT recommendation_count, shown_count, holdout_count, categories,
            action_types, recommendations, recommendations_sha256
       FROM daily_store_recommendations WHERE client_id=$1 AND location_id=$2`,
    [CID, EMPTY]
  );
  check('E6 the empty day is ARCHIVED as an explicit zero, not absent',
    emptyArchive.rows.length === 1 && emptyArchive.rows[0].recommendation_count === 0);
  check('E7 empty arrays, not nulls (a consumer can .length them safely)',
    Array.isArray(emptyArchive.rows[0].categories)
      && emptyArchive.rows[0].categories.length === 0
      && JSON.stringify(emptyArchive.rows[0].recommendations) === '[]');
  check('E8 an empty day still hashes (change detection keeps working)',
    /^[0-9a-f]{64}$/.test(emptyArchive.rows[0].recommendations_sha256));

  await dailySvc.captureSignalsForRun(pool, emptyRun, emptyPersist.day);
  const emptySignals = await pool.query(
    `SELECT signal_count, sources_ok, sources_failed, active_keys, weather,
            bundle_fidelity, bundle
       FROM daily_store_signals WHERE client_id=$1 AND location_id=$2`,
    [CID, EMPTY]
  );
  check('E9 an empty signal bundle persists with signal_count = 0',
    emptySignals.rows.length === 1 && emptySignals.rows[0].signal_count === 0);
  check('E10 generated columns are NULL on an empty bundle, not a crash',
    emptySignals.rows[0].weather === null);
  check('E11 active_keys is an empty array, never null',
    Array.isArray(emptySignals.rows[0].active_keys)
      && emptySignals.rows[0].active_keys.length === 0);

  // FULL: a complete run.
  const fullBundle = {
    weather: { summary: 'Hot', high_f: 99 },
    sports: [{ league: 'nfl', home: 'A', away: 'B', date: '2026-09-21' }],
    events: [], holidays: [], news: [], social: [],
    active_keys: ['heat_advisory'],
  };
  const fullRun = makeRun(FULL, { recs: [REC], bundle: fullBundle });
  const fullPersist = await recSvc.persistRun(pool, fullRun);
  await dailySvc.captureSignalsForRun(pool, fullRun, fullPersist.day);

  const fullArchive = await pool.query(
    'SELECT recommendation_count, action_types FROM daily_store_recommendations WHERE client_id=$1 AND location_id=$2',
    [CID, FULL]
  );
  check('F2 a full run archives its recommendations',
    fullArchive.rows[0].recommendation_count === 1
      && fullArchive.rows[0].action_types[0] === 'cold_box');

  const fullSignals = await pool.query(
    'SELECT signal_count, weather, bundle_fidelity FROM daily_store_signals WHERE client_id=$1 AND location_id=$2',
    [CID, FULL]
  );
  check('F3 a full bundle records its signals and is marked full-fidelity',
    fullSignals.rows[0].signal_count === 2
      && fullSignals.rows[0].bundle_fidelity === 'full'
      && fullSignals.rows[0].weather.high_f === 99);

  // The empty and full stores must be DISTINGUISHABLE in one query — that is
  // what makes "which stores produced nothing today" answerable.
  const distinguishable = await pool.query(
    `SELECT location_id, recommendation_count FROM daily_store_recommendations
      WHERE client_id=$1 AND recommendation_count = 0`, [CID]
  );
  check('E12 "which stores produced nothing" is one indexed query',
    distinguishable.rows.length === 1 && distinguishable.rows[0].location_id === EMPTY);

  // ══ LAYER 3 — the stage envelope ═════════════════════════════════════════
  console.log('\n── Layer 3: stage envelope across the spectrum ─────────────');

  // The Python package owns the envelope; Node's job is to READ a stage output
  // without inventing meaning. An empty-store stage result must survive the
  // wire as an explicit no-answer.
  const env = require('../lib/stageEnvelope');
  const emptyStageRow = {
    schema: 'stage_result/1',
    stage: 'dead_stock', stage_version: '1.0.0',
    ok: false, value: null, reasons: ['no_inventory'], duration_ms: 2,
    provenance: {
      own_observations: 0, cohort_level: null, cohort_size: null,
      own_weight: 0.0, evidence_state: 'NEW', inputs: [], config_keys: [],
    },
    context: {
      run_id: 'r1', tenant_id: CID, store_id: EMPTY, as_of: '2026-09-21',
      snapshot_id: 's1', config_version: 'default', seed: 0, versions: {},
    },
  };
  const parsedEmpty = env.parseAuditRow(emptyStageRow);
  check('E13 an empty store yields ok=false WITH a reason, not a fake zero',
    parsedEmpty.ok === false && parsedEmpty.reasons[0] === 'no_inventory'
      && parsedEmpty.value === null);
  check('E14 its provenance says 0 observations and 0.0 own_weight',
    parsedEmpty.provenance.own_observations === 0
      && parsedEmpty.provenance.own_weight === 0);
  check('E15 the evidence state is NEW, so nothing downstream over-trusts it',
    parsedEmpty.provenance.evidence_state === 'NEW');
  check('E16 describeProvenance states the emptiness rather than hiding it',
    env.describeProvenance(parsedEmpty.provenance) === '0 obs, NEW, own 0.00');

  // A full store's result, for contrast.
  const fullStageRow = JSON.parse(JSON.stringify(emptyStageRow));
  fullStageRow.ok = true;
  fullStageRow.value = ['MD1'];
  fullStageRow.reasons = [];
  fullStageRow.provenance = {
    own_observations: 412, cohort_level: null, cohort_size: null,
    own_weight: 1.0, evidence_state: 'MATURE', inputs: ['items.sku'], config_keys: ['k'],
  };
  const parsedFull = env.parseAuditRow(fullStageRow);
  check('F4 a full store yields a value with MATURE, own_weight 1.0',
    parsedFull.ok === true && parsedFull.provenance.evidence_state === 'MATURE'
      && parsedFull.provenance.own_weight === 1);

  // The partial case: an answer that is mostly borrowed from peers. This is the
  // one that must never read as confident.
  const partialStageRow = JSON.parse(JSON.stringify(fullStageRow));
  partialStageRow.provenance = {
    own_observations: 3, cohort_level: 'state', cohort_size: 240,
    own_weight: 0.15, evidence_state: 'EMERGING', inputs: ['items.sku'], config_keys: ['k'],
  };
  const parsedPartial = env.parseAuditRow(partialStageRow);
  check('P3 a cohort-borrowed answer discloses how little is this store',
    parsedPartial.provenance.own_weight === 0.15
      && parsedPartial.provenance.cohort_level === 'state');
  check('P4 the one-line description makes the borrowing visible',
    env.describeProvenance(parsedPartial.provenance)
      === '3 obs, EMERGING, own 0.15, cohort state/240');

  // ══ Cross-cutting: the digest tolerates every shape ══════════════════════
  console.log('\n── Digest resilience ───────────────────────────────────────');

  check('D1 an estate with no connectors at all renders a message, not a crash',
    ingest.formatDigest([]) === 'No connectors to report.');

  const zeroRuns = ingest.formatDigest([{
    digest_date: '2026-09-22', connector: 'silent', stores: 12, runs: 0,
    failed: 0, failure_pct: 0, transient_count: 0, credential_count: 0,
    schema_count: 0, dead_count: 0, stores_stale: 0, stores_never: 12,
    max_stale_days: null, median_stale_days: null, skus: null,
    cost_coverage_pct: null, category_coverage_pct: null, exemplars: [],
  }]);
  check('D2 a connector with ZERO runs still appears (silent != healthy)',
    zeroRuns.includes('SILENT') && zeroRuns.includes('12 never synced'));
  check('D3 unknown coverage renders "n/a", never 0%',
    zeroRuns.includes('cost n/a') && !zeroRuns.includes('CONNECTOR DEFECT'),
    zeroRuns);

  // 0% and unknown must not be confused: one is a defect, the other is silence.
  const zeroCost = ingest.formatDigest([{
    digest_date: '2026-09-22', connector: 'gokul', stores: 19, runs: 10, failed: 0,
    failure_pct: 0, transient_count: 0, credential_count: 0, schema_count: 0,
    dead_count: 0, stores_stale: 0, stores_never: 0, max_stale_days: 0,
    median_stale_days: 0, skus: 160133, cost_coverage_pct: 0,
    category_coverage_pct: 98.6, exemplars: [],
  }]);
  check('D4 0% coverage IS called a connector defect',
    zeroCost.includes('CONNECTOR DEFECT'));

  // ══ Batch across a mixed estate ══════════════════════════════════════════
  console.log('\n── Mixed-estate batch ──────────────────────────────────────');

  const mixed = [
    { clientId: CID, locationId: EMPTY, entity: 'm1', connector: CONNECTOR },
    { clientId: CID, locationId: PARTIAL, entity: 'm2', connector: CONNECTOR },
    { clientId: CID, locationId: FULL, entity: 'm3', connector: CONNECTOR },
  ];
  const batch = await ingest.runStoreBatch(
    mixed,
    async (store) => {
      if (store.locationId === EMPTY) throw new Error('Status: 404 Not Found');
      if (store.locationId === PARTIAL) throw new Error('ECONNRESET');
      return { ok: true };
    },
    { analyticsPool: pool, sleepFn: async () => {} }
  );
  check('M1 a mixed estate returns a summary covering every store',
    batch.attempted === 3 && batch.succeeded === 1 && batch.failed === 2,
    JSON.stringify(batch));
  check('M2 the healthy store still succeeded despite two failures around it',
    batch.results.some((r) => r.store.endsWith(':m3') && r.outcome === 'succeeded'));
  check('M3 failures are attributed to the right classes',
    batch.byClass.dead === 1 && batch.byClass.transient === 1,
    JSON.stringify(batch.byClass));

  await cleanup(pool);
  await pool.end();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nverification aborted:', err);
  process.exit(1);
});
