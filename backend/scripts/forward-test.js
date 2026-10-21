#!/usr/bin/env node
/**
 * FORWARD TEST: score the recommendations we actually issued against the sales
 * that actually followed, under the assumption that every card was accepted in
 * full.
 *
 *   node scripts/forward-test.js --stores 171,181 --window-days 7 --out ../audit/forward
 *
 * HOW THIS DIFFERS FROM THE BACKTEST, AND WHY BOTH EXIST
 *   `real_engine_backtest.py` replays the engine over history: it picks a past
 *   date, asks what the engine WOULD have said, and scores that. It can only
 *   run where a year of history sits behind the decision date, and it measures
 *   the engine's judgement against a counterfactual.
 *
 *   This measures cards the engine REALLY ISSUED, on the days it issued them,
 *   against the units that really sold afterwards. No replay, no reconstruction
 *   of what the engine might have thought. The one counterfactual is the
 *   acceptance itself - we assume the owner ordered the recommended quantity -
 *   and that assumption is stated in every figure below rather than hidden.
 *
 * THE FOUR TRAPS THIS SCRIPT IS BUILT AROUND
 *
 *   1. AN OPEN WINDOW IS NOT A FAILED ONE. A card issued three days ago cannot
 *      have a 7-day outcome. Scoring it as "sold 0 of 12" would make every
 *      recent card look like dead stock, and since recommendations are issued
 *      daily, most cards are recent. Such cards are `pending` and are excluded
 *      from every rate - they are not counted as a denominator either.
 *
 *   2. ABSENCE IS NOT ZERO. A store whose sales feed stopped mid-window has not
 *      sold nothing; we do not know what it sold. Those cards are `no_data`,
 *      never `unutilized`. Conflating the two would blame the engine for a
 *      broken integration, which is exactly backwards.
 *
 *   3. OPEN DAYS, NEVER CALENDAR DAYS. A "7-day window" is seven days the store
 *      actually traded. A store closed on Sundays would otherwise have its
 *      windows quietly shortened by a seventh, and every absorption figure
 *      understated by the same amount.
 *
 *   4. THE SPEC'S FOUR CATEGORIES ARE NOT EXHAUSTIVE. "Successful" needs units
 *      sold at or above the recommended quantity; "overstocked" needs ending
 *      stock above safety; "unutilized" needs zero sold; "understocked" needs a
 *      stockout. A card that sold 7 of 12 with ending stock below safety is
 *      none of those. It gets `partial_absorption` rather than being forced
 *      into the nearest bucket, because forcing it would mean reporting a
 *      number that is not true.
 *
 * WHAT IS SIMULATED AND WHAT IS OBSERVED
 *   OBSERVED: every unit of demand. Daily units per SKU come from sale_items,
 *   unchanged.
 *   SIMULATED: the inventory trajectory only. Starting stock is the engine's own
 *   `engine_on_hand` snapshot taken when the card was written, plus the
 *   recommended quantity, depleted by the real daily units.
 *
 *   A card without `engine_on_hand` (the column postdates some cards) cannot
 *   have its trajectory simulated, so no stockout determination is made for it
 *   and it is scored on absorption alone. That subset is reported separately
 *   rather than mixed in, because a stockout-blind score is a weaker claim.
 *
 * READ-ONLY. SELECT against both databases, no writes anywhere. Node is the
 * only process that may write bottleai_analytics and this is not that process.
 *
 * ALSO A LIBRARY. `scripts/forward-test-daily.js` runs this measurement every
 * morning and persists it (migration 038), so the pieces are exported and the
 * CLI only runs under `require.main === module`. The measurement itself -
 * fetch, score, metrics - is `runForwardTest`; the daily job writes rows, this
 * file still writes nothing.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { getPool } = require('../database/connection');
const { getAnalyticsPool } = require('../database/analytics-connection');

// ── Tunables, all visible in the output ──────────────────────────────────────

/** Open days after the recommendation over which the outcome is measured. */
const DEFAULT_WINDOW_DAYS = 7;

/**
 * Cover the store should still be holding at the end of the window before we
 * call the order too large, in OPEN days of its own measured rate. Seven days
 * is one trading week: a store holding a week of cover is stocked, not
 * overstocked.
 */
const DEFAULT_SAFETY_COVER_DAYS = 7;

/**
 * How far above safety stock ending inventory must sit before the order counts
 * as waste. A card that lands 10% over a week of cover is not a bad call.
 */
const OVERSTOCK_TOLERANCE = 0.25;

/** Open days of history used to measure a rate when the card did not record one. */
const RATE_WINDOW_OPEN_DAYS = 28;

/** Annual holding cost as a fraction of unit cost, for the capital tied up. */
const HOLDING_COST_ANNUAL_RATE = 0.25;

const OUTCOMES = ['successful', 'partial_absorption', 'overstocked',
  'understocked', 'unutilized', 'no_data', 'pending'];

// ── CLI ──────────────────────────────────────────────────────────────────────

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

/** A DATE with no timezone applied - see export-store-sales.js for why. */
function day(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Wilson score interval - correct at the small n a forward test starts with. */
function wilson(hits, n, z = 1.96) {
  if (!n) return [null, null];
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return [Math.max(0, (centre - spread) / d) * 100,
    Math.min(1, (centre + spread) / d) * 100];
}

// ── Data access ──────────────────────────────────────────────────────────────

/**
 * Every open day for a store, ascending. An open day is one the store recorded
 * a sale on; that is the only evidence we have that it was trading, and it is
 * the denominator for every rate in this script.
 */
async function openDays(syncgo, clientId) {
  const { rows } = await syncgo.query(
    `SELECT DISTINCT sale_date::date AS d
       FROM sales
      WHERE client_id = $1 AND upper(COALESCE(sale_status, '')) <> 'VOID'
      ORDER BY 1`,
    [clientId]
  );
  return rows.map((r) => day(r.d));
}

/** Daily units sold per SKU for one store, as { sku: { 'YYYY-MM-DD': units } }. */
async function dailyUnits(syncgo, clientId, skus) {
  if (!skus.length) return {};
  const { rows } = await syncgo.query(
    `SELECT sku, sale_date::date AS d, sum(quantity)::numeric AS units
       FROM sale_items
      WHERE client_id = $1
        AND (sku = ANY($2::text[]) OR upc = ANY($2::text[]))
        AND item_status = 'Sold' AND quantity > 0
      GROUP BY 1, 2`,
    [clientId, skus]
  );
  const out = {};
  for (const r of rows) {
    const k = String(r.sku);
    (out[k] = out[k] || {})[day(r.d)] = Number(r.units);
  }
  return out;
}

/**
 * Unit economics per SKU, from what actually transacted rather than the
 * catalogue: the median transacted price and cost are what the store really
 * achieved. Falls back to the product master, and reports neither as zero when
 * both are absent - a missing margin is unknown, not nil.
 */
async function unitEconomics(syncgo, clientId, skus) {
  if (!skus.length) return {};
  // TWO INDEXED QUERIES, MERGED HERE, rather than one FULL JOIN of sale_items
  // against products. The join version is correct and unusably slow: it cannot
  // use either table's (client_id, sku) index because the join key is
  // COALESCE'd, so it seq-scans a multi-million-row partition set and dies on
  // the pool's 5s statement timeout.
  const [txn, cat] = await Promise.all([
    syncgo.query(
      `SELECT sku,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY price)
                FILTER (WHERE price > 0) AS px,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY cost)
                FILTER (WHERE cost > 0)  AS ct,
              max(product_name)          AS name,
              max(category)              AS category
         FROM sale_items
        WHERE client_id = $1 AND item_status = 'Sold'
          AND (sku = ANY($2::text[]) OR upc = ANY($2::text[]))
        GROUP BY 1`,
      [clientId, skus]
    ),
    syncgo.query(
      `SELECT sku,
              max(price) FILTER (WHERE price > 0) AS px,
              max(cost)  FILTER (WHERE cost  > 0) AS ct,
              max(product_name)                   AS name,
              max(category)                       AS category
         FROM products
        WHERE client_id = $1 AND COALESCE(is_deleted, false) = false
          AND (sku = ANY($2::text[]) OR upc = ANY($2::text[]))
        GROUP BY 1`,
      [clientId, skus]
    ),
  ]);

  const out = {};
  const put = (sku, price, cost, name, category, preferExisting) => {
    const k = String(sku);
    const cur = out[k] || { price: null, cost: null, name: null, category: null };
    const pick = (a, b) => (preferExisting ? (a ?? b) : (b ?? a));
    out[k] = {
      price: pick(cur.price, price),
      cost: pick(cur.cost, cost),
      name: cur.name || name || null,
      category: cur.category || category || null,
    };
  };
  // Transacted first: what the store actually achieved beats the catalogue.
  for (const r of txn.rows) put(r.sku, num(r.px), num(r.ct), r.name, r.category, false);
  for (const r of cat.rows) put(r.sku, num(r.px), num(r.ct), r.name, r.category, true);

  for (const k of Object.keys(out)) {
    const { price, cost } = out[k];
    // A missing margin is UNKNOWN, not nil - a zero here would turn every
    // uncosted SKU into a card that earned the store nothing.
    out[k].margin = (price !== null && cost !== null && cost < price) ? price - cost : null;
  }
  return out;
}

/**
 * The cards in scope, newest run first, with their recorded baseline.
 *
 * Two ways to bound the period, because two callers want different things:
 *   sinceDays   "the trailing N days" - what the one-shot CLI asks for.
 *   sinceDate   "everything issued on or after this calendar day (IST)" - what
 *               the daily job asks for, so a fixed test period (16-30 Oct 2026)
 *               keeps the same first card on every one of its runs. A trailing
 *               window would silently drop the earliest cards as the days
 *               passed, and the period's own evidence would shrink while it
 *               was supposed to be growing.
 * When `sinceDate` is given it wins and `sinceDays` is ignored. The day is
 * taken in Asia/Kolkata explicitly: `rec_date` below uses the session's date
 * cast, which is IST on this server, but a period boundary must not depend on
 * which clock the session happens to be set to.
 */
async function fetchRecommendations(analytics, stores, sinceDays, sinceDate = null) {
  const where = ['r.suggested_order_qty IS NOT NULL', 'r.suggested_order_qty > 0'];
  const params = [];
  if (stores.length) { params.push(stores); where.push(`r.client_id = ANY($${params.length}::int[])`); }
  if (sinceDate) {
    params.push(sinceDate);
    where.push(`(u.generated_at AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}::date`);
  } else {
    params.push(sinceDays);
    where.push(`u.generated_at > now() - ($${params.length} || ' days')::interval`);
  }
  const { rows } = await analytics.query(
    `SELECT r.id, r.client_id, r.location_id, r.action_type, r.engine_family,
            r.primary_skus, r.reference_upc, r.suggested_order_qty,
            r.engine_on_hand, r.engine_daily_rate, r.confidence,
            r.holding_cost_if_unsold, r.expected_range_low, r.expected_range_high,
            r.promise_floor_units, r.status,
            u.generated_at::date AS rec_date,
            COALESCE(a.visible, true) AS was_visible
       FROM recommendations r
       JOIN recommendation_runs u ON u.id = r.run_id
       LEFT JOIN recommendation_admission a ON a.rec_id::bigint = r.id
      WHERE ${where.join(' AND ')}
      ORDER BY u.generated_at DESC, r.client_id, r.id`,
    params
  );
  return rows;
}

// ── The simulation ───────────────────────────────────────────────────────────

/**
 * Score one card.
 *
 * Returns the full working, not just a verdict: every rate, every day of the
 * window and every reason is in the row, so a surprising classification can be
 * argued with rather than taken on trust.
 */
function evaluateCard(card, ctx) {
  const { openDaysAsc, units, econ, windowDays, safetyCoverDays, windowMode } = ctx;
  const sku = (card.primary_skus || [])[0] || card.reference_upc || null;
  const qty = num(card.suggested_order_qty);
  const recDate = day(card.rec_date);

  const row = {
    rec_id: String(card.id),
    store_id: card.client_id,
    location_id: card.location_id,
    rec_date: recDate,
    action_type: card.action_type,
    engine_family: card.engine_family || null,
    was_visible: card.was_visible,
    stated_confidence: num(card.confidence),
    product_id: sku,
    product_name: (econ[sku] || {}).name || null,
    category: (econ[sku] || {}).category || null,
    recommended_qty: qty,
    window_open_days_requested: windowDays,
  };

  if (!sku || qty === null) {
    return { ...row, outcome: 'no_data', reason: 'card carries no SKU or no quantity' };
  }

  // The store's own rate, preferring what the card recorded at the time. Hoisted
  // above the window because in `intended` mode the window LENGTH depends on it.
  const perDayAll = units[sku] || null;
  let rate = num(card.engine_daily_rate);
  let rateBasis = 'engine_daily_rate recorded on the card';
  if (rate === null) {
    const before = openDaysAsc.filter((d) => d <= recDate).slice(-RATE_WINDOW_OPEN_DAYS);
    if (before.length && perDayAll) {
      const u = before.reduce((a, d) => a + (perDayAll[d] || 0), 0);
      rate = u / before.length;
      rateBasis = `measured over the ${before.length} open days before the card`;
    } else {
      rateBasis = 'no rate available';
    }
  }
  row.daily_rate = rate === null ? null : Math.round(rate * 1000) / 1000;
  row.daily_rate_basis = rateBasis;

  // HOW LONG THE ORDER WAS SIZED TO LAST, in open days. This is the horizon the
  // engine actually chose, and it is the only fair period over which to ask
  // whether the quantity sold through.
  const intendedDays = (rate !== null && rate > 0) ? Math.ceil(qty / rate) : null;
  row.intended_cover_open_days = intendedDays;

  // THE WINDOW, in open days strictly after the recommendation date.
  //
  // WHY THE MODE MATTERS MORE THAN ANY OTHER SETTING HERE. A reorder card is
  // sized to cover a REORDER CYCLE - at this store the quantities imply twelve
  // to twenty-six open days. Asking whether three weeks of stock sold in one
  // week is not a hard test, it is an impossible one, and it returns a success
  // rate near zero for an engine that sized the order correctly. The first run
  // of this script did exactly that and reported 1.8%.
  //
  //   fixed     every card gets the same window. Comparable across cards, but
  //             `successful` is unreachable whenever the window is shorter than
  //             the cover, so read ITE and velocity, not the success rate.
  //   intended  each card gets its own cover horizon. This is the honest test
  //             of the quantity, and it means a card cannot be scored until its
  //             own horizon has elapsed - most will be `pending` for weeks.
  const after = openDaysAsc.filter((d) => d > recDate);
  const needDays = windowMode === 'intended'
    ? (intendedDays === null ? null : intendedDays)
    : windowDays;
  row.window_mode = windowMode;
  row.window_open_days_requested = needDays;
  row.window_open_days_available = after.length;

  if (needDays === null) {
    return {
      ...row,
      outcome: 'no_data',
      reason: 'intended-horizon mode needs a daily rate and this card has none, so '
        + 'the period the order was sized for is unknown',
      actual_sold: null, variance: null,
    };
  }

  const windowDaysList = after.slice(0, needDays);
  row.window_start = windowDaysList[0] || null;
  row.window_end = windowDaysList[windowDaysList.length - 1] || null;

  // TRAP 1: an open window is not a failed one.
  if (windowDaysList.length < needDays) {
    return {
      ...row,
      outcome: 'pending',
      reason: `window needs ${needDays} open days`
        + (windowMode === 'intended'
          ? ` (${qty} units at ${row.daily_rate}/open day)` : '')
        + `, only ${windowDaysList.length} have elapsed since the card was issued`,
      actual_sold: null, variance: null,
    };
  }

  // TRAP 2: absence is not zero. The store must have been trading in the
  // window for "sold nothing" to mean anything. By construction every day in
  // windowDaysList is an open day for this store, so a store that stopped
  // reporting simply has no days here and lands in `pending` above. This
  // guard catches the remaining case: the SKU is absent from the catalogue and
  // the feed, so we cannot tell a zero from a gap.
  const perDay = perDayAll;
  const knownSku = perDay !== null || (econ[sku] && (econ[sku].price !== null || econ[sku].name));
  if (!knownSku) {
    return {
      ...row,
      outcome: 'no_data',
      reason: 'SKU appears in neither the sales feed nor the product master, so '
        + 'zero sales cannot be distinguished from missing data',
      actual_sold: null, variance: null,
    };
  }

  const soldByDay = windowDaysList.map((d) => (perDay ? (perDay[d] || 0) : 0));
  const sold = soldByDay.reduce((a, b) => a + b, 0);
  row.actual_sold = Math.round(sold * 100) / 100;
  row.variance = Math.round((sold - qty) * 100) / 100;
  row.absorption_ratio = qty > 0 ? Math.round((sold / qty) * 1000) / 1000 : null;

  // VELOCITY, the one measure that does not depend on the window length.
  //
  // Absorption asks "did the whole order sell", which a short window can make
  // impossible. This asks "did the product move at the pace the engine said it
  // would", which is answerable over any number of open days and is the actual
  // forecasting claim behind the quantity. A ratio of 1.0 means the SKU sold
  // exactly at the predicted rate; above 1.0 means the engine under-predicted.
  const expected = rate === null ? null : rate * windowDaysList.length;
  row.expected_units_at_rate = expected === null ? null
    : Math.round(expected * 100) / 100;
  row.velocity_ratio = (expected !== null && expected > 0)
    ? Math.round((sold / expected) * 1000) / 1000 : null;
  row.met_forecast_rate = row.velocity_ratio === null ? null : row.velocity_ratio >= 1;

  // SIMULATION: inventory only. Demand is observed, never modelled.
  const onHand = num(card.engine_on_hand);
  row.on_hand_at_rec = onHand;
  row.simulatable = onHand !== null;

  let stockoutDay = null;
  let endingInventory = null;
  if (onHand !== null) {
    let inv = onHand + qty;
    for (let i = 0; i < windowDaysList.length; i += 1) {
      inv -= soldByDay[i];
      if (inv <= 0 && stockoutDay === null) stockoutDay = windowDaysList[i];
    }
    endingInventory = Math.round(Math.max(0, inv) * 100) / 100;
  }
  row.simulated_stockout_date = stockoutDay;
  row.simulated_ending_inventory = endingInventory;

  const safety = rate === null ? null
    : Math.round(rate * safetyCoverDays * 100) / 100;
  row.safety_stock_units = safety;
  row.safety_cover_days = safetyCoverDays;

  // Unmet demand under the simulation: real units that sold AFTER the day the
  // simulated inventory ran out. Those are observed sales the recommended
  // quantity could not have served, which is the only honest evidence of a
  // shortfall - a modelled "lost sale" would be a guess.
  let unmet = 0;
  if (stockoutDay) {
    const k = windowDaysList.indexOf(stockoutDay);
    unmet = soldByDay.slice(k + 1).reduce((a, b) => a + b, 0);
  }
  row.unmet_demand_after_stockout = Math.round(unmet * 100) / 100;

  // ── Classification, in precedence order ────────────────────────────────
  let outcome;
  let reason;
  if (stockoutDay && unmet > 0) {
    outcome = 'understocked';
    reason = `even with the ${qty} recommended units the simulated stock ran out on `
      + `${stockoutDay}, and ${row.unmet_demand_after_stockout} further units sold after that`;
  } else if (sold === 0) {
    outcome = 'unutilized';
    reason = `the store traded on all ${windowDaysList.length} window days and this SKU `
      + 'sold nothing';
  } else if (sold >= qty && !stockoutDay) {
    outcome = 'successful';
    reason = `sold ${row.actual_sold} against ${qty} recommended, with no simulated stockout`;
  } else if (sold >= qty) {
    // Absorbed in full but the trajectory still hit zero on the last day with
    // nothing left unserved. The order was right, not too small.
    outcome = 'successful';
    reason = `sold ${row.actual_sold} against ${qty} recommended; simulated stock reached `
      + 'zero but no demand went unserved';
  } else if (safety !== null && endingInventory !== null
             && endingInventory > safety * (1 + OVERSTOCK_TOLERANCE)) {
    outcome = 'overstocked';
    reason = `${endingInventory} units left against a ${safety}-unit safety stock `
      + `(${safetyCoverDays} open days of cover), more than ${Math.round(OVERSTOCK_TOLERANCE * 100)}% above it`;
  } else {
    outcome = 'partial_absorption';
    reason = `sold ${row.actual_sold} of ${qty} recommended`
      + (endingInventory === null
        ? '; no on-hand snapshot, so neither overstock nor stockout can be determined'
        : `, ending at ${endingInventory} units which is within a safety stock`);
  }
  row.outcome = outcome;
  row.reason = reason;

  // ── Money. Units x margin, never a probability x a margin. ─────────────
  const e = econ[sku] || {};
  const margin = e.margin;
  row.unit_margin = margin;
  row.unit_cost = e.cost;
  // Gross margin realised on the units that moved, capped at the recommended
  // quantity: units beyond it would have sold without the card.
  const credited = Math.min(sold, qty);
  row.units_credited = Math.round(credited * 100) / 100;
  row.realised_margin = margin === null ? null
    : Math.round(credited * margin * 100) / 100;
  // Capital tied up in what did not move, over the window only.
  const idle = endingInventory === null ? null : Math.max(0, endingInventory);
  const recordedHolding = num(card.holding_cost_if_unsold);
  if (recordedHolding !== null) {
    row.holding_cost = recordedHolding;
    row.holding_cost_basis = 'holding_cost_if_unsold recorded on the card';
  } else if (idle !== null && e.cost !== null) {
    row.holding_cost = Math.round(idle * e.cost * HOLDING_COST_ANNUAL_RATE
      * (windowDaysList.length / 365) * 100) / 100;
    row.holding_cost_basis = `${Math.round(HOLDING_COST_ANNUAL_RATE * 100)}% annual on `
      + `${idle} idle units over ${windowDaysList.length} open days`;
  } else {
    row.holding_cost = null;
    row.holding_cost_basis = 'unknown: no cost on this SKU';
  }
  row.net_impact = (row.realised_margin === null && row.holding_cost === null) ? null
    : Math.round(((row.realised_margin || 0) - (row.holding_cost || 0)) * 100) / 100;

  return row;
}

// ── Metrics ──────────────────────────────────────────────────────────────────

function calculateConfidenceMetrics(rows) {
  const counts = {};
  for (const o of OUTCOMES) counts[o] = 0;
  for (const r of rows) counts[r.outcome] = (counts[r.outcome] || 0) + 1;

  // SCORED means the window closed and we know what happened. `pending` and
  // `no_data` are neither successes nor failures and must not sit in a
  // denominator - that is the difference between "the engine was wrong" and
  // "we have not found out yet".
  const scored = rows.filter((r) => !['pending', 'no_data'].includes(r.outcome));
  const n = scored.length;
  const ok = counts.successful;
  const [lo, hi] = wilson(ok, n);

  // VELOCITY, reported separately because it is the only rate here that does
  // not depend on the window length - see evaluateCard. At a fixed window
  // shorter than the order cover this is the figure to read, not the success
  // rate.
  const withVel = scored.filter((r) => r.velocity_ratio !== null);
  const metRate = withVel.filter((r) => r.met_forecast_rate).length;
  const [vlo, vhi] = wilson(metRate, withVel.length);
  const velSorted = withVel.map((r) => r.velocity_ratio).sort((x, y) => x - y);
  const medianVel = velSorted.length
    ? velSorted[Math.floor(velSorted.length / 2)] : null;

  const recommended = scored.reduce((a, r) => a + (r.recommended_qty || 0), 0);
  const soldTotal = scored.reduce((a, r) => a + (r.actual_sold || 0), 0);

  const withMoney = scored.filter((r) => r.net_impact !== null);
  const realised = withMoney.reduce((a, r) => a + (r.realised_margin || 0), 0);
  const holding = withMoney.reduce((a, r) => a + (r.holding_cost || 0), 0);

  // CALIBRATION: does a card that claimed 0.6 confidence come good six times
  // in ten? This is the question "engine confidence" actually asks, and it is
  // answerable without inventing a composite score.
  //
  // SCORED AGAINST met_forecast_rate, NOT against `successful`. Calibrating on
  // `successful` reads 0% in almost every band whenever the window is shorter
  // than the order cover - not because the stated confidence is wrong but
  // because the target is unreachable, and a table of zeroes would indict the
  // engine for the measurement's own flaw. Whether the product moved at its
  // predicted rate is reachable at any window length, so it is the fair target.
  const buckets = [[0, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.7], [0.7, 1.01]];
  const calibration = buckets.map(([a, b]) => {
    const inB = scored.filter((r) => r.stated_confidence !== null
      && r.met_forecast_rate !== null
      && r.stated_confidence >= a && r.stated_confidence < b);
    const hits = inB.filter((r) => r.met_forecast_rate).length;
    const [bl, bh] = wilson(hits, inB.length);
    return {
      band: `${a.toFixed(2)}-${b >= 1 ? '1.00' : b.toFixed(2)}`,
      cards: inB.length,
      stated_mean: inB.length
        ? Math.round((inB.reduce((s, r) => s + r.stated_confidence, 0) / inB.length) * 1000) / 1000
        : null,
      observed_met_rate_pct: inB.length ? Math.round((hits / inB.length) * 1000) / 10 : null,
      ci95: inB.length ? [Math.round(bl * 10) / 10, Math.round(bh * 10) / 10] : [null, null],
    };
  });

  return {
    counts,
    evaluated: n,
    pending: counts.pending,
    no_data: counts.no_data,
    recommendation_accuracy_rate_pct: n ? Math.round((ok / n) * 1000) / 10 : null,
    rar_ci95: n ? [Math.round(lo * 10) / 10, Math.round(hi * 10) / 10] : [null, null],
    met_forecast_rate_pct: withVel.length
      ? Math.round((metRate / withVel.length) * 1000) / 10 : null,
    met_forecast_rate_ci95: withVel.length
      ? [Math.round(vlo * 10) / 10, Math.round(vhi * 10) / 10] : [null, null],
    median_velocity_ratio: medianVel,
    cards_with_velocity: withVel.length,
    inventory_turnover_efficiency: recommended > 0
      ? Math.round((soldTotal / recommended) * 1000) / 1000 : null,
    units_recommended: Math.round(recommended * 100) / 100,
    units_sold: Math.round(soldTotal * 100) / 100,
    realised_margin: Math.round(realised * 100) / 100,
    holding_cost: Math.round(holding * 100) / 100,
    net_financial_impact: Math.round((realised - holding) * 100) / 100,
    cards_with_money: withMoney.length,
    simulatable: scored.filter((r) => r.simulatable).length,
    calibration,
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

const CSV_COLS = ['rec_id', 'store_id', 'rec_date', 'action_type', 'engine_family',
  'was_visible', 'product_id', 'product_name', 'category', 'recommended_qty',
  'actual_sold', 'variance', 'absorption_ratio', 'outcome', 'daily_rate',
  'on_hand_at_rec', 'simulated_ending_inventory', 'safety_stock_units',
  'simulated_stockout_date', 'unmet_demand_after_stockout', 'stated_confidence',
  'unit_margin', 'realised_margin', 'holding_cost', 'net_impact',
  'window_start', 'window_end', 'window_open_days_available', 'reason'];

function toCsv(rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLS.join(','),
    ...rows.map((r) => CSV_COLS.map((c) => cell(r[c])).join(','))].join('\n');
}

function printSummary(m, meta) {
  const bar = '='.repeat(78);
  console.log('');
  console.log(bar);
  console.log('  FORWARD TEST - assumes every card was accepted in full'.padStart(52));
  console.log(bar);
  console.log(`  stores: ${meta.stores}   window: ${meta.windowMode === "intended" ? "each card's own cover" : meta.windowDays + " OPEN days"}   `
    + `safety cover: ${meta.safetyCoverDays} open days`);
  console.log(`  cards examined: ${meta.total}`);
  console.log('');
  console.log('  OUTCOMES');
  const label = {
    successful: 'Successful restock',
    partial_absorption: 'Partial absorption',
    overstocked: 'Overstocked (waste)',
    understocked: 'Understocked (missed)',
    unutilized: 'Unutilized (dead)',
    no_data: 'No data (not a verdict)',
    pending: 'Pending (window open)',
  };
  for (const o of OUTCOMES) {
    const n = m.counts[o] || 0;
    const share = m.evaluated && !['pending', 'no_data'].includes(o)
      ? ` ${(n / m.evaluated * 100).toFixed(1)}% of scored` : '';
    console.log(`    ${label[o].padEnd(26)} ${String(n).padStart(5)}${share}`);
  }
  console.log('');
  console.log(`  SCORED: ${m.evaluated}   (pending ${m.pending} and no-data ${m.no_data} `
    + 'are excluded from every rate below)');
  if (!m.evaluated) {
    console.log('  Nothing has a closed window yet, so no rate can be reported.');
    console.log(bar);
    return;
  }
  console.log('');
  console.log(`  Recommendation Accuracy Rate   ${m.recommendation_accuracy_rate_pct}%  `
    + `(95% CI ${m.rar_ci95[0]} - ${m.rar_ci95[1]}, n=${m.evaluated})`);
  console.log(`  Met the forecast rate          ${m.met_forecast_rate_pct}%  `
    + `(95% CI ${m.met_forecast_rate_ci95[0]} - ${m.met_forecast_rate_ci95[1]}, n=${m.cards_with_velocity})`);
  console.log(`  Median velocity ratio          ${m.median_velocity_ratio}  `
    + '(1.00 = sold exactly at the predicted rate)');
  console.log(`  Inventory Turnover Efficiency  ${m.inventory_turnover_efficiency}  `
    + `(${m.units_sold} units sold of ${m.units_recommended} recommended)`);
  console.log(`  Realised margin                $${m.realised_margin.toLocaleString('en-US')}`);
  console.log(`  Holding cost of what sat       $${m.holding_cost.toLocaleString('en-US')}`);
  console.log(`  Net financial impact           $${m.net_financial_impact.toLocaleString('en-US')}  `
    + `(on ${m.cards_with_money} cards with known unit economics)`);
  console.log(`  Stockout-simulatable           ${m.simulatable} of ${m.evaluated} cards `
    + 'carried an on-hand snapshot');
  console.log('');
  console.log('  CALIBRATION - stated confidence vs how often the SKU met its'
    + ' own predicted rate');
  console.log(`    ${'band'.padEnd(12)}${'cards'.padStart(6)}${'stated'.padStart(9)}`
    + `${'observed'.padStart(10)}   95% CI`);
  for (const c of m.calibration) {
    if (!c.cards) continue;
    console.log(`    ${c.band.padEnd(12)}${String(c.cards).padStart(6)}`
      + `${String(c.stated_mean).padStart(9)}${String(c.observed_met_rate_pct + '%').padStart(10)}`
      + `   ${c.ci95[0]} - ${c.ci95[1]}`);
  }
  console.log(bar);
}

// ── The run, as a function ───────────────────────────────────────────────────
//
// The CLI below and scripts/forward-test-daily.js both call this. It is the
// whole measurement - fetch, per-store data, score, metrics - with no process
// exit and no file write, so the daily job can run it four times (two window
// modes, two periods) and persist the result itself. Everything the CLI used
// to print still prints, through `log`, so its console output is unchanged.

/**
 * Per-store data for the simulation: open days, daily units and economics for
 * the SKUs on the store's cards. `cache` (a Map, optional) lets a caller that
 * runs the test several times over the same cards fetch each store's data
 * once: three syncgo queries per store per run adds up when the job runs the
 * test four times a morning. A cache entry is reused only if it covers every
 * SKU the current cards need, otherwise it is refetched - a partial reuse
 * would silently score some cards against an empty sales map.
 */
async function storeData(syncgo, clientId, skus, cache) {
  const hit = cache && cache.get(clientId);
  if (hit && skus.every((s) => hit.skuSet.has(s))) return hit;
  const openDaysAsc = await openDays(syncgo, clientId);
  const units = await dailyUnits(syncgo, clientId, skus);
  const econ = await unitEconomics(syncgo, clientId, skus);
  const entry = { openDaysAsc, units, econ, skuSet: new Set(skus) };
  if (cache) cache.set(clientId, entry);
  return entry;
}

/**
 * Run the forward test.
 *
 * @param analytics  pg pool for bottleai_analytics (read only here)
 * @param syncgo     pg pool for the syncgo warehouse (read only)
 * @param opts       stores: int[] (empty = all), sinceDays, sinceDate ('YYYY-MM-DD',
 *                   wins over sinceDays), windowDays, safetyCoverDays,
 *                   windowMode 'fixed'|'intended', log (default console.log),
 *                   cache (Map, see storeData)
 * @returns {{rows, metrics, meta}}  meta carries every setting the run used,
 *          and `meta.cards` is the count fetched, so a caller can tell "no card
 *          carried a quantity" (cards 0, rows []) from a run that scored.
 */
async function runForwardTest(analytics, syncgo, opts = {}) {
  const stores = opts.stores || [];
  const sinceDays = opts.sinceDays ?? 60;
  const sinceDate = opts.sinceDate || null;
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const safetyCoverDays = opts.safetyCoverDays ?? DEFAULT_SAFETY_COVER_DAYS;
  const windowMode = (opts.windowMode || 'fixed').toLowerCase();
  const log = opts.log || console.log;
  const cache = opts.cache || null;
  if (!['fixed', 'intended'].includes(windowMode)) {
    throw new Error("windowMode must be 'fixed' or 'intended'");
  }

  const meta = {
    stores: stores.length ? stores.join(',') : 'all',
    storeList: stores,
    windowMode, windowDays, safetyCoverDays, sinceDays, sinceDate,
    total: 0, cards: 0,
  };

  log(`[1/5] fetching recommendations (${sinceDate ? `since ${sinceDate}` : `last ${sinceDays} days`}`
    + `${stores.length ? `, stores ${stores.join(',')}` : ', all stores'}) ...`);
  const cards = await fetchRecommendations(analytics, stores, sinceDays, sinceDate);
  meta.cards = cards.length;
  log(`      ${cards.length} card(s) carry a suggested order quantity`);
  if (!cards.length) {
    log('      nothing to evaluate - no card in the window carries a quantity');
    return { rows: [], metrics: calculateConfidenceMetrics([]), meta };
  }

  const byStore = new Map();
  for (const c of cards) {
    if (!byStore.has(c.client_id)) byStore.set(c.client_id, []);
    byStore.get(c.client_id).push(c);
  }

  const rows = [];
  let done = 0;
  for (const [clientId, storeCards] of byStore) {
    log(`[2/5] store ${clientId}: snapshotting open days and sales ...`);
    const skus = [...new Set(storeCards
      .flatMap((c) => [...(c.primary_skus || []), c.reference_upc])
      .filter(Boolean).map(String))];
    const { openDaysAsc, units, econ } = await storeData(syncgo, clientId, skus, cache);
    log(`      ${openDaysAsc.length} open days, ${skus.length} SKUs, `
      + `economics on ${Object.values(econ).filter((e) => e.margin !== null).length}`);

    log(`[3/5] store ${clientId}: simulating restock and scoring ${storeCards.length} card(s) ...`);
    for (const card of storeCards) {
      rows.push(evaluateCard(card, { openDaysAsc, units, econ, windowDays, safetyCoverDays, windowMode }));
      done += 1;
      if (done % 50 === 0) log(`      ${done}/${cards.length} scored`);
    }
  }

  log('[4/5] computing metrics ...');
  const metrics = calculateConfidenceMetrics(rows);
  meta.total = rows.length;
  return { rows, metrics, meta };
}

/** The JSON document the CLI writes - the same shape for every caller. */
function buildPayload({ rows, metrics, meta }) {
  return {
    generated_at: new Date().toISOString(),
    assumption: 'every recommendation was accepted and ordered in full',
    measured: 'daily units per SKU from sale_items, unchanged',
    simulated: 'the inventory trajectory only (engine_on_hand + recommended qty, '
      + 'depleted by real daily units)',
    window: {
      mode: meta.windowMode,
      open_days: meta.windowMode === 'intended' ? 'per card: ceil(qty / daily rate)' : meta.windowDays,
      note: 'open days, never calendar days',
    },
    settings: {
      safety_cover_days: meta.safetyCoverDays,
      overstock_tolerance: OVERSTOCK_TOLERANCE,
      rate_window_open_days: RATE_WINDOW_OPEN_DAYS,
      holding_cost_annual_rate: HOLDING_COST_ANNUAL_RATE,
      since_days: meta.sinceDays,
      ...(meta.sinceDate ? { since_date: meta.sinceDate } : {}),
    },
    scope: { stores: meta.storeList.length ? meta.storeList : 'all', cards_examined: rows.length },
    metrics,
    cards: rows,
  };
}

/** The filename stamp: the MODE belongs in it - see the CLI below for why. */
const fileStamp = (windowMode, windowDays) => (windowMode === 'intended' ? 'intended' : `w${windowDays}`);

module.exports = {
  fetchRecommendations, openDays, dailyUnits, unitEconomics, evaluateCard,
  calculateConfidenceMetrics, toCsv, printSummary, CSV_COLS, OUTCOMES,
  runForwardTest, buildPayload, fileStamp, wilson, day,
  DEFAULT_WINDOW_DAYS, DEFAULT_SAFETY_COVER_DAYS, RATE_WINDOW_OPEN_DAYS,
};

// ── Main ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const stores = (arg('stores') || arg('store-id') || '').split(',')
      .map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
    const windowDays = parseInt(arg('window-days', String(DEFAULT_WINDOW_DAYS)), 10);
    const safetyCoverDays = parseInt(
      arg('safety-cover-days', String(DEFAULT_SAFETY_COVER_DAYS)), 10);
    const sinceDays = parseInt(arg('since-days', '60'), 10);
    const windowMode = (arg('window-mode', 'fixed') || 'fixed').toLowerCase();
    if (!['fixed', 'intended'].includes(windowMode)) {
      console.error("--window-mode must be 'fixed' or 'intended'");
      process.exit(1);
    }
    const outDir = arg('out', null);
    const format = arg('output-format', 'both');

    const analytics = getAnalyticsPool();
    const syncgo = getPool();

    const result = await runForwardTest(analytics, syncgo, {
      stores, sinceDays, windowDays, safetyCoverDays, windowMode,
    });
    if (!result.meta.cards) process.exit(0);
    const { rows, metrics, meta } = result;

    printSummary(metrics, meta);

    if (outDir) {
      console.log('[5/5] writing the report ...');
      fs.mkdirSync(outDir, { recursive: true });
      // The MODE belongs in the filename. Both modes default to the same
      // --window-days, so a stamp of w7 alone had the intended-horizon run
      // silently overwrite the fixed-window one - two different measurements,
      // one filename, and no way to tell afterwards which was which.
      const stamp = fileStamp(windowMode, windowDays);
      const payload = buildPayload(result);
      if (format === 'json' || format === 'both') {
        const f = path.join(outDir, `forward_test_${stamp}.json`);
        fs.writeFileSync(f, JSON.stringify(payload, null, 2));
        console.log(`      wrote ${f}`);
      }
      if (format === 'csv' || format === 'both') {
        const f = path.join(outDir, `forward_test_${stamp}.csv`);
        fs.writeFileSync(f, '﻿' + toCsv(rows));
        console.log(`      wrote ${f}`);
      }
    } else {
      console.log('[5/5] no --out given, so nothing written');
    }

    process.exit(0);
  })().catch((e) => { console.error('FAILED:', e.message); console.error(e.stack); process.exit(1); });
}
