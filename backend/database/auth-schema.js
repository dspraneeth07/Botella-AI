/**
 * Verify that the users table is accessible.
 * The table is managed externally - we just check connectivity.
 */
async function verifyAuthConnection(pool) {
  try {
    await pool.query('SELECT 1 FROM users LIMIT 1');
    console.log('[Auth] users table accessible');
  } catch (err) {
    console.error('[Auth] Cannot access users table:', err.message);
  }
}

module.exports = { verifyAuthConnection };
