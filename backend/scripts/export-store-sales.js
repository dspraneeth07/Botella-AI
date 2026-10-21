#!/usr/bin/env node
/**
 * Export one store's sale_items to the .csv.gz shape the backtest loader reads.
 *
 *   node scripts/export-store-sales.js --locations 44,51,173,194 --out ../audit-14/data
 *
 * WHY THIS IS A SCRIPT AND NOT A psql ONE-LINER
 *   The loader is strict about three things and a hand-rolled COPY gets them
 *   wrong in ways that look like "the store has no sales" rather than like an
 *   error: the header names must match exactly, `sale_date` must be a bare date
 *   (the column is a timestamp and Postgres renders a timezone offset that
 *   `strptime("%Y-%m-%d")` then truncates to the WRONG DAY either side of
 *   midnight), and `item_status` must survive because the loader skips every row
 *   that is not 'Sold'.
 *
 * STREAMED, NOT BUFFERED. Local Vine alone is 741,639 rows; materialising that
 * as a JS array before writing is how an export of a real store runs the heap
 * out on a laptop.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Pool } = require('pg');
const QueryStream = require('pg-query-stream');
require('dotenv').config();

const COLS = ['sale_date', 'sku', 'product_name', 'category', 'upc',
  'quantity', 'price', 'cost', 'item_status'];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** CSV field: quote only when needed, double any embedded quote. */
function cell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The DATE, with no timezone applied.
 *
 * `sale_date` is `timestamp without time zone`, and node-postgres hands it back
 * as a JS Date in LOCAL time. Calling toISOString() on that shifts it by the
 * machine's offset - on a +05:30 box every sale lands on the previous day, which
 * silently moves a third of a month's cards into the wrong window.
 */
function day(v) {
  if (!v) return '';
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

async function exportOne(pool, locationId, outDir) {
  const file = path.join(outDir, `store_${locationId}_sale_items.csv.gz`);
  const gzip = zlib.createGzip();
  const out = fs.createWriteStream(file);
  gzip.pipe(out);
  gzip.write(COLS.join(',') + '\n');

  const client = await pool.connect();
  let rows = 0;
  try {
    const q = new QueryStream(
      `SELECT sale_date, sku, product_name, category, upc,
              quantity, price, cost, item_status
         FROM sale_items
        WHERE location_id = $1
        ORDER BY sale_date`,
      [locationId], { batchSize: 2000 }
    );
    const stream = client.query(q);
    for await (const r of stream) {
      rows += 1;
      gzip.write([
        day(r.sale_date), cell(r.sku), cell(r.product_name), cell(r.category),
        cell(r.upc), cell(r.quantity), cell(r.price), cell(r.cost),
        cell(r.item_status),
      ].join(',') + '\n');
    }
  } finally {
    client.release();
  }
  await new Promise((res, rej) => {
    out.on('finish', res); out.on('error', rej); gzip.end();
  });
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`  ${String(locationId).padStart(4)}  ${String(rows).padStart(8)} rows  ${String(kb).padStart(7)} KB  ${path.basename(file)}`);
  return rows;
}

(async () => {
  const locations = (arg('locations') || '').split(',')
    .map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
  const outDir = path.resolve(arg('out', '../audit-14/data'));
  if (!locations.length) {
    console.error('usage: --locations 44,51,173 [--out DIR]');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const pool = new Pool({
    host: process.env.PG_HOST, port: process.env.PG_PORT,
    database: process.env.PG_DATABASE, user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    ssl: { rejectUnauthorized: false }, max: 2,
  });
  console.log(`exporting ${locations.length} store(s) to ${outDir}`);
  let total = 0;
  for (const loc of locations) total += await exportOne(pool, loc, outDir);
  console.log(`  ${total.toLocaleString()} rows total`);
  await pool.end();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
