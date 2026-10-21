-- ============================================================================
-- 024_card_statement_events.sql - the activity trail behind a statement's log
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js - see 001.)
--
-- A statement row carries the OUTCOME of reading it (status, parse_confidence,
-- parse_ms, parse_error). What it does not carry is the HISTORY: when it was
-- uploaded and by whom, when the read finished, whether it was found to be a
-- copy of another statement, who re-ran it, and who asked about Rebelipay.
-- The log modal on the screen shows that history; this table is it.
--
-- WHY
--
--   Mirrors 010_po_events.sql, for the same reasons:
--
--   APPEND-ONLY. Rows are never updated or deleted on their own; they go when
--   the statement goes (ON DELETE CASCADE). An audit trail that can be edited
--   answers no question worth asking. 025 grants INSERT and SELECT only.
--
--   jsonb PAYLOAD. Each event carries different facts - an upload has a file
--   name and a size, an analysis has a confidence and a check count, a
--   duplicate names the statement it duplicates. It is rendered, not queried.
--   The payload never holds the extracted statement, and never holds the parts
--   of Rebelipay's price (contract D7): only totals and all-in rates.
--
--   NOT AN ERROR PATH. Writing an event must never fail the operation it
--   describes; the service swallows and logs failures.
--
--   Events: uploaded, analysed, analysis_failed, duplicate, reanalysed,
--   interrupted, rebelipay_interest. Deletion is logged by the server logger,
--   because the row and its events are gone.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS card_statement_events (
  id                bigserial   PRIMARY KEY,
  statement_id      bigint      NOT NULL
                                REFERENCES card_statements (id) ON DELETE CASCADE,
  -- Denormalised from the parent so the tenant filter never needs a join, and
  -- so a query cannot accidentally read another client's trail.
  client_id         integer     NOT NULL,
  location_id       integer,

  event             text        NOT NULL,

  -- Who did it. Null for events the system raises on its own (an analysis
  -- finishing, a restart sweep), which is how the log tells the two apart.
  actor             text,

  payload           jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- The log modal: one statement's trail, oldest first.
CREATE INDEX IF NOT EXISTS card_statement_events_statement_idx
  ON card_statement_events (statement_id, created_at);

-- A client's recent activity, and tenant-wide support queries.
CREATE INDEX IF NOT EXISTS card_statement_events_client_idx
  ON card_statement_events (client_id, created_at DESC);

COMMENT ON TABLE card_statement_events IS
  'Append-only activity trail per card statement (uploaded, analysed, analysis_failed, '
  'duplicate, reanalysed, interrupted, rebelipay_interest). Cascades with the statement.';

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- SELECT has_table_privilege('bottleai_writer','card_statement_events','INSERT');  -- expect t (after 025)
-- SELECT has_table_privilege('bottleai_writer','card_statement_events','UPDATE');  -- expect f
-- SELECT event, count(*) FROM card_statement_events GROUP BY 1 ORDER BY 2 DESC;
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS card_statement_events;
