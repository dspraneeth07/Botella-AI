/**
 * Ingestion control-plane API.
 *
 *   POST /api/ingestion/raw
 *        Land one fetch AS RECEIVED, before parsing. The external POS fetcher
 *        calls this first; everything else is a consequence of the row it
 *        writes. Deduped on payload_sha256 within connector+store+entity.
 *
 *   POST /api/ingestion/outcome
 *        Report a sync's result. A success advances last_successful_sync; a
 *        failure is classified and counted and deliberately leaves the
 *        freshness marker alone, so downstream stages see the staleness.
 *
 *   GET  /api/ingestion/freshness/:clientId/:locationId
 *        How stale is this store. The read sheet 02 refuses on.
 *
 *   GET  /api/ingestion/digest?date=YYYY-MM-DD&format=text|json
 *        The daily report, grouped BY CONNECTOR, never per store.
 *
 *   POST /api/ingestion/refresh-state
 *        Mirror syncgo's job_runs_history into sync_store_state. Idempotent.
 *
 * AUTH: mounted under verifyServiceToken in server.js — this is a
 *   server-to-server surface (the fetcher, cron, ops scripts), not a browser
 *   one. Same posture as /api/clients.
 *
 * Both pools are in play and are NOT interchangeable: req.pool is `syncgo`
 * (read-only, the record of what actually synced); the analytics pool is
 * fetched here (where our control-plane tables live).
 */

const router = require('express').Router();
const logger = require('../utils/logger');
const { getAnalyticsPool } = require('../database/analytics-connection');
const ingest = require('../services/ingestionService');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** 400 with the contract's error envelope. */
function badRequest(res, message) {
  return res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
}

function tenantFrom(source) {
  const clientId = parseInt(source.clientId ?? source.client_id, 10);
  const locationId = parseInt(source.locationId ?? source.location_id, 10);
  return { clientId, locationId };
}

// ─── POST /raw ───────────────────────────────────────────────────────────────
router.post(
  '/raw',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = tenantFrom(req.body || {});
    const { connector, entity, payload, fetched_at: fetchedAt } = req.body || {};

    if (!Number.isInteger(clientId) || !Number.isInteger(locationId)) {
      return badRequest(res, 'client_id and location_id are required integers');
    }
    if (!connector) return badRequest(res, 'connector is required');
    if (!entity) return badRequest(res, 'entity is required');
    // `payload: null` is legal and meaningful — "we fetched and got nothing".
    // Only an entirely absent key is a caller error.
    if (!('payload' in (req.body || {}))) {
      return badRequest(res, 'payload is required (use null to record an empty fetch)');
    }

    const landed = await ingest.landRawPayload(getAnalyticsPool(), {
      connector, clientId, locationId, entity, payload, fetchedAt: fetchedAt || null,
    });
    // 200 on a dedupe, 201 on a genuinely new document: the caller can tell
    // whether anything actually changed without parsing the body.
    return res.status(landed.deduped ? 200 : 201).json(landed);
  })
);

// ─── POST /outcome ───────────────────────────────────────────────────────────
router.post(
  '/outcome',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = tenantFrom(req.body || {});
    const { connector, entity, ok, error, at } = req.body || {};

    if (!Number.isInteger(clientId) || !Number.isInteger(locationId)) {
      return badRequest(res, 'client_id and location_id are required integers');
    }
    if (!entity) return badRequest(res, 'entity is required');
    if (typeof ok !== 'boolean') return badRequest(res, 'ok must be a boolean');

    const pool = getAnalyticsPool();
    if (ok) {
      await ingest.recordSuccess(pool, { connector, clientId, locationId, entity, at });
      return res.json({ recorded: 'success' });
    }
    const state = await ingest.recordFailure(pool, {
      connector, clientId, locationId, entity, error, at,
    });
    return res.json({ recorded: 'failure', ...state });
  })
);

// ─── GET /freshness/:clientId/:locationId ────────────────────────────────────
// The downstream refusal read. Returns one row per entity plus a rolled-up
// worst case, because a store whose products synced today but whose sales are
// eleven days old is stale for anything that reasons about sales.
router.get(
  '/freshness/:clientId/:locationId',
  asyncHandler(async (req, res) => {
    const clientId = parseInt(req.params.clientId, 10);
    const locationId = parseInt(req.params.locationId, 10);
    if (!Number.isInteger(clientId) || !Number.isInteger(locationId)) {
      return badRequest(res, 'clientId and locationId must be integers');
    }
    const entities = await ingest.getStoreFreshness(
      getAnalyticsPool(), clientId, locationId, req.query.entity || null
    );

    // Worst case across entities. `never_synced` dominates any number of days:
    // "has never worked" is not a large staleness, it is a different state.
    const neverSynced = entities.some((e) => e.never_synced);
    const worstDays = entities.reduce(
      (max, e) => (e.days_stale != null && e.days_stale > max ? e.days_stale : max), 0
    );
    return res.json({
      client_id: clientId,
      location_id: locationId,
      tracked: entities.length,
      never_synced: neverSynced,
      worst_days_stale: entities.length === 0 ? null : (neverSynced ? null : worstDays),
      stale: entities.length === 0 ? true : entities.some((e) => e.stale),
      // No state row at all means we have never observed this store syncing —
      // treat as stale, never as fresh.
      reason: entities.length === 0 ? 'no_sync_state_recorded' : null,
      entities,
    });
  })
);

// ─── GET /digest ─────────────────────────────────────────────────────────────
router.get(
  '/digest',
  asyncHandler(async (req, res) => {
    const date = req.query.date || null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return badRequest(res, 'date must be YYYY-MM-DD');
    }
    const rows = await ingest.buildConnectorDigest(getAnalyticsPool(), req.pool, {
      date, persist: req.query.persist !== 'false',
    });
    if (req.query.format === 'text') {
      res.type('text/plain');
      return res.send(ingest.formatDigest(rows, { date }));
    }
    return res.json({ date: date || new Date().toISOString().slice(0, 10), connectors: rows });
  })
);

// ─── POST /refresh-state ─────────────────────────────────────────────────────
router.post(
  '/refresh-state',
  asyncHandler(async (req, res) => {
    const sinceDays = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
    const result = await ingest.refreshSyncState(getAnalyticsPool(), req.pool, { sinceDays });
    logger.info('[Ingest] sync state refreshed', result);
    return res.json(result);
  })
);

module.exports = router;
