/**
 * Money audit - per card, did this store make or lose money on it, or can that
 * not be said yet (services/moneyAuditService.js).
 *
 * Mounted at `/api/recommendations/money-audit` behind verifyToken +
 * attachPool (server.js), the same gate as /api/recommendations and
 * /api/signal-impact. It is its own router rather than a route inside
 * routes/recommendations.js because that file is being edited concurrently;
 * the recommendations router has no bare `/:id` GET, so a request for
 * `/money-audit` falls through it to this mount.
 *
 *   GET /api/recommendations/money-audit?days=120
 *       → { data: moneyAuditService.moneyAudit(...) }
 *
 * `days` bounds how far back "issued" reaches (1..365, default 120) and is
 * clamped, never rejected. Tenant keys come from the JWT (req.user): an owner
 * sees their own store's audit and nothing else. The analytics pool is fetched
 * here; req.pool (syncgo) is attached by the mount and unused.
 *
 * Error shape matches the rest of the app: { "error": { "code", "message" } }.
 */

const router = require('express').Router();
const logger = require('../utils/logger');
const { toSafeError } = require('../utils/errors');
const { getAnalyticsPool } = require('../database/analytics-connection');
const audit = require('../services/moneyAuditService');

router.get('/', async (req, res) => {
  const { client_id: clientId, location_id: locationId } = req.user;
  try {
    const data = await audit.moneyAudit(getAnalyticsPool(), clientId, locationId, {
      sinceDays: req.query.days,
    });
    res.json({ data });
  } catch (err) {
    const safe = toSafeError(err);
    logger.error('Money audit failed', {
      error: err.message, code: safe.code, status: safe.statusCode, clientId, locationId,
    });
    res.status(safe.statusCode).json({ error: { code: safe.code, message: safe.userMessage } });
  }
});

module.exports = router;
