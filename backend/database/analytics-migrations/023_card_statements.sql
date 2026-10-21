-- ============================================================================
-- 023_card_statements.sql - Card Statement Analysis
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js - see 001.)
--
-- An owner uploads a monthly card-processing statement (a PDF, or a transaction
-- export as CSV). Botella reads it, reconciles the printed numbers against each
-- other, analyses it deterministically and shows what the owner paid, where the
-- money leaks and what the same month would have cost with Rebelipay. The full
-- contract is CARD-STATEMENTS.md; this file is its section 2.1.
--
-- WHY
--
--   Why the analytics DB. A statement is Botella's own record of a document the
--   owner gave us, not POS truth - the same reasoning that put purchase orders
--   here (008). `syncgo` is the POS mirror, written by the sync and SELECT-only
--   to the app; nothing about a processor statement belongs in it.
--
--   Why scoped to the CLIENT and not the store. One merchant account often
--   serves several locations, and the owner reads statements per merchant, not
--   per login. Every query filters `client_id`; `location_id` records where the
--   upload came from and is never a visibility filter (contract D1).
--
--   Why JSONB and not child tables. The extraction, the analysis and the
--   reconciliation are each read WHOLE - the detail screen renders a statement,
--   it never edits one fee line - and nothing queries inside them. Child tables
--   for fee lines, daily rows and card types would add three writes per save to
--   a pool of five connections and buy no query anyone runs. The columns that
--   ARE queried (list, sort, store filter, history, duplicates) are promoted to
--   real columns below.
--
--   Why `duplicate` is a status and not a delete. A second upload of the same
--   statement (same merchant number and period end, found only after reading)
--   becomes a tombstone pointing at the original. The owner watched it upload,
--   so the screen has to be able to say where it went (contract D8). The
--   tombstone keeps no file and is never listed.
--
--   Why the identity index is UNIQUE when 021's is not. 021 left invoice
--   identity to the application because its key is fuzzy (vendor spellings,
--   invoice-number prefixes). A statement's key is exact - a merchant number
--   and a date - so the database can enforce it, and a unique violation on
--   save is how the service learns it is holding a duplicate. Partial on
--   `analysed`, so failed and in-flight rows never collide.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS card_statements (
  id                 bigserial PRIMARY KEY,
  client_id          integer     NOT NULL,          -- visibility scope (D1)
  location_id        integer     NOT NULL,          -- where the upload came from; audit only

  -- Lifecycle. A row is created as 'analysing' the moment the file lands, so a
  -- read that dies part way leaves a visible row. Rows stranded by a restart
  -- are swept to 'failed' (at boot, and lazily on reads).
  status             text        NOT NULL DEFAULT 'analysing'
                     CHECK (status IN ('analysing','analysed','failed','duplicate')),
  parse_error        text,                          -- owner-safe text only

  -- Header columns, copied out of the analysis for the list, sorting, the store
  -- filter and history. All nullable: a failed read has none of them.
  processor          text,
  merchant_number    text,
  merchant_name      text,
  period_start       date,
  period_end         date,
  layout_version     text,                          -- 'legacy_2026' | 'v2_2026' | 'csv' | 'unknown'
  amount_submitted   numeric(14,2),
  total_fees         numeric(14,2),                 -- positive
  amount_processed   numeric(14,2),
  transaction_count  integer,
  effective_rate     numeric(7,4),                  -- percent, e.g. 3.0154
  debit_share        numeric(7,4),                  -- percent
  findings_count     integer,
  rebelipay_cost     numeric(14,2),
  rebelipay_savings  numeric(14,2),                 -- raw: negative when Rebelipay costs more. Never returned negative by the API.
  rebelipay_savings_annual numeric(14,2),
  rebelipay_eligible boolean,

  extracted          jsonb,                         -- contract section 3, snake_case
  analysis           jsonb,                         -- contract section 5, camelCase, public-safe
  reconciliation     jsonb,                         -- contract section 4

  -- How the read went, for support: which reader, how sure, how long.
  parse_model        text,
  parse_confidence   numeric(5,4),
  parse_ms           integer,
  analysis_version   integer,

  -- The original upload, kept so the owner can always open the source.
  file_name          text,
  file_mime          text,
  file_size          integer,
  file_path          text,                          -- relative POSIX path under CS_UPLOAD_DIR
  content_sha256     char(64),
  duplicate_of       bigint REFERENCES card_statements(id) ON DELETE CASCADE,

  uploaded_by        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- List + paging: "this client's statements, newest first".
CREATE INDEX IF NOT EXISTS card_statements_client_created_idx
  ON card_statements (client_id, created_at DESC);

-- The hash duplicate check on upload. Tombstones are excluded: a re-upload
-- should be pointed at the statement the owner can see, never at a hidden copy.
CREATE INDEX IF NOT EXISTS card_statements_client_hash_idx
  ON card_statements (client_id, content_sha256)
  WHERE status <> 'duplicate';

-- History for the trend, savings to date, and the store filter.
CREATE INDEX IF NOT EXISTS card_statements_client_merchant_period_idx
  ON card_statements (client_id, merchant_number, period_end);

-- One analysed statement per merchant + period per client; a second one is an
-- identity duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS card_statements_identity_uniq
  ON card_statements (client_id, merchant_number, period_end)
  WHERE status = 'analysed';

-- The stale sweep: rows left 'analysing' by a restart.
CREATE INDEX IF NOT EXISTS card_statements_analysing_idx
  ON card_statements (updated_at)
  WHERE status = 'analysing';

COMMENT ON TABLE card_statements IS
  'Uploaded card-processing statements, one row per upload. Scoped to client_id '
  '(location_id is audit only). Header columns are copied from the analysis for '
  'the list; extracted/analysis/reconciliation are read whole. See CARD-STATEMENTS.md.';

COMMENT ON COLUMN card_statements.rebelipay_savings IS
  'Raw saving with Rebelipay for this statement: negative when Rebelipay would '
  'cost more. Kept raw so savings-to-date is honest; the API never returns it '
  'negative or for a statement that is not eligible.';

COMMENT ON COLUMN card_statements.duplicate_of IS
  'Set only on status = duplicate: the analysed statement with the same merchant '
  'number and period end. The tombstone keeps no file and is never listed; it '
  'exists so the screen can say where an upload went.';

COMMENT ON COLUMN card_statements.parse_error IS
  'Owner-safe text only. Raw errors go to the server log, never here.';

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- SELECT has_table_privilege('bottleai_writer','card_statements','INSERT');  -- expect t (after 025)
-- -- Nothing stranded mid-read for longer than the sweep threshold:
-- SELECT id, client_id, updated_at FROM card_statements
--  WHERE status = 'analysing' AND updated_at < now() - interval '10 minutes';
-- -- One analysed statement per merchant + period per client (the index enforces it):
-- SELECT client_id, merchant_number, period_end, count(*) FROM card_statements
--  WHERE status = 'analysed' GROUP BY 1, 2, 3 HAVING count(*) > 1;           -- expect no rows
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS card_statement_events;   -- 024 depends on this table
-- DROP TABLE IF EXISTS card_statements;
