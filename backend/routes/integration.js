/**
 * Integration routes - consumed by the external Python recommendation service.
 *
 * Mounted at `/api/clients` (see server.js). Endpoints:
 *   GET /api/clients/:clientId/locations/:locationId/profile
 *   GET /api/clients/:clientId/locations/:locationId/inventory
 *   GET /api/clients/:clientId/locations/:locationId/sales?days=90
 *   GET /api/clients/:clientId/locations/:locationId/recommendation-history?days=30&limit=20
 *   GET /api/clients/:clientId/locations/:locationId/co-purchases?days=90&limit=50
 *   GET /api/clients/:clientId/locations/:locationId/trend-validation?terms=a,b
 *   GET /api/clients/:clientId/locations/:locationId/area-winners?days=30&limit=10
 *   GET /api/clients/:clientId/locations/:locationId/social-trends?days=14
 *   POST /api/clients/:clientId/locations/:locationId/social-trends/observed-terms
 *   GET /api/clients/:clientId/locations/:locationId/register-trends?limit=8
 *   GET /api/clients/:clientId/locations/:locationId/lead-times
 *
 * Both tenant keys are mandatory path segments - they can never be omitted, which
 * matches the non-negotiable client_id + location_id filtering rule (ARCHITECTURE.md).
 * The actual SQL + contract-shaping lives in services/integrationService.js, except
 * recommendation-history, which reads the rec tables owned by
 * services/recommendationService.js in the ANALYTICS DB (req.pool is syncgo).
 *
 * AUTH: verifyServiceToken in server.js - a no-op until NODE_API_TOKEN is set,
 *   then `Authorization: Bearer <NODE_API_TOKEN>` is required on every call.
 *
 * Error shape matches the contract envelope: { "error": { "code", "message" } }.
 */

const router = require('express').Router();
const logger = require('../utils/logger');
const svc = require('../services/integrationService');
const recSvc = require('../services/recommendationService');
const catalogSvc = require('../services/catalogTrackingService');
const igTrendsSvc = require('../services/instagramTrendsService');
const leadTimeSvc = require('../services/leadTimeService');
const { getAnalyticsPool } = require('../database/analytics-connection');
const { makeTenantScopedPool } = require('../database/connection');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Send a contract-shaped error envelope. */
function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

/** Wrap an async handler so thrown/rejected errors hit the global error handler. */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** Parse a path segment as a positive integer, else null. */
function toPositiveInt(value) {
  if (!/^\d+$/.test(String(value))) return null;
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ─── Tenant resolution (shared by all three endpoints) ───────────────────────
// Validates the IDs, confirms the (client_id, location_id) pair exists, and stashes
// the resolved values + the location row on req. A missing pair is a clean 404 here
// rather than each endpoint silently returning empty data for bad IDs.
router.use(
  '/:clientId/locations/:locationId',
  asyncHandler(async (req, res, next) => {
    const clientId = toPositiveInt(req.params.clientId);
    const locationId = toPositiveInt(req.params.locationId);

    if (clientId === null || locationId === null) {
      return sendError(
        res,
        400,
        'INVALID_PARAMS',
        'clientId and locationId must be positive integers.'
      );
    }

    // Machine-to-machine callers carry no user JWT, so server.js's attachPool
    // hands this route the BARE pool (no tenant GUCs). Tenant-scope it from the
    // path params here so every downstream query runs under this tenant's RLS
    // context once migration 002 is applied - and behaves exactly like the bare
    // pool until then (the GUCs are simply unread). Both keys validated above.
    const base = req.pool && req.pool.raw ? req.pool.raw : req.pool;
    req.pool = makeTenantScopedPool(base, clientId, locationId);

    const row = await svc.getLocationRow(req.pool, clientId, locationId);
    if (!row) {
      return sendError(
        res,
        404,
        'LOCATION_NOT_FOUND',
        `No location ${locationId} for client ${clientId}.`
      );
    }

    req.tenant = { clientId, locationId };
    req.locationRow = row;
    next();
  })
);

// ─── GET .../profile ─────────────────────────────────────────────────────────
router.get(
  '/:clientId/locations/:locationId/profile',
  (req, res) => {
    // Row already fetched (and cached) by the resolver - no second query.
    res.json(svc.toProfile(req.locationRow));
  }
);

// ─── GET .../inventory ───────────────────────────────────────────────────────
// Also runs the new-product detection pass (catalogTrackingService): the SKU
// list is diffed against the first-seen registry in the analytics DB, and
// `created_at` is filled from it for recent additions. That single field is
// what activates the Python side's "new arrivals" candidate slice - baseline
// SKUs (present before tracking started) keep created_at = null. Best-effort:
// a tracking failure degrades to the pre-feature all-null behavior.
router.get(
  '/:clientId/locations/:locationId/inventory',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const inventory = await svc.getInventory(req.pool, clientId, locationId);
    const firstSeen = await catalogSvc.firstSeenMapSafe(
      getAnalyticsPool(), clientId, locationId,
      inventory.map((i) => ({ sku: i.sku, upc: i.upc }))
    );
    for (const item of inventory) {
      if (firstSeen[item.sku]) item.created_at = firstSeen[item.sku];
    }
    res.json(inventory); // bare array - contract accepts array or { data: [...] }
  })
);

// ─── GET .../sales?days=90 ───────────────────────────────────────────────────
router.get(
  '/:clientId/locations/:locationId/sales',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const days = svc.normalizeDays(req.query.days);
    const sales = await svc.getSales(req.pool, clientId, locationId, days);
    res.json(sales);
  })
);

// ─── GET .../recommendation-history?days=30&limit=20 ─────────────────────────
// Contract §1.4 (feedback loop): past persisted recs + thumbs votes + each
// rec's measured outcome (action_taken / verdict / lift). Python joins these
// against sales to measure realized lift per rec category. Voted recs come
// first, then most-recent fill to `limit` - bounds the Python prompt context.
//
// Response is the { data: [...] } envelope the contract already accepts (the
// Python client's _as_list handles both shapes), so the MEASURED learning
// lists ride along additively as `effectiveness: { proven, avoid }` - SKUs
// that repeatedly won / missed when recommended, steering future candidate
// selection. Learning is best-effort: a failure degrades to empty lists and
// never sinks the history feed.
router.get(
  '/:clientId/locations/:locationId/recommendation-history',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const days = svc.normalizeDays(req.query.days, 30); // contract default 30
    const limit = svc.normalizeHistoryLimit(req.query.limit); // default 20, max 100
    const history = await recSvc.getRecommendationHistory(
      getAnalyticsPool(), clientId, locationId, days, limit
    );
    let effectiveness = { proven: [], avoid: [] };
    try {
      effectiveness = await recSvc.computeLearning(
        getAnalyticsPool(), req.pool, clientId, locationId
      );
    } catch (err) {
      logger.warn('recommendation-history learning lists skipped', {
        error: err.message, clientId, locationId,
      });
    }
    res.json({ data: history, effectiveness });
  })
);

// ─── GET/POST .../signal-history ─────────────────────────────────────────────
// Which signals were active, per store, per day. APPEND-ONLY, enforced by a
// trigger on the table: a signal was either active on a date or it was not, so a
// re-run is idempotent rather than a duplicate.
//
// POST takes rows computed by `features/signal_backfill.py`. `origin` stays
// 'computed' on those, which is what stops a backfill being quoted later as
// evidence that live capture was running - a holiday reconstructed from a calendar
// is a different kind of fact from a temperature somebody recorded.
router.get(
  '/:clientId/locations/:locationId/signal-history',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const days = svc.normalizeDays(req.query.days, 1000);
    const data = await recSvc.getSignalHistory(
      getAnalyticsPool(), clientId, locationId, days
    );
    res.json({ data });
  })
);

router.post(
  '/:clientId/locations/:locationId/signal-history',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const rows = Array.isArray(req.body) ? req.body : (req.body || {}).rows;
    if (!Array.isArray(rows)) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'rows must be an array' },
      });
    }
    // The tenant is taken from the ROUTE, never from the body. A writer that can
    // name its own store can write into somebody else's history.
    const scoped = rows.map((r) => ({
      ...r, client_id: clientId, location_id: locationId,
    }));
    const result = await recSvc.insertSignalHistory(getAnalyticsPool(), scoped);
    logger.info('[Signals] backfill written', {
      clientId, locationId, ...result,
    });
    res.json({ data: result });
  })
);

// ─── GET .../scored-outcomes?window=30 ───────────────────────────────────────
// Sheet 08's input: what each evaluated card CLAIMED, and whether it worked. The
// statistics live in `calibrate/fit.py` and are not reimplemented here.
router.get(
  '/:clientId/locations/:locationId/scored-outcomes',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const windowDays = svc.normalizeDays(req.query.window, 30);
    const data = await recSvc.getScoredOutcomes(
      getAnalyticsPool(), clientId, locationId, windowDays
    );
    // WHICH ENGINE THESE CAME FROM. The fitter must stamp the bundle with it,
    // because a curve maps a raw ranking score onto a hit rate and that
    // mapping only holds for the engine that produced the scores. Sent
    // alongside rather than inside each row: it is one fact about the set.
    res.json({ data, engine_version: data.engineVersion ?? null });
  })
);

// ─── GET/PUT .../signal-effects ──────────────────────────────────────────────
// Migration 029. The measured effect of each external signal on each drink
// family, fitted offline against day-of-week / month / trend controls.
//
// THIS ENDPOINT IS THE HALF THAT WAS MISSING. `cold_box` and `pre_stock` refuse
// without a measured effect and nothing could supply one, so the engine gathered
// five to thirteen live signals a store and cited none of them anywhere.
//
// GET returns an ARRAY, and an EMPTY array - never a 404. An empty set is the
// normal and correct state at a store where nothing has been fitted or nothing
// qualified, and the families already treat "no effect" as a refusal to speak. A
// 404 here would make the recommender's optional-feed handler log a failure for
// the most ordinary outcome there is.
//
// `?all=1` includes the refusals. The serving path wants only what a card may
// cite; a human asking "did you look at sports, and what did you find" wants the
// 499 refusals too, and the `usable` column is GENERATED so neither caller can
// apply its own rule.
router.get(
  '/:clientId/locations/:locationId/signal-effects',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const usableOnly = !['1', 'true', 'yes'].includes(
      String(req.query.all || '').toLowerCase()
    );
    const rows = await recSvc.getSignalEffects(
      getAnalyticsPool(), clientId, locationId, { usableOnly }
    );
    res.json({ data: rows });
  })
);

router.put(
  '/:clientId/locations/:locationId/signal-effects',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const body = req.body || {};
    const rows = Array.isArray(body) ? body : body.effects;
    if (!Array.isArray(rows)) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST',
                 message: 'body must be an array of effects, or {effects: [...]}' },
      });
    }
    // REPLACES the store's whole set, in one transaction. A partial publish would
    // leave a store citing January's heat effect beside July's cold one.
    const written = await recSvc.replaceSignalEffects(
      getAnalyticsPool(), clientId, locationId, rows
    );
    res.json({ data: { written, replaced: true } });
  })
);

// ─── GET/PUT .../calibration-bundle ──────────────────────────────────────────
// The fitted isotonic curve. PUT by the batch that fits it; GET on the request
// path so the stated confidence is a calibrated probability rather than a raw
// ranking score.
//
// A 404 on GET means no curve has been fitted for this store, which is an
// ABSENCE: `apply_calibration` then runs the identity transform and the card
// correctly declines to present its score as a percentage.
router.get(
  '/:clientId/locations/:locationId/calibration-bundle',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const found = await recSvc.getCalibrationBundle(
      getAnalyticsPool(), clientId, locationId
    );
    if (!found) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND',
                 message: 'no calibration curve fitted for this store yet' },
      });
    }
    res.json({ data: found });
  })
);

router.put(
  '/:clientId/locations/:locationId/calibration-bundle',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const body = req.body || {};
    if (!body.version || !body.fitted_at || !body.bundle) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST',
                 message: 'version, fitted_at and bundle are required' },
      });
    }
    await recSvc.upsertCalibrationBundle(getAnalyticsPool(), {
      ...body, client_id: clientId, location_id: locationId,
    });
    logger.info('[Calibration] bundle published', {
      clientId, locationId, version: body.version,
      engineVersion: body.engine_version || null,
      cells: body.cells_fitted, outcomes: body.outcomes_fitted,
      rungs: body.rungs,
    });
    res.json({ data: { ok: true, version: body.version } });
  })
);

// ─── GET/PUT .../gate-verdict ────────────────────────────────────────────────
// Sheet 17's STORE-level gate. GET is read on the request path when assembling a
// slate; PUT is written by the batch that measures the inputs over a month of
// ledger.
//
// A 404 on GET means nobody has measured this store, which is an ABSENCE and not
// a failure - the consumer must honour `displayed` only where `measured` is true,
// or it withholds every card at every store the first time it reads the flag.
router.get(
  '/:clientId/locations/:locationId/gate-verdict',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const verdict = await recSvc.getStoreGateVerdict(
      getAnalyticsPool(), clientId, locationId
    );
    if (!verdict) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND',
                 message: 'no gate verdict measured for this store yet' },
      });
    }
    res.json({ data: verdict });
  })
);

router.put(
  '/:clientId/locations/:locationId/gate-verdict',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const body = req.body || {};
    if (!body.state || !body.reason) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST',
                 message: 'state and reason are required' },
      });
    }
    const result = await recSvc.upsertStoreGateVerdict(getAnalyticsPool(), {
      ...body, client_id: clientId, location_id: locationId,
    });
    if (result.changed) {
      logger.info('[Gate] store verdict changed', {
        clientId, locationId, from: result.previousState, to: body.state,
        reason: body.reason,
      });
    }
    res.json({ data: { ok: true, ...result } });
  })
);

// ─── GET .../card-history?days=60 ────────────────────────────────────────────
// Feeds the LIFECYCLE screen, which asks a different question from the feedback
// loop: not "how did this card do" but "have we said this before, and has it
// stopped working". One row per SKU with first-issue date, how many times it has
// been shown, and the engine rate that justified the FIRST card.
//
// Separate from recommendation-history on purpose: that one is capped at 20 rows
// and ordered voted-first, so reusing it would report a product shown 15 times as
// shown once.
router.get(
  '/:clientId/locations/:locationId/card-history',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const days = svc.normalizeDays(req.query.days, 60);
    const data = await recSvc.getCardHistory(
      getAnalyticsPool(), clientId, locationId, days
    );
    res.json({ data });
  })
);

// ─── GET .../co-purchases?days=90&limit=50 ───────────────────────────────────
// Contract §1.5: top basket co-occurrence pairs, grounding `bundle` recs.
router.get(
  '/:clientId/locations/:locationId/co-purchases',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const days = svc.normalizeDays(req.query.days);
    const limit = svc.normalizeLimit(req.query.limit);
    const pairs = await svc.getCoPurchases(req.pool, clientId, locationId, days, limit);
    res.json(pairs);
  })
);

// ─── GET .../trend-validation?terms=aperol,high+noon ─────────────────────────
// Contract §1.7: validate social-media trending drink TERMS against real
// registers at same-state peer stores - how many stores sell matching
// products, average weekly units, and how many are accelerating this week.
// ANONYMIZED aggregates only; velocity stats are withheld below the
// k-anonymity floor. Grounds the `social_trending` recommendations: hype with
// local register movement earns confidence, hype without it stays soft.
router.get(
  '/:clientId/locations/:locationId/trend-validation',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const terms = svc.normalizeTrendTerms(req.query.terms);
    if (!terms.length) {
      return sendError(
        res, 400, 'INVALID_PARAMS',
        'terms must be a comma-separated list of drink terms (letters/digits, 2-40 chars).'
      );
    }
    const bare = req.pool && req.pool.raw ? req.pool.raw : req.pool;
    const validation = await svc.getTrendValidation(
      bare, clientId, locationId, req.locationRow, terms
    );
    res.json(validation);
  })
);

// ─── GET .../area-winners?days=30&limit=10 ───────────────────────────────────
// Contract §1.6: new products (first seen ≤30d) performing well at OTHER
// stores in this store's area (same state; same-city ranked first), matched
// across stores by UPC and returned as ANONYMIZED aggregates only. Grounds the
// `new_arrival` recommendations that suggest stocking a product this store
// doesn't carry yet. Note the bare pool handoff: the service re-scopes it per
// contributing tenant (RLS-compatible) - see getAreaWinners for the rationale.
router.get(
  '/:clientId/locations/:locationId/area-winners',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const days = svc.normalizeDays(req.query.days, 30);
    const limit = svc.normalizeAreaLimit(req.query.limit);
    const bare = req.pool && req.pool.raw ? req.pool.raw : req.pool;
    const winners = await svc.getAreaWinners(
      bare, getAnalyticsPool(), clientId, locationId, req.locationRow, days, limit
    );
    res.json(winners);
  })
);

// ─── GET .../social-trends?days=14 ───────────────────────────────────────────
// Instagram hashtag velocity for the tracked drink vocabulary (migration 005;
// polled daily by the IG trends cron). GLOBAL data - hashtag popularity is not
// per-store - but mounted under the tenant path so it rides the same auth and
// contract mount as every other integration pull. The Python side ranks by
// `acceleration` (latest posts/hour vs. the multi-day baseline) and feeds the
// fast movers into the same trend-validation flow as Google Trends / Reddit
// terms. Empty array until the poller has run (or if migration 005 is pending).
router.get(
  '/:clientId/locations/:locationId/social-trends',
  asyncHandler(async (req, res) => {
    const days = svc.normalizeDays(req.query.days, 14);
    const data = await igTrendsSvc.getTrendSeries(getAnalyticsPool(), days);
    res.json({ data, source: 'instagram', window_days: days });
  })
);

// ─── POST .../social-trends/observed-terms ───────────────────────────────────
// Contract §1.8 (dynamic vocabulary): the Python service reports the trend
// terms its discovery channels surfaced this run; the daily Instagram poll
// merges the freshest into its vocabulary (migration 006), so a newly viral
// drink starts being MEASURED within a day of first sighting. Fire-and-forget
// on the Python side - always answers with a count, never an error the caller
// must handle.
router.post(
  '/:clientId/locations/:locationId/social-trends/observed-terms',
  asyncHandler(async (req, res) => {
    const terms = Array.isArray(req.body && req.body.terms) ? req.body.terms : [];
    const accepted = await igTrendsSvc.recordObservedTerms(getAnalyticsPool(), terms);
    res.json({ accepted });
  })
);

// ─── GET .../register-trends?limit=8 ─────────────────────────────────────────
// Contract §1.9: DISCOVER what's accelerating at same-state peer registers -
// the inverse of §1.7, which validates terms someone else discovered. Same
// anonymization, floors, and peer fan-out as trend-validation; same bare-pool
// handoff (the service re-scopes per contributing tenant).
router.get(
  '/:clientId/locations/:locationId/register-trends',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const bare = req.pool && req.pool.raw ? req.pool.raw : req.pool;
    const trends = await svc.getRegisterTrends(
      bare, clientId, locationId, req.locationRow, req.query.limit
    );
    res.json({ data: trends, source: 'registers' });
  })
);

// ─── GET .../lead-times ──────────────────────────────────────────────────────
// Migration 037. Per-vendor delivery lead time WITH PROVENANCE, and which
// vendor supplies each SKU as far as the parsed documents say.
//
// The engine's reorder quantity rests on a lead time that was declared seven
// days in three places and could never be measured, because nothing recorded
// when an order arrived. `received_date` now can be, `leadTimeService` turns
// receipts into a median per vendor, and this is where the Python side reads
// it so a card can say "measured from 4 receipts" or "supplier default,
// declared, not measured" - never a bare seven.
//
// Returns an EMPTY map at a store with no documents, and at an estate that has
// not run 037 - never a 404. Absence means "no vendor is known for anything",
// and the consumer keeps its declared default and says so.
//
//   vendors  {vendor_key: {lead_time_days, source, observations, vendor_name,
//                          measured_from, measured_to}}
//   skus     {sku: vendor_key}   explicit links and barcode/code matches only
router.get(
  '/:clientId/locations/:locationId/lead-times',
  asyncHandler(async (req, res) => {
    const { clientId, locationId } = req.tenant;
    const analytics = getAnalyticsPool();
    const [vendors, skus] = await Promise.all([
      leadTimeSvc.getLeadTimes(analytics, clientId, locationId),
      leadTimeSvc.getSkuVendorMap(analytics, req.pool, clientId, locationId),
    ]);
    res.json({
      data: {
        vendors,
        skus,
        default_days: leadTimeSvc.LEAD_TIME_DEFAULT_DAYS,
        min_observations: leadTimeSvc.LEAD_TIME_MIN_OBSERVATIONS,
      },
    });
  })
);

module.exports = router;
