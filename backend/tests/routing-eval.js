#!/usr/bin/env node
/*
  Routing-precision eval - measures the #1 residual risk directly.

  46 questions the gate has NEVER used: 8 fresh phrasings per metric (40)
  + 6 negative controls (questions with NO covering metric, which must fall
  through to run_sql to be answered correctly).

  Scoring per positive case:
    STRICT  - routed to the expected canonical tool
    OK      - routed to an acceptable sibling (listed per case: e.g. a single
              named day answered via get_revenue(start=end) is equally
              canonical and equally deterministic)
    MISS    - fell through to run_sql (improvised SQL on a covered question)
              or routed to a wrong metric tool
  Negative controls pass when run_sql WAS used (a metric tool alone cannot
  answer them); metric calls alongside run_sql are fine.

  Run backend first:
    EVAL_PORT=3100 BOTELLA_READ_ONLY_DB=true DISABLE_CHAT_ANALYTICS=true \
      BOTELLA_EVAL_MODE=true npm start
  Then:
    node tests/routing-eval.js
*/
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { JWT_SECRET } = require('../middleware/auth');

const API_BASE = process.env.EVAL_API_BASE || 'http://127.0.0.1:3100/api';
const CLIENT_ID = Number(process.env.EVAL_CLIENT_ID || 125);
const LOCATION_ID = Number(process.env.EVAL_LOCATION_ID || 125);

const token = jwt.sign({
  user_id: 'eval-readonly', username: 'eval-readonly',
  client_id: CLIENT_ID, location_id: LOCATION_ID,
  client_name: 'Route 106 Wine & Spirits', location_name: 'Route 106 Wine & Spirits',
}, JWT_SECRET, { expiresIn: '4h' });

async function ask(question) {
  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: question, history: [], conversation_id: 'route-' + Math.random().toString(36).slice(2) }),
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
  return { answer: answer.split('<<FOLLOWUPS>>')[0], tools: evidence.map(e => e.tool) };
}

const METRICS = new Set(['get_revenue', 'get_transaction_count', 'get_sales_on_day', 'get_dead_stock', 'get_product_count']);

// 8 fresh phrasings per metric - none reused from the spike gate.
const POSITIVE = [
  // get_revenue
  { q: 'How much money did I make last month?', expect: 'get_revenue' },
  { q: 'What were my total sales for May 2026?', expect: 'get_revenue' },
  { q: 'Revenue for the last 30 days?', expect: 'get_revenue' },
  { q: 'How did the store do this month?', expect: 'get_revenue', ok: ['get_transaction_count', 'get_sales_on_day'] },
  { q: "What's my all-time revenue?", expect: 'get_revenue' },
  { q: 'Sales between March 1 and March 15, 2026?', expect: 'get_revenue' },
  { q: 'How much did the store bring in yesterday?', expect: 'get_revenue', ok: ['get_sales_on_day'] },
  { q: 'whats my revenue today', expect: 'get_revenue', ok: ['get_sales_on_day'] },
  // get_transaction_count
  { q: 'How many sales did I ring up yesterday?', expect: 'get_transaction_count', ok: ['get_revenue', 'get_sales_on_day'] },
  { q: 'Number of transactions this month?', expect: 'get_transaction_count', ok: ['get_revenue'] },
  { q: 'How many receipts did I have last week?', expect: 'get_transaction_count', ok: ['get_revenue'] },
  { q: 'Total number of sales in April 2026?', expect: 'get_transaction_count', ok: ['get_revenue'] },
  { q: 'How many transactions have I done all time?', expect: 'get_transaction_count', ok: ['get_revenue'] },
  { q: 'Transaction count for 2025?', expect: 'get_transaction_count', ok: ['get_revenue'] },
  { q: 'How many purchases were made in the last 30 days?', expect: 'get_transaction_count', ok: ['get_revenue'] },
  { q: 'How many times did customers check out in May 2026?', expect: 'get_transaction_count', ok: ['get_revenue'] },
  // get_sales_on_day
  { q: 'What did I sell on March 15, 2026?', expect: 'get_sales_on_day', ok: ['get_revenue'] },
  { q: 'Revenue on my very first day of business?', expect: 'get_sales_on_day' },
  { q: 'How were sales on Christmas Eve 2025?', expect: 'get_sales_on_day', ok: ['get_revenue'] },
  { q: 'What did the store do on 2026-05-04?', expect: 'get_sales_on_day', ok: ['get_revenue'] },
  { q: "My latest day's numbers?", expect: 'get_sales_on_day', ok: ['get_revenue'] },
  { q: 'How much did I make on the last day on record?', expect: 'get_sales_on_day', ok: ['get_revenue'] },
  { q: 'Sales for June 1, 2026 please', expect: 'get_sales_on_day', ok: ['get_revenue'] },
  { q: 'Show me my opening day numbers', expect: 'get_sales_on_day' },
  // get_dead_stock
  { q: "What inventory hasn't sold in 90 days?", expect: 'get_dead_stock' },
  { q: 'Which products are sitting on my shelves not moving?', expect: 'get_dead_stock' },
  { q: 'Show me my dead stock', expect: 'get_dead_stock' },
  { q: "What items haven't sold in the last 6 months?", expect: 'get_dead_stock' },
  { q: "What's not selling at all?", expect: 'get_dead_stock' },
  { q: 'Give me a stale inventory report', expect: 'get_dead_stock' },
  { q: "Which bottles haven't moved in 90 days?", expect: 'get_dead_stock' },
  { q: 'Do I have items that just sit there and never sell?', expect: 'get_dead_stock' },
  // get_product_count
  { q: 'How many tequila products do I have?', expect: 'get_product_count' },
  { q: 'Do I carry any mezcal?', expect: 'get_product_count' },
  { q: 'How many wines do I have in stock right now?', expect: 'get_product_count' },
  { q: 'Count of rum products in my catalog?', expect: 'get_product_count' },
  { q: 'How many gins do I carry?', expect: 'get_product_count' },
  { q: 'How many whiskey products are in my store?', expect: 'get_product_count' },
  { q: 'Do I stock scotch?', expect: 'get_product_count' },
  { q: 'How many different beers do I carry?', expect: 'get_product_count' },
];

// Questions NO metric covers - must use run_sql to answer correctly.
const NEGATIVE = [
  { q: 'Who is my top customer this year?' },
  { q: 'What were my top 10 products by revenue last month?' },
  { q: 'Compare weekday vs weekend sales for May 2026' },
  { q: 'Break down my revenue by category' },
  { q: 'Which day of the week is my busiest?' },
  { q: 'List my low-stock items' },
];

async function main() {
  let strict = 0, okPass = 0, miss = 0;
  const misses = [];

  console.log('== Positive cases (40 fresh phrasings, 8 per metric) ==');
  for (const c of POSITIVE) {
    const a = await ask(c.q);
    const acceptable = [c.expect, ...(c.ok || [])];
    let verdict;
    if (a.tools.includes(c.expect)) { verdict = 'STRICT'; strict++; }
    else if (a.tools.some(t => acceptable.includes(t))) { verdict = 'OK  '; okPass++; }
    else { verdict = 'MISS'; miss++; misses.push({ q: c.q, tools: a.tools, expected: c.expect }); }
    console.log(`${verdict}  [${c.expect}]  "${c.q}"  → ${JSON.stringify(a.tools)}`);
  }

  console.log('\n== Negative controls (no covering metric - run_sql required) ==');
  let negPass = 0;
  const negFails = [];
  for (const c of NEGATIVE) {
    const a = await ask(c.q);
    const usedSql = a.tools.includes('run_sql');
    if (usedSql) negPass++; else negFails.push({ q: c.q, tools: a.tools });
    console.log(`${usedSql ? 'PASS' : 'FAIL'}  "${c.q}"  → ${JSON.stringify(a.tools)}`);
  }

  const n = POSITIVE.length;
  console.log(`\n${'='.repeat(64)}`);
  console.log(`ROUTING PRECISION (n=${n} positive):`);
  console.log(`  Strict (exact canonical tool):      ${strict}/${n}  (${(strict / n * 100).toFixed(1)}%)`);
  console.log(`  Acceptable (canonical or sibling):  ${strict + okPass}/${n}  (${((strict + okPass) / n * 100).toFixed(1)}%)`);
  console.log(`  Missed to fallback / wrong tool:    ${miss}/${n}  (${(miss / n * 100).toFixed(1)}%)`);
  console.log(`NEGATIVE CONTROLS: ${negPass}/${NEGATIVE.length} correctly used run_sql`);
  if (misses.length) {
    console.log('\nMis-routed phrasings:');
    misses.forEach(m => console.log(`  - "${m.q}" expected ${m.expected}, got ${JSON.stringify(m.tools)}`));
  }
  if (negFails.length) {
    console.log('\nNegative-control failures:');
    negFails.forEach(m => console.log(`  - "${m.q}" got ${JSON.stringify(m.tools)}`));
  }
  process.exit(miss === 0 && negFails.length === 0 ? 0 : 1);
}

main().catch(e => { console.error('Harness error:', e); process.exit(2); });
