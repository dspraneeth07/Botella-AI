#!/usr/bin/env node
/**
 * The pilot scoreboards - two boards kept apart, one line per product.
 *
 * The checklist's test paragraph asks for "two scoreboards kept separate:
 * prediction accuracy (needs no owner action) and holdout money (shown vs
 * withheld, action inferred from stock jumps and invoices)". The traps each
 * board has to avoid, each of which yields a confident wrong number:
 *
 *   A WITHHELD CARD LEFT OFF THE ACCURACY BOARD. It is still a prediction;
 *   grading only the shown ones grades the engine on the cards it chose to
 *   display.
 *
 *   A MARKDOWN READ AS "FILLED 0%". It asked for no quantity. The fill ratio
 *   runs over cards that asked, and a product with none refuses with the
 *   reason.
 *
 *   A COVERAGE FIGURE WITH NO RANGE BEHIND IT. A card that stated no range
 *   cannot be inside or outside one; the line says "no range stored".
 *
 *   THE TWO BOARDS BLURRED. Board A must not read action, arm, votes or
 *   money; board B must not headline a hit rate. The JSON of each is checked
 *   for the other's words.
 *
 *   A PRODUCT COUNTED TWICE ON THE HOLDOUT BOARD. Two cards in one window
 *   naming the same product are two CARDS (board A) and one PRODUCT-WINDOW
 *   (board B) - holdoutReport's DISTINCT ON, reused, not re-implemented.
 *
 *   A DIFFERENCE STATED ON ONE WITHHELD WINDOW. Below the floor the board
 *   refuses, with the reason, at store level and in the per-product note.
 *
 *   AN INVOICE NOT COUNTED AS AN ACTION. The evaluator can infer the action
 *   from an uploaded invoice; the board must show that detector by name.
 *
 * Needs the analytics DB from backend/.env with migrations through 036.
 * Sentinel tenant 999921 / 990021 (shared with holdout-report-verify.js;
 * both clean it first). The warehouse is mocked: no syncgo connection.
 *
 * Run:  node tests/pilot-scoreboard-verify.js
 */

require('dotenv').config();

const { getAnalyticsPool } = require('../database/analytics-connection');
const svc = require('../services/pilotScoreboardService');
const evalSvc = require('../services/recommendationEvalService');
const { parseStores, PILOT_STORES } = require('../scripts/pilot-scoreboard');

const CID = 999921;
const LID = 990021;
const MONTH = '2026-07';
// Windows named by the month they land in: these START in June and CLOSE in
// July, so they belong to July's board.
const WS = '2026-06-05';
const WE = '2026-07-05';
const WS2 = '2026-06-10';
const WE2 = '2026-07-10';
const WS3 = '2026-06-15';
const WE3 = '2026-07-15';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const near = (a, b, eps = 0.002) => a != null && Math.abs(a - b) <= eps;

// A warehouse that answers the two name lookups and nothing else - so the
// board's names come from here and no network is needed.
const route = (text) => {
  if (/FROM client_locations/.test(text)) return [{ location_name: 'Test Pilot Store' }];
  if (/FROM products/.test(text)) return [{ sku: 'P1', product_name: 'Product One 750ml' }];
  return [];
};
const mockClient = {
  query: async (text) => ({ rows: /BEGIN|COMMIT|ROLLBACK|set_config/.test(text) ? [] : route(text) }),
  release: () => {},
};
const mockSyncgo = { query: async (t) => ({ rows: route(t) }), connect: async () => mockClient };

async function clean(pool) {
  await pool.query('DELETE FROM recommendation_outcomes WHERE client_id = $1', [CID]);
  await pool.query('DELETE FROM recommendation_runs WHERE client_id = $1', [CID]);
  await pool.query('DELETE FROM pilot_scoreboards WHERE client_id = $1', [CID]);
}

(async () => {
  const pool = getAnalyticsPool();
  await clean(pool);
  const { rows: [run] } = await pool.query(
    `INSERT INTO recommendation_runs (client_id, location_id, generated_at)
     VALUES ($1, $2, now()) RETURNING id`, [CID, LID]
  );

  let rank = 0;
  /**
   * One card with one outcome row and (optionally) one evaluation row.
   * @param {object} s sku, family, arm, lift, qty, sold, range [lo,hi],
   *   stockout, soldThrough, margin, action, evidence, ws/we, openDays, windowDays
   */
  async function card(s) {
    const { rows: [rec] } = await pool.query(
      `INSERT INTO recommendations
         (run_id, client_id, location_id, rank, category, action_type, primary_skus, status,
          engine_family, suggested_order_qty, expected_range_low, expected_range_high,
          expected_range_refused)
       VALUES ($1,$2,$3,$4,'test',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [run.id, CID, LID, ++rank, s.family, [s.sku],
        s.arm === 'withheld' ? 'holdout' : null,
        s.stockout ? 'stockout' : null,
        s.qty ?? null,
        s.range ? s.range[0] : null, s.range ? s.range[1] : null,
        s.rangeRefused || null]
    );
    const wd = s.windowDays || 30;
    const ws = s.ws || WS;
    const we = s.we || (wd === 30 ? WE : null);
    await pool.query(
      `INSERT INTO recommendation_outcomes
         (recommendation_id, client_id, location_id, sku, family, arm,
          window_start, window_end, open_days_in_window, lift, lift_reason,
          recommended_qty, actual_units_sold, sold_through, sold_through_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7::date,
               ${we ? '$8::date' : `($7::date + ${wd})`},
               $9,$10,$11,$12,$13,$14,$15)`,
      [rec.id, CID, LID, s.sku, s.family, s.arm || 'shown', ws, we || ws,
        s.openDays ?? 24, s.lift ?? null,
        s.lift == null ? 'the baseline projects zero units over this window' : null,
        s.qty ?? null, s.sold ?? null,
        s.soldThrough ?? null, s.stockout && s.soldThrough == null ? 'window still open' : null]
    );
    if (s.margin !== undefined || s.action !== undefined) {
      await pool.query(
        `INSERT INTO recommendation_evaluations
           (rec_id, client_id, location_id, window_days, verdict, margin_impact,
            action_taken, action_evidence, data_through)
         VALUES ($1,$2,$3,$4,'neutral',$5,$6,$7::jsonb,$8::date)`,
        [rec.id, CID, LID, wd, s.margin ?? null, s.action ?? null,
          JSON.stringify(s.evidence || { skus: [] }), '2026-07-10']
      );
    }
    return rec.id;
  }

  // P1: three shown cards in three windows, plus a FOURTH card sharing the
  // first window (two cards, one product-window). Quantities on all; a stated
  // range on the third only.
  await card({ sku: 'P1', family: 'reorder', lift: 1.5, qty: 10, sold: 8, margin: 10,
    action: false, evidence: { skus: [{ sku: 'P1', taken: false, detector: 'stock_delta', net_inflow: 0, threshold: 3 }] } });
  await card({ sku: 'P1', family: 'reorder', lift: 0.8, qty: 10, sold: 4, margin: 20, ws: WS2, we: WE2,
    action: null, evidence: { skus: [{ sku: 'P1', taken: null, detector: 'none' }] } });
  await card({ sku: 'P1', family: 'reorder', lift: 2.0, qty: 10, sold: 12, margin: null, ws: WS3, we: WE3, range: [5, 15],
    action: true, evidence: { skus: [{ sku: 'P1', taken: true, detector: 'stock_delta', net_inflow: 9, threshold: 3 }] } });
  // The twin: same window as the first, fewer open days, so DISTINCT ON keeps
  // the first. No evaluation row - the per-product money must not need one.
  await card({ sku: 'P1', family: 'reorder', lift: 1.1, qty: 10, sold: 6, openDays: 18 });

  // P2: a markdown (asks for no quantity, no range: refused by the engine)
  // shown once and WITHHELD once - both arms exist for one product.
  await card({ sku: 'P2', family: 'markdown', lift: 0.5, sold: 3, margin: 20, rangeRefused: 'fewer than 8 trading days of history',
    action: false, evidence: { skus: [{ sku: 'P2', taken: false, detector: 'price', effective_price_then: 10, effective_price_now: 10 }] } });
  await card({ sku: 'P2', family: 'markdown', arm: 'withheld', lift: 1.2, sold: 5, margin: 30, ws: WS2, we: WE2 });

  // P3: the stockout card, graded, with NO measurable lift (zero baseline).
  await card({ sku: 'P3', family: 'reorder', stockout: true, lift: null, qty: 8, sold: 8, soldThrough: true, margin: null });

  // P4: a reorder whose ONLY action evidence is an uploaded invoice.
  await card({ sku: 'P4', family: 'reorder', lift: 1.0, qty: 5, sold: 5, margin: 15,
    action: true, evidence: { skus: [{ sku: 'P4', taken: true, detector: 'invoice', invoice_units: 12, invoice_dates: ['2026-06-20'] }] } });

  // Decoys that must be IGNORED: a 7-day window for P1 inside the month, and
  // a 30-day window for P1 that closes in August.
  await card({ sku: 'P1', family: 'reorder', lift: 9.0, qty: 10, sold: 90, windowDays: 7, ws: '2026-07-01', we: '2026-07-08' });
  await card({ sku: 'P1', family: 'reorder', lift: 9.0, qty: 10, sold: 90, ws: '2026-07-10', we: '2026-08-09' });

  const board = await svc.buildScoreboard(pool, CID, LID, MONTH, { syncgoPool: mockSyncgo });
  const A = board.accuracy;
  const B = board.holdout;
  const lineA = (sku) => A.lines.find((l) => l.sku === sku);
  const lineB = (sku) => B.lines.find((l) => l.sku === sku);

  console.log('\n-- The month and the window -----------------------------');
  check('1  only 30-day windows that CLOSED in the month: 8 cards, not 10',
    A.summary.cards === 8, `cards ${A.summary.cards}`);
  check('2  month rule and data_through are stated',
    /ended in/.test(board.month_rule) && board.data_through === '2026-07-10',
    `${board.month_rule} / ${board.data_through}`);
  check('3  names come from the warehouse; a sku with no name shows the sku',
    board.store.name === 'Test Pilot Store' && lineA('P1').product === 'Product One 750ml'
    && lineA('P2').product === 'P2' && lineB('P1').product === 'Product One 750ml');

  console.log('\n-- Board A: prediction accuracy -------------------------');
  check('4  the withheld card is counted: P2 has 2 cards',
    lineA('P2').cards === 2 && A.summary.products === 4, JSON.stringify(lineA('P2')));
  check('5  hit rate over MEASURED cards: 5 of 7 (P3 unmeasurable, not a miss)',
    A.summary.measured_on === 7 && A.summary.hits === 5 && near(A.summary.hit_rate, 0.714),
    JSON.stringify(A.summary));
  const ci = A.summary.hit_rate_interval_95;
  check('6  Wilson 95% interval around it, inside [0,1] and containing the rate',
    ci && ci.low < A.summary.hit_rate && ci.high > A.summary.hit_rate && ci.low >= 0 && ci.high <= 1,
    JSON.stringify(ci));
  check('7  fill ratio only over cards that asked: 43 of 53 units on 6 cards',
    A.summary.promise_fill.cards_with_quantity === 6 && A.summary.promise_fill.recommended_units === 53
    && A.summary.promise_fill.sold_units === 43 && near(A.summary.promise_fill.fill_ratio, 0.811),
    JSON.stringify(A.summary.promise_fill));
  check('8  the markdown asked for nothing: fill refused with the reason, never 0%',
    lineA('P2').promise_fill.fill_ratio === null
    && lineA('P2').refusals.some((r) => /asked for a quantity/.test(r)), JSON.stringify(lineA('P2')));
  check('9  coverage only where a range was stated: 1 of 1 (P1), refused as "no range stored" for P2',
    A.summary.interval_coverage.cards_with_range === 1 && A.summary.interval_coverage.coverage === 1
    && lineA('P2').interval_coverage.coverage === null
    && lineA('P2').refusals.some((r) => /no range stored/.test(r) && /fewer than 8 trading days/.test(r)),
    JSON.stringify(lineA('P2').refusals));
  check('10 the stockout grade: 1 card, sold through, counted from the evaluator\'s own recogniser',
    A.summary.stockout_grade.cards === 1 && A.summary.stockout_grade.sold_through === 1
    && lineA('P3').stockout_grade.sold_through === 1 && lineA('P1').stockout_grade.cards === 0,
    JSON.stringify(A.summary.stockout_grade));
  check('11 P3 has no measurable lift: hit rate refused on the line, with the reason',
    lineA('P3').hit_rate === null && lineA('P3').refusals.some((r) => /measurable lift/.test(r)));
  const aText = JSON.stringify({ summary: A.summary, lines: A.lines });
  check('12 board A reads no action, arm, vote or money',
    !/action|margin|withheld|shown|vote|dollar/.test(aText), aText.slice(0, 200));
  check('13 board A says it needs no owner action',
    /needs no owner action/.test(A.what_this_board_measures));

  console.log('\n-- Board B: holdout money ------------------------------');
  check('14 arms side by side per product: P2 shown 1 / withheld 1, each with its own lift and money',
    lineB('P2').shown.products === 1 && lineB('P2').withheld.products === 1
    && near(lineB('P2').shown.avg_lift, 0.5) && near(lineB('P2').withheld.avg_lift, 1.2)
    && lineB('P2').shown.dollars_per_product === 20 && lineB('P2').withheld.dollars_per_product === 30,
    JSON.stringify(lineB('P2')));
  check('15 one product-window, not two cards: P1 shown 3 windows (board A had 4 cards)',
    lineB('P1').shown.products === 3 && lineA('P1').cards === 4, JSON.stringify(lineB('P1').shown));
  check('16 ...and the kept outcome is the fuller one (1.5, not the twin\'s 1.1)',
    near(lineB('P1').shown.avg_lift, 1.433), `${lineB('P1').shown.avg_lift}`);
  check('17 money per product never totals: P1 $30 over 2 priced = $15; unpriced P3 is NULL with the reason',
    lineB('P1').shown.priced === 2 && lineB('P1').shown.dollars_per_product === 15
    && lineB('P3').shown.dollars_per_product === null
    && lineB('P3').refusals.some((r) => /cost unknown/.test(r)),
    JSON.stringify([lineB('P1').shown, lineB('P3')]));
  check('18 the store difference is refused below the floor, with the reason',
    B.summary.difference.lift === null
    && new RegExp(`needs ${evalSvc.HOLDOUT_MIN_PER_ARM} measured outcomes per arm; have 5 shown and 1 withheld`)
      .test(B.summary.difference.refused_reason || ''),
    JSON.stringify(B.summary.difference));
  check('19 ...and the per-product note for P2 says both arms exist and why no difference is stated',
    /both arms/.test(lineB('P2').note) && /no difference stated/.test(lineB('P2').note)
    && /have 1 shown and 1 withheld/.test(lineB('P2').note), lineB('P2').note);
  check('20 the invoice is counted as an inferred action, by name',
    lineB('P4').action_inferred_on_shown.acted === 1
    && lineB('P4').action_inferred_on_shown.detectors.invoice === 1,
    JSON.stringify(lineB('P4').action_inferred_on_shown));
  check('21 action totals on the shown arm: 2 acted (stock delta, invoice), 2 not, 2 unobservable',
    B.summary.action_inferred_on_shown.acted === 2 && B.summary.action_inferred_on_shown.not_acted === 2
    && B.summary.action_inferred_on_shown.unobservable === 2
    && B.summary.action_inferred_on_shown.detectors['stock delta'] === 1
    && B.summary.action_inferred_on_shown.detectors.invoice === 1,
    JSON.stringify(B.summary.action_inferred_on_shown));
  check('22 the withheld arm carries no action column',
    !('action_inferred_on_withheld' in lineB('P2')) && lineB('P2').withheld.acted === undefined);
  check('23 board B matches holdoutReport for the month exactly',
    JSON.stringify(B.summary.shown) === JSON.stringify((await evalSvc.holdoutReport(pool,
      { clientId: CID, locationId: LID, windowDays: 30, month: MONTH })).overall.shown));
  // The figures, not the sentence that says "this board states no hit rate".
  check('24 board B carries no hit rate in its figures',
    !/hit_rate|hit rate|hits/.test(JSON.stringify({ summary: B.summary, lines: B.lines, by_family: B.by_family })));
  check('25 totals are on the record, labelled as totals',
    B.summary.totals_for_the_record.shown_dollars_total === 65
    && /per product/.test(B.summary.totals_for_the_record.note),
    JSON.stringify(B.summary.totals_for_the_record));

  console.log('\n-- The row and the page --------------------------------');
  const saved = await svc.saveScoreboard(pool, board);
  const again = await svc.saveScoreboard(pool, board);
  const stored = await svc.getScoreboard(pool, CID, LID, MONTH);
  const { rows: [{ n }] } = await pool.query(
    'SELECT count(*)::int AS n FROM pilot_scoreboards WHERE client_id = $1', [CID]);
  check('26 the row upserts: one row after two saves, month and data_through stored',
    n === 1 && saved.month === MONTH && again.month === MONTH && stored.data_through === '2026-07-10',
    JSON.stringify({ n, saved, stored: stored && stored.month }));
  check('27 the stored boards read back as the boards built',
    stored.accuracy.summary.cards === 8 && stored.holdout.summary.difference.refused_reason != null);
  check('28 a month nobody built is null, not an empty board',
    (await svc.getScoreboard(pool, CID, LID, '2025-01')) === null);

  const html = svc.renderScoreboardHtml(board);
  check('29 the page has both boards as separate sections',
    /<h2 id="board-a">Board A - Prediction accuracy<\/h2>/.test(html)
    && /<h2 id="board-b">Board B - Holdout money<\/h2>/.test(html));
  check('30 the page says board A needs no owner action and board B compares arms',
    /needs no owner action/.test(html) && /This board compares arms/.test(html));
  check('31 the refusal text is on the page, in place',
    /needs 5 measured outcomes per arm; have 5 shown and 1 withheld/.test(html)
    && /no range stored/.test(html) && /asked for a quantity/.test(html));
  check('32 one row per product on each board, and no external assets',
    (html.match(/Product One 750ml/g) || []).length >= 2
    && !/<script|https?:\/\//.test(html));

  console.log('\n-- The log line and the store list ----------------------');
  const line = svc.summaryLine(board);
  check('33 the summary line carries the hit rate with its interval and the holdout refusal',
    /hit rate 71% \[\d+%-\d+%\] on 7 of 8 cards/.test(line) && /holdout difference refused/.test(line), line);
  check('34 the five pilot stores are the default, client == location',
    parseStores(PILOT_STORES).length === 5
    && parseStores(PILOT_STORES).every((s) => s.clientId === s.locationId)
    && parseStores(PILOT_STORES).map((s) => s.locationId).join(',') === '171,176,177,178,181');
  let refused = null;
  check('35 ALL is a sentinel resolved against the database, never a pooled board',
    parseStores('ALL') === 'ALL');
  check('36 previous month arithmetic crosses the year',
    svc.previousMonth(new Date('2026-01-15T00:00:00Z')) === '2025-12'
    && svc.previousMonth(new Date('2026-08-01T00:00:00Z')) === '2026-07');
  check('37 Wilson: 0 of 0 is null, not an interval; 5 of 7 is about [36%, 92%]',
    svc.wilsonInterval(0, 0) === null
    && near(svc.wilsonInterval(5, 7).low, 0.359, 0.01) && near(svc.wilsonInterval(5, 7).high, 0.918, 0.01),
    JSON.stringify(svc.wilsonInterval(5, 7)));

  // An empty month: every figure refused with a reason, nothing zero.
  const empty = await svc.buildScoreboard(pool, CID, LID, '2025-01', { syncgoPool: false });
  check('38 an empty month refuses every figure with a reason and stores no 0% anywhere',
    empty.accuracy.summary.cards === 0 && empty.accuracy.summary.hit_rate === null
    && empty.accuracy.summary.promise_fill.fill_ratio === null
    && empty.accuracy.refusals.length >= 4 && empty.holdout.summary.difference.refused_reason != null
    && empty.refusals.some((r) => /lookup skipped/.test(r)),
    JSON.stringify(empty.accuracy.refusals));

  await clean(pool);
  await pool.end();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('verification crashed:', err);
  process.exit(1);
});
