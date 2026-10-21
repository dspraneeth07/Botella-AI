/**
 * The money audit - did any recommendation cost this store money?
 *
 * The owner's question, verbatim: "Confirm Tuscany, Bethany's and Grapes and
 * Grains that they are not losing any money for any recommendations." That is
 * a statement PER CARD, and it is a statement the data either supports, refutes
 * or cannot yet make. This service produces exactly one of those three answers
 * for every card the store was shown, and never rounds "cannot yet say" up to
 * "fine".
 *
 * WHAT A CARD'S MONEY IS, AT ISSUE AND AFTER
 *
 *   At issue the engine made two money claims about a card:
 *     expected_profit_usd   the gate's figure (recommendation_admission): units
 *                           it expected to sell x (price - cost); the card was
 *                           refused below REC_MIN_PROFIT_USD
 *     holding_cost_if_unsold the engine's own price for being WRONG - what it
 *                           costs to hold the whole order unsold: capital at
 *                           WACC + shelf rent + a one-off obsolescence hazard
 *                           (Botella_External_APIs/app/pipeline/policy/
 *                           holding.py). On the card since migration 028.
 *
 *   After the window the evaluator measured (recommendation_evaluations):
 *     units_sold, expected_units, lift
 *     margin_impact         the INCREMENTAL margin: (sold - expected) x
 *                           (price - cost), NULL when cost is unknown
 *   and the outcome row (recommendation_outcomes, migration 035) carries
 *     units_unsold          recommended units not sold inside the window
 *                           (recommended_qty - units_sold, floored at 0) - a
 *                           count against the order, NOT a shelf count.
 *
 *   The realised NET of a card is then
 *
 *       net = margin_impact - holding_cost_incurred
 *
 *   where holding_cost_incurred reuses the engine's own figure PROPORTIONALLY:
 *   holding_cost_if_unsold x units_unsold / suggested_order_qty. That is an
 *   approximation and the row says so (`holding_basis`): the engine priced the
 *   whole order held for its own horizon, and we are charging the unsold
 *   fraction of it for this window. It is the same ruler the offline ledger
 *   uses (scripts/daily_recommendation_ledger.py), so a net here and a net
 *   there are the same kind of number.
 *
 * WHEN A LOSS IS A LOSS
 *
 *   A card nobody acted on cannot lose the store money. So a negative net is a
 *   LOSS only where fulfilment_state (migration 039) is `confirmed` - the
 *   purchases feed or an invoice shows the owner bought on the card. A
 *   not_followed or expired card had no money at risk whatever its sales did;
 *   a pending, claimed or unobservable card with a negative net is reported as
 *   such - `exposure_unconfirmed` - because "we do not know whether you bought"
 *   is a different sentence from "you lost money" and from "you did not".
 *   The same rule applies to GAINS: a positive net on a card the owner is not
 *   known to have followed is not money the card made. Crediting unconfirmed
 *   gains while refusing unconfirmed losses would be the one-sided arithmetic
 *   this whole audit exists to prevent.
 *
 * NULLS ARE NEVER ZEROS
 *
 *   No cost means no margin, which means no net - `unmeasurable`, with the
 *   reason. units_unsold of 0 is a GENUINE zero (everything sold; holding cost
 *   0). units_unsold of NULL (not captured) with a positive margin leaves the
 *   net unknown. One bound is still honest and is stated: a negative incremental
 *   margin is a loss of AT LEAST that much whatever the holding cost, since
 *   holding cost is never negative; such a card is `lost_money` with
 *   `realised_net` null and `realised_net_at_most` carrying the bound.
 *
 * THE WINDOW
 *
 *   The 30-day window where it has closed (the evaluator's data_through has
 *   passed rec_date + 30), else the LONGEST closed window (7 in practice), else
 *   `window_open`. "Closed" is a statement about the sales frontier, not the
 *   wall clock - the evaluator's own rule (recommendationEvalService.js).
 *
 * THE STORE SUMMARY makes no claim the per-card rows do not support: the sum of
 * realised net over closed, confirmed cards; a per-card mean with a
 * DATE-CLUSTERED bootstrap interval when there are at least 10 such cards on at
 * least 2 decision dates (two cards issued on the same morning share a market;
 * resampling cards would report an interval far tighter than the evidence -
 * the ledger's clustered_mean_ci, in JavaScript), else "too few to bound"; the
 * largest single loss by card; the expected-profit floor in force; and the
 * holdout comparison (recommendationEvalService.holdoutReport), which is the
 * ONLY causal statement available - everything else here is bookkeeping on the
 * cards that were shown.
 *
 * READ-ONLY. Writes nothing. The on-demand script is scripts/money-audit.js;
 * the route is GET /api/recommendations/money-audit.
 */

const gate = require('./recommendationGateService');
const evalSvc = require('./recommendationEvalService');

const DEFAULT_SINCE_DAYS = 120;
const PREFERRED_WINDOW_DAYS = 30;
/** The gate's dollar floor as the default ships it, for the "below $1" count. */
const ONE_DOLLAR = 1;
/** At least this many closed confirmed cards, on at least 2 dates, before a CI. */
const CI_MIN_CARDS = 10;
const CI_MIN_DATES = 2;
const CI_DRAWS = 2000;

const VERDICTS = Object.freeze([
  'lost_money',               // closed window, confirmed, net < 0 (or bounded < 0)
  'made_money',               // closed window, confirmed, net > 0
  'broke_even',               // closed window, confirmed, net exactly 0
  'exposure_unconfirmed',     // closed window, net known, fulfilment not established
  'not_followed_no_exposure', // not_followed / expired: nothing was bought
  'window_open',              // no evaluation window has closed yet
  'unmeasurable',             // closed, but the net cannot be computed - reason says why
]);

/** Ordering for "losses first": the verdict rank, then the most negative net. */
const VERDICT_ORDER = new Map(VERDICTS.map((v, i) => [v, i]));

const NO_EXPOSURE_STATES = new Set(['not_followed', 'expired']);

// ─── Small helpers ───────────────────────────────────────────────────────────

const toNumber = (v) => (v === null || v === undefined || v === '' ? null
  : (Number.isFinite(Number(v)) ? Number(v) : null));
/** A cost of 0.00 is a cost nobody sent, never a free product (the gate's rule). */
const toPositiveNumber = (v) => { const n = toNumber(v); return n !== null && n > 0 ? n : null; };
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const round3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
const isoDate = (d) => (d == null ? null
  : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)));
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000)
  .toISOString().slice(0, 10);

/**
 * mulberry32 - a small seeded generator so the bootstrap interval printed in
 * an audit is the same interval the next run prints from the same rows. A
 * Math.random bootstrap would move the published figure by a few dollars on
 * every refresh, and a reader has no way to tell that from a change in the data.
 */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Date-clustered bootstrap of a mean. `byDate` is a list of lists: the nets of
 * the cards issued on each decision date. Resamples DATES with replacement and
 * takes the mean over every card in the drawn dates - the ledger's
 * clustered_mean_ci (scripts/real_engine_backtest.py), kept to the same
 * arithmetic so the two tools bound the same figure the same way.
 * Returns { low, high } or null with a reason when there is too little.
 */
function clusteredMeanCi(byDate, { draws = CI_DRAWS, seed = 20261019 } = {}) {
  const cards = byDate.reduce((n, d) => n + d.length, 0);
  if (cards < CI_MIN_CARDS) {
    return { interval: null, reason: `too few to bound: ${cards} closed confirmed card(s), need ${CI_MIN_CARDS}` };
  }
  if (byDate.length < CI_MIN_DATES) {
    return { interval: null, reason: `too few to bound: all ${cards} cards share one decision date, need ${CI_MIN_DATES}` };
  }
  const rnd = seededRandom(seed);
  const means = [];
  for (let i = 0; i < draws; i++) {
    let sum = 0;
    let n = 0;
    for (let j = 0; j < byDate.length; j++) {
      const drawn = byDate[Math.floor(rnd() * byDate.length)];
      for (const v of drawn) { sum += v; n += 1; }
    }
    means.push(n ? sum / n : 0);
  }
  means.sort((a, b) => a - b);
  return {
    interval: { low: round2(means[Math.floor(0.025 * draws)]), high: round2(means[Math.floor(0.975 * draws)]) },
    reason: null,
  };
}

// ─── Schema guard ────────────────────────────────────────────────────────────

const REQUIRED_COLUMNS = [
  ['recommendations', 'holding_cost_if_unsold', '028'],
  ['recommendations', 'fulfilment_state', '039'],
  ['recommendation_outcomes', 'units_unsold', '035'],
  ['recommendation_admission', 'expected_profit_usd', '019'],
  ['recommendation_evaluations', 'margin_impact', '003'],
  ['recommendation_sku_state', 'cost', '003'],
];

/**
 * Refuse, naming the migration, rather than degrade: an audit that silently
 * drops the holding cost or the fulfilment state would print a reassuring page
 * over a schema that cannot support it.
 */
async function assertSchema(pool) {
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name, column_name) IN (${REQUIRED_COLUMNS.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(', ')})`,
    REQUIRED_COLUMNS.flatMap(([t, c]) => [t, c])
  );
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const missing = REQUIRED_COLUMNS.filter(([t, c]) => !have.has(`${t}.${c}`));
  if (missing.length) {
    throw new Error('money audit refused: analytics schema is missing '
      + missing.map(([t, c, m]) => `${t}.${c} (migration ${m})`).join(', '));
  }
}

// ─── Loading ─────────────────────────────────────────────────────────────────

async function loadCards(pool, clientId, locationId, sinceDays) {
  // One row per card. Price and cost come from the rec-time snapshot
  // (recommendation_sku_state) for the FIRST primary SKU - the one the order
  // quantity and the holding cost were computed on - and sku_count says when a
  // card named more than one product, because then "unit price" is one of
  // several. The run's rec_date is the decision day the evaluator uses
  // (falling back the way its loader does).
  const { rows } = await pool.query(
    `SELECT r.id, r.rank, r.action_type, r.category, r.status, r.primary_skus,
            r.suggested_order_qty, r.engine_family, r.engine_daily_rate,
            r.engine_days_cover, r.engine_on_hand,
            r.holding_cost_if_unsold, r.holding_cost_basis,
            r.fulfilment_state, r.fulfilment_evidence->>'detector' AS fulfilment_detector,
            r.fulfilment_confirmed_at, r.action_claim, r.valid_through,
            -- ::text, because node-postgres hands a DATE back as a Date at LOCAL
            -- midnight, and toISOString() on that is the previous day anywhere
            -- east of UTC: a card issued on the 16th would close its windows a
            -- day early. A 'YYYY-MM-DD' string has no timezone to get wrong.
            COALESCE(ru.rec_date, ru.data_as_of, r.created_at::date)::text AS rec_date,
            a.rec_id IS NOT NULL AS admission_recorded,
            a.visible AS admission_visible, a.expected_profit_usd, a.profit_basis,
            a.reasons AS admission_reasons,
            s.sku_count, s.price AS unit_price, s.cost AS unit_cost
       FROM recommendations r
       JOIN recommendation_runs ru ON ru.id = r.run_id
       LEFT JOIN recommendation_admission a ON a.rec_id = r.id
       LEFT JOIN LATERAL (
            SELECT count(*)::int AS sku_count,
                   (array_agg(st.price ORDER BY (st.sku = r.primary_skus[1]) DESC, st.sku))[1] AS price,
                   (array_agg(st.cost  ORDER BY (st.sku = r.primary_skus[1]) DESC, st.sku))[1] AS cost
              FROM recommendation_sku_state st
             WHERE st.rec_id = r.id
       ) s ON true
      WHERE r.client_id = $1 AND r.location_id = $2
        AND COALESCE(ru.rec_date, ru.data_as_of, r.created_at::date)
            >= current_date - make_interval(days => $3::int)
      ORDER BY rec_date, r.rank, r.id`,
    [clientId, locationId, sinceDays]
  );
  return rows;
}

async function loadEvaluations(pool, clientId, locationId, recIds) {
  if (!recIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT rec_id, window_days, data_through::text AS data_through, units_sold, expected_units, lift,
            margin_impact, revenue_impact, verdict, action_taken
       FROM recommendation_evaluations
      WHERE client_id = $1 AND location_id = $2 AND rec_id = ANY($3::bigint[])`,
    [clientId, locationId, recIds]
  );
  const byRec = new Map();
  for (const e of rows) {
    if (!byRec.has(String(e.rec_id))) byRec.set(String(e.rec_id), new Map());
    byRec.get(String(e.rec_id)).set(Number(e.window_days), e);
  }
  return byRec;
}

async function loadOutcomes(pool, clientId, locationId, recIds) {
  if (!recIds.length) return new Map();
  // One row per card per window: a card naming two SKUs scores two outcome
  // rows, carrying the same card-level units_unsold, so the most recent one is
  // the card's figure.
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (recommendation_id, (window_end - window_start))
            recommendation_id, arm, (window_end - window_start) AS window_days,
            window_start::text AS window_start, window_end::text AS window_end,
            units_unsold, recommended_qty,
            actual_purchased_qty, purchased_qty_source, actual_units_sold,
            on_hand_at_window_end, sold_through
       FROM recommendation_outcomes
      WHERE client_id = $1 AND location_id = $2
        AND recommendation_id = ANY($3::bigint[])
      ORDER BY recommendation_id, (window_end - window_start), scored_at DESC NULLS LAST, id DESC`,
    [clientId, locationId, recIds]
  );
  const byRec = new Map();
  for (const o of rows) {
    if (!byRec.has(String(o.recommendation_id))) byRec.set(String(o.recommendation_id), new Map());
    byRec.get(String(o.recommendation_id)).set(Number(o.window_days), o);
  }
  return byRec;
}

// ─── Per-card arithmetic ─────────────────────────────────────────────────────

/**
 * Which window to read. 30 if it has closed; else the longest closed one; else
 * the 30-day row (partial, so far) with window_closed false. Closed means the
 * evaluator's sales frontier (data_through) has passed rec_date + window.
 */
function chooseWindow(recDate, evals) {
  const closed = (w) => {
    const e = evals.get(w);
    return Boolean(e && e.data_through && isoDate(e.data_through) >= addDays(recDate, w));
  };
  if (closed(PREFERRED_WINDOW_DAYS)) return { windowDays: PREFERRED_WINDOW_DAYS, closed: true };
  const others = [...evals.keys()].filter((w) => w !== PREFERRED_WINDOW_DAYS && closed(w))
    .sort((a, b) => b - a);
  if (others.length) return { windowDays: others[0], closed: true };
  // Nothing closed. Prefer the 30-day row for the partial figures, else the
  // shortest window that has any row, else no row at all.
  if (evals.has(PREFERRED_WINDOW_DAYS)) return { windowDays: PREFERRED_WINDOW_DAYS, closed: false };
  const any = [...evals.keys()].sort((a, b) => a - b);
  return { windowDays: any.length ? any[0] : PREFERRED_WINDOW_DAYS, closed: false };
}

/**
 * Holding cost actually incurred on this card over the window, from the
 * engine's own figure, proportionally. Returns { amount, basis, reason } where
 * exactly one of amount / reason is set. Zero is returned ONLY for a genuine
 * zero (nothing unsold).
 */
function holdingIncurred(card, unitsUnsold) {
  if (unitsUnsold === null) {
    return { amount: null, basis: null, reason: 'unsold units not captured for this window (no outcome row with units_unsold)' };
  }
  if (unitsUnsold === 0) {
    return { amount: 0, basis: 'nothing unsold: every recommended unit sold inside the window, so no holding cost accrued', reason: null };
  }
  const hc = toNumber(card.holding_cost_if_unsold);
  const qty = toPositiveNumber(card.suggested_order_qty);
  if (hc === null) {
    return { amount: null, basis: null,
      reason: `${unitsUnsold} unit(s) unsold but the engine issued no holding-cost figure for this card (holding_cost_if_unsold is null; cards before the 028 figures, or no unit cost)` };
  }
  if (qty === null) {
    return { amount: null, basis: null,
      reason: `${unitsUnsold} unit(s) unsold and a holding figure of $${hc.toFixed(2)}, but no suggested_order_qty to prorate it over` };
  }
  const share = Math.min(1, unitsUnsold / qty);
  return {
    amount: round2(hc * share),
    basis: `approximation: the engine's holding_cost_if_unsold ($${hc.toFixed(2)} for all ${qty} units held unsold - ${card.holding_cost_basis || 'basis not recorded'}) x ${unitsUnsold}/${qty} unsold`,
    reason: null,
  };
}

/** The per-card row, with its verdict and the reason for it. */
function auditCard(card, evals, outcomes) {
  const recDate = isoDate(card.rec_date);
  const { windowDays, closed } = chooseWindow(recDate, evals);
  const e = evals.get(windowDays) || null;
  const o = outcomes.get(windowDays) || null;

  const price = toNumber(card.unit_price);
  const cost = toPositiveNumber(card.unit_cost);
  const marginPerUnit = price !== null && cost !== null ? round2(price - cost) : null;
  const expectedProfit = toNumber(card.expected_profit_usd);
  const marginImpact = e ? toNumber(e.margin_impact) : null;
  const lift = e ? toNumber(e.lift) : null;
  const unitsUnsold = o ? toNumber(o.units_unsold) : null;
  const holding = closed ? holdingIncurred(card, unitsUnsold) : { amount: null, basis: null, reason: 'window open' };

  let realisedNet = null;
  let realisedNetAtMost = null;
  let netBasis = null;
  if (closed && marginImpact !== null) {
    if (holding.amount !== null) {
      realisedNet = round2(marginImpact - holding.amount);
      netBasis = `incremental margin $${marginImpact.toFixed(2)} - holding $${holding.amount.toFixed(2)}`;
    } else if (marginImpact < 0) {
      // Holding cost is never negative, so the loss is at least the margin.
      realisedNetAtMost = round2(marginImpact);
      netBasis = `holding cost unknown (${holding.reason}); the loss is AT LEAST the incremental margin, $${Math.abs(marginImpact).toFixed(2)}`;
    } else {
      netBasis = `incremental margin $${marginImpact.toFixed(2)} known, holding cost unknown (${holding.reason}) - net not stated`;
    }
  }

  // ── The verdict ──────────────────────────────────────────────────────────
  const fulfilment = card.fulfilment_state || 'pending';
  // What the increment IS, in units, so a reader can see that a negative
  // margin means the product sold below its own baseline after a confirmed
  // restock - not that the stock was thrown away.
  const soldLine = e
    ? `sold ${toNumber(e.units_sold) ?? '?'} vs ${toNumber(e.expected_units) != null ? Number(e.expected_units).toFixed(1) : '?'} expected over ${windowDays}d`
      + (marginPerUnit !== null ? ` at $${marginPerUnit.toFixed(2)}/unit margin` : '')
      // A product with no sales in the baseline has no "expected"; the
      // evaluator then counts every unit sold as increment (pure upside), so
      // the margin here is the whole sale, not a lift over a baseline.
      + (toNumber(e.expected_units) === 0 ? ' (no sales baseline: every unit sold counts as increment)' : '')
    : 'no evaluation row';
  let verdict;
  let reason;
  if (NO_EXPOSURE_STATES.has(fulfilment)) {
    verdict = 'not_followed_no_exposure';
    reason = `fulfilment ${fulfilment}: nothing was bought on this card, so no money was at risk`
      + (marginImpact !== null ? ` (the product's sales moved ${marginImpact >= 0 ? '+' : '-'}$${Math.abs(marginImpact).toFixed(2)} against baseline anyway, which is not the card's doing)` : '');
  } else if (!closed) {
    verdict = 'window_open';
    const firstClose = addDays(recDate, Math.min(...(evals.size ? [...evals.keys()] : [7])));
    reason = e
      ? `no evaluation window has closed (sales through ${isoDate(e.data_through) || 'unknown'}; the ${Math.min(...[...evals.keys()])}-day window closes at ${firstClose})`
      : `not yet evaluated (issued ${recDate}; the first window closes at ${firstClose})`;
  } else if (marginImpact === null) {
    verdict = 'unmeasurable';
    if (lift === null) {
      const expected = e ? toNumber(e.expected_units) : null;
      reason = e && e.verdict === 'insufficient_data'
        ? `no lift: the evaluator found insufficient data (no sales baseline for this product)`
        : expected === 0
          ? `no sales baseline: the product sold nothing in the baseline period (expected 0 over ${windowDays}d, sold ${toNumber(e.units_sold) ?? '?'}), so the evaluator refuses both a lift and a dollar figure`
          : `no lift and no margin on the ${windowDays}-day evaluation`;
    } else if (cost === null) {
      reason = `lift ${lift} measured, but unit cost is unknown at issue, so the margin on the increment cannot be priced`;
    } else {
      reason = `lift ${lift} measured, but the evaluator recorded no margin_impact for the ${windowDays}-day window`;
    }
    if (e && e.verdict && !/insufficient data/.test(reason)) reason += ` (evaluator verdict '${e.verdict}')`;
  } else if (realisedNet === null && realisedNetAtMost === null) {
    verdict = 'unmeasurable';
    reason = netBasis;
  } else if (fulfilment !== 'confirmed') {
    verdict = 'exposure_unconfirmed';
    const net = realisedNet !== null ? realisedNet : realisedNetAtMost;
    reason = `fulfilment ${fulfilment}: the product's sales ${net < 0 ? 'lost' : 'made'} $${Math.abs(net).toFixed(2)} against baseline, `
      + 'but whether the owner bought on this card is not established, so neither a gain nor a loss is attributed';
  } else if (realisedNet === null) {
    verdict = 'lost_money';
    reason = `confirmed bought (${card.fulfilment_detector || 'detector not recorded'}); ${soldLine}; ${netBasis}`;
  } else if (realisedNet < 0) {
    verdict = 'lost_money';
    reason = `confirmed bought (${card.fulfilment_detector || 'detector not recorded'}); ${soldLine}; ${netBasis} = -$${Math.abs(realisedNet).toFixed(2)}`
      + (unitsUnsold ? `; ${unitsUnsold} of ${toNumber(card.suggested_order_qty) ?? '?'} recommended units unsold at window end` : '');
  } else if (realisedNet > 0) {
    verdict = 'made_money';
    reason = `confirmed bought (${card.fulfilment_detector || 'detector not recorded'}); ${soldLine}; ${netBasis} = +$${realisedNet.toFixed(2)}`;
  } else {
    verdict = 'broke_even';
    reason = `confirmed bought; ${netBasis} = $0.00`;
  }

  return {
    rec_id: Number(card.id),
    rank: card.rank,
    rec_date: recDate,
    sku: (card.primary_skus || [])[0] || null,
    skus: card.primary_skus || [],
    sku_count: card.sku_count || 0,
    action_type: card.action_type,
    engine_family: card.engine_family || null,
    fulfilment_state: fulfilment,
    fulfilment_detector: card.fulfilment_detector || null,
    action_claim: card.action_claim || null,
    at_issue: {
      admission_recorded: Boolean(card.admission_recorded),
      expected_profit_usd: expectedProfit,
      profit_basis: card.profit_basis || null,
      below_one_dollar: expectedProfit !== null && expectedProfit < ONE_DOLLAR,
      suggested_order_qty: toNumber(card.suggested_order_qty),
      unit_price: price,
      unit_cost: cost,
      cost_note: card.unit_cost != null && cost === null ? 'cost recorded as 0.00: treated as unknown, not free' : null,
      margin_per_unit: marginPerUnit,
      holding_cost_if_unsold: toNumber(card.holding_cost_if_unsold),
      holding_cost_basis: card.holding_cost_basis || null,
    },
    after_window: {
      window_days: windowDays,
      window_closed: closed,
      data_through: e ? isoDate(e.data_through) : null,
      evaluator_verdict: e ? e.verdict : null,
      units_sold: e ? toNumber(e.units_sold) : null,
      expected_units: e ? round3(toNumber(e.expected_units)) : null,
      lift: round3(lift),
      incremental_margin: marginImpact,
      units_unsold: unitsUnsold,
      purchased_qty: o ? toNumber(o.actual_purchased_qty) : null,
      purchased_qty_source: o ? o.purchased_qty_source : null,
      holding_cost_incurred: holding.amount,
      holding_basis: holding.basis || holding.reason,
      realised_net: realisedNet,
      realised_net_at_most: realisedNetAtMost,
      net_basis: netBasis,
    },
    verdict,
    reason,
  };
}

/**
 * ONE PRODUCT-WINDOW COUNTS ONCE. Two cards naming the same SKU on the same
 * day read the same sales, so they carry the same increment, the same unsold
 * count and the same net - two opinions about a single fact. The per-card
 * table keeps every card (the owner saw every card), but the money summary
 * sums each product-window once, as the holdout report does (DISTINCT ON
 * sku, window in recommendationEvalService.holdoutPerProductCte). Measured on
 * Bethany, 19 October 2026: 226 of 269 shown cards were repeats - one product
 * was issued as 14 cards on 29 September, each reading +$281.30 - and a naive
 * sum reported $3,975 where the distinct figure is a tenth of that.
 *
 * Marks every later card in a group with `duplicate_of` (the lowest rec_id in
 * the group); the first card is the group's representative and carries null.
 */
function markDuplicates(rows) {
  const firstByKey = new Map();
  for (const r of [...rows].sort((a, b) => a.rec_id - b.rec_id)) {
    // The FULL set of SKUs, not the first: the evaluator sums a card's
    // increment over every SKU it names, so two cards sharing a first SKU but
    // naming different sets read different sales (Bethany cards 31 and 34,
    // 24 August 2026: 45 sold against 162) and are not one fact.
    const key = `${[...(r.skus || [r.sku])].sort().join(',')}|${r.rec_date}|${r.after_window.window_days}`;
    if (firstByKey.has(key)) r.duplicate_of = firstByKey.get(key);
    else { firstByKey.set(key, r.rec_id); r.duplicate_of = null; }
  }
  return rows;
}

/** Losses first, most negative first; then the rest in verdict order, newest first. */
function sortLossesFirst(rows) {
  const netOf = (r) => (r.after_window.realised_net ?? r.after_window.realised_net_at_most ?? 0);
  return [...rows].sort((a, b) => {
    const va = VERDICT_ORDER.get(a.verdict);
    const vb = VERDICT_ORDER.get(b.verdict);
    if (va !== vb) return va - vb;
    if (a.verdict === 'lost_money' || a.verdict === 'exposure_unconfirmed' || a.verdict === 'made_money') {
      const d = netOf(a) - netOf(b);
      if (d !== 0) return d;
    }
    return a.rec_date < b.rec_date ? 1 : a.rec_date > b.rec_date ? -1 : a.rec_id - b.rec_id;
  });
}

// ─── The store summary ───────────────────────────────────────────────────────

function summarise(shown, withheld, { floor, floorEnv, holdout, sinceDays }) {
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const r of shown) counts[r.verdict] += 1;
  // The same counts over distinct product-windows, so "6 cards lost money"
  // can be read next to "5 products lost money".
  const countsDistinct = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const r of shown) if (r.duplicate_of == null) countsDistinct[r.verdict] += 1;

  const closed = shown.filter((r) => r.after_window.window_closed);
  const confirmed = shown.filter((r) => r.fulfilment_state === 'confirmed');
  // Money is summed over DISTINCT product-windows (markDuplicates): a repeat
  // card is listed and given its verdict, but its dollars are the same dollars.
  const distinct = shown.filter((r) => r.duplicate_of == null);
  const duplicates = shown.length - distinct.length;
  const settled = distinct.filter((r) => ['made_money', 'lost_money', 'broke_even'].includes(r.verdict));
  const settledCards = shown.filter((r) => ['made_money', 'lost_money', 'broke_even'].includes(r.verdict)).length;
  const withNet = settled.filter((r) => r.after_window.realised_net !== null);
  const boundedOnly = settled.filter((r) => r.after_window.realised_net === null);

  const byDate = new Map();
  for (const r of withNet) {
    if (!byDate.has(r.rec_date)) byDate.set(r.rec_date, []);
    byDate.get(r.rec_date).push(r.after_window.realised_net);
  }
  const netSum = withNet.length ? round2(withNet.reduce((s, r) => s + r.after_window.realised_net, 0)) : null;
  const ci = withNet.length ? clusteredMeanCi([...byDate.values()])
    : { interval: null, reason: 'no closed confirmed card carries a full net yet' };

  // The largest loss is named by its first card; a repeat reads the same figures.
  const losses = distinct.filter((r) => r.verdict === 'lost_money');
  const lossAmount = (r) => r.after_window.realised_net ?? r.after_window.realised_net_at_most;
  const largest = losses.length
    ? losses.reduce((m, r) => (lossAmount(r) < lossAmount(m) ? r : m))
    : null;

  // The unattributed money: what the closed cards' products did regardless of
  // whether the owner acted. On the record because it happened; NOT a result.
  const closedNets = closed.filter((r) => r.duplicate_of == null)
    .map((r) => r.after_window.realised_net).filter((v) => v !== null);

  const belowOneDollar = shown.filter((r) => r.at_issue.below_one_dollar);
  const noAdmission = shown.filter((r) => !r.at_issue.admission_recorded);
  const noProfitFigure = shown.filter((r) => r.at_issue.admission_recorded && r.at_issue.expected_profit_usd === null);

  return {
    since_days: sinceDays,
    cards_shown: shown.length,
    cards_withheld: withheld.length,
    distinct_product_windows: distinct.length,
    duplicate_cards: duplicates,
    confirmed: confirmed.length,
    closed: closed.length,
    verdicts: counts,
    verdicts_distinct: countsDistinct,
    windows_used: closed.reduce((acc, r) => {
      const k = `${r.after_window.window_days}d`;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    realised_net: {
      cards: withNet.length,
      settled_cards_including_repeats: settledCards,
      sum: netSum,
      mean: withNet.length ? round2(netSum / withNet.length) : null,
      ci95: ci.interval,
      ci_reason: ci.reason,
      decision_dates: byDate.size,
      bounded_only_losses: boundedOnly.length,
      bounded_only_losses_at_least: boundedOnly.length
        ? round2(boundedOnly.reduce((s, r) => s + Math.abs(r.after_window.realised_net_at_most), 0)) : null,
      statement: withNet.length
        ? `${withNet.length} closed, confirmed product-window(s) carry a full net`
          + (settledCards > settled.length ? ` (${settledCards} cards; a product issued more than once on one day is counted once)` : '')
          + `: ${netSum < 0 ? '-' : '+'}$${Math.abs(netSum).toFixed(2)} in total, `
          + `${round2(netSum / withNet.length) < 0 ? '-' : '+'}$${Math.abs(round2(netSum / withNet.length)).toFixed(2)} per card`
          + (ci.interval ? ` (95% date-clustered bootstrap $${ci.interval.low.toFixed(2)} to $${ci.interval.high.toFixed(2)})` : ` (${ci.reason})`)
          + (boundedOnly.length ? `; ${boundedOnly.length} further confirmed loss(es) are bounded only, at least $${round2(boundedOnly.reduce((s, r) => s + Math.abs(r.after_window.realised_net_at_most), 0)).toFixed(2)} between them` : '')
        : `no closed, confirmed card carries a full net yet (${ci.reason})`,
    },
    largest_loss: largest ? {
      rec_id: largest.rec_id,
      sku: largest.sku,
      rec_date: largest.rec_date,
      amount: lossAmount(largest),
      bounded: largest.after_window.realised_net === null,
      why: largest.reason,
    } : { rec_id: null, sku: null, amount: null, why: losses.length ? 'n/a' : 'no confirmed card with a closed window has a negative net' },
    unattributed_closed_net: {
      cards: closedNets.length,
      sum: closedNets.length ? round2(closedNets.reduce((s, v) => s + v, 0)) : null,
      note: 'every closed card with a computable net, whatever its fulfilment state - what the products did, not what the cards earned',
    },
    profit_floor: {
      rec_min_profit_usd_in_force: floor,
      env_value: floorEnv === undefined ? null : floorEnv,
      note: floorEnv === undefined ? 'REC_MIN_PROFIT_USD unset: the module default applies'
        : (Number(floorEnv) === 0 ? 'REC_MIN_PROFIT_USD=0 in this environment: the dollar floor is switched off, so cards below $1 expected profit were shown' : null),
      issued_below_one_dollar: belowOneDollar.length,
      issued_without_admission_row: noAdmission.length,
      issued_without_profit_figure: noProfitFigure.length,
    },
    holdout,
    holdout_line: holdout ? evalSvc.holdoutLine(holdout) : null,
  };
}

/**
 * Plain-English answer to "are they losing money on any recommendation?",
 * built only from the figures above, with what cannot be stated said.
 */
function answer(summary, store) {
  const s = summary;
  const v = s.verdicts;
  const who = store.name || `store ${store.location_id}`;
  if (!s.cards_shown) {
    return [`${who} has been shown no recommendation in the last ${s.since_days} days, so there is no recommendation it could be losing money on - and none it could be making money on.`];
  }
  const lines = [];
  lines.push(`${who}: ${s.cards_shown} card(s) shown in the last ${s.since_days} days (${s.cards_withheld} withheld as the control)`
    + (s.duplicate_cards ? `, ${s.distinct_product_windows} distinct product-windows - ${s.duplicate_cards} cards repeat another card for the same product on the same day` : '')
    + `; ${s.confirmed} confirmed bought; ${s.closed} have a closed evaluation window.`);
  const vd = s.verdicts_distinct || v;
  const withDistinct = (n, key) => (vd[key] !== n ? `${n} card(s) (${vd[key]} distinct product-window(s))` : `${n} card(s)`);
  if (v.lost_money) {
    const ll = s.largest_loss;
    lines.push(`MEASURED LOSS on ${withDistinct(v.lost_money, 'lost_money')}: the owner bought on them and the net came out negative. `
      + `Largest: card ${ll.rec_id} (${ll.sku}, ${ll.rec_date}) at ${ll.bounded ? 'at least ' : ''}-$${Math.abs(ll.amount).toFixed(2)} - ${ll.why}`);
  } else if (s.closed && s.confirmed) {
    lines.push('No measured loss: no card the owner is confirmed to have bought on has a closed window with a negative net.');
  }
  if (v.made_money) lines.push(`${withDistinct(v.made_money, 'made_money')} made money after their window, confirmed bought. ${s.realised_net.statement}.`);
  else if (s.realised_net.cards === 0) lines.push(`Nothing can be stated about money made: ${s.realised_net.statement}.`);
  const cannot = [];
  if (v.window_open) cannot.push(`${v.window_open} card(s) have no closed window yet`);
  if (v.exposure_unconfirmed) cannot.push(`${v.exposure_unconfirmed} closed card(s) have a net but no confirmed purchase, so it is not attributed either way`);
  if (v.unmeasurable) cannot.push(`${v.unmeasurable} closed card(s) cannot be priced (see each row's reason)`);
  if (v.not_followed_no_exposure) cannot.push(`${v.not_followed_no_exposure} card(s) were not followed, so no money was at risk on them`);
  if (cannot.length) lines.push(`Cannot be stated yet: ${cannot.join('; ')}.`);
  if (s.profit_floor.issued_below_one_dollar) {
    lines.push(`${s.profit_floor.issued_below_one_dollar} card(s) were issued with under $1 of expected profit (floor in force: $${s.profit_floor.rec_min_profit_usd_in_force}).`);
  }
  if (s.profit_floor.issued_without_admission_row) {
    lines.push(`${s.profit_floor.issued_without_admission_row} card(s) have no admission record, so their expected profit at issue is unknown.`);
  }
  lines.push(`Causal statement (holdout): ${s.holdout_line || 'not available'}.`);
  return lines;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * @param {import('pg').Pool} analyticsPool
 * @param {number} clientId
 * @param {number} locationId
 * @param {object} [opts]
 * @param {number} [opts.sinceDays=120]   how far back "issued" reaches
 * @param {string} [opts.storeName]       for the page title; null when unknown
 * @returns {Promise<object>} { store, generated_at, summary, answer, cards, withheld, definitions }
 */
async function moneyAudit(analyticsPool, clientId, locationId, { sinceDays = DEFAULT_SINCE_DAYS, storeName = null } = {}) {
  const since = Math.max(1, Math.min(365, parseInt(sinceDays, 10) || DEFAULT_SINCE_DAYS));
  await assertSchema(analyticsPool);

  const cards = await loadCards(analyticsPool, clientId, locationId, since);
  const ids = cards.map((c) => c.id);
  const [evals, outcomes] = await Promise.all([
    loadEvaluations(analyticsPool, clientId, locationId, ids),
    loadOutcomes(analyticsPool, clientId, locationId, ids),
  ]);

  const shown = [];
  const withheld = [];
  for (const card of cards) {
    const row = auditCard(card, evals.get(String(card.id)) || new Map(), outcomes.get(String(card.id)) || new Map());
    if (card.status === 'holdout') {
      // The control. Its money is the ledger's, not the owner's: nobody saw
      // the card, so no verdict - the figures ride along for the comparison.
      withheld.push({ ...row, verdict: 'withheld', reason: 'holdout arm: the card was never shown, so there is nothing to make or lose on it; it is the control the holdout comparison reads' });
    } else {
      shown.push(row);
    }
  }

  markDuplicates(shown);
  markDuplicates(withheld);

  const holdout = await evalSvc.holdoutReport(analyticsPool, {
    clientId, locationId, windowDays: PREFERRED_WINDOW_DAYS, days: since,
  });

  const floorEnv = process.env.REC_MIN_PROFIT_USD;
  const summary = summarise(shown, withheld, {
    floor: gate.MIN_EXPECTED_PROFIT_USD, floorEnv, holdout, sinceDays: since,
  });
  const store = { client_id: clientId, location_id: locationId, name: storeName };

  return {
    store,
    generated_at: new Date().toISOString(),
    summary,
    answer: answer(summary, store),
    cards: sortLossesFirst(shown),
    withheld: sortLossesFirst(withheld),
    definitions: {
      realised_net: 'incremental margin (recommendation_evaluations.margin_impact: (sold - expected) x (price - cost)) minus the holding cost incurred',
      holding_cost_incurred: 'the engine\'s holding_cost_if_unsold x units_unsold / suggested_order_qty - an approximation, stated on each row',
      units_unsold: 'recommended units not sold inside the window (recommended_qty - units_sold, floored at 0); a count against the order, not a shelf count',
      window: `the ${PREFERRED_WINDOW_DAYS}-day window where closed, else the longest closed window; closed means the evaluator's data_through has passed rec_date + window`,
      lost_money: 'closed window, fulfilment confirmed, net < 0 (or incremental margin < 0 with holding cost unknown: a loss of at least that much)',
      made_money: 'closed window, fulfilment confirmed, net > 0',
      exposure_unconfirmed: 'closed window with a net, but fulfilment pending / claimed / unobservable: not attributed as gain or loss',
      not_followed_no_exposure: 'fulfilment not_followed or expired: nothing was bought, so no money was at risk',
      unmeasurable: 'closed window but no net can be computed: the reason names the missing input (cost, lift, unsold capture, holding figure)',
      ci95: `date-clustered bootstrap over decision dates, ${CI_DRAWS} draws, seeded; needs ${CI_MIN_CARDS} cards on ${CI_MIN_DATES} dates`,
      duplicate_of: 'a later card for the same SKU on the same day reading the same window: listed with its own verdict, but its dollars are counted once, under the first card',
      lost_money_meaning: 'a confirmed restock after which the product sold BELOW its own baseline (negative incremental margin), plus the holding cost of the units left - deferred revenue on spirits, not destroyed stock; the engine\'s holding model prices that',
    },
  };
}

// ─── HTML ────────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (v, { bound = false } = {}) => (v == null ? '<span class="mut">n/a</span>'
  : `<span class="${v < 0 ? 'bad' : v > 0 ? 'good' : ''}">${bound ? '&le; ' : ''}${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}</span>`);
const num = (v, d = 0) => (v == null ? '<span class="mut">n/a</span>' : Number(v).toFixed(d));

function cardRow(r) {
  const a = r.at_issue;
  const w = r.after_window;
  const net = w.realised_net != null ? money(w.realised_net)
    : w.realised_net_at_most != null ? money(w.realised_net_at_most, { bound: true })
      : '<span class="mut">n/a</span>';
  return `<tr class="v-${r.verdict}">
<td><span class="verdict">${esc(r.verdict)}</span></td>
<td>${r.rec_id}${r.duplicate_of != null ? ` <span class="mut">repeat of ${r.duplicate_of}</span>` : ''}</td><td>${esc(r.rec_date)}</td>
<td>${esc(r.sku)}${r.sku_count > 1 ? ` <span class="mut">+${r.sku_count - 1}</span>` : ''}</td>
<td>${esc(r.engine_family || r.action_type)}</td>
<td>${esc(r.fulfilment_state)}${r.fulfilment_detector && r.fulfilment_detector !== 'none' ? ` <span class="mut">(${esc(r.fulfilment_detector)})</span>` : ''}</td>
<td class="r">${a.expected_profit_usd == null ? `<span class="mut">${a.admission_recorded ? 'none' : 'no row'}</span>` : money(a.expected_profit_usd)}</td>
<td class="r">${num(a.suggested_order_qty)}</td>
<td class="r">${num(a.unit_price, 2)}</td><td class="r">${num(a.unit_cost, 2)}</td><td class="r">${num(a.margin_per_unit, 2)}</td>
<td class="r">${a.holding_cost_if_unsold == null ? '<span class="mut">n/a</span>' : `$${a.holding_cost_if_unsold.toFixed(2)}`}</td>
<td class="r">${w.window_days}d ${w.window_closed ? 'closed' : '<span class="mut">open</span>'}</td>
<td class="r">${num(w.units_sold)}</td><td class="r">${num(w.expected_units, 1)}</td><td class="r">${num(w.lift, 2)}</td>
<td class="r">${money(w.incremental_margin)}</td>
<td class="r">${num(w.units_unsold)}</td>
<td class="r">${w.holding_cost_incurred == null ? '<span class="mut">n/a</span>' : `$${w.holding_cost_incurred.toFixed(2)}`}</td>
<td class="r">${net}</td>
<td class="why">${esc(r.reason)}</td></tr>`;
}

function renderMoneyAuditHtml(audit) {
  const s = audit.summary;
  const st = audit.store;
  const title = `Money audit - ${st.name || `store ${st.location_id}`}`;
  const kv = (k, v, note = '') => `<tr><th>${esc(k)}</th><td>${v}${note ? ` <span class="mut">${esc(note)}</span>` : ''}</td></tr>`;
  const ll = s.largest_loss;
  const rn = s.realised_net;
  const pf = s.profit_floor;
  const hd = s.holdout && s.holdout.overall ? s.holdout.overall : null;
  const summaryRows = [
    kv('Cards shown', `${s.cards_shown}`, `last ${s.since_days} days; ${s.cards_withheld} withheld as the control; ${s.distinct_product_windows} distinct product-windows (${s.duplicate_cards} repeat cards, counted once in the money)`),
    kv('Confirmed bought', `${s.confirmed}`, 'fulfilment_state confirmed: purchases feed or invoice'),
    kv('Closed windows', `${s.closed}`, Object.entries(s.windows_used).map(([k, n]) => `${n} x ${k}`).join(', ')),
    kv('Lost money', `<span class="${s.verdicts.lost_money ? 'bad' : ''}">${s.verdicts.lost_money}</span>`, 'confirmed, closed, net < 0'),
    kv('Made money', `<span class="${s.verdicts.made_money ? 'good' : ''}">${s.verdicts.made_money}</span>`, 'confirmed, closed, net > 0'),
    kv('Broke even', `${s.verdicts.broke_even}`),
    kv('Exposure unconfirmed', `${s.verdicts.exposure_unconfirmed}`, 'closed with a net, purchase not established'),
    kv('Not followed, no exposure', `${s.verdicts.not_followed_no_exposure}`),
    kv('Window open', `${s.verdicts.window_open}`),
    kv('Unmeasurable', `${s.verdicts.unmeasurable}`, 'each row names the missing input'),
    kv('Realised net, closed confirmed', rn.sum == null ? '<span class="mut">n/a</span>' : money(rn.sum), rn.statement),
    kv('Per card', rn.mean == null ? '<span class="mut">n/a</span>' : money(rn.mean),
      rn.ci95 ? `95% date-clustered bootstrap $${rn.ci95.low.toFixed(2)} to $${rn.ci95.high.toFixed(2)} over ${rn.decision_dates} decision dates` : rn.ci_reason),
    kv('Largest single loss', ll.amount == null ? '<span class="mut">none</span>'
      : `${money(ll.amount, { bound: ll.bounded })} - card ${ll.rec_id}, ${esc(ll.sku)}, ${esc(ll.rec_date)}`, ll.why),
    kv('Unattributed closed net', s.unattributed_closed_net.sum == null ? '<span class="mut">n/a</span>' : money(s.unattributed_closed_net.sum),
      `${s.unattributed_closed_net.cards} card(s); ${s.unattributed_closed_net.note}`),
    kv('Expected-profit floor in force', `$${pf.rec_min_profit_usd_in_force}`,
      `REC_MIN_PROFIT_USD=${pf.env_value == null ? '(unset)' : pf.env_value}${pf.note ? '; ' + pf.note : ''}`),
    kv('Issued below $1 expected profit', `${pf.issued_below_one_dollar}`,
      `${pf.issued_without_admission_row} without an admission row; ${pf.issued_without_profit_figure} with no computable figure`),
    kv('Holdout (the only causal statement)', esc(s.holdout_line || 'not available'),
      hd ? `shown ${hd.shown.products} product-windows, withheld ${hd.withheld.products}` : ''),
  ].join('\n');

  const cards = audit.cards.map(cardRow).join('\n');
  const withheld = audit.withheld.map(cardRow).join('\n');
  const head = `<tr><th>Verdict</th><th>Card</th><th>Issued</th><th>SKU</th><th>Family</th><th>Fulfilment</th>
<th class="r">Expected profit</th><th class="r">Order qty</th><th class="r">Price</th><th class="r">Cost</th><th class="r">Margin/unit</th><th class="r">Holding if unsold</th>
<th class="r">Window</th><th class="r">Sold</th><th class="r">Expected</th><th class="r">Lift</th><th class="r">Incr. margin</th><th class="r">Unsold</th><th class="r">Holding incurred</th><th class="r">Net</th><th>Why</th></tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
*{box-sizing:border-box}
:root{--bg:#fbfaf7;--fg:#1a1713;--mut:#6f675b;--line:#dfdad0;--good:#047857;--bad:#be123c;--badbg:#fff1f2;--goodbg:#ecfdf5;--panel:#f3f1ec}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1115;--fg:#e8e6e1;--mut:#9a948a;--line:#2a2e36;--good:#34d399;--bad:#fb7185;--badbg:#2d0d16;--goodbg:#052e23;--panel:#181b21}}
:root[data-theme="dark"]{--bg:#0f1115;--fg:#e8e6e1;--mut:#9a948a;--line:#2a2e36;--good:#34d399;--bad:#fb7185;--badbg:#2d0d16;--goodbg:#052e23;--panel:#181b21}
body{margin:0;padding:24px 16px 64px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
p{max-width:80ch}.mut{color:var(--mut)}.bad{color:var(--bad);font-weight:600}.good{color:var(--good);font-weight:600}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}td.r,th.r{text-align:right;white-space:nowrap}
.summary th{width:28ch;text-transform:none;letter-spacing:0;font-size:13px;color:var(--fg)}
.cards{font-size:12.5px}.cards td.why{min-width:36ch;max-width:60ch;color:var(--mut)}
tr.v-lost_money td{background:var(--badbg)}tr.v-made_money td{background:var(--goodbg)}
.verdict{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px}
.wrap{overflow-x:auto}.answer li{margin:4px 0}
</style></head><body>
<h1>${esc(title)}</h1>
<p class="mut">Client ${st.client_id}, location ${st.location_id}. Generated ${esc(audit.generated_at.slice(0, 19).replace('T', ' '))} UTC. Read-only; nothing here is a forecast.</p>

<h2>Are they losing money on any recommendation?</h2>
<ul class="answer">${audit.answer.map((l) => `<li>${esc(l)}</li>`).join('\n')}</ul>

<h2>Summary</h2>
<table class="summary"><tbody>${summaryRows}</tbody></table>

<h2>Every card shown, losses first</h2>
<p class="mut">${esc(audit.definitions.realised_net)}. ${esc(audit.definitions.holding_cost_incurred)}. ${esc(audit.definitions.window)}. ${esc(audit.definitions.units_unsold)}.</p>
<div class="wrap"><table class="cards"><thead>${head}</thead><tbody>
${cards || '<tr><td colspan="21" class="mut">no card shown in the period</td></tr>'}
</tbody></table></div>

<h2>Withheld cards (the control)</h2>
<p class="mut">Never shown to the owner, so nothing was made or lost on them; their figures are what the holdout comparison reads.</p>
<div class="wrap"><table class="cards"><thead>${head}</thead><tbody>
${withheld || '<tr><td colspan="21" class="mut">no withheld card in the period</td></tr>'}
</tbody></table></div>
</body></html>`;
}

/** One line for the console or a log. */
function summaryLine(audit) {
  const s = audit.summary;
  const v = s.verdicts;
  const rn = s.realised_net;
  const ll = s.largest_loss;
  return `${audit.store.name || audit.store.location_id} (${audit.store.client_id}:${audit.store.location_id}): `
    + `${s.cards_shown} shown / ${s.cards_withheld} withheld; ${s.confirmed} confirmed; ${s.closed} closed; `
    + `made ${v.made_money}, lost ${v.lost_money}, even ${v.broke_even}, unconfirmed ${v.exposure_unconfirmed}, `
    + `no-exposure ${v.not_followed_no_exposure}, open ${v.window_open}, unmeasurable ${v.unmeasurable}; `
    + `net ${rn.sum == null ? 'n/a' : `${rn.sum < 0 ? '-' : '+'}$${Math.abs(rn.sum).toFixed(2)} over ${rn.cards}`}; `
    + `largest loss ${ll.amount == null ? 'none' : `${ll.bounded ? '>=' : ''}-$${Math.abs(ll.amount).toFixed(2)} (card ${ll.rec_id}, ${ll.sku})`}`;
}

module.exports = {
  moneyAudit,
  renderMoneyAuditHtml,
  summaryLine,
  VERDICTS,
  DEFAULT_SINCE_DAYS,
  _internals: { auditCard, chooseWindow, holdingIncurred, clusteredMeanCi, sortLossesFirst, markDuplicates, summarise, answer },
};
