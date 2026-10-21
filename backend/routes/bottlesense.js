/**
 * BottleSense routes - the measurement models from the August 2026 BottleSense
 * research, computed for the signed-in store.
 *
 * Mounted at `/api/bottlesense` behind verifyToken + attachPool (server.js):
 *   GET /api/bottlesense   → the whole screen in one payload
 *
 * One endpoint on purpose. The research's third "habit not to copy" is that the
 * same metric name is computed independently in sixteen of their datasets, so
 * two of their dashboards can disagree and both be correct. Every figure on this
 * screen comes from one service call over one as-of date, so the tiles cannot
 * drift apart from each other.
 *
 * Tenant keys come from the JWT (req.user), so the client_id + location_id
 * filter is always satisfied - req.pool is `syncgo`, which holds sales,
 * products and cost.
 *
 * Error shape matches the rest of the app: { "error": { "code", "message" } }.
 */

const router = require('express').Router();
const logger = require('../utils/logger');
const { toSafeError } = require('../utils/errors');
const svc = require('../services/bottleSenseService');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function sendError(res, err, context) {
  const safe = toSafeError(err);
  logger.error(`BottleSense ${context} failed`, {
    error: err.message, code: safe.code, status: safe.statusCode,
  });
  res.status(safe.statusCode).json({ error: { code: safe.code, message: safe.userMessage } });
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    try {
      const data = await svc.getBottleSense(req.pool, clientId, locationId);
      res.json(data);
    } catch (err) {
      sendError(res, err, 'report');
    }
  }),
);

module.exports = router;
