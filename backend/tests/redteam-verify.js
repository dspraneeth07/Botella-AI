// =============================================================================
// redteam-verify.js - run an adversarial bypass corpus through the LIVE guard.
// =============================================================================
// Input: a JSON file (default /tmp/redteam-candidates.json) of the form
//   { candidates: [ { technique, sql, angle, why? }, ... ] }
// produced by the tenant-guard-redteam workflow. For each candidate we compute
// the EXACT app-layer verdict handleTool uses for a session bound to tenant 46:
//     isSafeQuery(sql) && !isBlockedTable(sql) && validateTenantFilter(sql,46,46)
// ALL must be BLOCKED. Any candidate that is ALLOWED is printed for DB-level
// follow-up (run it against the RLS fixture to confirm the backstop) and the
// run exits non-zero. This is the deterministic half of the red-team; the RLS
// migration (proven in rls-and-index-proof.sh) is the database backstop beneath.
// =============================================================================
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const { _internal } = require('../routes/chat');
const { isSafeQuery, isBlockedTable, validateTenantFilter } = _internal;

const SELF = 46;
const file = process.argv[2] || require('path').join(__dirname, 'fixtures', 'redteam-candidates.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const candidates = data.candidates || data;

const guardAllows = (sql) =>
  isSafeQuery(sql) && !isBlockedTable(sql) && validateTenantFilter(sql, SELF, SELF);

let allowed = 0;
const allowedList = [];
for (const c of candidates) {
  const sql = (c.sql || '').trim();
  if (!sql) continue;
  if (guardAllows(sql)) { allowed++; allowedList.push(c); }
}

console.log(`\n══ Red-team verification - ${candidates.length} adversarial candidates ══`);
const byAngle = {};
for (const c of candidates) byAngle[c.angle || c.technique || '?'] = (byAngle[c.angle || c.technique || '?'] || 0) + 1;
console.log('   corpus by angle:', Object.entries(byAngle).map(([k, v]) => `${k}:${v}`).join('  '));
console.log(`   BLOCKED by app-layer guard: ${candidates.length - allowed}/${candidates.length}`);
console.log(`   ALLOWED (potential gap):    ${allowed}/${candidates.length}`);

if (allowed) {
  console.log('\n   ⚠️  Candidates the guard ALLOWED - inspect against the RLS fixture:');
  for (const c of allowedList) console.log(`     [${c.angle || c.technique}] ${c.sql}`);
  console.log('\n❌ Red-team found app-layer gap(s) above. (RLS still blocks at the DB - see 002.)');
  process.exit(1);
}
console.log('\n✅ Red-team: every adversarial candidate BLOCKED by the app-layer guard.');
process.exit(0);
