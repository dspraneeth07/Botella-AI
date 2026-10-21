#!/usr/bin/env node
/*
  answer-verifier.js - INDEPENDENT value-level answer verifier (accuracy v2).

  This file is deliberately self-contained: it imports NOTHING from routes/chat.js
  or lib/metrics.js (the code under test). It grades a bot answer (free text) against
  (a) the ACTUAL tool-result rows the bot saw (captured in eval mode) and
  (b) per-test INDEPENDENT ground-truth values computed by ground-truth.js from its
  own SQL.

  It is stricter than "does this number appear somewhere": labeled values are checked
  WITH CORRECT PAIRING (the number next to LIQUOR must equal LIQUOR's value), weekday
  names must match the date they describe, "top/best" must equal the real arg-max,
  thresholds must hold for every listed item, and an honest decline is only credited
  when the ground truth confirms the data is genuinely missing.

  Verdicts per turn: 'correct' | 'honest' | 'confident_wrong' (FAIL) | 'needs_review'.
  Any check of severity 'fail' makes the turn confident_wrong. The grader's headline
  is "% correct-or-honest" and "# confident_wrong (must be 0)".
*/

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ── number parsing / matching ────────────────────────────────────────────────
function parseNumberToken(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  let mult = 1;
  if (/k$/i.test(s)) { mult = 1e3; s = s.replace(/k$/i, ''); }
  else if (/m$/i.test(s)) { mult = 1e6; s = s.replace(/m$/i, ''); }
  s = s.replace(/[$,%\s]/g, '');
  if (s === '' || !/^-?\d*\.?\d+$/.test(s)) return null;
  return Number(s) * mult;
}

function approxEqual(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  if (diff <= 0.5) return true;                       // whole-dollar rounding
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return diff / denom <= 0.015;                       // 1.5% relative tolerance
}

// True if a claimed number plausibly equals a target. Only scales UP (K/M shorthand,
// already mostly handled in parseNumberToken). It must NOT scale DOWN: with the small
// absolute tolerance, claim*1e-6 would read as ~0 and falsely "match" the 0 that is
// almost always present in evidence - which would let fabricated figures pass.
function valueClose(claim, target) {
  const scales = [1, 1e3, 1e6];
  return scales.some(s => approxEqual(claim * s, target));
}

// Looser variant for big plain integers (counts) so reasonable rounding ("about
// 1,600" for 1,627) isn't penalized, while gross fabrications still fail.
function approxEqualLoose(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  if (diff <= 2) return true;
  return diff / Math.max(Math.abs(a), Math.abs(b), 1e-9) <= 0.05;   // 5% for counts
}
function valueCloseLoose(claim, target) {
  return [1, 1e3, 1e6].some(s => approxEqualLoose(claim * s, target));
}

// Pull candidate numeric tokens out of free text, tagging currency / percent and
// skipping date parts and bare years so we don't false-positive on "2026".
function extractNumberTokens(text) {
  const out = [];
  const t = String(text || '');
  // K/M is only a magnitude suffix when NOT followed by another letter, so "750ML"
  // (bottle size) and "$800 more" are not misread as 750-million / 800-million.
  const re = /(\$\s?-?\d[\d,]*(?:\.\d+)?(?:[kKmM](?![a-zA-Z]))?)|(-?\d[\d,]*(?:\.\d+)?\s?%)|(-?\d[\d,]*(?:\.\d+)?(?:[kKmM](?![a-zA-Z]))?)/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const raw = m[0];
    const idx = m.index;
    // skip ISO date fragments like 2026-06-02 and bare 4-digit years
    const around = t.slice(Math.max(0, idx - 1), idx + raw.length + 1);
    if (/\d-\d/.test(around) && /^\d{1,4}$/.test(raw.replace(/\D/g, ''))) continue;
    const isCurrency = /\$/.test(raw);
    const isPercent = /%/.test(raw);
    const value = parseNumberToken(raw);
    if (value == null) continue;
    const bareYear = !isCurrency && !isPercent && /^(19|20)\d{2}$/.test(raw.replace(/\D/g, ''));
    out.push({ raw: raw.trim(), value, isCurrency, isPercent, bareYear, index: idx });
  }
  return out;
}

function extractWeekdayTokens(text) {
  const out = [];
  const t = String(text || '');
  const re = /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    out.push({ weekday: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), index: m.index });
  }
  return out;
}

// Independent weekday computation (verifier owns this - does not trust the bot/tool).
function computeWeekday(isoDate) {
  const d = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return WEEKDAYS[d.getUTCDay()];
}

function extractIsoDates(text) {
  return [...String(text || '').matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map(m => m[1]);
}

// ── evidence flattening ──────────────────────────────────────────────────────
// Walk an arbitrary captured tool result and collect all numbers / strings / dates.
function collectValues(node, acc) {
  if (node == null) return acc;
  if (Array.isArray(node)) { for (const x of node) collectValues(x, acc); return acc; }
  if (typeof node === 'object') { for (const k of Object.keys(node)) collectValues(node[k], acc); return acc; }
  if (typeof node === 'number') { acc.numbers.push(node); return acc; }
  if (typeof node === 'string') {
    acc.texts.push(node.toLowerCase());
    for (const d of extractIsoDates(node)) acc.dates.add(d);
    const n = parseNumberToken(node);
    if (n != null && /^[\d.,$%-]+$/.test(node.trim())) acc.numbers.push(n);
    return acc;
  }
  return acc;
}

// Build the set of values an answer is allowed to state from evidence: every captured
// number, plus TIGHT derivations (column sums and per-row share-of-sum + simple
// averages). Deliberately NOT all pairwise differences/ratios - that is the weak
// "appears somewhere" trap this verifier exists to avoid.
function buildAllowedValues(evidence) {
  const acc = { numbers: [], texts: [], dates: new Set() };
  const rowsForSums = [];
  for (const ev of evidence || []) {
    collectValues(ev.result != null ? ev.result : ev, acc);
    const rows = ev?.result?.rows || ev?.result?.categories || ev?.result?.days
      || ev?.result?.periods || ev?.result?.products || ev?.result?.rows;
    if (Array.isArray(rows)) rowsForSums.push(rows);
  }
  const allowed = new Set(acc.numbers.map(n => n));
  // column sums + per-row share-of-sum + averages
  for (const rows of rowsForSums) {
    const cols = {};
    for (const r of rows) {
      if (r && typeof r === 'object') {
        for (const [k, v] of Object.entries(r)) {
          const n = typeof v === 'number' ? v : parseNumberToken(v);
          if (Number.isFinite(n)) (cols[k] = cols[k] || []).push(n);
        }
      }
    }
    for (const [, arr] of Object.entries(cols)) {
      const sum = arr.reduce((a, b) => a + b, 0);
      allowed.add(sum);
      if (arr.length) allowed.add(sum / arr.length);                 // average
      for (const v of arr) if (sum) allowed.add((v / sum) * 100);    // each row's share %
      // Bounded, principled derivations that real answers use (NOT the weak all-pairwise
      // explosion): top-N cumulative totals + cumulative share, and "X more than the
      // next/best" deltas (adjacent-rank and vs-max). O(N) per column, sorted desc.
      const desc = [...arr].sort((a, b) => b - a);
      let pref = 0;
      for (const v of desc) { pref += v; allowed.add(pref); if (sum) allowed.add((pref / sum) * 100); }
      for (let i = 0; i < desc.length; i++) {
        allowed.add(desc[0] - desc[i]);                 // gap vs the best
        if (i + 1 < desc.length) allowed.add(desc[i] - desc[i + 1]);  // gap to the next rank
      }
    }
    // Within-ROW derivations: avg/ratio/delta between a single row's own columns
    // (avg ticket = revenue/transactions, %stock = in/total*100, share, delta%), plus
    // percentage complements. Scoped to one row so it stays tight - NOT all-pairwise.
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const vals = Object.values(r).map(v => (typeof v === 'number' ? v : parseNumberToken(v))).filter(Number.isFinite);
      for (const v of vals) if (v > 0 && v < 100) allowed.add(100 - v);
      for (let i = 0; i < vals.length; i++) for (let j = 0; j < vals.length; j++) {
        if (i === j) continue;
        const a = vals[i], b = vals[j];
        allowed.add(a - b);
        if (b !== 0) { allowed.add(a / b); allowed.add((a / b) * 100); allowed.add(((a - b) / b) * 100); allowed.add(((a - b) / Math.abs(b)) * 100); }
      }
    }
  }
  // Global SAME-COLUMN derivations across ALL evidence rows/turns - period-over-period
  // (April vs March revenue delta) and week-over-week. A metric compared to ITSELF across
  // rows/turns, NOT cross-metric all-pairwise.
  const gcols = {};
  for (const rws of rowsForSums) for (const r of rws) {
    if (!r || typeof r !== 'object') continue;
    for (const [k, v] of Object.entries(r)) { const n = (typeof v === 'number' ? v : parseNumberToken(v)); if (Number.isFinite(n)) (gcols[k] = gcols[k] || []).push(n); }
  }
  for (const arr of Object.values(gcols)) {
    for (let i = 0; i < arr.length; i++) for (let j = 0; j < arr.length; j++) {
      if (i === j) continue;
      const a = arr[i], b = arr[j];
      allowed.add(a - b);
      if (b !== 0) { allowed.add(a / b); allowed.add(((a - b) / b) * 100); allowed.add(((a - b) / Math.abs(b)) * 100); }
    }
  }
  return { numbers: [...allowed], dates: acc.dates, texts: acc.texts };
}

function numberSupported(value, allowed) {
  return allowed.numbers.some(t => valueClose(value, t));
}

// ── individual checks (each returns {ok, severity, reason}) ───────────────────
const FAIL = 'fail', WARN = 'warn', OK = 'ok';

// Currency, percentage, and large-count figures in the answer must be supported by
// evidence (the rows the bot actually retrieved) or a tight derivation of it.
// Small bare integers (ordinals, "top 5", "3 ideas", "last 30 days") are left alone
// to avoid false positives. Threshold figures echoed from the question are skipped.
function checkNumbersSupported(answer, allowed) {
  const findings = [];
  const text = String(answer || '');
  for (const tok of extractNumberTokens(answer)) {
    if (tok.bareYear) continue;
    const pre = text.slice(Math.max(0, tok.index - 18), tok.index);
    const post = text.slice(tok.index + tok.raw.length, tok.index + tok.raw.length + 8);
    const thresholdCtx = /\b(under|over|below|above|less than|more than|at least|up to|within|max|maximum|min|minimum|cap(?:ped)?(?: at)?|priced? at|between|last|past|top|first|next|previous)\s*$/i.test(pre);
    const unitCtx = /^\s*(days?|weeks?|months?|years?|hours?|minutes?)\b/i.test(post);
    // Skip a figure the answer is REFUTING / echoing from the user's premise ("not 80%", "rather than 80%").
    if (/\b(not|rather than|instead of|n['’]t|nowhere near)\s*$/i.test(pre)) continue;
    // Skip an explicitly-APPROXIMATE figure ("about $10,000", "roughly 30%", "~$5") - the bot
    // signalled it is rounding, so don't require an exact evidence match.
    if (/(\b(about|around|roughly|approximately|nearly|almost|close to|order of|just over|just under|upwards of)|~)\s*$/i.test(pre)) continue;
    if (tok.isPercent) {
      if (tok.value < 0 || tok.value > 100) continue;
      const pctOk = numberSupported(tok.value, allowed) || allowed.numbers.some(t => Math.abs(t - tok.value) <= 1.0);  // 1 pct-point tolerance for rounding ("roughly 30%" vs 29.2%)
      if (!pctOk) findings.push({ check: 'numbers_supported', severity: FAIL, reason: `Unsupported percentage "${tok.raw}" - not present in or derivable from the data the bot retrieved.` });
    } else if (tok.isCurrency) {
      if (thresholdCtx) continue;
      if (!numberSupported(tok.value, allowed)) findings.push({ check: 'numbers_supported', severity: FAIL, reason: `Unsupported currency value "${tok.raw}" - not present in or derivable from the data the bot retrieved.` });
    } else if (Math.abs(tok.value) >= 1000) {
      if (thresholdCtx || unitCtx) continue;
      const supported = allowed.numbers.some(t => valueCloseLoose(tok.value, t));
      if (!supported) findings.push({ check: 'numbers_supported', severity: FAIL, reason: `Unsupported large number "${tok.raw}" - not present in or derivable from the data the bot retrieved.` });
    }
  }
  return findings.length ? findings : [{ check: 'numbers_supported', severity: OK }];
}

// Any weekday named within ~40 chars of an ISO date must be that date's real weekday.
function checkWeekdays(answer, dateToWeekday) {
  const findings = [];
  const text = String(answer || '');
  const weekdays = extractWeekdayTokens(text);
  const dates = [...text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map(m => ({ date: m[1], index: m.index }));
  for (const wd of weekdays) {
    // find nearest ISO date within ~18 chars - tight, so a weekday in prose ("Friday, May 29th")
    // is NOT mis-paired with a far-off ISO date elsewhere (e.g. in a table row).
    let near = null, best = 19;
    for (const d of dates) {
      const dist = Math.abs(d.index - wd.index);
      if (dist < best) { best = dist; near = d; }
    }
    if (!near) continue;
    const truth = (dateToWeekday && dateToWeekday[near.date]) || computeWeekday(near.date);
    if (truth && wd.weekday !== truth) {
      findings.push({ check: 'weekday', severity: FAIL, reason: `Called ${near.date} "${wd.weekday}" but it was a ${truth}.` });
    }
  }
  return findings.length ? findings : [{ check: 'weekday', severity: OK }];
}

// Correct pairing: for each label in expectedMap that appears in the answer, the number
// that appears right after the label must equal that label's expected value.
function checkPairing(answer, expectedMap, opts = {}) {
  const findings = [];
  const text = String(answer || '');
  const window = opts.window || 60;
  for (const [label, expected] of Object.entries(expectedMap || {})) {
    const li = text.toLowerCase().indexOf(String(label).toLowerCase());
    if (li < 0) continue;
    const after = text.slice(li, li + String(label).length + window);
    const toks = extractNumberTokens(after).filter(t => !t.bareYear);
    if (!toks.length) continue;
    // the first currency/number after the label is the paired value
    const paired = toks.find(t => t.isCurrency) || toks[0];
    if (!valueClose(paired.value, expected)) {
      findings.push({ check: 'pairing', severity: FAIL, reason: `Value for "${label}" was stated as "${paired.raw}" but the data says ${expected}.` });
    }
  }
  return findings.length ? findings : [{ check: 'pairing', severity: OK }];
}

// Ranking: the answer's stated "top/best/#1" entity must equal the real arg-max label.
function checkRanking(answer, topLabel, opts = {}) {
  const text = String(answer || '');
  if (!topLabel) return [{ check: 'ranking', severity: OK }];
  // find a superlative cue, then check the real top label appears within the next window
  const cue = /(top|best|highest|busiest|most|number one|#1|leading|biggest)\b/i.exec(text);
  if (!cue) return [{ check: 'ranking', severity: OK }];
  const seg = text.slice(cue.index, cue.index + (opts.window || 260));
  if (seg.toLowerCase().includes(String(topLabel).toLowerCase())) {
    return [{ check: 'ranking', severity: OK }];
  }
  // also accept if the top label is the first listed entity near the start (e.g. first table row,
  // past a wide markdown header)
  if (text.slice(0, 260).toLowerCase().includes(String(topLabel).toLowerCase())) {
    return [{ check: 'ranking', severity: OK }];
  }
  return [{ check: 'ranking', severity: FAIL, reason: `Stated a top/best item, but the real leader (${topLabel}) is not the one named.` }];
}

// Threshold: every listed item's value must satisfy the predicate (e.g. price < 200).
function checkThreshold(answer, items, predicate, label) {
  const findings = [];
  for (const it of items || []) {
    if (!predicate(it)) findings.push({ check: 'threshold', severity: FAIL, reason: `Listed "${it.name}" (${it.value}) violates ${label}.` });
  }
  return findings.length ? findings : [{ check: 'threshold', severity: OK }];
}

// Min count: a stated headline count must be at least the true value (search recall).
function checkMinCount(answer, minValue, opts = {}) {
  const text = String(answer || '');
  const nums = extractNumberTokens(text).filter(t => !t.isCurrency && !t.isPercent && !t.bareYear).map(t => t.value);
  // the answer passes if it states a count >= minValue (recall floor) and <= some ceiling
  const ok = nums.some(n => n >= minValue * (opts.floorRatio || 0.9));
  if (!ok) return [{ check: 'min_count', severity: FAIL, reason: `Recall too low: data has ~${minValue} matching items but the answer doesn't reflect that.` }];
  // Over-scope guard (precision): a SPECIFIC sub-type count must not balloon to a much larger
  // family count (e.g. "bourbon" returning the whole whiskey family). Use the HEADLINE count
  // (first count-like integer near the start) so numbers inside product names ("750ML") don't pollute it.
  const head = extractNumberTokens(text.slice(0, 120)).find(t => !t.isCurrency && !t.isPercent && !t.bareYear && Number.isInteger(t.value) && t.value >= 2);
  if (head && head.value > minValue * (opts.ceilRatio || 1.6)) {
    return [{ check: 'min_count', severity: FAIL, reason: `Count too high: stated ${head.value} but the true count is ~${minValue} (likely returned a broader family than was asked for).` }];
  }
  return [{ check: 'min_count', severity: OK }];
}

// Honest decline: the answer must acknowledge the data gap AND not invent a value.
function checkHonestDecline(answer, opts = {}) {
  const raw = String(answer || '');
  const text = raw.toLowerCase();
  const declinePatterns = opts.patterns || [
    /not (recorded|tracked|available|populated|captured|stored)/, /isn'?t (recorded|tracked|available|populated)/,
    /no (cashier|register|payment|customer|cost|supplier|data)/, /don'?t (have|track|record|store)/,
    /can'?t (compute|calculate|determine|identify|provide|tell|break)/, /cannot (compute|calculate|determine|identify|provide|break)/,
    /anonymous/, /not linked/, /unable to/, /no (identified|named) customer/, /outside (this|the|your) (range|data)/,
    /not (enough|sufficient)/, /no .* on file/, /none .* on sale/, /no products .* on sale/,
  ];
  const declined = declinePatterns.some(p => p.test(text));
  // invented-value patterns that should NOT appear in an honest decline (tested
  // against the ORIGINAL-case answer so name patterns like [A-Z][a-z]+ work).
  // Patterns may be RegExp (direct calls) or strings (after JSON round-trip).
  const invented = (opts.forbid || []).some(p => {
    if (!(p instanceof RegExp) && typeof p !== 'string') return false;  // ignore malformed/serialized patterns
    try { const re = (p instanceof RegExp) ? p : new RegExp(p); return re.test(raw); }
    catch { return false; }
  });
  if (invented) return [{ check: 'honest_decline', severity: FAIL, reason: 'Answer invented a value for a field that is not in the data.' }];
  if (declined) return [{ check: 'honest_decline', severity: OK, honest: true }];
  return [{ check: 'honest_decline', severity: WARN, reason: 'Expected an honest "not available" but the answer did not clearly decline.' }];
}

// No-closure: the answer must not claim closed/no-sales for a date that HAS sales.
function checkNoClosure(answer, salesExistByDate) {
  const text = String(answer || '');
  // Refutation: if the answer DENIES closure or evidences the store was open, don't flag it.
  if (/\b(you (were|are) open|had (active )?sales|active sales|normal business day|definitely open|were open|was open|not closed|was ?n'?t closed|were ?n'?t closed|open that day|in (total )?revenue|[\d,]+ transactions|transaction data|accurate for|most recent day)\b/i.test(text)) return [{ check: 'no_closure', severity: OK }];
  // Conditional/hypothetical closure ("IF you were closed …") is not an assertion of closure.
  if (/\bif\b[^.]{0,30}\bclosed\b/i.test(text)) return [{ check: 'no_closure', severity: OK }];
  const closureRe = /\b(closed|not open|was ?n'?t open|not operational|no sales (were )?(recorded|made|registered)|system (outage|down))\b/i;
  if (!closureRe.test(text)) return [{ check: 'no_closure', severity: OK }];
  const dates = extractIsoDates(text);
  for (const d of dates) {
    if (salesExistByDate && salesExistByDate[d] && salesExistByDate[d] > 0) {
      return [{ check: 'no_closure', severity: FAIL, reason: `Implied closed/no-sales on ${d}, but that day had ${salesExistByDate[d]} sales.` }];
    }
  }
  // closure wording with no specific in-range date - still suspicious if a default date has sales
  if (salesExistByDate && salesExistByDate.__latest__ > 0 && dates.length === 0) {
    return [{ check: 'no_closure', severity: FAIL, reason: `Used closed/no-sales wording though the store has recent sales.` }];
  }
  return [{ check: 'no_closure', severity: OK }];
}

// ── orchestration ────────────────────────────────────────────────────────────
function isRefusalOrClarification(text) {
  return /\b(please clarify|could you clarify|what do you mean|need more (info|information)|which (one|of)|can you (specify|tell me))\b/i.test(text || '');
}

/*
  gradeTurn(turn, ctx)
  turn: { answer, evidence }  (evidence = captured tool calls w/ .result rows)
  ctx:  { expect, groundTruth }  per-test spec + independently-computed truth
  Returns { verdict, findings, hadEvidence }
*/
function gradeTurn(turn, ctx = {}) {
  // Strip internal markers the frontend hides (CSV download id, followups) so their
  // digits aren't mistaken for data claims.
  const answer = String(turn.answer || '')
    .replace(/\[download:[^\]]*\]/gi, ' ')
    .replace(/<<FOLLOWUPS>>[\s\S]*?<<?\/FOLLOWUPS>>/gi, ' ');
  const evidence = turn.evidence || [];
  const gt = ctx.groundTruth || {};
  const spec = ctx.expect || {};
  const allowed = buildAllowedValues(evidence);
  const findings = [];

  // universal checks
  findings.push(...checkNumbersSupported(answer, allowed));
  findings.push(...checkWeekdays(answer, gt.dateToWeekday));
  if (gt.salesExistByDate) findings.push(...checkNoClosure(answer, gt.salesExistByDate));

  // per-test checks
  for (const c of spec.checks || []) {
    if (c.type === 'pairing') findings.push(...checkPairing(answer, c.expectedMap, c));
    else if (c.type === 'weekday_best') {
      // best day claim must name the right date and/or weekday
      if (gt.bestDay) {
        const f = checkPairing(answer, { [gt.bestDay.weekday]: gt.bestDay.revenue }, { window: 80 });
        // also ensure the named best weekday is correct
        const wd = extractWeekdayTokens(answer);
        const claimsBest = /(best|busiest|highest|top)\b/i.test(answer);
        if (claimsBest && wd.length && !answer.toLowerCase().includes(gt.bestDay.weekday.toLowerCase())
            && !answer.includes(gt.bestDay.date)) {
          findings.push({ check: 'weekday_best', severity: FAIL, reason: `Best day is ${gt.bestDay.weekday} ${gt.bestDay.date}, but the answer named a different day.` });
        } else findings.push({ check: 'weekday_best', severity: OK });
      }
    }
    else if (c.type === 'ranking') findings.push(...checkRanking(answer, gt[c.from] || c.topLabel, c));
    else if (c.type === 'min_count') findings.push(...checkMinCount(answer, gt[c.from] != null ? gt[c.from] : c.min, c));
    else if (c.type === 'honest_decline') findings.push(...checkHonestDecline(answer, c));
    else if (c.type === 'no_closure' && gt.salesExistByDate) findings.push(...checkNoClosure(answer, gt.salesExistByDate));
    else if (c.type === 'pairing_from' && gt[c.from]) findings.push(...checkPairing(answer, gt[c.from], c));
    else if (c.type === 'ranking_from' && gt[c.from]) findings.push(...checkRanking(answer, gt[c.from], c));
  }

  const failed = findings.filter(f => f.severity === FAIL);
  const hadEvidence = evidence.some(e => e.success !== false);
  const honestExpected = (spec.checks || []).some(c => c.type === 'honest_decline');
  const honestSatisfied = findings.some(f => f.check === 'honest_decline' && f.honest);

  let verdict;
  if (failed.length) verdict = 'confident_wrong';
  else if (honestExpected) verdict = honestSatisfied ? 'honest' : 'needs_review';
  else if (isRefusalOrClarification(answer) && !hadEvidence) verdict = 'honest';
  else if (hadEvidence) verdict = 'correct';
  else verdict = 'needs_review';

  return { verdict, findings: findings.filter(f => f.severity !== OK || f.honest), hadEvidence };
}

module.exports = {
  WEEKDAYS, parseNumberToken, approxEqual, valueClose, extractNumberTokens,
  extractWeekdayTokens, computeWeekday, extractIsoDates, collectValues, buildAllowedValues,
  numberSupported, checkNumbersSupported, checkWeekdays, checkPairing, checkRanking,
  checkThreshold, checkMinCount, checkHonestDecline, checkNoClosure, gradeTurn,
};
