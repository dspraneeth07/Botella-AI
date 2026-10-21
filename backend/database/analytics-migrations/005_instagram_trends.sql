-- ============================================================================
-- Analytics migration 005 — Instagram hashtag trend tracking
-- ============================================================================
-- DATABASE: bottleai_analytics  (NOT syncgo — see 001 header for the split.)
--
-- WHY
--   The social_trending recommendation slice validates trend TERMS against
--   peer-store registers (integrationService.getTrendValidation). Terms come
--   from Google Trends / Reddit today; this adds Instagram as a source.
--   Meta has no "trending" API, so services/instagramTrendsService.js polls a
--   fixed vocabulary of drink hashtags daily (Graph API hashtag search) and
--   records post-velocity + engagement snapshots here. Acceleration across
--   snapshots is the trend signal; the Python service pulls it via
--   GET /api/clients/:cid/locations/:lid/social-trends. GLOBAL data — no
--   tenant keys on purpose (hashtag popularity is not per-store).
--
--   ig_hashtags caches term → Meta hashtag-ID (IDs are permanent). The cache
--   is load-bearing, not an optimization: every ig_hashtag_search call counts
--   against Meta's 30-unique-hashtags-per-7-days cap; media reads by cached ID
--   count only that hashtag, so resolving once keeps the cap headroom.
--
--   meta_token_history holds the rotating long-lived user token (60-day
--   expiry; the weekly refresh cron appends a row and readers take the latest).
--   Append-only by design — the app role gets no UPDATE/DELETE, and the row
--   trail doubles as a refresh audit log (~52 rows/year). The .env
--   IG_ACCESS_TOKEN acts as the seed when the table is empty.
--
-- PROVISIONING RULE
--   Same as 001: applied via `npm run migrate` (or MIGRATE_ON_BOOT=true),
--   ANALYTICS_MIGRATE_DSN for environments where the app role lacks CREATE.
--   Idempotent; app code degrades gracefully (log + empty/env fallback) until
--   applied. Manual fallback: psql "$ANALYTICS_ADMIN_DSN" -f this file.
-- ============================================================================

BEGIN;

-- term → Meta hashtag ID cache (IDs never change; resolved once per term).
CREATE TABLE IF NOT EXISTS ig_hashtags (
  term        text        PRIMARY KEY,   -- normalized: lowercase, alnum only, no '#'
  hashtag_id  text        NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now()
);

-- One row per (term, poll tick): the raw observation the acceleration math
-- reads. posts_per_hour is derived from the timestamp spread of the newest
-- recent_media sample (Meta exposes no hashtag post-count field).
CREATE TABLE IF NOT EXISTS ig_hashtag_snapshots (
  term            text        NOT NULL,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  hashtag_id      text        NOT NULL,
  posts_per_hour  numeric,              -- NULL when the sample is too thin to rate
  sample_count    integer     NOT NULL, -- recent_media items the rate was derived from
  newest_post_at  timestamptz,
  oldest_post_at  timestamptz,
  top_like_sum    bigint,               -- engagement over the top_media sample
  top_comment_sum bigint,
  top_sample_count integer,
  PRIMARY KEY (term, captured_at)
);

-- Series reads are "latest N days for every term" — the PK's term-first order
-- serves per-term reads; this serves the cross-term window scan.
CREATE INDEX IF NOT EXISTS idx_ig_snapshots_captured
  ON ig_hashtag_snapshots (captured_at);

-- Rotating Meta user token. Append-only: refresh cron INSERTs, readers take
-- ORDER BY created_at DESC LIMIT 1. source: 'refresh' | 'manual' (a re-auth
-- pasted via psql after a dead token — see instagramTrendsService header).
CREATE TABLE IF NOT EXISTS meta_token_history (
  id           bigserial   PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  access_token text        NOT NULL,
  expires_at   timestamptz,             -- from the exchange's expires_in when returned
  source       text        NOT NULL DEFAULT 'refresh'
);

-- Least privilege. No UPDATE/DELETE anywhere: snapshots and tokens are
-- append-only; a hashtag re-resolve would INSERT a fresh row only after an
-- admin clears the stale one (has not happened — IDs are stable).
GRANT SELECT, INSERT ON TABLE ig_hashtags          TO bottleai_writer;
GRANT SELECT, INSERT ON TABLE ig_hashtag_snapshots TO bottleai_writer;
GRANT SELECT, INSERT ON TABLE meta_token_history   TO bottleai_writer;
GRANT USAGE ON SEQUENCE meta_token_history_id_seq  TO bottleai_writer;

COMMIT;

-- ── Verify (run as the app role) ─────────────────────────────────────────────
-- SELECT has_table_privilege('bottleai_writer', 'ig_hashtag_snapshots', 'SELECT, INSERT');  -- expect t
-- SELECT has_sequence_privilege('bottleai_writer', 'meta_token_history_id_seq', 'USAGE');   -- expect t
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS ig_hashtag_snapshots;
-- DROP TABLE IF EXISTS ig_hashtags;
-- DROP TABLE IF EXISTS meta_token_history;
