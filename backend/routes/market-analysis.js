const router = require('express').Router();
const logger = require('../utils/logger');
const { toSafeError } = require('../utils/errors');

// ─── In-process LRU-ish cache ─────────────────────────────────────────────
// Type-ahead fires a request per keystroke. Caching the normalised query
// for 60s collapses that into a single DB hit per unique prefix while the
// user types, and across users in the same region who type the same thing.
// Cache key includes the resolved state so cross-region results never bleed.
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;
const cache = new Map(); // key → { value, expiresAt }

// State lookups rarely change. Cache the (client_id, location_id) → state
// resolution for an hour so the search path stays one query instead of two.
const STATE_TTL_MS = 60 * 60 * 1000;
const stateCache = new Map(); // `${clientId}:${locationId}` → { state, expiresAt }

// Liquor category filter. The `products.category` column is free-form (~1.2k
// distinct values, mixed casing, lots of non-alcoholic clutter), so we keep
// only categories whose name matches a liquor keyword and isn't in the
// accessory/snack/non-alc deny list. Runs at SQL level so the dropdown
// payload is small and the regex stays in one place.
const LIQUOR_ALLOW = '\\y(wine|vino|beer|ale|lager|ipa|stout|porter|pilsner|brews?|vodka|gin|rum|tequila|whiskey|whisky|bourbon|scotch|brandy|cognac|mezcal|liqueure?s?|liquor|spirits|sake|schnapps|absinthe|champagne|sparkling|prosecco|cava|chardonnay|cabernet|sauvignon|merlot|pinot|riesling|moscato|malbec|syrah|shiraz|zinfandel|sangiovese|tempranillo|gewurztraminer|grenache|vermouth|sherry|red blend|white blend|rtd|seltzer|cocktails?|mojito|cordial|sangria|cider)\\y';
const LIQUOR_DENY = '(tobacco|cigar|cigarett|vape|e[- ]?cig|delta[ -]?8|snack|grocer|food|soft drink|juice|water|mixer|accessor|hardware|garnish|non[- ]?alc|smoke|hemp|cannabis|kombucha|glasses?|deposit|lottery|gift card|merch|t-?shirt|cocktail (cherr|napkin|onion|mix|stick|pick|stir)|root beer|wine bag|^na | na |n/a|non -alc|non-alochol|^soda$)';

async function resolveUserState(pool, clientId, locationId) {
  const key = `${clientId}:${locationId}`;
  const cached = stateCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.state;

  const { rows } = await pool.query(
    `SELECT state FROM client_locations
      WHERE client_id = $1 AND location_id = $2
      LIMIT 1`,
    [clientId, locationId]
  );
  const state = rows[0]?.state || null;
  stateCache.set(key, { state, expiresAt: Date.now() + STATE_TTL_MS });
  return state;
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  // Refresh recency for LRU eviction
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    // Evict oldest insertion (Map preserves insertion order)
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// GET /api/market-analysis/products/search?q=...&category=...
//
// Returns:
//   { suggestions: string[], results: Product[] }
//
// `suggestions` is the distinct list of product names from the matched rows
// (used to drive the type-ahead). `results` is the full table payload.
// We deliberately return both in one round-trip so the dropdown and the
// table stay in sync without a second fetch.
router.get('/products/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';

  if (!q || q.length > 200) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Query "q" is required (1-200 chars).' } });
  }

  try {
    const clientId = req.user.client_id;
    const locationId = req.user.location_id;

    // Region-scoped search: resolve the caller's state, then return matches
    // from every active location in that state (cross-store market view).
    const state = await resolveUserState(req.pool, clientId, locationId);
    if (!state) {
      return res.status(404).json({ error: { code: 'NO_STATE', message: 'Could not determine the region for this account.' } });
    }

    const cacheKey = `region:${state}:${category.toLowerCase()}:${q.toLowerCase()}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }

    // Parameterized query - never interpolate user input into SQL.
    const params = [state, `%${q}%`];
    let categoryClause = '';
    if (category) {
      params.push(category);
      categoryClause = ` AND p.category = $${params.length}`;
    }

    const sql = `
      SELECT p.client_id, p.location_id, p.product_name, p.price, p.sale_price
      FROM products p
      WHERE p.location_id IN (
              SELECT cl.location_id FROM client_locations cl
               WHERE cl.state = $1 AND cl.is_active = true
            )
        AND p.product_name ILIKE $2
        ${categoryClause}
      ORDER BY p.product_name
      LIMIT 200
    `;

    const { rows } = await req.pool.query(sql, params);

    const results = rows.map((r) => ({
      client_id: r.client_id != null ? Number(r.client_id) : null,
      location_id: r.location_id != null ? Number(r.location_id) : null,
      product_name: r.product_name,
      price: r.price != null ? parseFloat(r.price) : 0,
      sale_price: r.sale_price != null && parseFloat(r.sale_price) > 0 ? parseFloat(r.sale_price) : null,
    }));

    // Distinct names preserving sort order, capped at 20 for the dropdown
    const seen = new Set();
    const suggestions = [];
    for (const r of results) {
      if (!seen.has(r.product_name)) {
        seen.add(r.product_name);
        suggestions.push(r.product_name);
        if (suggestions.length === 20) break;
      }
    }

    const payload = { suggestions, results };
    cacheSet(cacheKey, payload);
    res.setHeader('X-Cache', 'MISS');
    res.json(payload);
  } catch (err) {
    const safe = toSafeError(err);
    logger.error('Market analysis search failed', { error: err.message, clientId: req.user?.client_id, locationId: req.user?.location_id });
    res.status(safe.statusCode).json({ error: { code: safe.code, message: safe.userMessage } });
  }
});

// GET /api/market-analysis/categories - populates the filter dropdown.
// Region-scoped so the dropdown matches the search universe.
router.get('/categories', async (req, res) => {
  try {
    const clientId = req.user.client_id;
    const locationId = req.user.location_id;

    const state = await resolveUserState(req.pool, clientId, locationId);
    if (!state) {
      return res.status(404).json({ error: { code: 'NO_STATE', message: 'Could not determine the region for this account.' } });
    }

    const cacheKey = `categories:region:${state}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }

    const { rows } = await req.pool.query(
      `SELECT DISTINCT category
         FROM products
        WHERE location_id IN (
                SELECT cl.location_id FROM client_locations cl
                 WHERE cl.state = $1 AND cl.is_active = true
              )
          AND category IS NOT NULL AND category <> ''
          AND category ~* $2
          AND category !~* $3
        ORDER BY category`,
      [state, LIQUOR_ALLOW, LIQUOR_DENY]
    );
    const payload = { categories: rows.map((r) => r.category) };
    cacheSet(cacheKey, payload);
    res.setHeader('X-Cache', 'MISS');
    res.json(payload);
  } catch (err) {
    const safe = toSafeError(err);
    logger.error('Market analysis categories failed', { error: err.message, clientId: req.user?.client_id, locationId: req.user?.location_id });
    res.status(safe.statusCode).json({ error: { code: safe.code, message: safe.userMessage } });
  }
});

module.exports = router;
