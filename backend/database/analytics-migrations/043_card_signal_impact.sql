-- ============================================================================
-- 043_card_signal_impact.sql - what each live signal was found to do, on the card
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js - see 001.)
--
-- THE DEFECT, AS THE OWNER SAW IT (20 October 2026)
--
--   "I want to see which external signals exist and their impact on the
--   recommendations; do not show me only reorder." The Signals rail listed
--   sixteen live keys - two home games, four esports nights, Halloween, Day
--   of the Dead, four trends - and not one card on the screen said a word
--   about any of them. The owner concluded the engine ignores the feeds.
--
--   It does not. The engine attaches `signal_impact` to EVERY card
--   (app/recommender/pipeline.py _attach_signal_impact): one entry per live
--   signal, each either `measured` with a beta and its interval, or
--   `not_measurable` / `not_fitted` with the NAMED reason - and
--   `signal_impact_summary`, the same block in one sentence. Both are declared
--   on the Python response schema (app/schemas/recommendation.py). Both were
--   dropped on arrival: the persist path's explicit column list had no column
--   to put them in, so "we checked tonight's game and cannot measure it yet"
--   was indistinguishable from never having looked. Same failure class as
--   migration 028's twenty-four decision figures.
--
-- WHAT THIS DOES
--
--   Two nullable columns on `recommendations`, written by the persist path
--   from the engine's own payload and read back by getLatest:
--
--     signal_impact          jsonb array, the engine's block verbatim:
--                            [{signal_key, family, state, beta, interval_lo,
--                              interval_hi, reason, active_days,
--                              observations}, ...]. A refused entry carries
--                            beta NULL and a reason, never 0.0: "not measured"
--                            and "measured and found to be nothing" are
--                            different facts and the first is the common one.
--     signal_impact_summary  the one sentence a surface with no room for the
--                            block still prints.
--
--   NULLABLE, no backfill. A card persisted before this migration was never
--   told what the engine found, and inventing a block for it now would be a
--   claim about an examination that did not happen. The frontend prints
--   nothing where the column is NULL, which is the honest rendering. Stored
--   as jsonb rather than normalised rows because the block is read whole, per
--   card, and never joined; the fitted cells it summarises live in
--   `signal_effects` (migration 029) already.
--
--   No CHECK on the entry vocabulary (`measured` / `not_measurable` /
--   `not_fitted`), for the reason 040 gives for confidence_basis: the words
--   are owned by the Python side and a copy in DDL is a copy to forget. The
--   persist path writes NULL for anything that is not an array.
--
-- GRANTS
--
--   `recommendations` is already granted SELECT, INSERT, UPDATE to
--   bottleai_writer (migration 001 and the grants that followed each column
--   addition); a new column on a granted table needs no new GRANT, and none
--   is written.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS.
-- ============================================================================

BEGIN;

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS signal_impact         jsonb,
  ADD COLUMN IF NOT EXISTS signal_impact_summary text;

COMMENT ON COLUMN recommendations.signal_impact IS
  'What each signal live at the store on the run day was found to do to this '
  'card''s product family: [{signal_key, family, state, beta, interval_lo, '
  'interval_hi, reason, active_days, observations}]. state is measured / '
  'not_measurable / not_fitted (vocabulary owned by app/recommender/pipeline.py). '
  'A refused entry has beta NULL with a reason - never 0.0. NULL on cards '
  'persisted before this migration; never backfilled.';

COMMENT ON COLUMN recommendations.signal_impact_summary IS
  'The signal_impact block in one sentence, written by the engine, so a surface '
  'that shows no detail still cannot show silence. NULL where the engine sent '
  'none.';

COMMIT;

-- ============================================================================
-- ROLLBACK (manual; not run by the migrator)
-- ============================================================================
-- BEGIN;
-- ALTER TABLE recommendations
--   DROP COLUMN IF EXISTS signal_impact_summary,
--   DROP COLUMN IF EXISTS signal_impact;
-- COMMIT;
