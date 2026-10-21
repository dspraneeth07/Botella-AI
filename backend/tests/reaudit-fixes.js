#!/usr/bin/env node
/*
  reaudit-fixes.js - verify the 11 re-audit fixes for Zeke's (client 46).
  Start the bot with BOTELLA_ALLOW_RUNSQL_WITHOUT_RLS=true (C3 uses run_sql), then:
    node tests/reaudit-fixes.js
  Frozen data → exact expected values.
*/
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { JWT_SECRET } = require('../middleware/auth');
const API = process.env.EVAL_API_BASE || 'http://127.0.0.1:3100/api';
const token = jwt.sign({ user_id: 'audit', client_id: 46, location_id: 46 }, JWT_SECRET, { expiresIn: '1h' });

async function ask(message) {
  const res = await fetch(`${API}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, history: [], conversation_id: 'rf-' + Math.random().toString(36).slice(2) }),
  });
  const raw = await res.text();
  let a = '', ev = [];
  for (const l of raw.split('\n')) {
    if (!l.startsWith('data: ')) continue;
    try { const e = JSON.parse(l.slice(6)); if (e.type === 'delta') a += e.text || ''; if (e.type === 'clear') a = ''; if (e.type === 'done' && e.eval) ev = e.eval.evidence || []; } catch {}
  }
  return { a: a.split('<<FOLLOWUPS>>')[0].trim(), tools: ev.map(x => x.tool) };
}
const timedOut = (s) => /timed out|time out|unable to retrieve|couldn'?t (pull|retrieve|compute)|too large/i.test(s);
let fails = 0;
const check = (label, cond, r) => {
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) { console.log(`         ↳ tools=[${r.tools}] ${r.a.replace(/\s+/g, ' ').slice(0, 140)}`); fails++; }
};

(async () => {
  console.log('\n══ Re-audit 11-fix verification - Zeke\'s (client 46) ══\n');
  console.log('- Cluster 1: calendar windows -');
  let r;
  r = await ask('How much revenue did I make last month?');
  check('#6 revenue last month = $97,159.66 sub_total (not $57,705 old basis)', /97,?159/.test(r.a) && !/57,?705/.test(r.a), r);
  r = await ask('How many transactions did I have last month?');
  check('#22 transactions last month = 1,372 (not 1,240)', /1,?372/.test(r.a) && !/1,?240/.test(r.a), r);
  r = await ask('What was my best selling product last month?');
  check('#35 best seller last month = Chamisul ~$5,170 (de-duped per DQ-01; was inflated $9,460)', /chamisul/i.test(r.a) && /5,?1\d\d/.test(r.a) && !/9,?460/.test(r.a), r);
  r = await ask("What's my revenue this year?");
  check('#7 revenue this year = $436,791.56 sub_total (2026 YTD)', /436,?791/.test(r.a) && !/265,?965/.test(r.a), r);
  r = await ask('How many orders did I have this week?');
  check('#144 orders this week = 93 (not 295)', /\b93\b/.test(r.a) && !/\b295\b/.test(r.a), r);

  console.log('\n- Cluster 2: margin (no timeout) -');
  r = await ask("What's my gross margin this month?");
  check('#59 margin this month ~33.96% (no timeout)', !timedOut(r.a) && /3[34]\.\d/.test(r.a) && r.tools.includes('get_margin'), r);
  r = await ask('What gross margin do I make on whiskey?');
  check('#167 whiskey margin = a real % (no timeout)', !timedOut(r.a) && /\d{1,2}(\.\d+)?\s*%/.test(r.a) && r.tools.includes('get_margin'), r);
  r = await ask('What do I make per dollar of sales?');
  check('#153 all-time margin computes (no timeout)', !timedOut(r.a) && /\d{1,2}(\.\d+)?\s*%/.test(r.a), r);

  console.log('\n- Cluster 3: arithmetic + basis -');
  r = await ask('What are my items per transaction today?');
  check('#159 items/transaction = 2.54 (not 2.00)', /2\.5\d/.test(r.a) && !/\b2\.0+\b/.test(r.a), r);
  r = await ask('What was my single best day ever by revenue?');
  check('#160 best day = Oct 6 2023 / $18,193 (sub_total basis)', /2023-10-06|october 6,? 2023|oct 6,? 2023/i.test(r.a) && /18,?193/.test(r.a), r);

  console.log('\n- Do-not-regress spot checks -');
  r = await ask('What is my all-time revenue?');
  check('all-time revenue = $5,627,769.06 sub_total + calm data note (no icon)', /5,?627,?769/.test(r.a) && /data note|reconcile|subtotal|close estimate|approximate/i.test(r.a) && !/[⚠🚫]/u.test(r.a), r);
  r = await ask('How many dead stock items do I have?');
  check('dead-stock still 355 via get_dead_stock', /\b355\b/.test(r.a) && r.tools.includes('get_dead_stock'), r);

  console.log(`\n${fails === 0 ? '✅ reaudit-fixes: ALL PASSED' : `⚠️  ${fails} need a look`}`);
  process.exit(fails ? 1 : 0);
})();
