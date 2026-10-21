-- ============================================================================
-- 022_recommendation_engine_facts.sql - let a card show the numbers that chose it
--
-- THE CARD AND THE ENGINE WERE QUOTING DIFFERENT RATES.
--
-- Observed on store 171, 29 September 2026. The top card read:
--
--     "Ironroot Industrial Luciano is selling about 17 a week and you have
--      2 on hand - gone within a day."   $5,893 in sales protected
--
-- It had sold NINE units in the last 28 days - about two a week. The "17 a
-- week" is a 90-day average carried on the Buying screen's buy_list, and this
-- product's sales had collapsed inside that window. Every figure downstream of
-- the rate - the cover phrase, the order-by date, the dollars protected - was
-- wrong with it.
--
-- The card below it, from the same run, disagreed with itself: the headline
-- said "about 8 days of cover" (90-day average) and the detail said "About 9
-- days of stock left" (the engine's 28-day open-day rate). Two subsystems, two
-- windows, one card.
--
-- WHY THE OVERRIDE EXISTED, AND WHY IT IS NOW WRONG
--   RecommendationsHome replaced the recommender's prose with buy_list figures
--   deliberately. Its comment records the reason: an LLM wrote "about 22
--   bottles a week ... empty by September 20" for a bottle selling 2.2 a week
--   with 83 days of cover. Policing a generator that invents numbers with
--   measured ones was exactly right.
--
--   The recommender is no longer a generator. It selects deterministically and
--   its rate is computed from the store's own receipts over a 28-day window,
--   shrunk toward the SKU's own long run. That figure is more current than the
--   90-day average that is overriding it, so the override now replaces a good
--   number with a stale one.
--
-- The fix is not to trust prose. It is to carry the MEASURED figures the
-- engine used, so the card can state them and the frontend can stop deriving
-- a rival answer from a different window.
--
-- NULLABLE, no backfill. Rows written by the LLM path have no engine figures
-- and must keep reading as "unknown" rather than zero - a zero rate would make
-- every legacy card claim infinite cover. The frontend falls back to the
-- buy_list exactly as it does today when these are null.
-- ============================================================================

BEGIN;

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS engine_daily_rate numeric,
  ADD COLUMN IF NOT EXISTS engine_days_cover numeric,
  ADD COLUMN IF NOT EXISTS engine_on_hand    numeric;

COMMENT ON COLUMN recommendations.engine_daily_rate IS
  'Units per OPEN day the engine used to choose this product: a 28-day window '
  'shrunk toward the SKU''s own long run (sheet 20). NULL for rows the LLM path '
  'produced - unknown, never zero.';

COMMENT ON COLUMN recommendations.engine_days_cover IS
  'Open days of stock remaining at engine_daily_rate when the card was made. '
  'NULL when stock was unknown at decision time.';

COMMENT ON COLUMN recommendations.engine_on_hand IS
  'Units on the shelf when the card was made. Recorded rather than looked up '
  'later: a stock level read a week afterwards is not the one the decision was '
  'taken on.';

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- ALTER TABLE recommendations
--   DROP COLUMN IF EXISTS engine_on_hand,
--   DROP COLUMN IF EXISTS engine_days_cover,
--   DROP COLUMN IF EXISTS engine_daily_rate;
