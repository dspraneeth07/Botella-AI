const { Pool } = require('pg');

// Single pool - all data in one database, isolated by client_id + location_id
let pool = null;

/**
 * Get the single connection pool (created lazily on first call).
 */
function getPool() {
  if (pool) return pool;

  pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'syncgo',
    user: process.env.PG_USER || 'bottela',
    password: process.env.PG_PASSWORD || '',
    // Capacity - dashboard fires ~12 queries in parallel and chat runs concurrently,
    // so default max=10 causes connection queueing + starvation. Room to grow.
    max: 20,
    // Close idle clients after 30s so we don't pin 20 sockets forever.
    idleTimeoutMillis: 30000,
    // Fail fast if PG is unreachable instead of hanging the request.
    connectionTimeoutMillis: 5000,
    // Hard DB-side cap - kills any runaway query so it doesn't block a pool slot.
    statement_timeout: 15000,
    // BOTELLA_READ_ONLY_DB=true makes every session read-only at the Postgres level -
    // any INSERT/UPDATE/DELETE/DDL fails server-side regardless of what SQL the LLM
    // produces. Defense in depth beyond the isSafeQuery() regex (which is the ONLY
    // guard otherwise). Used by eval runs and recommended for prod until a dedicated
    // read-only role exists.
    ...(process.env.BOTELLA_READ_ONLY_DB === 'true'
      ? { options: '-c default_transaction_read_only=on' }
      : {}),
  });

  pool.on('error', (err) => {
    console.error('[DB] Unexpected PostgreSQL pool error:', err);
  });

  console.log(`[DB] Pool created for database: ${process.env.PG_DATABASE || 'syncgo'}${
    process.env.BOTELLA_READ_ONLY_DB === 'true' ? ' (READ-ONLY sessions enforced)' : ''}`);
  return pool;
}

/**
 * Test connection to the database.
 */
async function testConnection() {
  const p = getPool();
  await p.query('SELECT NOW()');
  console.log(`[DB] Connected to PostgreSQL (${process.env.PG_DATABASE || 'syncgo'})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TENANT SCOPING (Finding #1 - defense-in-depth below the SQL validator)
// ─────────────────────────────────────────────────────────────────────────────
// Run ONE query inside a transaction that sets the per-request tenant GUCs
// (app.client_id / app.location_id) LOCALLY. Postgres Row-Level-Security
// policies (database/migrations/002_tenant_rls.sql) read these GUCs and filter
// EVERY row to this session's tenant - so even if a model-authored run_sql query
// slipped past the app-layer validator, the database itself returns zero rows
// for any other tenant.
//
// Why a transaction + set_config(...,true): is_local=true scopes the setting to
// THIS transaction, so it auto-clears on COMMIT/ROLLBACK and can NEVER leak to
// the next checkout of a pooled connection. set_config is parameterized (no
// string interpolation of ids). When RLS is NOT yet enabled (the state today,
// before a DBA applies the migration), the GUCs are simply unread and this
// behaves exactly like pool.query - zero behavior change, zero risk.
async function tenantScopedQuery(pool, clientId, locationId, text, params) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      "SELECT set_config('app.client_id', $1, true), set_config('app.location_id', $2, true)",
      [String(clientId ?? ''), String(locationId ?? '')]
    );
    const res = await c.query(text, params);
    await c.query('COMMIT');
    return res;
  } catch (err) {
    try { await c.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
    throw err;
  } finally {
    c.release();
  }
}

// A drop-in replacement for a pg Pool whose .query() is tenant-scoped. Callers
// keep using `pool.query(text, params)` unchanged; .connect()/.raw expose the
// underlying pool for the rare path that manages its own transaction (those
// paths are the parameterized-tenant surfaces, already safe; they must set the
// GUCs themselves before RLS is enabled fleet-wide - see the migration notes).
function makeTenantScopedPool(pool, clientId, locationId) {
  return {
    query: (text, params) => tenantScopedQuery(pool, clientId, locationId, text, params),
    connect: (...args) => pool.connect(...args),
    raw: pool,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// run_sql safety gate (Finding #1 - the regex validator is NOT a sufficient
// boundary). An adversarial red-team (tests/redteam-verify.js) showed the
// app-layer validator cannot prove an arbitrary query scopes EVERY tenant table
// (an unfiltered table inside a subquery/CTE/join slips past any regex). RLS IS
// that proof. So the raw run_sql fallback is allowed ONLY when RLS is active on
// the tenant tables - probed once at boot. Explicit opt-out
// (BOTELLA_ALLOW_RUNSQL_WITHOUT_RLS=true) exists for eval/dev that accept the
// validator-only posture; hard kill-switch (BOTELLA_DISABLE_RUN_SQL=true) always
// wins. Production sets neither → run_sql is OFF until the DBA applies migration
// 002, and the bot answers via the tenant-bound metric tools.
let _rlsActive = null; // null = not yet probed
async function probeRlsActive(pool) {
  try {
    const r = await pool.query(
      `SELECT bool_and(relrowsecurity) AS on FROM pg_class
        WHERE relkind='r' AND relname = ANY($1)`,
      [['products', 'sales', 'sale_items', 'purchases', 'suppliers', 'customers']]
    );
    _rlsActive = r.rows[0] && r.rows[0].on === true;
  } catch (_) { _rlsActive = false; }
  return _rlsActive;
}
function rlsActive() { return _rlsActive; }
function isRunSqlAllowed() {
  if (process.env.BOTELLA_DISABLE_RUN_SQL === 'true') return false;
  if (process.env.BOTELLA_ALLOW_RUNSQL_WITHOUT_RLS === 'true') return true;
  return _rlsActive === true;
}

module.exports = {
  getPool, testConnection, tenantScopedQuery, makeTenantScopedPool,
  probeRlsActive, rlsActive, isRunSqlAllowed,
};
