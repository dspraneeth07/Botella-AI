-- ============================================================================
-- Analytics migration 004 — owner-reported action claims
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js — see 001).
--
-- Physical actions (endcap, cold box, promote, bundle) leave no trace in the
-- sales data, so their action_taken stays NULL — unless we simply ask. The UI
-- shows ONE lightweight question at a time ("Did you put X in the cold box?");
-- the answer lands here and fills the unknown in the evaluator:
--
--   action_claim: 'did' | 'did_not' | 'dismissed'
--     did / did_not → becomes action_taken (evidence: owner_reported) ONLY
--                     where no hard detector produced an answer — a detected
--                     price cut or purchase order always outranks a memory.
--     dismissed     → never ask about this rec again; no evaluation effect.
--
-- New columns inherit the table-level grants (bottleai_writer already
-- SELECTs/INSERTs/UPDATEs recommendations for votes) — no new GRANTs needed.
-- ============================================================================

BEGIN;

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS action_claim text
    CHECK (action_claim IN ('did', 'did_not', 'dismissed')),
  ADD COLUMN IF NOT EXISTS action_claim_at timestamptz;

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- ALTER TABLE recommendations DROP COLUMN IF EXISTS action_claim_at;
-- ALTER TABLE recommendations DROP COLUMN IF EXISTS action_claim;
