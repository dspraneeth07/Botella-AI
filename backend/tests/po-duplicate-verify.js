#!/usr/bin/env node
/**
 * The same invoice must not appear on the list twice.
 *
 * Migration 013 added a sha256 of the uploaded bytes, and it works - for a
 * BYTE-IDENTICAL file. The reported defect is the case it cannot see: the same
 * invoice re-scanned, re-exported from an email client, or re-saved by a PDF
 * viewer has different bytes and identical identity, so it arrived as a second
 * full document, parsed again and listed as though the store had bought the
 * goods twice.
 *
 * Two holes, and this pins both:
 *
 *   IDENTITY   (vendor, invoice_no) recognised after the parse, because
 *              neither field exists before it.
 *   THE RACE   two uploads of one file arriving together both pass the
 *              pre-insert check and both insert; 013's index is deliberately
 *              not unique, so nothing downstream stops them.
 *
 * Run:  node tests/po-duplicate-verify.js
 */

const svc = require('../services/purchaseOrderService');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ── A pool that answers from a tiny in-memory table ─────────────────────────
// Deliberately not a mock that returns a fixed row: the normalisation is the
// thing under test, so the fake has to apply the same SQL-side normalisation
// the real query does, in JavaScript, and disagree if they ever diverge.
function fakePool(rows, { noColumn = false } = {}) {
  return {
    queries: [],
    async query(sql, params = []) {
      this.queries.push(sql);
      if (noColumn) {
        const e = new Error('column "duplicate_of" does not exist');
        e.code = '42703';
        throw e;
      }
      if (/information_schema\.columns/.test(sql)) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (/UPDATE purchase_orders SET duplicate_of/.test(sql)) {
        const [id, dup] = params;
        const row = rows.find((r) => r.id === id);
        if (row) row.duplicate_of = dup;
        return { rows: [] };
      }
      // findEarlierByContent
      if (/AND id < \$4/.test(sql)) {
        const [c, l, sha, id] = params;
        const hit = rows
          .filter((r) => r.client_id === c && r.location_id === l
            && r.content_sha256 === sha && r.id < id && r.duplicate_of == null)
          .sort((a, b) => a.id - b.id)[0];
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      // findDuplicateByIdentity — the query narrows by VENDOR only; the
      // invoice-number rule lives in JS so it exists once. The fake therefore
      // filters on vendor alone, exactly as the real SQL does, and leaves the
      // invoice comparison to the code under test.
      if (/regexp_replace/.test(sql)) {
        const [c, l, id, vendor] = params;
        return {
          rows: rows
            .filter((r) => r.client_id === c && r.location_id === l
              && r.id !== id && r.duplicate_of == null
              && r.invoice_no && r.vendor_name
              && svc.normaliseVendor(r.vendor_name) === vendor)
            .sort((a, b) => a.id - b.id),
        };
      }
      return { rows: [] };
    },
  };
}

const T = { c: 171, l: 171 };
const row = (id, vendor, invoice, sha, duplicate_of = null) => ({
  id, client_id: T.c, location_id: T.l, vendor_name: vendor,
  invoice_no: invoice, content_sha256: sha, duplicate_of, status: 'parsed',
});

(async () => {
  console.log('\nNORMALISATION — one vendor, one invoice, many spellings');

  check('vendor punctuation and case collapse',
    svc.normaliseVendor("Glazer's Beer & Beverage")
      === svc.normaliseVendor('GLAZERS BEER AND BEVERAGE'));
  check('vendor ampersand equals "and"',
    svc.normaliseVendor('A & B') === svc.normaliseVendor('A and B'));
  check('different vendors stay different',
    svc.normaliseVendor('Glazers') !== svc.normaliseVendor('Southern Glazers'));
  check('invoice prefixes and punctuation collapse',
    svc.normaliseInvoiceNo('INV-1578334') === svc.normaliseInvoiceNo('#1578334'));
  check('leading zeros are KEPT — 001 and 1 are different documents',
    svc.normaliseInvoiceNo('001') !== svc.normaliseInvoiceNo('1'));
  check('empty stays empty', svc.normaliseVendor(null) === ''
    && svc.normaliseInvoiceNo(undefined) === '');

  console.log('\nIDENTITY — the case the content hash cannot see');

  {
    const rows = [row(1, "Glazer's Beer & Beverage", 'INV-1578334', 'aaa')];
    const pool = fakePool(rows);
    // Same invoice, re-scanned: different bytes, different file name.
    const dup = await svc.findDuplicateByIdentity(pool, T.c, T.l, {
      id: 2, vendorName: 'GLAZERS BEER AND BEVERAGE', invoiceNo: '1578334',
    });
    check('a re-scan of the same invoice is recognised', dup && dup.id === 1,
      dup ? `matched ${dup.id}` : 'no match');
  }

  {
    const rows = [row(1, 'Glazers', 'INV-1', 'aaa')];
    const dup = await svc.findDuplicateByIdentity(fakePool(rows), T.c, T.l, {
      id: 2, vendorName: 'Glazers', invoiceNo: 'INV-2',
    });
    check('a DIFFERENT invoice from the same vendor is not a duplicate', dup === null);
  }

  {
    const rows = [row(1, 'Glazers', 'INV-1', 'aaa')];
    const dup = await svc.findDuplicateByIdentity(fakePool(rows), T.c, T.l, {
      id: 2, vendorName: 'Breakthru', invoiceNo: 'INV-1',
    });
    check('the same number from a DIFFERENT vendor is not a duplicate', dup === null);
  }

  {
    // Two failed parses both have no invoice number. Matching them would merge
    // documents that have nothing in common but their own failure.
    const rows = [row(1, 'Glazers', null, 'aaa')];
    const dup = await svc.findDuplicateByIdentity(fakePool(rows), T.c, T.l, {
      id: 2, vendorName: 'Glazers', invoiceNo: null,
    });
    check('a missing invoice number NEVER matches', dup === null);
  }

  {
    const rows = [row(1, 'Glazers', 'INV-1', 'aaa'), row(2, 'Glazers', 'INV-1', 'bbb', 1)];
    const dup = await svc.findDuplicateByIdentity(fakePool(rows), T.c, T.l, {
      id: 3, vendorName: 'Glazers', invoiceNo: 'INV-1',
    });
    check('a third copy points at the ORIGINAL, not at the second copy',
      dup && dup.id === 1, dup ? `matched ${dup.id}` : 'no match');
  }

  {
    const rows = [row(1, 'Glazers', 'INV-1', 'aaa')];
    const other = { ...rows[0] };
    other.client_id = 999;
    const dup = await svc.findDuplicateByIdentity(fakePool([other]), T.c, T.l, {
      id: 2, vendorName: 'Glazers', invoiceNo: 'INV-1',
    });
    check('another tenant\'s invoice is never a duplicate of ours', dup === null);
  }

  console.log('\nTHE RACE — two uploads of one file arriving together');

  {
    const rows = [row(1, null, null, 'same-bytes'), row(2, null, null, 'same-bytes')];
    const pool = fakePool(rows);
    const earlier = await svc.findEarlierByContent(pool, T.c, T.l, 'same-bytes', 2);
    check('the later insert finds the earlier one', earlier && earlier.id === 1);
    await svc.markDuplicate(pool, 2, earlier.id);
    check('and retires itself', rows[1].duplicate_of === 1);

    const first = await svc.findEarlierByContent(pool, T.c, T.l, 'same-bytes', 1);
    check('the winner finds nothing earlier and stays', first === null);
  }

  {
    const rows = [row(5, null, null, 'x'), row(9, null, null, 'x')];
    const pool = fakePool(rows);
    const a = await svc.findEarlierByContent(pool, T.c, T.l, 'x', 9);
    const b = await svc.findEarlierByContent(pool, T.c, T.l, 'x', 5);
    check('both rows agree which is the original — no mutual hiding',
      a && a.id === 5 && b === null);
  }

  console.log('\nDEGRADING — an estate that has not run migration 021');

  {
    const pool = fakePool([], { noColumn: true });
    const dup = await svc.findDuplicateByIdentity(pool, T.c, T.l, {
      id: 2, vendorName: 'Glazers', invoiceNo: 'INV-1',
    });
    check('a missing column returns null rather than throwing', dup === null);
    const marked = await svc.markDuplicate(pool, 2, 1);
    check('marking degrades to false rather than throwing', marked === false);
    const earlier = await svc.findEarlierByContent(pool, T.c, T.l, 'x', 2);
    check('the race check degrades too', earlier === null);
  }

  console.log('');
  if (failures) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('ALL CHECKS PASSED');
})().catch((e) => { console.error('threw:', e); process.exit(1); });
