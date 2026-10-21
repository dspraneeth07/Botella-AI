-- ============================================================================
-- Analytics migration 018 — the feature store (sheet 03)
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js — see 001.)
--
-- NUMBERING: the sheet asks for 015_feature_store.sql. 015 is
--   daily_store_recommendations and 016/017 are taken, so this is 018.
--
-- WHY
--   Velocity is currently computed in app/store_data/velocity.py, again in
--   backend/lib/metrics.js, and again in SQL inside individual chat tools.
--   When those disagree you get 454 versus 485 — the same question answered
--   twice, differently, with neither marked as the authority. One definition,
--   computed once, read everywhere.
--
-- ── THE GRAIN, AND WHY IT IS SPARSE ─────────────────────────────────────────
--   Measured on the live warehouse, not assumed:
--
--     DENSE  (every store × every SKU × every day)  6,556,636,357 rows @1,500
--     SPARSE (only where something was observed)      173,027,171 rows @1,500
--
--   The sheet's target is ~317M. Dense is 21× over it and never viable; sparse
--   fits with room. So feature_daily is SPARSE: a row exists only where there
--   is an observation.
--
--   That creates the problem this design turns on. In a sparse table, "no row"
--   is ambiguous — it could mean the store was CLOSED, or open and simply did
--   not sell that SKU. Conflating those is exactly the defect the sheet exists
--   to remove, so the calendar is a SECOND table at (store, day) grain:
--
--     feature_store_day   1,500 stores × ~1,100 days ≈ 1.65M rows. Tiny.
--
--   Every rate then takes its NUMERATOR from the sparse facts and its
--   DENOMINATOR from the dense calendar. Both correct, and it scales.
--
-- ── CLOSED DAYS ARE ABSENT, NOT ZERO ────────────────────────────────────────
--   Measured on Bethany Discount Liquor (171:171) over its full history:
--
--     calendar days 1,358   trading days 1,158   CLOSED 200
--     of those 200: 191 are SUNDAYS, plus 9 scattered holidays
--     dividing by calendar days understates velocity by 14.7%
--
--   Over a recent 28-day window: 24 open days, 5,945 units.
--     per calendar day 212.32     per OPEN day 247.71
--
--   The sheet said 199 closed days and ~16%; measured it is 200 and 14.7%.
--   The claim is right and the mechanism is exactly as described.
--
-- ── POINT-IN-TIME CORRECTNESS ───────────────────────────────────────────────
--   `known_at` is when WE learned the fact, which is not when the fact
--   happened. A read as of 3 March must return what was known on 3 March,
--   excluding rows that arrived later — otherwise every backtest leaks and
--   reports a skill the live system will not have. That is the single most
--   expensive bug class in forecasting, because it makes a broken model look
--   excellent right up until it is deployed.
--
-- ── PARTITIONS RUN OUT. THAT IS NOT HYPOTHETICAL ────────────────────────────
--   Sheet 02 found that syncgo's sale_items partitions stop at 2026-11-30, so
--   in ~10 weeks every new sale silently lands in DEFAULT. This table will not
--   repeat that quietly: it ships with a DEFAULT partition that must stay
--   EMPTY, an ensure_feature_partitions() helper, and a monitoring query. A
--   non-empty default is an alert, not a shrug.
-- ============================================================================

BEGIN;

-- ── The dense store calendar ────────────────────────────────────────────────
-- One row per store per day. Small enough to be dense, which is what lets the
-- fact table be sparse without losing the closed/no-sale distinction.
CREATE TABLE IF NOT EXISTS feature_store_day (
  client_id   integer NOT NULL,
  location_id integer NOT NULL,
  obs_date    date    NOT NULL,

  -- From OBSERVED TRADING DAYS, not inferred per SKU and not a guess. A store
  -- that sold nothing all day looks identical to a closed store at SKU grain;
  -- at store grain it does not.
  was_open boolean NOT NULL,

  -- Separate from was_open on purpose. A store 4 days behind on sync has days
  -- that are neither closed nor observed — they are UNKNOWN, and a rate must
  -- not divide by them any more than it divides by a Sunday. This is what
  -- replaces the data-frontier anchor without reintroducing false downtrends.
  has_data boolean NOT NULL DEFAULT false,

  -- How was_open was decided, so a reader can tell a measured closure from an
  -- assumed one: 'observed' | 'assumed_closed' | 'no_sync'.
  open_source text NOT NULL DEFAULT 'observed'
    CHECK (open_source IN ('observed', 'assumed_closed', 'no_sync')),

  baskets      integer,   -- distinct non-VOID receipts
  revenue      numeric,
  units_total  numeric,
  distinct_skus integer,

  known_at   timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, location_id, obs_date)
);

-- "How many open days in this window" — the denominator of every rate.
CREATE INDEX IF NOT EXISTS idx_fsd_open
  ON feature_store_day (client_id, location_id, obs_date)
  WHERE was_open IS TRUE;

COMMENT ON COLUMN feature_store_day.was_open IS
  'Derived from observed trading days at STORE grain. Every rate divides by open days only.';
COMMENT ON COLUMN feature_store_day.has_data IS
  'False where sync has not delivered the day yet. Neither closed nor observed - excluded from denominators.';

-- ── The sparse fact table ───────────────────────────────────────────────────
-- NULL means GENUINELY ABSENT everywhere in this table. Never zero-filled.
CREATE TABLE IF NOT EXISTS feature_daily (
  client_id   integer NOT NULL,
  location_id integer NOT NULL,
  sku         text    NOT NULL,
  obs_date    date    NOT NULL,

  units_sold numeric,   -- NULL when the store was closed or the day is unsynced
  revenue    numeric,
  -- NULL when the connector omits cost. gokul, square and mpower send 0.00%
  -- cost across 31 stores; a zero here would yield a 100% margin, so it stays
  -- NULL and every margin built on it is withheld instead (sheet 02).
  unit_cost  numeric,
  -- NULL for all historical rows: syncgo's products.stock_qty is CURRENT-only
  -- (last_updated mutates on every sync), so there is no on-hand history to
  -- reconstruct. Populated forward from the day capture starts. Inventing a
  -- back-history here would be the most confident lie in the table.
  on_hand    numeric,
  price      numeric,
  baskets_containing integer,

  -- POINT-IN-TIME. When WE learned this, not when it happened. A read as of
  -- date D filters known_at <= D so late-arriving rows are excluded.
  known_at   timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (client_id, location_id, sku, obs_date)
) PARTITION BY RANGE (obs_date);

-- The index the sheet asks for is the primary key above; this one serves the
-- other direction — "everything for this SKU across stores" (area winners,
-- cross-store trend proof), which the tenant-first PK cannot answer.
CREATE INDEX IF NOT EXISTS idx_feature_daily_sku_date
  ON feature_daily (sku, obs_date DESC);

-- Point-in-time reads filter on known_at; without this a backtest scans the
-- whole partition to discard late rows.
CREATE INDEX IF NOT EXISTS idx_feature_daily_known
  ON feature_daily (known_at);

COMMENT ON TABLE feature_daily IS
  'Sparse feature store at (store, sku, day). NULL means genuinely absent - never zero-filled. Closed days have no row; the calendar in feature_store_day says why.';
COMMENT ON COLUMN feature_daily.known_at IS
  'When WE learned this fact. Point-in-time reads filter known_at <= as_of so late-arriving rows are excluded and backtests do not leak.';

-- ── Monthly partitions ──────────────────────────────────────────────────────
-- Idempotent, and callable later to extend the runway. Takes a range so a
-- cron can say "keep me twelve months ahead" without knowing what exists.
CREATE OR REPLACE FUNCTION ensure_feature_partitions(from_month date, to_month date)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  m date := date_trunc('month', from_month)::date;
  stop date := date_trunc('month', to_month)::date;
  made integer := 0;
  part text;
BEGIN
  WHILE m <= stop LOOP
    part := format('feature_daily_y%sm%s', to_char(m, 'YYYY'), to_char(m, 'MM'));
    IF to_regclass('public.' || part) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF feature_daily FOR VALUES FROM (%L) TO (%L)',
        part, m, (m + interval '1 month')::date
      );
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I TO bottleai_writer', part);
      made := made + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN made;
END;
$$;

COMMENT ON FUNCTION ensure_feature_partitions(date, date) IS
  'Idempotently create monthly partitions. Run ahead of time - a table whose partitions run out absorbs rows into DEFAULT silently (syncgo does this today).';

-- History back to the warehouse's earliest sales (2023-01) and a year ahead.
SELECT ensure_feature_partitions('2023-01-01'::date, (now() + interval '12 months')::date);

-- A safety net that must stay EMPTY. Rows here mean the runway ran out and
-- the monitoring query below should be alerting.
CREATE TABLE IF NOT EXISTS feature_daily_default PARTITION OF feature_daily DEFAULT;

COMMENT ON TABLE feature_daily_default IS
  'MUST STAY EMPTY. Any row here means monthly partitions ran out - run ensure_feature_partitions().';

-- ── Grants ───────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON TABLE feature_store_day     TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE feature_daily         TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE feature_daily_default TO bottleai_writer;
GRANT EXECUTE ON FUNCTION ensure_feature_partitions(date, date) TO bottleai_writer;

COMMIT;

-- ── Monitoring ───────────────────────────────────────────────────────────────
-- Run this daily. A non-zero count is an incident, not a curiosity.
--   SELECT count(*) AS rows_in_default FROM feature_daily_default;
--
-- Partition runway - how far ahead are we covered?
--   SELECT max(substring(relname from 'y(\d{4})m(\d{2})')) FROM pg_class
--    WHERE relname LIKE 'feature_daily_y%';
--
-- Extend it:
--   SELECT ensure_feature_partitions(current_date, current_date + interval '12 months');
--
-- ── Verify ───────────────────────────────────────────────────────────────────
-- -- Velocity the ONE way: numerator sparse, denominator from the calendar.
-- SELECT f.sku,
--        sum(f.units_sold)                                    AS units,
--        count(DISTINCT d.obs_date) FILTER (WHERE d.was_open) AS open_days,
--        sum(f.units_sold) / NULLIF(
--          count(DISTINCT d.obs_date) FILTER (WHERE d.was_open), 0)  AS units_per_open_day
--   FROM feature_store_day d
--   LEFT JOIN feature_daily f
--     ON  f.client_id = d.client_id AND f.location_id = d.location_id
--     AND f.obs_date  = d.obs_date  AND f.sku = 'SOME_SKU'
--  WHERE d.client_id = 171 AND d.location_id = 171
--    AND d.obs_date > current_date - 28
--  GROUP BY f.sku;
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS feature_daily;          -- drops every partition
-- DROP TABLE IF EXISTS feature_store_day;
-- DROP FUNCTION IF EXISTS ensure_feature_partitions(date, date);
