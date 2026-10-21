/**
 * Integration Service - data access for the external Python recommendation service.
 *
 * The Python service holds NO database connection. It pulls every DB-backed value
 * from this Node backend over HTTP (profile / inventory / sales), computes
 * contextual signals + one LLM call, and hands recommendations back to Node to
 * persist. This module is the single place that turns the `syncgo` schema into the
 * exact JSON shapes that contract expects, so the route layer stays thin.
 *
 * Tenancy: every query filters on BOTH `client_id` AND `location_id` (house rule -
 * see ARCHITECTURE.md). Both keys arrive from the caller as path segments, so there
 * is no client-from-location resolution here.
 *
 * Schema-mapping notes (contract field ← real column):
 *   profile.{address,city,state,postal_code,country}  ← client_locations.* (direct).
 *       The Python side geocodes "address, city, state, postal_code" to lat/long
 *       (free US Census geocoder, cached) for NWS weather + Ticketmaster events, so
 *       we ship the street address rather than coordinates. latitude/longitude/
 *       dma_code are intentionally OMITTED - sending them would make Python skip
 *       geocoding. (Add them only if real coordinate columns ever exist.)
 *   profile.size_class →  NOT STORED. Returned as "medium" (contract default).
 *   inventory.on_hand  ← products.stock_qty
 *   inventory.price    ← products.price (0 when absent)
 *   inventory.cost     ← products.cost (margin input; null - never 0 - when absent,
 *       so Python doesn't infer a 100% margin). NOT sale_items.cost (≈0 - ARCHITECTURE).
 *   inventory.created_at →  NOT STORED in syncgo. products has no creation timestamp
 *       (`last_updated` mutates on every sync, so using it would mislabel the whole
 *       catalogue as "new arrivals"). This module returns null; the inventory ROUTE
 *       fills it from the first-seen registry (services/catalogTrackingService.js,
 *       analytics DB), which activates the Python side's new-arrivals slice.
 *   sales              ← pre-aggregated per sku per day from `sale_items`
 *       (units = SUM(quantity); unit_price = revenue-weighted SUM(total_amount) /
 *        SUM(quantity), per ARCHITECTURE Rule 6a - never a simple AVG).
 */

const logger = require('../utils/logger');
const catalogTracking = require('./catalogTrackingService');
const { makeTenantScopedPool } = require('../database/connection');

// ─── Tenant/profile cache ────────────────────────────────────────────────────
// Store metadata (the client_locations row) is effectively static and is read on
// every Python call (profile + the existence check that guards inventory/sales).
// A short TTL cache makes that lookup essentially free without risking meaningful
// staleness. Only positive hits are cached, so a newly-added location shows up on
// its next call rather than after the TTL.
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const profileCache = new Map(); // `${clientId}:${locationId}` → { row, expiresAt }

// Bound the sales window so a malformed `days` can't ask for an unbounded scan.
const SALES_DAYS_DEFAULT = 90;
const SALES_DAYS_MIN = 1;
const SALES_DAYS_MAX = 365;

// Co-purchase pair cap (contract default 50). Python only shows pairs whose SKUs
// are both in its candidate pool, so it wants "top pairs by support" - bounded.
const COPURCHASE_LIMIT_DEFAULT = 50;
const COPURCHASE_LIMIT_MAX = 500;

// Recommendation-history cap. The feedback loop's signal is the store's votes plus
// a little recency - shipping every rec in the window would balloon the Python
// prompt as daily runs accumulate (~10 recs/day). getRecommendationHistory ranks
// voted (liked/disliked) recs first, then fills the rest with the most recent, so
// this bound keeps the feedback intact while capping prompt context.
const HISTORY_LIMIT_DEFAULT = 20;
const HISTORY_LIMIT_MAX = 100;

/**
 * Coerce/validate the `days` query param into a bounded integer.
 * @param {number} [def]  default when absent/malformed (history uses 30, not 90)
 * @returns {number} clamped to [SALES_DAYS_MIN, SALES_DAYS_MAX]
 */
function normalizeDays(raw, def = SALES_DAYS_DEFAULT) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(SALES_DAYS_MAX, Math.max(SALES_DAYS_MIN, n));
}

/** Coerce/validate the co-purchases `limit` query param. */
function normalizeLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return COPURCHASE_LIMIT_DEFAULT;
  return Math.min(COPURCHASE_LIMIT_MAX, Math.max(1, n));
}

/** Coerce/validate the recommendation-history `limit` query param. */
function normalizeHistoryLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return HISTORY_LIMIT_DEFAULT;
  return Math.min(HISTORY_LIMIT_MAX, Math.max(1, n));
}

/**
 * Fetch the raw client_locations row for a (clientId, locationId) pair, cached.
 * Returns null when the pair does not exist - callers turn that into a 404.
 */
async function getLocationRow(pool, clientId, locationId) {
  const key = `${clientId}:${locationId}`;
  const cached = profileCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.row;

  const { rows } = await pool.query(
    `SELECT location_id, client_id, location_name, address, city, state, postal_code, country
       FROM client_locations
      WHERE client_id = $1 AND location_id = $2
      LIMIT 1`,
    [clientId, locationId]
  );
  const row = rows[0] || null;
  if (row) {
    profileCache.set(key, { row, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS });
  }
  return row;
}

/**
 * Map a client_locations row to the contract's profile shape.
 * Pass the row from getLocationRow() so we don't query twice.
 */
function toProfile(row) {
  return {
    id: row.location_id,
    name: row.location_name || 'Unknown store',
    address: row.address ?? null,       // street line - Python geocodes this
    city: row.city ?? null,
    state: row.state ?? null,
    postal_code: row.postal_code ?? null,
    country: row.country ?? null,       // geocoding is US-only; non-US is skipped
    size_class: 'medium',               // not stored; contract default
    // latitude/longitude/dma_code intentionally omitted - see module header.
  };
}

/**
 * Current on-hand snapshot - one row per stocked product (incl. on_hand = 0),
 * excluding soft-deleted products. Rows with no usable SKU are dropped (sku is the
 * join key for sales and is required by the contract).
 *
 * `upc` is included as informational product metadata (the real barcode). It is NOT a
 * join key: it is non-unique within a store (one upc can map to many products - up to
 * 15 observed), so joining on it fans out and inflates totals. The Python service joins
 * inventory↔sales on `sku` (verified ~100% on well-synced stores). `category`/
 * `sub_category` are coerced from empty-string to NULL so the Python side can cleanly
 * detect missing classification and fall back to its product-name classifier.
 */
// ─── Small-format (miniature) exclusion ─────────────────────────────────
//
// 50ml minis were dominating the generated recommendations - 21% of a recent
// 45-day sample, showing up as reorder, bundle, cold_box, pre_stock AND
// liquidate, sometimes for the same size of product in one run.
//
// They rank highly for a structural reason, not a data error: a mini costs
// $0.89-$1.99 and is held in hundreds or thousands of units (one store carries
// 1,035 units of a single 50ml SKU). Any score computed on UNITS rather than
// dollars reads that as both high velocity ("fast mover, reorder it") and high
// stock ("overstocked, clear it").
//
// WHY THE NAME, NOT A COLUMN. `products.pack_size` and `products.uom` look like
// the right fields and are not: across the whole 9,732-row catalogue they hold
// exactly one value each, '1' and '0.0'. There is no structured size in this
// data. The name string is the only place a size is recorded, so it is the only
// thing that can be parsed.
//
// SCOPE. This gate sits on the integration feed, which is machine-to-machine
// (verifyServiceToken) and has exactly ONE consumer: the Python recommendation
// service. The dashboard, Purchasing and dead-stock screens read their own
// queries and are unaffected - a mini still counts in your inventory value and
// still appears in Purchasing › Clear. It is only withheld from the engine that
// was over-recommending it.
//
// KILL SWITCH. Set REC_FEED_INCLUDE_MINIS=true to restore the previous feed
// without a deploy.

// Anything at or below this many millilitres is withheld. 100 keeps the two
// true miniature formats (50ml, 100ml) out while leaving 187ml splits and up.
const MINI_ML_MAX = parseInt(process.env.REC_FEED_MINI_ML_MAX || '100', 10);
const INCLUDE_MINIS = String(process.env.REC_FEED_INCLUDE_MINIS || '').toLowerCase() === 'true';

// Volume in millilitres parsed from a product name, or null when the name says
// nothing about size.
//
// The number is captured WHOLE, which is what keeps "750ml" and "1750ml" out of
// a naive "50ml" match - they parse as 750 and 1750, not 50. Litres are
// converted, so "Titos 1.75L" is 1750ml and stays.
function volumeMlFromName(name) {
  if (!name) return null;
  const m = String(name).match(/(\d+(?:\.\d+)?)\s*(ml|l|lt|ltr|liter|litre)s?\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /^m/i.test(m[2]) ? n : n * 1000;
}

// A product is only excluded when its name STATES a small size. A name with no
// size parses to null and is kept: silently dropping products we cannot measure
// would be a worse failure than the one this fixes.
function isMiniFormat(name) {
  const ml = volumeMlFromName(name);
  return ml !== null && ml <= MINI_ML_MAX;
}

async function getInventory(pool, clientId, locationId) {
  const { rows } = await pool.query(
    `SELECT sku,
            upc,
            product_name,
            NULLIF(TRIM(category),     '') AS category,
            NULLIF(TRIM(sub_category), '') AS sub_category,
            price,
            cost,
            stock_qty
       FROM products
      WHERE client_id = $1 AND location_id = $2
        AND is_deleted IS NOT TRUE
        AND NULLIF(TRIM(sku), '') IS NOT NULL
      ORDER BY sku`,
    [clientId, locationId]
  );

  // Withhold miniatures from the recommendation engine's candidate pool. Done
  // here rather than in SQL because the size has to be parsed out of the name
  // (see isMiniFormat) and a JS parse is far clearer than the equivalent regex
  // in Postgres.
  const kept = INCLUDE_MINIS ? rows : rows.filter((r) => !isMiniFormat(r.product_name));
  if (kept.length !== rows.length) {
    logger.info('[rec feed] miniatures withheld from inventory', {
      clientId, locationId,
      withheld: rows.length - kept.length,
      sent: kept.length,
      maxMl: MINI_ML_MAX,
    });
  }

  return kept.map((r) => ({
    sku: r.sku,
    upc: r.upc ?? null,
    product_name: r.product_name ?? null,
    category: r.category ?? null,       // NULL when empty - Python falls back to product-name classifier
    sub_category: r.sub_category ?? null,
    price: r.price != null ? Number(r.price) : 0,
    // products.cost - margin input. null (not 0) when absent: a fabricated 0 would
    // imply a 100% margin. NOT sale_items.cost, which is ~always 0 (ARCHITECTURE).
    cost: r.cost != null ? Number(r.cost) : null,
    // NULL, NEVER 0, when the POS sends no count - the same rule applied to
    // `cost` three lines up, and for a sharper reason: a fabricated zero here
    // does not understate a margin, it says THE SHELF IS EMPTY, which is a buy
    // signal. The engine treats a missing level as unknown and declines to
    // claim cover; it cannot do that if Node has already decided the answer.
    on_hand: r.stock_qty != null ? parseInt(r.stock_qty, 10) : null,
    created_at: null, // no syncgo timestamp; the route fills this from the first-seen registry
  }));
}

/**
 * POS sales facts for the trailing window, pre-aggregated to one row per sku per
 * day (the contract accepts raw or aggregated; aggregating in SQL is the cheapest
 * shape at scale - far smaller payload, and the Python side re-aggregates anyway).
 *
 * Window is anchored to MAX(sale_date) for the tenant, NOT CURRENT_DATE - the DB can
 * lag wall-clock time, so "the last N days" means the N days ending at the latest day
 * that actually has data (ARCHITECTURE Rule 4 / dashboard.js convention). Returns []
 * when the tenant has no sales.
 *
 * CANONICAL DEMAND SEMANTICS (one-number rule): this feed must measure the same
 * units the storeagent demand engine measures (storeagent/source/forecast_repo.py),
 * or the two AI surfaces quote different velocities for the same product. Three
 * rules ported from there:
 *   1. Dual-key remap, not drop: a store can ring the same product under its
 *      internal sku on some lines and its barcode on others (store 46: ~25% of
 *      volume under the upc). Each sale line's key is remapped to the canonical
 *      `products.sku` via a catalog exposed once per key (sku and upc), deduped
 *      DISTINCT ON so a non-unique upc can never fan a line out - sku claim
 *      beats upc claim, then the row holding stock wins (sku_key.products_join's
 *      exact priority). Lines matching NO catalog key keep their raw sku (a
 *      LEFT join - dropping them would hide the sync gap; unmatched keys simply
 *      never join to inventory downstream, exactly as before).
 *   2. VOID sales are excluded (sales.sale_status = 'VOID').
 *   3. Only positive quantities count (returns/corrections don't subtract from
 *      demand - the engine sizes buying on gross sell-through).
 *
 * @param {number} days  trailing window length (already normalized by the caller)
 */
async function getSales(pool, clientId, locationId, days) {
  // Phase 1 - resolve the latest day with data. Cheap, and lets phase 2 bind a
  // literal date so Postgres can prune sale_items partitions (sale_items is
  // partitioned by sale_date). A correlated subquery bound would defeat pruning.
  const latestRes = await pool.query(
    `SELECT MAX(sale_date)::date AS latest
       FROM sale_items
      WHERE client_id = $1 AND location_id = $2`,
    [clientId, locationId]
  );
  const latest = latestRes.rows[0]?.latest;
  if (!latest) return [];

  // Phase 2 - aggregate the window [latest-(days-1), latest] inclusive.
  // Bounds are constant expressions (params + immutable funcs) and we never cast the
  // partition column in WHERE, so partition pruning + any sale_date index still apply.
  const { rows } = await pool.query(
    `WITH catalog AS (
       -- One product row per join key (sku and upc), sku claim first, then the
       -- row holding stock - mirrors the Python sku_key.products_join dedup.
       SELECT DISTINCT ON (jk) jk, sku
         FROM (
           SELECT sku, sku AS jk, 0 AS jk_pri, stock_qty AS jk_stock
             FROM products
            WHERE client_id = $1 AND location_id = $2
              AND is_deleted IS NOT TRUE AND NULLIF(TRIM(sku), '') IS NOT NULL
           UNION ALL
           SELECT sku, upc AS jk, 1 AS jk_pri, stock_qty AS jk_stock
             FROM products
            WHERE client_id = $1 AND location_id = $2
              AND is_deleted IS NOT TRUE AND NULLIF(TRIM(upc), '') IS NOT NULL
              AND NULLIF(TRIM(sku), '') IS NOT NULL
         ) u
        ORDER BY jk, jk_pri, jk_stock DESC NULLS LAST, sku
     ),
     voids AS (
       SELECT sale_id FROM sales
        WHERE client_id = $1 AND location_id = $2
          AND sale_status = 'VOID' AND sale_id IS NOT NULL
     )
     SELECT COALESCE(c.sku, si.sku)                               AS sku,
            to_char(si.sale_date::date, 'YYYY-MM-DD')             AS sale_date,
            SUM(si.quantity)                                      AS units,
            ROUND(SUM(si.total_amount) / NULLIF(SUM(si.quantity), 0), 2) AS unit_price
       FROM sale_items si
       LEFT JOIN catalog c ON c.jk = si.sku
      WHERE si.client_id = $1 AND si.location_id = $2
        AND si.sale_date >= ($3::date - make_interval(days => $4::int - 1))
        AND si.sale_date <  ($3::date + 1)
        AND NULLIF(TRIM(si.sku), '') IS NOT NULL
        AND si.quantity > 0
        AND (si.sale_id IS NULL OR si.sale_id NOT IN (SELECT sale_id FROM voids))
      GROUP BY COALESCE(c.sku, si.sku), si.sale_date::date
      ORDER BY si.sale_date::date ASC, COALESCE(c.sku, si.sku) ASC`,
    [clientId, locationId, latest, days]
  );

  return rows.map((r) => ({
    sku: r.sku,
    sale_date: r.sale_date, // 'YYYY-MM-DD'
    units: parseInt(r.units, 10) || 0,
    unit_price: r.unit_price != null ? Number(r.unit_price) : 0,
  }));
}

/**
 * Top basket co-occurrence pairs (contract §1.5) - two SKUs appearing on the same
 * receipt (`sale_id`), counted over the trailing window and ranked by support.
 * Grounds the Python side's `bundle` recommendations in observed behavior.
 *
 * Same two-phase window as getSales: anchored to MAX(sale_date), literal bounds
 * so sale_items partition pruning applies. Pairs are emitted once with
 * `sku_a < sku_b` (canonical order - no (B,A) duplicates). DISTINCT per receipt
 * first so a receipt with 3 lines of the same SKU doesn't inflate support.
 *
 * @param {number} days   trailing window length (already normalized)
 * @param {number} limit  max pairs, by support desc (already normalized)
 */
async function getCoPurchases(pool, clientId, locationId, days, limit) {
  const latestRes = await pool.query(
    `SELECT MAX(sale_date)::date AS latest
       FROM sale_items
      WHERE client_id = $1 AND location_id = $2`,
    [clientId, locationId]
  );
  const latest = latestRes.rows[0]?.latest;
  if (!latest) return [];

  const { rows } = await pool.query(
    `WITH basket_items AS (
       SELECT DISTINCT sale_id, sku
         FROM sale_items
        WHERE client_id = $1 AND location_id = $2
          AND sale_date >= ($3::date - make_interval(days => $4::int - 1))
          AND sale_date <  ($3::date + 1)
          AND sale_id IS NOT NULL
          AND NULLIF(TRIM(sku), '') IS NOT NULL
     )
     SELECT a.sku AS sku_a,
            b.sku AS sku_b,
            COUNT(*)::int AS support
       FROM basket_items a
       JOIN basket_items b
         ON b.sale_id = a.sale_id
        AND b.sku > a.sku
      GROUP BY a.sku, b.sku
      ORDER BY support DESC, a.sku ASC, b.sku ASC
      LIMIT $5`,
    [clientId, locationId, latest, days, limit]
  );

  if (INCLUDE_MINIS) {
    return rows.map((r) => ({ sku_a: r.sku_a, sku_b: r.sku_b, support: r.support }));
  }

  // Bundle recommendations are grounded on these pairs, so the gate has to be
  // here too - otherwise a mini that no longer exists in the inventory feed can
  // still be proposed as half of a bundle (the sample had exactly that: a
  // "Jim Beam 50ml + Jim Beam Black 7yr 50ml" bundle). A pair is dropped when
  // EITHER side is a miniature.
  //
  // Basket rows carry only a sku, so the names are resolved in one query rather
  // than per row.
  const skus = [...new Set(rows.flatMap((r) => [r.sku_a, r.sku_b]))];
  if (skus.length === 0) return [];
  const { rows: named } = await pool.query(
    `SELECT sku, product_name FROM products
      WHERE client_id = $1 AND location_id = $2 AND sku = ANY($3::text[])`,
    [clientId, locationId, skus]
  );
  const mini = new Set(named.filter((p) => isMiniFormat(p.product_name)).map((p) => p.sku));

  const kept = rows.filter((r) => !mini.has(r.sku_a) && !mini.has(r.sku_b));
  if (kept.length !== rows.length) {
    logger.info('[rec feed] miniature pairs withheld from co-purchases', {
      clientId, locationId, withheld: rows.length - kept.length, sent: kept.length,
    });
  }
  return kept.map((r) => ({ sku_a: r.sku_a, sku_b: r.sku_b, support: r.support }));
}

// ─── Area winners (cross-store new-product intelligence) ─────────────────────
// "A new product is taking off at stores near you." Products are matched
// across stores by UPC (sku is a per-location POS code and is meaningless
// elsewhere; upc is the real barcode - non-unique within one store, which is
// fine here because we aggregate, never join facts on it).
//
// Privacy: the response NEVER identifies a contributing store - only counts
// and averages leave this function. That is the deliberate trade that makes a
// cross-client aggregate acceptable in a strictly tenant-scoped system.
//
// RLS-compatibility (migration 002): products/sale_items are GUC-filtered and
// fail-closed, so one bare cross-tenant query would return zero rows once RLS
// is live. Instead, every sales/products read below runs through
// makeTenantScopedPool for ONE contributing store at a time - each query is
// tenant-clean, and only this function ever sees more than one store's rows.
// client_locations and the analytics-side registry are not RLS'd.

const AREA_NEW_WINDOW_DAYS = 7;    // "new in the area" = first seen ≤ 7 days ago (matches the local window)
const AREA_MIN_UNITS = 5;          // units in the window for a store to count as evidence
const AREA_MAX_STORES = 25;        // bound the per-store query fan-out
const AREA_LIMIT_DEFAULT = 10;
const AREA_LIMIT_MAX = 25;

/** Coerce/validate the area-winners `limit` query param. */
function normalizeAreaLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return AREA_LIMIT_DEFAULT;
  return Math.min(AREA_LIMIT_MAX, Math.max(1, n));
}

const _norm = (s) => (s == null ? '' : String(s).trim().toUpperCase());

/**
 * New products performing well at OTHER stores in this store's area.
 *
 * @param {import('pg').Pool} bareSyncgoPool  UNSCOPED syncgo pool - rewrapped
 *   per contributing tenant below; never queried bare except client_locations.
 * @param {import('pg').Pool} analyticsPool   registry lives here
 * @param {object} locationRow  this store's client_locations row (city/state)
 * @param {number} days   sales window (normalized by the caller)
 * @param {number} limit  max winners (normalized by the caller)
 * @returns {Array<object>} anonymized aggregates, best-supported first
 */
async function getAreaWinners(
  bareSyncgoPool, analyticsPool, clientId, locationId, locationRow, days, limit
) {
  const state = _norm(locationRow.state);
  if (!state) return []; // no area to match against

  // 1. Seed list: recent non-baseline arrivals across the network (registry).
  const recent = await catalogTracking.getRecentNewProducts(
    analyticsPool, AREA_NEW_WINDOW_DAYS
  );
  const byStore = new Map(); // "cid:lid" → { clientId, locationId, rows: [...] }
  for (const row of recent) {
    if (row.client_id === clientId && row.location_id === locationId) continue;
    const key = `${row.client_id}:${row.location_id}`;
    if (!byStore.has(key)) {
      byStore.set(key, { clientId: row.client_id, locationId: row.location_id, rows: [] });
    }
    byStore.get(key).rows.push(row);
  }
  if (byStore.size === 0) return [];

  // 2. Area filter: same state, same-city noted (client_locations is small and
  // not under RLS - the one legitimately bare read here).
  const stores = [...byStore.values()];
  const locs = await bareSyncgoPool.query(
    `SELECT client_id, location_id, city, state
       FROM client_locations
      WHERE (client_id, location_id) IN (
        SELECT c, l FROM unnest($1::int[], $2::int[]) AS t(c, l)
      )`,
    [stores.map((s) => s.clientId), stores.map((s) => s.locationId)]
  );
  const areaByKey = new Map();
  for (const r of locs.rows) {
    if (_norm(r.state) === state) {
      areaByKey.set(`${r.client_id}:${r.location_id}`, {
        sameCity: _norm(r.city) !== '' && _norm(r.city) === _norm(locationRow.city),
      });
    }
  }
  const contributors = stores
    .filter((s) => areaByKey.has(`${s.clientId}:${s.locationId}`))
    .slice(0, AREA_MAX_STORES);
  if (contributors.length === 0) return [];

  // 3. Per contributing store (tenant-scoped, sequential - a handful of small
  // indexed queries): the new SKUs' sales in the window + display metadata.
  const byUpc = new Map();
  for (const store of contributors) {
    const scoped = makeTenantScopedPool(bareSyncgoPool, store.clientId, store.locationId);
    const firstSeenBySku = new Map(store.rows.map((r) => [r.sku, r.first_seen_at]));
    let rows;
    try {
      ({ rows } = await scoped.query(
        `SELECT p.sku, p.upc, p.product_name,
                NULLIF(TRIM(p.category), '') AS category,
                COALESCE(s.units, 0)::int    AS units
           FROM products p
           LEFT JOIN (
             SELECT sku, SUM(quantity) AS units
               FROM sale_items
              WHERE client_id = $1 AND location_id = $2
                AND sale_date >= CURRENT_DATE - make_interval(days => $4::int)
              GROUP BY sku
           ) s ON s.sku = p.sku
          WHERE p.client_id = $1 AND p.location_id = $2
            AND p.sku = ANY($3)
            AND p.is_deleted IS NOT TRUE`,
        [store.clientId, store.locationId, [...firstSeenBySku.keys()], days]
      ));
    } catch (err) {
      logger.warn(
        `[AreaWinners] contributor ${store.clientId}:${store.locationId} skipped: ${err.message}`
      );
      continue; // one slow/broken store never sinks the endpoint
    }
    const { sameCity } = areaByKey.get(`${store.clientId}:${store.locationId}`);
    for (const r of rows) {
      if (!r.upc || r.units < AREA_MIN_UNITS) continue;
      const agg = byUpc.get(r.upc) || {
        upc: r.upc, product_name: r.product_name, category: r.category,
        store_count: 0, same_city_stores: 0, total_units: 0, best_units: 0,
        earliest_first_seen: null,
      };
      agg.store_count += 1;
      if (sameCity) agg.same_city_stores += 1;
      agg.total_units += r.units;
      if (r.units > agg.best_units) {
        agg.best_units = r.units;
        agg.product_name = r.product_name; // name from the strongest seller
        agg.category = r.category || agg.category;
      }
      const seen = firstSeenBySku.get(r.sku);
      if (seen && (!agg.earliest_first_seen || seen < agg.earliest_first_seen)) {
        agg.earliest_first_seen = seen;
      }
      byUpc.set(r.upc, agg);
    }
  }
  if (byUpc.size === 0) return [];

  // 4. Does THIS store already carry each winner? (tenant-scoped as usual.)
  const scopedSelf = makeTenantScopedPool(bareSyncgoPool, clientId, locationId);
  const carriedRes = await scopedSelf.query(
    `SELECT DISTINCT ON (upc) upc, sku, stock_qty
       FROM products
      WHERE client_id = $1 AND location_id = $2
        AND upc = ANY($3)
        AND is_deleted IS NOT TRUE
      ORDER BY upc, stock_qty DESC NULLS LAST`,
    [clientId, locationId, [...byUpc.keys()]]
  );
  const carriedByUpc = new Map(carriedRes.rows.map((r) => [r.upc, r]));

  const weeks = Math.max(days / 7, 1);
  return [...byUpc.values()]
    .sort((a, b) =>
      b.same_city_stores - a.same_city_stores
      || b.store_count - a.store_count
      || b.total_units - a.total_units
    )
    .slice(0, limit)
    .map((w) => {
      const carried = carriedByUpc.get(w.upc);
      const ageDays = w.earliest_first_seen
        ? Math.max(0, Math.round((Date.now() - new Date(w.earliest_first_seen).getTime()) / 86400000))
        : null;
      return {
        upc: w.upc,
        product_name: w.product_name,
        category: w.category,
        store_count: w.store_count,
        same_city_stores: w.same_city_stores,
        avg_weekly_units: Math.round((w.total_units / weeks / w.store_count) * 10) / 10,
        days_since_first_seen: ageDays,
        carried: Boolean(carried),
        this_store_sku: carried ? carried.sku : null,
        this_store_on_hand: carried && carried.stock_qty != null
          ? parseInt(carried.stock_qty, 10) : null,
      };
    });
}

// ─── Trend validation (cross-store proof for social trends) ──────────────────
// "That drink trending on Reddit - is it actually selling near you?" The Python
// service extracts trending drink TERMS (Google Trends / Reddit) and asks this
// endpoint to check them against real registers at same-state peer stores:
// how many stores sell matching products, at what weekly rate, and whether the
// last 7 days are accelerating vs the prior baseline. Internet hype with no
// local register movement stays a low-confidence signal; hype WITH movement
// becomes a proven pick - and a NOT-CARRIED term with a representative UPC can
// ground a measurable stock_new recommendation (product_first_seen detector).
//
// Privacy: identical posture to area winners - only counts and averages leave
// this function, never a contributing store's identity, and velocity stats are
// withheld entirely below TREND_MIN_STORES (k-anonymity floor). Same-state
// peers only (liquor regulation is state-scoped - matches the market
// capability's deliberate choice). RLS-compatible: per-store reads run through
// makeTenantScopedPool, one contributing tenant at a time.

const TREND_TERMS_MAX = 8;        // bound the per-request term fan-out
const TREND_MAX_STORES = 25;      // bound the per-store query fan-out
const TREND_PEER_CONCURRENCY = 5; // peers queried in flight at once (pool max 20)
const TREND_MIN_STORES = 3;       // k-anonymity floor for velocity aggregates
const TREND_WINDOW_DAYS = 28;     // velocity window (anchored per store)
const TREND_RECENT_DAYS = 7;      // "accelerating" compares this vs the prior 21
const TREND_ACCEL_RATIO = 1.3;    // recent rate must beat baseline by 30%
const TREND_MIN_UNITS_7D = 3;     // below this, a spike is noise
const BARCODE_SHAPE = /^[0-9]{8,14}$/; // canonical cross-store identity

/**
 * Sanitize free-text trend terms into word-bounded, case-insensitive Postgres
 * regex patterns (the metrics.js termPattern discipline: validate shape, escape,
 * \y-bound). Returns [{ term, pattern }]; unusable terms are dropped.
 */
function normalizeTrendTerms(raw) {
  const seen = new Set();
  const out = [];
  for (const piece of String(raw || '').split(',')) {
    const term = piece.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!term || seen.has(term)) continue;
    // Letters/digits/space/hyphen/apostrophe only, 2-40 chars - anything else
    // is not a drink name and never reaches SQL.
    if (!/^[a-z0-9][a-z0-9 \-']{1,39}$/.test(term)) continue;
    seen.add(term);
    const body = term
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/'/g, "'?") // apostrophe optional: Tito's matches Titos
      .replace(/ /g, '[\\s-]+');
    out.push({ term, pattern: `\\y${body}\\y` });
    if (out.length >= TREND_TERMS_MAX) break;
  }
  return out;
}

/**
 * Per-term, per-store velocity for products whose name/sub_category matches the
 * term. One store, one round trip; window anchored to the store's own latest
 * sale (never wall-clock), with a constant CURRENT_DATE - 60 prune bound so
 * sale_items partition pruning still applies.
 */
async function _storeTermStats(scopedPool, clientId, locationId, terms) {
  const { rows } = await scopedPool.query(
    `WITH matched AS (
       SELECT DISTINCT t.term, p.sku, p.upc, p.product_name
         FROM products p
         JOIN unnest($3::text[], $4::text[]) AS t(term, pattern)
           ON (p.product_name ~* t.pattern
               OR COALESCE(p.sub_category, '') ~* t.pattern)
        WHERE p.client_id = $1 AND p.location_id = $2
          AND p.is_deleted IS NOT TRUE
     ),
     anchor AS (
       SELECT MAX(sale_date)::date AS as_of
         FROM sale_items
        WHERE client_id = $1 AND location_id = $2
          AND sale_date >= CURRENT_DATE - 60
     ),
     term_sales AS (
       SELECT m.term, m.sku, m.upc, m.product_name,
              SUM(si.quantity) FILTER (
                WHERE si.sale_date > a.as_of - $5::int
              ) AS u_recent,
              SUM(si.quantity) AS u_window
         FROM sale_items si
         JOIN matched m ON m.sku = si.sku
        CROSS JOIN anchor a
        WHERE si.client_id = $1 AND si.location_id = $2
          AND a.as_of IS NOT NULL
          AND si.sale_date > a.as_of - $6::int
          AND si.sale_date <= a.as_of
        GROUP BY m.term, m.sku, m.upc, m.product_name
     )
     SELECT term,
            SUM(u_window)::int AS units_window,
            SUM(COALESCE(u_recent, 0))::int AS units_recent,
            (ARRAY_AGG(product_name ORDER BY u_window DESC))[1] AS top_name,
            (ARRAY_AGG(upc ORDER BY u_window DESC)
              FILTER (WHERE upc ~ '^[0-9]{8,14}$'))[1] AS top_upc
       FROM term_sales
      GROUP BY term`,
    [
      clientId, locationId,
      terms.map((t) => t.term), terms.map((t) => t.pattern),
      TREND_RECENT_DAYS, TREND_WINDOW_DAYS,
    ]
  );
  return rows;
}

/**
 * Validate trending terms against same-state peer registers.
 *
 * @param {import('pg').Pool} bareSyncgoPool  UNSCOPED pool - rewrapped per
 *   contributing tenant; queried bare only for client_locations (not RLS'd).
 * @param {object} locationRow  this store's client_locations row (state/city)
 * @param {Array<{term,pattern}>} terms  from normalizeTrendTerms()
 * @returns {Array<object>} one anonymized aggregate per term, input order
 */
async function getTrendValidation(
  bareSyncgoPool, clientId, locationId, locationRow, terms
) {
  if (!terms.length) return [];
  const state = _norm(locationRow.state);
  if (!state) return [];

  // 1. Same-state active peers (bare read - client_locations is not RLS'd).
  const peersRes = await bareSyncgoPool.query(
    `SELECT client_id, location_id
       FROM client_locations
      WHERE UPPER(TRIM(COALESCE(state, ''))) = $1
        AND NOT (client_id = $2 AND location_id = $3)
        AND COALESCE(is_active, TRUE)
      ORDER BY client_id, location_id
      LIMIT $4`,
    [state, clientId, locationId, TREND_MAX_STORES]
  );

  // 2. Per peer (tenant-scoped): matching products' recent velocity, all
  // terms in one round trip per store. Peers are queried through a small
  // bounded worker pool - the warehouse is remote, so ~25 sequential round
  // trips measured ~40s, past the Python client's patience; five in flight
  // keeps it a few seconds while staying far under the pool's max clients.
  const byTerm = new Map(terms.map((t) => [t.term, {
    term: t.term, stores_selling: 0, accelerating_stores: 0,
    total_weekly: 0, best_units: 0, best_name: null, best_upc: null,
  }]));
  const peers = peersRes.rows;
  let peerCursor = 0;
  const applyRows = (rows) => {
    for (const r of rows) {
      const agg = byTerm.get(r.term);
      if (!agg || !r.units_window) continue;
      agg.stores_selling += 1;
      agg.total_weekly += r.units_window / (TREND_WINDOW_DAYS / 7);
      const recentRate = r.units_recent / TREND_RECENT_DAYS;
      const priorUnits = r.units_window - r.units_recent;
      const priorRate = priorUnits / (TREND_WINDOW_DAYS - TREND_RECENT_DAYS);
      if (
        r.units_recent >= TREND_MIN_UNITS_7D
        && (priorRate === 0 || recentRate >= priorRate * TREND_ACCEL_RATIO)
      ) {
        agg.accelerating_stores += 1;
      }
      if (r.units_window > agg.best_units) {
        agg.best_units = r.units_window;
        agg.best_name = r.top_name;
        agg.best_upc = r.top_upc && BARCODE_SHAPE.test(r.top_upc) ? r.top_upc : agg.best_upc;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TREND_PEER_CONCURRENCY, peers.length) }, async () => {
      while (peerCursor < peers.length) {
        const peer = peers[peerCursor++];
        const scoped = makeTenantScopedPool(bareSyncgoPool, peer.client_id, peer.location_id);
        try {
          applyRows(await _storeTermStats(scoped, peer.client_id, peer.location_id, terms));
        } catch (err) {
          logger.warn(
            `[TrendValidation] peer ${peer.client_id}:${peer.location_id} skipped: ${err.message}`
          ); // one slow/broken store never sinks the endpoint
        }
      }
    })
  );

  // 3. Does THIS store carry a match? (tenant-scoped as usual.)
  const scopedSelf = makeTenantScopedPool(bareSyncgoPool, clientId, locationId);
  let ownRows = [];
  try {
    ownRows = await _storeTermStats(scopedSelf, clientId, locationId, terms);
  } catch (err) {
    logger.warn(`[TrendValidation] own-store stats skipped: ${err.message}`);
  }
  // Sales-based stats miss carried-but-not-selling products; a plain catalog
  // match still answers "carried" and names the SKU for the prompt.
  const { rows: ownCatalog } = await scopedSelf.query(
    `SELECT DISTINCT ON (t.term) t.term, p.sku, p.stock_qty
       FROM products p
       JOIN unnest($3::text[], $4::text[]) AS t(term, pattern)
         ON (p.product_name ~* t.pattern
             OR COALESCE(p.sub_category, '') ~* t.pattern)
      WHERE p.client_id = $1 AND p.location_id = $2
        AND p.is_deleted IS NOT TRUE
      ORDER BY t.term, p.stock_qty DESC NULLS LAST`,
    [clientId, locationId, terms.map((t) => t.term), terms.map((t) => t.pattern)]
  );
  const ownByTerm = new Map(ownCatalog.map((r) => [r.term, r]));
  const ownSalesByTerm = new Map(ownRows.map((r) => [r.term, r]));

  // 4. Shape: velocity aggregates only at/above the k-anonymity floor.
  return terms.map(({ term }) => {
    const agg = byTerm.get(term);
    const own = ownByTerm.get(term);
    const ownSales = ownSalesByTerm.get(term);
    const meetsFloor = agg.stores_selling >= TREND_MIN_STORES;
    return {
      term,
      stores_selling: agg.stores_selling,
      avg_weekly_units: meetsFloor
        ? Math.round((agg.total_weekly / agg.stores_selling) * 10) / 10
        : null,
      accelerating_stores: meetsFloor ? agg.accelerating_stores : null,
      product_name: meetsFloor ? agg.best_name : null,
      upc: meetsFloor ? agg.best_upc : null,
      carried: Boolean(own),
      this_store_sku: own ? own.sku : null,
      this_store_on_hand: own && own.stock_qty != null
        ? parseInt(own.stock_qty, 10) : null,
      this_store_weekly_units: ownSales
        ? Math.round((ownSales.units_window / (TREND_WINDOW_DAYS / 7)) * 10) / 10
        : null,
    };
  });
}

// ─── Register-trend discovery (what's accelerating at nearby registers) ──────
// The inverse of trend validation: no input terms - this MINES same-state peer
// registers for drink sub-categories whose last 7 days outpace their prior
// baseline, so "trending" can be DISCOVERED from measured purchases instead of
// only from social chatter. The Python service turns each row into a TREND
// line (source: registers), the strongest evidence tier its prompt knows.
// Privacy posture, fan-out bounds, and RLS discipline are identical to
// getTrendValidation above (same worker pool, same k-anonymity floor).

const REGTREND_MAX_TERMS = 8;       // response cap (client may ask for fewer)
const REGTREND_MIN_STORES = TREND_MIN_STORES; // k-anonymity floor (3 selling)
const REGTREND_MIN_ACCEL_STORES = 2; // a "trend" = acceleration at 2+ stores

// Non-beverage / admin buckets that must never surface as "trending drinks".
const REGTREND_STOPLIST = new Set([
  'dnr', 'high alloc', 'misc', 'other', 'none', 'na', 'n/a',
  'cigars', 'tobacco', 'accessories', 'supplies', 'snacks', 'grocery',
]);

/**
 * Per-store, per-category velocity: one round trip per store, window anchored
 * to the store's own latest sale (same discipline as _storeTermStats).
 *
 * Term identity across stores: `sub_category` where a store fills it (rare -
 * most stores leave it empty, verified 2026-08-18), else `category` with the
 * family prefix stripped ("liquor  - tequila" -> "tequila"), whitespace
 * collapsed. That survives each POS's own prefix/spacing habits well enough
 * for same-state aggregation.
 */
async function _storeCategoryStats(scopedPool, clientId, locationId) {
  const { rows } = await scopedPool.query(
    `WITH anchor AS (
       SELECT MAX(sale_date)::date AS as_of
         FROM sale_items
        WHERE client_id = $1 AND location_id = $2
          AND sale_date >= CURRENT_DATE - 60
     ),
     cat_sales AS (
       SELECT TRIM(REGEXP_REPLACE(REGEXP_REPLACE(
                LOWER(COALESCE(NULLIF(TRIM(p.sub_category), ''), p.category)),
                '^.*-', ''), '\\s+', ' ', 'g')) AS term,
              p.product_name, p.upc,
              SUM(si.quantity) FILTER (
                WHERE si.sale_date > a.as_of - $3::int
              ) AS u_recent,
              SUM(si.quantity) AS u_window
         FROM sale_items si
         JOIN products p
           ON p.sku = si.sku
          AND p.client_id = $1 AND p.location_id = $2
          AND p.is_deleted IS NOT TRUE
        CROSS JOIN anchor a
        WHERE si.client_id = $1 AND si.location_id = $2
          AND a.as_of IS NOT NULL
          AND si.sale_date > a.as_of - $4::int
          AND si.sale_date <= a.as_of
          AND COALESCE(TRIM(COALESCE(NULLIF(TRIM(p.sub_category), ''), p.category)), '') <> ''
        GROUP BY 1, 2, 3
     )
     SELECT term,
            SUM(u_window)::int AS units_window,
            SUM(COALESCE(u_recent, 0))::int AS units_recent,
            (ARRAY_AGG(product_name ORDER BY u_window DESC))[1] AS top_name,
            (ARRAY_AGG(upc ORDER BY u_window DESC)
              FILTER (WHERE upc ~ '^[0-9]{8,14}$'))[1] AS top_upc
       FROM cat_sales
      GROUP BY term`,
    [clientId, locationId, TREND_RECENT_DAYS, TREND_WINDOW_DAYS]
  );
  return rows;
}

/**
 * Discover accelerating sub-categories across same-state peer registers.
 * Returns anonymized aggregates only, sorted most-widely-accelerating first.
 */
async function getRegisterTrends(bareSyncgoPool, clientId, locationId, locationRow, limit) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || REGTREND_MAX_TERMS, 1), REGTREND_MAX_TERMS);
  const state = _norm(locationRow.state);
  if (!state) return [];

  const peersRes = await bareSyncgoPool.query(
    `SELECT client_id, location_id
       FROM client_locations
      WHERE UPPER(TRIM(COALESCE(state, ''))) = $1
        AND NOT (client_id = $2 AND location_id = $3)
        AND COALESCE(is_active, TRUE)
      ORDER BY client_id, location_id
      LIMIT $4`,
    [state, clientId, locationId, TREND_MAX_STORES]
  );

  const byTerm = new Map();
  const applyRows = (rows) => {
    for (const r of rows) {
      if (!r.units_window) continue;
      if (r.term.length < 3 || REGTREND_STOPLIST.has(r.term)) continue;
      let agg = byTerm.get(r.term);
      if (!agg) {
        agg = {
          term: r.term, stores_selling: 0, accelerating_stores: 0,
          total_weekly: 0, growth_sum: 0, growth_n: 0,
          best_units: 0, best_name: null, best_upc: null,
        };
        byTerm.set(r.term, agg);
      }
      agg.stores_selling += 1;
      agg.total_weekly += r.units_window / (TREND_WINDOW_DAYS / 7);
      const recentRate = r.units_recent / TREND_RECENT_DAYS;
      const priorUnits = r.units_window - r.units_recent;
      const priorRate = priorUnits / (TREND_WINDOW_DAYS - TREND_RECENT_DAYS);
      if (priorRate > 0) {
        agg.growth_sum += recentRate / priorRate;
        agg.growth_n += 1;
      }
      if (
        r.units_recent >= TREND_MIN_UNITS_7D
        && (priorRate === 0 || recentRate >= priorRate * TREND_ACCEL_RATIO)
      ) {
        agg.accelerating_stores += 1;
      }
      if (r.units_window > agg.best_units) {
        agg.best_units = r.units_window;
        agg.best_name = r.top_name;
        agg.best_upc = r.top_upc && BARCODE_SHAPE.test(r.top_upc) ? r.top_upc : agg.best_upc;
      }
    }
  };

  const peers = peersRes.rows;
  let peerCursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(TREND_PEER_CONCURRENCY, peers.length) }, async () => {
      while (peerCursor < peers.length) {
        const peer = peers[peerCursor++];
        const scoped = makeTenantScopedPool(bareSyncgoPool, peer.client_id, peer.location_id);
        try {
          applyRows(await _storeCategoryStats(scoped, peer.client_id, peer.location_id));
        } catch (err) {
          logger.warn(
            `[RegisterTrends] peer ${peer.client_id}:${peer.location_id} skipped: ${err.message}`
          ); // one slow/broken store never sinks the endpoint
        }
      }
    })
  );

  return [...byTerm.values()]
    .filter((a) =>
      a.stores_selling >= REGTREND_MIN_STORES
      && a.accelerating_stores >= REGTREND_MIN_ACCEL_STORES
    )
    .sort((a, b) =>
      b.accelerating_stores - a.accelerating_stores
      || (b.growth_n ? b.growth_sum / b.growth_n : 0) - (a.growth_n ? a.growth_sum / a.growth_n : 0)
    )
    .slice(0, cap)
    .map((a) => ({
      term: a.term,
      stores_selling: a.stores_selling,
      accelerating_stores: a.accelerating_stores,
      avg_weekly_units: Math.round((a.total_weekly / a.stores_selling) * 10) / 10,
      avg_growth: a.growth_n
        ? Math.round((a.growth_sum / a.growth_n) * 10) / 10
        : null,
      product_name: a.best_name,
      upc: a.best_upc,
    }));
}

/** Test seam - clear the in-memory profile cache. */
function _clearCache() {
  profileCache.clear();
}

module.exports = {
  normalizeDays,
  normalizeLimit,
  normalizeHistoryLimit,
  normalizeAreaLimit,
  normalizeTrendTerms,
  getLocationRow,
  toProfile,
  getInventory,
  getSales,
  getCoPurchases,
  getAreaWinners,
  getTrendValidation,
  getRegisterTrends,
  _clearCache,
  SALES_DAYS_DEFAULT,
};
