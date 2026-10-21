-- ============================================================================
-- 040_confidence_basis_required.sql - every card says what its confidence
--                                     figure IS
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js - see 001.)
--
-- THE FINDING (QA, 2026-10-19)
--
--   `recommendations.confidence` is one real, and the same real means four
--   different things depending on which path wrote the row. Migration 028
--   added `confidence_basis` to say which, as a nullable text with no default,
--   and only the deterministic engine ever wrote it. Measured on this store at
--   the time of writing:
--
--       raw_ranking_score     637   the engine's p_hit, uncalibrated
--       NULL                  352   signal-family cards and the LLM path -
--                                   nothing said what the figure was
--       isotonic_flat_slate   142   a curve, every card on the same value
--       isotonic               65
--
--   So a reader of 352 rows could not tell a shrinkage weight from a measured
--   hit rate, and the admission gate's REC_MIN_CONFIDENCE floor filtered all
--   of them as one number. The Python response model now REQUIRES a basis from
--   a closed vocabulary (app/schemas/recommendation.py CONFIDENCE_BASES,
--   mirrored in backend/lib/confidenceBasis.js), and this migration makes the
--   column agree with the model.
--
-- WHAT THIS DOES
--
--   1. Backfills every NULL to 'not_recorded'. That is the TRUE statement
--      about those rows: nothing upstream recorded a basis. It is not a guess
--      at which path wrote them - 'family_evidence_count' would be right for
--      most of the 352 and wrong for the LLM-era ones, and a label that is
--      sometimes wrong is worse than one that is honestly empty. Reports that
--      want the historical split can still get it from action_type and run
--      date; the label does not pretend to.
--
--   2. Sets the DEFAULT to 'not_recorded' and the column NOT NULL. From here a
--      row cannot be written without a basis. The persist path
--      (recommendationService.persistRun) writes the card's own basis when it
--      is a word the vocabulary has and 'not_recorded' - with a logged warning
--      naming the card, counted per run - when it is missing or unknown.
--
--      LABELLED, NOT DROPPED. The alternative considered was to refuse a card
--      payload with no basis. A card is advice the store can act on; the basis
--      is a label on one of its numbers. Dropping advice for a missing label
--      hides a card over a bookkeeping defect, and does it silently from the
--      owner's side - the slate is simply shorter. 'not_recorded' keeps the
--      card and puts the defect on the row, where `WHERE confidence_basis =
--      'not_recorded'` finds it.
--
--   The vocabulary itself is NOT a CHECK constraint here. The list is owned by
--   the Python schema and mirrored in Node; a third copy in DDL would be a
--   third place to forget, and an unapplied migration would then refuse rows
--   the two code copies accept. The persist path enforces membership before
--   the INSERT and the verify suite asserts the two code copies agree.
--
-- GRANTS
--
--   `recommendations` is already granted to bottleai_writer (migration 001 and
--   the grants that followed each column addition); no new object is created
--   here, so no new GRANT is needed and none is written.
--
-- IDEMPOTENT. The UPDATE touches only NULL rows; SET DEFAULT and SET NOT NULL
-- are no-ops on a column that already has them.
-- ============================================================================

BEGIN;

UPDATE recommendations
   SET confidence_basis = 'not_recorded'
 WHERE confidence_basis IS NULL;

ALTER TABLE recommendations
  ALTER COLUMN confidence_basis SET DEFAULT 'not_recorded';

ALTER TABLE recommendations
  ALTER COLUMN confidence_basis SET NOT NULL;

COMMENT ON COLUMN recommendations.confidence_basis IS
  'What the confidence figure IS, from the closed vocabulary in '
  'app/schemas/recommendation.py CONFIDENCE_BASES (mirrored in '
  'backend/lib/confidenceBasis.js): raw_ranking_score, isotonic, '
  'isotonic_constant, isotonic_flat_slate, isotonic_constant_flat_slate, '
  'family_evidence_count, llm_stated, not_recorded. NOT NULL since 040; rows '
  'from before the vocabulary were backfilled to not_recorded, which is a '
  'statement that nothing was recorded and not a guess at the path. The '
  'admission floor REC_MIN_CONFIDENCE applies only to isotonic.';

COMMIT;

-- ============================================================================
-- ROLLBACK (manual; not run by the migrator)
-- ============================================================================
-- BEGIN;
-- ALTER TABLE recommendations ALTER COLUMN confidence_basis DROP NOT NULL;
-- ALTER TABLE recommendations ALTER COLUMN confidence_basis DROP DEFAULT;
-- -- The backfilled rows stay 'not_recorded'; there is no NULL to restore
-- -- them to that would say anything different.
-- COMMIT;
