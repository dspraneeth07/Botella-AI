/**
 * Card statement search: what the owner types into the list's search box.
 *
 * A query is split into words and EVERY word must match the statement. A word
 * matches when the store name, the merchant number or the file name contains
 * it, or, when the word reads as a period, when the statement's period does:
 *
 *   june, jun, July                       statements covering that month, any year
 *   2026                                  statements covering that year
 *   jun 2026, june/2026, 06/2026, 2026-06 statements covering that month
 *   06/30/2026, 2026-06-30, June 30 2026  the statement covering that day
 *
 * Text and period are alternatives, never one or the other: "july" still finds
 * a file called "july-statement.pdf", and "wine june" finds Wine Republic's
 * June statement (and any other store with "wine" in its name).
 *
 * Pure: parseSearch() reads the words, searchClause() turns them into one
 * parameterised SQL condition. Nothing typed is ever spliced into the SQL.
 */
'use strict';

const MAX_TERM = 200;
const MAX_WORDS = 8;

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const MONTH_NAME = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const monthOf = (word) => MONTHS[String(word || '').toLowerCase().replace(/\.$/, '')] || null;

// Two-digit years are this century; anything outside a plausible statement
// range is not a period, just text.
function yearOf(raw) {
  const s = String(raw);
  const y = s.length === 2 ? 2000 + Number(s) : Number(s);
  return Number.isInteger(y) && y >= 1990 && y <= 2100 ? y : null;
}

function realDate(y, m, d) {
  if (!y || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? iso(y, m, d) : null;
}

function lastDayOf(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const dateSpec = (date) => (date ? { kind: 'date', date } : null);
const monthYearSpec = (y, m) => (y && m >= 1 && m <= 12
  ? { kind: 'month_year', year: y, month: m, first: iso(y, m, 1), last: iso(y, m, lastDayOf(y, m)) }
  : null);

/**
 * Read one word (or a phrase the caller already joined) as a period, or null.
 * US order first for slashed dates, as the statements print them; a first
 * number over 12 can only be a day, so "30/06/2026" still reads as 30 June.
 */
function periodOf(word) {
  const w = String(word || '').trim().toLowerCase().replace(/,/g, '');
  if (!w) return null;
  let m;

  if ((m = w.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    return dateSpec(realDate(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  if ((m = w.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = yearOf(m[3]);
    return dateSpec(realDate(y, a, b) || (a > 12 ? realDate(y, b, a) : null));
  }
  if ((m = w.match(/^(\d{4})(\d{2})(\d{2})$/))) {
    return dateSpec(realDate(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  if ((m = w.match(new RegExp(`^(${MONTH_NAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(\\d{4})$`)))) {
    return dateSpec(realDate(yearOf(m[3]), monthOf(m[1]), Number(m[2])));
  }
  if ((m = w.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAME})\\.?\\s+(\\d{4})$`)))) {
    return dateSpec(realDate(yearOf(m[3]), monthOf(m[2]), Number(m[1])));
  }
  if ((m = w.match(/^(\d{4})[-/.](\d{1,2})$/))) return monthYearSpec(yearOf(m[1]), Number(m[2]));
  if ((m = w.match(/^(\d{1,2})[-/.](\d{4})$/))) return monthYearSpec(yearOf(m[2]), Number(m[1]));
  if ((m = w.match(new RegExp(`^(${MONTH_NAME})\\.?[\\s/.'-]?(\\d{4}|\\d{2})$`)))) {
    return monthYearSpec(yearOf(m[2]), monthOf(m[1]));
  }
  if ((m = w.match(new RegExp(`^(\\d{4})[\\s/.-]?(${MONTH_NAME})\\.?$`)))) {
    return monthYearSpec(yearOf(m[1]), monthOf(m[2]));
  }
  if (/^(19|20)\d{2}$/.test(w)) return { kind: 'year', year: Number(w) };
  const month = monthOf(w);
  if (month) return { kind: 'month', month };
  return null;
}

/**
 * Split a query into the words that must all match.
 *
 * "jun 2026" and "june 30 2026" are read as one period, not as a month AND a
 * year that could come from two different statements. A word that is not a
 * period is still kept, as text.
 */
function parseSearch(term) {
  const text = String(term || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TERM);
  if (!text) return [];
  const words = text.split(' ');
  const out = [];
  for (let i = 0; i < words.length && out.length < MAX_WORDS; i += 1) {
    // Longest phrase first: a three-word date, then a two-word month and year.
    const three = words.slice(i, i + 3).join(' ');
    const two = words.slice(i, i + 2).join(' ');
    const asDate = i + 2 < words.length ? periodOf(three) : null;
    if (asDate && asDate.kind === 'date') { out.push({ text: three, period: asDate }); i += 2; continue; }
    const asPair = i + 1 < words.length ? periodOf(two) : null;
    if (asPair && (asPair.kind === 'month_year' || asPair.kind === 'date')) { out.push({ text: two, period: asPair }); i += 1; continue; }
    out.push({ text: words[i], period: periodOf(words[i]) });
  }
  return out;
}

// LIKE's own wildcards are escaped: a merchant number is typed by a person,
// and "50%" should find "50%", not everything.
const likePattern = (s) => `%${String(s).replace(/[\\%_]/g, '\\$&')}%`;

/**
 * One SQL condition for the whole query, its values appended to `params`.
 * Returns null for an empty query. Rows with no period yet (still analysing,
 * or unreadable) can only match on text: NULL never satisfies a date test.
 */
function searchClause(term, params) {
  const words = parseSearch(term);
  if (!words.length) return null;
  const next = (value) => { params.push(value); return `$${params.length}`; };
  const parts = words.map(({ text, period }) => {
    const p = next(likePattern(text));
    const textMatch = `merchant_name ILIKE ${p} OR merchant_number ILIKE ${p} OR file_name ILIKE ${p}`;
    if (!period) return `(${textMatch})`;
    let periodMatch;
    if (period.kind === 'date') {
      const d = next(period.date);
      periodMatch = `(period_start <= ${d}::date AND period_end >= ${d}::date)`;
    } else if (period.kind === 'month_year') {
      const last = next(period.last);
      const first = next(period.first);
      periodMatch = `(period_start <= ${last}::date AND period_end >= ${first}::date)`;
    } else if (period.kind === 'month') {
      const mo = next(period.month);
      periodMatch = `(EXTRACT(MONTH FROM period_start) = ${mo} OR EXTRACT(MONTH FROM period_end) = ${mo})`;
    } else {
      const y = next(period.year);
      periodMatch = `(EXTRACT(YEAR FROM period_start) = ${y} OR EXTRACT(YEAR FROM period_end) = ${y})`;
    }
    return `(${textMatch} OR ${periodMatch})`;
  });
  return parts.join(' AND ');
}

module.exports = { parseSearch, periodOf, searchClause, likePattern, MAX_WORDS };
