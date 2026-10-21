// Why did this screen get nothing - the store, or us?
//
// WHAT WENT WRONG WITHOUT THIS. `availability.js` answers the question for a
// payload that ARRIVED: a 200 whose sections are absent means the store has no
// CRM, no cost data, no supplier history, and the screen says so kindly. But
// when the request itself fails there is no payload to inspect, and every
// screen collapsed the whole space of reasons into one sentence with a Retry
// button next to it:
//
//     Unable to load customer insights.    [Retry]
//
// For a store whose analytics database has no customer tables, that button
// will never work. An owner presses it, waits, presses it again, and is never
// told the one thing that is true: the data has to be connected upstream, and
// the people who can do that are us.
//
// The two readings are not interchangeable, and the difference is not cosmetic:
//
//   MISSING  a statement about the STORE. The table, the column, the whole
//            capability is not there. Nothing is coming; retrying cannot
//            change it; the action is to contact us.
//   FAILED   a statement about US. The service is down, the network dropped,
//            a grant is behind, a query timed out. Retrying may well work, and
//            telling the owner their store has no data would be a lie.
//
// SO THE DEFAULT IS FAILED. A failure we do not recognise is ours until it
// proves otherwise. Guessing the other way puts "your store does not have this
// data" on screen during an outage, which is both false and unrecoverable - it
// sends the owner to support over a blip, and teaches them to ignore the notice
// for the one case where it is real.
//
// The hazard this file is most careful about is `permission denied`. It names a
// table, it reads exactly like absence, and it is OURS - a role without a GRANT
// is a migration we have not finished, not a store without customers.

import { errorText } from '../utils/errorText';

/** The store does not have this data. Retrying will not change that. */
export const MISSING = 'missing';
/** The request failed on our side. Retrying may work. */
export const FAILED = 'failed';

/**
 * Postgres (and the engines above it) saying the object itself is not there.
 *
 * These arrive through the Python service's 502 envelope as
 * `UndefinedTable: relation "customers" does not exist` - the status is about
 * the hop that failed, so the message is the only thing that identifies the
 * cause.
 */
// Written as regex LITERALS and joined on `.source`: a pattern spelled as a
// string needs every backslash doubled, and `'\s'` is a silent `s` - the
// `relation "x" does not exist` branch matched nothing at all until this moved
// off strings, and it failed in the quiet direction (absence read as our
// outage), which is exactly the one no owner would report.
const ABSENT_OBJECT = new RegExp([
  /undefined(?:table|column|object|function)/,
  /invalid(?:schemaname|catalogname)/,
  /(?:relation|column|table|schema|database|view)\s+"?[\w.$-]+"?\s+does not exist/,
  /no such (?:table|column|database)/,
  /does not exist in (?:the )?(?:analytics|schema|database)/,
  /is not configured for this store/,
  /not available for this store/,
].map((r) => r.source).join('|'), 'i');

/**
 * Ours, not theirs - checked FIRST, because several of these name a table and
 * would otherwise read as absence.
 *
 * `permission denied for relation sales` is a GRANT we owe, which is why it
 * leads the list. The rest are transport: the service down, the tunnel closed,
 * a query past its deadline.
 */
const OUR_FAULT = new RegExp([
  /insufficient_?privilege/,
  /permission denied/,
  /must be owner/,
  /service unreachable/,
  /failed to fetch/,
  /networkerror/,
  /load failed/,
  /timed? ?out|timeout/,
  /econn(?:refused|reset|aborted)|enotfound|ehostunreach|socket hang up/,
  /the operation was aborted/,
].map((r) => r.source).join('|'), 'i');

/** Statuses that mean the thing asked for is not there for this caller. */
const ABSENT_STATUS = new Set([404, 410, 501]);

/** A sentence an owner can act on, where we know more than the default. */
const ABSENT_OBJECT_REASON =
  'The tables this screen reads are not in your store\'s analytics database, '
  + 'so there is nothing to show yet.';

/**
 * An error carrying WHY, so the component that renders it does not have to
 * guess. A plain Error thrown anywhere else still works: `kindOf` reads it as
 * FAILED, which is the safe reading.
 */
export class RetrievalError extends Error {
  constructor(message, { status = 0, kind = FAILED, reason = null, detail = null } = {}) {
    super(message);
    this.name = 'RetrievalError';
    this.status = status;
    this.kind = kind;
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Which of the two readings does this failure support?
 *
 * @param {number} status  HTTP status, or 0 when `fetch` itself threw.
 * @param {unknown} body   parsed response body, if there was one.
 * @returns {{kind: string, reason: string|null, detail: string|null}}
 */
export function classify(status, body) {
  const text = errorText(body, '');
  // Ours first: these name tables too, and a GRANT we owe must never be shown
  // to an owner as their store lacking data.
  if (OUR_FAULT.test(text)) return { kind: FAILED, reason: null, detail: null };
  // The engine refused and wrote the best sentence we will ever have for why.
  if (body && typeof body === 'object' && body.available === false) {
    return { kind: MISSING, reason: sentence(body.reason) || null, detail: null };
  }
  if (ABSENT_STATUS.has(status)) return { kind: MISSING, reason: null, detail: null };
  if (ABSENT_OBJECT.test(text)) {
    return { kind: MISSING, reason: ABSENT_OBJECT_REASON, detail: trim(text) };
  }
  // Unrecognised: ours until proven otherwise.
  return { kind: FAILED, reason: null, detail: null };
}

/** Build the classified error for a response that came back not-ok. */
export async function retrievalError(res, fallback) {
  let body = null;
  try {
    const text = await res.text();
    if (text) {
      try { body = JSON.parse(text); } catch { body = { error: text }; }
    }
  } catch { /* body unreadable; the status still classifies */ }
  const c = classify(res.status, body);
  return new RetrievalError(errorText(body, fallback || `HTTP ${res.status}`), {
    status: res.status, ...c,
  });
}

/** The reading for anything caught, including errors this module did not make. */
export function kindOf(err) {
  return err && err.kind === MISSING ? MISSING : FAILED;
}

/** True when the store simply does not have it. */
export const isMissing = (err) => kindOf(err) === MISSING;

function sentence(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * The one line of a technical message that is fit to put on a screen.
 *
 * psycopg does not stop at the sentence. A real one, captured from this
 * service:
 *
 *   UndefinedTable: relation "customer_metrics" does not exist
 *   LINE 1: SELECT 1 FROM customer_metrics LIMIT 1
 *                         ^
 *
 * Only the first line names the thing. The rest echoes OUR SQL back, and that
 * does not belong in front of a store owner - it is noise to them and query
 * shape to anyone else looking over their shoulder. So: first line only, then
 * a length cap.
 */
function trim(text, max = 180) {
  const first = String(text || '').split(/[\r\n]/, 1)[0];
  const s = first.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const retrieval = { MISSING, FAILED, classify, isMissing, kindOf, retrievalError, RetrievalError };
export default retrieval;
