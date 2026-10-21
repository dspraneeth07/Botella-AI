/**
 * Signal impact - what each external signal has measurably done for the store.
 *
 * Mounted at `/api/signal-impact` behind verifyToken + attachPool (server.js),
 * the same gate as /api/recommendations, so the Effectiveness tab fetches it
 * with the token it already holds:
 *
 *   GET /api/signal-impact?window=30&days=365
 *       → { data: signalImpactService.signalImpactLedger(...) }
 *
 * `window` is one of the configured evaluation windows (REC_EVAL_WINDOWS,
 * default 30) and `days` bounds how far back "issued" reaches (1..365). Both
 * are clamped, never rejected: a bad value gets the default, because the tab
 * must still render when a query string is stale.
 *
 * Tenant keys come from the JWT (req.user). The analytics pool is fetched here;
 * req.pool (syncgo) is attached by the mount and unused, as on
 * /api/po-effectiveness.
 *
 * Error shape matches the rest of the app: { "error": { "code", "message" } }.
 */

const router = require('express').Router();
const logger = require('../utils/logger');
const { toSafeError } = require('../utils/errors');
const { getAnalyticsPool } = require('../database/analytics-connection');
const impact = require('../services/signalImpactService');

router.get('/', async (req, res) => {
  const { client_id: clientId, location_id: locationId } = req.user;
  try {
    const data = await impact.signalImpactLedger(getAnalyticsPool(), clientId, locationId, {
      windowDays: req.query.window,
      sinceDays: req.query.days,
    });
    res.json({ data });
  } catch (err) {
    const safe = toSafeError(err);
    logger.error('Signal impact ledger failed', {
      error: err.message, code: safe.code, status: safe.statusCode, clientId, locationId,
    });
    res.status(safe.statusCode).json({ error: { code: safe.code, message: safe.userMessage } });
  }
});

/**
 * GET /api/signal-impact/today
 *     → { data: signalImpactService.signalsToday(...) }
 *
 * The present tense for the Recommendations rail: one row per signal live on
 * the latest run's day, labelled from that run's snapshot, with the weekly
 * fit's verdict in words (measured / not yet measurable / not fitted) and the
 * cards it reached. No query parameters; the run is the tenant's latest.
 */
router.get('/today', async (req, res) => {
  const { client_id: clientId, location_id: locationId } = req.user;
  try {
    const data = await impact.signalsToday(getAnalyticsPool(), clientId, locationId);
    res.json({ data });
  } catch (err) {
    const safe = toSafeError(err);
    logger.error('Signals today failed', {
      error: err.message, code: safe.code, status: safe.statusCode, clientId, locationId,
    });
    res.status(safe.statusCode).json({ error: { code: safe.code, message: safe.userMessage } });
  }
});

module.exports = router;
