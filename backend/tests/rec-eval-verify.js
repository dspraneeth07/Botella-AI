/**
 * Recommendation-evaluation verification - exercises recommendationEvalService
 * end-to-end against the real analytics DB (sentinel tenant) with a mocked
 * syncgo warehouse, covering every scoring/detection path:
 *
 *   1  reorder that sold + restocked (PO evidence)      → winner, acted
 *   2  markdown with a real price cut                   → acted via price detector
 *   3  promote (unobservable action) with strong lift   → winner, action NULL
 *   4  flat outcome + a single (possibly mistaken) 👍   → NEUTRAL, vote can't flip it
 *   5  collapsed sales                                  → underperformer
 *   6  no sales, no snapshot                            → insufficient_data
 *   7  zero-baseline SKU that sold                      → upside path (0.8)
 *   8  stock_new whose UPC later arrived (registry)     → acted, evaluated via arrival sku
 *   9  windows beyond the data frontier                 → pending, never scored early
 *   10 reorder provably NOT acted                       → action false lowers score
 *   11 idempotent re-run                                → 0 new evaluations
 *   12 effectiveness report shape + acted-as-recommended counts
 *   13 per-rec evaluation read + history evaluated_score enrichment
 *   14 captureForRun snapshots from warehouse state
 *   15 outcome quantities (migration 035): recommended_qty from the printed
 *      order, not the hint's high end; bought from the PO feed, else the
 *      stock inflow, else NULL (never 0 for "no feed"); on-hand at issue and
 *      at window end with the observation date; units unsold
 *   16 the stockout grade: sold through before a PO → true; delivery seen in
 *      the nightly counts with cover still on the shelf → false; nothing
 *      observed yet on an open window → NULL with the reason; recognised by
 *      engine_family, or by cover below the horizon for rows without one
 *   (039) an owner's claim is a CLAIM: it no longer fills action_taken, so
 *      it moves neither score nor verdict; the card reads 'claimed' until the
 *      data confirms it, and a detected price cut stays 'confirmed' whatever
 *      the owner says. acted_as_recommended counts confirmed only. The full
 *      state machine is exercised in tests/fulfilment-verify.js.
 *   17 an UPLOADED INVOICE as the only action evidence: a reorder with no
 *      purchases-feed row and no snapshot, whose sku a person matched on a
 *      parsed invoice dated inside the window → acted, detector 'invoice',
 *      and the bought quantity names the invoice as its source (036); an
 *      invoice dated after the window never credits it
 *
 * PREREQ: analytics migrations 001+002 applied (035 for scenarios 15-16, 036
 *         for the invoice source in 17).
 * Run:  ANALYTICS_PG_HOST=localhost node tests/rec-eval-verify.js
 */
require('dotenv').config();

const { getAnalyticsPool } = require('../database/analytics-connection');
const evalSvc = require('../services/recommendationEvalService');
const recSvc = require('../services/recommendationService');

const CID = 999901;
const LID = 990001;

const dayMs = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => iso(Date.now() - n * dayMs);
const TODAY = daysAgo(0);        // sales frontier
const REC_DATE = daysAgo(10);    // every rec is 10 days old → 7d window closed, 30d pending

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
}
const near = (a, b, eps = 0.02) => a != null && Math.abs(a - b) <= eps;

// ── Mock syncgo warehouse ────────────────────────────────────────────────────
// Daily sales rows: [sku, isoDay, units]. Baseline period is the 28 days
// BEFORE the rec; the window is the 7 days after it.
const salesRows = [];
function addDaily(sku, fromDaysAgo, toDaysAgo, unitsPerDay) {
  for (let n = fromDaysAgo; n > toDaysAgo; n--) salesRows.push({ sku, day: daysAgo(n), units: unitsPerDay });
}
// 1 RS1: baseline 1/day, window 2/day (lift ~2x). Window sales start the day
// AFTER the rec - the rec day itself belongs to the baseline (start-exclusive).
addDaily('RS1', 38, 10, 1); addDaily('RS1', 9, 2, 2);
// 2 MD1: baseline 0.5/day (1 every 2 days → use 14 units over 28d), window 5 units
for (let n = 38; n > 10; n -= 2) salesRows.push({ sku: 'MD1', day: daysAgo(n), units: 1 });
addDaily('MD1', 8, 3, 1);
// 3 PR1: baseline 1/day, window 3/day (lift 3.0)
addDaily('PR1', 38, 10, 1); addDaily('PR1', 10, 3, 3);
// 4 FL1: flat 1/day throughout, covering the whole 7d window (lift 1.0)
addDaily('FL1', 38, 2, 1);
// 5 UP1: baseline 1/day, window 1 unit total (lift 0.14)
addDaily('UP1', 38, 10, 1); salesRows.push({ sku: 'UP1', day: daysAgo(9), units: 1 });
// 6 ND1: no sales at all
// 7 ZB1: no baseline, 5 units in window
salesRows.push({ sku: 'ZB1', day: daysAgo(8), units: 5 });
// 8 NEWSKU (stock_new arrival): 6 units after arriving
salesRows.push({ sku: 'NEWSKU', day: daysAgo(6), units: 6 });
// 10 RN1: flat 1/day throughout
addDaily('RN1', 38, 3, 1);
// 15 PO2 (PO after the window must NOT credit it): 1/day right up to the frontier
addDaily('PO2', 38, 0, 1);
// 16 MD2 (pre-existing sale price): 1/day
addDaily('MD2', 38, 0, 1);
// 17 LS1 (late snapshot): 1/day
addDaily('LS1', 38, 0, 1);
// 18 SO1 (stockout, 6 on hand): 2/day for three days after the card and then
// nothing - the shelf is empty on day 3, the PO lands on day 5. No baseline,
// so the outcome scores on the zero-baseline path. (The rec day itself is
// start-exclusive, so the three days are 9, 8 and 7 days ago.)
addDaily('SO1', 9, 6, 2);
// 19 SO2 (stockout, 10 on hand): 1/day right up to the frontier - 9 units in
// the covered span, so the cover never runs out before the delivery the
// nightly counts show landing on day 6.
addDaily('SO2', 9, 0, 1);
// 20 SO3 (stockout by the cover-below-horizon fallback): no sales at all.

const CURRENT_PRODUCTS = {
  RS1: { stock_qty: 20, price: 15, sale_price: null, cost: 10 },
  MD1: { stock_qty: 30, price: 16.99, sale_price: null },  // was 20.00 at snapshot → cut
  PR1: { stock_qty: 12, price: 12, sale_price: null },
  FL1: { stock_qty: 10, price: 10, sale_price: null },
  UP1: { stock_qty: 40, price: 25, sale_price: null, cost: 18 },
  ZB1: { stock_qty: 8, price: 11, sale_price: null },
  RN1: { stock_qty: 4, price: 10, sale_price: null },      // 10 - sold, no inflow
  PO2: { stock_qty: 0, price: 10, sale_price: null },      // drained; PO landed after window
  MD2: { stock_qty: 25, price: 20, sale_price: 15.99 },    // sale price UNCHANGED since snapshot
  LS1: { stock_qty: 1, price: 10, sale_price: null },      // drained; snapshot was late
  CAP1: { stock_qty: 9, price: 19.5, sale_price: null },   // captureForRun check
  SO1: { stock_qty: 12, price: 14, sale_price: null },     // 6 − 6 sold + 12 delivered
  SO2: { stock_qty: 13, price: 14, sale_price: null },     // 10 − 9 sold + 12 delivered
  SO3: { stock_qty: 8, price: 14, sale_price: null },      // untouched: no sales, no inflow
};
// Purchase-order daily rows: RS1's PO is INSIDE its 7d window; PO2's PO is
// AFTER the window and must not count for it. SO1's PO is the dated delivery
// its stockout grade is measured against; SO2 has none, so its delivery has
// to be seen in the nightly shelf counts.
const PURCHASE_ROWS = [
  { sku: 'RS1', day: daysAgo(7), units: 12 },
  { sku: 'PO2', day: daysAgo(1), units: 20 },
  { sku: 'SO1', day: daysAgo(5), units: 12 },
];
// Nightly shelf counts (feature_daily.on_hand, captured since checklist 7).
// SPARSE on purpose - a row only on the days the product row synced - so the
// outcome row has to say which day its window-end count was taken on.
//   SO1: 4 on day 2 (two sold), 12 on day 8 (after the PO).
//   SO2: 7 on day 3 (three sold, no rise), 16 on day 6: a rise of 9 on the
//        shelf with 3 sold in between = 12 units arrived, above the threshold.
const ON_HAND_ROWS = [
  { sku: 'SO1', day: daysAgo(8), on_hand: 4 },
  { sku: 'SO1', day: daysAgo(2), on_hand: 12 },
  { sku: 'SO2', day: daysAgo(7), on_hand: 7 },
  { sku: 'SO2', day: daysAgo(4), on_hand: 16 },
];

function route(text, params) {
  if (/information_schema\.columns/.test(text) && /purchases/.test(text)) {
    return [{ n: 3 }];
  }
  if (/MAX\(sale_date\)/.test(text)) return [{ latest: TODAY, d: TODAY }];
  // THE MATCHERS BELOW ROUTE ON THE SELECT LIST, NOT THE GROUP BY.
  //
  // They used to read `/GROUP BY sku, sale_date::date/`, which stopped
  // matching when the service introduced UPC->SKU canonicalisation: every
  // sales query now groups by `COALESCE(k.sku, si.sku)` rather than a bare
  // column. Nothing failed loudly - the mock simply returned [] for every
  // sales query, so the evaluator measured NO sales and reported
  // `insufficient_data`, `lift null` and `revenue null` everywhere. Fourteen
  // checks were asserting against an empty warehouse.
  //
  // The SELECT list is the stable thing: what a query ASKS FOR changes far
  // less often than how it canonicalises its join keys.
  if (/FROM sale_items/.test(text) && /AS sku,/.test(text) && /AS day,/.test(text)) {
    // Bulk per-sku-per-day sales, the evaluator's main measurement input.
    const skus = params[2];
    const since = params[3];
    return salesRows
      .filter((r) => skus.includes(r.sku) && r.day >= String(since).slice(0, 10))
      .map((r) => ({ sku: r.sku, day: r.day, units: r.units }));
  }
  if (/FROM sale_items/.test(text) && /\bsku\)? = \$3/.test(text)) {
    // On-demand single-sku fetch (stock_new arrival).
    //
    // The predicate is `COALESCE(k.sku, si.sku) = $3` in the real query, not
    // `sku = $3`, so a matcher anchored on the bare column name never fired.
    // The query then fell through to the `FROM products` branch below - which
    // it reaches only because SKU_KEYMAP_CTE selects from `products` - and
    // that branch called `.filter()` on what is a single SKU string here,
    // crashing the whole verification at line 128.
    return salesRows
      .filter((r) => r.sku === params[2] && r.day > String(params[3]).slice(0, 10))
      .map((r) => ({ day: r.day, units: r.units }));
  }
  if (/FROM sale_items/.test(text) && /AS sku,/.test(text)) {
    // Trailing-rate query in captureForRecs: per-sku totals, no day column -
    // so it is this branch only once the day-carrying one above has not
    // matched. Order matters here and always did.
    const skus = params[2];
    const totals = {};
    for (const r of salesRows) {
      if (skus.includes(r.sku) && r.day > daysAgo(28)) totals[r.sku] = (totals[r.sku] || 0) + r.units;
    }
    return Object.entries(totals).map(([sku, units]) => ({ sku, units }));
  }
  if (/FROM products/.test(text)) {
    const skus = params[2];
    // A mock that guesses wrong should say so, not crash sixty lines later
    // with `skus.filter is not a function`. Several sale_items queries embed
    // SKU_KEYMAP_CTE, which selects `FROM products`, so this branch is
    // reachable by queries that are not about products at all.
    if (!Array.isArray(skus)) {
      throw new Error('rec-eval mock: a query matched the FROM products branch '
        + `but bound $3 = ${JSON.stringify(skus)} rather than a SKU array. `
        + `Add a more specific matcher above it. Query: ${text.slice(0, 120)}`);
    }
    return skus.filter((s) => CURRENT_PRODUCTS[s]).map((s) => ({ sku: s, ...CURRENT_PRODUCTS[s] }));
  }
  if (/FROM purchases/.test(text)) {
    const skus = params[2];
    return PURCHASE_ROWS
      .filter((r) => skus.includes(r.sku) && r.day >= String(params[3]).slice(0, 10))
      .map((r) => ({ sku: r.sku, day: r.day, units: r.units }));
  }
  return [];
}
const mockClient = {
  query: async (text, params) => ({ rows: /BEGIN|COMMIT|ROLLBACK|set_config/.test(text) ? [] : route(text, params) }),
  release: () => {},
};
const mockSyncgo = { query: async (t, p) => ({ rows: route(t, p) }), connect: async () => mockClient };

// ── Fixture setup in the analytics DB ────────────────────────────────────────
async function setup(pool) {
  // generated_at must be a UTC-midnight instant: a bare ::date cast becomes
  // local midnight on the DB server, which shifts toDateOnly a day under IST.
  // engine_version (migration 032) is what the outcome row's model_version
  // is read from; the fixture sets one so the read can be asserted.
  const run = await pool.query(
    `INSERT INTO recommendation_runs
       (client_id, location_id, generated_at, data_as_of, candidate_count, recommendation_count, dropped_invalid, signal_snapshot, engine_version)
     VALUES ($1, $2, ($3 || 'T00:00:00Z')::timestamptz, $3::date, 100, 9, 0, '{}'::jsonb, '0.1.0-test') RETURNING id`,
    [CID, LID, REC_DATE]
  );
  const runId = run.rows[0].id;

  // `orderQty` is recommendations.suggested_order_qty (migration 007) and
  // `engine` the decision figures (022) plus the family (035) - the shape the
  // deterministic engine's stockout card arrives in.
  const mk = async (rank, category, action, skus, {
    vote = null, upc = null, qty = null, status = null, orderQty = null, engine = null,
  } = {}) => {
    const r = await pool.query(
      `INSERT INTO recommendations
         (run_id, client_id, location_id, rank, category, action_type, primary_skus,
          rationale, signals_cited, confidence, valid_through, vote, reference_upc,
          quantity_hint, status, created_at, suggested_order_qty,
          engine_daily_rate, engine_days_cover, engine_on_hand, engine_family)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}',0.8,($9::date + 14),$10,$11,$12,$13,$9::date,
               $14,$15,$16,$17,$18)
       RETURNING id`,
      [runId, CID, LID, rank, category, action, skus, `${category} test rec`, REC_DATE, vote, upc, qty, status,
        orderQty,
        engine ? engine.daily_rate : null, engine ? engine.days_cover : null,
        engine ? engine.on_hand : null, engine ? engine.family ?? null : null]
    );
    return r.rows[0].id;
  };

  const ids = {};
  ids.RS1 = await mk(1, 'inventory_understock', 'reorder', ['RS1'], { qty: 'order about 3 to 4 cases' });
  ids.MD1 = await mk(2, 'inventory_overstock', 'markdown', ['MD1']);
  ids.PR1 = await mk(3, 'weather', 'promote', ['PR1']);
  ids.FL1 = await mk(4, 'calendar_sports', 'endcap', ['FL1'], { vote: 1 }); // mistaken 👍
  ids.UP1 = await mk(5, 'news', 'promote', ['UP1']);
  ids.ND1 = await mk(6, 'bundle', 'bundle', ['ND1']);
  ids.ZB1 = await mk(7, 'new_arrival', 'promote', ['ZB1']);
  ids.SNW = await mk(8, 'new_arrival', 'stock_new', [], { upc: '0999' });
  ids.RN1 = await mk(9, 'inventory_understock', 'reorder', ['RN1']);
  ids.PO2 = await mk(10, 'inventory_understock', 'reorder', ['PO2']);
  ids.MD2 = await mk(11, 'inventory_overstock', 'markdown', ['MD2']);
  ids.LS1 = await mk(12, 'inventory_understock', 'reorder', ['LS1']);
  // Holdout: evaluated like the rest, hidden from every owner-facing surface.
  ids.HOLD = await mk(13, 'weather', 'promote', ['FL1'], { status: 'holdout' });
  // The engine's stockout card, as it is actually written: the hint quotes
  // the ORDER (8) and then the predictive band (5-30), so the hint's parsed
  // high end is 30 and the printed order is 8. The outcome row must carry 8.
  const STOCKOUT_HINT = 'about 8 units to cover the next 14 days. Over the next 30 '
    + 'selling days total sales should land between 5 and 30 units 90% of the time';
  ids.SO1 = await mk(15, 'inventory_understock', 'reorder', ['SO1'], {
    qty: STOCKOUT_HINT, orderQty: 8,
    engine: { family: 'stockout', daily_rate: 2, days_cover: 3, on_hand: 6 },
  });
  ids.SO2 = await mk(16, 'inventory_understock', 'reorder', ['SO2'], {
    qty: STOCKOUT_HINT, orderQty: 8,
    engine: { family: 'stockout', daily_rate: 2, days_cover: 5, on_hand: 10 },
  });
  // Written before engine_family existed: NO family, but a reorder with cover
  // below the 14-day horizon - the evaluator's stated fallback.
  ids.SO3 = await mk(17, 'inventory_understock', 'reorder', ['SO3'], {
    qty: 'about 20 units to cover the next 14 days', orderQty: 20,
    engine: { family: null, daily_rate: 2, days_cover: 4, on_hand: 8 },
  });

  // Snapshots for the detectors (capturedAt = rec time unless stated).
  const snap = (recId, sku, onHand, price, weeklyRate, { salePrice = null, capturedAt = REC_DATE } = {}) => pool.query(
    `INSERT INTO recommendation_sku_state
       (rec_id, client_id, location_id, sku, on_hand, price, sale_price, weekly_rate, captured_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date)`,
    [recId, CID, LID, sku, onHand, price, salePrice, weeklyRate, capturedAt]
  );
  await snap(ids.RS1, 'RS1', 10, 15, 7);
  await snap(ids.MD1, 'MD1', 34, 20.0, 3.5);
  await snap(ids.RN1, 'RN1', 10, 10, 7);
  await snap(ids.PO2, 'PO2', 10, 10, 7);
  await snap(ids.MD2, 'MD2', 30, 20.0, 3.5, { salePrice: 15.99 }); // already on sale at rec time
  await snap(ids.LS1, 'LS1', 10, 10, 7, { capturedAt: daysAgo(5) }); // captured LATE
  await snap(ids.SO1, 'SO1', 6, 14, 14);
  await snap(ids.SO2, 'SO2', 10, 14, 14);
  await snap(ids.SO3, 'SO3', 8, 14, 14);

  // stock_new arrival in the first-seen registry, 2 days after the rec.
  await pool.query(
    `INSERT INTO product_first_seen (client_id, location_id, sku, upc, is_baseline, first_seen_at)
     VALUES ($1,$2,'NEWSKU','0999',false,$3::date)`,
    [CID, LID, daysAgo(8)]
  );

  // Nightly shelf counts. Sentinel rows only; the ON CONFLICT lets a re-run
  // after a failed cleanup reseed rather than crash.
  for (const row of ON_HAND_ROWS) {
    await pool.query(
      `INSERT INTO feature_daily (client_id, location_id, sku, obs_date, on_hand)
       VALUES ($1,$2,$3,$4::date,$5)
       ON CONFLICT (client_id, location_id, sku, obs_date) DO UPDATE SET on_hand = EXCLUDED.on_hand`,
      [CID, LID, row.sku, row.day, row.on_hand]
    );
  }

  return { runId, ids };
}

async function cleanup(pool) {
  await pool.query('DELETE FROM recommendation_runs WHERE client_id=$1 AND location_id=$2', [CID, LID]);
  // Scenario 17's uploaded invoices (items cascade from the order).
  await pool.query('DELETE FROM purchase_orders WHERE client_id=$1 AND location_id=$2', [CID, LID])
    .catch((e) => console.warn('purchase_orders cleanup skipped:', e.message));
  await pool.query('DELETE FROM product_first_seen WHERE client_id=$1 AND location_id=$2', [CID, LID]);
  await pool.query('DELETE FROM recommendation_digests WHERE client_id=$1 AND location_id=$2', [CID, LID])
    .catch(() => {});
  // Both are tables the production role deliberately cannot DELETE from
  // (migration 031 / the partition grants in 018); in development the app
  // role owns them. A refusal here leaves sentinel rows behind, which the
  // seeding above tolerates, so it is reported rather than fatal.
  await pool.query('DELETE FROM feature_daily WHERE client_id=$1 AND location_id=$2', [CID, LID])
    .catch((e) => console.warn('feature_daily cleanup skipped:', e.message));
  await pool.query('DELETE FROM recommendation_outcomes WHERE client_id=$1 AND location_id=$2', [CID, LID])
    .catch((e) => console.warn('recommendation_outcomes cleanup skipped:', e.message));
}

(async () => {
  const pool = getAnalyticsPool();
  try {
    await cleanup(pool);
    const { runId, ids } = await setup(pool);

    // ── Pure-math sanity before touching the DB paths ──
    check('single 👍 is Laplace-smoothed to 2/3', near(evalSvc.voteComponentOf(1, 0).value, 0.667));
    check('single-vote weight is ~8%', near(evalSvc.voteComponentOf(1, 0).weight, 0.0833, 0.001));
    check('neutral outcome + mistaken 👍 stays out of winner range',
      evalSvc.blendScore({ outcomeScore: 0.5, actionTaken: null, voteUps: 1, voteDowns: 0 }).finalScore < 0.6);
    check('votes alone never mint a winner',
      evalSvc.verdictOf({ finalScore: 0.9, outcomeMeasurable: false, actionKnown: false }) === 'insufficient_data');
    check('zero-baseline floor scales with window (7d→3, 90d→13)',
      evalSvc.zeroBaselineMinUnits(7) === 3 && evalSvc.zeroBaselineMinUnits(90) === 13);

    check('exactly-neutral not-acted blend (0.400) is neutral, not underperformer',
      evalSvc.verdictOf({ finalScore: 0.4, outcomeMeasurable: true, actionKnown: true }) === 'neutral');
    check('just below the boundary is still an underperformer',
      evalSvc.verdictOf({ finalScore: 0.399, outcomeMeasurable: true, actionKnown: true }) === 'underperformer');

    check('quantity hint parses to a range',
      JSON.stringify(evalSvc.parseQuantityHint('order about 3 to 4 cases')).includes('"low":3'));
    check('quantity hint handles or-ranges and hyphenated packs',
      JSON.stringify(evalSvc.parseQuantityHint('2 or 3 cases')) === JSON.stringify({ low: 2, high: 3, text: '2 or 3 cases' })
      && evalSvc.parseQuantityHint('grab a 12-pack for the cooler').low === 12);
    check('date-only prose parses to nothing',
      evalSvc.parseQuantityHint('restock before the July 3-5 weekend') === null);

    // ── Evaluate the tenant (12 scenarios + 1 holdout + 3 stockout cards;
    // 7d windows finalize, 30/60/90 get PARTIAL evaluations over the 10
    // covered days) ──
    const res = await evalSvc.evaluateTenant(pool, CID, LID, { syncgoPool: mockSyncgo });
    check('evaluated all 64 due (rec,window) pairs (16 final + 48 partial)',
      res.evaluated === 64, `evaluated ${res.evaluated}`);

    const evals = {};
    const all = await pool.query(
      `SELECT e.*, r.action_type FROM recommendation_evaluations e
        JOIN recommendations r ON r.id = e.rec_id
       WHERE e.client_id=$1 AND e.location_id=$2`, [CID, LID]
    );
    for (const row of all.rows) if (row.window_days === 7) evals[row.rec_id] = row;
    const w30 = all.rows.filter((r) => r.window_days === 30);
    check('7d rows are final (no partial marker)',
      all.rows.filter((r) => r.window_days === 7)
        .every((r) => !JSON.stringify(r.action_evidence).includes('"partial"')));
    check('30d rows are partial over the covered 10 days',
      w30.length === 16 && w30.every((r) =>
        JSON.stringify(r.action_evidence).includes('"covered_days":10')),
      JSON.stringify(w30[0]?.action_evidence));

    const e1 = evals[ids.RS1];
    check('reorder: ~2x lift measured', near(Number(e1.lift), 2.07, 0.05), `lift ${e1.lift}`);
    check('reorder: acted via purchase orders', e1.action_taken === true
      && JSON.stringify(e1.action_evidence).includes('purchase_orders'));
    check('reorder: winner', e1.verdict === 'winner', e1.verdict);

    const e2 = evals[ids.MD1];
    check('markdown: price cut detected', e2.action_taken === true
      && JSON.stringify(e2.action_evidence).includes('"price"'), JSON.stringify(e2.action_evidence));
    check('markdown: winner', e2.verdict === 'winner', `score ${e2.final_score}`);

    const e3 = evals[ids.PR1];
    check('promote: action unobservable stays NULL', e3.action_taken === null);
    check('promote: strong lift alone makes a winner', e3.verdict === 'winner', `lift ${e3.lift}`);

    const e4 = evals[ids.FL1];
    check('flat + mistaken 👍: score ~0.52, NOT a winner', e4.verdict === 'neutral' && near(Number(e4.final_score), 0.52, 0.03),
      `verdict ${e4.verdict}, score ${e4.final_score}`);

    const e5 = evals[ids.UP1];
    check('collapsed sales: underperformer', e5.verdict === 'underperformer', `lift ${e5.lift}`);

    const e6 = evals[ids.ND1];
    check('no sales, no snapshot: insufficient_data', e6.verdict === 'insufficient_data');

    const e7 = evals[ids.ZB1];
    check('zero-baseline seller: upside score 0.8', near(Number(e7.outcome_score), 0.8) && e7.verdict === 'winner');

    const e8 = evals[ids.SNW];
    check('stock_new: arrival detected from registry', e8.action_taken === true
      && JSON.stringify(e8.action_evidence).includes('catalog_registry'));
    check('stock_new: outcome measured via arrived sku', e8.units_sold === 6 && e8.verdict === 'winner',
      `units ${e8.units_sold}, verdict ${e8.verdict}`);

    const e10 = evals[ids.RN1];
    check('reorder not acted: stock_delta says false', e10.action_taken === false,
      JSON.stringify(e10.action_evidence));
    check('not-acted flat reorder scores ≤0.40', Number(e10.final_score) <= 0.4, `score ${e10.final_score}`);

    // ── Review-finding regressions ──
    const e11 = evals[ids.PO2];
    check('PO after the window never credits it (window-bounded evidence)',
      e11.action_taken === false
      && JSON.stringify(e11.action_evidence).includes('"purchased_units_in_window":0'),
      JSON.stringify(e11.action_evidence));
    const e12 = evals[ids.MD2];
    check('pre-existing sale price is NOT counted as acting', e12.action_taken === false,
      JSON.stringify(e12.action_evidence));
    const e13 = evals[ids.LS1];
    check('late snapshot downgrades "not acted" to unknown', e13.action_taken === null,
      JSON.stringify(e13.action_evidence));

    // ── Dollar attribution + quantity evidence + holdout ──
    check('winner reorder attributes positive revenue (and margin from cost)',
      Number(e1.revenue_impact) > 0 && Number(e1.margin_impact) > 0
      && Number(e1.margin_impact) < Number(e1.revenue_impact),
      `rev ${e1.revenue_impact}, margin ${e1.margin_impact}`);
    check('collapsed seller attributes negative revenue',
      Number(e5.revenue_impact) < 0, `rev ${e5.revenue_impact}`);
    check('quantity hint recorded as evidence, not scored',
      JSON.stringify(e1.action_evidence).includes('"quantity_hint_range"'));
    check('holdout rec was evaluated too', evals[ids.HOLD] != null
      && evals[ids.HOLD].verdict !== undefined);

    // ── Outcome quantities (migration 035) ──────────────────────────────────
    // Read from recommendation_outcomes, the table the gate and calibration
    // consume - not from the evaluation's evidence, which is a mirror.
    const outRes = await pool.query(
      `SELECT recommendation_id, (window_end - window_start) AS span,
              recommended_qty, actual_purchased_qty, purchased_qty_source,
              actual_units_sold, units_unsold, on_hand_at_issue, on_hand_at_window_end,
              to_char(on_hand_observed_on, 'YYYY-MM-DD') AS on_hand_observed_on,
              sold_through, days_to_sell_through, delivery_evidence, sold_through_reason,
              to_char(delivery_observed_on, 'YYYY-MM-DD') AS delivery_observed_on,
              model_version
         FROM recommendation_outcomes WHERE client_id=$1 AND location_id=$2`,
      [CID, LID]
    );
    const out = (id, span) => outRes.rows.find(
      (o) => Number(o.recommendation_id) === Number(id) && Number(o.span) === span
    ) || {};
    const num = (v) => (v == null ? null : Number(v));
    check('outcome rows exist for every (rec, window) pair, keyed on the nominal end',
      outRes.rows.length === 64 && outRes.rows.every((o) => [7, 30, 60, 90].includes(Number(o.span))),
      `${outRes.rows.length} rows`);

    // recommended_qty: the printed order, not the hint's parsed high end.
    const hint = evalSvc.parseQuantityHint(
      'about 8 units to cover the next 14 days. Over the next 30 selling days total '
      + 'sales should land between 5 and 30 units 90% of the time');
    check('the stockout hint parses to a high end of 30 (the predictive band), so it is the wrong source',
      hint && hint.high === 30, JSON.stringify(hint));
    check('recommended_qty is suggested_order_qty (8), not the hint high (30)',
      num(out(ids.SO1, 30).recommended_qty) === 8
      && evals[ids.SO1].action_evidence.quantities.recommended_qty_source === 'suggested_order_qty',
      JSON.stringify(evals[ids.SO1].action_evidence.quantities));
    check('the hint range is still on the evidence, as prose evidence',
      evals[ids.SO1].action_evidence.quantity_hint_range?.high === 30);
    check('a buy card with no column value falls back to the hint and says so',
      num(out(ids.RS1, 7).recommended_qty) === 4
      && evals[ids.RS1].action_evidence.quantities.recommended_qty_source === 'quantity_hint_high',
      JSON.stringify(evals[ids.RS1].action_evidence.quantities));
    check('a markdown asks for no quantity: recommended_qty and units_unsold stay NULL',
      out(ids.MD1, 7).recommended_qty === null && out(ids.MD1, 7).units_unsold === null);

    // actual_purchased_qty: feed, else inflow, else NULL - and 0 only when measured.
    check('bought comes from the purchases feed when it has rows (12, purchases_feed)',
      num(out(ids.SO1, 30).actual_purchased_qty) === 12
      && out(ids.SO1, 30).purchased_qty_source === 'purchases_feed',
      JSON.stringify(out(ids.SO1, 30)));
    check('bought falls back to the attributable stock inflow (12, stock_inflow)',
      num(out(ids.SO2, 30).actual_purchased_qty) === 12
      && out(ids.SO2, 30).purchased_qty_source === 'stock_inflow',
      JSON.stringify(out(ids.SO2, 30)));
    check('a fresh snapshot that saw nothing arrive records a MEASURED 0 with its source',
      num(out(ids.RN1, 7).actual_purchased_qty) === 0
      && out(ids.RN1, 7).purchased_qty_source === 'stock_inflow',
      JSON.stringify(out(ids.RN1, 7)));
    check('no feed rows and no snapshot is NULL with no source - never a 0',
      out(ids.ND1, 7).actual_purchased_qty === null && out(ids.ND1, 7).purchased_qty_source === null
      && /no purchase-order rows/.test(evals[ids.ND1].action_evidence.quantities.purchased_qty_note || ''),
      JSON.stringify(evals[ids.ND1].action_evidence.quantities));
    check('a late snapshot cannot say how much was bought: NULL, with the reason',
      out(ids.LS1, 7).actual_purchased_qty === null
      && /captured late/.test(evals[ids.LS1].action_evidence.quantities.purchased_qty_note || ''),
      JSON.stringify(evals[ids.LS1].action_evidence.quantities));

    // On hand, at issue and at window end - the latter dated, because sparse.
    check('on_hand_at_issue is the engine\'s own count (6)',
      num(out(ids.SO1, 30).on_hand_at_issue) === 6
      && evals[ids.SO1].action_evidence.quantities.on_hand_at_issue_source === 'engine_on_hand');
    check('on_hand_at_issue falls back to the rec-time snapshot (10) when the engine recorded none',
      num(out(ids.RN1, 7).on_hand_at_issue) === 10
      && evals[ids.RN1].action_evidence.quantities.on_hand_at_issue_source === 'rec_time_snapshot');
    check('on_hand_at_window_end is the latest nightly count inside the 30d window, with its date',
      num(out(ids.SO1, 30).on_hand_at_window_end) === 12
      && out(ids.SO1, 30).on_hand_observed_on === daysAgo(2),
      JSON.stringify(out(ids.SO1, 30)));
    check('...and the 7d window of the same card takes the count inside ITS window (4, day 2)',
      num(out(ids.SO1, 7).on_hand_at_window_end) === 4
      && out(ids.SO1, 7).on_hand_observed_on === daysAgo(8),
      JSON.stringify(out(ids.SO1, 7)));
    check('no nightly count inside the window leaves both NULL',
      out(ids.RN1, 7).on_hand_at_window_end === null && out(ids.RN1, 7).on_hand_observed_on === null);
    check('units_unsold = recommended − sold, floored at 0 (8 − 6 = 2; 20 − 0 = 20)',
      num(out(ids.SO1, 30).units_unsold) === 2 && num(out(ids.SO3, 30).units_unsold) === 20,
      `${out(ids.SO1, 30).units_unsold}, ${out(ids.SO3, 30).units_unsold}`);
    check('model_version is read from the run (032), no longer NULL on every row',
      out(ids.SO1, 30).model_version === '0.1.0-test', String(out(ids.SO1, 30).model_version));

    // ── The stockout grade ──────────────────────────────────────────────────
    const g1 = out(ids.SO1, 30);
    check('stockout sold through (6 units by day 3) before the PO on day 5 → sold_through TRUE',
      g1.sold_through === true && num(g1.days_to_sell_through) === 3
      && g1.delivery_observed_on === daysAgo(5) && g1.delivery_evidence === 'purchases_feed',
      JSON.stringify(g1));
    const g2 = out(ids.SO2, 30);
    check('stockout whose nightly counts rose (12 arrived day 6) with 9 of 10 sold → FALSE',
      g2.sold_through === false && g2.days_to_sell_through === null
      && g2.delivery_observed_on === daysAgo(4) && g2.delivery_evidence === 'on_hand_increase',
      JSON.stringify(g2));
    check('...and the reason says the cover was still on the shelf',
      /cover still on the shelf/.test(g2.sold_through_reason || ''), g2.sold_through_reason);
    const g3 = out(ids.SO3, 30);
    check('nothing observed yet on an open window → NULL with the reason, not FALSE',
      g3.sold_through === null && /window still open/.test(g3.sold_through_reason || ''),
      JSON.stringify(g3));
    check('a card with no engine_family is recognised by cover below the horizon, and says it is a fallback',
      evalSvc.isStockoutCard({ engine_family: null, action_type: 'reorder', engine_days_cover: 4 })
      && !evalSvc.isStockoutCard({ engine_family: null, action_type: 'reorder', engine_days_cover: 20 })
      && !evalSvc.isStockoutCard({ engine_family: 'recovering', action_type: 'reorder', engine_days_cover: 4 })
      && evals[ids.SO3].action_evidence.stockout_grade?.family_source === 'cover_below_horizon_fallback'
      && evals[ids.SO1].action_evidence.stockout_grade?.family_source === 'engine_family');
    check('the grade is taken on the 30-day window only; the 7d row says so',
      out(ids.SO1, 7).sold_through === null
      && new RegExp(`${evalSvc.STOCKOUT_GRADE_WINDOW_DAYS}-day window only`).test(out(ids.SO1, 7).sold_through_reason || ''),
      out(ids.SO1, 7).sold_through_reason);
    check('a card that is not a stockout card carries no grade and no reason',
      out(ids.RS1, 30).sold_through === null && out(ids.RS1, 30).sold_through_reason === null
      && out(ids.RS1, 30).delivery_evidence === null);

    // ── Idempotency ──
    const again = await evalSvc.evaluateTenant(pool, CID, LID, { syncgoPool: mockSyncgo });
    check('re-run evaluates nothing new', again.evaluated === 0, `evaluated ${again.evaluated}`);

    // ── Report + reads ──
    const report = await evalSvc.getEffectiveness(pool, CID, LID, { windowDays: 7, sinceDays: 30 });
    // 15 shown: the 12 scenarios plus SO1-SO3. SO1 and SO2 sold with no
    // baseline (upside) and were acted on (PO / stock delta) → two more
    // winners and two more acted; SO3's fresh snapshot saw nothing → one more
    // observable, not acted.
    check('report: 15 shown evaluated (holdout excluded), winners counted',
      report.summary.evaluated === 15 && report.summary.winners === 7,
      JSON.stringify(report.summary));
    // 6, not 5, since 039: `acted` is the CARD's fulfilment state, not this
    // window's action_taken. PO2's order landed on day 9 - after the 7-day
    // window (whose row still says false, checked below) but inside the
    // 30-day one - so the store DID follow that card, and the report says so
    // whichever window it is read on. not_followed stays 0 here: RN1, MD2 and
    // SO3 are measured false on the 7-day window, but the 30-day horizon has
    // not closed and valid_through has not passed, so the machine says
    // 'pending' and the read path must not second-guess it.
    check('report: acted-as-recommended story (confirmed by data, per CARD)',
      report.summary.acted_as_recommended === 6 && report.summary.confirmed === 6
      && report.summary.acted_and_won === 5 && report.summary.action_observable === 9
      && report.summary.claimed === 0 && report.summary.not_followed === 0,
      JSON.stringify(report.summary));
    check('report: revenue totals present', report.summary.revenue_impact != null);
    check('report: network benchmark shape', report.network == null
      || ('avg_win_rate' in report.network && !('client_id' in report.network)));
    check('report: category/action/signal breakdowns present',
      report.by_category.length > 0 && report.by_action_type.length > 0);
    check('report: top list carries acted flag',
      report.top.every((t) => 'acted_as_recommended' in t) && report.top.length === 5);

    const one = await evalSvc.getRecEvaluations(pool, CID, LID, ids.RS1);
    check('per-rec read returns all evaluated windows, 7d first',
      one.length === 4 && one[0].window_days === 7, `got ${one.length}`);

    const history = await recSvc.getRecommendationHistory(pool, CID, LID, 30, 20);
    const h1 = history.find((h) => h.primary_skus.includes('RS1'));
    check('history rows carry evaluated_score', h1 && h1.evaluated_score != null,
      JSON.stringify(h1));
    check('holdout recs hidden from the Python history feed', history.length === 15,
      `history ${history.length}`);

    // ── Pending actions (mid-window nudges from the latest run) ──
    const pendingRes = await evalSvc.getPendingActions(pool, CID, LID, { syncgoPool: mockSyncgo });
    const pendingIds = pendingRes.pending.map((p) => Number(p.rec_id));
    // PO2 is correctly ABSENT: its PO landed after the 7d eval window but
    // before today, so by now the store HAS acted - no nudge.
    check('pending-actions lists exactly the still-un-acted observable recs',
      pendingIds.length === 4
      && [ids.RN1, ids.MD2, ids.LS1, ids.SO3].every((id) => pendingIds.includes(Number(id)))
      && !pendingIds.includes(Number(ids.PO2)),
      JSON.stringify(pendingIds));
    check('pending-actions carries days_left', pendingRes.pending.every((p) => p.days_left === 4),
      JSON.stringify(pendingRes.pending.map((p) => p.days_left)));

    // ── Owner-reported action claims (the micro-question) ──
    const q = await evalSvc.getActionQuestion(pool, CID, LID, { syncgoPool: mockSyncgo });
    check('a single askable question is offered for an unobservable action',
      q.question != null && /^Did you/.test(q.question.text)
      && ['endcap', 'cold_box', 'promote', 'bundle'].includes(q.question.action_type),
      JSON.stringify(q.question));

    check('claim on a foreign rec id is rejected',
      (await evalSvc.recordActionClaim(pool, 12345, 1, ids.FL1, 'did', { syncgoPool: mockSyncgo })) === false);

    // The score FL1 carried before the owner said anything - the claim must
    // not move it (039).
    const fl1ScoreBefore = Number(e4.final_score);
    const claimFL1 = await evalSvc.recordActionClaim(pool, CID, LID, ids.FL1, 'did', { syncgoPool: mockSyncgo });      // endcap, unobservable
    await evalSvc.recordActionClaim(pool, CID, LID, ids.PR1, 'did_not', { syncgoPool: mockSyncgo });  // promote, unobservable
    const claimMD1 = await evalSvc.recordActionClaim(pool, CID, LID, ids.MD1, 'did_not', { syncgoPool: mockSyncgo });  // price cut DETECTED - the data wins
    await evalSvc.evaluateTenant(pool, CID, LID, { syncgoPool: mockSyncgo, force: true });
    const after = await pool.query(
      `SELECT e.rec_id, e.action_taken, e.action_evidence, e.final_score, r.fulfilment_state
         FROM recommendation_evaluations e JOIN recommendations r ON r.id = e.rec_id
        WHERE e.client_id=$1 AND e.location_id=$2 AND e.window_days=7 AND e.rec_id = ANY($3)`,
      [CID, LID, [ids.FL1, ids.PR1, ids.MD1]]
    );
    const byId = new Map(after.rows.map((r) => [Number(r.rec_id), r]));
    // ── 039: an owner's claim is a CLAIM. It no longer fills action_taken,
    // so it no longer moves the score or the verdict; it is kept beside the
    // detectors' answer and the fulfilment state says how the two relate.
    check('owner "yes" on an unobservable action leaves action_taken NULL and records the claim beside it',
      byId.get(Number(ids.FL1)).action_taken === null
      && byId.get(Number(ids.FL1)).action_evidence.claim === 'did'
      && !JSON.stringify(byId.get(Number(ids.FL1)).action_evidence).includes('owner_reported'),
      JSON.stringify(byId.get(Number(ids.FL1)).action_evidence));
    check('...and the card is CLAIMED, not confirmed - nothing can confirm an endcap',
      byId.get(Number(ids.FL1)).fulfilment_state === 'claimed' && claimFL1.fulfilment_state === 'claimed',
      `${byId.get(Number(ids.FL1)).fulfilment_state} / ${claimFL1 && claimFL1.fulfilment_state}`);
    check('...and the claim did not move the score',
      near(Number(byId.get(Number(ids.FL1)).final_score), fl1ScoreBefore, 0.001),
      `${fl1ScoreBefore} -> ${byId.get(Number(ids.FL1)).final_score}`);
    check('owner "no" on an unobservable action leaves action_taken NULL too (a "no" is not a detector\'s false)',
      byId.get(Number(ids.PR1)).action_taken === null
      && byId.get(Number(ids.PR1)).action_evidence.claim === 'did_not'
      && byId.get(Number(ids.PR1)).fulfilment_state === 'unobservable',
      `${byId.get(Number(ids.PR1)).action_taken} / ${byId.get(Number(ids.PR1)).fulfilment_state}`);
    check('hard detector evidence outranks an owner claim: the price cut stays TRUE and the card stays CONFIRMED',
      byId.get(Number(ids.MD1)).action_taken === true
      && !JSON.stringify(byId.get(Number(ids.MD1)).action_evidence).includes('owner_reported')
      && byId.get(Number(ids.MD1)).fulfilment_state === 'confirmed'
      && claimMD1.fulfilment_state === 'confirmed',
      `${byId.get(Number(ids.MD1)).fulfilment_state} / ${claimMD1 && claimMD1.fulfilment_state}`);
    check('the claim response says what the data decided and carries a sentence',
      claimFL1.ok === true && claimFL1.evaluation === 'done'
      && /Marked done by you/.test(claimFL1.fulfilment_summary || ''),
      JSON.stringify(claimFL1));
    const q2 = await evalSvc.getActionQuestion(pool, CID, LID, { syncgoPool: mockSyncgo });
    check('answered recs are never asked about again',
      !q2.question || ![ids.FL1, ids.PR1, ids.MD1].map(Number).includes(Number(q2.question.rec_id)));

    // An answer about a not-yet-measurable rec must be VISIBLY pending, not
    // silently absorbed - insert a claimed rec with no evaluations yet.
    await pool.query(
      `INSERT INTO recommendations (run_id, client_id, location_id, rank, category, action_type,
         primary_skus, rationale, signals_cited, confidence, valid_through, action_claim, action_claim_at)
       VALUES ($1,$2,$3,14,'weather','promote','{FL1}','fresh rec, answered early','{}',0.7,CURRENT_DATE + 7,'did',now())`,
      [runId, CID, LID]
    );
    const report2 = await evalSvc.getEffectiveness(pool, CID, LID, { windowDays: 7, sinceDays: 30 });
    check('report surfaces answers still waiting for measurement',
      report2.summary.owner_answers?.answered === 4
      && report2.summary.owner_answers?.pending_measurement === 1,
      JSON.stringify(report2.summary.owner_answers));
    // 039: acted_as_recommended is CONFIRMED only - still 5 - and the owner's
    // "yes" on FL1 is counted on its own line, never inside acted.
    check('report: acted_as_recommended is unchanged by the claims (confirmed only), and claimed is counted apart',
      report2.summary.acted_as_recommended === 6 && report2.summary.confirmed === 6
      && report2.summary.claimed === 1,
      JSON.stringify({ acted: report2.summary.acted_as_recommended, claimed: report2.summary.claimed }));
    check('report: followthrough carries the fulfilment buckets',
      ['confirmed', 'claimed', 'not_followed', 'unobservable', 'pending'].every((k) => k in report2.followthrough));
    check('report: group rows count claimed and not_followed beside acted',
      report2.by_action_type.every((g) => 'claimed' in g && 'not_followed' in g));
    check('report: rows carry fulfilment_state and the deciding detector',
      report2.top.every((t) => 'fulfilment_state' in t && 'detector' in t)
      && report2.top.some((t) => ['purchase_orders', 'price', 'catalog_registry', 'stock_delta'].includes(t.detector)),
      JSON.stringify(report2.top.map((t) => [t.fulfilment_state, t.detector])));

    // ── Weekly digest ──
    const digestSvc = require('../services/recommendationDigestService');
    const digest = await digestSvc.generateDigest(pool, CID, LID, {
      syncgoPool: mockSyncgo, weekStart: digestSvc.mondayOf(new Date(`${REC_DATE}T00:00:00Z`)),
    });
    // 16 recs; 14 measured - SO1/SO2 on outcome, SO3 on a known (not acted)
    // action, like RN1 before it.
    check('digest generated with measured facts', digest != null
      && digest.payload.recs === 16 && digest.payload.measured === 14
      && /worked/.test(digest.body_text),
      digest && JSON.stringify(digest.payload));
    const stored = await digestSvc.getLatestDigest(pool, CID, LID);
    check('digest archived and readable', stored != null && stored.subject === digest.subject);

    // ── captureForRun snapshots from (mock) warehouse state ──
    const capRec = await pool.query(
      `INSERT INTO recommendations (run_id, client_id, location_id, rank, category, action_type, primary_skus, rationale, signals_cited, confidence, valid_through)
       VALUES ($1,$2,$3,10,'weather','cold_box','{CAP1}','capture test','{}',0.5,CURRENT_DATE) RETURNING id`,
      [runId, CID, LID]
    );
    const captured = await evalSvc.captureForRun(pool, CID, LID, runId, { syncgoPool: mockSyncgo });
    const capRow = await pool.query(
      'SELECT on_hand, price FROM recommendation_sku_state WHERE rec_id=$1 AND sku=$2',
      [capRec.rows[0].id, 'CAP1']
    );
    check('captureForRun snapshots stock+price', captured >= 1
      && capRow.rows[0]?.on_hand === 9 && near(Number(capRow.rows[0]?.price), 19.5),
      JSON.stringify(capRow.rows[0]));

    // ── 17: an uploaded invoice as the ONLY action evidence ─────────────────
    //
    // INV1 / INV2 are reorder cards for skus the mock warehouse has never
    // heard of: no purchases-feed row (the feed exists and says 0), no
    // rec-time snapshot (so no stock delta), no current product. The only
    // thing that can speak is a document the owner uploaded: a PARSED invoice
    // with a line a person matched to the sku. INV1's is dated inside the 7d
    // window; INV2's is dated after it (and so inside the 30d window only).
    // Evaluated one card at a time (onlyRecId) so none of the count-based
    // checks above have to learn about them.
    const mkInvoice = async (sku, qty, invoiceDay, status = 'parsed') => {
      const { rows: [po] } = await pool.query(
        `INSERT INTO purchase_orders
           (client_id, location_id, doc_type, status, vendor_name, invoice_no, invoice_date,
            file_name, file_mime, file_path)
         VALUES ($1,$2,'invoice',$3,'Test Vendor',$4,$5::date,'test.pdf','application/pdf','/dev/null')
         RETURNING id`,
        [CID, LID, status, `INV-${sku}-${invoiceDay}`, invoiceDay]
      );
      await pool.query(
        `INSERT INTO purchase_order_items
           (purchase_order_id, client_id, location_id, line_no, product_name, quantity,
            matched_sku, match_source, matched_at)
         VALUES ($1,$2,$3,1,$4,$5,$6,'manual',now())`,
        [po.id, CID, LID, `${sku} test line`, qty, sku]
      );
      return po.id;
    };
    const mkInvRec = async (rank, sku) => {
      const r = await pool.query(
        `INSERT INTO recommendations
           (run_id, client_id, location_id, rank, category, action_type, primary_skus,
            rationale, signals_cited, confidence, valid_through, created_at, suggested_order_qty)
         VALUES ($1,$2,$3,$4,'inventory_understock','reorder',$5,'invoice test rec','{}',0.8,
                 ($6::date + 14),$6::date,24)
         RETURNING id`,
        [runId, CID, LID, rank, [sku], REC_DATE]
      );
      return r.rows[0].id;
    };
    const invIds = { INV1: await mkInvRec(21, 'INV1'), INV2: await mkInvRec(22, 'INV2') };
    await mkInvoice('INV1', 24, daysAgo(5));            // inside the 7d window (ends day 3)
    await mkInvoice('INV2', 18, daysAgo(1));            // after the 7d window; inside the 30d
    await mkInvoice('INV1', 99, daysAgo(6), 'failed');  // a failed parse never counts
    for (const id of Object.values(invIds)) {
      await evalSvc.evaluateTenant(pool, CID, LID, { syncgoPool: mockSyncgo, onlyRecId: id });
    }
    const invEvals = await pool.query(
      `SELECT rec_id, window_days, action_taken, action_evidence FROM recommendation_evaluations
        WHERE client_id=$1 AND location_id=$2 AND rec_id = ANY($3)`,
      [CID, LID, Object.values(invIds)]
    );
    const invEval = (id, w) => invEvals.rows.find((r) => Number(r.rec_id) === Number(id) && r.window_days === w);
    const i1 = invEval(invIds.INV1, 7);
    const i1sku = i1?.action_evidence?.skus?.[0] || {};
    check('invoice: a reorder with no feed row and no snapshot is ACTED on the strength of the uploaded invoice',
      i1 && i1.action_taken === true && i1sku.detector === 'invoice', JSON.stringify(i1 && i1.action_evidence));
    check('invoice: the evidence carries the units and the dated days, and says the feed had none',
      i1sku.invoice_units === 24 && Array.isArray(i1sku.invoice_dates) && i1sku.invoice_dates[0] === daysAgo(5)
      && i1sku.purchased_units_in_window === 0, JSON.stringify(i1sku));
    check('invoice: the failed parse (99 units) is never counted',
      i1sku.invoice_units === 24, JSON.stringify(i1sku));
    const i2 = invEval(invIds.INV2, 7);
    const i2sku = i2?.action_evidence?.skus?.[0] || {};
    check('invoice dated AFTER the window never credits it (unknown, not acted)',
      i2 && i2.action_taken === null && i2sku.detector === 'none', JSON.stringify(i2 && i2.action_evidence));
    const i2w30 = invEval(invIds.INV2, 30);
    check('...and the same invoice credits the 30d window it falls inside',
      i2w30 && i2w30.action_taken === true && i2w30.action_evidence?.skus?.[0]?.detector === 'invoice',
      JSON.stringify(i2w30 && i2w30.action_evidence));
    const invOut = await pool.query(
      `SELECT actual_purchased_qty, purchased_qty_source FROM recommendation_outcomes
        WHERE recommendation_id=$1 AND (window_end - window_start) = 7`, [invIds.INV1]
    );
    const admits = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'recommendation_outcomes_purchased_qty_source_check'`
    );
    const invoiceAdmitted = admits.rows.some((r) => /'invoice'/.test(r.def));
    check(invoiceAdmitted
      ? 'invoice: the bought quantity is 24 and names the invoice as its source (036 applied)'
      : 'invoice: without 036 the bought quantity stays NULL rather than wearing another source\'s name',
    invoiceAdmitted
      ? Number(invOut.rows[0]?.actual_purchased_qty) === 24 && invOut.rows[0]?.purchased_qty_source === 'invoice'
      : invOut.rows[0]?.actual_purchased_qty === null && invOut.rows[0]?.purchased_qty_source === null,
    JSON.stringify(invOut.rows[0]));
  } finally {
    try { await cleanup(pool); } catch (e) { console.warn('cleanup failed:', e.message); }
    await pool.end();
  }
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error('verification crashed:', err); process.exit(1); });
