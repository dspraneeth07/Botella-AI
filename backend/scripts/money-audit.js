#!/usr/bin/env node
/**
 * The money audit, on demand - one page per store answering "are they losing
 * money on any recommendation?" card by card (services/moneyAuditService.js).
 *
 *   node scripts/money-audit.js                                  # the three asking stores
 *   node scripts/money-audit.js --stores 171:171,173:173,188:188
 *   node scripts/money-audit.js --since-days 90 --out ../audit/money
 *
 * For each store it writes, under the out directory (default audit/money):
 *
 *     MONEY_AUDIT_<location>_<YYYY-MM-DD>.html   the summary and one row per
 *                                                card, losses first, each with
 *                                                its reason
 *     MONEY_AUDIT_<location>_<YYYY-MM-DD>.json   the same figures
 *     INDEX.html                                 every audit in the folder
 *
 * and prints one line per store. Read-only against the analytics database.
 *
 * NOT SCHEDULED. server.js is being edited elsewhere, so this is run by hand
 * (or by whatever wires it after review) rather than appended to the 05:00
 * evaluation's tail. `runMoneyAudits` is exported for exactly that wiring.
 *
 * THE DEFAULT STORES are the three the product owner asked about, not the
 * pilot five: 171 Bethany Discount Liquor, 173 Tuscany, 188 Grapes and Grains.
 * client_id == location_id for all three (as for the pilot stores -
 * scripts/pilot-scoreboard.js). A store with no cards still gets a page: "no
 * recommendation to lose money on" is an answer, and a different one from
 * "not audited".
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { getAnalyticsPool } = require('../database/analytics-connection');
const audit = require('../services/moneyAuditService');

const ASKING_STORES = '171:171,173:173,188:188';
const STORE_NAMES = {
  '171:171': 'Bethany Discount Liquor',
  '173:173': 'Tuscany',
  '188:188': 'Grapes and Grains',
};

function parseStores(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('refused: no stores named');
  return text.split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [c, l] = pair.split(':').map((n) => parseInt(n, 10));
    if (!Number.isInteger(c) || !Number.isInteger(l)) {
      throw new Error(`refused: "${pair}" is not client:location`);
    }
    return { clientId: c, locationId: l, name: STORE_NAMES[`${c}:${l}`] || null };
  });
}

function parseArgs(argv) {
  const args = { stores: null, out: null, sinceDays: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stores') args.stores = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--since-days') args.sinceDays = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log('usage: money-audit.js [--stores c:l,...] [--out <dir>] [--since-days N]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (args.sinceDays !== null && !(Number.isInteger(args.sinceDays) && args.sinceDays > 0)) {
    throw new Error('refused: --since-days must be a positive integer');
  }
  return args;
}

const DEFAULT_OUT = path.join(__dirname, '..', '..', 'audit', 'money');

/**
 * Run the audit for a list of stores and write the pages. Never throws for one
 * store's failure; returns the per-store results with the summary lines.
 */
async function runMoneyAudits(analyticsPool, {
  stores = parseStores(ASKING_STORES),
  sinceDays = audit.DEFAULT_SINCE_DAYS,
  outDir = DEFAULT_OUT,
  log = console.log,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const results = [];
  for (const { clientId, locationId, name } of stores) {
    try {
      const report = await audit.moneyAudit(analyticsPool, clientId, locationId, { sinceDays, storeName: name });
      const base = path.join(outDir, `MONEY_AUDIT_${locationId}_${day}`);
      fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
      fs.writeFileSync(`${base}.html`, audit.renderMoneyAuditHtml(report));
      const line = audit.summaryLine(report);
      log(`${line} -> ${base}.html`);
      results.push({ clientId, locationId, ok: true, line, report, written: `${base}.html` });
    } catch (err) {
      log(`${clientId}:${locationId}: FAILED - ${err.message}`);
      results.push({ clientId, locationId, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * One index over every audit in the folder, rebuilt from the JSON on disk:
 * one row per store per day, newest first, with the summary line and the links.
 */
function writeIndex(outDir) {
  const files = fs.readdirSync(outDir)
    .filter((f) => /^MONEY_AUDIT_\d+_\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const rows = files.map((f) => {
    const report = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
    return { base: f.replace(/\.json$/, ''), report };
  }).sort((x, y) => (y.report.generated_at < x.report.generated_at ? -1 : 1)
    || (x.report.store.location_id - y.report.store.location_id));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tr = ({ base, report }) => {
    const s = report.summary;
    const v = s.verdicts;
    const ll = s.largest_loss;
    return `<tr><td>${esc(report.store.name || report.store.location_id)}</td><td>${report.store.location_id}</td>`
      + `<td>${esc(report.generated_at.slice(0, 10))}</td><td>${s.cards_shown}</td><td>${s.confirmed}</td><td>${s.closed}</td>`
      + `<td class="${v.lost_money ? 'bad' : ''}">${v.lost_money}</td><td class="${v.made_money ? 'good' : ''}">${v.made_money}</td>`
      + `<td>${v.exposure_unconfirmed}</td><td>${v.window_open}</td><td>${v.unmeasurable}</td>`
      + `<td>${s.realised_net.sum == null ? 'n/a' : `${s.realised_net.sum < 0 ? '-' : '+'}$${Math.abs(s.realised_net.sum).toFixed(2)} over ${s.realised_net.cards}`}</td>`
      + `<td>${ll.amount == null ? 'none' : `${ll.bounded ? '&ge; ' : ''}-$${Math.abs(ll.amount).toFixed(2)} (card ${ll.rec_id}, ${esc(ll.sku)})`}</td>`
      + `<td><a href="${base}.html">page</a> · <a href="${base}.json">json</a></td></tr>`;
  };
  const html = `<!doctype html><meta charset="utf-8"><title>Money audits</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#1a1713;background:#fbfaf7}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #dfdad0;vertical-align:top}
th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6f675b}.bad{color:#be123c;font-weight:600}.good{color:#047857;font-weight:600}
p{max-width:80ch}</style>
<h1>Money audits</h1>
<p>One row per store per run. "Lost" counts only cards the owner is CONFIRMED to have bought on whose net
(incremental margin minus the holding cost of unsold units) came out negative after a closed window; a card nobody
acted on cannot lose the store money. "Unconfirmed" cards have a net but no established purchase, and are attributed
neither way. There is no estate line on purpose.</p>
<table><thead><tr><th>Store</th><th>Loc</th><th>Run</th><th>Shown</th><th>Confirmed</th><th>Closed</th><th>Lost</th><th>Made</th>
<th>Unconfirmed</th><th>Open</th><th>Unmeasurable</th><th>Net (closed, confirmed)</th><th>Largest loss</th><th>Open</th></tr></thead>
<tbody>${rows.map(tr).join('\n')}</tbody></table>
<p>Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC from the JSON beside each page. Run by hand: <code>node scripts/money-audit.js</code> (backend/).</p>`;
  fs.writeFileSync(path.join(outDir, 'INDEX.html'), html);
  return rows.length;
}

if (require.main === module) {
  (async () => {
    let args;
    try {
      args = parseArgs(process.argv.slice(2));
    } catch (err) {
      console.error(err.message);
      process.exit(2);
    }
    const pool = getAnalyticsPool();
    try {
      const outDir = args.out ? path.resolve(args.out) : DEFAULT_OUT;
      const results = await runMoneyAudits(pool, {
        stores: parseStores(args.stores || ASKING_STORES),
        sinceDays: args.sinceDays || audit.DEFAULT_SINCE_DAYS,
        outDir,
      });
      const failed = results.filter((r) => !r.ok).length;
      console.log(`index: ${writeIndex(outDir)} audit(s) listed in ${path.join(outDir, 'INDEX.html')}`);
      console.log(`${results.length - failed} of ${results.length} store(s) written`);
      process.exit(failed ? 1 : 0);
    } catch (err) {
      console.error(err.message);
      process.exit(2);
    } finally {
      await pool.end().catch(() => {});
    }
  })();
}

module.exports = { ASKING_STORES, STORE_NAMES, parseStores, runMoneyAudits, writeIndex };
