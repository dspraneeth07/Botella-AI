/**
 * Recommendation Evaluation Service - did each recommendation work?
 *
 * For every persisted recommendation this service measures, over configurable
 * windows (REC_EVAL_WINDOWS, default 7/30/60/90 days):
 *
 *   1. OUTCOME - did the recommended products move? Units sold in the window
 *      vs. the SKU's own trailing 28-day rate (calendar-day basis, windows
 *      anchored to MAX(sale_date) - the house conventions). lift 1.0x = the
 *      rec changed nothing; the score squashes lift/(lift+1) so 1.0x = 0.5,
 *      exactly mirroring the Python feedback loop's math.
 *
 *   2. ACTION - did the store do what was recommended, even if nobody read the
 *      card? Detection is per action_type and only claims what the data can
 *      actually show:
 *        reorder / pre_stock : purchase-order rows for the SKU in the window
 *                              (when the tenant's `purchases` table has data),
 *                              else an UPLOADED INVOICE whose matched line
 *                              names the SKU and whose receipt (else invoice)
 *                              date falls inside the window (analytics
 *                              purchase_orders / purchase_order_items, 008),
 *                              else net stock inflow inferred from the
 *                              generation-time snapshot: (stock_now − stock_then)
 *                              + units_sold ≥ threshold. In that order of
 *                              trust - see detectAction for why.
 *        markdown / liquidate: price or sale_price dropped vs. the snapshot.
 *        stock_new           : the product's UPC (recommendations.reference_upc)
 *                              appeared in this store's catalog afterwards
 *                              (product_first_seen registry - authoritative).
 *        endcap / cold_box / promote / bundle: physically unobservable →
 *                              action_taken stays NULL, success is outcome-only.
 *      A detector reports FALSE only when it had full visibility (snapshot or
 *      authoritative source) and saw nothing; anything less is NULL (unknown),
 *      never a guess.
 *
 *   3. VOTES - the store's thumbs (one per rec by design) folded in with
 *      deliberate shrinkage so an accidental tap cannot flip a verdict:
 *      value is Laplace-smoothed ((ups+1)/(n+2): single up = 0.667, not 1.0)
 *      and its blend weight scales with vote count, VOTE_WEIGHT_MAX·n/(n+K)
 *      - one vote sways the final score by at most ~8%, and the verdict rules
 *      below never let votes alone create a winner or an underperformer.
 *
 *   4. QUANTITIES - on every outcome row (sheet 19, migration 035), because a
 *      sales figure alone cannot say whether the store over-bought,
 *      under-bought or bought at all:
 *        recommended_qty      : recommendations.suggested_order_qty - the
 *                               canonical order the card printed. NOT the
 *                               quantity hint's parsed high end, which on a
 *                               stockout card is the predictive band's top
 *                               ("between 5 and 30 units") and on a markdown
 *                               card is the on-shelf count. The hint is kept
 *                               as evidence; it falls back to the hint only
 *                               for a buy card with no column value.
 *        actual_purchased_qty : PO units inside the window when the purchases
 *                               feed has them, else the attributable stock
 *                               inflow, else NULL - never 0 for "no feed".
 *                               `purchased_qty_source` says which.
 *        on_hand_at_issue / on_hand_at_window_end / units_unsold: the shelf
 *                               count the decision was taken on, the latest
 *                               nightly count inside the window (sparse, so
 *                               dated by on_hand_observed_on), and what was
 *                               asked for minus what sold.
 *
 *   5. THE STOCKOUT GRADE - the one card stores will see first makes one
 *      checkable claim, "it runs out before the next delivery lands", and
 *      lift cannot grade it: two days of cover sells exactly what is on the
 *      shelf whatever the card says. So for a stockout card (engine_family,
 *      or for older rows the engine's own rule: reorder with cover below the
 *      14-day horizon) the 30-day window records whether cumulative sales
 *      reached the issue-time on-hand STRICTLY BEFORE the first OBSERVED
 *      inflow - a purchases-feed row, else a feature_daily on-hand rise net
 *      of sales, else the undated stock delta. The declared lead time is
 *      never used as a delivery date: grading a card against its own
 *      assumption would pass every card. NULL is ungraded, with the reason.
 *
 *   6. FULFILMENT (migration 039) - did the store FOLLOW the card, as a state
 *      on the card itself, decided by the data and never by a click:
 *        confirmed    a detector with rows said true (feed / invoice /
 *                     attributable stock delta / price / registry) - never an
 *                     owner report. Terminal; never downgraded.
 *        not_followed full-visibility false, and the 30-day window closed or
 *                     valid_through passed. An owner's 'did' does not lift it;
 *                     the evidence records both.
 *        claimed      the owner said 'did' and nothing confirms it.
 *        unobservable the detectors cannot see this action; no claim.
 *        expired      valid_through passed, nothing seen, nothing said.
 *        pending      otherwise.
 *      THE OWNER'S CLAIM NO LONGER FILLS action_taken. It used to, where no
 *      detector had spoken, and so moved the score and the verdict on the
 *      owner's word. action_taken is now only what detectors saw; the claim
 *      lives in action_evidence.claim and in fulfilment_state, named as a
 *      claim. See fulfilmentFrom for the rules, one function, pure.
 *
 * final_score = weight-renormalized blend of the present components
 * (outcome 0.60, action 0.15, votes ≤0.25·n/(n+2)). The quantities and the
 * stockout grade are RECORDED, never scored - they feed the gate. Verdicts:
 *   winner         : final ≥ 0.60 AND the outcome was actually measurable
 *   underperformer : final < 0.40 AND the outcome was actually measurable
 *   neutral        : anything else with some evidence
 *   insufficient_data: nothing measurable (no sales evidence, no action info)
 *
 * An evaluation for (rec, window) runs once the tenant's sales frontier
 * (MAX(sale_date), not wall-clock - syncs lag) has passed rec_date + window,
 * so partially-synced windows are never scored early; rows upsert idempotently.
 *
 * Tenancy: every query filters BOTH client_id AND location_id; all syncgo
 * reads go through makeTenantScopedPool (RLS-compatible). Tables are
 * provisioned by database/analytics-migrations/002 (no DDL here); until it is
 * applied every entry point degrades to a logged no-op.
 */

const logger = require('../utils/logger');
const { probePurchaseFeed } = require('./purchaseFeed');
const featureStore = require('./featureStoreService');
const outcomeSvc = require('./outcomeFeedbackService');
const { getPool, makeTenantScopedPool } = require('../database/connection');
const { purchaseDaySql, purchaseDaySaneSql } = require('./purchaseDateSql');

// ─── Configuration (env-overridable) ─────────────────────────────────────────

function parseWindows(raw) {
  const parsed = String(raw || '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 365);
  const unique = [...new Set(parsed)].sort((a, b) => a - b);
  return unique.length ? unique : [7, 30, 60, 90];
}

const EVAL_WINDOWS = parseWindows(process.env.REC_EVAL_WINDOWS || '7,30,60,90');
const BASELINE_DAYS = 28;              // trailing window defining a SKU's normal rate
const LIFT_CAP = 5;                    // scoring cap; raw lift is stored uncapped
// The feature definition this evaluation was computed under. Bumped when the
// meaning of a feature changes, so an outcome row can say which definition
// produced it - an outcome that cannot be explained cannot move a threshold.
const FEATURE_VERSION = '1.0.0';
const ZERO_BASELINE_MIN_UNITS = 3;     // no-baseline SKU needs this many sales to count as upside
const ZERO_BASELINE_SCORE = 0.8;       // strong-but-not-perfect: sold with no history
const OUTCOME_WEIGHT = 0.6;
const ACTION_WEIGHT = 0.15;
const VOTE_WEIGHT_MAX = 0.25;
const VOTE_SHRINK_K = 2;
const WINNER_MIN = Number(process.env.REC_EVAL_WINNER_MIN || 0.6);
const UNDERPERFORMER_MAX = Number(process.env.REC_EVAL_UNDERPERFORMER_MAX || 0.4);
const MARKDOWN_MIN_DROP = 0.05;        // ≥5% price cut counts as a markdown
const RESTOCK_MIN_UNITS = 3;           // net inflow floor to call it a restock
const LOOKBACK_DAYS = Number(process.env.REC_EVAL_LOOKBACK_DAYS || 180);
const SUMMARY_DEFAULT_DAYS = 90;
// Minimum covered days before a window gets a PARTIAL evaluation. Below this
// a span is noise; at/after it the window is scored over the covered days and
// re-scored as data arrives until it finalizes.
const PARTIAL_MIN_DAYS = 3;
// The engine's coverage horizon (deterministic.py COVERAGE_DAYS): a reorder
// pick whose cover is below it is a STOCKOUT card. Mirrored here for ONE use
// only - recognising rows written before migration 035 persisted the family.
// A rec that carries engine_family never consults this.
const ENGINE_COVERAGE_DAYS = 14;
// The stockout grade is taken on this window alone. The card's claim spans
// the 14-day cover plus the 7-day lead time it quotes; 30 days is the first
// evaluation horizon that contains both, and grading the 7-day window would
// fail every card whose delivery is simply not due yet.
const STOCKOUT_GRADE_WINDOW_DAYS = 30;

// ─── Table availability (migration 002 may not be applied yet) ───────────────

// Probe caching: a TRUE result is stable for the process lifetime, but FALSE
// re-probes after a short TTL - otherwise applying migration 002 to a live
// system would leave the feature stuck off until a restart.
const PROBE_RETRY_MS = 5 * 60 * 1000;

function makeProbe(runProbe) {
  let cached = null; // { value, at } | in-flight promise
  function probe(pool) {
    if (cached && typeof cached.then === 'function') return cached;
    if (cached && (cached.value === true || Date.now() - cached.at < PROBE_RETRY_MS)) {
      return Promise.resolve(cached.value);
    }
    const p = runProbe(pool)
      .then((value) => {
        cached = { value, at: Date.now() };
        return value;
      })
      .catch((err) => {
        cached = null;
        throw err;
      });
    cached = p;
    return p;
  }
  probe.reset = () => { cached = null; };
  return probe;
}

let evalTablesExist = makeProbe((pool) =>
  pool
    .query(
      `SELECT to_regclass('public.recommendation_sku_state')   IS NOT NULL
          AND to_regclass('public.recommendation_evaluations') IS NOT NULL AS ready`
    )
    .then((r) => r.rows[0].ready)
);

let referenceUpcColumnExists = makeProbe((pool) =>
  pool
    .query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'recommendations' AND column_name = 'reference_upc'`
    )
    .then((r) => r.rows.length > 0)
);

// ---------------------------------------------------------------------------
// Canonical sale-line matching (one-number rule). The generator's demand feed
// (integrationService.getSales) credits upc-rung sale lines to the canonical
// products.sku, excludes VOIDs, and counts only positive quantities - so
// EVALUATION must measure sales the same way, or a rec for a upc-keyed store
// (store 46: ~25% of volume rings under the barcode) reads as a flatline and
// mis-feeds the proven/avoid learning lists. These fragments assume the
// enclosing query binds $1 = client_id, $2 = location_id.
// ---------------------------------------------------------------------------
const SKU_KEYMAP_CTE = `keymap AS (
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
  )`;
const VOID_SALES_CTE = `void_sales AS (
    SELECT sale_id FROM sales
     WHERE client_id = $1 AND location_id = $2
       AND sale_status = 'VOID' AND sale_id IS NOT NULL
  )`;
const CANON_SKU = `COALESCE(k.sku, si.sku)`;
const CANON_JOIN = `LEFT JOIN keymap k ON k.jk = si.sku`;
const NOT_VOID = `(si.sale_id IS NULL OR si.sale_id NOT IN (SELECT sale_id FROM void_sales))`;

// suggested_order_qty (canonical reorder quantity from the shared demand
// engine) ships with analytics migration 007; same probe-and-degrade pattern
// as reference_upc so pre-migration deploys keep persisting recs.
let suggestedOrderQtyColumnExists = makeProbe((pool) =>
  pool
    .query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'recommendations' AND column_name = 'suggested_order_qty'`
    )
    .then((r) => r.rows.length > 0)
);

// The syncgo `purchases` table is authoritative restock evidence where the POS
// actually syncs POs - for other tenants it exists but is EMPTY, so its rows
// only ever assert positives (a PO happened); absence of rows never proves the
// store didn't restock. This probe checks the shape only.
let purchasesUsable = makeProbe((pool) =>
  pool
    .query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'purchases' AND column_name IN ('sku', 'date', 'quantity')`
    )
    .then((r) => r.rows[0].n === 3)
    .catch(() => false)
);

// ─── Uploaded invoices as restock evidence (analytics 008 / 037) ─────────────
//
// `purchase_orders` + `purchase_order_items` are Botella's own record of a
// document the OWNER gave us (Quick PO), in the analytics DB - not POS truth,
// which is why they live apart from syncgo `purchases`. A line counts only
// through its EXPLICIT `matched_sku` (a human picked the product, or created
// it); the read-time fuzzy match is never used here, because evidence that
// "the store acted" must not rest on a name similarity. Like the purchases
// feed, these rows only ever assert positives: no invoice proves nothing - the
// owner may simply not have uploaded one.
let invoiceTablesUsable = makeProbe((pool) =>
  pool
    .query(
      `SELECT (to_regclass('public.purchase_orders') IS NOT NULL
          AND to_regclass('public.purchase_order_items') IS NOT NULL
          AND EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'purchase_order_items'
                         AND column_name = 'matched_sku')) AS ready`
    )
    .then((r) => r.rows[0].ready === true)
    .catch(() => false)
);

// 037 added received_date - the day the goods ARRIVED, when the document or
// the owner states it. Preferred over invoice_date for placing the delivery
// inside a window; absent, the invoice date is the best dated fact we have.
let poReceivedDateColumnExists = makeProbe((pool) =>
  pool
    .query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'purchase_orders' AND column_name = 'received_date'`
    )
    .then((r) => r.rows.length > 0)
    .catch(() => false)
);

// 021 marks a re-upload of the same invoice with duplicate_of. A duplicate
// must not double the units the owner bought.
let poDuplicateOfColumnExists = makeProbe((pool) =>
  pool
    .query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'purchase_orders' AND column_name = 'duplicate_of'`
    )
    .then((r) => r.rows.length > 0)
    .catch(() => false)
);

// Whether recommendation_outcomes.purchased_qty_source may say 'invoice'. 035
// wrote the CHECK with two sources and 036 widens it; until 036 is applied an
// invoice can prove the ACTION (action_evidence is jsonb) but the bought
// quantity cannot name it as the source, and must not be written under
// another source's name.
let purchasedSourceAdmitsInvoice = makeProbe((pool) =>
  pool
    .query(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'recommendation_outcomes'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) ILIKE '%purchased_qty_source%'`
    )
    .then((r) => r.rows.some((row) => /'invoice'/.test(row.def)))
    .catch(() => false)
);

/**
 * Invoice units per sku per day, for the tenant's involved skus, as a daily
 * map shaped exactly like `purchasesDaily` so `unitsBetween` slices both the
 * same way. Loaded ONCE per tenant per evaluation (bulk by sku list), never
 * per rec. Returns null when the tables are not there - "no evidence", which
 * the detectors keep apart from an empty map ("looked, found none").
 *
 * The day is COALESCE(received_date, invoice_date): the arrival when it is
 * known, else the document's own date. Only status 'parsed' rows - a 'failed'
 * parse has no trustworthy lines and a 'parsing' one is not finished.
 */
async function loadInvoicesDaily(analyticsPool, clientId, locationId, skus, sinceIso) {
  if (!skus.length || !(await invoiceTablesUsable(analyticsPool))) return null;
  const hasReceived = await poReceivedDateColumnExists(analyticsPool);
  const hasDuplicateOf = await poDuplicateOfColumnExists(analyticsPool);
  const dayExpr = hasReceived ? 'COALESCE(o.received_date, o.invoice_date)' : 'o.invoice_date';
  try {
    // The ids and invoice numbers ride along so the fulfilment evidence can
    // NAME the document that confirmed a card ("invoice #4471"), not merely
    // count its units. Aggregated per (sku, day) exactly like the units, so
    // the daily map's shape is unchanged for `unitsBetween`.
    const { rows } = await analyticsPool.query(
      `SELECT i.matched_sku AS sku,
              to_char(${dayExpr}, 'YYYY-MM-DD') AS day,
              SUM(i.quantity)::numeric AS units,
              array_agg(DISTINCT o.id) AS order_ids,
              array_agg(DISTINCT o.invoice_no) FILTER (WHERE o.invoice_no IS NOT NULL) AS invoice_nos
         FROM purchase_order_items i
         JOIN purchase_orders o ON o.id = i.purchase_order_id
        WHERE i.client_id = $1 AND i.location_id = $2
          AND o.client_id = $1 AND o.location_id = $2
          AND i.matched_sku = ANY($3)
          AND i.quantity > 0
          AND o.status = 'parsed'
          ${hasDuplicateOf ? 'AND o.duplicate_of IS NULL' : ''}
          AND ${dayExpr} IS NOT NULL
          AND ${dayExpr} >= $4::date
        GROUP BY i.matched_sku, ${dayExpr}`,
      [clientId, locationId, skus, sinceIso]
    );
    const invoicesDaily = new Map();
    // Side table of the documents behind each day's units - a property on the
    // Map rather than a second return value so every existing caller that
    // passes `invoicesDaily` through to the detectors carries it for free.
    // Map iteration never sees a property, so `unitsBetween` is unaffected.
    invoicesDaily.refs = new Map();
    for (const row of rows) {
      if (!invoicesDaily.has(row.sku)) invoicesDaily.set(row.sku, new Map());
      invoicesDaily.get(row.sku).set(row.day, Number(row.units));
      if (!invoicesDaily.refs.has(row.sku)) invoicesDaily.refs.set(row.sku, []);
      invoicesDaily.refs.get(row.sku).push({
        day: row.day, units: Number(row.units),
        order_ids: row.order_ids || [], invoice_nos: row.invoice_nos || [],
      });
    }
    return invoicesDaily;
  } catch (err) {
    logger.warn(`[RecEval] invoice evidence unavailable for ${clientId}:${locationId}: ${err.message}`);
    return null;
  }
}

// Migration 003 (dollar attribution + snapshot cost) - optional like the rest.
let extensionsExist = makeProbe((pool) =>
  pool
    .query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'recommendation_evaluations' AND column_name = 'revenue_impact'`
    )
    .then((r) => r.rows.length > 0)
);

// Migration 022 (the figures the decision was taken on). Read here so the
// outcome row can carry the shelf count the card was made on, and so a
// pre-035 stockout card can be recognised from its cover.
let engineFactsColumnsExist = makeProbe((pool) =>
  pool
    .query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'recommendations' AND column_name = 'engine_on_hand'`
    )
    .then((r) => r.rows.length > 0)
);

// Migration 035 (which engine family made the card).
let engineFamilyColumnExists = makeProbe((pool) =>
  pool
    .query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'recommendations' AND column_name = 'engine_family'`
    )
    .then((r) => r.rows.length > 0)
);

// Migration 032 (which engine produced the run). The outcome row's
// model_version was NULL on every row ever written because the evaluator
// read `rec.model_version` and no such column exists; the version lives on
// the run.
let engineVersionColumnExists = makeProbe((pool) =>
  pool
    .query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'recommendation_runs' AND column_name = 'engine_version'`
    )
    .then((r) => r.rows.length > 0)
);

// Migration 004 (owner-reported action claims).
let actionClaimColumnExists = makeProbe((pool) =>
  pool
    .query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'recommendations' AND column_name = 'action_claim'`
    )
    .then((r) => r.rows.length > 0)
);

// Migration 039 (the fulfilment state machine's columns). Until it is applied
// the machine still RUNS - its answer rides every read as a derived field -
// but nothing is persisted and the owner's dismiss reason has nowhere to go.
let fulfilmentColumnsExist = makeProbe((pool) =>
  pool
    .query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'recommendations' AND column_name = 'fulfilment_state'`
    )
    .then((r) => r.rows.length > 0)
    .catch(() => false)
);

// ─── Pure scoring helpers (exported for tests) ───────────────────────────────

/** lift in [0, ∞) → 0..1, 1.0x → 0.5 (the Python feedback loop's squash). */
function squashLift(lift) {
  const capped = Math.min(lift, LIFT_CAP);
  return capped / (capped + 1);
}

/** Zero-baseline "pure upside" floor, scaled to the window: ~1 unit/week with
 * an absolute minimum, so 3 units in 90 days never mints a winner. */
function zeroBaselineMinUnits(windowDays) {
  return Math.max(ZERO_BASELINE_MIN_UNITS, Math.ceil(windowDays / 7));
}

/**
 * Laplace-smoothed vote value + shrunk weight. With the one-vote-per-store
 * design n is 0 or 1: a single vote is worth 0.667/0.333 (never 1/0) and its
 * weight is VOTE_WEIGHT_MAX·(1/3) ≈ 0.083 - a mistaken tap cannot dominate.
 */
function voteComponentOf(ups, downs) {
  const n = ups + downs;
  if (n === 0) return null;
  return {
    value: (ups + 1) / (n + 2),
    weight: VOTE_WEIGHT_MAX * (n / (n + VOTE_SHRINK_K)),
  };
}

/**
 * Blend the present components with weight renormalization. Returns
 * { finalScore, voteComponent } - finalScore null when nothing is present.
 */
function blendScore({ outcomeScore, actionTaken, voteUps, voteDowns }) {
  let accum = 0;
  let weight = 0;
  if (outcomeScore != null) {
    accum += OUTCOME_WEIGHT * outcomeScore;
    weight += OUTCOME_WEIGHT;
  }
  if (actionTaken === true || actionTaken === false) {
    accum += ACTION_WEIGHT * (actionTaken ? 1 : 0);
    weight += ACTION_WEIGHT;
  }
  const vote = voteComponentOf(voteUps, voteDowns);
  if (vote) {
    accum += vote.weight * vote.value;
    weight += vote.weight;
  }
  return {
    finalScore: weight > 0 ? Math.round((accum / weight) * 1000) / 1000 : null,
    voteComponent: vote ? Math.round(vote.value * 1000) / 1000 : null,
  };
}

/**
 * Verdict rules. Votes alone can never mint a winner/underperformer: both
 * labels require the outcome to have been measurable.
 */
function verdictOf({ finalScore, outcomeMeasurable, actionKnown }) {
  if (finalScore == null || (!outcomeMeasurable && !actionKnown)) return 'insufficient_data';
  if (outcomeMeasurable && finalScore >= WINNER_MIN) return 'winner';
  // Strictly below the line: an exactly-neutral outcome (0.400) is neutral.
  if (outcomeMeasurable && finalScore < UNDERPERFORMER_MAX) return 'underperformer';
  return 'neutral';
}

// ─── Small date helpers (all date-only, UTC) ─────────────────────────────────

const dayMs = 86400000;
const toDateOnly = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (isoDate, n) => toDateOnly(new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + n * dayMs));

/** Sum a sku's units over (start, end], from the daily map. */
function unitsBetween(daily, sku, startIso, endIso) {
  const byDay = daily.get(sku);
  if (!byDay) return 0;
  let total = 0;
  for (const [day, units] of byDay) {
    if (day > startIso && day <= endIso) total += units;
  }
  return total;
}

/** The days in (start, end] on which a sku had units, sorted - so evidence
 * can say WHEN, not only how many. Empty when none. */
function daysWithUnits(daily, sku, startIso, endIso) {
  const byDay = daily.get(sku);
  if (!byDay) return [];
  return [...byDay.entries()]
    .filter(([day, units]) => day > startIso && day <= endIso && units > 0)
    .map(([day]) => day)
    .sort();
}

// ─── Baseline capture ────────────────────────────────────────────────────────

/**
 * Snapshot per-SKU state for the recs of one run (called right after persist).
 * Best-effort: failure is logged upstream; the recs then evaluate snapshot-less.
 */
async function captureForRun(analyticsPool, clientId, locationId, runId, opts = {}) {
  if (!(await evalTablesExist(analyticsPool))) return 0;
  const recs = await analyticsPool.query(
    `SELECT id, primary_skus FROM recommendations
      WHERE run_id = $1 AND client_id = $2 AND location_id = $3`,
    [runId, clientId, locationId]
  );
  return captureForRecs(analyticsPool, clientId, locationId, recs.rows, opts);
}

/**
 * Cron catch-up: snapshot any recent recs (≤7d) that still have no state rows
 * and cite at least one SKU - covers recs persisted while capture was failing.
 */
async function captureMissing(analyticsPool, clientId, locationId, opts = {}) {
  if (!(await evalTablesExist(analyticsPool))) return 0;
  const recs = await analyticsPool.query(
    `SELECT r.id, r.primary_skus FROM recommendations r
      WHERE r.client_id = $1 AND r.location_id = $2
        AND r.created_at >= now() - interval '7 days'
        AND cardinality(r.primary_skus) > 0
        AND NOT EXISTS (SELECT 1 FROM recommendation_sku_state s WHERE s.rec_id = r.id)`,
    [clientId, locationId]
  );
  return captureForRecs(analyticsPool, clientId, locationId, recs.rows, opts);
}

async function captureForRecs(analyticsPool, clientId, locationId, recRows, opts = {}) {
  const skus = [...new Set(recRows.flatMap((r) => r.primary_skus || []))];
  if (!skus.length) return 0;

  const scoped = makeTenantScopedPool(opts.syncgoPool || getPool(), clientId, locationId);
  const hasExtensions = await extensionsExist(analyticsPool).catch(() => false);
  const products = await scoped.query(
    `SELECT sku, stock_qty, price, sale_price, cost FROM products
      WHERE client_id = $1 AND location_id = $2 AND sku = ANY($3)`,
    [clientId, locationId, skus]
  );
  const bySku = new Map(products.rows.map((p) => [p.sku, p]));

  // Trailing 28-day rate anchored to the data frontier (house rule), matched
  // canonically (upc remap, VOID-free, positive qty) like the generator feed.
  const rates = await scoped.query(
    `WITH latest AS (
       SELECT MAX(sale_date)::date AS d FROM sale_items
        WHERE client_id = $1 AND location_id = $2
     ), ${SKU_KEYMAP_CTE}, ${VOID_SALES_CTE}
     SELECT ${CANON_SKU} AS sku, SUM(si.quantity)::int AS units
       FROM sale_items si ${CANON_JOIN}
      WHERE si.client_id = $1 AND si.location_id = $2 AND ${CANON_SKU} = ANY($3)
        AND si.sale_date > (SELECT d FROM latest) - $4::int
        AND si.quantity > 0 AND ${NOT_VOID}
      GROUP BY ${CANON_SKU}`,
    [clientId, locationId, skus, BASELINE_DAYS]
  );
  // ── The rate: units per OPEN week, not per calendar week ──────────────────
  // This used to be `units / (BASELINE_DAYS / 7)` - a CALENDAR-week divisor.
  // Bethany (171:171) closes every Sunday, so that understated its velocity by
  // 14.3% (212.32/day vs 247.71/open-day) and every restock threshold and
  // expected-units figure derived from it inherited the error.
  //
  // The denominator now comes from the feature store's calendar (sheet 03),
  // which is the ONE definition. Probe-and-degrade: a store that has not been
  // built yet falls back to the old calendar divisor rather than losing its
  // evaluation entirely, and the fallback is logged so the gap is visible.
  const asOf = toDateOnly(new Date());
  let openDays = null;
  if (await featureStore.isBuilt(analyticsPool, clientId, locationId)) {
    openDays = await featureStore
      .openDays(analyticsPool, { clientId, locationId, asOf, windowDays: BASELINE_DAYS })
      .catch(() => null);
  }
  if (!openDays) {
    logger.warn('[RecEval] feature store unavailable; falling back to a '
      + `calendar-day rate for ${clientId}:${locationId} (understates any `
      + 'store that closes)');
  }
  const weeksInWindow = openDays ? openDays / 7 : BASELINE_DAYS / 7;
  const rateBySku = new Map(rates.rows.map((r) => [r.sku, r.units / weeksInWindow]));

  let inserted = 0;
  for (const rec of recRows) {
    for (const sku of rec.primary_skus || []) {
      const p = bySku.get(sku);
      const cols = ['rec_id', 'client_id', 'location_id', 'sku', 'on_hand', 'price', 'sale_price', 'weekly_rate'];
      const vals = [
        rec.id, clientId, locationId, sku,
        p && p.stock_qty != null ? parseInt(p.stock_qty, 10) : null,
        p && p.price != null ? Number(p.price) : null,
        p && p.sale_price != null ? Number(p.sale_price) : null,
        Math.round((rateBySku.get(sku) || 0) * 100) / 100,
      ];
      if (hasExtensions) {
        cols.push('cost');
        vals.push(p && p.cost != null ? Number(p.cost) : null);
      }
      const res = await analyticsPool.query(
        `INSERT INTO recommendation_sku_state (${cols.join(', ')})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (rec_id, sku) DO NOTHING`,
        vals
      );
      inserted += res.rowCount;
    }
  }
  return inserted;
}

// ─── Quantity-hint compliance (evidence only) ────────────────────────────────
// quantity_hint is owner-facing prose ("order about 3 to 4 cases"). Unit
// conversions (cases vs bottles) are too ambiguous to score, so the parsed
// range is recorded as EVIDENCE next to the detected purchase volume and never
// influences the verdict.
function parseQuantityHint(hint) {
  if (!hint) return null;
  const text = String(hint);
  // Only unit-adjacent quantities count - '2 cases', '3-5 cases', '3 to 5
  // cases', '2 or 3 cases', '12-pack'. Bare numbers are dates/prose ('the
  // July 4 weekend'), never quantities; with no unit-adjacent number the
  // hint parses to nothing.
  const re = /(\d+(?:\.\d+)?)(?:\s*(?:-|-|to|or)\s*(\d+(?:\.\d+)?))?[\s-]*(?:cases?|cs|bottles?|btl|units?|packs?|pk)\b/gi;
  const values = [];
  for (const m of text.matchAll(re)) {
    for (const raw of [m[1], m[2]]) {
      const n = Number(raw);
      if (raw != null && Number.isFinite(n) && n > 0 && n < 100000) values.push(n);
    }
  }
  if (!values.length) return null;
  return { low: Math.min(...values), high: Math.max(...values), text: text.slice(0, 120) };
}

// ─── Action detection ────────────────────────────────────────────────────────

const RESTOCK_ACTIONS = new Set(['reorder', 'pre_stock']);
const MARKDOWN_ACTIONS = new Set(['markdown', 'liquidate']);

// A snapshot captured more than this many days after the rec cannot support a
// definitive "did NOT act" - the action may have happened before the (late)
// capture. TRUE evidence survives; FALSE downgrades to unknown.
const CAPTURE_FRESH_DAYS = 2;
// Stock-delta inflow can only be attributed to THIS window when the evaluation
// runs close to the window's end; beyond the grace the inflow may postdate it.
const STOCK_DELTA_ATTRIBUTION_GRACE_DAYS = 3;

/** The net-inflow floor to call a stock delta a restock: 3 units or half a
 * week of sales, whichever is larger, so a fast seller's count noise never
 * reads as a delivery. */
function restockThreshold(weeklyRate) {
  return Math.max(RESTOCK_MIN_UNITS, Math.round(0.5 * (weeklyRate || 0)));
}

/**
 * Everything the data can say about units ARRIVING for one sku over one
 * window, computed once. The action detector decides "did they act" from it
 * and the outcome row records "how many" from it; two copies of this
 * arithmetic is how one screen comes to say 454 and another 485.
 *
 *   po_units     PO units inside (rec_date, windowEnd]. null when there is no
 *                purchases feed; 0 when the feed had no rows for this sku -
 *                which, for a tenant whose POS does not sync POs, proves
 *                nothing (the table exists and is empty).
 *   invoice_units units on UPLOADED invoices whose receipt (else invoice) date
 *                falls inside (rec_date, windowEnd], through the line's
 *                explicit matched_sku. null when the invoice tables are not
 *                there; 0 when no uploaded document names this sku - which
 *                proves nothing, the owner may not have uploaded it.
 *   invoice_days the dated days those units fell on, so the evidence can
 *                say WHEN rather than only how many.
 *   net_inflow   (stock_now − snapshot.on_hand) + units sold over the SAME
 *                (capture, frontier] span, so post-window sales can never mask
 *                an in-window restock. null without a snapshot or a current
 *                count.
 *   threshold    the restock floor for this sku.
 *   capture_late the snapshot was taken > CAPTURE_FRESH_DAYS after the rec, so
 *                an arrival before it is invisible and "none" cannot be said.
 *   attributable the frontier is within the grace of the window's end, so
 *                inflow in the delta belongs to THIS window and not a later one.
 */
function skuInflow(sku, { rec, windowEndIso, frontier, state, current, purchasesDaily, invoicesDaily, daily }) {
  // The documents behind the units, for the fulfilment evidence (039): which
  // feed rows and which invoices fell inside THIS window. `refs` is the side
  // table the loaders attach to the daily maps; absent (older loader, the
  // test mock) the units and days still speak.
  const refsIn = (dailyMap) => {
    const list = dailyMap && dailyMap.refs && dailyMap.refs.get(sku);
    return Array.isArray(list)
      ? list.filter((r) => r.day > rec.rec_date && r.day <= windowEndIso) : null;
  };
  const poRefs = purchasesDaily ? refsIn(purchasesDaily) : null;
  const invRefs = invoicesDaily ? refsIn(invoicesDaily) : null;
  const flat = (list, key) => (list ? [...new Set(list.flatMap((r) => r[key] || []))] : null);
  const out = {
    po_units: purchasesDaily ? unitsBetween(purchasesDaily, sku, rec.rec_date, windowEndIso) : null,
    po_days: purchasesDaily ? daysWithUnits(purchasesDaily, sku, rec.rec_date, windowEndIso) : null,
    po_ids: poRefs ? flat(poRefs, 'purchase_ids') : null,
    invoice_units: invoicesDaily ? unitsBetween(invoicesDaily, sku, rec.rec_date, windowEndIso) : null,
    invoice_days: invoicesDaily ? daysWithUnits(invoicesDaily, sku, rec.rec_date, windowEndIso) : null,
    invoice_ids: invRefs ? flat(invRefs, 'order_ids') : null,
    invoice_nos: invRefs ? flat(invRefs, 'invoice_nos') : null,
    net_inflow: null, threshold: null, capture_late: null, attributable: null,
  };
  if (state && state.on_hand != null && current && current.stock_qty != null) {
    const captureDay = toDateOnly(state.captured_at);
    out.capture_late = captureDay > addDays(rec.rec_date, CAPTURE_FRESH_DAYS);
    const soldSince = unitsBetween(daily, sku, captureDay, frontier);
    out.net_inflow = (parseInt(current.stock_qty, 10) - state.on_hand) + soldSince;
    out.threshold = restockThreshold(state.weekly_rate);
    out.attributable = frontier <= addDays(windowEndIso, STOCK_DELTA_ATTRIBUTION_GRACE_DAYS);
  }
  return out;
}

/**
 * Decide action_taken for one (rec, window). Returns
 * { taken: true|false|null, evidence }.
 *
 * Honesty rules (violations of these were the #1 review finding):
 *  - Every detector is bounded to (rec_date, windowEnd]: evidence from before
 *    the rec or after the window never credits/blames this window.
 *  - FALSE requires full visibility: a fresh (≤2d) snapshot for the delta and
 *    price detectors, or the authoritative first-seen registry for stock_new.
 *  - Purchase-order rows only ever assert POSITIVES - the table is legitimately
 *    empty for tenants whose POS doesn't sync POs, so absence proves nothing.
 *    The same holds for uploaded invoices: no document, no claim either way.
 *
 * ORDER OF TRUST for a restock, and why:
 *  1. the purchases feed   - the POS recorded the order; dated, system-written.
 *  2. an uploaded invoice  - a DOCUMENT the owner gave us, with a date on it
 *                            (the receipt date when stated, else the invoice
 *                            date) and a line a human matched to the SKU. It
 *                            says what was ordered and when; it does not by
 *                            itself say the goods are on the shelf.
 *  3. the stock delta      - inferred from two counts, UNDATED: it can say
 *                            units arrived somewhere between capture and the
 *                            frontier, never on which day, which is why it is
 *                            the only one that needs the attribution grace.
 *  A dated document outranks an undated inference; a system record outranks
 *  a document. Each is consulted only when the one above it had nothing.
 */
function detectAction({ rec, windowEndIso, frontier, stateBySku, currentBySku, purchasesDaily, invoicesDaily, daily, stockNewArrival }) {
  if (rec.action_type === 'stock_new') {
    // The first-seen registry is authoritative both ways: the product either
    // appeared in this store's catalog during the window, or it didn't.
    if (!rec.reference_upc) {
      return { taken: null, evidence: { detector: 'stock_new', note: 'no reference_upc recorded' } };
    }
    const arrivedInWindow = Boolean(
      stockNewArrival && stockNewArrival.first_seen <= windowEndIso
    );
    return {
      taken: arrivedInWindow,
      evidence: {
        detector: 'catalog_registry',
        upc: rec.reference_upc,
        arrived: stockNewArrival || null,
        ...(stockNewArrival && !arrivedInWindow ? { note: 'arrived after this window' } : {}),
      },
    };
  }

  if (RESTOCK_ACTIONS.has(rec.action_type)) {
    const perSku = [];
    for (const sku of rec.primary_skus) {
      const flow = skuInflow(sku, {
        rec, windowEndIso, frontier,
        state: stateBySku.get(sku), current: currentBySku.get(sku),
        purchasesDaily, invoicesDaily, daily,
      });
      // 1. Purchase orders INSIDE the window - authoritative positive.
      if (flow.po_units != null && flow.po_units > 0) {
        perSku.push({
          sku, taken: true, detector: 'purchase_orders', purchased_units: flow.po_units,
          // The dated rows behind the units (039): the fulfilment evidence
          // names them so "confirmed" can point at a purchase, not a sum.
          purchase_days: flow.po_days,
          ...(flow.po_ids && flow.po_ids.length ? { purchase_ids: flow.po_ids } : {}),
        });
        continue;
      }
      // 2. An uploaded invoice dated INSIDE the window naming this sku - a
      // document, dated, matched by a person. Positive only.
      if (flow.invoice_units != null && flow.invoice_units > 0) {
        perSku.push({
          sku, taken: true, detector: 'invoice',
          invoice_units: flow.invoice_units, invoice_dates: flow.invoice_days,
          ...(flow.invoice_ids && flow.invoice_ids.length ? { invoice_ids: flow.invoice_ids } : {}),
          ...(flow.invoice_nos && flow.invoice_nos.length ? { invoice_nos: flow.invoice_nos } : {}),
          ...(flow.po_units != null ? { purchased_units_in_window: flow.po_units } : {}),
        });
        continue;
      }
      // 3. Stock-delta inference from the generation-time snapshot (the
      // arithmetic is in skuInflow, shared with the outcome row's quantity).
      if (flow.net_inflow != null) {
        let taken;
        let note;
        if (flow.net_inflow >= flow.threshold) {
          // Inflow definitely happened - but only attribute it to THIS window
          // when the data frontier is still close to the window's end.
          if (flow.attributable) {
            taken = true;
          } else {
            taken = null;
            note = 'inflow detected but not attributable to this window (late evaluation)';
          }
        } else if (!flow.capture_late) {
          // No meaningful inflow across (capture, frontier] ⊇ the window.
          taken = false;
        } else {
          taken = null;
          note = 'snapshot captured late; a restock before capture would be invisible';
        }
        perSku.push({
          sku, taken, detector: 'stock_delta',
          net_inflow: flow.net_inflow, threshold: flow.threshold,
          ...(flow.po_units != null ? { purchased_units_in_window: flow.po_units } : {}),
          ...(flow.invoice_units != null ? { invoice_units_in_window: flow.invoice_units } : {}),
          ...(note ? { note } : {}),
        });
      } else {
        perSku.push({ sku, taken: null, detector: 'none' });
      }
    }
    return combinePerSku(perSku);
  }

  if (MARKDOWN_ACTIONS.has(rec.action_type)) {
    const perSku = [];
    for (const sku of rec.primary_skus) {
      const state = stateBySku.get(sku);
      const current = currentBySku.get(sku);
      if (!state || state.price == null || !current || current.price == null) {
        perSku.push({ sku, taken: null, detector: 'none' });
        continue;
      }
      // Compare EFFECTIVE prices (min of base and active sale price) so a
      // discount that already existed at rec time never counts as acting.
      const saleThen = state.sale_price != null ? Number(state.sale_price) : 0;
      const saleNow = current.sale_price != null ? Number(current.sale_price) : 0;
      const effThen = Math.min(Number(state.price), saleThen > 0 ? saleThen : Infinity);
      const effNow = Math.min(Number(current.price), saleNow > 0 ? saleNow : Infinity);
      const dropped = effThen > 0 && effNow <= effThen * (1 - MARKDOWN_MIN_DROP);
      const captureLate = toDateOnly(state.captured_at) > addDays(rec.rec_date, CAPTURE_FRESH_DAYS);
      const taken = dropped ? true : captureLate ? null : false;
      perSku.push({
        sku, taken, detector: 'price',
        effective_price_then: effThen, effective_price_now: effNow,
        ...(taken === null ? { note: 'snapshot captured late; a cut before capture would be invisible' } : {}),
      });
    }
    return combinePerSku(perSku);
  }

  // endcap / cold_box / promote / bundle: physical placement - unobservable.
  return { taken: null, evidence: { detector: 'unobservable', action_type: rec.action_type } };
}

/** ANY true → true; all observable false → false; nothing observable → null. */
function combinePerSku(perSku) {
  const taken = perSku.some((s) => s.taken === true)
    ? true
    : perSku.some((s) => s.taken === false) && perSku.every((s) => s.taken !== null)
      ? false
      : null;
  return { taken, evidence: { skus: perSku } };
}

// ─── The fulfilment state machine (migration 039) ────────────────────────────
//
// WHAT IT ANSWERS. Did the store follow this card? One state per CARD (not per
// evaluation window), decided by the data and never by a click:
//
//   confirmed     a detector that reads real rows said TRUE - purchases feed,
//                 matched invoice, attributable stock inflow, price drop,
//                 catalogue arrival. Never 'owner_reported'. Terminal.
//   not_followed  a detector with FULL visibility said FALSE, and the window
//                 the decision is taken on has closed or the card's own
//                 valid_through has passed. An owner's 'did' does NOT lift
//                 this: the evidence records both and the UI shows both.
//   claimed       the owner said 'did' and nothing has confirmed it - either
//                 not yet (the window is still open, the feed has not synced)
//                 or not ever (a shelf-floor action no feed can see).
//   unobservable  the detectors cannot see this kind of action, and the owner
//                 has not claimed it.
//   expired       valid_through has passed, nothing was seen, nothing said.
//   pending       everything else: too early to say, and nothing claimed.
//
// WHY A SEPARATE STATE AND NOT action_taken. action_taken is per window and
// tri-state, and until this change a claim could FILL it, which made the
// score and the verdict move on the owner's word. The state keeps the two
// apart: action_taken stays what the detectors saw; the claim lives beside
// it, named as a claim, and the machine says how the two relate.
//
// WHICH WINDOW DECIDES. Any window whose detector said TRUE confirms (a PO
// inside the 7-day window is inside the 30-day one too). For FALSE the
// longest window the evaluator has looked at speaks, and "closed" means the
// data frontier has passed the end of FULFILMENT_WINDOW_DAYS - the 30-day
// horizon, for the same reason the stockout grade uses it: the card's own
// claim spans the 14-day cover plus the lead time it quotes, and calling a
// reorder "not followed" on day 7 would fail every card whose delivery is
// simply not due yet.
//
// PURE. No I/O, no clock: `today` is passed in, so the same inputs always
// give the same state and the unit tests can pin every branch.

const FULFILMENT_WINDOW_DAYS = 30;
const FULFILMENT_STATES = ['pending', 'claimed', 'confirmed', 'not_followed', 'unobservable', 'expired'];
/** Detectors whose TRUE rests on rows in a table, and so may confirm. */
const CONFIRMING_DETECTORS = new Set(['purchase_orders', 'invoice', 'stock_delta', 'price', 'catalog_registry']);
/** Action types at least one detector can see. The rest are shelf-floor. */
const OBSERVABLE_ACTIONS = new Set(['reorder', 'pre_stock', 'markdown', 'liquidate', 'stock_new']);

/**
 * Which detector DECIDED a detectAction result. Per-sku evidence (`skus`) is
 * read against the combined verdict: the first sku that said TRUE when the
 * card is true, the first that said FALSE when the card is false, else the
 * first sku's detector (all null). Top-level detectors (catalog_registry,
 * unobservable, stock_new, owner_reported, none) are returned as they are.
 */
function decidingDetector(evidence, taken) {
  if (!evidence) return 'none';
  if (Array.isArray(evidence.skus)) {
    if (!evidence.skus.length) return 'none';
    const pick = taken === true ? evidence.skus.find((s) => s.taken === true)
      : taken === false ? evidence.skus.find((s) => s.taken === false)
        : null;
    return (pick || evidence.skus[0]).detector || 'none';
  }
  return evidence.detector || 'none';
}

/**
 * The rows that decided it, lifted out of the detector evidence into a flat
 * shape the card can print: feed units and days (and purchase ids when the
 * feed carries them), invoice ids and numbers, the snapshot delta against its
 * threshold, the two effective prices, the registry arrival. Only the skus
 * that agree with the verdict are kept - a card confirmed by one sku's PO
 * does not list the other sku's silent snapshot as if it mattered.
 */
function decidingRows(evidence, taken) {
  if (!evidence) return [];
  if (Array.isArray(evidence.skus)) {
    const agree = evidence.skus.filter((s) => (taken == null ? true : s.taken === taken));
    return agree.map((s) => {
      const row = { sku: s.sku, detector: s.detector };
      if (s.detector === 'purchase_orders') {
        row.units = s.purchased_units;
        if (s.purchase_days) row.days = s.purchase_days;
        if (s.purchase_ids) row.purchase_ids = s.purchase_ids;
      } else if (s.detector === 'invoice') {
        row.units = s.invoice_units;
        row.days = s.invoice_dates;
        if (s.invoice_ids) row.invoice_ids = s.invoice_ids;
        if (s.invoice_nos) row.invoice_nos = s.invoice_nos;
      } else if (s.detector === 'stock_delta') {
        row.net_inflow = s.net_inflow;
        row.threshold = s.threshold;
      } else if (s.detector === 'price') {
        row.effective_price_then = s.effective_price_then;
        row.effective_price_now = s.effective_price_now;
      }
      if (s.note) row.note = s.note;
      return row;
    });
  }
  if (evidence.detector === 'catalog_registry') {
    return [{ detector: 'catalog_registry', upc: evidence.upc, arrived: evidence.arrived || null,
      ...(evidence.note ? { note: evidence.note } : {}) }];
  }
  return evidence.note ? [{ detector: evidence.detector || 'none', note: evidence.note }] : [];
}

/**
 * THE ONE FUNCTION. Returns { state, evidence } where evidence is the jsonb
 * written to recommendations.fulfilment_evidence.
 *
 *   actionType    the card's action_type
 *   detection     { taken, evidence } from detectAction for the window that
 *                 speaks (see "which window decides" above), or null when no
 *                 window has been evaluable yet
 *   claim         recommendations.action_claim: 'did' | 'did_not' |
 *                 'dismissed' | null
 *   validThrough  'YYYY-MM-DD' or null
 *   windowClosed  has the deciding window closed against the data frontier
 *   today         'YYYY-MM-DD' - passed in, never read from the clock
 *   window        optional { days, end, data_through } recorded as evidence
 */
function fulfilmentFrom({ actionType, detection, claim, validThrough, windowClosed, today, window } = {}) {
  const taken = detection ? detection.taken : null;
  const detEvidence = detection ? detection.evidence : null;
  const detector = detection ? decidingDetector(detEvidence, taken) : 'none';
  const validPassed = Boolean(validThrough && today && validThrough < today);
  const observable = OBSERVABLE_ACTIONS.has(actionType);
  const claimed = claim === 'did';

  const base = {
    detector,
    rows: decidingRows(detEvidence, taken),
    action_type: actionType,
    ...(window ? { window } : {}),
    valid_through: validThrough || null,
    window_closed: Boolean(windowClosed),
    ...(claim ? { claim } : {}),
  };

  // 1. Confirmed: rows in a table said so. A claim can never be the detector.
  if (taken === true && CONFIRMING_DETECTORS.has(detector)) {
    return { state: 'confirmed', evidence: { ...base, decided_by: 'detector_true' } };
  }
  // 2. Not followed: full visibility, nothing happened, and the time to act
  //    has run out. The owner's 'did' does not override - it is recorded and
  //    contradicted in the same breath.
  if (taken === false && (windowClosed || validPassed)) {
    return {
      state: 'not_followed',
      evidence: {
        ...base,
        decided_by: windowClosed ? 'detector_false_window_closed' : 'detector_false_valid_through_passed',
        ...(claimed ? { conflict: 'owner said done; the data shows no action' } : {}),
      },
    };
  }
  // 3. Claimed: the owner's word, standing alone. If a detector has said
  //    FALSE so far (window still open) that is noted - the claim has not
  //    been refuted, but it has not been met either.
  if (claimed) {
    return {
      state: 'claimed',
      evidence: {
        ...base,
        decided_by: 'owner_claim',
        ...(taken === false ? { note: 'no action seen so far; the window is still open' } : {}),
        ...(!observable ? { note: 'no detector can see this kind of action; the claim stands as the owner\'s word' } : {}),
      },
    };
  }
  // 4. Unobservable: nothing will ever confirm or refute this without a claim.
  if (!observable || detector === 'unobservable') {
    return { state: 'unobservable', evidence: { ...base, decided_by: 'action_type_unobservable' } };
  }
  // 5. Expired: the card's own date passed and the data stayed silent.
  if (validPassed && taken === null) {
    return { state: 'expired', evidence: { ...base, decided_by: 'valid_through_passed_nothing_seen' } };
  }
  // 6. Pending: too early, or the detectors have not had full visibility yet.
  return {
    state: 'pending',
    evidence: {
      ...base,
      decided_by: taken === false ? 'detector_false_window_open' : 'nothing_decisive_yet',
    },
  };
}

/**
 * The card's state as the READ paths should treat it, with a fallback for
 * rows migration 039 has not re-stated yet. Those rows sit at the default
 * 'pending' until their next evaluation pass; in the meantime the evaluation
 * row's own action_taken is the same evidence, so a detector TRUE (not an
 * owner report) still reads as confirmed and a final-window FALSE as
 * not_followed. Rows the machine HAS stated are returned as stated.
 *
 *   row: { fulfilment_state?, action_taken?, action_evidence?, action_claim?,
 *          evidence_partial?, action_type? }
 */
function effectiveFulfilment(row) {
  if (!row) return 'pending';
  const stated = row.fulfilment_state;
  if (stated && stated !== 'pending') return stated;
  // A 'pending' the MACHINE wrote (checked_at set) is an answer - "window
  // still open, nothing decisive" - and must not be second-guessed from a
  // single window's FALSE. Only the column default (never checked) falls
  // through to the evaluation-row fallback below.
  if (stated === 'pending' && row.fulfilment_checked_at) return 'pending';
  const ev = typeof row.action_evidence === 'string'
    ? (() => { try { return JSON.parse(row.action_evidence); } catch { return null; } })()
    : row.action_evidence || null;
  const detector = decidingDetector(ev, row.action_taken);
  if (row.action_taken === true && CONFIRMING_DETECTORS.has(detector)) return 'confirmed';
  if (row.action_taken === false && !row.evidence_partial && detector !== 'owner_reported') return 'not_followed';
  if (row.action_claim === 'did') return 'claimed';
  if (row.action_type && !OBSERVABLE_ACTIONS.has(row.action_type)) return 'unobservable';
  return stated || 'pending';
}

// ── One plain sentence per state, for the card face ─────────────────────────

// Accepts 'YYYY-MM-DD' text, an ISO timestamp string, or the Date object
// node-postgres hands back for a timestamptz (action_claim_at arrives as one).
const monthDay = (when) => {
  if (!when) return null;
  const text = when instanceof Date ? when.toISOString() : String(when);
  const d = new Date(`${text.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};
const dollars = (v) => (v == null || !Number.isFinite(Number(v)) ? null : `$${Number(v).toFixed(2)}`);
const unitsWord = (n) => `${n} unit${Number(n) === 1 ? '' : 's'}`;

/**
 * "Confirmed: 24 units received on 14 Oct (invoice #4471)." One sentence,
 * owner's words, and it never says more than the evidence does: a feed row
 * is an ORDER, an invoice is a RECEIPT when it carries a received date and a
 * document otherwise, a stock delta is units that ARRIVED, undated.
 *
 *   { state, evidence, claim, claim_at, valid_through, action_type }
 */
function fulfilmentSummary({ state, evidence, claim, claim_at: claimAt, valid_through: validThrough, action_type: actionType } = {}) {
  const ev = evidence || {};
  const rows = Array.isArray(ev.rows) ? ev.rows : [];
  const first = rows[0] || {};
  const claimedOn = claimAt ? monthDay(claimAt) : null;
  const claimBit = claim === 'did' ? `You marked it done${claimedOn ? ` on ${claimedOn}` : ''}` : null;
  const through = ev.window && ev.window.data_through ? monthDay(ev.window.data_through) : null;
  const isPrice = actionType === 'markdown' || actionType === 'liquidate';
  const isCatalog = actionType === 'stock_new';

  if (state === 'confirmed') {
    const d = ev.detector || first.detector;
    let core;
    if (d === 'purchase_orders') {
      const day = Array.isArray(first.days) && first.days[0] ? monthDay(first.days[0]) : null;
      core = `Confirmed: ${first.units != null ? unitsWord(first.units) : 'an order'} ordered${day ? ` on ${day}` : ''} (purchase order)`;
    } else if (d === 'invoice') {
      const day = Array.isArray(first.days) && first.days[0] ? monthDay(first.days[0]) : null;
      const no = Array.isArray(first.invoice_nos) && first.invoice_nos[0] ? ` (invoice #${first.invoice_nos[0]})` : ' (invoice)';
      core = `Confirmed: ${first.units != null ? unitsWord(first.units) : 'a delivery'} received${day ? ` on ${day}` : ''}${no}`;
    } else if (d === 'stock_delta') {
      core = `Confirmed: stock rose by ${first.net_inflow != null ? unitsWord(first.net_inflow) : 'more than sales explain'} after this card${first.threshold != null ? `, above the ${first.threshold} that sales alone would explain` : ''}`;
    } else if (d === 'price') {
      const a = dollars(first.effective_price_then); const b = dollars(first.effective_price_now);
      core = `Confirmed: price dropped${a && b ? ` from ${a} to ${b}` : ''}`;
    } else if (d === 'catalog_registry') {
      const day = first.arrived && first.arrived.first_seen ? monthDay(first.arrived.first_seen) : null;
      core = `Confirmed: the product appeared in your catalogue${day ? ` on ${day}` : ''}`;
    } else {
      core = 'Confirmed by your data';
    }
    return `${core}.${claimBit ? ` ${claimBit}.` : ''}`;
  }
  if (state === 'claimed') {
    const notYet = isPrice ? 'the price has not moved in your data yet'
      : isCatalog ? 'it has not appeared in your catalogue yet'
        : !OBSERVABLE_ACTIONS.has(actionType) ? 'your register cannot show this kind of action, so it stands as your word'
          : 'no order has appeared in your data yet';
    return `Marked done by you${claimedOn ? ` on ${claimedOn}` : ''}; ${notYet}.`;
  }
  if (state === 'not_followed') {
    const by = through ? ` by ${through}` : validThrough ? ` by ${monthDay(validThrough)}` : '';
    let core;
    if (isPrice) {
      const p = dollars(first.effective_price_now);
      core = `The price held${p ? ` at ${p}` : ''}${by}; no markdown appeared`;
    } else if (isCatalog) {
      core = `It never appeared in your catalogue${by}`;
    } else {
      core = `No order seen${by}; the shelf did not move`;
    }
    return `${core}.${claimBit ? ` ${claimBit}, but the data shows no ${isPrice ? 'price change' : isCatalog ? 'arrival' : 'order'}.` : ''}`;
  }
  if (state === 'unobservable') {
    return 'Your register cannot show this kind of action; mark it done if you did it.';
  }
  if (state === 'expired') {
    return `Valid through ${monthDay(validThrough) || 'its date'}; nothing was seen in your data and you did not mark it.`;
  }
  // pending
  if (ev.decided_by === 'detector_false_window_open') {
    return `Nothing seen in your data${through ? ` through ${through}` : ''}; still checking as sales sync.`;
  }
  return `Not yet seen in your data${through ? ` (checked through ${through})` : ''}; checking as sales sync.`;
}

/**
 * Persist a card's state. NEVER DOWNGRADES CONFIRMED: a PO that was in the
 * feed still was, whatever a later pass sees, so a confirmed row keeps its
 * state and its evidence and only refreshes fulfilment_checked_at. The
 * confirmed timestamp is written once and kept. Returns the row as stored,
 * or null when the card is not this tenant's.
 */
async function writeFulfilment(analyticsPool, clientId, locationId, recId, { state, evidence }) {
  if (!FULFILMENT_STATES.includes(state)) throw new Error(`fulfilment: unknown state ${state}`);
  const { rows } = await analyticsPool.query(
    `UPDATE recommendations
        SET fulfilment_state = CASE WHEN fulfilment_state = 'confirmed' THEN 'confirmed' ELSE $4 END,
            fulfilment_evidence = CASE WHEN fulfilment_state = 'confirmed' AND $4 <> 'confirmed'
                                       THEN fulfilment_evidence ELSE $5::jsonb END,
            fulfilment_confirmed_at = CASE WHEN $4 = 'confirmed'
                                           THEN COALESCE(fulfilment_confirmed_at, now())
                                           ELSE fulfilment_confirmed_at END,
            fulfilment_checked_at = now()
      WHERE id = $1 AND client_id = $2 AND location_id = $3
      RETURNING fulfilment_state, fulfilment_evidence, fulfilment_confirmed_at, action_claim, action_claim_at`,
    [recId, clientId, locationId, state, JSON.stringify(evidence || {})]
  );
  return rows[0] || null;
}

// ─── Quantities on the outcome row (migration 035) ───────────────────────────

/**
 * What the store BOUGHT over the window, summed over the card's skus, with
 * the source named - because the sources are not equally trustworthy, in
 * the same order detectAction trusts them:
 *   purchases_feed : PO rows inside the window. The POS said so.
 *   invoice        : lines on an uploaded invoice dated inside the window,
 *                    matched to the sku by a person. What was ordered, by
 *                    the owner's own document. Only when migration 036 has
 *                    widened the source CHECK to admit it (`invoiceAdmitted`);
 *                    before that the figure is reported in the reason and
 *                    the quantity stays NULL rather than wearing another
 *                    source's name.
 *   stock_inflow   : the snapshot-to-frontier delta plus sales. Inferred, and
 *                    asserted only from a fresh snapshot: a restock at or
 *                    above the threshold that is attributable to this window,
 *                    or full visibility of none (recorded as 0 - a measured
 *                    nothing, which the source column keeps apart from "no
 *                    feed").
 * Returns { qty: null, source: null, reason } when none can speak. NULL is
 * "no evidence", never "bought nothing": a tenant whose POS does not sync POs
 * has a purchases table that exists and is empty, and a 0 from it would read
 * as a store ignoring every card (migration 020 says so in the DDL).
 */
function purchasedQuantityFor({
  rec, windowEndIso, frontier, stateBySku, currentBySku, purchasesDaily, invoicesDaily, daily,
  invoiceAdmitted = false,
}) {
  if (!rec.primary_skus.length) return { qty: null, source: null, reason: 'no sku on this card' };
  let feedUnits = 0;
  let feedSkus = 0;
  let invoiceUnits = 0;
  let invoiceSkus = 0;
  let inflowUnits = 0;
  let inflowSkus = 0;
  const unresolved = [];
  for (const sku of rec.primary_skus) {
    const flow = skuInflow(sku, {
      rec, windowEndIso, frontier,
      state: stateBySku.get(sku), current: currentBySku.get(sku),
      purchasesDaily, invoicesDaily, daily,
    });
    if (flow.po_units != null && flow.po_units > 0) {
      feedUnits += flow.po_units;
      feedSkus += 1;
    } else if (flow.invoice_units != null && flow.invoice_units > 0 && invoiceAdmitted) {
      invoiceUnits += flow.invoice_units;
      invoiceSkus += 1;
    } else if (flow.invoice_units != null && flow.invoice_units > 0) {
      unresolved.push(`${sku}: an uploaded invoice shows ${flow.invoice_units} units `
        + `(${flow.invoice_days.join(', ')}) but migration 036 has not widened `
        + 'purchased_qty_source to record an invoice as the source');
    } else if (flow.net_inflow == null) {
      unresolved.push(`${sku}: no purchase-order rows and no rec-time snapshot to difference`);
    } else if (flow.capture_late) {
      unresolved.push(`${sku}: snapshot captured late; a restock before capture would be invisible`);
    } else if (flow.net_inflow >= flow.threshold) {
      if (flow.attributable) {
        inflowUnits += flow.net_inflow;
        inflowSkus += 1;
      } else {
        unresolved.push(`${sku}: inflow seen but not attributable to this window (late evaluation)`);
      }
    } else {
      // Fresh snapshot, nothing at or above the threshold across (capture,
      // frontier] ⊇ the window. A measured none, not an absence of data.
      inflowSkus += 1;
    }
  }
  const resolved = feedSkus + invoiceSkus + inflowSkus;
  if (resolved === 0) {
    return { qty: null, source: null, reason: unresolved.join('; ') };
  }
  // The source named is the most trusted one that contributed; a card whose
  // skus were resolved by different sources is still one figure, and the
  // reason says how many skus it covers.
  return {
    qty: feedUnits + invoiceUnits + inflowUnits,
    source: feedSkus > 0 ? 'purchases_feed' : invoiceSkus > 0 ? 'invoice' : 'stock_inflow',
    reason: unresolved.length
      ? `covers ${resolved} of ${rec.primary_skus.length} skus; ${unresolved.join('; ')}`
      : null,
  };
}

/** Latest nightly shelf count observed inside [recDate, windowEnd] - the row
 * itself, because the series is sparse and the reader needs its date. */
function onHandAtWindowEnd(series, recDate, windowEnd) {
  let hit = null;
  for (const obs of series || []) {
    if (obs.day < recDate) continue;
    if (obs.day > windowEnd) break;
    hit = obs;
  }
  return hit;
}

/** First day in (recDate, through] on which cumulative units sold since the
 * card reached `units`; null when they never did within the span. */
function sellThroughDay(daily, sku, recDate, through, units) {
  const byDay = daily.get(sku);
  if (!byDay) return null;
  let cumulative = 0;
  for (const day of [...byDay.keys()].sort()) {
    if (day <= recDate || day > through) continue;
    cumulative += byDay.get(day);
    if (cumulative >= units) return day;
  }
  return null;
}

/** First day in (recDate, through] with positive units in a daily map. */
function firstDayWithUnits(dailyMap, sku, recDate, through) {
  const byDay = dailyMap && dailyMap.get(sku);
  if (!byDay) return null;
  for (const day of [...byDay.keys()].sort()) {
    if (day > recDate && day <= through && byDay.get(day) > 0) return day;
  }
  return null;
}

/**
 * First observation inside (recDate, windowEnd] at which the shelf count ROSE
 * net of sales - the observation-to-observation form of the stock delta. A
 * delivery of six with five sold between two counts shows as +1 on the shelf,
 * so the rise is (count_i − count_{i−1}) + units sold in (day_{i−1}, day_i].
 * The first observation is compared against the issue-time count. The
 * threshold is the restock detector's, so count noise is not a delivery.
 *
 * Returns { day, after, inflow }: the delivery landed somewhere in
 * (after, day] - the series is sparse, so `day` is when it was SEEN, and a
 * sell-through inside that same gap cannot be ordered against it.
 */
function firstOnHandRise(series, { sku, recDate, windowEnd, issueOnHand, daily, threshold }) {
  let prevDay = recDate;
  let prevCount = issueOnHand;
  for (const obs of series || []) {
    if (obs.day <= recDate) {
      prevDay = obs.day;
      prevCount = Number(obs.on_hand);
      continue;
    }
    if (obs.day > windowEnd) break;
    const count = Number(obs.on_hand);
    if (prevCount != null) {
      const inflow = (count - prevCount) + unitsBetween(daily, sku, prevDay, obs.day);
      if (inflow >= threshold) return { day: obs.day, after: prevDay, inflow };
    }
    prevDay = obs.day;
    prevCount = count;
  }
  return null;
}

/** The last observation day in the series at or before `through`, or null. */
function lastObservationDay(series, through) {
  let last = null;
  for (const obs of series || []) {
    if (obs.day > through) break;
    last = obs.day;
  }
  return last;
}

const calendarDaysBetween = (fromIso, toIso) => Math.round(
  (new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`)) / dayMs
);

/**
 * Is this the engine's STOCKOUT card? The recorded family answers when there
 * is one. For rows written before migration 035 persisted it, FALL BACK to
 * the engine's own rule (deterministic.py: a reorder pick whose cover is
 * below COVERAGE_DAYS is a stockout). A recorded fact beats a re-derivation,
 * which is why the column exists; this re-derives only where no fact was
 * recorded, and never for a card that is not a reorder.
 */
function isStockoutCard(rec) {
  if (rec.engine_family != null) return rec.engine_family === 'stockout';
  return rec.action_type === 'reorder'
    && rec.engine_days_cover != null
    && Number(rec.engine_days_cover) < ENGINE_COVERAGE_DAYS;
}

const UNGRADED = (reason) => ({
  sold_through: null, days_to_sell_through: null,
  delivery_observed_on: null, delivery_evidence: null,
  sold_through_reason: reason,
});

/**
 * Grade one stockout card on one window: did cumulative sales reach the
 * issue-time on-hand STRICTLY BEFORE the first observed inflow?
 *
 * Delivery evidence, in order of trust, and only ever OBSERVED - the 7-day
 * lead time the card quotes is an assumption, and a card graded against its
 * own assumption passes by construction:
 *   purchases_feed    a PO row inside the window - dated.
 *   on_hand_increase  a nightly count rose net of sales - dated to the
 *                     observation, bounded below by the previous one.
 *   stock_delta       the snapshot-to-frontier delta shows a restock that
 *                     belongs to this window - UNDATED, so it can refute a
 *                     sell-through (cover never ran out) but not confirm one.
 *   stock_delta_none / on_hand_no_rise
 *                     full visibility and nothing arrived.
 *
 * TRUE needs the sell-through day to sit at or before the last day the
 * delivery certainly had not landed (`after`). A sell-through on the delivery
 * day, or inside the same gap between two sparse counts, is NULL - the order
 * of the two events inside a day is not something the data can state.
 */
function gradeStockout({
  rec, sku, windowEndIso, coveredEnd, isPartial, frontier,
  issueOnHand, issueOnHandSource, daily, purchasesDaily, series, flow,
}) {
  if (!sku) return UNGRADED('no sku on this card');
  if (issueOnHand == null) {
    return UNGRADED('no on-hand count at issue: no engine_on_hand and no rec-time snapshot');
  }
  const need = Number(issueOnHand);
  // An already-empty shelf has nothing left to sell through; the claim "it
  // runs out before the next delivery" was true the day it was made.
  const soldDay = need <= 0 ? rec.rec_date : sellThroughDay(daily, sku, rec.rec_date, coveredEnd, need);
  const basis = `${need} on hand at issue (${issueOnHandSource})`;
  const threshold = flow.threshold != null ? flow.threshold : RESTOCK_MIN_UNITS;

  // 1. A dated delivery.
  let delivery = null;
  if (flow.po_units != null && flow.po_units > 0) {
    const day = firstDayWithUnits(purchasesDaily, sku, rec.rec_date, windowEndIso);
    delivery = { day, after: addDays(day, -1), evidence: 'purchases_feed' };
  } else {
    const rise = firstOnHandRise(series, {
      sku, recDate: rec.rec_date, windowEnd: windowEndIso,
      issueOnHand: need, daily, threshold,
    });
    if (rise) delivery = { day: rise.day, after: rise.after, evidence: 'on_hand_increase' };
  }
  if (delivery) {
    const base = {
      delivery_observed_on: delivery.day, delivery_evidence: delivery.evidence,
      days_to_sell_through: null,
    };
    if (soldDay != null && soldDay <= delivery.after) {
      return {
        ...base, sold_through: true,
        days_to_sell_through: calendarDaysBetween(rec.rec_date, soldDay),
        sold_through_reason: `${basis}; sold through on ${soldDay}, delivery observed ${delivery.day} (${delivery.evidence})`,
      };
    }
    if (soldDay != null && soldDay <= delivery.day) {
      return {
        ...base, sold_through: null,
        sold_through_reason: `${basis}; sold through on ${soldDay} and the delivery was observed ${delivery.day}`
          + ` (${delivery.evidence}, landed after ${delivery.after}) - the order of the two cannot be stated`,
      };
    }
    return {
      ...base, sold_through: false,
      sold_through_reason: `${basis}; delivery observed ${delivery.day} (${delivery.evidence}) with cover still on the shelf`
        + (soldDay ? `; sold through only on ${soldDay}` : `; ${unitsBetween(daily, sku, rec.rec_date, coveredEnd)} sold through ${coveredEnd}`),
    };
  }

  // 2. No dated delivery. What the undated evidence can and cannot say.
  const lastObs = lastObservationDay(series, windowEndIso);
  const noneSeen = flow.net_inflow != null && !flow.capture_late && flow.net_inflow < threshold
    ? 'stock_delta_none'
    : lastObs != null && lastObs > rec.rec_date && lastObs >= coveredEnd ? 'on_hand_no_rise'
      : null;
  if (noneSeen) {
    const seenThrough = noneSeen === 'stock_delta_none' ? frontier : lastObs;
    if (soldDay != null) {
      return {
        sold_through: true, days_to_sell_through: calendarDaysBetween(rec.rec_date, soldDay),
        delivery_observed_on: null, delivery_evidence: noneSeen,
        sold_through_reason: `${basis}; sold through on ${soldDay} and no inflow observed through ${seenThrough} (${noneSeen})`,
      };
    }
    if (isPartial) {
      return UNGRADED(`${basis}; window still open through ${coveredEnd}: neither sell-through nor delivery observed yet`);
    }
    return {
      sold_through: false, days_to_sell_through: null,
      delivery_observed_on: null, delivery_evidence: noneSeen,
      sold_through_reason: `${basis}; no delivery observed through ${seenThrough} (${noneSeen}) and only `
        + `${unitsBetween(daily, sku, rec.rec_date, coveredEnd)} sold in the window - the cover did not run out`,
    };
  }
  if (flow.net_inflow != null && !flow.capture_late && flow.net_inflow >= threshold) {
    if (!flow.attributable) {
      return UNGRADED(`${basis}; inflow of ${flow.net_inflow} seen in the stock delta but not attributable to this window (late evaluation)`);
    }
    if (soldDay == null) {
      return {
        sold_through: false, days_to_sell_through: null,
        delivery_observed_on: null, delivery_evidence: 'stock_delta',
        sold_through_reason: `${basis}; inflow of ${flow.net_inflow} arrived (stock delta, undated) and sales never reached the cover through ${coveredEnd}`,
      };
    }
    return UNGRADED(`${basis}; sold through on ${soldDay} and an inflow of ${flow.net_inflow} is in the stock delta, undated - cannot be ordered against the sell-through`);
  }
  if (flow.net_inflow != null && flow.capture_late) {
    return UNGRADED(`${basis}; snapshot captured late, so a delivery before capture is invisible, and no dated inflow was observed`);
  }
  return UNGRADED(`${basis}; no delivery evidence: no purchase-order rows, no nightly on-hand rise, no rec-time snapshot to difference`);
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

/**
 * Evaluate everything due for one tenant. Returns { evaluated, pending }.
 * @param {object} [opts] { force: re-evaluate existing rows (manual endpoint) }
 */
async function evaluateTenant(analyticsPool, clientId, locationId, opts = {}) {
  if (!(await evalTablesExist(analyticsPool))) return { evaluated: 0, pending: 0, disabled: true };
  const syncgoBase = opts.syncgoPool || getPool();
  const scoped = makeTenantScopedPool(syncgoBase, clientId, locationId);
  const hasUpcColumn = await referenceUpcColumnExists(analyticsPool);

  // The tenant's sales frontier - evaluations wait for data, never wall-clock.
  // DATE columns are shipped as text (to_char) everywhere in this service:
  // node-postgres parses bare DATE to a LOCAL-midnight JS Date, which shifts a
  // calendar day on non-UTC servers when run through toISOString (review
  // finding: IST made every window sum one day off).
  const frontierRes = await scoped.query(
    `SELECT to_char(MAX(sale_date)::date, 'YYYY-MM-DD') AS latest FROM sale_items
      WHERE client_id = $1 AND location_id = $2`,
    [clientId, locationId]
  );
  const frontier = frontierRes.rows[0]?.latest || null;
  if (!frontier) return { evaluated: 0, pending: 0 };

  const hasExtensions = await extensionsExist(analyticsPool).catch(() => false);
  const hasClaims = await actionClaimColumnExists(analyticsPool).catch(() => false);
  const hasOrderQty = await suggestedOrderQtyColumnExists(analyticsPool).catch(() => false);
  const hasEngineFacts = await engineFactsColumnsExist(analyticsPool).catch(() => false);
  const hasEngineFamily = await engineFamilyColumnExists(analyticsPool).catch(() => false);
  const hasEngineVersion = await engineVersionColumnExists(analyticsPool).catch(() => false);
  const hasFulfilment = hasClaims && await fulfilmentColumnsExist(analyticsPool).catch(() => false);
  const recsRes = await analyticsPool.query(
    `SELECT r.id, r.category, r.action_type, r.primary_skus, r.vote, r.quantity_hint,
            to_char(r.valid_through, 'YYYY-MM-DD') AS valid_through,
            -- status carries the ARM (sheet 19). Read, never re-derived: it is
            -- the arm the store actually experienced, and re-deriving it from
            -- the current REC_HOLDOUT_PCT would relabel history the day that
            -- setting changes.
            r.status, r.confidence,
            run.generated_at${hasUpcColumn ? ', r.reference_upc' : ''}${hasClaims ? ', r.action_claim, r.action_claim_at' : ''}
            -- The fulfilment state as it stands (039), so the pass can say
            -- what it changed and never downgrade a confirmed card.
            ${hasFulfilment ? ', r.fulfilment_state' : ''}
            -- THE QUANTITY THE CARD PRINTED (migration 007). Never read here
            -- before; the outcome row's recommended_qty came from the hint's
            -- parsed high end, which on a stockout card is the predictive
            -- band's top and on a markdown card is the on-shelf count.
            ${hasOrderQty ? ', r.suggested_order_qty' : ''}
            -- The figures the decision was taken on (022) and which family
            -- took it (035): the stockout grade needs both.
            ${hasEngineFacts ? ', r.engine_daily_rate, r.engine_days_cover, r.engine_on_hand' : ''}
            ${hasEngineFamily ? ', r.engine_family' : ''}
            -- The run's engine (032). The outcome row has a model_version
            -- column that was NULL on every row because this SELECT never
            -- carried one.
            ${hasEngineVersion ? ', run.engine_version AS model_version' : ''}
       FROM recommendations r
       JOIN recommendation_runs run ON run.id = r.run_id
      WHERE r.client_id = $1 AND r.location_id = $2
        AND run.generated_at >= now() - make_interval(days => $3)
        ${opts.onlyRecId ? 'AND r.id = $4' : ''}`,
    opts.onlyRecId
      ? [clientId, locationId, LOOKBACK_DAYS, opts.onlyRecId]
      : [clientId, locationId, LOOKBACK_DAYS]
  );
  if (!recsRes.rows.length) return { evaluated: 0, pending: 0 };

  const existing = await analyticsPool.query(
    `SELECT rec_id, window_days, to_char(data_through, 'YYYY-MM-DD') AS data_through
       FROM recommendation_evaluations
      WHERE client_id = $1 AND location_id = $2`,
    [clientId, locationId]
  );
  const existingByKey = new Map(
    existing.rows.map((e) => [`${e.rec_id}:${e.window_days}`, e.data_through])
  );

  const recs = recsRes.rows.map((r) => ({
    ...r,
    rec_date: toDateOnly(r.generated_at),
    primary_skus: r.primary_skus || [],
    reference_upc: r.reference_upc || null,
  }));

  // Work list. A (rec, window) is evaluable as soon as the frontier covers at
  // least PARTIAL_MIN_DAYS of post-rec sales: it gets a PARTIAL evaluation
  // (measured over the covered span, expected pro-rated to it, marked in the
  // evidence) that is re-evaluated whenever new data arrives, and becomes
  // FINAL once the frontier passes the window's end. Skip rules: final rows
  // are done forever; partial rows are skipped only while the frontier hasn't
  // moved past what they already saw (idempotent re-runs).
  const due = [];
  let pending = 0;
  for (const rec of recs) {
    for (const w of EVAL_WINDOWS) {
      const windowEnd = addDays(rec.rec_date, w);
      const seenThrough = existingByKey.get(`${rec.id}:${w}`);
      if (!opts.force && seenThrough !== undefined
          && (seenThrough >= windowEnd || seenThrough >= frontier)) continue;
      const coveredEnd = windowEnd < frontier ? windowEnd : frontier;
      const coveredDays = Math.round(
        (new Date(`${coveredEnd}T00:00:00Z`) - new Date(`${rec.rec_date}T00:00:00Z`)) / dayMs
      );
      if (coveredDays >= Math.min(PARTIAL_MIN_DAYS, w)) {
        due.push({ rec, windowDays: w, coveredEnd, coveredDays });
      } else {
        pending++;
      }
    }
  }
  if (!due.length) {
    // Nothing to score, but cards younger than PARTIAL_MIN_DAYS still need
    // their first fulfilment state (an endcap is 'unobservable' from day one;
    // a claim is 'claimed'). `stateFulfilment` is hoisted from the end of
    // this function - function declarations are, so it is callable here.
    return { evaluated: 0, pending, fulfilment: await stateFulfilment([], new Map()) };
  }

  // ── Bulk data fetches (one of each per tenant, not per rec) ──
  const dueRecs = [...new Set(due.map((d) => d.rec))];
  const skus = [...new Set(dueRecs.flatMap((r) => r.primary_skus))];
  const earliest = addDays(
    dueRecs.map((r) => r.rec_date).sort()[0], -(BASELINE_DAYS + 1)
  );

  // ── The OPEN-day calendar, fetched once (sheet 19) ──────────────────────
  //
  // Every rate in this file is per OPEN day. Fetched as a SET of dates rather
  // than a count, because each recommendation needs the open days in ITS OWN
  // two windows - the trailing baseline and the covered span - and those
  // differ per rec. A single estate-wide count cannot answer that.
  //
  // Empty when the feature store has no calendar for this store yet. The
  // counter below then degrades to calendar days and says so, which is the
  // same trade the store-level rate above makes: a rate that understates a
  // closing store beats losing its evaluation entirely, as long as the gap is
  // visible.
  const openDates = new Set();
  try {
    const { rows: calRows } = await analyticsPool.query(
      `SELECT to_char(obs_date, 'YYYY-MM-DD') AS d
         FROM feature_store_day
        WHERE client_id = $1 AND location_id = $2
          AND obs_date >= $3::date AND obs_date <= $4::date
          AND was_open IS TRUE AND has_data IS TRUE`,
      [clientId, locationId, earliest, frontier]
    );
    for (const row of calRows) openDates.add(row.d);
  } catch (calErr) {
    logger.warn('[RecEval] open-day calendar unavailable; lift will use '
      + `calendar days for ${clientId}:${locationId}`, { error: calErr.message });
  }

  /**
   * Open days in [from, to). Falls back to the calendar span when no calendar
   * exists, never to zero - a zero here would divide by nothing and make every
   * lift unmeasurable for a store whose calendar has not been built.
   */
  const openDaysBetween = (from, to) => {
    const spanDays = Math.max(0, Math.round(
      (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / dayMs
    ));
    if (!openDates.size) return spanDays;
    let count = 0;
    for (let i = 0; i < spanDays; i++) {
      if (openDates.has(addDays(from, i))) count += 1;
    }
    // A window with no open days at all is genuinely unmeasurable, and
    // `liftFor` says so rather than dividing by a fabricated 1.
    return count;
  };

  // Daily sales map for every involved sku (days as text - see frontier note),
  // matched canonically so upc-rung lines credit the recommended SKU.
  const daily = new Map();
  if (skus.length) {
    const sales = await scoped.query(
      `WITH ${SKU_KEYMAP_CTE}, ${VOID_SALES_CTE}
       SELECT ${CANON_SKU} AS sku, to_char(si.sale_date::date, 'YYYY-MM-DD') AS day,
              SUM(si.quantity)::int AS units
         FROM sale_items si ${CANON_JOIN}
        WHERE si.client_id = $1 AND si.location_id = $2 AND ${CANON_SKU} = ANY($3)
          AND si.sale_date >= $4::date
          AND si.quantity > 0 AND ${NOT_VOID}
        GROUP BY ${CANON_SKU}, si.sale_date::date`,
      [clientId, locationId, skus, earliest]
    );
    for (const row of sales.rows) {
      if (!daily.has(row.sku)) daily.set(row.sku, new Map());
      daily.get(row.sku).set(row.day, row.units);
    }
  }

  // Snapshots + current product state.
  const stateRows = skus.length
    ? await analyticsPool.query(
        `SELECT rec_id, sku, on_hand, price, sale_price, weekly_rate, captured_at
               ${hasExtensions ? ', cost' : ''}
           FROM recommendation_sku_state
          WHERE client_id = $1 AND location_id = $2 AND rec_id = ANY($3)`,
        [clientId, locationId, dueRecs.map((r) => r.id)]
      )
    : { rows: [] };
  const stateByRec = new Map();
  for (const s of stateRows.rows) {
    if (!stateByRec.has(s.rec_id)) stateByRec.set(s.rec_id, new Map());
    stateByRec.get(s.rec_id).set(s.sku, s);
  }

  const currentBySku = new Map();
  if (skus.length) {
    const current = await scoped.query(
      `SELECT sku, stock_qty, price, sale_price, cost FROM products
        WHERE client_id = $1 AND location_id = $2 AND sku = ANY($3)`,
      [clientId, locationId, skus]
    );
    current.rows.forEach((p) => currentBySku.set(p.sku, p));
  }

  // Purchase orders as a DAILY map so each (rec, window) sums exactly its own
  // (rec_date, windowEnd] slice - a PO from before the rec or after the window
  // must never credit it (review finding #1).
  let purchasesDaily = null;
  if (skus.length && (await purchasesUsable(syncgoBase))) {
    try {
      // purchase_id is the POS's own order reference; carried so the
      // fulfilment evidence can name the order that confirmed a card (039).
      //
      // The day is purchaseDaySql(), not `date`: at every LiquorPOS store the
      // sync writes -infinity into `date` and the real day into invoice_date
      // (see services/purchaseDateSql.js). A bare `date >= rec_date` here
      // excluded Tuscany's entire feed - 7,646 rows read as "no order for any
      // SKU" - which is the opposite of what an empty result must mean.
      const po = await scoped.query(
        `SELECT sku, to_char(${purchaseDaySql()}::date, 'YYYY-MM-DD') AS day, SUM(quantity)::int AS units,
                array_agg(DISTINCT purchase_id::text) FILTER (WHERE purchase_id IS NOT NULL) AS purchase_ids
           FROM purchases
          WHERE client_id = $1 AND location_id = $2 AND sku = ANY($3)
            AND ${purchaseDaySaneSql()}
            AND ${purchaseDaySql()} >= $4::date
          GROUP BY sku, ${purchaseDaySql()}::date`,
        [clientId, locationId, skus, dueRecs.map((r) => r.rec_date).sort()[0]]
      );
      purchasesDaily = new Map();
      purchasesDaily.refs = new Map();
      for (const row of po.rows) {
        if (!purchasesDaily.has(row.sku)) purchasesDaily.set(row.sku, new Map());
        purchasesDaily.get(row.sku).set(row.day, row.units);
        if (!purchasesDaily.refs.has(row.sku)) purchasesDaily.refs.set(row.sku, []);
        purchasesDaily.refs.get(row.sku).push({
          day: row.day, units: row.units, purchase_ids: row.purchase_ids || [],
        });
      }
    } catch (err) {
      logger.warn(`[RecEval] purchases probe failed for ${clientId}:${locationId}: ${err.message}`);
      purchasesDaily = null;
    }
  }

  // Uploaded invoices (analytics purchase_orders), the same daily shape, one
  // bulk read per tenant. The second-ranked restock evidence - see
  // detectAction's order of trust. `invoiceAdmitted` is whether the outcome
  // row may NAME it as the bought quantity's source (migration 036).
  const invoicesDaily = await loadInvoicesDaily(
    analyticsPool, clientId, locationId, skus,
    dueRecs.map((r) => r.rec_date).sort()[0]
  );
  const invoiceAdmitted = invoicesDaily
    ? await purchasedSourceAdmitsInvoice(analyticsPool).catch(() => false)
    : false;

  // ── Nightly shelf counts after the card (feature_daily.on_hand) ─────────
  //
  // Captured forward since the on-hand capture started (featureStoreService
  // .captureOnHand): one row per day the product row synced, never rewritten,
  // NULL before capture began. Read as a per-sku series so each (rec, window)
  // can take the latest count inside ITS window and the first rise after ITS
  // card. The dates travel as text for the same reason the frontier does.
  // Best-effort: a store with no capture yet records no window-end count and
  // no on-hand-based delivery evidence, and says so - it does not fail.
  const onHandSeries = new Map();
  if (skus.length) {
    try {
      const { rows: obsRows } = await analyticsPool.query(
        `SELECT sku, to_char(obs_date, 'YYYY-MM-DD') AS day, on_hand
           FROM feature_daily
          WHERE client_id = $1 AND location_id = $2 AND sku = ANY($3)
            AND obs_date >= $4::date AND on_hand IS NOT NULL
          ORDER BY sku, obs_date`,
        [clientId, locationId, skus, dueRecs.map((r) => r.rec_date).sort()[0]]
      );
      for (const row of obsRows) {
        if (!onHandSeries.has(row.sku)) onHandSeries.set(row.sku, []);
        onHandSeries.get(row.sku).push({ day: row.day, on_hand: Number(row.on_hand) });
      }
    } catch (obsErr) {
      logger.warn('[RecEval] feature_daily on-hand unavailable; outcome rows carry '
        + `no window-end count for ${clientId}:${locationId}`, { error: obsErr.message });
    }
  }

  // stock_new arrivals: consult the first-seen registry per referenced UPC.
  const stockNewByRec = new Map();
  const upcRecs = dueRecs.filter((r) => r.action_type === 'stock_new' && r.reference_upc);
  if (upcRecs.length) {
    const arrivals = await analyticsPool.query(
      `SELECT upc, sku, MIN(first_seen_at) AS first_seen_at
         FROM product_first_seen
        WHERE client_id = $1 AND location_id = $2
          AND is_baseline IS FALSE AND upc = ANY($3)
        GROUP BY upc, sku`,
      [clientId, locationId, [...new Set(upcRecs.map((r) => r.reference_upc))]]
    );
    for (const rec of upcRecs) {
      const hit = arrivals.rows.find(
        (a) => a.upc === rec.reference_upc && toDateOnly(a.first_seen_at) > rec.rec_date
      );
      if (hit) stockNewByRec.set(rec.id, { sku: hit.sku, first_seen: toDateOnly(hit.first_seen_at) });
    }
  }

  // ── Score every due (rec, window) pair ──
  let evaluated = 0;
  // What each window's detectors saw, per card, for the fulfilment machine
  // after the loop: rec_id → [{ windowDays, isPartial, taken, evidence }].
  const detectionsByRec = new Map();
  for (const { rec, windowDays, coveredEnd, coveredDays } of due) {
    // This recommendation's own two windows, in OPEN days.
    const baselineOpenDays = openDaysBetween(
      addDays(rec.rec_date, -BASELINE_DAYS), rec.rec_date
    );
    const coveredOpenDays = openDaysBetween(rec.rec_date, coveredEnd);
    const windowEndIso = addDays(rec.rec_date, windowDays);
    const isPartial = coveredEnd < windowEndIso;

    // For a stock_new rec, the outcome is the arrived sku's sales - but only
    // when the arrival actually falls inside THIS window.
    const arrival = stockNewByRec.get(rec.id);
    const arrivalInWindow = arrival && arrival.first_seen <= windowEndIso ? arrival : null;
    const outcomeSkus = rec.primary_skus.length
      ? rec.primary_skus
      : arrivalInWindow ? [arrivalInWindow.sku] : [];

    // stock_new arrival: its sales may not be in `daily` (sku discovered after
    // the bulk fetch built its sku list) - fetch on demand, once, tiny query.
    if (arrivalInWindow && !daily.has(arrivalInWindow.sku)) {
      const extra = await scoped.query(
        `WITH ${SKU_KEYMAP_CTE}, ${VOID_SALES_CTE}
         SELECT to_char(si.sale_date::date, 'YYYY-MM-DD') AS day, SUM(si.quantity)::int AS units
           FROM sale_items si ${CANON_JOIN}
          WHERE si.client_id = $1 AND si.location_id = $2 AND ${CANON_SKU} = $3
            AND si.sale_date > $4::date
            AND si.quantity > 0 AND ${NOT_VOID}
          GROUP BY si.sale_date::date`,
        [clientId, locationId, arrivalInWindow.sku, rec.rec_date]
      );
      daily.set(arrivalInWindow.sku, new Map(extra.rows.map((r) => [r.day, r.units])));
    }

    // Split SKUs by baseline availability, mirroring the Python feedback loop:
    // lift is actual/expected over BASELINED skus only - a zero-baseline sku
    // must never inflate the numerator against an empty denominator. Its sales
    // are tracked separately as pure upside. Alongside, attribute dollars:
    // extra units beyond baseline × price (margin when cost is known).
    const recState = stateByRec.get(rec.id) || new Map();
    let unitsSold = 0;
    let baselinedActual = 0;
    let expected = 0;
    let upsideUnits = 0;
    let revenueImpact = 0;
    let marginImpact = 0;
    let priceKnown = false;
    let costKnown = false;
    for (const sku of outcomeSkus) {
      // Measure over the COVERED span; a partial window's expectation is
      // pro-rated to the same span, so partial lift is apples-to-apples.
      const sold = unitsBetween(daily, sku, rec.rec_date, coveredEnd);
      unitsSold += sold;
      const baseUnits = unitsBetween(daily, sku, addDays(rec.rec_date, -BASELINE_DAYS), rec.rec_date);
      let expectedSku = 0;
      // A baseline window with NO open days is unmeasurable, not infinite.
      // Dividing by it would produce Infinity, which then propagates through
      // `expected` and makes lift 0 - reporting "this did nothing" for a store
      // that was shut. `liftFor` in lib/lift.js refuses the same case; this
      // inline path has to refuse it too until the two are merged.
      if (baseUnits > 0 && baselineOpenDays > 0 && coveredOpenDays > 0) {
        baselinedActual += sold;
        // OPEN DAYS IN BOTH WINDOWS (sheet 19).
        //
        // This was `(baseUnits / BASELINE_DAYS) * coveredDays` - CALENDAR days
        // on both sides. The store-level rate above was fixed to open days long
        // ago; this per-recommendation one was missed, and it is the figure the
        // gate and calibration actually consume.
        //
        // Bethany closes Sundays plus three holidays: 200 closed days of 1,360,
        // so a 28-calendar-day window there holds 23 open days. Stores 101, 102
        // and 103 are worse - 22 of 28. The error is the MISMATCH between the
        // two windows' open fractions, so it does not cancel: a baseline period
        // with four Sundays measured against a window with five produces a lift
        // that is wrong by the difference, in whichever direction the calendar
        // happened to fall.
        expectedSku = (baseUnits / baselineOpenDays) * coveredOpenDays;
        expected += expectedSku;
      } else {
        upsideUnits += sold;
      }
      // Dollar attribution: prefer rec-time snapshot price/cost, fall back to
      // current. "Extra" is sold minus what the baseline predicted.
      const st = recState.get(sku);
      const cur = currentBySku.get(sku);
      const price = st && st.price != null ? Number(st.price)
        : cur && cur.price != null ? Number(cur.price) : null;
      const cost = st && st.cost != null ? Number(st.cost)
        : cur && cur.cost != null ? Number(cur.cost) : null;
      if (price != null) {
        const extra = sold - expectedSku;
        revenueImpact += extra * price;
        priceKnown = true;
        if (cost != null) {
          marginImpact += extra * (price - cost);
          costKnown = true;
        }
      }
    }
    let unitsInValidity = null;
    if (rec.valid_through) {
      const validEnd = rec.valid_through < coveredEnd ? rec.valid_through : coveredEnd;
      unitsInValidity = outcomeSkus.reduce(
        (sum, sku) => sum + unitsBetween(daily, sku, rec.rec_date, validEnd), 0
      );
    }

    // The zero-baseline "pure upside" bar scales with the MEASURED span - 3
    // units in a week is a signal, 3 units in 90 days is noise.
    const zeroBaselineMin = zeroBaselineMinUnits(coveredDays);

    let lift = null;
    let outcomeScore = null;
    const roundedExpected = Math.round(expected * 100) / 100;
    if (expected > 0) {
      lift = Math.round((baselinedActual / expected) * 100) / 100;
      outcomeScore = Math.round(squashLift(baselinedActual / expected) * 1000) / 1000;
    } else if (upsideUnits >= zeroBaselineMin) {
      outcomeScore = ZERO_BASELINE_SCORE; // sold with no history at all - pure upside
    }

    const { taken, evidence } = detectAction({
      rec, windowEndIso, frontier,
      stateBySku: recState,
      currentBySku, purchasesDaily, invoicesDaily, daily,
      stockNewArrival: arrival || null,
    });
    // THE OWNER'S CLAIM NO LONGER FILLS action_taken (migration 039).
    //
    // This used to read: if the detectors saw nothing and the owner said
    // 'did' or 'did_not', set action_taken from the claim and label the
    // evidence 'owner_reported'. That value then went into blendScore at
    // ACTION_WEIGHT and into verdictOf's actionKnown, so a click moved the
    // score and the verdict, and summary.acted_as_recommended counted it
    // beside purchase orders. action_taken now means only what a detector
    // saw: true, false with full visibility, or null. The claim is KEPT -
    // here, named as a claim, and in recommendations.fulfilment_state, where
    // the machine says how it relates to the data.
    if (rec.action_claim === 'did' || rec.action_claim === 'did_not') {
      evidence.claim = rec.action_claim;
    }
    if (!detectionsByRec.has(rec.id)) detectionsByRec.set(rec.id, []);
    detectionsByRec.get(rec.id).push({
      windowDays, windowEndIso, isPartial, taken,
      // A copy taken NOW, before the quantities / grade / partial markers
      // are folded in below: the machine reads the detector's answer, not
      // the whole evaluation row.
      evidence: JSON.parse(JSON.stringify(evidence)),
    });
    if (upsideUnits > 0) evidence.zero_baseline_units = upsideUnits;
    if (expected === 0 && outcomeScore === ZERO_BASELINE_SCORE) evidence.zero_baseline = true;
    if (isPartial) evidence.partial = { covered_days: coveredDays, of_days: windowDays };
    // Quantity-hint compliance - recorded as evidence, never scored (unit
    // ambiguity: "3 cases" vs "18 bottles").
    const hintRange = parseQuantityHint(rec.quantity_hint);
    if (hintRange) evidence.quantity_hint_range = hintRange;

    // ── The quantities (migration 035) - recorded, never scored ──────────
    //
    // WHAT WAS ASKED FOR. The canonical order quantity the card printed,
    // which `suggested_order_qty` has carried since migration 007 and this
    // service never read. The hint's parsed range is the wrong figure: a
    // stockout card reads "about 8 units to cover the next 14 days ...
    // between 5 and 30 units", so `high` is the predictive band's top, and
    // on a markdown card it is the on-shelf count. The hint is the fallback
    // only for a BUY card with no column value (LLM-path pre_stock, rows
    // older than 007), and the evidence says which source was used.
    const recommendedQty = rec.suggested_order_qty != null
      ? Number(rec.suggested_order_qty)
      : RESTOCK_ACTIONS.has(rec.action_type) && hintRange ? hintRange.high : null;
    const recommendedQtySource = rec.suggested_order_qty != null
      ? 'suggested_order_qty' : recommendedQty != null ? 'quantity_hint_high' : null;
    // WHAT WAS BOUGHT. Same arithmetic the action detector runs, so the two
    // cannot disagree; NULL with a reason when nothing can speak.
    const bought = purchasedQuantityFor({
      rec, windowEndIso, frontier,
      stateBySku: recState, currentBySku, purchasesDaily, invoicesDaily, daily,
      invoiceAdmitted,
    });
    // WHAT WAS ON THE SHELF. At issue: the engine's own count (the figure the
    // cover claim was made on) where it recorded one, else the rec-time
    // snapshot - the two are the same POS count read minutes apart, and the
    // evidence names which. At window end: the latest nightly count inside
    // the window, dated, because the series is sparse.
    const qtySku = (rec.primary_skus || [])[0] || null;
    const issueState = qtySku ? recState.get(qtySku) : null;
    const issueOnHand = rec.engine_on_hand != null ? Number(rec.engine_on_hand)
      : issueState && issueState.on_hand != null ? Number(issueState.on_hand) : null;
    const issueOnHandSource = rec.engine_on_hand != null ? 'engine_on_hand'
      : issueOnHand != null ? 'rec_time_snapshot' : null;
    const endObs = qtySku ? onHandAtWindowEnd(onHandSeries.get(qtySku), rec.rec_date, windowEndIso) : null;
    const unitsUnsold = recommendedQty != null ? Math.max(0, recommendedQty - unitsSold) : null;
    evidence.quantities = {
      recommended_qty: recommendedQty, recommended_qty_source: recommendedQtySource,
      purchased_qty: bought.qty, purchased_qty_source: bought.source,
      ...(bought.reason ? { purchased_qty_note: bought.reason } : {}),
      on_hand_at_issue: issueOnHand, on_hand_at_issue_source: issueOnHandSource,
      on_hand_at_window_end: endObs ? endObs.on_hand : null,
      on_hand_observed_on: endObs ? endObs.day : null,
      units_unsold: unitsUnsold,
    };

    // ── The stockout grade (item 14) - the 30-day window only ─────────────
    let grade = UNGRADED(null);
    if (isStockoutCard(rec)) {
      grade = windowDays === STOCKOUT_GRADE_WINDOW_DAYS
        ? gradeStockout({
          rec, sku: qtySku, windowEndIso, coveredEnd, isPartial, frontier,
          issueOnHand, issueOnHandSource, daily, purchasesDaily,
          series: qtySku ? onHandSeries.get(qtySku) : null,
          // The grade's delivery evidence stays feed / nightly counts / stock
          // delta (035's delivery_evidence CHECK names those three); the
          // invoice is passed so the inflow figures agree, not as a dated
          // delivery - an invoice date is when it was billed, not shelved.
          flow: qtySku ? skuInflow(qtySku, {
            rec, windowEndIso, frontier,
            state: issueState, current: currentBySku.get(qtySku),
            purchasesDaily, invoicesDaily, daily,
          }) : { po_units: null, net_inflow: null, threshold: null, capture_late: null, attributable: null },
        })
        : UNGRADED(`graded on the ${STOCKOUT_GRADE_WINDOW_DAYS}-day window only`);
      evidence.stockout_grade = {
        ...grade,
        family_source: rec.engine_family != null ? 'engine_family' : 'cover_below_horizon_fallback',
      };
    }

    // Dollar claims only ride on a measurable outcome - no outcome, no number.
    const revenueOut = outcomeScore != null && priceKnown
      ? Math.round(revenueImpact * 100) / 100 : null;
    const marginOut = outcomeScore != null && costKnown
      ? Math.round(marginImpact * 100) / 100 : null;

    const voteUps = rec.vote === 1 ? 1 : 0;
    const voteDowns = rec.vote === 0 ? 1 : 0;
    const { finalScore, voteComponent } = blendScore({
      outcomeScore, actionTaken: taken, voteUps, voteDowns,
    });
    const verdict = verdictOf({
      finalScore,
      outcomeMeasurable: outcomeScore != null,
      actionKnown: taken === true || taken === false,
    });

    const cols = ['rec_id', 'client_id', 'location_id', 'window_days', 'data_through',
      'units_sold', 'expected_units', 'units_in_validity', 'lift', 'outcome_score',
      'action_taken', 'action_evidence', 'vote_ups', 'vote_downs', 'vote_component',
      'final_score', 'verdict'];
    const vals = [
      rec.id, clientId, locationId, windowDays, frontier, unitsSold,
      roundedExpected, unitsInValidity, lift, outcomeScore, taken,
      JSON.stringify(evidence), voteUps, voteDowns, voteComponent, finalScore, verdict,
    ];
    if (hasExtensions) {
      cols.push('revenue_impact', 'margin_impact');
      vals.push(revenueOut, marginOut);
    }
    const updates = cols
      .filter((c) => !['rec_id', 'client_id', 'location_id', 'window_days'].includes(c))
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(', ');
    await analyticsPool.query(
      `INSERT INTO recommendation_evaluations (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (rec_id, window_days) DO UPDATE SET evaluated_at = now(), ${updates}`,
      vals
    );
    // ── Sheet 19: the outcome row, shown and withheld alike ──────────────
    //
    // Written alongside the evaluation rather than instead of it: the two
    // answer different questions. `recommendation_evaluations` is the
    // per-window scoring detail this service has always kept;
    // `recommendation_outcomes` is the LOOP - one row per recommendation per
    // window, in the shape calibration, k and the gate consume.
    //
    // Best-effort. A failure to record an outcome must never lose an
    // evaluation that was computed correctly, and the two tables are allowed
    // to disagree about whether a row exists - never about what it says.
    try {
      await outcomeSvc.recordOutcome(analyticsPool, {
        recommendation_id: rec.id,
        client_id: clientId,
        location_id: locationId,
        sku: (rec.primary_skus || [])[0] || '',
        family: rec.action_type || '',
        // THE ARM, as persisted. Not re-derived - see the SELECT above.
        arm: rec.status === 'holdout' ? 'withheld' : 'shown',
        // THE THREE QUANTITIES, at last. `recommended_qty` was null on every
        // row ever written (an object indexed as an array), then briefly the
        // hint's high end, which is the wrong figure - see the block that
        // computes `recommendedQty`. `actual_purchased_qty` was hard-coded
        // null with the comment "no purchase-order feed for every store",
        // which is true and is exactly what `purchased_qty_source` now says
        // per row, instead of saying nothing for the stores that HAVE one.
        recommended_qty: recommendedQty,
        actual_purchased_qty: bought.qty,
        purchased_qty_source: bought.source,
        actual_units_sold: unitsSold,
        units_unsold: unitsUnsold,
        on_hand_at_issue: issueOnHand,
        on_hand_at_window_end: endObs ? endObs.on_hand : null,
        on_hand_observed_on: endObs ? endObs.day : null,
        // The stockout grade: all NULL for a card that is not a stockout
        // card, and NULL with a reason for one that could not be graded.
        sold_through: grade.sold_through,
        days_to_sell_through: grade.days_to_sell_through,
        delivery_observed_on: grade.delivery_observed_on,
        delivery_evidence: grade.delivery_evidence,
        sold_through_reason: grade.sold_through_reason,
        window_start: rec.rec_date,
        // THE NOMINAL END, NOT THE FRONTIER.
        //
        // The unique key here is (recommendation_id, window_start, window_end)
        // and the ON CONFLICT that uses it states the intent exactly: "Two rows
        // for one window would each be counted as independent evidence by the
        // gate, which is how 30 outcomes becomes 60 without 30 more facts."
        // That is right, and passing `coveredEnd` defeated it - the frontier
        // moves every night, so the key changed, nothing ever conflicted, and a
        // card collected one row per nightly re-score until its window closed.
        //
        // Measured on the live table before this change: 444 rows for 284
        // card-windows, 284 of them mid-window snapshots at spans of 4, 10, 12,
        // 24, 26 and 39 days. Two thirds of the evidence base was the same
        // cards counted again.
        //
        // The nominal end is a pure function of (rec_date, window_days), so it
        // is fixed for the life of the card and a re-score now UPDATES in
        // place. How much of the window the data actually covers is not lost:
        // `open_days_in_window` carries it and `snapshot_id` carries the
        // frontier it was measured at.
        window_end: windowEndIso,
        open_days_in_window: coveredOpenDays,
        baseline_open_days: baselineOpenDays,
        baseline_units: null,
        lift,
        lift_reason: lift === null
          ? (expected === 0
            ? 'the baseline projects zero units over this window'
            : 'no SKU on this recommendation had a trailing baseline')
          : null,
        expected_units: roundedExpected,
        upside_units: upsideUnits,
        stated_confidence: rec.confidence ?? null,
        // Calibrated confidence arrives once sheet 08's curve is fitted - which
        // needs THIS table. NULL until then rather than a copy of the stated
        // value, which would make the calibration fit itself.
        calibrated_confidence: null,
        evidence_state: null,
        own_weight: null,
        cohort_level: null,
        cohort_size: null,
        model_version: rec.model_version ?? null,
        feature_version: FEATURE_VERSION,
        config_version: 'default',
        snapshot_id: frontier,
      });
    } catch (outcomeErr) {
      logger.warn('[RecEval] outcome row not recorded', {
        error: outcomeErr.message, recId: rec.id,
      });
    }

    evaluated++;
  }

  // ── The fulfilment state, per CARD (migration 039) ─────────────────────
  //
  // One state for the card from everything its windows saw tonight. Any
  // window whose detector said TRUE confirms it; otherwise the longest window
  // evaluated speaks, and "closed" is the 30-day horizon against the data
  // frontier (see FULFILMENT_WINDOW_DAYS). Cards too young for any window
  // (fewer than PARTIAL_MIN_DAYS of sales) are stated with no detection, so a
  // fresh endcap reads 'unobservable' and a fresh claim reads 'claimed'
  // rather than both sitting at the column default.
  //
  // Best-effort per card, like the outcome row: a failed UPDATE must never
  // lose an evaluation that was computed correctly. The writer itself never
  // downgrades a confirmed card.
  const fulfilment = await stateFulfilment(dueRecs, detectionsByRec);

  return { evaluated, pending, fulfilment };

  /**
   * The pass itself, as a local function because it runs from two places:
   * here, after the windows were scored, and at the early return above when
   * nothing was due tonight but young cards still need their first state.
   */
  async function stateFulfilment(statedDueRecs, detections) {
    const out = { stated: 0, by_state: {} };
    if (!hasFulfilment) return out;
    const today = toDateOnly(new Date());
    const dueIds = new Set(statedDueRecs.map((r) => r.id));
    const young = recs.filter((r) => !dueIds.has(r.id)
      && !EVAL_WINDOWS.some((w) => existingByKey.has(`${r.id}:${w}`)));
    for (const rec of [...statedDueRecs, ...young]) {
      const seen = detections.get(rec.id) || [];
      const confirmedBy = seen.find((d) => d.taken === true
        && CONFIRMING_DETECTORS.has(decidingDetector(d.evidence, true)));
      const longest = seen.slice().sort((a, b) => b.windowDays - a.windowDays)[0] || null;
      const speaks = confirmedBy || longest;
      const decision = fulfilmentFrom({
        actionType: rec.action_type,
        detection: speaks ? { taken: speaks.taken, evidence: speaks.evidence } : null,
        claim: rec.action_claim || null,
        validThrough: rec.valid_through || null,
        windowClosed: frontier >= addDays(rec.rec_date, FULFILMENT_WINDOW_DAYS),
        today,
        window: speaks
          ? { days: speaks.windowDays, end: speaks.windowEndIso, data_through: frontier, partial: speaks.isPartial }
          : { days: null, end: null, data_through: frontier, note: `fewer than ${PARTIAL_MIN_DAYS} days of sales since the card` },
      });
      try {
        const stored = await writeFulfilment(analyticsPool, clientId, locationId, rec.id, decision);
        if (stored) {
          out.stated += 1;
          out.by_state[stored.fulfilment_state] = (out.by_state[stored.fulfilment_state] || 0) + 1;
        }
      } catch (fulErr) {
        logger.warn('[RecEval] fulfilment state not written', { error: fulErr.message, recId: rec.id });
      }
    }
    return out;
  }
}

/** Cron entry: capture missing baselines + evaluate due, across all tenants with recs. */
async function evaluateAllTenants(analyticsPool, opts = {}) {
  if (!(await evalTablesExist(analyticsPool))) {
    logger.warn('[RecEval] tables missing, apply analytics migration 002 (npm run migrate)');
    return { tenants: 0, evaluated: 0 };
  }
  const tenants = await analyticsPool.query(
    'SELECT DISTINCT client_id, location_id FROM recommendations'
  );
  let evaluated = 0;
  for (const t of tenants.rows) {
    try {
      await captureMissing(analyticsPool, t.client_id, t.location_id, opts);
      const res = await evaluateTenant(analyticsPool, t.client_id, t.location_id, opts);
      evaluated += res.evaluated;
    } catch (err) {
      logger.error('[RecEval] tenant failed', {
        clientId: t.client_id, locationId: t.location_id, error: err.message,
      });
    }
  }
  return { tenants: tenants.rows.length, evaluated };
}

// ─── Read APIs ───────────────────────────────────────────────────────────────

/** All evaluated windows for one rec (tenant-checked). vote_ups/vote_downs are
 * base-schema columns; the dollar columns ride the migration-003 probe.
 * data_through ships as to_char'd text (house rule): a bare DATE would parse
 * to server-local midnight and shift a calendar day for viewers west of the
 * server - same reason fetchEvaluatedRows carries data_through_day. */
async function getRecEvaluations(analyticsPool, clientId, locationId, recId) {
  if (!(await evalTablesExist(analyticsPool))) return [];
  const hasExtensions = await extensionsExist(analyticsPool).catch(() => false);
  const { rows } = await analyticsPool.query(
    `SELECT window_days, evaluated_at,
            to_char(data_through, 'YYYY-MM-DD') AS data_through,
            units_sold, expected_units,
            units_in_validity, lift, outcome_score, action_taken, action_evidence,
            vote_ups, vote_downs, vote_component, final_score, verdict
            ${hasExtensions ? ', revenue_impact, margin_impact' : ''}
       FROM recommendation_evaluations
      WHERE rec_id = $1 AND client_id = $2 AND location_id = $3
      ORDER BY window_days`,
    [recId, clientId, locationId]
  );
  return rows;
}

/** Clamp ?window= to a configured evaluation window (default 30 when configured). */
function normalizeWindow(windowDays) {
  return EVAL_WINDOWS.includes(windowDays) ? windowDays
    : EVAL_WINDOWS.includes(30) ? 30 : EVAL_WINDOWS[0];
}

/** Clamp the ?days= history bound to 1..365 (default SUMMARY_DEFAULT_DAYS). */
function normalizeSince(sinceDays) {
  return Math.min(Math.max(sinceDays || SUMMARY_DEFAULT_DAYS, 1), 365);
}

/**
 * The ONE query behind both the effectiveness report and the ledger: every
 * evaluated (rec × this window) for the tenant within the history bound,
 * including holdout rows - callers MUST split those out (status === 'holdout')
 * before showing anything owner-facing. Keeping report + ledger on the same
 * fetch means the two views can never disagree about what exists.
 * data_through is also shipped as to_char'd text (data_through_day): bare DATE
 * parses to local midnight and shifts a day on non-UTC servers (house rule).
 */
async function fetchEvaluatedRows(analyticsPool, clientId, locationId, window, since, hasExtensions) {
  const hasClaims = await actionClaimColumnExists(analyticsPool).catch(() => false);
  const hasFulfilment = hasClaims && await fulfilmentColumnsExist(analyticsPool).catch(() => false);
  const { rows } = await analyticsPool.query(
    `SELECT e.rec_id, e.units_sold, e.expected_units, e.lift, e.outcome_score,
            e.action_taken, e.vote_component, e.final_score, e.verdict, e.data_through,
            to_char(e.data_through, 'YYYY-MM-DD') AS data_through_day,
            e.action_evidence -> 'partial' AS evidence_partial,
            -- The whole evidence, so the read can name the DETECTOR that
            -- decided action_taken and tell a feed row from an owner report
            -- (the fallback in effectiveFulfilment needs exactly that).
            e.action_evidence,
            r.category, r.action_type, r.primary_skus, r.signals_cited, r.rationale,
            r.confidence, r.created_at, r.status, r.vote
            ${hasClaims ? ', r.action_claim, r.action_claim_at' : ''}
            ${hasFulfilment ? ', r.fulfilment_state, r.fulfilment_confirmed_at, r.fulfilment_checked_at' : ''}
            ${hasExtensions ? ', e.revenue_impact, e.margin_impact' : ''}
       FROM recommendation_evaluations e
       JOIN recommendations r ON r.id = e.rec_id
      WHERE e.client_id = $1 AND e.location_id = $2 AND e.window_days = $3
        AND r.created_at >= now() - make_interval(days => $4)
      ORDER BY e.final_score DESC NULLS LAST`,
    [clientId, locationId, window, since]
  );
  // Stated once here so every consumer (summary, groups, ledger rows) reads
  // the same answer for the same row.
  for (const r of rows) r.fulfilment = effectiveFulfilment(r);
  return rows;
}

/**
 * One owner-facing row (top/bottom lists + the ledger). Extends the original
 * shape ADDITIVELY - revenue_impact / margin_impact / data_through /
 * evidence_partial are new; every field existing consumers read is unchanged.
 * revenue/margin are null until migration 003 + a measurable outcome;
 * evidence_partial is {covered_days, of_days} only for partial windows.
 */
function shapeRow(r) {
  return {
    rec_id: r.rec_id,
    category: r.category,
    action_type: r.action_type,
    primary_skus: r.primary_skus || [],
    rationale_gist: String(r.rationale || '').slice(0, 180),
    created_at: r.created_at,
    units_sold: r.units_sold,
    expected_units: r.expected_units,
    lift: r.lift,
    action_taken: r.action_taken,
    // CONFIRMED ONLY (039). This was `action_taken === true`, which until
    // this change included owner-reported fills; the fulfilment state is the
    // one place that distinguishes a purchase order from a click.
    acted_as_recommended: r.fulfilment === 'confirmed',
    fulfilment_state: r.fulfilment || null,
    // Which detector decided action_taken for this window - purchase_orders,
    // invoice, stock_delta, price, catalog_registry, unobservable, none - so
    // the case file can say WHAT was checked, not just whether.
    detector: decidingDetector(r.action_evidence, r.action_taken),
    action_claim: r.action_claim || null,
    action_claim_at: r.action_claim_at || null,
    final_score: r.final_score,
    verdict: r.verdict,
    revenue_impact: r.revenue_impact != null ? Number(r.revenue_impact) : null,
    margin_impact: r.margin_impact != null ? Number(r.margin_impact) : null,
    data_through: r.data_through_day || null,
    evidence_partial: r.evidence_partial || null,
    // The store's own thumbs on this rec (1/0/NULL column → 'up'/'down'/null)
    // so the case row can show + flip it in place.
    user_vote: r.vote == null ? null : (Number(r.vote) === 1 ? 'up' : 'down'),
  };
}

/**
 * The effectiveness report for one store: summary + per-category /
 * per-action / per-signal breakdowns + best and worst recs, for one window.
 */
async function getEffectiveness(analyticsPool, clientId, locationId, { windowDays, sinceDays } = {}) {
  if (!(await evalTablesExist(analyticsPool))) {
    return { available: false, reason: 'Evaluation tables not provisioned yet (analytics migration 002).' };
  }
  const window = normalizeWindow(windowDays);
  const since = normalizeSince(sinceDays);
  const hasExtensions = await extensionsExist(analyticsPool).catch(() => false);

  const allRows = await fetchEvaluatedRows(analyticsPool, clientId, locationId, window, since, hasExtensions);

  // Holdout recs (generated but deliberately never shown - REC_HOLDOUT_PCT
  // experiment) are excluded from the owner-facing lists and counted only in
  // the shown-vs-holdout comparison below.
  const holdoutRows = allRows.filter((r) => r.status === 'holdout');
  const rows = allRows.filter((r) => r.status !== 'holdout');

  const measurable = rows.filter((r) => r.verdict !== 'insufficient_data');
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
  // Averages use the CAPPED lift - one 40x outlier (tiny baseline) must not
  // swamp a mean the owner reads as "how well do recs work here".
  const cappedLift = (r) => (r.lift != null ? Math.min(Number(r.lift), LIFT_CAP) : null);

  const groupBy = (keyFn) => {
    const groups = new Map();
    for (const r of measurable) {
      for (const key of keyFn(r)) {
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
    }
    return [...groups.entries()]
      .map(([key, list]) => ({
        key,
        recs: list.length,
        winners: list.filter((r) => r.verdict === 'winner').length,
        underperformers: list.filter((r) => r.verdict === 'underperformer').length,
        // Follow-through per group: did the store act, and did acting pay off?
        // `acted` is CONFIRMED by data (039); the owner's unconfirmed word is
        // `claimed`, counted apart, and `not_followed` is a measured absence.
        acted: list.filter((r) => r.fulfilment === 'confirmed').length,
        acted_won: list.filter((r) => r.fulfilment === 'confirmed' && r.verdict === 'winner').length,
        claimed: list.filter((r) => r.fulfilment === 'claimed').length,
        not_followed: list.filter((r) => r.fulfilment === 'not_followed').length,
        avg_score: mean(list.map((r) => r.final_score).filter((s) => s != null)),
        avg_lift: mean(list.map(cappedLift).filter((l) => l != null)),
      }))
      .sort((a, b) => (b.avg_score ?? -1) - (a.avg_score ?? -1));
  };

  // "Acted" is CONFIRMED BY DATA (039) - a purchases-feed row, a matched
  // invoice, an attributable stock inflow, a price drop, a catalogue arrival.
  // It was `action_taken === true`, which until 039 an owner's click could
  // fill. The click is now counted on its own line as `claimed`.
  const acted = rows.filter((r) => r.fulfilment === 'confirmed');
  const claimedRows = rows.filter((r) => r.fulfilment === 'claimed');
  const notFollowedRows = rows.filter((r) => r.fulfilment === 'not_followed');
  const actionKnown = rows.filter((r) => r.action_taken === true || r.action_taken === false);

  // Follow-through split over MEASURABLE rows only so "winners of n" always
  // means something. A bucket stays null until it holds n >= 3 (server-side
  // gate: tiny samples never render). One bucket per fulfilment state, plus
  // the three legacy names the page already reads: `acted` IS the confirmed
  // bucket, `not_acted` the not_followed one, `unknown` everything else.
  const followBucket = (list) => (list.length >= 3
    ? {
        n: list.length,
        winners: list.filter((r) => r.verdict === 'winner').length,
        avg_lift: mean(list.map(cappedLift).filter((l) => l != null)),
      }
    : null);
  const byState = (state) => measurable.filter((r) => r.fulfilment === state);
  const followthrough = {
    confirmed: followBucket(byState('confirmed')),
    claimed: followBucket(byState('claimed')),
    not_followed: followBucket(byState('not_followed')),
    unobservable: followBucket(byState('unobservable')),
    pending: followBucket(measurable.filter((r) => r.fulfilment === 'pending' || r.fulfilment === 'expired')),
    acted: followBucket(byState('confirmed')),
    not_acted: followBucket(byState('not_followed')),
    unknown: followBucket(measurable.filter((r) => !['confirmed', 'not_followed'].includes(r.fulfilment))),
  };

  // Freshness: the newest sales day any of these evaluations has seen
  // ("measured through <date>"). Text compare is safe on YYYY-MM-DD.
  const dataThroughMax = rows.reduce(
    (max, r) => (r.data_through_day && (!max || r.data_through_day > max) ? r.data_through_day : max),
    null
  );

  // Dollar attribution (migration 003): summed over measurable shown recs.
  const sumImpact = (key) => {
    if (!hasExtensions) return null;
    const vals = measurable.map((r) => r[key]).filter((v) => v != null).map(Number);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  };

  // Where the dollars actually came from - so the UI can headline what the
  // WORKED calls earned and never blame Botella for a miss the owner didn't
  // act on. missed_acted: underperformers with a detected action (a real cost,
  // worth the owner's review); missed_unacted: underperformers with no action
  // seen (the product fell short of its own baseline on its own - following
  // the advice cost the store nothing there). All null until migration 003.
  const sumOver = (list) => {
    if (!hasExtensions) return null;
    const vals = list.map((r) => r.revenue_impact).filter((v) => v != null).map(Number);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  };
  const missedRows = measurable.filter((r) => r.verdict === 'underperformer');
  const dollars = {
    won: sumOver(measurable.filter((r) => r.verdict === 'winner')),
    missed_acted: sumOver(missedRows.filter((r) => r.fulfilment === 'confirmed')),
    missed_unacted: sumOver(missedRows.filter((r) => r.fulfilment !== 'confirmed')),
    missed_acted_count: missedRows.filter((r) => r.fulfilment === 'confirmed').length,
    missed_unacted_count: missedRows.filter((r) => r.fulfilment !== 'confirmed').length,
  };

  // Shown-vs-holdout: the honesty check - did recommending actually move
  // anything, or would it have sold anyway? Only rendered once holdout data
  // exists (REC_HOLDOUT_PCT > 0 for a while).
  const holdoutMeasurable = holdoutRows.filter((r) => r.verdict !== 'insufficient_data');
  const holdout = holdoutMeasurable.length >= 3
    ? {
        shown_avg_lift: mean(measurable.map(cappedLift).filter((l) => l != null)),
        holdout_avg_lift: mean(holdoutMeasurable.map(cappedLift).filter((l) => l != null)),
        shown_recs: measurable.length,
        holdout_recs: holdoutMeasurable.length,
      }
    : null;

  // Owner answers ("did you do this?") and how many are still waiting for
  // sales data before they can count - without this, an answer given about a
  // fresh rec looks ignored until its first evaluation lands.
  let ownerAnswers = null;
  if (await actionClaimColumnExists(analyticsPool).catch(() => false)) {
    const claims = await analyticsPool.query(
      `SELECT count(*)::int AS answered,
              count(*) FILTER (
                WHERE NOT EXISTS (
                  SELECT 1 FROM recommendation_evaluations e2 WHERE e2.rec_id = r.id
                )
              )::int AS pending_measurement
         FROM recommendations r
        WHERE r.client_id = $1 AND r.location_id = $2
          AND r.action_claim IN ('did', 'did_not')
          AND r.created_at >= now() - make_interval(days => $3)`,
      [clientId, locationId, since]
    );
    ownerAnswers = claims.rows[0];
  }

  // Anonymized network benchmark: this store vs every tenant with enough
  // evaluated data (≥5 measurable) - averages only, no store identities.
  let network = null;
  try {
    const bench = await analyticsPool.query(
      `SELECT count(*)::int AS stores,
              ROUND(AVG(win_rate)::numeric, 2)::float AS avg_win_rate,
              ROUND(AVG(avg_lift)::numeric, 2)::float AS avg_lift
         FROM (
           SELECT e.client_id, e.location_id,
                  AVG(CASE WHEN e.verdict = 'winner' THEN 1.0 ELSE 0.0 END) AS win_rate,
                  AVG(LEAST(e.lift, $2::real)) AS avg_lift
             FROM recommendation_evaluations e
            WHERE e.window_days = $1 AND e.verdict <> 'insufficient_data'
            GROUP BY e.client_id, e.location_id
           HAVING count(*) >= 5
         ) per_store`,
      [window, LIFT_CAP]
    );
    const b = bench.rows[0];
    if (b && b.stores > 0) {
      network = {
        stores: b.stores,
        avg_win_rate: b.avg_win_rate,
        avg_lift: b.avg_lift,
        this_store_win_rate: measurable.length
          ? Math.round((count('winner') / measurable.length) * 100) / 100
          : null,
      };
    }
  } catch (err) {
    logger.warn(`[RecEval] network benchmark skipped: ${err.message}`);
  }

  // CAN ANYTHING HERE BE CONFIRMED AT ALL?
  //
  // `confirmed: 0` was the only thing the screen knew, so it printed the
  // money anyway: "$-71,125 - 0 confirmed done by your data". At a store
  // whose POS has never synced an order, every card is ungradeable and that
  // figure is their sum - arithmetic on an absence, read by the owner as a
  // verdict on their buying. The report now carries the REASON so the screen
  // can say "we cannot see your orders" instead of inventing a loss.
  //
  // Probed from the feed rather than inferred from these rows: rows written
  // before migration 039 carry no reason at all, and a dead feed would then
  // be indistinguishable from a store that ignored every card.
  const earliestRec = rows
    .map((r) => (r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : null))
    .filter(Boolean)
    .sort()[0] || null;
  const purchaseFeed = await probePurchaseFeed(clientId, locationId, earliestRec);

  return {
    available: true,
    window_days: window,
    since_days: since,
    windows_configured: EVAL_WINDOWS,
    purchase_feed: purchaseFeed,
    summary: {
      evaluated: rows.length,
      measurable: measurable.length,
      winners: count('winner'),
      neutral: count('neutral'),
      underperformers: count('underperformer'),
      insufficient_data: count('insufficient_data'),
      avg_lift: mean(measurable.map(cappedLift).filter((l) => l != null)),
      avg_score: mean(measurable.map((r) => r.final_score).filter((s) => s != null)),
      // "You did what Botella suggested" - the observable-compliance story.
      // acted_as_recommended is CONFIRMED BY DATA only (039); the owner's
      // unconfirmed word is `claimed`, and a measured absence is
      // `not_followed`. None of the three is ever folded into another.
      action_observable: actionKnown.length,
      acted_as_recommended: acted.length,
      acted_and_won: acted.filter((r) => r.verdict === 'winner').length,
      confirmed: acted.length,
      claimed: claimedRows.length,
      not_followed: notFollowedRows.length,
      // The dollar story (null until migration 003 + measurable outcomes).
      revenue_impact: sumImpact('revenue_impact'),
      margin_impact: sumImpact('margin_impact'),
      dollars,
      // Micro-question answers: total given, and how many still await their
      // first measurable sales window before they can count.
      owner_answers: ownerAnswers,
    },
    holdout,
    network,
    followthrough,
    data_through_max: dataThroughMax,
    by_category: groupBy((r) => [r.category]),
    by_action_type: groupBy((r) => [r.action_type]),
    by_signal: groupBy((r) => (r.signals_cited || []).slice(0, 6)).slice(0, 12),
    top: measurable.filter((r) => r.verdict === 'winner').slice(0, 5).map(shapeRow),
    bottom: measurable.filter((r) => r.verdict === 'underperformer').slice(-5).reverse().map(shapeRow),
  };
}

// ─── The ledger (Phase 1) ────────────────────────────────────────────────────

const LEDGER_SORTS = new Set(['impact', 'lift', 'date']);
const LEDGER_DEFAULT_LIMIT = 50;
const LEDGER_MAX_LIMIT = 200;

/**
 * The effectiveness LEDGER: every evaluated, owner-visible rec for one window
 * as a flat, filterable, pageable list - the exact query + holdout exclusion
 * getEffectiveness uses, minus the top5/bottom5 truncation. Filters run in
 * memory over the identical row set so report and ledger can never disagree.
 *
 * Filters (all optional): verdict (winner/neutral/underperformer/
 * insufficient_data), category, signal (matches signals_cited membership),
 * acted ('true' | 'false' | 'unknown' - detector tri-state, never conflated).
 * Sort: 'impact' (revenue_impact desc, default) | 'lift' | 'date'; unknown
 * values fall back to impact. Nulls always sort last; ties break newest-first.
 */
async function getEffectivenessLedger(analyticsPool, clientId, locationId, {
  windowDays, sinceDays, verdict, category, signal, acted, sort, limit, offset,
} = {}) {
  if (!(await evalTablesExist(analyticsPool))) {
    return {
      available: false,
      reason: 'Evaluation tables not provisioned yet (analytics migration 002).',
      total: 0,
      rows: [],
    };
  }
  const window = normalizeWindow(windowDays);
  const since = normalizeSince(sinceDays);
  const hasExtensions = await extensionsExist(analyticsPool).catch(() => false);

  const allRows = await fetchEvaluatedRows(analyticsPool, clientId, locationId, window, since, hasExtensions);
  // Holdout recs never reach owner-facing lists (same rule as getEffectiveness).
  let rows = allRows.filter((r) => r.status !== 'holdout');

  if (verdict) rows = rows.filter((r) => r.verdict === verdict);
  if (category) rows = rows.filter((r) => r.category === category);
  if (signal) rows = rows.filter((r) => (r.signals_cited || []).includes(signal));
  // 'true' is CONFIRMED by data (039), 'false' a measured not_followed, and
  // 'unknown' everything the data has not decided - claimed included, because
  // an owner's word is not a detector's answer.
  if (acted === 'true') rows = rows.filter((r) => r.fulfilment === 'confirmed');
  else if (acted === 'false') rows = rows.filter((r) => r.fulfilment === 'not_followed');
  else if (acted === 'unknown') rows = rows.filter((r) => !['confirmed', 'not_followed'].includes(r.fulfilment));

  const byDateDesc = (a, b) => new Date(b.created_at) - new Date(a.created_at);
  const descNullsLast = (av, bv) => {
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  };
  const sortKey = LEDGER_SORTS.has(sort) ? sort : 'impact';
  if (sortKey === 'date') {
    rows.sort(byDateDesc);
  } else if (sortKey === 'lift') {
    rows.sort((a, b) =>
      descNullsLast(a.lift != null ? Number(a.lift) : null, b.lift != null ? Number(b.lift) : null)
      || byDateDesc(a, b));
  } else {
    rows.sort((a, b) =>
      descNullsLast(
        a.revenue_impact != null ? Number(a.revenue_impact) : null,
        b.revenue_impact != null ? Number(b.revenue_impact) : null
      ) || byDateDesc(a, b));
  }

  const total = rows.length;
  const lim = Math.min(Math.max(parseInt(limit, 10) || LEDGER_DEFAULT_LIMIT, 1), LEDGER_MAX_LIMIT);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  return {
    available: true,
    window_days: window,
    since_days: since,
    total,
    rows: rows.slice(off, off + lim).map(shapeRow),
  };
}

/**
 * Recommendations from the LATEST run that recommend an observable action the
 * store has NOT taken yet and that are still actionable (valid_through today
 * or later) - the "don't let this expire" nudge list. Runs the same detectors
 * mid-window with windowEnd = the data frontier.
 */
async function getPendingActions(analyticsPool, clientId, locationId, opts = {}) {
  if (!(await evalTablesExist(analyticsPool))) return { available: false, pending: [] };
  // This walk costs several warehouse round-trips (~5-7s observed), and the
  // answer only moves when a new run lands or the store acts - cache it
  // briefly so the tab renders instantly on revisits.
  const cacheKey = `${clientId}:${locationId}`;
  const cached = pendingCache.get(cacheKey);
  if (!opts.nocache && cached && Date.now() - cached.at < PENDING_CACHE_MS) {
    return cached.value;
  }
  const syncgoBase = opts.syncgoPool || getPool();
  const scoped = makeTenantScopedPool(syncgoBase, clientId, locationId);
  const hasUpcColumn = await referenceUpcColumnExists(analyticsPool);

  const runRes = await analyticsPool.query(
    `SELECT id, generated_at FROM recommendation_runs
      WHERE client_id = $1 AND location_id = $2
      ORDER BY generated_at DESC, id DESC LIMIT 1`,
    [clientId, locationId]
  );
  if (!runRes.rows.length) return { available: true, pending: [] };
  const run = runRes.rows[0];
  const recDate = toDateOnly(run.generated_at);

  const observable = [...OBSERVABLE_ACTIONS];
  const hasClaims = await actionClaimColumnExists(analyticsPool).catch(() => false);
  const hasFulfilment = hasClaims && await fulfilmentColumnsExist(analyticsPool).catch(() => false);
  const recsRes = await analyticsPool.query(
    `SELECT r.id, r.category, r.action_type, r.primary_skus, r.rationale, r.confidence,
            r.quantity_hint, r.vote,
            to_char(r.valid_through, 'YYYY-MM-DD') AS valid_through
            ${hasUpcColumn ? ', r.reference_upc' : ''}
            ${hasClaims ? ', r.action_claim, r.action_claim_at' : ''}
            ${hasFulfilment ? ', r.fulfilment_state, r.dismiss_reason' : ''}
       FROM recommendations r
      WHERE r.run_id = $1 AND r.client_id = $2 AND r.location_id = $3
        AND r.action_type = ANY($4)
        AND (r.status IS DISTINCT FROM 'holdout')
        AND (r.valid_through IS NULL OR r.valid_through >= CURRENT_DATE)
        -- A card the owner DISMISSED is not waiting on them: "don't let this
        -- lapse" is a nag when the answer was "no, wrong product". Claimed
        -- cards stay in the list, flagged, so the tab can show "marked done,
        -- awaiting confirmation" instead of asking again (039).
        ${hasClaims ? "AND (r.action_claim IS DISTINCT FROM 'dismissed')" : ''}
        -- A card the data has already confirmed is not pending either, and
        -- needs no re-detection to say so.
        ${hasFulfilment ? "AND (r.fulfilment_state IS DISTINCT FROM 'confirmed')" : ''}`,
    [run.id, clientId, locationId, observable]
  );
  if (!recsRes.rows.length) return { available: true, pending: [] };

  const frontierRes = await scoped.query(
    `SELECT to_char(MAX(sale_date)::date, 'YYYY-MM-DD') AS latest FROM sale_items
      WHERE client_id = $1 AND location_id = $2`,
    [clientId, locationId]
  );
  const frontier = frontierRes.rows[0]?.latest || toDateOnly(new Date());

  const recs = recsRes.rows.map((r) => ({
    ...r, rec_date: recDate,
    primary_skus: r.primary_skus || [],
    reference_upc: r.reference_upc || null,
  }));
  const skus = [...new Set(recs.flatMap((r) => r.primary_skus))];

  const daily = new Map();
  if (skus.length) {
    const sales = await scoped.query(
      `WITH ${SKU_KEYMAP_CTE}, ${VOID_SALES_CTE}
       SELECT ${CANON_SKU} AS sku, to_char(si.sale_date::date, 'YYYY-MM-DD') AS day,
              SUM(si.quantity)::int AS units
         FROM sale_items si ${CANON_JOIN}
        WHERE si.client_id = $1 AND si.location_id = $2 AND ${CANON_SKU} = ANY($3)
          AND si.sale_date >= $4::date
          AND si.quantity > 0 AND ${NOT_VOID}
        GROUP BY ${CANON_SKU}, si.sale_date::date`,
      [clientId, locationId, skus, recDate]
    );
    for (const row of sales.rows) {
      if (!daily.has(row.sku)) daily.set(row.sku, new Map());
      daily.get(row.sku).set(row.day, row.units);
    }
  }
  const stateRows = await analyticsPool.query(
    `SELECT rec_id, sku, on_hand, price, sale_price, weekly_rate, captured_at
       FROM recommendation_sku_state
      WHERE client_id = $1 AND location_id = $2 AND rec_id = ANY($3)`,
    [clientId, locationId, recs.map((r) => r.id)]
  );
  const stateByRec = new Map();
  for (const s of stateRows.rows) {
    if (!stateByRec.has(s.rec_id)) stateByRec.set(s.rec_id, new Map());
    stateByRec.get(s.rec_id).set(s.sku, s);
  }
  const currentBySku = new Map();
  if (skus.length) {
    const current = await scoped.query(
      `SELECT sku, product_name, stock_qty, price, sale_price FROM products
        WHERE client_id = $1 AND location_id = $2 AND sku = ANY($3)`,
      [clientId, locationId, skus]
    );
    current.rows.forEach((p) => currentBySku.set(p.sku, p));
  }
  let purchasesDaily = null;
  if (skus.length && (await purchasesUsable(syncgoBase))) {
    try {
      // Same day expression as evaluateTenant's loader, for the same reason:
      // `date` is -infinity throughout at LiquorPOS stores (purchaseDateSql.js).
      const po = await scoped.query(
        `SELECT sku, to_char(${purchaseDaySql()}::date, 'YYYY-MM-DD') AS day, SUM(quantity)::int AS units
           FROM purchases
          WHERE client_id = $1 AND location_id = $2 AND sku = ANY($3)
            AND ${purchaseDaySaneSql()}
            AND ${purchaseDaySql()} >= $4::date
          GROUP BY sku, ${purchaseDaySql()}::date`,
        [clientId, locationId, skus, recDate]
      );
      purchasesDaily = new Map();
      for (const row of po.rows) {
        if (!purchasesDaily.has(row.sku)) purchasesDaily.set(row.sku, new Map());
        purchasesDaily.get(row.sku).set(row.day, row.units);
      }
    } catch { purchasesDaily = null; }
  }
  // A card the owner's own uploaded invoice proves acted on is not pending.
  const invoicesDaily = await loadInvoicesDaily(analyticsPool, clientId, locationId, skus, recDate);
  const upcs = recs.filter((r) => r.action_type === 'stock_new' && r.reference_upc)
    .map((r) => r.reference_upc);
  const arrivalsByUpc = new Map();
  if (upcs.length) {
    const arrivals = await analyticsPool.query(
      `SELECT upc, sku, MIN(first_seen_at) AS first_seen_at FROM product_first_seen
        WHERE client_id = $1 AND location_id = $2 AND is_baseline IS FALSE AND upc = ANY($3)
        GROUP BY upc, sku`,
      [clientId, locationId, [...new Set(upcs)]]
    );
    for (const a of arrivals.rows) {
      if (toDateOnly(a.first_seen_at) > recDate) {
        arrivalsByUpc.set(a.upc, { sku: a.sku, first_seen: toDateOnly(a.first_seen_at) });
      }
    }
  }

  const today = toDateOnly(new Date());
  const pending = [];
  for (const rec of recs) {
    const { taken, evidence } = detectAction({
      rec, windowEndIso: frontier, frontier,
      stateBySku: stateByRec.get(rec.id) || new Map(),
      currentBySku, purchasesDaily, invoicesDaily, daily,
      stockNewArrival: arrivalsByUpc.get(rec.reference_upc) || null,
    });
    if (taken === true) {
      // Already acted - nothing to nudge. This walk has just done the
      // detectors' work mid-window, so WRITE THE CONFIRMATION THROUGH (039)
      // rather than leave the card reading 'pending' or 'claimed' until the
      // nightly pass gets to it. The writer never downgrades; a failure here
      // is logged and the card simply waits for the cron.
      if (hasFulfilment && CONFIRMING_DETECTORS.has(decidingDetector(evidence, true))) {
        const decision = fulfilmentFrom({
          actionType: rec.action_type, detection: { taken, evidence },
          claim: rec.action_claim || null, validThrough: rec.valid_through || null,
          windowClosed: frontier >= addDays(recDate, FULFILMENT_WINDOW_DAYS), today,
          window: { days: null, end: frontier, data_through: frontier, note: 'detected mid-window by the pending-actions walk' },
        });
        await writeFulfilment(analyticsPool, clientId, locationId, rec.id, decision)
          .catch((err) => logger.warn('[RecEval] pending walk could not write confirmed', { error: err.message, recId: rec.id }));
      }
      continue;
    }
    const daysLeft = rec.valid_through
      ? Math.round((new Date(`${rec.valid_through}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / dayMs)
      : null;
    pending.push({
      rec_id: rec.id,
      category: rec.category,
      action_type: rec.action_type,
      primary_skus: rec.primary_skus,
      // The owner's claim and the card's state (039), so the tab can show a
      // 'did' as "marked done - awaiting confirmation" and never re-ask it,
      // and a 'did_not' as "you said not yet" with the offer still open.
      action_claim: hasClaims ? (rec.action_claim || null) : null,
      action_claim_at: hasClaims ? (rec.action_claim_at || null) : null,
      fulfilment_state: hasFulfilment ? (rec.fulfilment_state || 'pending') : null,
      // Additive: real names from the catalog walk we already do (currentBySku)
      // so the pending card can show products, not SKU codes. Null when the
      // SKU isn't in the catalog (e.g. stock_new) - the UI falls back to the sku.
      products: rec.primary_skus.map((sku) => ({
        sku,
        product_name: currentBySku.get(sku)?.product_name?.trim() || null,
      })),
      rationale_gist: String(rec.rationale || '').slice(0, 180),
      quantity_hint: rec.quantity_hint,
      confidence: rec.confidence != null ? Number(rec.confidence) : null,
      valid_through: rec.valid_through,
      days_left: daysLeft,
      action_taken: taken, // false = provably not yet; null = unobserved so far
      evidence,
    });
  }
  pending.sort((a, b) => (a.days_left ?? 99) - (b.days_left ?? 99) || (b.confidence ?? 0) - (a.confidence ?? 0));
  const result = { available: true, run_generated_at: run.generated_at, pending };
  pendingCache.set(cacheKey, { at: Date.now(), value: result });
  return result;
}

const PENDING_CACHE_MS = 5 * 60 * 1000;
const pendingCache = new Map(); // `${clientId}:${locationId}` → { at, value }

/**
 * Drop one tenant's cached pending-actions answer - called right after a new
 * run persists, so the tab never serves the previous run for up to 5 minutes.
 */
function invalidatePendingCache(clientId, locationId) {
  pendingCache.delete(`${clientId}:${locationId}`);
}

// ─── Sales trace (Phase 2 - the case file's chart) ───────────────────────────
// Daily units for one rec's SKUs, split into the 28-day baseline before the
// rec and the after-window, summed across SKUs. Same index-supported daily
// query the evaluator uses (sub-second); cached 5 min like pending-actions.

const TRACE_CACHE_MS = 5 * 60 * 1000;
const traceCache = new Map(); // `${clientId}:${locationId}:${recId}:${window}` → { at, value }

/**
 * Sales trace for one rec: zero-filled daily series over
 * baseline (rec_date-28, rec_date] and after (rec_date, min(frontier,
 * rec_date+window)], plus the baseline-derived expected daily rate. Returns
 * null (→ 404) for a missing / cross-tenant / holdout rec - holdouts never
 * surface owner-facing (same rule as the report and ledger).
 */
async function getSalesTrace(analyticsPool, clientId, locationId, recId, opts = {}) {
  const window = normalizeWindow(opts.windowDays);
  const cacheKey = `${clientId}:${locationId}:${recId}:${window}`;
  const cached = traceCache.get(cacheKey);
  if (!opts.nocache && cached && Date.now() - cached.at < TRACE_CACHE_MS) {
    return cached.value;
  }

  const hasUpcColumn = await referenceUpcColumnExists(analyticsPool).catch(() => false);
  const recRes = await analyticsPool.query(
    `SELECT r.primary_skus, r.action_type,
            to_char(r.valid_through, 'YYYY-MM-DD') AS valid_through,
            run.generated_at${hasUpcColumn ? ', r.reference_upc' : ''}
       FROM recommendations r
       JOIN recommendation_runs run ON run.id = r.run_id
      WHERE r.id = $1 AND r.client_id = $2 AND r.location_id = $3
        AND (r.status IS DISTINCT FROM 'holdout')`,
    [recId, clientId, locationId]
  );
  if (!recRes.rows.length) return null;
  const rec = recRes.rows[0];
  const recDate = toDateOnly(rec.generated_at);
  let skus = rec.primary_skus || [];

  // A stock_new rec may cite no SKU at rec time - chart the product that
  // actually arrived, per the same first-seen registry the evaluator trusts.
  if (!skus.length && rec.action_type === 'stock_new' && rec.reference_upc) {
    try {
      const arrival = await analyticsPool.query(
        `SELECT sku, MIN(first_seen_at) AS first_seen_at
           FROM product_first_seen
          WHERE client_id = $1 AND location_id = $2
            AND is_baseline IS FALSE AND upc = $3
          GROUP BY sku`,
        [clientId, locationId, rec.reference_upc]
      );
      const hit = arrival.rows.find((a) => toDateOnly(a.first_seen_at) > recDate);
      if (hit) skus = [hit.sku];
    } catch { /* trace degrades to an empty series */ }
  }

  const scoped = makeTenantScopedPool(opts.syncgoPool || getPool(), clientId, locationId);
  const frontierRes = await scoped.query(
    `SELECT to_char(MAX(sale_date)::date, 'YYYY-MM-DD') AS latest FROM sale_items
      WHERE client_id = $1 AND location_id = $2`,
    [clientId, locationId]
  );
  const frontier = frontierRes.rows[0]?.latest || null;

  const baselineStart = addDays(recDate, -BASELINE_DAYS); // exclusive lower bound
  const windowEnd = addDays(recDate, window);
  // Never chart days the data hasn't reached - MEASURED only, no projection.
  const afterEnd = frontier && frontier < windowEnd ? frontier : windowEnd;

  const byDay = new Map();
  if (skus.length && frontier) {
    const sales = await scoped.query(
      `WITH ${SKU_KEYMAP_CTE}, ${VOID_SALES_CTE}
       SELECT to_char(si.sale_date::date, 'YYYY-MM-DD') AS day, SUM(si.quantity)::int AS units
         FROM sale_items si ${CANON_JOIN}
        WHERE si.client_id = $1 AND si.location_id = $2 AND ${CANON_SKU} = ANY($3)
          AND si.sale_date > $4::date AND si.sale_date <= $5::date
          AND si.quantity > 0 AND ${NOT_VOID}
        GROUP BY si.sale_date::date`,
      [clientId, locationId, skus, baselineStart, afterEnd]
    );
    sales.rows.forEach((r) => byDay.set(r.day, r.units));
  }

  // Zero-filled continuous series over (startExclusive, endInclusive] - the
  // chart needs every calendar day, not just days with sales.
  const series = (startExclusive, endInclusive) => {
    const out = [];
    if (!(endInclusive > startExclusive)) return out;
    for (let d = addDays(startExclusive, 1); d <= endInclusive; d = addDays(d, 1)) {
      out.push({ day: d, units: byDay.get(d) || 0 });
    }
    return out;
  };
  const baseline = frontier ? series(baselineStart, recDate) : [];
  const after = frontier ? series(recDate, afterEnd) : [];
  const baselineUnits = baseline.reduce((sum, p) => sum + p.units, 0);

  // Open days in the baseline window, from the feature store's calendar - the
  // ONE definition (sheet 03). Anchored to the REC DATE, so the trace divides
  // by the days the store actually traded before the recommendation, not by
  // 28 calendar days. Falls back to the calendar count when the store has not
  // been built, so an unbuilt store loses accuracy rather than its trace.
  let baselineOpenDays = BASELINE_DAYS;
  if (await featureStore.isBuilt(analyticsPool, clientId, locationId)) {
    const measured = await featureStore
      .openDays(analyticsPool, {
        clientId, locationId, asOf: recDate, windowDays: BASELINE_DAYS,
      })
      .catch(() => null);
    if (measured) baselineOpenDays = measured;
  }

  const value = {
    available: true,
    rec_id: recId,
    window_days: window,
    rec_date: recDate,
    data_through: frontier,
    baseline,
    after,
    // Per OPEN day, not per calendar day - see captureForRecs for why.
    // `baselineOpenDays` falls back to BASELINE_DAYS when the store has not
    // been built, so the figure degrades rather than disappearing.
    expected_daily_rate:
      Math.round((baselineUnits / baselineOpenDays) * 1000) / 1000,
    baseline_open_days: baselineOpenDays,
    valid_through: rec.valid_through,
    skus,
  };
  if (traceCache.size > 500) traceCache.clear(); // bound memory; refills lazily
  traceCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

// ─── Owner-reported action claims (the one-question micro-survey) ────────────
// For physically unobservable actions the only remaining sensor is the owner.
// The UI shows AT MOST ONE question per visit; answers land on the rec row and
// fill action_taken where no detector could (never overriding hard evidence).

const ASKABLE_ACTIONS = ['endcap', 'cold_box', 'promote', 'bundle'];
const QUESTION_TEMPLATES = {
  endcap: (p) => `Did you set up a front display for ${p}?`,
  cold_box: (p) => `Did you put ${p} in the cold box?`,
  promote: (p) => `Did you end up featuring ${p}?`,
  bundle: (p) => `Did you run the ${p} bundle?`,
};

/**
 * Pick the single best rec to ask about: unobservable action, not yet
 * answered or dismissed, recent but at least a day old (give the owner time
 * to have acted). Returns { question: null } when there is nothing to ask -
 * the UI then simply shows nothing.
 */
async function getActionQuestion(analyticsPool, clientId, locationId, opts = {}) {
  if (!(await actionClaimColumnExists(analyticsPool).catch(() => false))) return { question: null };
  const { rows } = await analyticsPool.query(
    `SELECT r.id, r.action_type, r.primary_skus, r.rationale
       FROM recommendations r
       JOIN recommendation_runs run ON run.id = r.run_id
      WHERE r.client_id = $1 AND r.location_id = $2
        AND r.action_type = ANY($3)
        AND r.action_claim IS NULL
        AND (r.status IS DISTINCT FROM 'holdout')
        AND run.generated_at >= now() - interval '30 days'
        AND run.generated_at <= now() - interval '1 day'
      ORDER BY run.generated_at DESC, r.confidence DESC
      LIMIT 1`,
    [clientId, locationId, ASKABLE_ACTIONS]
  );
  if (!rows.length) return { question: null };
  const rec = rows[0];

  let productName = null;
  const sku = (rec.primary_skus || [])[0];
  if (sku) {
    try {
      const scoped = makeTenantScopedPool(opts.syncgoPool || getPool(), clientId, locationId);
      const p = await scoped.query(
        `SELECT product_name FROM products
          WHERE client_id = $1 AND location_id = $2 AND sku = $3 LIMIT 1`,
        [clientId, locationId, sku]
      );
      productName = p.rows[0]?.product_name?.trim() || null;
    } catch { /* cosmetic - question falls back to a generic subject */ }
  }
  const subject = productName || 'that product';
  const template = QUESTION_TEMPLATES[rec.action_type]
    || ((s) => `Did you act on the suggestion for ${s}?`);
  return {
    question: {
      rec_id: rec.id,
      action_type: rec.action_type,
      product_name: productName,
      text: template(subject),
      rationale_gist: String(rec.rationale || '').slice(0, 140),
    },
  };
}

/** How long the claim route waits for the targeted re-evaluation. */
const CLAIM_REEVAL_WAIT_MS = Number(process.env.REC_CLAIM_REEVAL_WAIT_MS || 20000);
const CLAIM_VALUES = ['did', 'did_not', 'dismissed', 'none'];

/**
 * Record the owner's answer and say what the data makes of it.
 *
 *   claim   'did'        the owner says the action was taken. The card goes
 *                        to 'claimed' SYNCHRONOUSLY when it is pending,
 *                        unobservable or expired - never when the data has
 *                        already confirmed or refuted it - and the targeted
 *                        re-evaluation is AWAITED (bounded by
 *                        CLAIM_REEVAL_WAIT_MS) so the response can carry the
 *                        state the data decided: a store whose feed already
 *                        holds the order sees 'confirmed' on the same click.
 *           'did_not'    the owner says not yet. Recorded; the state is left
 *                        to the data (an owner's "no" is not a detector's
 *                        full-visibility FALSE); re-evaluation awaited the
 *                        same way so the evidence carries the claim.
 *           'dismissed'  the owner refused the card. Recorded with `reason`
 *                        when the body carries one; no fulfilment change (a
 *                        dismissal is not a fulfilment state) and no
 *                        re-evaluation.
 *           'none'       RETRACT. Clears action_claim, action_claim_at and
 *                        dismiss_reason; a 'claimed' card returns to
 *                        'pending' (the next pass re-states it from the
 *                        data); every other state stands - confirmed is
 *                        never touched, not_followed was decided by the data.
 *   opts    { reason, syncgoPool, waitMs }
 *
 * Returns false when the rec is not this tenant's; otherwise
 *   { ok: true, id, claim, action_claim, fulfilment_state, fulfilment_evidence,
 *     fulfilment_summary, evaluation: 'done' | 'queued' | 'skipped' }
 * where 'queued' means the re-evaluation outran the wait and is still
 * running - the state returned is the synchronous one, and the next read
 * will carry what the data decided.
 */
async function recordActionClaim(analyticsPool, clientId, locationId, recId, claim, opts = {}) {
  if (!CLAIM_VALUES.includes(claim)) throw new Error(`action claim must be one of ${CLAIM_VALUES.join(', ')}`);
  const hasFulfilment = await fulfilmentColumnsExist(analyticsPool).catch(() => false);
  const reason = typeof opts.reason === 'string' && opts.reason.trim()
    ? opts.reason.trim().slice(0, 200) : null;

  const fulfilmentCols = hasFulfilment
    ? ', fulfilment_state, fulfilment_evidence, fulfilment_confirmed_at, dismiss_reason, action_type, to_char(valid_through, \'YYYY-MM-DD\') AS valid_through'
    : ', action_type, to_char(valid_through, \'YYYY-MM-DD\') AS valid_through';
  let rows;
  if (claim === 'none') {
    ({ rows } = await analyticsPool.query(
      `UPDATE recommendations
          SET action_claim = NULL, action_claim_at = NULL
              ${hasFulfilment ? `, dismiss_reason = NULL,
              fulfilment_state = CASE WHEN fulfilment_state = 'claimed' THEN 'pending' ELSE fulfilment_state END,
              fulfilment_evidence = CASE WHEN fulfilment_state = 'claimed'
                                         THEN COALESCE(fulfilment_evidence, '{}'::jsonb) - 'claim' - 'conflict'
                                              || jsonb_build_object('decided_by', 'claim_retracted')
                                         ELSE fulfilment_evidence END,
              fulfilment_checked_at = now()` : ''}
        WHERE id = $1 AND client_id = $2 AND location_id = $3
        RETURNING id, action_claim, action_claim_at${fulfilmentCols}`,
      [recId, clientId, locationId]
    ));
  } else {
    ({ rows } = await analyticsPool.query(
      `UPDATE recommendations
          SET action_claim = $4, action_claim_at = now()
              ${hasFulfilment ? `, dismiss_reason = $5,
              -- 'did' is a CLAIM: it moves a card the data has not decided
              -- (pending / unobservable / expired) to 'claimed' and nothing
              -- else. A confirmed card stays confirmed; a not_followed card
              -- stays not_followed with the claim recorded beside it.
              fulfilment_state = CASE
                WHEN $4 = 'did' AND fulfilment_state IN ('pending', 'unobservable', 'expired') THEN 'claimed'
                ELSE fulfilment_state END,
              fulfilment_evidence = CASE
                WHEN $4 IN ('did', 'did_not')
                THEN COALESCE(fulfilment_evidence, '{}'::jsonb) || jsonb_build_object('claim', $4::text)
                ELSE fulfilment_evidence END,
              fulfilment_checked_at = now()` : ''}
        WHERE id = $1 AND client_id = $2 AND location_id = $3
        RETURNING id, action_claim, action_claim_at${fulfilmentCols}`,
      hasFulfilment ? [recId, clientId, locationId, claim, reason] : [recId, clientId, locationId, claim]
    ));
  }
  if (!rows.length) return false;
  let row = rows[0];
  pendingCache.delete(`${clientId}:${locationId}`);

  let evaluation = 'skipped';
  if (claim === 'did' || claim === 'did_not') {
    // Awaited, bounded. The promise keeps running past the deadline - the
    // work is not wasted, the response simply stops waiting for it.
    const reeval = evaluateTenant(analyticsPool, clientId, locationId, {
      force: true, onlyRecId: recId, ...(opts.syncgoPool ? { syncgoPool: opts.syncgoPool } : {}),
    }).catch((err) => {
      logger.warn(`[RecEval] claim re-eval failed for rec ${recId}: ${err.message}`);
      return { failed: true };
    });
    const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : CLAIM_REEVAL_WAIT_MS;
    const outcome = await Promise.race([
      reeval.then((r) => ({ settled: true, result: r })),
      new Promise((resolve) => setTimeout(() => resolve({ settled: false }), waitMs)),
    ]);
    evaluation = outcome.settled ? (outcome.result && outcome.result.failed ? 'failed' : 'done') : 'queued';
    if (outcome.settled && hasFulfilment) {
      const fresh = await analyticsPool.query(
        `SELECT id, action_claim, action_claim_at${fulfilmentCols}
           FROM recommendations WHERE id = $1 AND client_id = $2 AND location_id = $3`,
        [recId, clientId, locationId]
      );
      if (fresh.rows[0]) row = fresh.rows[0];
    }
  }

  const state = hasFulfilment ? row.fulfilment_state : null;
  return {
    ok: true,
    id: recId,
    claim,
    action_claim: row.action_claim || null,
    action_claim_at: row.action_claim_at || null,
    dismiss_reason: hasFulfilment ? (row.dismiss_reason || null) : null,
    fulfilment_state: state,
    fulfilment_evidence: hasFulfilment ? (row.fulfilment_evidence || null) : null,
    fulfilment_confirmed_at: hasFulfilment ? (row.fulfilment_confirmed_at || null) : null,
    fulfilment_summary: state ? fulfilmentSummary({
      state, evidence: row.fulfilment_evidence, claim: row.action_claim, claim_at: row.action_claim_at,
      valid_through: row.valid_through, action_type: row.action_type,
    }) : null,
    evaluation,
  };
}

/** Test seam - forget the memoized table/column/purchases probes. */
function _resetProbes() {
  evalTablesExist.reset();
  referenceUpcColumnExists.reset();
  suggestedOrderQtyColumnExists.reset();
  engineFactsColumnsExist.reset();
  engineFamilyColumnExists.reset();
  engineVersionColumnExists.reset();
  purchasesUsable.reset();
  invoiceTablesUsable.reset();
  poReceivedDateColumnExists.reset();
  poDuplicateOfColumnExists.reset();
  purchasedSourceAdmitsInvoice.reset();
  actionClaimColumnExists.reset();
  fulfilmentColumnsExist.reset();
}


/**
 * SHOWN VERSUS WITHHELD - the only question that separates a forecast from a
 * recommendation.
 *
 * A high hit rate on shown cards says the engine can pick products that were
 * going to sell. It does not say that recommending them changed anything. The
 * withheld arm is the only thing that can, and it has been assigned since the
 * holdout went in - 63 of 372 live recommendations, a realised 16.9% - while
 * nothing reported it. The evidence was being collected and thrown away.
 *
 * WHY THIS READS recommendation_outcomes AND NOT recommendation_evaluations.
 * The outcomes table carries `arm` as a STORED column rather than something
 * each consumer re-derives from `status`, which matters because the arm is the
 * experiment's assignment and must not be recomputed per reader. It also
 * carries `family` and `sku`, so the per-family split is a GROUP BY rather than
 * another join.
 *
 * ONE OUTCOME PER PRODUCT PER WINDOW. Two cards in one window can name the same
 * SKU - 62 of 372 live cards cover more than one product - and counting that
 * product twice weights it twice in an average that is supposed to be per
 * product. DISTINCT ON (sku, window_start, window_end) keeps the most complete
 * look at each product-window, which is a stable key only because the outcome's
 * `window_end` is now the nominal end rather than the moving sales frontier.
 *
 * MONEY COMES FROM recommendation_evaluations.margin_impact, the estate's one
 * definition - extra units beyond baseline x (price - cost) - which is NULL
 * when cost is unknown. Nulls are counted and reported separately, never summed
 * as zero: a card whose cost nobody knows has not earned nothing. The join is
 * on rec_id AND the window span, which is sound for the same reason the
 * DISTINCT ON is.
 *
 * A DIFFERENCE IS REPORTED ONLY WHEN BOTH ARMS CLEAR THE FLOOR. With one
 * withheld outcome, "shown beat withheld by 0.4" is noise wearing a number.
 * Below the floor this returns the counts and names what it is waiting for,
 * which is the useful thing to print - it is how anyone notices that the
 * withheld arm is starved.
 */
const HOLDOUT_MIN_PER_ARM = parseInt(process.env.HOLDOUT_MIN_PER_ARM || '5', 10);

/**
 * The rules of the shown-versus-withheld comparison, as functions, so that
 * the pilot scoreboard (services/pilotScoreboardService.js) can run the SAME
 * arithmetic per product that holdoutReport runs per family and overall.
 * Two copies of a fold is how one page says 454 and another 485.
 *
 *   holdoutScope        the WHERE clause and its params: window length, and
 *                       EITHER a trailing lookback on window_start (the
 *                       digest's view) OR a calendar month the window CLOSED
 *                       in (the scoreboard's view - windows named by the
 *                       month they land in, as the ledger does). Never both.
 *   holdoutPerProductCte the DISTINCT ON that keeps ONE outcome per product
 *                       per window, carrying the money column from the
 *                       evaluation row.
 *   holdoutArmBlank/Fold/Seal   accumulate GROUP BY rows into one arm figure
 *   holdoutDifference   the difference, or the refusal with its reason
 */
function holdoutScope({ clientId = null, locationId = null, windowDays = 30, days = LOOKBACK_DAYS, month = null } = {}) {
  const params = [windowDays];
  let where = `(o.window_end - o.window_start) = $1`;
  if (month != null) {
    if (!/^\d{4}-\d{2}$/.test(String(month))) {
      throw new Error(`holdoutScope: month must be YYYY-MM, got ${JSON.stringify(month)}`);
    }
    // The month the window CLOSED in: [first day, first day of next month).
    params.push(`${month}-01`);
    where += ` AND o.window_end >= $2::date AND o.window_end < ($2::date + interval '1 month')`;
  } else {
    params.push(days);
    where += ` AND o.window_start >= (current_date - make_interval(days => $2))`;
  }
  if (clientId != null && locationId != null) {
    params.push(clientId, locationId);
    where += ` AND o.client_id = $${params.length - 1} AND o.location_id = $${params.length}`;
  }
  return { where, params };
}

function holdoutPerProductCte(where, extraCols = '') {
  return `per_product AS (
       SELECT DISTINCT ON (o.client_id, o.location_id, o.sku,
                           o.window_start, o.window_end)
              o.client_id, o.location_id, o.arm, o.family, o.sku,
              o.lift, o.lift_reason, e.margin_impact${extraCols}
         FROM recommendation_outcomes o
         LEFT JOIN recommendation_evaluations e
                ON e.rec_id = o.recommendation_id
               AND e.window_days = (o.window_end - o.window_start)
        WHERE ${where}
        ORDER BY o.client_id, o.location_id, o.sku, o.window_start,
                 o.window_end, o.open_days_in_window DESC, o.scored_at DESC
     )`;
}

const holdoutArmBlank = () => ({
  products: 0, measurable: 0, avg_lift: null, priced: 0, dollars: null,
});

const holdoutArmFold = (acc, r) => {
  acc.products += r.products;
  acc.measurable += r.measurable;
  acc.priced += r.priced;
  // Weighted by measurable rows, so folding families into one figure gives
  // the same answer as averaging the underlying rows directly.
  if (r.measurable > 0 && r.avg_lift != null) {
    acc.liftSum = (acc.liftSum || 0) + Number(r.avg_lift) * r.measurable;
  }
  if (r.priced > 0 && r.dollars != null) {
    acc.dollars = (acc.dollars || 0) + Number(r.dollars);
  }
  return acc;
};

const holdoutArmSeal = (acc) => {
  acc.avg_lift = acc.measurable > 0 && acc.liftSum != null
    ? Math.round((acc.liftSum / acc.measurable) * 1000) / 1000 : null;
  delete acc.liftSum;
  if (acc.dollars != null) acc.dollars = Math.round(acc.dollars * 100) / 100;
  // PER PRODUCT-WINDOW, because the arms are not the same size and never
  // will be. The holdout is 16.9%, so the shown arm carries roughly five
  // times the cards; comparing TOTAL dollars between them would report that
  // ratio as an effect and "recommending earned $7,063" would be true of any
  // engine, including one picking at random. The totals stay on the record
  // because they are what actually happened, but the difference is taken on
  // the per-product figure.
  acc.dollars_per_product = acc.priced > 0 && acc.dollars != null
    ? Math.round((acc.dollars / acc.priced) * 100) / 100 : null;
  return acc;
};

// The difference, and the refusal to state one. NULL with a reason, never a
// zero: "no measured difference" and "not enough to measure" are opposite
// statements and a reader cannot tell them apart from a number alone.
const holdoutDifference = (a) => {
  if (a.shown.measurable < HOLDOUT_MIN_PER_ARM
      || a.withheld.measurable < HOLDOUT_MIN_PER_ARM) {
    return {
      lift: null,
      dollars_per_product: null,
      refused_reason: `needs ${HOLDOUT_MIN_PER_ARM} measured outcomes per arm; `
        + `have ${a.shown.measurable} shown and ${a.withheld.measurable} withheld`,
    };
  }
  // Priced counts are checked separately from measurable ones: a row can
  // carry a margin and no lift (the baseline projects zero units) or a lift
  // and no margin (cost unknown), so one arm clearing the lift floor says
  // nothing about whether its money is comparable.
  const pricedBoth = a.shown.priced >= HOLDOUT_MIN_PER_ARM
    && a.withheld.priced >= HOLDOUT_MIN_PER_ARM
    && a.shown.dollars_per_product != null
    && a.withheld.dollars_per_product != null;
  return {
    lift: Math.round((a.shown.avg_lift - a.withheld.avg_lift) * 1000) / 1000,
    dollars_per_product: pricedBoth
      ? Math.round((a.shown.dollars_per_product
        - a.withheld.dollars_per_product) * 100) / 100 : null,
    dollars_refused_reason: pricedBoth ? null
      : `needs ${HOLDOUT_MIN_PER_ARM} PRICED outcomes per arm; have `
        + `${a.shown.priced} shown and ${a.withheld.priced} withheld`,
    refused_reason: null,
  };
};

async function holdoutReport(analyticsPool, {
  clientId = null, locationId = null, windowDays = 30, days = LOOKBACK_DAYS, month = null,
} = {}) {
  const { where, params } = holdoutScope({ clientId, locationId, windowDays, days, month });

  const { rows } = await analyticsPool.query(
    `WITH ${holdoutPerProductCte(where)}
     SELECT arm, family,
            count(*)::int             AS products,
            count(lift)::int          AS measurable,
            avg(lift)                 AS avg_lift,
            count(margin_impact)::int AS priced,
            sum(margin_impact)        AS dollars
       FROM per_product
      GROUP BY arm, family
      ORDER BY family, arm`,
    params
  );

  const byFamily = new Map();
  const overall = { shown: holdoutArmBlank(), withheld: holdoutArmBlank() };
  for (const r of rows) {
    const arm = r.arm === 'withheld' ? 'withheld' : 'shown';
    if (!byFamily.has(r.family)) {
      byFamily.set(r.family, { family: r.family, shown: holdoutArmBlank(), withheld: holdoutArmBlank() });
    }
    holdoutArmFold(byFamily.get(r.family)[arm], r);
    holdoutArmFold(overall[arm], r);
  }

  holdoutArmSeal(overall.shown);
  holdoutArmSeal(overall.withheld);
  const families = [...byFamily.values()].map((f) => {
    holdoutArmSeal(f.shown);
    holdoutArmSeal(f.withheld);
    f.difference = holdoutDifference(f);
    return f;
  }).sort((x, y) => (y.shown.products + y.withheld.products)
    - (x.shown.products + x.withheld.products));

  return {
    window_days: windowDays,
    // One of the two is the scope; the other is null so a reader of the JSON
    // cannot mistake a month's report for a trailing one.
    lookback_days: month != null ? null : days,
    month: month != null ? month : null,
    min_per_arm: HOLDOUT_MIN_PER_ARM,
    overall: { ...overall, difference: holdoutDifference(overall) },
    by_family: families,
  };
}

/** One line for a log or a digest. States what it cannot state, and why. */
function holdoutLine(report) {
  const o = report.overall;
  const money = (v) => (v == null ? 'unpriced'
    : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`);
  if (o.difference.refused_reason) {
    return `holdout ${report.window_days}d NOT YET MEASURABLE - `
      + o.difference.refused_reason;
  }
  const sign = o.difference.lift > 0 ? '+' : '';
  const perMoney = o.difference.dollars_per_product != null
    ? `${money(o.difference.dollars_per_product)} per product`
    : `money not comparable (${o.difference.dollars_refused_reason})`;
  return `holdout ${report.window_days}d: shown ${o.shown.avg_lift} lift / `
    + `${money(o.shown.dollars_per_product)} per product over `
    + `${o.shown.measurable} product-windows, withheld ${o.withheld.avg_lift} / `
    + `${money(o.withheld.dollars_per_product)} over ${o.withheld.measurable} `
    + `- recommending is worth ${sign}${o.difference.lift} lift and ${perMoney}`;
}

module.exports = {
  holdoutReport,
  holdoutLine,
  HOLDOUT_MIN_PER_ARM,
  // The holdout comparison's rules, for the pilot scoreboard to run per
  // product without forking them.
  holdoutScope,
  holdoutPerProductCte,
  holdoutArmBlank,
  holdoutArmFold,
  holdoutArmSeal,
  holdoutDifference,
  EVAL_WINDOWS,
  // Scoring thresholds / caps - shared with the learning lists so "proven"
  // and "avoid" mean exactly what "winner" and "underperformer" mean here.
  WINNER_MIN,
  UNDERPERFORMER_MAX,
  LIFT_CAP,
  evalTablesExist,
  referenceUpcColumnExists,
  suggestedOrderQtyColumnExists,
  engineFactsColumnsExist,
  engineFamilyColumnExists,
  actionClaimColumnExists,
  fulfilmentColumnsExist,
  _resetProbes,
  // The fulfilment state machine (039): the pure decision, the detector that
  // decided, the read-path fallback, the owner's sentence, and the writer.
  fulfilmentFrom,
  decidingDetector,
  effectiveFulfilment,
  fulfilmentSummary,
  writeFulfilment,
  detectAction,
  FULFILMENT_STATES,
  FULFILMENT_WINDOW_DAYS,
  CONFIRMING_DETECTORS,
  OBSERVABLE_ACTIONS,
  CLAIM_VALUES,
  // Pure helpers behind the outcome quantities and the stockout grade.
  restockThreshold,
  isStockoutCard,
  STOCKOUT_GRADE_WINDOW_DAYS,
  squashLift,
  zeroBaselineMinUnits,
  voteComponentOf,
  blendScore,
  verdictOf,
  parseQuantityHint,
  captureForRun,
  captureMissing,
  evaluateTenant,
  evaluateAllTenants,
  getRecEvaluations,
  getEffectiveness,
  getEffectivenessLedger,
  getSalesTrace,
  getPendingActions,
  invalidatePendingCache,
  getActionQuestion,
  recordActionClaim,
};
