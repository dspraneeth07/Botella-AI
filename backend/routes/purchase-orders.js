/**
 * Purchase Orders / Invoices - upload, read, correct, export.
 *
 * Mounted behind verifyToken + attachPool, so `req.user` carries the tenant and
 * `req.pool` is the syncgo (POS mirror) pool. Our own rows live in the
 * analytics pool; the two are never interchangeable - see
 * services/purchaseOrderService.js.
 *
 * House rule: every query filters on BOTH client_id AND location_id.
 */

const router = require('express').Router();
const fs = require('fs');
const multer = require('multer');
const logger = require('../utils/logger');
const { getAnalyticsPool } = require('../database/analytics-connection');
const svc = require('../services/purchaseOrderService');

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB - a scanned multi-page invoice
const ACCEPTED = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ACCEPTED.has(file.mimetype)) {
      return cb(new Error('Upload a PDF or a photo (PNG, JPEG or WebP) of the document.'));
    }
    cb(null, true);
  },
});

const tenant = (req) => ({ clientId: req.user.client_id, locationId: req.user.location_id });
// Who is acting, for the activity trail. Null rather than a placeholder when the
// token carries no name: the log distinguishes a person from the system by the
// absence of an actor, and "unknown" would blur the two.
const actorOf = (req) => (req.user && (req.user.username || req.user.email)) || null;
const fail = (res, status, message) => res.status(status).json({ error: message });

/**
 * Answer a failed query with something the reader can act on.
 *
 * Postgres 42P01 is undefined_table, and for this feature it means one thing:
 * the analytics migrations have not been run against this machine's database.
 * Reporting that as "Could not load your documents" sends people to look for a
 * bug in the documents, which is the one place the problem is not. The server
 * now applies pending migrations at boot outside production, so this should be
 * unreachable - but if it is ever reached again, it should say what it is.
 */
const failQuery = (res, err, fallback) => {
  if (err && err.code === '42P01') {
    return fail(res, 503,
      'The purchase-order tables are missing from the analytics database on this machine. '
      + 'Run: npm run migrate --prefix backend');
  }
  return fail(res, 500, fallback);
};

/** A stored row, flattened into the shape the UI reads. */
function toApi(row) {
  return {
    id: String(row.id),
    docType: row.doc_type,
    status: row.status,
    // Present so a caller that asked for duplicates can tell which they are,
    // and so opening one by id can say what it duplicates rather than looking
    // like an ordinary document that mysteriously left the list.
    duplicateOf: row.duplicate_of != null ? String(row.duplicate_of) : null,
    parseError: row.parse_error,
    vendorName: row.vendor_name,
    accountNo: row.account_no,
    invoiceNo: row.invoice_no,
    invoiceDate: row.invoice_date,
    dueDate: row.due_date,
    poNumber: row.po_number,
    poDate: row.po_date,
    // When the goods arrived (migration 037). Null means unknown - most
    // invoices do not say - and it is the one date a lead time is measured
    // from, so the owner can set it below. Undefined on an estate without 037.
    receivedDate: row.received_date === undefined ? undefined : (row.received_date ?? null),
    currency: row.currency,
    subtotal: row.subtotal != null ? Number(row.subtotal) : null,
    taxTotal: row.tax_total != null ? Number(row.tax_total) : null,
    discountTotal: row.discount_total != null ? Number(row.discount_total) : null,
    deliveryTotal: row.delivery_total != null ? Number(row.delivery_total) : null,
    invoiceTotal: row.invoice_total != null ? Number(row.invoice_total) : null,
    notes: row.notes,
    fileName: row.file_name,
    fileMime: row.file_mime,
    fileSize: row.file_size,
    parseConfidence: row.parse_confidence != null ? Number(row.parse_confidence) : null,
    // The list query computes item_count in SQL; the detail path counts the
    // rows it already loaded. Reading only the SQL alias left the detail
    // response with itemCount: undefined, which the UI renders as
    // "3 of  lines".
    itemCount: row.item_count != null ? Number(row.item_count)
      : (Array.isArray(row.items) ? row.items.length : undefined),
    // How many lines are matched to a POS SKU. The list computes it in SQL; the
    // detail path already holds the items, so count those. Undefined rather
    // than 0 when neither is available, so the UI can tell "none mapped" from
    // "not known yet" instead of showing a confident zero.
    mappedCount: row.mapped_count != null ? Number(row.mapped_count)
      : (Array.isArray(row.items) ? row.items.filter((i) => i.matched_sku).length : undefined),
    createdAt: row.created_at,
  };
}

function itemToApi(it) {
  return {
    id: String(it.id),
    lineNo: it.line_no,
    productNo: it.product_no,
    productName: it.product_name,
    upc: it.upc,
    productVolume: it.product_volume,
    pack: it.pack,
    uom: it.uom,
    quantity: it.quantity != null ? Number(it.quantity) : null,
    cost: it.cost != null ? Number(it.cost) : null,
    discountAmt: it.discount_amt != null ? Number(it.discount_amt) : null,
    taxAmt: it.tax_amt != null ? Number(it.tax_amt) : null,
    depositAmt: it.deposit_amt != null ? Number(it.deposit_amt) : null,
    extPrice: it.ext_price != null ? Number(it.ext_price) : null,
    note: it.note,
    match: it.match,
    // Near-miss candidates for an unmatched line. Proposals only - the exact
    // matcher is unchanged, and nothing here is applied without a click.
    suggestions: it.suggestions || [],
  };
}

/* ── POST /upload ─────────────────────────────────────────────────────────────
   The parse runs INLINE, not on a queue. It takes a few seconds and the owner
   is watching the upload; a queue would mean building a job table, a poller and
   a progress UI to hide latency the user is already waiting through. The row is
   written as 'parsing' first, so a crash mid-parse leaves a visible failed row
   rather than a silent nothing. */
router.post('/upload', (req, res) => {
  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const msg = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? 'That file is larger than 20MB. Try a lower-resolution scan.'
        : uploadErr.message || 'Upload failed.';
      return fail(res, 400, msg);
    }
    if (!req.file) return fail(res, 400, 'No file was attached.');

    const { clientId, locationId } = tenant(req);
    const pool = getAnalyticsPool();
    let id = null;

    // Already read this exact document? Hand back the one we have rather than
    // parsing and listing a second copy. Matched on CONTENT: the same invoice
    // reaches us under several names, and the demo list carried invoice 1578334
    // three times over, identical vendor, date and total.
    //
    // This does NOT block the file. A re-upload is usually an accident, but not
    // always - a parse that went wrong is legitimately worth retrying - so the
    // response names the existing document and the caller decides. "Parse
    // again" on that row is the supported way to re-read it, and it corrects
    // the row in place instead of adding a rival to it.
    const sha = svc.contentHash(req.file.buffer);
    try {
      const existing = await svc.findByContent(pool, clientId, locationId, sha);
      if (existing) {
        logger.info('[PO] duplicate upload ignored', { id: existing.id, clientId, locationId });
        return res.status(200).json({
          duplicate: true,
          id: existing.id,
          invoiceNo: existing.invoice_no,
          vendorName: existing.vendor_name,
          fileName: existing.file_name,
          status: existing.status,
          uploadedOn: existing.uploaded_on,
          message: `This document is already on your list${existing.invoice_no ? ` as invoice ${existing.invoice_no}` : ''}`
            + `${existing.uploaded_on ? `, uploaded ${existing.uploaded_on}` : ''}.`
            + ' Open it and use Parse again if you want it re-read.',
        });
      }
    } catch (err) {
      // A failed duplicate check must never stop an upload.
      logger.warn('[PO] duplicate check failed, continuing', { error: err.message });
    }

    try {
      const stored = svc.storeFile(clientId, locationId, req.file.originalname, req.file.buffer);
      id = await svc.createParsing(pool, {
        clientId,
        locationId,
        sha,
        uploadedBy: req.user.username || req.user.email || null,
        file: {
          name: req.file.originalname || 'document',
          mime: req.file.mimetype,
          size: req.file.size,
          path: stored,
        },
      });
      svc.logEvent(pool, {
        orderId: id, clientId, locationId, event: 'uploaded', actor: actorOf(req),
        payload: { fileName: req.file.originalname, length: req.file.size, mime: req.file.mimetype },
      });

      // CLOSE THE RACE the check above cannot.
      //
      // `findByContent` runs before the insert, so two uploads of one file
      // arriving together both see nothing and both insert - and 013's index
      // is deliberately not unique, so the database does not stop them either.
      // Re-checking now that we have an id lets the loser retire itself, and
      // ordering by id means both rows agree on which of them is the original.
      const earlier = await svc.findEarlierByContent(pool, clientId, locationId, sha, id);
      if (earlier) {
        await svc.markDuplicate(pool, id, earlier.id);
        logger.info('[PO] concurrent duplicate upload retired', {
          id, originalId: earlier.id, clientId, locationId });
        return res.status(200).json({
          duplicate: true,
          id: earlier.id,
          message: 'This document was already being read when you uploaded it.'
            + ' Open the copy already on your list.',
        });
      }
    } catch (err) {
      logger.error('[PO] could not store the upload', { error: err.message, clientId, locationId });
      return fail(res, 500, 'The file could not be saved. Please try again.');
    }

    // ANSWER NOW, PARSE AFTER.
    //
    // This used to await the parse, and a parse of a scanned invoice takes
    // about ninety seconds - measured at 93.8s on a real Breakthru delivery.
    // The HTTP request was held open for all of it, per file, so uploading four
    // invoices tied up a connection and a worker for six minutes and looked
    // exactly like "the backend is slow". Any proxy with a shorter idle timeout
    // turned the wait into a failed upload on a document that parsed fine.
    //
    // The row already exists as 'parsing' before we get here, the list already
    // polls, and the dialog already tells the reader "you can close this, each
    // document is already in the table and will finish reading on its own" -
    // which was a promise the route did not keep. It does now.
    //
    // req.file.buffer is multer's in-memory copy, so it outlives the response.
    res.status(202).json({ id: String(id), status: 'parsing' });

    parseInBackground({
      pool, syncgo: req.pool, id, clientId, locationId,
      buffer: req.file.buffer, mime: req.file.mimetype, name: req.file.originalname,
    });
  });
});

/**
 * Read a stored document and record the outcome. Deliberately returns nothing
 * and never throws: the response has already gone, so the only place a failure
 * can be reported is the row's own status and its parser log - which is where
 * the reader looks anyway.
 */
async function parseInBackground({ pool, id, clientId, locationId, buffer, mime, name }) {
  try {
    const parsed = await svc.parseDocument({ buffer, mimeType: mime, fileName: name });
    const saved = await svc.saveParsed(pool, id, clientId, locationId, parsed);
    if (saved && saved.duplicateOf) {
      // The parse revealed this is an invoice the store already has - a
      // re-scan or a re-export, which the content hash cannot see. The row is
      // kept and pointed at the original rather than deleted: the reader
      // uploaded it and is entitled to find out what became of it.
      svc.logEvent(pool, {
        orderId: id, clientId, locationId, event: 'duplicate_detected',
        actor: 'system',
        payload: { duplicateOf: saved.duplicateOf, invoiceNo: saved.duplicateInvoiceNo },
      });
      logger.info('[PO] duplicate invoice recognised after parse', {
        id, originalId: saved.duplicateOf, clientId, locationId });
    }
    logger.info('[PO] parsed', {
      id, clientId, locationId, items: parsed.payload.items.length,
      confidence: parsed.confidence, ms: parsed.ms,
    });
    // No actor: the parse is the system's own work, not a person's.
    svc.logEvent(pool, {
      orderId: id, clientId, locationId, event: 'parsed',
      payload: {
        items: parsed.payload.items.length,
        method: parsed.model,
        confidence: parsed.confidence,
        ms: parsed.ms,
      },
    });
  } catch (err) {
    logger.error('[PO] parse failed', { id, error: err.message, clientId, locationId });
    await svc.markFailed(pool, id, err.message).catch(() => {});
    svc.logEvent(pool, {
      orderId: id, clientId, locationId, event: 'parse_failed',
      payload: { error: String(err.message || '').slice(0, 300) },
    });
  }
}

/* ── GET / ─────────────────────────────────────────────────────────────────── */
router.get('/', async (req, res) => {
  const { clientId, locationId } = tenant(req);
  try {
    // Whitelisted, not passed through: req.query goes into a WHERE clause, and
    // handing the whole object to the service would let any future query
    // parameter reach it by accident.
    const { rows, total } = await svc.list(getAnalyticsPool(), clientId, locationId, {
      limit: req.query.limit,
      offset: req.query.offset,
      q: req.query.q,
      status: req.query.status,
      // Opt-in, so the reader can find a document they uploaded and then could
      // not see. Hidden by default because a recognised duplicate on the list
      // is what this whole change exists to remove.
      includeDuplicates: req.query.includeDuplicates === 'true',
    });
    res.json({ data: rows.map(toApi), total });
  } catch (err) {
    logger.error('[PO] list failed', { error: err.message, clientId, locationId });
    failQuery(res, err, 'Could not load your documents.');
  }
});

/* ── GET /:id ──────────────────────────────────────────────────────────────── */
router.get('/:id(\\d+)', async (req, res) => {
  const { clientId, locationId } = tenant(req);
  try {
    const detail = await svc.getDetail(getAnalyticsPool(), req.pool, clientId, locationId, req.params.id);
    if (!detail) return fail(res, 404, 'That document was not found.');
    res.json({ ...toApi(detail), items: detail.items.map(itemToApi), unmatchedCount: detail.unmatchedCount });
  } catch (err) {
    logger.error('[PO] detail failed', { id: req.params.id, error: err.message });
    fail(res, 500, 'Could not load that document.');
  }
});

/* ── PATCH /:id - set the receipt date on a document ───────────────────────
   The one header field an owner knows and the document usually does not: the
   day the goods actually arrived. It is the only column a delivery lead time
   can be measured from (migration 037), so setting it also refreshes this
   store's per-vendor lead times - best-effort, after the response, so the
   owner's click is not held on a recomputation. */
router.patch('/:id(\\d+)', async (req, res) => {
  const { clientId, locationId } = tenant(req);
  if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'receivedDate')) {
    return fail(res, 400, 'Nothing to update. Send receivedDate as YYYY-MM-DD, or null to clear it.');
  }
  const raw = req.body.receivedDate;
  const received = raw === '' || raw == null ? null : String(raw).trim();
  if (received !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(received) || Number.isNaN(Date.parse(`${received}T00:00:00Z`))) {
      return fail(res, 400, 'receivedDate must be a date in the form YYYY-MM-DD.');
    }
    // A receipt in the future is a typo, not a delivery.
    if (received > new Date().toISOString().slice(0, 10)) {
      return fail(res, 400, 'receivedDate cannot be in the future.');
    }
  }

  const pool = getAnalyticsPool();
  try {
    const { rowCount } = await pool.query(
      `UPDATE purchase_orders SET received_date = $4, updated_at = now()
        WHERE id = $1 AND client_id = $2 AND location_id = $3`,
      [req.params.id, clientId, locationId, received]
    );
    if (!rowCount) return fail(res, 404, 'That document was not found.');
    svc.logEvent(pool, {
      orderId: req.params.id, clientId, locationId, event: 'received_date.set',
      actor: actorOf(req),
      // The value IS the point of this event: it is the owner's own claim about
      // when goods arrived, and the trail should show what they said.
      payload: { receivedDate: received },
    });

    const detail = await svc.getDetail(pool, req.pool, clientId, locationId, req.params.id);
    res.json({ ...toApi(detail), items: detail.items.map(itemToApi), unmatchedCount: detail.unmatchedCount });

    // After the response. A failure here costs one night's freshness - the
    // 03:00 refresh will catch up - and must never fail the owner's edit.
    require('../services/leadTimeService')
      .refreshLeadTimes(pool, clientId, locationId)
      .then((r) => logger.info('[PO] lead times refreshed after receipt date', { clientId, locationId, ...r }))
      .catch((err) => logger.warn('[PO] lead-time refresh failed', { clientId, locationId, error: err.message }));
  } catch (err) {
    if (err.code === '42703') {
      return fail(res, 503, 'Receipt dates need the analytics migrations. Run: npm run migrate --prefix backend');
    }
    logger.error('[PO] set received date failed', { error: err.message, clientId, locationId });
    fail(res, 500, 'Could not save the receipt date.');
  }
});

/* ── PATCH /:id/items/:itemId - correct a parsed line ─────────────────────── */
const EDITABLE = {
  productNo: 'product_no', productName: 'product_name', upc: 'upc',
  productVolume: 'product_volume', pack: 'pack', uom: 'uom',
  quantity: 'quantity', cost: 'cost', extPrice: 'ext_price', note: 'note',
};

/* ── GET /:id/log ─────────────────────────────────────────────────────────────
   The parser log: what the parse produced, and everything that has happened to
   the document since. The outcome lives on the document row (status, model,
   confidence, notes); the history is the append-only trail. Both are returned
   together because the screen shows them as one panel. */
router.get('/:id(\\d+)/log', async (req, res) => {
  const { clientId, locationId } = tenant(req);
  try {
    const pool = getAnalyticsPool();
    const { rows: [row] } = await pool.query(
      `SELECT id, status, parse_error, parse_model, parse_confidence, parse_ms,
              notes, file_name, uploaded_by, created_at, updated_at
         FROM purchase_orders
        WHERE id = $1 AND client_id = $2 AND location_id = $3`,
      [req.params.id, clientId, locationId]
    );
    if (!row) return fail(res, 404, 'That document was not found.');

    const events = await svc.listEvents(pool, clientId, locationId, req.params.id);
    res.json({
      id: String(row.id),
      status: row.status,
      parseError: row.parse_error,
      method: row.parse_model,
      confidence: row.parse_confidence != null ? Number(row.parse_confidence) : null,
      parseMs: row.parse_ms,
      notes: row.notes,
      fileName: row.file_name,
      uploadedBy: row.uploaded_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      events: events.map((e) => ({
        event: e.event,
        actor: e.actor,
        payload: e.payload,
        at: e.created_at,
      })),
    });
  } catch (err) {
    logger.error('[PO] log failed', { error: err.message, clientId, locationId });
    fail(res, 500, 'Could not load the log for that document.');
  }
});


router.patch('/:id(\\d+)/items/:itemId(\\d+)', async (req, res) => {
  const { clientId, locationId } = tenant(req);
  const sets = [];
  const vals = [req.params.itemId, req.params.id, clientId, locationId];

  for (const [apiKey, col] of Object.entries(EDITABLE)) {
    if (Object.prototype.hasOwnProperty.call(req.body, apiKey)) {
      vals.push(req.body[apiKey] === '' ? null : req.body[apiKey]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (!sets.length) return fail(res, 400, 'Nothing to update.');

  try {
    const { rowCount } = await getAnalyticsPool().query(
      `UPDATE purchase_order_items SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $1 AND purchase_order_id = $2 AND client_id = $3 AND location_id = $4`,
      vals
    );
    if (!rowCount) return fail(res, 404, 'That line was not found.');
    svc.logEvent(getAnalyticsPool(), {
      orderId: req.params.id, clientId, locationId, event: 'items.edited', actor: actorOf(req),
      // Which line, and which fields - not the values. A trail that copies the
      // new numbers duplicates state that already lives on the row.
      payload: { itemIds: [String(req.params.itemId)], fields: Object.keys(req.body || {}) },
    });
    const detail = await svc.getDetail(getAnalyticsPool(), req.pool, clientId, locationId, req.params.id);
    res.json({ ...toApi(detail), items: detail.items.map(itemToApi), unmatchedCount: detail.unmatchedCount });
  } catch (err) {
    logger.error('[PO] patch item failed', { error: err.message });
    fail(res, 500, 'Could not save that change.');
  }
});

/* ── POST /:id/items/:itemId/link - point a line at an existing product ───── */
router.post('/:id(\\d+)/items/:itemId(\\d+)/link', async (req, res) => {
  const { clientId, locationId } = tenant(req);
  const sku = String(req.body.sku || '').trim();
  if (!sku) return fail(res, 400, 'A product sku is required.');

  try {
    // Either source is a valid link target: the POS catalogue, or a product
    // the owner added here earlier.
    const { rows } = await req.pool.query(
      `SELECT sku FROM products
        WHERE client_id = $1 AND location_id = $2 AND sku = $3 AND is_deleted IS NOT TRUE`,
      [clientId, locationId, sku]
    );
    if (!rows.length) {
      const { rows: manual } = await getAnalyticsPool().query(
        `SELECT sku FROM po_manual_products WHERE client_id = $1 AND location_id = $2 AND sku = $3`,
        [clientId, locationId, sku]
      );
      if (!manual.length) return fail(res, 404, 'No product with that sku in your catalogue.');
    }

    const { rowCount } = await getAnalyticsPool().query(
      `UPDATE purchase_order_items
          SET matched_sku = $5, match_source = 'manual', matched_at = now(), updated_at = now()
        WHERE id = $1 AND purchase_order_id = $2 AND client_id = $3 AND location_id = $4`,
      [req.params.itemId, req.params.id, clientId, locationId, sku]
    );
    if (!rowCount) return fail(res, 404, 'That line was not found.');
    svc.logEvent(getAnalyticsPool(), {
      orderId: req.params.id, clientId, locationId, event: 'items.mapped', actor: actorOf(req),
      payload: { itemIds: [String(req.params.itemId)], sku: String(sku) },
    });

    const detail = await svc.getDetail(getAnalyticsPool(), req.pool, clientId, locationId, req.params.id);
    res.json({ ...toApi(detail), items: detail.items.map(itemToApi), unmatchedCount: detail.unmatchedCount });
  } catch (err) {
    logger.error('[PO] link failed', { error: err.message });
    fail(res, 500, 'Could not link that line.');
  }
});

/* ── DELETE /:id/items/:itemId/link - undo a link ─────────────────────────── */
router.delete('/:id(\\d+)/items/:itemId(\\d+)/link', async (req, res) => {
  const { clientId, locationId } = tenant(req);
  try {
    await getAnalyticsPool().query(
      `UPDATE purchase_order_items
          SET matched_sku = NULL, match_source = NULL, matched_at = NULL, updated_at = now()
        WHERE id = $1 AND purchase_order_id = $2 AND client_id = $3 AND location_id = $4`,
      [req.params.itemId, req.params.id, clientId, locationId]
    );
    svc.logEvent(getAnalyticsPool(), {
      orderId: req.params.id, clientId, locationId, event: 'items.unmapped', actor: actorOf(req),
      payload: { itemIds: [String(req.params.itemId)] },
    });
    const detail = await svc.getDetail(getAnalyticsPool(), req.pool, clientId, locationId, req.params.id);
    res.json({ ...toApi(detail), items: detail.items.map(itemToApi), unmatchedCount: detail.unmatchedCount });
  } catch (err) {
    logger.error('[PO] unlink failed', { error: err.message });
    fail(res, 500, 'Could not unlink that line.');
  }
});

/* ── GET /products/search - the picker behind "link to an existing product" ─ */
router.get('/products/search', async (req, res) => {
  const { clientId, locationId } = tenant(req);
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ data: [] });
  try {
    const { rows } = await req.pool.query(
      `SELECT sku, upc, product_name, price, cost, stock_qty, category
         FROM products
        WHERE client_id = $1 AND location_id = $2 AND is_deleted IS NOT TRUE
          AND (product_name ILIKE $3 OR sku ILIKE $3 OR upc ILIKE $3)
        ORDER BY product_name
        LIMIT 25`,
      [clientId, locationId, `%${q}%`]
    );
    // Products the owner added here are searchable too, flagged so the picker
    // can say where each one came from.
    const { rows: manual } = await getAnalyticsPool().query(
      `SELECT sku, upc, product_name, price, cost, stock_qty, category
         FROM po_manual_products
        WHERE client_id = $1 AND location_id = $2
          AND (product_name ILIKE $3 OR sku ILIKE $3 OR upc ILIKE $3)
        LIMIT 25`,
      [clientId, locationId, `%${q}%`]
    );
    const posSkus = new Set(rows.map((r) => r.sku));
    const shape = (r, source) => ({
      sku: r.sku, upc: r.upc, productName: r.product_name,
      price: r.price != null ? Number(r.price) : null,
      cost: r.cost != null ? Number(r.cost) : null,
      onHand: r.stock_qty != null ? parseInt(r.stock_qty, 10) : 0,
      category: r.category || null,
      source,
    });
    res.json({
      data: [
        ...rows.map((r) => shape(r, 'pos')),
        ...manual.filter((r) => !posSkus.has(r.sku)).map((r) => shape(r, 'added')),
      ],
    });
  } catch (err) {
    logger.error('[PO] product search failed', { error: err.message });
    fail(res, 500, 'Search failed.');
  }
});

/* ── POST /:id/items/:itemId/create-product ───────────────────────────────────
   The "this product is not in my inventory yet" path. Creates the product in
   the store's own catalogue from the invoice line and links the line to it in
   one step, because doing it in two would leave a product created and a line
   still unmatched if the second call failed. */
router.post('/:id(\\d+)/items/:itemId(\\d+)/create-product', async (req, res) => {
  const { clientId, locationId } = tenant(req);
  const sku = String(req.body.sku || '').trim();
  const name = String(req.body.productName || '').trim();
  if (!sku) return fail(res, 400, 'A sku is required. It is how this product will be identified everywhere else.');
  if (!name) return fail(res, 400, 'A product name is required.');

  const price = req.body.price === '' || req.body.price == null ? null : Number(req.body.price);
  const cost = req.body.cost === '' || req.body.cost == null ? null : Number(req.body.cost);
  const stock = req.body.stockQty === '' || req.body.stockQty == null ? 0 : parseInt(req.body.stockQty, 10);
  if (price != null && !Number.isFinite(price)) return fail(res, 400, 'Price must be a number.');
  if (cost != null && !Number.isFinite(cost)) return fail(res, 400, 'Cost must be a number.');

  const analytics = getAnalyticsPool();
  try {
    // The POS catalogue is read-only to this application (verified: the
    // `bottela` role holds SELECT on products and nothing else), so a new
    // product is recorded in Botella's own overlay - see
    // 009_po_manual_products.sql for why that is the right place and not a
    // workaround. Still check the POS first: if the sku is already a real
    // product, the owner wants to LINK, not create a duplicate under a name
    // only Botella can see.
    const { rows: inPos } = await req.pool.query(
      `SELECT sku, product_name FROM products
        WHERE client_id = $1 AND location_id = $2 AND sku = $3 AND is_deleted IS NOT TRUE`,
      [clientId, locationId, sku]
    );
    if (inPos.length) {
      return fail(res, 409, `Your inventory already has "${inPos[0].product_name}" under sku ${sku}. Use Link instead.`);
    }

    await analytics.query(
      `INSERT INTO po_manual_products
         (client_id, location_id, sku, upc, product_name, category, price, cost, stock_qty,
          source_item_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [clientId, locationId, sku, String(req.body.upc || '').trim() || null, name,
        String(req.body.category || '').trim() || null, price, cost,
        Number.isFinite(stock) ? stock : 0, req.params.itemId,
        req.user.username || null]
    );

    await analytics.query(
      `UPDATE purchase_order_items
          SET matched_sku = $5, match_source = 'created', matched_at = now(), updated_at = now()
        WHERE id = $1 AND purchase_order_id = $2 AND client_id = $3 AND location_id = $4`,
      [req.params.itemId, req.params.id, clientId, locationId, sku]
    );

    logger.info('[PO] product added from an invoice line', { sku, clientId, locationId });
    const detail = await svc.getDetail(analytics, req.pool, clientId, locationId, req.params.id);
    res.json({ ...toApi(detail), items: detail.items.map(itemToApi), unmatchedCount: detail.unmatchedCount });
  } catch (err) {
    if (err.code === '23505') {
      return fail(res, 409, `You have already added a product with sku ${sku}. Use Link to point this line at it.`);
    }
    logger.error('[PO] create product failed', { error: err.message });
    fail(res, 500, 'Could not add that product.');
  }
});

/* ── POST /:id/reparse - run the parse again on the stored original ───────── */
/*
 * A parse can come back empty or thin for reasons that are not the document's
 * fault: the model timed out, the key was rotated, the prompt has since been
 * improved. Before this the only recovery was to delete the row and upload the
 * same file again - which throws away every manual link the owner had already
 * made on the lines that DID parse.
 *
 * This re-reads the file already on disk and runs the same saveParsed() the
 * upload path uses, so the two cannot drift. The human's links are captured
 * first and re-applied afterwards, keyed on (line number + product name):
 *
 *   - name alone would move a link to the wrong line if the re-parse reorders
 *   - line number alone would move it to a DIFFERENT product if the new parse
 *     finds one extra line near the top
 *
 * Requiring both is why some links are reported lost rather than silently
 * re-attached to something the owner never chose.
 */
router.post('/:id(\\d+)/reparse', async (req, res) => {
  const { clientId, locationId } = tenant(req);
  const pool = getAnalyticsPool();
  try {
    const { rows: [row] } = await pool.query(
      `SELECT id, file_path, file_name, file_mime FROM purchase_orders
        WHERE id = $1 AND client_id = $2 AND location_id = $3`,
      [req.params.id, clientId, locationId]
    );
    if (!row) return fail(res, 404, 'That document was not found.');

    const full = svc.resolveFile(row.file_path);
    if (!fs.existsSync(full)) {
      return fail(res, 409, 'The original file is no longer on the server, so it cannot be parsed again.');
    }

    const { rows: priorLinks } = await pool.query(
      `SELECT line_no, product_name, matched_sku, match_source
         FROM purchase_order_items
        WHERE purchase_order_id = $1 AND client_id = $2 AND location_id = $3
          AND matched_sku IS NOT NULL`,
      [row.id, clientId, locationId]
    );

    const parsed = await svc.parseDocument({
      buffer: fs.readFileSync(full),
      mimeType: row.file_mime,
      fileName: row.file_name,
    });

    // parseDocument returns { payload, model, ms, confidence } - the lines are
    // on .payload, the same shape saveParsed consumes.
    if (!parsed || !parsed.payload || !(parsed.payload.items || []).length) {
      await svc.markFailed(pool, row.id, 'The document parsed again with no line items.');
      const failedDetail = await svc.getDetail(pool, req.pool, clientId, locationId, row.id);
      return res.json({
        ...toApi(failedDetail),
        items: failedDetail.items.map(itemToApi),
        unmatchedCount: failedDetail.unmatchedCount,
        reparse: { linksCarried: 0, linksLost: priorLinks.length, itemsFound: 0 },
      });
    }

    await svc.saveParsed(pool, row.id, clientId, locationId, parsed);
    svc.logEvent(pool, {
      orderId: row.id, clientId, locationId, event: 'reparsed', actor: actorOf(req),
      payload: {
        items: (parsed.payload.items || []).length,
        method: parsed.model,
        confidence: parsed.confidence,
        ms: parsed.ms,
      },
    });

    // Re-apply the links the owner had already made. One statement per link:
    // there are rarely more than a handful, and a bulk CASE would be harder to
    // read than the thing it saves.
    let carried = 0;
    for (const l of priorLinks) {
      const { rowCount } = await pool.query(
        `UPDATE purchase_order_items
            SET matched_sku = $5, match_source = $6, matched_at = now(), updated_at = now()
          WHERE purchase_order_id = $1 AND client_id = $2 AND location_id = $3
            AND line_no = $4
            AND lower(regexp_replace(trim(coalesce(product_name,'')), '\\s+', ' ', 'g'))
                = lower(regexp_replace(trim(coalesce($7::text,'')), '\\s+', ' ', 'g'))`,
        [row.id, clientId, locationId, l.line_no, l.matched_sku, l.match_source, l.product_name]
      );
      if (rowCount) carried += 1;
    }

    const detail = await svc.getDetail(pool, req.pool, clientId, locationId, row.id);
    res.json({
      ...toApi(detail),
      items: detail.items.map(itemToApi),
      unmatchedCount: detail.unmatchedCount,
      reparse: {
        linksCarried: carried,
        linksLost: priorLinks.length - carried,
        itemsFound: detail.items.length,
      },
    });
  } catch (err) {
    logger.error('[PO] reparse failed', { error: err.message });
    fail(res, 500, `The document could not be parsed again. ${err.message || ''}`.trim());
  }
});

/* ── GET /:id/file - view or download the original ────────────────────────── */
router.get('/:id(\\d+)/file', async (req, res) => {
  const { clientId, locationId } = tenant(req);
  try {
    const { rows: [row] } = await getAnalyticsPool().query(
      `SELECT file_path, file_name, file_mime FROM purchase_orders
        WHERE id = $1 AND client_id = $2 AND location_id = $3`,
      [req.params.id, clientId, locationId]
    );
    if (!row) return fail(res, 404, 'That document was not found.');

    const full = svc.resolveFile(row.file_path);
    if (!fs.existsSync(full)) return fail(res, 404, 'The original file is no longer on the server.');

    // inline by default so the browser can PREVIEW it; ?download=1 to save.
    const disp = req.query.download ? 'attachment' : 'inline';
    res.setHeader('Content-Type', row.file_mime);
    res.setHeader('Content-Disposition', `${disp}; filename="${encodeURIComponent(row.file_name)}"`);
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    logger.error('[PO] file failed', { error: err.message });
    fail(res, 500, 'Could not open that file.');
  }
});

/* ── GET /:id/csv - the parsed lines, as a spreadsheet ────────────────────── */
router.get('/:id(\\d+)/csv', async (req, res) => {
  const { clientId, locationId } = tenant(req);
  try {
    const detail = await svc.getDetail(getAnalyticsPool(), req.pool, clientId, locationId, req.params.id);
    if (!detail) return fail(res, 404, 'That document was not found.');

    const head = ['Line', 'Vendor code', 'Product', 'UPC', 'Pack', 'Qty', 'Unit cost',
      'Ext price', 'In inventory', 'Matched sku', 'Matched product'];
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = detail.items.map((i) => [
      i.line_no, i.product_no, i.product_name, i.upc, i.pack, i.quantity, i.cost,
      i.ext_price, i.match.matched ? 'yes' : 'no',
      i.match.matched ? i.match.sku : '', i.match.matched ? i.match.productName : '',
    ].map(esc).join(','));

    // BOM so Excel opens UTF-8 correctly - without it accented product names
    // arrive mojibaked, which is the single most common complaint about CSVs.
    const csv = '﻿' + [head.join(','), ...lines].join('\n');
    const name = `${detail.doc_type === 'purchase_order' ? 'po' : 'invoice'}-${detail.invoice_no || detail.id}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(csv);
  } catch (err) {
    logger.error('[PO] csv failed', { error: err.message });
    fail(res, 500, 'Could not build the CSV.');
  }
});

/* ── DELETE /:id ──────────────────────────────────────────────────────────── */
router.delete('/:id(\\d+)', async (req, res) => {
  const { clientId, locationId } = tenant(req);
  try {
    const { rows: [row] } = await getAnalyticsPool().query(
      `DELETE FROM purchase_orders WHERE id = $1 AND client_id = $2 AND location_id = $3
       RETURNING file_path`,
      [req.params.id, clientId, locationId]
    );
    if (!row) return fail(res, 404, 'That document was not found.');
    // Best-effort: the row is already gone, and a stranded file is a far
    // smaller problem than a 500 on a delete that actually succeeded.
    try { fs.unlinkSync(svc.resolveFile(row.file_path)); } catch { /* already gone */ }
    res.json({ ok: true });
  } catch (err) {
    logger.error('[PO] delete failed', { error: err.message });
    fail(res, 500, 'Could not delete that document.');
  }
});

module.exports = router;
