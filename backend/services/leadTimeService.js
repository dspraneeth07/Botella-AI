/**
 * Per-supplier delivery lead times, with provenance.
 *
 * WHAT WAS WRONG
 * --------------
 * The engine's reorder quantity rests on a lead time, and the lead time was
 * seven days everywhere, declared three times over (inventory.py's registry
 * Setting, deterministic.py's module constant, storeagent/config.py), and never
 * measurable because nothing recorded when an order ARRIVED. Migration 037 adds
 * `purchase_orders.received_date` so that it can be, and this service turns
 * the receipts into one row per (store, vendor) in `supplier_lead_times`.
 *
 * THE RULE
 * --------
 *   lead time  = received_date - COALESCE(po_date, invoice_date)
 *   per vendor = MEDIAN over the trailing year, on documents with both dates
 *
 * The median, not the mean: a single delivery that sat on a dock for a month
 * must not drag a vendor who is otherwise reliable to a fortnight. And only
 * documents with BOTH dates - a receipt date with nothing to subtract from is
 * not an observation.
 *
 * `po_date` is preferred over `invoice_date` because it is the day the order
 * was placed; the invoice is usually cut on the day of delivery, in which case
 * `received - invoice` reads zero and says nothing about the wait. A zero or
 * negative gap is dropped as an observation for exactly that reason.
 *
 * PROVENANCE IS THE PRODUCT
 * -------------------------
 * A vendor with fewer than LEAD_TIME_MIN_OBSERVATIONS receipts gets a row with
 * source='default' and the declared default, NOT a measured row on one data
 * point and NOT no row at all. The consumer must be able to tell "this is the
 * default" from "nobody has looked", and a card must be able to say "measured
 * from 4 receipts between March and June" rather than printing a bare number.
 *
 * ONE NORMALISER. The vendor key is `normaliseVendor` from
 * purchaseOrderService - the fold the duplicate-invoice check already uses -
 * applied in JavaScript. The grouping is therefore done here rather than in
 * SQL, so the rule exists once; a store has tens of documents a year, not
 * millions, and the rows are cheap.
 */

const logger = require('../utils/logger');
const { normaliseVendor } = require('./purchaseOrderService');

// The declared default, for a vendor nobody has measured. Seven is the same
// figure app/pipeline/policy/inventory.py declares as LEAD_TIME_DAYS, and for
// the same reason it gives there: a common distributor cycle and nothing more.
// The Python side keeps its own registry Setting as the figure it ORDERS
// against; this one is what the default ROW carries, so the audit of the table
// shows what the engine was assuming at the time.
const LEAD_TIME_DEFAULT_DAYS = Math.max(1, parseInt(process.env.LEAD_TIME_DEFAULT_DAYS || '7', 10) || 7);

// Receipts a vendor needs before its median is written as measured. Three is
// the smallest count at which a median is not simply one of the observations.
const LEAD_TIME_MIN_OBSERVATIONS = Math.max(1, parseInt(process.env.LEAD_TIME_MIN_OBSERVATIONS || '3', 10) || 3);

// Trailing window for observations. A year, so a vendor who changed its
// delivery day last spring is not still described by the year before.
const LEAD_TIME_WINDOW_DAYS = 365;

// Receipts implausibly far from the order are data entry, not delivery: a
// received_date typed as the wrong year would otherwise become a 400-day
// median. Ninety days is generous for any distributor this product serves.
const LEAD_TIME_MAX_DAYS = 90;

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/**
 * A date-only string from whatever the driver hands back.
 *
 * The queries below cast every `date` column to text, so this normally sees a
 * string. The Date branch formats LOCAL components, not toISOString(): pg
 * builds a date-only value at local midnight, and converting that to UTC on a
 * machine east of Greenwich moves it to the previous day - which this file
 * did once on the refresh read and once on the get, and a receipt dated the
 * 6th came back as the 4th.
 */
function toDay(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function daysBetween(fromDay, toDayStr) {
  const a = Date.parse(`${fromDay}T00:00:00Z`);
  const b = Date.parse(`${toDayStr}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** The median of a non-empty numeric array. */
function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Group a store's dated documents by vendor and compute each vendor's figure.
 *
 * Pure, and exported for the verify test: the arithmetic is the part worth
 * checking without a database. `rows` carry vendor_name, po_date, invoice_date,
 * received_date, and an `id` used only to pick the latest spelling.
 */
function computeLeadTimes(rows, {
  defaultDays = LEAD_TIME_DEFAULT_DAYS,
  minObservations = LEAD_TIME_MIN_OBSERVATIONS,
} = {}) {
  const byVendor = new Map();
  for (const r of rows) {
    const key = normaliseVendor(r.vendor_name);
    if (!key) continue;
    let v = byVendor.get(key);
    if (!v) {
      v = { vendor_key: key, vendor_name: null, latestId: -1, gaps: [], from: null, to: null };
      byVendor.set(key, v);
    }
    const id = Number(r.id) || 0;
    if (id >= v.latestId && r.vendor_name) { v.latestId = id; v.vendor_name = String(r.vendor_name).trim(); }

    const ordered = toDay(r.po_date) || toDay(r.invoice_date);
    const received = toDay(r.received_date);
    if (!ordered || !received) continue;
    const gap = daysBetween(ordered, received);
    // Zero means the invoice was cut on delivery day and the order date is
    // unknown; negative means a typo. Neither is a wait that was observed.
    if (gap == null || gap <= 0 || gap > LEAD_TIME_MAX_DAYS) continue;
    v.gaps.push(gap);
    if (!v.from || received < v.from) v.from = received;
    if (!v.to || received > v.to) v.to = received;
  }

  const out = [];
  for (const v of byVendor.values()) {
    if (v.gaps.length >= minObservations) {
      out.push({
        vendor_key: v.vendor_key, vendor_name: v.vendor_name,
        lead_time_days: median(v.gaps), source: 'measured',
        observations: v.gaps.length, measured_from: v.from, measured_to: v.to,
      });
    } else {
      out.push({
        vendor_key: v.vendor_key, vendor_name: v.vendor_name,
        lead_time_days: defaultDays, source: 'default',
        observations: 0, measured_from: null, measured_to: null,
      });
    }
  }
  return out.sort((a, b) => a.vendor_key.localeCompare(b.vendor_key));
}

/* ── Refresh ──────────────────────────────────────────────────────────────── */

/**
 * Recompute and republish one store's vendor rows.
 *
 * Every vendor seen on a parsed document in the trailing year gets a row -
 * default or measured - and vendors no longer seen drop out, in one
 * transaction, so the table is never half of one night and half of another.
 *
 * Degrades to {skipped} when migration 037 has not run: a missing column or
 * table is a deployment state, not a reason to fail the cron that called this.
 */
async function refreshLeadTimes(analyticsPool, clientId, locationId) {
  let rows;
  try {
    ({ rows } = await analyticsPool.query(
      `SELECT id, vendor_name, po_date::text AS po_date,
              invoice_date::text AS invoice_date, received_date::text AS received_date
         FROM purchase_orders
        WHERE client_id = $1 AND location_id = $2
          AND status = 'parsed'
          AND duplicate_of IS NULL
          AND vendor_name IS NOT NULL
          AND COALESCE(received_date, po_date, invoice_date, created_at::date)
              >= CURRENT_DATE - $3::int`,
      [clientId, locationId, LEAD_TIME_WINDOW_DAYS]
    ));
  } catch (err) {
    if (err.code === '42703' || err.code === '42P01') {
      logger.warn('[LeadTime] purchase_orders is not at migration 037 yet - skipping', {
        clientId, locationId, error: err.message });
      return { skipped: true, vendors: 0, measured: 0 };
    }
    throw err;
  }

  const computed = computeLeadTimes(rows);
  const client = await analyticsPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM supplier_lead_times WHERE client_id = $1 AND location_id = $2`,
      [clientId, locationId]
    );
    for (const v of computed) {
      await client.query(
        `INSERT INTO supplier_lead_times
           (client_id, location_id, vendor_key, vendor_name, lead_time_days,
            source, observations, measured_from, measured_to, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
        [clientId, locationId, v.vendor_key, v.vendor_name, v.lead_time_days,
          v.source, v.observations, v.measured_from, v.measured_to]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '42P01') {
      logger.warn('[LeadTime] supplier_lead_times is missing - run migrations', {
        clientId, locationId });
      return { skipped: true, vendors: 0, measured: 0 };
    }
    throw err;
  } finally {
    client.release();
  }

  const measured = computed.filter((v) => v.source === 'measured').length;
  return { skipped: false, vendors: computed.length, measured };
}

/* ── Reads ────────────────────────────────────────────────────────────────── */

/**
 * {vendor_key: {lead_time_days, source, observations, vendor_name,
 *               measured_from, measured_to}} for one store.
 *
 * An EMPTY object is the normal answer at a store that has uploaded nothing,
 * and at an estate that has not run 037 - the Python consumer treats both as
 * "no vendor is known" and keeps its declared default, saying so.
 */
async function getLeadTimes(analyticsPool, clientId, locationId) {
  let rows;
  try {
    ({ rows } = await analyticsPool.query(
      `SELECT vendor_key, vendor_name, lead_time_days, source, observations,
              measured_from::text AS measured_from, measured_to::text AS measured_to
         FROM supplier_lead_times
        WHERE client_id = $1 AND location_id = $2
        ORDER BY vendor_key`,
      [clientId, locationId]
    ));
  } catch (err) {
    if (err.code === '42P01') return {};
    throw err;
  }
  const out = {};
  for (const r of rows) {
    out[r.vendor_key] = {
      lead_time_days: Number(r.lead_time_days),
      source: r.source,
      observations: Number(r.observations) || 0,
      vendor_name: r.vendor_name || r.vendor_key,
      measured_from: toDay(r.measured_from),
      measured_to: toDay(r.measured_to),
    };
  }
  return out;
}

/**
 * {sku: vendor_key} - which vendor supplies each of the store's SKUs, as far
 * as the parsed documents say.
 *
 * WHY THIS SOURCE AND NOT `syncgo.purchases`. The POS purchases ledger names a
 * supplier for far more SKUs than the uploaded invoices do, but it names them
 * in a different key space (the POS supplier record, not the letterhead), it
 * has no receipt date so it can never produce a measured lead time, and
 * nobody has verified a cross-walk between the two spellings. A measured
 * lead time exists ONLY for vendors seen on parsed documents, so the SKU map
 * is built from the same documents: the key on the SKU side and the key on
 * the vendor side then agree by construction. Coverage is thinner and that is
 * honest - a SKU this map does not know keeps the declared default and the
 * card says so.
 *
 * Resolution mirrors the two strongest passes of `attachMatches`:
 *   1. matched_sku  - an explicit human link; always wins.
 *   2. upc / product_no against the POS catalogue - a barcode is an identity,
 *      and the vendor's code sometimes IS the store's sku. The fuzzy name pass
 *      is deliberately NOT used here: a wrong vendor on a SKU would quietly
 *      size its orders against the wrong supplier's lead time.
 * A SKU seen under two vendors goes to the one with more lines, most recent
 * document breaking the tie.
 */
async function getSkuVendorMap(analyticsPool, syncgoPool, clientId, locationId) {
  let rows;
  try {
    ({ rows } = await analyticsPool.query(
      `SELECT o.id AS order_id, o.vendor_name, i.matched_sku, i.upc, i.product_no
         FROM purchase_order_items i
         JOIN purchase_orders o ON o.id = i.purchase_order_id
        WHERE i.client_id = $1 AND i.location_id = $2
          AND o.client_id = $1 AND o.location_id = $2
          AND o.status = 'parsed'
          AND o.duplicate_of IS NULL
          AND o.vendor_name IS NOT NULL
          AND COALESCE(o.received_date, o.po_date, o.invoice_date, o.created_at::date)
              >= CURRENT_DATE - $3::int`,
      [clientId, locationId, LEAD_TIME_WINDOW_DAYS]
    ));
  } catch (err) {
    if (err.code === '42703' || err.code === '42P01') return {};
    throw err;
  }
  if (!rows.length) return {};

  // Resolve barcodes and vendor codes against the POS catalogue in one query.
  const upcs = [...new Set(rows.map((r) => r.upc).filter(Boolean))];
  const nos = [...new Set(rows.map((r) => r.product_no).filter(Boolean))];
  const byUpc = new Map();
  const posSkus = new Set();
  if (syncgoPool && (upcs.length || nos.length)) {
    try {
      const { rows: products } = await syncgoPool.query(
        `SELECT sku, upc FROM products
          WHERE client_id = $1 AND location_id = $2 AND is_deleted IS NOT TRUE
            AND (($3::text[] IS NOT NULL AND upc = ANY($3::text[]))
              OR ($4::text[] IS NOT NULL AND sku = ANY($4::text[])))`,
        [clientId, locationId, upcs.length ? upcs : null, nos.length ? nos : null]
      );
      for (const p of products) {
        if (p.sku) posSkus.add(p.sku);
        if (p.upc && p.sku && !byUpc.has(p.upc)) byUpc.set(p.upc, p.sku);
      }
    } catch (err) {
      // The catalogue being unreachable costs the UPC pass, not the map.
      logger.warn('[LeadTime] catalogue lookup failed; explicit links only', {
        clientId, locationId, error: err.message });
    }
  }

  // sku -> vendor_key -> {lines, latest}
  const tally = new Map();
  for (const r of rows) {
    const key = normaliseVendor(r.vendor_name);
    if (!key) continue;
    const sku = r.matched_sku
      || (r.upc && byUpc.get(r.upc))
      || (r.product_no && posSkus.has(r.product_no) ? r.product_no : null);
    if (!sku) continue;
    let perVendor = tally.get(sku);
    if (!perVendor) { perVendor = new Map(); tally.set(sku, perVendor); }
    const t = perVendor.get(key) || { lines: 0, latest: -1 };
    t.lines += 1;
    t.latest = Math.max(t.latest, Number(r.order_id) || 0);
    perVendor.set(key, t);
  }

  const out = {};
  for (const [sku, perVendor] of tally) {
    let best = null;
    for (const [key, t] of perVendor) {
      if (!best || t.lines > best.t.lines
          || (t.lines === best.t.lines && t.latest > best.t.latest)) {
        best = { key, t };
      }
    }
    if (best) out[sku] = best.key;
  }
  return out;
}

module.exports = {
  LEAD_TIME_DEFAULT_DAYS,
  LEAD_TIME_MIN_OBSERVATIONS,
  LEAD_TIME_WINDOW_DAYS,
  LEAD_TIME_MAX_DAYS,
  computeLeadTimes,
  median,
  refreshLeadTimes,
  getLeadTimes,
  getSkuVendorMap,
};
