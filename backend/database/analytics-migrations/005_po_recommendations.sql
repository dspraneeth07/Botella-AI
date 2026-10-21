-- ============================================================================
-- Analytics migration 005 — purchase-order recommendation effectiveness
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js — see 001).
--
-- WHY
--   The daily signal-aware `recommendations` already have an effectiveness
--   ledger (migration 002/003). What was NOT tracked is the Buying report's
--   PURCHASE-ORDER suggestions — the "reorder SKU X, quantity N" list from the
--   StoreAgent buying capability, which carries a NUMERIC recommended quantity
--   (`order_qty`). This migration adds the two tables that let Node measure
--   those specifically:
--
--   po_recommendations — one row per (store, sku, day) snapshot of a buy-list
--       suggestion at the moment it was shown: the recommended quantity, the
--       on-hand and velocity at rec time, supplier, reason. Snapshotting is the
--       whole game — "was the recommended quantity right, and did buying it
--       pay off?" is unanswerable without capturing the state we said it in.
--
--   po_recommendation_outcomes — one row per (rec, window): did the owner act
--       (a matching PO in `purchases`), how close the actual order quantity was
--       to the recommendation (forecast accuracy), and the post-purchase
--       performance — units sold, sell-through, velocity change, gross margin,
--       revenue impact, inventory turnover — with a blended score + verdict.
--       Upserted by the evaluation pass; unique on (rec_id, window_days).
--
-- All rows are tenant-keyed (client_id + location_id — house rule) so tenant
-- filters never require a join. Evaluation only runs once the store's own sales
-- frontier has passed rec_date + window (same honesty rule as migration 002):
-- a store whose sync is behind is never scored on a partial window.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS po_recommendations (
  id                   bigserial   PRIMARY KEY,
  client_id            integer     NOT NULL,
  location_id          integer     NOT NULL,
  sku                  text        NOT NULL,
  product_name         text,
  recommended_qty      integer     NOT NULL,   -- buy_list.order_qty at rec time
  order_value          numeric,                -- recommended_qty * unit_cost (as shown)
  unit_cost            numeric,
  on_hand_at_rec       integer,                -- stock on hand when recommended
  daily_rate_at_rec    real,                   -- sales velocity (units/day) at rec time
  days_of_supply_at_rec real,
  supplier             text,
  stockout_risk        text,                   -- the report's own risk label, if any
  reason               text,
  rec_date             date        NOT NULL,   -- the suggestion's day (dedupe key)
  generated_at         timestamptz NOT NULL DEFAULT now(),
  -- One snapshot per SKU per day per store: re-viewing the buying report the
  -- same day must not create duplicate suggestions to evaluate.
  UNIQUE (client_id, location_id, sku, rec_date)
);

CREATE INDEX IF NOT EXISTS idx_po_recs_tenant_date
  ON po_recommendations (client_id, location_id, rec_date DESC);

CREATE TABLE IF NOT EXISTS po_recommendation_outcomes (
  rec_id               bigint      NOT NULL REFERENCES po_recommendations(id) ON DELETE CASCADE,
  client_id            integer     NOT NULL,
  location_id          integer     NOT NULL,
  window_days          integer     NOT NULL,
  evaluated_at         timestamptz NOT NULL DEFAULT now(),
  data_through         date,                   -- sales frontier the evaluation saw
  acted                boolean,                -- a matching PO appeared after rec_date within the window
  actual_qty           integer,               -- units actually purchased in (rec_date, rec_date+window]
  order_date           date,                   -- first PO date after the rec
  qty_accuracy         real,                   -- 1 - |rec-actual|/rec, clamped 0..1 (forecast accuracy); NULL if not acted
  units_sold           integer,               -- units sold across the window
  sell_through         real,                   -- units_sold / actual_qty; NULL if not acted / no order
  velocity_before      real,                   -- units/day, 28d before rec
  velocity_after       real,                   -- units/day across the window
  stockout_days_before integer,               -- zero-sales days in the 28d before (proxy); NULL if unknown
  stockout_days_after  integer,               -- zero-sales days across the window (proxy); NULL if unknown
  gross_margin         real,                   -- $ margin on units_sold (where cost known)
  revenue_impact       real,                   -- $ revenue on units_sold
  turnover             real,                   -- annualized turns ≈ (units_sold/window*365) / avg_on_hand
  final_score          real,                   -- blended 0..1 (accuracy + sell-through + velocity lift)
  verdict              text        NOT NULL CHECK
                         (verdict IN ('winner', 'neutral', 'underperformer', 'insufficient_data')),
  PRIMARY KEY (rec_id, window_days)
);

CREATE INDEX IF NOT EXISTS idx_po_outcomes_tenant_window
  ON po_recommendation_outcomes (client_id, location_id, window_days);

-- Least privilege: the app captures (INSERT) and the evaluator upserts (UPDATE);
-- no DELETE. Sequences need USAGE for the bigserial INSERT under a non-owner.
GRANT SELECT, INSERT, UPDATE ON TABLE po_recommendations         TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE po_recommendation_outcomes TO bottleai_writer;
GRANT USAGE, SELECT ON SEQUENCE po_recommendations_id_seq        TO bottleai_writer;

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS po_recommendation_outcomes;
-- DROP TABLE IF EXISTS po_recommendations;
