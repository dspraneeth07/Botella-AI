-- ============================================================================
-- Analytics migration 002 — recommendation effectiveness evaluation
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js — `npm run
--   migrate` or MIGRATE_ON_BOOT=true; see 001 for the provisioning rules).
--
-- WHY
--   services/recommendationEvalService.js measures every persisted
--   recommendation against what actually happened afterwards (sales, restocks,
--   price changes), over configurable windows (REC_EVAL_WINDOWS, default
--   7/30/60/90 days). Two tables:
--
--   recommendation_sku_state — the state snapshot captured per (rec, sku) at
--       (or shortly after) generation time: on-hand, price, sale_price and the
--       trailing weekly sales rate. Action detection needs "what did things
--       look like when we said it" — products only stores CURRENT stock/price,
--       so without this snapshot a later "did they restock / mark down?" is
--       unanswerable. Recs that predate this feature simply have no snapshot
--       and evaluate on sales evidence alone.
--
--   recommendation_evaluations — one row per (rec, window): the measured
--       outcome (units vs expected, lift), the detected action, the
--       shrunk vote component, the blended final score and the verdict.
--       Upserted by the evaluation cron; unique on (rec_id, window_days).
--
--   recommendations.reference_upc — for SKU-less stock_new picks (area
--       winners the store doesn't carry): the UPC of the suggested product,
--       stamped by the Python validator, so the evaluator can later detect
--       "the store started carrying it".
--
-- All rows are tenant-keyed (client_id + location_id — house rule) even though
-- rec_id alone is unique, so tenant filters never require a join.
-- ============================================================================

BEGIN;

ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS reference_upc text;

CREATE TABLE IF NOT EXISTS recommendation_sku_state (
  rec_id       bigint      NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  client_id    integer     NOT NULL,
  location_id  integer     NOT NULL,
  sku          text        NOT NULL,
  on_hand      integer,               -- products.stock_qty at capture
  price        numeric,               -- products.price at capture
  sale_price   numeric,               -- products.sale_price at capture (NULL/0 = not on sale)
  weekly_rate  real,                  -- trailing 28d units / 4 (calendar-day basis) at capture
  captured_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rec_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_rec_sku_state_tenant
  ON recommendation_sku_state (client_id, location_id);

CREATE TABLE IF NOT EXISTS recommendation_evaluations (
  rec_id           bigint      NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  client_id        integer     NOT NULL,
  location_id      integer     NOT NULL,
  window_days      integer     NOT NULL,
  evaluated_at     timestamptz NOT NULL DEFAULT now(),
  data_through     date,                -- sales frontier the evaluation saw
  units_sold       integer,             -- across the rec's SKUs, (rec_date, rec_date+window]
  expected_units   real,                -- trailing-28d rate scaled to the window
  units_in_validity integer,            -- units through valid_through (event-scoped evidence)
  lift             real,                -- units_sold / expected_units (uncapped, NULL if unmeasurable)
  outcome_score    real,                -- squash(min(lift, cap)) in 0..1, NULL if unmeasurable
  action_taken     boolean,             -- true/false when a detector had visibility, NULL = unobservable
  action_evidence  jsonb,               -- detector name + numbers behind action_taken
  vote_ups         integer     NOT NULL DEFAULT 0,
  vote_downs       integer     NOT NULL DEFAULT 0,
  vote_component   real,                -- Laplace-smoothed vote value, NULL when unvoted
  final_score      real,                -- weight-renormalized blend, NULL when nothing measurable
  verdict          text        NOT NULL CHECK
                     (verdict IN ('winner', 'neutral', 'underperformer', 'insufficient_data')),
  PRIMARY KEY (rec_id, window_days)
);

CREATE INDEX IF NOT EXISTS idx_rec_eval_tenant_window
  ON recommendation_evaluations (client_id, location_id, window_days);

-- Least privilege: the evaluator INSERTs and upserts (UPDATE); no DELETE.
GRANT SELECT, INSERT, UPDATE ON TABLE recommendation_sku_state    TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE recommendation_evaluations  TO bottleai_writer;

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS recommendation_evaluations;
-- DROP TABLE IF EXISTS recommendation_sku_state;
-- ALTER TABLE recommendations DROP COLUMN IF EXISTS reference_upc;
