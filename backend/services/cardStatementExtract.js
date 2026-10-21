/**
 * Card Statement Analysis - extraction (CARD-STATEMENTS.md §3).
 *
 * One uploaded file in, one `extracted` object out, in the snake_case schema
 * of §3.2. Two readers:
 *
 *   - PDF: read with Claude, the Quick-PO way (purchaseOrderService.parseDocument).
 *     The model copies printed values; it computes nothing.
 *   - CSV: a deterministic parser. The model is used, at most, to say which
 *     column is which when the header matches none of the aliases, and it only
 *     ever sees the first 30 lines. Every row is still parsed here.
 *
 * WHY THE MODEL'S ANSWER IS POST-PROCESSED
 * ----------------------------------------
 * The prompt asks for plain positive numbers, ISO dates and normalised card
 * types, and a good read returns exactly that. But a "$5,651.28" string or a
 * "-26.36" dispute is a plausible slip, and it would reach the engine as a
 * wrong sign or a NaN. So everything the analysis leans on is coerced here, in
 * code: numbers, signs, dates, card types, the rate and base parsed back out of
 * the verbatim fee description, and is_prior_period from the date. The model's
 * job is reading the page; this file's job is not trusting the format.
 *
 * WHAT IS NEVER KEPT (D9)
 * -----------------------
 * Owner name, street address and the full TIN are not in the schema and are
 * dropped even if the model returns them: merchant is { number, name } and
 * reportable_sales carries tin_last4 only. Chargebacks keep date, amount and
 * reason; no card digits, no reference numbers.
 *
 * Errors carry `.code` (one of ERROR_CODES) and `.publicMessage`, which is the
 * only text an owner may see. The raw cause stays on `.cause` for the logs.
 * Extracted JSON is never logged at info: it is a merchant's statement.
 */

const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');

/* ── Config ───────────────────────────────────────────────────────────────── */

// Same default as Quick-PO (plan §6.4), but its own variable so the two
// features can move to different models independently.
const PARSE_MODEL = process.env.CS_PARSE_MODEL || process.env.PO_PARSE_MODEL || 'claude-sonnet-5';

// A v2 statement with a long Amounts Funded table is roughly 8-12k tokens of
// compact JSON. 32000 leaves room for a busier store and for any thinking the
// model does on its own; streaming is what lets the budget sit above the
// SDK's ~21,333 non-streaming ceiling.
const PARSE_MAX_TOKENS = parseInt(process.env.CS_PARSE_MAX_TOKENS || '32000', 10);

// ONE WALL-CLOCK DEADLINE PER READ (D13). The SDK's `timeout` option only
// covers the wait for the response headers: once a stream has started, a
// stalled or trickling body would run on forever, and the stale sweep would
// then fail a row whose read is still going. So every call also carries an
// AbortSignal.timeout of the same length, which cuts the body off too. The
// signal is shared by the SDK's single retry (maxRetries: 1, and it only
// retries before a body arrives), so the whole read, retry included, ends
// within READ_DEADLINE_MS. The service keeps CS_STALE_MINUTES above that
// (cardStatementService.staleMinutes), whatever the env says.
const PARSE_TIMEOUT_MS = positiveInt(process.env.CS_PARSE_TIMEOUT_MS, 240_000);

// Column mapping is a tiny answer; it should never take long.
const MAP_TIMEOUT_MS = 60_000;
const MAP_MAX_TOKENS = 2000;
const MAP_SAMPLE_LINES = 30;

// The longest any one job can spend with the model: a PDF read or, for a CSV,
// the column-mapping fallback. Never both in one job.
const READ_DEADLINE_MS = Math.max(PARSE_TIMEOUT_MS, MAP_TIMEOUT_MS);

function positiveInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 });
  return client;
}

/* ── Errors ───────────────────────────────────────────────────────────────── */

const ERROR_CODES = [
  'EXTRACTION_TRUNCATED', 'EXTRACTION_UNREADABLE', 'EXTRACTION_REFUSED', 'EXTRACTION_UNAVAILABLE',
  'CSV_COLUMNS', 'CSV_EMPTY', 'CSV_NO_MERCHANT',
];

// Owner-facing. No vendor name, no env var names, no em dashes (D15).
const PUBLIC_MESSAGES = {
  EXTRACTION_TRUNCATED: 'This statement has more detail than one read can return. Reanalyse it, and contact support if it happens again.',
  EXTRACTION_UNREADABLE: 'The file was opened but no statement figures could be read from it. Check that it is a card processing statement.',
  EXTRACTION_REFUSED: 'This file could not be processed. Check that it is a card processing statement.',
  EXTRACTION_UNAVAILABLE: 'The statement reader is temporarily unavailable. Reanalyse it in a few minutes.',
  // Same code as above (it is retryable the same way), worded for a read cut
  // off at its deadline.
  EXTRACTION_TIMED_OUT: 'Reading this statement took too long and was stopped. Reanalyse it in a few minutes.',
  CSV_COLUMNS: 'Could not find the date, amount and card type columns in this CSV.',
  CSV_EMPTY: 'This CSV has no transaction rows to analyse.',
  CSV_NO_MERCHANT: 'Could not find a merchant number in this CSV. Add a merchant number column, or put the merchant number in the file name.',
};

function extractionError(code, cause, publicMessage = PUBLIC_MESSAGES[code]) {
  const err = new Error(`[CardStmt] ${code}${cause && cause.message ? `: ${cause.message}` : ''}`);
  err.code = code;
  err.publicMessage = publicMessage;
  if (cause) err.cause = cause;
  return err;
}

/**
 * Any failure talking to the model becomes EXTRACTION_UNAVAILABLE, except a
 * 400 about the document itself (encrypted, corrupt, not really a PDF), which
 * is the file's problem and should say so.
 */
function wrapModelError(err) {
  if (err && ERROR_CODES.includes(err.code)) return err;
  if (isTimeout(err)) {
    return extractionError('EXTRACTION_UNAVAILABLE', err, PUBLIC_MESSAGES.EXTRACTION_TIMED_OUT);
  }
  if (err instanceof Anthropic.APIError && err.status === 400 && /pdf|document|page/i.test(err.message || '')) {
    return extractionError('EXTRACTION_UNREADABLE', err);
  }
  return extractionError('EXTRACTION_UNAVAILABLE', err);
}

/**
 * The read hit its deadline: our AbortSignal.timeout fired (the SDK reports
 * that as APIUserAbortError, or the raw AbortError / TimeoutError when it
 * fires between the SDK's own steps), or the SDK's header timeout did.
 */
function isTimeout(err) {
  if (!err) return false;
  if (err instanceof Anthropic.APIUserAbortError || err instanceof Anthropic.APIConnectionTimeoutError) return true;
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}

/** Request options for one model call: the header timeout and a deadline on the whole body. */
const deadline = (ms) => ({ timeout: ms, signal: AbortSignal.timeout(ms) });

/* ── Kind detection ───────────────────────────────────────────────────────── */

const CSV_MIMES = new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain']);
const DELIMITERS = [',', ';', '\t', '|'];

/**
 * 'pdf' | 'csv' | null. The content decides; the mimetype alone never does.
 * A PDF is recognised by its magic bytes anywhere in the first 1 KB (some
 * generators put junk before them). A CSV needs a .csv name or a text-ish
 * mimetype AND content that decodes as text with a delimiter on one of its
 * first lines (a preamble line may come before the header).
 */
function detectKind({ buffer, originalName, mimetype } = {}) {
  if (!buffer || !buffer.length) return null;
  if (buffer.subarray(0, 1024).includes('%PDF-')) return 'pdf';

  const name = String(originalName || '').toLowerCase();
  const mime = String(mimetype || '').toLowerCase().split(';')[0].trim();
  if (!name.endsWith('.csv') && !CSV_MIMES.has(mime)) return null;

  const text = decodeText(buffer.subarray(0, 64 * 1024));
  if (text == null) return null;
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, MAP_SAMPLE_LINES);
  return lines.some((l) => DELIMITERS.some((d) => l.includes(d))) ? 'csv' : null;
}

/** Buffer -> string, or null when it is not text (NUL bytes, binary noise). */
function decodeText(buffer) {
  let text;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    // Excel's "Unicode text" export: UTF-16LE with a BOM.
    text = buffer.subarray(2).toString('utf16le');
  } else {
    text = buffer.toString('utf8');
    // Not valid UTF-8 (an old Windows export): Latin-1 reads every byte.
    if (text.includes(String.fromCharCode(0xfffd))) text = buffer.toString('latin1');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const sample = text.slice(0, 4096);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0e-\x1f]/.test(sample)) return null;
  return text;
}

/* ── The extraction contract (PDF) ────────────────────────────────────────── */

const SCHEMA = `{
  "processor": string|null,
  "layout_version": "legacy_2026" | "v2_2026" | "unknown",
  "merchant": { "number": string, "name": string },
  "period": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "summary": {
    "amount_submitted": number,
    "paid_by_others": number|null,
    "disputes": number,
    "adjustments": number,
    "fees": number,
    "amount_processed": number
  },
  "customers": { "new": number, "repeat": number, "avg_ticket": number } | null,
  "sales_trend": [ { "month": "YYYY-MM", "amount": number } ],
  "printed_yoy_pct": number|null,
  "printed_mom_pct": number|null,
  "daily": [
    { "date": "YYYY-MM-DD", "submitted": number, "disputes": number, "adjustments": number,
      "fees": number, "processed": number, "is_prior_period": boolean }
  ],
  "month_end_charges": number|null,
  "card_types": [
    { "type": "VISA"|"MASTERCARD"|"AMEX"|"DISCOVER"|"DEBIT"|"OTHER", "label": string, "avg_ticket": number,
      "items": integer, "gross": number, "refund_items": integer, "refunds": number,
      "net_items": integer, "net": number }
  ],
  "fee_lines": [
    { "category": "transaction"|"account"|"interchange"|"other",
      "product": string|null,
      "network": "VISA"|"MASTERCARD"|"AMEX"|"DISCOVER"|"DEBIT"|"OTHER"|null,
      "description": string,
      "is_debit": boolean,
      "rate": number|null, "base_amount": number|null,
      "count": integer|null, "unit_price": number|null,
      "fee_type": "Service Charges"|"Fees"|"IC/PF"|null,
      "amount": number }
  ],
  "chargebacks": [ { "date": "YYYY-MM-DD", "amount": number, "reason": string|null } ],
  "funding": [
    { "date_submitted": "YYYY-MM-DD", "submitted": number, "fees": number,
      "date_funded": "YYYY-MM-DD", "funded": number }
  ],
  "reportable_sales": { "tin_last4": string|null, "month_label": string|null, "month_amount": number|null,
                        "ytd_amount": number, "ytd_year": integer } | null,
  "notices": [
    { "text": string,
      "kind": "acquirer_change"|"ach_descriptor_change"|"delivery_change"|"fee_change"|"other",
      "effective_date": "YYYY-MM-DD"|null }
  ]
}`;

// Each rule is here because breaking it yields a number that looks right and
// is not: a sign flipped, a total row counted twice, a prior-period row lost.
const RULES = `Rules:
- Return strictly valid JSON and nothing else. No markdown fence, no prose. Compact JSON, no indentation.
- Copy only what is printed. Compute nothing that is not printed. Use null for anything absent; never use 0 for something that is not printed.
- Numbers are plain JSON numbers: no "$", no thousands separators, no quotes.
- Signs: summary.fees, summary.disputes, daily fees and disputes, card_types refunds, fee_lines amount, chargebacks amount and funding fees are POSITIVE even though the statement prints them with a minus ("-$5,651.28" -> 5651.28; "Chargebacks/Reversals -$26.36" -> 26.36). Adjustments, paid_by_others, daily processed and funding funded keep the sign printed ("-$29.95" -> -29.95).
- Dates are YYYY-MM-DD. Two-digit years are 20yy ("05/01/26" -> "2026-05-01").
- Keep every list in the order printed.
- Copy descriptions and notice texts verbatim, with runs of spaces and line breaks collapsed to one space.
- Do not return the owner's name, any street address, card numbers, reference numbers or a full tax ID. merchant has only number and name (the business name, e.g. "WINE REPUBLIC"). For the TIN keep only its last 4 digits.

Field rules:
- processor: the processor's brand name from the logo or customer-service block ("BETTER payments" logo, www.TryBetter.Co -> "Better Payments"); null if unknown.
- layout_version: "legacy_2026" when the header says "Statement Period mm/dd/yy - mm/dd/yy" and there is a "SUMMARY" block; "v2_2026" when it says "PERIOD: mm/dd/yyyy-mm/dd/yyyy" with an "Account Summary" equation; otherwise "unknown".
- summary: the statement's own summary block. disputes = "Chargebacks/Reversals" (legacy) or "Disputes" (v2). paid_by_others is null on the legacy layout, which has no such line.
- customers: "New Customers", "Repeat Customers" and "Avg. Ticket Size" (v2 page 1). null on the legacy layout.
- sales_trend: the 13 MONTHS - SALES TREND bars, each labelled "Mon YY - $amount" (rotated text): "Jul 25 - $197,745.60" -> {"month":"2025-07","amount":197745.60}. All 13, oldest first. [] when there is no trend chart.
- printed_yoy_pct / printed_mom_pct: the printed "x% year over year" and "x% month over month" ("-1.63%" -> -1.63). null when not printed.
- daily: every DATED row of "Summary By Day", which may continue onto the next page; read both pages. Include rows dated before the statement period (e.g. "04/30/26" on a May statement, "06/30/2026" on a July one) with is_prior_period true; every other row has is_prior_period false. Do NOT include the "Month End Charge" row or the "Total" row in daily.
- month_end_charges: the Fees value on the "Month End Charge" row of Summary By Day, positive ("-$29.95" -> 29.95; 0 if it prints 0.00); null if there is no such row.
- card_types: the rows of "Summary By Card Type", without the Total row. label is the printed card type verbatim ("Mastercard", "AMEX ACQ", "Debit/Atm", "DEBIT CARD"). type: VISA, MASTERCARD, AMEX ("AMEX ACQ" -> AMEX), DISCOVER, DEBIT ("Debit/Atm" and "DEBIT CARD" -> DEBIT), else OTHER. items/gross are "Total Gross Sales You Submitted", refund_items/refunds are "Refunds" (refunds positive), net_items/net are "Total Amount You Submitted". Ignore the mix percentages printed above the v2 table.
- fee_lines: every individual fee line of the FEES section, without any subtotal or total row ("TOTAL TRANSACTION FEES", "TOTAL ACCOUNT FEES", "Total", "Total Service Charges", "Total Fees"), and NOT the v2 "Fee Summary" box or its Type x network table.
  - category: "transaction" for TRANSACTION FEES / "Transaction Fees", "account" for ACCOUNT FEES / "Account Fees", "interchange" for lines under an interchange charges / program fees heading (Type "IC/PF"), else "other".
  - product: v2: the Product column ("Miscellaneous", "Mastercard", "Visa", "Discover", "Debit"); it is printed once per group, so repeat it for every line of the group. Legacy: the brand sub-heading the line sits under ("MASTERCARD", "VISA", "DISCOVER", "DEBIT CARD", "Other"). null if there is none (legacy account fees).
  - network: the card brand named in the DESCRIPTION: "VISA DEBIT SALES DISCOUNT ..." -> "VISA", "MASTERCARD DEBIT SALES DISC ..." -> "MASTERCARD", "AMEX SALES DISCOUNT ..." -> "AMEX", "DEBIT SALES DISCOUNT ..." -> "DEBIT"; debit and PIN network lines ("MAESTRO REG", "STAR NE PREFER REG", "PULSE PAY CHOICE REG", "PAVD REG") -> "DEBIT". null when the description names no brand (account fees).
  - is_debit: true when the description contains DEBIT or network is DEBIT.
  - rate and base_amount from "<rate> DISC RATE TIMES $<base>" ("0.03 DISC RATE TIMES $119190.57" -> 0.03 and 119190.57); else null.
  - count and unit_price from "<n> TRANSACTIONS AT <price>" ("1 TRANSACTIONS AT 29.95" -> 1 and 29.95); else null.
  - fee_type: the Type column title-cased: "Service charges" -> "Service Charges", "Fees", "IC/PF"; null if none.
- chargebacks: rows of "CHARGEBACKS/REVERSALS" or a disputes table: date, amount (positive), reason (the description). No card digits, no reference numbers. [] when none.
- funding: the "Amounts Funded" rows on every page it spans, without the Total row: date_submitted, submitted ("Amount Submitted"), fees (positive), date_funded, funded ("Amounts Funded", signed). Keep a prior-period row such as "06/30/2026 ... 07/02/2026 -$29.95", and keep both rows when one date submitted is funded on two dates. [] when the section is absent (legacy statements).
- reportable_sales: "TOTAL GROSS REPORTABLE SALES BY TIN". tin_last4 = the last 4 digits after the masked TIN ("GROSS REPORTABLE SALES-TIN##########1234" -> "1234"), month_label = the Month column ("April"), month_amount = that row's total, ytd_amount and ytd_year from "2026 YTD Gross Reportable Sales $123,456.78" or "YTD Gross Reportable Sales 2026 $234,567.89". null when the section is absent.
- notices: every notice or important-information paragraph, one object per paragraph, verbatim and trimmed, in printed order. Include the "IMPORTANT INFORMATION ABOUT YOUR ACCOUNT" / "Important Information About Your Account" box and every "IMPORTANT NOTICE:" paragraph. The last page may be an image with no text layer: read it from the picture anyway. Ignore form codes such as "CED2262I", page furniture and section descriptions.
  - kind: acquiring bank or sponsorship change -> "acquirer_change"; ACH company name / descriptor change -> "ach_descriptor_change"; the way the STATEMENT itself is delivered changes (e.g. no longer emailed as a PDF, download it from a portal instead) -> "delivery_change"; a new or changed fee with a specific date -> "fee_change"; anything else -> "other", including advice about dispute or chargeback notifications (mail versus online) and fees that "may apply" with no date.
  - effective_date: only when a specific date is printed ("Effective June 29, 2026" -> "2026-06-29"); a month alone is not a date; else null.
- Ignore "SUMMARY BY BATCH" entirely.`;

const PROMPT = `You are reading a merchant's monthly card processing statement (a credit and debit card acquiring statement) so its figures can be checked and analysed.

Return ONLY a JSON object matching this schema:
${SCHEMA}

${RULES}`;

/* ── PDF ──────────────────────────────────────────────────────────────────── */

/**
 * PDF in, `extracted` out. Mirrors purchaseOrderService.parseDocument: the
 * document block goes BEFORE the text, the request is streamed, and only
 * text blocks are read (a thinking block may come first, so never content[0]).
 * No temperature, tool_choice or thinking setting: newer models reject them,
 * and the model must stay swappable through the env var.
 */
async function extractPdf({ buffer, fileName }) {
  const started = Date.now();
  if (!process.env.ANTHROPIC_API_KEY) {
    throw extractionError('EXTRACTION_UNAVAILABLE', new Error('ANTHROPIC_API_KEY is not set'));
  }

  const documentBlock = {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
  };

  let res;
  try {
    res = await getClient().messages.stream({
      model: PARSE_MODEL,
      max_tokens: PARSE_MAX_TOKENS,
      messages: [{ role: 'user', content: [documentBlock, { type: 'text', text: PROMPT }] }],
    }, deadline(PARSE_TIMEOUT_MS)).finalMessage();
  } catch (err) {
    throw wrapModelError(err);
  }

  // Each failure says which one it is: running out of room, declining, and
  // answering in prose are different problems with different fixes.
  if (res.stop_reason === 'refusal') {
    throw extractionError('EXTRACTION_REFUSED', new Error(`stop_reason refusal (${fileName || 'file'})`));
  }
  if (res.stop_reason === 'max_tokens') {
    // Not trusted even when the JSON happens to close: a statement cut short
    // reconciles badly and analyses quietly wrong.
    throw extractionError('EXTRACTION_TRUNCATED', new Error(`stopped at ${PARSE_MAX_TOKENS} tokens (${fileName || 'file'})`));
  }

  const raw = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const payload = extractJson(raw);
  if (!payload) {
    throw extractionError('EXTRACTION_UNREADABLE', new Error(`no JSON in the response (stop_reason ${res.stop_reason}, ${raw.length} chars)`));
  }

  return {
    extracted: normaliseExtracted(payload),
    model: PARSE_MODEL,
    ms: Date.now() - started,
    stopReason: res.stop_reason,
    usage: res.usage ? { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } : null,
  };
}

/** Pull the JSON object out of a reply that may still have prose around it. */
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ── Coercion helpers ─────────────────────────────────────────────────────── */

const CARD_TYPES = new Set(['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER', 'DEBIT', 'OTHER']);
const LAYOUTS = new Set(['legacy_2026', 'v2_2026', 'unknown']);
const FEE_CATEGORIES = new Set(['transaction', 'account', 'interchange', 'other']);
const NOTICE_KINDS = new Set(['acquirer_change', 'ach_descriptor_change', 'delivery_change', 'fee_change', 'other']);
const MAX_FEE_DESCRIPTION = 300;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// No real amount is longer than this, with its "$", commas, spaces and sign.
// Anything longer is not a number, and is turned away before a regex runs on
// it: a CSV cell can be megabytes long.
const MAX_NUMBER_TEXT = 64;
const MAX_NUMBER_DIGITS = 32;

/** "$1,234.56", "(12.00)", "-$26.36", "12.00-" or a number -> number; else null. */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.length > MAX_NUMBER_TEXT) return null;
  let s = v.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { negative = true; s = s.slice(0, -1); }
  s = s.replace(/[$,\s%]|USD/gi, '');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (s.length > MAX_NUMBER_DIGITS) return null;
  // No two quantifiers can claim the same digits, so a non-number fails in
  // linear time (the old /^\d*\.?\d+$/ backtracked quadratically).
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)) return null;
  const n = parseFloat(s);
  return negative ? -n : n;
}

const pos = (v) => { const n = num(v); return n == null ? null : Math.abs(n); };
const int = (v) => { const n = num(v); return n == null ? null : Math.round(n); };
const str = (v) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : null);
const toCents = (n) => Math.round(n * 100);
const fromCents = (c) => c / 100;

function validYmd(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** ISO, MM/DD/YYYY or MM/DD/YY (20yy), with or without a time -> YYYY-MM-DD; else null. */
function isoDate(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s])/);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:$|[T\s,])/);
  if (m) return validYmd(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  return null;
}

/** "2025-07", "Jul 25", "Jul 2025" -> "YYYY-MM"; else null. */
function isoMonth(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${String(+m[2]).padStart(2, '0')}`;
  m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+'?(\d{2}|\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    const y = m[2].length === 2 ? 2000 + +m[2] : +m[2];
    return `${y}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}`;
  }
  return null;
}

/** Printed card type label -> the normalised set. Brands win over DEBIT. */
function cardType(label) {
  const s = String(label || '').toUpperCase();
  if (/\bAMEX\b|AMERICAN\s*EXPRESS/.test(s)) return 'AMEX';
  if (/MASTER\s*CARD|^MC$|\bMC\b/.test(s)) return 'MASTERCARD';
  if (/\bVISA\b/.test(s)) return 'VISA';
  if (/\bDISCOVER\b/.test(s)) return 'DISCOVER';
  if (/DEBIT|\bATM\b|INTERAC/.test(s)) return 'DEBIT';
  return 'OTHER';
}

/** The brand a fee description names, or null when it names none. */
function networkFromDescription(desc) {
  const s = String(desc || '').toUpperCase();
  if (/\bAMEX\b|AMERICAN\s*EXPRESS/.test(s)) return 'AMEX';
  if (/MASTER\s*CARD|\bMC\b/.test(s)) return 'MASTERCARD';
  if (/\bVISA\b/.test(s)) return 'VISA';
  if (/\bDISCOVER\b/.test(s)) return 'DISCOVER';
  // Debit schemes and PIN networks bill their own registration lines
  // ("MAESTRO REG", "STAR NE PREFER REG", "PULSE PAY CHOICE", "PAVD REG").
  if (/\b(DEBIT|MAESTRO|STAR|PULSE|NYCE|ACCEL|PAVD|SHAZAM|INTERLINK)\b/.test(s)) return 'DEBIT';
  return null;
}

function feeCategory(v) {
  const s = String(v || '').toLowerCase();
  if (FEE_CATEGORIES.has(s)) return s;
  if (/transaction/.test(s)) return 'transaction';
  if (/account/.test(s)) return 'account';
  if (/interchange|program/.test(s)) return 'interchange';
  return 'other';
}

function feeType(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/service/i.test(s)) return 'Service Charges';
  if (/^ic\b|ic\/pf|interchange|program/i.test(s)) return 'IC/PF';
  if (/fee/i.test(s)) return 'Fees';
  return null;
}

/* ── Normalisation of the model's answer ──────────────────────────────────── */

/**
 * Coerce a raw model payload into the §3.2 schema. Pure; also used by the
 * smoke script and tests. Keys outside the schema are dropped.
 */
function normaliseExtracted(raw) {
  const x = raw && typeof raw === 'object' ? raw : {};
  const m = x.merchant && typeof x.merchant === 'object' ? x.merchant : {};
  const p = x.period && typeof x.period === 'object' ? x.period : {};
  const s = x.summary && typeof x.summary === 'object' ? x.summary : {};

  const period = { start: isoDate(p.start), end: isoDate(p.end) };
  const merchantNumber = m.number == null ? '' : String(m.number).replace(/\D/g, '');

  let monthEnd = x.month_end_charges == null ? null : pos(x.month_end_charges);
  const daily = [];
  for (const d of arr(x.daily)) {
    if (!d || typeof d !== 'object') continue;
    const date = isoDate(d.date);
    if (!date) {
      // A Month End Charge row the model put in daily anyway: keep its fees
      // where they belong, never as a day.
      if (monthEnd == null && /month\s*end/i.test(String(d.date || d.label || ''))) monthEnd = pos(d.fees);
      continue;
    }
    daily.push({
      date,
      submitted: num(d.submitted),
      disputes: pos(d.disputes),
      adjustments: num(d.adjustments),
      fees: pos(d.fees),
      processed: num(d.processed),
      // From the date whenever the period is known: the date is printed, the
      // flag is an inference, and the inference is ours to make.
      is_prior_period: period.start ? date < period.start : d.is_prior_period === true,
    });
  }

  const cardTypes = [];
  for (const c of arr(x.card_types)) {
    if (!c || typeof c !== 'object') continue;
    const label = str(c.label) || str(c.type);
    if (!label || /^total/i.test(label)) continue;
    // The printed label decides; the model's type only fills in when the
    // label names no brand we know.
    const fromLabel = cardType(label);
    cardTypes.push({
      type: fromLabel !== 'OTHER' ? fromLabel : (CARD_TYPES.has(c.type) ? c.type : 'OTHER'),
      label,
      avg_ticket: num(c.avg_ticket),
      items: int(c.items),
      gross: num(c.gross),
      refund_items: int(c.refund_items) == null ? null : Math.abs(int(c.refund_items)),
      refunds: pos(c.refunds),
      net_items: int(c.net_items),
      net: num(c.net),
    });
  }

  const feeLines = [];
  for (const f of arr(x.fee_lines)) {
    if (!f || typeof f !== 'object') continue;
    const description = str(f.description);
    if (!description || /^total\b/i.test(description)) continue;
    const category = feeCategory(f.category);
    // The description decides. Failing that, a card fee (never an account
    // fee) takes the model's network, then the brand its product names.
    const fromProduct = cardType(f.product);
    const network = networkFromDescription(description)
      || (category === 'account' ? null
        : (CARD_TYPES.has(f.network) ? f.network : null) || (fromProduct !== 'OTHER' ? fromProduct : null));
    // Parsed back out of the verbatim description: it is printed, so it is
    // exact, and it is the input to the rate check. A real fee description is
    // well under MAX_FEE_DESCRIPTION; a longer one is not parsed (the model's
    // own rate, base, count and price are used), so a pathological string
    // cannot make these regexes backtrack for seconds. The number groups do
    // not overlap for the same reason.
    const parseable = description.length <= MAX_FEE_DESCRIPTION;
    const rated = parseable
      ? description.match(/(\d+(?:\.\d+)?|\.\d+)\s+DISC(?:OUNT)?\s+RATE\s+TIMES\s+\$?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)/i)
      : null;
    const counted = parseable ? description.match(/(\d[\d,]*)\s+TRANSACTIONS?\s+AT\s+\$?\s*([\d,]*\.?\d+)/i) : null;
    feeLines.push({
      category,
      product: str(f.product),
      network,
      description,
      is_debit: /\bDEBIT\b/i.test(description) || network === 'DEBIT',
      rate: rated ? num(rated[1]) : num(f.rate),
      base_amount: rated ? num(rated[2]) : num(f.base_amount),
      count: counted ? int(counted[1]) : int(f.count),
      unit_price: counted ? num(counted[2]) : num(f.unit_price),
      fee_type: feeType(f.fee_type),
      amount: pos(f.amount),
    });
  }

  const chargebacks = arr(x.chargebacks)
    .filter((c) => c && typeof c === 'object' && isoDate(c.date))
    .map((c) => ({ date: isoDate(c.date), amount: pos(c.amount), reason: str(c.reason) }));

  const funding = arr(x.funding)
    .filter((f) => f && typeof f === 'object' && isoDate(f.date_submitted))
    .map((f) => ({
      date_submitted: isoDate(f.date_submitted),
      submitted: num(f.submitted),
      fees: pos(f.fees),
      date_funded: isoDate(f.date_funded),
      funded: num(f.funded),
    }));

  const trend = new Map();
  for (const t of arr(x.sales_trend)) {
    const month = t && isoMonth(t.month);
    const amount = t && num(t.amount);
    if (month && amount != null && !trend.has(month)) trend.set(month, amount);
  }

  const notices = arr(x.notices)
    .map((n) => (n && typeof n === 'object' ? n : { text: n }))
    .filter((n) => str(n.text))
    .map((n) => ({
      text: str(n.text),
      kind: NOTICE_KINDS.has(n.kind) ? n.kind : 'other',
      effective_date: isoDate(n.effective_date),
    }));

  return {
    processor: str(x.processor),
    layout_version: LAYOUTS.has(x.layout_version) ? x.layout_version : 'unknown',
    merchant: { number: merchantNumber || null, name: str(m.name) },
    period,
    summary: {
      amount_submitted: num(s.amount_submitted),
      paid_by_others: num(s.paid_by_others),
      disputes: pos(s.disputes),
      adjustments: num(s.adjustments),
      fees: pos(s.fees),
      amount_processed: num(s.amount_processed),
    },
    customers: normaliseCustomers(x.customers),
    sales_trend: [...trend.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, amount]) => ({ month, amount })),
    printed_yoy_pct: num(x.printed_yoy_pct),
    printed_mom_pct: num(x.printed_mom_pct),
    daily,
    month_end_charges: monthEnd,
    card_types: cardTypes,
    fee_lines: feeLines,
    chargebacks,
    funding,
    reportable_sales: normaliseReportable(x.reportable_sales),
    notices,
  };
}

function arr(v) { return Array.isArray(v) ? v : []; }

function normaliseCustomers(c) {
  if (!c || typeof c !== 'object') return null;
  const out = { new: int(c.new), repeat: int(c.repeat), avg_ticket: num(c.avg_ticket) };
  return out.new == null && out.repeat == null && out.avg_ticket == null ? null : out;
}

// D9: tin_last4 and the amounts only. Whatever else came back is dropped.
function normaliseReportable(r) {
  if (!r || typeof r !== 'object') return null;
  const tinSource = String(r.tin_last4 || r.tin_masked || r.tin || '');
  const tin = tinSource.match(/(\d{4})\D*$/);
  const out = {
    tin_last4: tin ? tin[1] : null,
    month_label: str(r.month_label),
    month_amount: num(r.month_amount),
    ytd_amount: num(r.ytd_amount),
    ytd_year: int(r.ytd_year),
  };
  return Object.values(out).every((v) => v == null) ? null : out;
}

/* ── CSV ──────────────────────────────────────────────────────────────────── */

// Matched against a header cell lowercased, with punctuation other than '#'
// turned into spaces. First alias that matches wins; order is preference.
const CSV_FIELDS = {
  date: ['date', 'transaction date', 'txn date', 'trans date', 'settlement date', 'batch date', 'created', 'datetime', 'date time', 'created at', 'transaction time'],
  amount: ['amount', 'sale amount', 'transaction amount', 'txn amount', 'total', 'gross', 'gross amount'],
  card: ['card type', 'card brand', 'brand', 'network', 'card', 'payment method', 'scheme', 'card network'],
  kind: ['type', 'transaction type', 'txn type', 'kind'],
  status: ['status', 'result', 'transaction status'],
  fee: ['fee', 'fees', 'processing fee', 'processing fees', 'discount', 'total fees'],
  merchantNumber: ['merchant number', 'merchant #', 'merchant no', 'mid', 'merchant id'],
  merchantName: ['merchant name', 'dba', 'dba name', 'store', 'location'],
};
const CSV_REQUIRED = ['date', 'amount', 'card'];
// csv_source.columns is part of `extracted`, so it is snake_case like the rest.
const COLUMN_KEYS = {
  date: 'date', amount: 'amount', card: 'card_type', kind: 'kind', status: 'status', fee: 'fee',
  merchantNumber: 'merchant_number', merchantName: 'merchant_name',
};
const CSV_LABELS = { date: 'date', amount: 'amount', card: 'card type' };
const APPROVED = /^(approved|settled|captured|success|successful|succeeded|complete|completed|paid|ok|accepted|posted|processed|funded)$/i;
// Money going back to the cardholder. "Credit" is NOT in here: on its own it
// usually says how the card was funded (credit, debit, prepaid), and reading
// it as a refund would turn every credit-card sale into one. It counts as a
// refund only in a column that also has sale or purchase rows (see
// creditMeansRefund).
const REFUND_KIND = /refund|return|reversal|chargeback/i;
// Rows that are not money moving: an authorisation, a void, a decline. An
// "auth reversal" is one of these too, so only refund/return can rescue a row.
const NON_SALE_KIND = /void|auth|declin|verif|cancel/i;
const REFUND_WORD = /refund|return/i;
// A column whose every value is one of these is the card's funding type.
const FUNDING_KINDS = new Set(['', 'credit', 'debit', 'prepaid', 'credit card', 'debit card', 'prepaid card']);
const SALE_KIND = /sale|purchase/i;
// A cell longer than this is not a date, an amount or a card type. The row
// is skipped as unusable before any parsing (or regex) touches the cell.
const MAX_CELL = 256;

function normHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
}

/** RFC 4180 records: quoted fields, "" escapes, embedded delimiters and newlines, CRLF. */
function parseRecords(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Header cells -> { field: columnIndex } by alias. */
function mapColumns(header) {
  const cells = header.map(normHeader);
  const taken = new Set();
  const map = {};
  const claim = (field, idx) => { map[field] = idx; taken.add(idx); };
  // Exact matches first, in field order, so "card type" can never be claimed
  // by the looser "type" (kind) alias.
  const order = ['date', 'card', 'merchantNumber', 'merchantName', 'fee', 'amount', 'kind', 'status'];
  for (const field of order) {
    for (const alias of CSV_FIELDS[field]) {
      const idx = cells.findIndex((c, i) => !taken.has(i) && c === alias);
      if (idx !== -1) { claim(field, idx); break; }
    }
  }
  // Then a prefix pass for the required columns only ("amount usd",
  // "date utc"), never a card NUMBER column for the card type.
  for (const field of CSV_REQUIRED) {
    if (map[field] != null) continue;
    for (const alias of CSV_FIELDS[field]) {
      const idx = cells.findIndex((c, i) => !taken.has(i) && c.startsWith(`${alias} `)
        && !(field === 'card' && /number|last|digits|#|bin|holder|entry/.test(c)));
      if (idx !== -1) { claim(field, idx); break; }
    }
  }
  return map;
}

/** Find the header row and delimiter by alias. Preamble lines are skipped. */
function findHeader(text) {
  const head = text.slice(0, 64 * 1024);
  let best = null;
  for (const delimiter of DELIMITERS) {
    const records = parseRecords(head, delimiter).slice(0, MAP_SAMPLE_LINES);
    for (let r = 0; r < records.length; r++) {
      if (records[r].length < 2) continue;
      const map = mapColumns(records[r]);
      const score = Object.keys(map).length;
      const complete = CSV_REQUIRED.every((f) => map[f] != null);
      const candidate = { delimiter, row: r, map, score, complete, header: records[r] };
      if (complete && (!best || !best.complete || score > best.score)) best = candidate;
      else if (!complete && (!best || (!best.complete && score > best.score))) best = candidate;
      if (complete) break;
    }
  }
  return best;
}

/**
 * Last resort when no alias matches: the model names the columns. It sees the
 * first 30 lines only and answers with a small mapping; no row is parsed by it.
 */
async function mapColumnsWithModel(text) {
  const sample = text.split(/\r\n|\n|\r/).slice(0, MAP_SAMPLE_LINES).join('\n');
  const prompt = `These are the first lines of a CSV export of card transactions. There may be title lines before the header row.

${sample}

Return ONLY a JSON object, no prose:
{"delimiter": "," | ";" | "\\t" | "|",
 "header": [the header row's cells, exactly as written],
 "columns": {"date": header cell, "amount": header cell, "card": header cell (card brand or type),
             "kind": header cell|null (sale/refund), "status": header cell|null,
             "fee": header cell|null, "merchantNumber": header cell|null, "merchantName": header cell|null}}
Use null for a column that is not there.`;

  const res = await getClient().messages.stream({
    model: PARSE_MODEL,
    max_tokens: MAP_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  }, deadline(MAP_TIMEOUT_MS)).finalMessage();
  const raw = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const answer = extractJson(raw);
  if (!answer || !answer.columns || typeof answer.columns !== 'object') return null;

  const delimiter = answer.delimiter === '\\t' ? '\t' : answer.delimiter;
  if (!DELIMITERS.includes(delimiter)) return null;
  // Trust nothing but names that are really in a header row of the file.
  const records = parseRecords(text.slice(0, 64 * 1024), delimiter).slice(0, MAP_SAMPLE_LINES);
  for (let r = 0; r < records.length; r++) {
    const cells = records[r].map((c) => c.trim());
    const map = {};
    for (const [field, name] of Object.entries(answer.columns)) {
      if (!CSV_FIELDS[field] || typeof name !== 'string') continue;
      const idx = cells.indexOf(name.trim());
      if (idx !== -1 && !Object.values(map).includes(idx)) map[field] = idx;
    }
    if (CSV_REQUIRED.every((f) => map[f] != null)) {
      return { delimiter, row: r, map, header: records[r], complete: true };
    }
  }
  return null;
}

/**
 * The merchant number from the file name: the first run of 8-16 digits that
 * is not a yyyymmdd date ("Statement_Location_498387143882_20260531.csv").
 */
function merchantFromFileName(fileName) {
  const runs = String(fileName || '').match(/\d+/g) || [];
  for (const run of runs) {
    if (run.length < 8 || run.length > 16) continue;
    if (run.length === 8 && /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(run)) continue;
    return run;
  }
  return null;
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  for (const [v, n] of counts) if (!best || n > best[1]) best = [v, n];
  return best ? best[0] : null;
}

/**
 * Transaction CSV in, `extracted` out (§3.3). Deterministic unless the header
 * matches no alias, in which case the model may map columns (see above).
 */
async function parseCsv({ buffer, fileName }) {
  const started = Date.now();
  const text = decodeText(buffer || Buffer.alloc(0));
  if (text == null || !text.trim()) throw extractionError('CSV_EMPTY', new Error('no text content'));

  let header = findHeader(text);
  let model = null;
  if ((!header || !header.complete) && process.env.ANTHROPIC_API_KEY) {
    try {
      const mapped = await mapColumnsWithModel(text);
      if (mapped) { header = mapped; model = PARSE_MODEL; }
    } catch (err) {
      // The alias failure below is the honest answer; the model was a bonus.
      logger.warn('[CS] CSV column mapping fallback failed', { fileName, error: err.message });
    }
  }
  if (!header || !header.complete) {
    const missing = CSV_REQUIRED.filter((f) => !header || header.map[f] == null).map((f) => CSV_LABELS[f]);
    throw extractionError('CSV_COLUMNS', new Error(`missing columns: ${missing.join(', ')}`),
      `Could not find the ${missing.slice(0, -1).join(', ')}${missing.length > 1 ? ' and ' : ''}${missing[missing.length - 1]} `
      + `column${missing.length === 1 ? '' : 's'} in this CSV. It needs a date, an amount and a card type for every transaction.`);
  }

  const { map, delimiter } = header;
  const records = parseRecords(text, delimiter).slice(header.row + 1);
  const cell = (rec, field) => {
    if (map[field] == null || rec[map[field]] == null) return '';
    const v = String(rec[map[field]]);
    return v.length > MAX_CELL ? '' : v.trim();
  };

  // What the 'type' column means is decided once, from all of its values: a
  // funding column (Credit / Debit / Prepaid) never marks a refund, and a bare
  // "Credit" is a refund only next to sale or purchase rows.
  const kinds = new Set();
  if (map.kind != null) for (const rec of records) kinds.add(cell(rec, 'kind').toLowerCase());
  const fundingColumn = map.kind != null && [...kinds].every((k) => FUNDING_KINDS.has(k));
  const creditMeansRefund = !fundingColumn && [...kinds].some((k) => SALE_KIND.test(k));
  const isRefundKind = (kind) => !fundingColumn && kind !== ''
    && (REFUND_KIND.test(kind) || (creditMeansRefund && /^credit$/i.test(kind)));

  const transactions = [];
  const merchantNumbers = [];
  const merchantNames = [];
  let rowsTotal = 0;
  let skipped = 0;
  for (const rec of records) {
    if (rec.every((c) => !String(c).trim())) continue;
    rowsTotal++;
    if (/^(sub)?totals?\b/i.test(String(rec[0] || '').trim())) { skipped++; continue; }
    if (map.status != null && !APPROVED.test(cell(rec, 'status'))) { skipped++; continue; }
    const kind = fundingColumn ? '' : cell(rec, 'kind');
    if (kind && NON_SALE_KIND.test(kind) && !REFUND_WORD.test(kind)) { skipped++; continue; }
    const date = isoDate(cell(rec, 'date'));
    const amount = num(cell(rec, 'amount'));
    if (!date || amount == null) { skipped++; continue; }
    transactions.push({
      date,
      amount: Math.abs(amount),
      card_type: cardType(cell(rec, 'card')),
      is_refund: amount < 0 || isRefundKind(kind),
      // A blank fee cell is unknown, not $0: a column that is blank on every
      // row leaves summary.fees null, and the file then says nothing about
      // what the processor charged.
      fee: map.fee == null ? null : num(cell(rec, 'fee')),
    });
    if (map.merchantNumber != null) merchantNumbers.push(cell(rec, 'merchantNumber').replace(/\D/g, ''));
    if (map.merchantName != null) merchantNames.push(cell(rec, 'merchantName').replace(/\s+/g, ' '));
  }
  if (!transactions.length) {
    throw extractionError('CSV_EMPTY', new Error(`no usable rows (${rowsTotal} rows, ${skipped} skipped)`));
  }

  const merchantNumber = mostCommon(merchantNumbers) || merchantFromFileName(fileName);
  if (!merchantNumber) throw extractionError('CSV_NO_MERCHANT', new Error('no merchant number column or file-name digits'));

  // Fees are a cost, stored positive. Some exports print them negative the
  // way the statement does; when the sales' fees net negative, the whole
  // column is in that convention and flips. A fee given back on a refund
  // stays a credit (negative) either way.
  if (map.fee != null) {
    const saleFees = transactions.filter((t) => !t.is_refund).reduce((s, t) => s + (t.fee || 0), 0);
    if (saleFees < 0) for (const t of transactions) if (t.fee != null && t.fee !== 0) t.fee = -t.fee;
  }

  return {
    extracted: buildCsvExtracted({
      transactions,
      merchant: { number: merchantNumber, name: mostCommon(merchantNames) },
      columns: Object.fromEntries(Object.entries(map).map(([field, idx]) => [COLUMN_KEYS[field], String(header.header[idx]).trim()])),
      rowsTotal,
      skipped,
    }),
    model,
    ms: Date.now() - started,
  };
}

/** Group transactions into the §3.2 shape. Sums are done in cents. */
function buildCsvExtracted({ transactions, merchant, columns, rowsTotal, skipped }) {
  const hasFees = transactions.some((t) => t.fee != null);
  const signed = (t) => (t.is_refund ? -1 : 1) * toCents(t.amount);

  const days = new Map();
  const types = new Map();
  let submitted = 0;
  let fees = 0;
  for (const t of transactions) {
    submitted += signed(t);
    fees += toCents(t.fee || 0);
    const d = days.get(t.date) || { submitted: 0, fees: 0 };
    d.submitted += signed(t);
    d.fees += toCents(t.fee || 0);
    days.set(t.date, d);
    const c = types.get(t.card_type) || { items: 0, gross: 0, refundItems: 0, refunds: 0 };
    if (t.is_refund) { c.refundItems++; c.refunds += toCents(t.amount); } else { c.items++; c.gross += toCents(t.amount); }
    types.set(t.card_type, c);
  }

  const dates = [...days.keys()].sort();
  return {
    processor: null,
    layout_version: 'csv',
    merchant,
    period: { start: dates[0], end: dates[dates.length - 1] },
    summary: {
      amount_submitted: fromCents(submitted),
      paid_by_others: null,
      disputes: 0,
      adjustments: 0,
      fees: hasFees ? fromCents(fees) : null,
      amount_processed: hasFees ? fromCents(submitted - fees) : null,
    },
    customers: null,
    sales_trend: [],
    printed_yoy_pct: null,
    printed_mom_pct: null,
    daily: dates.map((date) => {
      const d = days.get(date);
      return {
        date,
        submitted: fromCents(d.submitted),
        disputes: 0,
        adjustments: 0,
        fees: hasFees ? fromCents(d.fees) : null,
        processed: hasFees ? fromCents(d.submitted - d.fees) : null,
        is_prior_period: false,
      };
    }),
    month_end_charges: null,
    card_types: [...types.entries()].map(([type, c]) => ({
      type,
      label: type,
      avg_ticket: c.items ? Math.round(c.gross / c.items) / 100 : null,
      items: c.items,
      gross: fromCents(c.gross),
      refund_items: c.refundItems,
      refunds: fromCents(c.refunds),
      // As the processor prints it: sales and refunds both counted.
      net_items: c.items + c.refundItems,
      net: fromCents(c.gross - c.refunds),
    })),
    fee_lines: [],
    chargebacks: [],
    funding: [],
    reportable_sales: null,
    notices: [],
    transactions,
    csv_source: { columns, rows_total: rowsTotal, rows_used: transactions.length, rows_skipped: skipped },
  };
}

/* ── Entry point ──────────────────────────────────────────────────────────── */

/** { buffer, kind: 'pdf'|'csv', fileName } -> { extracted, model, ms }. */
async function extract({ buffer, kind, fileName }) {
  if (kind === 'pdf') return extractPdf({ buffer, fileName });
  if (kind === 'csv') return parseCsv({ buffer, fileName });
  throw extractionError('EXTRACTION_UNREADABLE', new Error(`unsupported kind ${kind}`));
}

module.exports = {
  detectKind,
  extract,
  extractPdf,
  parseCsv,
  extractJson,
  normaliseExtracted,
  PROMPT,
  ERROR_CODES,
  PARSE_MODEL,
  READ_DEADLINE_MS,
};
