// poEffectivenessService.js
// -----------------------------------------------------------------------------
// Effectiveness tracking for the Buying report's PURCHASE-ORDER suggestions.
//
// The daily signal-aware recommendations already have an effectiveness ledger
// (recommendationEvalService). This module is its sibling for the StoreAgent
// buying report - the "reorder SKU X, quantity N" list - which the other ledger
// never covered because those suggestions carry a NUMERIC recommended quantity
// (order_qty) and live in a different feed.
//
// Lifecycle:
//   1. capture()        - snapshot each buy-list suggestion the moment it is
//                         shown (recommended qty + on-hand + velocity at rec
//                         time), one row per (store, sku, day).
//   2. evaluateTenant() - once the store's own sales frontier has passed
//                         rec_date + window, measure: did the owner act (a
//                         matching PO in `purchases`), how close the actual
//                         order quantity was (forecast accuracy), and the
//                         post-purchase performance (units sold, sell-through,
//                         velocity change, gross margin, revenue, turnover),
//                         then blend a score + verdict. Upsert per (rec, window).
//   3. getReport()      - acceptance rate, forecast accuracy, revenue impact,
//                         winners vs underperformers, per-metric aggregates.
//   4. getLearning()    - proven / avoid SKUs, the feedback signal for tuning
//                         future buying suggestions.
//
// Honesty rules (inherited from the sibling ledger): a (rec, window) is only
// evaluated once its window has fully closed against MAX(sale_date) - never on
// a partial window; a metric that cannot be observed is stored NULL, never
// guessed; and quantity/margin math uses the state captured AT rec time.
//
// syncgo is read via getPool() with explicit client_id + location_id filters on
// every query (no cross-tenant leakage); the PO tables live in the analytics DB.
// -----------------------------------------------------------------------------

const { getPool } = require('../database/connection');
const { purchaseDaySql, purchaseDaySaneSql } = require('./purchaseDateSql');
const { probePurchaseFeed } = require('./purchaseFeed');
const logger = require('../utils/logger');

// Windows in days - configurable per the ticket (30/60/90 default).
const PO_EVAL_WINDOWS = (() => {
  const raw = (process.env.PO_EVAL_WINDOWS || '30,60,90')
    .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0 && n <= 365);
  const uniq = [...new Set(raw)].sort((a, b) => a - b);
  return uniq.length ? uniq : [30, 60, 90];
})();
const DEFAULT_WINDOW = PO_EVAL_WINDOWS.includes(30) ? 30 : PO_EVAL_WINDOWS[0];
const SINCE_DEFAULT = 180;

const WINNER_MIN = 0.6;
const UNDERPERFORMER_MAX = 0.4;

/* date helpers (rec_date arrives from pg as a Date or 'YYYY-MM-DD') */
const toISO = (d) => {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const s = String(d);
  return s.length >= 10 ? s.slice(0, 10) : s;
};
const addDays = (iso, n) => {
  const [y, m, day] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};
const squash = (x) => (x <= 0 ? 0 : x / (x + 1)); // (0,inf)->(0,1); x=1 -> 0.5
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const intOrNull = (v) => (Number.isFinite(+v) ? Math.round(+v) : null);
const floatOrNull = (v) => (Number.isFinite(+v) ? +v : null);

/* schema probe (cached) */
let _tablesReady = null;
async function tablesExist(analyticsPool) {
  if (_tablesReady != null) return _tablesReady;
  try {
    const r = await analyticsPool.query(
      "SELECT to_regclass('public.po_recommendations') IS NOT NULL"
      + " AND to_regclass('public.po_recommendation_outcomes') IS NOT NULL AS ok"
    );
    _tablesReady = !!r.rows[0] && r.rows[0].ok === true;
  } catch (_) { _tablesReady = false; }
  return _tablesReady;
}

// --- 1. CAPTURE --------------------------------------------------------------
/**
 * Snapshot a buying-report buy_list. One row per (store, sku, day); re-viewing
 * the report the same day is a no-op (ON CONFLICT DO NOTHING). Best-effort: a
 * capture failure must never break serving the buying report.
 * @returns {number} rows actually inserted
 */
async function capture(analyticsPool, clientId, locationId, buyList) {
  if (!(await tablesExist(analyticsPool))) return 0;
  if (!Array.isArray(buyList) || buyList.length === 0) return 0;

  let inserted = 0;
  const client = await analyticsPool.connect();
  try {
    for (const it of buyList.slice(0, 1000)) {
      const sku = String(it.sku || '').trim();
      const qty = intOrNull(it.order_qty);
      if (!sku || !qty || qty <= 0) continue;
      const orderValue = floatOrNull(it.order_value);
      const unitCost = orderValue && qty ? orderValue / qty : floatOrNull(it.unit_cost);
      const res = await client.query(
        `INSERT INTO po_recommendations
           (client_id, location_id, sku, product_name, recommended_qty, order_value, unit_cost,
            on_hand_at_rec, daily_rate_at_rec, days_of_supply_at_rec, supplier, stockout_risk, reason, rec_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CURRENT_DATE)
         ON CONFLICT (client_id, location_id, sku, rec_date) DO NOTHING`,
        [clientId, locationId, sku, it.product_name || null, qty, orderValue, unitCost,
          intOrNull(it.on_hand), floatOrNull(it.daily_rate), floatOrNull(it.days_of_supply),
          it.supplier || null, it.stockout_risk || null, it.reason || it.note || null]
      );
      inserted += res.rowCount || 0;
    }
  } catch (err) {
    logger.warn(`[PoEff] capture failed for ${clientId}:${locationId}: ${err.message}`);
  } finally {
    client.release();
  }
  if (inserted) logger.info(`[PoEff] captured ${inserted} PO suggestion(s) for ${clientId}:${locationId}`);
  return inserted;
}

// --- verdict + score ---------------------------------------------------------
// `sellThrough` is unified: when the owner acted it is units_sold / units_ordered
// (did what they bought sell); when there is no recorded PO it is units_sold /
// recommended_qty (did the demand we projected actually materialise). Either way
// it answers "did the targeted quantity move", so a recommendation is scoreable
// from sales alone - a store without a purchase feed still gets a real verdict.
// qtyAccuracy is only supplied when acted (recommended vs ordered).
function scoreAndVerdict({ qtyAccuracy, sellThrough, velocityBefore, velocityAfter }) {
  const parts = [];
  if (qtyAccuracy != null) parts.push([0.3, clamp01(qtyAccuracy)]);
  if (sellThrough != null) parts.push([qtyAccuracy != null ? 0.4 : 0.6, clamp01(sellThrough)]);
  if (velocityBefore != null && velocityBefore > 0 && velocityAfter != null) {
    parts.push([qtyAccuracy != null ? 0.3 : 0.4, squash(velocityAfter / velocityBefore)]);
  } else if (velocityAfter != null && sellThrough == null) {
    parts.push([0.5, velocityAfter > 0 ? 0.55 : 0.2]);
  }
  if (!parts.length) return { finalScore: null, verdict: 'insufficient_data' };
  const wsum = parts.reduce((s, p) => s + p[0], 0);
  const finalScore = Math.round((parts.reduce((s, p) => s + p[0] * p[1], 0) / wsum) * 1000) / 1000;
  const verdict = finalScore >= WINNER_MIN ? 'winner'
    : finalScore <= UNDERPERFORMER_MAX ? 'underperformer' : 'neutral';
  return { finalScore, verdict };
}

// --- 2. EVALUATE -------------------------------------------------------------
/**
 * Evaluate every (rec, window) for one store whose window has closed against the
 * store's own sales frontier and is not yet scored (unless force). Upserts one
 * po_recommendation_outcomes row per (rec, window).
 */
async function evaluateTenant(analyticsPool, clientId, locationId, { windows = PO_EVAL_WINDOWS, force = false } = {}) {
  if (!(await tablesExist(analyticsPool))) return { evaluated: 0 };
  const syncgo = getPool();

  const frontierRes = await syncgo.query(
    'SELECT MAX(sale_date)::date AS d FROM sale_items WHERE client_id = $1 AND location_id = $2',
    [clientId, locationId]
  );
  const frontier = toISO(frontierRes.rows[0] && frontierRes.rows[0].d);
  if (!frontier) return { evaluated: 0 };

  const recsRes = await analyticsPool.query(
    `SELECT id, sku, recommended_qty, unit_cost, on_hand_at_rec, daily_rate_at_rec, rec_date
       FROM po_recommendations
      WHERE client_id = $1 AND location_id = $2`,
    [clientId, locationId]
  );
  if (!recsRes.rows.length) return { evaluated: 0 };

  // Existing (rec, window) pairs, so we only compute what's missing.
  const existing = new Set();
  if (!force) {
    const ex = await analyticsPool.query(
      'SELECT rec_id, window_days FROM po_recommendation_outcomes WHERE client_id = $1 AND location_id = $2',
      [clientId, locationId]
    );
    ex.rows.forEach((r) => existing.add(`${r.rec_id}:${r.window_days}`));
  }

  // DOES THIS STORE HAVE A PURCHASES FEED AT ALL? Counted once, over the
  // evaluation period (the earliest rec date through the frontier). Where it
  // is zero, the absence of a matching PO row says nothing about whether the
  // owner ordered - the POS simply does not sync orders here (store 171: two
  // rows, both from 2020) - and `acted` must be NULL with that reason, never
  // FALSE. FALSE is reserved for a store whose feed is live and silent on
  // this SKU (store 173: 7,646 rows). The sibling ledger's rule exactly.
  //
  // The day is purchaseDaySql(), not `date`: at LiquorPOS stores the sync
  // writes -infinity into `date` and the real day into invoice_date
  // (services/purchaseDateSql.js). On bare `date` this count read 0 for
  // Tuscany and the whole store fell into the "feed silent" branch.
  const earliestRec = recsRes.rows.map((r) => toISO(r.rec_date)).sort()[0];
  const { rows: feedRowsInPeriod, silent: feedSilent, reason: feedReason } =
    await probePurchaseFeed(clientId, locationId, earliestRec);
  const hasActedReason = await analyticsPool
    .query(`SELECT 1 FROM information_schema.columns
             WHERE table_name = 'po_recommendation_outcomes' AND column_name = 'acted_reason'`)
    .then((r) => r.rows.length > 0)
    .catch(() => false);

  let evaluated = 0;
  for (const rec of recsRes.rows) {
    const recDate = toISO(rec.rec_date);
    const due = windows.filter((w) => addDays(recDate, w) <= frontier && (force || !existing.has(`${rec.id}:${w}`)));
    if (!due.length) continue;

    const sku = rec.sku;
    // Daily sales for the SKU from 28d before the rec through the frontier.
    const salesRes = await syncgo.query(
      `SELECT to_char(sale_date::date, 'YYYY-MM-DD') AS d,
              SUM(quantity)::int AS units, SUM(total_amount)::float AS rev
         FROM sale_items
        WHERE client_id = $1 AND location_id = $2 AND sku = $3
          AND sale_date::date >= $4::date - INTERVAL '28 days'
          AND sale_date::date <= $5::date
        GROUP BY sale_date::date`,
      [clientId, locationId, sku, recDate, frontier]
    );
    const salesByDay = new Map(salesRes.rows.map((r) => [r.d, { units: r.units || 0, rev: r.rev || 0 }]));

    // Purchase orders for the SKU strictly after the rec date, on the same
    // purchase-day expression as the feed count above.
    const poRes = await syncgo.query(
      `SELECT to_char(${purchaseDaySql()}::date, 'YYYY-MM-DD') AS d, SUM(quantity)::int AS units
         FROM purchases
        WHERE client_id = $1 AND location_id = $2 AND sku = $3
          AND ${purchaseDaySaneSql()}
          AND ${purchaseDaySql()}::date > $4::date
        GROUP BY ${purchaseDaySql()}::date ORDER BY d`,
      [clientId, locationId, sku, recDate]
    ).catch(() => ({ rows: [] }));

    // Unit cost fallback from the product master when not captured.
    let unitCost = floatOrNull(rec.unit_cost);
    if (unitCost == null) {
      const pr = await syncgo.query(
        'SELECT cost::float AS cost FROM products WHERE client_id = $1 AND location_id = $2 AND sku = $3 LIMIT 1',
        [clientId, locationId, sku]
      ).catch(() => ({ rows: [] }));
      unitCost = floatOrNull(pr.rows[0] && pr.rows[0].cost);
    }

    // Velocity before: 28 days ending at the rec date.
    let unitsBefore = 0;
    for (const [d, v] of salesByDay) if (d > addDays(recDate, -28) && d <= recDate) unitsBefore += v.units;
    const velocityBefore = unitsBefore / 28;

    for (const w of due) {
      const windowEnd = addDays(recDate, w);
      let unitsSold = 0; let revenue = 0;
      for (const [d, v] of salesByDay) {
        if (d > recDate && d <= windowEnd) { unitsSold += v.units; revenue += v.rev; }
      }
      const velocityAfter = unitsSold / w;
      const grossMargin = unitCost != null ? Math.round((revenue - unitsSold * unitCost) * 100) / 100 : null;

      const posIn = poRes.rows.filter((r) => r.d > recDate && r.d <= windowEnd);
      // TRI-STATE (039). true: a PO row for this SKU inside the window.
      // false: the feed is live for this store and holds none. NULL: the
      // store has no feed rows at all in the period, with the reason.
      const acted = posIn.length > 0 ? true : feedSilent ? null : false;
      const actedReason = acted === null ? feedReason : null;
      const actualQty = acted ? posIn.reduce((s, r) => s + (r.units || 0), 0) : null;
      const orderDate = acted ? posIn[0].d : null;
      const qtyAccuracy = acted && rec.recommended_qty
        ? clamp01(1 - Math.abs(rec.recommended_qty - actualQty) / rec.recommended_qty) : null;
      // Unified sell-through: against the ordered qty when acted, else against
      // the recommended qty (did the projected demand actually materialise).
      const denomQty = acted && actualQty > 0 ? actualQty : (rec.recommended_qty || 0);
      const sellThrough = denomQty > 0 ? Math.round((unitsSold / denomQty) * 1000) / 1000 : null;

      // Inventory turnover (annualized), approx: avg on-hand ~ start + qty/2.
      // Capped at 50x - without daily on-hand snapshots the denominator can be a
      // sliver, which would otherwise print an absurd (meaningless) turns figure.
      const baseQty = actualQty || rec.recommended_qty || 0;
      const avgOnHand = Math.max(1, (intOrNull(rec.on_hand_at_rec) || 0) + baseQty / 2);
      const turnover = baseQty ? Math.min(50, Math.round(((unitsSold / w) * 365 / avgOnHand) * 100) / 100) : null;

      const sv = scoreAndVerdict({ qtyAccuracy, sellThrough, velocityBefore, velocityAfter });

      await analyticsPool.query(
        `INSERT INTO po_recommendation_outcomes
           (rec_id, client_id, location_id, window_days, data_through, acted, actual_qty, order_date,
            qty_accuracy, units_sold, sell_through, velocity_before, velocity_after,
            gross_margin, revenue_impact, turnover, final_score, verdict, evaluated_at
            ${hasActedReason ? ', acted_reason' : ''})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now()
            ${hasActedReason ? ', $19' : ''})
         ON CONFLICT (rec_id, window_days) DO UPDATE SET
            data_through = EXCLUDED.data_through, acted = EXCLUDED.acted, actual_qty = EXCLUDED.actual_qty,
            order_date = EXCLUDED.order_date, qty_accuracy = EXCLUDED.qty_accuracy, units_sold = EXCLUDED.units_sold,
            sell_through = EXCLUDED.sell_through, velocity_before = EXCLUDED.velocity_before,
            velocity_after = EXCLUDED.velocity_after, gross_margin = EXCLUDED.gross_margin,
            revenue_impact = EXCLUDED.revenue_impact, turnover = EXCLUDED.turnover,
            final_score = EXCLUDED.final_score, verdict = EXCLUDED.verdict, evaluated_at = now()
            ${hasActedReason ? ', acted_reason = EXCLUDED.acted_reason' : ''}`,
        [rec.id, clientId, locationId, w, frontier, acted, actualQty, orderDate,
          qtyAccuracy, unitsSold, sellThrough, Math.round(velocityBefore * 1000) / 1000,
          Math.round(velocityAfter * 1000) / 1000, grossMargin,
          Math.round(revenue * 100) / 100, turnover, sv.finalScore, sv.verdict,
          ...(hasActedReason ? [actedReason] : [])]
      );
      evaluated += 1;
    }
  }
  if (evaluated) logger.info(`[PoEff] evaluated ${evaluated} (rec,window) for ${clientId}:${locationId}`);
  return { evaluated };
}

// --- BACKFILL (seed from history) --------------------------------------------
/**
 * Reconstruct the PO recommendations Botella WOULD have made over the store's
 * recent history and score them against what actually happened - so the report
 * is populated immediately instead of waiting ~30 days for live captures to
 * mature. Honest by construction: the recommended quantity is a real reorder
 * point computed from the sales velocity BEFORE the (back-dated) rec date, and
 * every outcome is measured against the store's real `purchases` and sales.
 *
 * @returns {object} { seeded, evaluated }
 */
async function backfillTenant(analyticsPool, clientId, locationId, { anchorDays = 100, maxSkus = 25 } = {}) {
  if (!(await tablesExist(analyticsPool))) return { seeded: 0, evaluated: 0 };
  const syncgo = getPool();

  const frontierRes = await syncgo.query(
    'SELECT MAX(sale_date)::date AS d FROM sale_items WHERE client_id = $1 AND location_id = $2',
    [clientId, locationId]
  );
  const frontier = toISO(frontierRes.rows[0] && frontierRes.rows[0].d);
  if (!frontier) return { seeded: 0, evaluated: 0 };
  // Back-date the recommendations far enough that every configured window is
  // already closed against the frontier.
  const recDate = addDays(frontier, -Math.max(anchorDays, Math.max(...PO_EVAL_WINDOWS) + 5));

  // The store's real fast movers in the 28 days BEFORE the rec date - the exact
  // pool a reorder model would draw from - with their trailing velocity.
  const movers = await syncgo.query(
    `SELECT sku, MAX(product_name) AS name, SUM(quantity)::int AS units
       FROM sale_items
      WHERE client_id = $1 AND location_id = $2
        AND sale_date::date > $3::date - INTERVAL '28 days' AND sale_date::date <= $3::date
      GROUP BY sku
      HAVING SUM(quantity) > 0
      ORDER BY SUM(quantity) DESC
      LIMIT $4`,
    [clientId, locationId, recDate, maxSkus]
  );
  if (!movers.rows.length) return { seeded: 0, evaluated: 0 };

  const skus = movers.rows.map((r) => r.sku);
  const costRes = await syncgo.query(
    'SELECT sku, cost::float AS cost FROM products WHERE client_id = $1 AND location_id = $2 AND sku = ANY($3)',
    [clientId, locationId, skus]
  ).catch(() => ({ rows: [] }));
  const costBySku = new Map(costRes.rows.map((r) => [r.sku, r.cost]));

  let seeded = 0;
  const client = await analyticsPool.connect();
  try {
    for (const m of movers.rows) {
      const dailyRate = (m.units || 0) / 28;
      // Reorder point: cover ~30 days at the trailing rate (min 1 case-ish).
      const recommendedQty = Math.max(1, Math.ceil(dailyRate * 30));
      const unitCost = costBySku.has(m.sku) ? costBySku.get(m.sku) : null;
      const res = await client.query(
        `INSERT INTO po_recommendations
           (client_id, location_id, sku, product_name, recommended_qty, order_value, unit_cost,
            daily_rate_at_rec, reason, rec_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date)
         ON CONFLICT (client_id, location_id, sku, rec_date) DO NOTHING`,
        [clientId, locationId, m.sku, m.name || null, recommendedQty,
          unitCost != null ? Math.round(unitCost * recommendedQty * 100) / 100 : null, unitCost,
          Math.round(dailyRate * 1000) / 1000, 'Backfilled from sales history', recDate]
      );
      seeded += res.rowCount || 0;
    }
  } finally {
    client.release();
  }

  const { evaluated } = await evaluateTenant(analyticsPool, clientId, locationId, { force: true });
  logger.info(`[PoEff] backfilled ${seeded} rec(s) → ${evaluated} evaluation(s) for ${clientId}:${locationId}`);
  return { seeded, evaluated };
}

/** Every store that has captured PO suggestions - the eval cron fans out over these. */
async function listTenantsWithRecs(analyticsPool) {
  if (!(await tablesExist(analyticsPool))) return [];
  const r = await analyticsPool.query(
    'SELECT DISTINCT client_id, location_id FROM po_recommendations ORDER BY client_id, location_id'
  );
  return r.rows.map((x) => ({ clientId: x.client_id, locationId: x.location_id }));
}

// --- 3. REPORT ---------------------------------------------------------------
function normWindow(w) {
  const n = parseInt(w, 10);
  return PO_EVAL_WINDOWS.includes(n) ? n : DEFAULT_WINDOW;
}
const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null);
const sum = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100 : null);

async function getReport(analyticsPool, clientId, locationId, { windowDays, sinceDays } = {}) {
  if (!(await tablesExist(analyticsPool))) {
    return { available: false, reason: 'PO effectiveness tables not provisioned yet (analytics migration 005).' };
  }
  const window = normWindow(windowDays);
  const since = Math.max(7, Math.min(730, parseInt(sinceDays, 10) || SINCE_DEFAULT));

  const { rows } = await analyticsPool.query(
    `SELECT r.id, r.sku, r.product_name, r.recommended_qty, to_char(r.rec_date,'YYYY-MM-DD') AS rec_date,
            o.acted, o.actual_qty, o.qty_accuracy, o.units_sold, o.sell_through,
            o.velocity_before, o.velocity_after, o.gross_margin, o.revenue_impact,
            o.turnover, o.final_score, o.verdict
       FROM po_recommendations r
       JOIN po_recommendation_outcomes o ON o.rec_id = r.id
      WHERE r.client_id = $1 AND r.location_id = $2 AND o.window_days = $3
        AND r.rec_date >= (CURRENT_DATE - ($4 || ' days')::interval)
      ORDER BY o.revenue_impact DESC NULLS LAST, r.rec_date DESC`,
    [clientId, locationId, window, since]
  );

  const evaluated = rows.length;
  const acted = rows.filter((r) => r.acted === true);
  // Rows where the feed could SPEAK (true or false). NULL rows - a store
  // with no purchases feed in the period (039) - are outside the acceptance
  // denominator: "0% acceptance" at a store whose POS never syncs an order
  // is a statement about the feed, not the owner.
  const actedKnown = rows.filter((r) => r.acted === true || r.acted === false);
  const measurable = rows.filter((r) => r.verdict !== 'insufficient_data');
  const winners = rows.filter((r) => r.verdict === 'winner');
  const underperformers = rows.filter((r) => r.verdict === 'underperformer');

  // Same window the scorer probes over: from the oldest suggestion on this
  // report, so "no orders since" names a date the owner can check.
  const earliestRec = rows.map((r) => r.rec_date).filter(Boolean).sort()[0] || null;
  const feed = await probePurchaseFeed(clientId, locationId, earliestRec);

  const shape = (r) => ({
    id: r.id, sku: r.sku, product_name: r.product_name, recommended_qty: r.recommended_qty,
    actual_qty: r.actual_qty, qty_accuracy: r.qty_accuracy, units_sold: r.units_sold,
    sell_through: r.sell_through, revenue_impact: r.revenue_impact, gross_margin: r.gross_margin,
    turnover: r.turnover, verdict: r.verdict, rec_date: r.rec_date,
  });

  return {
    available: true,
    window_days: window,
    since_days: since,
    windows_configured: PO_EVAL_WINDOWS,
    summary: {
      evaluated,
      // Acceptance: of the suggestions the FEED could check, how many became a
      // PO. NULL - not 0 - when the feed could check none of them.
      acceptance_rate: actedKnown.length ? Math.round((acted.length / actedKnown.length) * 1000) / 1000 : null,
      acted: acted.length,
      acted_known: actedKnown.length,
      acted_unknown: evaluated - actedKnown.length,
      // Forecast accuracy: how close the recommended quantity was to what was ordered.
      forecast_accuracy: mean(acted.map((r) => r.qty_accuracy).filter((v) => v != null)),
      winners: winners.length,
      neutral: rows.filter((r) => r.verdict === 'neutral').length,
      underperformers: underperformers.length,
      insufficient_data: rows.filter((r) => r.verdict === 'insufficient_data').length,
      // Performance metrics span every measurable suggestion (sales are
      // observable whether or not a PO was recorded); acceptance & forecast
      // accuracy above stay PO-based because they genuinely require the order.
      avg_sell_through: mean(measurable.map((r) => r.sell_through).filter((v) => v != null)),
      avg_turnover: mean(measurable.map((r) => r.turnover).filter((v) => v != null)),
      avg_score: mean(measurable.map((r) => r.final_score).filter((v) => v != null)),
      revenue_impact: sum(measurable.map((r) => r.revenue_impact).filter((v) => v != null)),
      gross_margin: sum(measurable.map((r) => r.gross_margin).filter((v) => v != null)),
      // Whether this store has a purchase feed at all (drives how the UI frames
      // acceptance/forecast accuracy - "0%" vs "no PO data").
      has_po_data: acted.length > 0,
    },
    // THE REASON, not just the absence.
    //
    // `has_po_data: false` told the UI the number was unusable and nothing
    // about why, so the screen rendered the arithmetic anyway: "0 confirmed
    // done by your data, $-71,125". At a store whose POS has never synced an
    // order that figure is a verdict on an absence - every card ungradeable,
    // summed. The owner reads it as a verdict on their buying.
    //
    // Probed live rather than inferred from the stored rows, because rows
    // written before migration 039 carry `acted = false` with no reason and
    // would make a dead feed look like a store that ignored every card.
    purchase_feed: feed,
    top: winners.slice(0, 5).map(shape),
    bottom: underperformers.slice(-5).reverse().map(shape),
  };
}

async function getLedger(analyticsPool, clientId, locationId, { windowDays, sinceDays, verdict, acted, limit, offset } = {}) {
  if (!(await tablesExist(analyticsPool))) return { available: false, rows: [], total: 0 };
  const window = normWindow(windowDays);
  const since = Math.max(7, Math.min(730, parseInt(sinceDays, 10) || SINCE_DEFAULT));
  const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const off = Math.max(0, parseInt(offset, 10) || 0);

  const filters = ['r.client_id = $1', 'r.location_id = $2', 'o.window_days = $3',
    "r.rec_date >= (CURRENT_DATE - ($4 || ' days')::interval)"];
  const params = [clientId, locationId, window, since];
  if (verdict) { params.push(verdict); filters.push(`o.verdict = $${params.length}`); }
  if (acted === 'true' || acted === 'false') { params.push(acted === 'true'); filters.push(`o.acted = $${params.length}`); }
  const where = filters.join(' AND ');

  const totalRes = await analyticsPool.query(
    `SELECT count(*)::int AS n FROM po_recommendations r JOIN po_recommendation_outcomes o ON o.rec_id = r.id WHERE ${where}`,
    params
  );
  params.push(lim); params.push(off);
  const { rows } = await analyticsPool.query(
    `SELECT r.id, r.sku, r.product_name, r.recommended_qty, to_char(r.rec_date,'YYYY-MM-DD') AS rec_date,
            o.acted, o.actual_qty, o.qty_accuracy, o.units_sold, o.sell_through,
            o.velocity_before, o.velocity_after, o.gross_margin, o.revenue_impact,
            o.turnover, o.final_score, o.verdict
       FROM po_recommendations r JOIN po_recommendation_outcomes o ON o.rec_id = r.id
      WHERE ${where}
      ORDER BY o.revenue_impact DESC NULLS LAST, r.rec_date DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { available: true, window_days: window, total: (totalRes.rows[0] && totalRes.rows[0].n) || 0, rows };
}

// --- 4. FEEDBACK -------------------------------------------------------------
/**
 * Proven / avoid SKUs - the feedback signal for tuning future buying
 * suggestions. A SKU is "proven" when its acted-on PO suggestions won on
 * average, "avoid" when they underperformed.
 */
async function getLearning(analyticsPool, clientId, locationId, { windowDays, sinceDays } = {}) {
  if (!(await tablesExist(analyticsPool))) return { proven: [], avoid: [] };
  const window = normWindow(windowDays);
  const since = Math.max(30, Math.min(730, parseInt(sinceDays, 10) || 365));
  const { rows } = await analyticsPool.query(
    `SELECT r.sku, r.product_name,
            count(*) FILTER (WHERE o.verdict = 'winner')::int AS wins,
            count(*) FILTER (WHERE o.verdict = 'underperformer')::int AS losses,
            round(avg(o.final_score)::numeric, 3)::float AS avg_score,
            round(avg(o.sell_through)::numeric, 3)::float AS avg_sell_through
       FROM po_recommendations r JOIN po_recommendation_outcomes o ON o.rec_id = r.id
      WHERE r.client_id = $1 AND r.location_id = $2 AND o.window_days = $3
        AND o.verdict IN ('winner','underperformer')
        AND r.rec_date >= (CURRENT_DATE - ($4 || ' days')::interval)
      GROUP BY r.sku, r.product_name`,
    [clientId, locationId, window, since]
  );
  const proven = rows.filter((r) => r.wins > r.losses)
    .sort((a, b) => (b.avg_score || 0) - (a.avg_score || 0)).slice(0, 25);
  const avoid = rows.filter((r) => r.losses > r.wins)
    .sort((a, b) => (a.avg_score || 1) - (b.avg_score || 1)).slice(0, 25);
  return { proven, avoid };
}

module.exports = {
  PO_EVAL_WINDOWS, DEFAULT_WINDOW,
  capture, evaluateTenant, backfillTenant, listTenantsWithRecs,
  getReport, getLedger, getLearning,
};
