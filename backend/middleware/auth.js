const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Shared secret for machine callers (the Python recommendation service hitting
// /api/clients/* and /api/ingestion/*).
//
// IT IS REQUIRED IN PRODUCTION. This used to read "unset = those routes stay
// open (dev / network-guarded)", and the guard was doing all the work: the prod
// compose publishes the backend on 3000 across EVERY host interface - it has to,
// because the Python container reaches Node through the bridge gateway and a
// loopback bind is unreachable from there - so the only thing standing between
// the open internet and these routes is an EC2 security group rule. That is one
// console edit away from exposing, unauthenticated:
//
//   every tenant's sales, inventory and signal history (GET, any client_id in
//   the path - the routes tenant-scope by path param, not by who is asking)
//   and WRITES to analytics: PUT signal-effects, PUT calibration-bundle,
//   PUT gate-verdict. An attacker who can publish a calibration bundle decides
//   what confidence figure every card in the estate displays.
//
// So this follows exactly the rule JWT_SECRET follows twenty lines below, and
// for the same reason: fail closed, at startup, loudly.
const NODE_API_TOKEN = process.env.NODE_API_TOKEN || '';
if (!NODE_API_TOKEN && process.env.NODE_ENV === 'production') {
  throw new Error(
    'NODE_API_TOKEN is not set - refusing to start with the machine-to-machine '
    + 'integration routes open. They serve the sales data of every tenant and '
    + 'accept '
    + 'writes to analytics, scoped by path parameter rather than by caller. '
    + 'Generate one with `openssl rand -hex 32` and set the SAME value in '
    + 'backend/.env (NODE_API_TOKEN) and Botella_External_APIs/.env '
    + '(NODE_API_TOKEN).'
  );
}

// Outside production an unset token leaves the routes reachable from LOOPBACK
// ONLY. That keeps the documented dev flow working - `node server.js` plus a
// local uvicorn, both on 127.0.0.1 - while removing the property that actually
// matters, which is being reachable from the network by anyone who finds the
// port. A containerised dev stack reaches Node through the bridge gateway, so it
// is NOT loopback and will get a 401 naming the variable: a discoverable
// failure rather than a silent open door.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
if (!NODE_API_TOKEN && process.env.NODE_ENV !== 'production') {
  console.warn(
    '[auth] NODE_API_TOKEN not set - the integration routes accept LOOPBACK '
    + 'callers only. Set the same value in backend/.env and '
    + 'Botella_External_APIs/.env to allow the Python service to reach them '
    + 'from a container or another host.'
  );
}

// Fail closed (Finding #1 cleanup): NEVER fall back to a fixed, source-visible
// default secret - that would let anyone forge a JWT for ANY tenant (a worse
// leak than the run_sql one). In production a missing secret aborts startup; in
// dev/test we use an ephemeral RANDOM secret (unguessable, per-process) instead.
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is not set - refusing to start with a default secret (it would allow cross-tenant token forgery).');
  }
  JWT_SECRET = require('crypto').randomBytes(48).toString('hex');
  console.warn('[auth] JWT_SECRET not set - using an ephemeral random secret for this process (dev/test only).');
}

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided. Please log in.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = {
      user_id: decoded.user_id,
      client_id: decoded.client_id,
      location_id: decoded.location_id,
      client_name: decoded.client_name,
      location_name: decoded.location_name,
      username: decoded.username,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token. Please log in again.' });
  }
}

/** Constant-time string compare (length leak is fine - the token is not guessable by length). */
function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Service-token gate for the machine-to-machine integration routes.
 *
 * With NODE_API_TOKEN set - mandatory in production, see above - requires
 * `Authorization: Bearer <NODE_API_TOKEN>` and rejects with the contract's
 * error envelope. Mounted between '/api/clients' and attachPool (server.js).
 *
 * Without it, outside production, admits loopback and refuses everything else.
 */
function verifyServiceToken(req, res, next) {
  if (!NODE_API_TOKEN) {
    // `req.socket.remoteAddress`, not `req.ip`: req.ip honours X-Forwarded-For
    // once `trust proxy` is on, and a header the caller controls must never be
    // what decides whether the caller is local.
    const peer = (req.socket && req.socket.remoteAddress) || '';
    if (LOOPBACK.has(peer)) return next();
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'NODE_API_TOKEN is not configured on this server, so the '
          + 'integration routes accept loopback callers only. Set the same '
          + 'value in backend/.env and Botella_External_APIs/.env.',
      },
    });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !timingSafeEqualStr(token, NODE_API_TOKEN)) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or missing service token.' },
    });
  }
  next();
}

module.exports = { verifyToken, verifyServiceToken, JWT_SECRET };
