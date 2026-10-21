-- ============================================================================
-- Analytics migration 006 — dynamic Instagram vocabulary (discovered terms)
-- ============================================================================
-- DATABASE: bottleai_analytics  (see 001 header for the folder split.)
--
-- WHY
--   Migration 005's poller tracked a FIXED hashtag vocabulary — it could
--   measure the classics but never a newly viral drink. This table closes the
--   loop: each rec run, the Python service reports the trend terms its
--   discovery channels surfaced (YouTube/Reddit analyst terms, Google Trends
--   breakout queries, register-mined categories) via
--   POST .../social-trends/observed-terms, and the daily Instagram poll merges
--   the freshest of them into its vocabulary alongside the stable core — so
--   Instagram starts MEASURING a discovered drink's post velocity within a
--   day of its first sighting.
--
--   The merge is governed by Meta's hard cap of 30 unique hashtags queried
--   per rolling 7 days (instagramTrendsService.buildPollVocabulary): core
--   tags first, then dynamic terms newest-first while the trailing-7-day
--   unique count stays under the safety margin. Terms not re-observed for
--   14 days age out of the merge naturally (no DELETE needed — the poller
--   just stops selecting them).
--
-- PROVISIONING RULE
--   Same as 001/005: `npm run migrate` / MIGRATE_ON_BOOT=true;
--   ANALYTICS_MIGRATE_DSN where the app role lacks CREATE. Idempotent; app
--   code degrades to the static vocabulary until applied. UPDATE is granted
--   (unlike the append-only 005 tables) because re-observing a term upserts
--   its last_seen — that touch IS the freshness signal the merge sorts by.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ig_dynamic_terms (
  term         text        PRIMARY KEY,  -- hashtag form: lowercase alnum ("pinkmojito")
  display_term text        NOT NULL,     -- word-bounded form ("pink mojito")
  source       text        NOT NULL,     -- discovery channel(s) that observed it
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now()
);

-- The poller's merge reads "freshest first"; partial recency index keeps it
-- cheap as the table accumulates aged-out terms.
CREATE INDEX IF NOT EXISTS idx_ig_dynamic_terms_last_seen
  ON ig_dynamic_terms (last_seen DESC);

GRANT SELECT, INSERT, UPDATE ON TABLE ig_dynamic_terms TO bottleai_writer;

COMMIT;

-- ── Verify (run as the app role) ─────────────────────────────────────────────
-- SELECT has_table_privilege('bottleai_writer', 'ig_dynamic_terms', 'SELECT, INSERT, UPDATE');  -- expect t
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS ig_dynamic_terms;
