-- ============================================================================
-- Analytics migration 017 — data quality gate results (sheet 02)
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js — see 001.)
--
-- NUMBERING: the sheet asks for `014_data_quality.sql`. 014 is already
--   daily_signal_capture and 015/016 are taken, so this is 017. Same folder,
--   same rules; only the number moved.
--
-- WHY
--   Nothing currently stands between a malformed POS payload and a
--   recommendation. This is where the system gets the RIGHT TO REFUSE: a store
--   whose data fails its contract produces no recommendation and a stated
--   reason, which is infinitely better than a confident one built on rubbish.
--
--   data_quality_results — one row per (store, batch, gate). The audit trail
--       behind every refusal. When an owner asks "why did I get nothing
--       today", this is the answer, with a field name in it.
--
--   store_quality_state — the LATEST verdict per store, so the serving path
--       can decide whether to show a recommendation with one indexed read
--       instead of replaying four gates. Derived, cheap to rebuild, and the
--       thing recommendationGateService consults on every request.
--
-- WHAT THE GATES FOUND WHEN FIRST RUN (live warehouse, measured not asserted)
--   * 8,616,193 sale_items rows sit in the DEFAULT partition. Every one has a
--     VALID sale_date — they are simply older than the oldest defined
--     partition (2025-04-01), so they were absorbed correctly rather than
--     corrupted. The sheet read this as malformed data; it is not.
--   * The live risk is the FORWARD edge: partitions stop at 2026-11-30. After
--     that, every new sale lands in DEFAULT with nothing to say so. The schema
--     gate's partition-range check exists for exactly that.
--   * Cost coverage is 0.00% for gokul, square and mpower — 31 stores, 355k
--     SKUs. Those fields are now marked UNAVAILABLE and travel as ABSENT, so
--     no margin claim can be built on a zero that means "unknown".
-- ============================================================================

BEGIN;

-- ── One row per (store, batch, gate) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS data_quality_results (
  id          bigserial   PRIMARY KEY,
  client_id   integer     NOT NULL,
  location_id integer     NOT NULL,
  -- The delivery this verdict is about. Free-form so it can carry the
  -- sync_raw_log payload hash, a job run id, or a synthetic daily key.
  batch       text        NOT NULL,
  connector   text,
  entity      text,

  gate        text        NOT NULL CHECK (gate IN
                ('schema', 'completeness', 'freshness', 'anomaly')),
  -- Per-gate outcome. 'pass' and 'fail' come straight from StageResult.ok;
  -- 'degraded' is the completeness/freshness middle ground where the batch is
  -- accepted but something downstream must not be used.
  verdict     text        NOT NULL CHECK (verdict IN
                ('pass', 'fail', 'degraded', 'abstained')),

  -- The StageResult, whole: reasons, provenance, the numbers behind the
  -- judgement. Stored rather than logged because a verdict whose evidence
  -- lives in a log line is a verdict nobody can audit six weeks later.
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Sheet-00 provenance, lifted out for querying.
  stage_version text,
  contract_key  text,     -- e.g. 'gokul/products@1.0.0'

  checked_at  timestamptz NOT NULL DEFAULT now()
);

-- "Why was this store refused" — the question this table exists to answer.
CREATE INDEX IF NOT EXISTS idx_dq_tenant_checked
  ON data_quality_results (client_id, location_id, checked_at DESC);

-- Connector-level rollup, the same discipline as sheet 01's digest: a schema
-- break is one connector ticket, not forty store tickets.
CREATE INDEX IF NOT EXISTS idx_dq_connector_gate
  ON data_quality_results (connector, gate, checked_at DESC);

-- Failures only — the triage scan, kept off the passing majority.
CREATE INDEX IF NOT EXISTS idx_dq_failures
  ON data_quality_results (checked_at DESC, connector, gate)
  WHERE verdict IN ('fail', 'degraded');

COMMENT ON TABLE data_quality_results IS
  'One row per (store, batch, gate). The audit trail behind every refusal; detail holds the full StageResult.';

-- ── Latest verdict per store, for the serving path ───────────────────────────
CREATE TABLE IF NOT EXISTS store_quality_state (
  client_id   integer NOT NULL,
  location_id integer NOT NULL,
  connector   text,

  -- Worst-wins across the four gates. 'reject' and 'quarantine' mean NO
  -- recommendation may be shown; 'degraded' means show it with fields
  -- withheld and staleness attached; 'pass' is unrestricted.
  verdict text NOT NULL DEFAULT 'unknown'
    CHECK (verdict IN ('pass', 'degraded', 'quarantine', 'reject', 'unknown')),

  -- Fields that failed completeness. These travel as ABSENT to every
  -- downstream stage: a cost of 0.0 is indistinguishable from a free product
  -- and yields a 100% margin, so the only honest representation is no value.
  unavailable_fields text[] NOT NULL DEFAULT '{}'::text[],

  -- Measured against THIS STORE's own median sync interval, not a fixed
  -- threshold. NULL when never synced, which is a different condition from
  -- "stale by N days" and must stay distinguishable.
  staleness_days       numeric,
  median_interval_days numeric,
  never_synced         boolean NOT NULL DEFAULT false,

  reasons    text[] NOT NULL DEFAULT '{}'::text[],
  gate_detail jsonb NOT NULL DEFAULT '{}'::jsonb,

  checked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_sqs_verdict
  ON store_quality_state (verdict, connector);

-- Stores currently refused, worst first. The operator's morning list.
CREATE INDEX IF NOT EXISTS idx_sqs_refused
  ON store_quality_state (connector, checked_at DESC)
  WHERE verdict IN ('reject', 'quarantine');

COMMENT ON COLUMN store_quality_state.unavailable_fields IS
  'Fields that failed completeness. They travel as ABSENT downstream - never zero-filled, because a zero cost yields a 100% margin.';

-- ── Why a recommendation was withheld ────────────────────────────────────────
-- A recommendation is shown only when it is valid AND its profit claim is
-- supportable. Withholding silently would just be a different way of being
-- unexplainable, so every suppression is recorded with its reason and the
-- owner-facing sentence that goes with it.
CREATE TABLE IF NOT EXISTS recommendation_admission (
  rec_id      bigint      NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  client_id   integer     NOT NULL,
  location_id integer     NOT NULL,
  rec_date    date,

  visible     boolean     NOT NULL,
  -- Machine-readable causes, e.g. {'store_quality:reject','missing_field:cost'}
  reasons     text[]      NOT NULL DEFAULT '{}'::text[],
  -- The sentence an owner would accept as an explanation.
  explanation text,

  -- The profit claim, where one could be computed at all. NULL means "we
  -- could not state a figure", which is a REASON TO WITHHOLD a profit-claiming
  -- action, not a reason to show it with the number left blank.
  expected_profit_usd numeric,
  profit_basis        text,   -- margin | revenue | avoided_stockout | none

  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rec_id)
);

CREATE INDEX IF NOT EXISTS idx_rec_admission_tenant
  ON recommendation_admission (client_id, location_id, rec_date DESC);

-- "What are we withholding, and why" across the estate.
CREATE INDEX IF NOT EXISTS idx_rec_admission_withheld
  ON recommendation_admission (rec_date DESC, client_id, location_id)
  WHERE visible IS FALSE;

COMMENT ON TABLE recommendation_admission IS
  'Per-recommendation visibility decision. A withheld rec is recorded with its reason so a refusal is as auditable as an answer.';

-- ── Grants ───────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON TABLE data_quality_results      TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE store_quality_state       TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE recommendation_admission  TO bottleai_writer;
GRANT USAGE, SELECT ON SEQUENCE data_quality_results_id_seq     TO bottleai_writer;

COMMIT;

-- ── Verify (run as the app role) ─────────────────────────────────────────────
-- SELECT has_table_privilege('bottleai_writer','data_quality_results','INSERT'); -- expect t
-- -- Who is refused right now, and why:
-- SELECT connector, verdict, count(*)::int stores,
--        array_agg(DISTINCT r) FILTER (WHERE r IS NOT NULL) AS reasons
--   FROM store_quality_state, unnest(COALESCE(reasons,'{}')) AS r
--  GROUP BY 1,2 ORDER BY 1,2;
-- -- What are we withholding today, and on what grounds:
-- SELECT unnest(reasons) AS reason, count(*)::int
--   FROM recommendation_admission
--  WHERE visible IS FALSE AND rec_date = current_date
--  GROUP BY 1 ORDER BY 2 DESC;
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS recommendation_admission;
-- DROP TABLE IF EXISTS store_quality_state;
-- DROP TABLE IF EXISTS data_quality_results;
