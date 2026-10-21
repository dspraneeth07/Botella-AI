#!/usr/bin/env node
/**
 * Card Statement Analysis - the real router, over HTTP, against a fake pool.
 *
 * The router and the service run exactly as the server runs them, on an
 * express app listening on an ephemeral port. Three things are replaced, and
 * only these:
 *
 *   the analytics pool    an in-memory table that answers the service's SQL
 *                         the way Postgres would, and records every statement
 *   the reader            extract() returns a hand-verified fixture instead of
 *                         calling a model (a CSV goes through the real,
 *                         deterministic parser)
 *   fetch                 the lead webhook is recorded; anything that is not
 *                         this test's own server is refused
 *
 * No database, no network, no .env. What is pinned:
 *
 *   TENANCY      every statement carries the client predicate (the boot sweep
 *                is the one exception), and another client's id is a 404 on
 *                every endpoint
 *   DUPLICATES   the same file is answered 200 with no insert; the same
 *                statement re-scanned becomes a tombstone, its file deleted,
 *                an event on both rows
 *   RECOVERY     rows stranded in 'analysing' are failed, lazily per client
 *                and by the boot sweep
 *   CONTRACT     upload validation, 409 BUSY, NOT_ELIGIBLE, the error
 *                envelope, 503 MIGRATION_MISSING
 *   NEVER        no payload, log entry, webhook body or CSV export carries a
 *                component of Rebelipay's price (D7)
 *
 * Run:  node tests/card-statement-routes-verify.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* ── Environment, before anything under test is loaded ────────────────────── */

const UPLOAD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-routes-'));
process.env.CS_UPLOAD_DIR = UPLOAD_ROOT;
process.env.CS_STALE_MINUTES = '10';
process.env.REBELIPAY_CTA_URL = 'https://rebelipay.example.test/start';
process.env.REBELIPAY_LEAD_WEBHOOK = 'https://leads.example.test/hook';
delete process.env.ANTHROPIC_API_KEY; // the reader can never reach a model

const logger = require('../utils/logger');
if (!process.env.CS_TEST_VERBOSE) logger.silent = true;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIXTURES = path.join(__dirname, 'fixtures', 'card-statements');
const load = (name) => JSON.parse(JSON.stringify(require(path.join(FIXTURES, `${name}.extracted.json`))));
const WR = '498387143882';
const SP = '498407670880';

/* ── The fake analytics pool ──────────────────────────────────────────────── */

// Postgres hands numeric and bigint back as strings, and (without the app's
// global type parser) a date as a Date at local midnight. The fake does the
// same, so the service's own decoding is what gets tested.
const NUMERIC = ['amount_submitted', 'total_fees', 'amount_processed', 'effective_rate', 'debit_share',
  'rebelipay_cost', 'rebelipay_savings', 'rebelipay_savings_annual', 'parse_confidence'];
const DATES = ['period_start', 'period_end'];

const db = { statements: [], events: [], nextId: 1, nextEventId: 1 };
const recorded = [];
let missingTables = false;

function out(row, columns = null) {
  const r = {};
  for (const [k, v] of Object.entries(row)) {
    if (columns && !columns.includes(k)) continue;
    if (k === 'id' || k === 'duplicate_of') r[k] = v == null ? null : String(v);
    else if (NUMERIC.includes(k)) r[k] = v == null ? null : String(v);
    else if (DATES.includes(k)) {
      if (v == null) r[k] = null;
      else { const [y, m, d] = v.split('-').map(Number); r[k] = new Date(y, m - 1, d); }
    } else r[k] = v;
  }
  return r;
}
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const jsonb = (v) => (v == null ? null : JSON.parse(v));
const dateOnly = (v) => (v == null ? null : String(v).slice(0, 10));
const byId = (id, clientId) => db.statements.find((r) => sameId(r.id, id) && r.client_id === clientId);
const ymdOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const res = (rows, rowCount = rows.length) => ({ rows, rowCount });

// A numeric(p, s) column keeps a value rounded to s decimals, half away from
// zero on the digits node-pg sends (String(n)), as Postgres does. So a figure
// read back can differ from the engine's in its last place, as it really does.
function atScale(v, s) {
  if (v === null || v === undefined) return v;
  const str = String(v);
  const [whole, frac = ''] = str.replace('-', '').split('.');
  if (/e/i.test(str) || frac.length <= s) return Number(v);
  const digits = BigInt(whole + frac.slice(0, s)) + (Number(frac[s]) >= 5 ? 1n : 0n);
  const t = digits.toString().padStart(s + 1, '0');
  return Number(`${str.startsWith('-') ? '-' : ''}${t.slice(0, t.length - s)}.${t.slice(t.length - s)}`);
}
// What re-filing reads of a row (cardStatementService.js REFILE_COLUMNS).
const REFILE_OUT = ['id', 'status', 'merchant_number', 'period_end', 'extracted', 'amount_submitted', 'total_fees',
  'amount_processed', 'transaction_count', 'effective_rate', 'debit_share', 'findings_count', 'rebelipay_cost',
  'rebelipay_savings', 'rebelipay_savings_annual', 'rebelipay_eligible', 'analysis_version'];

function insertStatement(fields) {
  const now = new Date();
  const row = {
    id: db.nextId++, client_id: null, location_id: null, status: 'analysing', parse_error: null, processor: null,
    merchant_number: null, merchant_name: null, period_start: null, period_end: null, layout_version: null,
    amount_submitted: null, total_fees: null, amount_processed: null, transaction_count: null, effective_rate: null,
    debit_share: null, findings_count: null, rebelipay_cost: null, rebelipay_savings: null, rebelipay_savings_annual: null,
    rebelipay_eligible: null, extracted: null, analysis: null, reconciliation: null, parse_model: null,
    parse_confidence: null, parse_ms: null, analysis_version: null, file_name: null, file_mime: null, file_size: null,
    file_path: null, content_sha256: null, duplicate_of: null, uploaded_by: null, created_at: now, updated_at: now,
    ...fields,
  };
  db.statements.push(row);
  return row;
}

function cascadeDelete(ids) {
  let doomed = new Set(ids.map(String));
  // duplicate_of ... ON DELETE CASCADE, to any depth
  for (;;) {
    const more = db.statements.filter((r) => r.duplicate_of != null && doomed.has(String(r.duplicate_of)) && !doomed.has(String(r.id)));
    if (!more.length) break;
    doomed = new Set([...doomed, ...more.map((r) => String(r.id))]);
  }
  db.statements = db.statements.filter((r) => !doomed.has(String(r.id)));
  db.events = db.events.filter((e) => !doomed.has(String(e.statement_id)));
}

function likeToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) { re += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i += 1; } else if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'is');
}

// Split a WHERE clause on its top-level ANDs: an AND inside parentheses (a
// search word's period test) belongs to its group.
function topLevelAnds(where) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < where.length; i += 1) {
    if (where[i] === '(') depth += 1;
    else if (where[i] === ')') depth -= 1;
    else if (depth === 0 && where.startsWith(' AND ', i)) { parts.push(where.slice(start, i)); start = i + 5; i += 4; }
  }
  parts.push(where.slice(start));
  return parts.map((s) => s.trim());
}

// A search word's period alternative (cardStatementSearch.js). Dates are kept
// as YYYY-MM-DD strings here, so they compare as Postgres dates do; a row with
// no period never matches, as NULL never satisfies a comparison.
function periodTest(s, params) {
  const p = (i) => params[Number(i) - 1];
  let m;
  if ((m = /^\(period_start <= \$(\d+)::date AND period_end >= \$(\d+)::date\)$/.exec(s))) {
    return (r) => r.period_start != null && r.period_end != null && r.period_start <= p(m[1]) && r.period_end >= p(m[2]);
  }
  if ((m = /^\(EXTRACT\(MONTH FROM period_start\) = \$(\d+) OR EXTRACT\(MONTH FROM period_end\) = \$\1\)$/.exec(s))) {
    return (r) => r.period_start != null && [r.period_start, r.period_end].some((d) => Number(d.slice(5, 7)) === p(m[1]));
  }
  if ((m = /^\(EXTRACT\(YEAR FROM period_start\) = \$(\d+) OR EXTRACT\(YEAR FROM period_end\) = \$\1\)$/.exec(s))) {
    return (r) => r.period_start != null && [r.period_start, r.period_end].some((d) => Number(d.slice(0, 4)) === p(m[1]));
  }
  throw new Error(`fake pool: unrecognised period test: ${s}`);
}

// The list's WHERE is built from whitelisted fragments; apply the same ones,
// and refuse any fragment the fake does not know.
function listFilter(sql, params) {
  const where = /WHERE ([\s\S]*?)(?: ORDER BY|$)/.exec(sql)[1];
  const p = (i) => params[Number(i) - 1];
  const tests = topLevelAnds(where).map((c) => {
    let m;
    if ((m = /^client_id = \$(\d+)$/.exec(c))) return (r) => r.client_id === p(m[1]);
    if (c === "status <> 'duplicate'") return (r) => r.status !== 'duplicate';
    if ((m = /^status = \$(\d+)$/.exec(c))) return (r) => r.status === p(m[1]);
    if ((m = /^merchant_number = \$(\d+)$/.exec(c))) return (r) => r.merchant_number === p(m[1]);
    if ((m = /^\(merchant_name ILIKE \$(\d+) OR merchant_number ILIKE \$\1 OR file_name ILIKE \$\1(?: OR (.+))?\)$/.exec(c))) {
      const re = likeToRegex(p(m[1]));
      const text = (r) => [r.merchant_name, r.merchant_number, r.file_name].some((v) => v != null && re.test(v));
      if (!m[2]) return text;
      const period = periodTest(m[2], params);
      return (r) => text(r) || period(r);
    }
    throw new Error(`fake pool: unrecognised list condition: ${c}`);
  });
  return db.statements.filter((r) => tests.every((t) => t(r)));
}

function sortList(sql, rows) {
  const order = /ORDER BY ([\s\S]*?) LIMIT /.exec(sql)[1];
  const desc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);
  const asc = (a, b) => desc(b, a);
  const nullsFirst = (x, y) => (x == null && y != null ? -1 : y == null && x != null ? 1 : 0);
  const name = (r) => (r.merchant_name == null ? null : r.merchant_name.toLowerCase());
  const nameAscNullsLast = (a, b) => -nullsFirst(name(a), name(b)) || (name(a) == null ? 0 : asc(name(a), name(b)));
  const shown = (r) => (r.status === 'analysed' && r.rebelipay_eligible && r.rebelipay_savings > 0 ? r.rebelipay_savings : null);
  let m;
  if (order === 'created_at DESC, id DESC') return rows.sort((a, b) => desc(a.created_at, b.created_at) || desc(a.id, b.id));
  if (/^CASE /.test(order)) {
    const up = /END ASC/.test(order);
    return rows.sort((a, b) => {
      const x = shown(a);
      const y = shown(b);
      if (x == null && y == null) return desc(a.id, b.id);
      if (x == null) return 1;
      if (y == null) return -1;
      return up ? x - y : y - x;
    });
  }
  if ((m = /^\(merchant_name IS NULL\) DESC, lower\(merchant_name\) (ASC|DESC), merchant_number (ASC|DESC), period_end DESC NULLS FIRST, created_at DESC, id DESC$/.exec(order))) {
    const dir = m[1] === 'ASC' ? asc : desc;
    return rows.sort((a, b) => nullsFirst(a.merchant_name, b.merchant_name)
      || (a.merchant_name == null ? 0 : dir(name(a), name(b)))
      || dir(a.merchant_number || '', b.merchant_number || '')
      || nullsFirst(a.period_end, b.period_end) || desc(a.period_end, b.period_end)
      || desc(a.created_at, b.created_at) || desc(a.id, b.id));
  }
  if ((m = /^period_end (ASC|DESC) NULLS FIRST, lower\(merchant_name\) ASC NULLS LAST, created_at DESC, id DESC$/.exec(order))) {
    const dir = m[1] === 'ASC' ? asc : desc;
    return rows.sort((a, b) => nullsFirst(a.period_end, b.period_end)
      || (a.period_end == null ? 0 : dir(a.period_end, b.period_end))
      || nameAscNullsLast(a, b) || desc(a.created_at, b.created_at) || desc(a.id, b.id));
  }
  throw new Error(`fake pool: unrecognised ORDER BY: ${order}`);
}

const staleBefore = (minutes) => new Date(Date.now() - minutes * 60000);

// Each entry: the statement's signature, and what Postgres would do with it.
const HANDLERS = [
  [/^INSERT INTO card_statement_events \(statement_id, client_id, location_id, event, actor, payload\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6::jsonb\)$/, ([statementId, clientId, locationId, event, actor, payload]) => {
    if (!db.statements.some((r) => sameId(r.id, statementId))) {
      const e = new Error('insert or update on table "card_statement_events" violates foreign key constraint'); e.code = '23503'; throw e;
    }
    db.events.push({ id: db.nextEventId++, statement_id: statementId, client_id: clientId, location_id: locationId,
      event, actor, payload: jsonb(payload), created_at: new Date(Date.now() + db.nextEventId) });
    return res([], 1);
  }],
  [/^SELECT id, event, actor, payload, created_at FROM card_statement_events WHERE statement_id = \$1 AND client_id = \$2 ORDER BY created_at, id LIMIT \$3$/, ([sid, clientId, limit]) => res(db.events
    .filter((e) => sameId(e.statement_id, sid) && e.client_id === clientId)
    .sort((a, b) => a.created_at - b.created_at || a.id - b.id).slice(0, limit)
    .map((e) => ({ id: String(e.id), event: e.event, actor: e.actor, payload: e.payload, created_at: e.created_at })))],
  [/^INSERT INTO card_statements \(client_id, location_id, status, file_name, file_mime, file_size, file_path, content_sha256, uploaded_by\) VALUES \(\$1, \$2, 'analysing', \$3, \$4, \$5, \$6, \$7, \$8\) RETURNING id$/, ([clientId, locationId, name, mime, size, filePath, sha, uploadedBy]) => {
    const row = insertStatement({ client_id: clientId, location_id: locationId, file_name: name, file_mime: mime,
      file_size: size, file_path: filePath, content_sha256: sha, uploaded_by: uploadedBy });
    return res([{ id: String(row.id) }]);
  }],
  [/FROM card_statements WHERE client_id = \$1 AND content_sha256 = \$2 AND id < \$3 AND status <> 'duplicate' ORDER BY id LIMIT 1$/, ([clientId, sha, id]) => res(db.statements
    .filter((r) => r.client_id === clientId && r.content_sha256 === sha && r.id < Number(id) && r.status !== 'duplicate')
    .sort((a, b) => a.id - b.id).slice(0, 1)
    .map((r) => ({ ...out(r, ['id', 'status', 'merchant_name', 'merchant_number', 'period_end', 'file_name']), uploaded_on: ymdOf(r.created_at) })))],
  // The hash lookup: a tombstone (d) resolves to the original it points at
  // (o), visible rows first.
  [/FROM card_statements d JOIN card_statements o ON o\.id = COALESCE\(d\.duplicate_of, d\.id\) AND o\.client_id = d\.client_id WHERE d\.client_id = \$1 AND d\.content_sha256 = \$2 AND o\.status <> 'duplicate' ORDER BY \(d\.status = 'duplicate'\), d\.id LIMIT 1$/, ([clientId, sha]) => res(db.statements
    .filter((d) => d.client_id === clientId && d.content_sha256 === sha)
    .map((d) => ({ d, o: db.statements.find((o) => sameId(o.id, d.duplicate_of != null ? d.duplicate_of : d.id) && o.client_id === d.client_id) }))
    .filter(({ o }) => o && o.status !== 'duplicate')
    .sort((a, b) => (a.d.status === 'duplicate') - (b.d.status === 'duplicate') || a.d.id - b.d.id).slice(0, 1)
    .map(({ o }) => ({ ...out(o, ['id', 'status', 'merchant_name', 'merchant_number', 'period_end', 'file_name']), uploaded_on: ymdOf(o.created_at) })))],
  [/^DELETE FROM card_statements WHERE id = \$1 AND client_id = \$2$/, ([id, clientId]) => {
    const row = byId(id, clientId);
    if (row) cascadeDelete([row.id]);
    return res([], row ? 1 : 0);
  }],
  [/^WITH tombstones AS \( SELECT file_path FROM card_statements WHERE client_id = \$2 AND duplicate_of = \$1 AND file_path IS NOT NULL \) DELETE FROM card_statements WHERE id = \$1 AND client_id = \$2 RETURNING /, ([id, clientId]) => {
    const row = byId(id, clientId);
    if (!row) return res([]);
    const tombstoneFiles = db.statements.filter((r) => r.client_id === clientId && sameId(r.duplicate_of, id) && r.file_path).map((r) => r.file_path);
    cascadeDelete([row.id]);
    return res([{ id: String(row.id), status: row.status, file_path: row.file_path,
      ...out(row, ['merchant_number', 'period_end']), tombstone_files: tombstoneFiles }]);
  }],
  // The list kept in step (D44): a store's statements dated after a change,
  // this client's rows an older engine filed, and the figures re-filed on one
  // of them. Re-filing leaves updated_at alone.
  [/^SELECT id, status, merchant_number, period_end, extracted, amount_submitted, total_fees, amount_processed, transaction_count, effective_rate, debit_share, findings_count, rebelipay_cost, rebelipay_savings, rebelipay_savings_annual, rebelipay_eligible, analysis_version FROM card_statements WHERE client_id = \$1 AND merchant_number = \$2 AND status = 'analysed' AND period_end (>|>=) \$3::date ORDER BY period_end$/, ([clientId, merchant, periodEnd], sql) => {
    const andItself = / period_end >= \$3::date /.test(sql);
    return res(db.statements
      .filter((r) => r.client_id === clientId && r.merchant_number === merchant && r.status === 'analysed'
        && (andItself ? r.period_end >= periodEnd : r.period_end > periodEnd))
      .sort((a, b) => (a.period_end < b.period_end ? -1 : 1))
      .map((r) => out(r, REFILE_OUT)));
  }],
  [/^SELECT id, status, merchant_number, period_end, extracted, amount_submitted, total_fees, amount_processed, transaction_count, effective_rate, debit_share, findings_count, rebelipay_cost, rebelipay_savings, rebelipay_savings_annual, rebelipay_eligible, analysis_version FROM card_statements WHERE client_id = \$1 AND status = 'analysed' AND extracted IS NOT NULL AND \(analysis_version IS NULL OR analysis_version < \$2\) ORDER BY period_end$/, ([clientId, version]) => res(db.statements
    .filter((r) => r.client_id === clientId && r.status === 'analysed' && r.extracted != null && (r.analysis_version == null || r.analysis_version < version))
    .sort((a, b) => (a.period_end < b.period_end ? -1 : 1))
    .map((r) => out(r, REFILE_OUT)))],
  [/^UPDATE card_statements SET amount_submitted = \$3, total_fees = \$4, amount_processed = \$5, transaction_count = \$6, effective_rate = \$7, debit_share = \$8, findings_count = \$9, rebelipay_cost = \$10, rebelipay_savings = \$11, rebelipay_savings_annual = \$12, rebelipay_eligible = \$13, analysis = \$14::jsonb, analysis_version = \$15 WHERE id = \$1 AND client_id = \$2 AND status = 'analysed'$/, (p) => {
    const row = db.statements.find((r) => sameId(r.id, p[0]) && r.client_id === p[1] && r.status === 'analysed');
    if (!row) return res([], 0);
    Object.assign(row, {
      amount_submitted: atScale(p[2], 2), total_fees: atScale(p[3], 2), amount_processed: atScale(p[4], 2), transaction_count: p[5],
      effective_rate: atScale(p[6], 4), debit_share: atScale(p[7], 4), findings_count: p[8], rebelipay_cost: atScale(p[9], 2),
      rebelipay_savings: atScale(p[10], 2), rebelipay_savings_annual: atScale(p[11], 2),
      rebelipay_eligible: p[12], analysis: jsonb(p[13]), analysis_version: p[14],
    });
    return res([], 1);
  }],
  [/^SELECT period_start, period_end, layout_version, amount_submitted, total_fees, amount_processed, effective_rate, debit_share, analysis->'kpis'->>'avgTicket' AS avg_ticket FROM card_statements WHERE client_id = \$1 AND merchant_number = \$2 AND status = 'analysed' AND id <> \$3 AND period_end < \$4::date ORDER BY period_end$/, ([clientId, merchant, excludeId, periodEnd]) => res(db.statements
    .filter((r) => r.client_id === clientId && r.merchant_number === merchant && r.status === 'analysed'
      && !sameId(r.id, excludeId) && r.period_end < periodEnd)
    .sort((a, b) => (a.period_end < b.period_end ? -1 : 1))
    .map((r) => {
      // ->> hands back text, as Postgres does.
      const t = r.analysis && r.analysis.kpis ? r.analysis.kpis.avgTicket : null;
      return { ...out(r, ['period_start', 'period_end', 'layout_version', 'amount_submitted', 'total_fees', 'amount_processed', 'effective_rate', 'debit_share']),
        avg_ticket: t === null || t === undefined ? null : String(t) };
    }))],
  [/^UPDATE card_statements SET status = 'analysed', .* WHERE id = \$1 AND client_id = \$2 AND status = ANY\(\$27::text\[\]\)$/, (p) => {
    const [id, clientId] = p;
    const row = db.statements.find((r) => sameId(r.id, id) && r.client_id === clientId && p[26].includes(r.status));
    if (!row) return res([], 0);
    const merchant = p[3];
    const periodEnd = dateOnly(p[6]);
    if (db.statements.some((r) => r !== row && r.client_id === clientId && r.merchant_number === merchant
      && r.period_end === periodEnd && r.status === 'analysed')) {
      const e = new Error('duplicate key value violates unique constraint "card_statements_identity_uniq"');
      e.code = '23505'; e.constraint = 'card_statements_identity_uniq';
      throw e;
    }
    Object.assign(row, {
      status: 'analysed', parse_error: null, duplicate_of: null, processor: p[2], merchant_number: merchant, merchant_name: p[4],
      period_start: dateOnly(p[5]), period_end: periodEnd, layout_version: p[7], amount_submitted: atScale(p[8], 2),
      total_fees: atScale(p[9], 2), amount_processed: atScale(p[10], 2), transaction_count: p[11], effective_rate: atScale(p[12], 4),
      debit_share: atScale(p[13], 4), findings_count: p[14], rebelipay_cost: atScale(p[15], 2), rebelipay_savings: atScale(p[16], 2),
      rebelipay_savings_annual: atScale(p[17], 2), rebelipay_eligible: p[18],
      extracted: jsonb(p[19]), analysis: jsonb(p[20]), reconciliation: jsonb(p[21]), parse_model: p[22],
      parse_confidence: atScale(p[23], 4), parse_ms: p[24], analysis_version: p[25], updated_at: new Date(),
    });
    return res([], 1);
  }],
  [/^UPDATE card_statements SET status = 'failed', parse_error = \$3, extracted = COALESCE\(\$4::jsonb, extracted\), .* WHERE id = \$1 AND client_id = \$2 AND status = ANY\(\$7::text\[\]\)$/, ([id, clientId, message, extracted, model, ms, expect]) => {
    const row = db.statements.find((r) => sameId(r.id, id) && r.client_id === clientId && expect.includes(r.status));
    if (!row) return res([], 0);
    Object.assign(row, { status: 'failed', parse_error: message, extracted: extracted != null ? jsonb(extracted) : row.extracted,
      parse_model: model != null ? model : row.parse_model, parse_ms: ms != null ? ms : row.parse_ms, updated_at: new Date() });
    return res([], 1);
  }],
  [/^SELECT id, location_id FROM card_statements WHERE client_id = \$1 AND merchant_number = \$2 AND period_end = \$3::date AND status = 'analysed' AND id <> \$4 ORDER BY id LIMIT 1$/, ([clientId, merchant, periodEnd, id]) => res(db.statements
    .filter((r) => r.client_id === clientId && r.merchant_number === merchant && r.period_end === periodEnd
      && r.status === 'analysed' && !sameId(r.id, id))
    .sort((a, b) => a.id - b.id).slice(0, 1).map((r) => out(r, ['id', 'location_id'])))],
  [/^WITH before AS \( SELECT file_path FROM card_statements WHERE id = \$1 AND client_id = \$2 \) UPDATE card_statements SET status = 'duplicate', duplicate_of = \$3, .* WHERE id = \$1 AND client_id = \$2 AND status = ANY\(\$8::text\[\]\) RETURNING /, ([id, clientId, originalId, merchant, name, start, end, expect]) => {
    const row = db.statements.find((r) => sameId(r.id, id) && r.client_id === clientId && expect.includes(r.status));
    if (!row) return res([]);
    const old = row.file_path;
    Object.assign(row, { status: 'duplicate', duplicate_of: Number(originalId), parse_error: null, merchant_number: merchant,
      merchant_name: name, period_start: dateOnly(start), period_end: dateOnly(end), extracted: null, analysis: null,
      reconciliation: null, file_path: null, updated_at: new Date() });
    return res([{ file_name: row.file_name, old_file_path: old }]);
  }],
  [/^SELECT file_path, file_mime, file_name, location_id FROM card_statements WHERE id = \$1 AND client_id = \$2$/, ([id, clientId]) => {
    const row = byId(id, clientId);
    return res(row ? [out(row, ['file_path', 'file_mime', 'file_name', 'location_id'])] : []);
  }],
  [/^UPDATE card_statements SET status = 'failed', parse_error = \$3, updated_at = now\(\) WHERE client_id = \$1 AND status = 'analysing' AND updated_at < now\(\) - make_interval\(mins => \$2::int\) RETURNING id, client_id, location_id$/,
    ([clientId, minutes, message]) => {
      const moved = db.statements.filter((r) => r.client_id === clientId && r.status === 'analysing' && r.updated_at < staleBefore(minutes));
      for (const r of moved) Object.assign(r, { status: 'failed', parse_error: message, updated_at: new Date() });
      return res(moved.map((r) => ({ id: String(r.id), client_id: r.client_id, location_id: r.location_id })));
    }],
  [/^UPDATE card_statements SET status = 'failed', parse_error = \$2, updated_at = now\(\) WHERE status = 'analysing' AND updated_at < now\(\) - make_interval\(mins => \$1::int\) RETURNING id, client_id, location_id$/, ([minutes, message]) => {
    const moved = db.statements.filter((r) => r.status === 'analysing' && r.updated_at < staleBefore(minutes));
    for (const r of moved) Object.assign(r, { status: 'failed', parse_error: message, updated_at: new Date() });
    return res(moved.map((r) => ({ id: String(r.id), client_id: r.client_id, location_id: r.location_id })));
  }],
  [/^SELECT count\(\*\)::int AS total FROM card_statements WHERE client_id = \$1 AND status <> 'duplicate'( AND [^;]*)?$/, (p, sql) => res([{ total: listFilter(sql, p).length }])],
  [/array_agg\(merchant_name .* FROM card_statements WHERE client_id = \$1 AND status <> 'duplicate' AND merchant_number IS NOT NULL GROUP BY merchant_number /, ([clientId]) => {
    const groups = new Map();
    for (const r of db.statements.filter((x) => x.client_id === clientId && x.status !== 'duplicate' && x.merchant_number != null)) {
      if (!groups.has(r.merchant_number)) groups.set(r.merchant_number, []);
      groups.get(r.merchant_number).push(r);
    }
    return res([...groups.entries()].map(([merchant, rows]) => {
      const named = rows.filter((r) => r.merchant_name != null)
        .sort((a, b) => (a.period_end === b.period_end ? b.id - a.id : (a.period_end || '') < (b.period_end || '') ? 1 : -1));
      return { merchant_number: merchant, merchant_name: named.length ? named[0].merchant_name : null, count: rows.length };
    }).sort((a, b) => String(a.merchant_name).localeCompare(String(b.merchant_name))));
  }],
  [/^SELECT id, status, parse_error, processor, merchant_number, .* FROM card_statements WHERE client_id = \$1 AND status <> 'duplicate'.* ORDER BY .* LIMIT \$\d+ OFFSET \$\d+$/, (p, sql) => {
    const limit = p[p.length - 2];
    const offset = p[p.length - 1];
    return res(sortList(sql, listFilter(sql, p)).slice(offset, offset + limit).map((r) => {
      const o = out(r);
      delete o.extracted; delete o.analysis; delete o.reconciliation;
      o.reconciliation_ok = r.reconciliation ? r.reconciliation.ok === true : null;
      return o;
    }));
  }],
  [/^SELECT period_end, rebelipay_savings FROM card_statements WHERE client_id = \$1 AND merchant_number = \$2 AND status = 'analysed' ORDER BY period_end$/, ([clientId, merchant]) => res(db.statements
    .filter((r) => r.client_id === clientId && r.merchant_number === merchant && r.status === 'analysed')
    .sort((a, b) => (a.period_end < b.period_end ? -1 : 1)).map((r) => out(r, ['period_end', 'rebelipay_savings'])))],
  [/^SELECT \* FROM card_statements WHERE id = \$1 AND client_id = \$2$/, ([id, clientId]) => {
    const row = byId(id, clientId);
    return res(row ? [out(row)] : []);
  }],
  [/^SELECT id FROM card_statements WHERE id = \$1 AND client_id = \$2$/, ([id, clientId]) => {
    const row = byId(id, clientId);
    return res(row ? [{ id: String(row.id) }] : []);
  }],
  [/^SELECT file_path, file_name, file_mime FROM card_statements WHERE id = \$1 AND client_id = \$2$/, ([id, clientId]) => {
    const row = byId(id, clientId);
    return res(row ? [out(row, ['file_path', 'file_name', 'file_mime'])] : []);
  }],
  [/^SELECT id, location_id, status, extracted, file_path, parse_model, parse_ms, merchant_number, period_end FROM card_statements WHERE id = \$1 AND client_id = \$2$/, ([id, clientId]) => {
    const row = byId(id, clientId);
    return res(row ? [out(row, ['id', 'location_id', 'status', 'extracted', 'file_path', 'parse_model', 'parse_ms',
      'merchant_number', 'period_end'])] : []);
  }],
  [/^UPDATE card_statements SET status = 'analysing', parse_error = NULL, updated_at = now\(\) WHERE id = \$1 AND client_id = \$2 AND status = \$3$/, ([id, clientId, status]) => {
    const row = db.statements.find((r) => sameId(r.id, id) && r.client_id === clientId && r.status === status);
    if (row) Object.assign(row, { status: 'analysing', parse_error: null, updated_at: new Date() });
    return res([], row ? 1 : 0);
  }],
  [/^SELECT id, location_id, status, merchant_number, merchant_name, period_start, period_end, rebelipay_eligible, analysis FROM card_statements WHERE id = \$1 AND client_id = \$2$/, ([id, clientId]) => {
    const row = byId(id, clientId);
    return res(row ? [out(row, ['id', 'location_id', 'status', 'merchant_number', 'merchant_name', 'period_start',
      'period_end', 'rebelipay_eligible', 'analysis'])] : []);
  }],
];

const unknownSql = [];
// A test can hold the next statement that matches a pattern until it lets it
// go, to put two flows in a chosen order (the per-store re-file queue, D44).
let holdSql = null;
const pool = {
  async query(sql, params = []) {
    await Promise.resolve();
    recorded.push({ sql, params });
    if (missingTables) {
      const e = new Error('relation "card_statements" does not exist'); e.code = '42P01'; throw e;
    }
    // Signatures are matched on whitespace-normalised SQL and spell out
    // every predicate the fake implements, so a statement that loses one is
    // unrecognised (and fails) instead of being answered as if it had it.
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (holdSql && holdSql.re.test(norm)) { const held = holdSql; holdSql = null; await held.until; }
    const hit = HANDLERS.find(([re]) => re.test(norm));
    if (!hit) {
      unknownSql.push(sql);
      throw new Error(`fake pool: unrecognised SQL: ${sql.slice(0, 80)}`);
    }
    return hit[1](params, norm);
  },
};

/* ── Stubs: the pool, the reader, fetch ───────────────────────────────────── */

const connPath = require.resolve(path.join(__dirname, '..', 'database', 'analytics-connection'));
require.cache[connPath] = {
  id: connPath, filename: connPath, loaded: true,
  exports: { getAnalyticsPool: () => pool, testAnalyticsConnection: async () => true },
};

const extractMod = require('../services/cardStatementExtract');
const realParseCsv = extractMod.parseCsv;
const extractCalls = [];
const holds = new Map();
// A tiny-ticket statement on which Rebelipay would cost more.
const COSTLY = {
  processor: 'Test Payments', layout_version: 'v2_2026',
  merchant: { number: '400000000006', name: 'TINY TICKETS' }, period: { start: '2026-07-01', end: '2026-07-31' },
  summary: { amount_submitted: 1000, paid_by_others: 0, disputes: 0, adjustments: 0, fees: 20, amount_processed: 980 },
  customers: null, sales_trend: [], printed_yoy_pct: null, printed_mom_pct: null,
  daily: [{ date: '2026-07-01', submitted: 1000, disputes: 0, adjustments: 0, fees: 20, processed: 980, is_prior_period: false }],
  month_end_charges: 0,
  card_types: [{ type: 'VISA', label: 'VISA', avg_ticket: 1, items: 1000, gross: 1000, refund_items: 0, refunds: 0, net_items: 1000, net: 1000 }],
  fee_lines: [{ category: 'transaction', product: 'Visa', network: 'VISA', description: 'VISA SALES DISCOUNT 0.02 DISC RATE TIMES $1000.00',
    is_debit: false, rate: 0.02, base_amount: 1000, count: null, unit_price: null, fee_type: 'Service Charges', amount: 20 }],
  chargebacks: [], funding: [], reportable_sales: null, notices: [],
};

// Two Julys a year apart for one store, neither printing a trend: the later
// one's trend, so its count of flagged findings, depends on the earlier one
// being on file (D44). Sales halve, so with both on file the trend is flagged.
const TREND_STORE = '400000000008';
function trendFixture(year) {
  const x = JSON.parse(JSON.stringify(COSTLY));
  const amount = year === '2025' ? 2000 : 1000;
  x.merchant = { number: TREND_STORE, name: 'TREND TEST' };
  x.period = { start: `${year}-07-01`, end: `${year}-07-31` };
  x.summary = { ...x.summary, amount_submitted: amount, fees: amount * 0.02, amount_processed: amount * 0.98 };
  x.daily = [{ ...x.daily[0], date: `${year}-07-01`, submitted: amount, fees: amount * 0.02, processed: amount * 0.98 }];
  x.card_types = [{ ...x.card_types[0], items: amount, gross: amount, net_items: amount, net: amount }];
  x.fee_lines = [{ ...x.fee_lines[0], description: `VISA SALES DISCOUNT 0.02 DISC RATE TIMES $${amount.toFixed(2)}`,
    base_amount: amount, amount: amount * 0.02 }];
  return x;
}

extractMod.extract = async ({ buffer, kind, fileName }) => {
  const text = buffer.toString('latin1');
  extractCalls.push({ kind, fileName, text: text.slice(0, 80) });
  if (kind === 'csv') return realParseCsv({ buffer, fileName });
  const hold = /hold=(\w+)/.exec(text);
  if (hold) await new Promise((resolve) => holds.set(hold[1], resolve));
  if (/fail=raw/.test(text)) throw new Error('upstream 529 overloaded_error from the provider, request id req_secret');
  if (/fail=owner/.test(text)) {
    const e = new Error('raw'); e.code = 'EXTRACTION_TRUNCATED'; e.publicMessage = 'This statement was too long to read in one go.'; throw e;
  }
  if (/fixture=costly/.test(text)) return { extracted: JSON.parse(JSON.stringify(COSTLY)), model: 'stub-model', ms: 7 };
  const trend = /fixture=trend-(\d{4})/.exec(text);
  if (trend) return { extracted: trendFixture(trend[1]), model: 'stub-model', ms: 7 };
  const name = /fixture=(\d+_\d+)/.exec(text)[1];
  const extracted = load(name);
  if (/noheader/.test(text)) extracted.merchant.number = null;
  return { extracted, model: 'stub-model', ms: 12 };
};
const releaseHold = async (key) => {
  for (let i = 0; i < 200 && !holds.has(key); i += 1) await sleep(5);
  holds.get(key)();
  holds.delete(key); // so the same file can be held again on a re-read
};

const realFetch = globalThis.fetch;
const webhookCalls = [];
let webhookMode = 'ok';
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(process.env.REBELIPAY_LEAD_WEBHOOK)) {
    webhookCalls.push({ url: u, opts });
    if (webhookMode === 'down') throw new Error('getaddrinfo ENOTFOUND leads.example.test');
    return { ok: true, status: 200 };
  }
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(u)) return realFetch(url, opts);
  throw new Error(`network refused in tests: ${u}`);
};

const express = require('express');
const svc = require('../services/cardStatementService');
const router = require('../routes/card-statements');

/* ── HTTP helpers ─────────────────────────────────────────────────────────── */

const payloads = []; // every response body, for the component scan
let base = '';
async function call(user, method, p, body) {
  const headers = { 'x-test-user': JSON.stringify(user) };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await realFetch(`${base}/api/card-statements${p}`, { method, headers, body: payload });
  const raw = Buffer.from(await r.arrayBuffer());
  const text = raw.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  payloads.push({ where: `${method} ${p}`, json, text, type: r.headers.get('content-type') || '' });
  return { status: r.status, json, text, raw, headers: r.headers };
}
function upload(user, name, content, type = 'application/pdf') {
  const fd = new FormData();
  if (content !== null) fd.append('file', new Blob([content], { type }), name);
  return call(user, 'POST', '/upload', fd);
}
async function settle(user, id) {
  for (let i = 0; i < 400; i += 1) {
    const row = byId(id, user.client_id);
    if (!row || row.status !== 'analysing') break;
    await sleep(5);
  }
  await sleep(10); // fire-and-forget event writes
  return call(user, 'GET', `/${id}`);
}
const pdf = (tag) => `%PDF-1.4\n% ${tag}\n%%EOF\n`;
const isEnvelope = (r, status, code) => r.status === status && r.json && Object.keys(r.json).join() === 'error'
  && Object.keys(r.json.error).sort().join() === 'code,message' && r.json.error.code === code
  && typeof r.json.error.message === 'string' && r.json.error.message.length > 0
  && !/[\u2013\u2014]|anthropic|claude|sonnet|openai|api[_ ]key|ANTHROPIC|CS_/i.test(r.json.error.message);
const eventsOf = (id) => db.events.filter((e) => sameId(e.statement_id, id)).map((e) => e.event);
const sqlSince = (mark) => recorded.slice(mark);

const A = { client_id: 999960, location_id: 990060, username: 'owner-a' };
const B = { client_id: 999961, location_id: 990061, username: 'owner-b' };
const C = { client_id: 999962, location_id: 990062, username: 'owner-c' };
const D = { client_id: 999963, location_id: 990063, username: 'owner-d' };
const E = { client_id: 999964, location_id: 990064, username: 'owner-e' };

/* ── The run ──────────────────────────────────────────────────────────────── */

(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = JSON.parse(req.headers['x-test-user']); next(); });
  app.use('/api/card-statements', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  try {
    console.log('\nWIRING');
    check('the service stores under CS_UPLOAD_DIR', svc.UPLOAD_DIR === path.resolve(UPLOAD_ROOT), svc.UPLOAD_DIR);
    let r = await call(A, 'GET', '/');
    check('an empty list: { data: [], total: 0, stores: [] }', r.status === 200 && Array.isArray(r.json.data)
      && r.json.data.length === 0 && r.json.total === 0 && Array.isArray(r.json.stores), r.text);

    /* ── Upload validation ── */
    console.log('\nUPLOAD VALIDATION');
    let mark = recorded.length;
    r = await upload(A, 'nothing', null);
    check('no file -> 400 NO_FILE', isEnvelope(r, 400, 'NO_FILE'), r.text);
    r = await upload(A, 'notes.txt', 'just some words and no table here', 'text/plain');
    check('a text file that is not a CSV -> 400 UNSUPPORTED_TYPE', isEnvelope(r, 400, 'UNSUPPORTED_TYPE'), r.text);
    r = await upload(A, 'photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), 'image/png');
    check('an image -> 400 UNSUPPORTED_TYPE', isEnvelope(r, 400, 'UNSUPPORTED_TYPE'), r.text);
    r = await upload(A, 'empty.pdf', '');
    check('an empty file -> 400 EMPTY_FILE', isEnvelope(r, 400, 'EMPTY_FILE'), r.text);
    r = await upload(A, 'huge.pdf', Buffer.alloc(20 * 1024 * 1024 + 1, 0x25));
    check('20 MB + 1 byte -> 413 FILE_TOO_LARGE', isEnvelope(r, 413, 'FILE_TOO_LARGE'), r.text);
    check('a rejected upload touches neither the database nor the disk', sqlSince(mark).length === 0
      && !fs.existsSync(path.join(UPLOAD_ROOT, String(A.client_id))));

    /* ── Upload and analyse ── */
    console.log('\nUPLOAD - stored, answered 202, analysed in the background');
    r = await upload(A, 'Statement May.pdf', pdf(`fixture=${WR}_202605`));
    check('a PDF -> 202 { id, status: analysing }', r.status === 202 && typeof r.json.id === 'string'
      && r.json.status === 'analysing' && Object.keys(r.json).sort().join() === 'id,status', r.text);
    const mayId = r.json.id;
    let d = (await settle(A, mayId)).json;
    check('May analysed', d && d.status === 'analysed', d && `${d.status} ${d.parseError}`);
    const stored = fs.readdirSync(path.join(UPLOAD_ROOT, String(A.client_id)));
    check('the original is stored as <timestamp>-<hex>.pdf under the client folder',
      stored.length === 1 && /^\d+-[0-9a-f]{12}\.pdf$/.test(stored[0]), stored.join(','));
    check('detail: ids as strings, dates as YYYY-MM-DD, numerics as numbers',
      d.id === mayId && d.periodStart === '2026-05-01' && d.periodEnd === '2026-05-31' && d.amountSubmitted === 187377.59
        && d.totalFees === 5651.28 && typeof d.effectiveRate === 'number' && d.transactionCount === 7200, JSON.stringify(d).slice(0, 300));
    check('detail: analysis with six findings, reconciliation 8/8, CTA url, parse model',
      d.analysis && d.analysis.findings.length === 6 && d.reconciliation.passed === 8 && d.reconciliation.total === 8
        && d.reconciliationOk === true
        && d.rebelipayCtaUrl === process.env.REBELIPAY_CTA_URL && d.parseModel === 'stub-model'
        && d.analysisVersion === require('../services/cardStatementAnalysis').ANALYSIS_VERSION);
    check('detail: the list fields are all there', ['id', 'status', 'fileName', 'fileMime', 'fileSize', 'uploadedBy', 'createdAt',
      'updatedAt', 'processor', 'merchantNumber', 'merchantName', 'periodStart', 'periodEnd', 'layoutVersion', 'amountSubmitted',
      'totalFees', 'amountProcessed', 'transactionCount', 'effectiveRate', 'debitShare', 'findingsCount', 'rebelipayEligible',
      'rebelipaySavings', 'rebelipaySavingsAnnual', 'parseError', 'parseConfidence', 'reconciliationOk', 'duplicateOf']
      .every((k) => k in d));
    check('detail: savingsToDate null with one statement', d.savingsToDate === null, JSON.stringify(d.savingsToDate));
    check('detail: the extraction itself is never returned', !('extracted' in d));
    check('events: uploaded, then analysed', eventsOf(mayId).join() === 'uploaded,analysed', eventsOf(mayId).join());

    /* ── Hash duplicate ── */
    console.log('\nSAME FILE AGAIN - 200 duplicate, no new row');
    mark = recorded.length;
    r = await upload(A, 'Statement May (1).pdf', pdf(`fixture=${WR}_202605`));
    check('same bytes -> 200 { duplicate: true, id: original, reason: same_file, message }',
      r.status === 200 && r.json.duplicate === true && r.json.id === mayId && r.json.reason === 'same_file'
        && /WINE REPUBLIC/.test(r.json.message || ''), r.text);
    check('no row was inserted', !sqlSince(mark).some((q) => /INSERT INTO card_statements\b/.test(q.sql))
      && db.statements.filter((x) => x.client_id === A.client_id).length === 1);
    check('a duplicate event on the original', eventsOf(mayId).join() === 'uploaded,analysed,duplicate', eventsOf(mayId).join());
    check('no second file on disk', fs.readdirSync(path.join(UPLOAD_ROOT, String(A.client_id))).length === 1);
    r = await call(A, 'GET', '/');
    check('the list still shows one statement', r.json.total === 1 && r.json.data.length === 1);

    /* ── History, savings to date ── */
    console.log('\nHISTORY - June and July, savings to date');
    r = await upload(A, 'June.pdf', pdf(`fixture=${WR}_202606`));
    const junId = r.json.id;
    r = await upload(A, 'July.pdf', pdf(`fixture=${WR}_202607`));
    const julId = r.json.id;
    await settle(A, junId);
    d = (await settle(A, julId)).json;
    check('July analysed', d.status === 'analysed' && d.periodEnd === '2026-07-31');
    check('July: savings to date $450.73 across 3 statements, 2026-05 to 2026-07 (switching only, D49)',
      d.savingsToDate && d.savingsToDate.amount === 450.73 && d.savingsToDate.statements === 3
        && d.savingsToDate.from === '2026-05' && d.savingsToDate.to === '2026-07', JSON.stringify(d.savingsToDate));
    check('July: list columns show the switching saving ($183.25, $2,199.00 a year)',
      d.rebelipayEligible === true && d.rebelipaySavings === 183.25 && d.rebelipaySavingsAnnual === 2199);
    check('July: the page splits it: switch $183.25, PCI fix $29.95, total $213.20 ($2,558.40 a year)',
      d.analysis.rebelipay.savings === 183.25 && d.analysis.rebelipay.penaltyFix === 29.95
        && d.analysis.rebelipay.penaltyFixLabel === 'Fix the PCI penalty (free, about 20 minutes)'
        && d.analysis.rebelipay.totalFound === 213.2 && d.analysis.rebelipay.totalFoundAnnual === 2558.4,
      JSON.stringify(d.analysis.rebelipay).slice(0, 300));
    const jun = (await call(A, 'GET', `/${junId}`)).json;
    check('June (legacy): trend built from history at read time, May then June',
      jun.analysis.salesTrend && jun.analysis.salesTrend.source === 'history'
        && jun.analysis.salesTrend.points.map((p) => p.month).join() === '2026-05,2026-06', JSON.stringify(jun.analysis.salesTrend));
    const may = (await call(A, 'GET', `/${mayId}`)).json;
    check('May: later statements never leak into its trend', may.analysis.salesTrend === null);
    r = await call(A, 'GET', '/?sort=savings');
    check('sorted by savings: Jul, Jun, May', r.json.data.map((x) => x.id).join() === [julId, junId, mayId].join(),
      r.json.data.map((x) => `${x.id}:${x.rebelipaySavings}`).join());
    r = await call(A, 'GET', '/');
    check('default sort: by store, newest period first within it', r.json.data.map((x) => x.id).join() === [julId, junId, mayId].join());
    check('stores: one merchant, three statements', r.json.stores.length === 1 && r.json.stores[0].merchantNumber === WR
      && r.json.stores[0].count === 3 && r.json.stores[0].merchantName === 'WINE REPUBLIC', JSON.stringify(r.json.stores));
    r = await call(A, 'GET', '/?q=republic&limit=2&offset=1');
    check('search, paging: total 3, page of 2 from offset 1', r.json.total === 3 && r.json.data.length === 2
      && r.json.data[0].id === junId, JSON.stringify(r.json.data.map((x) => x.id)));
    r = await call(A, 'GET', '/?q=50%25_x');
    check('LIKE wildcards in the search are literal', r.json.total === 0);

    /* ── Identity duplicate ── */
    console.log('\nSAME STATEMENT RE-SCANNED - identity duplicate (23505)');
    const dirBefore = fs.readdirSync(path.join(UPLOAD_ROOT, String(A.client_id))).sort().join();
    r = await upload(A, 'July rescan.pdf', pdf(`fixture=${WR}_202607 rescan`));
    const dupId = r.json.id;
    check('different bytes -> 202, a new row while it is read', r.status === 202 && dupId !== julId);
    d = (await settle(A, dupId)).json;
    check('the re-scan becomes a duplicate tombstone pointing at July',
      d.status === 'duplicate' && d.duplicateOf === julId && d.analysis === null && d.rebelipaySavings === null, JSON.stringify(d).slice(0, 200));
    check('the tombstone lost its stored file',
      fs.readdirSync(path.join(UPLOAD_ROOT, String(A.client_id))).sort().join() === dirBefore
      && byId(dupId, A.client_id).file_path === null);
    check('a duplicate event on the tombstone', eventsOf(dupId).join() === 'uploaded,duplicate', eventsOf(dupId).join());
    check('and a duplicate event on the original', eventsOf(julId).slice(-1)[0] === 'duplicate'
      && db.events.filter((e) => sameId(e.statement_id, julId) && e.event === 'duplicate')[0].payload.duplicateId === dupId);
    r = await call(A, 'GET', '/');
    check('the tombstone is never listed', r.json.total === 3 && !r.json.data.some((x) => x.id === dupId));
    r = await call(A, 'GET', `/${dupId}/log`);
    check('the tombstone log is readable', r.status === 200 && r.json.data.map((e) => e.event).join() === 'uploaded,duplicate');
    r = await call(A, 'POST', `/${dupId}/reanalyse`, {});
    check('re-analysing a tombstone -> 409 DUPLICATE', isEnvelope(r, 409, 'DUPLICATE'), r.text);
    // The tombstone keeps its hash: the same re-scan uploaded again is caught
    // before any read, and pointed at the original the owner can see.
    mark = recorded.length;
    const readsBefore = extractCalls.length;
    const rowsBefore = db.statements.length;
    r = await upload(A, 'July rescan (1).pdf', pdf(`fixture=${WR}_202607 rescan`));
    check('the re-scan uploaded again -> 200 duplicate, pointed at July, not at the tombstone',
      r.status === 200 && r.json.duplicate === true && r.json.id === julId && r.json.reason === 'same_file', r.text);
    check('and no new row, no read, no second tombstone', db.statements.length === rowsBefore
      && extractCalls.length === readsBefore && !sqlSince(mark).some((q) => /INSERT INTO card_statements/.test(q.sql)));

    /* ── Cross-client ── */
    console.log('\nTENANCY - another client sees nothing');
    mark = recorded.length;
    const before = JSON.stringify(db.statements.map((x) => [x.id, x.status]));
    for (const [method, p] of [['GET', `/${julId}`], ['GET', `/${julId}/log`], ['GET', `/${julId}/file`], ['GET', `/${julId}/csv`],
      ['POST', `/${julId}/reanalyse`], ['POST', `/${julId}/rebelipay-interest`], ['DELETE', `/${julId}`], ['GET', `/${dupId}`]]) {
      r = await call(B, method, p, method === 'POST' ? {} : undefined);
      check(`client B: ${method} ${p.replace(/\d+/, ':id')} -> 404 NOT_FOUND`, isEnvelope(r, 404, 'NOT_FOUND'), `${r.status} ${r.text}`);
    }
    r = await call(B, 'GET', '/');
    check('client B: an empty list and no stores', r.json.total === 0 && r.json.data.length === 0 && r.json.stores.length === 0);
    check('client B changed nothing', JSON.stringify(db.statements.map((x) => [x.id, x.status])) === before);
    const bSql = sqlSince(mark);
    const offTenant = bSql.filter((q) => {
      const m = /client_id = \$(\d+)/.exec(q.sql);
      return !m || q.params[Number(m[1]) - 1] !== B.client_id;
    });
    check(`client B's ${bSql.length} statements all filtered on client B`, bSql.length > 0 && offTenant.length === 0,
      offTenant.map((q) => q.sql.slice(0, 60)).join(' | '));
    r = await upload(B, 'mine.pdf', pdf(`fixture=${WR}_202605`));
    check('client B uploading the same bytes as A is not a duplicate of A\'s', r.status === 202, r.text);
    const bId = r.json.id;
    await settle(B, bId);
    r = await call(A, 'GET', '/');
    check('and A still sees only its own three', r.json.total === 3 && !r.json.data.some((x) => x.id === bId));

    /* ── File and CSV ── */
    console.log('\nFILE AND CSV EXPORT');
    r = await call(A, 'GET', `/${julId}/file`);
    check('original: application/pdf, inline, RFC 5987 name, nosniff, the stored bytes',
      r.status === 200 && r.headers.get('content-type') === 'application/pdf'
        && /^inline; filename="July.pdf"; filename\*=UTF-8''July\.pdf$/.test(r.headers.get('content-disposition'))
        && r.headers.get('x-content-type-options') === 'nosniff' && r.text === pdf(`fixture=${WR}_202607`),
      `${r.headers.get('content-type')} ${r.headers.get('content-disposition')}`);
    r = await call(A, 'GET', `/${julId}/file?download=1`);
    check('?download=1 -> attachment', /^attachment;/.test(r.headers.get('content-disposition') || ''));
    r = await call(A, 'GET', `/${julId}/csv`);
    const csv = r.text;
    check('csv: text/csv; charset=utf-8, BOM, named card-statement-<merchant>-<YYYY-MM>.csv',
      r.status === 200 && /^text\/csv; charset=utf-8/i.test(r.headers.get('content-type')) && r.raw[0] === 0xef && r.raw[1] === 0xbb
        && /filename="card-statement-498387143882-2026-07\.csv"/.test(r.headers.get('content-disposition')),
      `${r.headers.get('content-type')} ${r.headers.get('content-disposition')}`);
    check('csv: Summary, Rebelipay comparison, Card types, Fee lines, Daily',
      ['Summary', 'Rebelipay comparison', 'Card types', 'Fee lines', 'Daily'].every((s) => csv.replace(/^\uFEFF/, '').split(/\r\n/).includes(s)));
    check('csv: the comparison is totals only (paid 5865.65, with Rebelipay 5652.45, switch 183.25, PCI fix 29.95, total 213.20)',
      /Paid today,5865\.65\r\n/.test(csv) && /With Rebelipay,5652\.45\r\n/.test(csv) && /You save by switching,183\.25\r\n/.test(csv)
        && /"Fix the PCI penalty \(free, about 20 minutes\)",29\.95\r\n/.test(csv)
        && /Total savings Botella found,213\.20\r\n/.test(csv) && /Total savings Botella found per year \(est\.\),2558\.40\r\n/.test(csv));
    check('csv: the totals that add up and the findings flagged out of six, in the page\'s words (D43)',
      /Totals that add up,\d+ of \d+\r\n/.test(csv) && /Findings flagged,\d of 6\r\n/.test(csv) && !/Reconciliation checks/.test(csv));

    /* ── Not eligible ── */
    console.log('\nNOT ELIGIBLE - Rebelipay would cost more');
    r = await upload(A, 'tiny.pdf', pdf('fixture=costly'));
    const costlyId = r.json.id;
    d = (await settle(A, costlyId)).json;
    check('analysed, not eligible, no saving shown', d.status === 'analysed' && d.rebelipayEligible === false
      && d.rebelipaySavings === null && d.rebelipaySavingsAnnual === null && d.analysis.rebelipay.reason === 'costs_more'
      && !('rebelipayCost' in d.analysis.rebelipay) && !('savings' in d.analysis.rebelipay));
    check('the raw negative saving stays in the column only', byId(costlyId, A.client_id).rebelipay_savings < 0
      && !JSON.stringify(d).includes('-105.5'));
    r = await call(A, 'GET', `/${costlyId}/csv`);
    check('csv: no Rebelipay comparison when not eligible', r.status === 200 && !/Rebelipay/.test(r.text));
    let hooks = webhookCalls.length;
    r = await call(A, 'POST', `/${costlyId}/rebelipay-interest`, {});
    check('interest on a not-eligible statement -> 409 NOT_ELIGIBLE, no event, no webhook',
      isEnvelope(r, 409, 'NOT_ELIGIBLE') && !eventsOf(costlyId).includes('rebelipay_interest') && webhookCalls.length === hooks, r.text);

    /* ── Rebelipay interest ── */
    console.log('\nREBELIPAY INTEREST - eligible only, totals only');
    hooks = webhookCalls.length;
    r = await call(A, 'POST', `/${julId}/rebelipay-interest`, {});
    await sleep(10);
    check('-> 200 { ok: true, ctaUrl }', r.status === 200 && r.json.ok === true && r.json.ctaUrl === process.env.REBELIPAY_CTA_URL, r.text);
    const interest = db.events.filter((e) => sameId(e.statement_id, julId) && e.event === 'rebelipay_interest');
    check('a rebelipay_interest event with merchant, period, savings and user', interest.length === 1
      && interest[0].payload.merchantNumber === WR && interest[0].payload.period.label === 'Jul 2026'
      && interest[0].payload.savings.savings === 183.25 && interest[0].payload.savings.totalFound === 213.2 && interest[0].payload.user === 'owner-a' && interest[0].actor === 'owner-a',
      JSON.stringify(interest[0] && interest[0].payload));
    check('the webhook was called once, as a JSON POST', webhookCalls.length === hooks + 1
      && webhookCalls[hooks].opts.method === 'POST' && /json/.test(webhookCalls[hooks].opts.headers['Content-Type']));
    const lead = JSON.parse(webhookCalls[hooks].opts.body);
    check('the webhook body is the event, the statement, and totals only',
      Object.keys(lead).sort().join() === 'event,merchantName,merchantNumber,period,savings,statementId,user'
        && Object.keys(lead.savings).sort().join() === 'currentCost,currentRate,rebelipayCost,rebelipayRate,savings,savingsAnnual,savingsPct,totalFound,totalFoundAnnual,volume'
        && lead.event === 'rebelipay_interest' && lead.statementId === julId && lead.savings.rebelipayCost === 5652.45,
      JSON.stringify(lead));
    payloads.push({ where: 'webhook body', json: lead, text: webhookCalls[hooks].opts.body });
    webhookMode = 'down';
    r = await call(A, 'POST', `/${julId}/rebelipay-interest`, {});
    await sleep(10);
    check('a webhook failure never fails the request', r.status === 200 && r.json.ok === true);
    webhookMode = 'ok';
    const savedHook = process.env.REBELIPAY_LEAD_WEBHOOK;
    delete process.env.REBELIPAY_LEAD_WEBHOOK;
    hooks = webhookCalls.length;
    r = await call(A, 'POST', `/${julId}/rebelipay-interest`, {});
    await sleep(10);
    check('no webhook configured: recorded, nothing sent', r.status === 200 && webhookCalls.length === hooks);
    process.env.REBELIPAY_LEAD_WEBHOOK = savedHook;
    r = await call(A, 'GET', `/${julId}/log`);
    check('the log shows the interest, oldest first', r.status === 200 && r.json.data[0].event === 'uploaded'
      && r.json.data.filter((e) => e.event === 'rebelipay_interest').length === 3
      && r.json.data.every((e) => typeof e.id === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(e.createdAt)));

    /* ── Re-analyse ── */
    console.log('\nANALYSE AGAIN');
    let calls = extractCalls.length;
    r = await call(A, 'POST', `/${junId}/reanalyse`, {});
    check('default: re-run on the stored extraction, 200 with the fresh detail, no read',
      r.status === 200 && r.json.id === junId && r.json.status === 'analysed' && r.json.analysis && extractCalls.length === calls, r.text.slice(0, 200));
    check('a reanalysed event', eventsOf(junId).slice(-1)[0] === 'reanalysed');
    r = await call(A, 'POST', `/${junId}/reanalyse`, { reextract: true });
    check('reextract: 202 { id, status: analysing }', r.status === 202 && r.json.id === junId && r.json.status === 'analysing', r.text);
    d = (await settle(A, junId)).json;
    check('and the stored file is read again', d.status === 'analysed' && extractCalls.length === calls + 1
      && extractCalls[calls].fileName === 'June.pdf');
    r = await upload(A, 'slow.pdf', pdf(`fixture=${SP}_202607 hold=slow`));
    const slowId = r.json.id;
    r = await call(A, 'POST', `/${slowId}/reanalyse`, {});
    check('while analysing -> 409 BUSY', isEnvelope(r, 409, 'BUSY'), r.text);
    r = await call(A, 'POST', `/${slowId}/reanalyse`, { reextract: true });
    check('reextract while analysing -> 409 BUSY too', isEnvelope(r, 409, 'BUSY'), r.text);
    r = await call(A, 'GET', '/?status=analysing');
    check('the status filter finds it', r.json.total === 1 && r.json.data[0].id === slowId && r.json.data[0].rebelipayEligible === null);
    await releaseHold('slow');
    d = (await settle(A, slowId)).json;
    check('released, it finishes as analysed (Spotswood, refunds credited)', d.status === 'analysed'
      && d.merchantNumber === SP && d.analysis.rebelipay.refundsCredited === true);

    /* ── Failures ── */
    console.log('\nFAILURES - owner-safe, logged, recoverable');
    r = await upload(A, 'broken.pdf', pdf('fail=raw'));
    const brokenId = r.json.id;
    d = (await settle(A, brokenId)).json;
    check('a raw reader error -> failed with the generic owner message', d.status === 'failed'
      && d.parseError === svc.GENERIC_FAILURE && !/529|provider|req_secret/.test(JSON.stringify(d)), d.parseError);
    check('an analysis_failed event', eventsOf(brokenId).join() === 'uploaded,analysis_failed');
    r = await upload(A, 'long.pdf', pdf('fail=owner'));
    d = (await settle(A, r.json.id)).json;
    check('an owner-safe reader error is shown as it is', d.status === 'failed' && d.parseError === 'This statement was too long to read in one go.');
    r = await upload(A, 'headless.pdf', pdf(`fixture=${SP}_202605 noheader`));
    d = (await settle(A, r.json.id)).json;
    check('no merchant number -> failed, "Could not read this statement: no merchant number found."',
      d.status === 'failed' && d.parseError === 'Could not read this statement: no merchant number found.', d.parseError);
    r = await call(A, 'GET', `/${brokenId}/csv`);
    check('csv of a failed statement -> 409 NOT_ANALYSED', isEnvelope(r, 409, 'NOT_ANALYSED'), r.text);
    r = await call(A, 'POST', `/${brokenId}/rebelipay-interest`, {});
    check('interest on a failed statement -> 409 NOT_ELIGIBLE', isEnvelope(r, 409, 'NOT_ELIGIBLE'), r.text);

    /* ── A transaction CSV, end to end ── */
    console.log('\nCSV UPLOAD - the deterministic parser, end to end');
    const csvFile = fs.readFileSync(path.join(FIXTURES, 'csv-three-rows.csv'));
    r = await upload(A, 'csv-three-rows.csv', csvFile, 'application/vnd.ms-excel');
    check('a CSV sent as application/vnd.ms-excel -> 202', r.status === 202, r.text);
    const csvId = r.json.id;
    d = (await settle(A, csvId)).json;
    check('analysed with the CSV layout: $3.76 with Rebelipay, no current fees, not eligible',
      d.status === 'analysed' && d.layoutVersion === 'csv' && d.analysis.rebelipay.rebelipayCost === 3.76
        && d.analysis.rebelipay.reason === 'no_current_fees' && d.rebelipayEligible === false && d.rebelipaySavings === null
        && d.parseModel === null, JSON.stringify(d.analysis && d.analysis.rebelipay));
    check('stored as .csv and served back as text/csv', /\.csv$/.test(byId(csvId, A.client_id).file_path)
      && (await call(A, 'GET', `/${csvId}/file`)).headers.get('content-type') === 'text/csv');
    r = await call(A, 'POST', `/${csvId}/rebelipay-interest`, {});
    check('interest without a comparison -> 409 NOT_ELIGIBLE', isEnvelope(r, 409, 'NOT_ELIGIBLE'));
    // Refunds only: net card volume below zero is a misread, never KPIs.
    r = await upload(A, 'refunds.csv', 'Date,Amount,Card Type,Merchant Number\n2026-07-01,-10.00,Visa,400000000007\n', 'text/csv');
    d = (await settle(A, r.json.id)).json;
    check('a CSV that nets below zero -> Could not read, with an owner-safe reason',
      d.status === 'failed' && d.parseError === 'Could not read this statement: the amount submitted came out negative.'
        && d.analysis === null && d.amountSubmitted === null, `${d.status} ${d.parseError}`);
    await call(A, 'DELETE', `/${d.id}`);

    /* ── The list kept in step with the page ── */
    console.log('\nLIST FIGURES - what the page shows is what the list shows (D44)');
    const listed = async (id) => ((await call(E, 'GET', '/?limit=100')).json.data.find((x) => x.id === id) || {}).findingsCount;
    const until = async (test) => { for (let i = 0; i < 400 && !(await test()); i += 1) await sleep(5); };
    const figuresOf = async (who) => JSON.stringify((await call(who, 'GET', '/?limit=100')).json.data
      .map((x) => [x.id, x.findingsCount, x.totalFees, x.effectiveRate, x.debitShare, x.rebelipaySavings]));
    const aBefore = await figuresOf(A);
    r = await upload(E, 'July 2026.pdf', pdf('fixture=trend-2026'));
    const t26 = r.json.id;
    d = (await settle(E, t26)).json;
    const alone = d.analysis && d.analysis.findingsCount;
    check('July 2026 on its own: no trend to check yet', d.status === 'analysed' && d.analysis.findings[1].available === false
      && d.findingsCount === alone && (await listed(t26)) === alone, `${d.status} ${alone} ${d.findingsCount}`);
    const updatedAt = byId(t26, E.client_id).updated_at;
    r = await upload(E, 'July 2025.pdf', pdf('fixture=trend-2025'));
    const t25 = r.json.id;
    await settle(E, t25);
    await until(async () => byId(t26, E.client_id).findings_count === alone + 1);
    check('the year before arrives: July 2026 is re-filed without being opened (sales halved, one more finding)',
      (await listed(t26)) === alone + 1, String(await listed(t26)));
    check('re-filing leaves updated_at alone', byId(t26, E.client_id).updated_at === updatedAt);
    d = (await call(E, 'GET', `/${t26}`)).json;
    check('and its page agrees with the list', d.analysis.findingsCount === alone + 1 && d.findingsCount === alone + 1
      && d.analysis.findings[1].flagged === true, `${d.analysis.findingsCount} ${d.findingsCount}`);
    mark = recorded.length;
    await call(E, 'GET', `/${t26}`);
    // (The lazy sweep's UPDATE of stale 'analysing' rows runs on every read; it is not a re-file.)
    const refiles = (since) => sqlSince(since).filter((q) => /UPDATE card_statements SET amount_submitted = /.test(q.sql.replace(/\s+/g, ' ')));
    check('opening it again writes nothing', refiles(mark).length === 0, String(refiles(mark).length));
    // Figures filed before a rule changed: opening the statement re-files them.
    Object.assign(byId(t26, E.client_id), { findings_count: 0, total_fees: 1 });
    check('a stale count shows on the list until the statement is opened', (await listed(t26)) === 0);
    d = (await call(E, 'GET', `/${t26}`)).json;
    check('opening it re-files the list figures, and the detail answers with them',
      d.findingsCount === alone + 1 && d.totalFees === 20 && (await listed(t26)) === alone + 1
        && byId(t26, E.client_id).total_fees === 20, `${d.findingsCount} ${d.totalFees}`);
    r = await call(E, 'DELETE', `/${t25}`);
    check('deleting the year before re-files July 2026 back', r.status === 200 && (await listed(t26)) === alone,
      String(await listed(t26)));
    check('nothing else in this run was re-filed: the uploads, re-reads and deletes above left figures that already agreed',
      refiles(0).length === 3, refiles(0).map((q) => q.params[0]).join(','));

    // A re-read takes the statement out of the later ones' history the moment
    // it starts, so a delete while it is read, or a read that finds something
    // else, leaves them right.
    r = await upload(E, 'July 2025 again.pdf', pdf('fixture=trend-2025 hold=t25'));
    const t25b = r.json.id;
    await releaseHold('t25');
    await settle(E, t25b);
    await until(async () => byId(t26, E.client_id).findings_count === alone + 1);
    check('the year before, uploaded again, is back in July 2026\'s trend', (await listed(t26)) === alone + 1);
    r = await call(E, 'POST', `/${t25b}/reanalyse`, { reextract: true });
    check('reading the year before again: July 2026 is re-filed as it starts, without it',
      r.status === 202 && byId(t25b, E.client_id).status === 'analysing' && (await listed(t26)) === alone, String(await listed(t26)));
    r = await call(E, 'DELETE', `/${t25b}`);
    await releaseHold('t25');
    await sleep(30);
    check('deleted while it was read: July 2026 stays re-filed without it', r.status === 200 && !byId(t25b, E.client_id)
      && (await listed(t26)) === alone, String(await listed(t26)));
    // Analyse again on a stored read that now fails: it leaves the history too.
    r = await upload(E, 'July 2025 once more.pdf', pdf('fixture=trend-2025 third'));
    const t25c = r.json.id;
    await settle(E, t25c);
    await until(async () => byId(t26, E.client_id).findings_count === alone + 1);
    byId(t25c, E.client_id).extracted.summary.amount_submitted = -5;
    r = await call(E, 'POST', `/${t25c}/reanalyse`, {});
    check('analysed again and failed: July 2026 is re-filed without it', r.status === 200 && r.json.status === 'failed'
      && (await listed(t26)) === alone, `${r.status} ${r.json.status} ${await listed(t26)}`);
    await call(E, 'DELETE', `/${t25c}`);

    // A rule change raises the engine's version: the list re-files this
    // client's older rows before it lists them, and only this client's.
    const current = require('../services/cardStatementAnalysis').ANALYSIS_VERSION;
    Object.assign(byId(t26, E.client_id), { analysis_version: current - 1, findings_count: 0 });
    const aRow = db.statements.find((x) => x.client_id === A.client_id && x.status === 'analysed');
    aRow.analysis_version = current - 1;
    check('an older engine\'s count is re-filed before the list shows it', (await listed(t26)) === alone
      && byId(t26, E.client_id).analysis_version === current, String(await listed(t26)));
    check('another client\'s older row waits for that client\'s own list', aRow.analysis_version === current - 1);
    await call(A, 'GET', '/');
    check('which re-files it, even when no figure moved', aRow.analysis_version === current);
    mark = recorded.length;
    await call(E, 'GET', '/');
    check('once every row is current, a list load re-files nothing', refiles(mark).length === 0);
    check('another client\'s list figures never moved', (await figuresOf(A)) === aBefore);

    // A figure finer than its column (fees of 20.005: Postgres keeps 20.01,
    // JavaScript rounds to 20.00) is the same figure, so after the one re-file
    // its moved effective rate needs, opening it writes nothing.
    byId(t26, E.client_id).extracted.summary.fees = 20.005;
    mark = recorded.length;
    await call(E, 'GET', `/${t26}`);
    check('the effective rate it moved is re-filed once', refiles(mark).length === 1, String(refiles(mark).length));
    mark = recorded.length;
    await call(E, 'GET', `/${t26}`);
    await call(E, 'GET', `/${t26}`);
    check('then a figure within half a cent of its column is not re-filed on every open', refiles(mark).length === 0, String(refiles(mark).length));

    // Re-filing runs one at a time per store: a second run waits for the
    // first one's write before it reads anything.
    byId(t26, E.client_id).findings_count = 9;
    let release;
    holdSql = { re: /^UPDATE card_statements SET amount_submitted = /, until: new Promise((done) => { release = done; }) };
    mark = recorded.length;
    const laterSelects = () => sqlSince(mark).filter((q) => /AND status = 'analysed' AND period_end >=? \$3::date/.test(q.sql.replace(/\s+/g, ' '))).length;
    const runs = [svc.refileLater(pool, E.client_id, TREND_STORE, '2026-01-01'), svc.refileLater(pool, E.client_id, TREND_STORE, '2026-01-01')];
    await sleep(30);
    check('a second re-file of a store waits while the first one writes', laterSelects() === 1, String(laterSelects()));
    release();
    await Promise.all(runs);
    check('and then runs, reading what the first one wrote', laterSelects() === 2 && byId(t26, E.client_id).findings_count === alone,
      `${laterSelects()} ${byId(t26, E.client_id).findings_count}`);

    // One row the engine cannot re-run does not stop the rows after it.
    const broken = insertStatement({ client_id: E.client_id, location_id: E.location_id, status: 'analysed', merchant_number: '400000000009',
      merchant_name: 'BROKEN', period_start: '2026-01-01', period_end: '2026-01-31', findings_count: 0, analysis_version: current - 1,
      extracted: { get summary() { throw new Error('an extraction this engine cannot read'); } } });
    Object.assign(byId(t26, E.client_id), { analysis_version: current - 1, findings_count: 0 });
    await call(E, 'GET', '/');
    check('an outdated row the engine cannot re-run is skipped, and the next one is still re-filed',
      broken.analysis_version === current - 1 && byId(t26, E.client_id).analysis_version === current && byId(t26, E.client_id).findings_count === alone,
      `${broken.analysis_version} ${byId(t26, E.client_id).analysis_version} ${byId(t26, E.client_id).findings_count}`);
    db.statements = db.statements.filter((x) => x !== broken);

    /* ── Stuck rows ── */
    console.log('\nSTUCK ROWS - interrupted reads are failed, not polled forever');
    const longAgo = new Date(Date.now() - 30 * 60000);
    const stuckA = insertStatement({ client_id: A.client_id, location_id: A.location_id, status: 'analysing',
      file_name: 'stuck-a.pdf', file_mime: 'application/pdf', updated_at: longAgo, created_at: longAgo });
    const stuckC = insertStatement({ client_id: C.client_id, location_id: C.location_id, status: 'analysing',
      file_name: 'stuck-c.pdf', file_mime: 'application/pdf', updated_at: longAgo, created_at: longAgo });
    const freshA = insertStatement({ client_id: A.client_id, location_id: A.location_id, status: 'analysing', file_name: 'fresh-a.pdf' });
    r = await call(A, 'GET', '/');
    await sleep(10);
    check('the list sweeps this client\'s stale row to failed', stuckA.status === 'failed'
      && stuckA.parse_error === 'Interrupted by a server restart. Reanalyse it to read it again.'
      && r.json.data.find((x) => x.id === String(stuckA.id)).status === 'failed', stuckA.status);
    check('an interrupted event on it', eventsOf(stuckA.id).join() === 'interrupted');
    check('another client\'s stale row is left alone by a client read', stuckC.status === 'analysing');
    check('a live read (updated just now) is left alone', freshA.status === 'analysing');
    const stuckA2 = insertStatement({ client_id: A.client_id, location_id: A.location_id, status: 'analysing',
      file_name: 'stuck-a2.pdf', updated_at: longAgo, created_at: longAgo });
    r = await call(A, 'GET', `/${stuckA2.id}`);
    check('the detail read sweeps too', r.json.status === 'failed' && stuckA2.status === 'failed');
    mark = recorded.length;
    const moved = await svc.recoverStuck({ pool });
    await sleep(10);
    check('the boot sweep fails every client\'s stale row', moved === 1 && stuckC.status === 'failed'
      && eventsOf(stuckC.id).join() === 'interrupted' && db.events.find((e) => sameId(e.statement_id, stuckC.id)).client_id === C.client_id);
    check('the boot sweep leaves a live read alone', freshA.status === 'analysing');
    const bootSql = sqlSince(mark).filter((q) => /UPDATE card_statements/.test(q.sql));
    check('the boot sweep is one UPDATE without a client predicate', bootSql.length === 1
      && !/WHERE[\s\S]*client_id[\s\S]*RETURNING/.test(bootSql[0].sql), bootSql.map((q) => q.sql.replace(/\s+/g, ' ')).join(' | '));
    process.env.CS_STALE_MINUTES = '45';
    const notYet = insertStatement({ client_id: A.client_id, location_id: A.location_id, status: 'analysing',
      file_name: 'not-yet.pdf', updated_at: longAgo, created_at: longAgo });
    await call(A, 'GET', '/');
    check('CS_STALE_MINUTES is honoured (30 minutes is not stale at 45)', notYet.status === 'analysing');
    // D13 holds in code: a threshold shorter than one read may take is raised
    // to the read's deadline plus slack, so a live read is never swept.
    const floor = Math.ceil((extractMod.READ_DEADLINE_MS + 2 * 60000) / 60000);
    check('the reader has one deadline for the whole read, under the default threshold',
      Number.isInteger(extractMod.READ_DEADLINE_MS) && extractMod.READ_DEADLINE_MS > 0 && floor <= 10, String(extractMod.READ_DEADLINE_MS));
    process.env.CS_STALE_MINUTES = '1';
    check(`CS_STALE_MINUTES=1 is raised to the safe minimum (${floor})`, svc.staleMinutes() === floor, String(svc.staleMinutes()));
    process.env.CS_STALE_MINUTES = String(floor + 5);
    check('a threshold above the minimum is kept as set', svc.staleMinutes() === floor + 5);
    process.env.CS_STALE_MINUTES = '10';
    await call(A, 'GET', '/');
    check('and is stale at 10', notYet.status === 'failed');

    /* ── Delete ── */
    console.log('\nDELETE');
    const julPath = byId(julId, A.client_id).file_path;
    r = await call(A, 'DELETE', `/${julId}`);
    check('-> 200 { ok: true }', r.status === 200 && r.json.ok === true && Object.keys(r.json).join() === 'ok', r.text);
    check('the row, its events and its tombstone are gone', !byId(julId, A.client_id) && !byId(dupId, A.client_id)
      && eventsOf(julId).length === 0 && eventsOf(dupId).length === 0);
    check('and its file', !fs.existsSync(path.join(UPLOAD_ROOT, julPath)));
    r = await call(A, 'GET', `/${julId}`);
    check('a deleted statement -> 404', isEnvelope(r, 404, 'NOT_FOUND'));
    r = await call(A, 'DELETE', `/${julId}`);
    check('deleting it again -> 404', isEnvelope(r, 404, 'NOT_FOUND'));
    d = (await call(A, 'GET', `/${junId}`)).json;
    check('June\'s savings to date no longer counts July ($267.48 over May and June)',
      d.savingsToDate && d.savingsToDate.amount === 267.48 && d.savingsToDate.statements === 2, JSON.stringify(d.savingsToDate));

    /* ── Migrations missing ── */
    console.log('\nMIGRATIONS MISSING - 42P01');
    missingTables = true;
    const filesBefore = fs.readdirSync(path.join(UPLOAD_ROOT, String(A.client_id))).length;
    r = await call(A, 'GET', '/');
    check('list -> 503 MIGRATION_MISSING with the command to run', isEnvelope(r, 503, 'MIGRATION_MISSING')
      && /npm run migrate/.test(r.json.error.message), r.text);
    r = await call(A, 'GET', `/${junId}`);
    check('detail -> 503 MIGRATION_MISSING', isEnvelope(r, 503, 'MIGRATION_MISSING'), r.text);
    r = await call(A, 'GET', `/${junId}/log`);
    check('log -> 503 MIGRATION_MISSING', isEnvelope(r, 503, 'MIGRATION_MISSING'), r.text);
    r = await call(A, 'DELETE', `/${junId}`);
    check('delete -> 503 MIGRATION_MISSING', isEnvelope(r, 503, 'MIGRATION_MISSING'), r.text);
    r = await upload(A, 'new.pdf', pdf(`fixture=${SP}_202606`));
    check('upload -> 503 MIGRATION_MISSING', isEnvelope(r, 503, 'MIGRATION_MISSING'), r.text);
    check('and the stored file was removed again', fs.readdirSync(path.join(UPLOAD_ROOT, String(A.client_id))).length === filesBefore);
    check('the boot sweep shrugs it off', (await svc.recoverStuck({ pool })) === 0);
    missingTables = false;

    /* ── Search by period, and the store order ── */
    console.log('\nSEARCH AND ORDER - periods, several words, store A to Z');
    const ids = {};
    const uploads = [['wrMay', `${WR}_202605`], ['wrJun', `${WR}_202606`], ['wrJul', `${WR}_202607`], ['spJun', `${SP}_202606`], ['spJul', `${SP}_202607`]];
    for (const [i, [key, name]] of uploads.entries()) {
      // Neutral file names, so a period search can only match on the period.
      r = await upload(D, `d${i}.pdf`, pdf(`fixture=${name}`));
      ids[key] = r.json.id;
    }
    // One more, held mid-read: no store name and no period yet.
    r = await upload(D, 'held.pdf', pdf(`fixture=${SP}_202605 hold=dsearch`));
    ids.spMay = r.json.id;
    for (const [key] of uploads) await settle(D, ids[key]);
    const order = async (qs) => (await call(D, 'GET', `/${qs}`)).json.data.map((x) => x.id).join();
    const want = (...keys) => keys.map((k) => ids[k]).join();
    let got = await order('');
    check('a statement still being read sorts first, so a fresh upload is on page 1',
      got === want('spMay', 'spJul', 'spJun', 'wrJul', 'wrJun', 'wrMay'), got);
    got = await order('?q=may');
    check('a period search never matches a statement with no period yet', got === want('wrMay'), got);
    await releaseHold('dsearch');
    await settle(D, ids.spMay);
    const ORDERS = [
      ['', 'default: store A to Z, newest period first within each store', ['spJul', 'spJun', 'spMay', 'wrJul', 'wrJun', 'wrMay']],
      ['?sort=store', 'sort=store: the same', ['spJul', 'spJun', 'spMay', 'wrJul', 'wrJun', 'wrMay']],
      ['?sort=store_desc', 'sort=store_desc: Z to A, newest period first', ['wrJul', 'wrJun', 'wrMay', 'spJul', 'spJun', 'spMay']],
      ['?sort=period', 'sort=period: newest first, stores A to Z within a period', ['spJul', 'wrJul', 'spJun', 'wrJun', 'spMay', 'wrMay']],
      ['?sort=period_asc', 'sort=period_asc: oldest first, stores A to Z within a period', ['spMay', 'wrMay', 'spJun', 'wrJun', 'spJul', 'wrJul']],
      ['?sort=bogus', 'an unknown sort falls back to the store order', ['spJul', 'spJun', 'spMay', 'wrJul', 'wrJun', 'wrMay']],
    ];
    for (const [qs, label, keys] of ORDERS) {
      got = await order(qs);
      check(label, got === want(...keys), got);
    }
    const SEARCHES = [
      ['june', ['spJun', 'wrJun']],
      ['jun 2026', ['spJun', 'wrJun']],
      ['June/2026', ['spJun', 'wrJun']],
      ['06/2026', ['spJun', 'wrJun']],
      ['2026-06', ['spJun', 'wrJun']],
      ['06/30/2026', ['spJun', 'wrJun']],
      ['June 30, 2026', ['spJun', 'wrJun']],
      ['JULY', ['spJul', 'wrJul']],
      ['2026', ['spJul', 'spJun', 'spMay', 'wrJul', 'wrJun', 'wrMay']],
      ['wine june', ['wrJun']],
      ['spotswood 07/2026', ['spJul']],
      ['republic', ['wrJul', 'wrJun', 'wrMay']],
      ['august', []],
      ['13/2026', []],
    ];
    for (const [term, keys] of SEARCHES) {
      const body = (await call(D, 'GET', `/?q=${encodeURIComponent(term)}`)).json;
      got = body.data.map((x) => x.id).join();
      check(`search "${term}" finds ${keys.length}, in store order`, body.total === keys.length && got === want(...keys), got);
    }
    r = await call(D, 'GET', '/?q=2026&limit=4&offset=4');
    check('a period search pages: total 6, second page of 2', r.json.total === 6
      && r.json.data.map((x) => x.id).join() === want('wrJun', 'wrMay'), JSON.stringify(r.json.data.map((x) => x.id)));
    r = await call(D, 'GET', `/?q=june&store=${SP}`);
    check('search and the store filter together', r.json.total === 1 && r.json.data[0].id === ids.spJun);
    r = await call(A, 'GET', '/?q=june');
    check('another client\'s June statements are never found', r.json.data.every((x) => byId(x.id, A.client_id)));

    /* ── Every statement carries the client predicate ── */
    console.log('\nTENANCY - every SQL statement');
    const boot = /UPDATE card_statements SET status = 'failed', parse_error = \$2/;
    const offenders = recorded.filter((q) => {
      if (boot.test(q.sql)) return false;
      if (/^\s*INSERT INTO card_statement_events/.test(q.sql)) return !Number.isInteger(q.params[1]);
      if (/^\s*INSERT INTO card_statements/.test(q.sql)) return !/\(client_id,/.test(q.sql) || !Number.isInteger(q.params[0]);
      const m = /\bclient_id = \$(\d+)/.exec(q.sql);
      return !m || !Number.isInteger(q.params[Number(m[1]) - 1]);
    });
    check(`all ${recorded.length} statements carry a bound client_id, except the boot sweep`, offenders.length === 0,
      offenders.map((q) => q.sql.replace(/\s+/g, ' ').slice(0, 70)).join(' | '));
    check('the boot sweep ran only when asked (twice)', recorded.filter((q) => boot.test(q.sql)).length === 2);
    check('the fake pool recognised every statement the service sent', unknownSql.length === 0, unknownSql.join(' | '));
    check('every reference to a statement id is bound with its client', recorded.every((q) => !/WHERE id = \$1(?! AND client_id = \$2)/.test(q.sql)));

    /* ── No component of the price anywhere ── */
    console.log('\nNO PRICE COMPONENTS - in any payload, log, webhook body or CSV');
    // The parts of the price for every statement uploaded here, in cents.
    const components = new Set();
    for (const name of [`${WR}_202605`, `${WR}_202606`, `${WR}_202607`, `${SP}_202605`, `${SP}_202606`, `${SP}_202607`]) {
      const ct = load(name).card_types;
      const pct = ct.reduce((s, c) => s + Math.round(c.gross * 100) * 25500, 0) / 1e6;
      [Math.round(pct), Math.floor(pct), Math.ceil(pct), ct.reduce((s, c) => s + c.items * 10, 0)].forEach((v) => components.add(v));
      const refunds = ct.reduce((s, c) => s + Math.round((c.refunds || 0) * 100) * 25500 + (c.refund_items || 0) * 10e6, 0);
      const salesMicro = ct.reduce((s, c) => s + Math.round(c.gross * 100) * 25500 + c.items * 10e6, 0);
      const credit = Math.floor((salesMicro + 5e5) / 1e6) - Math.floor((salesMicro - refunds + 5e5) / 1e6);
      if (credit > 0) components.add(credit);
    }
    const NOT_MONEY = /pct|share|rate|items|count|transactions|days|version|^new$|^repeat$|rows|^id$|ms$|size|passed|total$|expected|actual/i;
    const leaks = [];
    const visit = (v, at, key) => {
      if (key && /pctRate|perTxn|per_txn|txnFee|ppm|refundCredit|monthlyFees|refundsReturnFee|roundPerTransaction/i.test(key)) leaks.push(`${at}: key`);
      if (typeof v === 'number' && !(key && NOT_MONEY.test(key)) && components.has(Math.round(v * 100))
        && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6) leaks.push(`${at} = ${v}`);
      if (typeof v === 'number' && key && /rate|fee|cost|price/i.test(key) && at.includes('ebelipay') && [0.0255, 2.55, 0.1, 10].includes(v)) {
        leaks.push(`${at} = ${v} (offer term)`);
      }
      if (typeof v === 'string' && /2\.55\s*%|0\.0255|10\s*(¢|cents?\b)/i.test(v)) leaks.push(`${at}: names the price`);
      if (Array.isArray(v)) v.forEach((x, i) => visit(x, `${at}[${i}]`, key));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, `${at}.${k}`, k);
    };
    let scanned = 0;
    for (const p of payloads) {
      if (p.json) { visit(p.json, p.where, null); scanned += 1; }
    }
    check(`${scanned} JSON payloads (details, lists, logs, the webhook body) carry no price component`, leaks.length === 0 && scanned > 40,
      leaks.slice(0, 5).join('; '));
    const csvLeaks = [];
    for (const p of payloads.filter((x) => /text\/csv/.test(x.type || '') && /Summary/.test(x.text))) {
      for (const cell of p.text.replace(/^\uFEFF/, '').split(/\r\n/).flatMap((line) => line.split(','))) {
        const n = Number(cell);
        if (cell !== '' && Number.isFinite(n) && components.has(Math.round(n * 100)) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6) {
          csvLeaks.push(`${p.where}: ${cell}`);
        }
        if (/^(2\.55|0\.0255|0\.10?)$/.test(cell)) csvLeaks.push(`${p.where}: ${cell}`);
      }
    }
    check('the CSV exports carry no price component', csvLeaks.length === 0, csvLeaks.slice(0, 5).join('; '));
    check('every error answered with the { error: { code, message } } envelope',
      payloads.filter((p) => p.json && p.json.error).every((p) => Object.keys(p.json).join() === 'error'
        && typeof p.json.error.code === 'string' && typeof p.json.error.message === 'string'));
  } finally {
    server.close();
    fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true });
  }

  console.log('');
  if (failures) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('ALL CHECKS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error('threw:', e);
  try { fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(1);
});
