/**
 * Feedback service - persists user product feedback to the analytics DB.
 *
 * Two entry points on the UI feed one table:
 *   - in-chat banner   → { source: 'chat',    sentiment: 'up'|'down', message? }
 *   - session prompt    → { source: 'session', rating: 1..5,           message? }
 * Either can also carry a free-text `message` (the "write to us" modal).
 *
 * Lives in the analytics DB beside chat telemetry (a product decision, isolated
 * from syncgo). Prefer provisioning the table up front (owner runs the CREATE +
 * GRANT SELECT, INSERT to bottleai_writer); ensureTable() then only probes the
 * catalog and needs no CREATE. If it is missing it self-provisions, which needs
 * schema-CREATE. Same approach as storeagent_capability_results.
 */
const { getAnalyticsPool } = require('../database/analytics-connection');
const logger = require('../utils/logger');

// Lazily ensure the feedback table exists (once per process). It is normally
// provisioned up front in the analytics DB, so the common path is a catalog
// probe - a read any role can run - and we skip the CREATE DDL. That DDL needs
// schema-CREATE the least-privilege bottleai_writer role lacks (CREATE TABLE IF
// NOT EXISTS still checks CREATE on the schema even when the table already
// exists - the trap that surfaced as "permission denied for schema public").
// Mirrors storeagent_capability_results' ensureTable. Any failure resets the
// memo so a later call retries; the GET caller degrades to null, POST 500s.
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    const pool = getAnalyticsPool();
    tableReady = pool
      .query(`SELECT to_regclass('public.feedback') IS NOT NULL AS exists`)
      .then((probe) => {
        // Already present → nothing to do (no DDL, no privileges needed).
        if (probe.rows[0].exists) return undefined;
        // Missing → provision it. Needs CREATE / ownership; if the role can't,
        // this rejects and the caller handles it (see above).
        return pool.query(
          `CREATE TABLE IF NOT EXISTS feedback (
             id              BIGSERIAL PRIMARY KEY,
             client_id       INTEGER,
             location_id     INTEGER,
             user_id         VARCHAR(100),
             username        VARCHAR(150),
             conversation_id VARCHAR(100),
             source          VARCHAR(20)  NOT NULL CHECK (source IN ('chat', 'session')),
             sentiment       VARCHAR(10)  CHECK (sentiment IN ('up', 'down')),
             rating          SMALLINT     CHECK (rating BETWEEN 1 AND 5),
             message         TEXT,
             created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
           );
           CREATE INDEX IF NOT EXISTS idx_feedback_tenant
             ON feedback (client_id, location_id, created_at DESC);`
        );
      })
      .catch((err) => {
        tableReady = null; // allow a later retry
        throw err;
      });
  }
  return tableReady;
}

const MAX_MESSAGE_LEN = 5000;

/**
 * Persist one feedback row. Tenant/user come from the caller (JWT), never the
 * body. Returns the inserted row id.
 * @param {object} d
 * @param {number} d.clientId
 * @param {number} d.locationId
 * @param {string} d.userId
 * @param {string} [d.username]
 * @param {string} [d.conversationId]
 * @param {'chat'|'session'} d.source
 * @param {'up'|'down'} [d.sentiment]
 * @param {number} [d.rating]        1..5
 * @param {string} [d.message]       free-text description
 */
async function saveFeedback(d) {
  await ensureTable();
  const pool = getAnalyticsPool();

  const message = typeof d.message === 'string' ? d.message.trim().slice(0, MAX_MESSAGE_LEN) : null;
  const { rows } = await pool.query(
    `INSERT INTO feedback
       (client_id, location_id, user_id, username, conversation_id,
        source, sentiment, rating, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      d.clientId ?? null,
      d.locationId ?? null,
      d.userId || null,
      d.username || null,
      d.conversationId || null,
      d.source,
      d.sentiment || null,
      d.rating ?? null,
      message || null,
    ]
  );
  const id = rows[0]?.id;
  logger.info('[Feedback] saved', { id, source: d.source, sentiment: d.sentiment, rating: d.rating, hasMessage: !!message });
  return id;
}

/**
 * When this store last gave any feedback (Date or null). Drives the frontend's
 * cross-device ask cooldown: the prompt gate treats it as "last answered", so
 * a store that responded on one device isn't re-asked from another (or after
 * clearing browser storage).
 */
async function lastFeedbackAt(clientId, locationId) {
  await ensureTable();
  const { rows } = await getAnalyticsPool().query(
    `SELECT max(created_at) AS last_at FROM feedback
      WHERE client_id = $1 AND location_id = $2`,
    [clientId ?? null, locationId ?? null]
  );
  return rows[0]?.last_at || null;
}

module.exports = { saveFeedback, ensureTable, lastFeedbackAt, MAX_MESSAGE_LEN };
