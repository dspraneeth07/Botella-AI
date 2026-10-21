/**
 * Forward-test daily job verification - drives scripts/forward-test-daily.js
 * end-to-end against the real analytics DB (sentinel tenant 999922/990022)
 * with a mocked syncgo warehouse, generation skipped (--no-generate), output
 * into a temp directory. Covers:
 *
 *   1  the shelf snapshot is written for every SKU with a product row, and a
 *      SKU without one gets NO row (absence is not zero)
 *   2  a second run on the same day does not overwrite the morning's count
 *   3  a card with a closed 7-open-day window is scored and persisted with the
 *      typed columns matching the evaluateCard row
 *   4  a 3-day-old card is `pending` and sits in no denominator
 *   5  a card whose SKU is in neither feed is `no_data`, also in no denominator
 *   6  the forward_test_runs row carries the metrics verbatim, four runs
 *      (period/trailing30 x fixed/intended) are written and labelled
 *   7  REPORT.html names the four metrics, prints the confidence score with
 *      both halves, and holds the per-card table with the observed shelf count
 *   8  INDEX.html lists the day and says how many of the period's runs happened
 *   9  --final writes the three final files, the evolution counts and the
 *      "cannot say" section
 *   10 the refactored forward-test.js still scores a known card the same way
 *      (the CLI's JSON was also diffed byte-for-byte before and after the
 *      refactor, ignoring generated_at - see the commit)
 *
 * PREREQ: analytics migration 038 applied.
 * Run:  node tests/forward-test-daily-verify.js
 */
require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getAnalyticsPool } = require('../database/analytics-connection');
const ft = require('../scripts/forward-test');
const daily = require('../scripts/forward-test-daily');

const CID = 999922;
const LID = 990022;

const dayMs = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => iso(Date.now() - n * dayMs);
// "Today" for the job is the IST calendar day, computed the way the job does.
const TODAY = daily.istDay();
const PERIOD_START = daily.addDays(TODAY, -14);   // a 15-morning period ending today
const PERIOD_END = TODAY;
const OLD_REC = daysAgo(12);   // 12 days old: 7 open days have elapsed
const NEW_REC = daysAgo(3);    // 3 days old: pending

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
}

// ── Mock syncgo warehouse ────────────────────────────────────────────────────
// Open every day for the last 40 days. FTA1 sells 1/day, FTB1 2/day, FTC1 is
// in neither the sales feed nor the product master.
const openDays = [];
for (let n = 40; n >= 0; n -= 1) openDays.push(daysAgo(n));
const UNITS = { FTA1: 1, FTB1: 2 };
const ECON = { FTA1: { price: 10, cost: 6, name: 'Sentinel Gin 750ml' }, FTB1: { price: 20, cost: 12, name: 'Sentinel Rum 1L' } };
// Mutable so test 2 can change the "current" count between runs.
const STOCK = { FTA1: 2, FTB1: 7 };

function route(text, params) {
  if (/SELECT DISTINCT sale_date::date/.test(text)) return openDays.map((d) => ({ d }));
  if (/FROM sale_items/.test(text) && /sum\(quantity\)/.test(text)) {
    const skus = params[1];
    const out = [];
    for (const sku of skus) {
      if (!UNITS[sku]) continue;
      for (const d of openDays) out.push({ sku, d, units: String(UNITS[sku]) });
    }
    return out;
  }
  if (/percentile_cont/.test(text)) {
    return params[1].filter((s) => ECON[s]).map((s) => ({ sku: s, px: ECON[s].price, ct: ECON[s].cost, name: ECON[s].name, category: 'SPIRITS' }));
  }
  if (/FROM products/.test(text) && /max\(price\)/.test(text)) {
    return params[1].filter((s) => ECON[s]).map((s) => ({ sku: s, px: ECON[s].price, ct: ECON[s].cost, name: ECON[s].name, category: 'SPIRITS' }));
  }
  if (/FROM products/.test(text) && /stock_qty/.test(text)) {
    return params[1].filter((s) => ECON[s]).map((s) => ({
      sku: s, upc: null, location_id: LID, stock_qty: STOCK[s], price: ECON[s].price, cost: ECON[s].cost,
    }));
  }
  if (/FROM client_locations/.test(text)) return [{ client_id: CID, location_id: LID, location_name: 'Sentinel Store' }];
  throw new Error(`forward-test-daily mock: unrouted syncgo query: ${text.slice(0, 100)}`);
}
const mockSyncgo = { query: async (t, p) => ({ rows: route(t, p) }) };

// ── Fixtures in the analytics DB ─────────────────────────────────────────────
async function setup(pool) {
  const mkRun = async (recDate) => {
    const r = await pool.query(
      `INSERT INTO recommendation_runs
         (client_id, location_id, generated_at, data_as_of, candidate_count, recommendation_count, dropped_invalid, signal_snapshot)
       VALUES ($1, $2, ($3 || 'T06:00:00+05:30')::timestamptz, $3::date, 10, 2, 0, '{}'::jsonb) RETURNING id`,
      [CID, LID, recDate]
    );
    return r.rows[0].id;
  };
  const mkCard = async (runId, recDate, rank, sku, { qty, onHand, rate, confidence }) => {
    const r = await pool.query(
      `INSERT INTO recommendations
         (run_id, client_id, location_id, rank, category, action_type, primary_skus, rationale,
          signals_cited, confidence, valid_through, created_at, suggested_order_qty,
          engine_daily_rate, engine_on_hand, engine_family)
       VALUES ($1,$2,$3,$4,'inventory_understock','reorder',$5,'forward-test-daily fixture','{}',$6,
               ($7::date + 14),$7::date,$8,$9,$10,'stockout') RETURNING id`,
      [runId, CID, LID, rank, [sku], confidence, recDate, qty, rate, onHand]
    );
    return r.rows[0].id;
  };
  const oldRun = await mkRun(OLD_REC);
  const newRun = await mkRun(NEW_REC);
  const ids = {};
  // A: 5 recommended on 3 on hand at 1/day. Seven open days sell 7 >= 5 with
  // 1 unit left and no stockout: successful. Intended horizon is 5 days.
  ids.A = await mkCard(oldRun, OLD_REC, 1, 'FTA1', { qty: 5, onHand: 3, rate: 1, confidence: 0.6 });
  // C: a SKU in neither feed, so zero cannot be told from a gap: no_data.
  ids.C = await mkCard(oldRun, OLD_REC, 2, 'FTC1', { qty: 20, onHand: null, rate: null, confidence: 0.3 });
  // B: three days old, so no 7-open-day window has elapsed: pending.
  ids.B = await mkCard(newRun, NEW_REC, 1, 'FTB1', { qty: 10, onHand: 4, rate: 2, confidence: 0.5 });
  return ids;
}

async function cleanup(pool) {
  await pool.query(
    `DELETE FROM forward_test_card_outcomes WHERE run_id IN (SELECT id FROM forward_test_runs WHERE stores = $1::int[])`,
    [[CID]]);
  await pool.query('DELETE FROM forward_test_runs WHERE stores = $1::int[]', [[CID]]);
  await pool.query('DELETE FROM forward_test_inventory_snapshots WHERE client_id = $1', [CID]);
  await pool.query('DELETE FROM recommendation_runs WHERE client_id = $1 AND location_id = $2', [CID, LID]);
}

(async () => {
  const pool = getAnalyticsPool();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forward-test-daily-'));
  const quiet = () => {};
  try {
    await cleanup(pool);
    const ids = await setup(pool);
    const common = { stores: [CID], outDir, noGenerate: true, periodStart: PERIOD_START, periodEnd: PERIOD_END, asOf: TODAY, log: quiet };

    // ── First run ──────────────────────────────────────────────────────────
    const s1 = await daily.runDaily(common, { analytics: pool, syncgo: mockSyncgo });

    // 1. snapshots
    const snaps = (await pool.query(
      `SELECT sku, stock_qty, rate_28d_open_days, price, cost FROM forward_test_inventory_snapshots
        WHERE client_id = $1 AND snap_date = $2::date ORDER BY sku`, [CID, TODAY])).rows;
    check('1 snapshot rows written for the two SKUs with a product row', snaps.length === 2, `got ${snaps.length}`);
    check('1 FTA1 snapshot carries the observed count, the 28-open-day rate and the price/cost',
      snaps[0] && snaps[0].sku === 'FTA1' && Number(snaps[0].stock_qty) === 2
        && Number(snaps[0].rate_28d_open_days) === 1 && Number(snaps[0].price) === 10 && Number(snaps[0].cost) === 6,
      JSON.stringify(snaps[0]));
    check('1 the SKU with no product row has no snapshot row and is counted',
      !snaps.find((s) => s.sku === 'FTC1') && s1.capture.without_product === 1 && s1.capture.inserted === 2,
      JSON.stringify(s1.capture));

    // 2. second run the same day: the shelf "changes" but the row must not
    STOCK.FTA1 = 99; STOCK.FTB1 = 0;
    const s2 = await daily.runDaily(common, { analytics: pool, syncgo: mockSyncgo });
    const snaps2 = (await pool.query(
      `SELECT sku, stock_qty FROM forward_test_inventory_snapshots WHERE client_id = $1 AND snap_date = $2::date ORDER BY sku`,
      [CID, TODAY])).rows;
    check('2 a second run the same day does not overwrite the earlier capture',
      snaps2.length === 2 && Number(snaps2[0].stock_qty) === 2 && Number(snaps2[1].stock_qty) === 7,
      JSON.stringify(snaps2));
    check('2 the second run reports 0 inserted and 2 already captured',
      s2.capture.inserted === 0 && s2.capture.already_captured === 2, JSON.stringify(s2.capture));

    // 3-6. runs and card rows (from the FIRST run's rows, the ones the report used)
    const runs = (await pool.query(
      `SELECT * FROM forward_test_runs WHERE stores = $1::int[] ORDER BY id`, [[CID]])).rows;
    check('6 eight run rows exist after two daily runs (4 per morning)', runs.length === 8, `got ${runs.length}`);
    const firstFour = runs.slice(0, 4);
    const labels = firstFour.map((r) => `${r.label}/${r.window_mode}`).sort().join(' ');
    check('6 the four runs are labelled period/trailing30 x fixed/intended',
      labels === 'period/fixed period/intended trailing30/fixed trailing30/intended', labels);
    const pf = firstFour.find((r) => r.label === 'period' && r.window_mode === 'fixed');
    check('6 the period/fixed run row carries the metrics verbatim (3 examined, 1 scored, 1 pending, 1 no_data)',
      pf && pf.cards_examined === 3 && pf.metrics.evaluated === 1 && pf.metrics.pending === 1
        && pf.metrics.no_data === 1 && pf.metrics.counts.successful === 1
        && pf.metrics.recommendation_accuracy_rate_pct === 100
        && ft.day(pf.as_of) === TODAY,
      pf ? JSON.stringify({ n: pf.cards_examined, m: pf.metrics.counts, as_of: ft.day(pf.as_of) }) : 'no row');
    check('6 generation columns say the step was skipped (NULL cards today is not 0 refused)',
      pf && pf.generation === null && pf.generation_refused === 0 && pf.generation_failed === 0
        && pf.generated_cards_today === 0,
      pf ? JSON.stringify({ g: pf.generation, r: pf.generation_refused, c: pf.generated_cards_today }) : 'no row');

    const cards = (await pool.query(
      `SELECT * FROM forward_test_card_outcomes WHERE run_id = $1 ORDER BY rec_id`, [pf.id])).rows;
    const A = cards.find((c) => Number(c.rec_id) === Number(ids.A));
    const B = cards.find((c) => Number(c.rec_id) === Number(ids.B));
    const C = cards.find((c) => Number(c.rec_id) === Number(ids.C));
    check('3 the closed-window card is scored successful and persisted with its working',
      A && A.outcome === 'successful' && A.window_closed === true && Number(A.actual_sold) === 7
        && Number(A.ending_inventory_sim) === 1 && Number(A.simulated_start) === 8
        && Number(A.recommended_qty) === 5 && A.met_forecast_rate === true
        && Number(A.realised_margin) === 20 && A.sku === 'FTA1' && A.window_open_days === 7
        && A.detail.outcome === 'successful' && A.detail.reason.includes('sold 7 against 5'),
      A ? JSON.stringify({ o: A.outcome, sold: A.actual_sold, end: A.ending_inventory_sim, m: A.realised_margin }) : 'no row');
    check('4 the 3-day-old card is pending, window open, sold NULL (not 0)',
      B && B.outcome === 'pending' && B.window_closed === false && B.actual_sold === null
        && B.ending_inventory_sim === null && /only 3 have elapsed|only \d have elapsed/.test(B.detail.reason),
      B ? JSON.stringify({ o: B.outcome, closed: B.window_closed, sold: B.actual_sold, r: B.detail.reason }) : 'no row');
    check('5 the SKU in neither feed is no_data, window not closed',
      C && C.outcome === 'no_data' && C.window_closed === false && C.actual_sold === null,
      C ? JSON.stringify({ o: C.outcome, closed: C.window_closed }) : 'no row');
    check('4 pending and no_data sit in no denominator: RAR is 1 of 1, not 1 of 3',
      pf.metrics.evaluated === 1 && pf.metrics.recommendation_accuracy_rate_pct === 100
        && pf.metrics.units_recommended === 5, JSON.stringify(pf.metrics));
    const pi = firstFour.find((r) => r.label === 'period' && r.window_mode === 'intended');
    const Ai = (await pool.query(
      `SELECT outcome, window_open_days, actual_sold FROM forward_test_card_outcomes WHERE run_id = $1 AND rec_id = $2`,
      [pi.id, ids.A])).rows[0];
    check('6 the intended-mode run scores the same card over its own 5-day cover',
      Ai && Ai.outcome === 'successful' && Ai.window_open_days === 5 && Number(Ai.actual_sold) === 5,
      JSON.stringify(Ai));

    // 7. REPORT.html
    const dayDir = path.join(outDir, 'daily', TODAY);
    const html = fs.readFileSync(path.join(dayDir, 'REPORT.html'), 'utf8');
    for (const name of ['Recommendation Accuracy Rate', 'Inventory Turnover Efficiency', 'Net financial impact', 'Met-forecast rate']) {
      check(`7 REPORT.html names "${name}"`, html.includes(name));
    }
    check('7 REPORT.html prints the Engine Confidence Score with both halves and its definition',
      html.includes('Engine Confidence Score') && html.includes('Measured performance:')
        && html.includes('Evidence sufficiency:') && html.includes('a product, not an average'));
    check('7 the confidence score is a product that collapses on thin evidence',
      s1.confidence.engine_confidence !== null && s1.confidence.performance.score !== null
        && s1.confidence.sufficiency.score !== null
        && Math.abs(s1.confidence.engine_confidence - (s1.confidence.performance.score * s1.confidence.sufficiency.score) / 100) < 0.2
        && s1.confidence.engine_confidence < s1.confidence.performance.score,
      JSON.stringify({ e: s1.confidence.engine_confidence, p: s1.confidence.performance.score, s: s1.confidence.sufficiency.score }));
    check('7 REPORT.html holds the per-card table with the SKU, the product, the outcome and the observed shelf count',
      html.includes('<td>FTA1</td>') && html.includes('Sentinel Gin 750ml') && html.includes('<td>successful</td>')
        && html.includes('<td>pending</td>') && html.includes('<td>no_data</td>')
        && /<td class="n">2<\/td><td>successful<\/td>/.test(html));
    check('7 REPORT.html has the outcome breakdown, calibration and per-store sections',
      html.includes('Outcome breakdown') && html.includes('Calibration') && html.includes('Sentinel Store')
        && html.includes('Successful restock'));
    for (const f of ['forward_test_w7.json', 'forward_test_w7.csv', 'forward_test_intended.json', 'forward_test_intended.csv',
      'forward_test_w7_trailing30.json', 'forward_test_intended_trailing30.csv', 'daily.json']) {
      check(`7 ${f} written in the day folder`, fs.existsSync(path.join(dayDir, f)));
    }
    const w7 = JSON.parse(fs.readFileSync(path.join(dayDir, 'forward_test_w7.json'), 'utf8'));
    check('7 the day\'s forward_test_w7.json has the CLI\'s shape and the period filter',
      w7.window.mode === 'fixed' && w7.settings.since_date === PERIOD_START && w7.scope.cards_examined === 3
        && Array.isArray(w7.cards) && w7.metrics.evaluated === 1, JSON.stringify(w7.settings));

    // 8. INDEX.html
    const index = fs.readFileSync(path.join(outDir, 'INDEX.html'), 'utf8');
    check('8 INDEX.html lists the day and links its report',
      index.includes(`daily/${TODAY}/REPORT.html`) && index.includes(`<td>${TODAY}</td>`));
    check('8 INDEX.html states the period and how many of its runs have happened',
      index.includes(`${PERIOD_START} to ${PERIOD_END}`) && index.includes('1 of 15</b> daily runs have happened'),
      index.match(/<b>\d+ of \d+<\/b> daily runs/)?.[0] || 'no count line');

    // 9. --final
    const s3 = await daily.runDaily({ ...common, final: true }, { analytics: pool, syncgo: mockSyncgo });
    const base = `FINAL_REPORT_${PERIOD_START}_to_${PERIOD_END}`;
    check('9 --final writes the html, json and csv', ['html', 'json', 'csv'].every((e) => fs.existsSync(path.join(outDir, `${base}.${e}`))),
      JSON.stringify(s3.final));
    const fin = fs.readFileSync(path.join(outDir, `${base}.html`), 'utf8');
    const finJson = JSON.parse(fs.readFileSync(path.join(outDir, `${base}.json`), 'utf8'));
    check('9 the final report has the "cannot say" section with acceptance, pending last week, refusals and missed days',
      fin.includes('What this report cannot say') && fin.includes('Acceptance is assumed')
        && fin.includes('Stores the quality gate refused') && fin.includes('Mornings the job did not run')
        && finJson.cannot_say.acceptance_assumed === true && finJson.cannot_say.pending_cards_from_last_7_days === 1);
    check('9 the final report counts how verdicts evolved across the runs',
      fin.includes('How verdicts evolved') && finJson.evolution.cards === 3
        && finJson.evolution.scored_from_first_run === 1 && finJson.evolution.still_pending === 1,
      JSON.stringify(finJson.evolution));
    check('9 the final report compares simulated ending stock with the observed shelf (A: sim 1, shelf 2)',
      finJson.shelf_comparison.cards_compared === 1 && finJson.shelf_comparison.cards[0].simulated_ending === 1
        && finJson.shelf_comparison.cards[0].observed_shelf === 2
        && finJson.shelf_comparison.cards[0].observed_minus_simulated === 1,
      JSON.stringify(finJson.shelf_comparison));
    check('9 the final report says the job ran on 1 of 15 mornings and lists the missed ones',
      finJson.period.runs_happened === 1 && finJson.period.days_missed.length === 14
        && fin.includes('1 of 15</b> mornings'));
    check('9 the final csv has one row per card with the intended verdict and the shelf count',
      fs.readFileSync(path.join(outDir, `${base}.csv`), 'utf8').split('\n').length === 4
        && fs.readFileSync(path.join(outDir, `${base}.csv`), 'utf8').includes('intended_outcome,shelf_on_last_day'));
    const index2 = fs.readFileSync(path.join(outDir, 'INDEX.html'), 'utf8');
    check('8 INDEX.html links the final report once it exists', index2.includes(`${base}.html`));

    // 10. the refactored forward-test.js scores a known card the same way
    const card = {
      id: 1, client_id: 1, location_id: 1, action_type: 'reorder', engine_family: 'stockout',
      primary_skus: ['K1'], reference_upc: null, suggested_order_qty: '12', engine_on_hand: '4',
      engine_daily_rate: '0.5', confidence: '0.42', holding_cost_if_unsold: null, rec_date: '2026-10-01', was_visible: true,
    };
    const days = Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
    const ctx = {
      openDaysAsc: days, windowDays: 7, safetyCoverDays: 7, windowMode: 'fixed',
      units: { K1: { '2026-10-02': 1, '2026-10-04': 1, '2026-10-07': 2 } },
      econ: { K1: { price: 20, cost: 12, margin: 8, name: 'Known', category: 'X' } },
    };
    const r = ft.evaluateCard(card, ctx);
    // 4 on hand + 12 = 16, minus 4 sold = 12 left; safety 0.5*7 = 3.5, 12 > 4.375: overstocked.
    check('10 evaluateCard on a known card: overstocked, 4 sold of 12, 12 left, velocity 1.143, margin 32',
      r.outcome === 'overstocked' && r.actual_sold === 4 && r.simulated_ending_inventory === 12
        && r.velocity_ratio === 1.143 && r.met_forecast_rate === true && r.realised_margin === 32
        && r.window_start === '2026-10-02' && r.window_end === '2026-10-08' && r.variance === -8,
      JSON.stringify({ o: r.outcome, s: r.actual_sold, e: r.simulated_ending_inventory, v: r.velocity_ratio, m: r.realised_margin }));
    const m = ft.calculateConfidenceMetrics([r, { ...r, rec_id: '2', outcome: 'pending', actual_sold: null, velocity_ratio: null, net_impact: null }]);
    check('10 calculateConfidenceMetrics keeps pending out of every denominator',
      m.evaluated === 1 && m.pending === 1 && m.recommendation_accuracy_rate_pct === 0 && m.cards_with_velocity === 1);
    // 11. generation never hangs on one store, and never runs past its budget
    const neverResolves = () => new Promise(() => {});
    const gateOpen = { getStoreQuality: async () => ({ verdict: 'pass' }), storeRefusals: () => [] };
    const gen = await daily.generateIfMissing({
      analytics: pool, asOf: TODAY, log: quiet, recGate: gateOpen,
      locations: [{ clientId: 999923, locationId: 1 }, { clientId: 999923, locationId: 2 }],
      recommendationService: { generateAndPersist: neverResolves },
      storeTimeoutMs: 60, budgetMs: 10 * 60 * 1000,
    });
    check('11 a store that never answers is counted failed with reason timeout, and the job moves on',
      gen.failed === 2 && gen.ok === 0 && gen.failures.every((f) => f.code === 'timeout'), JSON.stringify(gen.failures));
    const gen2 = await daily.generateIfMissing({
      analytics: pool, asOf: TODAY, log: quiet, recGate: gateOpen,
      locations: [{ clientId: 999923, locationId: 1 }, { clientId: 999923, locationId: 2 }, { clientId: 999923, locationId: 3 }],
      recommendationService: { generateAndPersist: async () => { await new Promise((r) => setTimeout(r, 40)); return { runId: 1, recommendation_count: 0 }; } },
      storeTimeoutMs: 1000, budgetMs: -1,   // already exhausted: nothing may start
    });
    check('11 stores not reached inside the budget are counted and named, not silently dropped',
      gen2.budget_exhausted === true && gen2.skipped_budget + gen2.ok === 3 && gen2.skipped_budget >= 1,
      JSON.stringify({ ok: gen2.ok, skipped: gen2.skipped_budget }));
    check('10 the module exports the CLI pieces',
      ['fetchRecommendations', 'openDays', 'dailyUnits', 'unitEconomics', 'evaluateCard', 'calculateConfidenceMetrics',
        'toCsv', 'printSummary', 'CSV_COLS', 'OUTCOMES', 'runForwardTest'].every((k) => ft[k] !== undefined));
  } catch (e) {
    console.error('ERROR', e.stack || e.message);
    failures += 1;
  } finally {
    try { await cleanup(pool); } catch (e) { console.warn('cleanup failed:', e.message); }
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
    await pool.end();
  }
  console.log(`\n${failures ? `${failures} FAILED` : 'ALL PASSED'}`);
  process.exit(failures ? 1 : 0);
})();
