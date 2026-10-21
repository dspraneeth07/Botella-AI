-- ============================================================================
-- 034_card_retirement.sql - when the engine retired a claim, and until when
--                           it must not make it again
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js - see 001.)
--
-- WHY
--
--   The lifecycle screen (Python, candidates/lifecycle.py) retires a card
--   whose claim has visibly failed and suppresses the SKU for fourteen open
--   days, so the next morning does not re-earn the same card from the same
--   depressed window - the eight-day Stroyski loop. Retirement without
--   suppression does nothing, and the suppression was never written down.
--
--   Every morning the live route re-judged the same card, decided the same
--   retirement, and suppressed until "today + 14". So the window either rolled
--   forever (the rule kept firing on a card that only got staler) or ended the
--   moment the rule stopped firing. Neither is fourteen days. A verdict has to
--   be made once and remembered, and Python is stateless by design - Node is
--   where it gets remembered.
--
-- A TABLE, NOT COLUMNS ON `recommendations`
--
--   A retirement is about a CLAIM - this store, this SKU - not about any one of
--   the fifteen rows that carried it. Putting retired_at on `recommendations`
--   would mean choosing which row to stamp, or stamping all of them with an
--   UPDATE across history rows that are otherwise append-only. An event table
--   keyed on (client, location, sku, retired_at) records the fact once, with
--   its own reason, and the card-history feed (getCardHistory) already groups
--   by SKU, so the latest retirement per SKU is one DISTINCT ON join - cheap,
--   and served from the index below.
--
--   `retired_at` is the run's data_as_of (the store's trading day the decision
--   speaks for), never a clock read. `created_at` is when Node wrote it, inside
--   the same transaction as the run's cards, so a card from the SAME run shares
--   its timestamp and a card from a LATER run is strictly newer - which is how
--   the feed tells "a fresh claim since the retirement" from "the one retired".
--
-- `suppressed_until` IS A PROJECTION, COMPUTED BY THE ENGINE AND STORED
--
--   Fourteen OPEN days from a retirement is not a date anyone knows on the day:
--   the days the store will be open are in the future. The engine projects it
--   from the store's trailing open-day density (24 of 28 days open -> 17
--   calendar days) and rounds UP, and the date is stored rather than re-derived
--   by each reader - the same argument migration 033 makes for valid_until.
--   One date, written once, compared by everybody.
--
-- APPEND-ONLY. No UPDATE or DELETE grant, deliberately: the same morning
-- re-run inserts the same (sku, retired_at) and conflicts DO NOTHING, and a
-- retirement is a decision the engine took, which is not something the app
-- has a reason to erase.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS recommendation_retirements (
  id                bigserial    PRIMARY KEY,
  client_id         integer      NOT NULL,
  location_id       integer      NOT NULL,
  sku               text         NOT NULL,
  -- The trading day the decision speaks for (the run's data_as_of).
  retired_at        date         NOT NULL,
  -- First day the claim MAY be made again. Projected and stored, see above.
  suppressed_until  date         NOT NULL,
  -- Which rule: declining | no_recovery | stale | acted_on | dismissed.
  retirement_rule   text         NOT NULL,
  reason            text,
  -- The card that was retired, for the audit.
  first_issued      date,
  open_days_since   integer,
  recovery_ratio    double precision,
  -- For `declining`: the lower-tail probability the rule fired on and the
  -- count model it was computed under (negative_binomial | poisson |
  -- poisson_unmeasured_dispersion). NULL for the other rules.
  tail_probability  double precision,
  distribution      text,
  run_id            bigint       REFERENCES recommendation_runs(id) ON DELETE SET NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT recommendation_retirements_once_per_day
    UNIQUE (client_id, location_id, sku, retired_at),
  CONSTRAINT recommendation_retirements_window
    CHECK (suppressed_until >= retired_at)
);

COMMENT ON TABLE recommendation_retirements IS
  'One row per claim the lifecycle retired, per store, per trading day. The '
  'card-history feed joins the LATEST row per SKU so the engine honours the '
  'stored suppression instead of re-deciding it every morning.';
COMMENT ON COLUMN recommendation_retirements.retired_at IS
  'The run''s data_as_of: the trading day the decision speaks for, not the '
  'day the row was written.';
COMMENT ON COLUMN recommendation_retirements.suppressed_until IS
  'First day the claim may be made again. Projected by the engine from the '
  'store''s trailing open-day density (fourteen OPEN days), rounded up, and '
  'stored so every reader compares the same date.';

-- The feed's question: the latest retirement for each SKU at a store.
CREATE INDEX IF NOT EXISTS idx_rec_retirements_latest
  ON recommendation_retirements (client_id, location_id, sku, retired_at DESC);

-- Append-only: the insert conflicts DO NOTHING, which needs no UPDATE.
GRANT SELECT, INSERT ON TABLE recommendation_retirements TO bottleai_writer;
GRANT USAGE, SELECT ON SEQUENCE recommendation_retirements_id_seq TO bottleai_writer;

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- SELECT has_table_privilege('bottleai_writer','recommendation_retirements','INSERT');  -- t
-- SELECT has_table_privilege('bottleai_writer','recommendation_retirements','UPDATE');  -- f
-- SELECT sku, retired_at, suppressed_until, retirement_rule
--   FROM recommendation_retirements WHERE client_id = 171 ORDER BY retired_at DESC;
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE recommendation_retirements;
