-- ============================================================================
-- 042_card_order_by.sql - the card's deadline, decided once and stored
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js - see 001.)
--
-- THE DEFECT, AS THE OWNER SAW IT (Bethany, 19 October 2026)
--
--   The Recommendations card for Weber Ranch 1L read "selling about 9.0 a week
--   and you have 8 on hand - about 6 days of cover left ... Order by Mon,
--   Oct 19". The Purchasing row for the same bottle, the same morning, read
--   "On hand 8 . Sold 90d 121 . Qty to cover 28 . Order by Thu, Oct 22".
--   Same bottle, same day, two dates and no shared quantity.
--
--   Two causes. The card's date was arithmetic the BROWSER did on
--   engine_days_cover with a hard-coded seven-day lead; the row's was
--   utils/cover.js with a lead of THREE on a 90-day average - a figure that
--   was never anyone's measured lead time. And nothing stored either date, so
--   nothing else (Purchasing, a digest, the effectiveness ledger) could show
--   the one the card showed.
--
-- WHAT THIS DOES
--
--   Three nullable columns on `recommendations`, written by the persist path
--   from the engine's own payload and read back by getLatest:
--
--     order_by         the calendar date the owner must order by. The engine
--                      computes it ONCE - as_of + max(0, floor(days_cover -
--                      lead_time_days)) - with the lead time the card quotes
--                      (app/recommender/deterministic.py order_by_for), and
--                      every surface shows this stored value.
--     lead_time_days   the lead time that date rests on.
--     lead_time_basis  'measured' (a per-vendor median from this store's
--                      receipts, migration 037) or 'declared' (the policy's
--                      seven). The same figure the stockout sentence quotes.
--
--   NULLABLE, no backfill. A markdown card has nothing to order and so no day
--   to order it by; a card from the LLM path or from before this migration
--   carries none, and the frontend falls back to the shared arithmetic in
--   utils/cover.js (now on the engine's declared seven, not three). NULL must
--   stay NULL: a default of today's date would give every historical card a
--   deadline it never had.
--
--   `order_by` is a DATE and is read back `::text` (DAILY-CAPTURE.md section
--   4): node-postgres parses a DATE at local midnight, and a host west of UTC
--   would stringify it a day early.
--
--   `lead_time_basis` carries no CHECK constraint, for the reason 040 gives
--   for confidence_basis: the vocabulary is owned by the Python schema
--   (Literal["measured", "declared"]) and mirrored in the persist path, and a
--   third copy in DDL would be a third place to forget. The persist path
--   writes NULL for any word outside the pair.
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
  ADD COLUMN IF NOT EXISTS order_by        date,
  ADD COLUMN IF NOT EXISTS lead_time_days  integer,
  ADD COLUMN IF NOT EXISTS lead_time_basis text;

COMMENT ON COLUMN recommendations.order_by IS
  'The calendar date the owner must order by, decided by the engine once: '
  'as_of + max(0, floor(engine_days_cover - lead_time_days)). Every surface '
  'shows this stored value. NULL on markdown cards, the LLM path, and where '
  'stock was unknown at decision time - never defaulted to a date.';

COMMENT ON COLUMN recommendations.lead_time_days IS
  'The delivery lead time order_by rests on, in calendar days. NULL where no '
  'order is being asked for.';

COMMENT ON COLUMN recommendations.lead_time_basis IS
  'measured: a per-vendor median from this store''s receipts (migration 037). '
  'declared: the policy''s seven, nothing measured. Vocabulary owned by '
  'app/schemas/recommendation.py; no CHECK here for the reason 040 gives.';

COMMIT;

-- ============================================================================
-- ROLLBACK (manual; not run by the migrator)
-- ============================================================================
-- BEGIN;
-- ALTER TABLE recommendations
--   DROP COLUMN IF EXISTS lead_time_basis,
--   DROP COLUMN IF EXISTS lead_time_days,
--   DROP COLUMN IF EXISTS order_by;
-- COMMIT;
