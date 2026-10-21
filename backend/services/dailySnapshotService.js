/**
 * Daily snapshot service - the day-grain capture layer (analytics migrations
 * 014 + 015).
 *
 * Three tables, three different durability rules, and the differences are
 * deliberate:
 *
 *   daily_store_recommendations  written INSIDE recommendationService's run
 *       transaction. The day archive and the run rows must never disagree
 *       about what was recommended on a day, so they commit together or not
 *       at all.
 *
 *   daily_store_signals          written AFTER that commit, best-effort. A
 *       failure to record what the weather was must not throw away a
 *       successfully generated set of recommendations. The row is missing,
 *       which is visible and recoverable; the alternative is losing the
 *       recommendations, which is neither.
 *
 *   signal_source_payloads       written after the commit too, and keyed by
 *       GEOGRAPHY rather than by store. A thousand stores on one NWS
 *       gridpoint share one row per day. Upsert-on-conflict means the
 *       hundredth store to report the same payload is a cheap no-op rather
 *       than a duplicate.
 *
 * DATES ARE STRINGS HERE, ALWAYS.
 * node-postgres parses a Postgres `date` into a JS Date at local midnight, so
 * a row stored as 2026-09-22 reads back as 2026-09-21T18:30:00Z on an IST
 * machine and `.toISOString().slice(0,10)` then yields the WRONG DAY. That is
 * not hypothetical - the rec-eval fixtures already carry a comment about it.
 * Every date crossing this module's boundary is a 'YYYY-MM-DD' string, and
 * every SELECT casts with ::text so nothing can re-introduce the parse.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const { toInt, toNumber } = require('../utils/numbers');

// ─── Schema probes ───────────────────────────────────────────────────────────
// Probe-and-degrade, the house pattern (see recommendationEvalService's
// referenceUpcColumnExists): a Node deploy that reaches a database where
// migrations 014/015 have not run yet must keep generating recommendations and
// simply skip the capture, not 500. A positive result is cached forever (DDL
// does not un-apply); a negative is retried periodically so capture starts
// working the moment the migration lands, without a restart.
const PROBE_RETRY_MS = 60_000;

function makeProbe(runProbe) {
  let cached = null; // { value, at } | in-flight promise
  const probe = (pool) => {
    if (cached && typeof cached.then === 'function') return cached;
    if (cached && (cached.value === true || Date.now() - cached.at < PROBE_RETRY_MS)) {
      return Promise.resolve(cached.value);
    }
    const p = runProbe(pool)
      .then((value) => { cached = { value, at: Date.now() }; return value; })
      .catch((err) => { cached = null; throw err; });
    cached = p;
    return p;
  };
  probe.reset = () => { cached = null; };
  return probe;
}

/** migration 015 - the day-grain recommendation archive. */
const dailyRecTableExists = makeProbe((pool) =>
  pool
    .query("SELECT to_regclass('public.daily_store_recommendations') IS NOT NULL AS ready")
    .then((r) => r.rows[0].ready)
);

/** migration 014 - both signal-capture tables. */
const signalTablesExist = makeProbe((pool) =>
  pool
    .query(
      `SELECT to_regclass('public.daily_store_signals')    IS NOT NULL
          AND to_regclass('public.signal_source_payloads') IS NOT NULL AS ready`
    )
    .then((r) => r.rows[0].ready)
);

/** migration 015 - rec_date/day_basis/timezone on recommendation_runs. */
const runDayColumnsExist = makeProbe((pool) =>
  pool
    .query(
      `SELECT count(*) = 3 AS ready FROM information_schema.columns
        WHERE table_name = 'recommendation_runs'
          AND column_name IN ('rec_date', 'day_basis', 'timezone')`
    )
    .then((r) => r.rows[0].ready)
);

// ─── Day keys ────────────────────────────────────────────────────────────────

/**
 * The store's own calendar date for an instant.
 *
 * Why not just `generated_at::date`: the rec cron runs at 04:00, which is the
 * PREVIOUS evening in every US timezone. Keying on UTC (or on whatever zone
 * the server happens to run in) labels Tuesday's recommendations "Wednesday"
 * for the entire network, and silently changes meaning when the server moves
 * region. The store's own day is the only definition an owner would recognise.
 *
 * @param {Date|string} instant   when the run/gather happened
 * @param {string|null} timeZone  IANA zone for the store (NWS reports it for
 *                                the store's gridpoint); null when unknown
 * @returns {{ date: string, basis: 'store_local'|'utc', timezone: string|null }}
 */
function resolveDayKey(instant, timeZone) {
  const at = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(at.getTime())) {
    // An unparseable timestamp must not produce a plausible-looking wrong day.
    throw new TypeError(`resolveDayKey: invalid instant ${JSON.stringify(instant)}`);
  }
  if (timeZone) {
    try {
      // 'en-CA' formats as YYYY-MM-DD, which is the shape we need anyway.
      const date = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(at);
      // Guard against a locale returning something unexpected rather than
      // writing a malformed key into a primary key column.
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { date, basis: 'store_local', timezone: timeZone };
      }
      logger.warn(`[DailySnapshot] unexpected date format for zone ${timeZone}: ${date}`);
    } catch {
      // An unknown/misspelled IANA zone throws in the Intl constructor. Fall
      // through to UTC rather than failing the capture - a UTC-keyed row that
      // SAYS it is UTC-keyed is strictly better than no row.
      logger.warn(`[DailySnapshot] unusable timezone ${JSON.stringify(timeZone)}, falling back to UTC`);
    }
  }
  return { date: at.toISOString().slice(0, 10), basis: 'utc', timezone: null };
}

// ─── Small helpers ───────────────────────────────────────────────────────────

/** Key-sorted JSON, so an unchanged payload always hashes the same. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const sha256 = (value) => crypto.createHash('sha256').update(canonical(value)).digest('hex');

/** Entries in a full bundle: weather counts as one, the rest by length. */
function countSignals(bundle) {
  if (!bundle || typeof bundle !== 'object') return 0;
  let n = bundle.weather ? 1 : 0;
  for (const field of ['sports', 'events', 'holidays', 'news', 'social']) {
    if (Array.isArray(bundle[field])) n += bundle[field].length;
  }
  return n;
}

/**
 * Roll per-source health up into the three counters.
 *
 * `dormant` is checked FIRST and is not a failure: a source with no API key
 * configured (Reddit, YouTube) is working as intended, and counting it as
 * broken would make every store look degraded forever.
 */
function summarizeHealth(health) {
  let ok = 0, failed = 0, dormant = 0;
  for (const entry of Object.values(health || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.dormant) dormant += 1;
    else if (entry.ok === false) failed += 1;
    else if (entry.ok === true) ok += 1;
  }
  return { ok, failed, dormant };
}

const asStringArray = (value) =>
  Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];

const asDateString = (value) => {
  if (!value) return null;
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
};

// Shared primitive, NOT a local Number() check: Number(null) and Number('')
// are both 0, so the obvious version turns an absent token count into a
// confident "0 tokens used". See utils/numbers.js.
const asInt = toInt;

// ─── daily_store_signals ─────────────────────────────────────────────────────

/**
 * Upsert one store's signal cell for one day.
 *
 * Upsert, not append: a day is a cell. A second run on the same day replaces
 * the bundle and bumps capture_count, so re-running never produces two
 * near-identical rows to disambiguate later, and never loses the fact that it
 * happened twice.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {object} capture
 * @param {number} capture.clientId
 * @param {number} capture.locationId
 * @param {string} capture.signalDate    'YYYY-MM-DD', store-local
 * @param {string} capture.dayBasis      'store_local' | 'utc'
 * @param {string|null} capture.timezone
 * @param {object} capture.bundle        the FULL SignalBundle when available
 * @param {'full'|'display_trimmed'} capture.fidelity
 */
async function persistDailySignals(db, capture) {
  const bundle = capture.bundle && typeof capture.bundle === 'object' ? capture.bundle : {};
  const health = capture.sourceHealth && typeof capture.sourceHealth === 'object'
    ? capture.sourceHealth : {};
  const counts = summarizeHealth(health);
  const fidelity = capture.fidelity === 'full' ? 'full' : 'display_trimmed';

  await db.query(
    `INSERT INTO daily_store_signals (
       client_id, location_id, signal_date, day_basis, timezone,
       bundle, bundle_fidelity, display_snapshot,
       active_keys, news_categories, news_product_keywords,
       event_categories, trend_categories, trend_product_keywords,
       source_health, source_geo_keys,
       sources_ok, sources_failed, sources_dormant, signal_count,
       latitude, longitude, state, geo_source, bundle_sha256, engine_version)
     VALUES ($1,$2,$3::date,$4,$5,
             $6::jsonb,$7,$8::jsonb,
             $9,$10,$11,$12,$13,$14,
             $15::jsonb,$16::jsonb,
             $17,$18,$19,$20,
             $21,$22,$23,$24,$25,$26)
     ON CONFLICT (client_id, location_id, signal_date) DO UPDATE SET
       day_basis              = EXCLUDED.day_basis,
       timezone               = EXCLUDED.timezone,
       bundle                 = EXCLUDED.bundle,
       bundle_fidelity        = EXCLUDED.bundle_fidelity,
       display_snapshot       = EXCLUDED.display_snapshot,
       active_keys            = EXCLUDED.active_keys,
       news_categories        = EXCLUDED.news_categories,
       news_product_keywords  = EXCLUDED.news_product_keywords,
       event_categories       = EXCLUDED.event_categories,
       trend_categories       = EXCLUDED.trend_categories,
       trend_product_keywords = EXCLUDED.trend_product_keywords,
       source_health          = EXCLUDED.source_health,
       source_geo_keys        = EXCLUDED.source_geo_keys,
       sources_ok             = EXCLUDED.sources_ok,
       sources_failed         = EXCLUDED.sources_failed,
       sources_dormant        = EXCLUDED.sources_dormant,
       signal_count           = EXCLUDED.signal_count,
       latitude               = EXCLUDED.latitude,
       longitude              = EXCLUDED.longitude,
       state                  = EXCLUDED.state,
       geo_source             = EXCLUDED.geo_source,
       bundle_sha256          = EXCLUDED.bundle_sha256,
       engine_version         = EXCLUDED.engine_version,
       captured_at            = now(),
       -- first_captured_at is never overwritten: it is the one fact an
       -- upsert would otherwise destroy.
       capture_count          = daily_store_signals.capture_count + 1`,
    [
      capture.clientId, capture.locationId, capture.signalDate,
      capture.dayBasis === 'store_local' ? 'store_local' : 'utc',
      capture.dayBasis === 'store_local' ? (capture.timezone || null) : null,
      JSON.stringify(bundle), fidelity,
      capture.displaySnapshot ? JSON.stringify(capture.displaySnapshot) : null,
      asStringArray(bundle.active_keys),
      asStringArray(bundle.news_categories),
      asStringArray(bundle.news_product_keywords),
      asStringArray(bundle.event_categories),
      asStringArray(bundle.trend_categories),
      asStringArray(bundle.trend_product_keywords),
      JSON.stringify(health),
      JSON.stringify(capture.sourceGeoKeys || {}),
      counts.ok, counts.failed, counts.dormant, countSignals(bundle),
      Number.isFinite(capture.latitude) ? capture.latitude : null,
      Number.isFinite(capture.longitude) ? capture.longitude : null,
      capture.state || null,
      ['profile', 'geocoded', 'none'].includes(capture.geoSource) ? capture.geoSource : null,
      sha256(bundle),
      capture.engineVersion || null,
    ]
  );
}

// ─── signal_source_payloads ──────────────────────────────────────────────────

/**
 * Upsert raw upstream responses, deduplicated by the geography that determines
 * them.
 *
 * Every store in a gridpoint reports the same weather payload, so the second
 * through thousandth writes are conflicts by design. `capture_count` records
 * how many times a payload was re-observed, which is a useful fan-out signal
 * in its own right ("this gridpoint serves 340 stores").
 *
 * Rows are validated individually and a bad one is SKIPPED, not fatal: this is
 * observability data, and one malformed record must not cost the rest of the
 * day's capture.
 *
 * @returns {{ written: number, skipped: number }}
 */
async function persistSourcePayloads(db, rows) {
  let written = 0, skipped = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const source = typeof row?.source === 'string' ? row.source.trim() : '';
    const scope = row?.geoScope;
    const fetchDate = asDateString(row?.fetchDate);
    if (!source || !['global', 'state', 'gridpoint', 'latlon', 'store'].includes(scope) || !fetchDate) {
      skipped += 1;
      continue;
    }
    const payload = row.payload === undefined ? null : row.payload;
    const text = payload === null ? null : JSON.stringify(payload);
    try {
      await db.query(
        `INSERT INTO signal_source_payloads (
           source, geo_scope, geo_key, fetch_date,
           payload, payload_sha256, payload_bytes, item_count,
           ok, http_status, latency_ms, error)
         VALUES ($1,$2,$3,$4::date,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (source, geo_scope, geo_key, fetch_date) DO UPDATE SET
           payload        = EXCLUDED.payload,
           payload_sha256 = EXCLUDED.payload_sha256,
           payload_bytes  = EXCLUDED.payload_bytes,
           item_count     = EXCLUDED.item_count,
           ok             = EXCLUDED.ok,
           http_status    = EXCLUDED.http_status,
           latency_ms     = EXCLUDED.latency_ms,
           error          = EXCLUDED.error,
           captured_at    = now(),
           capture_count  = signal_source_payloads.capture_count + 1`,
        [
          source, scope, typeof row.geoKey === 'string' ? row.geoKey : '', fetchDate,
          text, payload === null ? null : sha256(payload),
          text === null ? null : Buffer.byteLength(text, 'utf8'),
          asInt(row.itemCount), row.ok !== false,
          asInt(row.httpStatus), asInt(row.latencyMs),
          row.error ? String(row.error).slice(0, 2000) : null,
        ]
      );
      written += 1;
    } catch (err) {
      skipped += 1;
      logger.warn(`[DailySnapshot] raw payload ${source}/${scope}/${row.geoKey} skipped: ${err.message}`);
    }
  }
  return { written, skipped };
}

// ─── daily_store_recommendations ─────────────────────────────────────────────

/**
 * Upsert one store's recommendation cell for one day.
 *
 * MUST be called with the same client/transaction that wrote the run rows -
 * the archive and the run tables agreeing about a day is the property this
 * table exists to provide.
 *
 * @param {import('pg').PoolClient} client  in-transaction client
 * @param {object} day
 * @param {Array<object>} day.recommendations  rank-ordered, each with its
 *        persisted `recommendations.id` so per-rec outcomes join back
 */
async function persistDailyRecommendations(client, day) {
  const recs = Array.isArray(day.recommendations) ? day.recommendations : [];
  const shown = recs.filter((r) => r.status !== 'holdout');
  const categories = [...new Set(recs.map((r) => r.category).filter(Boolean))].sort();
  const actionTypes = [...new Set(recs.map((r) => r.action_type).filter(Boolean))].sort();
  const engine = day.engine || {};

  await client.query(
    `INSERT INTO daily_store_recommendations (
       client_id, location_id, rec_date, day_basis, timezone,
       run_id, signal_date, generated_at, data_as_of,
       recommendations, candidate_count, recommendation_count,
       shown_count, holdout_count, dropped_invalid,
       categories, action_types,
       engine_version, model, prompt_version,
       llm_input_tokens, llm_output_tokens, llm_cost_usd, latency_ms,
       recommendations_sha256)
     VALUES ($1,$2,$3::date,$4,$5,
             $6,$7::date,$8,$9::date,
             $10::jsonb,$11,$12,
             $13,$14,$15,
             $16,$17,
             $18,$19,$20,
             $21,$22,$23,$24,
             $25)
     ON CONFLICT (client_id, location_id, rec_date) DO UPDATE SET
       day_basis              = EXCLUDED.day_basis,
       timezone               = EXCLUDED.timezone,
       run_id                 = EXCLUDED.run_id,
       signal_date            = EXCLUDED.signal_date,
       generated_at           = EXCLUDED.generated_at,
       data_as_of             = EXCLUDED.data_as_of,
       recommendations        = EXCLUDED.recommendations,
       candidate_count        = EXCLUDED.candidate_count,
       recommendation_count   = EXCLUDED.recommendation_count,
       shown_count            = EXCLUDED.shown_count,
       holdout_count          = EXCLUDED.holdout_count,
       dropped_invalid        = EXCLUDED.dropped_invalid,
       categories             = EXCLUDED.categories,
       action_types           = EXCLUDED.action_types,
       engine_version         = EXCLUDED.engine_version,
       model                  = EXCLUDED.model,
       prompt_version         = EXCLUDED.prompt_version,
       llm_input_tokens       = EXCLUDED.llm_input_tokens,
       llm_output_tokens      = EXCLUDED.llm_output_tokens,
       llm_cost_usd           = EXCLUDED.llm_cost_usd,
       latency_ms             = EXCLUDED.latency_ms,
       recommendations_sha256 = EXCLUDED.recommendations_sha256,
       capture_count          = daily_store_recommendations.capture_count + 1`,
    [
      day.clientId, day.locationId, day.recDate,
      day.dayBasis === 'store_local' ? 'store_local' : 'utc',
      day.dayBasis === 'store_local' ? (day.timezone || null) : null,
      day.runId ?? null, day.signalDate || null, day.generatedAt, day.dataAsOf || null,
      JSON.stringify(recs), asInt(day.candidateCount) ?? 0, recs.length,
      shown.length, recs.length - shown.length, asInt(day.droppedInvalid) ?? 0,
      categories, actionTypes,
      engine.version || null, engine.model || null, engine.prompt_version || null,
      asInt(engine.input_tokens), asInt(engine.output_tokens),
      toNumber(engine.cost_usd),
      asInt(engine.latency_ms),
      sha256(recs),
    ]
  );
}

// ─── Best-effort capture from a completed run ────────────────────────────────

/**
 * Record the signal side of a run: the store's daily cell plus any raw
 * upstream payloads the Python service reported.
 *
 * Deliberately NEVER throws. This is called after the run transaction has
 * committed, and a failure to record what the weather was must not surface as
 * a failed recommendation run. Returns a small summary for logging.
 *
 * @param {import('pg').Pool} analyticsPool
 * @param {object} run  the RunResult, whose `signal_capture` the Python
 *                      service fills (absent on a service that predates it,
 *                      in which case the trimmed snapshot is stored and
 *                      honestly marked 'display_trimmed')
 * @param {{date: string, basis: string, timezone: string|null}} day
 */
async function captureSignalsForRun(analyticsPool, run, day) {
  try {
    if (!(await signalTablesExist(analyticsPool))) return { skipped: 'no_tables' };

    const capture = run.signal_capture || {};
    // Full bundle when the service reports one; otherwise the display-trimmed
    // snapshot, stored under its true name so nothing downstream mistakes a
    // ten-chip view for the engine's whole input.
    const hasFull = capture.bundle && typeof capture.bundle === 'object';
    const bundle = hasFull ? capture.bundle : (run.signal_snapshot ?? {});

    await persistDailySignals(analyticsPool, {
      clientId: run.client_id,
      locationId: run.location_id,
      signalDate: capture.signal_date || day.date,
      dayBasis: capture.signal_date ? (capture.day_basis || day.basis) : day.basis,
      timezone: capture.timezone || day.timezone,
      bundle,
      fidelity: hasFull ? 'full' : 'display_trimmed',
      displaySnapshot: run.signal_snapshot ?? null,
      sourceHealth: capture.source_health || {},
      sourceGeoKeys: capture.source_geo_keys || {},
      latitude: capture.latitude,
      longitude: capture.longitude,
      state: capture.state,
      geoSource: capture.geo_source,
      engineVersion: run.engine?.version || null,
    });

    const raw = await persistSourcePayloads(
      analyticsPool,
      (capture.raw_payloads || []).map((p) => ({
        source: p.source,
        geoScope: p.geo_scope,
        geoKey: p.geo_key,
        fetchDate: p.fetch_date || day.date,
        payload: p.payload,
        itemCount: p.item_count,
        ok: p.ok,
        httpStatus: p.http_status,
        latencyMs: p.latency_ms,
        error: p.error,
      }))
    );
    return { fidelity: hasFull ? 'full' : 'display_trimmed', raw };
  } catch (err) {
    logger.warn(
      `[DailySnapshot] signal capture failed for client=${run.client_id} ` +
      `location=${run.location_id} day=${day.date}: ${err.message}`
    );
    return { error: err.message };
  }
}

module.exports = {
  resolveDayKey,
  persistDailySignals,
  persistSourcePayloads,
  persistDailyRecommendations,
  captureSignalsForRun,
  dailyRecTableExists,
  signalTablesExist,
  runDayColumnsExist,
  _resetProbes: () => {
    dailyRecTableExists.reset();
    signalTablesExist.reset();
    runDayColumnsExist.reset();
  },
  // exported for tests
  _internals: { canonical, sha256, countSignals, summarizeHealth },
};
