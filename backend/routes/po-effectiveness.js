/**
 * Purchase-order recommendation effectiveness routes.
 *
 * Measures the Buying report's PO suggestions (reorder SKU X, quantity N) after
 * the owner acts on them - acceptance, forecast accuracy, and post-purchase
 * performance. See services/poEffectivenessService.js for the methodology.
 *
 * Mounted at `/api/po-effectiveness` behind verifyToken (+ attachPool for the
 * syncgo pool). Tenant keys come from the JWT (req.user).
 *
 *   GET  /report        → acceptance rate, forecast accuracy, revenue impact,
 *                         winners vs underperformers, per-metric aggregates
 *   GET  /ledger        → the flat, filterable, paged evaluated-suggestion list
 *   GET  /learning      → proven / avoid SKUs (the feedback signal)
 *   POST /capture       → snapshot a buy_list now (the buying view can post its
 *                         list so a store with no cron still accrues history)
 *   POST /evaluate      → run the evaluation pass for this tenant now
 *
 * Error shape matches the rest of the app: { "error": { "code", "message" } }.
 */

const router = require('express').Router();
const logger = require('../utils/logger');
const { toSafeError } = require('../utils/errors');
const { getAnalyticsPool } = require('../database/analytics-connection');
const po = require('../services/poEffectivenessService');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function sendError(res, err, context) {
  const safe = toSafeError(err);
  logger.error(`PO-effectiveness ${context} failed`, {
    error: err.message, code: safe.code, status: safe.statusCode,
  });
  res.status(safe.statusCode).json({ error: { code: safe.code, message: safe.userMessage } });
}

// ─── GET /report ─────────────────────────────────────────────────────────────
router.get(
  '/report',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    try {
      const report = await po.getReport(getAnalyticsPool(), clientId, locationId, {
        windowDays: parseInt(req.query.window, 10) || undefined,
        sinceDays: parseInt(req.query.days, 10) || undefined,
      });
      if (report && report.available) {
        try {
          report.learning = await po.getLearning(getAnalyticsPool(), clientId, locationId, {
            windowDays: report.window_days,
          });
        } catch (learnErr) {
          logger.warn('PO learning lists skipped', { error: learnErr.message, clientId, locationId });
          report.learning = { proven: [], avoid: [] };
        }
      }
      res.json(report);
    } catch (err) {
      sendError(res, err, 'report');
    }
  })
);

// ─── GET /ledger ─────────────────────────────────────────────────────────────
router.get(
  '/ledger',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    const verdict = req.query.verdict ? String(req.query.verdict) : undefined;
    const acted = req.query.acted ? String(req.query.acted) : undefined;
    if (verdict && !['winner', 'neutral', 'underperformer', 'insufficient_data'].includes(verdict)) {
      return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: "verdict must be 'winner', 'neutral', 'underperformer' or 'insufficient_data'." } });
    }
    if (acted && !['true', 'false'].includes(acted)) {
      return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: "acted must be 'true' or 'false'." } });
    }
    try {
      const ledger = await po.getLedger(getAnalyticsPool(), clientId, locationId, {
        windowDays: parseInt(req.query.window, 10) || undefined,
        sinceDays: parseInt(req.query.days, 10) || undefined,
        verdict, acted,
        limit: parseInt(req.query.limit, 10) || undefined,
        offset: parseInt(req.query.offset, 10) || undefined,
      });
      res.json(ledger);
    } catch (err) {
      sendError(res, err, 'ledger');
    }
  })
);

// ─── GET /learning ───────────────────────────────────────────────────────────
router.get(
  '/learning',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    try {
      res.json(await po.getLearning(getAnalyticsPool(), clientId, locationId, {
        windowDays: parseInt(req.query.window, 10) || undefined,
        sinceDays: parseInt(req.query.days, 10) || undefined,
      }));
    } catch (err) {
      sendError(res, err, 'learning');
    }
  })
);

// ─── POST /capture ───────────────────────────────────────────────────────────
// The buying view can POST its current buy_list so a store accrues PO-suggestion
// history even without the server-side capture hook / cron. Idempotent per day.
router.post(
  '/capture',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    const buyList = Array.isArray(req.body?.buy_list) ? req.body.buy_list : null;
    if (!buyList) {
      return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: 'buy_list (array) is required.' } });
    }
    try {
      const captured = await po.capture(getAnalyticsPool(), clientId, locationId, buyList);
      res.json({ ok: true, captured });
    } catch (err) {
      sendError(res, err, 'capture');
    }
  })
);

// ─── POST /backfill ──────────────────────────────────────────────────────────
// Seed the report from history: reconstruct the reorder recommendations Botella
// would have made over the store's recent past (velocity-based, back-dated so
// their windows are closed) and score them against the store's real purchases
// and sales. Lets the report show real, populated numbers immediately instead
// of waiting ~30 days for live captures to mature.
router.post(
  '/backfill',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    try {
      const result = await po.backfillTenant(getAnalyticsPool(), clientId, locationId, {});
      res.json({ ok: true, ...result });
    } catch (err) {
      sendError(res, err, 'backfill');
    }
  })
);

// ─── POST /evaluate ──────────────────────────────────────────────────────────
router.post(
  '/evaluate',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    try {
      const result = await po.evaluateTenant(getAnalyticsPool(), clientId, locationId, {
        force: ['1', 'true'].includes(String(req.query.force || '')),
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      sendError(res, err, 'evaluate');
    }
  })
);

module.exports = router;
