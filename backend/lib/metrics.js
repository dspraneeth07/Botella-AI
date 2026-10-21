// metrics.js - canonical metric library (Phase-2 spike: 5 metrics)
// =============================================================================
// DRAFT staged outside the repo until the baseline is under version control.
// Target location: backend/lib/metrics.js in BottleAI-AR-edits.
//
// Each metric is ONE parameterized, tested SQL pattern with its business
// definition pinned here - the LLM routes and presents; it never writes SQL
// for covered questions. Schema rules (Issues-and-Fixes §1) are baked in ONCE:
//   * sale_items.sku links to a product via EITHER products.sku OR products.upc -
//     the join key VARIES BY STORE (Zeke's/46 = sku maps 88% of revenue, upc only
//     6.5%; other stores are the reverse), so EVERY products join links on BOTH:
//     (TRIM(p.sku)=TRIM(si.sku) OR TRIM(p.upc)=TRIM(si.sku)). A single-key join
//     silently drops the majority of sales. (Was wrongly pinned to upc-only.)
//   * revenue = SUM(sales.total_amount) - receipt-header basis (owner-ratified
//     2026-06-10), cross-checked vs line items; never price×qty
//   * transactions                → COUNT(DISTINCT sale_id), never COUNT(*) line items
//   * "today" = MAX(sale_date::date) (DB lags wall clock). Data availability
//     (time-of-day, cost, customers) VARIES BY STORE - NEVER hard-code "absent":
//     measure coverage, then answer or decline (verify-before-decline). At Zeke's,
//     4/160,773 sales are midnight-stamped and cost is set on 4,919/5,001 products,
//     so time-of-day and margin ARE answerable here - declining them is a bug.
//   * tenant scope (client_id + location_id) is bound server-side from the JWT -
//     the router LLM cannot supply or omit it.
//
// Every result carries a deterministic confidence tag:
//   { label: 'verified' | 'estimate' | 'cant_answer', reason, ... }
// computed from MEASURED signals (unmapped %, unlinkable %, empty columns) -
// never from the model's judgment. ✅ verified is reserved for books-reconciling
// answers on clean fields with the date range stated.
// =============================================================================

// Timeout budgets are read from env at PROCESS START (positive integers only;
// missing / 0 / negative / NaN / non-integer all fall back to the defaults).
// BOTELLA_QUERY_TIMEOUT_MS governs light metric queries; BOTELLA_HEAVY_TIMEOUT_MS
// the heavy product/category/margin aggregations. Lowering HEAVY (e.g. =50) is
// how the timeout path is forced in tests.
const envPosInt = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
const QUERY_TIMEOUT_MS = envPosInt('BOTELLA_QUERY_TIMEOUT_MS', 10000);

async function runQuery(pool, sql, params = [], timeoutMs = QUERY_TIMEOUT_MS) {
  return Promise.race([
    pool.query(sql, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Metric query timed out')), timeoutMs)
    ),
  ]);
}
// Product/category aggregations scan all line items; ~8s on prod TODAY (no
// functional index yet - migration 001), sub-second once it's applied. Give them
// headroom under the pool's 15s statement_timeout.
const HEAVY_TIMEOUT_MS = envPosInt('BOTELLA_HEAVY_TIMEOUT_MS', 14000);

const num = (v) => (v == null ? 0 : Number(v));
const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// ─────────────────────────────────────────────────────────────────────────────
// Date-window resolution. All windows anchor to MAX(sale_date::date) - never
// CURRENT_DATE (the DB lags wall-clock). Resolved literal dates are RETURNED so
// the presenter always states the exact range (do-not-regress: never fabricate
// a date the query didn't hand back).
// ─────────────────────────────────────────────────────────────────────────────
// MAX(sale_date)::date - NOT MAX(sale_date::date): identical value (the cast is
// monotonic), but casting the COLUMN blocks the btree MIN/MAX shortcut and
// forces a full tenant scan (~50ms warm, seconds cold); this form is ~1ms via
// backward index-only scans. Cached per tenant for 60s because EVERY windowed
// metric call resolves its anchor here and the network round-trip alone costs
// ~0.5s - a ≤60s-stale anchor is harmless (resolved literal dates are still
// returned and quoted with every result).
const LATEST_SALE_TTL_MS = 60 * 1000;
const latestSaleCache = new Map(); // `${clientId}:${locationId}` -> { d, exp }
async function latestSaleDate(pool, clientId, locationId) {
  const key = `${clientId}:${locationId}`;
  const hit = latestSaleCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.d;
  const r = await runQuery(pool,
    `SELECT MAX(sale_date)::date AS d FROM sale_items WHERE client_id=$1 AND location_id=$2`,
    [clientId, locationId]);
  const d = r.rows[0]?.d ? iso(r.rows[0].d) : null;
  if (d) latestSaleCache.set(key, { d, exp: Date.now() + LATEST_SALE_TTL_MS });
  return d;
}

const addDays = (isoStr, n) => {
  const d = new Date(`${isoStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const pad2 = (n) => String(n).padStart(2, '0');
const monthStart = (isoStr) => `${isoStr.slice(0, 7)}-01`;
// Monday-start of the calendar week containing isoStr (store convention).
const weekStartMonday = (isoStr) => {
  const dow = new Date(`${isoStr}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  return addDays(isoStr, -(dow === 0 ? 6 : dow - 1));
};
// First day of the calendar quarter containing month m (1-12).
const quarterStartMonth = (m) => Math.floor((m - 1) / 3) * 3 + 1;

// Bare month name/number → 1-12 (Fix: deterministic bare-month resolution).
// Accepts "may" / "May" / "5" / 5. Returns null for anything unrecognised.
const MONTH_TO_NUM = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};
const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
function resolveMonthNumber(month) {
  if (month === undefined || month === null || month === '') return null;
  const s = String(month).trim().toLowerCase();
  if (/^\d+$/.test(s)) { const n = Number(s); return n >= 1 && n <= 12 ? n : null; }
  return MONTH_TO_NUM[s] || null;
}

// CALENDAR windows resolve to real month/year/week/quarter boundaries - NOT
// rolling N-day ranges - all anchored to MAX(sale_date) (never CURRENT_DATE):
//   today | yesterday | last_week (trailing 7d, partial latest day incl.) |
//   last_30_days | this_week (Mon-start..today) | this_month | last_month
//   (full prior cal month) | this_quarter | last_quarter | this_year (Jan1..today)
//   | last_year (full prior cal year) | all_time - or explicit {start,end}.
async function resolveWindow(pool, clientId, locationId, { window, start, end, month } = {}) {
  if (start && end) return { start: iso(start), end: iso(end), label: `${iso(start)} to ${iso(end)}` };
  const today = await latestSaleDate(pool, clientId, locationId);
  if (!today) throw new Error('No sales data found for this store');
  switch (window || 'all_time') {
    case 'today':        return { start: today, end: today, label: today };
    case 'yesterday': {  const y = addDays(today, -1); return { start: y, end: y, label: y }; }
    case 'last_week': {  const s = addDays(today, -6);
      return { start: s, end: today, label: `${s} to ${today} (trailing 7 days incl. latest partial day)` }; }
    case 'last_30_days': { const s = addDays(today, -29);
      return { start: s, end: today, label: `${s} to ${today}` }; }
    case 'this_week': { const s = weekStartMonday(today);
      return { start: s, end: today, label: `${s} to ${today} (this week)` }; }
    case 'last_month': {
      const lastDayPrev = addDays(monthStart(today), -1);        // e.g. 2026-04-30
      const s = monthStart(lastDayPrev);                          // 2026-04-01
      return { start: s, end: lastDayPrev, label: `${s} to ${lastDayPrev} (last month)` }; }
    case 'this_quarter': {
      const s = `${today.slice(0, 4)}-${pad2(quarterStartMonth(Number(today.slice(5, 7))))}-01`;
      return { start: s, end: today, label: `${s} to ${today} (this quarter)` }; }
    case 'last_quarter': {
      const thisQStart = `${today.slice(0, 4)}-${pad2(quarterStartMonth(Number(today.slice(5, 7))))}-01`;
      const lastDayPrevQ = addDays(thisQStart, -1);
      const s = `${lastDayPrevQ.slice(0, 4)}-${pad2(quarterStartMonth(Number(lastDayPrevQ.slice(5, 7))))}-01`;
      return { start: s, end: lastDayPrevQ, label: `${s} to ${lastDayPrevQ} (last quarter)` }; }
    case 'this_year': { const s = `${today.slice(0, 4)}-01-01`;
      return { start: s, end: today, label: `${s} to ${today} (year to date)` }; }
    case 'last_year': { const y = Number(today.slice(0, 4)) - 1;
      return { start: `${y}-01-01`, end: `${y}-12-31`, label: `${y} (last year)` }; }
    case 'this_month': { const s = `${today.slice(0, 7)}-01`;
      return { start: s, end: today, label: `${s} to ${today}` }; }
    case 'month': {
      // Bare month name/number → the MOST RECENT occurrence on or before the
      // latest data day. year = latest year if the month is on or before the
      // latest data month, else the prior year. The current month resolves to
      // month-to-date (end = latest data day), never the full calendar month.
      const m = resolveMonthNumber(month);
      if (!m) throw new Error(`Unknown or missing month for window 'month': ${month}`);
      const latestYear = Number(today.slice(0, 4));
      const latestMonth = Number(today.slice(5, 7));
      const year = m <= latestMonth ? latestYear : latestYear - 1;
      const s = `${year}-${pad2(m)}-01`;
      const name = MONTH_LABELS[m - 1];
      if (year === latestYear && m === latestMonth) {
        return { start: s, end: today, label: `${name} ${year} (month to date)` };
      }
      const nextFirst = m === 12 ? `${year + 1}-01-01` : `${year}-${pad2(m + 1)}-01`;
      const lastDay = addDays(nextFirst, -1);
      return { start: s, end: lastDay, label: `${name} ${year}` };
    }
    case 'all_time': {
      const r = await runQuery(pool,
        `SELECT MIN(sale_date::date) AS mn FROM sale_items WHERE client_id=$1 AND location_id=$2`,
        [clientId, locationId]);
      const s = iso(r.rows[0].mn);
      return { start: s, end: today, label: `all time (${s} to ${today})` }; }
    default: throw new Error(`Unknown window: ${window}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 1 - revenue(window|start,end)            [definition-pinner, B5 guard]
// CANONICAL BASIS (owner-ratified 2026-06-10): SUM(sales.total_amount) - the
// RECEIPT-HEADER totals, matching how the store reads its register reports.
// Every call also computes the line-item sum (SUM(sale_items.total_amount)) as
// a cross-check; when the two disagree by more than BASIS_CAVEAT_PCT the answer
// downgrades to ⚠️ with the quantified gap (ratified: "receipt totals, but if
// it is off for some reason the bot caveats it"). Both figures are returned so
// the presenter can show the reconciliation if asked.
// ─────────────────────────────────────────────────────────────────────────────
// Header-vs-line-item gap (%) above which we caveat. Tuned from measurement
// (2026-06-11, all 42 months of history): the gap is a constant background
// 0.1-0.4%, worst month ever 0.764%, zero months over 1%. At 0.5% ~1 in 3
// recent months flagged normal register noise; at 1% a caveat only fires when
// something genuinely unusual happened (owner: markers flag problems only).
const BASIS_CAVEAT_PCT = 1.0;
// Data-quality caveat thresholds. A metric carries a ⚠️ ONLY when the MEASURED gap
// exceeds these - below them the answer is clean (no marker). Markers flag real,
// quantified, located problems; they are never blanket hedges.
const MATCH_CAVEAT_PCT = 2;          // top-products / category: unmatched-revenue share
const MARGIN_CLEAN_COSTED_PCT = 95;  // margin: clean when product cost covers ≥ this %

function basisCheck(headerRevenue, lineItemRevenue) {
  const delta = r2(Math.abs(headerRevenue - lineItemRevenue));
  const deltaPct = headerRevenue ? r2((delta / headerRevenue) * 100) : 0;
  // understates = line items total MORE than the receipt headers we report, so
  // the reported (header) figure is likely below true sales - e.g. receipts with
  // a $0 or partial header that still have items on them.
  return { line_item_revenue: r2(lineItemRevenue), basis_delta: delta, basis_delta_pct: deltaPct,
           material: deltaPct > BASIS_CAVEAT_PCT, understates: lineItemRevenue > headerRevenue };
}

// Finding #5 - the quantified, honest caveat for a material header/line gap.
// When line items exceed headers the reported figure UNDERSTATES true sales, and
// revenue stays UNVERIFIED until it's tied out to an external register/Z-report.
function basisCaveat(check, label, fmt) {
  const amt = `$${check.basis_delta.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  return check.understates
    ? `The receipt-header total for ${label} likely UNDERSTATES true sales: ${amt} (${check.basis_delta_pct}%) of line-item value isn't reflected in the receipt headers (some receipts carry a $0 or partial header). Reported on the receipt-header basis per store convention, but UNVERIFIED until reconciled to your register/Z-report, treat it as an estimate.`
    : `Receipt totals for ${label} disagree with their line items by ${amt} (${check.basis_delta_pct}%), some receipts have totals that don't match the items on them. Reported on the receipt-header basis per store convention; UNVERIFIED until reconciled, treat it as an estimate.`;
}

// Fix 0 (2026-06-16): revenue basis = sales.sub_total (pre-tax NET sales). total_amount
// was BLANK on ~5% of receipts + tax-inclusive (~35% low); sub_total is populated on
// ~99.98% of receipts and corroborated by de-duped line items to 0.08%.
// Revenue is CLEAN by default (no marker - markers flag problems only). ⚠️ fires ONLY
// when the line items don't reconcile to the receipt subtotals (gap > BASIS_CAVEAT_PCT)
// - i.e. older receipts with duplicated line-item detail. The reported figure stays on
// the subtotal basis either way.
function revenueCaveat(check, label) {
  const amt = `$${check.basis_delta.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  return `For ${label}, the line-item detail doesn't fully reconcile to the receipt subtotals (they differ by ${amt}, ${check.basis_delta_pct}%), some older receipts carry duplicated line items. I'm reporting the receipt-subtotal total (the reliable basis); treat per-product breakdowns for this period as approximate.`;
}

// Monthly revenue time-series - answers "monthly sales for the past N months",
// "revenue by month", and trend questions in ONE call. Previously the model
// called get_revenue once per month and ran out of tool loops at 3, returning a
// partial (wrong) answer for "past 6 months". Default 6 months ending at the
// latest data month; honors explicit start/end. Receipt-subtotal basis, same as
// point-in-time revenue, so the monthly figures sum to the same total.
// Shared by every group_by:'month' variant: explicit start/end wins, else the
// last N months (default 6, clamped 1-36) ending at the latest data day.
async function monthlyRange(pool, clientId, locationId, args = {}) {
  const months = Math.min(Math.max(parseInt(args.months, 10) || 6, 1), 36);
  if (args.start && args.end) {
    const start = iso(args.start), end = iso(args.end);
    return { start, end, label: `${start} to ${end}, by month` };
  }
  const latest = await latestSaleDate(pool, clientId, locationId);
  const d = new Date(`${monthStart(latest)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - (months - 1));
  return {
    start: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-01`,
    end: latest,
    label: `the ${months} months ending ${latest}`,
  };
}

async function revenueMonthly(pool, clientId, locationId, args = {}) {
  const { start, end, label } = await monthlyRange(pool, clientId, locationId, args);
  const r = await runQuery(pool,
    `SELECT to_char(date_trunc('month', sale_date), 'YYYY-MM') AS month,
            ROUND(COALESCE(SUM(sub_total::numeric),0),2) AS revenue,
            COUNT(*) AS transactions
       FROM sales
      WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3::date AND sale_date < ($4::date + 1)
      GROUP BY 1 ORDER BY 1`,
    [clientId, locationId, start, end]);
  const series = r.rows.map(x => ({
    month: x.month, revenue: r2(num(x.revenue)), transactions: parseInt(x.transactions, 10) || 0,
  }));
  return {
    metric: 'revenue', group_by: 'month',
    date_range: { start, end, label },
    series, total_revenue: r2(series.reduce((a, s) => a + s.revenue, 0)),
    definition: 'Monthly revenue series = SUM(sales.sub_total) by calendar month (receipt-subtotal basis)',
    confidence: { label: 'verified', reason: `Monthly net sales for ${label}; ${series.length} month(s) returned, receipt-subtotal basis.` },
  };
}

async function revenue(pool, clientId, locationId, args = {}) {
  if (String(args.group_by || '').toLowerCase() === 'month') {
    return revenueMonthly(pool, clientId, locationId, args);
  }
  const w = await resolveWindow(pool, clientId, locationId, args);
  // sale_date >= start AND < end+1 ⟺ sale_date::date BETWEEN start AND end,
  // but the sargable form partition-prunes and index-seeks (~1ms) where the
  // column cast forced a full tenant scan (~90ms warm, seconds cold). The two
  // sales aggregates also share ONE scan instead of two subqueries.
  const r = await runQuery(pool,
    `SELECT h.revenue, h.transactions,
            (SELECT ROUND(COALESCE(SUM(total_amount::numeric),0),2) FROM sale_items
              WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3::date AND sale_date < ($4::date + 1)) AS line_item_revenue
       FROM (SELECT ROUND(COALESCE(SUM(sub_total::numeric),0),2) AS revenue, COUNT(*) AS transactions
               FROM sales
              WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3::date AND sale_date < ($4::date + 1)) h`,
    [clientId, locationId, w.start, w.end]);
  const row = r.rows[0];
  const rev = r2(num(row.revenue));
  const check = basisCheck(rev, num(row.line_item_revenue));
  return {
    metric: 'revenue',
    date_range: w,
    revenue: rev,
    transactions: parseInt(row.transactions, 10) || 0,
    ...check,
    definition: 'Revenue = SUM(sales.sub_total), receipt-subtotal (pre-tax net sales) basis',
    confidence: check.material
      ? { label: 'estimate', reason: revenueCaveat(check, w.label) }
      : { label: 'verified', reason: `Receipt-subtotal revenue for ${w.label}; line items reconcile within ${BASIS_CAVEAT_PCT}%.` },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 2 - transaction_count(window|start,end)            [definition-pinner]
// COUNT(DISTINCT sale_id) - never COUNT(*) of line items (the team's manual
// checks made that mistake; the harness, not their sheet, is ground truth).
// ─────────────────────────────────────────────────────────────────────────────
async function transactionCountMonthly(pool, clientId, locationId, args = {}) {
  const { start, end, label } = await monthlyRange(pool, clientId, locationId, args);
  const r = await runQuery(pool,
    `SELECT to_char(date_trunc('month', sale_date), 'YYYY-MM') AS month,
            COUNT(DISTINCT sale_id) AS transactions
       FROM sale_items
      WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3::date AND sale_date < ($4::date + 1)
      GROUP BY 1 ORDER BY 1`,
    [clientId, locationId, start, end]);
  const series = r.rows.map(x => ({ month: x.month, transactions: parseInt(x.transactions, 10) || 0 }));
  return {
    metric: 'transaction_count', group_by: 'month',
    date_range: { start, end, label },
    series, total_transactions: series.reduce((a, s) => a + s.transactions, 0),
    definition: 'Monthly transaction series = COUNT(DISTINCT sale_id) (distinct receipts) by calendar month',
    confidence: { label: 'verified', reason: `Monthly distinct-receipt counts for ${label}; ${series.length} month(s) returned.` },
  };
}

async function transactionCount(pool, clientId, locationId, args = {}) {
  if (String(args.group_by || '').toLowerCase() === 'month') {
    return transactionCountMonthly(pool, clientId, locationId, args);
  }
  const w = await resolveWindow(pool, clientId, locationId, args);
  const r = await runQuery(pool,
    `SELECT COUNT(DISTINCT sale_id) AS txns FROM sale_items
      WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3::date AND sale_date < ($4::date + 1)`,
    [clientId, locationId, w.start, w.end]);
  return {
    metric: 'transaction_count',
    date_range: w,
    transactions: parseInt(r.rows[0].txns, 10) || 0,
    definition: 'Transactions = COUNT(DISTINCT sale_id) (distinct receipts)',
    confidence: { label: 'verified', reason: `Distinct receipts for ${w.label}.` },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 3 - sales_on_day(date | 'first_day' | 'last_day')        [B2 killer]
// The aggregate is FILTERED TO THE DAY - never a MIN/MAX(date) label glued to
// an unfiltered SUM (the $12,871,360.64-for-one-day bug).
// ─────────────────────────────────────────────────────────────────────────────
async function salesOnDay(pool, clientId, locationId, args = {}) {
  let day = args.date ? iso(args.date) : null;
  if (!day || args.date === 'first_day' || args.date === 'last_day') {
    const r = await runQuery(pool,
      `SELECT MIN(sale_date)::date AS mn, MAX(sale_date)::date AS mx
         FROM sale_items WHERE client_id=$1 AND location_id=$2`,
      [clientId, locationId]);
    day = args.date === 'first_day' ? iso(r.rows[0].mn) : iso(r.rows[0].mx);
  }
  // Half-open day range (⟺ sale_date::date = day) prunes to one partition and
  // index-seeks; the two sales aggregates and the two sale_items aggregates
  // each share one scan instead of four subqueries.
  const r = await runQuery(pool,
    `SELECT h.revenue, h.transactions, li.units, li.line_item_revenue
       FROM (SELECT ROUND(COALESCE(SUM(sub_total::numeric),0),2) AS revenue, COUNT(*) AS transactions
               FROM sales
              WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3::date AND sale_date < ($3::date + 1)) h,
            (SELECT COALESCE(SUM(quantity::numeric),0) AS units,
                    ROUND(COALESCE(SUM(total_amount::numeric),0),2) AS line_item_revenue
               FROM sale_items
              WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3::date AND sale_date < ($3::date + 1)) li`,
    [clientId, locationId, day]);
  const row = r.rows[0];
  const rev = r2(num(row.revenue));
  const check = basisCheck(rev, num(row.line_item_revenue));
  return {
    metric: 'sales_on_day',
    date: day,
    revenue: rev,
    transactions: parseInt(row.transactions, 10) || 0,
    units: num(row.units),
    ...check,
    definition: 'Single-day totals on the receipt-subtotal (pre-tax net sales) basis, filtered to that exact date',
    confidence: check.material
      ? { label: 'estimate', reason: revenueCaveat(check, day) }
      : { label: 'verified', reason: `Receipt-subtotal totals for ${day}; line items reconcile within ${BASIS_CAVEAT_PCT}%.` },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 4 - dead_stock(days=90)                                  [B1 killer]
// In-stock products with NO sale in the trailing N days ending at the latest
// sale date. Anti-join links sale_items.sku to a product on EITHER key -
// (TRIM(si.sku)=TRIM(p.sku) OR =TRIM(p.upc)) - because the feed's join key varies
// by store (Zeke's=sku, others=upc); a single-key join falsely flags items that
// actually sold under the other key as dead. unlinkable = no usable key at all.
//
// HONESTY ADDITION (deviation from spec's bare ✅ - flagged deliberately):
// products with a NULL/blank UPC can never link to sales, so they'd sit in
// "dead" forever even if they sell daily under an unmapped sku. We measure that
// unlinkable share; if it is material the answer downgrades to ⚠️ estimate
// with the quantified reason. ✅ means "passed every check we can run".
// ─────────────────────────────────────────────────────────────────────────────
async function deadStock(pool, clientId, locationId, args = {}) {
  const days = Number.isFinite(Number(args.days)) && Number(args.days) > 0 ? Number(args.days) : 90;
  const r = await runQuery(pool,
    `WITH anchor AS (
       SELECT MAX(sale_date)::date AS today FROM sale_items
        WHERE client_id=$1 AND location_id=$2
     ),
     sold AS (
       -- Distinct keys that SOLD in the trailing window, computed ONCE. The old
       -- per-product correlated NOT EXISTS with a TRIM-OR predicate couldn't use
       -- an index and ran ~11s on the live DB (over the 10s budget → timeout).
       -- This pre-aggregate (one windowed scan) makes the metric index-independent
       -- and sub-second; identical result. Window unchanged:
       -- sale_date >= today - N + 1 ⟺ sale_date::date > today - N (sargable form).
       SELECT DISTINCT TRIM(sku) AS k FROM sale_items
        WHERE client_id=$1 AND location_id=$2
          AND sale_date >= (SELECT today FROM anchor) - $3::int + 1
     ),
     ever AS (
       -- Keys that have EVER sold. Pre-aggregated for the same reason the
       -- sold CTE is: a correlated EXISTS per product cannot use an index.
       SELECT DISTINCT TRIM(sku) AS k FROM sale_items
        WHERE client_id=$1 AND location_id=$2
     )
     SELECT COUNT(*)                                            AS dead_count,
            COUNT(*) FILTER (WHERE NULLIF(TRIM(p.upc),'') IS NULL AND NULLIF(TRIM(p.sku),'') IS NULL) AS unlinkable_count,
            -- The CLEARABLE subset - the figure the Purchasing screen and the
            -- home tile show. Three filters, each of which changes the answer
            -- to a different question:
            --   stock_qty > 1  one leftover bottle is not a clear-out
            --   cost > 0       you can only free capital you can value
            --   ever sold      a never-sold line is an assortment mistake, a
            --                  different problem with a different fix
            COUNT(*) FILTER (
              WHERE p.stock_qty > 1 AND p.cost > 0
                AND EXISTS (SELECT 1 FROM ever WHERE ever.k = TRIM(p.sku) OR ever.k = TRIM(p.upc))
            )                                                   AS clearable_count,
            COALESCE(SUM(p.stock_qty * p.cost) FILTER (
              WHERE p.stock_qty > 1 AND p.cost > 0
                AND EXISTS (SELECT 1 FROM ever WHERE ever.k = TRIM(p.sku) OR ever.k = TRIM(p.upc))
            ), 0)                                               AS clearable_capital,
            (SELECT COUNT(*) FROM products
              WHERE client_id=$1 AND location_id=$2 AND stock_qty>0) AS in_stock_total,
            (SELECT today FROM anchor)                          AS anchor_date
       FROM products p
      WHERE p.client_id=$1 AND p.location_id=$2 AND p.stock_qty>0
        AND NOT EXISTS (SELECT 1 FROM sold WHERE sold.k = TRIM(p.sku) OR sold.k = TRIM(p.upc))`,
    [clientId, locationId, days]);
  const row = r.rows[0];
  const dead = parseInt(row.dead_count, 10) || 0;
  const unlinkable = parseInt(row.unlinkable_count, 10) || 0;

  // The CLEARABLE figures come from the Purchasing screen's own cached result,
  // not from the SQL above.
  //
  // The SQL reimplements the Python service's definition, and reimplementing a
  // definition is how two systems end up "agreeing" at 485 against 454 and
  // $60,712 against $61,487 - close enough to look right and different enough
  // to be wrong. There is one authoritative answer to "what is worth clearing",
  // the service that computes it, and its result is already sitting in
  // storeagent_capability_results where the tile reads it. Read that.
  //
  // The SQL stays as the fallback for a store whose buying report has never
  // been computed, and the response says which one it used, because an
  // approximation that cannot be told from the real figure is the whole problem
  // this is fixing.
  let clearable = {
    count: parseInt(row.clearable_count, 10) || 0,
    capital: r2(Number(row.clearable_capital) || 0),
    source: 'estimated',
  };
  try {
    const { getAnalyticsPool } = require('../database/analytics-connection');
    const { rows: [cached] } = await getAnalyticsPool().query(
      `SELECT payload->'buying'->>'dont_buy_sku_count'    AS n,
              payload->'buying'->>'dont_buy_capital_tied' AS capital,
              computed_at
         FROM storeagent_capability_results
        WHERE client_id = $1 AND location_id = $2 AND capability = 'buying'`,
      [clientId, locationId]);
    if (cached && cached.n != null) {
      clearable = {
        count: parseInt(cached.n, 10) || 0,
        capital: r2(Number(cached.capital) || 0),
        source: 'purchasing_report',
        as_of: cached.computed_at ? iso(cached.computed_at) : null,
      };
    }
  } catch (err) {
    // No cache table, no analytics pool, nothing computed yet - the estimate
    // above still answers, and its source says so.
  }
  const unlinkablePct = dead ? r2((unlinkable / dead) * 100) : 0;
  const material = unlinkablePct > 2; // >2% of "dead" items can't be linked at all
  return {
    metric: 'dead_stock',
    days,
    anchor_date: iso(row.anchor_date),
    dead_count: dead,
    in_stock_total: parseInt(row.in_stock_total, 10) || 0,
    unlinkable_count: unlinkable,
    // Two figures, because the product shows two and they were read as one.
    // The Purchasing screen's "Capital in dead stock" tile counts only what is
    // worth clearing; this tool counted everything stocked and unsold. Same
    // window, same link, different question - and with only one number in the
    // answer, a store owner asking the chat got 1,082 beside a tile reading
    // 454 and no way to tell which was wrong. Neither was.
    clearable_count: clearable.count,
    clearable_capital: clearable.capital,
    // 'purchasing_report' = the exact figures the Purchasing screen and the
    // home tile show. 'estimated' = that report has not been computed for this
    // store, so these are this module's own approximation of its rule and may
    // differ by a few products.
    clearable_source: clearable.source,
    clearable_as_of: clearable.as_of || null,
    definition: `Dead stock = in-stock products with no sale in the trailing ${days} days (link: sale_items.sku = products.sku OR products.upc). `
      + `clearable_count is the subset worth acting on - more than one on hand, a known cost, and sold at some point before - which is what the Purchasing screen and the home tile show.`,
    confidence: material
      ? { label: 'estimate',
          reason: `${unlinkable} of the ${dead} items (${unlinkablePct}%) have no SKU or UPC in the catalog and can't be matched to sales at all, they may actually be selling. Treat as an estimate until the catalog is cleaned.` }
      : { label: 'verified',
          reason: `No-sale window verified per product via SKU/UPC link; anchor ${iso(row.anchor_date)}.` },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 5 - product_count(term, split_stock=false)      [definition-pinner D4]
// Word-boundary match on product_name OR sub_category OR category. Umbrella
// terms expand to the family; specific sub-types stay STRICT (do-not-regress:
// bourbon ≠ the whole whiskey family). ⚠️ ALWAYS an estimate: there are no real
// spirit categories in this data (rum/vodka/tequila all sit under LIQUOR), so
// brands without the word in the name (Bacardi, Captain Morgan…) are missed -
// the honest, quantified caveat travels with every answer.
// ─────────────────────────────────────────────────────────────────────────────
const UMBRELLA = {
  // Mirrors the SCHEMA_PROMPT umbrella lists - keep the two in sync.
  whiskey: '(whiskey|whisky|bourbon|scotch|rye|single malt)',
  whisky:  '(whiskey|whisky|bourbon|scotch|rye|single malt)',
  wine:    '(wine|cabernet|merlot|chardonnay|pinot|sauvignon|riesling|zinfandel|malbec|syrah|rose)',
  beer:    '(beer|ale|lager|ipa|stout|pilsner|porter)',
};
function termPattern(term) {
  const t = String(term || '').trim().toLowerCase();
  if (!/^[a-z][a-z \-']{1,30}$/.test(t)) throw new Error('Invalid search term');
  const body = UMBRELLA[t] || t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `\\y${body}\\y`;
}
async function productCount(pool, clientId, locationId, args = {}) {
  const pattern = termPattern(args.term);
  const splitStock = !!args.split_stock;
  const r = await runQuery(pool,
    `SELECT COUNT(*)                                   AS total,
            COUNT(*) FILTER (WHERE stock_qty > 0)      AS in_stock,
            COUNT(*) FILTER (WHERE stock_qty = 0 OR stock_qty IS NULL) AS out_of_stock,
            COUNT(*) FILTER (WHERE stock_qty < 0)      AS negative_stock
       FROM products
      WHERE client_id=$1 AND location_id=$2
        AND (product_name ~* $3 OR sub_category ~* $3 OR category ~* $3)`,
    [clientId, locationId, pattern]);
  const row = r.rows[0];
  const isUmbrella = !!UMBRELLA[String(args.term || '').trim().toLowerCase()];
  return {
    metric: 'product_count',
    term: args.term,
    matched_by: isUmbrella ? 'family expansion (umbrella term)' : 'strict word-boundary',
    // Exact filter used - a "show me the list" follow-up MUST reuse this same
    // pattern on (product_name | sub_category | category) so the list
    // reconciles with this count (list-after-count consistency).
    match_pattern: pattern,
    total: parseInt(row.total, 10) || 0,
    ...(splitStock ? {
      in_stock: parseInt(row.in_stock, 10) || 0,
      // Out of stock is strictly zero (or unrecorded) on hand. Negative stock
      // is its own bucket - oversold / unposted receiving, not an empty shelf -
      // so it is never folded in here. The three buckets sum to `total`.
      out_of_stock: parseInt(row.out_of_stock, 10) || 0,
      negative_stock: parseInt(row.negative_stock, 10) || 0,
    } : {}),
    definition: `Products matching '${args.term}' by word-boundary on name OR sub-category OR category${isUmbrella ? ' (expanded to the family)' : ' (strict)'}`,
    confidence: { label: 'estimate',
      reason: `Matched by the word '${args.term}' in the name/category, this store's data has no real spirit categories, so big brands without the word in the name may be missed. Consistent count, possibly incomplete.` },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 6 - top_products(window|start,end, limit=10)            [F2 killer]
// Ranks products by revenue. CRITICAL: links sale_items to the catalog on BOTH
// keys (sku OR upc - varies by store; a single-key join made the bot report the
// top product 10x low, $15,774 vs the true $152,358.90). De-dupes per sku so a
// line matching more than one product row counts once. Pre-aggregates sale_items
// by sku FIRST so it uses ix_sale_items_sku and stays fast instead of timing out.
// Always an ⚠️ estimate: line-item basis + the unmatched share is disclosed.
// ─────────────────────────────────────────────────────────────────────────────
async function topProducts(pool, clientId, locationId, args = {}) {
  const w = await resolveWindow(pool, clientId, locationId, args);
  const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.min(Number(args.limit), 50) : 10;
  // sort_by maps to a WHITELISTED output column - raw input is never interpolated.
  // The ORDER BY runs BEFORE the LIMIT, so the true leaders by the chosen basis
  // survive the cut (ranking by revenue then LIMIT used to hide the units leader).
  const SORT_COLS = { revenue: 'revenue', units: 'units', transactions: 'transactions' };
  const sortBy = SORT_COLS[String(args.sort_by || '').toLowerCase()] || 'revenue';
  const basisLabel = sortBy === 'units' ? 'units sold'
    : sortBy === 'transactions' ? 'number of transactions' : 'revenue';
  const r = await runQuery(pool,
    `WITH line_sku AS (
       -- DQ-01 (fixed 2026-06-25): collapse CROSS-SKU ETL twins (Sep'25 to Apr'26 feed
       -- band: one physical line ingested under two skus, sharing name/qty/price/total)
       -- WITHOUT dropping genuine SAME-SKU repeat lines (the same product rung twice on
       -- one receipt). The old DISTINCT ON (sale_id,name,qty,price,total_amount) collapsed
       -- BOTH, silently under-counting repeat-heavy stores by up to ~18% of line revenue
       -- (measured across all 78 tenants). Fix: aggregate per (line-identity, sku) keeping
       -- the row multiplicity, then keep the DOMINANT sku per line-identity group - twins
       -- differ only in sku (the minority sku drops), real repeats share it (their full
       -- count survives via mult). Twin removal preserved (store 46 ~6%, store 2 ~2.5%).
       SELECT sale_id, TRIM(sku) AS k, product_name, quantity, price, total_amount, COUNT(*) AS mult
         FROM sale_items
        WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3 AND sale_date < ($4::date + 1)
        GROUP BY sale_id, TRIM(sku), product_name, quantity, price, total_amount),
     deduped AS (
       SELECT DISTINCT ON (sale_id, product_name, quantity, price, total_amount)
              sale_id, k, quantity, total_amount, mult
         FROM line_sku
        ORDER BY sale_id, product_name, quantity, price, total_amount, mult DESC, k),
     si_agg AS (
       SELECT k, SUM(total_amount*mult) rev, SUM(quantity*mult) u, COUNT(DISTINCT sale_id) tx
         FROM deduped
        GROUP BY k),
     prod_keys AS (
       -- Normalize sku+upc into one key column so the link is a plain hash join on
       -- equality (the OR-of-two-TRIMs couldn't index and re-scanned the catalog per
       -- sku: ~19s+ on big stores; this is sub-second). src=0 (sku) beats src=1 (upc).
       SELECT TRIM(sku) pk, 0 src, product_name AS name FROM products
         WHERE client_id=$1 AND location_id=$2 AND NULLIF(TRIM(sku),'') IS NOT NULL
       UNION ALL
       SELECT TRIM(upc) pk, 1 src, product_name AS name FROM products
         WHERE client_id=$1 AND location_id=$2 AND NULLIF(TRIM(upc),'') IS NOT NULL),
     pick AS (
       SELECT DISTINCT ON (s.k) s.k, s.rev, s.u, s.tx, pk.name
         FROM si_agg s
         LEFT JOIN prod_keys pk ON pk.pk = s.k
        ORDER BY s.k, pk.src)
     SELECT name,
            ROUND(SUM(rev),2) AS revenue, SUM(u) AS units, SUM(tx) AS transactions,
            (SELECT ROUND(SUM(rev),2) FROM pick) AS total_rev,
            (SELECT ROUND(SUM(rev),2) FROM pick WHERE NULLIF(TRIM(name),'') IS NOT NULL) AS matched_rev,
            (SELECT ROUND(COALESCE(SUM(sub_total::numeric),0),2) FROM sales
               WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3 AND sale_date < ($4::date + 1)) AS header_rev
       FROM pick
      WHERE NULLIF(TRIM(name),'') IS NOT NULL
      GROUP BY name
      ORDER BY ${sortBy} DESC
      LIMIT ${limit}`,
    [clientId, locationId, w.start, w.end], HEAVY_TIMEOUT_MS);
  const products = r.rows.map(x => ({
    product_name: (x.name || '').trim(), revenue: r2(num(x.revenue)),
    units: num(x.units), transactions: parseInt(x.transactions, 10) || 0,
  }));
  const total = num(r.rows[0]?.total_rev);
  const matched = num(r.rows[0]?.matched_rev);
  const unmatchedPct = total ? r2(((total - matched) / total) * 100) : 0;
  const matchedPct = r2(100 - unmatchedPct);
  // DQ-01 backstop: even after de-dup, if the (de-duped) line total still runs
  // materially above the receipt subtotals for the window, product-level dollars
  // are approximate - flag it (residual duplicated lines / legitimate twins).
  const basis = basisCheck(num(r.rows[0]?.header_rev), total);
  const flagged = unmatchedPct > MATCH_CAVEAT_PCT || basis.material;
  let reason;
  if (!flagged) {
    reason = `Top products by ${basisLabel} for ${w.label}; ${matchedPct}% of sales link cleanly to the catalog.`;
  } else {
    const parts = [];
    if (unmatchedPct > MATCH_CAVEAT_PCT) parts.push(`${unmatchedPct}% of sales can't be linked to a product`);
    if (basis.material) parts.push(`line-item detail still runs ${basis.basis_delta_pct}% above receipt subtotals for this period (residual duplicated lines)`);
    reason = `Ranked by ${basisLabel} for ${w.label}, the ordering is reliable but treat the totals as close estimates (${parts.join('; ')}).`;
  }
  return {
    metric: 'top_products', date_range: w, limit, sort_by: sortBy, products,
    matched_pct: matchedPct, unmatched_pct: unmatchedPct, basis_delta_pct: basis.basis_delta_pct,
    definition: `Top products by ${basisLabel} (line-item basis), linked on sale_items.sku = products.sku OR products.upc, de-duped per line AND per duplicate-twin line identity`,
    confidence: { label: flagged ? 'estimate' : 'verified', reason },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 7 - category_breakdown(window|start,end)                 [F2 killer]
// Revenue share by category, same both-keys + de-dupe + pre-aggregate shape as
// top_products. The UNMATCHED revenue is NOT dropped - it gets its own
// "Unmapped / uncategorized" row so the shares sum to total sales (the old
// dashboard query silently dropped 93.5% under the upc-only join).
// ─────────────────────────────────────────────────────────────────────────────
async function categoryBreakdown(pool, clientId, locationId, args = {}) {
  const w = await resolveWindow(pool, clientId, locationId, args);
  const r = await runQuery(pool,
    `WITH line_sku AS (
       -- DQ-01 (fixed 2026-06-25): collapse cross-sku ETL twins WITHOUT dropping genuine
       -- same-sku repeat lines - keep the dominant sku per line-identity group, carrying
       -- its multiplicity. See topProducts for the full rationale.
       SELECT sale_id, TRIM(sku) AS k, product_name, quantity, price, total_amount, COUNT(*) AS mult
         FROM sale_items
        WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3 AND sale_date < ($4::date + 1)
        GROUP BY sale_id, TRIM(sku), product_name, quantity, price, total_amount),
     deduped AS (
       SELECT DISTINCT ON (sale_id, product_name, quantity, price, total_amount)
              sale_id, k, quantity, total_amount, mult
         FROM line_sku
        ORDER BY sale_id, product_name, quantity, price, total_amount, mult DESC, k),
     si_agg AS (
       SELECT k, SUM(total_amount*mult) rev, SUM(quantity*mult) u
         FROM deduped
        GROUP BY k),
     prod_keys AS (
       -- Normalized sku+upc key → plain hash join on equality (see topProducts).
       SELECT TRIM(sku) pk, 0 src, category AS cat FROM products
         WHERE client_id=$1 AND location_id=$2 AND NULLIF(TRIM(sku),'') IS NOT NULL
       UNION ALL
       SELECT TRIM(upc) pk, 1 src, category AS cat FROM products
         WHERE client_id=$1 AND location_id=$2 AND NULLIF(TRIM(upc),'') IS NOT NULL),
     pick AS (
       SELECT DISTINCT ON (s.k) s.k, s.rev, s.u, pk.cat
         FROM si_agg s
         LEFT JOIN prod_keys pk ON pk.pk = s.k
        ORDER BY s.k, pk.src)
     SELECT COALESCE(
              CASE
                -- Keep RTD / Seltzer as their OWN bucket instead of letting the
                -- dash-collapse fold them into the parent ("Liquor - RTD" -> RTD,
                -- "Beer - Seltzer" -> Seltzer). Mirrors the dashboard pie
                -- (routes/dashboard.js) so the chat breakdown reconciles with it.
                WHEN TRIM(SPLIT_PART(cat,'-',2)) ~* '\\yrtd\\y'     THEN 'RTD'
                WHEN TRIM(SPLIT_PART(cat,'-',2)) ~* '\\yseltzer\\y' THEN 'Seltzer'
                ELSE NULLIF(TRIM(SPLIT_PART(cat,'-',1)),'')
              END,
              'Unmapped / uncategorized') AS category,
            ROUND(SUM(rev),2) AS revenue, SUM(u) AS units,
            ROUND(100.0*SUM(rev)/NULLIF((SELECT SUM(rev) FROM pick),0),2) AS pct_of_total,
            (SELECT ROUND(COALESCE(SUM(sub_total::numeric),0),2) FROM sales
              WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3 AND sale_date < ($4::date + 1)) AS header_rev
       FROM pick
      GROUP BY 1
      ORDER BY revenue DESC`,
    [clientId, locationId, w.start, w.end], HEAVY_TIMEOUT_MS);
  const categories = r.rows.map(x => ({
    category: x.category, revenue: r2(num(x.revenue)), units: num(x.units), pct_of_total: num(x.pct_of_total),
  }));
  const unmapped = categories.find(x => x.category === 'Unmapped / uncategorized');
  const unmappedPct = unmapped ? unmapped.pct_of_total : 0;
  // DQ-01 backstop: compare the de-duped line total to receipt subtotals for
  // the window (header total rides along in the same statement - one fewer
  // ~0.5s network round-trip than the old follow-up query).
  const lineTotal = categories.reduce((a, c) => a + c.revenue, 0);
  const basis = basisCheck(num(r.rows[0]?.header_rev), lineTotal);
  const flagged = unmappedPct > MATCH_CAVEAT_PCT || basis.material;
  let reason;
  if (!flagged) {
    reason = `Category mix for ${w.label}; only ${unmappedPct}% of revenue is unmatched.`;
  } else {
    const parts = [];
    if (unmappedPct > MATCH_CAVEAT_PCT) parts.push(`${unmappedPct}% of revenue can't be matched to a categorized product (the "Unmapped / uncategorized" row)`);
    if (basis.material) parts.push(`line-item detail runs ${basis.basis_delta_pct}% above receipt subtotals for this period (residual duplicated lines)`);
    reason = `Category mix for ${w.label}, shares are reliable but treat absolute dollars as close estimates (${parts.join('; ')}).`;
  }
  return {
    metric: 'category_breakdown', date_range: w, categories, unmapped_pct: unmappedPct, basis_delta_pct: basis.basis_delta_pct,
    definition: 'Revenue by category, linked on sale_items.sku = products.sku OR products.upc, de-duped per line AND per duplicate-twin line identity; unmatched sales kept as their own row',
    confidence: { label: flagged ? 'estimate' : 'verified', reason },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 8 - margin(window|start,end, term?)               [C2: no-timeout margin]
// Gross margin on the LINE-ITEM revenue basis (unchanged), using the same
// pre-aggregated both-keys + de-dupe shape as top_products / dead_stock so it's
// index-independent and sub-second (the run_sql cost join hit 461s all-time).
// Optional `term` filters to a spirit/category (e.g. whiskey) by word-match on the
// linked product. ALWAYS an ⚠️ estimate: discloses the COSTED share, because
// uncosted revenue is carried at zero cost (so the % runs a little high).
// ─────────────────────────────────────────────────────────────────────────────
// Store-wide cost coverage for the margin gate, cached per tenant: the catalog's
// costed share only moves on a catalog reload, and the extra round-trip costs
// ~0.5s on every margin call. TTL keeps a reload visible within 10 minutes.
const COST_GATE_TTL_MS = 10 * 60 * 1000;
const costGateCache = new Map(); // `${clientId}:${locationId}` -> { pct, exp }
async function costedProductPct(pool, clientId, locationId) {
  const key = `${clientId}:${locationId}`;
  const hit = costGateCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.pct;
  const cov = await runQuery(pool,
    `SELECT ROUND(100.0*COUNT(*) FILTER (WHERE cost>0)/NULLIF(COUNT(*),0),1) AS pct
       FROM products WHERE client_id=$1 AND location_id=$2`, [clientId, locationId]);
  const pct = num(cov.rows[0]?.pct);
  costGateCache.set(key, { pct, exp: Date.now() + COST_GATE_TTL_MS });
  return pct;
}

async function marginMonthly(pool, clientId, locationId, args = {}) {
  const { start, end, label } = await monthlyRange(pool, clientId, locationId, args);
  const term = String(args.term || '').trim();
  const pattern = term ? termPattern(term) : null;
  // Same fast cost-coverage gate as the single-window margin (cached).
  const COSTED_MIN_PCT = 5;
  const productCostedPct = await costedProductPct(pool, clientId, locationId);
  if (productCostedPct < COSTED_MIN_PCT) {
    return {
      metric: 'margin', group_by: 'month', date_range: { start, end, label }, term: term || null,
      series: [], costed_pct: 0,
      definition: 'Gross margin requires product cost; this store has essentially none.',
      confidence: { label: 'cant_answer', reason: `Product cost isn't recorded for this store (cost is set on ${productCostedPct}% of products), so a gross margin can't be computed, it would just read ~100%. Margin unlocks once cost data is loaded.` },
    };
  }
  const params = [clientId, locationId, start, end];
  if (pattern) params.push(pattern);
  // Identical dedup + both-keys shape as margin(), with a month dimension.
  // The line-identity key includes sale_id (one receipt = one date = one
  // month), so twin-collapsing behaves exactly as in the single-window query.
  const r = await runQuery(pool,
    `WITH line_sku AS (
       SELECT sale_id, date_trunc('month', sale_date) AS m, TRIM(sku) AS k,
              product_name, quantity, price, total_amount, COUNT(*) AS mult
         FROM sale_items
        WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3 AND sale_date < ($4::date + 1)
        GROUP BY sale_id, date_trunc('month', sale_date), TRIM(sku), product_name, quantity, price, total_amount),
     deduped AS (
       SELECT DISTINCT ON (sale_id, product_name, quantity, price, total_amount)
              m, k, quantity, total_amount, mult
         FROM line_sku
        ORDER BY sale_id, product_name, quantity, price, total_amount, mult DESC, k),
     si_agg AS (
       SELECT m, k, SUM(total_amount*mult) rev, SUM(quantity*mult) qty
         FROM deduped
        GROUP BY m, k),
     prod_keys AS (
       SELECT TRIM(sku) pk, 0 src, cost, product_name, category, sub_category FROM products
         WHERE client_id=$1 AND location_id=$2 AND NULLIF(TRIM(sku),'') IS NOT NULL
       UNION ALL
       SELECT TRIM(upc) pk, 1 src, cost, product_name, category, sub_category FROM products
         WHERE client_id=$1 AND location_id=$2 AND NULLIF(TRIM(upc),'') IS NOT NULL),
     pick AS (
       SELECT DISTINCT ON (s.m, s.k) s.m, s.k, s.rev, s.qty, pk.cost, pk.product_name, pk.category, pk.sub_category
         FROM si_agg s
         LEFT JOIN prod_keys pk ON pk.pk = s.k
        ORDER BY s.m, s.k, pk.src)
     SELECT to_char(m, 'YYYY-MM') AS month,
            ROUND(SUM(rev),2) AS line_revenue,
            -- COST SANITY: insane costs (> 1.5× the sku's realized unit price -
            -- pack-size corruption, e.g. store 177's case costs) count as uncosted,
            -- same rule as the single-window margin above / dashboard / Daily Report.
            ROUND(SUM(CASE WHEN cost > 0 AND cost*qty <= 1.5*rev THEN cost*qty ELSE 0 END),2) AS cogs,
            ROUND(100.0*(SUM(rev)-SUM(CASE WHEN cost > 0 AND cost*qty <= 1.5*rev THEN cost*qty ELSE 0 END))/NULLIF(SUM(rev),0),2) AS margin_pct,
            ROUND(100.0*SUM(CASE WHEN cost > 0 AND cost*qty <= 1.5*rev THEN rev ELSE 0 END)/NULLIF(SUM(rev),0),1) AS costed_pct
       FROM pick
      ${pattern ? 'WHERE (product_name ~* $5 OR category ~* $5 OR sub_category ~* $5)' : ''}
      GROUP BY 1 ORDER BY 1`,
    params, HEAVY_TIMEOUT_MS);
  const series = r.rows.map(x => ({
    month: x.month, margin_pct: x.margin_pct == null ? null : num(x.margin_pct),
    line_revenue: r2(num(x.line_revenue)), cogs: r2(num(x.cogs)), costed_pct: num(x.costed_pct),
  }));
  const totRev = series.reduce((a, s) => a + s.line_revenue, 0);
  const totCogs = series.reduce((a, s) => a + s.cogs, 0);
  const totCosted = series.reduce((a, s) => a + s.line_revenue * s.costed_pct / 100, 0);
  const costedPct = totRev ? r2(100 * totCosted / totRev) : 0;
  let confidence;
  if (!series.length) {
    confidence = { label: 'cant_answer', reason: `No ${term ? term + ' ' : ''}sales found for ${label}, so there's no margin to compute.` };
  } else if (costedPct < COSTED_MIN_PCT) {
    confidence = { label: 'cant_answer', reason: `Product cost isn't recorded for ${term ? term + ' ' : ''}${label} (cost is set on ${costedPct}% of this revenue), so a real gross margin can't be computed, it would just read ~100%. Margin unlocks once cost data is loaded.` };
  } else if (costedPct < MARGIN_CLEAN_COSTED_PCT) {
    confidence = { label: 'estimate', reason: `Monthly gross margin for ${term ? term + ', ' : ''}${label} on the line-item basis; cost is set on ${costedPct}% of this revenue (the remainder is carried at zero cost, so the figures run a little high). Treat as close estimates.` };
  } else {
    confidence = { label: 'verified', reason: `Monthly gross margin for ${term ? term + ', ' : ''}${label}; product cost covers ${costedPct}% of revenue. ${series.length} month(s) returned.` };
  }
  return {
    metric: 'margin', group_by: 'month', date_range: { start, end, label }, term: term || null,
    series, overall_margin_pct: totRev ? r2(100 * (totRev - totCogs) / totRev) : null, costed_pct: costedPct,
    definition: 'Monthly gross margin = (line-item revenue − Σ(product cost × qty)) / line-item revenue per calendar month; both keys, de-duped per line',
    confidence,
  };
}

async function margin(pool, clientId, locationId, args = {}) {
  if (String(args.group_by || '').toLowerCase() === 'month') {
    return marginMonthly(pool, clientId, locationId, args);
  }
  const w = await resolveWindow(pool, clientId, locationId, args);
  const term = String(args.term || '').trim();
  const pattern = term ? termPattern(term) : null;
  // Fast cost-coverage gate (products table only, cached per tenant): if this
  // store has essentially no cost data, decline IMMEDIATELY instead of running
  // - and timing out on - the heavy line-item aggregation (store 125 has 0
  // cost and 1.45M lines). Store-agnostic: Zeke's ~98% costed → proceeds.
  const COSTED_MIN_PCT = 5;
  const productCostedPct = await costedProductPct(pool, clientId, locationId);
  if (productCostedPct < COSTED_MIN_PCT) {
    return {
      metric: 'margin', date_range: w, term: term || null, margin_pct: null,
      line_revenue: null, cogs: null, costed_pct: 0,
      definition: 'Gross margin requires product cost; this store has essentially none.',
      confidence: { label: 'cant_answer', reason: `Product cost isn't recorded for this store (cost is set on ${productCostedPct}% of products), so a gross margin can't be computed, it would just read ~100%. Margin unlocks once cost data is loaded.` },
    };
  }
  const params = [clientId, locationId, w.start, w.end];
  if (pattern) params.push(pattern);
  const r = await runQuery(pool,
    `WITH line_sku AS (
       -- DQ-01 (fixed 2026-06-25): collapse cross-sku ETL twins WITHOUT dropping genuine
       -- same-sku repeat lines - keep the dominant sku per line-identity group, carrying
       -- its multiplicity. See topProducts for the full rationale.
       SELECT sale_id, TRIM(sku) AS k, product_name, quantity, price, total_amount, COUNT(*) AS mult
         FROM sale_items
        WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3 AND sale_date < ($4::date + 1)
        GROUP BY sale_id, TRIM(sku), product_name, quantity, price, total_amount),
     deduped AS (
       SELECT DISTINCT ON (sale_id, product_name, quantity, price, total_amount)
              sale_id, k, quantity, total_amount, mult
         FROM line_sku
        ORDER BY sale_id, product_name, quantity, price, total_amount, mult DESC, k),
     si_agg AS (
       SELECT k, SUM(total_amount*mult) rev, SUM(quantity*mult) qty
         FROM deduped
        GROUP BY k),
     prod_keys AS (
       -- Normalized sku+upc key → plain hash join on equality (see topProducts).
       SELECT TRIM(sku) pk, 0 src, cost, product_name, category, sub_category FROM products
         WHERE client_id=$1 AND location_id=$2 AND NULLIF(TRIM(sku),'') IS NOT NULL
       UNION ALL
       SELECT TRIM(upc) pk, 1 src, cost, product_name, category, sub_category FROM products
         WHERE client_id=$1 AND location_id=$2 AND NULLIF(TRIM(upc),'') IS NOT NULL),
     pick AS (
       SELECT DISTINCT ON (s.k) s.k, s.rev, s.qty, pk.cost, pk.product_name, pk.category, pk.sub_category
         FROM si_agg s
         LEFT JOIN prod_keys pk ON pk.pk = s.k
        ORDER BY s.k, pk.src)
     SELECT ROUND(SUM(rev),2) AS line_revenue,
            ROUND(SUM(CASE WHEN cost > 0 AND cost*qty <= 1.5*rev THEN cost*qty ELSE 0 END),2) AS cogs,
            -- Margin over the costed subset only (uncosted lines excluded from BOTH
            -- sides) - same semantics as the dashboard panels and the Daily Report,
            -- so all three surfaces quote the same number. COST SANITY (matches
            -- dashboard.js buildPanelsSql): a cost above 1.5× the sku's own realized
            -- unit price is pack-size corruption (store 177 keeps case costs in the
            -- unit field) and is treated as unrecorded.
            ROUND(100.0*(SUM(rev) FILTER (WHERE cost > 0 AND cost*qty <= 1.5*rev)
                         - SUM(cost*qty) FILTER (WHERE cost > 0 AND cost*qty <= 1.5*rev))
                  /NULLIF(SUM(rev) FILTER (WHERE cost > 0 AND cost*qty <= 1.5*rev),0),2) AS margin_pct,
            ROUND(100.0*SUM(CASE WHEN cost > 0 AND cost*qty <= 1.5*rev THEN rev ELSE 0 END)/NULLIF(SUM(rev),0),1) AS costed_pct
       FROM pick
      ${pattern ? 'WHERE (product_name ~* $5 OR category ~* $5 OR sub_category ~* $5)' : ''}`,
    params, HEAVY_TIMEOUT_MS);
  const row = r.rows[0] || {};
  const marginPct = row.margin_pct == null ? null : num(row.margin_pct);
  const costedPct = num(row.costed_pct);
  // Secondary guard: even with cost data store-wide, if THIS window's revenue is
  // essentially uncosted the margin would read ~100% - decline rather than mislead.
  let confidence, reportedMargin = marginPct;
  if (marginPct == null) {
    confidence = { label: 'cant_answer', reason: `No ${term ? term + ' ' : ''}sales found for ${w.label}, so there's no margin to compute.` };
  } else if (costedPct < COSTED_MIN_PCT) {
    reportedMargin = null;
    confidence = { label: 'cant_answer', reason: `Product cost isn't recorded for ${term ? term + ' ' : ''}${w.label} (cost is set on ${costedPct}% of this revenue), so a real gross margin can't be computed, it would just read ~100%. Margin unlocks once cost data is loaded.` };
  } else if (costedPct < MARGIN_CLEAN_COSTED_PCT) {
    confidence = { label: 'estimate', reason: `Gross margin for ${term ? term + ', ' : ''}${w.label} on the line-item basis; cost is set on ${costedPct}% of this revenue (the remaining ${r2(100 - costedPct)}% has no recorded cost and is excluded from the margin). Treat as a close estimate.` };
  } else {
    confidence = { label: 'verified', reason: `Gross margin for ${term ? term + ', ' : ''}${w.label}; product cost covers ${costedPct}% of revenue.` };
  }
  return {
    metric: 'margin', date_range: w, term: term || null,
    margin_pct: reportedMargin,
    line_revenue: r2(num(row.line_revenue)),
    cogs: r2(num(row.cogs)),
    costed_pct: costedPct,
    definition: 'Gross margin = (costed line revenue − Σ(product cost × qty)) / costed line revenue, over lines with a recorded cost; both keys, de-duped per line',
    confidence,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 9 - tax(window|start|end|month)            [deterministic tax status]
// Tax lives on the receipt header (sales.tax). For Zeke's it is $0.00 on every
// receipt across all history → "not tracked", NOT a measured zero. This metric
// decides that DETERMINISTICALLY (all-time total + nonzero-row count) so the bot
// never leads with a bare "$0.00" business fact. If tax IS populated somewhere in
// history, the requested-window total is reported plainly (genuine zeros included).
// ─────────────────────────────────────────────────────────────────────────────
async function taxMonthly(pool, clientId, locationId, args = {}) {
  const { start, end, label } = await monthlyRange(pool, clientId, locationId, args);
  const r = await runQuery(pool,
    `SELECT ROUND(COALESCE(SUM(tax::numeric),0),2) AS all_time_tax,
            COUNT(*) FILTER (WHERE COALESCE(tax::numeric,0) <> 0) AS nonzero_rows
       FROM sales WHERE client_id=$1 AND location_id=$2`,
    [clientId, locationId]);
  const allTimeTax = r2(num(r.rows[0].all_time_tax));
  const nonzeroRows = parseInt(r.rows[0].nonzero_rows, 10) || 0;
  if (allTimeTax === 0 && nonzeroRows === 0) {
    return {
      metric: 'tax', group_by: 'month', date_range: { start, end, label }, not_tracked: true,
      all_time_tax: allTimeTax, nonzero_rows: nonzeroRows,
      definition: 'Tax on the receipt header (SUM(sales.tax))',
      confidence: { label: 'cant_answer',
        reason: `Tax does not appear to be tracked separately in this data. The tax field reads $0.00 on every receipt across your entire history (no receipt has a nonzero tax value), so this isn't proof no tax was collected or owed, it just isn't captured as a separate field here.` },
    };
  }
  const m = await runQuery(pool,
    `SELECT to_char(date_trunc('month', sale_date), 'YYYY-MM') AS month,
            ROUND(COALESCE(SUM(tax::numeric),0),2) AS tax_collected
       FROM sales
      WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3::date AND sale_date < ($4::date + 1)
      GROUP BY 1 ORDER BY 1`,
    [clientId, locationId, start, end]);
  const series = m.rows.map(x => ({ month: x.month, tax_collected: r2(num(x.tax_collected)) }));
  return {
    metric: 'tax', group_by: 'month', date_range: { start, end, label }, not_tracked: false,
    series, total_tax: r2(series.reduce((a, s) => a + s.tax_collected, 0)),
    definition: 'Monthly tax collected = SUM(sales.tax) by calendar month (receipt-header basis)',
    confidence: { label: 'verified', reason: `Monthly tax collected for ${label} (receipt-header basis); ${series.length} month(s) returned.` },
  };
}

async function tax(pool, clientId, locationId, args = {}) {
  if (String(args.group_by || '').toLowerCase() === 'month') {
    return taxMonthly(pool, clientId, locationId, args);
  }
  const w = await resolveWindow(pool, clientId, locationId, args);
  // One all-time scan (SUM + FILTERed COUNT together) instead of two, plus the
  // sargable window form - identical values.
  const r = await runQuery(pool,
    `SELECT a.all_time_tax, a.nonzero_rows,
            (SELECT ROUND(COALESCE(SUM(tax::numeric),0),2) FROM sales
              WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3::date AND sale_date < ($4::date + 1)) AS window_tax
       FROM (SELECT ROUND(COALESCE(SUM(tax::numeric),0),2) AS all_time_tax,
                    COUNT(*) FILTER (WHERE COALESCE(tax::numeric,0) <> 0) AS nonzero_rows
               FROM sales WHERE client_id=$1 AND location_id=$2) a`,
    [clientId, locationId, w.start, w.end]);
  const row = r.rows[0];
  const allTimeTax = r2(num(row.all_time_tax));
  const nonzeroRows = parseInt(row.nonzero_rows, 10) || 0;
  const windowTax = r2(num(row.window_tax));
  const notTracked = allTimeTax === 0 && nonzeroRows === 0;
  if (notTracked) {
    return {
      metric: 'tax', date_range: w, not_tracked: true,
      all_time_tax: allTimeTax, nonzero_rows: nonzeroRows, window_tax: windowTax,
      definition: 'Tax on the receipt header (SUM(sales.tax))',
      confidence: { label: 'cant_answer',
        reason: `Tax does not appear to be tracked separately in this data. The tax field reads $0.00 on every receipt across your entire history (no receipt has a nonzero tax value), so this isn't proof no tax was collected or owed, it just isn't captured as a separate field here.` },
    };
  }
  return {
    metric: 'tax', date_range: w, not_tracked: false,
    tax_collected: windowTax, all_time_tax: allTimeTax, nonzero_rows: nonzeroRows,
    definition: 'Tax collected = SUM(sales.tax) for the period (receipt-header basis)',
    confidence: { label: 'verified', reason: `Tax collected for ${w.label} (receipt-header basis).` },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 10 - per_unit(window|start|end|month)        [same-basis $ per unit]
// Sales dollars per unit MUST keep numerator and denominator on the SAME basis:
// line-item revenue ÷ line-item units. Dividing receipt-subtotal revenue by
// line-item units (a mixed basis) understates it (e.g. $12.63 vs the true $23.30).
// If line items don't reconcile to the subtotals for the window, the figure is
// flagged ⚠️ - but the two operands stay on one (line-item) basis regardless.
// ─────────────────────────────────────────────────────────────────────────────
async function perUnitMonthly(pool, clientId, locationId, args = {}) {
  const { start, end, label } = await monthlyRange(pool, clientId, locationId, args);
  // Same dedup shape as perUnit(), with a month dimension (sale_id pins each
  // line identity to one month, so twin-collapsing is unchanged).
  const r = await runQuery(pool,
    `WITH line_sku AS (
       SELECT sale_id, date_trunc('month', sale_date) AS m, TRIM(sku) AS k,
              product_name, quantity, price, total_amount, COUNT(*) AS mult
         FROM sale_items
        WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3 AND sale_date < ($4::date + 1)
        GROUP BY sale_id, date_trunc('month', sale_date), TRIM(sku), product_name, quantity, price, total_amount),
     deduped AS (
       SELECT DISTINCT ON (sale_id, product_name, quantity, price, total_amount)
              m, total_amount, quantity, mult
         FROM line_sku
        ORDER BY sale_id, product_name, quantity, price, total_amount, mult DESC, k),
     li AS (
       SELECT to_char(m, 'YYYY-MM') AS month,
              ROUND(COALESCE(SUM(total_amount::numeric*mult),0),2) AS line_revenue,
              COALESCE(SUM(quantity::numeric*mult),0) AS units
         FROM deduped GROUP BY 1),
     hdr AS (
       SELECT to_char(date_trunc('month', sale_date), 'YYYY-MM') AS month,
              ROUND(COALESCE(SUM(sub_total::numeric),0),2) AS header_revenue
         FROM sales
        WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3 AND sale_date < ($4::date + 1)
        GROUP BY 1)
     SELECT COALESCE(li.month, hdr.month) AS month,
            COALESCE(li.line_revenue,0) AS line_revenue, COALESCE(li.units,0) AS units,
            COALESCE(hdr.header_revenue,0) AS header_revenue
       FROM li FULL JOIN hdr ON hdr.month = li.month
      ORDER BY 1`,
    [clientId, locationId, start, end]);
  const series = r.rows.map(x => {
    const rev = r2(num(x.line_revenue)), units = num(x.units);
    return { month: x.month, revenue_per_unit: units ? r2(rev / units) : null, line_revenue: rev, units };
  });
  const totRev = r2(series.reduce((a, s) => a + s.line_revenue, 0));
  const totUnits = series.reduce((a, s) => a + s.units, 0);
  const totHdr = r2(r.rows.reduce((a, x) => a + num(x.header_revenue), 0));
  const check = basisCheck(totHdr, totRev);
  let confidence;
  if (!totUnits) {
    confidence = { label: 'cant_answer', reason: `No units sold in ${label}, so there's no per-unit figure to compute.` };
  } else if (check.material) {
    confidence = { label: 'estimate', reason: `Monthly sales per unit for ${label}, line-item revenue ÷ line-item units, kept on one basis. Note: even after de-duplicating, the line-item detail still runs ${check.basis_delta_pct}% above the receipt subtotals across this range, so treat the dollar figures as close estimates.` };
  } else {
    confidence = { label: 'verified', reason: `Monthly sales per unit for ${label} (line-item revenue ÷ line-item units, same basis); ${series.length} month(s) returned.` };
  }
  return {
    metric: 'per_unit', group_by: 'month', date_range: { start, end, label },
    series, overall_per_unit: totUnits ? r2(totRev / totUnits) : null,
    ...check,
    definition: 'Monthly sales dollars per unit = SUM(sale_items.total_amount) / SUM(sale_items.quantity) per calendar month, both operands on the line-item basis',
    confidence,
  };
}

async function perUnit(pool, clientId, locationId, args = {}) {
  if (String(args.group_by || '').toLowerCase() === 'month') {
    return perUnitMonthly(pool, clientId, locationId, args);
  }
  const w = await resolveWindow(pool, clientId, locationId, args);
  const r = await runQuery(pool,
    `WITH line_sku AS (
       -- DQ-01 (fixed 2026-06-25): collapse cross-sku ETL twins WITHOUT dropping genuine
       -- same-sku repeat lines - keep the dominant sku per line-identity group, carrying
       -- its multiplicity (numerator and denominator both scale by mult - same basis).
       SELECT sale_id, TRIM(sku) AS k, product_name, quantity, price, total_amount, COUNT(*) AS mult
         FROM sale_items
        WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3 AND sale_date < ($4::date + 1)
        GROUP BY sale_id, TRIM(sku), product_name, quantity, price, total_amount),
     deduped AS (
       SELECT DISTINCT ON (sale_id, product_name, quantity, price, total_amount)
              total_amount, quantity, mult
         FROM line_sku
        ORDER BY sale_id, product_name, quantity, price, total_amount, mult DESC, k)
     SELECT (SELECT ROUND(COALESCE(SUM(total_amount::numeric*mult),0),2) FROM deduped) AS line_revenue,
            (SELECT COALESCE(SUM(quantity::numeric*mult),0) FROM deduped) AS units,
            (SELECT ROUND(COALESCE(SUM(sub_total::numeric),0),2) FROM sales
              WHERE client_id=$1 AND location_id=$2 AND sale_date >= $3 AND sale_date < ($4::date + 1)) AS header_revenue`,
    [clientId, locationId, w.start, w.end]);
  const row = r.rows[0];
  const lineRevenue = r2(num(row.line_revenue));
  const units = num(row.units);
  const headerRevenue = r2(num(row.header_revenue));
  const perUnitVal = units ? r2(lineRevenue / units) : null;
  const check = basisCheck(headerRevenue, lineRevenue);
  let confidence;
  if (perUnitVal == null) {
    confidence = { label: 'cant_answer', reason: `No units sold in ${w.label}, so there's no per-unit figure to compute.` };
  } else if (check.material) {
    confidence = { label: 'estimate',
      reason: `Sales per unit for ${w.label} is $${perUnitVal}, line-item revenue ($${lineRevenue.toLocaleString('en-US',{minimumFractionDigits:2})}) ÷ ${units.toLocaleString('en-US')} units, kept on one (line-item) basis. Note: even after de-duplicating, the line-item detail still runs ${check.basis_delta_pct}% above the receipt subtotals for this period (residual duplicated lines / normal receipt noise), so treat it as a close estimate.` };
  } else {
    confidence = { label: 'verified', reason: `Sales per unit for ${w.label}: $${perUnitVal} (line-item revenue ÷ line-item units, same basis).` };
  }
  return {
    metric: 'per_unit', date_range: w,
    revenue_per_unit: perUnitVal, line_revenue: lineRevenue, units,
    ...check,
    definition: 'Sales dollars per unit = SUM(sale_items.total_amount) / SUM(sale_items.quantity), numerator and denominator both on the line-item basis (never receipt-subtotal ÷ line-item units)',
    confidence,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Declines - questions the DATA cannot answer (🚫). Deterministic, never a
// 0-cost artifact, never a fabricated daypart. These are data-feed gaps; each
// decline names the gap so it doubles as the data-cleanup backlog.
//
// CRITICAL (F3 fix): time_of_day and cost_derived are MEASURED-GATED, NOT
// universal. Availability VARIES BY STORE - at Zeke's/46 sales DO carry real
// times (4/160,773 midnight) and cost IS populated (4,919/5,001), so neither
// decline applies here and emitting one would be a false refusal. Only return
// these after a per-store coverage check confirms the gap (the prompt's
// verify-before-decline path). The reason text states the gap as a CONDITION
// that the caller has already measured to be true - it is not a fixed premise.
// empty_fields (cashier/register/pay_mode/suppliers) is the only one empty for
// Zeke's today; re-measure all of them when the upstream feed changes.
// ─────────────────────────────────────────────────────────────────────────────
const DECLINES = {
  time_of_day: {
    label: 'cant_answer',
    reason: "Time-of-day isn't recorded for this store (sales carry no usable timestamp), morning/afternoon/hourly questions can't be answered until the POS feed includes real times. Return ONLY after confirming COUNT(DISTINCT sale_date::time) <= 1.",
  },
  cost_derived: {
    label: 'cant_answer',
    reason: "Product cost isn't populated for this store, margin, gross profit, COGS, inventory value, and below-cost questions can't be answered until cost data is loaded. Return ONLY after confirming products.cost coverage is essentially zero.",
  },
  empty_fields: {
    label: 'cant_answer',
    reason: "That field (cashier / register / payment type / customer / supplier) is empty in this store's data feed, there's nothing recorded to report on.",
  },
};

module.exports = {
  latestSaleDate,
  resolveWindow,
  revenue,
  transactionCount,
  salesOnDay,
  deadStock,
  productCount,
  topProducts,
  categoryBreakdown,
  margin,
  tax,
  perUnit,
  DECLINES,
  _internal: { termPattern, addDays, basisCheck, basisCaveat, BASIS_CAVEAT_PCT },
};
