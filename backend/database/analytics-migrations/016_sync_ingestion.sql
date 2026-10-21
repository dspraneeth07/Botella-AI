-- ============================================================================
-- Analytics migration 016 — ingestion durability, isolation and staleness
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js — see 001.)
--
-- WHY THIS IS IN analytics-migrations/ AND NOT migrations/003_
--   Sheet 01 says to add this as `backend/database/migrations/003_`. That
--   folder targets the SYNCGO warehouse, and these tables must not go there:
--
--     * The app role on syncgo is SELECT-only BY DESIGN (see database/
--       migrate.js: "syncgo: SYNCGO_MIGRATE_DSN, REQUIRED - there is no
--       fallback on purpose"). A table the ingestion control plane has to
--       INSERT into every few minutes cannot live on a connection that is not
--       allowed to write.
--     * syncgo is the POS vendor's warehouse — the record of what the stores
--       sold. These are OUR operational tables: our raw log, our failure
--       classification, our staleness marker. Mixing them in makes the
--       warehouse's ownership ambiguous and couples our deploys to a DBA.
--     * Every downstream consumer of staleness (the rec pipeline, sheet 02's
--       refusal rule) already reads the analytics pool. Putting the marker in
--       syncgo would force a second pool into every reader.
--
--   So: analytics, numbered 016 in sequence. Nothing else about the sheet
--   changes.
--
-- WHAT THIS ADDS
--   Ingestion works. What it lacks is isolation and replay. 25.5% of all sync
--   runs fail (132,611 of 519,702 measured on the live warehouse — the sheet
--   said 26.1% of 504,366; the table has grown since). At 94 stores a person
--   reads those. At 1,500 they are background noise and stores go dark while
--   the engine keeps serving stale data with full confidence.
--
--   sync_raw_log     — every fetch landed AS RECEIVED, before any parsing.
--       Replay becomes reading a row instead of re-fetching from a POS that
--       may no longer hold the data. Deduped on payload_sha256 within a
--       connector+store, so a re-fetch of identical bytes is RECORDED (the
--       fetch happened) without storing the document twice.
--
--   sync_store_state — the staleness marker the "do not reintroduce" rule
--       demands. A failed sync must never leave the previous data in place
--       with no marker: a store whose last success was eleven days ago is
--       visibly eleven days stale to every downstream stage, and sheet 02 can
--       refuse on it. Also holds the consecutive-failure count and the
--       disable flag that stop a dead job retrying forever.
--
--   sync_connector_digest — one row per connector per day. The single change
--       that makes 1,500 stores operable: one ticket per connector per day,
--       never one per store. Carries the coverage columns too, because the
--       cost gap tracks the CONNECTOR, not the store (measured on the live
--       warehouse: Square and Gokul and MPower sit at 0.0% cost coverage
--       across 31 stores and 355k SKUs, while EPOSNow reaches 99.4% — a
--       connector-level defect that has been read as a per-store data problem).
-- ============================================================================

BEGIN;

-- ── The durable raw log ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_raw_log (
  id             bigserial   PRIMARY KEY,
  connector      text        NOT NULL,      -- client_pos_config.pos_type, normalized lower
  client_id      integer     NOT NULL,
  location_id    integer     NOT NULL,
  -- products | sales | customers | purchases | suppliers. Failures are
  -- per (store, entity) — Gokul can sync products and cannot sync suppliers —
  -- so the raw log has to carry it or replay cannot find the right payload.
  entity         text        NOT NULL,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  payload_sha256 char(64)    NOT NULL,
  -- The response AS RECEIVED. NULL only when the fetch itself failed, which
  -- is still worth a row: "we asked and got nothing" is the fact being kept.
  payload        jsonb,
  bytes          integer     NOT NULL DEFAULT 0,

  -- A re-fetch of identical bytes is the COMMON case (most syncs change
  -- nothing). Recording it as a new document would multiply the table by the
  -- sync frequency for no information. Instead the first landing wins and the
  -- counters below record that it happened again.
  first_fetched_at timestamptz NOT NULL DEFAULT now(),
  fetch_count      integer     NOT NULL DEFAULT 1,

  UNIQUE (connector, client_id, location_id, entity, payload_sha256)
);

-- Replay reads "the payload for this store+entity around this time".
CREATE INDEX IF NOT EXISTS idx_sync_raw_tenant_fetched
  ON sync_raw_log (client_id, location_id, entity, fetched_at DESC);

-- Retention sweeps and cross-tenant "what did we land yesterday".
CREATE INDEX IF NOT EXISTS idx_sync_raw_fetched
  ON sync_raw_log (fetched_at DESC);

COMMENT ON TABLE sync_raw_log IS
  'Every POS fetch landed as-received before parsing. Deduped by payload_sha256 within connector+store+entity; fetch_count records re-observations.';

-- ── Per-store sync state: the staleness marker ───────────────────────────────
CREATE TABLE IF NOT EXISTS sync_store_state (
  client_id   integer NOT NULL,
  location_id integer NOT NULL,
  entity      text    NOT NULL,
  connector   text,

  -- THE field sheet 02 refuses on. Deliberately only ever moved forward by a
  -- SUCCESS: a failed sync must leave it exactly where it was, so the store
  -- reads as eleven days stale rather than as freshly synced with old data.
  last_successful_sync timestamptz,
  last_attempt_at      timestamptz,

  -- Retry/disable state. consecutive_failures resets to 0 on success.
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_failure_class   text CHECK (last_failure_class IS NULL OR last_failure_class IN
                         ('transient', 'credential', 'schema', 'dead')),
  last_error           text,
  last_failure_at      timestamptz,

  -- Set when a job is disabled after N consecutive failures. Disabled jobs
  -- stop consuming retries; the connector gets ONE ticket, not one per store.
  disabled_at     timestamptz,
  disabled_reason text,

  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, location_id, entity)
);

-- "Which stores are stale" across the estate — the digest's staleness column
-- and any downstream sweep. Nulls sort first, which is correct: a store that
-- has NEVER succeeded is the most stale thing there is.
CREATE INDEX IF NOT EXISTS idx_sync_state_staleness
  ON sync_store_state (last_successful_sync ASC NULLS FIRST);

CREATE INDEX IF NOT EXISTS idx_sync_state_connector
  ON sync_store_state (connector, last_successful_sync ASC NULLS FIRST);

-- Triage: the disabled and the repeatedly-failing, without scanning healthy rows.
CREATE INDEX IF NOT EXISTS idx_sync_state_unhealthy
  ON sync_store_state (connector, consecutive_failures DESC)
  WHERE consecutive_failures > 0 OR disabled_at IS NOT NULL;

COMMENT ON COLUMN sync_store_state.last_successful_sync IS
  'Advanced ONLY by a successful sync. A failure leaves it stale on purpose so downstream stages can see the staleness and refuse.';

-- ── Connector-level daily digest ─────────────────────────────────────────────
-- One row per connector per day. Per-store alerting does not survive 1,500
-- stores; per-connector does, and it is also the level the defects actually
-- live at (a 401 is one dead credential for one merchant; 27,000 Clover 401s
-- across four merchants is one connector ticket).
CREATE TABLE IF NOT EXISTS sync_connector_digest (
  digest_date date    NOT NULL,
  connector   text    NOT NULL,

  stores           integer NOT NULL DEFAULT 0,
  runs             integer NOT NULL DEFAULT 0,
  succeeded        integer NOT NULL DEFAULT 0,
  failed           integer NOT NULL DEFAULT 0,
  -- Failures split by class, so the reader knows which queue this belongs in
  -- before opening anything.
  transient_count  integer NOT NULL DEFAULT 0,
  credential_count integer NOT NULL DEFAULT 0,
  schema_count     integer NOT NULL DEFAULT 0,
  dead_count       integer NOT NULL DEFAULT 0,

  -- Staleness across the connector's stores, in days since last success.
  stores_stale     integer NOT NULL DEFAULT 0,  -- beyond the freshness budget
  stores_never     integer NOT NULL DEFAULT 0,  -- never synced successfully
  max_stale_days   integer,
  median_stale_days integer,

  -- Coverage, first-class and per connector. This is the number that turns
  -- "some stores have no cost data" into "this connector does not send cost".
  skus             integer,
  cost_coverage_pct     numeric(5,2),
  category_coverage_pct numeric(5,2),

  -- The worst offenders, for the one ticket: [{store, entity, class, error}]
  exemplars jsonb NOT NULL DEFAULT '[]'::jsonb,

  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (digest_date, connector)
);

CREATE INDEX IF NOT EXISTS idx_sync_digest_date
  ON sync_connector_digest (digest_date DESC);

COMMENT ON TABLE sync_connector_digest IS
  'One row per connector per day. Failures, staleness and field coverage aggregated at the level the defects actually live at.';

-- ── Grants ───────────────────────────────────────────────────────────────────
-- Upsert everywhere; no DELETE for the app role. Pruning the raw log is a
-- retention job with admin credentials, never something a request path can do.
GRANT SELECT, INSERT, UPDATE ON TABLE sync_raw_log           TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE sync_store_state       TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE sync_connector_digest  TO bottleai_writer;
GRANT USAGE, SELECT ON SEQUENCE sync_raw_log_id_seq          TO bottleai_writer;

COMMIT;

-- ── Verify (run as the app role) ─────────────────────────────────────────────
-- SELECT has_table_privilege('bottleai_writer','sync_raw_log','INSERT');  -- expect t
-- -- Who is dark, worst first:
-- SELECT connector, client_id, location_id, entity,
--        (now()::date - last_successful_sync::date) AS days_stale,
--        consecutive_failures, last_failure_class
--   FROM sync_store_state
--  ORDER BY last_successful_sync ASC NULLS FIRST LIMIT 20;
-- -- Yesterday's one-ticket-per-connector view:
-- SELECT connector, failed, credential_count, schema_count, stores_stale,
--        cost_coverage_pct
--   FROM sync_connector_digest WHERE digest_date = current_date - 1
--  ORDER BY failed DESC;
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS sync_connector_digest;
-- DROP TABLE IF EXISTS sync_store_state;
-- DROP TABLE IF EXISTS sync_raw_log;
