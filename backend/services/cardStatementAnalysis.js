/**
 * Card Statement Analysis - the engine. One extracted statement in, the
 * owner-facing analysis and the DB header columns out.
 *
 * Contract: CARD-STATEMENTS.md §5 (output), §5.1 (findings), §6 (Rebelipay).
 *
 * PURE, AND WHY THAT MATTERS HERE
 * -------------------------------
 * No I/O, no clock, no randomness: the same statement and history always give
 * the same analysis. That is what lets the detail endpoint re-run it at read
 * time (D10), so a statement uploaded before its predecessor still gets a
 * trend once the predecessor arrives, and a rules change shows up on every
 * statement without a migration. Dates stay YYYY-MM-DD strings; weekdays come
 * from Date.UTC so the server's timezone can never move a sale to another day.
 *
 * TEMPLATE COPY, NOT MODEL COPY
 * -----------------------------
 * Every title and sentence below is a template filled with numbers the
 * statement printed or that are computed from them. Nothing a model wrote is
 * shown, and nothing is compared with an industry figure (D3): `shows` is
 * what is on the page, `hidden` is what the same page's numbers add up to.
 * The API keeps both sentences; the Overview shows the figures instead (D37).
 *
 * MISSING IS NOT ZERO
 * -------------------
 * A legacy statement prints no customer counts. Reporting 0 new customers
 * would be a fact the statement never stated, so an absent section is null
 * and is listed in `missing`, and the finding that needs it says so.
 */

const DEFAULT_RULES = require('./cardStatementRules');
const { priceRebelipay } = require('./cardStatementPricing');

// Raised whenever a rule changes a figure the list shows (a flag, a count, a
// total), so rows filed by an older engine are re-filed the next time their
// owner's list loads (D44). 2: every listed day and every tagged fee flags
// its check (D46). 3: so does a notice about a new way to get statements.
// 4: finding 01 is a fact, never a flag (D48); the Rebelipay saving leaves
// out the penalty and counts a once-a-year fee once (D49).
const ANALYSIS_VERSION = 4;

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FRI_TO_SUN = new Set([5, 6, 0]);
const DAY_MS = 86400000;

// Debit counts as "charged like credit" unless it is at least this many
// percentage points cheaper (§5.1, finding 01).
const SAME_RATE_POINTS = 0.05;
const AMEX_TELL_PCT = 20;
const ACTION_KINDS = new Set(['acquirer_change', 'ach_descriptor_change', 'fee_change']);

/* ── Numbers ─────────────────────────────────────────────────────────────── */

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
// Sums run in integer cents so a 31-row total does not pick up float dust.
const cents = (v) => { const n = num(v); return n === null ? null : Math.round(n * 100); };
const dollars = (c) => (c === null ? null : c / 100);
const sumMoney = (rows, pick) => dollars(rows.reduce((s, r) => s + (cents(pick(r)) || 0), 0));
const pctOf = (part, whole) => (part === null || whole === null || !whole ? null : (part / whole) * 100);
const round4 = (v) => (v === null ? null : Math.round(v * 10000) / 10000);

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/* ── Copy formatting ─────────────────────────────────────────────────────── */

function fmtMoney(v) {
  if (v === null) return 'n/a';
  const [whole, frac] = Math.abs(v).toFixed(2).split('.');
  return `${v < 0 ? '-' : ''}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}
const fmtPct = (v, dp = 1) => (v === null ? 'n/a' : `${v.toFixed(dp)}%`);
const fmtSignedPct = (v, dp = 2) => (v === null ? 'n/a' : `${v > 0 ? '+' : ''}${v.toFixed(dp)}%`);
const fmtInt = (v) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);

/* ── Dates (strings in, strings out) ─────────────────────────────────────── */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcMs(iso) {
  const m = ISO_DATE.exec(iso || '');
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
// Whether a period is a month's worth (28 days or more), so it can stand for
// a month beside another; null when either end is unknown.
function fullMonth(start, end) {
  const a = utcMs(isoDateOf(start));
  const b = utcMs(isoDateOf(end));
  return a === null || b === null ? null : Math.round((b - a) / DAY_MS) + 1 >= 28;
}
function dowOf(iso) {
  const ms = utcMs(iso);
  return ms === null ? null : new Date(ms).getUTCDay();
}
function addDays(iso, days) {
  const ms = utcMs(iso);
  return ms === null ? null : new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}
/** "2026-07" -> "Jul 2026" */
function monthLabel(month) {
  const m = /^(\d{4})-(\d{2})/.exec(month || '');
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}
/** "2026-07-04" -> "Sat, Jul 4" */
function dayLabel(iso) {
  const m = ISO_DATE.exec(iso || '');
  return m ? `${DOW[dowOf(iso)]}, ${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : String(iso);
}
/** "2026-06-29" -> "Jun 29, 2026" */
function dateLabel(iso) {
  const m = ISO_DATE.exec(iso || '');
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : String(iso);
}
/**
 * A history row's date as YYYY-MM-DD. The service is asked for strings, but a
 * `date` that came through pg's global parser is a Date at local midnight, so
 * it is read in local time rather than shifted by toISOString().
 */
function isoDateOf(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const m = /^\d{4}-\d{2}-\d{2}/.exec(typeof value === 'string' ? value : '');
  return m ? m[0] : null;
}
/** "2026-07" shifted by n months. */
function shiftMonth(month, n) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!m) return null;
  const idx = Number(m[1]) * 12 + Number(m[2]) - 1 + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/* ── Finding scaffold ────────────────────────────────────────────────────── */

function finding(index, key, fields) {
  return {
    key,
    number: `Finding ${String(index).padStart(2, '0')}`,
    title: null,
    severity: 'info',
    flagged: false,
    available: true,
    unavailableReason: null,
    impactLabel: null,
    // Why a flagged check has its level, in a sentence the card shows (D47).
    why: null,
    isEstimate: false,
    shows: null,
    hidden: null,
    metrics: {},
    chart: null,
    table: null,
    callout: null,
    footnote: null,
    sourceRefs: [],
    ...fields,
  };
}

/* ── Sections ────────────────────────────────────────────────────────────── */

function feeLineSection(feeLines, rules) {
  if (!feeLines.length) return null;
  return feeLines.map((l, index) => {
    const tag = tagFeeLine(l, rules);
    const rate = num(l.rate);
    return {
      index,
      category: l.category || null,
      product: l.product || null,
      network: l.network || null,
      description: l.description || '',
      isDebit: Boolean(l.is_debit),
      rate,
      ratePct: rate === null ? null : rate * 100,
      baseAmount: num(l.base_amount),
      count: num(l.count),
      unitPrice: num(l.unit_price),
      feeType: l.fee_type || null,
      amount: num(l.amount),
      tag: tag.tag,
      fix: tag.fix,
    };
  });
}

/**
 * A fee description without its arithmetic tail, for quoting in a sentence:
 * "NON RECEIPT OF PCI VALIDATION 1 TRANSACTIONS AT 29.95" -> "NON RECEIPT OF PCI VALIDATION".
 */
function feeLabel(description) {
  const trimmed = String(description || '')
    .replace(/\s+\d+\s+TRANSACTIONS?\s+AT\s+\$?[\d.,]+\s*$/i, '')
    .replace(/\s+[\d.]+\s+DISC RATE TIMES\s+\$?[\d.,]+\s*$/i, '')
    .trim();
  return trimmed || String(description || '').trim();
}

/** Catalogue match on the verbatim description; an unmatched account fee is worth a question. */
function tagFeeLine(line, rules) {
  const desc = (line && line.description) || '';
  // search() ignores lastIndex, so a catalogue regex with a /g flag cannot misfire.
  const hit = (rules.feeCatalogue || []).find((e) => desc.search(e.match) !== -1);
  if (hit) return { tag: hit.tag, fix: hit.fix, period: hit.period };
  if (line && line.category === 'account') {
    return { tag: 'review', fix: 'Ask your processor what this fee is for', period: 'monthly' };
  }
  return { tag: null, fix: null, period: null };
}

function cardMixSection(cardTypes) {
  if (!cardTypes.length) return null;
  const netTotal = cardTypes.reduce((s, ct) => s + (cents(ct.net) || 0), 0);
  const rows = cardTypes.map((ct) => ({
    type: ct.type || 'OTHER',
    label: ct.label || ct.type || 'Other',
    avgTicket: num(ct.avg_ticket),
    items: num(ct.items),
    gross: num(ct.gross),
    refundItems: num(ct.refund_items),
    refunds: num(ct.refunds),
    netItems: num(ct.net_items),
    net: num(ct.net),
    sharePct: pctOf(cents(ct.net) || 0, netTotal),
  }));
  // A total is only known when every row carries the figure: one unreadable
  // count makes the total unknown, never a smaller number that looks real.
  const known = (k) => cardTypes.every((ct) => num(ct[k]) !== null);
  const sumInt = (k) => (known(k) ? cardTypes.reduce((s, ct) => s + num(ct[k]), 0) : null);
  const sumKnownMoney = (k) => (known(k) ? sumMoney(cardTypes, (ct) => ct[k]) : null);
  return {
    rows,
    totals: {
      items: sumInt('items'),
      gross: sumKnownMoney('gross'),
      refundItems: sumInt('refund_items'),
      refunds: sumKnownMoney('refunds'),
      netItems: sumInt('net_items'),
      net: known('net') ? dollars(netTotal) : null,
    },
  };
}

function customersSection(customers) {
  if (!customers) return null;
  const fresh = num(customers.new);
  const repeat = num(customers.repeat);
  if (fresh === null && repeat === null) return null;
  return {
    new: fresh,
    repeat,
    repeatSharePct: fresh === null || repeat === null ? null : pctOf(repeat, fresh + repeat),
    avgTicket: num(customers.avg_ticket),
  };
}

function inPeriod(row, period) {
  if (row.is_prior_period) return false;
  if (period.start && row.date < period.start) return false;
  if (period.end && row.date > period.end) return false;
  return true;
}

/* ── Daily anomalies ─────────────────────────────────────────────────────── */

// Each anomaly is told twice: `detail`, a sentence that stands on its own,
// and `note`, the rest of that sentence after the date and amount, for a list
// that already shows those ("Jul 31  $145.67  in fees on a day with no sales").
function dailyAnomalies(daily, funding, period, rules) {
  const anomalies = [];
  const days = daily.filter((r) => ISO_DATE.test(r.date || '') && inPeriod(r, period));
  const byDate = new Map();
  for (const r of days) if (!byDate.has(r.date)) byDate.set(r.date, r);

  // Median of the same weekday's OTHER in-period days, so a bad day cannot
  // drag its own yardstick down. A day whose sales were not read is left out:
  // missing is not $0.00.
  const weekdayMedian = (iso) => {
    const dow = dowOf(iso);
    return median(days.filter((r) => r.date !== iso && dowOf(r.date) === dow && num(r.submitted) !== null).map((r) => num(r.submitted)));
  };

  // (a) a near-empty batch followed by a spike: sales batched a day late.
  for (const r of days) {
    const next = byDate.get(addDays(r.date, 1));
    if (!next) continue;
    if (num(r.submitted) === null || num(next.submitted) === null) continue;
    const med = weekdayMedian(r.date);
    const nextMed = weekdayMedian(next.date);
    const amount = num(r.submitted);
    const nextAmount = num(next.submitted);
    if (med && nextMed && amount < rules.lowBatchRatio * med && nextAmount > rules.spikeRatio * nextMed) {
      anomalies.push({
        type: 'low_batch',
        date: r.date,
        amount: dollars(cents(amount)),
        detail: `${dayLabel(r.date)} had only ${fmtMoney(amount)} in card sales, compared with ${fmtMoney(med)} on a usual ${DOW_LONG[dowOf(r.date)]}. `
          + `Then ${dayLabel(next.date)} brought in ${fmtMoney(nextAmount)}, ${(nextAmount / nextMed).toFixed(1)} times a usual ${DOW_LONG[dowOf(next.date)]}.`,
        note: `in card sales, compared with ${fmtMoney(med)} on a usual ${DOW_LONG[dowOf(r.date)]}. Then ${dayLabel(next.date)} brought in `
          + `${fmtMoney(nextAmount)}, ${(nextAmount / nextMed).toFixed(1)} times a usual ${DOW_LONG[dowOf(next.date)]}.`,
        nextDate: next.date,
        nextAmount: dollars(cents(nextAmount)),
      });
    }
  }

  // (b) fees on a day with no sales.
  for (const r of days) {
    const fees = num(r.fees) || 0;
    const sales = num(r.submitted);
    if (sales !== null && Math.abs(sales) < 0.005 && fees > 0) {
      anomalies.push({
        type: 'zero_with_fees',
        date: r.date,
        amount: dollars(cents(fees)),
        detail: `${dayLabel(r.date)} had $0.00 in card sales but ${fmtMoney(fees)} in fees.`,
        note: 'in fees on a day with no card sales.',
      });
    }
  }

  // (c) sales from before this period carried onto this statement.
  for (const r of daily) {
    if (!r || !(r.is_prior_period || (period.start && r.date && r.date < period.start))) continue;
    anomalies.push({
      type: 'prior_period',
      date: r.date || null,
      amount: num(r.submitted),
      detail: priorDetail(num(r.submitted), r.date),
      note: 'in card sales from before this statement began, counted on this one.',
    });
  }

  // (d) one day's card sales paid in more than one deposit, on different dates.
  const split = splitFunding(funding);
  if (split.days > 0) {
    anomalies.push({
      type: 'split_funding',
      date: null,
      amount: split.lateAmount,
      detail: `On ${split.days} ${plural(split.days, 'day')}, the day's card sales were paid in more than one deposit, on different dates. `
        + `${fmtMoney(split.lateAmount)} in all came a day or more later.`,
      note: `of ${plural(split.days, "that day's", "those days'")} card sales were paid a day or more later, in a separate deposit.`,
      dates: split.dates,
    });
  }

  return anomalies;
}

// Sales dated before the statement starts but counted on it. A row read
// without its amount or its date says less, never "$0.00" or "dated null".
function priorDetail(amount, date) {
  const when = date ? `dated ${dateLabel(date)}, ` : '';
  if (amount === null) return `Card sales ${when}from before this statement began are counted on this statement.`;
  return date
    ? `${fmtMoney(amount)} in card sales dated ${dateLabel(date)}, before this statement began, are counted on this statement.`
    : `${fmtMoney(amount)} in card sales from before this statement began are counted on this statement.`;
}

function splitFunding(funding) {
  const groups = new Map();
  for (const f of funding) {
    if (!f || !f.date_submitted) continue;
    if (!groups.has(f.date_submitted)) groups.set(f.date_submitted, []);
    groups.get(f.date_submitted).push(f);
  }
  const dates = [];
  let late = 0;
  for (const [date, rows] of groups) {
    // Only sales count. Some statements fund every day's fees as a separate
    // $0 row; that is a fee debit, not a split deposit.
    const funded = [...new Set(rows.filter((r) => (num(r.submitted) || 0) > 0).map((r) => r.date_funded).filter(Boolean))].sort();
    if (funded.length < 2) continue;
    dates.push(date);
    for (const r of rows) if ((num(r.submitted) || 0) > 0 && r.date_funded > funded[0]) late += cents(r.submitted);
  }
  dates.sort();
  return { days: dates.length, dates, lateAmount: dollars(late) };
}

/* ── Finding 01: debit cards (a fact, D48) ──────────────────────────────── */

function debitFacts(x, feeLines, cardTypes, submitted) {
  const indexed = feeLines.map((l, i) => ({ l, i }));
  const rated = indexed.filter(({ l }) => num(l.rate) !== null && num(l.base_amount) !== null);
  const ratedDebit = rated.filter(({ l }) => l.is_debit);
  const ratedCredit = rated.filter(({ l }) => !l.is_debit && l.network);
  const bucket = (rows) => ({
    volume: sumMoney(rows, ({ l }) => l.base_amount),
    fees: sumMoney(rows, ({ l }) => l.amount),
  });

  let debit = null;
  let credit = null;
  let source = null;
  let debitVolume = null;
  let debitFeesPaid = null;

  if (feeLines.length) {
    debitFeesPaid = sumMoney(feeLines.filter((l) => l.is_debit), (l) => l.amount);
  }
  // The card-type fallback is used only where it can be trusted. A DEBIT
  // card-type row covers PIN debit only, so it would understate debit when the
  // fee table has debit lines it could not rate; and no DEBIT row at all says
  // nothing (Visa debit is filed under VISA), so the volume stays unknown.
  const debitRows = cardTypes.filter((ct) => ct.type === 'DEBIT');
  if (ratedDebit.length) {
    debit = bucket(ratedDebit);
    credit = ratedCredit.length ? bucket(ratedCredit) : null;
    debitVolume = debit.volume;
    source = 'fee_lines';
  } else if (!feeLines.some((l) => l.is_debit) && debitRows.length) {
    debitVolume = sumMoney(debitRows, (ct) => ct.net);
  }

  // A CSV with a fee column carries the same facts per transaction.
  const txns = Array.isArray(x.transactions) ? x.transactions.filter((t) => t && !t.is_refund) : [];
  if (!source && txns.length && txns.some((t) => num(t.fee) !== null)) {
    const pick = (isDebit) => {
      const rows = txns.filter((t) => (t.card_type === 'DEBIT') === isDebit);
      return { volume: sumMoney(rows, (t) => t.amount), fees: sumMoney(rows, (t) => t.fee) };
    };
    debit = pick(true);
    credit = pick(false);
    source = 'transactions';
    if (debitFeesPaid === null) debitFeesPaid = debit.fees;
  }

  const debitRatePct = debit && debit.volume ? pctOf(debit.fees, debit.volume) : null;
  const creditRatePct = credit && credit.volume ? pctOf(credit.fees, credit.volume) : null;
  return {
    source,
    csv: x.layout_version === 'csv',
    debitVolume,
    debitShare: pctOf(debitVolume, submitted),
    debitFeesPaid,
    debitRatePct,
    creditVolume: credit ? credit.volume : null,
    creditFeesPaid: credit ? credit.fees : null,
    creditRatePct,
    sameRate: debitRatePct === null || creditRatePct === null
      ? null : Math.abs(debitRatePct - creditRatePct) <= SAME_RATE_POINTS,
    refs: [...ratedDebit, ...ratedCredit].map(({ i }) => `fee_lines[${i}]`),
    example: ratedDebit.length
      ? ratedDebit.reduce((a, b) => ((num(b.l.base_amount) || 0) > (num(a.l.base_amount) || 0) ? b : a)).l
      : null,
  };
}

function debitFinding(f) {
  const metrics = {
    debitVolume: f.debitVolume,
    debitShare: f.debitShare,
    debitFeesPaid: f.debitFeesPaid,
    debitRatePct: f.debitRatePct,
    creditVolume: f.creditVolume,
    creditFeesPaid: f.creditFeesPaid,
    creditRatePct: f.creditRatePct,
    sameRate: f.sameRate,
  };
  if (f.debitRatePct === null) {
    let unavailableReason;
    if (f.debitVolume === 0) unavailableReason = f.csv ? 'No debit card sales in this file' : 'No debit card sales on this statement';
    else if (f.csv && f.debitVolume === null) unavailableReason = 'This file does not show which cards were debit';
    else unavailableReason = f.csv ? 'This file does not show the rate charged on debit cards'
      : 'This statement does not show the rate charged on debit cards';
    return finding(1, 'debit_at_credit_rates', {
      title: 'What debit cards cost you',
      severity: 'info',
      available: false,
      unavailableReason,
      metrics,
    });
  }

  // A fact about the store, never a flag (D48): Rebelipay prices debit and
  // credit cards the same, so calling debit at credit-card rates an
  // overcharge would argue against the offer this page makes. The card says
  // how much of the sales is debit and what it costs; the rates sit side by
  // side in its tiles.
  const flagged = false;
  const title = f.debitShare !== null ? `Debit is ${fmtPct(f.debitShare, 0)} of your card sales` : 'What debit cards cost you';

  const shows = f.source === 'fee_lines'
    ? `The fee table lists debit sales on their own lines, such as ${f.example.description}. `
      + `Together they come to ${fmtMoney(f.debitVolume)} of debit sales and ${fmtMoney(f.debitFeesPaid)} in fees.`
    : `The file lists ${fmtMoney(f.debitVolume)} of debit card sales and ${fmtMoney(f.debitFeesPaid)} in fees on them.`;

  let hidden = `Debit was charged ${fmtPct(f.debitRatePct, 2)} of every sale`
    + (f.creditRatePct === null ? '.' : `, and credit cards ${fmtPct(f.creditRatePct, 2)}.`);
  if (f.debitShare !== null) {
    hidden += ` Debit made up ${fmtPct(f.debitShare)} of your card volume ${f.csv ? 'in this file' : 'this month'}.`;
  }
  const why = null;

  return finding(1, 'debit_at_credit_rates', {
    title,
    severity: 'info',
    flagged,
    why,
    impactLabel: f.debitVolume !== null ? `${fmtMoney(f.debitVolume)} in debit card sales` : null,
    shows,
    hidden,
    metrics,
    chart: {
      type: 'debitCredit',
      bars: [
        { key: 'debit', label: 'Debit', volume: f.debitVolume, fees: f.debitFeesPaid, ratePct: f.debitRatePct },
        { key: 'credit', label: 'Credit', volume: f.creditVolume, fees: f.creditFeesPaid, ratePct: f.creditRatePct },
      ],
    },
    table: {
      type: 'math',
      cells: [
        { label: 'Debit volume', value: f.debitVolume, format: 'money' },
        { label: 'Rate charged', value: f.debitRatePct, format: 'pct' },
        { label: 'You paid on debit', value: f.debitFeesPaid, format: 'money' },
        { label: 'Share of volume', value: f.debitShare, format: 'pct' },
      ],
    },
    footnote: 'Rates are the fees on each line divided by the sales they were charged on, as printed in the fee table.',
    sourceRefs: f.refs,
  });
}

/* ── Finding 02: sales trend ─────────────────────────────────────────────── */

function trendPoints(x, history) {
  const printed = (Array.isArray(x.sales_trend) ? x.sales_trend : [])
    .filter((p) => p && /^\d{4}-\d{2}$/.test(p.month) && num(p.amount) !== null)
    .map((p) => ({ month: p.month, amount: dollars(cents(p.amount)) }))
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  if (printed.length >= 2) return { source: 'statement', points: printed };

  // Legacy statements print no trend: build it from this merchant's earlier
  // statements plus this one. Later statements never leak into an earlier
  // statement's trend.
  const end = x.period && x.period.end;
  const amount = num(x.summary && x.summary.amount_submitted);
  if (!end || amount === null) return { source: 'history', points: [] };
  const thisMonth = end.slice(0, 7);
  const byMonth = new Map();
  for (const h of history || []) {
    const hEnd = h ? isoDateOf(h.periodEnd) : null;
    const hAmount = num(h && h.amountSubmitted);
    if (!hEnd || hAmount === null || hEnd >= end) continue;
    // A short upload (a few days' CSV, a part month) is not a month of sales.
    if (fullMonth(h.periodStart, hEnd) === false) continue;
    const month = hEnd.slice(0, 7);
    if (month === thisMonth) continue;
    const seen = byMonth.get(month);
    if (!seen || hEnd > seen.end) byMonth.set(month, { end: hEnd, amount: hAmount });
  }
  const points = [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, v]) => ({ month, amount: dollars(cents(v.amount)) }));
  points.push({ month: thisMonth, amount: dollars(cents(amount)) });
  return { source: 'history', points };
}

function trendSection(x, history) {
  const { source, points } = trendPoints(x, history);
  if (points.length < 2) return { source, section: null, points };
  const last = points[points.length - 1];
  const at = (month) => points.find((p) => p.month === month) || null;
  const change = (prev) => (prev && prev.amount ? ((last.amount - prev.amount) / prev.amount) * 100 : null);

  const printedYoy = num(x.printed_yoy_pct);
  const printedMom = num(x.printed_mom_pct);
  // Ties go to the earliest month.
  const peak = points.reduce((a, b) => (b.amount > a.amount ? b : a));
  const trough = points.reduce((a, b) => (b.amount < a.amount ? b : a));
  return {
    source,
    points,
    section: {
      source,
      points,
      yoyPct: printedYoy !== null ? printedYoy : change(at(shiftMonth(last.month, -12))),
      momPct: printedMom !== null ? printedMom : change(at(shiftMonth(last.month, -1))),
      peak: { month: peak.month, amount: peak.amount },
      trough: { month: trough.month, amount: trough.amount },
    },
  };
}

/* ── The top figures against last month (D47) ─────────────────────────────── */

// From the same store's statement for the month before, when it is on file
// and comparable - a statement, not a file, covering a month's worth of days,
// as this one must - how fees, what reached the bank and the average sale
// moved (in percent), and what the effective rate and debit share were. Card
// sales take the change finding 02 shows, at the same rounding as its text, so
// the page never gives two numbers for it; `cardVolumeSource` says where it
// came from: printed on this statement, or built from the uploads. A file
// covers any span, so it has no last month.
function lastMonthFigures(x, history, kpis, trendSec, csv) {
  const end = isoDateOf(x.period && x.period.end);
  if (csv || !end) return null;
  const month = shiftMonth(end.slice(0, 7), -1);
  const prev = fullMonth(x.period.start, end) === false ? null : (history || [])
    .filter((h) => h && h.layoutVersion !== 'csv' && (isoDateOf(h.periodEnd) || '').slice(0, 7) === month
      && fullMonth(h.periodStart, h.periodEnd) !== false)
    .reduce((best, h) => (!best || isoDateOf(h.periodEnd) > isoDateOf(best.periodEnd) ? h : best), null);
  const was = (key) => (prev ? num(prev[key]) : null);
  const change = (now, then) => (now === null || then === null || !then
    ? null : Math.round(((now - then) / Math.abs(then)) * 10000) / 100);
  const mom = trendSec && num(trendSec.momPct) !== null ? Number(trendSec.momPct.toFixed(2)) : null;
  const out = {
    month,
    cardVolumePct: mom,
    cardVolumeSource: mom === null ? null : (trendSec.source === 'statement' ? 'printed' : 'uploads'),
    processingFeesPct: change(kpis.processingFees, was('totalFees')),
    netDepositedPct: change(kpis.netDeposited, was('amountProcessed')),
    avgTicketPct: change(kpis.avgTicket, was('avgTicket')),
    effectiveRate: was('effectiveRate'),
    debitShare: was('debitShare'),
  };
  return Object.keys(out).some((k) => k !== 'month' && out[k] !== null) ? out : null;
}

function trendFinding(trend, x) {
  const t = trend.section;
  if (!t) {
    return finding(2, 'sales_trend', {
      title: 'Card sales trend',
      severity: 'info',
      available: false,
      unavailableReason: 'A trend needs at least two months of card sales',
      metrics: { source: trend.source, points: trend.points, yoyPct: null, momPct: null, peak: null, trough: null, peakToTroughPct: null },
      footnote: x.layout_version === 'legacy_2026'
        ? 'This kind of statement does not list your past months of sales. Upload earlier statements or files for this store to see a trend.'
        : null,
    });
  }

  const last = t.points[t.points.length - 1];
  const peakToTroughPct = t.peak.amount ? ((t.trough.amount - t.peak.amount) / t.peak.amount) * 100 : null;
  const flagged = t.yoyPct !== null && t.yoyPct < 0;

  let title;
  if (t.yoyPct !== null) {
    title = t.yoyPct < 0
      ? `Card sales are down ${fmtPct(Math.abs(t.yoyPct), 2)} from a year ago`
      : `Card sales are up ${fmtPct(t.yoyPct, 2)} from a year ago`;
  } else if (t.momPct !== null) {
    title = t.momPct < 0
      ? `Card sales are down ${fmtPct(Math.abs(t.momPct), 2)} from last month`
      : `Card sales are up ${fmtPct(t.momPct, 2)} from last month`;
  } else {
    title = `Card sales over ${t.points.length} months`;
  }

  const span = `${monthLabel(t.points[0].month)} to ${monthLabel(last.month)}`;
  const shows = t.source === 'statement'
    ? `A ${t.points.length}-month sales chart ending at ${fmtMoney(last.amount)} this month`
      + (t.yoyPct !== null ? `, with a year over year change of ${fmtSignedPct(t.yoyPct)}.` : '.')
    : `This statement prints no sales history. Your ${t.points.length} uploaded statements for this store cover ${span}.`;

  const sentences = [];
  if (t.peak.month !== t.trough.month) {
    sentences.push(`The best month was ${monthLabel(t.peak.month)} at ${fmtMoney(t.peak.amount)} and the slowest was `
      + `${monthLabel(t.trough.month)} at ${fmtMoney(t.trough.amount)}, a swing of ${fmtPct(Math.abs(peakToTroughPct))}.`);
  }
  if (last.month !== t.peak.month && t.peak.amount) {
    sentences.push(`This month is ${fmtPct(((t.peak.amount - last.amount) / t.peak.amount) * 100)} below the best month.`);
  } else if (last.month === t.peak.month) {
    sentences.push(`This month is the best month in the series.`);
  }
  if (t.momPct !== null) sentences.push(`Against last month, sales changed ${fmtSignedPct(t.momPct)}.`);

  return finding(2, 'sales_trend', {
    title,
    severity: flagged ? 'medium' : 'low',
    flagged,
    why: flagged
      ? `Your card sales were ${fmtPct(Math.abs(t.yoyPct), 2)} lower than in the same month last year. A drop is worth checking soon, before it grows.`
      : null,
    impactLabel: t.yoyPct !== null ? `${fmtSignedPct(t.yoyPct)} vs a year ago` : (t.momPct !== null ? `${fmtSignedPct(t.momPct)} vs last month` : null),
    shows,
    hidden: sentences.join(' '),
    metrics: {
      source: t.source,
      points: t.points,
      yoyPct: t.yoyPct,
      momPct: t.momPct,
      peak: t.peak,
      trough: t.trough,
      peakToTroughPct,
    },
    chart: { type: 'trend', points: t.points, peak: t.peak, trough: t.trough },
    footnote: t.source === 'statement'
      ? 'Monthly amounts and the year over year figure are as printed on the statement.'
      : 'Built from the amount submitted on each uploaded statement for this store.',
    sourceRefs: t.source === 'statement' ? ['sales_trend'] : ['summary.amount_submitted'],
  });
}

/* ── Finding 03: customer scorecard ──────────────────────────────────────── */

function avgTicketOf(cardTypes, type) {
  const rows = cardTypes.filter((ct) => ct.type === type);
  if (!rows.length) return null;
  if (rows.length === 1 && num(rows[0].avg_ticket) !== null) return num(rows[0].avg_ticket);
  const items = rows.reduce((s, ct) => s + (num(ct.net_items) || 0), 0);
  return items ? dollars(Math.round((rows.reduce((s, ct) => s + (cents(ct.net) || 0), 0)) / items)) : null;
}

function scorecardFinding(customers, cardMix, cardTypes, kpis, csv) {
  const amex = avgTicketOf(cardTypes, 'AMEX');
  const visa = avgTicketOf(cardTypes, 'VISA');
  const amexPremiumPct = amex !== null && visa ? (amex / visa - 1) * 100 : null;
  const mix = cardMix ? cardMix.rows.map((r) => ({ type: r.type, label: r.label, net: r.net, sharePct: r.sharePct })) : [];
  const metrics = {
    newCustomers: customers ? customers.new : null,
    repeatCustomers: customers ? customers.repeat : null,
    repeatSharePct: customers ? customers.repeatSharePct : null,
    avgTicket: kpis.avgTicket,
    avgTicketSource: kpis.avgTicketSource,
    amexAvgTicket: amex,
    visaAvgTicket: visa,
    amexPremiumPct,
    effectiveRate: kpis.effectiveRate,
    cardMix: mix,
  };

  if (!customers && !cardMix) {
    return finding(3, 'customer_scorecard', {
      title: 'Your customers and the cards they use',
      available: false,
      unavailableReason: csv
        ? 'This file does not show how many customers you had or which cards they used'
        : 'This statement does not show how many customers you had or which cards they used',
      metrics,
    });
  }

  let title;
  if (customers && customers.repeatSharePct !== null) {
    title = `Repeat customers were ${fmtPct(customers.repeatSharePct)} of your card customers this month`;
  } else if (amexPremiumPct !== null && amexPremiumPct > 0) {
    title = `Amex customers spend ${fmtPct(amexPremiumPct)} more per sale than Visa customers`;
  } else {
    title = csv ? 'Which cards your customers paid with in this file' : 'Which cards your customers paid with this month';
  }

  const top = mix.length ? mix.reduce((a, b) => ((b.net || 0) > (a.net || 0) ? b : a)) : null;
  const shows = customers
    ? `Three numbers in a sidebar: ${fmtInt(customers.new || 0)} new customers, ${fmtInt(customers.repeat || 0)} repeat customers`
      + (customers.avgTicket !== null ? ` and a ${fmtMoney(customers.avgTicket)} average ticket.` : '.')
    : (csv
      ? `Card types in the file, led by ${top.label} at ${fmtPct(top.sharePct)} of volume. The file has no customer counts.`
      : `A card type table led by ${top.label} at ${fmtPct(top.sharePct)} of volume. This statement prints no customer counts.`);

  const sentences = [];
  if (customers && customers.repeatSharePct !== null) {
    sentences.push(`Repeat customers are ${fmtPct(customers.repeatSharePct)} of everyone who paid by card this month.`);
  }
  if (amexPremiumPct !== null) {
    sentences.push(amexPremiumPct >= 0
      ? `Amex tickets average ${fmtMoney(amex)} against ${fmtMoney(visa)} on Visa, ${fmtPct(amexPremiumPct)} more per visit.`
      : `Amex tickets average ${fmtMoney(amex)} against ${fmtMoney(visa)} on Visa, ${fmtPct(Math.abs(amexPremiumPct))} less per visit.`);
  }
  if (kpis.effectiveRate !== null) {
    sentences.push(`All in, processing cost ${fmtPct(kpis.effectiveRate, 2)} of card sales.`);
  }

  return finding(3, 'customer_scorecard', {
    title,
    severity: 'info',
    flagged: false,
    impactLabel: customers && customers.repeatSharePct !== null ? `${fmtPct(customers.repeatSharePct)} repeat customers` : null,
    shows,
    hidden: sentences.join(' '),
    metrics,
    chart: mix.length ? { type: 'cardMix', rows: mix } : null,
    // The card's tiles show the two tickets and the gap; the callout says
    // what they mean, once.
    callout: amexPremiumPct !== null && amexPremiumPct >= AMEX_TELL_PCT
      ? { title: 'Bigger spenders', text: 'Amex customers spend more per sale than your Visa customers.' }
      : null,
    footnote: customers
      ? 'Repeat share is repeat customers divided by new plus repeat customers. Amex premium compares the average Amex ticket with the average Visa ticket.'
      : 'Amex premium compares the average Amex ticket with the average Visa ticket.',
    sourceRefs: [...(customers ? ['customers'] : []), ...cardTypes.map((_, i) => `card_types[${i}]`)],
  });
}

/* ── Finding 04: daily patterns ──────────────────────────────────────────── */

function dailyFinding(x, dailySection, anomalies, period) {
  const daily = Array.isArray(x.daily) ? x.daily : [];
  const csv = x.layout_version === 'csv';
  const days = daily.filter((r) => r && ISO_DATE.test(r.date || '') && inPeriod(r, period));
  const split = anomalies.find((a) => a.type === 'split_funding');
  // Unknown, not zero, when the statement prints no Amounts Funded section.
  const hasFunding = Array.isArray(x.funding) && x.funding.some(Boolean);
  const splitFundingDays = hasFunding ? (split ? split.dates.length : 0) : null;
  const emptyMetrics = {
    friSunSharePct: null, biggestDay: null, daysFor60Pct: null, daysFor60SharePct: null, daysInPeriod: null, anomalies, splitFundingDays,
  };
  if (!dailySection || !days.length) {
    return finding(4, 'daily_patterns', {
      title: 'Your busiest days',
      available: false,
      unavailableReason: csv ? 'This file does not show sales by day' : 'This statement does not show sales by day',
      metrics: emptyMetrics,
    });
  }

  const totalC = days.reduce((s, r) => s + (cents(r.submitted) || 0), 0);
  const friSunC = days.filter((r) => FRI_TO_SUN.has(dowOf(r.date))).reduce((s, r) => s + (cents(r.submitted) || 0), 0);
  const biggest = days.reduce((a, b) => ((num(b.submitted) || 0) > (num(a.submitted) || 0) ? b : a));
  const sorted = days.map((r) => cents(r.submitted) || 0).sort((a, b) => b - a);
  let running = 0;
  let daysFor60Pct = 0;
  for (const c of sorted) {
    if (totalC <= 0 || running * 100 >= totalC * 60) break;
    running += c;
    daysFor60Pct += 1;
  }
  const startMs = utcMs(period.start);
  const endMs = utcMs(period.end);
  const daysInPeriod = startMs !== null && endMs !== null && endMs >= startMs
    ? Math.round((endMs - startMs) / DAY_MS) + 1 : days.length;
  // The biggest day against a usual day of its weekday (D47): the median of
  // the period's other days on that weekday whose sales were read.
  const usualBig = median(days
    .filter((r) => r.date !== biggest.date && dowOf(r.date) === dowOf(biggest.date) && num(r.submitted) !== null)
    .map((r) => num(r.submitted)));

  const metrics = {
    friSunSharePct: pctOf(friSunC, totalC),
    biggestDay: {
      date: biggest.date,
      amount: num(biggest.submitted),
      sharePct: pctOf(cents(biggest.submitted) || 0, totalC),
      usualAmount: usualBig === null ? null : dollars(cents(usualBig)),
      timesUsual: usualBig > 0 && num(biggest.submitted) !== null ? Math.round((num(biggest.submitted) / usualBig) * 10) / 10 : null,
    },
    daysFor60Pct: totalC > 0 ? daysFor60Pct : null,
    // What those days really brought in: 60% or a little more.
    daysFor60SharePct: totalC > 0 ? pctOf(running, totalC) : null,
    daysInPeriod,
    anomalies,
    splitFundingDays,
  };

  const flaggedTypes = ['low_batch', 'zero_with_fees', 'prior_period'];
  const flaggedAnomalies = anomalies.filter((a) => flaggedTypes.includes(a.type));
  // Every day listed under the chart is something to check (D46): a split
  // deposit says "check it reached your bank", so the card cannot also say
  // there is nothing to fix. A low sales day or fees with no sales is
  // medium; an earlier sale or a split deposit is low ("Worth a look").
  const flagged = anomalies.length > 0;
  const lowBatch = anomalies.find((a) => a.type === 'low_batch');
  const zero = anomalies.find((a) => a.type === 'zero_with_fees');
  const prior = anomalies.find((a) => a.type === 'prior_period');

  let title;
  if (lowBatch) title = `Very low card sales on ${dayLabel(lowBatch.date)}, then a jump the next day`;
  else if (zero) title = 'You were charged fees on a day with no card sales';
  else if (prior) title = csv ? 'This file includes sales from before its start date' : 'This statement includes sales from before its start date';
  // Flagged for a split deposit alone (D46), the title says what to check;
  // the busiest-days figure stays in its tile.
  else if (anomalies.some((a) => a.type === 'split_funding')) title = "Some days' card sales were paid in more than one deposit";
  else if (metrics.daysFor60Pct !== null) {
    title = `Your ${metrics.daysFor60Pct} busiest ${plural(metrics.daysFor60Pct, 'day')} out of ${daysInPeriod} brought in `
      + `${Math.round(metrics.daysFor60SharePct)}% of your card sales`;
  }
  else title = 'Your busiest days';

  // A transaction export can cover any span, and a short one is not a month.
  const span = csv || daysInPeriod < 28 ? 'period' : 'month';
  const sentences = [];
  if (metrics.friSunSharePct !== null) {
    sentences.push(`Friday to Sunday brought in ${fmtPct(metrics.friSunSharePct)} of card sales.`);
  }
  sentences.push(`The biggest day, ${dayLabel(biggest.date)}, took ${fmtMoney(metrics.biggestDay.amount)} `
    + `(${fmtPct(metrics.biggestDay.sharePct)} of the ${span}).`);
  if (metrics.daysFor60Pct !== null) {
    sentences.push(`60% of the ${span}'s sales came in on ${metrics.daysFor60Pct} of ${daysInPeriod} days.`);
  }
  for (const a of flaggedAnomalies) sentences.push(a.detail);

  // Say what is really on the page: a CSV has transactions, not a Summary by
  // Day table, and a table without fees is not described as having them.
  const hasDailyFees = daily.some((r) => num(r.fees) !== null);
  let shows;
  if (csv) {
    const txnCount = Array.isArray(x.transactions) ? x.transactions.filter(Boolean).length : null;
    const listed = txnCount !== null ? `${fmtInt(txnCount)} ${plural(txnCount, 'transaction')}` : 'transactions';
    shows = `The file lists ${listed} over ${daily.length} ${plural(daily.length, 'day')}${hasDailyFees ? ', with their fees' : ''}.`;
  } else {
    shows = `A Summary by Day table: ${daily.length} ${plural(daily.length, 'row')} of daily sales`
      + `${hasDailyFees ? ', fees and amounts processed' : ''}.`;
  }

  const batchNote = lowBatch
    ? "That day's card sales may have been sent a day late. If so, your deposit came later and those sales show on the wrong day in your reports. It is worth one call to your processor."
    : null;

  // Why it has its level (D47): a day that looks wrong needs a look; earlier
  // sales or a split deposit are only worth a check.
  let why = null;
  if (flagged) {
    const more = anomalies.length - 1;
    const andMore = more > 0 ? ` ${more === 1 ? 'One more item is' : `${more} more items are`} listed under the chart.` : '';
    if (lowBatch) {
      // What it can mean, and what to do, is the card's callout; this says
      // only why it needs a look.
      why = `${dayLabel(lowBatch.date)} had far fewer card sales than a usual ${DOW_LONG[dowOf(lowBatch.date)]}, then the next day jumped. `
        + `A day that looks off like this is worth checking soon.${andMore}`;
    } else if (zero) {
      why = `You were charged fees on ${dayLabel(zero.date)}, a day with no card sales. Often they are the day before's fees, charged late, but they are worth checking.${andMore}`;
    } else {
      // Each kind with its own step: earlier sales are a bookkeeping note,
      // a split deposit is money to look for.
      const split = anomalies.some((a) => a.type === 'split_funding');
      const noun = csv ? 'file' : 'statement';
      const priorStep = `keep them in mind when you match this ${noun} to your books`;
      why = prior && split
        ? `Sales from before the start date are counted on this ${noun}, and some days' sales were paid in more than one deposit. `
          + `Nothing looks wrong, but ${priorStep}, and check each deposit reached your bank.`
        : prior
          ? `Sales from before the start date are counted on this ${noun}. Nothing looks wrong, but ${priorStep}.`
          : "Some days' sales were paid in more than one deposit. Nothing looks wrong, but check each deposit reached your bank.";
    }
  }

  return finding(4, 'daily_patterns', {
    title,
    severity: lowBatch || zero ? 'medium' : (flagged ? 'low' : 'info'),
    flagged,
    why,
    impactLabel: flagged
      ? `${anomalies.length} ${plural(anomalies.length, 'item')} to check`
      : (metrics.friSunSharePct !== null ? `${fmtPct(metrics.friSunSharePct)} of sales Friday to Sunday` : null),
    shows,
    hidden: sentences.join(' '),
    metrics,
    chart: {
      type: 'daily',
      rows: dailySection.rows.map((r) => ({
        date: r.date,
        dow: r.dow,
        amount: r.submitted,
        friToSun: r.weekend,
        priorPeriod: r.priorPeriod,
        anomaly: r.anomalies.length > 0,
      })),
    },
    // Split deposits are already an anomaly row on the card, in the same
    // words, so only the batch note (an action) is a callout.
    callout: batchNote ? { title: 'What this can mean', text: batchNote } : null,
    footnote: csv
      ? 'Shares use the days in this file. Days are compared with the same weekday in the file.'
      : 'Shares use the days inside this statement period only. Days are compared with the same weekday in the month.',
    sourceRefs: daily
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => flaggedAnomalies.some((a) => a.date === r.date) || r.date === biggest.date)
      .map(({ i }) => `daily[${i}]`),
  });
}

/* ── Finding 05: junk fees ───────────────────────────────────────────────── */

function junkFinding(feeLines, rules, csv) {
  if (!feeLines.length) {
    return finding(5, 'junk_fees', {
      title: 'Junk fees not checked',
      available: false,
      unavailableReason: csv ? 'This file does not list fees by name' : 'This statement does not list fees by name',
      isEstimate: false,
      metrics: { items: [], totalAnnualised: null },
    });
  }

  const items = [];
  feeLines.forEach((l, i) => {
    const tag = tagFeeLine(l, rules);
    if (!tag.tag) return;
    const monthlyC = cents(l.amount) || 0;
    items.push({
      line: l.description || '',
      tag: tag.tag,
      monthly: dollars(monthlyC),
      annualised: dollars(tag.period === 'annual' ? monthlyC : monthlyC * 12),
      period: tag.period,
      fix: tag.fix,
      sourceRef: `fee_lines[${i}]`,
    });
  });
  const totalAnnualised = dollars(items.reduce((s, it) => s + cents(it.annualised), 0));
  const actionable = items.filter((it) => it.tag === 'penalty' || it.tag === 'negotiable');
  // Every tagged fee is something to check (D46): a card titled "1 fee to
  // check" cannot also say there is nothing to fix. A penalty or a fee that
  // could be cut is medium; one to ask about or keep watching is low.
  const flagged = items.length > 0;

  let title;
  if (actionable.length > 1) title = `${actionable.length} fees you could stop or lower`;
  else if (actionable.length === 1) {
    title = actionable[0].tag === 'penalty' ? 'A penalty fee you can stop' : 'A fee you could stop or lower';
  } else if (items.length) title = `${items.length} ${plural(items.length, 'fee')} to check`;
  else title = 'No junk fees on this statement';

  const lead = actionable[0] || items[0];
  const shows = lead
    ? (items.length === 1
      ? `One quiet line: ${feeLabel(lead.line)}, ${fmtMoney(lead.monthly)}.`
      : `${items.length} small lines among the fees, including ${feeLabel(lead.line)} at ${fmtMoney(lead.monthly)}.`)
    : 'Every fee line on this statement is a processing charge on sales.';

  const sentences = items.map((it) => {
    const kind = { penalty: 'is a penalty, not a service', negotiable: 'is worth asking to have waived', watch: 'is small today but worth watching', review: 'is not explained on the statement' }[it.tag];
    const yearly = it.period === 'annual'
      ? `It is charged once a year (${fmtMoney(it.annualised)}).`
      : `If it repeats, that is ${fmtMoney(it.annualised)} a year.`;
    return `"${feeLabel(it.line)}" ${kind}. ${yearly} Fix: ${it.fix}.`;
  });

  // Why it has its level (D47): a fee you could stop or cut costs you every
  // time it comes back; one to ask about or watch is only worth a check.
  let why = null;
  if (actionable.length) {
    const yearC = actionable.reduce((s, it) => s + cents(it.annualised), 0);
    const penalty = actionable.some((it) => it.tag === 'penalty');
    const what = actionable.length > 1 ? `${actionable.length} fees you could stop or lower`
      : penalty ? 'A penalty you can stop' : 'A fee you could stop or lower';
    // The step is the table's, row by row: a lone penalty ends once its step
    // is done; anything else, the table says how.
    const lonePenalty = actionable.length === 1 && penalty;
    why = `${what} ${actionable.length > 1 ? 'cost' : 'costs'} you about ${fmtMoney(dollars(yearC))} a year if `
      + `${actionable.length > 1 ? 'they keep' : 'it keeps'} coming. `
      + (lonePenalty ? 'It ends once you do what the table says.' : `The table says how to stop or lower ${actionable.length > 1 ? 'each one' : 'it'}.`);
  } else if (items.length) {
    // A fee we do not recognise is not known to be harmless: ask what it is.
    const unknown = items.filter((it) => it.tag === 'review').length;
    why = unknown
      ? `We don't recognise ${unknown === 1 ? 'a fee' : `${unknown} fees`} here, so we can't tell if ${unknown === 1 ? 'it' : 'they'} could be cut. `
        + `Ask your processor what ${unknown === 1 ? 'it is' : 'they are'} for.`
      : `Only ${items.length === 1 ? 'a fee' : 'fees'} to keep an eye on. None is a penalty or a fee to cut.`;
  }

  return finding(5, 'junk_fees', {
    title,
    severity: actionable.length ? 'medium' : (items.length ? 'low' : 'info'),
    flagged,
    why,
    impactLabel: items.length ? `${fmtMoney(totalAnnualised)} a year (est.)` : null,
    isEstimate: items.length > 0,
    shows,
    hidden: sentences.length ? sentences.join(' ') : 'No penalties, compliance or statement fees were charged this month.',
    metrics: { items, totalAnnualised: items.length ? totalAnnualised : 0 },
    table: items.length
      ? {
        type: 'grid',
        columns: [
          { key: 'line', label: 'Fee as printed', format: 'text' },
          { key: 'tag', label: 'Flag', format: 'tag' },
          { key: 'monthly', label: 'This month', format: 'money' },
          { key: 'annualised', label: 'A year (est.)', format: 'money' },
          { key: 'fix', label: 'What to do', format: 'text' },
        ],
        rows: items.map(({ line, tag, monthly, annualised, fix }) => ({ line, tag, monthly, annualised, fix })),
      }
      : null,
    footnote: 'A year assumes the fee repeats every month; annual fees are counted once.',
    sourceRefs: items.map((it) => it.sourceRef),
  });
}

/* ── Finding 06: fine print ──────────────────────────────────────────────── */

const NOTICE_PHRASE = {
  acquirer_change: 'the bank that sponsors your card processing changes',
  ach_descriptor_change: 'your deposits arrive under a new company name on your bank statement',
  delivery_change: 'the way you receive this statement changes',
  fee_change: 'a fee on your account changes',
  other: 'a general notice applies to your account',
};

function finePrintFinding(notices, reportableSales, disputes, x) {
  // A transaction export carries no notices, no 1099-K block and no dispute
  // detail. That is "not in this file", never "no disputes".
  if (disputes === null && !notices.length && !reportableSales) {
    return finding(6, 'fine_print', {
      title: 'Notices and disputes',
      available: false,
      unavailableReason: 'This file has no notices or dispute details',
      metrics: { notices, reportableSales, disputes: null, zeroDisputes: null },
    });
  }
  const sentences = [];
  for (const n of notices) {
    if (n.kind === 'other') continue;
    const phrase = NOTICE_PHRASE[n.kind] || NOTICE_PHRASE.other;
    sentences.push(n.effectiveDate
      ? `From ${dateLabel(n.effectiveDate)}, ${phrase}. ${n.action}`
      : `${phrase[0].toUpperCase()}${phrase.slice(1)}. ${n.action}`);
  }
  if (reportableSales && reportableSales.ytdAmount !== null) {
    sentences.push(`Your IRS-reportable card sales for ${reportableSales.ytdYear || 'this year'} reached `
      + `${fmtMoney(reportableSales.ytdAmount)}${reportableSales.monthLabel ? ` by ${reportableSales.monthLabel}` : ''}; your 1099-K is built from this figure.`);
  }
  // null when the source does not show disputes at all: neither zero nor a claim.
  const zeroDisputes = disputes === null ? null : disputes.count === 0 && !disputes.amount;
  if (zeroDisputes === true) {
    sentences.push('No disputes or chargebacks this month.');
  } else if (zeroDisputes === false && disputes.count) {
    sentences.push(`${disputes.count} ${plural(disputes.count, 'chargeback')} for ${fmtMoney(disputes.amount)} came off this month's deposits.`);
  } else if (zeroDisputes === false) {
    sentences.push(`Disputes of ${fmtMoney(disputes.amount)} came off this month's deposits.`);
  }

  const kinds = new Set(notices.map((n) => n.kind));
  const hasDisputes = zeroDisputes === false;
  // A notice that asks for a step flags the check too (D46): a new way to get
  // your statements is low ("Worth a look"). Only "other" notices, which say
  // to read them once, leave it unflagged.
  const delivery = kinds.has('delivery_change');
  const flagged = notices.some((n) => ACTION_KINDS.has(n.kind)) || hasDisputes || delivery;
  const changesMoney = kinds.has('acquirer_change') || kinds.has('ach_descriptor_change');
  let title;
  if (kinds.has('acquirer_change')) title = 'A notice says the bank behind your card processing is changing';
  else if (kinds.has('ach_descriptor_change')) title = 'A notice says your deposits will arrive under a new name';
  else if (kinds.has('fee_change')) title = 'A notice says a fee on your account is changing';
  else if (hasDisputes) {
    title = disputes.count > 1
      ? `${disputes.count} customer disputes took ${fmtMoney(disputes.amount)} off your deposits this month`
      : (disputes.count === 1
        ? `A customer dispute took ${fmtMoney(disputes.amount)} off your deposits this month`
        : `Disputes took ${fmtMoney(disputes.amount)} off your deposits this month`);
  } else if (delivery) title = 'A notice says the way you get your statements is changing';
  // Disputes not read are unknown, never "no disputes" (§5.1).
  else if (notices.length) title = zeroDisputes === true ? 'No urgent notices and no disputes' : 'No urgent notices';
  else if (zeroDisputes === null) title = x.layout_version === 'csv' ? 'No notices in this file' : 'No notices on this statement';
  else title = 'No notices and no disputes';

  // Why it has its level (D47): a new processing bank or deposit name changes
  // how your money reaches you; a fee change or a dispute needs a step; a new
  // way to get your statements only needs someone who can still get them.
  let why = null;
  if (flagged) {
    const changes = [];
    if (kinds.has('acquirer_change')) changes.push('the bank behind your card processing is changing');
    if (kinds.has('ach_descriptor_change')) changes.push('your deposits will arrive under a new name');
    // Disputes say only what is known: how many when rows were read, else the
    // amount the statement prints. Their step is the Disputes tile's.
    const disputed = !hasDisputes ? null
      : disputes.count > 1 ? `customers disputed ${disputes.count} payments`
        : disputes.count === 1 ? 'a customer disputed a payment'
          : `disputes took ${fmtMoney(disputes.amount)} off your deposits`;
    if (changes.length) {
      why = `A notice says ${changes.join(', and ')}. Check your deposits keep arriving, and update your records.`;
    } else if (kinds.has('fee_change') || disputed) {
      const parts = [];
      if (kinds.has('fee_change')) parts.push('A notice says a fee on your account is changing: check the new fee and the date it starts.');
      if (disputed) parts.push(`${disputed.charAt(0).toUpperCase()}${disputed.slice(1)}: check each one against your receipts.`);
      why = parts.join(' ');
    } else {
      why = 'A notice says the way you get your statements is changing. Nothing looks wrong, but make sure someone can still get them.';
    }
  }

  return finding(6, 'fine_print', {
    title,
    severity: changesMoney ? 'high' : (kinds.has('fee_change') || hasDisputes ? 'medium' : 'low'),
    flagged,
    why,
    impactLabel: flagged ? 'Action needed' : (zeroDisputes === null ? null : 'Nothing urgent'),
    shows: notices.length
      ? `${notices.length} ${plural(notices.length, 'notice')} in the statement's small print, easy to skip.`
      : 'No notices on this statement.',
    hidden: sentences.join(' '),
    metrics: { notices, reportableSales, disputes, zeroDisputes },
    table: disputes && disputes.items.length
      ? {
        type: 'grid',
        columns: [
          { key: 'date', label: 'Date', format: 'date' },
          { key: 'reason', label: 'Reason', format: 'text' },
          { key: 'amount', label: 'Amount', format: 'money' },
        ],
        rows: disputes.items,
      }
      : null,
    sourceRefs: [
      ...notices.map((_, i) => `notices[${i}]`),
      ...(reportableSales ? ['reportable_sales'] : []),
      ...(Array.isArray(x.chargebacks) ? x.chargebacks.map((_, i) => `chargebacks[${i}]`) : []),
    ],
  });
}

/* ── Engine ──────────────────────────────────────────────────────────────── */

/**
 * Analyse one extracted statement (CARD-STATEMENTS.md §5).
 *
 * `history`: earlier analysed statements of the same client and merchant,
 * [{ periodStart, periodEnd, amountSubmitted }]. Entries ending on or after
 * this statement's period end are ignored.
 */
function analyse(extracted, { history = [], rules = DEFAULT_RULES } = {}) {
  const x = extracted || {};
  const summary = x.summary || {};
  const period = { start: (x.period && x.period.start) || null, end: (x.period && x.period.end) || null };
  const merchant = x.merchant || {};
  const cardTypes = (Array.isArray(x.card_types) ? x.card_types : []).filter(Boolean);
  const feeLines = (Array.isArray(x.fee_lines) ? x.fee_lines : []).filter(Boolean);
  const daily = (Array.isArray(x.daily) ? x.daily : []).filter(Boolean);
  const funding = (Array.isArray(x.funding) ? x.funding : []).filter(Boolean);

  const submitted = num(summary.amount_submitted);
  const fees = num(summary.fees);
  const csv = x.layout_version === 'csv';
  // What the fee table says the store can stop for free, and what comes once
  // a year, so the saving from switching neither claims the penalty nor counts
  // a yearly fee twelve times (D49).
  const tagged = feeLines.map((l) => ({ l, t: tagFeeLine(l, rules) }));
  const penaltyLines = tagged.filter(({ t }) => t.tag === 'penalty');
  const pricing = priceRebelipay(x, rules, {
    penalties: penaltyLines.map(({ l, t }) => ({ amount: Math.abs(num(l.amount) || 0), period: t.period })),
    annualFees: tagged.filter(({ t }) => t.tag !== 'penalty' && t.period === 'annual').map(({ l }) => Math.abs(num(l.amount) || 0)),
    penaltyLabel: penaltyLines.length && penaltyLines.every(({ l }) => /PCI/i.test(l.description || ''))
      ? 'Fix the PCI penalty (free, about 20 minutes)' : 'Stop the penalty fees',
  });
  const rebelipay = pricing.public;

  /* KPIs */
  // A card type with sales on it but no count read makes the total unknown:
  // a partial sum would understate it and inflate the computed average ticket.
  const countMissing = cardTypes.some((ct) => num(ct.items) === null && (num(ct.net) || num(ct.gross)));
  const transactions = cardTypes.length && !countMissing
    ? cardTypes.reduce((s, ct) => s + (num(ct.items) || 0), 0) : null;
  const debit = debitFacts(x, feeLines, cardTypes, submitted);
  const customers = customersSection(x.customers);
  const printedTicket = x.customers ? num(x.customers.avg_ticket) : null;
  const computedTicket = submitted !== null && transactions ? dollars(Math.round((submitted * 100) / transactions)) : null;
  const kpis = {
    cardVolume: submitted,
    transactions,
    processingFees: fees,
    effectiveRate: pctOf(fees, submitted),
    debitVolume: debit.debitVolume,
    debitShare: debit.debitShare,
    debitFeesPaid: debit.debitFeesPaid,
    netDeposited: num(summary.amount_processed),
    avgTicket: printedTicket !== null ? printedTicket : computedTicket,
    avgTicketSource: printedTicket !== null ? 'printed' : (computedTicket !== null ? 'computed' : null),
    rebelipayEligible: rebelipay.eligible,
    rebelipaySavings: rebelipay.eligible ? rebelipay.savings : null,
    rebelipaySavingsAnnual: rebelipay.eligible ? rebelipay.savingsAnnual : null,
  };

  /* Sections */
  const anomalies = dailyAnomalies(daily, funding, period, rules);
  const anomalyTypesByDate = new Map();
  for (const a of anomalies) {
    if (!a.date) continue;
    if (!anomalyTypesByDate.has(a.date)) anomalyTypesByDate.set(a.date, []);
    anomalyTypesByDate.get(a.date).push(a.type);
  }
  const dailySection = daily.length
    ? {
      rows: daily.map((r) => {
        const dow = dowOf(r.date);
        return {
          date: r.date || null,
          dow: dow === null ? null : DOW[dow],
          submitted: num(r.submitted),
          // Not columns of a transaction export: unknown, not $0.00.
          disputes: csv ? null : num(r.disputes),
          adjustments: csv ? null : num(r.adjustments),
          fees: num(r.fees),
          processed: num(r.processed),
          // Friday to Sunday, the span the daily chart shades darker.
          weekend: dow !== null && FRI_TO_SUN.has(dow),
          priorPeriod: Boolean(r.is_prior_period) || Boolean(period.start && r.date && r.date < period.start),
          anomalies: anomalyTypesByDate.get(r.date) || [],
        };
      }),
      monthEndCharges: num(x.month_end_charges),
      // A file with no fee column (a CSV) has null fees and processed on every
      // row; their totals are unknown too, never $0.00.
      totals: {
        submitted: sumMoney(daily, (r) => r.submitted),
        fees: daily.some((r) => num(r.fees) !== null) || num(x.month_end_charges) !== null
          ? dollars(daily.reduce((s, r) => s + (cents(r.fees) || 0), 0) + (cents(x.month_end_charges) || 0)) : null,
        processed: daily.some((r) => num(r.processed) !== null)
          ? dollars(daily.reduce((s, r) => s + (cents(r.processed) || 0), 0) - (cents(x.month_end_charges) || 0)) : null,
      },
    }
    : null;

  const cardMix = cardMixSection(cardTypes);
  const trend = trendSection(x, history);
  kpis.lastMonth = lastMonthFigures(x, history, kpis, trend.section, csv);
  const notices = (Array.isArray(x.notices) ? x.notices : []).filter(Boolean).map((n) => {
    const kind = rules.noticeActions[n.kind] ? n.kind : 'other';
    return {
      text: n.text || '',
      kind,
      effectiveDate: n.effective_date || null,
      action: rules.noticeActions[kind],
    };
  });
  const rs = x.reportable_sales;
  const reportableSales = rs
    ? {
      tinLast4: rs.tin_last4 || null,
      monthLabel: rs.month_label || null,
      monthAmount: num(rs.month_amount),
      ytdAmount: num(rs.ytd_amount),
      ytdYear: num(rs.ytd_year),
    }
    : null;
  const chargebacks = (Array.isArray(x.chargebacks) ? x.chargebacks : []).filter(Boolean);
  // A transaction export has no disputes section, so its 0 is "not shown",
  // not "none": null, and the Notices tab says it is not in the file.
  // A statement whose disputes line was not read, with no chargeback rows, is
  // unknown too: null, never "no disputes".
  const disputes = (csv && !chargebacks.length) || (!chargebacks.length && num(summary.disputes) === null)
    ? null
    : {
      count: chargebacks.length,
      amount: chargebacks.length ? sumMoney(chargebacks, (c) => c.amount) : (num(summary.disputes) || 0),
      items: chargebacks.map((c) => ({ date: c.date || null, amount: num(c.amount), reason: c.reason || null })),
    };
  const fundingSection = funding.length
    ? { rows: funding.length, splitDays: splitFunding(funding).days }
    : null;
  const feeLineRows = feeLineSection(feeLines, rules);

  /* Findings, fixed order 01..06 */
  const findings = [
    debitFinding(debit),
    trendFinding(trend, x),
    scorecardFinding(customers, cardMix, cardTypes, kpis, csv),
    dailyFinding(x, dailySection, anomalies, period),
    junkFinding(feeLines, rules, csv),
    finePrintFinding(notices, reportableSales, disputes, x),
  ];
  const findingsCount = findings.filter((f) => f.flagged).length;

  const sections = {
    feeLines: feeLineRows,
    daily: dailySection,
    cardMix,
    customers,
    salesTrend: trend.section,
    reportableSales,
    disputes,
    funding: fundingSection,
  };
  const missing = Object.keys(sections).filter((k) => sections[k] === null);

  const analysis = {
    version: ANALYSIS_VERSION,
    layoutVersion: x.layout_version || 'unknown',
    processor: x.processor || null,
    merchant: { number: merchant.number || null, name: merchant.name || null },
    period: { start: period.start, end: period.end, label: monthLabel(period.end) },
    kpis,
    rebelipay,
    findings,
    feeLines: feeLineRows,
    daily: dailySection,
    cardMix,
    customers,
    salesTrend: trend.section,
    notices,
    reportableSales,
    disputes,
    funding: fundingSection,
    missing,
    findingsCount,
  };

  const header = {
    processor: analysis.processor,
    merchantNumber: analysis.merchant.number,
    merchantName: analysis.merchant.name,
    periodStart: period.start,
    periodEnd: period.end,
    layoutVersion: analysis.layoutVersion,
    amountSubmitted: submitted,
    totalFees: fees,
    amountProcessed: kpis.netDeposited,
    transactionCount: transactions,
    effectiveRate: round4(kpis.effectiveRate),
    debitShare: round4(kpis.debitShare),
    findingsCount,
    rebelipayCost: pricing.raw.rebelipayCost,
    rebelipaySavings: pricing.raw.savings,
    rebelipaySavingsAnnual: pricing.raw.savingsAnnual,
    rebelipayEligible: pricing.raw.eligible,
    analysisVersion: ANALYSIS_VERSION,
  };

  return { analysis, header };
}

module.exports = {
  ANALYSIS_VERSION,
  analyse,
};
