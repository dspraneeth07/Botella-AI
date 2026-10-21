#!/usr/bin/env node
/**
 * One deadline per bottle (migration 042), and the basis guard behind it.
 *
 * THE DEFECT. Bethany, 19 October 2026: the Recommendations card for Weber
 * Ranch 1L read "Order by Mon, Oct 19"; the Purchasing row for the same bottle
 * read "Order by Thu, Oct 22" and a quantity the card never asked for. The
 * card's date was browser arithmetic on engine_days_cover with a hard-coded
 * seven; the row's was utils/cover.js with a lead of three. Nothing stored
 * either. The fix is one source: the engine computes `order_by` with the lead
 * time the card quotes, the persist path stores it, getLatest serves it, and
 * both screens read it.
 *
 * What is pinned here, without a database:
 *
 *   1  the persist path and getLatest carry the three columns the way the
 *      house pattern requires - probed, degraded, and the DATE read back as
 *      text (DAILY-CAPTURE.md section 4)
 *   2  the two vocabularies agree: the words Node accepts for lead_time_basis
 *      are exactly the Python schema's Literal
 *   3  migration 042 adds the three columns idempotently and writes no GRANT,
 *      because `recommendations` is already granted (said so in the file)
 *   4  BELT AND BRACES on confidence_basis. The 19 October regeneration
 *      failure was `null value in column confidence_basis` from a Node
 *      process still running pre-040 code. The persist path coerces the basis
 *      before the INSERT; this asserts that `coerceBasis` can never return a
 *      null, empty or unknown basis for ANY input, which is the guarantee that
 *      makes a further guard in persistRun redundant.
 *
 * The same regex-on-source approach as rec-surface-verify.js: the service
 * opens a pool when loaded, and a test that needs the database is a test that
 * does not run in CI's unit job.
 *
 * Run:  node tests/card-order-by-verify.js
 */

const path = require('path');
const fs = require('fs');

const basisLib = require('../lib/confidenceBasis');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const ROOT = path.join(__dirname, '..');
const service = fs.readFileSync(path.join(ROOT, 'services', 'recommendationService.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(ROOT, 'database', 'analytics-migrations', '042_card_order_by.sql'), 'utf8');
const pySchema = fs.readFileSync(
  path.join(ROOT, '..', 'Botella_External_APIs', 'app', 'schemas', 'recommendation.py'), 'utf8');
const pyEngine = fs.readFileSync(
  path.join(ROOT, '..', 'Botella_External_APIs', 'app', 'recommender', 'deterministic.py'), 'utf8');

console.log('\n── 1. The persist path and getLatest carry the deadline ────────');

check('1a persistRun probes for the order_by column before writing it',
  /column_name = 'order_by' LIMIT 1/.test(service),
  'probe-and-degrade is the house pattern; an unprobed column couples persistence to migration order');
check('1b the INSERT writes order_by, lead_time_days and lead_time_basis together',
  /cols\.push\('order_by', 'lead_time_days', 'lead_time_basis'\)/.test(service));
check('1c the date is written as the string it arrived as, never built from the clock',
  /dateString\(r\.order_by\)/.test(service) && /function dateString\(v\)/.test(service));
check('1d getLatest reads the DATE back as text',
  /order_by::text AS order_by/.test(service),
  'a DATE parsed at local midnight shifts a day west of UTC (DAILY-CAPTURE.md section 4)');
check('1e getLatest exposes all three on the card shape',
  /order_by: hasOrderBy \? \(i\.order_by \|\| null\) : null/.test(service)
    && /lead_time_days: hasOrderBy && i\.lead_time_days != null/.test(service)
    && /lead_time_basis: hasOrderBy \? \(i\.lead_time_basis \|\| null\) : null/.test(service));
check('1f a basis outside the vocabulary is persisted as null, not as a third word',
  /LEAD_TIME_BASES\.has\(r\.lead_time_basis\) \? r\.lead_time_basis : null/.test(service));

// The date helper, exercised directly: re-evaluated from the source so the
// module (which opens a pool) is never loaded.
const helperSrc = /function dateString\(v\) \{[\s\S]*?\n\}/.exec(service);
check('1g the date helper is present in the source', Boolean(helperSrc));
if (helperSrc) {
  // eslint-disable-next-line no-new-func
  const dateString = new Function(`${helperSrc[0]}; return dateString;`)();
  check('1h  "2026-10-19" is kept as is', dateString('2026-10-19') === '2026-10-19');
  check('1i  a full ISO datetime keeps its date part, as valid_through does',
    dateString('2026-10-19T04:00:00.000Z') === '2026-10-19');
  check('1j  a number, an empty string, a Date and undefined all become null',
    [dateString(20261019), dateString(''), dateString(new Date()), dateString(undefined),
      dateString(null), dateString('Oct 19')].every((v) => v === null));
}

console.log('\n── 2. One vocabulary for lead_time_basis ────────────────────────');

const nodeBases = /const LEAD_TIME_BASES = new Set\(\[([^\]]*)\]\)/.exec(service);
const pyBases = /lead_time_basis: Literal\[([^\]]*)\]/.exec(pySchema);
const words = (m) => (m ? m[1].match(/["']([a-z_]+)["']/g).map((w) => w.replace(/["']/g, '')).sort() : null);
check('2a Node declares the set', Boolean(nodeBases));
check('2b the Python schema declares the Literal', Boolean(pyBases));
check('2c the two lists are identical',
  JSON.stringify(words(nodeBases)) === JSON.stringify(words(pyBases)),
  `node=${JSON.stringify(words(nodeBases))} python=${JSON.stringify(words(pyBases))}`);
check('2d the engine emits only those two words',
  /LEAD_TIME_BASIS_MEASURED = "measured"/.test(pyEngine)
    && /LEAD_TIME_BASIS_DECLARED = "declared"/.test(pyEngine));
check('2e the Python schema declares all three fields the engine emits',
  /^\s+order_by: str \| None = None/m.test(pySchema)
    && /^\s+lead_time_days: int \| None = None/m.test(pySchema)
    && /^\s+lead_time_basis: Literal/m.test(pySchema),
  'an undeclared field is silently discarded by Recommendation.model_validate (tests/test_card_surface.py)');

console.log('\n── 3. Migration 042 ─────────────────────────────────────────────');

check('3a adds order_by as a DATE, idempotently',
  /ADD COLUMN IF NOT EXISTS order_by\s+date/.test(migration));
check('3b adds lead_time_days as an integer, idempotently',
  /ADD COLUMN IF NOT EXISTS lead_time_days\s+integer/.test(migration));
check('3c adds lead_time_basis as text, idempotently',
  /ADD COLUMN IF NOT EXISTS lead_time_basis\s+text/.test(migration));
check('3d is a transaction', /^BEGIN;/m.test(migration) && /^COMMIT;/m.test(migration));
check('3e writes no GRANT - recommendations is already granted - and says so',
  !/^\s*GRANT\b/m.test(migration) && /already granted/.test(migration));
check('3f sets no default on order_by (a historical card must not acquire a deadline)',
  !/order_by\s+date\s+(NOT NULL|DEFAULT)/i.test(migration));
check('3g the file is the next number after 041',
  fs.existsSync(path.join(ROOT, 'database', 'analytics-migrations', '041_admission_notes.sql'))
    && !fs.readdirSync(path.join(ROOT, 'database', 'analytics-migrations'))
      .some((f) => /^042_/.test(f) && f !== '042_card_order_by.sql'));

console.log('\n── 4. confidence_basis can never reach the INSERT as null ────────');

// Every shape a payload has ever arrived in, and a few it has not.
const hostile = [undefined, null, '', 0, false, NaN, {}, [], 42, 'ISOTONIC', ' isotonic',
  'guessed', 'not_recorded ', String(Symbol('x')), '\u0000', 'raw_ranking_score\n'];
const coerced = hostile.map((v) => basisLib.coerceBasis(v));
check('4a every hostile input yields a non-empty string basis',
  coerced.every((c) => typeof c.basis === 'string' && c.basis.length > 0));
check('4b every hostile input yields a word the vocabulary has',
  coerced.every((c) => basisLib.isKnownBasis(c.basis)));
check('4c every hostile input is labelled not_recorded, with a reason to log',
  coerced.every((c) => c.basis === basisLib.NOT_RECORDED && typeof c.reason === 'string' && c.reason.length));
check('4d every known basis passes through unchanged with no reason',
  basisLib.CONFIDENCE_BASES.every((b) => {
    const c = basisLib.coerceBasis(b);
    return c.basis === b && c.reason === null;
  }));
check('4e not_recorded is itself in the vocabulary (so the fallback is never refused)',
  basisLib.CONFIDENCE_BASES.includes(basisLib.NOT_RECORDED));
check('4f the persist path pushes the COERCED basis, never the raw field through text()',
  /const basis = coerceBasis\(r\.confidence_basis\);/.test(service)
    && /basis\.basis, num\(r\.confidence_raw\)/.test(service)
    && !/text\(r\.confidence_basis\)/.test(service),
  'text() would hand the INSERT an explicit NULL, which the column DEFAULT does not rescue');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
