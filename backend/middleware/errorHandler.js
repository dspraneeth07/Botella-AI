/**
 * Global Error Handler Middleware - Botella
 *
 * Catches all unhandled errors from routes.
 * - Logs full details (with stack trace) via Winston
 * - Sends user-friendly message to client (never leaks internals)
 * - Consistent JSON error response format
 */

const logger = require('../utils/logger');
const { AppError, toSafeError } = require('../utils/errors');

function errorHandler(err, req, res, _next) {
  // Convert to safe error if it's a raw Error
  const safeErr = err instanceof AppError ? err : toSafeError(err);

  // Log full details internally
  logger.error(safeErr.userMessage, {
    code: safeErr.code,
    statusCode: safeErr.statusCode,
    internalMessage: safeErr.internalMessage || err.message,
    stack: err.stack,
    path: req.originalUrl,
    method: req.method,
    clientId: req.user?.client_id,
    locationId: req.user?.location_id,
    username: req.user?.username,
  });

  // Don't send response if headers already sent (e.g. SSE streaming)
  if (res.headersSent) return;

  // Send consistent, user-friendly response
  res.status(safeErr.statusCode).json({
    error: {
      code: safeErr.code,
      message: safeErr.userMessage,
    },
  });
}

module.exports = errorHandler;
