const router = require('express').Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { JWT_SECRET } = require('../middleware/auth');
const { getPool } = require('../database/connection');
const { getAnalyticsPool } = require('../database/analytics-connection');
const storeIntelligenceService = require('../services/storeIntelligenceService');

/**
 * Verify an ASP.NET Core Identity v3 password hash.
 * Format: version(1) | prf(4 BE) | iterations(4 BE) | saltLen(4 BE) | salt(saltLen) | subkey(32)
 * PRF: 0=SHA1, 1=SHA256, 2=SHA512
 */
function verifyIdentityV3Hash(password, hashedPassword) {
  const buf = Buffer.from(hashedPassword, 'base64');

  if (buf.length < 13 || buf[0] !== 0x01) {
    return false; // Not a v3 hash
  }

  const prf = buf.readUInt32BE(1);
  const iterations = buf.readUInt32BE(5);
  const saltLen = buf.readUInt32BE(9);

  if (buf.length < 13 + saltLen) return false;

  const salt = buf.subarray(13, 13 + saltLen);
  const expectedSubkey = buf.subarray(13 + saltLen);

  // Map PRF to hash algorithm
  const algorithms = { 0: 'sha1', 1: 'sha256', 2: 'sha512' };
  const algo = algorithms[prf];
  if (!algo) return false;

  const derivedKey = crypto.pbkdf2Sync(password, salt, iterations, expectedSubkey.length, algo);

  return crypto.timingSafeEqual(derivedKey, expectedSubkey);
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const pool = getPool();

    // Query users joined with clients and client_locations
    const { rows } = await pool.query(
      `SELECT u.user_id, u.username, u.password_hash,
              u.client_id, u.location_id,
              c.client_name, c.contact_name,
              -- The store's own state drives comparable-store wording, so it is
              -- never hard-coded to one market. Location wins over client: a
              -- multi-site client can span states.
              COALESCE(NULLIF(cl.state, ''), NULLIF(c.state, '')) AS state,
              COALESCE(NULLIF(cl.city, ''),  NULLIF(c.city, ''))  AS city,
              cl.location_name
       FROM users u
       JOIN clients c ON c.client_id = u.client_id
       JOIN client_locations cl ON cl.location_id = u.location_id AND cl.client_id = u.client_id
       WHERE u.username = $1 AND u.is_active = true`,
      [username.trim().toLowerCase()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const user = rows[0];

    // Verify password against ASP.NET Core Identity v3 hash
    const valid = verifyIdentityV3Hash(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // Generate JWT token (24h expiry)
    const token = jwt.sign(
      {
        user_id: user.user_id,
        username: user.username,
        client_id: user.client_id,
        location_id: user.location_id,
        client_name: user.client_name,
        location_name: user.location_name,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    console.log(`[Auth] Login: ${user.username} → Client ${user.client_id}, Location ${user.location_id} (${user.location_name})`);

    res.json({
      token,
      client_id: user.client_id,
      location_id: user.location_id,
      client_name: user.client_name,
      location_name: user.location_name,
      // contact_name is the account contact. In much of the data it simply
      // repeats client_name, so the client decides whether it is a usable
      // person name rather than trusting it blindly.
      contact_name: user.contact_name,
      state: user.state,
      city: user.city,
      username: user.username,
    });

    // Recompute this store's intelligence for the new session. Deliberately
    // after res.json() and never awaited: it is warehouse work measured in
    // tens of seconds, and login must not wait for it. The service guards
    // against repeat logins piling up duplicate runs.
    try {
      storeIntelligenceService.refreshStoreOnLogin(
        getAnalyticsPool(), user.client_id, user.location_id);
    } catch (bgErr) {
      require('../utils/logger').warn('[Auth] login refresh could not start', { error: bgErr.message });
    }
  } catch (err) {
    const logger = require('../utils/logger');
    const { toSafeError } = require('../utils/errors');
    const safeErr = toSafeError(err);
    logger.error('Login failed', { error: err.message });
    res.status(safeErr.statusCode).json({ error: { code: safeErr.code, message: safeErr.userMessage } });
  }
});

module.exports = router;
