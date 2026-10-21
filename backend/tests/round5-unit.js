#!/usr/bin/env node
/*
  round5-unit.js - DETERMINISTIC tests BELOW the LLM for the Round-5 fixes (A3 + the
  A4 helper layer). No server, no model. Hits the live READ-ONLY DB (SELECT-only) for
  resolveWindow + topProducts; uses MOCKS for the heavy-metric timeout guard.

  Run (give the all-time top-products query headroom so it isn't cut by the heavy
  timeout - the mocked timeout tests below ignore this value):
    cd backend && BOTELLA_HEAVY_TIMEOUT_MS=60000 node tests/round5-unit.js

  NOT a frozen dataset. It was, and it rotted: every expectation was written
  against MAX(sale_date)=2026-05-27 and all 8 date/value checks failed the
  moment the warehouse advanced (it is now months past that). A test that has
  to be re-frozen after every sync is a test nobody re-freezes.

  So the anchor is READ from the warehouse and every date expectation is
  DERIVED from it, and the value checks assert the PROPERTY each fix was about
  - de-duped revenue is lower than the banded sum, per-unit keeps numerator and
  denominator on one basis - rather than a dollar figure that changes daily.
  Oracle identities that do not drift (Terra leads revenue, Chamisul leads
  units) are still asserted by name.
*/
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const metrics = require('../lib/metrics');
const { _internal } = require('../routes/chat');
const { getPool, isRunSqlAllowed } = require('../database/connection');

const C = 46, L = 46;
let fails = 0;
const check = (label, cond, extra) => {
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) { fails++; if (extra !== undefined) console.log(`         ↳ ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`); }
};

(async () => {
  const pool = getPool();
  console.log('\n══ Round-5 deterministic unit tests (below the LLM) - Zeke\'s (46) ══\n');

  // ── Fix 2: resolveWindow bare-month resolver ──────────────────────────────
  console.log('- Fix 2: resolveWindow bare-month resolver -');
  // THE ANCHOR IS READ, NOT ASSERTED. The rules under test are all relative
  // to the warehouse's latest sale date, so pinning that date pins nothing of
  // value and breaks on the next sync.
  const latest = await metrics.latestSaleDate(pool, C, L);
  check('latest sale date is a real date the warehouse reports',
    /^\d{4}-\d{2}-\d{2}$/.test(latest || ''), latest);
  const [LY, LM] = [Number(latest.slice(0, 4)), Number(latest.slice(5, 7))];
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'];
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  console.log(`   (anchor read from the warehouse: ${latest})`);

  // THE RULE: a bare month at or before the latest month is this data-year;
  // a month after it belongs to the prior year, because it has not happened
  // yet in this dataset. The latest month itself is month-to-date.
  const current = await metrics.resolveWindow(pool, C, L,
    { window: 'month', month: MONTHS[LM - 1] });
  check(`"${MONTHS[LM - 1]}" (the latest month) → month to date, ending at the anchor`,
    current.start === `${LY}-${pad(LM)}-01` && current.end === latest
      && /month to date/i.test(current.label), current);

  const pastM = LM > 1 ? LM - 1 : 12;
  const pastY = LM > 1 ? LY : LY - 1;
  const past = await metrics.resolveWindow(pool, C, L,
    { window: 'month', month: MONTHS[pastM - 1] });
  check(`"${MONTHS[pastM - 1]}" (a month already complete) → the FULL month`,
    past.start === `${pastY}-${pad(pastM)}-01`
      && past.end === `${pastY}-${pad(pastM)}-${lastDay(pastY, pastM)}`, past);

  const aheadM = LM < 12 ? LM + 1 : 1;
  const aheadY = LM < 12 ? LY - 1 : LY;
  const ahead = await metrics.resolveWindow(pool, C, L,
    { window: 'month', month: MONTHS[aheadM - 1] });
  check(`"${MONTHS[aheadM - 1]}" (later than the anchor month) → the PRIOR year, not the future`,
    ahead.start === `${aheadY}-${pad(aheadM)}-01`
      && ahead.end === `${aheadY}-${pad(aheadM)}-${lastDay(aheadY, aheadM)}`, ahead);

  const numeric = await metrics.resolveWindow(pool, C, L, { window: 'month', month: LM });
  check('a numeric month resolves identically to its name',
    numeric.start === current.start && numeric.end === current.end, numeric);

  check('no bare month ever resolves past the anchor',
    [current, past, ahead, numeric].every((w) => w.end <= latest),
    [current, past, ahead, numeric].map((w) => w.end));

  let threw = false;
  try { await metrics.resolveWindow(pool, C, L, { window: 'month', month: 'nope' }); } catch { threw = true; }
  check('invalid month throws - no silent default', threw);

  // ── Fix 4: topProducts sort_by ────────────────────────────────────────────
  console.log('\n- Fix 4: topProducts sort_by -');
  const byRev = await metrics.topProducts(pool, C, L, { window: 'all_time', limit: 10 });
  const byUnits = await metrics.topProducts(pool, C, L, { window: 'all_time', limit: 10, sort_by: 'units' });
  const bogus = await metrics.topProducts(pool, C, L, { window: 'last_week', sort_by: 'definitely-not-a-column' });

  check('default sort_by = revenue', byRev.sort_by === 'revenue', byRev.sort_by);
  check('sort_by:units reported on result', byUnits.sort_by === 'units', byUnits.sort_by);
  check('unknown sort_by falls back to revenue (whitelist)', bogus.sort_by === 'revenue', bogus.sort_by);

  check('revenue list ordered by revenue DESC',
    byRev.products.every((p, i, a) => i === 0 || a[i - 1].revenue >= p.revenue), byRev.products.map(p => p.revenue));
  check('units list ordered by units DESC',
    byUnits.products.every((p, i, a) => i === 0 || a[i - 1].units >= p.units), byUnits.products.map(p => p.units));

  // The IDENTITY of the leader is the durable fact; the dollar figure grows
  // with every sync and pinning it only guarantees this test breaks again.
  check('revenue leader is Terra',
    /terra/i.test(byRev.products[0].product_name), byRev.products[0]);
  check('units leader = Chamisul Soju - NOT the revenue leader',
    /chamisul/i.test(byUnits.products[0].product_name) && byUnits.products[0].units >= 10000
      && byUnits.products[0].product_name !== byRev.products[0].product_name, byUnits.products[0]);
  check('units-sorted top ≠ revenue-sorted top (LIMIT applied AFTER sort)',
    byUnits.products[0].product_name !== byRev.products[0].product_name);

  // ── Fix 1 / A2: heavy-metric timeout guard (mocked, no DB) ─────────────────
  console.log('\n- Fix 1 / A2: runMetricTool timeout guard (mocked) -');
  const { runMetricTool, handleTool } = _internal;

  let calls = 0;
  const timeoutHandler = async () => { calls++; throw new Error('Metric query timed out'); };

  calls = 0;
  const heavyRes = await runMetricTool('get_top_products', timeoutHandler, {}, C, L, { window: 'all_time' });
  check('heavy metric retried exactly once (handler called twice)', calls === 2, `calls=${calls}`);
  check('heavy timeout → cant_answer', heavyRes?.confidence?.label === 'cant_answer', heavyRes);
  check('heavy timeout → timed_out:true, fallback_blocked:true, retry_count:1',
    heavyRes.timed_out === true && heavyRes.fallback_blocked === true && heavyRes.retry_count === 1, heavyRes);
  check('heavy timeout result has NO error field that invites run_sql', !heavyRes.error, heavyRes.error);
  check('deferral reason says "too long" and carries NO business number',
    /taking too long/i.test(heavyRes.confidence.reason) && !/\$|\d+\s*%/.test(heavyRes.confidence.reason), heavyRes.confidence.reason);

  calls = 0;
  const lightRes = await runMetricTool('get_revenue', timeoutHandler, {}, C, L, {});
  check('light metric NOT retried on timeout (handler called once)', calls === 1, `calls=${calls}`);
  check('light timeout → best-effort run_sql lane, NOT a hard defer (deferral is heavy-only)',
    !!lightRes.error && /run_sql/.test(lightRes.error) && !lightRes.timed_out && !lightRes.fallback_blocked, lightRes);

  // PG statement_timeout (SQLSTATE 57014, message 'canceling statement due to
  // statement timeout') must ALSO classify as a timeout - the old JS-message-only
  // regex missed it, which would have leaked a heavy timeout into the run_sql lane.
  let pgCalls = 0;
  const pgTimeout = async () => { pgCalls++; const e = new Error('canceling statement due to statement timeout'); e.code = '57014'; throw e; };
  const pgRes = await runMetricTool('get_margin', pgTimeout, {}, C, L, { window: 'all_time' });
  check('heavy PG statement_timeout (57014) classified as timeout → retried then deferred',
    pgCalls === 2 && pgRes?.confidence?.label === 'cant_answer' && pgRes.timed_out === true && pgRes.fallback_blocked === true, pgRes);

  const nonTimeout = await runMetricTool('get_margin', async () => { throw new Error('boom: bad column'); }, {}, C, L, {});
  check('NON-timeout error keeps the best-effort run_sql fallback message',
    !!nonTimeout.error && /run_sql/.test(nonTimeout.error) && !nonTimeout.timed_out, nonTimeout);

  // ── A2: timeout path is independent of the run_sql gate (via handleTool) ────
  console.log('\n- A2: timeout deferral independent of isRunSqlAllowed() -');
  process.env.BOTELLA_ALLOW_RUNSQL_WITHOUT_RLS = 'true';
  check('isRunSqlAllowed() === true for this assertion', isRunSqlAllowed() === true);
  let qCalls = 0, hCalls = 0;
  const spyPool = { query: async () => { qCalls++; return { rows: [], rowCount: 0 }; } };
  const mockHandlers = { get_category_breakdown: async () => { hCalls++; throw new Error('Metric query timed out'); } };
  const out = await handleTool(
    { name: 'get_category_breakdown', input: { window: 'all_time' } },
    spyPool, C, L, { handlers: mockHandlers });
  check('handleTool returns cant_answer on heavy timeout even with run_sql ALLOWED',
    out?.confidence?.label === 'cant_answer' && out.fallback_blocked === true, out);
  check('NO run_sql / DB query executed on the timeout path (pool.query never called)', qCalls === 0, `qCalls=${qCalls}`);
  check('mock heavy handler retried once under handleTool too', hCalls === 2, `hCalls=${hCalls}`);

  // ── Audit round-2 fixes: bare-month enforcement, tax, per-unit ────────────
  console.log('\n- Audit fix 1: bare-month receipt counts (server-resolved year) -');
  // THE FIX: a bare month is resolved on the SERVER from the warehouse's own
  // latest sale date, never from the wall clock and never defaulted to an
  // arbitrary year. The property is that the resolved year is one the data
  // actually covers and the count is a real, positive number - not a
  // particular receipt count, which changes with every sync.
  for (const mo of ['september', 'october', 'december', 'june']) {
    const r = await metrics.transactionCount(pool, C, L, { window: 'month', month: mo });
    const yearIn = Number((r.date_range.label.match(/(20\d{2})/) || [])[1]);
    check(`"${mo}" resolves to a year the data covers, with real receipts`,
      Number.isInteger(yearIn) && (yearIn === LY || yearIn === LY - 1)
        && r.transactions > 0 && r.date_range.end <= latest,
      { label: r.date_range.label, txns: r.transactions, end: r.date_range.end });
  }

  console.log('\n- Audit fix 1: detectBareMonth gate (server enforcement decision) -');
  const dbm = _internal.detectBareMonth;
  check('"in September" → september', dbm('How many receipts were there in September?') === 'september');
  check('"September 2024" → null (explicit year preserved)', dbm('revenue in September 2024') === null);
  check('"last March" → march (data-relative: treated as a bare month, resolver gives 2026)', dbm('how was last March') === 'march');
  check('"September vs October" → null (comparison left to model)', dbm('September vs October revenue') === null);
  check('"may" modal → null', dbm('you may want today revenue') === null);
  check('"tax in may" → may (temporal context)', dbm('how much tax in may') === 'may');

  console.log('\n- Audit fix 2/3: tax is deterministically not-tracked -');
  for (const w of [{ window: 'this_month' }, { window: 'month', month: 'may' }, { window: 'last_year' }]) {
    const t = await metrics.tax(pool, C, L, w);
    check(`tax ${JSON.stringify(w)} → not_tracked, cant_answer, lead phrase present`,
      t.not_tracked === true && t.confidence.label === 'cant_answer'
        && /does not appear to be tracked/i.test(t.confidence.reason), t);
  }
  const taxLY = await metrics.tax(pool, C, L, { window: 'last_year' });
  check('tax "last year" resolves to 2025, not 2024', taxLY.date_range.label.includes('2025') && !taxLY.date_range.label.includes('2024'), taxLY.date_range);

  console.log('\n- Audit fix 4: per-unit keeps numerator+denominator on the line-item basis -');
  const pu = await metrics.perUnit(pool, C, L, { window: 'last_month' });
  // THE FIX: numerator and denominator on ONE basis. Pre-fix this divided a
  // receipt-subtotal revenue by line-item units and reported $12.63 against a
  // true $23.57 - a 47% understatement. The property is that the ratio
  // reconciles to its own components and the two bases agree; the dollar
  // value itself moves with the data.
  check('per-unit divides line revenue by line units, and reconciles exactly',
    pu.units > 0 && pu.line_revenue > 0
      && Math.abs(pu.revenue_per_unit - pu.line_revenue / pu.units) < 0.01
      && pu.line_item_revenue === pu.line_revenue
      && pu.basis_delta === 0 && pu.material === false,
    pu);
  check('per-unit last month now RECONCILES post-DQ-01 dedup → verified (was estimate w/ 84.5% gap)', pu.confidence.label === 'verified', pu.confidence.label);

  // ── Audit round-4: DQ-01 disguised-duplicate de-dup (acceptance gate) ──────
  console.log('\n- DQ-01: de-duped line totals reconcile to receipt headers -');
  for (const [label, win, exact] of [
    ['May 2026 (clean)', { window: 'month', month: 'may' }, true],
    ['Apr 2026 (affected)', { window: 'last_month' }, false],
    ['Mar 2026 (affected)', { window: 'month', month: 'march' }, false],
  ]) {
    const cat = await metrics.categoryBreakdown(pool, C, L, win);
    const hdr = await metrics.revenue(pool, C, L, win);
    const lineTotal = Math.round(cat.categories.reduce((a, c) => a + c.revenue, 0) * 100) / 100;
    const gapPct = hdr.revenue ? Math.abs(lineTotal - hdr.revenue) / hdr.revenue * 100 : 0;
    if (exact) check(`DQ-01 ${label}: de-duped line total == header EXACTLY (no over-collapse)`, Math.abs(lineTotal - hdr.revenue) < 0.5, { lineTotal, header: hdr.revenue });
    else check(`DQ-01 ${label}: de-duped line total within 2% of header (was ~2x pre-fix)`, gapPct < 2, { lineTotal, header: hdr.revenue, gapPct: gapPct.toFixed(2) });
  }
  // DQ-01 removed disguised duplicates - the same line repeated under
  // different "band" rows, which roughly doubled some products' revenue. The
  // durable property is that the de-duped total is materially BELOW the naive
  // sum over all rows, measured here rather than pinned to a dollar figure.
  const naive = await pool.query(
    `SELECT COALESCE(SUM(si.total_amount), 0)::numeric AS revenue
       FROM sale_items si
      WHERE si.client_id = $1 AND si.location_id = $2
        AND si.quantity > 0
        AND LOWER(si.product_name) LIKE '%terra%'`,
    [C, L]
  );
  const naiveRevenue = Number(naive.rows[0].revenue);
  const deduped = Number(byRev.products[0].revenue);
  check('DQ-01: the de-duped total is below the naive all-rows sum (band inflation removed)',
    naiveRevenue > 0 && deduped > 0 && deduped < naiveRevenue,
    { deduped, naive: naiveRevenue,
      removed_pct: (((naiveRevenue - deduped) / naiveRevenue) * 100).toFixed(1) });

  // ── Audit round-3: intent-normalization layer (runs before tool dispatch) ──
  console.log('\n- Audit fix: intent normalizer (run_sql redirect + comparison year-correction) -');
  const norm = (name, input, msg) => { const t = { name, input: input || {} }; _internal.normalizeMetricToolCall(t, msg); return t; };
  let r;
  r = norm('run_sql', { query: 'x' }, 'Count the purchases in September');
  check('run_sql "count purchases in September" → get_transaction_count window:month september',
    r.name === 'get_transaction_count' && r.input.window === 'month' && r.input.month === 'september', r);
  r = norm('run_sql', { query: 'x' }, 'How many checkouts in December?');
  check('run_sql "checkouts in December" → get_transaction_count december', r.name === 'get_transaction_count' && r.input.month === 'december', r);
  r = norm('run_sql', { query: 'x' }, 'How many purchases were made in the last 30 days?');
  check('run_sql "purchases last 30 days" → get_transaction_count last_30_days', r.name === 'get_transaction_count' && r.input.window === 'last_30_days', r);
  r = norm('run_sql', { query: 'x' }, 'How many sales over $100 in September?');
  check('filtered "sales over $100" → stays run_sql (not redirected)', r.name === 'run_sql', r);
  r = norm('run_sql', { query: 'x' }, 'How many purchase orders from my supplier?');
  check('"purchase orders / supplier" → stays run_sql', r.name === 'run_sql', r);
  // comparison: each call year-corrected independently by its own month
  r = norm('get_revenue', { start: '2024-09-01', end: '2024-09-30' }, 'Compare September revenue against October revenue');
  check('comparison Sept call (2024 dates) → window:month september', r.input.window === 'month' && r.input.month === 'september', r);
  r = norm('get_revenue', { start: '2024-10-01', end: '2024-10-31' }, 'Compare September revenue against October revenue');
  check('comparison Oct call (2024 dates) → window:month october', r.input.window === 'month' && r.input.month === 'october', r);
  r = norm('get_revenue', { start: '2024-09-01', end: '2024-09-30' }, 'revenue in September 2024');
  check('explicit "September 2024" preserved (NOT normalized)', r.input.window !== 'month' && r.input.start === '2024-09-01', r);
  r = norm('get_revenue', { window: 'last_month' }, 'how did last March do');
  check('"last March" → window:month march (data-relative decision)', r.input.window === 'month' && r.input.month === 'march', r);

  // ── Comparison guardrails: a DELIBERATE window is never month-forced ──
  // (bug: "How does July compare to last month?" had the last_month call
  // rewritten to month:july, so both comparison sides returned July and the
  // model burned all 3 loops retrying June.)
  r = norm('get_revenue', { window: 'last_month' }, 'How does July compare to last month?');
  check('"July vs last month" keeps window:last_month (phrased in message)', r.input.window === 'last_month', r);
  r = norm('get_transaction_count', { window: 'last_month' }, 'How does July compare to last month?');
  check('"July vs last month" transaction count keeps last_month too', r.input.window === 'last_month', r);
  r = norm('get_revenue', { window: 'this_month' }, 'How does July compare to last month?');
  check('unphrased this_month side still forced to month:july (equivalent)', r.input.window === 'month' && r.input.month === 'july', r);
  r = norm('get_revenue', { window: 'last_year' }, 'How does July compare to last year?');
  check('"July vs last year" keeps window:last_year', r.input.window === 'last_year', r);
  r = norm('get_revenue', { start: '2025-07-01', end: '2025-07-31' }, 'How does July compare to the same month last year?');
  check('YoY explicit prior-year July range preserved (not year-"corrected")', r.input.window !== 'month' && r.input.start === '2025-07-01', r);
  r = norm('get_revenue', { group_by: 'month', start: '2026-03-01', end: '2026-07-19' }, 'revenue by month since March');
  check('group_by month series never collapsed to a single month', r.input.group_by === 'month' && r.input.start === '2026-03-01', r);
  r = norm('get_revenue', { start: '2026-03-15', end: '2026-07-19' }, 'sales from mid March until now');
  check('explicit non-month range with one bare month stays a range', r.input.window !== 'month' && r.input.start === '2026-03-15', r);

  // oracle-backed: the normalized windows resolve to the right year+value
  const sepR = await metrics.revenue(pool, C, L, { window: 'month', month: 'september' });
  const octR = await metrics.revenue(pool, C, L, { window: 'month', month: 'october' });
  check('Sept 2025 rev $99,771.40 / Oct 2025 rev $120,893.82 (comparison resolves to 2025)',
    Math.round(sepR.revenue) === 99771 && sepR.date_range.label.includes('2025')
      && Math.round(octR.revenue) === 120894 && octR.date_range.label.includes('2025'), { sep: sepR.revenue, oct: octR.revenue });
  const lastMar = await metrics.revenue(pool, C, L, { window: 'month', month: 'march' });
  check('"last March" resolves to March 2026 ($96,271.89), not 2025',
    Math.round(lastMar.revenue) === 96272 && lastMar.date_range.label.includes('2026'), lastMar.date_range);

  console.log(`\n${fails === 0 ? '✅ round5-unit: ALL PASSED' : `⚠️  ${fails} FAILED`}`);
  await pool.end();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
