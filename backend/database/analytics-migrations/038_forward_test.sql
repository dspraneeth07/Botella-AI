-- ============================================================================
-- 038_forward_test.sql - the daily forward test, persisted: every run, every
--                        card's verdict on every day, and the shelf as observed
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js - see 001.)
--
-- WHY
--
--   scripts/forward-test.js scores the cards the engine really issued against
--   the sales that really followed. It was a one-shot CLI that wrote two files
--   into audit/forward/ and kept nothing else, so three questions it was about
--   to be asked had no answer in the data:
--
--     1. HOW DID A CARD'S VERDICT CHANGE. A card is `pending` for a week and
--        then scored. Only the latest file survived, so "how many of the cards
--        issued on the 16th had been scored by the 23rd, and how many flipped
--        from pending to overstocked" was unanswerable without re-running the
--        test with a clock wound back - which it cannot do, because open days
--        are read from the live sales table.
--     2. WHAT WAS REALLY ON THE SHELF. The test SIMULATES the inventory
--        trajectory (engine_on_hand + recommended qty, depleted by real sales)
--        and says so in every figure. Nothing recorded the OBSERVED count on
--        the days that followed, so a simulated stockout could never be checked
--        against a real one. `products.stock_qty` is current-only; a count not
--        captured on the day is gone.
--     3. DID THE RUN HAPPEN. The 04:00 batch did not run for three days in
--        October because the laptop was asleep. A test that leaves no row
--        cannot say which mornings it ran on, and the 30 October report has to
--        say "15 of 15" or "11 of 15" truthfully.
--
--   The daily job (scripts/forward-test-daily.js) writes these three tables at
--   04:00 IST for the test period 2026-10-16 .. 2026-10-30, and the final
--   report is built from them rather than from files on disk.
--
-- 1. `forward_test_runs` - one row per measurement per day
--
--   The job measures FOUR times a morning: fixed 7-open-day window and each
--   card's own intended horizon, each over the test period and over the
--   trailing 30 days (so cards issued before the period keep being scored).
--   `label` names the period ('period' / 'trailing30') and `window_mode` the
--   mode, because the four are different measurements and a reader must never
--   be able to confuse a 1.8% fixed-window success rate with an intended-
--   horizon one (the first run of the CLI made exactly that mistake with one
--   filename for two modes). `metrics` is calculateConfidenceMetrics' object
--   verbatim - counts, RAR with its Wilson interval, met-forecast rate,
--   turnover efficiency, money, calibration - so the report reads what the run
--   computed, never a retyped number.
--
--   `as_of` is the IST calendar day the job ran for, computed in Asia/Kolkata
--   in code; `ran_at` is the instant. They differ when a run is repeated or
--   replayed and the day, not the instant, is what the period counts.
--
--   The generation counters sit here because generating the day's cards is the
--   first step of the same job: when the server's 04:00 batch has not run, the
--   job generates (through the same quality gate) so the period loses no day.
--   `generation` keeps WHICH stores were refused and why - the final report
--   lists them, because a store that contributed no cards is a fact about the
--   evidence, not an omission to hide.
--
-- 2. `forward_test_card_outcomes` - one row per card per run
--
--   The evolution table. On the 16th a card is `pending`; on the 24th it is
--   `overstocked`. Both rows stay, keyed by (run_id, rec_id), and the report
--   joins them to say how many verdicts moved and which way. `detail` is the
--   evaluateCard row verbatim (every rate, the window's dates, the reason), so
--   a surprising classification can be argued with months later. The typed
--   columns are the ones the report sorts and sums on. `window_closed` is the
--   plain-words form of "not pending and not no_data": the card is in a
--   denominator.
--
--   `met_forecast_rate` and the money columns are NULL, never 0, when the card
--   has no rate or no unit economics - the same rule evaluateCard follows.
--
-- 3. `forward_test_inventory_snapshots` - the observed shelf, daily
--
--   For every SKU on any card issued in the period, the job records
--   `products.stock_qty` as it stood at capture time, with the SKU's 28-open-
--   day rate and the price/cost the forward test uses for the same SKU, so the
--   simulated ending stock can be set beside a real count and a real stockout
--   (stock_qty <= 0) can be SEEN rather than inferred.
--
--   NEVER OVERWRITTEN. The job inserts ON CONFLICT DO NOTHING on the day key: a
--   second run on the same morning (a replay, a test) must not replace the
--   04:00 count with an afternoon one, because the whole point of the row is
--   that it was taken at a known moment. `captured_at` says when. A SKU with no
--   product row gets no snapshot row - absence is not a count of zero.
--
-- GRANTS
--
--   SELECT, INSERT, UPDATE and the sequence for the runs table. No DELETE: a
--   day's measurement is history and is never erased by the application (031
--   and 036 make the same argument); a correction is a migration run by the
--   owner. The snapshots table gets no UPDATE either - its contract is that a
--   row is written once.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS forward_test_runs (
  id                     bigserial    PRIMARY KEY,
  ran_at                 timestamptz  NOT NULL DEFAULT now(),
  -- The IST calendar day the run belongs to (Asia/Kolkata, computed in code).
  as_of                  date         NOT NULL,
  -- 'period'      cards issued on or after period_start (the test period)
  -- 'trailing30'  cards issued in the 30 days before as_of
  label                  text         NOT NULL,
  period_start           date         NOT NULL,
  period_end             date         NOT NULL,
  window_mode            text         NOT NULL CHECK (window_mode IN ('fixed', 'intended')),
  window_days            integer      NOT NULL,
  safety_cover_days      integer      NOT NULL,
  -- Store scope the run was asked for. Empty array = every store.
  stores                 integer[]    NOT NULL DEFAULT '{}',
  cards_examined         integer      NOT NULL DEFAULT 0,
  -- calculateConfidenceMetrics(rows), verbatim.
  metrics                jsonb        NOT NULL,
  -- Cards (any quantity) in runs generated on as_of across the scope, counted
  -- after the generation step - so a batch the server ran at 04:00 counts too.
  generated_cards_today  integer,
  -- Stores the quality gate refused / stores whose generation threw.
  generation_refused     integer      NOT NULL DEFAULT 0,
  generation_failed      integer      NOT NULL DEFAULT 0,
  -- Per-store detail of the generation step: ok, refused (with reasons),
  -- failed (with the error), already generated. Same object on each of the
  -- day's rows, because the step ran once for the day.
  generation             jsonb,
  notes                  text[]       NOT NULL DEFAULT '{}',
  CHECK (period_start <= period_end)
);

COMMENT ON TABLE forward_test_runs IS
  'One forward-test measurement (scripts/forward-test-daily.js). Four per '
  'morning: fixed and intended window modes over the test period and over the '
  'trailing 30 days. metrics is calculateConfidenceMetrics output verbatim.';
COMMENT ON COLUMN forward_test_runs.as_of IS
  'The Asia/Kolkata calendar day the run measured for. Never derived from UTC midnight.';
COMMENT ON COLUMN forward_test_runs.generated_cards_today IS
  'Cards in recommendation_runs generated on as_of (IST) across the scope, '
  'counted after the generate-if-missing step. NULL when the step was skipped.';

CREATE INDEX IF NOT EXISTS idx_forward_test_runs_day
  ON forward_test_runs (as_of DESC, label, window_mode);

CREATE TABLE IF NOT EXISTS forward_test_card_outcomes (
  run_id                 bigint   NOT NULL REFERENCES forward_test_runs(id),
  rec_id                 bigint   NOT NULL,
  client_id              integer  NOT NULL,
  location_id            integer  NOT NULL,
  rec_date               date     NOT NULL,
  sku                    text,
  recommended_qty        numeric,
  -- engine_on_hand when the card was written; NULL = the card predates it,
  -- and no stockout determination was made.
  engine_on_hand         numeric,
  simulated_start        numeric,
  -- NULL while pending or no_data: unknown, never zero.
  actual_sold            numeric,
  ending_inventory_sim   numeric,
  outcome                text     NOT NULL CHECK (outcome IN
    ('successful', 'partial_absorption', 'overstocked', 'understocked',
     'unutilized', 'no_data', 'pending')),
  velocity_ratio         numeric,
  met_forecast_rate      boolean,
  realised_margin        numeric,
  holding_cost           numeric,
  net_impact             numeric,
  stated_confidence      numeric,
  -- Open days the window asked for (fixed: the setting; intended: the
  -- card's own ceil(qty / rate), NULL when it has no rate).
  window_open_days       integer,
  -- The card is in a denominator: outcome is neither pending nor no_data.
  window_closed          boolean  NOT NULL,
  -- evaluateCard's row, verbatim.
  detail                 jsonb    NOT NULL,
  PRIMARY KEY (run_id, rec_id)
);

COMMENT ON TABLE forward_test_card_outcomes IS
  'One row per card per forward-test run, so a verdict''s evolution (pending '
  'on day 1, scored on day 8) is kept rather than overwritten. detail is the '
  'evaluateCard row verbatim.';

-- The evolution query: every run's verdict for one card, in run order.
CREATE INDEX IF NOT EXISTS idx_forward_test_card_outcomes_rec
  ON forward_test_card_outcomes (rec_id, run_id);
CREATE INDEX IF NOT EXISTS idx_forward_test_card_outcomes_store
  ON forward_test_card_outcomes (client_id, location_id, rec_date);

CREATE TABLE IF NOT EXISTS forward_test_inventory_snapshots (
  client_id            integer      NOT NULL,
  location_id          integer      NOT NULL,
  sku                  text         NOT NULL,
  snap_date            date         NOT NULL,
  -- products.stock_qty at capture time. <= 0 is an OBSERVED stockout.
  stock_qty            numeric,
  -- Units per open day over the SKU's last 28 open days before snap_date,
  -- measured the way forward-test.js measures it. NULL when the store has no
  -- open days or the SKU no sales rows - unknown, not zero.
  rate_28d_open_days   numeric,
  price                numeric,
  cost                 numeric,
  captured_at          timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, location_id, sku, snap_date)
);

COMMENT ON TABLE forward_test_inventory_snapshots IS
  'The observed shelf count for every SKU under forward test, one row per SKU '
  'per IST day, written once (ON CONFLICT DO NOTHING) so the simulated '
  'trajectory can be compared with what was really on the shelf.';

GRANT SELECT, INSERT, UPDATE ON TABLE forward_test_runs                TO bottleai_writer;
GRANT USAGE, SELECT          ON SEQUENCE forward_test_runs_id_seq      TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE forward_test_card_outcomes       TO bottleai_writer;
GRANT SELECT, INSERT         ON TABLE forward_test_inventory_snapshots TO bottleai_writer;

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- SELECT as_of, label, window_mode, cards_examined,
--        metrics->>'evaluated' AS scored, metrics->>'pending' AS pending
--   FROM forward_test_runs ORDER BY as_of DESC, label, window_mode;
-- SELECT rec_id, array_agg(outcome ORDER BY run_id) AS evolution
--   FROM forward_test_card_outcomes GROUP BY rec_id HAVING count(DISTINCT outcome) > 1;
-- SELECT count(*) FILTER (WHERE stock_qty <= 0) AS observed_stockouts, count(*)
--   FROM forward_test_inventory_snapshots WHERE snap_date = current_date;
-- SELECT has_table_privilege('bottleai_writer','forward_test_inventory_snapshots','UPDATE'); -- f
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS forward_test_card_outcomes;
-- DROP TABLE IF EXISTS forward_test_inventory_snapshots;
-- DROP TABLE IF EXISTS forward_test_runs;
