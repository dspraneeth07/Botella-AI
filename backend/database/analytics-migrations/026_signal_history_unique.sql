-- Fix forward: signal_history needs a UNIQUE key, and it already holds duplicates.
--
-- THE BUG, AND HOW IT SURFACED
--   025 created `signal_history_store_key_date_idx` as a PLAIN index, and the
--   backfill writer used `ON CONFLICT DO NOTHING`. That clause only fires on an
--   actual constraint violation, so with no unique index it deduplicated nothing:
--   re-running the backfill over the same range inserted every row a second time.
--
--   Caught by running the backfill twice and comparing `inserted` to `rows` - 460
--   both times, where the second should have been 0. The table held 2,760 rows
--   where 2,300 were correct.
--
-- WHY THIS IS A CORRECTNESS BUG AND NOT UNTIDINESS
--   `elasticity/signal.py` fits
--       ln(units + 1) = alpha + beta*signal_active + dow + month + trend + e
--   over the days a signal was active. A duplicated day is counted twice, which
--   inflates the active-day count, understates the standard error and makes a
--   coefficient look more significant than the evidence supports. The engine would
--   then let a card cite a signal that had not earned it - exactly the failure the
--   elasticity gate exists to prevent.
--
-- WHY TRUNCATE AND NOT DELETE, AND WHY THAT IS SAFE *HERE*
--   The first version of this migration deleted the duplicate rows. The
--   append-only trigger from 025 refused it, and was RIGHT to: "a corrected signal
--   is a NEW ROW. If a row can be amended, the table is a cache rather than a
--   history and no estimate fitted on it can be reproduced."
--
--   So the duplicates are not edited. The table is emptied and rebuilt, which is
--   defensible only because of a fact this migration CHECKS rather than assumes:
--   every row present is `origin = 'computed'`, meaning every one is a function of
--   the calendar and reproducible exactly by re-running the backfill. No captured
--   observation exists yet to lose.
--
--   If any CAPTURED row existed this migration raises instead of truncating. A
--   captured temperature is not reproducible and must never be discarded to tidy
--   up an index - the guard below is what makes that impossible rather than merely
--   unlikely.
--
-- AFTER THIS, RE-RUN THE BACKFILL
--   scripts/publish_signal_history.py --stores ... --from ... --to ...
--   It is idempotent once the index below exists, which is the whole point.

DO $$
DECLARE
  captured_rows integer;
BEGIN
  SELECT COUNT(*) INTO captured_rows
    FROM signal_history
   WHERE origin IS DISTINCT FROM 'computed';

  IF captured_rows > 0 THEN
    RAISE EXCEPTION
      'signal_history holds % CAPTURED row(s). This migration rebuilds the table '
      'to add a unique index, which is only safe while every row is reproducible '
      'from the calendar. A captured observation cannot be regenerated. '
      'Deduplicate those rows deliberately, then re-run.', captured_rows;
  END IF;

  -- Allowed: the append-only trigger is BEFORE UPDATE OR DELETE, and TRUNCATE is
  -- neither. That is not a loophole being exploited - it is the difference between
  -- amending a recorded fact, which must stay impossible, and discarding a derived
  -- table that can be recomputed exactly.
  TRUNCATE TABLE signal_history;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS signal_history_one_per_day_idx
  ON signal_history (client_id, location_id, as_of, signal_key);

COMMENT ON INDEX signal_history_one_per_day_idx IS
  'A signal was either active on a date or it was not. This is what makes the '
  'backfill writer ON CONFLICT DO NOTHING actually deduplicate - without it a '
  're-run doubled every row and the elasticity fit double-counted active days.';
