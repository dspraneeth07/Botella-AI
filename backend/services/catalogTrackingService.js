/**
 * Catalog Tracking Service - detect newly-added products without a created_at.
 *
 * `products` (syncgo) has no creation timestamp, and `last_updated` mutates on
 * every sync, so "when was this SKU added?" cannot be answered from the source
 * table (see integrationService.js header). Instead we keep ONE registry table
 * in the ANALYTICS Postgres:
 *
 *   product_first_seen - one row per (client_id, location_id, sku): when the
 *       SKU first appeared, plus its `upc` (the cross-store product identity -
 *       sku is a per-location POS code and means nothing at another store).
 *       Rows written on a tenant's very first pass are flagged `is_baseline`:
 *       the catalog that existed before tracking started is NOT "new", so
 *       baseline SKUs never surface as new arrivals.
 *
 * Every pass runs the same idempotent set-diff: INSERT the current SKU list
 * ON CONFLICT DO NOTHING - whatever actually inserts is new. No stored count,
 * no last-run date, no short-circuit: the diff IS the cheap operation (one
 * indexed insert per pull, daily per store), and skipping it based on a stored
 * count or run date re-introduces the add+remove-cancels blind spot for zero
 * real savings. `first_seen_at` is the detection time - the true insert
 * happened somewhere between the previous pull and this one, so with the daily
 * cadence the date is accurate to within a day.
 *
 * PROVISIONING - the table is NOT created here. The app role (bottleai_writer)
 * deliberately has no schema-CREATE (the "permission denied for schema public"
 * trap the feedback table hit). It ships as
 * database/analytics-migrations/001_product_first_seen.sql, applied by the
 * migration runner (`npm run migrate`, or MIGRATE_ON_BOOT=true - see
 * database/migrate.js); this service only ever SELECTs and INSERTs. Until the
 * table exists, firstSeenMapSafe() degrades to an empty map (created_at null).
 *
 * Called from the integration inventory endpoint (routes/integration.js),
 * which the Python service hits before every recommendation run - so the
 * registry stays current without a dedicated cron. The registry also feeds the
 * cross-store "area winners" feature (integrationService.getAreaWinners).
 *
 * Tenancy (house rule): every query filters on BOTH client_id AND location_id.
 * (getRecentNewProducts is the audited exception: a deliberate cross-tenant
 * read of this backend-owned registry, feeding only anonymized aggregates.)
 */

const logger = require('../utils/logger');

// Only additions this recent are interesting downstream (the Python side's
// new-arrival window is 7 days) - bounding the map keeps the payload flat no
// matter how many additions accumulate over the years.
const FIRST_SEEN_WINDOW_DAYS = 90;

/**
 * Run one detection pass for a tenant against its current visible product list
 * (the same filtered rows the inventory endpoint returns: non-deleted,
 * non-empty sku). `products` is [{ sku, upc }]. Returns the first-seen map for
 * recent NON-baseline additions: { sku: Date }.
 */
async function syncCatalog(pool, clientId, locationId, products) {
  const skus = products.map((p) => p.sku);
  const upcs = products.map((p) => (p.upc == null ? null : String(p.upc)));

  // A tenant with no registry rows yet is on its first pass → baseline.
  const seeded = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM product_first_seen
        WHERE client_id = $1 AND location_id = $2
     ) AS seeded`,
    [clientId, locationId]
  );
  const isBaseline = !seeded.rows[0].seeded;

  const inserted = await pool.query(
    `INSERT INTO product_first_seen (client_id, location_id, sku, upc, is_baseline)
     SELECT $1, $2, s.sku, s.upc, $5
       FROM unnest($3::text[], $4::text[]) AS s(sku, upc)
     ON CONFLICT (client_id, location_id, sku) DO NOTHING
     RETURNING sku`,
    [clientId, locationId, skus, upcs, isBaseline]
  );

  if (isBaseline) {
    logger.info(
      `[CatalogTracking] baseline seeded for ${clientId}:${locationId} (${inserted.rows.length} SKUs)`
    );
  } else if (inserted.rows.length) {
    const added = inserted.rows.map((r) => r.sku);
    logger.info(
      `[CatalogTracking] ${added.length} new product(s) for ${clientId}:${locationId}: ` +
        added.slice(0, 20).join(', ') + (added.length > 20 ? ', …' : '')
    );
  }

  const recent = await pool.query(
    `SELECT sku, first_seen_at FROM product_first_seen
      WHERE client_id = $1 AND location_id = $2
        AND is_baseline IS FALSE
        AND first_seen_at >= now() - make_interval(days => $3)`,
    [clientId, locationId, FIRST_SEEN_WINDOW_DAYS]
  );
  const map = {};
  for (const row of recent.rows) map[row.sku] = row.first_seen_at;
  return map;
}

/**
 * Non-throwing wrapper for read paths: any failure (analytics DB down, table
 * not yet provisioned, …) logs a warning and returns an empty map, so
 * inventory serves created_at = null exactly as it did before this feature.
 */
async function firstSeenMapSafe(pool, clientId, locationId, products) {
  try {
    return await syncCatalog(pool, clientId, locationId, products);
  } catch (err) {
    logger.warn(
      `[CatalogTracking] detection skipped for ${clientId}:${locationId}: ${err.message}`
    );
    return {};
  }
}

/**
 * Recent non-baseline arrivals across ALL tenants - the seed list for the
 * cross-store "area winners" aggregation. DELIBERATELY cross-tenant: this
 * registry is backend-owned metadata (sku/upc/date, no sales figures), and the
 * consumer (integrationService.getAreaWinners) re-queries every sales number
 * through the tenant-scoped pool per contributing store and returns only
 * anonymized aggregates. Rows without a upc are excluded - without the
 * cross-store identity they can't be matched anywhere else.
 */
async function getRecentNewProducts(pool, windowDays) {
  const { rows } = await pool.query(
    `SELECT client_id, location_id, sku, upc, first_seen_at
       FROM product_first_seen
      WHERE is_baseline IS FALSE
        AND upc IS NOT NULL
        AND first_seen_at >= now() - make_interval(days => $1)`,
    [windowDays]
  );
  return rows;
}

module.exports = {
  syncCatalog,
  firstSeenMapSafe,
  getRecentNewProducts,
  FIRST_SEEN_WINDOW_DAYS,
};
