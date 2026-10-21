/**
 * Card Statement Analysis - what this statement would have cost with Rebelipay.
 *
 * Pure: no I/O, no clock. See CARD-STATEMENTS.md §6 for the contract.
 *
 * WHY INTEGER ARITHMETIC
 * ----------------------
 * The figure an owner acts on is a difference of two five-figure totals, and
 * the plan's worked table is quoted to the cent. Floating point gets that
 * wrong in the last place often enough to matter (146012.07 * 100 is not an
 * integer in binary), so every amount here is cents as a BigInt, the
 * percentage is parts per million, and an exact charge is kept in units of
 * 1e-6 cent until the one place it is rounded.
 *
 * WHY ONE ROUNDING PER STATEMENT (D4)
 * -----------------------------------
 * A PDF does not list individual transactions, only a total per card type.
 * Rounding each card type's charge would round five times and drift: WR May's
 * exact sum is 5,498.128545, which is $5,498.13, but the per-card-type
 * roundings add up to $5,498.12. So the statement total is rounded once, and
 * the per-card-type rows are carved out of that total by largest remainder so
 * the rows still add up to it. A CSV does list transactions, and there each
 * transaction is rounded on its own, as the offer's terms say.
 *
 * THE PRICE NEVER LEAVES THIS FILE (D7)
 * -------------------------------------
 * Only totals and one all-in rate come out. Nothing returned here holds the
 * percentage part, the per-transaction part, the refund credit on its own or
 * a rules value, and the per-card-type split is an allocation of the total,
 * not a breakdown of the price.
 */

const DEFAULT_RULES = require('./cardStatementRules');

const MICRO = 1000000n;                // exact charges are in 1e-6 cent
const HALF_MICRO = MICRO / 2n;

/* ── Integer helpers ─────────────────────────────────────────────────────── */

/** Dollars (number or numeric string) to integer cents as a BigInt. Null stays null. */
function toCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Round the magnitude so -12.345 and 12.345 round the same way.
  const c = Math.round(Math.abs(n) * 100);
  return BigInt(n < 0 ? -c : c);
}

const toDollars = (cents) => (cents === null ? null : Number(cents) / 100);

function floorDiv(a, b) {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

/** 1e-6 cent to cents, half up. The only rounding a PDF statement gets. */
const roundHalfUp = (micro) => floorDiv(micro + HALF_MICRO, MICRO);

const sumBig = (values) => values.reduce((s, v) => s + v, 0n);

/** A transaction count as a BigInt. Only called once pricePdf knows the count is there. */
const count = (value) => BigInt(Math.round(Number(value) || 0));

const isCount = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

/**
 * Can this card type row be priced? Pricing needs its sales and its count. A
 * row read without them would price as $0 and inflate the saving, while the
 * totals still reconcile (they use net), so a gap here makes the whole
 * statement unpriceable instead. A row with no money on it at all is fine.
 */
function rowPriceable(ct, units) {
  const gross = toCents(ct.gross);
  const net = toCents(ct.net);
  if ((gross === null || gross === 0n) && (net === null || net === 0n)) return true;
  if (gross === null || !isCount(ct.items)) return false;
  if (units.creditRefunds && (toCents(ct.refunds) || 0n) !== 0n && !isCount(ct.refund_items)) return false;
  return true;
}

/**
 * Split `total` cents across rows in proportion to their exact charges, so the
 * rows add up to `total` exactly. Each row gets its floor, and the cents left
 * over go to the largest remainders; ties go to the earlier row so the result
 * never depends on sort stability.
 */
function allocate(exacts, total) {
  const floors = exacts.map((e) => floorDiv(e, MICRO));
  let left = total - sumBig(floors);
  const order = exacts
    .map((e, i) => ({ i, rem: e - floors[i] * MICRO }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : (b.rem > a.rem ? 1 : -1)));
  for (const { i } of order) {
    if (left <= 0n) break;
    floors[i] += 1n;
    left -= 1n;
  }
  return floors;
}

/* ── Pricing ─────────────────────────────────────────────────────────────── */

function offerUnits(rules) {
  const offer = (rules || DEFAULT_RULES).rebelipay;
  return {
    ppm: BigInt(Math.round(Number(offer.pctRate) * 1e6)),
    feeMicro: toCents(offer.perTxnFee) * MICRO,
    monthly: toCents(offer.monthlyFees || 0),
    creditRefunds: Boolean(offer.refundsReturnFee),
    roundPerTransaction: offer.roundPerTransaction !== false,
  };
}

/** PDF: one exact charge per card type, one rounding for the statement (D4, D5). */
function pricePdf(extracted, units) {
  const cardTypes = Array.isArray(extracted.card_types) ? extracted.card_types : [];
  const feeLines = Array.isArray(extracted.fee_lines) ? extracted.fee_lines : [];

  const exacts = cardTypes.map((ct) => {
    let exact = (toCents(ct.gross) || 0n) * units.ppm + count(ct.items) * units.feeMicro;
    if (units.creditRefunds) {
      exact -= (toCents(ct.refunds) || 0n) * units.ppm + count(ct.refund_items) * units.feeMicro;
    }
    return exact;
  });
  const total = roundHalfUp(sumBig(exacts));
  const allocated = allocate(exacts, total);

  const rows = cardTypes.map((ct, i) => ({
    type: ct.type || 'OTHER',
    label: ct.label || ct.type || 'Other',
    transactions: Number(ct.items) || 0,
    volume: toCents(ct.gross) || 0n,
    // What the processor charged on this network's own fee lines.
    currentCost: sumBig(feeLines
      .filter((l) => l && l.network && l.network === ct.type)
      .map((l) => toCents(l.amount) || 0n)),
    rebelipayCost: allocated[i],
  }));

  return {
    basis: 'per_card_type_from_pdf',
    priced: cardTypes.length > 0,
    complete: cardTypes.every((ct) => rowPriceable(ct, units)),
    transactions: rows.reduce((s, r) => s + r.transactions, 0),
    volume: sumBig(rows.map((r) => r.volume)),
    cardCost: total,
    rows,
  };
}

/**
 * CSV: every transaction rounded on its own, refunds credited the same way.
 * With rules.rebelipay.roundPerTransaction off, the file is priced like a PDF
 * instead: exact charges, one rounding, allocated back to the card types.
 */
function priceCsv(extracted, units) {
  const txns = Array.isArray(extracted.transactions) ? extracted.transactions : [];
  const byType = new Map();
  let transactions = 0;
  let volume = 0n;

  for (const t of txns) {
    if (!t) continue;
    const type = t.card_type || 'OTHER';
    if (!byType.has(type)) {
      byType.set(type, { type, label: type, transactions: 0, volume: 0n, currentCost: 0n, rebelipayCost: 0n, exact: 0n });
    }
    const row = byType.get(type);
    const amount = toCents(Math.abs(Number(t.amount) || 0));
    const exact = amount * units.ppm + units.feeMicro;
    const charge = units.roundPerTransaction ? roundHalfUp(exact) : 0n;
    row.currentCost += toCents(t.fee) || 0n;
    if (t.is_refund) {
      if (units.creditRefunds) {
        row.rebelipayCost -= charge;
        row.exact -= exact;
      }
      continue;
    }
    row.transactions += 1;
    row.volume += amount;
    row.rebelipayCost += charge;
    row.exact += exact;
    transactions += 1;
    volume += amount;
  }

  const typeRows = [...byType.values()];
  let cardCost;
  if (units.roundPerTransaction) {
    cardCost = sumBig(typeRows.map((r) => r.rebelipayCost));
  } else {
    cardCost = roundHalfUp(sumBig(typeRows.map((r) => r.exact)));
    allocate(typeRows.map((r) => r.exact), cardCost).forEach((c, i) => { typeRows[i].rebelipayCost = c; });
  }

  // Card type labels follow the statement's own vocabulary where one exists.
  const labels = new Map((extracted.card_types || []).filter(Boolean).map((ct) => [ct.type, ct.label]));
  const rows = typeRows.map((r) => ({
    type: r.type,
    label: labels.get(r.type) || r.label,
    transactions: r.transactions,
    volume: r.volume,
    currentCost: r.currentCost,
    rebelipayCost: r.rebelipayCost,
  }));

  return { basis: 'per_transaction_from_csv', priced: transactions > 0, complete: true, transactions, volume, cardCost, rows };
}

/**
 * Price one extracted statement (CARD-STATEMENTS.md §6).
 *
 * Returns `public`, the shape that goes into analysis.rebelipay (redacted when
 * not eligible), and `raw`, the unredacted totals for the DB columns. Raw
 * savings may be negative; the API never returns them that way.
 */
function priceRebelipay(extracted, rules = DEFAULT_RULES, fixes = {}) {
  const x = extracted || {};
  const summary = x.summary || {};
  const units = offerUnits(rules);
  const isCsv = x.layout_version === 'csv' || Array.isArray(x.transactions);
  const priced = isCsv ? priceCsv(x, units) : pricePdf(x, units);

  const currentCost = toCents(summary.fees);
  const submitted = toCents(summary.amount_submitted);
  const rebelipayCost = priced.cardCost + units.monthly;

  // What the engine found on the fee table (D49). A penalty (the PCI
  // non-validation fee) stops once the store does its free step, whichever
  // processor it uses, so switching gets no credit for it: it is its own line.
  // A once-a-year fee is in this month's fees but comes once a year, so a
  // year of savings counts it once, not twelve times.
  const penalties = (fixes.penalties || []).map((p) => ({ cents: toCents(p.amount) || 0n, annual: p.period === 'annual' }));
  const penalty = sumBig(penalties.map((p) => p.cents));
  const penaltyAnnual = sumBig(penalties.map((p) => (p.annual ? p.cents : p.cents * 12n)));
  const yearlyOnce = sumBig((fixes.annualFees || []).map((a) => toCents(a) || 0n));
  const switchSaving = currentCost === null ? null : currentCost - penalty - rebelipayCost;
  const switchAnnual = switchSaving === null ? null : (switchSaving - yearlyOnce) * 12n + yearlyOnce;

  // A negative charge or a net amount at or below zero is a misread (a sign
  // that slipped, sales read as refunds), never a saving to pitch. Switching
  // must save money by itself, this month and over a year.
  let reason = null;
  if (!priced.priced || priced.volume <= 0n || priced.cardCost < 0n || (submitted !== null && submitted <= 0n)) {
    reason = 'no_volume';
  } else if (!priced.complete) reason = 'incomplete';
  else if (currentCost === null) reason = 'no_current_fees';
  else if (switchSaving <= 0n || switchAnnual <= 0n) reason = 'costs_more';
  const eligible = reason === null;
  // Nothing was priced, or not all of it: no Rebelipay figure at all.
  const unpriced = reason === 'no_volume' || reason === 'incomplete';

  const savings = (unpriced || currentCost === null) ? null : switchSaving;
  const savingsAnnual = savings === null ? null : switchAnnual;
  const rateOf = (cents) => (cents === null || submitted === null || submitted <= 0n
    ? null : (Number(cents) / Number(submitted)) * 100);

  const raw = {
    currentCost: toDollars(currentCost),
    rebelipayCost: unpriced ? null : toDollars(rebelipayCost),
    savings: toDollars(savings),
    savingsAnnual: toDollars(savingsAnnual),
    eligible,
    reason,
  };

  const pub = {
    eligible,
    reason,
    currentProcessor: x.processor || null,
    // A partial sum is not a total: unknown when a card type was not readable.
    transactions: priced.priced && priced.complete ? priced.transactions : null,
    volume: priced.priced && priced.complete ? toDollars(priced.volume) : null,
    currentCost: toDollars(currentCost),
    rebelipayCost: toDollars(rebelipayCost),
    savings: toDollars(savings),
    savingsPct: savings === null || !currentCost ? null : (Number(savings) / Number(currentCost)) * 100,
    savingsAnnual: raw.savingsAnnual,
    // The store's own penalty, stopped by a free step (D49), and the total
    // the page shows: switching plus the penalty. With no penalty they equal
    // the switching saving.
    penaltyFix: penalty > 0n ? toDollars(penalty) : null,
    penaltyFixAnnual: penalty > 0n ? toDollars(penaltyAnnual) : null,
    penaltyFixLabel: penalty > 0n ? (fixes.penaltyLabel || 'Stop the penalty fees') : null,
    totalFound: savings === null ? null : toDollars(savings + penalty),
    totalFoundAnnual: savingsAnnual === null ? null : toDollars(savingsAnnual + penaltyAnnual),
    currentRate: rateOf(currentCost),
    rebelipayRate: rateOf(rebelipayCost),
    byCardType: [],
    pricingBasis: priced.basis,
    refundsCredited: units.creditRefunds,
  };

  if (reason === null) {
    const rows = priced.rows.map((r) => ({
      type: r.type,
      label: r.label,
      transactions: r.transactions,
      volume: toDollars(r.volume),
      currentCost: toDollars(r.currentCost),
      rebelipayCost: toDollars(r.rebelipayCost),
      savings: toDollars(r.currentCost - r.rebelipayCost),
    }));
    // Account fees, penalties and any line without a network land here, so the
    // rows add up to everything the processor charged. Its saving leaves the
    // penalty out, so the column adds up to the switching saving (D49).
    const residual = currentCost - sumBig(priced.rows.map((r) => r.currentCost));
    rows.push({
      type: 'ACCOUNT_OTHER',
      label: 'Account & other fees',
      transactions: null,
      volume: null,
      currentCost: toDollars(residual),
      rebelipayCost: toDollars(units.monthly),
      savings: toDollars(residual - penalty - units.monthly),
    });
    pub.byCardType = rows;
  } else if (reason === 'costs_more') {
    // No negative saving can be shown, or worked back from what is left. The
    // penalty is the store's own fee and stays.
    for (const k of ['currentCost', 'rebelipayCost', 'savings', 'savingsPct', 'savingsAnnual', 'rebelipayRate', 'byCardType',
      'totalFound', 'totalFoundAnnual']) {
      delete pub[k];
    }
  } else if (reason === 'no_current_fees') {
    pub.currentRate = null;
  } else {
    // no_volume: nothing was priced. incomplete: a card type's sales or count
    // was not read, so any total would be too low.
    pub.rebelipayCost = null;
    pub.rebelipayRate = null;
  }

  return { public: pub, raw };
}

/* ── Savings to date ─────────────────────────────────────────────────────── */

function monthOf(value) {
  if (!value) return null;
  // pg hands a `date` back as a Date at local midnight when the global type
  // parser is in play; read it in local time so the day does not shift.
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
  }
  const m = String(value).match(/^(\d{4}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Raw savings summed over every analysed statement of one merchant.
 *
 * Negatives are included on purpose: a month where Rebelipay would have cost
 * more must pull the total down, or the figure is a highlight reel rather
 * than a total. The UI decides whether it is worth showing (§6).
 *
 * Rows: [{ periodEnd, rebelipaySavings }] (snake_case column names accepted).
 */
function savingsToDate(rows) {
  let total = 0n;
  let statements = 0;
  let from = null;
  let to = null;
  for (const row of rows || []) {
    if (!row) continue;
    if (row.status && row.status !== 'analysed') continue;
    const cents = toCents(row.rebelipaySavings !== undefined ? row.rebelipaySavings : row.rebelipay_savings);
    if (cents === null) continue;
    total += cents;
    statements += 1;
    const month = monthOf(row.periodEnd !== undefined ? row.periodEnd : row.period_end);
    if (month) {
      if (!from || month < from) from = month;
      if (!to || month > to) to = month;
    }
  }
  return { amount: toDollars(total), statements, from, to };
}

module.exports = {
  priceRebelipay,
  savingsToDate,
};
