-- ============================================================================
-- 032_engine_version.sql - which engine produced a run, and which engine a
--                          fitted confidence curve is valid for
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js - see 001.)
--
-- WHY
--
--   The calibration curve maps a RAW RANKING SCORE onto an observed hit rate.
--   That mapping is only meaningful for the engine that produced the scores:
--   change how candidates are selected or scored and the same raw 0.4 means
--   something else, so a curve fitted before the change is not a weaker claim
--   about cards after it - it is a claim about a different quantity.
--
--   Nothing recorded which engine produced a run, so the fitter pooled every
--   outcome it could find regardless of provenance and had no way not to.
--   recommendation_evaluations has no version column at all, and the one place
--   a version could have been read - recommendation_outcomes.model_version -
--   is NULL on all 1,110 rows, because the evaluator reads rec.model_version
--   and `recommendations` has no such column.
--
--   The engine has in fact been reporting its version all along: the run
--   response carries EngineInfo(version=app.__version__) and Node passes it to
--   the daily snapshot. It was simply never persisted on the run.
--
-- THE BACKFILL IS A FACT, NOT A GUESS
--
--   Existing rows are set to '0.1.0' because that is the only value
--   app/__init__.py has ever held - introduced at c4115b6 and unchanged since,
--   confirmed by git log on that line. So every historical run really was
--   produced by 0.1.0, and the filter this enables is a no-op today rather
--   than something that silently discards the 56 outcomes the current curve is
--   fitted on. It starts biting at the first version bump, which is when it
--   should.
--
--   NULL stays possible for a run Node persisted before the engine sent a
--   version, and the fitter treats NULL as "unknown provenance" rather than as
--   a match - an outcome that cannot name its engine cannot be pooled with one
--   that can.
-- ============================================================================

BEGIN;

ALTER TABLE recommendation_runs
  ADD COLUMN IF NOT EXISTS engine_version text;

COMMENT ON COLUMN recommendation_runs.engine_version IS
  'app.__version__ of the engine that produced this run, from EngineInfo in the '
  'run response. NULL means the engine did not report one; the calibration '
  'fitter treats that as unknown provenance, not as a match.';

UPDATE recommendation_runs SET engine_version = '0.1.0' WHERE engine_version IS NULL;

-- Which engine a fitted curve is VALID FOR. `version` is already taken: it is
-- the fit's own identity hash (e.g. 2026-10-06.a32555599cf6). This is the
-- engine whose raw scores the curve was fitted against, so the recommender can
-- refuse a bundle that does not match the engine about to use it - rather than
-- applying a transform calibrated on a different quantity.
ALTER TABLE calibration_bundle
  ADD COLUMN IF NOT EXISTS engine_version text;

COMMENT ON COLUMN calibration_bundle.engine_version IS
  'The engine version whose outcomes this curve was fitted on. A recommender '
  'running a different version must not apply it.';

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- SELECT engine_version, count(*) FROM recommendation_runs GROUP BY 1;  -- all 0.1.0
-- SELECT client_id, version, engine_version FROM calibration_bundle;    -- null until refit
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- ALTER TABLE recommendation_runs DROP COLUMN engine_version;
-- ALTER TABLE calibration_bundle  DROP COLUMN engine_version;
