#!/usr/bin/env node
/*
  fixfinal-verify.js - verify the revenue-switch + round-3 residual fixes (Zeke's 46).
  Start: ...BOTELLA_ALLOW_RUNSQL_WITHOUT_RLS=true node server.js ; then node tests/fixfinal-verify.js
*/
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { JWT_SECRET } = require('../middleware/auth');
const API = process.env.EVAL_API_BASE || 'http://127.0.0.1:3100/api';
const token = jwt.sign({ user_id: 'audit', client_id: 46, location_id: 46 }, JWT_SECRET, { expiresIn: '1h' });

async function ask(message, history = []) {
  const res = await fetch(`${API}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, history, conversation_id: 'ff-' + Math.random().toString(36).slice(2) }),
  });
  const raw = await res.text();
  let a = '', ev = [];
  for (const l of raw.split('\n')) { if (!l.startsWith('data: ')) continue;
    try { const e = JSON.parse(l.slice(6)); if (e.type === 'delta') a += e.text || ''; if (e.type === 'clear') a = ''; if (e.type === 'done' && e.eval) ev = e.eval.evidence || []; } catch {} }
  return { a: a.split('<<FOLLOWUPS>>')[0].trim(), tools: ev.map(x => x.tool) };
}
let fails = 0;
const check = (label, cond, r) => { console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) { console.log(`         ↳ tools=[${r.tools}] ${r.a.replace(/\s+/g, ' ').slice(0, 150)}`); fails++; } };

(async () => {
  console.log('\n══ Revenue switch + round-3 residual fixes - Zeke\'s (46) ══\n');

  console.log('- Fix 0: revenue on sub_total basis -');
  let r = await ask("What's my all-time revenue?");
  check('all-time = $5,627,769.06 + ⚠️ (sub_total), not the old $3.93M',
    /5,?627,?769/.test(r.a) && /⚠/.test(r.a) && !/3,?934,?334/.test(r.a), r);
  r = await ask("What were my sales today?");
  check("today = $1,467.76 via get_sales_on_day", /1,?467\.76/.test(r.a) && r.tools.includes('get_sales_on_day'), r);

  console.log('\n- Fix 1: bare month → most recent occurrence ≤ MAX -');
  r = await ask('What were my total sales in April?');
  check('"in April" → April 2026 $97,159.66 (NOT 2025)', /97,?159/.test(r.a) && !/114,?734/.test(r.a) && !/75,?49/.test(r.a), r);
  r = await ask('How did I do in June?');
  check('"in June" → June 2025 (most recent June ≤ May 2026)', /2025|june 2025/i.test(r.a) && !/june 2026|2026-06/i.test(r.a), r);

  console.log('\n- Fix 2: heavy all-time tool returns correct (single-user) -');
  r = await ask('What is my gross margin all time?');
  check('all-time margin ~36% via get_margin (no 365-day re-window)', /3[0-9](\.\d+)?\s*%/.test(r.a) && r.tools.includes('get_margin'), r);

  console.log('\n- Fix 3: items per basket = units per transaction -');
  r = await ask('What are my items per basket today?');
  check('items per basket = 2.54 (units/txn, not line-items 1.49)', /2\.5\d/.test(r.a) && !/1\.49/.test(r.a), r);

  console.log('\n- Fix 4: hold the figure under pushback (3-turn) -');
  const h = [];
  r = await ask('How much revenue did I make last month?', h);
  const t1 = r.a; h.push({ role: 'user', text: 'How much revenue did I make last month?' }, { role: 'assistant', text: t1 });
  r = await ask("Are you sure? I think it was over $100k.", h);
  h.push({ role: 'user', text: "Are you sure? I think it was over $100k." }, { role: 'assistant', text: r.a });
  r = await ask('So what is your final answer?', h);
  check('holds $97,159 across pushback (does not jump to $179k line-item)',
    /97,?159/.test(r.a) && !/179,?\d{3}/.test(r.a), r);

  console.log(`\n${fails === 0 ? '✅ fixfinal-verify: ALL PASSED' : `⚠️  ${fails} need a look`}`);
  process.exit(fails ? 1 : 0);
})();
