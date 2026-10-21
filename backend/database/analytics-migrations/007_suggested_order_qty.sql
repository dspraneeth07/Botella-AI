-- ============================================================================
-- Analytics migration 007 — canonical reorder quantity on recommendations
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js — see 001).
--
-- One-number rule: the Python rec service now stamps reorder/pre_stock picks
-- with suggested_order_qty — the exact order quantity the storeagent demand
-- engine computes (the same figure the Store Intelligence Buying tab prints
-- as order_qty). Persisting it lets every downstream surface (rec cards,
-- startup digest, future unified action feed) render the number directly
-- instead of parsing it out of the LLM's quantity_hint prose, and lets the
-- effectiveness evaluator score restocks against the recommended quantity.
--
-- NULL = the rec predates this column, isn't a buy action, or the demand
-- engine had no figure for the SKU (warehouse bridge unavailable). Writers
-- probe for the column (services/recommendationService.js), so deploys where
-- this migration hasn't run yet keep working — the field is simply dropped.
--
-- New columns inherit the table-level grants (bottleai_writer already
-- SELECTs/INSERTs/UPDATEs recommendations) — no new GRANTs needed.
-- ============================================================================

BEGIN;

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS suggested_order_qty integer
    CHECK (suggested_order_qty IS NULL OR suggested_order_qty >= 0);

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- ALTER TABLE recommendations DROP COLUMN IF EXISTS suggested_order_qty;
