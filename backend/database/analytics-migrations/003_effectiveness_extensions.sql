-- ============================================================================
-- Analytics migration 003 — effectiveness extensions (dollar attribution,
--                            holdout evaluation, digest archive)
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js — see 001).
--
-- WHAT THIS ADDS
--   recommendation_sku_state.cost — unit cost at capture, so evaluations can
--       attribute MARGIN impact, not just revenue (null when syncgo lacks it).
--   recommendation_evaluations.revenue_impact / margin_impact — the measured
--       dollar story: (units_sold − expected_units) × price(/margin) at rec
--       time. Null when unmeasurable — never fabricated.
--   recommendations.status usage note — 'holdout' marks recs generated but
--       DELIBERATELY not shown (REC_HOLDOUT_PCT experiment, off by default).
--       They evaluate identically, giving a shown-vs-holdout comparison. No
--       DDL needed (status is an existing text column) — documented here.
--   recommendation_digests — the weekly digest archive, one row per store per
--       ISO week; sent via the store's connected Gmail when available, always
--       readable from the API.
-- ============================================================================

BEGIN;

ALTER TABLE recommendation_sku_state    ADD COLUMN IF NOT EXISTS cost numeric;
ALTER TABLE recommendation_evaluations  ADD COLUMN IF NOT EXISTS revenue_impact real;
ALTER TABLE recommendation_evaluations  ADD COLUMN IF NOT EXISTS margin_impact  real;

CREATE TABLE IF NOT EXISTS recommendation_digests (
  client_id    integer     NOT NULL,
  location_id  integer     NOT NULL,
  week_start   date        NOT NULL,   -- Monday of the ISO week the digest covers
  generated_at timestamptz NOT NULL DEFAULT now(),
  subject      text        NOT NULL,
  body_text    text        NOT NULL,
  payload      jsonb       NOT NULL,   -- the structured numbers behind the text
  emailed      boolean     NOT NULL DEFAULT false,
  PRIMARY KEY (client_id, location_id, week_start)
);

GRANT SELECT, INSERT, UPDATE ON TABLE recommendation_digests TO bottleai_writer;

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS recommendation_digests;
-- ALTER TABLE recommendation_evaluations DROP COLUMN IF EXISTS margin_impact;
-- ALTER TABLE recommendation_evaluations DROP COLUMN IF EXISTS revenue_impact;
-- ALTER TABLE recommendation_sku_state   DROP COLUMN IF EXISTS cost;
