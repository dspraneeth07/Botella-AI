#!/usr/bin/env node
/**
 * The pilot's monthly scoreboards - five GOOD stores, two boards kept apart,
 * one line per product.
 *
 *   node scripts/pilot-scoreboard.js                      # previous month, the five pilot stores
 *   node scripts/pilot-scoreboard.js --month 2026-09      # a named month
 *   node scripts/pilot-scoreboard.js --stores 171:171,176:176
 *   node scripts/pilot-scoreboard.js --out ../audit --dry-run
 *
 * For each store: build both boards (services/pilotScoreboardService.js),
 * upsert the row in pilot_scoreboards (036), and write the offline pair the
 * audit folder keeps per store per month, next to the ledgers:
 *
 *     audit/scoreboard-<location>-<YYYY-MM>/scoreboard.json
 *     audit/scoreboard-<location>-<YYYY-MM>/SCOREBOARD.html
 *
 * --dry-run builds and prints the summary lines, writes nothing - no row, no
 * file.
 *
 * FIVE STORES BY DEFAULT, AND "ALL" MEANS EVERY STORE, SEPARATELY. The
 * requirement names five GOOD stores, and the default is those five.
 * `--stores ALL` writes a board for EVERY store that has ever been issued a
 * card - one board per store, never a pooled one, so the "whole estate says"
 * mistake the checklist exists to prevent cannot happen here: there is no
 * estate line to quote. A store outside the pilot five is labelled
 * `pilot_store: false` in its JSON and "(not a pilot store)" in the summary
 * line, because a board over a store that was never gated as good is a board
 * over an ungated engine, and the reader has to be told which kind they are
 * holding. PILOT_SCOREBOARD_LOCATIONS renames the default list.
 *
 * The month defaults to the PREVIOUS calendar month, because the first of the
 * month is when the cron runs it (server.js, PILOT_SCOREBOARD_CRON_SCHEDULE)
 * and the current month has nothing closed in it yet.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { getAnalyticsPool } = require('../database/analytics-connection');
const scoreboard = require('../services/pilotScoreboardService');

// ─── The five pilot stores, in ONE place ────────────────────────────────────
//
// client_id == location_id for all five - confirmed against syncgo
// client_locations and the local analytics tables (and assumed by the audit
// publish scripts). audit/all_stores.json names the same five.
//
//   171  Bethany Discount Liquor, Allen TX
//   176  Northlake Liquors, North Palm Beach
//   177  Mango Jo's Bar & Liquors
//   178  Marshfield Wine & Spirits
//   181  Cork Runner Wine & Spirits, CA
const PILOT_STORES = '171:171,176:176,177:177,178:178,181:181';

function parseStores(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  // ALL is resolved against the database by runScoreboards, because the list
  // of stores that have cards is a fact of the table, not of this file.
  if (text.toUpperCase() === 'ALL') return 'ALL';
  const stores = text.split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [c, l] = pair.split(':').map((n) => parseInt(n, 10));
    if (!Number.isInteger(c) || !Number.isInteger(l)) {
      throw new Error(`refused: "${pair}" is not client:location`);
    }
    return { clientId: c, locationId: l };
  });
  if (!stores.length) throw new Error('refused: no stores named');
  return stores;
}

function parseArgs(argv) {
  const args = { month: null, stores: null, out: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--month') args.month = argv[++i];
    else if (a === '--stores') args.stores = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: pilot-scoreboard.js [--month YYYY-MM] [--stores c:l,...] [--out <dir>] [--dry-run]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/**
 * Run the scoreboards for a list of stores. Exported so the cron in server.js
 * runs the same code path the command line does; it returns the per-store
 * summary lines and the failures, and never throws for one store's failure.
 */
async function runScoreboards(analyticsPool, {
  month = scoreboard.previousMonth(),
  stores = parseStores(process.env.PILOT_SCOREBOARD_LOCATIONS || PILOT_STORES),
  outDir = path.join(__dirname, '..', '..', 'audit'),
  dryRun = false,
  syncgoPool = undefined,
  log = console.log,
} = {}) {
  const pilot = new Set(parseStores(PILOT_STORES).map((s) => `${s.clientId}:${s.locationId}`));
  if (stores === 'ALL') {
    // Every store that has ever been issued a card. A store with cards and no
    // closed window this month still gets a board - all refusals, with the
    // reasons - because "nothing measurable yet" is a different statement
    // from "not reported".
    const { rows } = await analyticsPool.query(
      'SELECT DISTINCT client_id, location_id FROM recommendations ORDER BY 1, 2'
    );
    stores = rows.map((r) => ({ clientId: r.client_id, locationId: r.location_id }));
    log(`ALL: ${stores.length} store(s) have been issued cards; `
      + `${stores.filter((s) => pilot.has(`${s.clientId}:${s.locationId}`)).length} of them are pilot stores`);
  }
  const results = [];
  for (const { clientId, locationId } of stores) {
    try {
      const board = await scoreboard.buildScoreboard(
        analyticsPool, clientId, locationId, month, syncgoPool === undefined ? {} : { syncgoPool }
      );
      board.pilot_store = pilot.has(`${clientId}:${locationId}`);
      const line = scoreboard.summaryLine(board)
        + (board.pilot_store ? '' : ' (not a pilot store)');
      let written = null;
      if (!dryRun) {
        await scoreboard.saveScoreboard(analyticsPool, board);
        const dir = path.join(outDir, `scoreboard-${locationId}-${month}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'scoreboard.json'), JSON.stringify(board, null, 2));
        fs.writeFileSync(path.join(dir, 'SCOREBOARD.html'), scoreboard.renderScoreboardHtml(board));
        written = dir;
      }
      log(`${dryRun ? '[dry-run] ' : ''}${line}${written ? ` -> ${written}` : ''}`);
      results.push({ clientId, locationId, ok: true, line, written, board });
    } catch (err) {
      log(`${clientId}:${locationId} ${month}: FAILED - ${err.message}`);
      results.push({ clientId, locationId, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * One index over every board in the audit folder, so "all stores" is a page
 * and not a directory listing. Rebuilt from the JSON on disk after every run:
 * one row per store per month, the summary line, pilot or not, and the links.
 * Sorted pilot stores first, then by location, then month descending.
 */
function writeIndex(outDir) {
  const dirs = fs.readdirSync(outDir)
    .filter((d) => /^scoreboard-\d+-\d{4}-\d{2}$/.test(d)
      && fs.existsSync(path.join(outDir, d, 'scoreboard.json')));
  const rows = dirs.map((d) => {
    const board = JSON.parse(fs.readFileSync(path.join(outDir, d, 'scoreboard.json'), 'utf8'));
    return { dir: d, board };
  }).sort((x, y) => (Number(Boolean(y.board.pilot_store)) - Number(Boolean(x.board.pilot_store)))
    || (x.board.store.location_id - y.board.store.location_id)
    || (y.board.month < x.board.month ? -1 : 1));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tr = ({ dir, board }) => {
    const a = board.accuracy.summary || {};
    const h = (board.holdout.summary || {}).difference || {};
    const hit = a.hit_rate == null ? 'not measurable'
      : `${Math.round(a.hit_rate * 100)}% [${Math.round(a.hit_rate_interval_95.low * 100)}-${Math.round(a.hit_rate_interval_95.high * 100)}%] on ${a.measured_on} of ${a.cards}`;
    const diff = h.dollars_per_product != null ? `$${h.dollars_per_product.toFixed(2)} per product`
      : (h.lift != null ? `lift ${h.lift > 0 ? '+' : ''}${h.lift}` : `refused: ${esc(h.refused_reason || 'no data')}`);
    return `<tr${board.pilot_store ? '' : ' class="np"'}><td>${esc(board.store.name || board.store.location_id)}</td>`
      + `<td>${board.store.location_id}</td><td>${board.pilot_store ? 'pilot' : 'not a pilot store'}</td>`
      + `<td>${esc(board.month)}</td><td>${hit}</td><td>${a.products || 0}</td><td>${diff}</td>`
      + `<td><a href="${dir}/SCOREBOARD.html">page</a> · <a href="${dir}/scoreboard.json">json</a></td></tr>`;
  };
  const html = `<!doctype html><meta charset="utf-8"><title>Scoreboards, every store</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#1a1713;background:#fbfaf7}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #dfdad0;vertical-align:top}
th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6f675b}tr.np td{color:#6f675b}
p{max-width:76ch}</style>
<h1>Scoreboards, every store</h1>
<p>One row per store per month. Board A (prediction accuracy) and Board B (holdout money) are on each store's page,
kept separate. There is no estate line on purpose: the boards are per store, and a pooled figure would be the
"whole estate says" number the checklist exists to prevent. Stores outside the five-store pilot are greyed and
labelled; their engine was never gated as good.</p>
<table><thead><tr><th>Store</th><th>Loc</th><th>Pilot</th><th>Month</th><th>Board A · hit rate (30-day, Wilson 95%)</th><th>Products</th><th>Board B · holdout difference</th><th>Open</th></tr></thead>
<tbody>${rows.map(tr).join('\n')}</tbody></table>
<p>Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC from the JSON beside each page.</p>`;
  fs.writeFileSync(path.join(outDir, 'SCOREBOARDS.html'), html);
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
      const results = await runScoreboards(pool, {
        month: args.month || scoreboard.previousMonth(),
        stores: parseStores(args.stores || process.env.PILOT_SCOREBOARD_LOCATIONS || PILOT_STORES),
        outDir: args.out ? path.resolve(args.out) : undefined,
        dryRun: args.dryRun,
      });
      const failed = results.filter((r) => !r.ok).length;
      if (!args.dryRun) {
        const outDir = args.out ? path.resolve(args.out) : path.join(__dirname, '..', '..', 'audit');
        console.log(`index: ${writeIndex(outDir)} board(s) listed in ${path.join(outDir, 'SCOREBOARDS.html')}`);
      }
      console.log(`${results.length - failed} of ${results.length} store(s) ${args.dryRun ? 'built' : 'written'}`);
      process.exit(failed ? 1 : 0);
    } catch (err) {
      console.error(err.message);
      process.exit(2);
    } finally {
      await pool.end().catch(() => {});
    }
  })();
}

module.exports = { PILOT_STORES, parseStores, runScoreboards, writeIndex };
