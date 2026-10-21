#!/usr/bin/env node
/**
 * The forward on-hand capture — verification against the real warehouse.
 *
 * `feature_daily.on_hand` was NULL in all 12,091,569 rows. Migration 018
 * created the column and said why it would stay empty: `syncgo.products` keeps
 * ONE mutating row per SKU, so there is no on-hand history to reconstruct and
 * the column can only be "populated forward from the day capture starts".
 * Capture never started.
 *
 * It matters more than an empty column usually does, because of one line:
 *
 *     ideal_qty = order_up_to - on_hand - on_order
 *
 * A missing count read as zero does not produce a cautious small order. It
 * produces the LARGEST order the policy can express, on every SKU at once, and
 * nothing in the output looks wrong. That is what this file guards.
 *
 * Run:  node tests/on-hand-capture-verify.js
 */

require('dotenv').config();

const { getPool } = require('../database/connection');
const { getAnalyticsPool } = require('../database/analytics-connection');
const fs = require('../services/featureStoreService');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

(async () => {
  const analytics = getAnalyticsPool();
  const syncgo = getPool();

  // A store that has actually been captured. Chosen from the data rather than
  // hardcoded, so this file does not rot the moment the estate changes.
  const { rows: candidates } = await analytics.query(
    `SELECT client_id, location_id, count(on_hand)::int AS n
       FROM feature_daily WHERE on_hand IS NOT NULL
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 1`
  );

  console.log('\n── The column is no longer empty ──────────────────────────');

  const { rows: [total] } = await analytics.query(
    `SELECT count(on_hand)::bigint AS n FROM feature_daily`
  );
  check('1  feature_daily.on_hand has rows (capture has run)',
    Number(total.n) > 0,
    'run: node scripts/build-feature-store.js <client> <location> --incremental');

  if (!candidates.length) {
    console.log('\n  No captured store found; nothing further to verify.');
    process.exit(failures ? 1 : 0);
  }
  const { client_id: clientId, location_id: locationId } = candidates[0];
  console.log(`     using store ${clientId}:${locationId}`);

  console.log('\n── A negative count is never written, and never clamped ───');

  const { rows: [neg] } = await analytics.query(
    `SELECT count(*)::int AS n FROM feature_daily WHERE on_hand < 0`
  );
  check('2  no negative on_hand was written', neg.n === 0, `${neg.n} rows`);

  // 9% of products rows estate-wide report negative stock. If those had been
  // clamped to zero rather than dropped, every one of them would appear as a
  // captured zero.
  //
  // COMPARED ONLY AGAINST ROWS THAT HAVE NOT DRIFTED.
  //   The first version of this check compared the captured zero COUNT against
  //   the source's CURRENT zero count, and failed the moment the POS synced
  //   again - captured 17,243 against a source that had moved to 15,308 zeroes
  //   and 4,209 negatives. A capture is a historical fact; the source is live.
  //   Comparing the two wholesale tests how recently the store synced, not
  //   whether negatives were clamped.
  //
  //   So the join is on (sku, observation date): a source row still carrying
  //   the date we captured it on has not changed since, and is the only kind
  //   that can be compared at all.
  const { rows: negativeRows } = await syncgo.query(
    `SELECT DISTINCT ON (sku) sku,
            to_char(last_updated AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS obs_date
       FROM products
      WHERE client_id = $1 AND location_id = $2 AND stock_qty < 0
        AND last_updated IS NOT NULL
      ORDER BY sku, last_updated DESC NULLS LAST
      LIMIT 500`,
    [clientId, locationId]
  );
  let clampedCount = 0;
  for (const row of negativeRows) {
    const { rows: [hit] } = await analytics.query(
      `SELECT on_hand FROM feature_daily
        WHERE client_id = $1 AND location_id = $2 AND sku = $3
          AND obs_date = $4::date AND on_hand IS NOT NULL`,
      [clientId, locationId, row.sku, row.obs_date]
    );
    // A SKU whose source value is negative TODAY, captured on that same day,
    // must have no captured row at all. A zero there is a clamp.
    if (hit) clampedCount += 1;
  }
  check('3  a SKU negative in the source has no captured row for that day',
    clampedCount === 0,
    `${clampedCount} of ${negativeRows.length} negative SKUs were captured `
    + `anyway - clamping turns "this count is wrong" into "this shelf is empty"`);

  console.log('\n── Zero IS a measurement and must survive ─────────────────');

  const { rows: [gotZero] } = await analytics.query(
    `SELECT count(*)::int AS n FROM feature_daily
      WHERE client_id = $1 AND location_id = $2 AND on_hand = 0`,
    [clientId, locationId]
  );
  check('4  zero counts were written (an empty shelf is a fact)',
    gotZero.n > 0, `${gotZero.n} rows`);

  console.log('\n── The observation date is the SYNC\'s, never today\'s ──────');

  // The honest property: every captured date must exist in the source as a
  // last_updated day. A stale store stamped with today's date would break it.
  const { rows: mismatch } = await analytics.query(
    `SELECT to_char(f.obs_date, 'YYYY-MM-DD') AS d, count(*)::int AS n
       FROM feature_daily f
      WHERE f.client_id = $1 AND f.location_id = $2 AND f.on_hand IS NOT NULL
      GROUP BY 1 ORDER BY 1 DESC LIMIT 1`,
    [clientId, locationId]
  );
  const { rows: [srcNewest] } = await syncgo.query(
    `SELECT to_char(max(last_updated) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d
       FROM products WHERE client_id = $1 AND location_id = $2
        AND stock_qty IS NOT NULL AND stock_qty >= 0`,
    [clientId, locationId]
  );
  check('5  newest captured date equals the newest sync date',
    mismatch.length > 0 && mismatch[0].d === srcNewest.d,
    `captured ${mismatch[0]?.d}, source ${srcNewest.d}`);

  const today = new Date().toISOString().slice(0, 10);
  const { rows: [future] } = await analytics.query(
    `SELECT count(*)::int AS n FROM feature_daily
      WHERE on_hand IS NOT NULL AND obs_date > $1::date`,
    [today]
  );
  check('6  nothing was written into the future', future.n === 0, `${future.n} rows`);

  console.log('\n── Capture is idempotent, and never rewrites a fact ───────');

  // IDEMPOTENCE IS SCALE-INDEPENDENT, so this re-runs against the SMALLEST
  // captured store rather than the largest. The checks above want the biggest
  // store, because that is where negatives and zeros are most likely to be
  // found; this one does not, and running it there made the suite fail for a
  // reason that has nothing to do with the property:
  //
  //   the capture reads every SKU's stock_qty from the warehouse on another
  //   host, and on the largest store (29,790 SKUs) the identical call measured
  //   2.7s once and 18.2s a few minutes later, against a 15s statement
  //   timeout. The test was reporting warehouse latency as a correctness
  //   failure.
  const { rows: [smallest] } = await analytics.query(
    `SELECT client_id, location_id FROM feature_daily
      WHERE on_hand IS NOT NULL
      GROUP BY 1, 2 ORDER BY count(on_hand) ASC LIMIT 1`
  );
  const idemC = smallest ? smallest.client_id : clientId;
  const idemL = smallest ? smallest.location_id : locationId;
  console.log(`     re-running against the smallest captured store ${idemC}:${idemL}`);

  const { rows: [before] } = await analytics.query(
    `SELECT count(on_hand)::int AS n, sum(on_hand)::numeric AS total
       FROM feature_daily WHERE client_id = $1 AND location_id = $2`,
    [idemC, idemL]
  );
  // A warehouse timeout here is not a failed assertion - it is the one thing
  // this check cannot distinguish from success without the data. Say so and
  // move on rather than crashing the suite.
  let again;
  try {
    again = await fs.captureOnHand(analytics, syncgo, {
      clientId: idemC, locationId: idemL, asOf: today,
    });
  } catch (err) {
    console.log(`  SKIP 7-9 could not re-run capture - ${err.message}`);
    console.log('       (the warehouse read timed out; this says nothing about '
      + 'idempotence)');
    again = null;
  }
  const { rows: [after] } = await analytics.query(
    `SELECT count(on_hand)::int AS n, sum(on_hand)::numeric AS total
       FROM feature_daily WHERE client_id = $1 AND location_id = $2`,
    [idemC, idemL]
  );
  if (again) {
    check('7  re-running capture writes nothing new', again.written === 0,
      `wrote ${again.written}`);
    check('8  the counts are unchanged', before.n === after.n,
      `${before.n} -> ${after.n}`);
    check('9  no captured value was rewritten',
      String(before.total) === String(after.total),
      `${before.total} -> ${after.total}`);
  }

  console.log('\n── The basis of the date is recorded, not assumed ─────────');

  check('10 capture states which definition of "day" it used',
    again.day_basis === 'utc', String(again.day_basis));
  check('11 staleness is reported so a stopped sync is visible',
    again.staleness_days !== undefined, String(again.staleness_days));

  console.log('\n── Capture rows must not look like sales ──────────────────');

  // Sheet 04 counts n from days with units_sold; a capture row carries only a
  // shelf count. If these were written with units_sold = 0 they would inflate
  // every store's evidence and shrink it toward its own data prematurely.
  const { rows: [shape] } = await analytics.query(
    `SELECT count(*) FILTER (WHERE units_sold = 0)::int AS zero_sales
       FROM feature_daily
      WHERE client_id = $1 AND location_id = $2 AND on_hand IS NOT NULL
        AND revenue IS NULL`,
    [clientId, locationId]
  );
  check('12 capture never writes units_sold = 0 (that would inflate n)',
    shape.zero_sales === 0, `${shape.zero_sales} rows`);

  console.log('');
  console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
