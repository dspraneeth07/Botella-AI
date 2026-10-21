#!/usr/bin/env node
/**
 * Build the feature store (sheet 03).
 *
 *   node scripts/build-feature-store.js                 # every store, full history
 *   node scripts/build-feature-store.js 171 171         # one store
 *   node scripts/build-feature-store.js --incremental   # last 7 days only
 *   node scripts/build-feature-store.js --as-of 2026-09-21
 *
 * Anchored to --as-of (default: today), NEVER to max(sale_date). A store whose
 * sync is four days behind gets the same window production will use, with
 * those days counted as unsynced rather than silently shifting the window.
 */
require('dotenv').config();

const { getPool } = require('../database/connection');
const { getAnalyticsPool } = require('../database/analytics-connection');
const fs = require('../services/featureStoreService');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const positional = args.filter((a) => /^\d+$/.test(a)).map(Number);

const AS_OF = opt('as-of') || new Date().toISOString().slice(0, 10);
const INCREMENTAL = flag('incremental');
const CONCURRENCY = parseInt(opt('concurrency') || '3', 10);

(async () => {
  const analytics = getAnalyticsPool();
  const syncgo = getPool();

  let stores;
  if (positional.length >= 2) {
    stores = [{ client_id: positional[0], location_id: positional[1] }];
  } else {
    const { rows } = await syncgo.query(
      `SELECT DISTINCT client_id, location_id FROM sale_items ORDER BY 1, 2`
    );
    stores = rows;
  }

  const since = INCREMENTAL
    ? new Date(Date.parse(AS_OF) - fs.INCREMENTAL_LOOKBACK_DAYS * 86400000)
      .toISOString().slice(0, 10)
    : null;

  console.log(`Building ${stores.length} store(s), as_of ${AS_OF}`
    + (since ? ` (incremental from ${since})` : ' (full history)'));
  console.log('─'.repeat(78));

  const totals = { facts: 0, calendar: 0, open: 0, closed: 0, unsynced: 0,
    dropped: 0, stores: 0, skipped: 0, failed: 0,
    on_hand: 0, on_hand_negative: 0, on_hand_future: 0 };
  // Stores whose newest shelf count is older than this are reported at the
  // end. Not a failure of the build - a sync that stopped, which nobody was
  // being told about, and which silently costs those stores every reorder
  // recommendation they would otherwise get (sheet 14).
  const STALE_AFTER_DAYS = parseInt(opt('stale-after') || '7', 10);
  const staleStores = [];
  const started = Date.now();

  let cursor = 0;
  const worker = async () => {
    while (cursor < stores.length) {
      const s = stores[cursor++];
      try {
        const r = await fs.buildStore(analytics, syncgo, {
          clientId: s.client_id, locationId: s.location_id, asOf: AS_OF, since,
        });

        // The forward on-hand capture.
        //
        // BEFORE the no-sales skip, deliberately. It reads a DIFFERENT source
        // (products, not sale_items) and writes a different kind of fact - one
        // about a shelf on a day rather than about a transaction - so "this
        // store sold nothing in the window" says nothing at all about whether
        // its shelf counts are worth recording.
        //
        // The first version of this ran after the skip and captured zero rows
        // for store 106: 29,019 SKUs, 10,334 of them with stock, dropped
        // because the store had no sales that week. That is backwards. A store
        // holding stock it is not selling is the DEAD STOCK case, which is the
        // one most worth having a shelf count for.
        //
        // It is also wrapped separately, so a failure to capture cannot lose a
        // successful build, and vice versa.
        let oh = null;
        try {
          oh = await fs.captureOnHand(analytics, syncgo, {
            clientId: s.client_id, locationId: s.location_id, asOf: AS_OF,
          });
          totals.on_hand += oh.written;
          totals.on_hand_negative += oh.dropped_negative;
          totals.on_hand_future += oh.dropped_future;
          if (oh.staleness_days === null
              || oh.staleness_days > STALE_AFTER_DAYS) {
            staleStores.push({ store: `${s.client_id}:${s.location_id}`,
              newest: oh.newest_observation, days: oh.staleness_days });
          }
        } catch (err) {
          console.error(`  ${s.client_id}:${s.location_id} on_hand capture `
            + `FAILED - ${err.message}`);
        }

        if (r.skipped) {
          totals.skipped += 1;
          if (oh && oh.written) {
            console.log(`  ${String(s.client_id + ':' + s.location_id).padEnd(10)}`
              + `no sales in window, but captured ${oh.written} shelf count(s)`
              + (oh.staleness_days ? `  (${oh.staleness_days}d old)` : ''));
          }
          continue;
        }
        totals.stores += 1;
        totals.facts += r.facts;
        totals.calendar += r.calendar;
        totals.open += r.open_days;
        totals.closed += r.closed_days;
        totals.unsynced += r.unsynced_days;
        totals.dropped += r.dropped_on_closed_days;

        console.log(
          `  ${String(s.client_id + ':' + s.location_id).padEnd(10)}`
          + `facts ${String(r.facts).padStart(7)}  days ${String(r.calendar).padStart(5)}`
          + `  open ${String(r.open_days).padStart(5)}`
          + `  closed ${String(r.closed_days).padStart(4)}`
          + `  unsynced ${String(r.unsynced_days).padStart(4)}`
          + `  on_hand ${String(oh ? oh.written : '-').padStart(6)}`
          + (oh && oh.staleness_days ? `  (${oh.staleness_days}d old)` : '')
        );
      } catch (err) {
        totals.failed += 1;
        console.error(`  ${s.client_id}:${s.location_id} FAILED - ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(CONCURRENCY, stores.length || 1) }, worker));

  console.log('─'.repeat(78));
  console.log(`built ${totals.stores} store(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`
    + `  (${totals.skipped} with no sales, ${totals.failed} failed)`);
  console.log(`  feature_daily rows     ${totals.facts.toLocaleString()}`);
  console.log(`  feature_store_day rows ${totals.calendar.toLocaleString()}`);
  console.log(`  open ${totals.open.toLocaleString()}  closed ${totals.closed.toLocaleString()}`
    + `  unsynced ${totals.unsynced.toLocaleString()}`);
  if (totals.dropped) {
    console.log(`  dropped ${totals.dropped} fact(s) landing on closed days`);
  }
  console.log(`  on_hand captured       ${totals.on_hand.toLocaleString()}`
    + (totals.on_hand_negative
      ? `  (${totals.on_hand_negative.toLocaleString()} negative counts left NULL,`
        + ' never clamped to zero)' : ''));
  if (totals.on_hand_future) {
    console.log(`  ${totals.on_hand_future} count(s) timestamped after as_of, not written`);
  }

  if (staleStores.length) {
    // Printed rather than logged, because it is the finding most likely to be
    // acted on: a store with no recent shelf count can receive NO reorder
    // recommendation at all, and until now nothing said so.
    console.log('');
    console.log(`  ${staleStores.length} store(s) have no shelf count newer than `
      + `${STALE_AFTER_DAYS} days. These stores cannot be given a reorder`);
    console.log('  recommendation at all until their POS product sync resumes:');
    for (const st of staleStores.slice(0, 20)) {
      console.log(`    ${st.store.padEnd(12)}`
        + (st.newest ? `newest ${st.newest} (${st.days}d old)` : 'no counts at all'));
    }
    if (staleStores.length > 20) {
      console.log(`    ... and ${staleStores.length - 20} more`);
    }
  }

  const def = await analytics.query('SELECT count(*)::int n FROM feature_daily_default');
  console.log(`  DEFAULT partition: ${def.rows[0].n} rows`
    + (def.rows[0].n ? '  <- ALERT: partitions ran out' : ' (correct)'));

  await analytics.end();
  await syncgo.end();
  process.exit(totals.failed ? 1 : 0);
})().catch((err) => {
  console.error('build aborted:', err.message);
  process.exit(1);
});
