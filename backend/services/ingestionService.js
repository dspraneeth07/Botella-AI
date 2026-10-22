/**
 * Ingestion control plane - durability, isolation, classification, aggregation.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *   It is NOT a POS connector. The fetching is done by an external service
 *   (the errors in job_runs_history are stamped 'CloverService',
 *   'GokulService', 'POS service message'), which writes the syncgo warehouse.
 *   This Node backend has SELECT-only access there, by design.
 *
 *   This module is the control plane AROUND that: the durable raw log a
 *   fetcher lands into before parsing, the failure classifier, the per-store
 *   batch runner that stops one store sinking a run, the staleness marker
 *   downstream stages refuse on, and the connector-level digest.
 *
 *   services/integrationService.js is a different thing entirely - the
 *   Python-facing READ API. Nothing here touches it.
 *
 * WHY IT EXISTS
 *   Ingestion works; it lacks isolation and replay. 25.5% of all sync runs
 *   fail (132,611 of 519,702 on the live warehouse). At 94 stores a person
 *   reads those. At 1,500 they are background noise and stores go dark while
 *   the engine keeps serving stale data with full confidence.
 *
 *   The failure corpus says the fix belongs at the connector, not the store.
 *   Measured on the live warehouse, ~92% of failures are two conditions that
 *   will never resolve by retrying:
 *     ~27,000  Clover   "Status: 401 Unauthorized"        - dead credential
 *     ~15,000  EPOSNow  "Status: 403 Forbidden"           - dead credential
 *     ~12,600  Gokul/Clover "Service 'X' does not implement method 'Y'"
 *                                                          - capability gap
 *   Those are four bad merchant tokens and two connectors missing an entity.
 *   Six tickets, retried a hundred thousand times.
 *
 * TWO POOLS, NOT INTERCHANGEABLE
 *   analyticsPool → sync_raw_log / sync_store_state / sync_connector_digest
 *   syncgoPool    → job_runs_history / jobs / client_pos_config / products
 *                   (read-only; the source of truth for what actually synced)
 *
 * Tenancy (house rule): every query filters on BOTH client_id AND location_id.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

// ─── Tunables ────────────────────────────────────────────────────────────────
// Sheet 00's rule 3 says thresholds are declared with an owner and a reason.
// The registry is Python-side; until a Node mirror exists these carry the same
// discipline in comments and are env-overridable.

/** Consecutive failures before a job is disabled and ONE ticket is raised. */
const DEAD_AFTER_FAILURES = parseInt(process.env.SYNC_DEAD_AFTER || '5', 10);

/** Max attempts for a transient failure, including the first. */
const MAX_TRANSIENT_ATTEMPTS = parseInt(process.env.SYNC_MAX_RETRIES || '3', 10);

/** Backoff base; attempt n waits base * 2^(n-1), jittered. */
const BACKOFF_BASE_MS = parseInt(process.env.SYNC_BACKOFF_BASE_MS || '1000', 10);

/**
 * Days after which a store counts as stale in the digest.
 * Not a refusal threshold - sheet 02 owns that decision and reads the raw
 * `days_stale`. This only decides what the digest highlights.
 */
const STALE_AFTER_DAYS = parseInt(process.env.SYNC_STALE_AFTER_DAYS || '2', 10);

/** Exemplars carried on a digest row, so the one ticket has something in it. */
const DIGEST_EXEMPLARS = 5;

// ─── 1. Failure classification ───────────────────────────────────────────────

const FAILURE_CLASSES = Object.freeze(['transient', 'credential', 'schema', 'dead']);

/**
 * Patterns are ordered: the FIRST match wins, so the specific ones come before
 * the general ones. Every pattern here was taken from a real, counted failure
 * in job_runs_history - none is speculative.
 */
const CLASSIFIERS = [
  // ── credential ─────────────────────────────────────────────────────────
  // The single biggest bucket. A 401/403 will not fix itself, and retrying it
  // three times an hour for a month is how 27,000 identical rows happen.
  // Notify the store, do not retry.
  { cls: 'credential', re: /\b(401|403)\b|unauthoriz|forbidden|invalid[_ ]?(api[_ ]?key|token|credential)|authentication fail|access[_ ]denied|token (has )?expired|invalid_grant/i },

  // ── schema ─────────────────────────────────────────────────────────────
  // The payload shape or the connector's capability changed. Page the
  // connector owner; no per-store action exists.
  // "Service 'GokulService' does not implement method 'ProcessSupplier'" is
  // the dominant real case: the job should never have been scheduled.
  { cls: 'schema', re: /does not implement method|invalid entity|unknown (field|column|entity)|missing (required )?(field|column|property)|cannot deserialize|unexpected (token|character) .* json|schema (mismatch|error)|no such (field|column)/i },

  // ── transient ──────────────────────────────────────────────────────────
  // Genuinely worth a retry: the network, a rate limit, a 5xx, a lock.
  { cls: 'transient', re: /\b(408|429|500|502|503|504)\b|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|rate.?limit|too many requests|temporarily unavailable|deadlock|lock timeout|connection (reset|refused|closed)/i },

  // ── dead ───────────────────────────────────────────────────────────────
  // The endpoint or the account is gone. Nothing to retry, nothing to fix at
  // the store: disable and raise one ticket.
  { cls: 'dead', re: /\b(404|410)\b|not found|merchant (not found|disabled|closed)|account (closed|terminated|suspended)|no longer (exists|available)|gone/i },
];

/**
 * Classify a failure into the one action that should follow it.
 *
 *   transient  → retry with exponential backoff, max MAX_TRANSIENT_ATTEMPTS
 *   credential → mark the store, notify it, do NOT retry
 *   schema     → page the connector owner, the payload shape changed
 *   dead       → after N consecutive failures disable the job, ONE ticket
 *
 * Accepts an Error, a string, or a raw job_runs_history.result blob.
 *
 * `result` in the warehouse is a multi-LINE job log, not an error message -
 * it opens with "Start | Processing job for ClientId=..." and the actual
 * cause is on the last line ("Summary | POS service message: ... Status: 401
 * Unauthorized"). Matching the whole blob would classify every failure by its
 * preamble, so the tail is weighted first.
 *
 * Unrecognised failures return 'transient'. That is the deliberate default:
 * being wrong toward retry costs three attempts and a log line, while being
 * wrong toward 'dead' silently disables a healthy store's sync.
 *
 * @param {Error|string|{message?:string, result?:string, code?:string, status?:number}} err
 * @returns {'transient'|'credential'|'schema'|'dead'}
 */
function classifyFailure(err) {
  const text = failureText(err);
  if (!text) return 'transient';

  // The cause lives at the end of a multi-line job log. Try the tail first so
  // a preamble can never outvote the actual error.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-3).join('\n');

  for (const candidate of [tail, text]) {
    for (const { cls, re } of CLASSIFIERS) {
      if (re.test(candidate)) return cls;
    }
  }
  return 'transient';
}

/** Pull something matchable out of whatever the caller had. */
function failureText(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  const parts = [];
  // Numeric status first: an Error carrying { status: 401 } and no useful
  // message must still classify as a credential problem.
  if (err.status != null) parts.push(`${err.status}`);
  if (err.statusCode != null) parts.push(`${err.statusCode}`);
  if (err.code) parts.push(String(err.code));
  if (err.message) parts.push(String(err.message));
  if (err.result) parts.push(String(err.result));
  return parts.join(' ');
}

/** Should this class be retried at all? Only transient. */
const isRetryable = (cls) => cls === 'transient';

// ─── 2. The durable raw log ──────────────────────────────────────────────────

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Key-sorted JSON. (Same idea as dailySnapshotService's `canonical`; kept
 * local rather than shared so the two services stay independent.)
 *
 * The hash MUST be computed over this rather than over the bytes as they
 * arrived, because `payload` is stored as jsonb and **Postgres jsonb does not
 * preserve key order**. A payload landed as {"zebra":1,"alpha":2} reads back
 * as {"alpha":2,"zebra":1}. Hashing the original bytes would therefore
 * produce a digest that can never be re-verified against the stored row -
 * the integrity check would be broken the moment you tried to use it.
 *
 * Hashing the canonical form also makes DEDUPE mean the right thing: if a POS
 * reorders its JSON keys between two otherwise identical fetches, that is the
 * same document and must not become a second row. We are asking "did the data
 * change", not "did the vendor's serializer change".
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * Land a fetch AS RECEIVED, before any parsing.
 *
 * Replay then becomes reading a row instead of re-fetching from a POS that may
 * no longer hold the data - and a parser bug becomes repairable for history
 * instead of permanent.
 *
 * Identical bytes for the same connector+store+entity are RECORDED, not
 * duplicated: the first landing wins and fetch_count increments. Most syncs
 * change nothing, so storing each one would multiply the table by the sync
 * frequency for no information.
 *
 * @returns {{id:number, payload_sha256:string, deduped:boolean, bytes:number}}
 */
async function landRawPayload(analyticsPool, {
  connector, clientId, locationId, entity, payload, fetchedAt = null,
}) {
  const normConnector = normalizeConnector(connector);
  if (!normConnector) throw new TypeError('landRawPayload: connector is required');
  if (!Number.isInteger(clientId) || !Number.isInteger(locationId)) {
    throw new TypeError('landRawPayload: clientId and locationId must be integers');
  }
  const normEntity = String(entity || '').trim().toLowerCase();
  if (!normEntity) throw new TypeError('landRawPayload: entity is required');

  // `text` is what gets stored (jsonb will normalise it anyway); `digest` is
  // over the CANONICAL form so it survives that normalisation and can be
  // re-verified on read-back. See canonicalJson for why this matters.
  const empty = payload === undefined || payload === null;
  const text = empty ? null : JSON.stringify(payload);
  const digest = sha256(empty ? '' : canonicalJson(payload));
  // Size as received, for the retention/volume story - not the canonical form.
  const bytes = text === null ? 0 : Buffer.byteLength(text, 'utf8');

  const res = await analyticsPool.query(
    `INSERT INTO sync_raw_log
       (connector, client_id, location_id, entity, fetched_at,
        payload_sha256, payload, bytes)
     VALUES ($1,$2,$3,$4, COALESCE($5::timestamptz, now()), $6, $7::jsonb, $8)
     ON CONFLICT (connector, client_id, location_id, entity, payload_sha256)
     DO UPDATE SET fetched_at  = COALESCE($5::timestamptz, now()),
                   fetch_count = sync_raw_log.fetch_count + 1
     RETURNING id, fetch_count`,
    [normConnector, clientId, locationId, normEntity, fetchedAt, digest, text, bytes]
  );

  return {
    id: res.rows[0].id,
    payload_sha256: digest,
    deduped: res.rows[0].fetch_count > 1,
    fetch_count: res.rows[0].fetch_count,
    bytes,
  };
}

/** Read back a landed payload for replay. Newest first. */
async function readRawPayload(analyticsPool, { clientId, locationId, entity, sha256: want = null }) {
  const res = await analyticsPool.query(
    `SELECT id, connector, entity, fetched_at, payload_sha256, payload, bytes, fetch_count
       FROM sync_raw_log
      WHERE client_id = $1 AND location_id = $2 AND entity = $3
        AND ($4::char(64) IS NULL OR payload_sha256 = $4)
      ORDER BY fetched_at DESC
      LIMIT 1`,
    [clientId, locationId, String(entity).toLowerCase(), want]
  );
  return res.rows[0] || null;
}

// ─── 3. Per-store state: success, failure, staleness ─────────────────────────

/**
 * Record a successful sync. The ONLY thing that advances
 * last_successful_sync, and the only thing that clears the failure counters.
 */
async function recordSuccess(analyticsPool, { connector, clientId, locationId, entity, at = null }) {
  await analyticsPool.query(
    `INSERT INTO sync_store_state
       (client_id, location_id, entity, connector, last_successful_sync,
        last_attempt_at, consecutive_failures, last_failure_class, last_error,
        last_failure_at, disabled_at, disabled_reason, updated_at)
     VALUES ($1,$2,$3,$4, COALESCE($5::timestamptz, now()),
             COALESCE($5::timestamptz, now()), 0, NULL, NULL, NULL, NULL, NULL, now())
     ON CONFLICT (client_id, location_id, entity) DO UPDATE SET
       connector            = COALESCE(EXCLUDED.connector, sync_store_state.connector),
       last_successful_sync = EXCLUDED.last_successful_sync,
       last_attempt_at      = EXCLUDED.last_attempt_at,
       -- A success clears the whole failure state, including a disable: the
       -- store fixed its credentials and must come back on its own.
       consecutive_failures = 0,
       last_failure_class   = NULL,
       last_error           = NULL,
       last_failure_at      = NULL,
       disabled_at          = NULL,
       disabled_reason      = NULL,
       updated_at           = now()`,
    [clientId, locationId, String(entity).toLowerCase(), normalizeConnector(connector), at]
  );
}

/**
 * Record a failed sync.
 *
 * Deliberately does NOT touch last_successful_sync. That is the whole
 * "do not reintroduce" rule: a failed sync must never leave the previous data
 * looking fresh. The store stays visibly eleven days stale.
 *
 * @returns {{consecutive_failures:number, disabled:boolean, failure_class:string}}
 */
async function recordFailure(analyticsPool, {
  connector, clientId, locationId, entity, error, failureClass = null, at = null,
}) {
  const cls = failureClass || classifyFailure(error);
  const message = String(failureText(error) || 'unknown failure').slice(0, 4000);

  const res = await analyticsPool.query(
    `INSERT INTO sync_store_state
       (client_id, location_id, entity, connector, last_attempt_at,
        consecutive_failures, last_failure_class, last_error, last_failure_at, updated_at)
     VALUES ($1,$2,$3,$4, COALESCE($7::timestamptz, now()),
             1, $5, $6, COALESCE($7::timestamptz, now()), now())
     ON CONFLICT (client_id, location_id, entity) DO UPDATE SET
       connector            = COALESCE(EXCLUDED.connector, sync_store_state.connector),
       last_attempt_at      = EXCLUDED.last_attempt_at,
       consecutive_failures = sync_store_state.consecutive_failures + 1,
       last_failure_class   = EXCLUDED.last_failure_class,
       last_error           = EXCLUDED.last_error,
       last_failure_at      = EXCLUDED.last_failure_at,
       updated_at           = now()
     RETURNING consecutive_failures`,
    [clientId, locationId, String(entity).toLowerCase(), normalizeConnector(connector),
      cls, message, at]
  );

  const failures = res.rows[0].consecutive_failures;

  // Disable once it is clearly not coming back on its own. A 'dead' class
  // disables on sight; everything else gets DEAD_AFTER_FAILURES attempts.
  // 'credential' is NOT auto-disabled: the store can fix its own token, and a
  // disabled job would not notice when they did.
  const shouldDisable = cls === 'dead' || (cls === 'schema' && failures >= DEAD_AFTER_FAILURES)
    || failures >= DEAD_AFTER_FAILURES;

  if (shouldDisable) {
    await analyticsPool.query(
      `UPDATE sync_store_state
          SET disabled_at = COALESCE(disabled_at, now()),
              disabled_reason = COALESCE(disabled_reason, $4),
              updated_at = now()
        WHERE client_id = $1 AND location_id = $2 AND entity = $3`,
      [clientId, locationId, String(entity).toLowerCase(),
        `${cls} after ${failures} consecutive failures`]
    );
  }

  return { consecutive_failures: failures, disabled: shouldDisable, failure_class: cls };
}

/**
 * How fresh is this store? The read sheet 02 refuses on.
 *
 * `days_stale` is null when the store has NEVER synced successfully, which is
 * a different and worse condition than "stale by 11 days" - callers must be
 * able to tell them apart, so it is not collapsed to Infinity or to 9999.
 */
async function getStoreFreshness(analyticsPool, clientId, locationId, entity = null) {
  const res = await analyticsPool.query(
    `SELECT entity, connector,
            last_successful_sync,
            last_attempt_at,
            consecutive_failures,
            last_failure_class,
            disabled_at IS NOT NULL AS disabled,
            CASE WHEN last_successful_sync IS NULL THEN NULL
                 ELSE floor(EXTRACT(EPOCH FROM (now() - last_successful_sync)) / 86400)::int
            END AS days_stale
       FROM sync_store_state
      WHERE client_id = $1 AND location_id = $2
        AND ($3::text IS NULL OR entity = $3)
      ORDER BY entity`,
    [clientId, locationId, entity ? String(entity).toLowerCase() : null]
  );
  return res.rows.map((r) => ({
    ...r,
    never_synced: r.last_successful_sync === null,
    stale: r.last_successful_sync === null || r.days_stale >= STALE_AFTER_DAYS,
  }));
}

// ─── 4. Per-store batch isolation ────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `worker` over every store, isolating failures.
 *
 * One store's failure must not abort the batch. Partial estate output is the
 * NORMAL case and is reported as a number, not thrown: at 1,500 stores an
 * exception that aborts the run means the other 1,499 do not sync because one
 * merchant rotated a token.
 *
 * Retries only what is worth retrying. A 401 is not retried at all - that is
 * how one dead credential became 27,000 identical rows.
 *
 * @param {Array<{clientId:number, locationId:number, entity?:string, connector?:string}>} stores
 * @param {(store) => Promise<any>} worker
 * @returns {{attempted, succeeded, failed, skipped, byClass, results, durationMs}}
 */
async function runStoreBatch(stores, worker, opts = {}) {
  const {
    analyticsPool = null,
    concurrency = parseInt(process.env.SYNC_CONCURRENCY || '5', 10),
    maxAttempts = MAX_TRANSIENT_ATTEMPTS,
    backoffBaseMs = BACKOFF_BASE_MS,
    onResult = null,
    signal = null,
    // Injectable so tests do not actually wait out the backoff.
    sleepFn = sleep,
  } = opts;

  const list = Array.isArray(stores) ? stores : [];
  const summary = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    byClass: { transient: 0, credential: 0, schema: 0, dead: 0 },
    results: [],
    durationMs: 0,
  };
  const startedAt = Date.now();

  let cursor = 0;
  const runOne = async () => {
    while (cursor < list.length) {
      if (signal?.aborted) break;
      const store = list[cursor++];
      const label = `${store.clientId}:${store.locationId}:${store.entity || 'all'}`;

      // A disabled job is SKIPPED, not attempted and not counted as a failure.
      // Counting it as failed would keep a dead job inflating the connector's
      // failure rate forever, hiding whether the live stores are healthy.
      if (analyticsPool && (await isDisabled(analyticsPool, store))) {
        summary.skipped += 1;
        summary.results.push({ store: label, outcome: 'skipped', reason: 'disabled' });
        continue;
      }

      summary.attempted += 1;
      let lastError = null;
      let cls = null;

      for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
        try {
          const value = await worker(store, { attempt });
          summary.succeeded += 1;
          summary.results.push({ store: label, outcome: 'succeeded', attempt, value });
          if (analyticsPool) {
            await recordSuccess(analyticsPool, { ...store, entity: store.entity || 'all' })
              .catch((e) => logger.warn(`[Ingest] recordSuccess failed for ${label}: ${e.message}`));
          }
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          cls = classifyFailure(err);
          // Only transient failures are worth another attempt. Everything else
          // will fail identically, and fast, forever.
          if (!isRetryable(cls) || attempt >= maxAttempts) break;
          // Exponential with jitter: a connector-wide outage must not produce
          // 1,500 synchronized retries.
          const wait = backoffBaseMs * 2 ** (attempt - 1);
          await sleepFn(wait + Math.floor(Math.random() * backoffBaseMs));
        }
      }

      if (lastError) {
        summary.failed += 1;
        summary.byClass[cls] = (summary.byClass[cls] || 0) + 1;
        const entry = {
          store: label, outcome: 'failed', failure_class: cls,
          error: String(failureText(lastError)).slice(0, 500),
        };
        if (analyticsPool) {
          const state = await recordFailure(analyticsPool, {
            ...store, entity: store.entity || 'all', error: lastError, failureClass: cls,
          }).catch((e) => {
            logger.warn(`[Ingest] recordFailure failed for ${label}: ${e.message}`);
            return null;
          });
          if (state?.disabled) entry.disabled = true;
        }
        summary.results.push(entry);
        // Logged per store, alerted per connector. The digest is the alert.
        logger.warn('[Ingest] store failed', { store: label, class: cls, error: entry.error });
      }

      if (onResult) {
        try { onResult(summary.results[summary.results.length - 1]); } catch { /* never fatal */ }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, list.length || 1)) }, runOne)
  );

  summary.durationMs = Date.now() - startedAt;
  return summary;
}

async function isDisabled(analyticsPool, store) {
  try {
    const res = await analyticsPool.query(
      `SELECT 1 FROM sync_store_state
        WHERE client_id = $1 AND location_id = $2 AND entity = $3
          AND disabled_at IS NOT NULL`,
      [store.clientId, store.locationId, String(store.entity || 'all').toLowerCase()]
    );
    return res.rows.length > 0;
  } catch {
    // A state-table problem must not stop the batch running.
    return false;
  }
}

// ─── 5. Connector-level aggregation ──────────────────────────────────────────

function normalizeConnector(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text || null;
}

/**
 * Refresh sync_store_state from the warehouse's own run history.
 *
 * The fetching happens outside this backend, so the authoritative record of
 * "did this store actually sync" is syncgo's job_runs_history. This pulls the
 * last success and the current failure streak per (store, entity) and mirrors
 * it into analytics, where every downstream reader already connects.
 *
 * Idempotent - safe to run as often as you like.
 */
async function refreshSyncState(analyticsPool, syncgoPool, { batchSize = 500 } = {}) {
  const { rows } = await syncgoPool.query(
    `WITH cfg AS (
       SELECT client_id, location_id, lower(pos_type) AS connector
         FROM client_pos_config
     ),
     -- THE UNIVERSE: every (store, entity) that is CONFIGURED, unioned with
     -- every one that has ever run.
     --
     -- Deriving this from RECENT RUNS instead was a real bug, and exactly the
     -- one this sheet exists to prevent. 662 of 935 configured jobs have had
     -- no run in the last 30 days, so 71% of the estate silently had no state
     -- row at all: a store that stopped syncing two months ago was INVISIBLE
     -- to the digest and to sheet 02's refusal. "Stores go dark unnoticed",
     -- faithfully reproduced by the thing meant to prevent it.
     --
     -- Anchoring on the jobs table means a job that has NEVER run still gets
     -- a row with last_successful_sync NULL, and reads as never-synced rather
     -- than as absent. 322 jobs are in exactly that state today.
     universe AS (
       SELECT client_id, location_id, lower(entity) AS entity
         FROM jobs
        WHERE entity IS NOT NULL AND entity <> ''
        GROUP BY 1,2,3
       UNION
       -- Run history whose job row no longer exists still matters: the data
       -- is in the warehouse and something has to own its staleness.
       SELECT DISTINCT client_id, location_id, lower(entity)
         FROM job_runs_history
        WHERE entity IS NOT NULL AND entity <> ''
     ),
     last_ok AS (
       -- All time, deliberately unwindowed: "last successful sync" is
       -- meaningless if it can only see 30 days back. A store 134 days dark
       -- must report 134, not null.
       SELECT client_id, location_id, lower(entity) AS entity,
              max(started_at) AS last_successful_sync
         FROM job_runs_history
        WHERE status = 'Completed'
        GROUP BY 1,2,3
     ),
     last_any AS (
       SELECT DISTINCT ON (client_id, location_id, lower(entity))
              client_id, location_id, lower(entity) AS entity,
              started_at AS last_attempt_at, status, result
         FROM job_runs_history
        ORDER BY client_id, location_id, lower(entity), started_at DESC
     ),
     streak AS (
       -- Consecutive failures since the last success, per (store, entity).
       SELECT h.client_id, h.location_id, lower(h.entity) AS entity,
              count(*)::int AS consecutive_failures
         FROM job_runs_history h
         LEFT JOIN last_ok o
           ON o.client_id = h.client_id AND o.location_id = h.location_id
          AND o.entity = lower(h.entity)
        WHERE h.status <> 'Completed'
          AND (o.last_successful_sync IS NULL OR h.started_at > o.last_successful_sync)
        GROUP BY 1,2,3
     )
     SELECT u.client_id, u.location_id, u.entity,
            c.connector,
            o.last_successful_sync,
            a.last_attempt_at,
            COALESCE(s.consecutive_failures, 0) AS consecutive_failures,
            CASE WHEN a.status = 'Completed' THEN NULL ELSE a.result END AS last_error
       FROM universe u
       LEFT JOIN last_ok  o ON o.client_id=u.client_id AND o.location_id=u.location_id AND o.entity=u.entity
       LEFT JOIN last_any a ON a.client_id=u.client_id AND a.location_id=u.location_id AND a.entity=u.entity
       LEFT JOIN streak   s ON s.client_id=u.client_id AND s.location_id=u.location_id AND s.entity=u.entity
       LEFT JOIN cfg      c ON c.client_id=u.client_id AND c.location_id=u.location_id`
  );

  // Batched multi-row upsert. One round trip per row is ~935 today and would
  // be ~7,500 at 1,500 stores - tens of seconds of pure latency for a job that
  // has to finish before the 04:00 batch.
  let upserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const col = { cid: [], lid: [], ent: [], con: [], ok: [], att: [], fail: [], cls: [], err: [] };
    for (const r of chunk) {
      const cls = r.last_error ? classifyFailure(r.last_error) : null;
      col.cid.push(r.client_id);
      col.lid.push(r.location_id);
      col.ent.push(r.entity);
      col.con.push(r.connector);
      col.ok.push(r.last_successful_sync);
      col.att.push(r.last_attempt_at);
      col.fail.push(r.consecutive_failures);
      col.cls.push(cls);
      col.err.push(r.last_error ? String(r.last_error).slice(0, 4000) : null);
    }
    await analyticsPool.query(
      `INSERT INTO sync_store_state
         (client_id, location_id, entity, connector, last_successful_sync,
          last_attempt_at, consecutive_failures, last_failure_class, last_error,
          last_failure_at, updated_at)
       SELECT s.client_id, s.location_id, s.entity, s.connector,
              s.last_successful_sync, s.last_attempt_at, s.consecutive_failures,
              s.last_failure_class, s.last_error,
              CASE WHEN s.last_failure_class IS NULL THEN NULL ELSE s.last_attempt_at END,
              now()
         FROM (
           SELECT unnest($1::int[])         AS client_id,
                  unnest($2::int[])         AS location_id,
                  unnest($3::text[])        AS entity,
                  unnest($4::text[])        AS connector,
                  unnest($5::timestamptz[]) AS last_successful_sync,
                  unnest($6::timestamptz[]) AS last_attempt_at,
                  unnest($7::int[])         AS consecutive_failures,
                  unnest($8::text[])        AS last_failure_class,
                  unnest($9::text[])        AS last_error
         ) s
       ON CONFLICT (client_id, location_id, entity) DO UPDATE SET
         connector            = COALESCE(EXCLUDED.connector, sync_store_state.connector),
         -- GREATEST so a warehouse refresh can only ever move freshness
         -- FORWARD. A late-arriving row must not make a store look staler
         -- than a success we already recorded through /outcome.
         last_successful_sync = GREATEST(
           COALESCE(EXCLUDED.last_successful_sync, sync_store_state.last_successful_sync),
           COALESCE(sync_store_state.last_successful_sync, EXCLUDED.last_successful_sync)
         ),
         last_attempt_at      = GREATEST(
           COALESCE(EXCLUDED.last_attempt_at, sync_store_state.last_attempt_at),
           COALESCE(sync_store_state.last_attempt_at, EXCLUDED.last_attempt_at)
         ),
         consecutive_failures = EXCLUDED.consecutive_failures,
         last_failure_class   = EXCLUDED.last_failure_class,
         last_error           = EXCLUDED.last_error,
         last_failure_at      = EXCLUDED.last_failure_at,
         updated_at           = now()`,
      [col.cid, col.lid, col.ent, col.con, col.ok, col.att, col.fail, col.cls, col.err]
    );
    upserted += chunk.length;
  }
  return { upserted };
}

/**
 * Field coverage per connector, straight from the warehouse.
 *
 * First-class, because the gap tracks the CONNECTOR not the store. Measured
 * live: Square, Gokul and MPower sit at 0.0% cost coverage across 31 stores
 * and 355k SKUs while EPOSNow reaches 99.4%. Read per store that looks like a
 * data-quality problem at 31 sites; read per connector it is three tickets.
 */
async function coverageByConnector(syncgoPool) {
  const { rows } = await syncgoPool.query(
    `SELECT lower(c.pos_type) AS connector,
            count(DISTINCT (p.client_id, p.location_id))::int AS stores,
            count(*)::int AS skus,
            round(100.0 * count(*) FILTER (WHERE p.cost IS NOT NULL AND p.cost > 0)
                  / NULLIF(count(*), 0), 2) AS cost_coverage_pct,
            round(100.0 * count(*) FILTER (WHERE p.category IS NOT NULL AND p.category <> '')
                  / NULLIF(count(*), 0), 2) AS category_coverage_pct
       FROM products p
       JOIN client_pos_config c
         ON c.client_id = p.client_id AND c.location_id = p.location_id
      GROUP BY 1
      ORDER BY cost_coverage_pct ASC NULLS FIRST`
  );
  return rows;
}

/**
 * Build (and archive) the daily digest, grouped by connector.
 *
 * ONE row per connector per day. Never one per store - that is the single
 * change that makes 1,500 stores operable. A reader sees "clover: 1,778 runs,
 * 1,778 failed, all credential, 1 store dark 30 days" and opens one ticket.
 */
async function buildConnectorDigest(analyticsPool, syncgoPool, { date = null, persist = true } = {}) {
  const digestDate = date || new Date().toISOString().slice(0, 10);

  const failures = await syncgoPool.query(
    `SELECT COALESCE(lower(c.pos_type), '(unmapped)') AS connector,
            h.client_id, h.location_id, lower(h.entity) AS entity,
            h.status, h.result
       FROM job_runs_history h
       LEFT JOIN client_pos_config c
         ON c.client_id = h.client_id AND c.location_id = h.location_id
      WHERE h.started_at >= $1::date AND h.started_at < $1::date + 1`,
    [digestDate]
  );

  const byConnector = new Map();
  const bucket = (name) => {
    if (!byConnector.has(name)) {
      byConnector.set(name, {
        connector: name, stores: new Set(), runs: 0, succeeded: 0, failed: 0,
        transient_count: 0, credential_count: 0, schema_count: 0, dead_count: 0,
        exemplars: [],
      });
    }
    return byConnector.get(name);
  };

  for (const row of failures.rows) {
    const b = bucket(row.connector);
    b.runs += 1;
    b.stores.add(`${row.client_id}:${row.location_id}`);
    if (row.status === 'Completed') { b.succeeded += 1; continue; }
    b.failed += 1;
    const cls = classifyFailure(row.result);
    b[`${cls}_count`] += 1;
    if (b.exemplars.length < DIGEST_EXEMPLARS) {
      b.exemplars.push({
        store: `${row.client_id}:${row.location_id}`,
        entity: row.entity,
        class: cls,
        // The last line is the actual error; the rest is the job's preamble.
        error: lastLine(row.result).slice(0, 300),
      });
    }
  }

  // Staleness comes from our own state table, which is the thing downstream
  // stages read - so the digest and the refusal rule can never disagree.
  const stale = await analyticsPool.query(
    `SELECT COALESCE(connector, '(unmapped)') AS connector,
            count(*) FILTER (WHERE last_successful_sync IS NULL)::int AS stores_never,
            count(*) FILTER (
              WHERE last_successful_sync IS NOT NULL
                AND last_successful_sync < now() - ($1 || ' days')::interval
            )::int AS stores_stale,
            max(floor(EXTRACT(EPOCH FROM (now() - last_successful_sync)) / 86400))::int AS max_stale_days,
            (percentile_cont(0.5) WITHIN GROUP (
              ORDER BY floor(EXTRACT(EPOCH FROM (now() - last_successful_sync)) / 86400)
            ))::int AS median_stale_days
       FROM sync_store_state
      GROUP BY 1`,
    [String(STALE_AFTER_DAYS)]
  );
  const staleBy = new Map(stale.rows.map((r) => [r.connector, r]));

  const coverage = await coverageByConnector(syncgoPool).catch((err) => {
    logger.warn(`[Ingest] coverage query failed: ${err.message}`);
    return [];
  });
  const coverageBy = new Map(coverage.map((r) => [r.connector, r]));

  // Union of every connector seen anywhere: a connector with zero runs today
  // but 40 stale stores must still appear, or "silent" reads as "healthy".
  const names = new Set([
    ...byConnector.keys(), ...staleBy.keys(), ...coverageBy.keys(),
  ]);

  const digest = [...names].map((name) => {
    const b = byConnector.get(name) || {
      connector: name, stores: new Set(), runs: 0, succeeded: 0, failed: 0,
      transient_count: 0, credential_count: 0, schema_count: 0, dead_count: 0, exemplars: [],
    };
    const s = staleBy.get(name) || {};
    const c = coverageBy.get(name) || {};
    return {
      digest_date: digestDate,
      connector: name,
      stores: c.stores ?? b.stores.size,
      runs: b.runs,
      succeeded: b.succeeded,
      failed: b.failed,
      failure_pct: b.runs ? Math.round((1000 * b.failed) / b.runs) / 10 : 0,
      transient_count: b.transient_count,
      credential_count: b.credential_count,
      schema_count: b.schema_count,
      dead_count: b.dead_count,
      stores_stale: s.stores_stale ?? 0,
      stores_never: s.stores_never ?? 0,
      max_stale_days: s.max_stale_days ?? null,
      median_stale_days: s.median_stale_days ?? null,
      skus: c.skus ?? null,
      cost_coverage_pct: c.cost_coverage_pct ?? null,
      category_coverage_pct: c.category_coverage_pct ?? null,
      exemplars: b.exemplars,
    };
  }).sort((a, b) => b.failed - a.failed || a.connector.localeCompare(b.connector));

  if (persist) {
    for (const row of digest) {
      await analyticsPool.query(
        `INSERT INTO sync_connector_digest
           (digest_date, connector, stores, runs, succeeded, failed,
            transient_count, credential_count, schema_count, dead_count,
            stores_stale, stores_never, max_stale_days, median_stale_days,
            skus, cost_coverage_pct, category_coverage_pct, exemplars, generated_at)
         VALUES ($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb, now())
         ON CONFLICT (digest_date, connector) DO UPDATE SET
           stores=EXCLUDED.stores, runs=EXCLUDED.runs, succeeded=EXCLUDED.succeeded,
           failed=EXCLUDED.failed, transient_count=EXCLUDED.transient_count,
           credential_count=EXCLUDED.credential_count, schema_count=EXCLUDED.schema_count,
           dead_count=EXCLUDED.dead_count, stores_stale=EXCLUDED.stores_stale,
           stores_never=EXCLUDED.stores_never, max_stale_days=EXCLUDED.max_stale_days,
           median_stale_days=EXCLUDED.median_stale_days, skus=EXCLUDED.skus,
           cost_coverage_pct=EXCLUDED.cost_coverage_pct,
           category_coverage_pct=EXCLUDED.category_coverage_pct,
           exemplars=EXCLUDED.exemplars, generated_at=now()`,
        [row.digest_date, row.connector, row.stores, row.runs, row.succeeded, row.failed,
          row.transient_count, row.credential_count, row.schema_count, row.dead_count,
          row.stores_stale, row.stores_never, row.max_stale_days, row.median_stale_days,
          row.skus, row.cost_coverage_pct, row.category_coverage_pct,
          JSON.stringify(row.exemplars)]
      );
    }
  }

  return digest;
}

/** The last non-empty line - where the real error is in a job log blob. */
function lastLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || '';
}

/** Render the digest as the plain-text daily report. One block per connector. */
function formatDigest(rows, { date = null } = {}) {
  if (!rows.length) return 'No connectors to report.';
  const header = `POS ingestion digest - ${date || rows[0].digest_date}`;
  const lines = [header, '='.repeat(header.length), ''];

  for (const r of rows) {
    lines.push(`${r.connector.toUpperCase()}  -  ${r.stores} store(s)`);
    lines.push(`  runs ${r.runs}   failed ${r.failed} (${r.failure_pct}%)`);
    if (r.failed) {
      lines.push(
        `  by class: credential ${r.credential_count}, schema ${r.schema_count}, ` +
        `transient ${r.transient_count}, dead ${r.dead_count}`
      );
    }
    lines.push(
      `  staleness: ${r.stores_stale} stale, ${r.stores_never} never synced` +
      (r.max_stale_days != null ? `, worst ${r.max_stale_days}d` : '')
    );
    const cost = r.cost_coverage_pct == null ? 'n/a' : `${r.cost_coverage_pct}%`;
    const cat = r.category_coverage_pct == null ? 'n/a' : `${r.category_coverage_pct}%`;
    lines.push(`  coverage: cost ${cost}, category ${cat}` + (r.skus ? ` over ${r.skus} SKUs` : ''));
    if (Number(r.cost_coverage_pct) === 0 && r.skus) {
      // Say it outright. This is a connector defect, not 19 store problems.
      lines.push('    ^ CONNECTOR DEFECT: sends no cost data at all.');
    }
    for (const ex of r.exemplars || []) {
      lines.push(`    e.g. ${ex.store} ${ex.entity} [${ex.class}] ${ex.error}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = {
  // classification
  classifyFailure,
  isRetryable,
  FAILURE_CLASSES,
  // raw log
  landRawPayload,
  readRawPayload,
  // state + staleness
  recordSuccess,
  recordFailure,
  getStoreFreshness,
  refreshSyncState,
  // batch
  runStoreBatch,
  // aggregation
  coverageByConnector,
  buildConnectorDigest,
  formatDigest,
  // constants (exported for tests and for the digest route)
  DEAD_AFTER_FAILURES,
  MAX_TRANSIENT_ATTEMPTS,
  STALE_AFTER_DAYS,
  _internals: { failureText, lastLine, normalizeConnector, sha256, canonicalJson },
};
