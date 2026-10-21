#!/usr/bin/env node
/* eslint-disable no-console */
// -----------------------------------------------------------------------------
// clean-purchase-orders.js - make the PO list presentable without inventing data.
//
// A demo tenant accumulates upload debris: files the parser could not read,
// the same invoice uploaded three times while someone retried, and totals that
// came back negative. None of that is a product defect the audience needs to
// see, and none of it is worth hand-deleting row by row.
//
// DRY RUN BY DEFAULT. It prints exactly what it would remove and changes
// nothing. Pass --apply to commit. Nothing here is reversible, so the report is
// the point: read it, then decide.
//
//   node scripts/clean-purchase-orders.js                 # report only
//   node scripts/clean-purchase-orders.js --apply         # actually delete
//   node scripts/clean-purchase-orders.js --apply --client 171
//
// What it removes, in order:
//
//   1. FAILED PARSES - status <> 'parsed'. A row the parser never read carries
//      no invoice number, no vendor and no lines; it exists only to say a file
//      was rejected. Keeping a handful is honest, keeping eleven is noise.
//
//   2. DUPLICATE INVOICES - same (client, location, invoice_no), keeping the
//      row with the MOST LINE ITEMS, and the newest as the tiebreak. Newest-wins
//      is the obvious rule and it is wrong here: a retry often parses worse than
//      the attempt before it, so picking by line count keeps the best copy
//      rather than the last one. Rows with no invoice_no are never treated as
//      duplicates of each other - a null is not a match.
//
//   3. NEGATIVE TOTALS - invoice_total < 0. Usually a credit note the parser
//      read as an invoice. Reported and removed only with --include-negative,
//      because on a real tenant a credit note is data, not debris.
//
// Line items and events go with the document: purchase_order_items and
// purchase_order_events are deleted first in the same transaction, so a failed
// run leaves nothing half-removed. FK cascade is not assumed.
// -----------------------------------------------------------------------------

require('dotenv').config();
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const INCLUDE_NEGATIVE = process.argv.includes('--include-negative');
const clientArg = (() => {
  const i = process.argv.indexOf('--client');
  return i > -1 && process.argv[i + 1] ? parseInt(process.argv[i + 1], 10) : null;
})();

const pool = new Pool({
  host: process.env.ANALYTICS_PG_HOST || process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.ANALYTICS_PG_PORT || '5432', 10),
  database: process.env.ANALYTICS_PG_DATABASE || 'bottleai_analytics',
  user: process.env.ANALYTICS_PG_USER || process.env.PG_USER,
  password: process.env.ANALYTICS_PG_PASSWORD || process.env.PG_PASSWORD,
  statement_timeout: 60000,
});

const scope = clientArg ? 'AND po.client_id = $1' : '';
const params = clientArg ? [clientArg] : [];

async function main() {
  const { rows: [{ n: total }] } = await pool.query(
    `SELECT count(*)::int n FROM purchase_orders po WHERE true ${scope}`, params);
  console.log(`\npurchase_orders in scope: ${total}${clientArg ? ` (client ${clientArg})` : ''}`);
  if (!total) { console.log('Nothing to do.'); return; }

  const byStatus = await pool.query(
    `SELECT status, count(*)::int n FROM purchase_orders po WHERE true ${scope}
      GROUP BY 1 ORDER BY 2 DESC`, params);
  console.log('\nby status:');
  byStatus.rows.forEach((r) => console.log(`  ${String(r.n).padStart(4)}  ${r.status}`));

  // ---- 1. failed parses -----------------------------------------------------
  const failed = await pool.query(
    `SELECT po.id, po.status, po.file_name, left(coalesce(po.parse_error,''), 60) AS err
       FROM purchase_orders po WHERE po.status <> 'parsed' ${scope} ORDER BY po.id`, params);

  // ---- 2. duplicate invoice numbers ----------------------------------------
  // Rank within each (client, location, invoice_no): most line items first,
  // newest as the tiebreak. Everything after rank 1 goes.
  const dupes = await pool.query(
    `WITH ranked AS (
       SELECT po.id, po.invoice_no, po.client_id, po.location_id, po.invoice_total,
              (SELECT count(*) FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS lines,
              row_number() OVER (
                PARTITION BY po.client_id, po.location_id, po.invoice_no
                ORDER BY (SELECT count(*) FROM purchase_order_items i WHERE i.purchase_order_id = po.id) DESC,
                         po.created_at DESC, po.id DESC) AS rn,
              count(*) OVER (PARTITION BY po.client_id, po.location_id, po.invoice_no) AS copies
         FROM purchase_orders po
        WHERE po.status = 'parsed'
          AND po.invoice_no IS NOT NULL AND btrim(po.invoice_no) <> ''
          ${scope}
     )
     SELECT id, invoice_no, lines, copies, rn FROM ranked WHERE rn > 1 ORDER BY invoice_no, rn`,
    params);

  // ---- 3. negative totals ---------------------------------------------------
  const negative = await pool.query(
    `SELECT po.id, po.invoice_no, po.invoice_total
       FROM purchase_orders po
      WHERE po.invoice_total IS NOT NULL AND po.invoice_total < 0 ${scope}
      ORDER BY po.id`, params);

  const report = (title, rows, fmt) => {
    console.log(`\n${title}: ${rows.length}`);
    rows.slice(0, 15).forEach((r) => console.log('  ' + fmt(r)));
    if (rows.length > 15) console.log(`  ... and ${rows.length - 15} more`);
  };
  report('failed parses', failed.rows,
    (r) => `#${r.id}  ${r.status.padEnd(10)} ${(r.file_name || '(no file)').slice(0, 34)}  ${r.err}`);
  report('duplicate copies (keeping the fullest of each)', dupes.rows,
    (r) => `#${r.id}  invoice ${String(r.invoice_no).padEnd(16)} ${r.lines} lines  (copy ${r.rn} of ${r.copies})`);
  report(`negative totals${INCLUDE_NEGATIVE ? '' : '  [reported only - pass --include-negative to remove]'}`,
    negative.rows, (r) => `#${r.id}  invoice ${String(r.invoice_no || '-').padEnd(16)} ${r.invoice_total}`);

  const ids = [
    ...failed.rows.map((r) => r.id),
    ...dupes.rows.map((r) => r.id),
    ...(INCLUDE_NEGATIVE ? negative.rows.map((r) => r.id) : []),
  ];
  const unique = [...new Set(ids.map(String))];

  console.log(`\n${'-'.repeat(64)}`);
  console.log(`would remove ${unique.length} of ${total} documents, leaving ${total - unique.length}`);

  if (!unique.length) { console.log('Nothing to remove.'); return; }
  if (!APPLY) {
    console.log('\nDRY RUN - nothing changed. Re-run with --apply to commit.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Children first: the FK is not assumed to cascade, and a half-deleted
    // document is worse than either outcome.
    const del = async (sql) => (await client.query(sql, [unique])).rowCount;
    const ev = await del('DELETE FROM purchase_order_events WHERE purchase_order_id = ANY($1::bigint[])')
      .catch(() => 0); // table may not exist on an older estate
    const it = await del('DELETE FROM purchase_order_items WHERE purchase_order_id = ANY($1::bigint[])');
    const po = await del('DELETE FROM purchase_orders WHERE id = ANY($1::bigint[])');
    await client.query('COMMIT');
    console.log(`\nremoved: ${po} documents, ${it} line items, ${ev} events`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nFAILED - rolled back, nothing changed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

main()
  .catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
