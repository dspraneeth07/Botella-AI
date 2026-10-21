-- ============================================================================
-- 041_admission_notes.sql - what the gate DID NOT apply, recorded beside what
--                           it refused
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js - see 001.)
--
-- WHY
--
--   `recommendation_admission.reasons` is the list of refusals: a non-empty
--   array means the card was withheld, and the first entry is what the owner's
--   sentence explains. That shape is right and this does not change it.
--
--   The confidence floor is now conditional. REC_MIN_CONFIDENCE applies only
--   when `confidence_basis` is a calibrated basis that differs between cards
--   ('isotonic'); on a raw ranking score, a constant, a flat slate, an evidence
--   count, a model's guess or an unrecorded basis the floor is skipped and the
--   card rests on the expected-profit floor alone. That skip is a decision
--   about the card, and a decision nobody can see is the kind that becomes
--   permanent by accident - which is how 0.35 sat on an uncalibrated number
--   for months. So the skip is RECORDED, as
--
--       confidence_floor_not_applicable:<basis>
--
--   It cannot go in `reasons`: a reason withholds the card, and this card was
--   shown. Hence a second array, `notes`, for decisions the gate took that did
--   not refuse anything. Every row from before this migration has an empty
--   list, which is the true statement about it: the old gate recorded no
--   non-refusing decisions because it took none.
--
-- GRANTS
--
--   `recommendation_admission` was granted SELECT, INSERT, UPDATE to
--   bottleai_writer in 017; a new column on a granted table needs no new
--   GRANT, and none is written.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS.
-- ============================================================================

BEGIN;

ALTER TABLE recommendation_admission
  ADD COLUMN IF NOT EXISTS notes text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN recommendation_admission.notes IS
  'Decisions the gate took that did NOT refuse the card, e.g. '
  'confidence_floor_not_applicable:<basis> when REC_MIN_CONFIDENCE was skipped '
  'because the basis is not a discriminating calibrated one. Distinct from '
  'reasons, which withhold. Empty on rows from before 041.';

COMMIT;

-- ============================================================================
-- ROLLBACK (manual; not run by the migrator)
-- ============================================================================
-- BEGIN;
-- ALTER TABLE recommendation_admission DROP COLUMN IF EXISTS notes;
-- COMMIT;
