/**
 * Card Statement Analysis - storage, lifecycle, persistence, reads, export.
 *
 * The owner uploads a monthly card-processing statement (a PDF, or a
 * transaction export as CSV). The route stores it, answers 202, and
 * analyseInBackground() reads it, checks it, analyses it and files the result
 * on the row. Everything that touches the database or the disk for this
 * feature lives here. The reading, checking and arithmetic live in their own
 * modules (contract D12), each pure or I/O-only:
 *
 *   cardStatementExtract    reads a PDF or a CSV            (I/O: the model)
 *   cardStatementReconcile  do the printed numbers agree     (pure)
 *   cardStatementAnalysis   KPIs, findings, Rebelipay        (pure)
 *   cardStatementPricing    savings to date                  (pure)
 *   cardStatementRules      the versioned constants          (never serialised)
 *
 * TENANCY. Statements belong to the CLIENT, not the store (contract D1). The
 * analytics database has no row-level security, so one missing predicate is a
 * cross-client leak: every statement below filters client_id, with exactly
 * one exception - the boot-time sweep in recoverStuck(), which says why.
 *
 * POOLS. Analytics only. The lifecycle and read functions take `{ pool }` and
 * default to the shared analytics pool, so a test can hand in a fake; the
 * low-level helpers take the pool first, as Quick-PO's do.
 *
 * The contract this implements is CARD-STATEMENTS.md.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { getAnalyticsPool } = require('../database/analytics-connection');
const { searchClause } = require('./cardStatementSearch');

// The reader and the engine are required on first use, not at load. This
// module is loaded by the router, the router by check-routes and by server.js
// at boot; requiring the reader there builds a model client in processes that
// will never read a statement, and a fault in any one of these modules would
// take the whole router down instead of failing the one request that needed it.
const lazy = (name) => {
  let mod = null;
  return () => mod || (mod = require(name));
};
const extractor = lazy('./cardStatementExtract');
const reconciler = lazy('./cardStatementReconcile');
const engine = lazy('./cardStatementAnalysis');
const pricing = lazy('./cardStatementPricing');
const rules = lazy('./cardStatementRules');

// Where originals live: <CS_UPLOAD_DIR>/<clientId>/<timestamp>-<hex>.<pdf|csv>.
// Resolved against backend/ rather than the working directory, so a relative
// CS_UPLOAD_DIR means the same folder however the server was started. Never
// under data/imagegen, which is served without auth at /imagegen-files.
const UPLOAD_DIR = path.resolve(
  path.join(__dirname, '..'),
  process.env.CS_UPLOAD_DIR || path.join('data', 'card-statements'),
);

// The validated kind decides the stored extension and the Content-Type we
// serve back. The client's file name and declared mimetype decide neither.
const MIME_BY_KIND = { pdf: 'application/pdf', csv: 'text/csv' };
const KIND_BY_MIME = { 'application/pdf': 'pdf', 'text/csv': 'csv' };

const DEFAULT_CTA_URL = 'https://rebelipay.com';
const LEAD_TIMEOUT_MS = 5000;

// Owner-facing text. No vendor names, no env vars, no raw error text: these
// are stored in parse_error and shown on the screen as they are.
const INTERRUPTED_MESSAGE = 'Interrupted by a server restart. Reanalyse it to read it again.';
const GENERIC_FAILURE = 'This statement could not be read. Reanalyse it, or upload it again.';
const FILE_GONE = 'The original file is no longer on the server, so it cannot be read again. Upload it again.';

const LIST_STATUSES = ['analysed', 'analysing', 'failed'];

// Whitelisted ORDER BY clauses, keyed by the `sort` query value. Never built
// from input. The savings sorts rank only what the API would show: a saving
// that is not eligible is null on the wire, so it sorts with the nulls.
const SHOWN_SAVING = `CASE WHEN status = 'analysed' AND rebelipay_eligible AND rebelipay_savings > 0
                           THEN rebelipay_savings END`;
//
// The default is by store, A to Z, newest period first within each store. A
// statement with no name yet (still analysing, or unreadable) sorts first, so
// a fresh upload is on page 1 whatever the order; once read it moves to its
// store. Between stores with the same period, the name decides, so a page
// never reshuffles from one load to the next.
const BY_NAME = 'lower(merchant_name) ASC NULLS LAST';
const SORTS = {
  store: '(merchant_name IS NULL) DESC, lower(merchant_name) ASC, merchant_number ASC, period_end DESC NULLS FIRST, created_at DESC, id DESC',
  store_desc: '(merchant_name IS NULL) DESC, lower(merchant_name) DESC, merchant_number DESC, period_end DESC NULLS FIRST, created_at DESC, id DESC',
  period: `period_end DESC NULLS FIRST, ${BY_NAME}, created_at DESC, id DESC`,
  period_asc: `period_end ASC NULLS FIRST, ${BY_NAME}, created_at DESC, id DESC`,
  savings: `${SHOWN_SAVING} DESC NULLS LAST, period_end DESC NULLS LAST, id DESC`,
  savings_asc: `${SHOWN_SAVING} ASC NULLS LAST, period_end DESC NULLS LAST, id DESC`,
  created: 'created_at DESC, id DESC',
};

// What a list row needs. The three jsonb documents are left out on purpose:
// a page of 200 statements must not drag 200 extractions across the pool.
const LIST_COLUMNS = `id, status, parse_error, processor, merchant_number, merchant_name,
       period_start, period_end, layout_version, amount_submitted, total_fees,
       amount_processed, transaction_count, effective_rate, debit_share, findings_count,
       rebelipay_savings, rebelipay_savings_annual, rebelipay_eligible,
       parse_confidence, (reconciliation->>'ok')::boolean AS reconciliation_ok,
       file_name, file_mime, file_size, duplicate_of, uploaded_by, created_at, updated_at`;

/* ── Small pure helpers ───────────────────────────────────────────────────── */

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const idStr = (v) => (v === null || v === undefined ? null : String(v));
const pad2 = (n) => String(n).padStart(2, '0');
const validId = (id) => /^\d{1,18}$/.test(String(id == null ? '' : id));

/**
 * A DATE column as 'YYYY-MM-DD', whoever decoded it.
 *
 * chat.js installs a process-GLOBAL pg type parser that hands dates back as
 * strings; a process that never loaded chat.js (a test, a script) gets node-pg's
 * default, a Date at LOCAL midnight. Reading that Date with toISOString() would
 * move it a day back anywhere east of UTC, so it is read in local time.
 */
function ymd(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : null;
}

/** A timestamptz as ISO-8601, whoever decoded it (see ymd). */
function iso(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return String(v);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Jul 2026' from '2026-07-31', or null. */
function periodLabel(date) {
  const d = ymd(date);
  if (!d) return null;
  return `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}

/** 'WINE REPUBLIC · Jul 2026', or whichever half is known, or null. */
function statementLabel(row) {
  const parts = [row.merchant_name, periodLabel(row.period_end)].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** ['merchant number', 'statement period'] -> 'merchant number or statement period'. */
function joinWords(words) {
  const list = (words || []).filter(Boolean);
  if (list.length <= 1) return list[0] || 'statement details';
  return `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;
}

/**
 * A value that fits a numeric column, or null.
 *
 * The rates are numeric(7,4). A statement with $1 submitted and a $29.95
 * account fee has an effective rate near 3,000%, and writing that would fail
 * the whole save with a numeric overflow. The list column goes null and the
 * analysis jsonb keeps the real figure.
 */
function fit(v, maxAbs) {
  const n = num(v);
  return n === null || Math.abs(n) > maxAbs ? null : n;
}

const intOrNull = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};

/** http(s) only. Anything else - javascript:, a typo - is treated as unset. */
function httpUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
}

/** Where "Explore Rebelipay" goes (contract D6). Read per call: config, not state. */
const ctaUrl = () => httpUrl(process.env.REBELIPAY_CTA_URL) || DEFAULT_CTA_URL;

// Time a job spends outside the model call: storing, checking, saving.
const STALE_SLACK_MS = 2 * 60000;
let staleClampWarned = false;

/**
 * How old an 'analysing' row must be before the sweep fails it (D13).
 *
 * Never at or below the reader's own deadline: a CS_STALE_MINUTES set lower
 * than CS_PARSE_TIMEOUT_MS allows would sweep reads that are still running,
 * and their results would then be dropped. Such a setting is raised to the
 * smallest safe value, with one warning in the log.
 */
function staleMinutes() {
  const n = parseInt(process.env.CS_STALE_MINUTES, 10);
  const wanted = Number.isFinite(n) && n > 0 ? n : 10;
  let deadlineMs = 0;
  try {
    deadlineMs = Number(extractor().READ_DEADLINE_MS) || 0;
  } catch {
    // The reader failed to load, so nothing can be reading: no floor needed.
  }
  const floor = Math.ceil((deadlineMs + STALE_SLACK_MS) / 60000);
  if (wanted >= floor) return wanted;
  if (!staleClampWarned) {
    staleClampWarned = true;
    logger.warn('[CS] CS_STALE_MINUTES is shorter than one statement read may take; using the safe minimum',
      { configured: wanted, using: floor, readDeadlineMs: deadlineMs });
  }
  return floor;
}

/** An error whose message is safe to put in front of the owner. */
function ownerError(message, code) {
  const err = new Error(message);
  err.publicMessage = message;
  err.code = code;
  return err;
}

/** An error the route answers with this status and code as it is. */
function httpError(httpStatus, code, message) {
  const err = ownerError(message, code);
  err.httpStatus = httpStatus;
  return err;
}

/** A unique violation on the one unique index the save can hit. */
const isIdentityConflict = (err) => !!err && err.code === '23505'
  && (!err.constraint || err.constraint === 'card_statements_identity_uniq');

/* ── Row mappers ──────────────────────────────────────────────────────────── */

/**
 * The saving the API may show: only on an analysed, eligible statement, and
 * never negative. The column is raw (negative when Rebelipay costs more) so
 * savings to date stays honest, but a negative saving must not be shown or
 * derivable anywhere (contract section 6).
 */
function shownSaving(row, value) {
  if (row.status !== 'analysed' || row.rebelipay_eligible !== true) return null;
  const n = num(value);
  return n !== null && n > 0 ? n : null;
}

/** A stored row, flattened into the list item the UI reads (contract section 7). */
function toItem(row) {
  let reconciliationOk = null;
  if (row.reconciliation_ok !== undefined) {
    reconciliationOk = row.reconciliation_ok == null ? null : row.reconciliation_ok === true;
  } else if (row.reconciliation && typeof row.reconciliation === 'object' && 'ok' in row.reconciliation) {
    reconciliationOk = row.reconciliation.ok === true;
  }
  return {
    id: String(row.id),
    status: row.status,
    fileName: row.file_name || null,
    fileMime: row.file_mime || null,
    fileSize: num(row.file_size),
    uploadedBy: row.uploaded_by || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    processor: row.processor || null,
    merchantNumber: row.merchant_number || null,
    merchantName: row.merchant_name || null,
    periodStart: ymd(row.period_start),
    periodEnd: ymd(row.period_end),
    layoutVersion: row.layout_version || null,
    amountSubmitted: num(row.amount_submitted),
    totalFees: num(row.total_fees),
    amountProcessed: num(row.amount_processed),
    transactionCount: num(row.transaction_count),
    effectiveRate: num(row.effective_rate),
    debitShare: num(row.debit_share),
    findingsCount: num(row.findings_count),
    rebelipayEligible: row.status === 'analysed' ? row.rebelipay_eligible === true : null,
    rebelipaySavings: shownSaving(row, row.rebelipay_savings),
    rebelipaySavingsAnnual: shownSaving(row, row.rebelipay_savings_annual),
    parseError: row.parse_error || null,
    parseConfidence: num(row.parse_confidence),
    reconciliationOk,
    duplicateOf: idStr(row.duplicate_of),
  };
}

/* ── Storage ──────────────────────────────────────────────────────────────── */

/**
 * Write an upload to disk and return its path relative to UPLOAD_DIR.
 *
 * A random name, not the uploaded one: two statements called "statement.pdf"
 * must not collide, and the owner's name is kept in the row for display. The
 * extension comes from the validated kind, so a file can never be served back
 * as something other than what we checked it was.
 */
function storeFile(clientId, kind, buffer) {
  const ext = MIME_BY_KIND[kind] ? kind : null;
  if (!ext) throw new Error(`Unsupported statement kind: ${kind}`);
  const owner = String(clientId);
  if (!/^\d+$/.test(owner)) throw new Error('Invalid client id.');
  const dir = path.join(UPLOAD_DIR, owner);
  fs.mkdirSync(dir, { recursive: true });
  const stored = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, stored), buffer);
  return `${owner}/${stored}`;
}

/**
 * A stored relative path, resolved and fenced inside UPLOAD_DIR.
 *
 * Compared against the root PLUS a separator: a bare startsWith would let a
 * sibling directory such as "card-statements-old" through.
 */
function resolveFile(relPath) {
  if (!relPath) throw new Error('No stored file.');
  const full = path.resolve(UPLOAD_DIR, String(relPath));
  if (!full.startsWith(UPLOAD_DIR + path.sep)) throw new Error('Invalid file path.');
  return full;
}

/** Best-effort delete. A stranded file is a smaller problem than a failed request. */
function removeFile(relPath) {
  if (!relPath) return false;
  try {
    fs.unlinkSync(resolveFile(relPath));
    return true;
  } catch {
    return false;
  }
}

function fileExists(relPath) {
  try {
    return fs.existsSync(resolveFile(relPath));
  } catch {
    return false;
  }
}

/** sha256 of the uploaded bytes - the key a re-upload is recognised by. */
function contentHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 'pdf' | 'csv' | null. The check itself belongs to the reader. */
const detectKind = (file) => extractor().detectKind(file);

/* ── The activity trail ───────────────────────────────────────────────────── */

/**
 * Append one event to a statement's trail.
 *
 * Deliberately cannot fail its caller: a statement that was analysed correctly
 * but whose log line could not be written is still an analysed statement.
 * Not awaited on hot paths, as in Quick-PO. Payloads carry facts about the
 * event, never the extracted statement and never Rebelipay's price parts.
 */
async function logEvent(pool, { statementId, clientId, locationId = null, event, actor = null, payload = null }) {
  try {
    await pool.query(
      `INSERT INTO card_statement_events
         (statement_id, client_id, location_id, event, actor, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [statementId, clientId, locationId, event, actor, payload == null ? null : JSON.stringify(payload)]
    );
  } catch (err) {
    logger.warn('[CS] could not write event', { statementId, event, error: err.message });
  }
}

/** One statement's trail, oldest first. */
async function listEvents(pool, clientId, statementId, { limit = 500 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, event, actor, payload, created_at
       FROM card_statement_events
      WHERE statement_id = $1 AND client_id = $2
      ORDER BY created_at, id
      LIMIT $3`,
    [statementId, clientId, Math.min(Number(limit) || 500, 1000)]
  );
  return rows;
}

/* ── Upload-time persistence ──────────────────────────────────────────────── */

/**
 * Has this client already got this exact file?
 *
 * Matched on CONTENT, not name: one statement arrives as "Statement.pdf",
 * "Statement (1).pdf" and "July.pdf". A tombstone still holds its file's
 * hash, so the bytes of a re-scan that became a duplicate are caught here too,
 * before any read is paid for; the answer is the ORIGINAL the tombstone points
 * at, so the owner is pointed at a statement they can actually see. A visible
 * row wins over a tombstone when both match.
 */
async function findByContent(pool, clientId, sha) {
  if (!sha) return null;
  const { rows } = await pool.query(
    `SELECT o.id, o.status, o.merchant_name, o.merchant_number, o.period_end, o.file_name,
            to_char(o.created_at, 'YYYY-MM-DD') AS uploaded_on
       FROM card_statements d
       JOIN card_statements o ON o.id = COALESCE(d.duplicate_of, d.id) AND o.client_id = d.client_id
      WHERE d.client_id = $1 AND d.content_sha256 = $2 AND o.status <> 'duplicate'
      ORDER BY (d.status = 'duplicate'), d.id LIMIT 1`,
    [clientId, sha]
  );
  return rows[0] || null;
}

/**
 * Did another upload of this exact file win the race?
 *
 * The route checks findByContent before inserting, so two uploads of one file
 * arriving together both see nothing and both insert. Re-checking once the
 * row exists lets the loser retire itself; ordering by id means both rows agree
 * on which of them is the original. Same reasoning as Quick-PO.
 */
async function findEarlierByContent(pool, clientId, sha, id) {
  if (!sha) return null;
  const { rows } = await pool.query(
    `SELECT id, status, merchant_name, merchant_number, period_end, file_name,
            to_char(created_at, 'YYYY-MM-DD') AS uploaded_on
       FROM card_statements
      WHERE client_id = $1 AND content_sha256 = $2 AND id < $3 AND status <> 'duplicate'
      ORDER BY id LIMIT 1`,
    [clientId, sha, id]
  );
  return rows[0] || null;
}

/** The owner-facing reply to a byte-identical re-upload. */
function sameFileMessage(row) {
  const label = row ? statementLabel(row) : null;
  return `This file is already on your list${label ? ` as ${label}` : ''}`
    + `${row && row.uploaded_on ? `, uploaded ${row.uploaded_on}` : ''}.`;
}

async function createAnalysing(pool, { clientId, locationId, sha, uploadedBy, file }) {
  const { rows } = await pool.query(
    `INSERT INTO card_statements
       (client_id, location_id, status, file_name, file_mime, file_size, file_path,
        content_sha256, uploaded_by)
     VALUES ($1, $2, 'analysing', $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [clientId, locationId, file.name, file.mime, file.size, file.path, sha || null, uploadedBy || null]
  );
  return rows[0].id;
}

/**
 * Remove an upload that lost the duplicate race: hash duplicates create no row
 * (contract D8), so the loser's row and file both go.
 */
async function discardUpload(pool, clientId, id, relPath) {
  await pool.query('DELETE FROM card_statements WHERE id = $1 AND client_id = $2', [id, clientId]);
  removeFile(relPath);
}

/* ── Analysis-time persistence ────────────────────────────────────────────── */

/**
 * Earlier analysed statements of the same client and merchant, for the trend
 * on layouts that do not print one. The engine ignores anything not strictly
 * earlier; the query does too, so the pool carries less.
 */
async function loadHistory(pool, clientId, merchantNumber, periodEnd, excludeId) {
  if (!merchantNumber || !periodEnd) return [];
  // The filed figures too, so the top figures can say how they moved from
  // last month (D47); the average sale is the one the statement's page shows.
  const { rows } = await pool.query(
    `SELECT period_start, period_end, layout_version, amount_submitted, total_fees, amount_processed,
            effective_rate, debit_share, analysis->'kpis'->>'avgTicket' AS avg_ticket
       FROM card_statements
      WHERE client_id = $1 AND merchant_number = $2 AND status = 'analysed'
        AND id <> $3 AND period_end < $4::date
      ORDER BY period_end`,
    [clientId, String(merchantNumber), excludeId, periodEnd]
  );
  return rows.map((r) => ({
    periodStart: ymd(r.period_start),
    periodEnd: ymd(r.period_end),
    // A file is not "last month" for the top figures (D47).
    layoutVersion: r.layout_version || null,
    amountSubmitted: num(r.amount_submitted),
    totalFees: num(r.total_fees),
    amountProcessed: num(r.amount_processed),
    effectiveRate: num(r.effective_rate),
    debitShare: num(r.debit_share),
    avgTicket: num(r.avg_ticket),
  }));
}

/**
 * File a finished analysis on its row.
 *
 * Guarded by the status the caller expects (`analysing` for a background read,
 * the row's current status for a synchronous re-run): if the stale sweep, a
 * delete or a second re-run got there first, nothing is written and false comes
 * back. One statement, so no transaction to hold open on a five-connection pool.
 * A second analysed statement for the same merchant and period raises 23505 on
 * card_statements_identity_uniq, which the caller turns into a duplicate.
 */
async function saveAnalysed(pool, { id, clientId, extracted, analysis, header, reconciliation, model, ms, expect }) {
  const h = header || {};
  const { rowCount } = await pool.query(
    `UPDATE card_statements SET
       status = 'analysed', parse_error = NULL, duplicate_of = NULL,
       processor = $3, merchant_number = $4, merchant_name = $5,
       period_start = $6::date, period_end = $7::date, layout_version = $8,
       amount_submitted = $9, total_fees = $10, amount_processed = $11,
       transaction_count = $12, effective_rate = $13, debit_share = $14, findings_count = $15,
       rebelipay_cost = $16, rebelipay_savings = $17, rebelipay_savings_annual = $18,
       rebelipay_eligible = $19,
       extracted = $20::jsonb, analysis = $21::jsonb, reconciliation = $22::jsonb,
       parse_model = $23, parse_confidence = $24, parse_ms = $25, analysis_version = $26,
       updated_at = now()
     WHERE id = $1 AND client_id = $2 AND status = ANY($27::text[])`,
    [id, clientId,
      h.processor || null, h.merchantNumber != null ? String(h.merchantNumber) : null, h.merchantName || null,
      ymd(h.periodStart), ymd(h.periodEnd), h.layoutVersion || null,
      fit(h.amountSubmitted, 1e12), fit(h.totalFees, 1e12), fit(h.amountProcessed, 1e12),
      intOrNull(h.transactionCount), fit(h.effectiveRate, 999.9999), fit(h.debitShare, 999.9999),
      intOrNull(h.findingsCount),
      fit(h.rebelipayCost, 1e12), fit(h.rebelipaySavings, 1e12), fit(h.rebelipaySavingsAnnual, 1e12),
      h.rebelipayEligible === true,
      JSON.stringify(extracted), JSON.stringify(analysis), JSON.stringify(reconciliation),
      model || null, fit(reconciliation && reconciliation.confidence, 9.9999), intOrNull(ms),
      intOrNull(h.analysisVersion),
      expect]
  );
  return rowCount > 0;
}

/* ── Keeping the list in step (contract D44) ──────────────────────────────── */

// The list reads the figures filed with each row; the statement page re-runs
// the engine every time it opens (D10). After a rule change, or a change to the
// store's earlier statements (a trend is built from them), the two would
// disagree - the list said "5 flagged" while the page showed another count.
// These are the filed figures, as saveAnalysed writes them:
// [column, header key, decimals, the column's limit].
const LIST_FIGURES = [
  ['amount_submitted', 'amountSubmitted', 2, 1e12],
  ['total_fees', 'totalFees', 2, 1e12],
  ['amount_processed', 'amountProcessed', 2, 1e12],
  ['transaction_count', 'transactionCount', 0, null],
  ['effective_rate', 'effectiveRate', 4, 999.9999],
  ['debit_share', 'debitShare', 4, 999.9999],
  ['findings_count', 'findingsCount', 0, null],
  ['rebelipay_cost', 'rebelipayCost', 2, 1e12],
  ['rebelipay_savings', 'rebelipaySavings', 2, 1e12],
  ['rebelipay_savings_annual', 'rebelipaySavingsAnnual', 2, 1e12],
];

// A figure as saveAnalysed would write it (null where it would write null),
// and as its column keeps it, rounded to the column's decimals.
const unfiled = (value, decimals, limit) => (decimals ? fit(value, limit) : intOrNull(value));
const filed = (value, decimals, limit) => {
  const n = unfiled(value, decimals, limit);
  return n === null ? null : Number(n.toFixed(decimals));
};

// True when a fresh header would change what the list shows. The stored figure
// is the column's rounding of the engine's, so anything within half a unit of
// its last decimal is the same figure.
function figuresMoved(row, header) {
  if ((row.rebelipay_eligible === true) !== (header.rebelipayEligible === true)) return true;
  return LIST_FIGURES.some(([column, key, decimals, limit]) => {
    const was = num(row[column]);
    const now = unfiled(header[key], decimals, limit);
    if (was === null || now === null) return was !== now;
    return Math.abs(was - now) > 0.5 * 10 ** -decimals + 1e-9;
  });
}

/**
 * File a fresh analysis's figures on an analysed row, when any of them moved
 * or the row was filed by an older engine. Returns the row as now stored, or
 * null when nothing was written. Guarded by status, so a row a re-read or a
 * delete got to first is left alone. updated_at stays as it was: this re-files
 * figures the engine derives, it is not an upload, a re-read or a change of
 * status, and the Log's "Updated" says so.
 */
async function refileFigures(pool, row, clientId, analysis, header) {
  if (!row || row.status !== 'analysed' || !header) return null;
  const outdated = num(row.analysis_version) !== intOrNull(header.analysisVersion);
  if (!outdated && !figuresMoved(row, header)) return null;
  const values = LIST_FIGURES.map(([, key, decimals, limit]) => filed(header[key], decimals, limit));
  const eligible = header.rebelipayEligible === true;
  const version = intOrNull(header.analysisVersion);
  const { rowCount } = await pool.query(
    `UPDATE card_statements SET
       amount_submitted = $3, total_fees = $4, amount_processed = $5, transaction_count = $6,
       effective_rate = $7, debit_share = $8, findings_count = $9, rebelipay_cost = $10,
       rebelipay_savings = $11, rebelipay_savings_annual = $12, rebelipay_eligible = $13,
       analysis = $14::jsonb, analysis_version = $15
     WHERE id = $1 AND client_id = $2 AND status = 'analysed'`,
    [row.id, clientId, ...values, eligible, JSON.stringify(analysis), version]
  );
  if (!rowCount) return null;
  logger.info('[CS] list figures re-filed', {
    id: String(row.id), clientId, findings: { was: num(row.findings_count), now: values[6] } });
  const next = { ...row, rebelipay_eligible: eligible, analysis, analysis_version: version };
  LIST_FIGURES.forEach(([column], i) => { next[column] = values[i]; });
  return next;
}

// What re-filing reads of a row: enough to re-run the engine and compare.
const REFILE_COLUMNS = `id, status, merchant_number, period_end, extracted, ${LIST_FIGURES.map(([c]) => c).join(', ')},
       rebelipay_eligible, analysis_version`;

/** Re-run one row with its current history and re-file it. Never throws. */
async function refileRow(pool, clientId, row) {
  try {
    if (!row.extracted) return false;
    const history = await loadHistory(pool, clientId, row.merchant_number, ymd(row.period_end), row.id);
    const fresh = engine().analyse(row.extracted, { history, rules: rules() });
    return !!(await refileFigures(pool, row, clientId, fresh.analysis, fresh.header));
  } catch (err) {
    // One statement the engine cannot re-run does not stop the others.
    logger.warn('[CS] could not re-file a statement', { id: String(row.id), clientId, error: err.message });
    return false;
  }
}

async function refileLaterNow(pool, clientId, merchantNumber, periodEnd, andItself) {
  try {
    const { rows } = await pool.query(
      `SELECT ${REFILE_COLUMNS}
         FROM card_statements
        WHERE client_id = $1 AND merchant_number = $2 AND status = 'analysed' AND period_end ${andItself ? '>=' : '>'} $3::date
        ORDER BY period_end`,
      [clientId, String(merchantNumber), periodEnd]
    );
    let moved = 0;
    for (const row of rows) if (await refileRow(pool, clientId, row)) moved += 1;
    return moved;
  } catch (err) {
    logger.warn('[CS] could not re-file the later statements', { clientId, error: err.message });
    return 0;
  }
}

// One re-filing run per store at a time in this process, so two runs that
// started from different histories cannot land out of order: the later run
// starts after the earlier one has written, and reads the history as it is
// then.
const refiling = new Map();

/**
 * Re-file the figures of a store's statements dated after `periodEnd`. Their
 * trends are built from the store's earlier statements, so one analysed,
 * re-read, failed or deleted before them can move their figures. With
 * `andItself` the statement dated `periodEnd` is re-filed too: a statement
 * just saved read its history before an earlier one of its store may have
 * landed, and this run, queued behind that one's, reads it as it is now.
 * Never throws: the change that called it has already been made, and a
 * statement's page re-files its own figures when it is opened.
 */
function refileLater(pool, clientId, merchantNumber, periodEnd, { andItself = false } = {}) {
  if (!merchantNumber || !periodEnd) return Promise.resolve(0);
  const key = `${clientId}:${merchantNumber}`;
  const run = (refiling.get(key) || Promise.resolve())
    .then(() => refileLaterNow(pool, clientId, merchantNumber, periodEnd, andItself));
  refiling.set(key, run);
  run.then(() => { if (refiling.get(key) === run) refiling.delete(key); });
  return run;
}

/**
 * Re-file this client's rows that an older engine filed (D44). A rule change
 * raises ANALYSIS_VERSION; without this the list would show the old figures
 * until each statement was opened. Runs before the list, for this client only,
 * as the lazy sweep does; once every row is current it is one small query.
 * Never throws.
 */
async function refileOutdated(pool, clientId) {
  try {
    const { rows } = await pool.query(
      `SELECT ${REFILE_COLUMNS}
         FROM card_statements
        WHERE client_id = $1 AND status = 'analysed' AND extracted IS NOT NULL
          AND (analysis_version IS NULL OR analysis_version < $2)
        ORDER BY period_end`,
      [clientId, engine().ANALYSIS_VERSION]
    );
    for (const row of rows) await refileRow(pool, clientId, row);
    return rows.length;
  } catch (err) {
    logger.warn('[CS] could not re-file the outdated statements', { clientId, error: err.message });
    return 0;
  }
}

/**
 * Record a failure with owner-safe text. The extraction is kept when there is
 * one: a read is the expensive part, and "Analyse again" can then re-run the
 * checks and the engine without paying for another.
 */
async function markFailed(pool, { id, clientId, message, extracted = null, model = null, ms = null, expect }) {
  const { rowCount } = await pool.query(
    `UPDATE card_statements SET
       status = 'failed', parse_error = $3,
       extracted = COALESCE($4::jsonb, extracted),
       parse_model = COALESCE($5, parse_model), parse_ms = COALESCE($6, parse_ms),
       updated_at = now()
     WHERE id = $1 AND client_id = $2 AND status = ANY($7::text[])`,
    [id, clientId, String(message || GENERIC_FAILURE).slice(0, 500),
      extracted ? JSON.stringify(extracted) : null, model || null, intOrNull(ms), expect]
  );
  return rowCount > 0;
}

/**
 * Turn this row into a tombstone for the analysed statement it repeats
 * (contract D8): status 'duplicate', pointed at the original, its file deleted,
 * a 'duplicate' event on both rows. Returns the original's id, or null when
 * there is no original to point at (it was deleted in the meantime) and the
 * caller should treat this as an ordinary failure.
 */
async function markDuplicate(pool, { id, clientId, locationId, extracted, expect }) {
  const merchantNumber = extracted && extracted.merchant && extracted.merchant.number;
  const periodEnd = ymd(extracted && extracted.period && extracted.period.end);
  if (!merchantNumber || !periodEnd) return null;

  const { rows: [original] } = await pool.query(
    `SELECT id, location_id
       FROM card_statements
      WHERE client_id = $1 AND merchant_number = $2 AND period_end = $3::date
        AND status = 'analysed' AND id <> $4
      ORDER BY id LIMIT 1`,
    [clientId, String(merchantNumber), periodEnd, id]
  );
  if (!original) return null;

  // The tombstone keeps who and when (so the screen can say "same statement
  // as WINE REPUBLIC, Jul 2026"), and drops the file and the documents.
  const { rows: [gone] } = await pool.query(
    `WITH before AS (
       SELECT file_path FROM card_statements WHERE id = $1 AND client_id = $2
     )
     UPDATE card_statements SET
       status = 'duplicate', duplicate_of = $3, parse_error = NULL,
       merchant_number = $4, merchant_name = $5, period_start = $6::date, period_end = $7::date,
       extracted = NULL, analysis = NULL, reconciliation = NULL, file_path = NULL,
       updated_at = now()
     WHERE id = $1 AND client_id = $2 AND status = ANY($8::text[])
     RETURNING file_name, (SELECT file_path FROM before) AS old_file_path`,
    [id, clientId, original.id, String(merchantNumber),
      (extracted.merchant && extracted.merchant.name) || null,
      ymd(extracted.period && extracted.period.start), periodEnd, expect]
  );
  if (!gone) return String(original.id); // already moved on; nothing to tidy
  removeFile(gone.old_file_path);

  logEvent(pool, {
    statementId: id, clientId, locationId, event: 'duplicate',
    payload: { reason: 'same_statement', duplicateOf: String(original.id) },
  });
  logEvent(pool, {
    statementId: original.id, clientId, locationId: original.location_id, event: 'duplicate',
    payload: { reason: 'same_statement', duplicateId: String(id), fileName: gone.file_name || null },
  });
  logger.info('[CS] same statement uploaded again; kept the original', {
    id, originalId: String(original.id), clientId });
  return String(original.id);
}

/* ── The lifecycle ────────────────────────────────────────────────────────── */

/**
 * Check, analyse and save an extraction. Throws owner errors (a missing core
 * header), identity conflicts (23505) and anything unexpected; the caller
 * decides what each means. Returns 'analysed', or 'gone' when the row was no
 * longer in the expected state.
 */
async function applyAnalysis(pool, { id, clientId, locationId, extracted, model, ms, expect,
  event = 'analysed', actor = null }) {
  const missing = reconciler().coreHeaderMissing(extracted) || [];
  if (missing.length) {
    throw ownerError(`Could not read this statement: no ${joinWords(missing)} found.`, 'CORE_HEADER_MISSING');
  }
  // Negative card volume is a misread (sales read as refunds, a sign that
  // slipped), and every KPI built on it would be nonsense. Zero is a real,
  // if quiet, month and is analysed.
  if (extracted.summary.amount_submitted < 0) {
    throw ownerError('Could not read this statement: the amount submitted came out negative.', 'AMOUNT_NEGATIVE');
  }
  const reconciliation = reconciler().reconcile(extracted);
  const history = await loadHistory(pool, clientId,
    extracted.merchant && extracted.merchant.number,
    ymd(extracted.period && extracted.period.end), id);
  const { analysis, header } = engine().analyse(extracted, { history, rules: rules() });

  const saved = await saveAnalysed(pool, {
    id, clientId, extracted, analysis, header, reconciliation, model, ms, expect,
  });
  if (!saved) return 'gone';

  logEvent(pool, {
    statementId: id, clientId, locationId, event, actor,
    payload: {
      checksPassed: reconciliation.passed,
      checksTotal: reconciliation.total,
      confidence: reconciliation.confidence,
      findings: header && header.findingsCount != null ? header.findingsCount : null,
      ms: intOrNull(ms),
    },
  });
  // This statement is now part of the later ones' history (D44); and itself,
  // in case an earlier statement of its store landed while it was analysed.
  await refileLater(pool, clientId, header.merchantNumber, ymd(header.periodEnd), { andItself: true });
  return 'analysed';
}

/**
 * Record why an analysis did not finish. Never throws: it runs where the only
 * place left to report anything is the row itself.
 */
async function settleFailure(pool, { id, clientId, locationId, err, extracted = null, model = null, ms = null, expect }) {
  try {
    if (isIdentityConflict(err)) {
      const originalId = await markDuplicate(pool, { id, clientId, locationId, extracted, expect });
      if (originalId) return 'duplicate';
    }
    // Raw text to the log only, at warn: it can carry SDK detail, and the
    // owner gets either the reader's own owner-safe message or the generic one.
    logger.warn('[CS] analysis failed', {
      id, clientId, code: err && err.code, error: err && err.message });
    const message = (err && err.publicMessage) || GENERIC_FAILURE;
    const marked = await markFailed(pool, { id, clientId, message, extracted, model, ms, expect });
    if (!marked) return 'gone';
    logEvent(pool, {
      statementId: id, clientId, locationId, event: 'analysis_failed', payload: { message },
    });
    return 'failed';
  } catch (inner) {
    logger.error('[CS] could not record a failed analysis', { id, clientId, error: inner.message });
    return 'error';
  }
}

/** The stored original, for a read that did not arrive with the upload's bytes. */
async function loadSource(pool, id, clientId) {
  const { rows: [row] } = await pool.query(
    `SELECT file_path, file_mime, file_name, location_id
       FROM card_statements WHERE id = $1 AND client_id = $2`,
    [id, clientId]
  );
  if (!row) return null;
  if (!row.file_path || !fileExists(row.file_path)) throw ownerError(FILE_GONE, 'FILE_MISSING');
  return {
    buffer: fs.readFileSync(resolveFile(row.file_path)),
    kind: KIND_BY_MIME[row.file_mime] || null,
    fileName: row.file_name,
    locationId: row.location_id,
  };
}

/**
 * Read a statement and file the outcome. Returns nothing useful and never
 * throws: the response has already gone, so the row's status, its parse_error
 * and its log are the only places a result can land.
 *
 * Upload passes the bytes it already holds; a re-read passes none and the
 * stored original is loaded. Flow (contract section 7): extract, core header,
 * reconcile, history, analyse, save as analysed - or duplicate, or failed.
 */
async function analyseInBackground(id, { clientId, locationId = null, pool = getAnalyticsPool(),
  buffer = null, kind = null, fileName = null } = {}) {
  let extracted = null;
  let model = null;
  let ms = null;
  let where = locationId;
  try {
    let source = buffer ? { buffer, kind, fileName } : null;
    if (!source) {
      source = await loadSource(pool, id, clientId);
      if (!source) {
        logger.warn('[CS] statement was deleted before it could be read', { id, clientId });
        return;
      }
      if (where == null) where = source.locationId;
    }

    ({ extracted, model, ms } = await extractor().extract({
      buffer: source.buffer, kind: source.kind, fileName: source.fileName,
    }));

    const outcome = await applyAnalysis(pool, {
      id, clientId, locationId: where, extracted, model, ms, expect: ['analysing'],
    });
    if (outcome === 'gone') {
      // Swept as interrupted, deleted, or re-run while this read was out.
      // Whatever happened first stands; this result is dropped.
      logger.warn('[CS] statement changed while it was being read; result dropped', { id, clientId });
      return;
    }
    logger.info('[CS] analysed', { id, clientId, ms: intOrNull(ms) });
  } catch (err) {
    // A re-read's statement left the later ones' history when it went back to
    // 'analysing', and reanalyse() re-filed them then (D44); failing keeps it
    // out, so there is nothing more to re-file here.
    await settleFailure(pool, {
      id, clientId, locationId: where, err, extracted, model, ms, expect: ['analysing'],
    });
  }
}

/**
 * Mark statements stranded in 'analysing' as failed (contract D13).
 *
 * A read lives only in the memory of the process that started it, so a
 * restart strands its row and the screen would poll it forever. The age
 * threshold (CS_STALE_MINUTES, default 10) sits well above the reader's worst
 * case - an explicit timeout with a single retry - so a live read on another
 * instance is never swept, and running this from several instances at once is
 * harmless: the UPDATE is idempotent.
 *
 * With a clientId it is the lazy sweep the list and detail reads run first.
 * Without one it is the boot-time system sweep. Returns how many rows it moved,
 * and never throws: a sweep must not break a read or a boot.
 */
async function recoverStuck({ clientId = null, pool = getAnalyticsPool() } = {}) {
  const minutes = staleMinutes();
  try {
    const { rows } = clientId != null
      ? await pool.query(
        `UPDATE card_statements SET status = 'failed', parse_error = $3, updated_at = now()
          WHERE client_id = $1 AND status = 'analysing'
            AND updated_at < now() - make_interval(mins => $2::int)
          RETURNING id, client_id, location_id`,
        [clientId, minutes, INTERRUPTED_MESSAGE])
      // THE ONE STATEMENT IN THIS FEATURE WITHOUT A CLIENT PREDICATE, on
      // purpose. It runs at boot, on behalf of no one, and its job is exactly
      // the rows of every client that the restart stranded. It reads nothing
      // back to anyone, and it can only move a row from 'analysing' to
      // 'failed' with a fixed message; each row's event is written under that
      // row's own client_id.
      : await pool.query(
        `UPDATE card_statements SET status = 'failed', parse_error = $2, updated_at = now()
          WHERE status = 'analysing'
            AND updated_at < now() - make_interval(mins => $1::int)
          RETURNING id, client_id, location_id`,
        [minutes, INTERRUPTED_MESSAGE]);

    for (const r of rows) {
      logEvent(pool, {
        statementId: r.id, clientId: r.client_id, locationId: r.location_id, event: 'interrupted',
        payload: { staleMinutes: minutes },
      });
    }
    if (rows.length) {
      logger.info('[CS] interrupted statements marked failed', {
        count: rows.length, scope: clientId != null ? 'client' : 'boot', clientId, staleMinutes: minutes });
    }
    return rows.length;
  } catch (err) {
    // 42P01: the tables are not there yet (migrations pending). Nothing to sweep.
    if (err && err.code !== '42P01') {
      logger.warn('[CS] stuck-statement sweep failed', { clientId, error: err.message });
    }
    return 0;
  }
}

/* ── Reads ────────────────────────────────────────────────────────────────── */

/**
 * A page of statements, searched, filtered and sorted.
 *
 * Duplicate tombstones are never listed. The filter is built once and used for
 * the page and the total, so "1-25 of N" counts the rows the table shows.
 * `stores` is the store filter's option list: every merchant this client has,
 * unfiltered, so the dropdown does not empty itself as the owner narrows.
 */
async function list({ clientId, pool = getAnalyticsPool(), limit = 25, offset = 0, q = '',
  status = '', store = '', sort = 'store' } = {}) {
  await recoverStuck({ clientId, pool });
  // Figures an older engine filed are re-filed before they are listed (D44).
  await refileOutdated(pool, clientId);

  const where = ['client_id = $1', "status <> 'duplicate'"];
  const params = [clientId];

  // Store, merchant #, file name, or a period such as "june" or "06/2026":
  // every word must match (cardStatementSearch.js). Parameterised throughout.
  const search = searchClause(q, params);
  if (search) where.push(search);

  const wanted = String(status || '').trim();
  if (LIST_STATUSES.includes(wanted)) {
    params.push(wanted);
    where.push(`status = $${params.length}`);
  }

  const merchant = String(store || '').trim();
  if (merchant) {
    params.push(merchant);
    where.push(`merchant_number = $${params.length}`);
  }

  const filter = where.join(' AND ');
  const order = SORTS[sort] || SORTS.store;
  const pageParams = params.concat([
    Math.min(Math.max(parseInt(limit, 10) || 25, 1), 200),
    Math.max(parseInt(offset, 10) || 0, 0),
  ]);

  const { rows } = await pool.query(
    `SELECT ${LIST_COLUMNS}
       FROM card_statements
      WHERE ${filter}
      ORDER BY ${order}
      LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams
  );
  const { rows: [{ total }] } = await pool.query(
    `SELECT count(*)::int AS total FROM card_statements WHERE ${filter}`,
    params
  );
  // The name a merchant goes by is the one on its latest statement.
  const { rows: stores } = await pool.query(
    `SELECT merchant_number,
            (array_agg(merchant_name ORDER BY period_end DESC NULLS LAST, id DESC)
               FILTER (WHERE merchant_name IS NOT NULL))[1] AS merchant_name,
            count(*)::int AS count
       FROM card_statements
      WHERE client_id = $1 AND status <> 'duplicate' AND merchant_number IS NOT NULL
      GROUP BY merchant_number
      ORDER BY 2 NULLS LAST, merchant_number`,
    [clientId]
  );

  return {
    data: rows.map(toItem),
    total,
    stores: stores.map((s) => ({
      merchantNumber: s.merchant_number,
      merchantName: s.merchant_name || null,
      count: s.count,
    })),
  };
}

/**
 * Savings to date for one merchant, or null when the screen would not show it.
 *
 * Raw savings, negatives included, so the total is honest (contract section 6).
 * Only returned when it is positive and covers at least two statements: with
 * one statement it IS that statement's saving, and a negative one must not be
 * shown or derivable.
 */
async function loadSavingsToDate(pool, clientId, merchantNumber) {
  if (!merchantNumber) return null;
  const { rows } = await pool.query(
    `SELECT period_end, rebelipay_savings
       FROM card_statements
      WHERE client_id = $1 AND merchant_number = $2 AND status = 'analysed'
      ORDER BY period_end`,
    [clientId, merchantNumber]
  );
  // Both spellings of the saving: the pricing module reads `rebelipaySavings`
  // (the header's name for it); `savings` is the name the contract's interface
  // note uses. Passing both keeps the two from drifting apart silently.
  const total = pricing().savingsToDate(rows.map((r) => ({
    periodEnd: ymd(r.period_end),
    rebelipaySavings: num(r.rebelipay_savings),
    savings: num(r.rebelipay_savings),
  })));
  return total && total.amount > 0 && total.statements >= 2 ? total : null;
}

/** A full row as the detail response (contract section 7). */
async function buildDetail(pool, stored, clientId) {
  let row = stored;
  let analysis = null;
  let analysisVersion = num(row.analysis_version);
  if (row.status === 'analysed') {
    analysis = row.analysis || null;
    // Re-run at read time with the merchant's current history (contract D10):
    // the engine is pure and takes milliseconds, and this way the order the
    // statements were uploaded in no longer decides the legacy trend.
    if (row.extracted) {
      try {
        const history = await loadHistory(pool, clientId, row.merchant_number, ymd(row.period_end), row.id);
        const fresh = engine().analyse(row.extracted, { history, rules: rules() });
        analysis = fresh.analysis;
        if (fresh.header && fresh.header.analysisVersion != null) analysisVersion = num(fresh.header.analysisVersion);
        // What the page shows now is what the list shows next (D44).
        try {
          row = (await refileFigures(pool, row, clientId, fresh.analysis, fresh.header)) || row;
        } catch (err) {
          logger.warn('[CS] could not re-file the list figures', { id: String(row.id), clientId, error: err.message });
        }
      } catch (err) {
        logger.warn('[CS] read-time analysis failed; serving the stored one', {
          id: String(row.id), clientId, error: err.message });
      }
    }
  }
  const savingsToDate = row.status === 'analysed'
    ? await loadSavingsToDate(pool, clientId, row.merchant_number)
    : null;

  return {
    ...toItem(row),
    parseModel: row.parse_model || null,
    parseMs: num(row.parse_ms),
    analysisVersion,
    reconciliation: row.reconciliation || null,
    analysis,
    savingsToDate,
    rebelipayCtaUrl: ctaUrl(),
  };
}

/**
 * One statement, or null when it is not this client's. Duplicate tombstones
 * are returned (status 'duplicate', duplicateOf set) so the screen can explain
 * where an upload went; they are only ever hidden from the list.
 */
async function getDetail(id, { clientId, pool = getAnalyticsPool() } = {}) {
  if (!validId(id)) return null;
  await recoverStuck({ clientId, pool });
  const { rows: [row] } = await pool.query(
    'SELECT * FROM card_statements WHERE id = $1 AND client_id = $2',
    [id, clientId]
  );
  if (!row) return null;
  return buildDetail(pool, row, clientId);
}

/** One statement's event log, oldest first, or null when it is not this client's. */
async function getLog(id, { clientId, pool = getAnalyticsPool() } = {}) {
  if (!validId(id)) return null;
  const { rows: [row] } = await pool.query(
    'SELECT id FROM card_statements WHERE id = $1 AND client_id = $2',
    [id, clientId]
  );
  if (!row) return null;
  const events = await listEvents(pool, clientId, id);
  return {
    data: events.map((e) => ({
      id: String(e.id),
      event: e.event,
      actor: e.actor || null,
      payload: e.payload || null,
      createdAt: iso(e.created_at),
    })),
  };
}

/** The stored original: { fullPath (null when gone), kind, mime, name }, or null. */
async function getFile(id, { clientId, pool = getAnalyticsPool() } = {}) {
  if (!validId(id)) return null;
  const { rows: [row] } = await pool.query(
    `SELECT file_path, file_name, file_mime
       FROM card_statements WHERE id = $1 AND client_id = $2`,
    [id, clientId]
  );
  if (!row) return null;
  const kind = KIND_BY_MIME[row.file_mime] || null;
  return {
    fullPath: row.file_path && fileExists(row.file_path) ? resolveFile(row.file_path) : null,
    kind,
    mime: MIME_BY_KIND[kind] || 'application/octet-stream',
    name: row.file_name || `statement.${kind || 'bin'}`,
  };
}

/* ── Writes the owner asks for ────────────────────────────────────────────── */

/**
 * "Analyse again" (contract section 7).
 *
 * By default it re-runs the checks and the engine on the stored extraction,
 * synchronously - milliseconds, no model call - and returns the fresh detail:
 * { accepted: false, detail }. With `reextract`, or when there is no stored
 * extraction, the original is read again in the background like an upload:
 * { accepted: true, id, status: 'analysing' }, answered 202. Null when the
 * statement is not this client's. Throws httpError 409s the route passes on.
 */
async function reanalyse(id, { clientId, pool = getAnalyticsPool(), reextract = false, actor = null } = {}) {
  if (!validId(id)) return null;
  const { rows: [row] } = await pool.query(
    `SELECT id, location_id, status, extracted, file_path, parse_model, parse_ms, merchant_number, period_end
       FROM card_statements WHERE id = $1 AND client_id = $2`,
    [id, clientId]
  );
  if (!row) return null;
  if (row.status === 'analysing') {
    throw httpError(409, 'BUSY', 'This statement is still being analysed. Try again when it finishes.');
  }
  if (row.status === 'duplicate') {
    throw httpError(409, 'DUPLICATE', 'This upload is a copy of a statement already on your list. Open that one instead.');
  }

  if (reextract || !row.extracted) {
    if (!row.file_path || !fileExists(row.file_path)) throw httpError(409, 'FILE_MISSING', FILE_GONE);
    const { rowCount } = await pool.query(
      `UPDATE card_statements SET status = 'analysing', parse_error = NULL, updated_at = now()
        WHERE id = $1 AND client_id = $2 AND status = $3`,
      [row.id, clientId, row.status]
    );
    if (!rowCount) {
      throw httpError(409, 'BUSY', 'This statement is still being analysed. Try again when it finishes.');
    }
    logEvent(pool, {
      statementId: row.id, clientId, locationId: row.location_id, event: 'reanalysed', actor,
      payload: { reextract: true },
    });
    // While it is read again it is out of the later statements' history,
    // whatever the read then finds - another store or period, a duplicate, a
    // failure - or if it is deleted meanwhile (D44). Re-file them now, under
    // the store and period it was filed with.
    if (row.status === 'analysed') await refileLater(pool, clientId, row.merchant_number, ymd(row.period_end));
    analyseInBackground(row.id, { clientId, locationId: row.location_id, pool });
    return { accepted: true, id: String(row.id), status: 'analysing' };
  }

  const ctx = {
    id: row.id, clientId, locationId: row.location_id, extracted: row.extracted,
    model: row.parse_model, ms: row.parse_ms, expect: [row.status],
  };
  try {
    await applyAnalysis(pool, { ...ctx, event: 'reanalysed', actor });
  } catch (err) {
    // Owner-facing outcomes become the row's state, as they would in the
    // background. Anything else (an engine fault) leaves the row as it was
    // and fails the request: a good stored result is not thrown away over it.
    if (!isIdentityConflict(err) && !(err && err.publicMessage)) throw err;
    await settleFailure(pool, { ...ctx, err });
    // An analysed statement that failed or became a duplicate left the later
    // ones' history (D44): re-file them under the store and period it had.
    if (row.status === 'analysed') await refileLater(pool, clientId, row.merchant_number, ymd(row.period_end));
  }
  return { accepted: false, detail: await getDetail(row.id, { clientId, pool }) };
}

/**
 * Delete a statement, its events and duplicate tombstones (by cascade), and
 * every file they held. Logged here because the trail goes with the row.
 * Returns { ok: true }, or null when it is not this client's.
 */
async function deleteStatement(id, { clientId, pool = getAnalyticsPool() } = {}) {
  if (!validId(id)) return null;
  // One statement: the tombstones' files are collected in the same snapshot
  // the cascade deletes them from.
  const { rows: [row] } = await pool.query(
    `WITH tombstones AS (
       SELECT file_path FROM card_statements
        WHERE client_id = $2 AND duplicate_of = $1 AND file_path IS NOT NULL
     )
     DELETE FROM card_statements WHERE id = $1 AND client_id = $2
     RETURNING id, status, file_path, merchant_number, period_end,
               (SELECT coalesce(array_agg(file_path), '{}') FROM tombstones) AS tombstone_files`,
    [id, clientId]
  );
  if (!row) return null;
  removeFile(row.file_path);
  for (const f of row.tombstone_files || []) removeFile(f);
  logger.info('[CS] statement deleted', { id: String(row.id), clientId, status: row.status });
  // It is no longer part of the later statements' history (D44).
  if (row.status === 'analysed') await refileLater(pool, clientId, row.merchant_number, ymd(row.period_end));
  return { ok: true };
}

/**
 * What the interest event and the lead webhook carry: who, which statement,
 * and the savings as totals and all-in rates. Built field by field from the
 * public analysis so nothing else can ride along - in particular never the
 * parts of Rebelipay's price (contract D7).
 */
function interestPayload(row, actor) {
  const a = row.analysis || {};
  const rp = a.rebelipay || {};
  return {
    merchantNumber: row.merchant_number || null,
    merchantName: row.merchant_name || null,
    period: {
      start: ymd(row.period_start),
      end: ymd(row.period_end),
      label: (a.period && a.period.label) || periodLabel(row.period_end),
    },
    savings: {
      volume: num(rp.volume),
      currentCost: num(rp.currentCost),
      rebelipayCost: num(rp.rebelipayCost),
      savings: num(rp.savings),
      savingsPct: num(rp.savingsPct),
      savingsAnnual: num(rp.savingsAnnual),
      // What the owner saw as the total (D49): switching plus a penalty fix.
      totalFound: num(rp.totalFound),
      totalFoundAnnual: num(rp.totalFoundAnnual),
      currentRate: num(rp.currentRate),
      rebelipayRate: num(rp.rebelipayRate),
    },
    user: actor || null,
  };
}

/**
 * Forward a lead to REBELIPAY_LEAD_WEBHOOK when one is set. Fire and forget:
 * five seconds at most, failures logged (without the payload), and the owner's
 * request never waits on it or fails because of it. Returns the promise for
 * tests, or null when no webhook is configured.
 */
function forwardLead(payload, { id, clientId }) {
  const url = httpUrl(process.env.REBELIPAY_LEAD_WEBHOOK);
  if (!url) return null;
  try {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'rebelipay_interest', statementId: String(id), ...payload }),
      signal: AbortSignal.timeout(LEAD_TIMEOUT_MS),
    })
      .then((res) => {
        if (res.ok) logger.info('[CS] lead forwarded', { id: String(id), clientId });
        else logger.warn('[CS] lead webhook refused', { id: String(id), clientId, status: res.status });
      })
      .catch((err) => logger.warn('[CS] lead webhook failed', { id: String(id), clientId, error: err.message }));
  } catch (err) {
    logger.warn('[CS] lead webhook failed', { id: String(id), clientId, error: err.message });
    return null;
  }
}

/**
 * "Explore Rebelipay" was clicked (contract D6). The browser has already
 * opened the CTA; this records the interest and passes the lead on.
 * Returns { ok, ctaUrl }, or null when the statement is not this client's.
 */
async function recordInterest(id, { clientId, pool = getAnalyticsPool(), actor = null } = {}) {
  if (!validId(id)) return null;
  const { rows: [row] } = await pool.query(
    `SELECT id, location_id, status, merchant_number, merchant_name, period_start, period_end,
            rebelipay_eligible, analysis
       FROM card_statements WHERE id = $1 AND client_id = $2`,
    [id, clientId]
  );
  if (!row) return null;
  const rp = row.analysis && row.analysis.rebelipay;
  if (row.status !== 'analysed' || row.rebelipay_eligible !== true || !rp || rp.eligible !== true) {
    throw httpError(409, 'NOT_ELIGIBLE', 'Rebelipay savings are not available for this statement.');
  }
  const payload = interestPayload(row, actor);
  logEvent(pool, {
    statementId: row.id, clientId, locationId: row.location_id, event: 'rebelipay_interest', actor, payload,
  });
  forwardLead(payload, { id: row.id, clientId });
  return { ok: true, ctaUrl: ctaUrl() };
}

/* ── CSV export ───────────────────────────────────────────────────────────── */

/**
 * One cell. Numbers stay plain (no $, no thousands separators). Text that a
 * spreadsheet would run as a formula is prefixed with a quote: descriptions
 * and notices are printed by a third party and arrive here verbatim.
 */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Fixed) return v.text;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A number already formatted, so money keeps its cents ("213.20", not "213.2")
// without passing through the text path and its formula guard.
class Fixed {
  constructor(text) { this.text = text; }
}

const money = (v) => {
  const n = num(v);
  return n === null ? null : new Fixed(n.toFixed(2));
};
const pct = (v) => {
  const n = num(v);
  return n === null ? null : Number(n.toFixed(4));
};
const yesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : null);

/**
 * The detail as a spreadsheet: Summary, Rebelipay comparison (eligible only;
 * totals and all-in rates only), Card types, Fee lines, Daily. UTF-8 with a
 * BOM so Excel opens accented merchant names correctly.
 */
function toCsv(detail) {
  const a = (detail && detail.analysis) || {};
  const k = a.kpis || {};
  const rp = a.rebelipay || null;
  const out = [];
  const row = (...cells) => out.push(cells.map(csvCell).join(','));
  const gap = () => out.push('');

  row('Summary');
  row('Field', 'Value');
  row('Store', detail.merchantName);
  row('Merchant number', detail.merchantNumber);
  row('Processor', detail.processor);
  row('Period start', detail.periodStart);
  row('Period end', detail.periodEnd);
  row('Card volume', money(k.cardVolume));
  row('Transactions', num(k.transactions));
  row('Processing fees', money(k.processingFees));
  row('Effective rate (%)', pct(k.effectiveRate));
  row('Debit volume', money(k.debitVolume));
  row('Debit share (%)', pct(k.debitShare));
  row('Fees paid on debit', money(k.debitFeesPaid));
  row('Net deposited', money(k.netDeposited));
  row('Average ticket', money(k.avgTicket));
  // As the page and the list say it: of the six checks (D43).
  row('Findings flagged', num(a.findingsCount) === null ? null : `${num(a.findingsCount)} of ${(a.findings || []).length}`);
  if (detail.reconciliation && detail.reconciliation.total != null) {
    // 'Checks' is the six findings; the printed totals that agree are 'totals' (D43).
    row('Totals that add up', `${detail.reconciliation.passed} of ${detail.reconciliation.total}`);
  }

  if (rp && rp.eligible === true) {
    gap();
    row('Rebelipay comparison');
    row('Field', 'Value');
    row('Paid today', money(rp.currentCost));
    row('With Rebelipay', money(rp.rebelipayCost));
    // As the page splits it (D49): switching, a free penalty fix, the total.
    row('You save by switching', money(rp.savings));
    row('You save by switching (%)', pct(rp.savingsPct));
    row('You save by switching per year at this pace (est.)', money(rp.savingsAnnual));
    if (num(rp.penaltyFix) !== null) {
      row(rp.penaltyFixLabel || 'Stop the penalty fees', money(rp.penaltyFix));
      row(`${rp.penaltyFixLabel || 'Stop the penalty fees'} per year (est.)`, money(rp.penaltyFixAnnual));
    }
    row('Total savings Botella found', money(rp.totalFound));
    row('Total savings Botella found per year (est.)', money(rp.totalFoundAnnual));
    row('All-in rate today (%)', pct(rp.currentRate));
    row('All-in rate with Rebelipay (%)', pct(rp.rebelipayRate));
  }

  gap();
  row('Card types');
  row('Type', 'Label', 'Transactions', 'Gross sales', 'Refund items', 'Refunds', 'Net items', 'Net sales',
    'Average ticket', 'Share (%)');
  for (const c of (a.cardMix && a.cardMix.rows) || []) {
    row(c.type, c.label, num(c.items), money(c.gross), num(c.refundItems), money(c.refunds),
      num(c.netItems), money(c.net), money(c.avgTicket), pct(c.sharePct));
  }

  gap();
  row('Fee lines');
  row('Category', 'Product', 'Network', 'Description', 'Rate (%)', 'Base amount', 'Count', 'Unit price',
    'Fee type', 'Amount', 'Tag');
  for (const f of a.feeLines || []) {
    row(f.category, f.product, f.network, f.description, pct(f.ratePct), money(f.baseAmount),
      num(f.count), money(f.unitPrice), f.feeType, money(f.amount), f.tag);
  }

  gap();
  row('Daily');
  row('Date', 'Day', 'Submitted', 'Disputes', 'Adjustments', 'Fees', 'Processed', 'Prior period');
  const daily = a.daily || {};
  for (const d of daily.rows || []) {
    row(d.date, d.dow, money(d.submitted), money(d.disputes), money(d.adjustments), money(d.fees),
      money(d.processed), yesNo(d.priorPeriod));
  }
  if (daily.monthEndCharges != null) {
    row('Month end charge', null, null, null, null, money(daily.monthEndCharges), null, null);
  }

  return `﻿${out.join('\r\n')}\r\n`;
}

/** card-statement-<merchant>-<YYYY-MM>.csv */
function csvFileName(detail) {
  const merchant = String((detail && detail.merchantNumber) || (detail && detail.id) || 'statement')
    .replace(/[^A-Za-z0-9_-]+/g, '');
  const month = detail && detail.periodEnd ? String(detail.periodEnd).slice(0, 7) : 'undated';
  return `card-statement-${merchant || 'statement'}-${month}.csv`;
}

module.exports = {
  // Storage
  storeFile,
  resolveFile,
  removeFile,
  contentHash,
  detectKind,
  // Upload-time persistence (pool first, as in Quick-PO)
  findByContent,
  findEarlierByContent,
  sameFileMessage,
  createAnalysing,
  discardUpload,
  logEvent,
  listEvents,
  // Analysis-time persistence
  loadHistory,
  saveAnalysed,
  markFailed,
  markDuplicate,
  // The list kept in step (D44)
  refileLater,
  refileOutdated,
  // Lifecycle
  analyseInBackground,
  recoverStuck,
  reanalyse,
  deleteStatement,
  recordInterest,
  // Reads
  list,
  getDetail,
  getLog,
  getFile,
  // Export
  toCsv,
  csvFileName,
  // Pure helpers, exported for the tests
  toItem,
  ymd,
  iso,
  periodLabel,
  statementLabel,
  joinWords,
  interestPayload,
  forwardLead,
  httpUrl,
  ctaUrl,
  isIdentityConflict,
  validId,
  staleMinutes,
  UPLOAD_DIR,
  MIME_BY_KIND,
  INTERRUPTED_MESSAGE,
  GENERIC_FAILURE,
};
