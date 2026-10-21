-- @baseline
-- ============================================================================
-- Analytics migration 000 — BASE TABLES (recovered baseline)
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js — see 001 for
--   the provisioning and least-privilege rules that govern this whole folder.)
--
-- WHY THIS FILE EXISTS
--   `schema_migrations` in every existing environment records 000_base_tables
--   as applied, but the FILE was never committed. The five tables below — the
--   ones the rest of this folder ALTERs and the app reads on every request —
--   therefore had no DDL under version control at all. A fresh database could
--   not be provisioned from the repo: `npm run migrate` would reach
--   001_product_first_seen, then die at 002's
--   `ALTER TABLE recommendations ADD COLUMN reference_upc` against a table
--   that does not exist. The only way to stand up a new environment was to
--   pg_dump an old one, which is not a thing you can do in CI, in a
--   throwaway test database, or on a new developer's laptop.
--
--   This file is that missing DDL, transcribed from the live schema
--   (information_schema + pg_indexes + pg_constraint on bottleai_analytics,
--   PostgreSQL 16.15). It is a faithful reproduction, not a redesign: column
--   order, types, defaults, nullability, indexes and CHECK constraints all
--   match what is actually deployed. Improvements belong in a NEW numbered
--   file, never here.
--
-- THE @baseline PRAGMA (line 1 — load-bearing, do not remove)
--   Environments that already ran the original 000 have its checksum on
--   record, and it will not match this transcription. Without the pragma the
--   runner would report permanent "WARNING … was EDITED after being applied"
--   drift on every single migrate run, which is exactly the kind of warning
--   people learn to scroll past.
--
--   `-- @baseline` tells database/migrate.js: this file is the authoritative
--   text for DDL that is ALREADY APPLIED. On an environment that has it
--   recorded, the runner reconciles the stored checksum once, logs that it
--   did, and does NOT re-execute the file. On a fresh database the name is
--   not recorded, so the file simply applies first like any other migration.
--
--   The consequence, stated plainly: editing a @baseline file does not change
--   any existing database. Only ever use the pragma on a recovered or squashed
--   baseline, and fix forward with a new numbered file like everywhere else.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS, so applying this to a database
--   that already has the tables (the manual-fallback path) is a no-op.
-- ============================================================================

BEGIN;

-- ── recommendation_runs ──────────────────────────────────────────────────────
-- One row per generation run for one store: the envelope the Python service
-- returns (API_CONTRACT.md §2), persisted by services/recommendationService.js
-- `persistRun`. `signal_snapshot` is the DISPLAY-TRIMMED signal bundle
-- (SIGNAL_DISPLAY_CAP entries) that the Suggestions tab renders as chips — the
-- full bundle lives in daily_store_signals (migration 014).
CREATE TABLE IF NOT EXISTS recommendation_runs (
  id                   bigserial   PRIMARY KEY,
  client_id            integer     NOT NULL,
  location_id          integer     NOT NULL,
  generated_at         timestamptz NOT NULL DEFAULT now(),
  data_as_of           date,                      -- MAX(sale_date) the run saw
  candidate_count      integer     NOT NULL DEFAULT 0,
  recommendation_count integer     NOT NULL DEFAULT 0,
  dropped_invalid      integer     NOT NULL DEFAULT 0,
  signal_snapshot      jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- Every read is "the newest run for this store" — see recommendationService
-- getLatest. Tenant-first, generated_at DESC serves it from the index alone.
CREATE INDEX IF NOT EXISTS idx_rec_runs_tenant_generated
  ON recommendation_runs (client_id, location_id, generated_at DESC);

-- ── recommendations ──────────────────────────────────────────────────────────
-- One row per suggestion within a run. `category` and `action_type` hold the
-- canonical lowercase vocab from API_CONTRACT.md; they are deliberately plain
-- text rather than enums, because the persistence layer WARNS on an unknown
-- value and stores it rather than failing a whole run over one bad LLM token
-- (see normalizeVocab / KNOWN_CATEGORIES in recommendationService.js).
--
-- `status` is nullable and free-text; the only value the app writes is
-- 'holdout' (REC_HOLDOUT_PCT experiment — generated and evaluated like any
-- other rec, but never shown). NULL means an ordinary, shown recommendation.
CREATE TABLE IF NOT EXISTS recommendations (
  id                  bigserial   PRIMARY KEY,
  run_id              bigint      NOT NULL REFERENCES recommendation_runs(id) ON DELETE CASCADE,
  client_id           integer     NOT NULL,
  location_id         integer     NOT NULL,
  rank                integer     NOT NULL,
  category            text        NOT NULL,
  action_type         text        NOT NULL,
  primary_skus        text[]      NOT NULL DEFAULT '{}'::text[],
  quantity_hint       text,
  rationale           text        NOT NULL DEFAULT ''::text,
  signals_cited       text[]      NOT NULL DEFAULT '{}'::text[],
  confidence          real        NOT NULL DEFAULT 0,
  valid_through       date,
  status              text,                       -- NULL = shown; 'holdout' = suppressed
  vote                smallint    CHECK (vote = ANY (ARRAY[0, 1])),
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Added by later migrations; declared here so a FRESH database gets the
  -- final shape in one statement. The ALTERs in 002/004/007 stay IF NOT
  -- EXISTS, so they remain correct no-ops on both paths.
  reference_upc       text,                                            -- 002
  action_claim        text        CHECK (action_claim = ANY            -- 004
                        (ARRAY['did'::text, 'did_not'::text, 'dismissed'::text])),
  action_claim_at     timestamptz,                                     -- 004
  suggested_order_qty integer     CHECK (suggested_order_qty IS NULL    -- 007
                        OR suggested_order_qty >= 0)
);

CREATE INDEX IF NOT EXISTS idx_recommendations_run
  ON recommendations (run_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_tenant
  ON recommendations (client_id, location_id);

-- ── chat_interactions ────────────────────────────────────────────────────────
-- Chat telemetry: one row per answered question, with the token/cost breakdown
-- the usage reporting reads. Tenant keys are NULLABLE here (unlike everywhere
-- else) because a row is written even when a question fails before the tenant
-- is resolved — losing the error record would be worse than the inconsistency.
-- `deleted_at` is a soft delete: conversations are hidden, never destroyed.
CREATE TABLE IF NOT EXISTS chat_interactions (
  id                           bigserial   PRIMARY KEY,
  client_id                    integer,
  location_id                  integer,
  user_id                      integer,
  username                     text,
  location_name                text,
  conversation_id              text,
  question                     text,
  question_display             text,
  response                     text,
  followups                    jsonb,
  sql_queries                  jsonb,
  sql_query_count              integer,
  tool_loops_used              integer,
  response_time_ms             integer,
  claude_input_tokens          integer,
  claude_output_tokens         integer,
  claude_cache_read_tokens     integer,
  claude_cache_creation_tokens integer,
  error_message                text,
  question_cost_usd            numeric,
  response_cost_usd            numeric,
  total_cost_usd               numeric,
  cache_read_cost_usd          numeric,
  cache_creation_cost_usd      numeric,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  deleted_at                   timestamptz
);

-- Conversation replay reads live rows for one user's thread; the partial index
-- keeps soft-deleted history out of the scan entirely.
CREATE INDEX IF NOT EXISTS idx_chat_interactions_active
  ON chat_interactions (conversation_id, user_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chat_interactions_tenant_created
  ON chat_interactions (client_id, location_id, created_at DESC);

-- ── feedback ─────────────────────────────────────────────────────────────────
-- Thumbs and session ratings. `source` says which surface produced the row:
-- 'chat' rows carry `sentiment`, 'session' rows carry `rating`.
CREATE TABLE IF NOT EXISTS feedback (
  id              bigserial    PRIMARY KEY,
  client_id       integer,
  location_id     integer,
  user_id         varchar(100),
  username        varchar(150),
  conversation_id varchar(100),
  source          varchar(20)  NOT NULL CHECK (source::text = ANY
                    ((ARRAY['chat'::varchar, 'session'::varchar])::text[])),
  sentiment       varchar(10)  CHECK (sentiment::text = ANY
                    ((ARRAY['up'::varchar, 'down'::varchar])::text[])),
  rating          smallint     CHECK (rating >= 1 AND rating <= 5),
  message         text,
  created_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_tenant
  ON feedback (client_id, location_id, created_at DESC);

-- ── storeagent_capability_results ────────────────────────────────────────────
-- Warm cache for the Store-Intelligence tabs: the newest computed payload per
-- (store, capability), refreshed by the 03:30 cron and on login. One row per
-- capability — recomputing REPLACES, it does not append (this is a cache, and
-- the history that matters is kept by the capability's own tables).
CREATE TABLE IF NOT EXISTS storeagent_capability_results (
  client_id   integer     NOT NULL,
  location_id integer     NOT NULL,
  capability  text        NOT NULL,
  payload     jsonb       NOT NULL,
  narration   jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, location_id, capability)
);

-- ── Grants ───────────────────────────────────────────────────────────────────
-- The app role reads and writes all five. recommendations/recommendation_runs
-- get DELETE too: the rec tables are the one place the app prunes (a rerun
-- replacing a same-day run, and the test fixtures' cleanup), and the ON DELETE
-- CASCADE from recommendation_runs needs it to be usable at all.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE recommendation_runs            TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE recommendations                TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE         ON TABLE chat_interactions              TO bottleai_writer;
GRANT SELECT, INSERT                 ON TABLE feedback                       TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE         ON TABLE storeagent_capability_results  TO bottleai_writer;

GRANT USAGE, SELECT ON SEQUENCE recommendation_runs_id_seq TO bottleai_writer;
GRANT USAGE, SELECT ON SEQUENCE recommendations_id_seq     TO bottleai_writer;
GRANT USAGE, SELECT ON SEQUENCE chat_interactions_id_seq   TO bottleai_writer;
GRANT USAGE, SELECT ON SEQUENCE feedback_id_seq            TO bottleai_writer;

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- SELECT to_regclass('public.recommendations') IS NOT NULL;                 -- expect t
-- SELECT has_table_privilege('bottleai_writer','recommendations','INSERT');  -- expect t
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- Deliberately not provided. Dropping these destroys every recommendation,
-- evaluation and chat record in the environment; the later migrations' FKs
-- would have to go first. Restore from a backup instead.
