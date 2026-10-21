#!/usr/bin/env node
/**
 * FORWARD TEST, DAILY: generate the day's cards if nobody has, capture what is
 * on the shelf, score every card issued in the test period, persist all of it,
 * and write the day's report.
 *
 *   node scripts/forward-test-daily.js --out ../audit/forward
 *   node scripts/forward-test-daily.js --out ../audit/forward --stores 171,181 --no-generate
 *   node scripts/forward-test-daily.js --out ../audit/forward --final      # 30 Oct
 *
 * Scheduled for 04:00 IST every day of the test period, 2026-10-16 to
 * 2026-10-30 (fifteen mornings), with the final report on the 30th.
 *
 * WHY A DAILY JOB WHEN THE CLI ALREADY MEASURES
 *   scripts/forward-test.js measures correctly and keeps nothing: it reads the
 *   live sales table, so the measurement it makes on the 30th cannot say what
 *   it would have said on the 16th, and it never records what was really on
 *   the shelf on any day in between. The 30 October report has to answer three
 *   things the CLI cannot:
 *
 *     how each card's verdict evolved     (pending on the 16th, scored on the 24th)
 *     what the shelf really held          (observed count beside the simulated one)
 *     which mornings the test really ran  ("15 of 15", or not)
 *
 *   So this job runs the same measurement - the very same functions, imported,
 *   not copied - and writes it down (migration 038). The report is built from
 *   the tables, never from files on disk.
 *
 * THE STEPS, IN THE ORDER THEY RUN, AND WHY GENERATION IS NOT FIRST
 *   1. CAPTURE. For every SKU on any card issued since the period start,
 *      products.stock_qty right now, with the SKU's 28-open-day rate and its
 *      price and cost from the same queries the forward test uses. Inserted
 *      once per day and never overwritten: the row's value is that it was
 *      taken at a known moment.
 *   2. EVALUATE. runForwardTest four times: fixed 7-open-day window and each
 *      card's intended horizon, over the period and over the trailing 30 days
 *      (so cards issued just before the period keep being scored). Each run
 *      is one forward_test_runs row and one forward_test_card_outcomes row per
 *      card.
 *   3. REPORT. audit/forward/daily/<date>/ with the CLI's four files, REPORT.html
 *      and daily.json; audit/forward/INDEX.html rebuilt over every daily folder.
 *      At this point the day's measurement is on disk and in the tables, a
 *      few minutes after 04:00.
 *   4. GENERATE IF MISSING. The server's 04:00 batch (runDailyRecommendationBatch)
 *      is what should issue the day's cards. It did not run on 13, 14 and 15
 *      October because the laptop was asleep, and a test period with a
 *      three-day hole in it is a shorter test period. For every store in scope
 *      with no recommendation_runs row dated today (IST), this applies the SAME
 *      quality gate the batch applies - getStoreQuality + storeRefusals, a
 *      refused store gets no cards and is counted - and calls the same
 *      generateAndPersist. One store failing is logged and counted, never
 *      thrown; one store is given FORWARD_TEST_STORE_TIMEOUT_MS (default 300s)
 *      and the whole step FORWARD_TEST_GENERATE_BUDGET_MS (default 45 min),
 *      because a full pass over ~200 admitted stores takes 40-60 minutes at
 *      three stores a minute and the report must not wait on the slowest one.
 *      --no-generate skips the step (tests, replays).
 *   5. CAPTURE, EVALUATE, REPORT AGAIN, when generation ran, so the cards it
 *      issued and their SKUs' shelf counts are in today's rows and the run
 *      rows carry the generation counters. Both passes are persisted and the
 *      notes say which pass a row belongs to; the final report reads the
 *      latest.
 *   6. FINAL (--final). The whole-period report from the tables: every card's
 *      latest verdict, how many verdicts moved, both modes' metrics, per store,
 *      simulated ending stock beside the observed shelf, and what the test
 *      cannot say.
 *
 * "TODAY" IS ASIA/KOLKATA, SAID IN CODE. The machine happens to run in IST,
 * and the analytics server's session is Asia/Calcutta, so a bare date cast
 * would come out right by accident. The period is defined in IST calendar
 * days and this file says so wherever a day is computed - never UTC midnight,
 * which is 05:30 here and would put a 04:00 run on the previous day.
 *
 * WHAT IS WRITTEN AND WHAT IS NOT. Writes go to the three 038 tables and to
 * recommendation_runs through the service (step a). forward-test.js itself
 * stays read-only. Nothing here is a verdict on the engine: the test assumes
 * every card was accepted in full, and every page it writes says so.
 *
 * Exit code is non-zero only if the whole job fails. One store failing, one
 * SKU without a product row, one run with no cards - each is logged and
 * counted, and the job goes on.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { getPool } = require('../database/connection');
const { getAnalyticsPool } = require('../database/analytics-connection');
const ft = require('./forward-test');

// ── The period, and the tunables ─────────────────────────────────────────────

const TZ = 'Asia/Kolkata';
/** First day cards are captured from. Overridable; the default is the brief. */
const DEFAULT_PERIOD_START = '2026-10-16';
/** The last morning of the period and the day of the final report. */
const DEFAULT_PERIOD_END = '2026-10-30';
/** Stores generated at once in step a - the server's batch uses 5, this is a
 *  second client of the same Python service and must not crowd it out. */
const GENERATE_CONCURRENCY = 3;
/**
 * How long one store's generation may take before the job counts it as failed
 * ('timeout') and moves on. The service's own ceiling is 180s
 * (REC_SERVICE_TIMEOUT_MS) but the first real run of this job sat for thirty
 * minutes on one store's call, so the ceiling is enforced here as well, and
 * the job never waits on a single store. The abandoned call is not cancelled
 * (generateAndPersist has no cancel) - it finishes or fails on its own and the
 * job does not wait for it.
 */
const STORE_TIMEOUT_MS = parseInt(process.env.FORWARD_TEST_STORE_TIMEOUT_MS || '300000', 10);
/**
 * The budget for the whole generation step. Stores not reached when it runs
 * out are counted (`skipped_budget`) with their ids, and the job goes on to
 * capture and evaluate: the day's report must always be written, and a report
 * that says "generation ran out of time at store 140" is worth more than no
 * report. 45 minutes leaves the 04:00 run finished well before trading.
 */
const GENERATE_BUDGET_MS = parseInt(process.env.FORWARD_TEST_GENERATE_BUDGET_MS || String(45 * 60 * 1000), 10);
/** The trailing window of the second pair of runs. */
const TRAILING_DAYS = 30;
/** Scored cards at which a Wilson interval on a ~50% rate narrows to about
 *  +/-10 points - the first point a rate is worth quoting (audit/tuscany/confidence.js). */
const SCORED_CARDS_TARGET = 100;

// ── CLI ──────────────────────────────────────────────────────────────────────

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

// ── Dates, in IST ────────────────────────────────────────────────────────────

/** The calendar day in Asia/Kolkata for an instant. en-CA formats as YYYY-MM-DD. */
function istDay(instant = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

/** 'YYYY-MM-DD' plus n days, as a plain calendar calculation (no timezone). */
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Inclusive count of calendar days from a to b. */
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000) + 1;
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ── Scope ────────────────────────────────────────────────────────────────────

/**
 * Which (client, location) pairs the job works on.
 *   --stores 171,181            client ids; locations looked up
 *   FORWARD_TEST_LOCATIONS      '171:171,181:181' pairs, or bare client ids,
 *                               or ALL
 * Default ALL: every row of client_locations, the same list the server's
 * batch fans out over.
 */
async function resolveLocations(syncgo, recommendationService, storesArg, envRaw) {
  const all = await recommendationService.listAllLocations(syncgo);
  if (storesArg && storesArg.length) {
    return all.filter((l) => storesArg.includes(l.clientId));
  }
  const raw = (envRaw || 'ALL').trim();
  if (raw.toUpperCase() === 'ALL') return all;
  const pairs = [];
  const bare = [];
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (part.includes(':')) {
      const [c, l] = part.split(':').map((n) => parseInt(n, 10));
      if (Number.isInteger(c) && Number.isInteger(l)) pairs.push({ clientId: c, locationId: l });
    } else {
      const c = parseInt(part, 10);
      if (Number.isInteger(c)) bare.push(c);
    }
  }
  return [...pairs, ...all.filter((l) => bare.includes(l.clientId))];
}

// ── Step a: generate if missing ──────────────────────────────────────────────

async function hasRunToday(analytics, clientId, locationId, asOf) {
  const { rows } = await analytics.query(
    `SELECT 1 FROM recommendation_runs
      WHERE client_id = $1 AND location_id = $2
        AND (generated_at AT TIME ZONE '${TZ}')::date = $3::date
      LIMIT 1`,
    [clientId, locationId, asOf]
  );
  return rows.length > 0;
}

/** Cards (any quantity) in runs generated on asOf (IST) across the scope. */
async function cardsGeneratedOn(analytics, stores, asOf) {
  const params = [asOf];
  let scope = '';
  if (stores.length) { params.push(stores); scope = ' AND r.client_id = ANY($2::int[])'; }
  const { rows } = await analytics.query(
    `SELECT count(r.id)::int AS n, count(DISTINCT u.id)::int AS runs
       FROM recommendation_runs u
       JOIN recommendations r ON r.run_id = u.id
      WHERE (u.generated_at AT TIME ZONE '${TZ}')::date = $1::date${scope}`,
    params
  );
  return { cards: rows[0].n, runs: rows[0].runs };
}

/**
 * For every location with no run today: the quality gate, then the service.
 * Mirrors server.js runDailyRecommendationBatch - same gate, same call, same
 * counters - because a card this job generates must be a card the batch
 * would have generated, or the test is measuring a different engine.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} did not finish within ${Math.round(ms / 1000)}s`);
      e.code = 'timeout';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

async function generateIfMissing({ analytics, locations, asOf, log, recommendationService, recGate,
  storeTimeoutMs = STORE_TIMEOUT_MS, budgetMs = GENERATE_BUDGET_MS }) {
  const out = {
    stores_in_scope: locations.length, ok: 0, refused: 0, failed: 0, already: 0, skipped_budget: 0,
    refusals: [], failures: [], generated: [], skipped: [],
    store_timeout_ms: storeTimeoutMs, budget_ms: budgetMs, budget_exhausted: false,
  };
  const started = Date.now();
  let cursor = 0;
  const worker = async () => {
    while (cursor < locations.length) {
      const { clientId, locationId } = locations[cursor++];
      if (Date.now() - started > budgetMs) {
        out.skipped_budget += 1;
        out.skipped.push({ client_id: clientId, location_id: locationId });
        out.budget_exhausted = true;
        continue;
      }
      try {
        if (await hasRunToday(analytics, clientId, locationId, asOf)) {
          out.already += 1;
          continue;
        }
        const quality = await recGate.getStoreQuality(analytics, clientId, locationId);
        const reasons = recGate.storeRefusals(quality);
        if (reasons.length) {
          out.refused += 1;
          out.refusals.push({
            client_id: clientId, location_id: locationId, verdict: quality.verdict, reasons,
            staleness_days: quality.staleness_days ?? null,
          });
          log(`      refused ${clientId}:${locationId} (${quality.verdict}) ${reasons.join(', ')}`);
          continue;
        }
        const res = await withTimeout(
          recommendationService.generateAndPersist(analytics, clientId, locationId),
          storeTimeoutMs, `store ${clientId}:${locationId} generation`);
        out.ok += 1;
        out.generated.push({
          client_id: clientId, location_id: locationId,
          run_id: res?.runId ?? null, cards: res?.recommendation_count ?? null,
        });
        log(`      generated ${clientId}:${locationId} run ${res?.runId ?? '?'} `
          + `(${res?.recommendation_count ?? '?'} cards)`);
      } catch (err) {
        out.failed += 1;
        out.failures.push({
          client_id: clientId, location_id: locationId,
          code: err.code || 'UNKNOWN', status: err.statusCode ?? null, error: err.message,
        });
        log(`      FAILED ${clientId}:${locationId} ${err.code || ''} ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(GENERATE_CONCURRENCY, locations.length) }, worker));
  return out;
}

// ── Step b: capture the shelf ────────────────────────────────────────────────

/** The SKU a card is scored on - the same choice evaluateCard makes. */
const cardSku = (card) => (card.primary_skus || [])[0] || card.reference_upc || null;

/**
 * Current product rows for a store's SKUs, keyed by the SKU the card names
 * (matched on sku or upc, as every forward-test query matches). The location
 * is not in the WHERE for the same reason it is not in forward-test.js: the
 * warehouse keeps one product row per client per SKU.
 */
async function currentProducts(syncgo, clientId, skus) {
  if (!skus.length) return {};
  const { rows } = await syncgo.query(
    `SELECT sku, upc, location_id, stock_qty, price, cost
       FROM products
      WHERE client_id = $1 AND COALESCE(is_deleted, false) = false
        AND (sku = ANY($2::text[]) OR upc = ANY($2::text[]))`,
    [clientId, skus]
  );
  const want = new Set(skus);
  const out = {};
  for (const r of rows) {
    const key = want.has(String(r.sku)) ? String(r.sku)
      : (r.upc && want.has(String(r.upc)) ? String(r.upc) : null);
    if (key && !out[key]) {
      out[key] = { stock_qty: num(r.stock_qty), price: num(r.price), cost: num(r.cost) };
    }
  }
  return out;
}

/**
 * Upsert today's observed count for every SKU on any card issued since
 * periodStart. ON CONFLICT DO NOTHING: an earlier capture for the same day is
 * never overwritten.
 */
async function captureSnapshots({ analytics, syncgo, stores, periodStart, asOf, log, cache }) {
  const cards = await ft.fetchRecommendations(analytics, stores, null, periodStart);
  const byStore = new Map();
  for (const c of cards) {
    const sku = cardSku(c);
    if (!sku) continue;
    const k = `${c.client_id}:${c.location_id}`;
    if (!byStore.has(k)) byStore.set(k, { clientId: c.client_id, locationId: c.location_id, skus: new Set() });
    byStore.get(k).skus.add(String(sku));
  }
  const out = { cards: cards.length, stores: byStore.size, skus: 0, inserted: 0,
    already_captured: 0, without_product: 0, observed_stockouts: 0 };

  for (const { clientId, locationId, skus: skuSet } of byStore.values()) {
    const skus = [...skuSet];
    out.skus += skus.length;
    // The same open-day list, daily units and economics the evaluation uses,
    // fetched once here and left in the shared cache (the shape storeData in
    // forward-test.js expects), so the snapshot's rate and the card's rate
    // agree and the period runs do not query the warehouse a second time.
    const openDaysAsc = await ft.openDays(syncgo, clientId);
    const units = await ft.dailyUnits(syncgo, clientId, skus);
    const econ = await ft.unitEconomics(syncgo, clientId, skus);
    cache.set(clientId, { openDaysAsc, units, econ, skuSet: new Set(skus) });
    const products = await currentProducts(syncgo, clientId, skus);
    const before = openDaysAsc.filter((d) => d <= asOf).slice(-ft.RATE_WINDOW_OPEN_DAYS);

    const values = [];
    const params = [];
    for (const sku of skus) {
      const p = products[sku];
      if (!p) { out.without_product += 1; continue; }
      // NULL rate when nothing can be measured - unknown is not zero.
      let rate = null;
      if (before.length && units[sku]) {
        rate = before.reduce((a, d) => a + (units[sku][d] || 0), 0) / before.length;
        rate = Math.round(rate * 1000) / 1000;
      }
      if (p.stock_qty !== null && p.stock_qty <= 0) out.observed_stockouts += 1;
      const base = params.length;
      params.push(clientId, locationId, sku, asOf, p.stock_qty, rate, p.price, p.cost);
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::date, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`);
    }
    if (!values.length) continue;
    const { rows } = await analytics.query(
      `INSERT INTO forward_test_inventory_snapshots
         (client_id, location_id, sku, snap_date, stock_qty, rate_28d_open_days, price, cost)
       VALUES ${values.join(', ')}
       ON CONFLICT (client_id, location_id, sku, snap_date) DO NOTHING
       RETURNING sku`,
      params
    );
    out.inserted += rows.length;
    out.already_captured += values.length - rows.length;
  }
  log(`      ${out.skus} SKUs on ${out.cards} cards at ${out.stores} store(s): `
    + `${out.inserted} captured, ${out.already_captured} already captured today, `
    + `${out.without_product} without a product row, ${out.observed_stockouts} observed at zero`);
  return out;
}

/** Today's observed counts for the per-card table, keyed client:location:sku. */
async function shelfOn(analytics, stores, snapDate) {
  const params = [snapDate];
  let scope = '';
  if (stores.length) { params.push(stores); scope = ' AND client_id = ANY($2::int[])'; }
  const { rows } = await analytics.query(
    `SELECT client_id, location_id, sku, stock_qty, rate_28d_open_days, captured_at
       FROM forward_test_inventory_snapshots
      WHERE snap_date = $1::date${scope}`,
    params
  );
  const out = {};
  for (const r of rows) {
    out[`${r.client_id}:${r.location_id}:${r.sku}`] = {
      stock_qty: num(r.stock_qty), rate: num(r.rate_28d_open_days), captured_at: r.captured_at,
    };
  }
  return out;
}

// ── Step c: evaluate and persist ─────────────────────────────────────────────

const RUN_PLAN = [
  { label: 'period', windowMode: 'fixed' },
  { label: 'period', windowMode: 'intended' },
  { label: 'trailing30', windowMode: 'fixed' },
  { label: 'trailing30', windowMode: 'intended' },
];

async function persistRun(analytics, { label, run, asOf, periodStart, periodEnd, stores,
  generation, cardsToday, notes }) {
  const { rows, metrics, meta } = run;
  const ins = await analytics.query(
    `INSERT INTO forward_test_runs
       (as_of, label, period_start, period_end, window_mode, window_days, safety_cover_days,
        stores, cards_examined, metrics, generated_cards_today, generation_refused,
        generation_failed, generation, notes)
     VALUES ($1::date, $2, $3::date, $4::date, $5, $6, $7, $8::int[], $9, $10::jsonb, $11, $12, $13,
             $14::jsonb, $15::text[])
     RETURNING id`,
    [asOf, label, periodStart, periodEnd, meta.windowMode, meta.windowDays, meta.safetyCoverDays,
      stores, rows.length, JSON.stringify(metrics), cardsToday,
      generation ? generation.refused : 0, generation ? generation.failed : 0,
      generation ? JSON.stringify(generation) : null, notes]
  );
  const runId = ins.rows[0].id;

  const COLS = ['run_id', 'rec_id', 'client_id', 'location_id', 'rec_date', 'sku',
    'recommended_qty', 'engine_on_hand', 'simulated_start', 'actual_sold',
    'ending_inventory_sim', 'outcome', 'velocity_ratio', 'met_forecast_rate',
    'realised_margin', 'holding_cost', 'net_impact', 'stated_confidence',
    'window_open_days', 'window_closed', 'detail'];
  const CHUNK = 150;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const params = [];
    const values = slice.map((r) => {
      const onHand = r.on_hand_at_rec ?? null;
      const vals = [
        runId, Number(r.rec_id), r.store_id, r.location_id, r.rec_date, r.product_id ?? null,
        r.recommended_qty ?? null, onHand,
        onHand === null || r.recommended_qty === null ? null : onHand + r.recommended_qty,
        r.actual_sold ?? null, r.simulated_ending_inventory ?? null, r.outcome,
        r.velocity_ratio ?? null, r.met_forecast_rate ?? null,
        r.realised_margin ?? null, r.holding_cost ?? null, r.net_impact ?? null,
        r.stated_confidence ?? null, r.window_open_days_requested ?? null,
        !['pending', 'no_data'].includes(r.outcome), JSON.stringify(r),
      ];
      const base = params.length;
      params.push(...vals);
      return `(${vals.map((_, k) => `$${base + k + 1}${k === 4 ? '::date' : k === 20 ? '::jsonb' : ''}`).join(', ')})`;
    });
    await analytics.query(
      `INSERT INTO forward_test_card_outcomes (${COLS.join(', ')}) VALUES ${values.join(', ')}
       ON CONFLICT (run_id, rec_id) DO NOTHING`,
      params
    );
  }
  return runId;
}

async function evaluateAndPersist({ analytics, syncgo, stores, periodStart, asOf, windowDays,
  safetyCoverDays, generation, cardsToday, log, cache, extraNotes = [] }) {
  const runs = [];
  for (const plan of RUN_PLAN) {
    const sinceDate = plan.label === 'period' ? periodStart : addDays(asOf, -TRAILING_DAYS);
    log(`      ${plan.label} / ${plan.windowMode}: cards since ${sinceDate}`);
    const run = await ft.runForwardTest(analytics, syncgo, {
      stores, sinceDate, windowDays, safetyCoverDays, windowMode: plan.windowMode,
      log: () => {}, cache,
    });
    const notes = [...extraNotes];
    if (!run.meta.cards) notes.push('no card in scope carried a suggested order quantity');
    const runId = await persistRun(analytics, {
      label: plan.label, run, asOf, periodStart: sinceDate, periodEnd: asOf, stores,
      generation, cardsToday, notes,
    });
    const m = run.metrics;
    log(`        run ${runId}: ${run.rows.length} cards, ${m.evaluated} scored, ${m.pending} pending, `
      + `${m.no_data} no-data; RAR ${m.recommendation_accuracy_rate_pct ?? 'n/a'}%`);
    runs.push({ ...plan, runId, sinceDate, ...run, payload: ft.buildPayload(run) });
  }
  return runs;
}

// ── The confidence score ─────────────────────────────────────────────────────
//
// A PRODUCT of two halves, after audit/tuscany/confidence.js, which cannot be
// imported here because its performance half reads a backtest (forecast skill
// against trailing-28, interval coverage, a reversion-matched null) that this
// test does not run. The shape is kept exactly, and the reason too:
//
//     MEASURED PERFORMANCE   what the forward test says, where it says anything
//     EVIDENCE SUFFICIENCY   how much forward test there actually is
//     score = performance x sufficiency
//
// A product, not an average. On day one of a fifteen-day period almost every
// card is pending, and an average would let a good-looking number on three
// scored cards read as "the engine is 60% reliable". A product collapses toward
// zero when the evidence is thin, which is the honest reading: we do not know
// yet, and not knowing is not a middling result. Both halves are printed on
// every page so a low score is never mistaken for a bad engine.
//
// EVERY COMPONENT NAMES ITS BAR, and a component with nothing behind it is
// omitted rather than scored 50: a missing measurement is not a mediocre one.

function forwardConfidence({ fixed, intended, dailyRuns, periodDays, shelfCovered }) {
  const fm = fixed.metrics;
  const im = intended.metrics;
  const perf = [];

  // 1. Velocity accuracy. Did the product move at the pace the engine said?
  //    The median velocity ratio is the one figure that does not depend on
  //    the window length. 1.0 scores 100; a factor of two off in either
  //    direction (0.5 or 2.0) scores 50; a factor of four scores 0.
  if (fm.median_velocity_ratio !== null && fm.median_velocity_ratio > 0) {
    const off = Math.abs(Math.log2(fm.median_velocity_ratio));
    perf.push({
      key: 'velocity_accuracy', label: 'Velocity accuracy (fixed window)',
      score: clamp(100 - off * 50),
      detail: `median velocity ratio ${fm.median_velocity_ratio} on ${fm.cards_with_velocity} cards `
        + '(1.00 = sold exactly at the predicted rate scores 100; 0.50 or 2.00 scores 50)',
    });
  }

  // 2. Calibration. A card that said 0.4 should meet its rate about four times
  //    in ten. The card-weighted mean absolute gap between stated and observed,
  //    in points; two points of score per point of gap.
  const bands = fm.calibration.filter((b) => b.cards > 0 && b.observed_met_rate_pct !== null);
  if (bands.length) {
    const n = bands.reduce((a, b) => a + b.cards, 0);
    const gap = bands.reduce((a, b) => a + b.cards * Math.abs(b.stated_mean * 100 - b.observed_met_rate_pct), 0) / n;
    perf.push({
      key: 'calibration', label: 'Calibration of stated confidence',
      score: clamp(100 - gap * 2),
      detail: `stated confidence sits ${r1(gap)} points from the observed met-forecast rate, `
        + `card-weighted over ${bands.length} band(s) and ${n} cards (2 points of score per point)`,
    });
  }

  // 3. Order sizing. The share of scored cards that were neither waste
  //    (overstocked), nor shortfall (understocked), nor dead (unutilized).
  //    Read from the INTENDED run when it has scored cards - that is the test
  //    of the quantity over the horizon the engine chose - and from the fixed
  //    run otherwise, named either way.
  const src = im.evaluated > 0 ? { m: im, name: 'intended horizon' } : { m: fm, name: 'fixed window' };
  if (src.m.evaluated > 0) {
    const good = (src.m.counts.successful || 0) + (src.m.counts.partial_absorption || 0);
    perf.push({
      key: 'order_sizing', label: `Order sizing (${src.name})`,
      score: clamp((good / src.m.evaluated) * 100),
      detail: `${good} of ${src.m.evaluated} scored cards were neither overstocked, understocked `
        + `nor unutilized (${src.m.counts.overstocked} over, ${src.m.counts.understocked} under, `
        + `${src.m.counts.unutilized} dead)`,
    });
  }

  // 4. Money. The share of cards with known unit economics whose realised
  //    margin exceeded the holding cost of what sat.
  // `!= null`: a pending or no_data row never had the key set, and undefined
  // must read as "no money figure" exactly as null does - the first real run
  // counted 286 pending cards as 286 cards that did not pay for themselves.
  const money = fixed.rows.filter((r) => r.net_impact != null);
  if (money.length) {
    const pos = money.filter((r) => r.net_impact > 0).length;
    perf.push({
      key: 'money', label: 'Cards that paid for themselves',
      score: clamp((pos / money.length) * 100),
      detail: `${pos} of ${money.length} cards with known economics had realised margin above `
        + `holding cost (net ${fmtMoney(fm.net_financial_impact)} over the fixed window)`,
    });
  }

  const suff = [
    {
      key: 'scored_cards', label: 'Cards with a measured outcome',
      score: clamp((fm.evaluated / SCORED_CARDS_TARGET) * 100),
      detail: `${fm.evaluated} scored cards against the ${SCORED_CARDS_TARGET} at which a rate `
        + 'first narrows enough to quote',
    },
    {
      key: 'closed_windows', label: 'Fixed windows closed',
      score: fixed.rows.length ? clamp((fm.evaluated / fixed.rows.length) * 100) : 0,
      detail: fixed.rows.length
        ? `${fm.evaluated} of ${fixed.rows.length} cards have a closed 7-open-day window`
        : 'no card in the period carries a quantity',
    },
    {
      key: 'intended_closed', label: 'Intended horizons closed',
      score: intended.rows.length ? clamp((im.evaluated / intended.rows.length) * 100) : 0,
      detail: intended.rows.length
        ? `${im.evaluated} of ${intended.rows.length} cards have lived through the cover they were sized for`
        : 'no card in the period carries a quantity',
    },
    {
      key: 'period_coverage', label: 'Mornings of the period run',
      score: clamp((dailyRuns / periodDays) * 100),
      detail: `${dailyRuns} of ${periodDays} daily runs have happened`,
    },
    {
      key: 'shelf_observed', label: 'Cards with an observed shelf count today',
      score: fixed.rows.length ? clamp((shelfCovered / fixed.rows.length) * 100) : 0,
      detail: `${shelfCovered} of ${fixed.rows.length} cards have a captured stock_qty for today`,
    },
  ];

  const p = mean(perf.map((c) => c.score));
  const s = mean(suff.map((c) => c.score));
  const engine = p === null ? 0 : (p / 100) * s;
  return {
    definition: 'score = measured performance x evidence sufficiency (a product, not an average); '
      + 'both halves are printed; a component with no measurement behind it is omitted, never scored 50',
    performance: { components: perf, score: r1(p), note: perf.length ? null
      : 'no scored card yet, so no performance can be measured' },
    sufficiency: { components: suff, score: r1(s) },
    engine_confidence: r1(engine),
    band: engine >= 70 ? 'high' : engine >= 40 ? 'moderate' : engine >= 15 ? 'low' : 'insufficient evidence',
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? 'n/a'
  : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtPct = (v, d = 1) => (v === null || v === undefined ? 'n/a' : `${Number(v).toFixed(d)}%`);
function fmtMoney(v) {
  if (v === null || v === undefined) return 'n/a';
  return `${v < 0 ? '-' : ''}$${Math.abs(Number(v)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
const ci = (pair) => (pair && pair[0] !== null ? `${pair[0]} to ${pair[1]}` : 'n/a');

const OUTCOME_LABEL = {
  successful: 'Successful restock',
  partial_absorption: 'Partial absorption',
  overstocked: 'Overstocked (waste)',
  understocked: 'Understocked (missed)',
  unutilized: 'Unutilized (dead)',
  no_data: 'No data (not a verdict)',
  pending: 'Pending (window open)',
};

const PAGE_CSS = `body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#1a1713;background:#fbfaf7;max-width:1400px}
h1{font-size:24px;margin:0 0 6px}h2{font-size:17px;margin:34px 0 8px;border-bottom:1px solid #dfdad0;padding-bottom:4px}
h3{font-size:14px;margin:18px 0 6px}p{max-width:84ch}
table{border-collapse:collapse;width:100%;margin:8px 0 14px}th,td{text-align:left;padding:5px 9px;border-bottom:1px solid #e6e1d8;vertical-align:top;font-size:13px}
th{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#6f675b;white-space:nowrap}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:#6f675b}.tiles{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0}.tile{border:1px solid #dfdad0;border-radius:6px;padding:10px 14px;min-width:170px;background:#fff}
.tile b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.tile span{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6f675b}
.score{font-size:40px;font-weight:700;font-variant-numeric:tabular-nums}.band{font-size:13px;color:#6f675b;margin-left:8px}
.warn{background:#fff6e5;border:1px solid #e9d4a3;padding:10px 14px;border-radius:6px;max-width:84ch}
tr.pending td{color:#8a8277}tr.so td.so{color:#9b2c1a;font-weight:600}.small{font-size:12px}details summary{cursor:pointer;color:#6f675b}`;

function metricsTable(runs) {
  const row = (label, fn) => `<tr><td>${label}</td>${runs.map((r) => `<td class="n">${fn(r.metrics, r)}</td>`).join('')}</tr>`;
  return `<table><thead><tr><th>Metric</th>${runs.map((r) => `<th class="n">${esc(r.label)} / ${esc(r.windowMode)}<br><span class="muted">${r.windowMode === 'intended' ? "each card's own cover" : `${r.meta.windowDays} open days`}, since ${r.sinceDate}</span></th>`).join('')}</tr></thead><tbody>
${row('Cards examined', (m, r) => fmt(r.rows.length))}
${row('Scored (window closed)', (m) => fmt(m.evaluated))}
${row('Pending (window open)', (m) => fmt(m.pending))}
${row('No data (not a verdict)', (m) => fmt(m.no_data))}
${row('Recommendation Accuracy Rate', (m) => (m.evaluated ? `${fmtPct(m.recommendation_accuracy_rate_pct)} <span class="muted small">95% CI ${ci(m.rar_ci95)}, n=${m.evaluated}</span>` : 'n/a'))}
${row('Met-forecast rate', (m) => (m.cards_with_velocity ? `${fmtPct(m.met_forecast_rate_pct)} <span class="muted small">95% CI ${ci(m.met_forecast_rate_ci95)}, n=${m.cards_with_velocity}</span>` : 'n/a'))}
${row('Median velocity ratio', (m) => (m.median_velocity_ratio === null ? 'n/a' : fmt(m.median_velocity_ratio, 3)))}
${row('Inventory Turnover Efficiency', (m) => (m.inventory_turnover_efficiency === null ? 'n/a' : `${fmt(m.inventory_turnover_efficiency, 3)} <span class="muted small">${fmt(m.units_sold)} of ${fmt(m.units_recommended)} units</span>`))}
${row('Realised margin', (m) => (m.evaluated ? fmtMoney(m.realised_margin) : 'n/a'))}
${row('Holding cost of what sat', (m) => (m.evaluated ? fmtMoney(m.holding_cost) : 'n/a'))}
${row('Net financial impact', (m) => (m.evaluated ? `${fmtMoney(m.net_financial_impact)} <span class="muted small">on ${m.cards_with_money} cards</span>` : 'n/a'))}
${row('Stockout-simulatable', (m) => `${fmt(m.simulatable)} of ${fmt(m.evaluated)}`)}
</tbody></table>`;
}

function outcomeTable(runs) {
  return `<table><thead><tr><th>Outcome</th>${runs.map((r) => `<th class="n">${esc(r.label)} / ${esc(r.windowMode)}</th>`).join('')}</tr></thead><tbody>
${ft.OUTCOMES.map((o) => `<tr${o === 'pending' ? ' class="pending"' : ''}><td>${OUTCOME_LABEL[o]}</td>${runs.map((r) => {
    const n = r.metrics.counts[o] || 0;
    const share = r.metrics.evaluated && !['pending', 'no_data'].includes(o)
      ? ` <span class="muted small">${(n / r.metrics.evaluated * 100).toFixed(1)}% of scored</span>` : '';
    return `<td class="n">${n}${share}</td>`;
  }).join('')}</tr>`).join('\n')}
</tbody></table>`;
}

function calibrationTable(m) {
  const rows = m.calibration.filter((c) => c.cards > 0);
  if (!rows.length) return '<p class="muted">No scored card carries a stated confidence yet.</p>';
  return `<table><thead><tr><th>Stated band</th><th class="n">Cards</th><th class="n">Stated mean</th><th class="n">Observed met-forecast rate</th><th class="n">95% CI</th></tr></thead><tbody>
${rows.map((c) => `<tr><td>${c.band}</td><td class="n">${c.cards}</td><td class="n">${c.stated_mean}</td><td class="n">${fmtPct(c.observed_met_rate_pct)}</td><td class="n">${ci(c.ci95)}</td></tr>`).join('\n')}
</tbody></table>`;
}

function confidenceSection(conf) {
  const comp = (cs) => (cs.length ? `<table><thead><tr><th>Component</th><th class="n">Score</th><th>What it measured, against what bar</th></tr></thead><tbody>
${cs.map((c) => `<tr><td>${esc(c.label)}</td><td class="n">${fmt(c.score, 1)}</td><td class="small">${esc(c.detail)}</td></tr>`).join('\n')}</tbody></table>`
    : '<p class="muted">Nothing measurable yet.</p>');
  return `<p><span class="score">${fmt(conf.engine_confidence, 1)}</span><span class="band">/ 100, ${esc(conf.band)}</span></p>
<p><b>Definition.</b> Engine Confidence Score = <b>Measured performance</b> (${fmt(conf.performance.score, 1)}) x <b>Evidence sufficiency</b> (${fmt(conf.sufficiency.score, 1)}) / 100.
It is a product, not an average: a strong-looking performance on almost no evidence collapses toward zero, because we do not know yet, and not knowing is not a middling result.
A low score here does not say the engine performs badly. It says the test cannot yet claim that it performs well. Both halves are printed so that cannot be misread.
A component with no measurement behind it is left out, never scored 50.</p>
<h3>Measured performance: ${fmt(conf.performance.score, 1)}</h3>${conf.performance.note ? `<p class="muted">${esc(conf.performance.note)}</p>` : ''}${comp(conf.performance.components)}
<h3>Evidence sufficiency: ${fmt(conf.sufficiency.score, 1)}</h3>${comp(conf.sufficiency.components)}`;
}

/** Per-store aggregates over one run's rows. */
function perStore(rows, names) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.store_id}:${r.location_id}`;
    if (!by.has(k)) by.set(k, { store_id: r.store_id, location_id: r.location_id, rows: [] });
    by.get(k).rows.push(r);
  }
  return [...by.values()].sort((a, b) => a.store_id - b.store_id).map((s) => {
    const m = ft.calculateConfidenceMetrics(s.rows);
    return { ...s, name: names[s.store_id] || null, metrics: m, cards: s.rows.length };
  });
}

function storeTable(stores, intendedRows) {
  const intendedBy = new Map();
  for (const r of intendedRows) {
    const k = `${r.store_id}:${r.location_id}`;
    const e = intendedBy.get(k) || { scored: 0, ok: 0 };
    if (!['pending', 'no_data'].includes(r.outcome)) { e.scored += 1; if (r.outcome === 'successful') e.ok += 1; }
    intendedBy.set(k, e);
  }
  if (!stores.length) return '<p class="muted">No store has a card with a quantity in the period.</p>';
  return `<table><thead><tr><th>Store</th><th class="n">Cards</th><th class="n">Scored</th><th class="n">Pending</th><th class="n">RAR (fixed)</th><th class="n">Met-forecast</th><th class="n">Median velocity</th><th class="n">ITE</th><th class="n">Net impact</th><th class="n">Intended: ok / scored</th></tr></thead><tbody>
${stores.map((s) => {
    const m = s.metrics;
    const i = intendedBy.get(`${s.store_id}:${s.location_id}`) || { scored: 0, ok: 0 };
    return `<tr><td>${s.store_id}${s.name ? ` <span class="muted">${esc(s.name)}</span>` : ''}</td><td class="n">${s.cards}</td><td class="n">${m.evaluated}</td><td class="n">${m.pending}</td>`
      + `<td class="n">${m.evaluated ? `${fmtPct(m.recommendation_accuracy_rate_pct)} <span class="muted small">[${ci(m.rar_ci95)}]</span>` : 'n/a'}</td>`
      + `<td class="n">${m.cards_with_velocity ? fmtPct(m.met_forecast_rate_pct) : 'n/a'}</td>`
      + `<td class="n">${m.median_velocity_ratio === null ? 'n/a' : fmt(m.median_velocity_ratio, 3)}</td>`
      + `<td class="n">${m.inventory_turnover_efficiency === null ? 'n/a' : fmt(m.inventory_turnover_efficiency, 3)}</td>`
      + `<td class="n">${m.evaluated ? fmtMoney(m.net_financial_impact) : 'n/a'}</td>`
      + `<td class="n">${i.ok} / ${i.scored}</td></tr>`;
  }).join('\n')}
</tbody></table>`;
}

function cardTable(fixedRows, intendedRows, shelf, names, { extraCols = [] } = {}) {
  const intendedBy = new Map(intendedRows.map((r) => [r.rec_id, r]));
  const sorted = [...fixedRows].sort((a, b) => (a.rec_date < b.rec_date ? -1 : a.rec_date > b.rec_date ? 1
    : a.store_id - b.store_id || Number(a.rec_id) - Number(b.rec_id)));
  return `<table class="small"><thead><tr><th>Rec</th><th>Store</th><th>SKU</th><th>Product</th><th>Rec date</th><th class="n">Recommended</th><th class="n">Sold</th><th class="n">Ending sim</th><th class="n">Shelf today</th><th>Outcome (fixed 7)</th><th>Outcome (intended)</th><th class="n">Variance</th><th class="n">Velocity</th><th class="n">Confidence</th>${extraCols.map((c) => `<th class="n">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>
${sorted.map((r) => {
    const s = shelf[`${r.store_id}:${r.location_id}:${r.product_id}`];
    const i = intendedBy.get(r.rec_id);
    const stockout = s && s.stock_qty !== null && s.stock_qty <= 0;
    return `<tr${r.outcome === 'pending' ? ' class="pending"' : ''} title="${esc(r.reason || '')}">`
      + `<td>${r.rec_id}</td><td>${r.store_id}${names[r.store_id] ? ` <span class="muted">${esc(names[r.store_id])}</span>` : ''}</td>`
      + `<td>${esc(r.product_id)}</td><td>${esc(r.product_name || '')}</td><td>${r.rec_date}</td>`
      + `<td class="n">${fmt(r.recommended_qty)}</td><td class="n">${r.actual_sold === null || r.actual_sold === undefined ? 'n/a' : fmt(r.actual_sold)}</td>`
      + `<td class="n">${r.simulated_ending_inventory === null || r.simulated_ending_inventory === undefined ? 'n/a' : fmt(r.simulated_ending_inventory)}</td>`
      + `<td class="n${stockout ? ' so' : ''}">${s ? (s.stock_qty === null ? 'n/a' : fmt(s.stock_qty)) : 'not captured'}</td>`
      + `<td>${esc(r.outcome)}</td><td>${i ? esc(i.outcome) : 'n/a'}</td>`
      + `<td class="n">${r.variance === null || r.variance === undefined ? 'n/a' : fmt(r.variance)}</td>`
      + `<td class="n">${r.velocity_ratio === null || r.velocity_ratio === undefined ? 'n/a' : fmt(r.velocity_ratio, 2)}</td>`
      + `<td class="n">${r.stated_confidence === null ? 'n/a' : fmt(r.stated_confidence, 3)}</td>`
      + extraCols.map((c) => `<td class="n">${c.fn(r, s, i)}</td>`).join('')
      + '</tr>';
  }).join('\n')}
</tbody></table>`;
}

function generationSection(generation, cardsToday) {
  if (!generation) {
    return `<div class="tiles"><div class="tile"><b>skipped</b><span>generate if missing</span></div>`
      + `<div class="tile"><b>${fmt(cardsToday?.cards)}</b><span>cards generated today (IST)</span></div></div>`
      + '<p class="muted">Generation was skipped (--no-generate); the day\'s cards are whatever the server\'s 04:00 batch issued.</p>';
  }
  const g = generation;
  return `<div class="tiles">
<div class="tile"><b>${fmt(cardsToday?.cards)}</b><span>cards generated today (IST)</span></div>
<div class="tile"><b>${g.ok}</b><span>stores generated by this job</span></div>
<div class="tile"><b>${g.already}</b><span>stores already had today's run</span></div>
<div class="tile"><b>${g.refused}</b><span>refused by the quality gate</span></div>
<div class="tile"><b>${g.failed}</b><span>failed (incl. timeouts)</span></div>
<div class="tile"><b>${g.skipped_budget || 0}</b><span>not reached in the time budget</span></div>
<div class="tile"><b>${g.stores_in_scope}</b><span>stores in scope</span></div></div>
${g.step_error ? `<p class="warn"><b>The generation step itself failed:</b> ${esc(g.step_error)}. No store was generated by this job today; the counts below are what the server's own batch produced.</p>` : ''}
${g.budget_exhausted ? `<p class="warn">The generation budget (${Math.round(g.budget_ms / 60000)} min) ran out with ${g.skipped_budget} store(s) unreached: ${g.skipped.map((s) => `${s.client_id}:${s.location_id}`).join(', ')}. They have no cards today unless the server's batch issued them.</p>` : ''}
${g.refusals.length ? `<details><summary>${g.refusals.length} store(s) refused, with reasons</summary><table class="small"><thead><tr><th>Store</th><th>Verdict</th><th>Reasons</th><th class="n">Staleness (days)</th></tr></thead><tbody>
${g.refusals.map((r) => `<tr><td>${r.client_id}:${r.location_id}</td><td>${esc(r.verdict)}</td><td>${esc(r.reasons.join(', '))}</td><td class="n">${r.staleness_days === null ? 'n/a' : fmt(r.staleness_days, 1)}</td></tr>`).join('\n')}</tbody></table></details>` : ''}
${g.failures.length ? `<details open><summary>${g.failures.length} store(s) failed</summary><table class="small"><thead><tr><th>Store</th><th>Code</th><th>Error</th></tr></thead><tbody>
${g.failures.map((r) => `<tr><td>${r.client_id}:${r.location_id}</td><td>${esc(r.code)}${r.status ? ` (${r.status})` : ''}</td><td>${esc(r.error)}</td></tr>`).join('\n')}</tbody></table></details>` : ''}`;
}

// ── Step d: the day's report and the index ───────────────────────────────────

/** Count the daily folders that hold a daily.json (the mornings the job ran). */
function listDailyRuns(outDir) {
  const dir = path.join(outDir, 'daily');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(dir, d, 'daily.json')))
    .sort()
    .map((d) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, d, 'daily.json'), 'utf8')); } catch (e) { return { as_of: d, unreadable: e.message }; }
    });
}

async function storeNames(syncgo, stores) {
  try {
    const params = [];
    let where = '';
    if (stores.length) { params.push(stores); where = ' WHERE client_id = ANY($1::int[])'; }
    const { rows } = await syncgo.query(`SELECT client_id, location_name FROM client_locations${where}`, params);
    const out = {};
    for (const r of rows) out[r.client_id] = r.location_name;
    return out;
  } catch (e) {
    return {};
  }
}

function writeDailyReport({ outDir, asOf, periodStart, periodEnd, runs, generation, cardsToday,
  capture, shelf, names, dailyRunsSoFar, pass = null }) {
  const dayDir = path.join(outDir, 'daily', asOf);
  fs.mkdirSync(dayDir, { recursive: true });

  for (const r of runs) {
    const stamp = ft.fileStamp(r.windowMode, r.meta.windowDays) + (r.label === 'trailing30' ? '_trailing30' : '');
    fs.writeFileSync(path.join(dayDir, `forward_test_${stamp}.json`), JSON.stringify(r.payload, null, 2));
    fs.writeFileSync(path.join(dayDir, `forward_test_${stamp}.csv`), '﻿' + ft.toCsv(r.rows));
  }

  const fixed = runs.find((r) => r.label === 'period' && r.windowMode === 'fixed');
  const intended = runs.find((r) => r.label === 'period' && r.windowMode === 'intended');
  const periodDays = daysBetween(periodStart, periodEnd);
  const shelfCovered = fixed.rows.filter((r) => shelf[`${r.store_id}:${r.location_id}:${r.product_id}`]).length;
  const conf = forwardConfidence({ fixed, intended, dailyRuns: dailyRunsSoFar, periodDays, shelfCovered });
  const stores = perStore(fixed.rows, names);
  const observedStockouts = fixed.rows.filter((r) => {
    const s = shelf[`${r.store_id}:${r.location_id}:${r.product_id}`];
    return s && s.stock_qty !== null && s.stock_qty <= 0;
  }).length;

  const headline = {
    as_of: asOf, period_start: periodStart, period_end: periodEnd,
    daily_run_number: dailyRunsSoFar, period_days: periodDays, pass,
    generation: generation ? {
      ok: generation.ok, refused: generation.refused, failed: generation.failed,
      already: generation.already, stores_in_scope: generation.stores_in_scope,
    } : null,
    cards_generated_today: cardsToday ? cardsToday.cards : null,
    capture,
    runs: runs.map((r) => ({
      label: r.label, window_mode: r.windowMode, run_id: r.runId, since: r.sinceDate,
      cards: r.rows.length, scored: r.metrics.evaluated, pending: r.metrics.pending,
      no_data: r.metrics.no_data,
      rar_pct: r.metrics.recommendation_accuracy_rate_pct, rar_ci95: r.metrics.rar_ci95,
      met_forecast_rate_pct: r.metrics.met_forecast_rate_pct,
      median_velocity_ratio: r.metrics.median_velocity_ratio,
      ite: r.metrics.inventory_turnover_efficiency,
      net_financial_impact: r.metrics.net_financial_impact,
      counts: r.metrics.counts,
    })),
    confidence: conf,
    observed_stockouts_on_cards: observedStockouts,
    shelf_covered_cards: shelfCovered,
  };
  fs.writeFileSync(path.join(dayDir, 'daily.json'), JSON.stringify(headline, null, 2));

  const fm = fixed.metrics;
  const html = `<!doctype html><meta charset="utf-8"><title>Forward test, ${asOf}</title>
<style>${PAGE_CSS}</style>
<h1>Forward test, daily run for ${asOf}</h1>
<p class="muted">Test period ${periodStart} to ${periodEnd} (${periodDays} mornings, 04:00 IST). This is daily run ${dailyRunsSoFar} of ${periodDays}.
Written ${new Date().toISOString()} by scripts/forward-test-daily.js${pass ? ` (${esc(pass)} pass${pass === 'pre-generation' ? ': the cards that existed when the job started; a second pass follows generation and replaces this page' : ': includes the cards this job generated today'})` : ''}; every figure is read from the forward_test_* tables written this morning, never retyped.</p>
<div class="warn"><b>Assumption, stated once and everywhere:</b> every card is treated as accepted and ordered in full. Demand is observed (sale_items, unchanged); the inventory trajectory is simulated (engine_on_hand + recommended qty, depleted by real daily units). A window is counted in OPEN days, never calendar days. A pending card is not a failed one and sits in no denominator. Absence is never zero.</div>

<h2>Today's counters</h2>
${generationSection(generation, cardsToday)}
<div class="tiles">
<div class="tile"><b>${fmt(capture.inserted)}</b><span>shelf counts captured today</span></div>
<div class="tile"><b>${fmt(capture.already_captured)}</b><span>already captured today</span></div>
<div class="tile"><b>${fmt(capture.without_product)}</b><span>SKUs with no product row</span></div>
<div class="tile"><b>${fmt(capture.observed_stockouts)}</b><span>SKUs observed at zero</span></div>
<div class="tile"><b>${fmt(fixed.rows.length)}</b><span>cards in the period</span></div>
<div class="tile"><b>${fmt(fm.evaluated)}</b><span>scored at 7 open days</span></div>
<div class="tile"><b>${fmt(fm.pending)}</b><span>pending at 7 open days</span></div>
</div>

<h2>Engine Confidence Score</h2>
${confidenceSection(conf)}

<h2>The four metrics, per run</h2>
<p>Two window modes over two periods. <b>fixed</b> gives every card the same 7-open-day window: comparable, but a reorder sized for three weeks cannot sell through in one, so read velocity and turnover there, not the success rate. <b>intended</b> gives each card the horizon the engine sized it for, which is the honest test of the quantity and is why most of its cards stay pending for weeks. <b>period</b> is cards issued since ${periodStart}; <b>trailing30</b> is cards issued since ${runs.find((r) => r.label === 'trailing30').sinceDate}, so earlier cards keep being scored.</p>
${metricsTable(runs)}

<h2>Outcome breakdown</h2>
${outcomeTable(runs)}

<h2>Calibration (period, fixed window)</h2>
<p>Stated confidence against how often the SKU met its own predicted rate. Scored against the met-forecast rate rather than "successful" because the latter is unreachable whenever the window is shorter than the cover, and a table of zeroes would indict the engine for the measurement's own flaw.</p>
${calibrationTable(fm)}

<h2>Per store (period, fixed window; intended in the last column)</h2>
${storeTable(stores, intended.rows)}

<h2>Per card (period: every card issued since ${periodStart})</h2>
<p>"Shelf today" is the observed products.stock_qty captured this morning (forward_test_inventory_snapshots), beside the simulated ending inventory; a count at or below zero is an observed stockout and is marked. Hover a row for the classification's reason. ${observedStockouts} card(s) have an observed stockout today.</p>
${cardTable(fixed.rows, intended.rows, shelf, names)}
<p class="muted small">Files in this folder: forward_test_w${fixed.meta.windowDays}.json/.csv and forward_test_intended.json/.csv (period), the same with _trailing30 (trailing ${TRAILING_DAYS} days), daily.json (this page's headline numbers). Database rows: forward_test_runs ${runs.map((r) => r.runId).join(', ')}.</p>
`;
  fs.writeFileSync(path.join(dayDir, 'REPORT.html'), html);
  return { dayDir, headline, conf };
}

function writeIndex(outDir, { periodStart, periodEnd }) {
  const days = listDailyRuns(outDir).reverse();
  const periodDays = daysBetween(periodStart, periodEnd);
  const inPeriod = days.filter((d) => d.as_of >= periodStart && d.as_of <= periodEnd).length;
  const finalName = `FINAL_REPORT_${periodStart}_to_${periodEnd}.html`;
  const hasFinal = fs.existsSync(path.join(outDir, finalName));
  const fixedOf = (d) => (d.runs || []).find((r) => r.label === 'period' && r.window_mode === 'fixed') || {};
  const intOf = (d) => (d.runs || []).find((r) => r.label === 'period' && r.window_mode === 'intended') || {};
  const html = `<!doctype html><meta charset="utf-8"><title>Forward test, daily index</title>
<style>${PAGE_CSS}</style>
<h1>Forward test, daily runs</h1>
<p>Test period <b>${periodStart} to ${periodEnd}</b> (${periodDays} mornings at 04:00 IST). <b>${inPeriod} of ${periodDays}</b> daily runs have happened${days.length > inPeriod ? ` (${days.length - inPeriod} more outside the period)` : ''}.
Every run assumes each card was accepted in full; demand is observed, the inventory trajectory is simulated. Newest first.
${hasFinal ? `The final report for the whole period is <a href="${finalName}">${finalName}</a>.` : 'The final report is written on the last day of the period (--final).'}</p>
<table><thead><tr><th>Day</th><th class="n">Run</th><th class="n">Generated / refused / failed</th><th class="n">Shelf captured</th><th class="n">Cards</th><th class="n">Scored</th><th class="n">Pending</th><th class="n">RAR (fixed 7)</th><th class="n">Met-forecast</th><th class="n">Median velocity</th><th class="n">ITE</th><th class="n">Net impact</th><th class="n">Intended scored</th><th class="n">Confidence</th><th>Open</th></tr></thead><tbody>
${days.map((d) => {
    const f = fixedOf(d); const i = intOf(d); const g = d.generation;
    return `<tr><td>${d.as_of}</td><td class="n">${d.daily_run_number ?? ''} of ${d.period_days ?? periodDays}</td>`
      + `<td class="n">${g ? `${g.ok} / ${g.refused} / ${g.failed}` : 'skipped'}</td>`
      + `<td class="n">${d.capture ? fmt(d.capture.inserted + d.capture.already_captured) : 'n/a'}</td>`
      + `<td class="n">${fmt(f.cards)}</td><td class="n">${fmt(f.scored)}</td><td class="n">${fmt(f.pending)}</td>`
      + `<td class="n">${f.scored ? `${fmtPct(f.rar_pct)} <span class="muted small">[${ci(f.rar_ci95)}]</span>` : 'n/a'}</td>`
      + `<td class="n">${f.met_forecast_rate_pct === null || f.met_forecast_rate_pct === undefined ? 'n/a' : fmtPct(f.met_forecast_rate_pct)}</td>`
      + `<td class="n">${f.median_velocity_ratio === null || f.median_velocity_ratio === undefined ? 'n/a' : fmt(f.median_velocity_ratio, 3)}</td>`
      + `<td class="n">${f.ite === null || f.ite === undefined ? 'n/a' : fmt(f.ite, 3)}</td>`
      + `<td class="n">${f.scored ? fmtMoney(f.net_financial_impact) : 'n/a'}</td>`
      + `<td class="n">${fmt(i.scored)} of ${fmt(i.cards)}</td>`
      + `<td class="n">${d.confidence ? `${fmt(d.confidence.engine_confidence, 1)} <span class="muted small">(${fmt(d.confidence.performance.score, 1)} x ${fmt(d.confidence.sufficiency.score, 1)})</span>` : 'n/a'}</td>`
      + `<td><a href="daily/${d.as_of}/REPORT.html">report</a> · <a href="daily/${d.as_of}/forward_test_w7.json">json</a> · <a href="daily/${d.as_of}/forward_test_w7.csv">csv</a></td></tr>`;
  }).join('\n')}
</tbody></table>
<p class="muted small">Confidence is measured performance x evidence sufficiency, both shown in brackets; see any day's report for the components and their bars. Also in this folder: forward_test_w7.{json,csv} and forward_test_intended.json from the first manual run on 2026-10-15.</p>
`;
  fs.writeFileSync(path.join(outDir, 'INDEX.html'), html);
  return { days: days.length, inPeriod };
}

// ── Step e: the final report ─────────────────────────────────────────────────

/**
 * Everything the final report needs, from the tables. `upTo` bounds as_of so
 * a replay after the period reads the period's last run, not a later one.
 */
async function loadPeriodFromDb(analytics, { periodStart, periodEnd, stores, upTo }) {
  const scope = stores.length ? 'AND stores = $4::int[]' : "AND stores = '{}'::int[]";
  const params = [periodStart, periodEnd, upTo];
  if (stores.length) params.push(stores);
  const { rows: runRows } = await analytics.query(
    `SELECT id, ran_at, as_of, label, window_mode, window_days, cards_examined, metrics,
            generated_cards_today, generation_refused, generation_failed, generation, notes
       FROM forward_test_runs
      WHERE label = 'period' AND period_start = $1::date AND as_of BETWEEN $1::date AND $2::date
        AND as_of <= $3::date ${scope}
      ORDER BY ran_at`,
    params
  );
  const latest = {};
  for (const r of runRows) latest[r.window_mode] = r;   // ordered by ran_at, so the last wins
  const daysRun = [...new Set(runRows.map((r) => ft.day(r.as_of)))].sort();

  const outcomes = {};
  for (const mode of ['fixed', 'intended']) {
    if (!latest[mode]) continue;
    const { rows } = await analytics.query(
      `SELECT * FROM forward_test_card_outcomes WHERE run_id = $1 ORDER BY rec_date, client_id, rec_id`,
      [latest[mode].id]
    );
    outcomes[mode] = rows.map((r) => ({ ...r.detail, _row: r }));
  }

  // Evolution: first and latest verdict per card, fixed mode, across every
  // period run in order.
  const fixedRunIds = runRows.filter((r) => r.window_mode === 'fixed').map((r) => r.id);
  let evolution = [];
  if (fixedRunIds.length) {
    const { rows } = await analytics.query(
      `SELECT rec_id, array_agg(outcome ORDER BY run_id) AS path,
              array_agg(run_id ORDER BY run_id) AS run_ids
         FROM forward_test_card_outcomes WHERE run_id = ANY($1::bigint[]) GROUP BY rec_id`,
      [fixedRunIds]
    );
    evolution = rows;
  }

  const snapRows = latest.fixed ? (await analytics.query(
    `SELECT client_id, location_id, sku, stock_qty, rate_28d_open_days, captured_at
       FROM forward_test_inventory_snapshots WHERE snap_date = $1::date`,
    [ft.day(latest.fixed.as_of)]
  )).rows : [];
  const shelf = {};
  for (const r of snapRows) {
    shelf[`${r.client_id}:${r.location_id}:${r.sku}`] = { stock_qty: num(r.stock_qty), rate: num(r.rate_28d_open_days) };
  }
  const snapDays = (await analytics.query(
    `SELECT snap_date, count(*)::int AS n, count(*) FILTER (WHERE stock_qty <= 0)::int AS zero
       FROM forward_test_inventory_snapshots
      WHERE snap_date BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 1`,
    [periodStart, periodEnd]
  )).rows.map((r) => ({ snap_date: ft.day(r.snap_date), skus: r.n, at_zero: r.zero }));

  return { runRows, latest, daysRun, outcomes, evolution, shelf, snapDays };
}

function evolutionSummary(evolution) {
  const closed = (o) => !['pending', 'no_data'].includes(o);
  const s = { cards: evolution.length, pending_to_scored: 0, still_pending: 0, scored_from_first_run: 0,
    scored_then_changed: 0, no_data_ever: 0, paths: {} };
  for (const e of evolution) {
    const first = e.path[0];
    const last = e.path[e.path.length - 1];
    if (first === 'pending' && closed(last)) s.pending_to_scored += 1;
    else if (last === 'pending') s.still_pending += 1;
    else if (closed(first) && first === last) s.scored_from_first_run += 1;
    else if (closed(first) && first !== last) s.scored_then_changed += 1;
    else if (last === 'no_data') s.no_data_ever += 1;
    const key = `${first} -> ${last}`;
    s.paths[key] = (s.paths[key] || 0) + 1;
  }
  return s;
}

async function writeFinalReport({ analytics, syncgo, outDir, periodStart, periodEnd, stores, asOf, log }) {
  const db = await loadPeriodFromDb(analytics, { periodStart, periodEnd, stores, upTo: asOf });
  const base = `FINAL_REPORT_${periodStart}_to_${periodEnd}`;
  if (!db.latest.fixed) {
    const msg = `no period run exists for ${periodStart}..${periodEnd} in forward_test_runs`;
    log(`      final report not written: ${msg}`);
    return { written: false, reason: msg };
  }
  const names = await storeNames(syncgo, stores);
  const fixedRows = db.outcomes.fixed || [];
  const intendedRows = db.outcomes.intended || [];
  const fm = db.latest.fixed.metrics;
  const im = db.latest.intended ? db.latest.intended.metrics : ft.calculateConfidenceMetrics([]);
  const periodDays = daysBetween(periodStart, periodEnd);
  const lastDay = ft.day(db.latest.fixed.as_of);
  const allDays = Array.from({ length: Math.min(periodDays, daysBetween(periodStart, asOf)) }, (_, i) => addDays(periodStart, i));
  const missedDays = allDays.filter((d) => !db.daysRun.includes(d));
  const evo = evolutionSummary(db.evolution);
  const stores_ = perStore(fixedRows, names);

  // Observed shelf against simulated ending stock, per card where both exist.
  const compare = fixedRows
    .filter((r) => r.simulated_ending_inventory !== null && r.simulated_ending_inventory !== undefined)
    .map((r) => {
      const s = db.shelf[`${r.store_id}:${r.location_id}:${r.product_id}`];
      if (!s || s.stock_qty === null) return null;
      return { rec_id: r.rec_id, store_id: r.store_id, sku: r.product_id, product_name: r.product_name,
        outcome: r.outcome, simulated_ending: r.simulated_ending_inventory, observed_shelf: s.stock_qty,
        observed_minus_simulated: Math.round((s.stock_qty - r.simulated_ending_inventory) * 100) / 100,
        simulated_stockout: r.simulated_stockout_date || null, observed_stockout: s.stock_qty <= 0 };
    }).filter(Boolean);
  const cmp = {
    cards_compared: compare.length,
    observed_stockouts: compare.filter((c) => c.observed_stockout).length,
    simulated_stockouts: compare.filter((c) => c.simulated_stockout).length,
    both_stockout: compare.filter((c) => c.observed_stockout && c.simulated_stockout).length,
    median_abs_gap: compare.length
      ? compare.map((c) => Math.abs(c.observed_minus_simulated)).sort((a, b) => a - b)[Math.floor(compare.length / 2)] : null,
    note: 'The simulation assumes the recommended quantity was ordered and received; the shelf records what the store actually did. '
      + 'A gap is therefore mostly the acceptance assumption, not a forecasting error, and it is reported as a gap, not a score.',
  };

  // Refusals across the period, from every day's generation record.
  const refusedBy = new Map();
  let daysWithGeneration = 0;
  for (const r of db.runRows.filter((x) => x.window_mode === 'fixed')) {
    if (!r.generation) continue;
    daysWithGeneration += 1;
    for (const f of r.generation.refusals || []) {
      const k = `${f.client_id}:${f.location_id}`;
      const e = refusedBy.get(k) || { ...f, days: 0, reasons: new Set() };
      e.days += 1;
      for (const x of f.reasons) e.reasons.add(x);
      refusedBy.set(k, e);
    }
  }
  const refused = [...refusedBy.values()].map((e) => ({ ...e, reasons: [...e.reasons] }))
    .sort((a, b) => a.client_id - b.client_id);
  // Stores whose generation failed or timed out, or were not reached in the
  // budget, on any morning - they too may have contributed fewer cards.
  const failedBy = new Map();
  for (const r of db.runRows.filter((x) => x.window_mode === 'fixed')) {
    if (!r.generation) continue;
    for (const f of [...(r.generation.failures || []), ...(r.generation.skipped || []).map((s) => ({ ...s, code: 'not_reached_in_budget' }))]) {
      const k = `${f.client_id}:${f.location_id}`;
      const e = failedBy.get(k) || { client_id: f.client_id, location_id: f.location_id, days: 0, codes: new Set() };
      e.days += 1;
      e.codes.add(f.code || 'UNKNOWN');
      failedBy.set(k, e);
    }
  }
  const failed = [...failedBy.values()].map((e) => ({ ...e, codes: [...e.codes] }))
    .sort((a, b) => a.client_id - b.client_id);

  const lastWeekPending = fixedRows.filter((r) => r.outcome === 'pending' && r.rec_date > addDays(periodEnd, -7)).length;
  const shelfCovered = fixedRows.filter((r) => db.shelf[`${r.store_id}:${r.location_id}:${r.product_id}`]).length;
  const conf = forwardConfidence({
    fixed: { rows: fixedRows, metrics: fm }, intended: { rows: intendedRows, metrics: im },
    dailyRuns: db.daysRun.length, periodDays, shelfCovered,
  });

  const json = {
    generated_at: new Date().toISOString(),
    period: { start: periodStart, end: periodEnd, mornings: periodDays, runs_happened: db.daysRun.length,
      days_run: db.daysRun, days_missed: missedDays, last_run_as_of: lastDay },
    assumption: 'every recommendation was accepted and ordered in full',
    latest_runs: { fixed: db.latest.fixed.id, intended: db.latest.intended ? db.latest.intended.id : null },
    metrics: { fixed: fm, intended: im },
    evolution: evo,
    per_store: stores_.map((s) => ({ store_id: s.store_id, location_id: s.location_id, name: s.name,
      cards: s.cards, metrics: s.metrics })),
    shelf_comparison: { ...cmp, cards: compare },
    snapshot_days: db.snapDays,
    refused_stores: refused,
    failed_stores: failed,
    confidence: conf,
    cannot_say: {
      acceptance_assumed: true,
      pending_cards_from_last_7_days: lastWeekPending,
      pending_cards_total_fixed: fm.pending,
      pending_cards_total_intended: im.pending,
      refused_stores: refused.length,
      days_missed: missedDays,
    },
    cards: fixedRows.map((r) => {
      const i = intendedRows.find((x) => x.rec_id === r.rec_id);
      const s = db.shelf[`${r.store_id}:${r.location_id}:${r.product_id}`];
      const { _row, ...rest } = r;
      return { ...rest, intended_outcome: i ? i.outcome : null, intended_reason: i ? i.reason : null,
        shelf_on_last_day: s ? s.stock_qty : null };
    }),
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify(json, null, 2));
  const csvCols = [...ft.CSV_COLS, 'intended_outcome', 'shelf_on_last_day'];
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  fs.writeFileSync(path.join(outDir, `${base}.csv`), '﻿' + [csvCols.join(','),
    ...json.cards.map((r) => csvCols.map((c) => cell(r[c])).join(','))].join('\n'));

  const runsForTable = [
    { label: 'period', windowMode: 'fixed', metrics: fm, rows: fixedRows, sinceDate: periodStart,
      meta: { windowDays: db.latest.fixed.window_days } },
    { label: 'period', windowMode: 'intended', metrics: im, rows: intendedRows, sinceDate: periodStart,
      meta: { windowDays: db.latest.fixed.window_days } },
  ];
  const html = `<!doctype html><meta charset="utf-8"><title>Forward test, final report ${periodStart} to ${periodEnd}</title>
<style>${PAGE_CSS}</style>
<h1>Forward test, final report: ${periodStart} to ${periodEnd}</h1>
<p class="muted">Built ${new Date().toISOString()} from forward_test_runs, forward_test_card_outcomes and forward_test_inventory_snapshots (migration 038). Latest period runs: fixed ${db.latest.fixed.id}${db.latest.intended ? `, intended ${db.latest.intended.id}` : ''}, both as of ${lastDay}. The daily job ran on <b>${db.daysRun.length} of ${periodDays}</b> mornings${missedDays.length ? `; missed: ${missedDays.join(', ')}` : ''}.</p>
<div class="warn"><b>Assumption, stated once and everywhere:</b> every card is treated as accepted and ordered in full. Demand is observed; the inventory trajectory is simulated. Windows are open days. A pending card is not a failed one and sits in no denominator. Absence is never zero.</div>

<h2>Headline</h2>
<div class="tiles">
<div class="tile"><b>${fmt(fixedRows.length)}</b><span>cards issued in the period</span></div>
<div class="tile"><b>${fmt(fm.evaluated)}</b><span>scored at 7 open days</span></div>
<div class="tile"><b>${fmt(fm.pending)}</b><span>still pending at 7 open days</span></div>
<div class="tile"><b>${fmt(im.evaluated)}</b><span>scored at their intended horizon</span></div>
<div class="tile"><b>${fm.evaluated ? fmtPct(fm.recommendation_accuracy_rate_pct) : 'n/a'}</b><span>RAR, fixed [${ci(fm.rar_ci95)}]</span></div>
<div class="tile"><b>${im.evaluated ? fmtPct(im.recommendation_accuracy_rate_pct) : 'n/a'}</b><span>RAR, intended [${ci(im.rar_ci95)}]</span></div>
<div class="tile"><b>${fm.cards_with_velocity ? fmtPct(fm.met_forecast_rate_pct) : 'n/a'}</b><span>met-forecast rate (fixed)</span></div>
<div class="tile"><b>${fm.inventory_turnover_efficiency === null ? 'n/a' : fmt(fm.inventory_turnover_efficiency, 3)}</b><span>turnover efficiency (fixed)</span></div>
<div class="tile"><b>${fm.evaluated ? fmtMoney(fm.net_financial_impact) : 'n/a'}</b><span>net financial impact (fixed)</span></div>
</div>

<h2>Engine Confidence Score</h2>
${confidenceSection(conf)}

<h2>How verdicts evolved (fixed window, across ${db.daysRun.length} daily runs)</h2>
<div class="tiles">
<div class="tile"><b>${evo.cards}</b><span>cards seen by any run</span></div>
<div class="tile"><b>${evo.pending_to_scored}</b><span>pending, then scored</span></div>
<div class="tile"><b>${evo.still_pending}</b><span>still pending on the last run</span></div>
<div class="tile"><b>${evo.scored_from_first_run}</b><span>scored on their first run, unchanged</span></div>
<div class="tile"><b>${evo.scored_then_changed}</b><span>scored, then changed</span></div>
</div>
<table class="small"><thead><tr><th>First verdict to latest verdict</th><th class="n">Cards</th></tr></thead><tbody>
${Object.entries(evo.paths).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr><td>${esc(k)}</td><td class="n">${n}</td></tr>`).join('\n')}
</tbody></table>

<h2>The four metrics, both modes (latest run)</h2>
${metricsTable(runsForTable)}
<h2>Outcome breakdown</h2>
${outcomeTable(runsForTable)}
<h2>Calibration (fixed window)</h2>
${calibrationTable(fm)}

<h2>Per store</h2>
${storeTable(stores_, intendedRows)}

<h2>Simulated ending stock against the observed shelf (${lastDay})</h2>
<p>${cmp.note}</p>
<div class="tiles">
<div class="tile"><b>${cmp.cards_compared}</b><span>cards with both figures</span></div>
<div class="tile"><b>${cmp.observed_stockouts}</b><span>observed at zero on the shelf</span></div>
<div class="tile"><b>${cmp.simulated_stockouts}</b><span>simulated stockouts</span></div>
<div class="tile"><b>${cmp.both_stockout}</b><span>both</span></div>
<div class="tile"><b>${cmp.median_abs_gap === null ? 'n/a' : fmt(cmp.median_abs_gap, 1)}</b><span>median |observed - simulated|, units</span></div>
</div>
<p class="muted small">Snapshot days captured: ${db.snapDays.map((d) => `${d.snap_date} (${d.skus} SKUs, ${d.at_zero} at zero)`).join('; ') || 'none'}.</p>
${compare.length ? `<table class="small"><thead><tr><th>Rec</th><th>Store</th><th>SKU</th><th>Product</th><th>Outcome</th><th class="n">Simulated ending</th><th class="n">Observed shelf</th><th class="n">Observed - simulated</th><th>Simulated stockout</th><th>Observed stockout</th></tr></thead><tbody>
${compare.map((c) => `<tr><td>${c.rec_id}</td><td>${c.store_id}</td><td>${esc(c.sku)}</td><td>${esc(c.product_name || '')}</td><td>${esc(c.outcome)}</td><td class="n">${fmt(c.simulated_ending)}</td><td class="n${c.observed_stockout ? ' so' : ''}">${fmt(c.observed_shelf)}</td><td class="n">${fmt(c.observed_minus_simulated)}</td><td>${c.simulated_stockout || ''}</td><td>${c.observed_stockout ? 'yes' : ''}</td></tr>`).join('\n')}
</tbody></table>` : '<p class="muted">No card has both a simulated ending inventory and an observed count on the last day.</p>'}

<h2>Every card issued in the period, latest verdict</h2>
${cardTable(fixedRows, intendedRows, db.shelf, names)}

<h2>What this report cannot say</h2>
<ul>
<li><b>Whether anyone ordered.</b> Acceptance is assumed: every card is scored as if the recommended quantity was bought in full. Where the shelf comparison above shows stock below the simulated figure, the likeliest reason is that the order was not placed, not that the forecast was wrong. Nothing here measures the owner's action.</li>
<li><b>The last week's cards.</b> ${lastWeekPending} card(s) issued after ${addDays(periodEnd, -7)} cannot have seven open days behind them by ${periodEnd} and are pending at the fixed window; ${fm.pending} card(s) are pending at the fixed window in all and ${im.pending} at their intended horizon. They sit in no rate above. A card sized for three weeks of cover is not judged on one.</li>
<li><b>Stores the quality gate refused.</b> ${refused.length ? `${refused.length} store(s) were refused on at least one morning (of ${daysWithGeneration} mornings the job generated) and contributed no cards: ` + refused.map((r) => `${r.client_id}:${r.location_id} (${r.reasons.join(', ')}, ${r.days} morning${r.days === 1 ? '' : 's'})`).join('; ') + '.' : 'No store was refused by the quality gate on any morning the job generated.'} A refusal is a fact about the store's data feed, not about the engine, and those stores are absent from every figure here rather than counted as failures.</li>
<li><b>Stores whose generation failed, timed out or was not reached.</b> ${failed.length ? failed.map((f) => `${f.client_id}:${f.location_id} (${f.codes.join(', ')}, ${f.days} morning${f.days === 1 ? '' : 's'})`).join('; ') + '. On those mornings these stores have cards only if the server\'s own batch issued them.' : 'None on any morning the job generated.'}</li>
<li><b>Mornings the job did not run.</b> ${missedDays.length ? `${missedDays.join(', ')}: no measurement, no shelf capture. The cards those days would have issued do not exist, and no later run can recreate what the shelf held.` : 'None in the period so far.'}</li>
<li><b>Cards without an on-hand snapshot.</b> ${fm.evaluated - fm.simulatable} of ${fm.evaluated} scored cards carry no engine_on_hand, so no stockout determination was made for them; they are scored on absorption alone.</li>
<li><b>A rate on ${fm.evaluated} scored cards.</b> The Wilson intervals above are the honest width of what ${fm.evaluated} cards can say; the Engine Confidence Score's evidence half says how far that is from the ${SCORED_CARDS_TARGET} at which a rate first narrows enough to quote.</li>
</ul>
<p class="muted small">Files: ${base}.json (everything on this page, including every card) and ${base}.csv (one row per card with the intended-mode verdict and the last day's shelf count).</p>
`;
  fs.writeFileSync(path.join(outDir, `${base}.html`), html);
  log(`      wrote ${path.join(outDir, `${base}.html`)} (+ .json, .csv)`);
  return { written: true, files: [`${base}.html`, `${base}.json`, `${base}.csv`], evolution: evo, cannot_say: json.cannot_say };
}

// ── The job ──────────────────────────────────────────────────────────────────

/**
 * Run the day. `deps` lets a test hand in a mocked syncgo pool and skip the
 * services; the CLI passes the real ones.
 */
async function runDaily(opts, deps = {}) {
  const log = opts.log || console.log;
  const analytics = deps.analytics || getAnalyticsPool();
  const syncgo = deps.syncgo || getPool();
  const asOf = opts.asOf || istDay();
  const periodStart = opts.periodStart || process.env.FORWARD_TEST_PERIOD_START || DEFAULT_PERIOD_START;
  const periodEnd = opts.periodEnd || process.env.FORWARD_TEST_PERIOD_END || DEFAULT_PERIOD_END;
  const stores = opts.stores || [];
  const windowDays = opts.windowDays ?? ft.DEFAULT_WINDOW_DAYS;
  const safetyCoverDays = opts.safetyCoverDays ?? ft.DEFAULT_SAFETY_COVER_DAYS;
  const outDir = opts.outDir;
  if (!outDir) throw new Error('--out is required: where audit/forward lives');
  const started = Date.now();
  const summary = { as_of: asOf, period_start: periodStart, period_end: periodEnd, stores };

  log(`forward test, daily run for ${asOf} (IST); period ${periodStart}..${periodEnd}; `
    + `stores ${stores.length ? stores.join(',') : 'ALL'}`);

  // ORDER. Capture, evaluate and report FIRST, over the cards that exist when
  // the job starts, so the day's report is on disk and in the tables within
  // minutes. Generation runs second: a full pass over the estate takes 40-60
  // minutes at three stores a minute, and a report that waits for it is a
  // report that a slow service can delay into the trading day. When
  // generation issues new cards, the capture/evaluate/report pass runs AGAIN,
  // so today's cards and their SKUs' shelf counts are in today's rows and not
  // first seen tomorrow. Both passes are persisted (notes say which); the
  // final report reads the latest, and nothing in it depends on the first.
  const cache = new Map();
  const pass = async (label, generation, cardsToday) => {
    log(`[${label}] capturing the shelf for every SKU under test ...`);
    const capture = await captureSnapshots({ analytics, syncgo, stores, periodStart, asOf, log, cache });
    log(`[${label}] evaluating: four runs ...`);
    const runs = await evaluateAndPersist({ analytics, syncgo, stores, periodStart, asOf, windowDays,
      safetyCoverDays, generation, cardsToday: cardsToday.cards, log, cache, extraNotes: [`pass:${label}`] });
    log(`[${label}] writing the day's report and the index ...`);
    const shelf = await shelfOn(analytics, stores, asOf);
    const names = await storeNames(syncgo, stores);
    const already = listDailyRuns(outDir).filter((d) => d.as_of !== asOf && d.as_of >= periodStart && d.as_of <= periodEnd).length;
    const dailyRunsSoFar = already + (asOf >= periodStart && asOf <= periodEnd ? 1 : 0);
    const report = writeDailyReport({ outDir, asOf, periodStart, periodEnd, runs, generation, cardsToday,
      capture, shelf, names, dailyRunsSoFar, pass: label });
    const index = writeIndex(outDir, { periodStart, periodEnd });
    log(`      ${report.dayDir}`);
    log(`      INDEX.html lists ${index.days} day(s), ${index.inPeriod} of ${daysBetween(periodStart, periodEnd)} in the period`);
    log(`      Engine Confidence Score ${report.conf.engine_confidence} (${report.conf.band}): `
      + `performance ${report.conf.performance.score} x sufficiency ${report.conf.sufficiency.score}`);
    return { capture, runs, report };
  };

  let cardsToday = await cardsGeneratedOn(analytics, stores, asOf);
  log(`      ${cardsToday.cards} card(s) in ${cardsToday.runs} run(s) already generated today across the scope`);
  let result = await pass('pre-generation', null, cardsToday);

  // Generate if missing, bounded.
  let generation = null;
  if (opts.noGenerate) {
    log('[gen] generation skipped (--no-generate)');
  } else {
    log(`[gen] generating today's cards where no run exists yet (${Math.round(STORE_TIMEOUT_MS / 1000)}s per store, `
      + `${Math.round(GENERATE_BUDGET_MS / 60000)} min in all) ...`);
    // A failure of the STEP (the service unreachable, client_locations
    // unreadable) is recorded on the day and the job goes on: capture and
    // evaluation do not depend on it, and the report must say what happened.
    try {
      const recommendationService = deps.recommendationService || require('../services/recommendationService');
      const recGate = deps.recGate || require('../services/recommendationGateService');
      const locations = await resolveLocations(syncgo, recommendationService, stores, process.env.FORWARD_TEST_LOCATIONS);
      generation = await generateIfMissing({ analytics, locations, asOf, log, recommendationService, recGate });
      log(`      ${generation.ok} generated, ${generation.already} already had a run, `
        + `${generation.refused} refused, ${generation.failed} failed, `
        + `${generation.skipped_budget} not reached in the budget (of ${locations.length})`);
    } catch (err) {
      generation = {
        stores_in_scope: 0, ok: 0, refused: 0, failed: 0, already: 0, skipped_budget: 0,
        refusals: [], failures: [], generated: [], skipped: [],
        step_error: `${err.code || 'UNKNOWN'}: ${err.message}`,
      };
      log(`      generation step FAILED and is recorded as such: ${err.message}`);
    }
  }
  cardsToday = await cardsGeneratedOn(analytics, stores, asOf);
  log(`      ${cardsToday.cards} card(s) in ${cardsToday.runs} run(s) generated today across the scope`);
  summary.generation = generation;
  summary.cards_today = cardsToday;

  // The second pass runs whenever the generation step ran, even if it issued
  // nothing new: the run rows it writes are the ones that carry the day's
  // generation counters, and it is cheap, because the cache already holds
  // every store's open days, units and economics from the first pass. With
  // --no-generate the first pass stands as the day's measurement.
  if (generation) {
    result = await pass('post-generation', generation, cardsToday);
  }
  const { capture, runs, report } = result;
  summary.capture = capture;
  summary.runs = runs.map((r) => ({ label: r.label, window_mode: r.windowMode, run_id: r.runId,
    cards: r.rows.length, scored: r.metrics.evaluated, pending: r.metrics.pending }));
  summary.report_dir = report.dayDir;
  summary.confidence = report.conf;

  // e. final
  if (opts.final) {
    log('[e] writing the final report for the whole period ...');
    summary.final = await writeFinalReport({ analytics, syncgo, outDir, periodStart, periodEnd, stores, asOf, log });
    writeIndex(outDir, { periodStart, periodEnd });   // now links the final report
  }

  log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
  return summary;
}

module.exports = {
  runDaily, istDay, addDays, daysBetween, generateIfMissing, captureSnapshots,
  evaluateAndPersist, forwardConfidence, writeDailyReport, writeIndex, writeFinalReport,
  loadPeriodFromDb, evolutionSummary, resolveLocations, cardsGeneratedOn, shelfOn,
  DEFAULT_PERIOD_START, DEFAULT_PERIOD_END, TZ, SCORED_CARDS_TARGET,
};

// ── Main ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const stores = (arg('stores') || '').split(',')
      .map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
    const summary = await runDaily({
      stores,
      outDir: arg('out', null),
      noGenerate: has('no-generate'),
      periodStart: arg('period-start', null),
      periodEnd: arg('period-end', null),
      asOf: arg('as-of', null),
      final: has('final'),
      windowDays: parseInt(arg('window-days', String(ft.DEFAULT_WINDOW_DAYS)), 10),
      safetyCoverDays: parseInt(arg('safety-cover-days', String(ft.DEFAULT_SAFETY_COVER_DAYS)), 10),
    });
    if (has('json')) console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  })().catch((e) => { console.error('FAILED:', e.message); console.error(e.stack); process.exit(1); });
}
