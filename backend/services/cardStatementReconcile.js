/**
 * Card Statement Analysis - reconciliation (CARD-STATEMENTS.md §4).
 *
 * A statement prints the same money several ways: by day, by card type, as fee
 * lines and as one summary. When the extraction is right those views agree to
 * the cent, so checking them against each other is how a misread row, a dropped
 * page or a flipped sign gets caught without a human opening the PDF.
 *
 * Pure: no I/O, no clock. A check whose inputs are absent is `skipped` and not
 * counted (a CSV has no fee lines; a legacy statement has no paid-by-others).
 * A failed check never fails the statement: it still ends `analysed`, and the
 * detail view lists the failed labels in a warning banner.
 *
 * Tolerance is $0.05. The fee-line rate check (D11) widens it on large lines:
 * the processor rounds per transaction, so a printed fee drifts from
 * rate x base by up to half a cent per transaction (WR Jul VISA DEBIT:
 * 0.03 x $119,190.57 = 3,575.7171, printed $3,575.74). That check allows
 * max(RATE_FLOOR, 0.01% of rate x base).
 *
 * RATE_FLOOR is $0.05, not the $0.02 D11 first named: the drift does not
 * shrink with the base. 498407670880 May prints DISCOVER DEBIT 0.03 x
 * $2,148.94 = 64.4682 as $64.49 (2.18 cents) and June 0.03 x $2,484.81 =
 * 74.5443 as $74.52 (2.43 cents), on lines whose 0.01% is under a cent, and
 * both statements' fee lines still add up to the printed total. A misread
 * amount is caught by fee_lines_total anyway; this check is for a misread
 * rate or base, which usually moves the product by far more than five cents.
 */

const TOL = 0.05;
const RATE_FLOOR = 0.05;
const RATE_RELATIVE = 0.0001;

const LABELS = {
  daily_submitted_total: 'Daily rows add up to the amount submitted',
  daily_fees_total: 'Daily fees and month-end charges add up to total fees',
  card_types_total: 'Card types add up to the amount submitted',
  fee_lines_total: 'Fee lines add up to total fees',
  summary_equation: 'Submitted, less fees and disputes, plus adjustments, equals amount processed',
  fee_line_rate_math: 'Every rated fee line equals its rate times its base',
  fee_bases_match_card_types: 'Fee-line volumes match card-type sales',
  card_type_rows: 'Every card type has its sales, refunds and counts',
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
// The 1e-9 absorbs float noise in sums of cents, so exactly 5 cents passes.
const near = (a, b, tol = TOL) => Math.abs(a - b) <= tol + 1e-9;
const sum = (arr, f) => (arr || []).reduce((s, x) => s + (Number(f(x)) || 0), 0);
const money = (n) => (isNum(n) ? Math.round(n * 100) / 100 : n);

function reconcile(extracted) {
  const x = extracted || {};
  const s = x.summary || {};
  const checks = [];
  const add = (name, { expected = null, actual = null, ok = null, skipped = false, detail = null } = {}) => {
    checks.push({ name, label: LABELS[name], expected, actual, ok: skipped ? null : ok, skipped, detail });
  };
  const skip = (name) => add(name, { skipped: true });

  // Every daily row counts, prior-period ones included: the statement's own
  // total includes them (WR May: 04/30/26 is in the $187,377.59).
  const daily = Array.isArray(x.daily) ? x.daily : [];
  if (!daily.length || !isNum(s.amount_submitted)) skip('daily_submitted_total');
  else {
    const actual = sum(daily, (d) => d.submitted);
    add('daily_submitted_total', { expected: money(s.amount_submitted), actual: money(actual), ok: near(actual, s.amount_submitted) });
  }

  if (!daily.length || !isNum(s.fees)) skip('daily_fees_total');
  else {
    const actual = sum(daily, (d) => d.fees) + (x.month_end_charges || 0);
    add('daily_fees_total', { expected: money(s.fees), actual: money(actual), ok: near(actual, s.fees) });
  }

  const cardTypes = Array.isArray(x.card_types) ? x.card_types : [];
  if (!cardTypes.length || !isNum(s.amount_submitted)) skip('card_types_total');
  else {
    const actual = sum(cardTypes, (c) => c.net);
    add('card_types_total', { expected: money(s.amount_submitted), actual: money(actual), ok: near(actual, s.amount_submitted) });
  }

  const feeLines = Array.isArray(x.fee_lines) ? x.fee_lines : [];
  if (!feeLines.length || !isNum(s.fees)) skip('fee_lines_total');
  else {
    const actual = sum(feeLines, (f) => f.amount);
    add('fee_lines_total', { expected: money(s.fees), actual: money(actual), ok: near(actual, s.fees) });
  }

  if (!isNum(s.amount_submitted) || !isNum(s.amount_processed) || !isNum(s.fees)) skip('summary_equation');
  else {
    const actual = s.amount_submitted + (s.paid_by_others || 0) - (s.disputes || 0) + (s.adjustments || 0) - s.fees;
    add('summary_equation', { expected: money(s.amount_processed), actual: money(actual), ok: near(actual, s.amount_processed) });
  }

  // Counts, not money: expected = rated lines, actual = lines that agree.
  const rated = feeLines.map((f, index) => ({ f, index })).filter(({ f }) => isNum(f.rate) && isNum(f.base_amount));
  if (!rated.length) skip('fee_line_rate_math');
  else {
    const bad = rated.filter(({ f }) => {
      const exact = f.rate * f.base_amount;
      return !isNum(f.amount) || Math.abs(exact - f.amount) > Math.max(RATE_FLOOR, RATE_RELATIVE * exact) + 1e-9;
    }).map(({ f, index }) => ({
      index, description: f.description, expected: Math.round(f.rate * f.base_amount * 10000) / 10000, actual: f.amount,
    }));
    add('fee_line_rate_math', {
      expected: rated.length, actual: rated.length - bad.length, ok: bad.length === 0, detail: bad.length ? bad : null,
    });
  }

  // The bases of a network's rated transaction lines are that network's
  // volume, which is what the debit-share headline is built from. Some
  // processors rate gross sales, some net of refunds, so either matches.
  const ratedTxn = rated.filter(({ f }) => f.category === 'transaction' && f.network);
  if (!ratedTxn.length) skip('fee_bases_match_card_types');
  else {
    const byNetwork = {};
    for (const { f } of ratedTxn) byNetwork[f.network] = (byNetwork[f.network] || 0) + f.base_amount;
    const bad = [];
    for (const [network, bases] of Object.entries(byNetwork)) {
      const rows = cardTypes.filter((c) => c.type === network);
      const gross = sum(rows, (c) => c.gross);
      const net = sum(rows, (c) => c.net);
      if (!(near(bases, gross) || near(bases, net))) {
        bad.push({ network, bases: money(bases), gross: money(gross), net: money(net) });
      }
    }
    const networks = Object.keys(byNetwork).length;
    add('fee_bases_match_card_types', {
      expected: networks, actual: networks - bad.length, ok: bad.length === 0, detail: bad.length ? bad : null,
    });
  }

  // card_types_total only sums net, so a row whose gross or count was not read
  // still adds up, and pricing and the transaction count would quietly treat
  // the gap as zero. Each row with money on it must carry its gross and its
  // count, and agree with itself: gross less refunds is net, and the
  // processor's net count is sales plus refunds (both are transactions).
  // Expected = rows checked, actual = rows that pass.
  if (!cardTypes.length) skip('card_type_rows');
  else {
    const bad = [];
    cardTypes.forEach((c, index) => {
      if (!c) return;
      const blank = !(isNum(c.gross) && c.gross !== 0) && !(isNum(c.net) && c.net !== 0);
      if (blank) return;
      const problems = [];
      if (!isNum(c.gross)) problems.push('gross missing');
      if (!isNum(c.items)) problems.push('count missing');
      if (isNum(c.refunds) && c.refunds !== 0 && !isNum(c.refund_items)) problems.push('refund count missing');
      if (isNum(c.gross) && isNum(c.net) && !near(c.gross - (isNum(c.refunds) ? c.refunds : 0), c.net)) {
        problems.push('gross less refunds is not net');
      }
      if (isNum(c.items) && isNum(c.refund_items) && isNum(c.net_items) && c.items + c.refund_items !== c.net_items) {
        problems.push('counts do not add up');
      }
      if (problems.length) bad.push({ index, type: c.type || null, problems });
    });
    add('card_type_rows', {
      expected: cardTypes.length, actual: cardTypes.length - bad.length, ok: bad.length === 0, detail: bad.length ? bad : null,
    });
  }

  const counted = checks.filter((c) => !c.skipped);
  const passed = counted.filter((c) => c.ok).length;
  const total = counted.length;
  return {
    checks,
    passed,
    total,
    confidence: total === 0 ? 1 : Math.round((passed / total) * 10000) / 10000,
    ok: passed === total,
  };
}

/**
 * The core header an analysis cannot run without. Returns the missing ones as
 * owner-readable names, in a fixed order; [] when all are there. The caller
 * words the failure: "Could not read this statement: no <fields> found."
 */
function coreHeaderMissing(extracted) {
  const x = extracted || {};
  const missing = [];
  if (!x.merchant || !x.merchant.number || !String(x.merchant.number).trim()) missing.push('merchant number');
  if (!x.period || !x.period.start || !x.period.end) missing.push('statement period');
  if (!x.summary || !isNum(x.summary.amount_submitted)) missing.push('amount submitted');
  return missing;
}

module.exports = { reconcile, coreHeaderMissing, LABELS, TOLERANCE: TOL, RATE_FLOOR, RATE_RELATIVE };
