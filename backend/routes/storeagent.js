/**
 * StoreAgent proxy + result cache - Botella
 *
 * Proxies to the external Python service's /storeagent mount AND persists each
 * computed result in the bottleai_analytics Postgres so repeat loads come from
 * the DB instead of re-querying the warehouse. Mounted behind verifyToken; the
 * store/location passed to StoreAgent come from the JWT (server-authoritative).
 *
 * Flow per capability:
 *   GET  /:capability            -> DB hit returns instantly; miss computes
 *                                   upstream and caches. ?nocache=1 (the refresh
 *                                   button) recomputes and overwrites the row.
 *                                   Cached rows older than the max age still
 *                                   return instantly but trigger a background
 *                                   recompute (stale-while-revalidate), so
 *                                   nothing ever serves week-old numbers twice.
 *   GET  /:capability/narration  -> AI narration only (cached in the same row),
 *                                   so toggling AI never recomputes the view.
 */
const express = require('express');
const router = express.Router();
const { getAnalyticsPool } = require('../database/analytics-connection');
const logger = require('../utils/logger');

const STOREAGENT_API_URL = (process.env.STOREAGENT_API_URL || 'http://localhost:8000/storeagent').replace(/\/+$/, '');
const STOREAGENT_API_KEY = process.env.STOREAGENT_API_KEY || '';

function upstreamHeaders() {
  const h = { Accept: 'application/json' };
  if (STOREAGENT_API_KEY) h['X-API-Key'] = STOREAGENT_API_KEY;
  return h;
}

// Fetch JSON from the Python service. Returns { status, data }.
async function fetchUpstream(path, query) {
  const qs = new URLSearchParams(query).toString();
  const url = `${STOREAGENT_API_URL}${path}${qs ? `?${qs}` : ''}`;
  try {
    const r = await fetch(url, { headers: upstreamHeaders() });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text || `HTTP ${r.status}` };
    }
    return { status: r.status, data };
  } catch (err) {
    return { status: 502, data: { error: `StoreAgent service unreachable: ${err.message}` } };
  }
}

// Lazily ensure the cache table exists (once per process). The table is normally
// provisioned up front by database/analytics-schema.sql, so the common path is a
// catalog probe (a read any role can run) and we skip the CREATE/ALTER DDL -
// that needs schema-CREATE or table ownership the least-privilege bottleai_writer
// role lacks (CREATE TABLE IF NOT EXISTS still checks CREATE on the schema even
// when the table already exists). Any failure still degrades gracefully to no
// caching, since every caller wraps ensureTable() in try/catch.
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    const pool = getAnalyticsPool();
    tableReady = pool
      .query(
        `SELECT
           to_regclass('public.storeagent_capability_results') IS NOT NULL AS exists,
           EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_name = 'storeagent_capability_results'
               AND column_name = 'window_days'
           ) AS legacy`
      )
      .then((probe) => {
        const { exists, legacy } = probe.rows[0];
        // Already in the target 3-column shape → nothing to do (no DDL, no privileges needed).
        if (exists && !legacy) return undefined;
        // Table is missing, or still carries the legacy window_days column: run the
        // provisioning + one-time migration DDL. The DO block reverses the earlier
        // window_days experiment if present, restoring the 3-column key (safe to
        // drop the rows - it is only a cache). Remove this block once all
        // environments are reset. Needs CREATE / ownership; degrades gracefully
        // via the caller's try/catch when the role can't.
        return pool.query(
          `CREATE TABLE IF NOT EXISTS storeagent_capability_results (
             client_id   integer     NOT NULL,
             location_id integer     NOT NULL,
             capability  text        NOT NULL,
             payload     jsonb       NOT NULL,
             narration   jsonb,
             computed_at timestamptz NOT NULL DEFAULT now(),
             PRIMARY KEY (client_id, location_id, capability)
           );
           DO $$
           BEGIN
             IF EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_name = 'storeagent_capability_results' AND column_name = 'window_days'
             ) THEN
               DELETE FROM storeagent_capability_results;
               ALTER TABLE storeagent_capability_results
                 DROP CONSTRAINT IF EXISTS storeagent_capability_results_pkey;
               ALTER TABLE storeagent_capability_results DROP COLUMN window_days;
               ALTER TABLE storeagent_capability_results
                 ADD PRIMARY KEY (client_id, location_id, capability);
             END IF;
           END $$;`
        );
      })
      .catch((err) => {
        tableReady = null; // allow a later retry
        throw err;
      });
  }
  return tableReady;
}

const hasStore = (req) => req.user && req.user.client_id != null && req.user.location_id != null;
const storeKeys = (req) => [req.user.client_id, req.user.location_id];

// Selectable analysis window (inventory only). Validated here; the cache row is
// keyed by embedding it in the capability column ("inventory@60") so windowed
// views never collide with the default one - no schema change needed.
const windowFor = (req, cap) => {
  const w = parseInt(String(req.query.window || ''), 10);
  return cap === 'inventory' && [30, 60, 90].includes(w) ? w : null;
};
const cacheCap = (cap, window) => (window ? `${cap}@${window}` : cap);

// Upsert a freshly computed payload (also invalidates any prior narration).
async function cachePayload(clientId, locationId, cap, data) {
  await ensureTable();
  await getAnalyticsPool().query(
    `INSERT INTO storeagent_capability_results (client_id, location_id, capability, payload, narration, computed_at)
       VALUES ($1, $2, $3, $4, NULL, now())
     ON CONFLICT (client_id, location_id, capability)
       DO UPDATE SET payload = EXCLUDED.payload, narration = NULL, computed_at = now()`,
    [clientId, locationId, cap, JSON.stringify(data)]
  );
}

// Stale-while-revalidate: cached rows older than this still serve instantly,
// but kick off a background recompute so the NEXT viewer gets fresh numbers.
const CACHE_MAX_AGE_MS = (Number(process.env.STOREAGENT_CACHE_MAX_AGE_HOURS) || 24) * 3600 * 1000;

// Single-flight per (store, capability): concurrent misses, client retries
// (a cold overview outlives the popup's fetch timeout, so clients retry), and
// background revalidations all share ONE upstream computation. The compute
// runs to completion and caches even if every requester has hung up.
const inflightComputes = new Map();
// `window` (inventory 30/60/90) must flow BOTH into the upstream query (else
// Python computes the default analysis) and into the cache key (else the
// windowed result overwrites/serves the default row) - losing either is
// exactly the "30/60/90 toggle does nothing" bug.
function computeAndCache(clientId, locationId, cap, { bustPython = false, window = null } = {}) {
  const rowCap = cacheCap(cap, window);
  const key = `${clientId}:${locationId}:${rowCap}`;
  const existing = inflightComputes.get(key);
  if (existing) return existing;
  const p = (async () => {
    const query = { store: clientId, location: locationId };
    if (window) query.window = String(window);
    if (bustPython) query.nocache = '1'; // also busts Python's in-process cache
    const { status, data } = await fetchUpstream(`/${encodeURIComponent(cap)}`, query);
    if (status === 200) {
      try {
        await cachePayload(clientId, locationId, rowCap, data);
      } catch (err) {
        logger.warn(`[StoreAgent] result cache write failed: ${err.message}`);
      }
    }
    return { status, data };
  })().finally(() => inflightComputes.delete(key));
  inflightComputes.set(key, p);
  return p;
}

function revalidateInBackground(clientId, locationId, cap, window = null) {
  computeAndCache(clientId, locationId, cap, { bustPython: true, window }).then(
    ({ status }) => {
      if (status !== 200) logger.warn(`[StoreAgent] background refresh got HTTP ${status} for ${clientId}:${locationId}:${cacheCap(cap, window)}`);
    },
    (err) => logger.warn(`[StoreAgent] background refresh failed: ${err.message}`)
  );
}

// Passthrough metadata (no caching).
router.get('/health', async (req, res) => {
  const { status, data } = await fetchUpstream('/health', {});
  res.status(status).json(data);
});
router.get('/capabilities', async (req, res) => {
  const { status, data } = await fetchUpstream('/capabilities', {});
  res.status(status).json(data);
});

// Cache freshness for the logged-in store: capability -> computed_at (ISO).
// Registered BEFORE /:capability, which would otherwise swallow this path.
//
// Rows only, no payloads, so it is cheap enough to poll. That is the point: the
// login refresh rewrites rows in the background over several minutes, long
// after the tab has already rendered from the pre-login row, and without this
// the open page had no way to learn the fresh numbers had landed (the browser
// caches the first payload for the session). StoreAgentPanel polls this and
// re-reads only the capabilities whose stamp advanced.
//
// Never fails the caller: an unreadable cache returns an empty map, which the
// poller reads as "nothing new" and leaves the view exactly as it is.
router.get('/cache-status', async (req, res) => {
  if (!hasStore(req)) return res.json({ computed_at: {} });
  try {
    await ensureTable();
    const hit = await getAnalyticsPool().query(
      'SELECT capability, computed_at FROM storeagent_capability_results WHERE client_id=$1 AND location_id=$2',
      storeKeys(req)
    );
    const computed_at = {};
    for (const row of hit.rows) computed_at[row.capability] = new Date(row.computed_at).toISOString();
    return res.json({ computed_at });
  } catch (err) {
    logger.warn(`[StoreAgent] cache-status read failed: ${err.message}`);
    return res.json({ computed_at: {} });
  }
});

// AI narration only - cached in the row so re-toggling AI is instant.
router.get('/:capability/narration', async (req, res) => {
  const cap = req.params.capability;
  const window = windowFor(req, cap);
  const rowCap = cacheCap(cap, window);
  if (hasStore(req)) {
    try {
      await ensureTable();
      const hit = await getAnalyticsPool().query(
        'SELECT narration FROM storeagent_capability_results WHERE client_id=$1 AND location_id=$2 AND capability=$3',
        [...storeKeys(req), rowCap]
      );
      if (hit.rows[0] && hit.rows[0].narration) {
        return res.json({ narration: hit.rows[0].narration });
      }
    } catch (err) {
      logger.warn(`[StoreAgent] narration cache read failed: ${err.message}`);
    }
  }

  const query = {};
  if (hasStore(req)) {
    query.store = req.user.client_id;
    query.location = req.user.location_id;
  }
  if (window) query.window = String(window);
  const { status, data } = await fetchUpstream(`/${encodeURIComponent(cap)}/narration`, query);

  if (status === 200 && data && data.narration && hasStore(req)) {
    try {
      await getAnalyticsPool().query(
        `UPDATE storeagent_capability_results SET narration=$4
           WHERE client_id=$1 AND location_id=$2 AND capability=$3`,
        [...storeKeys(req), rowCap, JSON.stringify(data.narration)]
      );
    } catch (err) {
      logger.warn(`[StoreAgent] narration cache write failed: ${err.message}`);
    }
  }
  res.status(status).json(data);
});

// Capability result - DB-cached. ?nocache=1 recomputes + overwrites.
router.get('/:capability', async (req, res) => {
  const cap = req.params.capability;
  const nocache = ['1', 'true'].includes(String(req.query.nocache || ''));
  const window = windowFor(req, cap);
  const rowCap = cacheCap(cap, window);

  if (!nocache && hasStore(req)) {
    try {
      await ensureTable();
      const hit = await getAnalyticsPool().query(
        'SELECT payload, computed_at FROM storeagent_capability_results WHERE client_id=$1 AND location_id=$2 AND capability=$3',
        [...storeKeys(req), rowCap]
      );
      if (hit.rows[0] && hit.rows[0].payload) {
        const age = Date.now() - new Date(hit.rows[0].computed_at).getTime();
        if (age > CACHE_MAX_AGE_MS) {
          // Serve stale instantly; refresh for the next viewer.
          revalidateInBackground(...storeKeys(req), cap, window);
        }
        return res.json(hit.rows[0].payload);
      }
    } catch (err) {
      logger.warn(`[StoreAgent] result cache read failed: ${err.message}`);
    }
  }

  if (hasStore(req)) {
    // Single-flight: concurrent misses and retries share one computation,
    // which also writes the cache row (under the windowed key when windowed).
    const { status, data } = await computeAndCache(...storeKeys(req), cap, { bustPython: nocache, window });
    return res.status(status).json(data);
  }

  // No store on the JWT: plain passthrough, nothing to cache against.
  const query = {};
  if (nocache) query.nocache = '1';
  if (window) query.window = String(window);
  const { status, data } = await fetchUpstream(`/${encodeURIComponent(cap)}`, query);

  if (status === 200 && hasStore(req)) {
    try {
      await ensureTable();
      // New/refreshed payload invalidates any prior narration for the row.
      await getAnalyticsPool().query(
        `INSERT INTO storeagent_capability_results (client_id, location_id, capability, payload, narration, computed_at)
           VALUES ($1, $2, $3, $4, NULL, now())
         ON CONFLICT (client_id, location_id, capability)
           DO UPDATE SET payload = EXCLUDED.payload, narration = NULL, computed_at = now()`,
        [...storeKeys(req), rowCap, JSON.stringify(data)]
      );
    } catch (err) {
      logger.warn(`[StoreAgent] result cache write failed: ${err.message}`);
    }
  }
  res.status(status).json(data);
});

module.exports = router;
