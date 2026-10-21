#!/usr/bin/env node
/**
 * Supplier lead times: defaults flagged as defaults, measured from receipts.
 *
 * The reorder quantity rests on a delivery lead time, and that lead time was
 * seven days declared in three places and measurable in none - nothing in
 * either database recorded when an order ARRIVED. Migration 037 adds
 * `purchase_orders.received_date`; `leadTimeService` turns receipts into one
 * row per vendor with its provenance.
 *
 * What is easy to get wrong, and what this pins:
 *
 *   ONE RECEIPT IS AN ANECDOTE. A vendor with fewer than the minimum number
 *   of receipts must get a DEFAULT row, flagged as such - not a "measured"
 *   row resting on one data point, and not no row at all (absence must keep
 *   meaning "nobody has looked").
 *
 *   THE INVOICE DATE IS USUALLY THE DELIVERY DATE. received - invoice reads
 *   zero on most invoices and says nothing about the wait. po_date wins when
 *   present, and a zero gap is not an observation.
 *
 *   ONE SPELLING RULE. "Glazer's Beer & Beverage" and "GLAZERS BEER AND
 *   BEVERAGE" are one vendor here exactly as they are to the duplicate check.
 *
 *   AN OWNER'S DATE SURVIVES A RE-PARSE. A re-parse that did not see a
 *   received date on the page must not erase the one the owner typed.
 *
 * Needs the local analytics DB (backend/.env) at migration 037. Seeds a
 * sentinel tenant and removes it afterwards.
 *
 * Run:  node tests/lead-time-verify.js
 */

require('dotenv').config();

const { getAnalyticsPool } = require('../database/analytics-connection');
const lead = require('../services/leadTimeService');
const po = require('../services/purchaseOrderService');

const CID = 999916;
const LID = 999916;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ── The arithmetic, without a database ──────────────────────────────────────

console.log('\n-- computeLeadTimes: the rule, in isolation ----------------');

const doc = (id, vendor, { po_date = null, invoice_date = null, received_date = null } = {}) =>
  ({ id, vendor_name: vendor, po_date, invoice_date, received_date });

{
  const rows = [
    doc(1, "Glazer's Beer & Beverage", { po_date: '2026-03-02', received_date: '2026-03-06' }), // 4
    doc(2, 'GLAZERS BEER AND BEVERAGE', { po_date: '2026-04-06', received_date: '2026-04-09' }), // 3
    doc(3, 'Glazers Beer  &  Beverage,', { po_date: '2026-05-04', received_date: '2026-05-13' }), // 9
    doc(4, 'Glazers Beer & Beverage',    { po_date: '2026-06-01', received_date: '2026-06-05' }), // 4
  ];
  const out = lead.computeLeadTimes(rows, { defaultDays: 7, minObservations: 3 });
  check('1  four spellings of one vendor fold into one row', out.length === 1, `${out.length} rows`);
  const g = out[0];
  check('2  ...keyed by the duplicate check\'s own normaliser',
    g && g.vendor_key === po.normaliseVendor("Glazer's Beer & Beverage"), g && g.vendor_key);
  check('3  the median of 3,4,4,9 is 4 - the 9 does not drag it',
    g && g.lead_time_days === 4, g && String(g.lead_time_days));
  check('4  and it is MEASURED, on four receipts, with its window',
    g && g.source === 'measured' && g.observations === 4
      && g.measured_from === '2026-03-06' && g.measured_to === '2026-06-05',
    g && JSON.stringify(g));
  check('5  the most recent spelling is kept for display',
    g && g.vendor_name === 'Glazers Beer & Beverage', g && g.vendor_name);
}

{
  const rows = [
    doc(1, 'Breakthru', { po_date: '2026-05-01', received_date: '2026-05-04' }),
    doc(2, 'Breakthru', { po_date: '2026-05-08', received_date: '2026-05-11' }),
  ];
  const out = lead.computeLeadTimes(rows, { defaultDays: 7, minObservations: 3 });
  const b = out[0];
  check('6  two receipts is below the minimum: a DEFAULT row, not a measured one',
    b && b.source === 'default' && b.lead_time_days === 7 && b.observations === 0,
    b && JSON.stringify(b));
  check('7  ...and the row EXISTS, so "default" and "never seen" differ',
    out.length === 1);
}

{
  const rows = [
    // Invoice cut on delivery day: a zero gap, not a wait that was observed.
    doc(1, 'RNDC', { invoice_date: '2026-05-04', received_date: '2026-05-04' }),
    doc(2, 'RNDC', { invoice_date: '2026-05-11', received_date: '2026-05-11' }),
    doc(3, 'RNDC', { invoice_date: '2026-05-18', received_date: '2026-05-18' }),
    // po_date present: it wins over invoice_date.
    doc(4, 'RNDC', { po_date: '2026-06-01', invoice_date: '2026-06-05', received_date: '2026-06-05' }),
    doc(5, 'RNDC', { po_date: '2026-06-08', invoice_date: '2026-06-12', received_date: '2026-06-12' }),
    doc(6, 'RNDC', { po_date: '2026-06-15', invoice_date: '2026-06-20', received_date: '2026-06-20' }),
    // A typo: received before ordered.
    doc(7, 'RNDC', { po_date: '2026-06-22', received_date: '2026-06-02' }),
    // No receipt date at all.
    doc(8, 'RNDC', { po_date: '2026-06-29' }),
  ];
  const out = lead.computeLeadTimes(rows, { defaultDays: 7, minObservations: 3 });
  const r = out[0];
  check('8  zero gaps, negative gaps and missing receipts are not observations',
    r && r.observations === 3, r && String(r.observations));
  check('9  po_date is subtracted when present (4,4,5 -> median 4)',
    r && r.lead_time_days === 4 && r.source === 'measured', r && JSON.stringify(r));
}

{
  const rows = [doc(1, null, { po_date: '2026-06-01', received_date: '2026-06-05' }),
    doc(2, '  ', { po_date: '2026-06-01', received_date: '2026-06-05' })];
  check('10 a document with no vendor name contributes nothing',
    lead.computeLeadTimes(rows).length === 0);
  check('11 the median of an even count is the mean of the middle pair',
    lead.median([1, 2, 10, 11]) === 6 && lead.median([5]) === 5);
}

// ── Against the database ─────────────────────────────────────────────────────

(async () => {
  const pool = getAnalyticsPool();

  async function cleanup() {
    await pool.query('DELETE FROM supplier_lead_times WHERE client_id = $1 AND location_id = $2', [CID, LID]);
    // Items cascade from the order.
    await pool.query('DELETE FROM purchase_orders WHERE client_id = $1 AND location_id = $2', [CID, LID]);
  }

  console.log('\n-- The table and the column exist (migration 037) --------');
  const { rows: cols } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'purchase_orders' AND column_name = 'received_date'`);
  check('12 purchase_orders.received_date exists', cols.length === 1,
    'run: npm run migrate --prefix backend');
  const { rows: tbl } = await pool.query(`SELECT to_regclass('supplier_lead_times') AS t`);
  check('13 supplier_lead_times exists', tbl[0] && tbl[0].t !== null);
  if (!cols.length || !tbl[0] || tbl[0].t === null) {
    console.log('\n  Migration 037 is not applied; nothing further to verify.');
    await pool.end();
    process.exit(1);
  }

  try {
    await cleanup();

    console.log('\n-- Seed: one vendor with receipts, one without -----------');
    const file = { name: 'x.pdf', mime: 'application/pdf', size: 1, path: `${CID}-${LID}/x.pdf` };
    const mk = async (vendor, { poDate, receivedDate, invoiceDate = null, items = [] }) => {
      const id = await po.createParsing(pool, { clientId: CID, locationId: LID, file, uploadedBy: 'verify', sha: null });
      await po.saveParsed(pool, id, CID, LID, {
        payload: { docType: 'invoice', vendorName: vendor, invoiceNo: `V-${id}`,
          poDate, invoiceDate, receivedDate, items },
        model: 'verify', confidence: 1, ms: 1,
      });
      return id;
    };

    // Four receipts from Glazer's: 4, 3, 9, 4 days -> median 4.
    const g1 = await mk("Glazer's Beer & Beverage", { poDate: '2026-03-02', receivedDate: '2026-03-06',
      items: [{ lineNo: 1, productName: 'Modelo 12pk', quantity: 3 }] });
    await mk('GLAZERS BEER AND BEVERAGE', { poDate: '2026-04-06', receivedDate: '2026-04-09' });
    await mk('Glazers Beer & Beverage', { poDate: '2026-05-04', receivedDate: '2026-05-13' });
    await mk('Glazers Beer & Beverage', { poDate: '2026-06-01', receivedDate: '2026-06-05' });
    // One receipt from Breakthru - below the minimum.
    const b1 = await mk('Breakthru Beverage', { poDate: '2026-06-01', receivedDate: '2026-06-03',
      items: [{ lineNo: 1, productName: 'Titos 750ml', quantity: 6 }] });
    // Southern: documents, no receipts at all.
    await mk('Southern Glazers', { poDate: '2026-06-10', receivedDate: null });

    const { rows: [saved] } = await pool.query(
      'SELECT received_date::text AS d FROM purchase_orders WHERE id = $1', [g1]);
    check('14 saveParsed persists the parser\'s receivedDate', saved && saved.d === '2026-03-06', saved && saved.d);

    // The `deliveryDate` alias - the word on a delivery note.
    const aliasId = await po.createParsing(pool, { clientId: CID, locationId: LID, file, uploadedBy: 'verify', sha: null });
    await po.saveParsed(pool, aliasId, CID, LID, {
      payload: { docType: 'invoice', vendorName: 'Alias Co', invoiceNo: 'A-1',
        poDate: '2026-06-01', deliveryDate: '2026-06-04', items: [] },
      model: 'verify', confidence: 1, ms: 1,
    });
    const { rows: [alias] } = await pool.query(
      'SELECT received_date::text AS d FROM purchase_orders WHERE id = $1', [aliasId]);
    check('15 ...and accepts deliveryDate as an alias', alias && alias.d === '2026-06-04', alias && alias.d);

    console.log('\n-- An owner\'s date survives a re-parse ------------------');
    await pool.query('UPDATE purchase_orders SET received_date = $2 WHERE id = $1', [b1, '2026-06-03']);
    await po.saveParsed(pool, b1, CID, LID, {
      payload: { docType: 'invoice', vendorName: 'Breakthru Beverage', invoiceNo: `V-${b1}`,
        poDate: '2026-06-01', receivedDate: null,
        // The lines are re-written by a re-parse; keep the one the SKU map
        // test below links.
        items: [{ lineNo: 1, productName: 'Titos 750ml', quantity: 6 }] },
      model: 'verify', confidence: 1, ms: 1,
    });
    const { rows: [kept] } = await pool.query(
      'SELECT received_date::text AS d FROM purchase_orders WHERE id = $1', [b1]);
    check('16 a re-parse that saw no receipt date leaves the owner\'s in place',
      kept && kept.d === '2026-06-03', kept && kept.d);

    console.log('\n-- refreshLeadTimes writes one row per vendor ------------');
    const r = await lead.refreshLeadTimes(pool, CID, LID);
    check('17 refresh ran and counted its rows',
      r.skipped === false && r.vendors === 4 && r.measured === 1, JSON.stringify(r));

    const got = await lead.getLeadTimes(pool, CID, LID);
    const gKey = po.normaliseVendor("Glazer's Beer & Beverage");
    const bKey = po.normaliseVendor('Breakthru Beverage');
    const sKey = po.normaliseVendor('Southern Glazers');
    check('18 Glazer\'s is measured: median 4 over 4 receipts',
      got[gKey] && got[gKey].source === 'measured' && got[gKey].lead_time_days === 4
        && got[gKey].observations === 4, JSON.stringify(got[gKey]));
    check('19 ...with the window it was measured over',
      got[gKey] && got[gKey].measured_from === '2026-03-06' && got[gKey].measured_to === '2026-06-05',
      JSON.stringify(got[gKey]));
    check('20 Breakthru (one receipt) is a DEFAULT row at the declared default',
      got[bKey] && got[bKey].source === 'default'
        && got[bKey].lead_time_days === lead.LEAD_TIME_DEFAULT_DAYS && got[bKey].observations === 0,
      JSON.stringify(got[bKey]));
    check('21 Southern (no receipts) is a DEFAULT row too - present, flagged',
      got[sKey] && got[sKey].source === 'default', JSON.stringify(got[sKey]));
    check('22 a vendor nobody has seen is ABSENT, not defaulted',
      got[po.normaliseVendor('Nobody Ever')] === undefined);

    console.log('\n-- The SKU map uses the same key space -------------------');
    await pool.query(
      `UPDATE purchase_order_items SET matched_sku = 'MODELO12' WHERE purchase_order_id = $1`, [g1]);
    await pool.query(
      `UPDATE purchase_order_items SET matched_sku = 'TITOS750' WHERE purchase_order_id = $1`, [b1]);
    // No syncgo pool: explicit links only, which is the honest floor.
    const skus = await lead.getSkuVendorMap(pool, null, CID, LID);
    check('23 an explicitly linked SKU maps to its vendor_key',
      skus.MODELO12 === gKey && skus.TITOS750 === bKey, JSON.stringify(skus));
    check('24 ...and that key resolves in the vendor map, so Python can join them',
      got[skus.MODELO12] !== undefined && got[skus.MODELO12].source === 'measured');

    console.log('\n-- Re-running replaces rather than accumulates -----------');
    await pool.query('DELETE FROM purchase_orders WHERE client_id = $1 AND location_id = $2 AND vendor_name = $3',
      [CID, LID, 'Southern Glazers']);
    await lead.refreshLeadTimes(pool, CID, LID);
    const again = await lead.getLeadTimes(pool, CID, LID);
    check('25 a vendor no longer on any document drops out', again[sKey] === undefined);
    check('26 and the others are unchanged', again[gKey] && again[gKey].lead_time_days === 4);

    console.log('\n-- Tenant isolation ---------------------------------------');
    const other = await lead.getLeadTimes(pool, CID, LID + 1);
    check('27 a sibling location sees none of it', Object.keys(other).length === 0);
  } finally {
    await cleanup();
    await pool.end();
  }

  console.log('');
  console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('threw:', e); process.exit(1); });
