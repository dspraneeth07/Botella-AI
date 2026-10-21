#!/usr/bin/env node
/*
  Phase-2 metric-layer spike gate.

  Verifies, against the LIVE backend on EVAL_PORT (default 3100), that:
    1. ROUTING - covered questions call the canonical metric tool (not run_sql),
       across phrasing variants. Routing is the #1 residual risk: the SQL is
       deterministic by construction, the tool CHOICE is not.
    2. DETERMINISM - the same question asked N times returns the SAME number.
       Determinism cases use FROZEN windows (historical dates) because the DB
       is live and the latest day accumulates.
    3. CORRECTNESS - the number the bot SAYS matches independent reference SQL
       run directly against the DB (second SQL path, written separately from
       lib/metrics.js). Drift-prone ground truths (catalog counts, dead stock)
       are captured immediately around the bot calls.
    4. HONESTY - estimate-class answers carry the ⚠ caveat; verified-class
       answers state the exact date(s).

  GATE (per build brief §7.5): confident-wrong = 0 AND reproducibility = 100%
  on covered questions. Exit code 1 if the gate fails.

  Run backend first:
    EVAL_PORT=3100 BOTELLA_READ_ONLY_DB=true DISABLE_CHAT_ANALYTICS=true \
      BOTELLA_EVAL_MODE=true npm start
  Then:
    node tests/metric-spike-eval.js
*/
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { JWT_SECRET } = require('../middleware/auth');
const { Pool } = require('pg');

const API_BASE = process.env.EVAL_API_BASE || 'http://127.0.0.1:3100/api';
const CLIENT_ID = Number(process.env.EVAL_CLIENT_ID || 125);
const LOCATION_ID = Number(process.env.EVAL_LOCATION_ID || 125);

const token = jwt.sign({
  user_id: 'eval-readonly', username: 'eval-readonly',
  client_id: CLIENT_ID, location_id: LOCATION_ID,
  client_name: 'Route 106 Wine & Spirits', location_name: 'Route 106 Wine & Spirits',
}, JWT_SECRET, { expiresIn: '4h' });

const pool = new Pool({
  host: process.env.PG_HOST, port: process.env.PG_PORT, database: process.env.PG_DATABASE,
  user: process.env.PG_USER, password: process.env.PG_PASSWORD,
  ssl: { rejectUnauthorized: false },
  options: '-c default_transaction_read_only=on',
  connectionTimeoutMillis: 10000, statement_timeout: 60000,
});
const T = `client_id=${CLIENT_ID} AND location_id=${LOCATION_ID}`;

async function ask(question) {
  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: question, history: [], conversation_id: 'spike-' + Math.random().toString(36).slice(2) }),
  });
  const raw = await res.text();
  let answer = '', evidence = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const e = JSON.parse(line.slice(6));
      if (e.type === 'delta') answer += e.text || '';
      if (e.type === 'clear') answer = '';
      if (e.type === 'done' && e.eval) evidence = e.eval.evidence || [];
    } catch {}
  }
  return { answer: answer.split('<<FOLLOWUPS>>')[0], tools: evidence.map(e => e.tool) };
}

// Extract every number from the answer (commas stripped) for value matching.
const numbersIn = (text) => (text.match(/\d[\d,]*(?:\.\d+)?/g) || []).map(s => Number(s.replace(/,/g, '')));
const hasNumber = (text, expected, tol = 0) =>
  numbersIn(text).some(n => Math.abs(n - expected) <= tol);

// ── Shared check predicates ──────────────────────────────────────────────────
// Used by BOTH the live gate checks below and the planted-wrong self-test
// (section 5), so the self-test exercises the gate's ACTUAL detection logic,
// not a copy that could silently diverge.
const P = {
  routedTo: (a, tool) => a.tools.includes(tool),
  valueMatches: (a, expected) => expected.every(v => hasNumber(a.answer, v, v > 1000 ? 0.011 : 0)),
  // Headline = largest number in the answer (the figure itself); years excluded.
  headline: (a) => Math.max(...numbersIn(a.answer).filter(n => n !== 2026 && n !== 2025), 0),
  caveated: (a) => /⚠/.test(a.answer),
  cleanNoMarker: (a) => !/[⚠✅]/.test(a.answer),
  // Dead-stock claim anchored on dead-labeled lines: some line must carry the
  // correct count, and no dead line may claim a different >=1000 figure alone.
  deadClaim: (a, before, after) => {
    const deadLines = a.answer.split('\n').filter(l => /dead/i.test(l) && numbersIn(l).length);
    const claimOk = deadLines.some(l => numbersIn(l).includes(before) || numbersIn(l).includes(after));
    const noWrongClaim = deadLines.every(l => {
      const big = numbersIn(l).filter(n => n >= 1000);
      return big.length === 0 || big.includes(before) || big.includes(after);
    });
    return claimOk && noWrongClaim;
  },
  marginDeclined: (a) => /🚫|can.?t|cannot|missing|isn.?t recorded|not recorded|no cost/i.test(a.answer),
  hourlyDeclined: (a) => /🚫|midnight|time of day isn|not captured|isn.?t captured/i.test(a.answer),
  categoryDisclosed: (a) => /unmatched|uncategor|can.?t be (?:linked|matched)|couldn.?t (?:link|match)|not (?:linked|matched)|⚠/i.test(a.answer),
};

// Independent reference SQL - written here, NOT imported from lib/metrics.js.
const REF = {
  // Revenue refs are RECEIPT-SUBTOTAL basis (Fix 0, 2026-06-16): SUM(sales.sub_total).
  revenueMarch2026: `SELECT ROUND(SUM(sub_total)::numeric,2) v FROM sales WHERE ${T} AND sale_date::date >= '2026-03-01' AND sale_date::date < '2026-04-01'`,
  txnsMarch2026:    `SELECT COUNT(DISTINCT sale_id) v FROM sale_items WHERE ${T} AND sale_date::date >= '2026-03-01' AND sale_date::date < '2026-04-01'`,
  firstDayRevenue:  `SELECT ROUND(SUM(sub_total)::numeric,2) v FROM sales WHERE ${T} AND sale_date::date = (SELECT MIN(sale_date::date) FROM sale_items WHERE ${T})`,
  firstDayTxns:     `SELECT COUNT(DISTINCT sale_id) v FROM sale_items WHERE ${T} AND sale_date::date = (SELECT MIN(sale_date::date) FROM sale_items WHERE ${T})`,
  vodkaCarry:       `SELECT COUNT(*) v FROM products WHERE ${T} AND (product_name ~* '\\yvodka\\y' OR sub_category ~* '\\yvodka\\y' OR category ~* '\\yvodka\\y')`,
  bourbonCarry:     `SELECT COUNT(*) v FROM products WHERE ${T} AND (product_name ~* '\\ybourbon\\y' OR sub_category ~* '\\ybourbon\\y' OR category ~* '\\ybourbon\\y')`,
  deadStock90:      `SELECT COUNT(*) v FROM products p WHERE p.${T.replace(/ AND /, ' AND p.')} AND p.stock_qty>0 AND NOT EXISTS (
                       SELECT 1 FROM sale_items si WHERE si.client_id=p.client_id AND si.location_id=p.location_id
                       AND TRIM(si.sku)=TRIM(p.upc)
                       AND si.sale_date::date > (SELECT MAX(sale_date::date) FROM sale_items WHERE ${T}) - 90)`,
};
async function ref(key) {
  const r = await pool.query(REF[key]);
  return Number(r.rows[0].v);
}

const METRIC_TOOL_NAMES = new Set(['get_revenue', 'get_transaction_count', 'get_sales_on_day', 'get_dead_stock', 'get_product_count']);

async function main() {
  const failures = [];
  const note = (ok, label, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' - ' + detail : ''}`);
    if (!ok) failures.push(`${label}: ${detail}`);
  };

  // ── 0. Basis-caveat trigger logic (unit-level - the live DB has no period
  //       over the 1% threshold by design, so the fires path is tested here) ──
  console.log('\n== Basis-caveat trigger (unit) ==');
  {
    const { basisCheck, BASIS_CAVEAT_PCT } = require('../lib/metrics')._internal;
    note(BASIS_CAVEAT_PCT === 1.0, `caveat threshold pinned at 1% (got ${BASIS_CAVEAT_PCT}%)`);
    const fires = basisCheck(100000, 101100);   // 1.1% gap → must caveat
    note(fires.material === true, 'gap 1.1% → caveat fires', JSON.stringify(fires));
    const quiet = basisCheck(100000, 100764);   // 0.764% = worst real month → silent
    note(quiet.material === false, 'gap 0.764% (worst historical month) → no caveat', JSON.stringify(quiet));
  }

  // ── 1. Determinism (frozen windows) + correctness vs independent SQL ──────
  console.log('\n== Determinism + correctness (frozen windows) ==');

  const detCases = [
    // Revenue is on the receipt-SUBTOTAL basis (Fix 0) and is CLEAN by default -
    // carries the ⚠️ a mismatch note only when the line items don't reconcile;
    // a ⚠️ fires ONLY when line items don't reconcile (older duplicated receipts).
    // First-day + March 2026 reconcile (0% gap) → expectNoCaveat. Counts/units clean.
    { label: 'first-day revenue ×5', q: 'What was my revenue on the first day I have data for?',
      runs: 5, tool: 'get_sales_on_day', gt: ['firstDayRevenue', 'firstDayTxns'], expectNoCaveat: true },
    { label: 'March-2026 revenue ×3', q: 'What was my revenue in March 2026?',
      runs: 3, tool: 'get_revenue', gt: ['revenueMarch2026'], expectNoCaveat: true },
    { label: 'March-2026 transactions ×3', q: 'How many transactions did I have in March 2026?',
      runs: 3, tool: 'get_transaction_count', gt: ['txnsMarch2026'] },
  ];
  for (const c of detCases) {
    const expected = await Promise.all(c.gt.map(ref));
    const answers = [];
    for (let i = 0; i < c.runs; i++) answers.push(await ask(c.q));
    const routedAll = answers.every(a => P.routedTo(a, c.tool));
    note(routedAll, `${c.label} routing → ${c.tool}`, routedAll ? '' : `tools seen: ${JSON.stringify(answers.map(a => a.tools))}`);
    const valueOkAll = answers.every(a => P.valueMatches(a, expected));
    note(valueOkAll, `${c.label} value = independent SQL (${expected.join(', ')})`,
      valueOkAll ? '' : `answers: ${answers.map(a => a.answer.slice(0, 90)).join(' | ')}`);
    // Reproducibility = the HEADLINE figure (largest number in the answer -
    // the revenue/count itself) is identical on every run. Surrounding prose
    // (per-day averages, ticket size) derives from the same deterministic
    // metric result and may appear or not; that is presentation, not value.
    const stable = answers.every(a => P.headline(a) === P.headline(answers[0]));
    note(stable, `${c.label} reproducible across ${c.runs} runs (headline ${P.headline(answers[0])})`,
      stable ? '' : `headlines: ${answers.map(P.headline).join(', ')}`);
    if (c.expectCaveat) {
      const ok = answers.every(a => P.caveated(a));
      note(ok, `${c.label} carries ⚠ receipt-vs-items caveat (gap > 1%)`,
        ok ? '' : `answers missing caveat: ${answers.filter(a => !P.caveated(a)).map(a => a.answer.slice(0, 90)).join(' | ')}`);
    }
    if (c.expectNoCaveat) {
      // Clean answers carry NO marker at all (owner-ratified): no spurious ⚠,
      // and no ✅ either - symbols exist only to flag problems.
      const ok = answers.every(a => P.cleanNoMarker(a));
      note(ok, `${c.label} stays clean (gap < 1% - no caveat, no green check)`,
        ok ? '' : `marked answers: ${answers.filter(a => !P.cleanNoMarker(a)).map(a => a.answer.slice(0, 90)).join(' | ')}`);
    }
  }

  // ── 2. Drift-prone metrics: GT captured immediately around the call ───────
  console.log('\n== Catalog / dead-stock (GT captured around the call) ==');

  {
    const before = await ref('vodkaCarry');
    const a = await ask('How many vodka products do I carry?');
    const after = await ref('vodkaCarry');
    note(P.routedTo(a, 'get_product_count'), 'vodka routing → get_product_count', `tools: ${a.tools}`);
    const ok = hasNumber(a.answer, before) || hasNumber(a.answer, after);
    note(ok, `vodka count = reference SQL (${before}${after !== before ? '→' + after : ''})`, ok ? '' : a.answer.slice(0, 120));
    note(P.caveated(a), 'vodka answer carries ⚠ name-match caveat', P.caveated(a) ? '' : 'no caveat found');
  }
  {
    // B1 check. NOTE: the wrong join (products.sku = sale_items.sku) matches
    // ~zero sales, so "dead under the wrong join" = the ENTIRE in-stock
    // catalog - numerically identical to in_stock_total, which the metric
    // legitimately reports as context ("2,038 of your 5,824 in-stock
    // products"). A presence check on that value can never distinguish bug
    // from context. The meaningful assertion: the HEADLINE dead-count claim
    // (first number in the answer) equals the correct UPC anti-join.
    const before = await ref('deadStock90');
    const a = await ask('How much dead stock do I have - items in stock that have not sold in 90 days?');
    const after = await ref('deadStock90');
    note(P.routedTo(a, 'get_dead_stock'), 'dead-stock routing → get_dead_stock', `tools: ${a.tools}`);
    const ok = hasNumber(a.answer, before) || hasNumber(a.answer, after);
    note(ok, `dead-stock = correct UPC anti-join (${before}${after !== before ? '→' + after : ''})`, ok ? '' : a.answer.slice(0, 140));
    // Presentation varies (prose vs table) - P.deadClaim anchors on the lines
    // that say "dead" (catches "5,824 dead items" while allowing "2,038 of 5,824").
    const claimOk = P.deadClaim(a, before, after);
    note(claimOk, `dead-stock claim names the correct count, not the B1 figure`,
      claimOk ? '' : `answer: ${a.answer.slice(0, 200)}`);
  }
  {
    const before = await ref('bourbonCarry');
    const a = await ask('How many bourbons do I carry?');
    const after = await ref('bourbonCarry');
    const ok = hasNumber(a.answer, before) || hasNumber(a.answer, after);
    note(ok, `bourbon stays STRICT, no family expansion (${before}${after !== before ? '→' + after : ''})`, ok ? '' : a.answer.slice(0, 120));
  }

  // ── 3. Routing coverage across phrasing variants ──────────────────────────
  console.log('\n== Routing coverage (phrasing variants) ==');
  const routeCases = [
    { q: 'What did I do in sales last week?', tool: 'get_revenue' },
    { q: 'Which items are just collecting dust on my shelves?', tool: 'get_dead_stock' },
    { q: "Give me my first day's numbers.", tool: 'get_sales_on_day' },
    { q: 'Do I stock any tequila right now?', tool: 'get_product_count' },
    { q: 'Total receipts this month?', tool: 'get_transaction_count' },
  ];
  for (const c of routeCases) {
    const a = await ask(c.q);
    const usedMetric = a.tools.includes(c.tool);
    const usedAnyMetric = a.tools.some(t => METRIC_TOOL_NAMES.has(t));
    // Exact tool is the target; a sibling metric tool that still answers
    // deterministically (e.g. get_revenue also returns transactions) is a
    // soft pass, logged for the routing report.
    note(usedMetric || usedAnyMetric, `"${c.q}" → ${c.tool}`,
      usedMetric ? '' : `tools: ${JSON.stringify(a.tools)}${usedAnyMetric ? ' (sibling metric tool - soft pass)' : ''}`);
  }

  // ── 4. Honesty levels still intact end-to-end ──────────────────────────────
  console.log('\n== Honesty levels ==');
  {
    const a = await ask('What was my profit margin last month?');
    note(P.marginDeclined(a), 'margin → 🚫 decline (cost=0)', a.answer.slice(0, 100));
  }
  {
    const a = await ask('What time of day do I sell the most?');
    note(P.hourlyDeclined(a), 'hourly → 🚫 decline (no timestamps)', a.answer.slice(0, 100));
  }
  {
    // Ratified category convention: store's share-of-matched percentages, but
    // the unmatched/uncategorized share must ALWAYS be disclosed in the answer.
    const a = await ask('Break down my revenue by category.');
    note(P.categoryDisclosed(a), 'category breakdown discloses unmatched revenue share (ratified convention)',
      P.categoryDisclosed(a) ? '' : a.answer.slice(0, 160));
  }

  // ── 5. Planted-wrong self-test ─────────────────────────────────────────────
  // The gate's own sensitivity, proven: 11 deliberately wrong answers - the
  // actual historical failure modes - fed through the SAME predicates (P.*)
  // the live checks above use. Every one must be CAUGHT (predicate false).
  // A check that passes a planted wrong answer is a broken check.
  console.log('\n== Planted-wrong self-test (gate must catch each) ==');
  {
    const deadNow = await ref('deadStock90');
    const planted = [
      ['B1: dead stock = entire in-stock catalog (5,824)',
        { answer: 'You have 5,824 dead items in stock right now.', tools: ['get_dead_stock'] },
        (a) => P.deadClaim(a, deadNow, deadNow)],
      ['B2: first-day question answered with the all-time total',
        { answer: 'Your first day (2023-01-01) brought in $12,905,542.21 across 287 transactions.', tools: ['get_sales_on_day'] },
        (a) => P.valueMatches(a, [6316.03, 287])],
      ['wrong basis: March revenue on the deprecated total_amount basis ($260,388.54)',
        { answer: 'Your March 2026 revenue was $260,388.54.', tools: ['get_revenue'] },
        (a) => P.valueMatches(a, [262377.51])],
      ['wrong count: March transactions given as line-item rows (33,461)',
        { answer: 'You had 33,461 transactions in March 2026.', tools: ['get_transaction_count'] },
        (a) => P.valueMatches(a, [10616])],
      ['routing fallthrough: covered question answered via improvised SQL',
        { answer: 'Your revenue was $260,388.54.', tools: ['run_sql'] },
        (a) => P.routedTo(a, 'get_revenue')],
      ['missing ⚠: vodka count without the name-match caveat',
        { answer: 'You carry 275 vodka products.', tools: ['get_product_count'] },
        (a) => P.caveated(a)],
      ['fabricated margin: confident answer despite cost=0',
        { answer: 'Your profit margin in May 2026 was a healthy 28.4%.', tools: ['run_sql'] },
        (a) => P.marginDeclined(a)],
      ['fabricated daypart: confident answer despite midnight-only stamps',
        { answer: 'You sell the most between 4 and 6 PM.', tools: ['run_sql'] },
        (a) => P.hourlyDeclined(a)],
      ['spurious ✅ on a clean answer (markers flag problems only)',
        { answer: '✅ Your revenue on 2023-01-01 was $6,307.45.', tools: ['get_sales_on_day'] },
        (a) => P.cleanNoMarker(a)],
      ['hidden category gap: breakdown with no unmatched disclosure',
        { answer: 'LIQUOR leads at 38.2%, then BEER 32.5% and WINE 21.4%.', tools: ['run_sql'] },
        (a) => P.categoryDisclosed(a)],
    ];
    for (const [label, fixture, predicate] of planted) {
      const caught = !predicate(fixture);
      note(caught, `planted: ${label} → caught`, caught ? '' : 'GATE WOULD PASS THIS WRONG ANSWER');
    }
    // 11th plant: non-reproducibility - two runs of one question with
    // different headline figures must break the stability predicate.
    const runA = { answer: 'Your March 2026 revenue was $260,388.54.', tools: ['get_revenue'] };
    const runB = { answer: 'Your March 2026 revenue was $262,377.51.', tools: ['get_revenue'] };
    const flickerCaught = P.headline(runA) !== P.headline(runB);
    note(flickerCaught, 'planted: headline flickers across two runs → caught',
      flickerCaught ? '' : 'GATE WOULD PASS NON-DETERMINISTIC ANSWERS');
  }

  console.log(`\n${'='.repeat(60)}\nGATE: ${failures.length === 0 ? 'PASS - confident-wrong 0, reproducibility 100%' : `FAIL - ${failures.length} failure(s)`}`);
  failures.forEach(f => console.log('  - ' + f));
  await pool.end();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('Harness error:', e); await pool.end(); process.exit(2); });
