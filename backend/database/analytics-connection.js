// Separate pg.Pool dedicated to the bottleai_analytics database.
// This is intentionally isolated from the production `syncgo` pool - analytics
// reads/writes can never block or compete with user-facing chat queries.
const { Pool } = require('pg');

let pool = null;

function getAnalyticsPool() {
  if (pool) return pool;

  pool = new Pool({
    host:     process.env.ANALYTICS_PG_HOST     || 'localhost',
    port:     parseInt(process.env.ANALYTICS_PG_PORT || '5432'),
    database: process.env.ANALYTICS_PG_DATABASE || 'bottleai_analytics',
    user:     process.env.ANALYTICS_PG_USER     || process.env.PG_USER,
    password: process.env.ANALYTICS_PG_PASSWORD || process.env.PG_PASSWORD,

    // Conservative limits - analytics is single-INSERT writes, no need for many connections.
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });

  pool.on('error', (err) => {
    console.error('[Analytics DB] Unexpected pool error:', err.message);
  });

  console.log(`[Analytics DB] Pool created for database: ${process.env.ANALYTICS_PG_DATABASE || 'bottleai_analytics'}`);
  return pool;
}

// Light health-check used at server startup (optional - not required for app function).
async function testAnalyticsConnection() {
  try {
    const p = getAnalyticsPool();
    await p.query('SELECT 1');
    console.log('[Analytics DB] Connection verified');
    return true;
  } catch (err) {
    console.warn(`[Analytics DB] Connection failed (analytics will be silently skipped): ${err.message}`);
    return false;
  }
}

module.exports = { getAnalyticsPool, testAnalyticsConnection };
