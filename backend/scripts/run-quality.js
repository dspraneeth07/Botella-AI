#!/usr/bin/env node
/**
 * Run sheet 02's quality gates for every store, and record the verdict.
 *
 *   node scripts/run-quality.js              # every store with a sync state row
 *   node scripts/run-quality.js 171 171      # one store
 *   node scripts/run-quality.js --dry-run    # evaluate and print, write nothing
 *
 * THE GATES HAD NO CALLER, AND THE ROW HAD NO WRITER.
 *   `app/pipeline/contracts/gates.py` has held the four gates - and the right
 *   to refuse - since sheet 02. `store_quality_state` (migration 017) is the
 *   row `recommendationGateService` reads before it admits a card. Nothing ran
 *   the gates and nothing wrote the row, so every store read as `unknown`,
 *   which admits, and a POS feed three weeks dark looked exactly like a
 *   healthy one. That is the property checklist item 13 names: a stalled feed
 *   must REFUSE cards, not look like a buy signal.
 *
 * WHAT THIS WRITES, AND WHY BOTH NUMBERS
 *   `staleness_days` AND `median_interval_days`. Node's `data_too_stale`
 *   refusal fires only when staleness exceeds six times the store's OWN
 *   median sync interval, and that needs both columns non-null. The freshness
 *   gate itself only DEGRADES a stale store - it attaches the staleness so a
 *   card can carry "as of 6 days ago" - so without the median the refusal
 *   could never fire and `degraded` would admit forever.
 *
 * WHERE THE INPUTS COME FROM
 *   freshness  `sync_store_state` (analytics; refreshed at 03:00 from syncgo's
 *              job_runs_history) for the last success per entity, and
 *              job_runs_history itself for the trailing quarter of successful
 *              sync timestamps the median cadence is derived from. The state
 *              table keeps no history, so the cadence has to come from syncgo.
 *              If syncgo is unreachable the store is still evaluated - with no
 *              history, on the connector's default cadence - and the row says
 *              so, because "we could not read the cadence" is a fact about
 *              the run, not a reason to skip the store.
 *   anomaly    `feature_store_day`, when it has rows for the store. The
 *              feature store is built by an unscheduled CLI today, so most
 *              stores have none and the gate abstains; a store with trailing
 *              days is judged on its most recent COMPLETE day - strictly
 *              before the day of the last successful sales sync, because a
 *              half-synced day looks exactly like a volume collapse and would
 *              quarantine a healthy store.
 *   schema     not supplied here. The schema gate wants a connector's
 *              delivery; this job runs against the warehouse after the fact.
 *              Wiring it to sync_raw_log is a separate change.
 *
 * WHY THE STATISTICS ARE NOT HERE
 *   The thresholds, the cadence derivation and the verdict precedence live in
 *   `app/pipeline/contracts/gates.py`, where the registry Settings and the
 *   build guards are. This script moves rows. Re-implementing "is 20 days
 *   stale" in JavaScript is how an estate ends up with two answers to it -
 *   the 454-vs-485 lesson.
 */

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getAnalyticsPool } = require('../database/analytics-connection');
const { getPool } = require('../database/connection');
const python = require('../lib/pythonRunner');
const { toNumber } = require('../utils/numbers');

const RUNNER = 'quality_eval.py';

/**
 * Trailing days of successful syncs the cadence is derived from. The
 * freshness gate's input is documented as "the trailing quarter"; this is
 * the one place that quarter is turned into a query bound.
 */
const SYNC_HISTORY_DAYS = 90;

/**
 * Trailing days of feature_store_day the anomaly baseline is drawn from.
 * Generous on purpose: the gate's own `contracts.anomaly.min_observations`
 * decides whether there is enough to judge, and abstains below it.
 */
const ANOMALY_HISTORY_DAYS = 90;

// ─── Scope ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const nums = argv.filter((a) => /^\d+$/.test(a)).map(Number);
  return {
    dryRun: argv.includes('--dry-run'),
    pair: nums.length >= 2 ? { client_id: nums[0], location_id: nums[1] } : null,
  };
}

/** Every store the ingestion digest knows about - the universe 03:00 built. */
async function storesInScope(analyticsPool, pair) {
  if (pair) return [pair];
  const { rows } = await analyticsPool.query(
    `SELECT DISTINCT client_id, location_id FROM sync_store_state ORDER BY 1, 2`
  );
  return rows;
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** Per-entity last success and the connector, from the mirrored state. */
async function syncStateFor(analyticsPool, clientId, locationId) {
  const { rows } = await analyticsPool.query(
    `SELECT entity, connector, last_successful_sync
       FROM sync_store_state
      WHERE client_id = $1 AND location_id = $2
      ORDER BY entity`,
    [clientId, locationId]
  );
  return rows;
}

/**
 * Successful sync timestamps per entity over the trailing quarter, from
 * syncgo. Returns { byEntity, error } - never throws, because an unreachable
 * syncgo must degrade the store's cadence to the default, with a stated
 * reason, rather than abort the night's run for every store.
 */
async function syncHistoryFor(syncgoPool, clientId, locationId, { days = SYNC_HISTORY_DAYS } = {}) {
  const byEntity = new Map();
  if (!syncgoPool) return { byEntity, error: 'no_syncgo_pool' };
  try {
    const { rows } = await syncgoPool.query(
      `SELECT lower(entity) AS entity, started_at
         FROM job_runs_history
        WHERE client_id = $1 AND location_id = $2
          AND status = 'Completed'
          AND entity IS NOT NULL AND entity <> ''
          AND started_at > now() - ($3::int * interval '1 day')
        ORDER BY started_at`,
      [clientId, locationId, days]
    );
    for (const r of rows) {
      if (!byEntity.has(r.entity)) byEntity.set(r.entity, []);
      byEntity.get(r.entity).push(r.started_at);
    }
    return { byEntity, error: null };
  } catch (err) {
    return { byEntity, error: err.message };
  }
}

/**
 * The newest SALE this store actually has, from the warehouse.
 *
 * WHY THE SYNC LOG IS NOT ENOUGH, and why 182 stores went dark without this.
 *
 * `sync_store_state.last_successful_sync` records that a sync JOB completed.
 * For a store whose connector is `localdb` the rows are already in the
 * warehouse and no job ever runs for them, so `sales` reads
 * last_successful_sync = NULL forever. The freshness gate then calls that
 * `never_synced`, which is a reject, and the store is refused before the
 * engine is asked - while its sales table holds a year of data the engine was
 * happily building ten cards a night from.
 *
 * So freshness for sales is grounded in the DATA FRONTIER: the newest sale we
 * hold. That is not a workaround, it is the more truthful input - the engine
 * reasons from sales rows, not from a job's exit status, and a store whose
 * sync job succeeded an hour ago but whose newest sale is six weeks old is
 * stale no matter what the log says.
 *
 * Returns null when there are genuinely no sales, which is a real
 * `never_synced` and must keep rejecting. Never throws: an unreachable
 * warehouse leaves the sync log as the only evidence, which is the behaviour
 * that existed before this.
 */
async function dataFrontiersFor(syncgoPool, clientId, locationId) {
  const out = { sales: null, products: null };
  if (!syncgoPool) return out;
  // Both essential feeds, because both are affected. Store 171 had a real
  // `products` sync and passed once sales was grounded; 176 and 181 have NO
  // recorded sync for any entity and kept rejecting on products while holding
  // 587,000 and 1,063,000 sale_items. One query each, run only when the log
  // cannot speak for that entity.
  try {
    const { rows } = await syncgoPool.query(
      `SELECT max(sale_date) AS newest, count(*)::bigint AS rows
         FROM sale_items
        WHERE client_id = $1 AND location_id = $2`,
      [clientId, locationId]
    );
    const r = rows[0];
    if (r && r.newest && Number(r.rows) > 0) out.sales = new Date(r.newest);
  } catch { /* the log stays the only evidence */ }
  try {
    // `last_updated` is what the shelf-count capture already treats as the
    // product master's observation time, so the two agree about freshness.
    const { rows } = await syncgoPool.query(
      `SELECT max(last_updated) AS newest, count(*)::bigint AS rows
         FROM products
        WHERE client_id = $1 AND location_id = $2`,
      [clientId, locationId]
    );
    const r = rows[0];
    if (r && r.newest && Number(r.rows) > 0) out.products = new Date(r.newest);
  } catch { /* ditto */ }
  return out;
}

function median(values) {
  const sorted = values.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The anomaly input: the most recent COMPLETE day against the trailing
 * distribution. Null when the feature store has nothing for this store, in
 * which case the gate is simply not run (not "passed").
 *
 * `before` is the day of the last successful SALES sync; the batch day is
 * strictly earlier so a partially-synced day is never the thing judged.
 */
async function anomalyInputFor(analyticsPool, clientId, locationId, before, { days = ANOMALY_HISTORY_DAYS } = {}) {
  if (!before) return null;
  const { rows } = await analyticsPool.query(
    `SELECT obs_date::text AS obs_date, units_total, revenue, baskets
       FROM feature_store_day
      WHERE client_id = $1 AND location_id = $2
        AND was_open IS TRUE AND has_data IS TRUE
        AND obs_date < $3::date
        AND obs_date > $3::date - $4::int
      ORDER BY obs_date DESC`,
    [clientId, locationId, before, days]
  );
  if (rows.length < 2) return null;

  const derive = (r) => {
    const units = toNumber(r.units_total);
    const revenue = toNumber(r.revenue);
    const baskets = toNumber(r.baskets);
    return {
      volume: units,
      unit_price: units && revenue !== null && units > 0 ? revenue / units : null,
      basket_size: units !== null && baskets && baskets > 0 ? units / baskets : null,
    };
  };
  const [latest, ...trailing] = rows.map(derive);
  return {
    entity: 'sales',
    batch_day: rows[0].obs_date,
    batch_volume: latest.volume,
    batch_unit_price: latest.unit_price,
    batch_basket_size: latest.basket_size,
    trailing: {
      median_daily_volume: median(trailing.map((t) => t.volume)),
      median_unit_price: median(trailing.map((t) => t.unit_price)),
      median_basket_size: median(trailing.map((t) => t.basket_size)),
      observations: trailing.length,
    },
  };
}

/** The local calendar day, never toISOString() - a +05:30 box would shift it. */
function todayLocal(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Everything quality_eval.py needs for one store. Pure given its inputs, so
 * the verify test can hand it a canned history and no syncgo.
 */
function buildPayload({ clientId, locationId, asOf, syncState, history, anomaly,
  frontiers = null }) {
  const connector = (syncState.find((s) => s.connector) || {}).connector || null;
  const notes = [];
  const freshness = syncState.map((s) => {
    const entity = String(s.entity).toLowerCase();
    let last = s.last_successful_sync
      ? new Date(s.last_successful_sync).toISOString() : null;
    // AN ESSENTIAL FEED IS JUDGED ON THE DATA, not on whether a job ran. See
    // dataFrontiersFor: a `localdb` store records no sync at all, and calling
    // that "never synced" refused 182 of 211 stores on QA while their sales
    // tables held a year of data.
    const frontier = frontiers && frontiers[entity];
    if (!last && frontier) {
      last = frontier.toISOString();
      notes.push(`${entity}_freshness_from_data_frontier`);
    }
    return {
      entity: s.entity,
      last_successful_sync: last,
      recent_syncs: (history.byEntity.get(s.entity) || [])
        .map((d) => new Date(d).toISOString()),
    };
  });
  if (history.error) notes.push(`sync_history_unavailable:${history.error}`);
  const payload = {
    client_id: clientId, location_id: locationId, connector, as_of: asOf,
    freshness, notes,
  };
  if (anomaly) payload.anomaly = anomaly;
  return payload;
}

// ─── Evaluate and persist ────────────────────────────────────────────────────

async function runPython(payload) {
  const tmp = path.join(
    os.tmpdir(), `quality-${payload.client_id}-${payload.location_id}-${process.pid}.json`
  );
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  try {
    const { stdout } = await python.runScript(RUNNER, [tmp]);
    return JSON.parse(stdout);
  } finally {
    fs.unlinkSync(tmp);
  }
}

/**
 * Upsert the store's row and append one audit row per gate run.
 *
 * The audit rows are the answer to "why did I get nothing today" - with a
 * field name and a number in it - and they are written FIRST, so a crash
 * between the two leaves evidence without a verdict rather than a verdict
 * without evidence.
 */
async function persistVerdict(analyticsPool, verdict) {
  const batch = `daily:${verdict.as_of}`;
  for (const g of verdict.gates || []) {
    await analyticsPool.query(
      `INSERT INTO data_quality_results
         (client_id, location_id, batch, connector, entity, gate, verdict,
          detail, stage_version, contract_key, checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10, now())`,
      [verdict.client_id, verdict.location_id, batch, verdict.connector,
        g.entity || null, g.gate, g.verdict, JSON.stringify(g.detail || {}),
        g.stage_version || null, g.contract_key || null]
    );
  }
  await analyticsPool.query(
    `INSERT INTO store_quality_state
       (client_id, location_id, connector, verdict, unavailable_fields,
        staleness_days, median_interval_days, never_synced, reasons,
        gate_detail, checked_at, updated_at)
     VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8,$9::text[],$10::jsonb, now(), now())
     ON CONFLICT (client_id, location_id) DO UPDATE SET
       connector = EXCLUDED.connector,
       verdict = EXCLUDED.verdict,
       unavailable_fields = EXCLUDED.unavailable_fields,
       staleness_days = EXCLUDED.staleness_days,
       median_interval_days = EXCLUDED.median_interval_days,
       never_synced = EXCLUDED.never_synced,
       reasons = EXCLUDED.reasons,
       gate_detail = EXCLUDED.gate_detail,
       checked_at = now(),
       updated_at = now()`,
    [verdict.client_id, verdict.location_id, verdict.connector, verdict.verdict,
      verdict.unavailable_fields || [],
      // null stays null. A never-synced store is not "0 days stale".
      verdict.staleness_days ?? null, verdict.median_interval_days ?? null,
      Boolean(verdict.never_synced), verdict.reasons || [],
      JSON.stringify(verdict.gate_detail || {})]
  );
}

/**
 * One store, end to end. `history` may be injected (tests, or a caller that
 * batched the syncgo read); otherwise it is fetched per store.
 */
async function evaluateStore(pools, { clientId, locationId }, opts = {}) {
  const asOf = opts.asOf || todayLocal();
  const syncState = await syncStateFor(pools.analytics, clientId, locationId);
  if (!syncState.length) {
    // No state row at all: the ingestion digest has never seen this store.
    // Nothing to judge, and NOT a pass - the row is simply not written, and
    // the serving path keeps reading `unknown`.
    return { skipped: 'no_sync_state', clientId, locationId };
  }
  const history = opts.history
    || await syncHistoryFor(pools.syncgo, clientId, locationId);
  const sales = syncState.find((s) => s.entity === 'sales' || s.entity === 'sale_items');
  // The newest sale we actually hold. Read only when the sync log cannot speak
  // for sales, so a store with a working sync job costs nothing extra.
  const products = syncState.find((s) => String(s.entity).toLowerCase() === 'products');
  const needFrontier = (sales && !sales.last_successful_sync)
    || (products && !products.last_successful_sync);
  const frontiers = opts.frontiers !== undefined ? opts.frontiers
    : (needFrontier
      ? await dataFrontiersFor(pools.syncgo, clientId, locationId)
      : null);
  const salesFrontier = frontiers ? frontiers.sales : null;
  // The anomaly window follows the same evidence: with no sync timestamp the
  // frontier is the only honest "as of" for this store's sales.
  const salesAsOf = (sales && sales.last_successful_sync)
    ? todayLocal(new Date(sales.last_successful_sync))
    : (salesFrontier ? todayLocal(salesFrontier) : null);
  const anomaly = opts.anomaly !== undefined ? opts.anomaly
    : await anomalyInputFor(pools.analytics, clientId, locationId, salesAsOf);

  const payload = buildPayload({ clientId, locationId, asOf, syncState, history,
    anomaly, frontiers });
  const verdict = await runPython(payload);
  if (!opts.dryRun) await persistVerdict(pools.analytics, verdict);
  return { verdict, payload };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main(argv = process.argv.slice(2)) {
  const { dryRun, pair } = parseArgs(argv);
  const analytics = getAnalyticsPool();

  const ready = await analytics.query(
    `SELECT to_regclass('public.store_quality_state') IS NOT NULL
        AND to_regclass('public.sync_store_state')   IS NOT NULL AS ok`
  );
  if (!ready.rows[0].ok) {
    console.error('store_quality_state / sync_store_state are missing. Run: npm run migrate');
    process.exit(1);
  }

  // syncgo is probed ONCE. If it is down, every store is evaluated without
  // history and the run says so once at the top, not 900 times.
  let syncgo = getPool();
  let historyError = null;
  try {
    await syncgo.query('SELECT 1');
  } catch (err) {
    historyError = err.message;
    syncgo = null;
    console.error(`syncgo unreachable (${err.message}); cadence falls back to the `
      + 'connector default for every store, and each row says so.');
  }

  const stores = await storesInScope(analytics, pair);
  if (!stores.length) {
    console.log('No store has a sync state row yet. The 03:00 ingestion digest '
      + 'builds that table; run it first (or wait for it).');
    process.exit(0);
  }

  const counts = { pass: 0, degraded: 0, quarantine: 0, reject: 0, skipped: 0, failed: 0 };
  for (const { client_id: clientId, location_id: locationId } of stores) {
    try {
      const result = await evaluateStore({ analytics, syncgo }, { clientId, locationId }, {
        dryRun,
        history: syncgo ? undefined : { byEntity: new Map(), error: historyError },
      });
      if (result.skipped) {
        counts.skipped += 1;
        continue;
      }
      const v = result.verdict;
      counts[v.verdict] = (counts[v.verdict] || 0) + 1;
      const stale = v.staleness_days === null || v.staleness_days === undefined
        ? 'never' : `${Number(v.staleness_days).toFixed(1)}d`;
      const cadence = v.median_interval_days === null || v.median_interval_days === undefined
        ? '-' : `${Number(v.median_interval_days).toFixed(1)}d`;
      console.log(
        `  ${String(`${clientId}:${locationId}`).padEnd(12)}`
        + `${String(v.connector || '?').padEnd(10)}${v.verdict.padEnd(11)}`
        + `stale=${stale.padEnd(8)}cadence=${cadence.padEnd(7)}`
        + `${(v.reasons || []).slice(0, 3).join(' ')}`
      );
    } catch (err) {
      counts.failed += 1;
      console.error(`  ${clientId}:${locationId} FAILED - ${err.message}`);
    }
  }

  console.log('');
  console.log(
    `${stores.length} store(s): ${counts.pass} pass, ${counts.degraded} degraded, `
    + `${counts.quarantine} quarantine, ${counts.reject} reject, `
    + `${counts.skipped} skipped, ${counts.failed} failed`
    + (dryRun ? ' (dry run - nothing written)' : '')
  );
  process.exit(counts.failed && counts.failed === stores.length ? 1 : 0);
}

module.exports = {
  SYNC_HISTORY_DAYS,
  anomalyInputFor,
  buildPayload,
  dataFrontiersFor,
  evaluateStore,
  persistVerdict,
  syncHistoryFor,
  syncStateFor,
  todayLocal,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
