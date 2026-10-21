/**
 * Pilot scoreboards - two boards, kept apart, one line per product, per
 * store, per month.
 *
 * THE REQUIREMENT, verbatim from the pre-pilot checklist: "Five GOOD stores
 * only. Two scoreboards kept separate: prediction accuracy (needs no owner
 * action) and holdout money (shown vs withheld, action inferred from stock
 * jumps and invoices). Report monthly per store, one line per product."
 *
 * Every figure here already existed somewhere - lift and the quantities on the
 * outcome row (020/035), the arm on the outcome row, margin and the inferred
 * action on the evaluation row (002/003), the stated range on the card (028),
 * the shown-versus-withheld comparison in recommendationEvalService
 * .holdoutReport - and nothing put them on one page per store per month. This
 * does, and it adds no arithmetic of its own where one exists: the holdout
 * board runs holdoutReport's rules through holdoutReport's exported helpers.
 *
 * BOARD A - PREDICTION ACCURACY. Did what the card predicted come true?
 *   Every card whose 30-day window CLOSED in the month, BOTH arms - a withheld
 *   card is still a prediction, and grading only the shown ones would grade
 *   the engine on the cards it chose to display. One line per product:
 *     cards              outcome rows for the product in the month
 *     measured           of those, with a measurable lift
 *     hits / hit_rate    lift >= 1.0 - the product sold at least what its own
 *                        trailing rate projected - over the MEASURED cards
 *     mean_lift          over the measured cards
 *     promise fill       sum(sold) / sum(recommended), only over cards that
 *                        asked for a quantity; a markdown asks for none and
 *                        must not read as "filled 0%"
 *     interval coverage  sold inside [expected_range_low, expected_range_high]
 *                        over the cards that STATED a range (028); a card
 *                        whose range was refused is counted as refused, with
 *                        the engine's reason
 *     stockout grade     sold_through true / false / ungraded, over the cards
 *                        the evaluator recognises as stockout cards
 *   Nothing on this board reads action_taken, votes, arm or margin. The SQL
 *   does not select them, so a later edit cannot quietly start to.
 *
 * BOARD B - HOLDOUT MONEY. Did TELLING them change anything?
 *   Shown and withheld side by side per product: product-windows per arm (ONE
 *   outcome per product per window, holdoutReport's DISTINCT ON), measurable,
 *   average lift, margin per product per arm (NULL when unpriced), and for the
 *   SHOWN arm the action the evaluator inferred - acted / not / unobservable -
 *   with the detector that asserted it: purchases feed, invoice, stock delta,
 *   price drop. The withheld arm carries no action column: nobody was told,
 *   so "did they act on the card" has no meaning there. The store summary is
 *   holdoutReport itself over the month, difference and refusal included.
 *   Dollars are PER PRODUCT; totals stay on the record, labelled as totals,
 *   and this board never shows a hit rate as a headline.
 *
 * THE MONTH is the calendar month the 30-day window ENDED in - windows named
 * by the month they land in, as the offline ledger names them. The 30-day
 * window only: it is the horizon the stockout grade is taken on (035) and the
 * one holdoutReport defaults to; reporting 7/60/90 as well would give the
 * same card four lines and a reader four hit rates to choose from.
 *
 * NULL IS NEVER ZERO. Every null on either board is accompanied by a reason
 * under `refusals` (board-level) or `refusal` fields (line-level), in the
 * words a reader needs: "no card asked for a quantity" is not "filled 0%".
 */

const logger = require('../utils/logger');
const evalSvc = require('./recommendationEvalService');
const { getPool, makeTenantScopedPool } = require('../database/connection');

const WINDOW_DAYS = 30;
// lift >= 1.0: the product sold at least what its own trailing rate projected.
const HIT_LIFT = 1.0;
const HIT_RULE = `lift >= ${HIT_LIFT.toFixed(1)}: the product sold at least what its own trailing rate projected over the 30-day window`;

const round = (v, places = 3) => (v == null || !Number.isFinite(v)
  ? null : Math.round(v * 10 ** places) / 10 ** places);

/**
 * Wilson score interval for a proportion - the one that behaves on small n,
 * which is every pilot month. Returns null for n = 0: no interval around a
 * number that does not exist.
 */
function wilsonInterval(hits, n, z = 1.96) {
  if (!n || n <= 0) return null;
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: round(Math.max(0, centre - half)), high: round(Math.min(1, centre + half)) };
}

function assertMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) {
    throw new Error(`month must be YYYY-MM, got ${JSON.stringify(month)}`);
  }
  return `${month}-01`;
}

/** Previous calendar month of a date, as YYYY-MM. */
function previousMonth(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-based; the previous month is m-1
  const date = new Date(Date.UTC(y, m - 1, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Which optional columns this database has, in one read. */
async function columnsPresent(pool) {
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'recommendations'
             AND column_name IN ('expected_range_low', 'expected_range_high',
                                 'expected_range_refused', 'engine_family',
                                 'engine_days_cover'))
         OR (table_name = 'recommendation_outcomes'
             AND column_name IN ('sold_through', 'sold_through_reason', 'recommended_qty'))
         OR (table_name = 'recommendation_evaluations' AND column_name = 'margin_impact')`
  );
  const set = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  return {
    range: set.has('recommendations.expected_range_low') && set.has('recommendations.expected_range_high'),
    rangeRefused: set.has('recommendations.expected_range_refused'),
    engineFamily: set.has('recommendations.engine_family'),
    engineCover: set.has('recommendations.engine_days_cover'),
    soldThrough: set.has('recommendation_outcomes.sold_through'),
    recommendedQty: set.has('recommendation_outcomes.recommended_qty'),
    margin: set.has('recommendation_evaluations.margin_impact'),
  };
}

// ─── Board A: prediction accuracy ────────────────────────────────────────────

async function accuracyBoard(pool, clientId, locationId, monthStart, has) {
  // The SELECT names what the board is allowed to know. No arm, no action, no
  // vote, no money - by construction, not by discipline.
  const { rows } = await pool.query(
    `SELECT o.recommendation_id, o.sku, o.lift, o.lift_reason,
            ${has.recommendedQty ? 'o.recommended_qty' : 'NULL::numeric AS recommended_qty'},
            o.actual_units_sold,
            ${has.soldThrough ? 'o.sold_through, o.sold_through_reason' : 'NULL::boolean AS sold_through, NULL::text AS sold_through_reason'},
            to_char(o.window_start, 'YYYY-MM-DD') AS window_start,
            to_char(o.window_end, 'YYYY-MM-DD')   AS window_end,
            r.action_type,
            ${has.engineFamily ? 'r.engine_family' : 'NULL::text AS engine_family'},
            ${has.engineCover ? 'r.engine_days_cover' : 'NULL::numeric AS engine_days_cover'},
            ${has.range ? 'r.expected_range_low, r.expected_range_high' : 'NULL::numeric AS expected_range_low, NULL::numeric AS expected_range_high'},
            ${has.rangeRefused ? 'r.expected_range_refused' : 'NULL::text AS expected_range_refused'}
       FROM recommendation_outcomes o
       JOIN recommendations r ON r.id = o.recommendation_id
      WHERE o.client_id = $1 AND o.location_id = $2
        AND (o.window_end - o.window_start) = $3
        AND o.window_end >= $4::date
        AND o.window_end < ($4::date + interval '1 month')
      ORDER BY o.sku, o.window_start`,
    [clientId, locationId, WINDOW_DAYS, monthStart]
  );

  const bySku = new Map();
  const line = (sku) => {
    if (!bySku.has(sku)) {
      bySku.set(sku, {
        sku, product: null,
        cards: 0, measured: 0, hits: 0, liftSum: 0,
        promise: { cards_with_quantity: 0, recommended_units: 0, sold_units: 0 },
        range: { cards_with_range: 0, inside: 0, refused: 0, refused_reasons: new Set() },
        stockout: { cards: 0, sold_through: 0, not_sold_through: 0, ungraded: 0, ungraded_reasons: new Set() },
      });
    }
    return bySku.get(sku);
  };

  for (const o of rows) {
    const l = line(o.sku);
    l.cards += 1;
    const lift = o.lift != null ? Number(o.lift) : null;
    if (lift != null) {
      l.measured += 1;
      l.liftSum += lift;
      if (lift >= HIT_LIFT) l.hits += 1;
    }
    const sold = o.actual_units_sold != null ? Number(o.actual_units_sold) : null;
    // Promise fill: only a card that asked for a quantity can be filled.
    if (o.recommended_qty != null && sold != null) {
      l.promise.cards_with_quantity += 1;
      l.promise.recommended_units += Number(o.recommended_qty);
      l.promise.sold_units += sold;
    }
    // Interval coverage: only a card that STATED a range can be covered.
    if (o.expected_range_low != null && o.expected_range_high != null && sold != null) {
      l.range.cards_with_range += 1;
      if (sold >= Number(o.expected_range_low) && sold <= Number(o.expected_range_high)) {
        l.range.inside += 1;
      }
    } else if (o.expected_range_refused) {
      l.range.refused += 1;
      l.range.refused_reasons.add(String(o.expected_range_refused));
    }
    // The stockout grade, over the cards the EVALUATOR calls stockout cards -
    // the persisted family, or its stated fallback for rows older than 035.
    if (evalSvc.isStockoutCard(o)) {
      l.stockout.cards += 1;
      if (o.sold_through === true) l.stockout.sold_through += 1;
      else if (o.sold_through === false) l.stockout.not_sold_through += 1;
      else {
        l.stockout.ungraded += 1;
        if (o.sold_through_reason) l.stockout.ungraded_reasons.add(String(o.sold_through_reason));
      }
    }
  }

  const sealLine = (l) => {
    const refusals = [];
    const hitRate = l.measured > 0 ? round(l.hits / l.measured) : null;
    if (hitRate == null) refusals.push('hit rate: no card for this product had a measurable lift');
    const fill = l.promise.cards_with_quantity > 0 && l.promise.recommended_units > 0
      ? round(l.promise.sold_units / l.promise.recommended_units) : null;
    if (fill == null) {
      refusals.push(l.promise.cards_with_quantity === 0
        ? 'promise fill: no card for this product asked for a quantity'
        : 'promise fill: the quantities asked for sum to zero');
    }
    const coverage = l.range.cards_with_range > 0 ? round(l.range.inside / l.range.cards_with_range) : null;
    if (coverage == null) {
      refusals.push(l.range.refused > 0
        ? `interval coverage: no range stored; the engine refused one on ${l.range.refused} card(s): ${[...l.range.refused_reasons].join('; ')}`
        : 'interval coverage: no range stored on any card for this product');
    }
    return {
      sku: l.sku,
      product: l.product || l.sku,
      cards: l.cards,
      measured: l.measured,
      hits: l.hits,
      hit_rate: hitRate,
      mean_lift: l.measured > 0 ? round(l.liftSum / l.measured) : null,
      promise_fill: {
        cards_with_quantity: l.promise.cards_with_quantity,
        recommended_units: round(l.promise.recommended_units, 2),
        sold_units: round(l.promise.sold_units, 2),
        fill_ratio: fill,
      },
      interval_coverage: {
        cards_with_range: l.range.cards_with_range,
        inside_range: l.range.inside,
        range_refused: l.range.refused,
        coverage: coverage,
      },
      stockout_grade: {
        cards: l.stockout.cards,
        sold_through: l.stockout.sold_through,
        not_sold_through: l.stockout.not_sold_through,
        ungraded: l.stockout.ungraded,
        ...(l.stockout.ungraded_reasons.size
          ? { ungraded_reasons: [...l.stockout.ungraded_reasons] } : {}),
      },
      refusals,
    };
  };

  const lines = [...bySku.values()].map(sealLine)
    .sort((a, b) => b.cards - a.cards || a.sku.localeCompare(b.sku));

  // The store line: pooled, not averaged over lines, so a product with one
  // card does not weigh as much as one with nine.
  const sum = (f) => lines.reduce((acc, l) => acc + f(l), 0);
  const cards = sum((l) => l.cards);
  const measured = sum((l) => l.measured);
  const hits = sum((l) => l.hits);
  const liftSum = [...bySku.values()].reduce((acc, l) => acc + l.liftSum, 0);
  const recUnits = sum((l) => l.promise_fill.recommended_units);
  const soldUnits = sum((l) => l.promise_fill.sold_units);
  const withQty = sum((l) => l.promise_fill.cards_with_quantity);
  const withRange = sum((l) => l.interval_coverage.cards_with_range);
  const inside = sum((l) => l.interval_coverage.inside_range);
  const rangeRefused = sum((l) => l.interval_coverage.range_refused);
  const stockout = {
    cards: sum((l) => l.stockout_grade.cards),
    sold_through: sum((l) => l.stockout_grade.sold_through),
    not_sold_through: sum((l) => l.stockout_grade.not_sold_through),
    ungraded: sum((l) => l.stockout_grade.ungraded),
  };

  const refusals = [];
  if (cards === 0) refusals.push(`no card's ${WINDOW_DAYS}-day window closed in this month`);
  if (cards > 0 && measured === 0) refusals.push('hit rate: no card had a measurable lift (every baseline projected zero units)');
  if (withQty === 0) refusals.push('promise fill: no card asked for a quantity');
  else if (recUnits <= 0) refusals.push('promise fill: the quantities asked for sum to zero');
  if (withRange === 0) {
    refusals.push(rangeRefused > 0
      ? `interval coverage: no range stored; the engine refused one on ${rangeRefused} card(s)`
      : 'interval coverage: no range stored on any card this month');
  }
  if (stockout.cards === 0) refusals.push('stockout grade: no stockout card closed this month');
  else if (stockout.sold_through + stockout.not_sold_through === 0) {
    refusals.push(`stockout grade: ${stockout.ungraded} stockout card(s) closed and none could be graded`);
  }

  return {
    what_this_board_measures: 'Did what the card predicted come true. Graded on the prediction alone; '
      + 'needs no owner action, and reads neither the arm, the inferred action, the votes nor the money.',
    window_days: WINDOW_DAYS,
    both_arms_counted: true,
    hit_rule: HIT_RULE,
    summary: {
      cards,
      products: lines.length,
      measured_on: measured,
      hits,
      hit_rate: measured > 0 ? round(hits / measured) : null,
      hit_rate_interval_95: wilsonInterval(hits, measured),
      mean_lift: measured > 0 ? round(liftSum / measured) : null,
      promise_fill: {
        cards_with_quantity: withQty,
        recommended_units: round(recUnits, 2),
        sold_units: round(soldUnits, 2),
        fill_ratio: withQty > 0 && recUnits > 0 ? round(soldUnits / recUnits) : null,
      },
      interval_coverage: {
        cards_with_range: withRange,
        inside_range: inside,
        range_refused: rangeRefused,
        coverage: withRange > 0 ? round(inside / withRange) : null,
      },
      stockout_grade: stockout,
    },
    lines,
    refusals,
  };
}

// ─── Board B: holdout money ──────────────────────────────────────────────────

/** The detector names an owner reads, from the evaluator's evidence labels. */
const DETECTOR_LABELS = {
  purchase_orders: 'purchases feed',
  invoice: 'invoice',
  stock_delta: 'stock delta',
  price: 'price drop',
  catalog_registry: 'catalogue arrival',
  owner_reported: 'owner reported',
};

/** Which detectors asserted TRUE on one evaluation's evidence, as labels. */
function assertingDetectors(evidence) {
  if (!evidence || typeof evidence !== 'object') return [];
  const found = new Set();
  if (evidence.detector === 'owner_reported') found.add(DETECTOR_LABELS.owner_reported);
  if (evidence.detector === 'catalog_registry') found.add(DETECTOR_LABELS.catalog_registry);
  for (const s of Array.isArray(evidence.skus) ? evidence.skus : []) {
    if (s && s.taken === true && s.detector) found.add(DETECTOR_LABELS[s.detector] || s.detector);
  }
  return [...found];
}

async function holdoutBoard(pool, clientId, locationId, month, has) {
  // Store-level: holdoutReport itself, scoped to the month. Its rules, its
  // refusal, its line.
  const report = await evalSvc.holdoutReport(pool, {
    clientId, locationId, windowDays: WINDOW_DAYS, month,
  });

  // Per product: the SAME per_product CTE, with the evaluation's action
  // columns carried alongside the money, folded per (sku, arm) through the
  // same helpers holdoutReport folds per family.
  const { where, params } = evalSvc.holdoutScope({
    clientId, locationId, windowDays: WINDOW_DAYS, month,
  });
  const { rows } = await pool.query(
    `WITH ${evalSvc.holdoutPerProductCte(where, ', o.recommendation_id, e.action_taken, e.action_evidence')}
     SELECT sku, arm, family, lift, ${has.margin ? 'margin_impact' : 'NULL::real AS margin_impact'},
            recommendation_id, action_taken, action_evidence
       FROM per_product
      ORDER BY sku, arm`,
    params
  );

  const bySku = new Map();
  for (const r of rows) {
    if (!bySku.has(r.sku)) {
      bySku.set(r.sku, {
        sku: r.sku, families: new Set(),
        shown: evalSvc.holdoutArmBlank(), withheld: evalSvc.holdoutArmBlank(),
        action: { acted: 0, not_acted: 0, unobservable: 0, detectors: {} },
      });
    }
    const l = bySku.get(r.sku);
    l.families.add(r.family);
    const arm = r.arm === 'withheld' ? 'withheld' : 'shown';
    const lift = r.lift != null ? Number(r.lift) : null;
    const margin = r.margin_impact != null ? Number(r.margin_impact) : null;
    // One GROUP BY-shaped row per product-window, so the fold is the same
    // fold - weighted by measurable rows - that holdoutReport applies.
    evalSvc.holdoutArmFold(l[arm], {
      products: 1, measurable: lift != null ? 1 : 0, avg_lift: lift,
      priced: margin != null ? 1 : 0, dollars: margin,
    });
    if (arm === 'shown') {
      if (r.action_taken === true) l.action.acted += 1;
      else if (r.action_taken === false) l.action.not_acted += 1;
      else l.action.unobservable += 1;
      for (const d of assertingDetectors(r.action_evidence)) {
        l.action.detectors[d] = (l.action.detectors[d] || 0) + 1;
      }
    }
  }

  const lines = [...bySku.values()].map((l) => {
    evalSvc.holdoutArmSeal(l.shown);
    evalSvc.holdoutArmSeal(l.withheld);
    const refusals = [];
    if (l.shown.products > 0 && l.shown.priced === 0) refusals.push('shown margin: cost unknown on every shown window');
    if (l.withheld.products > 0 && l.withheld.priced === 0) refusals.push('withheld margin: cost unknown on every withheld window');
    if (l.shown.products > 0 && l.shown.measurable === 0) refusals.push('shown lift: no measurable window');
    if (l.withheld.products > 0 && l.withheld.measurable === 0) refusals.push('withheld lift: no measurable window');
    let note = null;
    if (l.shown.products > 0 && l.withheld.products > 0) {
      // Both arms exist for this product. The difference is holdoutReport's
      // rule and it will usually refuse at product level - a product rarely
      // has five windows per arm in one month - and the note says so rather
      // than printing the gap between two single windows as a result.
      const diff = evalSvc.holdoutDifference({ shown: l.shown, withheld: l.withheld });
      const money = (v) => (v == null ? 'unpriced' : `$${v.toFixed(2)}`);
      note = `both arms: shown ${l.shown.avg_lift ?? 'no'} lift / ${money(l.shown.dollars_per_product)} per product over `
        + `${l.shown.products} window(s), withheld ${l.withheld.avg_lift ?? 'no'} lift / ${money(l.withheld.dollars_per_product)} `
        + `over ${l.withheld.products}` + (diff.refused_reason
          ? `; no difference stated - ${diff.refused_reason}`
          : `; difference ${diff.lift > 0 ? '+' : ''}${diff.lift} lift`
            + (diff.dollars_per_product != null ? `, ${money(diff.dollars_per_product)} per product` : ` (${diff.dollars_refused_reason})`));
    } else if (l.withheld.products === 0) {
      note = 'shown only: no withheld window for this product this month';
    } else {
      note = 'withheld only: this product was never shown this month';
    }
    return {
      sku: l.sku,
      product: l.sku,
      families: [...l.families],
      shown: l.shown,
      withheld: l.withheld,
      // Shown arm only - the withheld arm was never told, so "acted on the
      // card" has no meaning there.
      action_inferred_on_shown: l.action,
      note,
      refusals,
    };
  }).sort((a, b) => (b.shown.products + b.withheld.products) - (a.shown.products + a.withheld.products)
    || a.sku.localeCompare(b.sku));

  const actionTotals = lines.reduce((acc, l) => {
    acc.acted += l.action_inferred_on_shown.acted;
    acc.not_acted += l.action_inferred_on_shown.not_acted;
    acc.unobservable += l.action_inferred_on_shown.unobservable;
    for (const [d, n] of Object.entries(l.action_inferred_on_shown.detectors)) {
      acc.detectors[d] = (acc.detectors[d] || 0) + n;
    }
    return acc;
  }, { acted: 0, not_acted: 0, unobservable: 0, detectors: {} });

  const refusals = [];
  const o = report.overall;
  if (o.shown.products + o.withheld.products === 0) {
    refusals.push(`no product-window's ${WINDOW_DAYS}-day window closed in this month`);
  }
  if (o.difference.refused_reason) refusals.push(`difference: ${o.difference.refused_reason}`);
  else if (o.difference.dollars_refused_reason) refusals.push(`money difference: ${o.difference.dollars_refused_reason}`);
  if (o.shown.products > 0 && o.shown.priced === 0) refusals.push('shown margin: cost unknown on every shown window');
  if (o.withheld.products > 0 && o.withheld.priced === 0) refusals.push('withheld margin: cost unknown on every withheld window');

  return {
    what_this_board_measures: 'Did telling the store change anything. Shown against withheld, per '
      + 'product; dollars are per product, never totals; the action is inferred from the purchases '
      + 'feed, an uploaded invoice, the stock delta or a price drop. This board states no hit rate.',
    window_days: WINDOW_DAYS,
    min_measured_per_arm_for_a_difference: report.min_per_arm,
    dollars_are_per_product: true,
    summary: {
      shown: o.shown,
      withheld: o.withheld,
      difference: o.difference,
      // What actually happened, labelled as such. Never the comparison.
      totals_for_the_record: {
        shown_dollars_total: o.shown.dollars,
        withheld_dollars_total: o.withheld.dollars,
        note: 'The arms are different sizes by design; the difference is taken per product above.',
      },
      action_inferred_on_shown: actionTotals,
      line: evalSvc.holdoutLine(report),
    },
    by_family: report.by_family,
    lines,
    refusals,
  };
}

// ─── Names, the frontier, and the board itself ──────────────────────────────

/** Store and product names from syncgo, best-effort. A failure names itself. */
async function lookupNames(syncgoBase, clientId, locationId, skus) {
  const out = { store: null, products: new Map(), refusal: null };
  try {
    const scoped = makeTenantScopedPool(syncgoBase, clientId, locationId);
    const loc = await scoped.query(
      `SELECT location_name FROM client_locations WHERE client_id = $1 AND location_id = $2`,
      [clientId, locationId]
    );
    if (loc.rows[0]?.location_name) out.store = String(loc.rows[0].location_name).trim();
    if (skus.length) {
      const prod = await scoped.query(
        `SELECT sku, product_name FROM products
          WHERE client_id = $1 AND location_id = $2 AND sku = ANY($3::text[])`,
        [clientId, locationId, skus]
      );
      for (const p of prod.rows) if (p.product_name) out.products.set(p.sku, String(p.product_name).trim());
    }
  } catch (err) {
    logger.warn(`[Scoreboard] name lookup failed for ${clientId}:${locationId}: ${err.message}`);
    out.refusal = `names: the store and product names could not be read from the warehouse (${err.message}); lines show the sku`;
  }
  return out;
}

/**
 * Build the two boards for one store for one month. Pure read; nothing is
 * written. `opts.syncgoPool` overrides the warehouse pool (tests); `false`
 * skips the name lookup and says so.
 *
 * @returns {{month, store, data_through, accuracy, holdout, refusals}}
 */
async function buildScoreboard(analyticsPool, clientId, locationId, month, opts = {}) {
  const monthStart = assertMonth(month);
  const has = await columnsPresent(analyticsPool);
  const refusals = [];

  const accuracy = await accuracyBoard(analyticsPool, clientId, locationId, monthStart, has);
  const holdout = await holdoutBoard(analyticsPool, clientId, locationId, month, has);

  // The frontier the month's evaluations had seen - from the evaluation rows
  // of the cards on the board, not from the clock.
  const { rows: [dt] } = await analyticsPool.query(
    `SELECT to_char(max(e.data_through), 'YYYY-MM-DD') AS data_through
       FROM recommendation_outcomes o
       JOIN recommendation_evaluations e
         ON e.rec_id = o.recommendation_id AND e.window_days = $3
      WHERE o.client_id = $1 AND o.location_id = $2
        AND (o.window_end - o.window_start) = $3
        AND o.window_end >= $4::date
        AND o.window_end < ($4::date + interval '1 month')`,
    [clientId, locationId, WINDOW_DAYS, monthStart]
  );
  const dataThrough = dt?.data_through || null;
  if (!dataThrough) refusals.push('data_through: no evaluation row behind any card this month');

  // Names, last and best-effort: a warehouse outage must not cost the board.
  let store = { client_id: clientId, location_id: locationId, name: null };
  if (opts.syncgoPool !== false) {
    const skus = [...new Set([...accuracy.lines, ...holdout.lines].map((l) => l.sku))];
    const names = await lookupNames(opts.syncgoPool || getPool(), clientId, locationId, skus);
    if (names.refusal) refusals.push(names.refusal);
    store = { ...store, name: names.store };
    for (const l of accuracy.lines) l.product = names.products.get(l.sku) || l.sku;
    for (const l of holdout.lines) l.product = names.products.get(l.sku) || l.sku;
  } else {
    refusals.push('names: lookup skipped; lines show the sku');
  }

  return {
    month,
    store,
    window_days: WINDOW_DAYS,
    month_rule: `a card belongs to the calendar month its ${WINDOW_DAYS}-day window ended in`,
    generated_at: new Date().toISOString(),
    data_through: dataThrough,
    accuracy,
    holdout,
    refusals,
  };
}

/** Upsert one store-month. Regenerating a month replaces it; nothing deletes. */
async function saveScoreboard(analyticsPool, board) {
  const monthStart = assertMonth(board.month);
  const { rows: [row] } = await analyticsPool.query(
    `INSERT INTO pilot_scoreboards
       (client_id, location_id, month, generated_at, data_through, accuracy, holdout)
     VALUES ($1, $2, $3::date, now(), $4::date, $5::jsonb, $6::jsonb)
     ON CONFLICT (client_id, location_id, month) DO UPDATE
       SET generated_at = now(),
           data_through = EXCLUDED.data_through,
           accuracy     = EXCLUDED.accuracy,
           holdout      = EXCLUDED.holdout
     RETURNING client_id, location_id, to_char(month, 'YYYY-MM') AS month,
               generated_at, to_char(data_through, 'YYYY-MM-DD') AS data_through`,
    [board.store.client_id, board.store.location_id, monthStart, board.data_through,
      JSON.stringify(board.accuracy), JSON.stringify(board.holdout)]
  );
  return row;
}

/** The stored row for one store-month, or null. */
async function getScoreboard(analyticsPool, clientId, locationId, month) {
  const monthStart = assertMonth(month);
  const { rows } = await analyticsPool.query(
    `SELECT client_id, location_id, to_char(month, 'YYYY-MM') AS month, generated_at,
            to_char(data_through, 'YYYY-MM-DD') AS data_through, accuracy, holdout
       FROM pilot_scoreboards
      WHERE client_id = $1 AND location_id = $2 AND month = $3::date`,
    [clientId, locationId, monthStart]
  );
  return rows[0] || null;
}

// ─── One line per store for the cron log ─────────────────────────────────────

function summaryLine(board) {
  const a = board.accuracy.summary;
  const ci = a.hit_rate_interval_95;
  const pct = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
  const hit = a.hit_rate == null
    ? `hit rate not measurable (${board.accuracy.refusals[0] || 'no measured card'})`
    : `hit rate ${pct(a.hit_rate)} [${pct(ci.low)}-${pct(ci.high)}] on ${a.measured_on} of ${a.cards} cards`;
  const d = board.holdout.summary.difference;
  const hold = d.refused_reason
    ? `holdout difference refused - ${d.refused_reason}`
    : `holdout difference ${d.lift > 0 ? '+' : ''}${d.lift} lift`
      + (d.dollars_per_product != null ? `, $${d.dollars_per_product} per product` : ` (${d.dollars_refused_reason})`);
  const name = board.store.name || `${board.store.client_id}:${board.store.location_id}`;
  return `${name} ${board.month}: ${hit}; ${hold}; ${board.accuracy.summary.products} products`;
}

// ─── The page ────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const pct = (v) => (v == null ? '<span class="na">n/a</span>' : `${Math.round(v * 100)}%`);
const num = (v, places = 2) => (v == null ? '<span class="na">n/a</span>' : esc(Number(v).toFixed(places)));
const money = (v) => (v == null ? '<span class="na">unpriced</span>' : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`);
const list = (items) => (items && items.length
  ? `<ul class="refusals">${items.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '');

/**
 * A self-contained page: the two boards as two SECTIONS, never one table,
 * the store summary line first in each, one row per product, refusals shown
 * in place. No scripts, no external assets - it has to open from a folder.
 */
function renderScoreboardHtml(board) {
  const a = board.accuracy;
  const h = board.holdout;
  const s = a.summary;
  const hs = h.summary;
  const name = board.store.name || `${board.store.client_id}:${board.store.location_id}`;
  const ci = s.hit_rate_interval_95;

  const accuracyRows = a.lines.map((l) => `
      <tr>
        <td class="name">${esc(l.product)}<div class="sku">${esc(l.sku)}</div></td>
        <td>${l.cards}</td>
        <td>${l.measured}</td>
        <td>${l.hits}</td>
        <td>${pct(l.hit_rate)}</td>
        <td>${num(l.mean_lift)}</td>
        <td>${pct(l.promise_fill.fill_ratio)}<div class="sub">${l.promise_fill.cards_with_quantity} asked, ${num(l.promise_fill.sold_units, 0)} of ${num(l.promise_fill.recommended_units, 0)} units</div></td>
        <td>${pct(l.interval_coverage.coverage)}<div class="sub">${l.interval_coverage.inside_range} of ${l.interval_coverage.cards_with_range} in range${l.interval_coverage.range_refused ? `, ${l.interval_coverage.range_refused} refused` : ''}</div></td>
        <td>${l.stockout_grade.cards === 0 ? '<span class="na">not a stockout card</span>'
    : `${l.stockout_grade.sold_through} / ${l.stockout_grade.not_sold_through} / ${l.stockout_grade.ungraded}`}</td>
        <td class="why">${list(l.refusals)}</td>
      </tr>`).join('');

  const holdoutRows = h.lines.map((l) => {
    const act = l.action_inferred_on_shown;
    const det = Object.entries(act.detectors).map(([d, n]) => `${esc(d)} ${n}`).join(', ');
    return `
      <tr>
        <td class="name">${esc(l.product)}<div class="sku">${esc(l.sku)} - ${esc(l.families.join(', '))}</div></td>
        <td>${l.shown.products}<div class="sub">${l.shown.measurable} measurable</div></td>
        <td>${num(l.shown.avg_lift)}</td>
        <td>${money(l.shown.dollars_per_product)}<div class="sub">${l.shown.priced} priced</div></td>
        <td>${l.withheld.products}<div class="sub">${l.withheld.measurable} measurable</div></td>
        <td>${num(l.withheld.avg_lift)}</td>
        <td>${money(l.withheld.dollars_per_product)}<div class="sub">${l.withheld.priced} priced</div></td>
        <td>${l.shown.products === 0 ? '<span class="na">never shown</span>'
      : `${act.acted} acted / ${act.not_acted} not / ${act.unobservable} unobservable`}<div class="sub">${det || ''}</div></td>
        <td class="why">${esc(l.note)}${list(l.refusals)}</td>
      </tr>`;
  }).join('');

  const familyRows = h.by_family.map((f) => `
      <tr>
        <td class="name">${esc(f.family)}</td>
        <td>${f.shown.products}<div class="sub">${f.shown.measurable} measurable</div></td>
        <td>${num(f.shown.avg_lift)}</td>
        <td>${money(f.shown.dollars_per_product)}</td>
        <td>${f.withheld.products}<div class="sub">${f.withheld.measurable} measurable</div></td>
        <td>${num(f.withheld.avg_lift)}</td>
        <td>${money(f.withheld.dollars_per_product)}</td>
        <td class="why">${f.difference.refused_reason ? esc(f.difference.refused_reason)
    : `${f.difference.lift > 0 ? '+' : ''}${f.difference.lift} lift` + (f.difference.dollars_per_product != null
      ? `, ${money(f.difference.dollars_per_product)} per product` : `; ${esc(f.difference.dollars_refused_reason)}`)}</td>
      </tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scoreboard ${esc(board.month)} - ${esc(name)}</title>
<style>
*{box-sizing:border-box}
:root{--bg:#fff;--panel:#f7f8fa;--fg:#0d1117;--mut:#5b6672;--line:#dfe3e8;--accent:#2563eb;--warn:#b45309}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0a0e17;--panel:#121823;--fg:#e8edf4;--mut:#93a1b1;--line:#233044;--accent:#60a5fa;--warn:#fbbf24}}
:root[data-theme="dark"]{--bg:#0a0e17;--panel:#121823;--fg:#e8edf4;--mut:#93a1b1;--line:#233044;--accent:#60a5fa;--warn:#fbbf24}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:40px 16px 80px}
h1{font-size:28px;margin:0 0 6px;letter-spacing:-.02em}
h2{font-size:21px;margin:56px 0 4px}
h3{font-size:15px;margin:24px 0 6px}
.lede{color:var(--mut);margin:0 0 20px;max-width:78ch}
.band{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px;padding:14px 18px;margin:16px 0;max-width:90ch}
.band.warn{border-left-color:var(--warn)}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:14px 0}
.k{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.k .v{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
.k .l{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.08em;margin-top:4px}
.k .d{font-size:12px;color:var(--mut);margin-top:6px}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px;margin:14px 0;background:var(--panel)}
table{width:100%;border-collapse:collapse;font-size:13.5px;font-variant-numeric:tabular-nums}
th,td{padding:8px 10px;text-align:right;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em}
th.name,td.name,th.why,td.why{text-align:left}
td.why{max-width:34ch;font-size:12.5px;color:var(--mut)}
.sku,.sub{font-size:11.5px;color:var(--mut);font-weight:400}
.na{color:var(--mut);font-style:italic}
ul.refusals{margin:4px 0 0;padding-left:16px}
.arm{border-left:2px solid var(--line)}
footer{color:var(--mut);font-size:12.5px;margin-top:48px}
</style></head><body><div class="wrap">
<h1>${esc(name)} - ${esc(board.month)}</h1>
<p class="lede">Pilot scoreboard. Two boards, kept apart. ${esc(board.month_rule)}. Data through <b>${esc(board.data_through || 'n/a')}</b>; generated ${esc(board.generated_at)}.</p>
${list(board.refusals)}

<h2 id="board-a">Board A - Prediction accuracy</h2>
<p class="lede">${esc(a.what_this_board_measures)} Both arms count: a withheld card is still a prediction. Hit rule: ${esc(a.hit_rule)}.</p>
<div class="band"><b>This board needs no owner action.</b> It grades the forecast on the forecast and never reads whether the store acted, voted, or what it earned.</div>
<h3>Store summary</h3>
<div class="summary">
  <div class="k"><div class="v">${pct(s.hit_rate)}</div><div class="l">hit rate</div><div class="d">${ci ? `95% interval ${pct(ci.low)} - ${pct(ci.high)}` : 'no interval: nothing measured'}; ${s.hits} of ${s.measured_on} measured</div></div>
  <div class="k"><div class="v">${s.cards}</div><div class="l">cards</div><div class="d">${s.products} products; measured on ${s.measured_on}</div></div>
  <div class="k"><div class="v">${num(s.mean_lift)}</div><div class="l">mean lift</div><div class="d">over the measured cards</div></div>
  <div class="k"><div class="v">${pct(s.promise_fill.fill_ratio)}</div><div class="l">promise fill</div><div class="d">${num(s.promise_fill.sold_units, 0)} sold of ${num(s.promise_fill.recommended_units, 0)} asked on ${s.promise_fill.cards_with_quantity} cards</div></div>
  <div class="k"><div class="v">${pct(s.interval_coverage.coverage)}</div><div class="l">interval coverage</div><div class="d">${s.interval_coverage.inside_range} of ${s.interval_coverage.cards_with_range} stated ranges held${s.interval_coverage.range_refused ? `; ${s.interval_coverage.range_refused} refused` : ''}</div></div>
  <div class="k"><div class="v">${s.stockout_grade.sold_through} / ${s.stockout_grade.not_sold_through} / ${s.stockout_grade.ungraded}</div><div class="l">stockout grade</div><div class="d">sold through / did not / ungraded, of ${s.stockout_grade.cards} stockout cards</div></div>
</div>
${a.refusals.length ? `<div class="band warn"><b>Not stated, and why</b>${list(a.refusals)}</div>` : ''}
<h3>One line per product</h3>
<div class="scroll"><table>
<thead><tr><th class="name">Product</th><th>Cards</th><th>Measured</th><th>Hits</th><th>Hit rate</th><th>Mean lift</th><th>Promise fill</th><th>Interval coverage</th><th>Stockout: sold through / not / ungraded</th><th class="why">Not stated</th></tr></thead>
<tbody>${accuracyRows || '<tr><td colspan="10" class="na">no card closed this month</td></tr>'}</tbody>
</table></div>

<h2 id="board-b">Board B - Holdout money</h2>
<p class="lede">${esc(h.what_this_board_measures)}</p>
<div class="band"><b>This board compares arms.</b> Shown against withheld, per product. A difference is stated only when both arms have at least ${h.min_measured_per_arm_for_a_difference} measured product-windows; below that it is refused with the reason, never zero.</div>
<h3>Store summary</h3>
<p>${esc(hs.line)}</p>
<div class="summary">
  <div class="k"><div class="v">${money(hs.shown.dollars_per_product)}</div><div class="l">shown, per product</div><div class="d">${hs.shown.products} product-windows, ${hs.shown.measurable} measurable, ${hs.shown.priced} priced; avg lift ${num(hs.shown.avg_lift)}</div></div>
  <div class="k"><div class="v">${money(hs.withheld.dollars_per_product)}</div><div class="l">withheld, per product</div><div class="d">${hs.withheld.products} product-windows, ${hs.withheld.measurable} measurable, ${hs.withheld.priced} priced; avg lift ${num(hs.withheld.avg_lift)}</div></div>
  <div class="k"><div class="v">${hs.difference.refused_reason ? '<span class="na">refused</span>' : `${hs.difference.lift > 0 ? '+' : ''}${hs.difference.lift}`}</div><div class="l">difference in lift</div><div class="d">${esc(hs.difference.refused_reason || (hs.difference.dollars_per_product != null ? `${money(hs.difference.dollars_per_product)} per product` : hs.difference.dollars_refused_reason))}</div></div>
  <div class="k"><div class="v">${hs.action_inferred_on_shown.acted} / ${hs.action_inferred_on_shown.not_acted} / ${hs.action_inferred_on_shown.unobservable}</div><div class="l">acted / not / unobservable</div><div class="d">shown arm; ${Object.entries(hs.action_inferred_on_shown.detectors).map(([d, n]) => `${esc(d)} ${n}`).join(', ') || 'no detector asserted an action'}</div></div>
</div>
<p class="sub">Totals, for the record only: shown ${money(hs.totals_for_the_record.shown_dollars_total)}, withheld ${money(hs.totals_for_the_record.withheld_dollars_total)}. ${esc(hs.totals_for_the_record.note)}</p>
${h.refusals.length ? `<div class="band warn"><b>Not stated, and why</b>${list(h.refusals)}</div>` : ''}
<h3>By family</h3>
<div class="scroll"><table>
<thead><tr><th class="name">Family</th><th class="arm">Shown windows</th><th>Shown lift</th><th>Shown $/product</th><th class="arm">Withheld windows</th><th>Withheld lift</th><th>Withheld $/product</th><th class="why">Difference</th></tr></thead>
<tbody>${familyRows || '<tr><td colspan="8" class="na">no product-window closed this month</td></tr>'}</tbody>
</table></div>
<h3>One line per product</h3>
<div class="scroll"><table>
<thead><tr><th class="name">Product</th><th class="arm">Shown windows</th><th>Shown lift</th><th>Shown $/product</th><th class="arm">Withheld windows</th><th>Withheld lift</th><th>Withheld $/product</th><th>Action inferred (shown)</th><th class="why">Note</th></tr></thead>
<tbody>${holdoutRows || '<tr><td colspan="9" class="na">no product-window closed this month</td></tr>'}</tbody>
</table></div>

<footer>Built by backend/services/pilotScoreboardService.js from recommendation_outcomes, recommendation_evaluations and recommendations. Every n/a carries its reason on the row or in the band above the table.</footer>
</div></body></html>
`;
}

module.exports = {
  WINDOW_DAYS,
  HIT_LIFT,
  wilsonInterval,
  previousMonth,
  buildScoreboard,
  saveScoreboard,
  getScoreboard,
  summaryLine,
  renderScoreboardHtml,
  assertingDetectors,
};
