/**
 * Store-Intelligence Service - pre-warm the StoreAgent capability cache.
 *
 * The Suggestions/Store-Intelligence tabs read storeagent_capability_results
 * (analytics DB). On a cold row, routes/storeagent.js computes the capability
 * upstream (the external Python /storeagent service) on first view, which is
 * slow. This service does the same compute ahead of time, on a cron, so the tab
 * always reads a warm row.
 *
 * It mirrors the upstream-fetch + upsert that routes/storeagent.js performs for
 * a live request, but the store/location come from the cron scope instead of a
 * JWT. Same analytics table, same ON CONFLICT key.
 */

const logger = require('../utils/logger');

// StoreAgent base URL already includes the /storeagent mount (see routes/storeagent.js).
const STOREAGENT_API_URL = (process.env.STOREAGENT_API_URL || 'http://localhost:8000/storeagent').replace(/\/+$/, '');
const STOREAGENT_API_KEY = process.env.STOREAGENT_API_KEY || '';
const STOREAGENT_TIMEOUT_MS = parseInt(process.env.STOREINTEL_TIMEOUT_MS || '90000', 10);

// The capabilities the UI renders (StoreAgentPanel.js). Override per-env with
// STOREINTEL_CAPABILITIES="pricing,market,buying" to warm a subset.
// 'basket' removed: the Basket & Cross-Sell tab is retired, so don't spend
// warehouse compute warming it. (inventory stays - it feeds the Zero Movement
// Report on the Buying tab, and the Dashboard's Stock Velocity panel.)
// 'overview' is LAST on purpose: the Daily Report's action queue runs the
// inventory/buying/market/customers engines through the shared result cache,
// so once those are freshly computed above it costs almost nothing.
const DEFAULT_CAPABILITIES = ['market', 'buying', 'inventory', 'customers', 'overview'];

function capabilitiesFromEnv() {
  const raw = (process.env.STOREINTEL_CAPABILITIES || '').trim();
  if (!raw) return DEFAULT_CAPABILITIES;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_CAPABILITIES;
}

function upstreamHeaders() {
  const h = { Accept: 'application/json' };
  if (STOREAGENT_API_KEY) h['X-API-Key'] = STOREAGENT_API_KEY;
  return h;
}

/** GET one capability from the Python service (forcing a fresh compute). */
async function fetchCapability(capability, clientId, locationId, { nocache = true } = {}) {
  const qs = new URLSearchParams({
    store: String(clientId),
    location: String(locationId),
    ...(nocache ? { nocache: '1' } : {}),
  }).toString();
  const url = `${STOREAGENT_API_URL}/${encodeURIComponent(capability)}?${qs}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STOREAGENT_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: upstreamHeaders(), signal: controller.signal });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text || `HTTP ${r.status}` }; }
    return { status: r.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/** GET the AI narration for one capability (optional warm). */
async function fetchNarration(capability, clientId, locationId) {
  const qs = new URLSearchParams({ store: String(clientId), location: String(locationId) }).toString();
  const url = `${STOREAGENT_API_URL}/${encodeURIComponent(capability)}/narration?${qs}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STOREAGENT_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: upstreamHeaders(), signal: controller.signal });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    return { status: r.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compute + cache every capability for one store. Mirrors the live-request
 * upsert in routes/storeagent.js (a fresh payload clears any stale narration).
 * Per-capability failures are logged and skipped - one bad capability never
 * aborts the store.
 *
 * @returns {{ ok: number, failed: number }}
 */
async function refreshStore(analyticsPool, clientId, locationId, opts = {}) {
  const capabilities = opts.capabilities || capabilitiesFromEnv();
  const withNarration = opts.withNarration ?? (String(process.env.STOREINTEL_CRON_NARRATION || '').toLowerCase() === 'true');

  // Compute + upsert ONE capability; returns true on success. Failures are
  // logged and absorbed so one bad capability never sinks the others.
  const runCap = async (cap) => {
    try {
      const { status, data } = await fetchCapability(cap, clientId, locationId, { nocache: true });
      if (status !== 200) {
        logger.warn('[StoreIntel] capability compute non-200', { clientId, locationId, cap, status });
        return false;
      }

      await analyticsPool.query(
        `INSERT INTO storeagent_capability_results (client_id, location_id, capability, payload, narration, computed_at)
           VALUES ($1, $2, $3, $4, NULL, now())
         ON CONFLICT (client_id, location_id, capability)
           DO UPDATE SET payload = EXCLUDED.payload, narration = NULL, computed_at = now()`,
        [clientId, locationId, cap, JSON.stringify(data)]
      );

      // Optionally pre-warm narration too, so toggling AI in the UI is instant.
      if (withNarration) {
        try {
          const n = await fetchNarration(cap, clientId, locationId);
          if (n.status === 200 && n.data && n.data.narration) {
            await analyticsPool.query(
              `UPDATE storeagent_capability_results SET narration = $4
                 WHERE client_id = $1 AND location_id = $2 AND capability = $3`,
              [clientId, locationId, cap, JSON.stringify(n.data.narration)]
            );
          }
        } catch (nerr) {
          logger.warn('[StoreIntel] narration warm failed', { clientId, locationId, cap, error: nerr.message });
        }
      }
      return true;
    } catch (err) {
      logger.warn('[StoreIntel] capability failed', { clientId, locationId, cap, error: err.message });
      return false;
    }
  };

  // Base capabilities run CONCURRENTLY - they are independent, and the Python
  // service single-flights per capability, so this collapses the refresh from
  // sum-of-engines (~30s measured) to the slowest engine (~12s). 'overview' is
  // held back until the rest have landed: its action queue replays the
  // inventory/buying/market engines through the Python service's shared result
  // cache, so running it last makes it nearly free instead of triggering its
  // own parallel computes. (Each engine opens 2-3 warehouse connections; four
  // at once per store is the same order of concurrency the overview action
  // queue already produces on its own.)
  const base = capabilities.filter((c) => c !== 'overview');
  const results = await Promise.all(base.map(runCap));
  if (capabilities.includes('overview')) results.push(await runCap('overview'));

  const ok = results.filter(Boolean).length;
  return { ok, failed: results.length - ok };
}

// ---- Login-triggered refresh ----------------------------------------------
// Signing in recomputes that store's capabilities, so a session starts on
// current numbers instead of whatever the nightly cron last left behind.
//
// One guard only: a single refresh per store at a time. Several staff signing
// in to the same store, or one person re-logging after a token expiry, join the
// run already under way instead of queueing a duplicate warehouse pass.
//
// There is deliberately NO minimum interval between logins. A time-based floor
// silently turned a deliberate sign-in into a no-op - the exact failure where a
// user logs in, sees yesterday's numbers, and has to press Refresh - and it
// bought nothing the in-flight guard doesn't already cover: the expensive case
// is CONCURRENT runs, not sequential ones, and back-to-back logins land inside
// the several-minute window one refresh takes anyway.
const LOGIN_REFRESH_ENABLED =
  String(process.env.STOREINTEL_LOGIN_REFRESH ?? 'true').toLowerCase() === 'true';

// The refresh starts on a delay so the login popup wins the race. The popup's
// headline numbers (/api/summary) hit the SAME warehouse the 5-engine refresh
// saturates for ~30-60s; started together, the summary crawls past the
// browser's fetch timeout and the popup renders "-" while the server finishes
// unobserved (nginx 499s, no backend error - store 171, 2026-08-19). Every
// popup fetch lands within the first few seconds of the dashboard, so parking
// the warehouse pass just past that window removes the contention entirely.
const LOGIN_REFRESH_DELAY_MS =
  Number(process.env.STOREINTEL_LOGIN_REFRESH_DELAY_MS ?? 25000);

const loginRefreshInFlight = new Set(); // `${clientId}_${locationId}`

/**
 * Kick off a background refresh for one store after a successful login.
 * Fire-and-forget by design - the login response must never wait on warehouse
 * work. Returns whether a refresh was actually started (false = suppressed by
 * a guard or disabled), which is useful for logging and tests.
 */
function refreshStoreOnLogin(analyticsPool, clientId, locationId) {
  if (!LOGIN_REFRESH_ENABLED) return false;
  const key = `${clientId}_${locationId}`;
  if (loginRefreshInFlight.has(key)) return false;

  // The guard covers the delay window too: a re-login while the refresh is
  // parked joins the pending run instead of scheduling a second one.
  loginRefreshInFlight.add(key);
  const timer = setTimeout(() => {
    refreshStore(analyticsPool, clientId, locationId)
      .then(({ ok, failed }) =>
        logger.info('[StoreIntel] login refresh complete', { clientId, locationId, ok, failed }))
      .catch((err) =>
        logger.warn('[StoreIntel] login refresh failed', { clientId, locationId, error: err.message }))
      .finally(() => loginRefreshInFlight.delete(key));
  }, LOGIN_REFRESH_DELAY_MS);
  if (typeof timer.unref === 'function') timer.unref(); // never holds a shutdown open
  return true;
}

module.exports = {
  DEFAULT_CAPABILITIES, capabilitiesFromEnv, refreshStore, refreshStoreOnLogin,
};
