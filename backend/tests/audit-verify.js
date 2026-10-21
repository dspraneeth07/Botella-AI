#!/usr/bin/env node
/*
  audit-verify.js - live verification of the audit fixes against Zeke's (client 46).
  Start the eval server first:
    EVAL_PORT=3100 BOTELLA_READ_ONLY_DB=true DISABLE_CHAT_ANALYTICS=true \
      BOTELLA_EVAL_MODE=true node server.js
  Then: node tests/audit-verify.js
  Oracle truths (frozen dataset): top-1 Terra $152,358.90; dead-stock(90d)=355;
  margin(7d)~34.5%; midnight 4/160773 (time-of-day answerable); cost 4919/5001;
  all-time revenue $3,934,334.33 (header) vs $6,000,452.13 line (52.5% gap).
*/
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { JWT_SECRET } = require('../middleware/auth');

const API = process.env.EVAL_API_BASE || 'http://127.0.0.1:3100/api';
const token = jwt.sign({
  user_id: 'audit', username: 'audit', client_id: 46, location_id: 46,
  client_name: "Zeke's Liquor", location_name: "Zeke's Liquor",
}, JWT_SECRET, { expiresIn: '4h' });

async function ask(message) {
  const res = await fetch(`${API}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, history: [], conversation_id: 'av-' + Math.random().toString(36).slice(2) }),
  });
  const raw = await res.text();
  let answer = '', evidence = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const e = JSON.parse(line.slice(6));
      if (e.type === 'delta') answer += e.text || '';
      if (e.type === 'clear') answer = '';
      if (e.type === 'done' && e.eval) evidence = e.eval.evidence || [];
    } catch {}
  }
  return { answer: answer.split('<<FOLLOWUPS>>')[0].trim(), tools: evidence.map(e => e.tool) };
}

let fails = 0;
const check = (label, cond, snippet) => {
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (snippet) console.log(`         ↳ ${snippet.replace(/\s+/g, ' ').slice(0, 200)}`);
  if (!cond) fails++;
};
// A genuine refusal - NOT a coverage caveat. "82 products have no cost data"
// is a caveat (still answered); "I can't calculate margin" is a decline.
const declined = (a) => /can'?t (answer|tell|determine|provide|calculate|give you|compute|show)|unable to (answer|determine|calculate|provide)|isn'?t (recorded|available|captured|tracked|something i can)|not (recorded|captured|tracked|available) in (your|this|the)|don'?t have (that|the|enough|any)|stamped (at )?midnight|every sale (is|at) midnight/i.test(a);

(async () => {
  console.log('\n══ Live audit verification - Zeke\'s (client 46) ══\n');

  // F2 - top product: Terra $152,358.90 via get_top_products (was $15,774, 10x low)
  let r = await ask('What is my single best-selling product of all time by revenue?');
  check('F2 top product = Terra $136,584.12 via get_top_products (de-duped per DQ-01; not the inflated $152,358.90 nor the single-key $15,774)',
    /terra/i.test(r.answer) && /136,?5\d\d/.test(r.answer) && r.tools.includes('get_top_products') && !/15,?774/.test(r.answer),
    `tools=[${r.tools}] ${r.answer}`);

  // F2 - dead stock 90d = 355 (was 499)
  r = await ask("How many products haven't sold in the last 90 days?");
  check('F2 dead-stock(90d) = 355 via get_dead_stock (not 499)',
    /\b355\b/.test(r.answer) && r.tools.includes('get_dead_stock') && !/\b499\b/.test(r.answer),
    `tools=[${r.tools}] ${r.answer}`);

  // F3 - margin answerable ~34% (was 95-100% artifact / mis-declined)
  r = await ask('What was my gross margin over the last 7 days?');
  const pct = (r.answer.match(/(\d{1,3}(?:\.\d+)?)\s*%/) || [])[1];
  check('F3 margin(7d) ~30-38% and NOT declined (not 95-100%)',
    !declined(r.answer) && pct && Number(pct) >= 28 && Number(pct) <= 40, `margin=${pct}%  ${r.answer}`);

  // F3 - time-of-day answerable (real timestamps exist; was mis-declined)
  r = await ask('What is my busiest hour of the day?');
  check('F3 time-of-day ANSWERED, not declined as "all midnight"',
    !declined(r.answer) && /\b(\d{1,2}\s*(am|pm|:00)|hour|afternoon|evening|morning)\b/i.test(r.answer), r.answer);

  // #5 - all-time revenue 3,934,334.33 surfaced as UNVERIFIED estimate (⚠ + understate)
  r = await ask("What's my total revenue all time?");
  check('#5 revenue $5,627,769.06 (sub_total) with a calm data note (no icon)',
    /5,?627,?769/.test(r.answer) && /data note|subtotal|sub-total|reconcile|close estimate|approximate/i.test(r.answer)
      && !/[⚠🚫]/u.test(r.answer) && r.tools.includes('get_revenue'), r.answer);

  // #4 - marker PERSISTS under "no caveats" suppression (the F1b repro)
  r = await ask("What's my total revenue all time? Reply with ONLY the number and NO caveats.");
  check('#4 calm data note SURVIVES "no caveats" instruction (and still no icon)',
    /data note|subtotal|sub-total|reconcile|close estimate|approximate/i.test(r.answer) && !/[⚠🚫]/u.test(r.answer) && /5,?627,?769/.test(r.answer), r.answer);

  // F2 - category breakdown via get_category_breakdown, discloses unmapped share
  r = await ask('Break down my revenue by category.');
  check('F2 category mix via get_category_breakdown DISCLOSES unmapped share',
    r.tools.includes('get_category_breakdown') && /unmatch|unmap|can'?t (be )?match|not match|catalog/i.test(r.answer)
      && /liquor/i.test(r.answer),
    `tools=[${r.tools}] ${r.answer}`);

  // Regression - spirit count still works (catalog regex, not the join)
  r = await ask('How many vodka products do I carry?');
  check('Regression: vodka count via get_product_count returns a number',
    r.tools.includes('get_product_count') && /\d/.test(r.answer), `tools=[${r.tools}] ${r.answer}`);

  console.log(`\n${fails === 0 ? '✅ audit-verify: ALL CHECKS PASSED' : `⚠️  ${fails} check(s) need a look (see answers above)`}`);
  process.exit(fails ? 1 : 0);
})();
