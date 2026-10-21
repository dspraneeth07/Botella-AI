/**
 * Purchase Order / Invoice capture - parse, persist, match.
 *
 * The owner uploads a supplier invoice or PO; we read it with Claude and hand
 * back the lines matched against the store's own catalogue.
 *
 * WHY VISION-ONLY, AND WHY THAT IS NOT A SHORTCUT
 * -----------------------------------------------
 * The reference implementation (QuickPO, .NET) runs a cascade: three different
 * PDF text extractors, each feeding a text prompt, accepting the first result
 * above a confidence floor, and only then falling back to a vision model.
 * That cascade exists because it was written against an API that could not
 * accept a PDF directly.
 *
 * Anthropic's API takes a PDF as a first-class `document` block and does its
 * own text-layer extraction, falling back to reading the rendered pixels when
 * there is no text layer. So the cascade's job is already done inside the
 * model, and reproducing it here would add three dependencies and a confidence
 * heuristic to arrive at the same place.
 *
 * It also fixes a real hole in the cascade. QuickPO routes images straight to
 * vision precisely because a text extractor cannot see the pen corrections a
 * receiver writes on a delivery - but a digital PDF that has been scanned back
 * in still has a text layer, so it takes the TEXT route and those corrections
 * are silently lost. Sending the document itself means the model sees the page
 * either way.
 *
 * MATCHING IS RESOLVED AT READ TIME
 * ---------------------------------
 * See 008_purchase_orders.sql. Only an explicit human link is stored; the
 * automatic match runs on every read so a product added after the upload makes
 * its line match without re-parsing.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Sonnet reads invoice layouts as well as the larger models at a fraction of
// the cost, and an invoice parse is a high-volume, low-ambiguity task.
const PARSE_MODEL = process.env.PO_PARSE_MODEL || 'claude-sonnet-5';

// Where uploads live. Beside the imagegen store, which already has this shape.
const UPLOAD_DIR = process.env.PO_UPLOAD_DIR
  || path.join(__dirname, '..', 'data', 'purchase-orders');

const MAX_ITEMS = 400;         // a delivery invoice past this is a data error
const PARSE_TIMEOUT_MS = 180_000;
// Output budget for the parse.
//
// Was 8000, which is roughly 120 line items of JSON - and a Breakthru Beverage
// delivery runs well past that. The response stopped mid-object, extractJson
// found no valid JSON, and the document was filed as "Could not read": a long
// invoice failed for being long, and the parser log said nothing about why.
// MAX_ITEMS is 400, so the budget has to be able to carry 400 items or the two
// limits contradict each other.
const PARSE_MAX_TOKENS = parseInt(process.env.PO_PARSE_MAX_TOKENS || '32000', 10);

/* ── The extraction contract ──────────────────────────────────────────────── */

const SCHEMA = `{
  "docType": "invoice" | "purchase_order",
  "vendorName": string|null,
  "accountNo": string|null,
  "invoiceNo": string|null,
  "invoiceDate": "YYYY-MM-DD"|null,
  "dueDate": "YYYY-MM-DD"|null,
  "poNumber": string|null,
  "poDate": "YYYY-MM-DD"|null,
  "receivedDate": "YYYY-MM-DD"|null,
  "currency": string|null,
  "subtotal": number|null,
  "taxTotal": number|null,
  "discountTotal": number|null,
  "deliveryTotal": number|null,
  "invoiceTotal": number|null,
  "notes": string|null,
  "items": [
    {
      "lineNo": number,
      "productNo": string|null,
      "productName": string|null,
      "upc": string|null,
      "productVolume": string|null,
      "pack": string|null,
      "uom": string|null,
      "quantity": number|null,
      "cost": number|null,
      "discountAmt": number|null,
      "taxAmt": number|null,
      "depositAmt": number|null,
      "extPrice": number|null,
      "note": string|null
    }
  ]
}`;

// The rules that matter are the ones a beverage invoice actually breaks. Each
// line below is here because getting it wrong produces a plausible-looking
// number that is quietly incorrect, which is worse than a null.
const RULES = `Rules:
- Return strictly valid JSON and nothing else. No markdown fence, no prose.
- Use null for anything not present. NEVER invent a value to fill a field.
- Dates are YYYY-MM-DD. Numbers carry no currency symbol and no thousands separator.
- "cost" is the per-unit cost. "extPrice" is the line's extended/net amount.
- Read the QUANTITY column, not the pack size. "12/750ml" is a pack
  description, not a quantity of 12.
- If a receiver has written a correction on the document by hand (a crossed-out
  quantity, a pen note), the HANDWRITTEN value is the real one. Put the printed
  value in the line's "note" so the change stays visible.
- For subtotal / taxTotal / discountTotal / deliveryTotal: prefer the number
  printed on the document, including an unlabelled column subtotal on the
  footer row of the item table. Only compute from the lines when the document
  does not state it. If neither, null.
- The separately boxed grand total is "invoiceTotal", never "discountTotal".
- NEVER derive a discount as (cost x quantity - extPrice). Beverage invoices
  print an already-net unit cost, so that subtraction double-counts.
- "docType" is "purchase_order" only when the document calls itself a purchase
  order or an order confirmation. A delivery document with prices is an invoice.
- "receivedDate" is the day the goods were DELIVERED or RECEIVED, only when the
  document states it: a "Delivered", "Received", "Delivery date" or "Ship date"
  field, a signed receiving stamp, or a handwritten received date. It is NOT
  the invoice date and NOT the due date. Most invoices do not carry it; then
  null.
- Return the items in the order they appear on the page.`;

/**
 * One document in, one parsed payload out.
 *
 * Deliberately single-invoice, unlike the reference implementation's
 * `invoices: []` envelope. A store owner uploads one supplier document at a
 * time; multi-invoice PDFs are a distributor-batch case that this product does
 * not have yet, and modelling for it now would mean a list screen that shows
 * "3 invoices" for one upload with no way to have asked for that.
 */
async function parseDocument({ buffer, mimeType, fileName }) {
  const started = Date.now();
  const isPdf = mimeType === 'application/pdf';

  const documentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } };

  const prompt = `You are reading a supplier document for a liquor store: an invoice or a purchase order.

Return ONLY a JSON object matching this schema:
${SCHEMA}

${RULES}`;

  // STREAMED, and it has to be.
  //
  // The SDK refuses a non-streaming request whose max_tokens implies it could
  // run past ten minutes - `(3600 * max_tokens) / 128000 > 600`, so anything
  // above 21,333 throws before the request leaves the process:
  //
  //   "Streaming is strongly recommended for operations that may take longer
  //    than 10 minutes."
  //
  // which reached an owner as a failed upload. A 400-item invoice genuinely
  // needs a budget above that ceiling, so the answer is to stream rather than
  // to shrink the budget back under it. finalMessage() returns the same shape
  // create() did, stop_reason included.
  const res = await anthropic.messages.stream({
    model: PARSE_MODEL,
    max_tokens: PARSE_MAX_TOKENS,
    messages: [{ role: 'user', content: [documentBlock, { type: 'text', text: prompt }] }],
  }, { timeout: PARSE_TIMEOUT_MS }).finalMessage();

  const raw = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const payload = extractJson(raw);
  if (!payload) {
    // Say WHICH failure this is. A response that ran out of room and one that
    // came back as prose are different problems with different fixes, and both
    // used to reach the owner as the same four words on a red chip.
    if (res.stop_reason === 'max_tokens') {
      throw new Error(
        `The document is longer than one read can return (stopped at ${PARSE_MAX_TOKENS} tokens). `
        + 'Split the file, or raise PO_PARSE_MAX_TOKENS.'
      );
    }
    throw new Error('The document was read but no structured data could be recovered from the response.');
  }
  // Valid JSON can still be short: the model may have closed the object early
  // when it hit the ceiling. Worth recording, because the item count will look
  // plausible and be wrong.
  if (res.stop_reason === 'max_tokens') {
    logger.warn('[PO] parse hit the token ceiling; line items may be incomplete', {
      fileName, maxTokens: PARSE_MAX_TOKENS,
    });
  }

  const items = Array.isArray(payload.items) ? payload.items.slice(0, MAX_ITEMS) : [];

  return {
    payload: { ...payload, items },
    model: PARSE_MODEL,
    ms: Date.now() - started,
    // A blunt but honest signal: the share of lines that came back with both a
    // name and a number. A parse where most lines are half-empty is one a
    // human should look at closely, and that is all this figure claims.
    confidence: items.length === 0 ? 0
      : items.filter((i) => i.productName && i.quantity != null).length / items.length,
    fileName,
  };
}

/** Pull the JSON object out of a reply that may still have prose around it. */
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ── Storage ──────────────────────────────────────────────────────────────── */

function storeFile(clientId, locationId, originalName, buffer) {
  const dir = path.join(UPLOAD_DIR, `${clientId}-${locationId}`);
  fs.mkdirSync(dir, { recursive: true });
  // A random name, not the uploaded one: two deliveries called "invoice.pdf"
  // must not collide, and the original name is kept in the row for display.
  const ext = path.extname(originalName || '').slice(0, 10) || '.bin';
  const stored = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const full = path.join(dir, stored);
  fs.writeFileSync(full, buffer);
  return path.relative(UPLOAD_DIR, full).split(path.sep).join('/');
}

function resolveFile(relPath) {
  const full = path.resolve(UPLOAD_DIR, relPath);
  // A stored path is ours, but resolve it anyway: a row whose file_path was
  // ever tampered with must not be able to read outside the upload directory.
  if (!full.startsWith(path.resolve(UPLOAD_DIR))) throw new Error('Invalid file path.');
  return full;
}

/* ── Persistence ──────────────────────────────────────────────────────────── */

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? v : null);

/* ── The activity trail ───────────────────────────────────────────────────── */

/**
 * Append one event to a document's trail.
 *
 * Deliberately cannot fail its caller. An invoice that parsed correctly but
 * whose log line could not be written is still a parsed invoice, and throwing
 * here would turn a bookkeeping problem into a failed upload. The failure is
 * logged and swallowed.
 *
 * Not awaited by every caller either - see the upload route, where the trail
 * must not add latency to a parse the owner is already waiting through.
 */
async function logEvent(pool, { orderId, clientId, locationId, event, actor = null, payload = {} }) {
  try {
    await pool.query(
      `INSERT INTO purchase_order_events
         (purchase_order_id, client_id, location_id, event, actor, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [orderId, clientId, locationId, event, actor, JSON.stringify(payload || {})]
    );
  } catch (err) {
    logger.warn('[PO] could not write event', { orderId, event, error: err.message });
  }
}

/** One document's trail, newest first. Tenant-scoped, like every other read. */
async function listEvents(pool, clientId, locationId, orderId, { limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT event, actor, payload, created_at
       FROM purchase_order_events
      WHERE purchase_order_id = $1 AND client_id = $2 AND location_id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT $4`,
    [orderId, clientId, locationId, Math.min(Number(limit) || 100, 500)]
  );
  return rows;
}

/**
 * Does this column exist? Cached for the life of the process.
 *
 * The estate is mid-migration - the audit found the local and Neon analytics
 * databases carrying different tables - so a query that assumes a column is a
 * query that breaks a list on one deployment and not the other. Probing once
 * and remembering is cheaper than a try/catch around every read, and it lets
 * the caller degrade deliberately rather than by exception.
 */
const _columnCache = new Map();
async function columnExists(pool, table, column) {
  const key = `${table}.${column}`;
  if (_columnCache.has(key)) return _columnCache.get(key);
  let present = false;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2 LIMIT 1`, [table, column]);
    present = rows.length > 0;
  } catch (err) {
    logger.warn('[PO] column probe failed, assuming absent', { key, error: err.message });
  }
  _columnCache.set(key, present);
  return present;
}

/** sha256 of the uploaded bytes - the key a re-upload is recognised by. */
function contentHash(buffer) {
  return require('crypto').createHash('sha256').update(buffer).digest('hex');
}

/**
 * Has this tenant already got this exact document?
 *
 * Matches on CONTENT, not file name: the same invoice arrives as
 * "Invoice_Glazers.pdf", "Savanah_2.pdf" and "scan (1).pdf", and two different
 * invoices from one vendor often share a naming pattern. Returns the existing
 * row, or null. Degrades to null if migration 013 has not run - a missing
 * column must not break uploading.
 */
async function findByContent(pool, clientId, locationId, sha) {
  if (!sha) return null;
  try {
    const { rows } = await pool.query(
      `SELECT id, invoice_no, vendor_name, file_name, status,
              to_char(created_at, 'YYYY-MM-DD') AS uploaded_on
         FROM purchase_orders
        WHERE client_id = $1 AND location_id = $2 AND content_sha256 = $3
        ORDER BY id LIMIT 1`,
      [clientId, locationId, sha]
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === '42703') return null; // column not there yet
    throw err;
  }
}

/**
 * A vendor name reduced to the part that identifies it.
 *
 * "Glazer's Beer & Beverage", "GLAZERS BEER AND BEVERAGE" and
 * "Glazers Beer  &  Beverage," are one supplier, and an invoice number is only
 * unique WITHIN a supplier - so the comparison has to survive the punctuation
 * and casing that a parse picks up off a letterhead. Deliberately crude: the
 * question is "same vendor?", not "which vendor?", and a crude answer that is
 * stable beats a clever one that is not.
 */
function normaliseVendor(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * An invoice number stripped to what the vendor actually assigned.
 *
 * "INV-1578334", "#1578334" and "1578334" are one invoice. Leading zeros are
 * kept: some vendors do issue 001 and 1 as different documents.
 */
function normaliseInvoiceNo(no) {
  const raw = String(no || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').trim();
  // Strip a LEADING document-type marker only. One scan of an invoice picks up
  // "INV-1578334" off the letterhead and the next reads "#1578334" out of the
  // body; they are one invoice and must normalise together.
  //
  // Only at the START, and only these words. A vendor that genuinely issues
  // alphanumeric numbers must keep them - A1234 and B1234 are different
  // documents, and stripping every letter would silently merge them.
  const stripped = raw.replace(/^(?:INVOICE|INVNO|INV|BILLNO|BILL|PONO|PO|NO)(?=\d)/, '');
  // Never return empty because the whole value looked like a prefix: "INV"
  // alone is not an invoice number, but it is also not nothing, and an empty
  // key matches every other empty key.
  return stripped || raw;
}

/**
 * Is this parsed document the same INVOICE as one already on the list?
 *
 * Runs after parsing, because it needs the vendor and the invoice number and
 * neither exists until then. This is the check migration 013's content hash
 * cannot make: a re-scan, a re-export or a second photograph of one invoice
 * produces different bytes and identical identity.
 *
 * Returns the EARLIEST matching row, so a third copy points at the original
 * rather than at the second copy - otherwise a chain forms and "open the one
 * you already have" leads somewhere that is itself hidden.
 *
 * Conservative on purpose. It refuses to guess when either half of the key is
 * missing: a failed parse with no invoice number would otherwise match every
 * other failed parse, and merging two documents that are not the same invoice
 * is a far worse outcome than listing one twice.
 */
async function findDuplicateByIdentity(pool, clientId, locationId, { id, vendorName, invoiceNo }) {
  const vendor = normaliseVendor(vendorName);
  const invoice = normaliseInvoiceNo(invoiceNo);
  if (!vendor || !invoice) return null;

  // ONE IMPLEMENTATION OF THE TRICKY HALF.
  //
  // The vendor comparison is done in SQL because it is a plain strip-and-fold
  // that both languages express identically, and the index needs it there.
  // The INVOICE NUMBER is not: it strips a leading document-type marker
  // ("INV-1578334" and "#1578334" are one invoice) and that rule will keep
  // changing as new vendor formats turn up.
  //
  // Writing it twice - once in JavaScript and once as a Postgres regexp - is
  // exactly how this codebase ended up with two definitions of lift that
  // disagreed by 1.37x while everyone believed they matched. So the query
  // narrows to the vendor and `normaliseInvoiceNo` decides, in one place, in
  // one language. A vendor has tens or hundreds of invoices, not millions;
  // the extra rows cost nothing and the divergence would cost a lot.
  try {
    const { rows } = await pool.query(
      `SELECT id, invoice_no, vendor_name, file_name, status,
              to_char(created_at, 'YYYY-MM-DD') AS uploaded_on
         FROM purchase_orders
        WHERE client_id = $1
          AND location_id = $2
          AND id <> $3
          AND duplicate_of IS NULL
          AND invoice_no IS NOT NULL
          AND vendor_name IS NOT NULL
          AND regexp_replace(lower(replace(vendor_name, '&', ' and ')),
                             '[^a-z0-9]', '', 'g') = $4
        ORDER BY id`,
      [clientId, locationId, id, vendor]
    );
    return rows.find((r) => normaliseInvoiceNo(r.invoice_no) === invoice) || null;
  } catch (err) {
    if (err.code === '42703') return null; // migration 021 has not run
    throw err;
  }
}


/**
 * Point this document at the one it duplicates. Never throws for a missing
 * column - an estate that has not run 021 keeps working, it just keeps listing
 * both copies, which is where it already was.
 */
async function markDuplicate(pool, id, originalId) {
  try {
    await pool.query(
      `UPDATE purchase_orders SET duplicate_of = $2, updated_at = now()
        WHERE id = $1`, [id, originalId]);
    return true;
  } catch (err) {
    if (err.code === '42703') return false;
    throw err;
  }
}

/**
 * Did another upload of this exact file win the race?
 *
 * The route checks `findByContent` before inserting, so two uploads of one file
 * arriving together BOTH see nothing and BOTH insert. The index from 013 is
 * deliberately not unique, so the database does not stop them either.
 *
 * Re-checking after the insert closes the window: the loser sees the winner's
 * lower id and retires itself. Ordering by id rather than by timestamp because
 * two inserts in the same millisecond have the same `created_at` and a stable
 * tie-break matters more here than wall-clock truth - both rows must agree on
 * which of them is the original, or they each hide the other.
 */
async function findEarlierByContent(pool, clientId, locationId, sha, id) {
  if (!sha) return null;
  try {
    const { rows } = await pool.query(
      `SELECT id FROM purchase_orders
        WHERE client_id = $1 AND location_id = $2 AND content_sha256 = $3
          AND id < $4 AND duplicate_of IS NULL
        ORDER BY id LIMIT 1`,
      [clientId, locationId, sha, id]
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === '42703') return null;
    throw err;
  }
}

async function createParsing(pool, { clientId, locationId, file, uploadedBy, sha }) {
  // Written with the hash where the column exists, without it where it does
  // not, so an estate that has not run 013 keeps uploading.
  const withHash = sha != null;
  const cols = ['client_id', 'location_id', 'status', 'file_name', 'file_mime',
    'file_size', 'file_path', 'uploaded_by', ...(withHash ? ['content_sha256'] : [])];
  const vals = [clientId, locationId, 'parsing', file.name, file.mime, file.size,
    file.path, uploadedBy || null, ...(withHash ? [sha] : [])];
  try {
    const { rows } = await pool.query(
      `INSERT INTO purchase_orders (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING id`, vals);
    return rows[0].id;
  } catch (err) {
    if (withHash && err.code === '42703') {
      return createParsing(pool, { clientId, locationId, file, uploadedBy, sha: null });
    }
    throw err;
  }
}

async function saveParsed(pool, id, clientId, locationId, parsed) {
  const p = parsed.payload;
  // The receipt date, when the document carries one (migration 037). The
  // `deliveryDate` alias is accepted because that is the word on a delivery
  // note. Written ONLY where the column exists, so an estate that has not run
  // 037 keeps parsing; and only when the parse found one - an owner-entered
  // date must not be erased by a re-parse that did not see it on the page.
  const received = date(p.receivedDate) || date(p.deliveryDate);
  const hasReceived = await columnExists(pool, 'purchase_orders', 'received_date');
  const receivedSet = hasReceived && received
    ? `, received_date = $20` : '';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE purchase_orders SET
         status = 'parsed', parse_error = NULL,
         doc_type = $2, vendor_name = $3, account_no = $4, invoice_no = $5,
         invoice_date = $6, due_date = $7, po_number = $8, po_date = $9,
         currency = $10, subtotal = $11, tax_total = $12, discount_total = $13,
         delivery_total = $14, invoice_total = $15, notes = $16,
         parse_model = $17, parse_confidence = $18, parse_ms = $19,
         updated_at = now()${receivedSet}
       WHERE id = $1`,
      [id,
        p.docType === 'purchase_order' ? 'purchase_order' : 'invoice',
        str(p.vendorName), str(p.accountNo), str(p.invoiceNo),
        date(p.invoiceDate), date(p.dueDate), str(p.poNumber), date(p.poDate),
        str(p.currency), num(p.subtotal), num(p.taxTotal), num(p.discountTotal),
        num(p.deliveryTotal), num(p.invoiceTotal), str(p.notes),
        parsed.model, parsed.confidence, parsed.ms,
        ...(receivedSet ? [received] : [])]
    );
    await client.query('DELETE FROM purchase_order_items WHERE purchase_order_id = $1', [id]);

    let n = 0;
    for (const it of p.items || []) {
      n += 1;
      await client.query(
        `INSERT INTO purchase_order_items
           (purchase_order_id, client_id, location_id, line_no, product_no, product_name,
            upc, product_volume, pack, uom, quantity, cost, discount_amt, tax_amt,
            deposit_amt, ext_price, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, clientId, locationId, num(it.lineNo) ?? n, str(it.productNo), str(it.productName),
          str(it.upc), str(it.productVolume), str(it.pack), str(it.uom), num(it.quantity),
          num(it.cost), num(it.discountAmt), num(it.taxAmt), num(it.depositAmt),
          num(it.extPrice), str(it.note)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // NOW that the vendor and invoice number exist, ask whether this is a
  // document the store already has. Migration 013's content hash cannot see
  // this: a re-scan or a re-export of one invoice has different bytes and the
  // same identity.
  //
  // AFTER the commit and outside the transaction on purpose. The parse is the
  // valuable work and it is already safely stored; a failure to notice a
  // duplicate must not roll it back. Worst case we list one document twice,
  // which is exactly where we were before this check existed.
  try {
    const dup = await findDuplicateByIdentity(pool, clientId, locationId, {
      id, vendorName: p.vendorName, invoiceNo: p.invoiceNo,
    });
    if (dup) {
      await markDuplicate(pool, id, dup.id);
      return { duplicateOf: dup.id, duplicateInvoiceNo: dup.invoice_no };
    }
  } catch (err) {
    // Never fail a good parse over a bookkeeping check.
    logger.warn('[PO] duplicate identity check failed', { id, error: err.message });
  }
  return { duplicateOf: null };
}

async function markFailed(pool, id, message) {
  await pool.query(
    `UPDATE purchase_orders SET status = 'failed', parse_error = $2, updated_at = now() WHERE id = $1`,
    [id, String(message || 'Parse failed.').slice(0, 500)]
  );
}

/* ── Matching against the store's catalogue ───────────────────────────────── */

/**
 * Attach a `match` to every line.
 *
 * Three passes, strongest evidence first, because the cost of a wrong match is
 * higher than the cost of no match: a wrongly matched line quietly attributes
 * a delivery to the wrong product.
 *
 *   1. explicit  - a human already linked or created this line. Always wins.
 *   2. upc       - a barcode is an exact identity.
 *   3. sku       - the vendor's code sometimes IS the store's sku.
 *   4. name      - exact, case-folded, whitespace-collapsed. Deliberately NOT
 *                  fuzzy: "Titos 750ml" and "Titos 1.75L" are one edit apart
 *                  and are different products.
 */
/* ── Suggesting a match, without making one ─────────────────────────────────
 *
 * Exact matching is deliberate (see QUICK-PO.md section 5): a wrong automatic
 * match silently books a delivery against the wrong product, and that is far
 * more expensive than a line in a queue. But it is too strict in one specific
 * way - `Roku Japanese Gin 750ml` on the invoice against `Roku Gin 750ml` in
 * the catalogue is obviously the same bottle to a person and invisible to an
 * exact matcher.
 *
 * These functions propose. They never apply. A suggestion the owner accepts
 * goes through the same link endpoint as any other manual link.
 */

// Words that carry no identity. Dropping them stops "750ml bottle of gin"
// scoring against every other bottle of gin.
const STOP_TOKENS = new Set([
  'the', 'of', 'and', 'a', 'bottle', 'bottles', 'btl', 'can', 'cans', 'pack',
  'case', 'cs', 'ct', 'pk', 'nr', 'bt', 'each', 'ea', 'w', 'with',
]);

function tokenise(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length > 1 && !STOP_TOKENS.has(t));
}

/**
 * Volume in millilitres, or null. Captures the WHOLE number, so `1750ml` reads
 * 1750 and not 50 - the same trap the recommendation feed hit with 50ml minis.
 */
function volumeMl(name) {
  const m = String(name || '').match(/(\d+(?:\.\d+)?)\s*(ml|l|lt|ltr|liter|litre)s?\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return /^m/i.test(m[2]) ? n : n * 1000;
}

/**
 * 0..1 similarity between two product names.
 *
 * Size is a GATE rather than one token among many: if both names declare a
 * volume and the volumes disagree, this is not the same product however many
 * words they share. That is the "Titos 750ml" / "Titos 1.75L" case, and
 * treating size as a mere token is what would make this matcher dangerous.
 */
function nameScore(a, b) {
  const va = volumeMl(a);
  const vb = volumeMl(b);
  if (va !== null && vb !== null && Math.abs(va - vb) > 1) return 0;

  const ta = tokenise(a);
  const tb = tokenise(b);
  if (!ta.length || !tb.length) return 0;

  const sa = new Set(ta);
  const sb = new Set(tb);
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared += 1;
  if (!shared) return 0;

  // Overlap against the SHORTER name, so the catalogue's extra words
  // ("Roku Japanese Gin" vs "Roku Gin") do not punish a real match, then
  // tempered by overall similarity so a one-word hit on a long name does not
  // score as highly as a near-complete match.
  const containment = shared / Math.min(sa.size, sb.size);
  const jaccard = shared / (sa.size + sb.size - shared);
  let score = containment * 0.7 + jaccard * 0.3;

  // Agreeing on a stated size is genuine evidence, not just an absence of
  // contradiction.
  if (va !== null && vb !== null) score = Math.min(1, score + 0.1);
  return score;
}

const SUGGEST_FLOOR = 0.45;   // below this, say nothing
const SUGGEST_MARGIN = 0.15;  // clear of the runner-up before calling it confident
const SUGGEST_MAX = 3;

/** The best few candidates for one unmatched line. */
function suggestFor(item, catalogue) {
  const name = item.product_name;
  if (!name) return [];
  const scored = [];
  for (const r of catalogue) {
    const score = nameScore(name, r.product_name);
    if (score >= SUGGEST_FLOOR) scored.push({ r, score });
  }
  if (!scored.length) return [];
  scored.sort((x, y) => y.score - x.score);
  const top = scored[0];
  const runnerUp = scored[1] ? scored[1].score : 0;
  return scored.slice(0, SUGGEST_MAX).map((c, i) => ({
    sku: c.r.sku,
    productName: c.r.product_name,
    upc: c.r.upc || null,
    price: c.r.price === null || c.r.price === undefined ? null : Number(c.r.price),
    stockQty: c.r.stock_qty === null || c.r.stock_qty === undefined ? null : Number(c.r.stock_qty),
    score: Math.round(c.score * 100) / 100,
    // Only the leader can be confident, and only when it is clearly ahead.
    // Three sizes of one product must read as a choice, not as an answer.
    confident: i === 0 && c.score >= 0.72 && (c.score - runnerUp) >= SUGGEST_MARGIN,
  }));
}

async function attachMatches(syncgoPool, analyticsPool, clientId, locationId, items) {
  if (!items.length) return items;

  const upcs = [...new Set(items.map((i) => i.upc).filter(Boolean))];
  const nos = [...new Set(items.map((i) => i.product_no).filter(Boolean))];
  const skus = [...new Set(items.map((i) => i.matched_sku).filter(Boolean))];
  const names = [...new Set(items.map((i) => normaliseName(i.product_name)).filter(Boolean))];

  // Two sources, and the order matters. `products` is the POS catalogue, which
  // is truth. `po_manual_products` is Botella's own overlay - what the owner
  // told us exists because the POS did not know about it yet. POS rows are
  // loaded second and overwrite the overlay on the same key, so the day a
  // manually added product turns up in a real sync, the POS row wins.
  // Issued together, not one after the other. They hit two DIFFERENT databases
  // - the overlay is local, the catalogue is the remote warehouse - so waiting
  // for the first before starting the second adds a whole round trip to a
  // screen the owner is sitting in front of. Nothing here depends on the other.
  const [{ rows: manualRows }, { rows: posRows }] = await Promise.all([
    analyticsPool.query(
      `SELECT sku, upc, product_name, price, cost, stock_qty, category
         FROM po_manual_products
        WHERE client_id = $1 AND location_id = $2`,
      [clientId, locationId]
    ),
    syncgoPool.query(
    `SELECT sku, upc, product_name, price, cost, stock_qty, category
       FROM products
      WHERE client_id = $1 AND location_id = $2
        AND is_deleted IS NOT TRUE
        AND (
          ($3::text[] IS NOT NULL AND upc = ANY($3::text[])) OR
          ($4::text[] IS NOT NULL AND sku = ANY($4::text[])) OR
          ($5::text[] IS NOT NULL AND sku = ANY($5::text[])) OR
          ($6::text[] IS NOT NULL AND lower(regexp_replace(trim(product_name), '\\s+', ' ', 'g')) = ANY($6::text[]))
        )`,
      [clientId, locationId, upcs.length ? upcs : null, nos.length ? nos : null,
        skus.length ? skus : null, names.length ? names : null]
    ),
  ]);

  const byUpc = new Map(), bySku = new Map(), byName = new Map();
  // Overlay first, POS second, so POS overwrites on a collision.
  for (const r of [...manualRows, ...posRows]) {
    if (r.upc && !byUpc.has(r.upc)) byUpc.set(r.upc, r);
    if (r.sku && !bySku.has(r.sku)) bySku.set(r.sku, r);
    const n = normaliseName(r.product_name);
    if (n && !byName.has(n)) byName.set(n, r);
  }

  // Candidates for SUGGESTIONS only. The exact lookup above is keyed and
  // cheap; this needs a pool to compare names against, so it is fetched only
  // when something actually failed to match, and bounded.
  let suggestPool = [];
  const anyUnmatched = items.some((it) => {
    if (it.matched_sku && bySku.has(it.matched_sku)) return false;
    if (it.upc && byUpc.has(it.upc)) return false;
    if (it.product_no && bySku.has(it.product_no)) return false;
    const n = normaliseName(it.product_name);
    return !(n && byName.has(n));
  });

  if (anyUnmatched) {
    // Narrow by first token before scoring: pulling a 10,000-row catalogue into
    // memory to compare every name against every line is the kind of thing that
    // is fine on a test tenant and not fine on a real one.
    const leadTokens = [...new Set(
      items.flatMap((it) => tokenise(it.product_name).slice(0, 2)),
    )].filter((t) => t.length > 2).slice(0, 60);

    if (leadTokens.length) {
      const like = leadTokens.map((t) => `%${t}%`);
      const [pos, manual] = await Promise.all([
        syncgoPool.query(
          `SELECT sku, upc, product_name, price, cost, stock_qty, category
             FROM products
            WHERE client_id = $1 AND location_id = $2 AND is_deleted IS NOT TRUE
              AND product_name ILIKE ANY($3::text[])
            LIMIT 400`,
          [clientId, locationId, like],
        ),
        analyticsPool.query(
          `SELECT sku, upc, product_name, price, cost, stock_qty, category
             FROM po_manual_products
            WHERE client_id = $1 AND location_id = $2
              AND product_name ILIKE ANY($3::text[])
            LIMIT 200`,
          [clientId, locationId, like],
        ),
      ]);
      const seen = new Set();
      suggestPool = [...pos.rows, ...manual.rows].filter((r) => {
        if (!r.sku || seen.has(r.sku)) return false;
        seen.add(r.sku);
        return true;
      });
    }
  }

  return items.map((it) => {
    let product = null;
    let via = null;
    if (it.matched_sku && bySku.has(it.matched_sku)) {
      product = bySku.get(it.matched_sku);
      via = it.match_source || 'manual';
    } else if (it.upc && byUpc.has(it.upc)) { product = byUpc.get(it.upc); via = 'upc'; }
    else if (it.product_no && bySku.has(it.product_no)) { product = bySku.get(it.product_no); via = 'sku'; }
    else {
      const n = normaliseName(it.product_name);
      if (n && byName.has(n)) { product = byName.get(n); via = 'name'; }
    }
    // Suggestions are attached ONLY to lines that failed to match. A matched
    // line offering alternatives would invite someone to second-guess a UPC
    // hit, which is the one match that is never wrong.
    const suggestions = product ? [] : suggestFor(it, suggestPool);
    return {
      ...it,
      suggestions,
      match: product ? {
        matched: true,
        via,
        sku: product.sku,
        productName: product.product_name,
        price: product.price != null ? Number(product.price) : null,
        cost: product.cost != null ? Number(product.cost) : null,
        onHand: product.stock_qty != null ? parseInt(product.stock_qty, 10) : 0,
        category: product.category || null,
      } : { matched: false, via: null },
    };
  });
}

const normaliseName = (s) => (s ? String(s).trim().replace(/\s+/g, ' ').toLowerCase() : null);

/* ── Reads ────────────────────────────────────────────────────────────────── */

/**
 * A page of documents, optionally searched and filtered.
 *
 * `q` searches the three things anyone actually remembers about an invoice -
 * its number, its PO number, and who sent it. `status` is the parse state
 * ('parsing' | 'parsed' | 'failed').
 *
 * The filter is built once and used for BOTH the page and the total, so the
 * "1-25 of N" line counts the same rows the table is showing. Counting all
 * documents while displaying a filtered page is the classic version of this
 * bug: the header promises results the table does not have.
 */
async function list(pool, clientId, locationId,
  { limit = 50, offset = 0, q = '', status = '', includeDuplicates = false } = {}) {
  const hasDuplicateColumn = await columnExists(pool, 'purchase_orders', 'duplicate_of');
  const where = ['o.client_id = $1', 'o.location_id = $2'];
  const params = [clientId, locationId];

  const term = String(q || '').trim();
  if (term) {
    params.push(`%${term}%`);
    const p = `$${params.length}`;
    // Parameterised LIKE, never interpolated - an invoice number is user input.
    where.push(`(o.invoice_no ILIKE ${p} OR o.po_number ILIKE ${p} OR o.vendor_name ILIKE ${p})`);
  }

  const wanted = String(status || '').trim();
  if (wanted && ['parsing', 'parsed', 'failed'].includes(wanted)) {
    params.push(wanted);
    where.push(`o.status = $${params.length}`);
  }

  // A recognised duplicate is kept but not listed. The reader uploaded it and
  // may go looking for it, so it stays reachable by id and by asking for it -
  // it simply does not sit in the table pretending to be a second delivery.
  //
  // Guarded with to_regclass rather than assumed: an estate that has not run
  // migration 021 has no such column, and this filter must not break its list.
  if (!includeDuplicates && hasDuplicateColumn !== false) {
    where.push('o.duplicate_of IS NULL');
  }

  const filter = where.join(' AND ');

  // mapped_count alongside item_count: with both, the UI can say whether a
  // document still needs attention without fetching every line of every row.
  const pageParams = params.concat([
    Math.min(Number(limit) || 50, 200),
    Math.max(Number(offset) || 0, 0),
  ]);
  const { rows } = await pool.query(
    `SELECT o.*,
            (SELECT count(*)::int FROM purchase_order_items i
              WHERE i.purchase_order_id = o.id) AS item_count,
            (SELECT count(*)::int FROM purchase_order_items i
              WHERE i.purchase_order_id = o.id AND i.matched_sku IS NOT NULL) AS mapped_count
       FROM purchase_orders o
      WHERE ${filter}
      ORDER BY o.created_at DESC
      LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams
  );

  const { rows: [{ total }] } = await pool.query(
    `SELECT count(*)::int AS total FROM purchase_orders o WHERE ${filter}`,
    params
  );
  return { rows, total };
}

async function getDetail(pool, syncgoPool, clientId, locationId, id) {
  const { rows: [order] } = await pool.query(
    `SELECT * FROM purchase_orders WHERE id = $1 AND client_id = $2 AND location_id = $3`,
    [id, clientId, locationId]
  );
  if (!order) return null;

  const { rows: items } = await pool.query(
    `SELECT * FROM purchase_order_items
      WHERE purchase_order_id = $1 AND client_id = $2 AND location_id = $3
      ORDER BY line_no, id`,
    [id, clientId, locationId]
  );

  const matched = await attachMatches(syncgoPool, pool, clientId, locationId, items);
  return {
    ...order,
    items: matched,
    unmatchedCount: matched.filter((i) => !i.match.matched).length,
    itemCount: matched.length,
  };
}

module.exports = {
  columnExists,
  contentHash,
  findByContent,
  findDuplicateByIdentity,
  findEarlierByContent,
  markDuplicate,
  normaliseInvoiceNo,
  normaliseVendor,
  // Exported for the suggestion tests - size gating is the part worth
  // checking directly rather than through the API.
  nameScore,
  volumeMl,
  parseDocument,
  storeFile,
  resolveFile,
  createParsing,
  saveParsed,
  logEvent,
  listEvents,
  markFailed,
  list,
  getDetail,
  attachMatches,
  UPLOAD_DIR,
  PARSE_MODEL,
};
