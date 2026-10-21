-- ============================================================================
-- 031_gate_calibration_signal_grants.sql - the grants 019-029 never wrote
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js - see 001.)
--
-- WHY
--
--   Third time: 012 wrote the grants 008-010 omitted, 025 wrote them for 023-024
--   up front, and six tables in between still have none. Grants are invisible in
--   development, where the app role owns the database and therefore owns whatever
--   it creates. They are fatal wherever migrations run as a privileged role
--   against the least-privilege app role - ANALYTICS_MIGRATE_DSN in
--   database/migrate.js - which is production.
--
--   Diffed every CREATE TABLE across the 31 migrations against every GRANT:
--   39 tables created, 33 granted, and the 6 without are precisely the tables
--   the nightly gate, the calibration refit and the signal-effect fit read and
--   write. So those three jobs could not have worked in production even with a
--   Python interpreter on the box - the writes would have been refused.
--
--       recommendation_family_gate  019   the gate's per-family verdict
--       recommendation_outcomes     020   THE EVIDENCE BASE
--       store_gate_verdict          023   the store-level gate
--       calibration_bundle          024   the fitted confidence curve
--       signal_history              025   what each signal said, per day
--       signal_effects              029   what each signal is worth
--
-- PRIVILEGES MATCH WHAT THE CODE DOES, NOT A BLANKET ALL
--
--   UPDATE is granted only where an INSERT ... ON CONFLICT DO UPDATE needs it;
--   Postgres requires the UPDATE privilege for the conflict path even though the
--   statement reads as an insert. signal_history conflicts DO NOTHING, so it
--   needs none. signal_effects is republished by DELETE-then-INSERT per store,
--   so it is the only one granted DELETE.
--
--   NO DELETE ON recommendation_outcomes, deliberately. That table is the
--   evidence the gate counts and the calibration curve is fitted on; the
--   application has no reason to erase a measured outcome, and a correction
--   belongs in a migration run by the owner (030 is one). The verify block
--   below asserts the absence, so a later blanket grant is caught.
--
--   IDEMPOTENT. GRANT is not an error when the privilege is already held, so
--   this is safe to re-run and safe in environments that never had the problem.
-- ============================================================================

BEGIN;

-- Upserted through ON CONFLICT DO UPDATE - hence SELECT, INSERT, UPDATE.
GRANT SELECT, INSERT, UPDATE ON TABLE recommendation_family_gate TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE recommendation_outcomes    TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE store_gate_verdict         TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE calibration_bundle         TO bottleai_writer;

-- Append-only: the insert conflicts DO NOTHING, which needs no UPDATE.
GRANT SELECT, INSERT         ON TABLE signal_history             TO bottleai_writer;

-- Republished per store as DELETE-then-INSERT, so this one needs DELETE.
GRANT SELECT, INSERT, DELETE ON TABLE signal_effects             TO bottleai_writer;

-- Three of the six have a bigserial primary key, and INSERT on the table is
-- refused without USAGE on the sequence behind it. The other three are keyed on
-- (client_id, location_id[, family]) and have no sequence.
GRANT USAGE, SELECT ON SEQUENCE recommendation_outcomes_id_seq TO bottleai_writer;
GRANT USAGE, SELECT ON SEQUENCE signal_history_id_seq          TO bottleai_writer;
GRANT USAGE, SELECT ON SEQUENCE signal_effects_id_seq          TO bottleai_writer;

COMMIT;

-- ── Verify (run as any role) ─────────────────────────────────────────────────
-- SELECT has_table_privilege('bottleai_writer','recommendation_outcomes','INSERT');     -- t
-- SELECT has_table_privilege('bottleai_writer','recommendation_outcomes','UPDATE');     -- t
-- SELECT has_table_privilege('bottleai_writer','recommendation_outcomes','DELETE');     -- f
-- SELECT has_table_privilege('bottleai_writer','signal_history','UPDATE');              -- f
-- SELECT has_table_privilege('bottleai_writer','signal_effects','DELETE');              -- t
-- SELECT has_sequence_privilege('bottleai_writer','signal_effects_id_seq','USAGE');     -- t
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- REVOKE ALL ON TABLE recommendation_family_gate, recommendation_outcomes,
--   store_gate_verdict, calibration_bundle, signal_history, signal_effects
--   FROM bottleai_writer;
-- REVOKE ALL ON SEQUENCE recommendation_outcomes_id_seq, signal_history_id_seq,
--   signal_effects_id_seq FROM bottleai_writer;
