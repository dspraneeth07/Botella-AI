-- ============================================================================
-- 035_outcome_quantities.sql - the quantities an outcome row was missing, and
--                              the grade for the one card stores will see
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js - see 001.)
--
-- WHY
--
-- 1. THE OUTCOME ROW COULD NOT SAY HOW MUCH.
--
--    Migration 020 gave `recommendation_outcomes` three quantity columns - what
--    we asked for, what they bought, what sold - and said in so many words why
--    each is nullable. Measured on the live table before this change: every
--    `recommended_qty` was NULL (the evaluator indexed an object as an array),
--    every `actual_purchased_qty` was NULL (hard-coded, "no purchase-order feed
--    for every store"), and nothing anywhere recorded how many units were left
--    unsold. The one column that was being written, `actual_units_sold`, is a
--    sales figure; on its own it cannot say whether the store over-bought,
--    under-bought, or bought at all.
--
--    `recommendations.suggested_order_qty` has carried the canonical order
--    quantity since migration 007 and was never read by the evaluator. The
--    quantity hint's parsed range is the wrong source for it: a stockout card
--    reads "about 8 units to cover the next 14 days ... between 5 and 30 units",
--    so the range's high end is the predictive band's top, not the order, and
--    on a markdown card it is the on-shelf count. The hint stays in the
--    evidence as prose; the column is what was asked for.
--
--    Three new facts make the row answer the question it exists for:
--
--      on_hand_at_issue       what was on the shelf when the card was made
--      on_hand_at_window_end  what was on the shelf when the window closed
--      units_unsold           recommended minus sold, floored at zero
--
--    The window-end count comes from `feature_daily.on_hand`, captured nightly
--    since the forward capture started (featureStoreService.captureOnHand). That
--    table is SPARSE - one row per day the product row synced, never rewritten -
--    so `on_hand_observed_on` carries the date of the row actually used. A
--    reader has to know whether "12 on hand at window end" was counted that day
--    or nine days earlier, and the row says which.
--
--    `purchased_qty_source` says where the bought figure came from, because the
--    two sources are not equally trustworthy: 'purchases_feed' is a PO row the
--    POS synced, 'stock_inflow' is the snapshot-to-frontier stock delta plus
--    sales, which only ever asserts within a 3-day attribution grace. NULL
--    `actual_purchased_qty` keeps the meaning 020 gave it - no evidence either
--    way - and is never written as a zero for a store whose POS sends no POs.
--
-- 2. NOTHING GRADED THE STOCKOUT CARD.
--
--    The engine's stockout card claims one checkable thing: "it runs out before
--    the next delivery lands". Lift cannot grade that - a product with two days
--    of cover sells exactly what is on the shelf whatever the card says - and
--    nothing else did. It is the card stores will see first, and it was the
--    only card with no verdict.
--
--    The grade is "did it sell through its cover before the first observed
--    inflow". Four columns rather than a jsonb, so the gate can read it with a
--    WHERE clause:
--
--      sold_through           true  : cumulative sales reached the issue-time
--                                     on-hand strictly before a delivery was
--                                     observed (or no delivery came and it
--                                     ran out anyway)
--                             false : a delivery was observed with cover still
--                                     on the shelf, or neither happened inside
--                                     a closed window
--                             NULL  : no on-hand count at issue, no delivery
--                                     evidence, or the two fell on one day
--      days_to_sell_through   calendar days from the card to the sell-through
--                                     day, only when sold_through is true
--      delivery_observed_on   the first day inflow was seen, from the purchases
--                                     feed, else the first feature_daily on-hand
--                                     rise net of sales; NULL when the only
--                                     evidence is an undated stock delta
--      delivery_evidence      which of those it was; 'stock_delta' when the
--                                     snapshot-to-frontier delta shows a
--                                     restock it cannot date; 'stock_delta_none'
--                                     / 'on_hand_no_rise' when a fresh snapshot
--                                     or the nightly counts saw no inflow at all
--      sold_through_reason    why the grade is what it is, lift_reason style
--
--    The declared 7-day lead time is NOT used as a delivery date. A date the
--    engine assumed is not an observation, and grading the card against its own
--    assumption would make every card pass.
--
--    The stockout card is not distinguishable from the other reorder card on the
--    row today: the engine's `family` ("stockout" / "recovering" / "overstock")
--    was never persisted, so Node sees category 'inventory_understock' and
--    action_type 'reorder' for both. `recommendations.engine_family` carries it
--    from now on. Rows written before this column existed are recognised by the
--    engine's own rule - action_type 'reorder' with engine_days_cover below the
--    14-day coverage horizon - and the evaluator says in code that it is a
--    fallback rather than a recorded fact.
--
-- GRANTS
--
--    None needed. Every column here is added to a table bottleai_writer already
--    holds SELECT, INSERT and UPDATE on (recommendations since 001,
--    recommendation_outcomes since 031), and column grants follow the table.
--    Still no DELETE on recommendation_outcomes - see 031 for why.
--
-- NULLABLE THROUGHOUT, no backfill. A row scored before this migration has no
-- quantities and no grade, and must keep reading as "not measured" rather than
-- as zero bought, zero unsold, or a card that failed.
-- ============================================================================

BEGIN;

-- ── Which engine family produced the card ────────────────────────────────────

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS engine_family text;

COMMENT ON COLUMN recommendations.engine_family IS
  'The deterministic engine''s family for this card: stockout, recovering or '
  'overstock. NULL for rows the LLM path or an older engine produced. The '
  'evaluator falls back to action_type + engine_days_cover for those.';

-- ── The quantities ───────────────────────────────────────────────────────────

ALTER TABLE recommendation_outcomes
  ADD COLUMN IF NOT EXISTS on_hand_at_issue       numeric,
  ADD COLUMN IF NOT EXISTS on_hand_at_window_end  numeric,
  ADD COLUMN IF NOT EXISTS on_hand_observed_on    date,
  ADD COLUMN IF NOT EXISTS units_unsold           numeric,
  ADD COLUMN IF NOT EXISTS purchased_qty_source   text
    CHECK (purchased_qty_source IS NULL
           OR purchased_qty_source IN ('purchases_feed', 'stock_inflow'));

COMMENT ON COLUMN recommendation_outcomes.on_hand_at_issue IS
  'Units on the shelf when the card was made: recommendations.engine_on_hand '
  'where the engine recorded one, else the rec-time snapshot in '
  'recommendation_sku_state. NULL when neither exists.';
COMMENT ON COLUMN recommendation_outcomes.on_hand_at_window_end IS
  'feature_daily.on_hand at the latest observation on or before window_end and '
  'on or after window_start. SPARSE source: see on_hand_observed_on for how '
  'old the count is. NULL when no observation fell inside the window.';
COMMENT ON COLUMN recommendation_outcomes.on_hand_observed_on IS
  'The obs_date of the feature_daily row on_hand_at_window_end was read from. '
  'Rows exist only on days the product row synced, so this can be well before '
  'window_end.';
COMMENT ON COLUMN recommendation_outcomes.units_unsold IS
  'max(0, recommended_qty - actual_units_sold). NULL when recommended_qty is '
  'unknown - never zero for "we did not ask for a quantity".';
COMMENT ON COLUMN recommendation_outcomes.purchased_qty_source IS
  'Where actual_purchased_qty came from: purchases_feed (PO rows the POS '
  'synced, inside the window) or stock_inflow (snapshot-to-frontier stock '
  'delta plus sales, attributable to the window). NULL with a NULL quantity '
  'means no evidence either way.';

-- ── The stockout grade ───────────────────────────────────────────────────────

ALTER TABLE recommendation_outcomes
  ADD COLUMN IF NOT EXISTS sold_through          boolean,
  ADD COLUMN IF NOT EXISTS days_to_sell_through  numeric,
  ADD COLUMN IF NOT EXISTS delivery_observed_on  date,
  ADD COLUMN IF NOT EXISTS delivery_evidence     text
    CHECK (delivery_evidence IS NULL
           OR delivery_evidence IN ('purchases_feed', 'on_hand_increase',
                                    'stock_delta', 'stock_delta_none',
                                    'on_hand_no_rise')),
  ADD COLUMN IF NOT EXISTS sold_through_reason   text;

COMMENT ON COLUMN recommendation_outcomes.sold_through IS
  'Stockout cards only, graded on the 30-day window: did cumulative sales '
  'reach on_hand_at_issue strictly before the first observed delivery. NULL is '
  'UNGRADED, never "did not" - sold_through_reason says why.';
COMMENT ON COLUMN recommendation_outcomes.days_to_sell_through IS
  'Calendar days from window_start to the day cumulative sales first reached '
  'on_hand_at_issue. Only set when sold_through is true.';
COMMENT ON COLUMN recommendation_outcomes.delivery_observed_on IS
  'First day inflow was OBSERVED inside the window - a purchases-feed row, or '
  'a feature_daily on-hand rise net of sales. Never the declared lead time.';
COMMENT ON COLUMN recommendation_outcomes.delivery_evidence IS
  'purchases_feed | on_hand_increase | stock_delta (inflow seen but undated) | '
  'stock_delta_none (fresh snapshot, no inflow through the frontier) | '
  'on_hand_no_rise (nightly counts through the window end, net of sales, '
  'never rose).';

-- The gate's eventual read of the grade: every graded stockout card for one
-- store, newest first. Partial so the index stays the size of the graded set.
CREATE INDEX IF NOT EXISTS idx_outcomes_sold_through
  ON recommendation_outcomes (client_id, location_id, window_end DESC)
  WHERE sold_through IS NOT NULL;

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- SELECT count(*) FILTER (WHERE recommended_qty IS NOT NULL)      AS with_qty,
--        count(*) FILTER (WHERE actual_purchased_qty IS NOT NULL) AS with_bought,
--        count(*) FILTER (WHERE sold_through IS NOT NULL)         AS graded
--   FROM recommendation_outcomes;                 -- all 0 until the next eval
-- SELECT engine_family, count(*) FROM recommendations GROUP BY 1;  -- NULL only
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS idx_outcomes_sold_through;
-- ALTER TABLE recommendation_outcomes
--   DROP COLUMN IF EXISTS on_hand_at_issue, DROP COLUMN IF EXISTS on_hand_at_window_end,
--   DROP COLUMN IF EXISTS on_hand_observed_on, DROP COLUMN IF EXISTS units_unsold,
--   DROP COLUMN IF EXISTS purchased_qty_source,
--   DROP COLUMN IF EXISTS sold_through, DROP COLUMN IF EXISTS days_to_sell_through,
--   DROP COLUMN IF EXISTS delivery_observed_on, DROP COLUMN IF EXISTS delivery_evidence,
--   DROP COLUMN IF EXISTS sold_through_reason;
-- ALTER TABLE recommendations DROP COLUMN IF EXISTS engine_family;
