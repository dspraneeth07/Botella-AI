#!/usr/bin/env node
/**
 * Export one store's feature-store slice as the JSON that sheets 04-06 consume.
 *
 *   node scripts/export-pipeline-input.js 171 171 --top 25 --out input.json
 *
 * WHY THIS EXISTS RATHER THAN A PYTHON READER
 *   Python is stateless and holds no analytics credentials - that is a standing
 *   constraint of this architecture, not an accident. Node is the sole reader
 *   and writer of `bottleai_analytics`. So the boundary is a payload: Node
 *   reads, Python computes, and the pipeline stages stay pure and replayable
 *   because every input they saw is in a file you can keep.
 *
 * WHAT IT DOES NOT DO
 *   Compute a rate, a share or an average beyond `units / open_days`, which is
 *   featureStoreService's one definition and is reused here rather than
 *   rewritten. Everything else is the pipeline's job; the moment this script
 *   starts deriving, there are two engines again.
 */
require('dotenv').config();

const nodeFs = require('fs');
const { getPool } = require('../database/connection');
const { getAnalyticsPool } = require('../database/analytics-connection');
// Reused, not reimplemented. `String(dateObj).slice(0, 10)` yields
// "Thu Sep 25" - a JS Date stringifies to a human format, not ISO - and
// `toISOString()` shifts a DATE a day west of UTC because it was parsed at
// LOCAL midnight. featureStoreService already got this right; a second copy
// here would be a second chance to get it wrong.
const { toDateString } = require('../services/featureStoreService');

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const positional = args.filter((a) => /^\d+$/.test(a)).map(Number);

const CLIENT_ID = positional[0];
const LOCATION_ID = positional[1];
const AS_OF = opt('as-of') || new Date().toISOString().slice(0, 10);
const WINDOW_DAYS = parseInt(opt('window', '364'), 10);
const TOP = parseInt(opt('top', '25'), 10);
// --out, not stdout redirection: the connection pools log to stdout on
// startup, so `> file.json` produces a file whose first line is a log banner.
const OUT = opt('out');

if (!Number.isInteger(CLIENT_ID) || !Number.isInteger(LOCATION_ID)) {
  console.error('usage: export-pipeline-input.js <client_id> <location_id> --out FILE [--top N] [--as-of YYYY-MM-DD] [--window 364]');
  process.exit(2);
}

const d = toDateString;
const num = (v) => (v == null ? null : Number(v));

(async () => {
  const analyticsPool = getAnalyticsPool();
  const syncgoPool = getPool();

  // The same treatment featureStoreService gives the builder, and for the
  // same reason: this is a batch analysis tool, and the estate-wide cohort
  // aggregations exceed the 15s default the moment the SKU set or window
  // grows. SET LOCAL inside a read-only transaction so the raised timeout
  // cannot outlive release() and strand an API request behind it.
  const analytics = await analyticsPool.connect();
  const syncgo = await syncgoPool.connect();
  await analytics.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await analytics.query("SET LOCAL statement_timeout = '600s'");
  await syncgo.query('BEGIN TRANSACTION READ ONLY');
  await syncgo.query("SET LOCAL statement_timeout = '600s'");

  // The subject store's state, and every candidate cohort member's. State is
  // the first rung of the geography ladder, so a NULL here is not fatal - the
  // ladder simply starts at national for that store.
  const { rows: locations } = await syncgo.query(
    `SELECT client_id, location_id, state
       FROM client_locations
      WHERE is_active IS NOT FALSE`
  );
  const stateOf = new Map(
    locations.map((r) => [`${r.client_id}:${r.location_id}`, r.state || null])
  );
  const subjectState = stateOf.get(`${CLIENT_ID}:${LOCATION_ID}`) || null;

  // The dense calendar. THE denominator.
  const { rows: calendarRows } = await analytics.query(
    `SELECT obs_date, was_open, has_data, open_source
       FROM feature_store_day
      WHERE client_id = $1 AND location_id = $2
        AND obs_date >  $3::date - ($4::int - 1)
        AND obs_date <= $3::date
      ORDER BY obs_date`,
    [CLIENT_ID, LOCATION_ID, AS_OF, WINDOW_DAYS]
  );

  // A store with NO calendar rows still has days. They are days we hold no
  // data for - which is a fact we know, not an absence of one, and sheet 03
  // already has the vocabulary for it: was_open=false, has_data=false,
  // open_source='no_sync'.
  //
  // Without this the whole cold-start path dies at the first stage.
  // `count_evidence` refuses an empty window with `no_calendar_for_window`,
  // the SKU is dropped, and a brand-new store gets NOTHING - the store with
  // the least of its own data receiving the least help, which is precisely
  // backwards. Given the days, the same call returns n=0, shrinkage weights
  // the cohort at 100%, and the store gets a real answer on its first day.
  //
  // This invents no trading days. Every day is marked closed AND unsynced, so
  // open_days is 0 and nothing can divide by it.
  const calendar = calendarRows.length ? calendarRows : (() => {
    const out = [];
    const end = Date.parse(`${AS_OF}T00:00:00Z`);
    for (let i = WINDOW_DAYS - 1; i >= 0; i -= 1) {
      out.push({
        obs_date: new Date(end - i * 86400000).toISOString().slice(0, 10),
        was_open: false,
        has_data: false,
        open_source: 'no_sync',
      });
    }
    return out;
  })();

  // ── Which SKUs are worth estimating ───────────────────────────────────────
  //
  // Sold first, then CARRIED-BUT-NEVER-SOLD, ranked by how many peer stores
  // sell them.
  //
  // Seeding this list from sales alone was wrong, and wrong in the one place
  // the architecture is supposed to be strongest. 15 stores in this estate
  // carry products and have sold nothing - store 106:106 stocks 29,019 SKUs
  // and has never rung one up. Those are the purest cold-start case, the one
  // shrinkage exists to serve, and a sales-only seed hands them an empty list
  // and therefore no recommendations at all. The store with the least of its
  // own data is the store that most needs the cohort's.
  //
  // A never-sold SKU is not a zero. It has n=0, so sheet 06 returns the cohort
  // prior exactly and the card says "based 0% on your own sales" - which is
  // both true and actionable. That is the whole point of the formula.
  const { rows: soldSkus } = await analytics.query(
    `SELECT sku, SUM(units_sold) AS units
       FROM feature_daily
      WHERE client_id = $1 AND location_id = $2
        AND obs_date >  $3::date - ($4::int - 1)
        AND obs_date <= $3::date
      GROUP BY sku
      HAVING SUM(units_sold) > 0
      ORDER BY units DESC
      LIMIT $5`,
    [CLIENT_ID, LOCATION_ID, AS_OF, WINDOW_DAYS, TOP]
  );
  const skus = soldSkus.map((r) => r.sku);

  if (skus.length < TOP) {
    // What the store CARRIES. `stock_qty` is current-only (sheet 03 §2.4), so
    // this is "on the shelf now", not a history - which is the right question
    // for "what should we estimate for this store".
    const { rows: carried } = await syncgo.query(
      `SELECT DISTINCT sku FROM products
        WHERE client_id = $1 AND location_id = $2
          AND sku IS NOT NULL AND sku <> ''`,
      [CLIENT_ID, LOCATION_ID]
    );
    const unsold = carried
      .map((r) => r.sku)
      .filter((sku) => !skus.includes(sku));

    if (unsold.length) {
      // Rank by PEER PREVALENCE, not by anything of the subject's - it has
      // nothing to rank by. A SKU 40 stores sell is a better thing to say
      // something about than one 2 stores sell, and the cohort that will
      // answer for it is correspondingly stronger.
      const { rows: popular } = await analytics.query(
        `SELECT sku, COUNT(DISTINCT (client_id, location_id)) AS stores
           FROM feature_daily
          WHERE obs_date >  $1::date - ($2::int - 1)
            AND obs_date <= $1::date
            AND sku = ANY($3::text[])
          GROUP BY sku
          ORDER BY stores DESC, sku
          LIMIT $4`,
        [AS_OF, WINDOW_DAYS, unsold, TOP - skus.length]
      );
      for (const r of popular) skus.push(r.sku);
    }
  }

  // The subject's sparse facts for those SKUs. Sheet 04 counts n from these.
  const { rows: facts } = skus.length
    ? await analytics.query(
      `SELECT obs_date, sku, units_sold, revenue, unit_cost, on_hand, price,
              baskets_containing, known_at
         FROM feature_daily
        WHERE client_id = $1 AND location_id = $2
          AND obs_date >  $3::date - ($4::int - 1)
          AND obs_date <= $3::date
          AND sku = ANY($5::text[])
        ORDER BY obs_date`,
      [CLIENT_ID, LOCATION_ID, AS_OF, WINDOW_DAYS, skus]
    )
    : { rows: [] };

  // Every store's open-day count in the window. The one definition, applied
  // per store rather than once - a cohort built on calendar days would carry
  // the same understatement this rebuild exists to remove, only estate-wide.
  const { rows: openDays } = await analytics.query(
    `SELECT client_id, location_id, COUNT(*) AS open_days
       FROM feature_store_day
      WHERE obs_date >  $1::date - ($2::int - 1)
        AND obs_date <= $1::date
        AND was_open AND has_data
      GROUP BY client_id, location_id`,
    [AS_OF, WINDOW_DAYS]
  );
  const openBy = new Map(
    openDays.map((r) => [`${r.client_id}:${r.location_id}`, Number(r.open_days)])
  );

  // Candidates: every store with any open day in the window. A store with zero
  // is excluded rather than included with a zero rate - it has not said
  // anything about this SKU, and a zero would be a claim that it sells none.
  const candidates = [...openBy.entries()]
    .filter(([, n]) => n > 0)
    .map(([key]) => {
      const [c, l] = key.split(':').map(Number);
      return [[c, l], stateOf.get(key) || null];
    });

  // Category per SKU, for the ladder's middle rung. Without it the ladder can
  // only go sku -> all_products, skipping the rung most likely to hold a
  // useful answer for a SKU too rare to clear k-anonymity on its own.
  //
  // A SKU'S CATEGORY IS AMBIGUOUS, AND THE RESOLUTION MUST NOT DEPEND ON THE
  // QUESTION. 95,074 SKUs in this estate carry more than one category - the
  // same product, filed differently by different stores. So every category
  // lookup here resolves with `DISTINCT ON (sku) ... ORDER BY last_updated
  // DESC` over a set chosen by SKU, never by category. Filtering by category
  // BEFORE the DISTINCT ON would let the set of categories being asked about
  // change which row wins, and therefore change the answer: exporting store
  // 171 at --top 12 gave GIFT_C a cohort of 0.119 and at --top 20 gave 0.115,
  // same rung, same cohort size. An estimate that moves because you asked
  // about a different number of OTHER SKUs is not an estimate.
  const { rows: catRows } = skus.length
    ? await syncgo.query(
      `SELECT DISTINCT ON (sku) sku, category
         FROM products
        WHERE sku = ANY($1::text[]) AND category IS NOT NULL AND category <> ''
        ORDER BY sku, last_updated DESC NULLS LAST`,
      [skus]
    )
    : { rows: [] };
  const categoryOf = new Map(catRows.map((r) => [r.sku, r.category]));

  // ── ON HAND: POINT-IN-TIME, FROM THE CAPTURE ──────────────────────────────
  //
  // Sheets 10, 11, 12 and 14 all take on_hand, and the whole chain turns on
  // one line:
  //
  //     ideal_qty = order_up_to - on_hand - on_order
  //
  // A missing count read as zero does not produce a cautious small order - it
  // produces the largest order the policy can express, on every SKU at once,
  // with nothing in the output looking wrong.
  //
  // This reads `feature_daily.on_hand`, which `captureOnHand` fills forward
  // with each count stamped at the day the SYNC took it. Reading the capture
  // rather than `products.stock_qty` directly is what makes the export
  // point-in-time:
  //
  //   - `products` holds ONE mutating row per SKU. It can only ever answer
  //     "what is on the shelf now", so an export at a historical --as-of had
  //     to be given no stock at all, and no reorder could be backtested.
  //   - the capture holds one row per (sku, day). `obs_date <= AS_OF` is then
  //     an honest point-in-time read, and a backtest sees exactly the count
  //     the engine would have seen on that day - never a later one.
  //
  // The count is carried as its own block, NOT folded into `facts`, and each
  // row states WHEN it was observed. A count is only as good as its age, and
  // sheet 11 refuses one that is too old; it cannot do that if the age is not
  // in the payload.
  //
  // Negative counts never appear here because capture drops them at the
  // source - 83,322 of 911,022 product rows (9%) report negative stock, and
  // clamping those to zero would convert "this count is wrong" into "this
  // shelf is empty", which is the reading that orders the most.
  const { rows: stockRows } = skus.length
    ? await analytics.query(
      `SELECT DISTINCT ON (sku) sku, on_hand,
              to_char(obs_date, 'YYYY-MM-DD') AS observed_on
         FROM feature_daily
        WHERE client_id = $1 AND location_id = $2
          AND sku = ANY($3::text[])
          AND on_hand IS NOT NULL
          AND obs_date <= $4::date
        ORDER BY sku, obs_date DESC`,
      [CLIENT_ID, LOCATION_ID, skus, AS_OF]
    )
    : { rows: [] };

  // Pack size is a product ATTRIBUTE, not an observation - it does not have a
  // history to be point-in-time about - so it still comes from the catalogue.
  const { rows: packRows } = skus.length
    ? await syncgo.query(
      `SELECT DISTINCT ON (sku) sku, pack_size
         FROM products
        WHERE client_id = $1 AND location_id = $2 AND sku = ANY($3::text[])
        ORDER BY sku, last_updated DESC NULLS LAST`,
      [CLIENT_ID, LOCATION_ID, skus]
    )
    : { rows: [] };
  const packOf = new Map(packRows.map((r) => [r.sku, num(r.pack_size)]));

  const stock = stockRows.map((r) => ({
    sku: r.sku,
    on_hand: Number(r.on_hand),
    pack_size: packOf.get(r.sku) ?? null,
    // The day the SYNC took this count, never the day we exported it. Sheet 11
    // measures staleness against it and refuses a count that has aged out.
    observed_at: r.observed_on,
  }));


  // ── EVERY RUNG MUST ANSWER IN THE SAME UNIT ────────────────────────────────
  //
  // The quantity being estimated is ONE SKU's units per open day. So every
  // rung of the ladder has to be a per-SKU rate:
  //
  //   sku           that SKU's units / open days
  //   category      the category's units / open days / distinct SKUs in it
  //   all_products  the store's units / open days / distinct SKUs
  //
  // The first version of this script supplied the store's TOTAL units per open
  // day for the all_products rung - 182.6/day for a Texas store. Blended
  // against a SKU selling 3.9/day it produced 17.5, a 4.5x overstatement, and
  // it looked entirely plausible in a table. The ladder was working correctly;
  // it was being handed a store-level number and asked a SKU-level question.
  // Dividing by the SKU count is what makes the rungs comparable, and the
  // assertion below is what keeps them that way.
  const { rows: cohortSku } = skus.length
    ? await analytics.query(
      `SELECT client_id, location_id, sku, SUM(units_sold) AS units
         FROM feature_daily
        WHERE obs_date >  $1::date - ($2::int - 1)
          AND obs_date <= $1::date
          AND sku = ANY($3::text[])
        GROUP BY client_id, location_id, sku`,
      [AS_OF, WINDOW_DAYS, skus]
    )
    : { rows: [] };

  // Per-store: total units and DISTINCT SKU count, so all_products can be
  // expressed per SKU rather than per store.
  const { rows: cohortAll } = await analytics.query(
    `SELECT client_id, location_id,
            SUM(units_sold) AS units,
            COUNT(DISTINCT sku) AS sku_count
       FROM feature_daily
      WHERE obs_date >  $1::date - ($2::int - 1)
        AND obs_date <= $1::date
      GROUP BY client_id, location_id`,
    [AS_OF, WINDOW_DAYS]
  );

  // Per-store, per-CATEGORY: units and distinct SKUs in that category.
  //
  // Two queries, not a join. `products` lives in syncgo and `feature_daily` in
  // bottleai_analytics - separate databases, so a single statement naming both
  // cannot run. The first version of this tried exactly that and wrapped it in
  // `.catch(() => ({ rows: [] }))`, which turned a hard error into an empty
  // category rung: every SKU too rare for its own rung silently fell through
  // to all_products, and the output looked fine. A swallowed error is worse
  // than a crash, so there is no catch here now.
  const categories = [...new Set(categoryOf.values())];
  const { rows: catMembers } = categories.length
    ? await syncgo.query(
      // Resolve EVERY sku's category first, then filter. The inner query is
      // ordered by sku only, so which row wins is a property of the sku - not
      // of the category list this particular export happens to want.
      `SELECT sku, category FROM (
         SELECT DISTINCT ON (sku) sku, category
           FROM products
          WHERE sku IS NOT NULL AND sku <> ''
            AND category IS NOT NULL AND category <> ''
          ORDER BY sku, last_updated DESC NULLS LAST
       ) resolved
       WHERE category = ANY($1::text[])`,
      [categories]
    )
    : { rows: [] };
  const categoryBySku = new Map(catMembers.map((r) => [r.sku, r.category]));
  const memberSkus = [...categoryBySku.keys()];

  const { rows: catFacts } = memberSkus.length
    ? await analytics.query(
      `SELECT client_id, location_id, sku, SUM(units_sold) AS units
         FROM feature_daily
        WHERE obs_date >  $1::date - ($2::int - 1)
          AND obs_date <= $1::date
          AND sku = ANY($3::text[])
        GROUP BY client_id, location_id, sku`,
      [AS_OF, WINDOW_DAYS, memberSkus]
    )
    : { rows: [] };

  // Roll SKU rows up to (store, category), carrying the distinct-SKU count so
  // the rung stays a PER-SKU rate like the other two.
  const catAgg = new Map();
  for (const r of catFacts) {
    const category = categoryBySku.get(r.sku);
    if (!category) continue;
    const key = `${r.client_id}:${r.location_id}:${category}`;
    const acc = catAgg.get(key)
      || { client_id: r.client_id, location_id: r.location_id, category,
           units: 0, sku_count: 0 };
    acc.units += Number(r.units);
    acc.sku_count += 1;
    catAgg.set(key, acc);
  }
  const cohortCat = [...catAgg.values()];

  const observations = {};
  const push = (unitKey, clientId, locationId, units, skuCount = 1) => {
    const open = openBy.get(`${clientId}:${locationId}`);
    if (!open || !skuCount) return;  // no open days -> no rate, not a zero
    (observations[unitKey] ||= []).push({
      store_key: [clientId, locationId],
      // units per OPEN day, PER SKU. The one definition, at the one grain.
      value: Number(units) / open / Number(skuCount),
      weight: 1,                     // one store, one vote
    });
  };
  for (const r of cohortSku) push(r.sku, r.client_id, r.location_id, r.units);
  for (const r of cohortCat) {
    push(r.category, r.client_id, r.location_id, r.units, r.sku_count);
  }
  for (const r of cohortAll) {
    push('*', r.client_id, r.location_id, r.units, r.sku_count);
  }

  const subjectOpen = openBy.get(`${CLIENT_ID}:${LOCATION_ID}`) || 0;
  // Only SOLD SKUs have own units. A carried-but-never-sold SKU is absent
  // here, so `own_rate` below comes out null - not 0. It has made no
  // measurement, and 0 would be a claim that it sells none.
  const ownUnits = new Map(soldSkus.map((r) => [r.sku, Number(r.units)]));

  const payload = JSON.stringify({
    as_of: AS_OF,
    window_days: WINDOW_DAYS,
    store_key: [CLIENT_ID, LOCATION_ID],
    subject_state: subjectState,
    subject_open_days: subjectOpen,
    calendar: calendar.map((r) => ({
      obs_date: d(r.obs_date),
      was_open: r.was_open,
      has_data: r.has_data,
      open_source: r.open_source,
    })),
    facts: facts.map((r) => ({
      obs_date: d(r.obs_date), sku: r.sku,
      units_sold: num(r.units_sold), revenue: num(r.revenue),
      unit_cost: num(r.unit_cost), on_hand: num(r.on_hand),
      price: num(r.price), baskets_containing: num(r.baskets_containing),
      known_at: r.known_at ? new Date(r.known_at).toISOString() : null,
    })),
    skus: skus.map((sku) => ({
      sku,
      category: categoryOf.get(sku) || null,
      // Units per OPEN day. NULL - never 0 - when the store has no open days
      // or has never sold this SKU: it has made no measurement, and a 0 would
      // be a confident claim that it sells none.
      own_rate: (subjectOpen && ownUnits.has(sku))
        ? ownUnits.get(sku) / subjectOpen
        : null,
    })),
    // Point-in-time shelf counts, deliberately outside `facts` - each row
    // carries the day its sync took it, so a read at any --as-of sees only
    // counts that existed by then. `stock_basis` is exported so a reader can
    // tell "this store has no counts captured" from "we did not ask", which
    // are different facts and look identical as an empty list.
    stock,
    stock_basis: 'feature_daily_capture',
    stock_observed_skus: stockRows.length,
    candidates,
    observations,
  }, null, 2);

  await analytics.query('COMMIT').catch(() => {});
  await syncgo.query('COMMIT').catch(() => {});
  analytics.release();
  syncgo.release();

  if (OUT) {
    nodeFs.writeFileSync(OUT, payload);
    console.log(`wrote ${OUT}  (${calendar.length} calendar days, `
      + `${facts.length} facts, ${skus.length} skus, `
      + `${candidates.length} candidate stores, `
      + `${stock.length} stock counts)`);
    if (!stock.length) {
      console.log('  no shelf counts as of ' + AS_OF + '. Reorder sizing will '
        + 'refuse for every SKU;');
      console.log('  run: node scripts/build-feature-store.js '
        + `${CLIENT_ID} ${LOCATION_ID} --incremental`);
    }
  } else {
    process.stdout.write(payload);
  }
  process.exit(0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
