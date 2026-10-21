-- ============================================================================
-- 010_po_events.sql - the activity trail behind a document's parser log
--
-- Every document already carries the OUTCOME of parsing (status, parse_model,
-- parse_confidence, parse_ms, notes). What it does not carry is the HISTORY:
-- who uploaded it, when the parse finished and what it produced, and which
-- lines a person corrected afterwards.
--
-- That history is the difference between "confidence 64%" and knowing why. A
-- document with a low score that nobody has touched is a parse to look at; the
-- same score on a document whose lines were all corrected by hand is a parse
-- that has already been dealt with. Only an append-only trail can tell them
-- apart.
--
-- APPEND-ONLY. Rows are never updated or deleted on their own; they go when
-- the document goes (ON DELETE CASCADE). An audit trail that can be edited
-- answers no question worth asking.
--
-- WHY jsonb FOR THE PAYLOAD. Each event carries different facts - an upload
-- has a filename and a size, a parse has an item count and a confidence, an
-- edit has the ids of the lines touched. Giving each a column would leave most
-- of them null on most rows; a jsonb blob keeps the shape with the event that
-- owns it. It is rendered, not queried, so it needs no schema.
--
-- NOT AN ERROR PATH. Writing an event must never fail the operation it
-- describes: an invoice that parsed correctly but could not be logged is still
-- a parsed invoice. The service wraps every write and swallows failures.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS purchase_order_events (
  id                bigserial   PRIMARY KEY,
  purchase_order_id bigint      NOT NULL
                                REFERENCES purchase_orders (id) ON DELETE CASCADE,
  -- Denormalised from the parent so the tenant filter never needs a join, and
  -- so a query cannot accidentally read another store's trail.
  client_id         integer     NOT NULL,
  location_id       integer     NOT NULL,

  -- Dotted names, matching what the UI shows: uploaded, parsed, parse_failed,
  -- items.edited, items.mapped, items.unmapped, reparsed.
  event             text        NOT NULL,

  -- Who did it. Null for events the system raises on its own (a parse
  -- finishing), which is exactly how the UI tells the two apart.
  actor             text,

  payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- The only read there is: one document's trail, newest first.
CREATE INDEX IF NOT EXISTS idx_po_events_order
  ON purchase_order_events (purchase_order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_po_events_tenant
  ON purchase_order_events (client_id, location_id);

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS purchase_order_events;
