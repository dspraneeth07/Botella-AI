-- ============================================================================
-- Analytics migration 015 — daily store recommendation archive
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js — see 001.)
--
-- WHY
--   `recommendation_runs` + `recommendations` record every RUN, which is the
--   right grain for "what did this generation produce" and the wrong grain for
--   the question the new engine, the digests and every effectiveness report
--   actually ask: "what did we tell this store on this day?"
--
--   Nothing in the existing schema answers that directly:
--
--     * There is no day key at all. `rec_date` is derived on the fly as
--       `generated_at::date`, in whatever timezone the reading session
--       happens to have — the test fixtures already carry a comment about a
--       bare `::date` cast shifting a day under IST. Every consumer re-derives
--       it, and they do not all agree.
--     * Nothing constrains a store to one run per day. The 04:00 cron, a
--       manual /generate from the UI, and a retry after a failure all write
--       full runs. "The day's recommendations" is then ambiguous, and the
--       obvious fix in a reader (`ORDER BY generated_at DESC LIMIT 1`) quietly
--       picks a different answer depending on when it is asked.
--     * The set is only reconstructable by joining and re-filtering (holdouts
--       out, rank order, vocab normalization). A backtest that has to
--       re-implement that join is a backtest that will diverge from
--       production.
--
--   So: one row per store per store-local day, holding the day's set as a
--   single JSONB document exactly as it was served, plus the run it came from
--   and the signal day that produced it. The run tables stay exactly as they
--   are and remain the append-only audit trail; this is the day-grain view the
--   engine reads and writes against.
--
-- RELATIONSHIP TO THE RUN TABLES — read this before using either:
--   recommendation_runs / recommendations  = every attempt, append-only, the
--     record of what happened. Keeps per-rec mutable state (vote,
--     action_claim) and is what recommendation_evaluations scores against.
--   daily_store_recommendations            = one canonical set per day,
--     upserted, immutable in shape. What the engine and backtests read.
--   Neither is derived from the other at read time; both are written in the
--   SAME transaction by recommendationService.persistRun, so they cannot
--   disagree about a day.
--
-- DAY KEY: identical rule to migration 014 — the STORE'S calendar date, with
--   `day_basis`/`timezone` recording how it was derived. `signal_date` points
--   at the daily_store_signals row that fed this set. They are usually equal
--   and deliberately separate columns: a run that reuses cached signals from
--   late the previous local day must be able to say so rather than quietly
--   misattributing its inputs.
-- ============================================================================

BEGIN;

-- ── A real day key on the run table ──────────────────────────────────────────
-- Stamped by the writer from the same store-local resolution as everything
-- else, so no reader ever has to cast `generated_at` and guess at a timezone
-- again. NULLABLE and not backfilled: the seven pre-existing runs have no
-- trustworthy store-local date (we do not know what zone they were meant to
-- be read in), and inventing one would be worse than admitting it is unknown.
-- Readers treat NULL as "legacy run, fall back to generated_at".
ALTER TABLE recommendation_runs
  ADD COLUMN IF NOT EXISTS rec_date  date,
  ADD COLUMN IF NOT EXISTS day_basis text
    CHECK (day_basis IS NULL OR day_basis IN ('store_local', 'utc')),
  ADD COLUMN IF NOT EXISTS timezone  text;

COMMENT ON COLUMN recommendation_runs.rec_date IS
  'The store''s own calendar date for this run. NULL on runs predating migration 015 - fall back to generated_at.';

CREATE INDEX IF NOT EXISTS idx_rec_runs_tenant_rec_date
  ON recommendation_runs (client_id, location_id, rec_date DESC)
  WHERE rec_date IS NOT NULL;

-- ── The daily archive ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_store_recommendations (
  client_id   integer NOT NULL,
  location_id integer NOT NULL,
  rec_date    date    NOT NULL,      -- the STORE'S calendar date (see header)

  day_basis text NOT NULL DEFAULT 'utc'
              CHECK (day_basis IN ('store_local', 'utc')),
  timezone  text,                    -- IANA zone; NULL when day_basis='utc'

  -- The run that produced the CANONICAL set for this day. ON DELETE SET NULL,
  -- not CASCADE: if a run row is ever pruned, the day's archive is the thing
  -- we most want to keep — that is the entire point of this table.
  run_id bigint REFERENCES recommendation_runs(id) ON DELETE SET NULL,

  -- The daily_store_signals row these recommendations were reasoned from.
  -- No FK: signal capture is fail-soft and a rec set must still be recordable
  -- on a day where signal persistence failed. Join on
  -- (client_id, location_id, signal_date) when the row exists.
  signal_date date,

  generated_at      timestamptz NOT NULL DEFAULT now(),
  first_captured_at timestamptz NOT NULL DEFAULT now(),
  -- How many runs landed on this day. > 1 means the set below is the LAST
  -- one; the earlier attempts remain in full in recommendation_runs.
  capture_count     integer     NOT NULL DEFAULT 1,

  data_as_of date,                   -- MAX(sale_date) the run saw

  -- THE CELL: the day's recommendations as served, rank-ordered, one JSON
  -- object per rec carrying the full persisted shape (id, rank, category,
  -- action_type, primary_skus, quantity_hint, rationale, signals_cited,
  -- confidence, valid_through, status, reference_upc, suggested_order_qty).
  -- `id` is each row's recommendations.id, so per-rec outcomes
  -- (recommendation_evaluations, votes, action claims) join straight back.
  recommendations jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(recommendations) = 'array'),

  candidate_count      integer NOT NULL DEFAULT 0,
  recommendation_count integer NOT NULL DEFAULT 0,  -- total persisted
  shown_count          integer NOT NULL DEFAULT 0,  -- status IS DISTINCT FROM 'holdout'
  holdout_count        integer NOT NULL DEFAULT 0,
  dropped_invalid      integer NOT NULL DEFAULT 0,

  -- Distinct vocab present in the set — the cheap group-by for "how often did
  -- we say markdown in August" without unnesting the JSONB every time.
  categories   text[] NOT NULL DEFAULT '{}'::text[],
  action_types text[] NOT NULL DEFAULT '{}'::text[],

  -- Provenance of the generation itself. Every one of these is nullable: they
  -- are filled by whatever engine produced the row, and a value that was not
  -- reported must read as unknown rather than as zero.
  engine_version   text,
  model            text,
  prompt_version   text,
  llm_input_tokens  integer,
  llm_output_tokens integer,
  llm_cost_usd      numeric,
  latency_ms        integer,

  recommendations_sha256 char(64),

  PRIMARY KEY (client_id, location_id, rec_date)
);

-- Network-wide day reads (digests, backtest loaders, "what did we ship
-- yesterday") scan by date across tenants.
CREATE INDEX IF NOT EXISTS idx_daily_recs_date
  ON daily_store_recommendations (rec_date DESC);

-- Join from a run back to its archived day.
CREATE INDEX IF NOT EXISTS idx_daily_recs_run
  ON daily_store_recommendations (run_id)
  WHERE run_id IS NOT NULL;

-- "Which days did we recommend a markdown / a cold_box" across the network.
CREATE INDEX IF NOT EXISTS idx_daily_recs_action_types
  ON daily_store_recommendations USING gin (action_types);

-- Days where the engine produced NOTHING are the ones worth finding, and they
-- are rare enough that a partial index is nearly free.
CREATE INDEX IF NOT EXISTS idx_daily_recs_empty
  ON daily_store_recommendations (rec_date DESC, client_id, location_id)
  WHERE recommendation_count = 0;

COMMENT ON TABLE daily_store_recommendations IS
  'One row per store per store-local day: the canonical recommendation set as served. Day-grain view over recommendation_runs/recommendations, written in the same transaction.';
COMMENT ON COLUMN daily_store_recommendations.recommendations IS
  'Rank-ordered JSON array of the day''s recommendations. Each element''s "id" is the recommendations.id, so per-rec outcomes join back directly.';
COMMENT ON COLUMN daily_store_recommendations.capture_count IS
  'Runs that landed on this day. >1 means this is the last set; earlier attempts remain in recommendation_runs.';

-- ── Grants ───────────────────────────────────────────────────────────────────
-- Upsert only. No DELETE for the app role — this table is the archive, and
-- pruning it is an admin retention job, not something a request path can do.
GRANT SELECT, INSERT, UPDATE ON TABLE daily_store_recommendations TO bottleai_writer;

COMMIT;

-- ── Verify (run as the app role) ─────────────────────────────────────────────
-- SELECT has_table_privilege('bottleai_writer','daily_store_recommendations','INSERT');  -- expect t
-- -- A store's last fortnight, signals and recs side by side:
-- SELECT r.rec_date, r.recommendation_count, r.shown_count, r.action_types,
--        s.signal_count, s.sources_failed
--   FROM daily_store_recommendations r
--   LEFT JOIN daily_store_signals s
--     ON s.client_id = r.client_id AND s.location_id = r.location_id
--    AND s.signal_date = r.signal_date
--  WHERE r.client_id = 46 AND r.location_id = 46
--  ORDER BY r.rec_date DESC LIMIT 14;
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS daily_store_recommendations;
-- DROP INDEX IF EXISTS idx_rec_runs_tenant_rec_date;
-- ALTER TABLE recommendation_runs
--   DROP COLUMN IF EXISTS timezone,
--   DROP COLUMN IF EXISTS day_basis,
--   DROP COLUMN IF EXISTS rec_date;
