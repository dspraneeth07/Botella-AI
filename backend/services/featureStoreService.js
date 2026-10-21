/**
 * Feature store — the builder, and the ONE definition of a rate.
 *
 * Sheet 03 created the tables and the Python reader. This is the half that was
 * missing: the job that fills them, and the function every Node caller uses
 * instead of dividing by calendar days.
 *
 * WHY THIS IS IN NODE
 *   The feature store lives in `bottleai_analytics`, and Node is the sole
 *   writer of that database (sheets 00-02). The source is `syncgo`, which Node
 *   reads. Python holds no analytics credentials by design - it is stateless -
 *   so a Python builder would have meant either giving it write access or
 *   inventing a second writer. Neither is worth it.
 *
 * WHY ALL THE LOGIC IS IN SQL
 *   The rules - UPC canonicalisation, VOID exclusion, the open/closed/unsynced
 *   calendar, the outage-vs-closure distinction - exist once, as SQL, and Node
 *   only moves rows. Re-implementing the calendar derivation in JavaScript
 *   would have recreated the 454-vs-485 problem in a new place, which is the
 *   one thing this whole sheet exists to prevent.
 *
 *   `app/pipeline/features/build.py` holds the same SQL as the executable
 *   SPECIFICATION, with unit tests over the derivation rules. The two are
 *   pinned by `tests/feature-store-reconcile.js`, which runs the Node SQL
 *   against the real warehouse and reconciles it to `integrationService.getSales`
 *   exactly, per SKU.
 *
 * THE BUG THIS REPLACES
 *   recommendationEvalService computed `units / (28 / 7)` and
 *   `units / 28` - CALENDAR days. Bethany (171:171) closes every Sunday, so
 *   that understates its velocity by 14.7% (212.32/day vs 247.71/open-day),
 *   and every evaluation scored against it inherited the error.
 */

'use strict';

const logger = require('../utils/logger');
const { toInt, toNumber } = require('../utils/numbers');

/** Consecutive silent days beyond which a gap is an OUTAGE, not a closure. */
const OUTAGE_RUN_DAYS = toInt(process.env.FEATURE_OUTAGE_RUN_DAYS) ?? 5;

/** How far back an incremental build re-reads, to absorb late-arriving rows. */
const INCREMENTAL_LOOKBACK_DAYS = toInt(process.env.FEATURE_LOOKBACK_DAYS) ?? 7;

/** Rows per INSERT. Bounded so one store cannot build a 200MB statement. */
const BATCH_ROWS = 2000;

/**
 * Days of history per SELECT during a backfill.
 *
 * syncgo's statement_timeout is 15s, and the per-SKU aggregation over a large
 * store's full history is far longer than that: store 122 (880k rows,
 * 2023-01-01 onward) takes 79.5s in one statement. The first estate build
 * failed 24 of 94 stores on exactly that, every one of them a timeout.
 *
 * The fact query aggregates by (sku, obs_date), so a date slice is closed
 * under it - no aggregate spans a boundary and chunking cannot change an
 * answer. It also bounds the result set: 395k rows in one array, times the
 * build concurrency, is memory nobody budgeted for.
 *
 * The CALENDAR query is deliberately NOT chunked. Its outage detection is a
 * run-length over consecutive silent days, so a boundary mid-run would split
 * one 9-day outage into two 4-day closures - a wrong answer, quietly. It runs
 * whole, under the raised timeout below.
 */
const BACKFILL_CHUNK_DAYS = toInt(process.env.FEATURE_CHUNK_DAYS) ?? 365;

/**
 * statement_timeout for the builder's own reads, via SET LOCAL.
 *
 * SET LOCAL and not SET: a plain SET outlives `release()` and would leave a
 * 10-minute timeout on a pooled connection for whatever borrows it next -
 * which is how a batch job's settings become an API request's hung query.
 */
const BACKFILL_TIMEOUT = process.env.FEATURE_BACKFILL_TIMEOUT || '600s';

// ─── The canonical sales rule ────────────────────────────────────────────────
// Identical to integrationService.getSales and to
// app/pipeline/features/build.py. Deviating by one clause would recreate
// 454-vs-485 in a new place.
//   1. UPC->SKU canonicalisation, sku claim first, then the row holding stock
//   2. VOID receipts excluded by sale_id
//   3. quantity > 0 only
//   4. non-empty sku only
//   5. units = SUM(quantity); price = SUM(total_amount)/SUM(quantity)

const CANONICAL_CTE = `
  catalog AS (
    SELECT DISTINCT ON (jk) jk, sku
      FROM (
        SELECT sku, sku AS jk, 0 AS jk_pri, stock_qty AS jk_stock
          FROM products
         WHERE client_id = $1 AND location_id = $2
           AND is_deleted IS NOT TRUE AND NULLIF(TRIM(sku), '') IS NOT NULL
        UNION ALL
        SELECT sku, upc AS jk, 1 AS jk_pri, stock_qty AS jk_stock
          FROM products
         WHERE client_id = $1 AND location_id = $2
           AND is_deleted IS NOT TRUE AND NULLIF(TRIM(upc), '') IS NOT NULL
           AND NULLIF(TRIM(sku), '') IS NOT NULL
      ) u
     ORDER BY jk, jk_pri, jk_stock DESC NULLS LAST, sku
  ),
  voids AS (
    SELECT sale_id FROM sales
     WHERE client_id = $1 AND location_id = $2
       AND sale_status = 'VOID' AND sale_id IS NOT NULL
  ),
  lines AS (
    SELECT COALESCE(c.sku, si.sku) AS sku,
           si.sale_date::date       AS obs_date,
           si.quantity, si.total_amount, si.sale_id
      FROM sale_items si
      LEFT JOIN catalog c ON c.jk = si.sku
     WHERE si.client_id = $1 AND si.location_id = $2
       AND si.sale_date >= $3::date AND si.sale_date < ($4::date + 1)
       AND NULLIF(TRIM(si.sku), '') IS NOT NULL
       AND si.quantity > 0
       AND (si.sale_id IS NULL OR si.sale_id NOT IN (SELECT sale_id FROM voids))
  )`;

/** Sparse facts: one row per (sku, day) that had activity. */
const FEATURE_DAILY_SQL = `
WITH ${CANONICAL_CTE},
     costs AS (
       SELECT DISTINCT ON (sku) sku, cost
         FROM products
        WHERE client_id = $1 AND location_id = $2 AND is_deleted IS NOT TRUE
          AND NULLIF(TRIM(sku), '') IS NOT NULL
        ORDER BY sku, cost DESC NULLS LAST
     )
SELECT l.sku,
       l.obs_date,
       SUM(l.quantity)                                          AS units_sold,
       SUM(l.total_amount)                                      AS revenue,
       ROUND(SUM(l.total_amount) / NULLIF(SUM(l.quantity), 0), 4) AS price,
       COUNT(DISTINCT l.sale_id)                                AS baskets_containing,
       -- NULL, never 0, when the connector omits cost: a zero here would
       -- yield a 100% margin (sheets 02 + 03).
       MAX(NULLIF(co.cost, 0))                                  AS unit_cost
  FROM lines l
  LEFT JOIN costs co ON co.sku = l.sku
 GROUP BY l.sku, l.obs_date`;

/**
 * The DENSE calendar, derived in SQL so there is no JavaScript copy of the
 * open/closed/unsynced rule.
 *
 * Three states, and keeping them apart is the point:
 *   was_open=true,  has_data=true   the store traded
 *   was_open=false                  closed (Bethany's 191 Sundays)
 *   was_open=true,  has_data=false  unknown - sync has not delivered it
 *
 * Gaps-and-islands: consecutive silent days are grouped by
 * (date - row_number()), which is constant across a run. A run of
 * OUTAGE_RUN_DAYS or more is `no_sync` rather than a closure - a store rarely
 * shuts for a week without warning, and labelling an outage "closed" hides it
 * behind a plausible calendar while shrinking the denominator.
 */
const STORE_DAY_SQL = `
WITH ${CANONICAL_CTE},
     traded AS (
       SELECT obs_date,
              COUNT(DISTINCT sale_id)::int AS baskets,
              SUM(total_amount)            AS revenue,
              SUM(quantity)                AS units_total,
              COUNT(DISTINCT sku)::int     AS distinct_skus
         FROM lines GROUP BY obs_date
     ),
     span AS (
       SELECT generate_series($3::date, $4::date, '1 day')::date AS obs_date
     ),
     joined AS (
       SELECT s.obs_date, t.baskets, t.revenue, t.units_total, t.distinct_skus,
              (t.obs_date IS NOT NULL) AS traded
         FROM span s LEFT JOIN traded t ON t.obs_date = s.obs_date
     ),
     silent AS (
       SELECT obs_date,
              obs_date - (row_number() OVER (ORDER BY obs_date))::int AS run_key
         FROM joined WHERE NOT traded
     ),
     runs AS (
       SELECT obs_date, COUNT(*) OVER (PARTITION BY run_key)::int AS run_len
         FROM silent
     )
SELECT j.obs_date,
       CASE WHEN j.traded THEN true
            WHEN r.run_len >= $5::int THEN true   -- an outage: open, unknown
            WHEN j.obs_date > $6::date THEN true  -- beyond the sync frontier
            ELSE false END                        AS was_open,
       CASE WHEN j.traded THEN true ELSE false END AS has_data,
       CASE WHEN j.traded THEN 'observed'
            WHEN r.run_len >= $5::int THEN 'no_sync'
            WHEN j.obs_date > $6::date THEN 'no_sync'
            ELSE 'assumed_closed' END             AS open_source,
       j.baskets, j.revenue, j.units_total, j.distinct_skus
  FROM joined j
  LEFT JOIN runs r ON r.obs_date = j.obs_date
 ORDER BY j.obs_date`;

// ─── Build ───────────────────────────────────────────────────────────────────

/**
 * Populate the feature store for one store.
 *
 * @param {object} opts
 * @param {string} opts.asOf     'YYYY-MM-DD'. THE anchor - never max(sale_date).
 * @param {string} opts.since    'YYYY-MM-DD'. Omit for a full backfill.
 * @returns {{facts, calendar, open_days, closed_days, unsynced_days}}
 */
async function buildStore(analyticsPool, syncgoPool, {
  clientId, locationId, asOf, since = null, outageRunDays = OUTAGE_RUN_DAYS,
}) {
  // ONE read-only snapshot for the whole store.
  //
  // The chunks below are separate statements, so without a snapshot a sync
  // landing mid-build would let the 2023 slice and the 2026 slice disagree
  // about the same store - the fact table would then hold a state that never
  // existed. REPEATABLE READ costs nothing here and removes the question.
  const client = await syncgoPool.connect();
  let facts;
  let calendar;
  let start;
  let end;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${BACKFILL_TIMEOUT}'`);

    // The sync frontier: the last day the warehouse has actually delivered.
    // Days after it are UNKNOWN, not closed (sheet 03 rule 3).
    const frontierRes = await client.query(
      'SELECT MAX(sale_date)::date AS d, MIN(sale_date)::date AS lo FROM sale_items WHERE client_id=$1 AND location_id=$2',
      [clientId, locationId]
    );
    const frontier = frontierRes.rows[0]?.d;
    const earliest = frontierRes.rows[0]?.lo;
    if (!frontier) {
      await client.query('ROLLBACK');
      return { facts: 0, calendar: 0, open_days: 0, closed_days: 0,
        unsynced_days: 0, skipped: 'no_sales' };
    }

    start = since || toDateString(earliest);
    end = asOf;
    const frontierStr = toDateString(frontier);

    // Facts in date slices; the calendar whole. See BACKFILL_CHUNK_DAYS for
    // why the asymmetry is not an oversight.
    const factRows = [];
    for (const [from, to] of dateChunks(start, end, BACKFILL_CHUNK_DAYS)) {
      const part = await client.query(FEATURE_DAILY_SQL,
        [clientId, locationId, from, to]);
      // NOT push(...part.rows): the spread passes every row as a separate
      // ARGUMENT, and a chunk of 300k rows overflows the call stack. It failed
      // on exactly the five largest stores in the estate - the ones chunking
      // was added to rescue - which is the shape of bug that only ever appears
      // on the data you were trying to fix.
      for (const row of part.rows) factRows.push(row);
    }

    const calRes = await client.query(STORE_DAY_SQL,
      [clientId, locationId, start, end, outageRunDays, frontierStr]);
    calendar = calRes.rows;
    await client.query('COMMIT');
    facts = factRows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const openDates = new Set(
    calendar.filter((c) => c.was_open && c.has_data).map((c) => toDateString(c.obs_date))
  );

  // A fact on a day the calendar calls CLOSED is a contradiction - usually a
  // timezone-shifted receipt. Dropped rather than written, because a row on a
  // closed day makes was_open a lie and the denominator wrong in the one
  // direction nobody checks.
  const kept = facts.filter((f) => openDates.has(toDateString(f.obs_date)));
  const dropped = facts.length - kept.length;
  facts = kept;

  await upsertCalendar(analyticsPool, clientId, locationId, calendar);
  await upsertFacts(analyticsPool, clientId, locationId, facts);

  const summary = {
    facts: facts.length,
    dropped_on_closed_days: dropped,
    calendar: calendar.length,
    open_days: calendar.filter((c) => c.was_open && c.has_data).length,
    closed_days: calendar.filter((c) => !c.was_open).length,
    unsynced_days: calendar.filter((c) => c.was_open && !c.has_data).length,
    start, end,
  };
  return summary;
}

async function upsertCalendar(pool, clientId, locationId, rows) {
  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const chunk = rows.slice(i, i + BATCH_ROWS);
    await pool.query(
      `INSERT INTO feature_store_day
         (client_id, location_id, obs_date, was_open, has_data, open_source,
          baskets, revenue, units_total, distinct_skus, updated_at)
       SELECT $1, $2, d.obs_date, d.was_open, d.has_data, d.open_source,
              d.baskets, d.revenue, d.units_total, d.distinct_skus, now()
         FROM (SELECT unnest($3::date[])   AS obs_date,
                      unnest($4::bool[])   AS was_open,
                      unnest($5::bool[])   AS has_data,
                      unnest($6::text[])   AS open_source,
                      unnest($7::int[])    AS baskets,
                      unnest($8::numeric[]) AS revenue,
                      unnest($9::numeric[]) AS units_total,
                      unnest($10::int[])   AS distinct_skus) d
       ON CONFLICT (client_id, location_id, obs_date) DO UPDATE SET
         was_open=EXCLUDED.was_open, has_data=EXCLUDED.has_data,
         open_source=EXCLUDED.open_source, baskets=EXCLUDED.baskets,
         revenue=EXCLUDED.revenue, units_total=EXCLUDED.units_total,
         distinct_skus=EXCLUDED.distinct_skus, updated_at=now()`,
      [clientId, locationId,
        chunk.map((r) => toDateString(r.obs_date)),
        chunk.map((r) => r.was_open),
        chunk.map((r) => r.has_data),
        chunk.map((r) => r.open_source),
        chunk.map((r) => toInt(r.baskets)),
        chunk.map((r) => toNumber(r.revenue)),
        chunk.map((r) => toNumber(r.units_total)),
        chunk.map((r) => toInt(r.distinct_skus))]
    );
  }
}

async function upsertFacts(pool, clientId, locationId, rows) {
  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const chunk = rows.slice(i, i + BATCH_ROWS);
    await pool.query(
      `INSERT INTO feature_daily
         (client_id, location_id, sku, obs_date, units_sold, revenue,
          unit_cost, price, baskets_containing, known_at, updated_at)
       SELECT $1, $2, f.sku, f.obs_date, f.units_sold, f.revenue,
              f.unit_cost, f.price, f.baskets_containing, now(), now()
         FROM (SELECT unnest($3::text[])    AS sku,
                      unnest($4::date[])    AS obs_date,
                      unnest($5::numeric[]) AS units_sold,
                      unnest($6::numeric[]) AS revenue,
                      unnest($7::numeric[]) AS unit_cost,
                      unnest($8::numeric[]) AS price,
                      unnest($9::int[])     AS baskets_containing) f
       ON CONFLICT (client_id, location_id, sku, obs_date) DO UPDATE SET
         units_sold=EXCLUDED.units_sold, revenue=EXCLUDED.revenue,
         unit_cost=COALESCE(EXCLUDED.unit_cost, feature_daily.unit_cost),
         price=EXCLUDED.price,
         baskets_containing=EXCLUDED.baskets_containing,
         -- known_at is NEVER advanced: it records when the fact FIRST became
         -- known, and moving it forward would let a backtest see a row earlier
         -- than it really arrived.
         updated_at=now()`,
      [clientId, locationId,
        chunk.map((r) => r.sku),
        chunk.map((r) => toDateString(r.obs_date)),
        chunk.map((r) => toNumber(r.units_sold)),
        chunk.map((r) => toNumber(r.revenue)),
        chunk.map((r) => toNumber(r.unit_cost)),
        chunk.map((r) => toNumber(r.price)),
        chunk.map((r) => toInt(r.baskets_containing))]
    );
  }
}

// ─── The forward on-hand capture ─────────────────────────────────────────────

/**
 * Write today's shelf counts into `feature_daily.on_hand`.
 *
 * THE COLUMN THIS FILLS HAS BEEN NULL IN ALL 12,091,569 ROWS.
 *   Migration 018 created `on_hand` and said why it would be empty:
 *   `syncgo.products` keeps ONE mutating row per SKU, so there is no on-hand
 *   history to reconstruct and the column can only be "populated forward from
 *   the day capture starts". Capture never started. This is it.
 *
 *   It matters more than an empty column usually does, because of one line of
 *   arithmetic downstream:
 *
 *       ideal_qty = order_up_to - on_hand - on_order
 *
 *   A missing count read as zero does not produce a cautious small order. It
 *   produces the largest order the policy can express, on every SKU at once,
 *   and nothing in the output looks wrong.
 *
 * THE OBSERVATION DATE IS THE SYNC'S, NOT TODAY'S.
 *   Each row is written at `obs_date = date(products.last_updated)` - the day
 *   the count was actually taken - never at `asOf`. That one choice is what
 *   makes this table honest rather than merely populated:
 *
 *     - A store that synced this morning gets today's count at today's date.
 *     - A store whose sync stopped on 2026-06-03 gets its count at
 *       2026-06-03, which is TRUE. It is not a current count and this does
 *       not pretend it is; sheet 14 still refuses to size an order against
 *       it, because a count is only current for as long as the shelf is.
 *
 *   Stamping a stale count with today's date would be the most confident lie
 *   available to this table, and it would be invisible forever after.
 *
 * NOTHING CAPTURED IS EVER REWRITTEN.
 *   `on_hand = COALESCE(feature_daily.on_hand, EXCLUDED.on_hand)` - the same
 *   rule `known_at` follows two functions up. An observation is a fact about a
 *   day that has passed, and a table whose past changes underneath a backtest
 *   cannot be used to measure anything. Re-running capture is therefore
 *   idempotent.
 *
 * NEGATIVE COUNTS ARE DROPPED, NOT CLAMPED.
 *   83,322 of 911,022 rows estate-wide (9%) report negative stock. A shelf
 *   cannot hold -7 bottles, so these are POS artefacts. They are left NULL,
 *   because clamping to zero converts "this count is wrong" into "this shelf
 *   is empty" - a measurement nobody made, and the one that orders the most.
 *
 * Returns what it did, per store, so the caller can see coverage rather than
 * infer it from an absence of errors.
 */
async function captureOnHand(analyticsPool, syncgoPool, {
  clientId, locationId, asOf,
}) {
  // Read-only, like every other syncgo access here. One statement, so no
  // snapshot transaction is needed: there is nothing for a concurrent sync to
  // make inconsistent with itself.
  // THE OBSERVATION DATE IS DERIVED IN SQL, AS TEXT. That is not a style
  // preference, it is the difference between a reproducible job and one whose
  // answer depends on which machine ran it.
  //
  // `last_updated` is a timestamptz. Converting it to a day in JavaScript uses
  // the PROCESS's timezone, so the same row lands on a different date on a
  // developer's laptop than on a UTC server: 2026-09-23T01:30Z is the 23rd in
  // IST and the 22nd in UTC. The first version of this did exactly that, and
  // this file's own header says why it is wrong - "re-implementing the
  // calendar derivation in JavaScript would have recreated the 454-vs-485
  // problem in a new place". It did.
  //
  // `to_char(...)` and not `::date`: a bare date comes back to node-postgres
  // as a Date at LOCAL midnight, which re-opens the same question one layer
  // later. A 'YYYY-MM-DD' string has no timezone to reinterpret - the rule
  // DAILY-CAPTURE.md §4 states as "dates are strings at every boundary".
  //
  // AT TIME ZONE 'UTC' is explicit for the same reason: without it the answer
  // depends on the SESSION's TimeZone, which is ambient state and would drift
  // between a psql console, the API, and this job.
  //
  // THIS IS UTC, NOT THE STORE'S DAY, AND THAT IS A KNOWN LIMITATION.
  //   DAILY-CAPTURE.md §4 establishes that the day key should be the STORE's
  //   calendar date, because a 04:00 UTC event is the previous evening across
  //   the US. A sync at 2026-09-23T01:30Z is the 23rd in UTC and the 22nd in
  //   US Central, so counts synced overnight can be attributed one day late.
  //
  //   The resolution chain that fixes this (`resolveDayKey` +the IANA zone NWS
  //   returns) needs a per-store timezone, and the table that would supply it
  //   - `daily_store_signals` - is EMPTY in this environment: the signal cron
  //   has not run. Guessing a zone would be worse than a recorded UTC basis,
  //   so the basis is returned to the caller and reported rather than assumed.
  //   See SHEET-14 §9.
  const { rows } = await syncgoPool.query(
    `SELECT DISTINCT ON (sku) sku, stock_qty,
            to_char(last_updated AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS obs_date
       FROM products
      WHERE client_id = $1 AND location_id = $2
        AND sku IS NOT NULL AND sku <> ''
        AND stock_qty IS NOT NULL
        AND last_updated IS NOT NULL
      ORDER BY sku, last_updated DESC NULLS LAST`,
    [clientId, locationId]
  );

  const usable = [];
  let negative = 0;
  let future = 0;
  for (const row of rows) {
    const qty = Number(row.stock_qty);
    if (!Number.isFinite(qty) || qty < 0) { negative += 1; continue; }
    // Both sides are 'YYYY-MM-DD' strings, so this compares dates and not
    // instants. A sync timestamped after `asOf` would write a fact into the
    // future and let a read as of today see a count that had not been taken
    // yet; clock skew on a POS is not hypothetical.
    if (row.obs_date > asOf) { future += 1; continue; }
    usable.push({ sku: row.sku, obs_date: row.obs_date, on_hand: qty });
  }

  let written = 0;
  for (let i = 0; i < usable.length; i += BATCH_ROWS) {
    const chunk = usable.slice(i, i + BATCH_ROWS);
    const res = await analyticsPool.query(
      `INSERT INTO feature_daily
         (client_id, location_id, sku, obs_date, on_hand, known_at, updated_at)
       SELECT $1, $2, s.sku, s.obs_date, s.on_hand, now(), now()
         FROM (SELECT unnest($3::text[])    AS sku,
                      unnest($4::date[])    AS obs_date,
                      unnest($5::numeric[]) AS on_hand) s
       ON CONFLICT (client_id, location_id, sku, obs_date) DO UPDATE SET
         -- Never rewritten. See the note above.
         on_hand = COALESCE(feature_daily.on_hand, EXCLUDED.on_hand),
         updated_at = now()
       WHERE feature_daily.on_hand IS NULL`,
      [clientId, locationId,
        chunk.map((r) => r.sku),
        chunk.map((r) => r.obs_date),
        chunk.map((r) => r.on_hand)]
    );
    written += res.rowCount || 0;
  }

  const dates = new Set(usable.map((r) => r.obs_date));
  const newest = usable.length
    ? usable.reduce((a, r) => (r.obs_date > a ? r.obs_date : a), '')
    : null;
  return {
    counted: rows.length,
    written,
    dropped_negative: negative,
    dropped_future: future,
    // Which definition of "day" these observation dates use. Recorded rather
    // than assumed, the same discipline `day_basis` applies to signal rows:
    // a date whose basis nobody stated is a date nobody can check.
    day_basis: 'utc',
    // How old the newest count is, in days. The number that decides whether
    // any reorder can be sized for this store at all.
    newest_observation: newest,
    staleness_days: newest
      ? Math.round((Date.parse(asOf) - Date.parse(newest)) / 86400000)
      : null,
    observation_dates: dates.size,
  };
}

// ─── Read: the ONE definition of a rate ──────────────────────────────────────

/**
 * Units per OPEN day for each SKU over a window anchored to `asOf`.
 *
 * THE denominator comes from `feature_store_day`, never from the calendar
 * length. That is the whole difference: on Bethany a 28-day window has 24 open
 * days, so 5,945 units is 247.71/open-day and not 212.32/day - a 14.3% gap
 * that every downstream evaluation used to inherit.
 *
 * Returns a Map sku -> { units, open_days, per_open_day, per_calendar_day }.
 * `per_calendar_day` is returned only so a caller can SEE the difference; no
 * decision should use it.
 */
async function ratesBySku(analyticsPool, {
  clientId, locationId, asOf, windowDays, skus = null,
}) {
  const { rows } = await analyticsPool.query(
    `WITH win AS (
       SELECT ($1::date - ($2::int - 1)) AS start_date, $1::date AS end_date
     ),
     days AS (
       SELECT count(*)::int AS open_days
         FROM feature_store_day d, win w
        WHERE d.client_id=$3 AND d.location_id=$4
          AND d.obs_date BETWEEN w.start_date AND w.end_date
          AND d.was_open IS TRUE AND d.has_data IS TRUE
     )
     SELECT f.sku,
            COALESCE(SUM(f.units_sold), 0)::numeric AS units,
            (SELECT open_days FROM days)            AS open_days
       FROM feature_daily f, win w
      WHERE f.client_id=$3 AND f.location_id=$4
        AND f.obs_date BETWEEN w.start_date AND w.end_date
        AND ($5::text[] IS NULL OR f.sku = ANY($5))
      GROUP BY f.sku`,
    [asOf, windowDays, clientId, locationId, skus]
  );

  const out = new Map();
  for (const r of rows) {
    const units = toNumber(r.units) ?? 0;
    const openDays = toInt(r.open_days) ?? 0;
    out.set(r.sku, {
      units,
      open_days: openDays,
      // NULL, not 0, when there are no open days: "we cannot state a rate" is
      // a different fact from "the rate is zero" (utils/numbers.js).
      per_open_day: openDays > 0 ? units / openDays : null,
      per_calendar_day: units / windowDays,
    });
  }
  return out;
}

/** Open days in a window. The denominator, on its own. */
async function openDays(analyticsPool, { clientId, locationId, asOf, windowDays }) {
  const { rows } = await analyticsPool.query(
    `SELECT count(*)::int AS n
       FROM feature_store_day
      WHERE client_id=$1 AND location_id=$2
        AND obs_date BETWEEN ($3::date - ($4::int - 1)) AND $3::date
        AND was_open IS TRUE AND has_data IS TRUE`,
    [clientId, locationId, asOf, windowDays]
  );
  return toInt(rows[0]?.n) ?? 0;
}

/** Has this store been built? Callers degrade to their own maths if not. */
async function isBuilt(analyticsPool, clientId, locationId) {
  try {
    const { rows } = await analyticsPool.query(
      `SELECT EXISTS (SELECT 1 FROM feature_store_day
         WHERE client_id=$1 AND location_id=$2) AS ok`,
      [clientId, locationId]
    );
    return Boolean(rows[0]?.ok);
  } catch (err) {
    logger.warn(`[FeatureStore] availability probe failed: ${err.message}`);
    return false;
  }
}

/** node-postgres hands back a Date for a DATE column; keep days as strings. */
/**
 * Inclusive [from, to] slices of at most `days` each, as 'YYYY-MM-DD'.
 *
 * Built by stepping a UTC millisecond counter rather than by mutating a local
 * Date: `setDate` on a local date crosses a DST boundary twice a year and
 * lands on the same day it started, which would emit a duplicate slice - and
 * the fact upsert would then double-count that slice's units.
 */
function dateChunks(from, to, days) {
  const DAY_MS = 86400000;
  const startMs = Date.parse(`${from}T00:00:00Z`);
  const endMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return [];
  }
  const out = [];
  for (let ms = startMs; ms <= endMs; ms += days * DAY_MS) {
    const sliceEnd = Math.min(ms + (days - 1) * DAY_MS, endMs);
    out.push([
      new Date(ms).toISOString().slice(0, 10),
      new Date(sliceEnd).toISOString().slice(0, 10),
    ]);
  }
  return out;
}

function toDateString(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  // Local getters, NOT toISOString(): a DATE is parsed at LOCAL midnight, so
  // toISOString would shift it a day west of UTC.
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = {
  BACKFILL_CHUNK_DAYS,
  BATCH_ROWS,
  dateChunks,
  FEATURE_DAILY_SQL,
  INCREMENTAL_LOOKBACK_DAYS,
  OUTAGE_RUN_DAYS,
  STORE_DAY_SQL,
  buildStore,
  captureOnHand,
  isBuilt,
  openDays,
  ratesBySku,
  toDateString,
};
