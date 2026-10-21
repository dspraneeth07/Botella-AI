-- ============================================================================
-- 025_card_statement_grants.sql - the grants 023 and 024 need
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js - see 001.)
--
-- WHY
--
--   Mirrors 012_po_grants.sql, written up front this time rather than after the
--   fact. Grants are invisible in development, where the app role owns the
--   database and therefore owns anything it creates. They are fatal anywhere
--   the migrations run as a privileged role against the least-privilege app
--   role (ANALYTICS_MIGRATE_DSN in database/migrate.js), which is production:
--
--       [CS] list failed  permission denied for table card_statements
--
--   Privileges match what the routes do. Statements are created, read, updated
--   through their lifecycle and deleted by the owner. Events are append-only by
--   design (see 024): INSERT and SELECT, deliberately no UPDATE or DELETE. When
--   a statement is deleted its events go by ON DELETE CASCADE, which Postgres
--   runs with the table owner's rights, so the app role needs no DELETE there.
--
--   IDEMPOTENT. GRANT is not an error when the privilege is already held, so
--   this is safe to re-run and safe in environments that never had the problem.
-- ============================================================================

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE card_statements       TO bottleai_writer;
GRANT SELECT, INSERT                 ON TABLE card_statement_events TO bottleai_writer;

-- Both have a bigserial primary key, and INSERT on the table is refused
-- without USAGE on the sequence behind it.
GRANT USAGE, SELECT ON SEQUENCE card_statements_id_seq       TO bottleai_writer;
GRANT USAGE, SELECT ON SEQUENCE card_statement_events_id_seq TO bottleai_writer;

COMMIT;

-- ── Verify (run as the app role) ─────────────────────────────────────────────
-- SELECT has_table_privilege('bottleai_writer','card_statements','DELETE');           -- expect t
-- SELECT has_table_privilege('bottleai_writer','card_statement_events','INSERT');     -- expect t
-- SELECT has_table_privilege('bottleai_writer','card_statement_events','DELETE');     -- expect f
-- SELECT has_sequence_privilege('bottleai_writer','card_statements_id_seq','USAGE');  -- expect t
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- REVOKE ALL ON TABLE card_statements, card_statement_events FROM bottleai_writer;
-- REVOKE ALL ON SEQUENCE card_statements_id_seq, card_statement_events_id_seq FROM bottleai_writer;
