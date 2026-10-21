/**
 * Recommendation Service - generate (via the Python service), persist, and read.
 *
 * Flow (Node-mediated; the browser never touches the Python service):
 *   1. POST {REC_SERVICE_URL}/run-recommendations/{clientId}/{locationId}
 *        → the Python service pulls profile/inventory/sales back from THIS Node
 *          backend (see routes/integration.js), computes signals + one LLM call,
 *          and returns a RunResult (API_CONTRACT.md §2).
 *   2. Persist the envelope as one `recommendation_runs` row + each item as a
 *        `recommendations` row - in the ANALYTICS Postgres DB (product decision;
 *        recs are tracked alongside chat telemetry, isolated from `syncgo`).
 *        The SAME transaction writes the day-grain archive row
 *        (`daily_store_recommendations`, migration 015) so the run tables and
 *        the day cell can never disagree about what was recommended on a day.
 *        After the commit, the day's external signals are recorded
 *        best-effort (`daily_store_signals` + `signal_source_payloads`,
 *        migration 014) - see services/dailySnapshotService.js for why those
 *        three writes have three different durability rules.
 *   3. Read the latest run for a store and enrich each rec's `primary_skus` with
 *        product name / price / current stock from `syncgo` (the rec rows store
 *        only opaque SKUs; the UI shows real products).
 *
 * Two pools are in play and they are NOT interchangeable:
 *   - analyticsPool → recommendation_runs / recommendations live here.
 *   - syncgoPool    → products live here (for SKU → name/price/stock enrichment).
 *
 * Tenancy (house rule): every query filters on BOTH client_id AND location_id.
 */

const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { coerceBasis } = require('../lib/confidenceBasis');
const evalSvc = require('./recommendationEvalService');
const dailySvc = require('./dailySnapshotService');
const recGate = require('./recommendationGateService');
const holdout = require('../lib/holdoutAssignment');
const familyGate = require('./familyGateService');
const featureStore = require('./featureStoreService');

// Base URL of the external Python recommendation service. Server-side only -
// defaults to the local dev service; override per-env with REC_SERVICE_URL.
const REC_SERVICE_URL = (process.env.REC_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');

// The run is synchronous on the Python side (geocode + weather + events + 1 LLM
// call), so give it a generous ceiling before we abort.
// 90s was cutting it fine: measured runs on real tenants take 67-85s (the
// service fetches inventory and sales back through this API, queries several
// signal providers, then calls a model), so an ordinary run on a slow day
// aborted and was reported as an unreachable service. 180s leaves headroom
// without letting a genuinely wedged run hold the request open indefinitely.
const REC_SERVICE_TIMEOUT_MS = parseInt(process.env.REC_SERVICE_TIMEOUT_MS || '180000', 10);

// Shared secret for the Python service's inbound auth (its SERVICE_API_KEY).
// When set, every /run-recommendations* call carries it as X-API-Key; the Python
// side 401s without it. Unset = the Python side must also be running open (dev).
const REC_SERVICE_API_KEY = process.env.REC_SERVICE_API_KEY || '';

// ─── 1. Call the Python service ──────────────────────────────────────────────

/**
 * POST /run-recommendations/{clientId}/{locationId} and return the parsed
 * RunResult. Throws an AppError (502) on transport / non-2xx / bad-shape so the
 * caller can surface a clean message and cron can retry.
 */
async function callPythonService(clientId, locationId) {
  const url = `${REC_SERVICE_URL}/run-recommendations/${clientId}/${locationId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REC_SERVICE_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: REC_SERVICE_API_KEY ? { 'X-API-Key': REC_SERVICE_API_KEY } : {},
    });
  } catch (err) {
    // An abort is OUR timer firing, not a missing service. A real run takes 60-90
    // seconds - it pulls inventory and sales back through the Node API, queries
    // several signal providers, and calls a model - so the two failures look
    // alike from here and mean opposite things. Reporting a slow run as
    // "unavailable ... check that it is running" sends the reader to inspect a
    // service that answered every request it was given.
    if (err.name === 'AbortError') {
      throw new AppError(
        `The recommendation run did not finish within ${Math.round(REC_SERVICE_TIMEOUT_MS / 1000)}s. ` +
          'The service is running and accepted the request; it simply took longer than that. ' +
          'Try again, or raise REC_SERVICE_TIMEOUT_MS.',
        'REC_SERVICE_TIMEOUT',
        504
      );
    }
    throw new AppError(
      'The recommendation service is unavailable right now. Please try again shortly.',
      'REC_SERVICE_UNREACHABLE',
      502
    );
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // fall through - handled by the !res.ok / shape checks below
  }

  if (!res.ok) {
    // Python errors use { error: { code, message } }; keep its code for logs.
    const code = body?.error?.code || `HTTP_${res.status}`;
    logger.warn('Rec service returned non-2xx', { clientId, locationId, status: res.status, code });
    const status = res.status === 404 ? 404 : 502;
    // A 404 from the Python service means two unrelated things, and the text
    // has to say which. `node_api_error` is Python reporting that ITS call back
    // into this Node API was answered 404 - the port it was given is not this
    // server (on 19 Oct 2026 another project's dev server sat on 3000 and 82
    // stores read "no recommendations are available yet" for an evening). Any
    // other 404 is the store genuinely having nothing to show.
    const msg = res.status === 404
      ? (code === 'node_api_error'
        ? 'The recommendation service could not pull this store\'s data back from the Node API '
          + '(its NODE_API_BASE_URL answered 404 - is this server the one listening on that port?).'
        : 'No recommendations are available for this store yet.')
      : 'The recommendation service could not complete the run. Please try again shortly.';
    throw new AppError(msg, code, status);
  }

  if (!body || typeof body !== 'object' || !Array.isArray(body.recommendations)) {
    throw new AppError(
      'The recommendation service returned an unexpected response.',
      'REC_SERVICE_BAD_SHAPE',
      502
    );
  }

  return body;
}

// ─── 2. Persist a RunResult ──────────────────────────────────────────────────

// Canonical vocab (API_CONTRACT.md) - every downstream consumer exact-matches
// these lowercase strings, so nothing else may reach the table.
const KNOWN_CATEGORIES = new Set([
  'inventory_understock', 'inventory_overstock', 'weather', 'calendar_sports',
  'news', 'bundle', 'new_arrival', 'social_trending',
]);
const KNOWN_ACTION_TYPES = new Set([
  'pre_stock', 'endcap', 'cold_box', 'bundle', 'markdown', 'reorder',
  'liquidate', 'promote', 'stock_new',
]);

// Where a card's lead time came from (migration 042). Mirrors the Python
// schema's Literal["measured", "declared"] on `lead_time_basis`; a word outside
// the pair is persisted as null rather than as a third meaning nobody declared.
const LEAD_TIME_BASES = new Set(['measured', 'declared']);

/**
 * A calendar date as the string it arrived as, or null.
 *
 * Accepts 'YYYY-MM-DD' and a full ISO datetime (keeps the date part, as
 * valid_through does). Refuses everything else - a number, an empty string, a
 * Date object - because the one thing this must never do is construct a date
 * from the clock: a card with no deadline must not acquire today's.
 */
function dateString(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(v);
  return m ? m[1] : null;
}

/** 'Pre-Stock' / 'cold box' → 'pre_stock' / 'cold_box'. */
function normalizeVocab(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Persist one RunResult: a single recommendation_runs row, one recommendations
 * row per item, and the day-grain archive row - inside one transaction
 * (all-or-nothing).
 *
 * @param {import('pg').Pool} analyticsPool  the analytics DB pool
 * @param {object} run  a RunResult from the Python service
 * @returns {{ runId: number, day: object, archived: object[] }} `day` is the
 *   resolved store-local day key, which the caller reuses for signal capture
 *   so both sides of the day agree on what "today" meant.
 */
async function persistRun(analyticsPool, run) {
  const client = await analyticsPool.connect();
  // The store's own calendar date for this run (migration 015). The Python
  // service reports the store's IANA zone when it could determine one - NWS
  // returns it for the gridpoint it already looks up - and resolveDayKey falls
  // back to UTC, recording which rule it used, when it could not.
  const capture = run.signal_capture || {};
  const day = dailySvc.resolveDayKey(run.generated_at, capture.timezone || null);
  const hasDayColumns = await dailySvc.runDayColumnsExist(analyticsPool).catch(() => false);

  try {
    await client.query('BEGIN');

    // rec_date/day_basis/timezone ship with migration 015 - probe and degrade
    // so persistence never couples to migration order (the house pattern,
    // matching reference_upc and suggested_order_qty below).
    const runCols = ['client_id', 'location_id', 'generated_at', 'data_as_of',
      'candidate_count', 'recommendation_count', 'dropped_invalid', 'signal_snapshot'];
    const runVals = [
      run.client_id,
      run.location_id,
      run.generated_at,
      run.data_as_of,
      run.candidate_count ?? 0,
      run.recommendations_generated ?? (run.recommendations?.length || 0),
      run.dropped_invalid ?? 0,
      JSON.stringify(run.signal_snapshot ?? {}),
    ];
    if (hasDayColumns) {
      runCols.push('rec_date', 'day_basis', 'timezone');
      runVals.push(day.date, day.basis, day.timezone);
    }
    // WHICH ENGINE PRODUCED THIS. The response has carried
    // EngineInfo(version=app.__version__) all along and Node passed it to the
    // daily snapshot without ever putting it on the run, so the calibration
    // fitter had no way to tell outcomes from one engine apart from another's
    // and pooled them all. A curve maps a RAW SCORE onto a hit rate, and that
    // mapping belongs to the engine that produced the scores. Migration 032.
    const hasEngineVersion = await analyticsPool
      .query(`SELECT 1 FROM information_schema.columns
               WHERE table_name = 'recommendation_runs'
                 AND column_name = 'engine_version' LIMIT 1`)
      .then((r) => r.rowCount > 0)
      .catch(() => false);
    if (hasEngineVersion) {
      runCols.push('engine_version');
      runVals.push((run.engine && run.engine.version) || null);
    }
    const runIns = await client.query(
      `INSERT INTO recommendation_runs (${runCols.join(', ')})
       VALUES (${runCols.map((c, i) => (c === 'signal_snapshot' ? `$${i + 1}::jsonb`
         : c === 'rec_date' ? `$${i + 1}::date` : `$${i + 1}`)).join(', ')})
       RETURNING id`,
      runVals
    );
    const runId = runIns.rows[0].id;

    // reference_upc (stock_new evaluation anchor) ships with analytics
    // migration 002 - include it only where the column exists, so persistence
    // never couples to migration order.
    const hasUpc = await evalSvc.referenceUpcColumnExists(analyticsPool).catch(() => false);
    const hasOrderQty = await evalSvc.suggestedOrderQtyColumnExists(analyticsPool).catch(() => false);
    // Probe-and-degrade, same pattern as the two above: an estate that has not
    // run migration 022 keeps writing recommendations, just without the
    // engine's own figures, and the card falls back to the buy list.
    const hasEngineFacts = await analyticsPool
      .query(`SELECT 1 FROM information_schema.columns
               WHERE table_name = 'recommendations'
                 AND column_name = 'engine_daily_rate' LIMIT 1`)
      .then((r) => r.rowCount > 0)
      .catch(() => false);
    // Migration 035 - which engine family made the card. The stockout card
    // and the recovering card both arrive as 'inventory_understock' /
    // 'reorder', and only the stockout one makes the claim the evaluator
    // grades on sell-through ("it runs out before the next delivery"). Without
    // this the grader has to guess from engine_days_cover.
    const hasEngineFamily = await analyticsPool
      .query(`SELECT 1 FROM information_schema.columns
               WHERE table_name = 'recommendations'
                 AND column_name = 'engine_family' LIMIT 1`)
      .then((r) => r.rowCount > 0)
      .catch(() => false);
    // Migration 042 - the day to order by, decided by the engine. Until this
    // column the card's deadline was browser arithmetic and Purchasing's was a
    // different formula, and on 19 October 2026 the two printed Oct 19 and
    // Oct 22 for the same bottle. Stored once so every surface reads one date.
    const hasOrderBy = await analyticsPool
      .query(`SELECT 1 FROM information_schema.columns
               WHERE table_name = 'recommendations'
                 AND column_name = 'order_by' LIMIT 1`)
      .then((r) => r.rowCount > 0)
      .catch(() => false);
    // Migration 043 - what each live signal was found to do to this card's
    // family, and the one-sentence summary. The engine attaches both to EVERY
    // card (pipeline._attach_signal_impact) and this INSERT dropped both, so an
    // owner looking at sixteen live signals and ten silent cards concluded the
    // feeds were ignored. Same failure class as 028.
    const hasSignalImpact = await analyticsPool
      .query(`SELECT 1 FROM information_schema.columns
               WHERE table_name = 'recommendations'
                 AND column_name = 'signal_impact' LIMIT 1`)
      .then((r) => r.rowCount > 0)
      .catch(() => false);
    // Migration 028 - the gate verdict, the predictive range, the promise floor,
    // the cost of being wrong, the calibration basis and the slate's budget.
    //
    // EVERY ONE OF THESE WAS BEING THROWN AWAY TWICE. Python's response model
    // dropped them (pydantic's default extra="ignore" against an undeclared
    // field), and this INSERT's explicit column list dropped whatever survived.
    // Both allow-lists, neither logging a thing. The figures were computed,
    // unit-tested, and never reached a card an owner could see.
    const hasDecisionFigures = await analyticsPool
      .query(`SELECT 1 FROM information_schema.columns
               WHERE table_name = 'recommendations'
                 AND column_name = 'gate_state' LIMIT 1`)
      .then((r) => r.rowCount > 0)
      .catch(() => false);

    // The A/B holdout. A deterministic slice of recs is marked 'holdout' -
    // persisted and EVALUATED exactly like any other, but never shown
    // (getLatest and the Python history exclude them). The effectiveness
    // report's shown-vs-holdout block then answers the only question that
    // matters: would it have sold anyway?
    //
    // ON BY DEFAULT, AND THAT IS THE CHANGE.
    //   This defaulted to 0 - built, never switched on - which is why the only
    //   evidence this programme has is a retrospective backtest that could
    //   measure forecasting but not causation. The gate in sheet 17 needs
    //   roughly a quarter of accumulated outcomes before it can judge
    //   anything, so every week it stayed off was a week added to the end of
    //   the programme.
    //
    //   10% is the cost: one card in ten is withheld from the owner so that
    //   the other nine can be proven to do something. Set REC_HOLDOUT_PCT=0 to
    //   turn it off, at the price of never knowing.
    const holdoutPct = Math.min(
      Math.max(parseInt(process.env.REC_HOLDOUT_PCT ?? '10', 10) || 0, 0), 50
    );

    // The day archive's JSONB array, built as we insert so each element carries
    // the real `recommendations.id` - that is what lets per-rec outcomes
    // (evaluations, votes, action claims) join straight back to the day cell.
    const archived = [];
    // Cards whose confidence_basis was missing or unknown and went in as
    // 'not_recorded'. Each is named as it happens; the total is logged once
    // after the loop so a run that labels every card shows up as one line
    // with a number in it rather than ten identical warnings.
    let basisDefects = 0;

    for (const r of run.recommendations) {
      const category = normalizeVocab(r.category);
      const actionType = normalizeVocab(r.action_type);
      const unknown = [];
      if (!KNOWN_CATEGORIES.has(category)) unknown.push(`category '${r.category}'`);
      if (!KNOWN_ACTION_TYPES.has(actionType)) unknown.push(`action_type '${r.action_type}'`);
      if (unknown.length) {
        console.warn(
          `[Recs] non-canonical ${unknown.join(', ')} persisted for ` +
          `client=${run.client_id} location=${run.location_id} rank=${r.rank}`
        );
      }
      const cols = ['run_id', 'client_id', 'location_id', 'rank', 'category', 'action_type',
        'primary_skus', 'quantity_hint', 'rationale', 'signals_cited', 'confidence', 'valid_through'];
      const vals = [
        runId,
        run.client_id,
        run.location_id,
        r.rank,
        category,
        actionType,
        Array.isArray(r.primary_skus) ? r.primary_skus : [],
        r.quantity_hint ?? null,
        r.rationale ?? '',
        Array.isArray(r.signals_cited) ? r.signals_cited : [],
        typeof r.confidence === 'number' ? r.confidence : 0,
        // valid_through may arrive as a date or a full ISO datetime - store the date part.
        r.valid_through ? String(r.valid_through).slice(0, 10) : null,
      ];
      if (hasUpc) {
        cols.push('reference_upc');
        vals.push(r.reference_upc ?? null);
      }
      if (hasOrderQty) {
        // Canonical reorder quantity from the shared demand engine (the same
        // figure the Buying tab prints) - migration 007, probe-and-degrade.
        cols.push('suggested_order_qty');
        vals.push(Number.isFinite(r.suggested_order_qty) ? r.suggested_order_qty : null);
      }
      if (hasEngineFacts) {
        // The rate the DECISION was taken on. The card shows this rather than
        // recomputing from the Buying screen's 90-day average, which for a
        // product whose sales have just collapsed is a different and worse
        // number - see migration 022.
        cols.push('engine_daily_rate', 'engine_days_cover', 'engine_on_hand');
        vals.push(
          Number.isFinite(r.engine_daily_rate) ? r.engine_daily_rate : null,
          Number.isFinite(r.engine_days_cover) ? r.engine_days_cover : null,
          Number.isFinite(r.engine_on_hand) ? r.engine_on_hand : null,
        );
      }
      if (hasEngineFamily) {
        // A non-empty string or null - never '' - so "the engine did not say"
        // stays distinguishable from a family it did name.
        cols.push('engine_family');
        vals.push(typeof r.engine_family === 'string' && r.engine_family.length
          ? r.engine_family : null);
      }
      if (hasOrderBy) {
        // THE DATE STAYS A STRING. The engine sends 'YYYY-MM-DD'; it is handed
        // to the DATE column as that string and read back `::text`, never
        // through a JS Date - DAILY-CAPTURE.md section 4 is the day this went
        // wrong on the backend. Anything that is not a date string is null,
        // not today: an invented deadline is worse than none.
        //
        // The lead time is a positive whole number of days or null, and the
        // basis is one of the two words the Python schema allows or null -
        // absence, never a guess, on all three.
        cols.push('order_by', 'lead_time_days', 'lead_time_basis');
        vals.push(
          dateString(r.order_by),
          Number.isInteger(r.lead_time_days) && r.lead_time_days > 0 ? r.lead_time_days : null,
          LEAD_TIME_BASES.has(r.lead_time_basis) ? r.lead_time_basis : null,
        );
      }
      if (hasSignalImpact) {
        // The block only when it IS a block, the sentence only when it says
        // something; null otherwise, never [] or ''. A refused entry inside
        // the array carries beta null with a reason - stored verbatim, because
        // "not measurable" and "measured as nothing" are different facts and
        // the engine is the only party that can tell them apart.
        cols.push('signal_impact', 'signal_impact_summary');
        vals.push(
          Array.isArray(r.signal_impact) ? JSON.stringify(r.signal_impact) : null,
          typeof r.signal_impact_summary === 'string' && r.signal_impact_summary.trim().length
            ? r.signal_impact_summary : null,
        );
      }
      if (hasDecisionFigures) {
        // ABSENCE IS NOT ZERO, and `num` is why this is not a one-liner. A
        // missing holding cost means the POS sends no unit cost, not that being
        // wrong is free; a missing range means the interval was refused, not
        // that the span is zero. Every value is coerced to null unless it is a
        // finite number, so an undefined, a NaN or a string never lands as 0.
        const num = (v) => (Number.isFinite(v) ? v : null);
        const bool = (v) => (typeof v === 'boolean' ? v : null);
        const text = (v) => (typeof v === 'string' && v.length ? v : null);
        const basis = coerceBasis(r.confidence_basis);
        if (basis.reason) {
          basisDefects += 1;
          console.warn(
            `[Recs] confidence_basis ${basis.reason} persisted as '${basis.basis}' for ` +
            `client=${run.client_id} location=${run.location_id} rank=${r.rank} ` +
            `action=${actionType} sku=${(Array.isArray(r.primary_skus) ? r.primary_skus : [])[0] || '-'}`
          );
        }
        cols.push(
          'gate_state', 'gate_reason', 'gate_displayed', 'gate_measured',
          'expected_range_low', 'expected_range_high',
          'expected_range_coverage', 'expected_range_basis',
          'expected_range_refused',
          'promise_floor_units', 'promise_floor_coverage',
          'promise_floor_basis', 'promise_floor_refused',
          'increment_promise_basis',
          'holding_cost_if_unsold', 'holding_cost_basis',
          'confidence_basis', 'confidence_raw',
          'portfolio_cash_committed', 'portfolio_cash_budget',
          'portfolio_units_committed', 'portfolio_shelf_budget_units',
          'portfolio_coverage', 'portfolio_offered', 'portfolio_assumptions',
        );
        vals.push(
          text(r.gate_state), text(r.gate_reason),
          bool(r.gate_displayed), bool(r.gate_measured),
          num(r.expected_range_low), num(r.expected_range_high),
          num(r.expected_range_coverage), text(r.expected_range_basis),
          text(r.expected_range_refused),
          num(r.promise_floor_units), num(r.promise_floor_coverage),
          text(r.promise_floor_basis), text(r.promise_floor_refused),
          text(r.increment_promise_basis),
          num(r.holding_cost_if_unsold), text(r.holding_cost_basis),
          // NEVER NULL, and never a word the vocabulary lacks (migration 040).
          // A card arriving with no basis, or an invented one, is persisted
          // as 'not_recorded' - labelled, not dropped - and named below, once
          // per card, with a per-run count after the loop. `text()` alone
          // would hand the INSERT an explicit NULL, which the column's
          // DEFAULT does not rescue.
          basis.basis, num(r.confidence_raw),
          num(r.portfolio_cash_committed), num(r.portfolio_cash_budget),
          num(r.portfolio_units_committed), num(r.portfolio_shelf_budget_units),
          num(r.portfolio_coverage), num(r.portfolio_offered),
          Array.isArray(r.portfolio_assumptions) ? r.portfolio_assumptions : null,
        );
      }
      // STABLE ACROSS RUNS. Keyed on (store, sku, family) and never on runId
      // or rank, both of which move every run - see lib/holdoutAssignment.js
      // for what the previous key did and why it made the measurement
      // meaningless.
      const isHoldout = holdout.isHoldout({
        clientId: run.client_id,
        locationId: run.location_id,
        sku: (Array.isArray(r.primary_skus) ? r.primary_skus : [])[0],
        family: actionType,
      }, holdoutPct);
      if (isHoldout) {
        cols.push('status');
        vals.push('holdout');
      }
      const recIns = await client.query(
        `INSERT INTO recommendations (${cols.join(', ')})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING id`,
        vals
      );

      archived.push({
        id: recIns.rows[0].id,
        rank: r.rank,
        category,
        action_type: actionType,
        primary_skus: Array.isArray(r.primary_skus) ? r.primary_skus : [],
        quantity_hint: r.quantity_hint ?? null,
        rationale: r.rationale ?? '',
        signals_cited: Array.isArray(r.signals_cited) ? r.signals_cited : [],
        confidence: typeof r.confidence === 'number' ? r.confidence : 0,
        valid_through: r.valid_through ? String(r.valid_through).slice(0, 10) : null,
        status: isHoldout ? 'holdout' : null,
        reference_upc: r.reference_upc ?? null,
        suggested_order_qty: Number.isFinite(r.suggested_order_qty) ? r.suggested_order_qty : null,
      });
    }

    if (basisDefects) {
      console.warn(
        `[Recs] ${basisDefects} of ${run.recommendations.length} cards persisted with ` +
        `confidence_basis 'not_recorded' for client=${run.client_id} ` +
        `location=${run.location_id}: the emitting path did not label its figure`
      );
    }

    // THE CLAIMS THE LIFECYCLE RETIRED THIS MORNING (migration 034). Written
    // in the SAME transaction as the cards, so a card from this run shares the
    // retirement's timestamp and getCardHistory can tell it from a fresher
    // claim issued later. Without this row the engine re-judges the same card
    // tomorrow and suppresses until "tomorrow + 14" - forever, or not at all.
    //
    // ON CONFLICT DO NOTHING: a same-day re-run decides the same retirement
    // and must not fail the run over it. Probe-and-degrade like every other
    // optional column: an estate without the table persists the run and
    // simply keeps yesterday's behaviour.
    const retirements = Array.isArray(run.card_retirements) ? run.card_retirements : [];
    if (retirements.length && await retirementTableExists(analyticsPool)) {
      const num = (v) => (Number.isFinite(v) ? v : null);
      const text = (v) => (typeof v === 'string' && v.length ? v : null);
      const dateOnly = (v) => (v ? String(v).slice(0, 10) : null);
      for (const t of retirements) {
        const sku = text(t.sku);
        const retiredAt = dateOnly(t.retired_at);
        const until = dateOnly(t.suppressed_until);
        const rule = text(t.rule);
        if (!sku || !retiredAt || !until || !rule) {
          console.warn(
            `[Recs] card retirement skipped for client=${run.client_id} ` +
            `location=${run.location_id}: missing sku/retired_at/suppressed_until/rule`
          );
          continue;
        }
        await client.query(
          `INSERT INTO recommendation_retirements (
             client_id, location_id, sku, retired_at, suppressed_until,
             retirement_rule, reason, first_issued, open_days_since,
             recovery_ratio, tail_probability, distribution, run_id)
           VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8::date, $9, $10, $11, $12, $13)
           ON CONFLICT (client_id, location_id, sku, retired_at) DO NOTHING`,
          [run.client_id, run.location_id, sku, retiredAt, until, rule,
            text(t.reason), dateOnly(t.first_issued),
            Number.isInteger(t.open_days_since) ? t.open_days_since : null,
            num(t.recovery_ratio), num(t.tail_probability), text(t.distribution),
            runId]
        );
      }
    }

    // The day archive commits WITH the run rows (migration 015): the two must
    // never disagree about what was recommended on a day. A failure here
    // rolls the run back, which is the intended trade - a run that cannot be
    // archived at day grain is not a run we want half-recorded.
    if (await dailySvc.dailyRecTableExists(analyticsPool).catch(() => false)) {
      await dailySvc.persistDailyRecommendations(client, {
        clientId: run.client_id,
        locationId: run.location_id,
        recDate: day.date,
        dayBasis: day.basis,
        timezone: day.timezone,
        runId,
        // The signals this set was reasoned from. Usually the same day; the
        // Python service reports its own key when a cached bundle came from
        // late the previous local day.
        signalDate: capture.signal_date || day.date,
        generatedAt: run.generated_at,
        dataAsOf: run.data_as_of,
        recommendations: archived,
        candidateCount: run.candidate_count,
        droppedInvalid: run.dropped_invalid,
        engine: run.engine || {},
      });
    }

    await client.query('COMMIT');
    return { runId, day, archived };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// One live run per store: a second /generate (double click, page re-visit,
// cron overlapping a manual run) joins the in-flight promise instead of firing
// a second Python/LLM run for the same tenant.
const inFlightRuns = new Map(); // `${clientId}:${locationId}` -> Promise<summary>

/**
 * Generate + persist for one store. This is the unit the daily cron fans out
 * over, and the manual /generate endpoint reuses it. Concurrent calls for the
 * same store coalesce onto one run.
 * @returns {object} { runId, recommendation_count, data_as_of, generated_at }
 */
function generateAndPersist(analyticsPool, clientId, locationId) {
  const key = `${clientId}:${locationId}`;
  const existing = inFlightRuns.get(key);
  if (existing) return existing;

  const p = (async () => {
    const run = await callPythonService(clientId, locationId);
    const { runId, day } = await persistRun(analyticsPool, run);
    // A new run changes the pending-actions answer immediately - don't let
    // the 5-min cache keep serving the previous run.
    evalSvc.invalidatePendingCache(clientId, locationId);
    logger.info('Recommendations generated + persisted', {
      clientId, locationId, runId, count: run.recommendations.length,
      recDate: day.date, dayBasis: day.basis,
    });
    // Record the day's external signals (migration 014). AWAITED, unlike the
    // SKU-state capture below, because the run has already committed and the
    // signal row is what a later backtest replays - letting the process move
    // on before it lands would make the capture racy for no gain. It never
    // throws: captureSignalsForRun turns every failure into a warning, so a
    // signal-capture problem can cost the signal row and nothing else.
    const signalCapture = await dailySvc.captureSignalsForRun(analyticsPool, run, day);
    if (signalCapture?.fidelity === 'display_trimmed') {
      // Worth saying out loud: these rows are honest history but NOT training
      // data, and the fix is shipping a Python service that reports the full
      // bundle (see signal_capture in API_CONTRACT.md §2).
      logger.warn(
        `[DailySnapshot] client=${clientId} location=${locationId} day=${day.date}: ` +
        'stored the display-trimmed snapshot - the rec service did not report a full signal bundle.'
      );
    }
    // Snapshot per-SKU stock/price state NOW - the effectiveness evaluator
    // later asks "did they restock / mark down vs. how things stood at rec
    // time". Fire-and-forget: a snapshot failure must never fail the run
    // (the eval cron re-captures recent recs, and evaluation degrades to
    // sales-only evidence without it).
    evalSvc.captureForRun(analyticsPool, clientId, locationId, runId).catch((err) =>
      logger.warn(`[RecEval] baseline capture failed for run ${runId}: ${err.message}`)
    );
    // THE ADMISSION AUDIT AT ISSUE (sheet 02, migration 019). Until 19 October
    // 2026 the admission decision - expected profit, the dollar floor, shown
    // or withheld and why - was recorded only when a browser fetched /latest,
    // because that is where applyAdmission runs. A store nobody opened had
    // cards with no admission row at all: Tuscany, 30 cards over three runs,
    // 0 rows, so the money audit could not say what profit any card promised
    // when it was issued. Read the run back here the way the owner's screen
    // would; getLatest records the audit on the way, with the same decision
    // the screen will later make (ON CONFLICT DO UPDATE keeps the latest).
    // Tenant-scoped pool, as the request path uses: the bare pool returns zero
    // product rows under RLS and every card would be audited as costless.
    // Best-effort and awaited: a failure costs the audit row, never the run.
    try {
      const { getPool, makeTenantScopedPool } = require('../database/connection');
      await getLatest(analyticsPool, makeTenantScopedPool(getPool(), clientId, locationId),
        clientId, locationId, { awaitAudit: true });
    } catch (err) {
      logger.warn(`[RecGate] admission audit at issue failed for run ${runId}: ${err.message}`);
    }
    return {
      runId,
      recommendation_count: run.recommendations.length,
      data_as_of: run.data_as_of,
      generated_at: run.generated_at,
    };
  })().finally(() => inFlightRuns.delete(key));

  inFlightRuns.set(key, p);
  return p;
}

// ─── 3. Read the latest run (+ enrich SKUs from syncgo) ──────────────────────

/**
 * Newest run for a store with its items, each enriched with product details for
 * its primary_skus (name / price / current stock) pulled from `syncgo`, plus the
 * store's thumbs vote on each rec (one role per store - no per-user votes).
 *
 * @param {import('pg').Pool} analyticsPool  recs live here
 * @param {import('pg').Pool} syncgoPool     products live here
 * @returns {object|null} { run, recommendations } or null when no run exists yet
 */
/**
 * May this store serve cards? One rule, in one place.
 *
 * Pure so it can be tested exhaustively and so the audit page can reach the
 * same verdict as the serving path without restating the logic - the gate is
 * the last thing in the estate that should disagree with itself.
 *
 * THREE STATES, NOT TWO. "Nobody has measured this store" is not "this store
 * failed". Conflating them withholds every card at every store the first time
 * the flag is honoured, which is an outage and not a cautious rollout, so
 * `measured` is carried separately and an unmeasured store SERVES.
 *
 * EXPIRY REMOVES PERMISSION AND NEVER GRANTS IT. A verdict past its
 * `valid_until`, or one that never stated one, no longer speaks for today, so
 * `displayed` is forced false. It is deliberately not allowed to flip a
 * withheld store open: "we never proved this store is safe" stays true when the
 * proof ages out, while "we proved it in June" does not survive to November.
 *
 * A VERDICT WITH NO `valid_until` IS EXPIRED, not valid forever. Rows published
 * before migration 033 have none, and grandfathering them in would preserve
 * exactly the behaviour the expiry exists to end.
 *
 * @param {object} verdict a row from store_gate_verdict
 * @param {{enforced: boolean, now?: Date}} opts
 */
function storeGateDecision(verdict, { enforced = false, now = new Date() } = {}) {
  // A CALENDAR DAY, NOT A TIMESTAMP, and never String()'d.
  //
  // node-postgres hands back a DATE column as a JS Date, and `String(date)`
  // gives "Wed Dec 31 2026 ..." - whose first ten characters are "Wed Dec 31".
  // Feeding that to `new Date()` yields Invalid Date, every comparison against
  // it is false, and EVERY VERDICT READS AS VALID FOREVER: the precise bug the
  // expiry exists to prevent, reintroduced by the parsing. A test caught it
  // only because one case passed for the wrong reason.
  //
  // It also must not go through toISOString(). The driver parses a DATE at
  // LOCAL midnight, so on a +05:30 box toISOString() moves it to the previous
  // day - the same shift this file already guards elsewhere with ::text casts.
  // So the day is read from the local parts.
  const dayOf = (v) => {
    if (v == null) return null;
    if (v instanceof Date) {
      const p = (n) => String(n).padStart(2, '0');
      return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    }
    return String(v).slice(0, 10);
  };

  const validUntil = dayOf(verdict.valid_until);
  // Compared as ISO day STRINGS, which sorts correctly and has no timezone in
  // it at all. A verdict is good THROUGH its last valid day, so this is `<`
  // rather than `<=` - expiring at midnight on the morning of the stated date
  // would make the date mean one day less than it says.
  const expired = !validUntil || validUntil < dayOf(now);
  const wasDisplayed = Boolean(verdict.displayed);
  return {
    measured: Boolean(verdict.measured),
    displayed: wasDisplayed && !expired,
    state: verdict.state || null,
    reason: expired && wasDisplayed
      ? `verdict_expired:${validUntil || 'no_valid_until'}`
      : (verdict.reason || null),
    expired,
    valid_until: validUntil,
    verdict_as_of: dayOf(verdict.verdict_as_of),
    // TRI-STATE, deliberately. NULL means the publisher did not say, which is
    // unknown rather than healthy - `??` keeps false distinct from absent where
    // `||` would collapse both to null (migration 033).
    calibration_is_stale: verdict.calibration_is_stale ?? null,
    enforced: Boolean(enforced),
    withheld_all: false,
  };
}

async function getLatest(analyticsPool, syncgoPool, clientId, locationId, opts = {}) {
  // rec_date arrives with migration 015 - probe and degrade, so a deploy that
  // runs ahead of the migration still serves. ::text because node-postgres
  // parses a DATE at LOCAL midnight and would shift the day west of UTC.
  const hasRecDate = await dailySvc.runDayColumnsExist(analyticsPool).catch(() => false);
  const runRes = await analyticsPool.query(
    `SELECT id, generated_at, data_as_of, candidate_count,
            recommendation_count, dropped_invalid, signal_snapshot
            ${hasRecDate ? ', rec_date::text AS rec_date' : ''}
       FROM recommendation_runs
      WHERE client_id = $1 AND location_id = $2
      ORDER BY generated_at DESC, id DESC
      LIMIT 1`,
    [clientId, locationId]
  );
  const run = runRes.rows[0];
  if (!run) return null;

  await ensureVoteColumn(analyticsPool);
  const hasOrderQty = await evalSvc.suggestedOrderQtyColumnExists(analyticsPool).catch(() => false);
  const hasEngineFacts = await analyticsPool
    .query(`SELECT 1 FROM information_schema.columns
             WHERE table_name = 'recommendations'
               AND column_name = 'engine_daily_rate' LIMIT 1`)
    .then((r) => r.rowCount > 0)
    .catch(() => false);
  // The basis is what tells a reader whether the confidence figure SEPARATES
  // this card from the next one. The engine appends `_flat_slate` when every
  // card in the finished slate scored the same and `_constant` when the curve
  // has one level and can only return one number; without it the stored card
  // cannot tell a real ranking from nine identical figures, and the renderer
  // would show the same word on all of them as though it meant something.
  const hasConfidenceBasis = await analyticsPool
    .query(`SELECT 1 FROM information_schema.columns
             WHERE table_name = 'recommendations'
               AND column_name = 'confidence_basis' LIMIT 1`)
    .then((r) => r.rowCount > 0)
    .catch(() => false);
  // The owner's claim (004) and the card's fulfilment state (039). Until 039
  // the card shape carried status and vote and nothing about whether the
  // store had FOLLOWED the card - so "Completed" lived in the browser.
  const hasClaims = await evalSvc.actionClaimColumnExists(analyticsPool).catch(() => false);
  const hasFulfilment = hasClaims && await evalSvc.fulfilmentColumnsExist(analyticsPool).catch(() => false);
  // The engine's deadline (042). `order_by::text` for the same reason as
  // rec_date above: a DATE parsed at local midnight shifts a day west of UTC,
  // and the card would print yesterday's deadline on a recommendation made
  // this morning.
  const hasOrderBy = await analyticsPool
    .query(`SELECT 1 FROM information_schema.columns
             WHERE table_name = 'recommendations'
               AND column_name = 'order_by' LIMIT 1`)
    .then((r) => r.rowCount > 0)
    .catch(() => false);
  // The signal disclosure (043): what each live signal was found to do to this
  // card's family, and its one-sentence summary. [] and null on a card from
  // before the migration - the engine's block was never stored for it, and
  // a surface that shows nothing there is telling the truth.
  const hasSignalImpact = await analyticsPool
    .query(`SELECT 1 FROM information_schema.columns
             WHERE table_name = 'recommendations'
               AND column_name = 'signal_impact' LIMIT 1`)
    .then((r) => r.rowCount > 0)
    .catch(() => false);
  const itemsRes = await analyticsPool.query(
    `SELECT id, rank, category, action_type, primary_skus, quantity_hint,
            rationale, signals_cited, confidence, valid_through, status, vote${hasOrderQty ? ', suggested_order_qty' : ''}${hasEngineFacts ? ', engine_daily_rate, engine_days_cover, engine_on_hand' : ''}${hasConfidenceBasis ? ', confidence_basis, confidence_raw' : ''}
            ${hasOrderBy ? ', order_by::text AS order_by, lead_time_days, lead_time_basis' : ''}
            ${hasSignalImpact ? ', signal_impact, signal_impact_summary' : ''}
            ${hasClaims ? ', action_claim, action_claim_at' : ''}
            ${hasFulfilment ? ', fulfilment_state, fulfilment_evidence, fulfilment_confirmed_at, dismiss_reason' : ''}
       FROM recommendations
      WHERE run_id = $1 AND client_id = $2 AND location_id = $3
        AND (status IS DISTINCT FROM 'holdout')
      ORDER BY rank ASC`,
    [run.id, clientId, locationId]
  );
  const items = itemsRes.rows;

  // Enrich SKUs → product name / price / on-hand from syncgo (one query for all).
  // This is the only remote-warehouse hit on the read path (the SKUs are already
  // validated upstream); never let a slow/down warehouse sink the whole read -
  // degrade to SKU-only so /latest always returns fast from the local DB.
  const skus = [...new Set(items.flatMap((i) => i.primary_skus || []))];
  let productBySku = new Map();
  try {
    productBySku = await fetchProducts(syncgoPool, clientId, locationId, skus);
  } catch (enrichErr) {
    logger.warn('Recommendation enrichment skipped (warehouse slow/unreachable)', {
      error: enrichErr.message, clientId, locationId,
    });
  }

  const recommendations = items.map((i) => ({
    id: i.id,
    rank: i.rank,
    category: i.category,
    action_type: i.action_type,
    primary_skus: i.primary_skus || [],
    products: (i.primary_skus || []).map((sku) => productBySku.get(sku) || {
      sku, product_name: null, price: null, on_hand: null,
    }),
    quantity_hint: i.quantity_hint,
    // Canonical reorder quantity (shared demand engine) - null pre-migration,
    // for non-buy actions, or when the engine had no figure for the SKU.
    suggested_order_qty: hasOrderQty ? (i.suggested_order_qty ?? null) : null,
    // The figures the DECISION was taken on. The card prefers these over the
    // Buying screen's 90-day average, which is a different and staler rate for
    // any product whose sales have recently changed - see migration 022.
    // numeric comes back from pg as a string; the card does arithmetic on it.
    engine_daily_rate: hasEngineFacts && i.engine_daily_rate != null
      ? Number(i.engine_daily_rate) : null,
    engine_days_cover: hasEngineFacts && i.engine_days_cover != null
      ? Number(i.engine_days_cover) : null,
    engine_on_hand: hasEngineFacts && i.engine_on_hand != null
      ? Number(i.engine_on_hand) : null,
    // The day to order by, decided by the engine and stored (042). A
    // 'YYYY-MM-DD' string or null; the card prefers it to its own arithmetic
    // and Purchasing shows it on the same SKU's row, so the two screens agree
    // because they are reading one number. Null is "the engine stated none"
    // (markdown, LLM path, unknown stock) and the frontend falls back.
    order_by: hasOrderBy ? (i.order_by || null) : null,
    lead_time_days: hasOrderBy && i.lead_time_days != null
      ? Number(i.lead_time_days) : null,
    lead_time_basis: hasOrderBy ? (i.lead_time_basis || null) : null,
    rationale: i.rationale,
    signals_cited: i.signals_cited || [],
    // What each live signal was found to do here (043). An array, possibly
    // empty, never null - so the card can iterate; the sentence is null where
    // the engine sent none, and the card prints nothing rather than a filler.
    signal_impact: hasSignalImpact && Array.isArray(i.signal_impact) ? i.signal_impact : [],
    signal_impact_summary: hasSignalImpact && typeof i.signal_impact_summary === 'string'
      && i.signal_impact_summary.length ? i.signal_impact_summary : null,
    confidence: i.confidence,
    valid_through: i.valid_through,
    status: i.status,
    ...voteShape(i.vote),
    // ── Did the store FOLLOW this card? (migration 039) ──────────────────
    // action_claim is what the owner SAID ('did' | 'did_not' | 'dismissed' |
    // null); fulfilment_state is what the DATA says about it. The frontend
    // derives its Open / Accepted / Marked done / Completed tabs from these
    // fields and nothing else - 'completed' only when the state is
    // 'confirmed'. fulfilment_summary is the one sentence the card prints
    // under the chip ("Confirmed: 24 units received on 14 Oct (invoice
    // #4471)", "Marked done by you on 12 Oct; no order has appeared yet").
    // All null on a backend whose migrations stop before 004 / 039.
    action_claim: hasClaims ? (i.action_claim || null) : null,
    action_claim_at: hasClaims ? (i.action_claim_at || null) : null,
    dismiss_reason: hasFulfilment ? (i.dismiss_reason || null) : null,
    fulfilment_state: hasFulfilment ? (i.fulfilment_state || 'pending') : null,
    fulfilment_confirmed_at: hasFulfilment ? (i.fulfilment_confirmed_at || null) : null,
    fulfilment_summary: hasFulfilment
      ? evalSvc.fulfilmentSummary({
        state: i.fulfilment_state || 'pending',
        evidence: i.fulfilment_evidence,
        claim: i.action_claim || null,
        claim_at: i.action_claim_at || null,
        valid_through: i.valid_through,
        action_type: i.action_type,
      })
      : null,
  }));

  // ── Admission (sheet 02): show it only if it is valid AND its profit claim
  // is supportable. A markdown for a store whose POS sends no cost cannot
  // state a margin, so it is withheld WITH A REASON rather than shown with a
  // number invented from a zero cost. Withheld items are returned separately,
  // never silently dropped.
  const quality = await recGate.getStoreQuality(analyticsPool, clientId, locationId);

  // THE MEASURED RATE FOR EVERY RECOMMENDED SKU, so the money figure is bounded
  // by what will actually sell rather than by what is on the shelf. Units per
  // OPEN day, from the one definition in featureStoreService.
  //
  // Best-effort: a store whose feature store has not been built yet still gets
  // its recommendations, with the older shelf-based figure and no claim that it
  // is better than it is.
  let rates = null;
  try {
    rates = await featureStore.ratesBySku(analyticsPool, {
      clientId, locationId, asOf: run.data_as_of || dailySvc.toDateOnly?.(new Date())
        || new Date().toISOString().slice(0, 10),
      windowDays: 90, skus,
    });
  } catch (rateErr) {
    logger.warn('Rate lookup failed; profit figures fall back to shelf units', {
      error: rateErr.message, clientId, locationId,
    });
  }

  const admission = recGate.applyAdmission(recommendations, quality, { rates });

  // Best-effort audit; a failure here must never hide a recommendation. Not
  // awaited on the owner's read path (the screen should not wait on an INSERT
  // per card); awaited when generateAndPersist calls this at issue, so the
  // audit rows exist before the run is reported done and a caller that ends
  // its pool afterwards does not cut the inserts off half way (observed:
  // 5 of 10 rows for Tuscany run 735 when the script ended the pool).
  const auditWritten = recGate
    .recordAdmissions(analyticsPool, clientId, locationId,
      run.rec_date || null, admission.decisions)
    .catch(() => {});
  if (opts.awaitAudit) await auditWritten;

  // ── The gate (sheet 17): has this FAMILY actually worked at THIS store?
  //
  // Sheet 02's admission above asks whether a recommendation is valid and its
  // profit claim supportable. This asks a different and harder question -
  // whether recommending this kind of thing here has ever been shown to
  // change anything, measured against a volume-matched null.
  //
  // A family stays in shadow until it has beaten that null at this store:
  // computed, stored, scored, NOT displayed. Enforcement is off until
  // families start going live (REC_GATE_ENFORCED), because the gate needs a
  // quarter of accumulated outcomes and enforcing on day one would show every
  // store nothing at all - a rollout, not an outage.
  let gated = { shown: admission.visible, withheld: [], enforced: false };
  let gateAvailable = false;
  try {
    const gateStates = await familyGate.statesForStore(
      analyticsPool, clientId, locationId
    );
    gateAvailable = gateStates.available;
    if (gateAvailable) {
      gated = familyGate.applyGate(admission.visible, gateStates.states);
    }
  } catch (gateErr) {
    // A gate that cannot be read must not delete a store's recommendations.
    // It fails OPEN here and says so loudly, which is the opposite of the
    // fail-closed default for a family with no row - the difference is
    // between "we have not proven this" and "we could not ask".
    logger.warn('Family gate unavailable; serving ungated', {
      error: gateErr.message, clientId, locationId,
    });
  }

  // ── THE STORE GATE, on the read path ────────────────────────────────────
  //
  // The FAMILY gate above has been applied here for a while. The STORE gate -
  // sheet 17's `store_gate_verdict`, which asks whether this store's cards are
  // trustworthy at all - was written, published and read by the audit page, and
  // never consulted when serving. So a store the gate had judged unfit went on
  // showing cards.
  //
  // THE THREE STATES ARE NOT TWO. "Nobody has measured this store" is not "this
  // store failed", and conflating them withholds every card at every store the
  // first time the flag is honoured, which is an outage rather than a cautious
  // rollout. That is why `measured` is carried separately from `displayed` and
  // why an unmeasured store SERVES.
  //
  // EXPIRY CAN ONLY REMOVE PERMISSION, NEVER GRANT IT. A verdict with no
  // `valid_until`, or one whose date has passed, no longer speaks for today - so
  // `displayed` is forced false. It is not allowed to flip a withheld store open:
  // "we never proved this store is safe" stays true when the proof ages out,
  // while "we proved it in June" does not survive to November.
  let storeGate = {
    measured: false, displayed: true, state: null, reason: null,
    expired: false, valid_until: null, verdict_as_of: null,
    calibration_is_stale: null, enforced: false, withheld_all: false,
  };
  try {
    const verdict = await getStoreGateVerdict(analyticsPool, clientId, locationId);
    if (verdict) {
      storeGate = storeGateDecision(verdict, { enforced: gated.enforced });
      if (storeGate.enforced && storeGate.measured && !storeGate.displayed) {
        // Everything moves to `withheld` rather than vanishing, so the count
        // and the reason stay answerable on a support call.
        const blocked = gated.shown.map((r) => ({
          ...r, withheld_reason: `store_gate:${storeGate.reason}`,
        }));
        gated = { ...gated, shown: [], withheld: [...gated.withheld, ...blocked] };
        storeGate.withheld_all = true;
        logger.warn('Store gate withheld every card', {
          clientId, locationId, state: storeGate.state,
          reason: storeGate.reason, cards: blocked.length,
        });
      }
    }
  } catch (verdictErr) {
    // Same rule as the family gate: a gate that cannot be READ fails open and
    // says so. "We could not ask" is not "we have not proven this".
    logger.warn('Store gate unavailable; serving ungated', {
      error: verdictErr.message, clientId, locationId,
    });
  }

  return {
    run: {
      id: run.id,
      generated_at: run.generated_at,
      data_as_of: run.data_as_of,
      candidate_count: run.candidate_count,
      recommendation_count: run.recommendation_count,
      dropped_invalid: run.dropped_invalid,
      signal_snapshot: run.signal_snapshot || {},
    },
    // Quality is part of the answer, not metadata: an owner seeing three
    // recommendations instead of nine is entitled to know why.
    quality: {
      verdict: quality.verdict,
      ungated: Boolean(quality.ungated),
      unavailable_fields: quality.unavailable_fields || [],
      staleness_days: quality.staleness_days ?? null,
      never_synced: Boolean(quality.never_synced),
    },
    recommendations: gated.shown,
    withheld: [...admission.withheld, ...gated.withheld],
    withheld_count: admission.withheld.length + gated.withheld.length,
    // The gate's own state, so an owner seeing fewer families knows it is a
    // measurement in progress rather than a fault - and so a support call has
    // something to read.
    gate: {
      available: gateAvailable,
      enforced: gated.enforced,
      withheld_by_gate: gated.withheld.length,
      // Sheet 17's STORE-level verdict, reported whether or not it is being
      // enforced, so the audit page and this screen describe the same store.
      store: storeGate,
    },
  };
}

/** Map sku → { sku, product_name, price, on_hand } for the given SKUs (syncgo). */
async function fetchProducts(syncgoPool, clientId, locationId, skus) {
  const map = new Map();
  if (!skus.length) return map;
  const { rows } = await syncgoPool.query(
    `SELECT sku, product_name, price, stock_qty, cost
       FROM products
      WHERE client_id = $1 AND location_id = $2
        AND sku = ANY($3::text[])
        AND is_deleted IS NOT TRUE`,
    [clientId, locationId, skus]
  );
  for (const r of rows) {
    map.set(r.sku, {
      sku: r.sku,
      product_name: r.product_name ?? null,
      price: r.price != null ? Number(r.price) : null,
      on_hand: r.stock_qty != null ? parseInt(r.stock_qty, 10) : null,
      // Unit cost, for the margin the admission gate needs to state a profit.
      // NULL - never 0 - when absent: a cost of zero is a product whose cost
      // we do not know, and treating it as free yields a 100% margin.
      cost: r.cost != null && Number(r.cost) > 0 ? Number(r.cost) : null,
    });
  }
  return map;
}

// ─── 3b. The case file (Phase 2) ─────────────────────────────────────────────
// One rec, fully opened: full rationale (never the 180-char gist), product
// names, the run it came from, and its cited signals RESOLVED against the
// run's signal_snapshot so the UI can show "Heatwave - 97°F Fri" instead of
// "heat_advisory".

// The snapshot (see the Python side's SignalBundle.snapshot()) is NOT keyed by
// signal key - it is { weather: {...}|null, sports: [...], events: [...],
// holidays: [...], news: [...], social: [...], active_keys: [...] }. Cited
// keys map onto it:
//   heat_advisory / cold_snap / severe_weather → the weather object
//   <league>_home_game                         → sports[] entry by league
//   holidays / events / news                   → entry with a matching .key
//   trend_<term>                               → social[] entry by .key
//   event_concert / event_sports / event_arts /
//   event_festival / event_nearby              → events[] entry by the same
//                                                segment / name rules the
//                                                Python keys_for_events uses
// The Python side trims the snapshot to a display cap (~10 entries), so a
// cited key may have NO surviving entry - those degrade to kind 'unresolved'
// and the UI shows the bare key. Never throw over a missing entry.

const WEATHER_KEYS = new Set(['heat_advisory', 'cold_snap', 'severe_weather']);
// Ticketmaster segment (lowercased) rules mirrored from app/signals/events.py.
const EVENT_SEGMENT_KEYS = {
  event_concert: ['music'],
  event_sports: ['sports'],
  event_arts: ['arts & theatre', 'arts and theatre', 'film'],
};
// Word-boundary match - 'Lifestyle Expo' must not match 'fest', but words
// ENDING in fest (Oktoberfest, Brewfest, Winefest) still count. Mirrors the
// Python side's _FESTIVAL_RE in app/signals/events.py.
const FESTIVAL_RE = /\b(?:\w*fest|festival|festivals|fair|carnival)\b/i;

/**
 * Map each cited signal key to { key, kind, detail }.
 * kind: 'weather' | 'sports' | 'holiday' | 'event' | 'news' | 'trend' | 'unresolved'.
 * detail is the raw snapshot entry (shape per kind, see SignalBundle) - null
 * for unresolved. Pure function; exported for tests.
 */
function resolveTriggers(citedKeys, snapshot) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const sports = Array.isArray(snap.sports) ? snap.sports : [];
  const events = Array.isArray(snap.events) ? snap.events : [];
  const holidays = Array.isArray(snap.holidays) ? snap.holidays : [];
  const news = Array.isArray(snap.news) ? snap.news : [];
  const social = Array.isArray(snap.social) ? snap.social : [];
  const segmentOf = (e) => String((e && e.category) || '').trim().toLowerCase();

  return (citedKeys || []).map((rawKey) => {
    const key = String(rawKey);
    if (WEATHER_KEYS.has(key) && snap.weather) {
      return { key, kind: 'weather', detail: snap.weather };
    }
    if (key.endsWith('_home_game')) {
      const league = key.slice(0, -'_home_game'.length);
      const game = sports.find((g) => g && g.league === league);
      if (game) return { key, kind: 'sports', detail: game };
    }
    // Exact .key matches first - holidays ('cinco_de_mayo'), analyst-keyed
    // events ('event_zach_bryan_moody_center') and news items.
    const holiday = holidays.find((h) => h && h.key === key);
    if (holiday) return { key, kind: 'holiday', detail: holiday };
    const event = events.find((e) => e && e.key === key);
    if (event) return { key, kind: 'event', detail: event };
    const newsItem = news.find((n) => n && n.key === key);
    if (newsItem) return { key, kind: 'news', detail: newsItem };
    // Social trends carry their own per-entry .key ('trend_<term>').
    const trendItem = social.find((t) => t && t.key === key);
    if (trendItem) return { key, kind: 'trend', detail: trendItem };
    // Segment-derived event keys carry no per-entry .key - re-derive.
    if (key === 'event_nearby' && events.length) {
      return { key, kind: 'event', detail: events[0] };
    }
    if (key === 'event_festival') {
      const fest = events.find((e) => FESTIVAL_RE.test(String((e && e.name) || '')));
      if (fest) return { key, kind: 'event', detail: fest };
    }
    if (EVENT_SEGMENT_KEYS[key]) {
      const match = events.find((e) => EVENT_SEGMENT_KEYS[key].includes(segmentOf(e)));
      if (match) return { key, kind: 'event', detail: match };
    }
    return { key, kind: 'unresolved', detail: null };
  });
}

/**
 * The full case file for one rec: { rec, run, resolved_triggers }. Returns
 * null (→ 404) when the rec doesn't exist, belongs to another tenant, or is a
 * holdout (holdouts must never surface owner-facing - same rule as getLatest).
 */
async function getRecCase(analyticsPool, syncgoPool, clientId, locationId, recId) {
  await ensureVoteColumn(analyticsPool);
  const hasClaims = await evalSvc.actionClaimColumnExists(analyticsPool).catch(() => false);
  const { rows } = await analyticsPool.query(
    `SELECT r.id, r.category, r.action_type, r.primary_skus, r.quantity_hint,
            r.rationale, r.signals_cited, r.confidence,
            to_char(r.valid_through, 'YYYY-MM-DD') AS valid_through,
            r.created_at, r.vote${hasClaims ? ', r.action_claim' : ''},
            run.generated_at AS run_generated_at, run.signal_snapshot
       FROM recommendations r
       JOIN recommendation_runs run ON run.id = r.run_id
      WHERE r.id = $1 AND r.client_id = $2 AND r.location_id = $3
        AND (r.status IS DISTINCT FROM 'holdout')`,
    [recId, clientId, locationId]
  );
  const rec = rows[0];
  if (!rec) return null;

  // SKU → product-name enrichment, same degrade rule as getLatest: a slow or
  // unreachable warehouse never sinks the case - products fall back to
  // sku-only stubs.
  const skus = rec.primary_skus || [];
  let productBySku = new Map();
  try {
    productBySku = await fetchProducts(syncgoPool, clientId, locationId, skus);
  } catch (enrichErr) {
    logger.warn('Case-file enrichment skipped (warehouse slow/unreachable)', {
      error: enrichErr.message, clientId, locationId, recId,
    });
  }

  return {
    rec: {
      rec_id: rec.id,
      category: rec.category,
      action_type: rec.action_type,
      primary_skus: skus,
      products: skus.map((sku) => productBySku.get(sku) || {
        sku, product_name: null, price: null, on_hand: null,
      }),
      quantity_hint: rec.quantity_hint,
      rationale: rec.rationale, // the FULL text, not the 180-char gist
      signals_cited: rec.signals_cited || [],
      confidence: rec.confidence != null ? Number(rec.confidence) : null,
      valid_through: rec.valid_through,
      created_at: rec.created_at,
      vote: voteShape(rec.vote),
      action_claim: hasClaims ? (rec.action_claim || null) : null,
    },
    run: { generated_at: rec.run_generated_at },
    resolved_triggers: resolveTriggers(rec.signals_cited || [], rec.signal_snapshot || {}),
  };
}

// ─── 4. Thumbs votes ─────────────────────────────────────────────────────────
// One vote per RECOMMENDATION, stored as a column on the rec row itself -
// 1 = thumbs up, 0 = thumbs down, NULL = no vote. Stores have a single role
// (no RBAC), so per-user vote rows would be machinery without a user model
// behind it; a flip is an UPDATE, a retract sets NULL. The vote feeds the
// Suggestions tab AND the Python feedback loop (recommendation-history blends
// it into each rec's score).

let voteColumnReady = false;

/**
 * Ensure recommendations.vote exists (idempotent). The column is normally
 * created up front by database/analytics-schema.sql, so the common path is just
 * a cheap catalog read that any role can run. We only fall back to ALTER TABLE
 * when the column is genuinely missing - ALTER requires table ownership, which
 * the least-privilege bottleai_writer role does not have, so we must not run it
 * on the hot read path when the column is already there (that raised
 * "must be owner of table recommendations" on every /latest read).
 */
async function ensureVoteColumn(analyticsPool) {
  if (voteColumnReady) return;
  const { rows } = await analyticsPool.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_name = 'recommendations' AND column_name = 'vote'`
  );
  if (rows.length) {
    voteColumnReady = true;
    return;
  }
  await analyticsPool.query(
    `ALTER TABLE recommendations
       ADD COLUMN IF NOT EXISTS vote SMALLINT CHECK (vote IN (0, 1))`
  );
  voteColumnReady = true;
}

/**
 * Map the stored column value (1 / 0 / NULL) to the API shape the UI and the
 * Python contract consume. Counts are 0-or-1 by design (one vote per store).
 */
function voteShape(v) {
  const n = v == null ? null : Number(v);
  return {
    thumbs_up: n === 1 ? 1 : 0,
    thumbs_down: n === 0 ? 1 : 0,
    user_vote: n == null ? null : (n === 1 ? 'up' : 'down'),
  };
}

/**
 * Cast / flip / retract the store's vote on one recommendation.
 * @param {'up'|'down'|'none'} vote  'none' retracts the existing vote
 * @returns {object} fresh { thumbs_up, thumbs_down, user_vote } for the rec
 */
async function castVote(analyticsPool, clientId, locationId, recommendationId, vote) {
  await ensureVoteColumn(analyticsPool);

  // Tenant filter doubles as the ownership check - a rec id from another store
  // matches zero rows and 404s.
  const { rows } = await analyticsPool.query(
    `UPDATE recommendations
        SET vote = $4
      WHERE id = $1 AND client_id = $2 AND location_id = $3
      RETURNING vote`,
    [recommendationId, clientId, locationId, vote === 'none' ? null : (vote === 'up' ? 1 : 0)]
  );
  if (!rows.length) {
    throw new AppError('Recommendation not found.', 'REC_NOT_FOUND', 404);
  }
  return voteShape(rows[0].vote);
}

// ─── 5. History for the Python feedback loop ─────────────────────────────────

/**
 * Past persisted recs in the contract's recommendation-history shape (§1.4):
 * one row per rec with its generation date, category, SKUs, confidence, and
 * thumbs counts (0-or-1 - one vote per store). The Python side joins these
 * against sales to measure realized lift and blends the votes into each rec's
 * score.
 *
 * Prioritization + cap: the store's votes are the scarce, valuable signal, so
 * voted (liked/disliked) recs are returned FIRST, then the most recent unvoted
 * ones fill the remainder up to `limit`. With no votes this degrades to "the
 * most recent `limit` recs". Bounding the row count keeps the feedback intact
 * while stopping the Python prompt from ballooning as daily runs accumulate.
 *
 * Window uses wall-clock NOW(): generated_at is the cron's own timestamp, so
 * the MAX(sale_date) anchoring rule (which exists for lagging POS data) does
 * not apply here.
 */
async function getRecommendationHistory(analyticsPool, clientId, locationId, days, limit = 20) {
  await ensureVoteColumn(analyticsPool);
  // When the evaluation tables exist, attach each rec's measured outcome -
  // extra fields are ignored by older Python consumers, and richer ones weigh
  // them alongside their own lift math:
  //   evaluated_score           - final_score of the longest window that HAS a
  //                               score (unchanged semantics);
  //   action_taken/verdict/lift - from the longest evaluated window outright
  //                               (detectors see the most evidence there).
  // action_taken stays tri-state: true = we saw the store act, false =
  // provably not (we checked), null = we can't tell - never rounded up.
  const withEval = await evalSvc.evalTablesExist(analyticsPool).catch(() => false);
  const withClaims = await evalSvc.actionClaimColumnExists(analyticsPool).catch(() => false);
  const evalSelect = withEval
    ? `, ev.final_score AS evaluated_score,
        evw.action_taken AS eval_action_taken,
        evw.verdict AS eval_verdict,
        evw.lift AS eval_lift`
    : '';
  const evalJoin = withEval
    ? `LEFT JOIN LATERAL (
         SELECT final_score FROM recommendation_evaluations e
          WHERE e.rec_id = r.id AND e.final_score IS NOT NULL
          ORDER BY e.window_days DESC LIMIT 1
       ) ev ON true
       LEFT JOIN LATERAL (
         SELECT action_taken, verdict, lift FROM recommendation_evaluations e
          WHERE e.rec_id = r.id
          ORDER BY e.window_days DESC LIMIT 1
       ) evw ON true`
    : '';
  const claimSelect = withClaims ? ', r.action_claim' : '';
  const { rows } = await analyticsPool.query(
    `SELECT to_char(rr.generated_at::date, 'YYYY-MM-DD') AS date,
            r.category,
            r.primary_skus,
            r.confidence,
            r.vote${claimSelect}${evalSelect}
       FROM recommendations r
       JOIN recommendation_runs rr ON rr.id = r.run_id
       ${evalJoin}
      WHERE r.client_id = $1 AND r.location_id = $2
        AND rr.generated_at >= NOW() - make_interval(days => $3::int)
        AND (r.status IS DISTINCT FROM 'holdout')
      ORDER BY (r.vote IS NOT NULL) DESC, rr.generated_at DESC, r.rank ASC
      LIMIT $4`,
    [clientId, locationId, days, limit]
  );
  return rows.map((r) => {
    const v = voteShape(r.vote);
    return {
      date: r.date,
      category: r.category,
      primary_skus: r.primary_skus || [],
      confidence: r.confidence != null ? Number(r.confidence) : null,
      thumbs_up: v.thumbs_up,
      thumbs_down: v.thumbs_down,
      evaluated_score: r.evaluated_score != null ? Number(r.evaluated_score) : null,
      // Measured track record (Phase 3, additive): tri-state action detection,
      // the owner's own claim, and the longest-window verdict + raw lift.
      action_taken: withEval ? (r.eval_action_taken ?? null) : null,
      action_claim: withClaims ? (r.action_claim || null) : null,
      verdict: withEval ? (r.eval_verdict || null) : null,
      lift: withEval && r.eval_lift != null ? Number(r.eval_lift) : null,
    };
  });
}

// ─── 5b. Learning lists (Phase 3) ────────────────────────────────────────────
// What the measurements have TAUGHT us about this store: SKUs that repeatedly
// win when recommended ("proven") and SKUs that repeatedly miss ("avoid").
// Served both to the Python generator (recommendation-history envelope - it
// steers future candidate selection) and to the UI ("What Botella has
// learned" footer on the Effectiveness tab).

const LEARNING_MIN_EVALS = 2;     // a SKU needs ≥2 scored evaluations to teach anything
const LEARNING_MAX_PER_LIST = 10; // bounded: footer stays short, Python prompt stays cheap
const LEARNING_SINCE_DAYS = 365;  // lessons age out after a year

/**
 * Compute { proven: [...], avoid: [...] } for one store. Each entry:
 *   { sku, name, category, evidence } - evidence is a plain-language measured
 * sentence fragment, e.g. 'worked 3 of 3 times, avg lift 2.1x'. NEVER
 * projected: only recs with a measured final_score count, one row per rec
 * (its longest scored window), holdout recs excluded like every owner-facing
 * read.
 *
 * Classification reuses the verdict thresholds at SKU level: mean final_score
 * >= WINNER_MIN → proven, <= UNDERPERFORMER_MAX → avoid; anything between
 * teaches nothing yet. Averaged lift is capped (LIFT_CAP) like every other
 * averaged lift in the report. One aggregate query + one name lookup; a slow
 * or unreachable warehouse degrades names to null, never sinks the caller.
 */
async function computeLearning(analyticsPool, syncgoPool, clientId, locationId) {
  const empty = { proven: [], avoid: [] };
  if (!(await evalSvc.evalTablesExist(analyticsPool).catch(() => false))) return empty;

  const { rows } = await analyticsPool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (e.rec_id)
              e.rec_id, e.final_score, e.lift, r.primary_skus, r.category
         FROM recommendation_evaluations e
         JOIN recommendations r ON r.id = e.rec_id
        WHERE e.client_id = $1 AND e.location_id = $2
          AND e.final_score IS NOT NULL
          AND (r.status IS DISTINCT FROM 'holdout')
          AND r.created_at >= now() - make_interval(days => $3::int)
        ORDER BY e.rec_id, e.window_days DESC
     )
     SELECT s.sku,
            count(*)::int AS n,
            count(*) FILTER (WHERE l.final_score >= $4)::int AS wins,
            AVG(l.final_score)::float AS avg_score,
            (AVG(LEAST(l.lift, $6::real)) FILTER (WHERE l.lift IS NOT NULL))::float AS avg_lift,
            mode() WITHIN GROUP (ORDER BY l.category) AS category
       FROM latest l, unnest(l.primary_skus) AS s(sku)
      GROUP BY s.sku
     HAVING count(*) >= $5`,
    [clientId, locationId, LEARNING_SINCE_DAYS, evalSvc.WINNER_MIN,
      LEARNING_MIN_EVALS, evalSvc.LIFT_CAP]
  );

  const provenRows = rows
    .filter((r) => r.avg_score >= evalSvc.WINNER_MIN)
    .sort((a, b) => (b.avg_score - a.avg_score) || (b.n - a.n))
    .slice(0, LEARNING_MAX_PER_LIST);
  const avoidRows = rows
    .filter((r) => r.avg_score <= evalSvc.UNDERPERFORMER_MAX)
    .sort((a, b) => (a.avg_score - b.avg_score) || (b.n - a.n))
    .slice(0, LEARNING_MAX_PER_LIST);
  if (!provenRows.length && !avoidRows.length) return empty;

  // Name enrichment for just the kept SKUs - same degrade rule as getLatest.
  let productBySku = new Map();
  try {
    productBySku = await fetchProducts(
      syncgoPool, clientId, locationId,
      [...new Set([...provenRows, ...avoidRows].map((r) => r.sku))]
    );
  } catch (enrichErr) {
    logger.warn('Learning-list enrichment skipped (warehouse slow/unreachable)', {
      error: enrichErr.message, clientId, locationId,
    });
  }

  const toEntry = (r) => {
    const worked = `worked ${r.wins} of ${r.n} time${r.n === 1 ? '' : 's'}`;
    const liftBit = r.avg_lift != null
      ? `, avg lift ${Math.round(Number(r.avg_lift) * 10) / 10}x`
      : '';
    return {
      sku: r.sku,
      name: productBySku.get(r.sku)?.product_name ?? null,
      category: r.category,
      evidence: `${worked}${liftBit}`,
    };
  };
  return { proven: provenRows.map(toEntry), avoid: avoidRows.map(toEntry) };
}

/** Enumerate every (client_id, location_id) pair - the cron fans out over these. */
async function listAllLocations(syncgoPool) {
  const { rows } = await syncgoPool.query(
    `SELECT client_id, location_id FROM client_locations ORDER BY client_id, location_id`
  );
  return rows.map((r) => ({ clientId: r.client_id, locationId: r.location_id }));
}


/**
 * CARD HISTORY FOR THE LIFECYCLE SCREEN - one row per SKU, not per card.
 *
 * WHY NOT `getRecommendationHistory`. That endpoint serves the feedback loop: it
 * is capped at 20 rows, ordered voted-first, and returns one row per CARD. The
 * lifecycle screen needs the opposite shape - EVERY SKU this store has been shown,
 * with how many times and when it was FIRST issued - because its question is "have
 * we said this before, and has it stopped working".
 *
 * Reusing the feedback query would have silently truncated the history to the 20
 * most-voted cards and reported a product shown 15 times as shown once.
 *
 * `baseline_rate` is `engine_daily_rate` AT FIRST ISSUE, not the latest value. The
 * lifecycle divides realised rate BY this, so taking today's rate would compare a
 * card against a claim it never made. The column is guarded because older rows
 * predate it; a SKU without one is returned with null and the Python side SKIPS it
 * rather than guessing - absence is not a rate of zero.
 *
 * THE STORED RETIREMENT (migration 034). Each row may carry the latest
 * `retired_at` / `suppressed_until` / `retirement_rule` the engine decided for
 * the SKU, and the engine honours that date instead of re-deciding "today + 14"
 * every morning. Two rules keep it honest:
 *
 *   A FRESHER CARD SUPERSEDES IT. A card written AFTER the retirement row
 *   (strictly later created_at - the retirement is written in the same
 *   transaction as its run's cards, so those share its timestamp) is a NEW
 *   claim. When one exists, every figure here (first_issued, times_shown,
 *   accepted, baseline_rate) describes the fresh cards only, and the
 *   retirement fields are null: the old verdict is history and the new claim
 *   is judged on its own.
 *
 *   NO FRESHER CARD: the figures describe the retired card, and the retirement
 *   travels with them, so the engine knows not to judge that card again.
 *
 * `created_at` and not `retired_at` for the comparison, because retired_at is
 * the run's data_as_of, which lags the run by a day and more when the sync lags,
 * and a date comparison would call yesterday's card "fresh" on a slow sync.
 */
async function getCardHistory(analyticsPool, clientId, locationId, days = 60) {
  let hasEngineFacts = false;
  try {
    const { rows } = await analyticsPool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'recommendations'
          AND column_name = 'engine_daily_rate' LIMIT 1`);
    hasEngineFacts = rows.length > 0;
  } catch (_) { hasEngineFacts = false; }
  const hasRetirements = await retirementTableExists(analyticsPool);

  const rateExpr = hasEngineFacts ? 'r.engine_daily_rate' : 'NULL::numeric';
  // Without the table, an empty `latest` keeps one query shape and every row
  // reads as fresh - exactly the feed as it was before migration 034.
  const latestCte = hasRetirements
    ? `SELECT DISTINCT ON (sku) sku, retired_at, suppressed_until, retirement_rule, created_at
         FROM recommendation_retirements
        WHERE client_id = $1 AND location_id = $2
        ORDER BY sku, retired_at DESC, created_at DESC`
    : `SELECT NULL::text AS sku, NULL::date AS retired_at, NULL::date AS suppressed_until,
              NULL::text AS retirement_rule, NULL::timestamptz AS created_at
        WHERE false`;

  const { rows } = await analyticsPool.query(
    `WITH latest AS (${latestCte}),
     cards AS (
       SELECT r.primary_skus[1] AS sku,
              r.created_at,
              ${rateExpr} AS engine_daily_rate,
              -- DID THE OWNER ACT? Recorded on the row all along and never
              -- surfaced, so the selector could not tell "ordered on day one"
              -- from "ignored for a month" and re-issued both identically.
              --
              -- An upvote counts as acceptance alongside an explicit 'did':
              -- the two surfaces disagree about which the owner is offered,
              -- and a store that only ever votes would otherwise read as one
              -- that never acts. COALESCEd to false so a card with no claim
              -- and no vote counts as "did not act", never as unknown.
              COALESCE(r.action_claim = 'did' OR r.vote = 1, false) AS acted,
              COALESCE(r.action_claim = 'dismissed', false) AS dismissed,
              r.action_claim_at,
              r.action_type,
              l.retired_at, l.suppressed_until, l.retirement_rule,
              (l.created_at IS NULL OR r.created_at > l.created_at) AS fresh
         FROM recommendations r
         LEFT JOIN latest l ON l.sku = r.primary_skus[1]
        WHERE r.client_id = $1 AND r.location_id = $2
          AND r.created_at >= NOW() - make_interval(days => $3::int)
          AND (r.status IS DISTINCT FROM 'holdout')
          AND r.primary_skus IS NOT NULL
          AND array_length(r.primary_skus, 1) >= 1
     )
     SELECT c.sku,
            bool_or(c.fresh) AS has_fresh,
            to_char((CASE WHEN bool_or(c.fresh)
                          THEN MIN(c.created_at) FILTER (WHERE c.fresh)
                          ELSE MIN(c.created_at) END)::date, 'YYYY-MM-DD') AS first_issued,
            (CASE WHEN bool_or(c.fresh)
                  THEN COUNT(*) FILTER (WHERE c.fresh)
                  ELSE COUNT(*) END)::int AS times_shown,
            CASE WHEN bool_or(c.fresh)
                 THEN bool_or(c.acted) FILTER (WHERE c.fresh)
                 ELSE bool_or(c.acted) END AS accepted,
            CASE WHEN bool_or(c.fresh)
                 THEN bool_or(c.dismissed) FILTER (WHERE c.fresh)
                 ELSE bool_or(c.dismissed) END AS dismissed,
            to_char((CASE WHEN bool_or(c.fresh)
                          THEN MAX(c.action_claim_at) FILTER (WHERE c.fresh)
                          ELSE MAX(c.action_claim_at) END)::date, 'YYYY-MM-DD') AS last_action_on,
            CASE WHEN bool_or(c.fresh)
                 THEN (ARRAY_AGG(c.engine_daily_rate ORDER BY c.created_at ASC)
                         FILTER (WHERE c.fresh AND c.engine_daily_rate IS NOT NULL))[1]
                 ELSE (ARRAY_AGG(c.engine_daily_rate ORDER BY c.created_at ASC)
                         FILTER (WHERE c.engine_daily_rate IS NOT NULL))[1]
            END AS baseline_rate,
            -- The stored verdict travels only while nothing fresher exists.
            CASE WHEN bool_or(c.fresh) THEN NULL
                 ELSE to_char(MAX(c.retired_at), 'YYYY-MM-DD') END AS retired_at,
            CASE WHEN bool_or(c.fresh) THEN NULL
                 ELSE to_char(MAX(c.suppressed_until), 'YYYY-MM-DD') END AS suppressed_until,
            CASE WHEN bool_or(c.fresh) THEN NULL
                 ELSE MAX(c.retirement_rule) END AS retirement_rule,
            -- WHAT KIND OF CARD. The Python lifecycle judged every card by the
            -- recovery rules, kind unseen, and so retired markdowns for a
            -- recovery they never predicted. Latest card wins: a SKU can be a
            -- reorder one month and a markdown the next.
            (ARRAY_AGG(c.action_type ORDER BY c.created_at DESC))[1] AS action_type
       FROM cards c
      GROUP BY c.sku
      ORDER BY COUNT(*) DESC, MIN(c.created_at) ASC`,
    [clientId, locationId, days]
  );
  return rows.map((r) => ({
    sku: r.sku,
    first_issued: r.first_issued,
    times_shown: r.times_shown,
    accepted: r.accepted === true,
    dismissed: r.dismissed === true,
    last_action_on: r.last_action_on ?? null,
    baseline_rate: r.baseline_rate != null ? Number(r.baseline_rate) : null,
    retired_at: r.retired_at ?? null,
    suppressed_until: r.suppressed_until ?? null,
    retirement_rule: r.retirement_rule ?? null,
    action_type: r.action_type ?? null,
  }));
}

/** Migration 034 applied? Probe-and-degrade, like every optional table. */
async function retirementTableExists(analyticsPool) {
  try {
    const { rows } = await analyticsPool.query(
      `SELECT to_regclass('public.recommendation_retirements') IS NOT NULL AS ok`);
    return rows[0]?.ok === true;
  } catch (_) {
    return false;
  }
}


/**
 * STORE GATE VERDICT - written by the batch, read on the request path.
 *
 * The inputs come from `scripts/_gate_inputs.py`, which measures them over a
 * month of ledger. Node owns the table; the statistics are NOT reimplemented
 * here, because two implementations of one rule is how an estate ends up with
 * two answers.
 *
 * `measured` is the column that matters. A store measured and failed is an
 * instruction to withhold cards; a store nobody has measured is an ABSENCE. Both
 * read state='shadow', and a serving path that conflates them withholds every
 * card at every store the moment it starts honouring the flag.
 */
async function upsertStoreGateVerdict(analyticsPool, verdict) {
  const prev = await analyticsPool.query(
    `SELECT state FROM store_gate_verdict WHERE client_id=$1 AND location_id=$2`,
    [verdict.client_id, verdict.location_id]
  );
  const previousState = prev.rows[0] ? prev.rows[0].state : null;
  const changed = previousState !== null && previousState !== verdict.state;

  const num = (v) => (v === undefined || v === null || Number.isNaN(v) ? null : v);
  await analyticsPool.query(
    `INSERT INTO store_gate_verdict (
       client_id, location_id, state, reason, measured, displayed,
       promise_fill_ratio, ece_points, worst_bin_points, interval_coverage,
       net_margin_month, backtest_edge, backtest_p_value,
       cards, priced_cards, calibration_scored, calibration_fitted,
       interval_considered, measured_for_month, evaluated_at,
       previous_state, state_changed_at,
       verdict_as_of, valid_until, calibration_is_stale,
       calibration_staleness_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             $19, now(), $20, $21, $22, $23, $24, $25)
     ON CONFLICT (client_id, location_id) DO UPDATE SET
       state=$3, reason=$4, measured=$5, displayed=$6,
       promise_fill_ratio=$7, ece_points=$8, worst_bin_points=$9,
       interval_coverage=$10, net_margin_month=$11, backtest_edge=$12,
       backtest_p_value=$13, cards=$14, priced_cards=$15,
       calibration_scored=$16, calibration_fitted=$17,
       interval_considered=$18, measured_for_month=$19, evaluated_at=now(),
       previous_state=COALESCE($20, store_gate_verdict.previous_state),
       state_changed_at=COALESCE($21, store_gate_verdict.state_changed_at),
       verdict_as_of=$22, valid_until=$23, calibration_is_stale=$24,
       calibration_staleness_detail=$25`,
    [verdict.client_id, verdict.location_id, verdict.state, verdict.reason,
     !!verdict.measured, !!verdict.displayed,
     num(verdict.promise_fill_ratio), num(verdict.ece_points),
     num(verdict.worst_bin_points), num(verdict.interval_coverage),
     num(verdict.net_margin_month), num(verdict.backtest_edge),
     num(verdict.backtest_p_value), num(verdict.cards),
     num(verdict.priced_cards), num(verdict.calibration_scored),
     num(verdict.calibration_fitted), num(verdict.interval_considered),
     verdict.measured_for_month || null,
     changed ? previousState : null, changed ? new Date() : null,
     // Migration 033. `valid_until` is the publisher's, not derived here: the
     // serving path and the audit page have to compare the same date, and two
     // readers each applying their own window is how they come to disagree.
     verdict.verdict_as_of || null, verdict.valid_until || null,
     // Tri-state on purpose - true, false, or "the publisher did not say".
     // `!!` would turn an absent flag into a healthy curve.
     verdict.calibration_is_stale === undefined
       ? null : verdict.calibration_is_stale,
     verdict.calibration_staleness_detail || null]
  );
  return { changed, previousState };
}

/** The verdict for one store, or null when nobody has measured it. */
async function getStoreGateVerdict(analyticsPool, clientId, locationId) {
  const { rows } = await analyticsPool.query(
    `SELECT * FROM store_gate_verdict WHERE client_id=$1 AND location_id=$2`,
    [clientId, locationId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  const n = (v) => (v === null ? null : Number(v));
  return {
    state: r.state, reason: r.reason,
    measured: r.measured, displayed: r.displayed,
    promise_fill_ratio: n(r.promise_fill_ratio),
    ece: n(r.ece_points),
    worst_bin_deviation: n(r.worst_bin_points),
    interval_coverage: n(r.interval_coverage),
    net30: n(r.net_margin_month),
    bt_edge: n(r.backtest_edge),
    bt_p: n(r.backtest_p_value),
    cards: r.cards, money_cards30: r.priced_cards,
    calibration_scored: r.calibration_scored,
    calibration_fitted: r.calibration_fitted,
    interval_considered: r.interval_considered,
    measured_for_month: r.measured_for_month,
    evaluated_at: r.evaluated_at,
  };
}


/**
 * SCORED OUTCOMES FOR THE CALIBRATION FITTER.
 *
 * One row per evaluated recommendation: what confidence it stated, and whether it
 * worked. That is all `calibrate/fit.py` needs - the statistics are not
 * reimplemented here, because two implementations of one rule is how an estate
 * ends up with two answers.
 *
 * `hit` is `lift >= 1.0`, which is the same definition the ledger and the gate
 * use. A row with no lift is EXCLUDED rather than counted as a miss: an
 * unevaluated card has not failed.
 *
 * FAMILY IS action_type, NOT category. These are two disjoint vocabularies and
 * this query returned the wrong one:
 *
 *     category     inventory_understock, weather, social_trending, news, ...
 *     action_type  reorder, markdown, promote, endcap, pre_stock, bundle, ...
 *
 * Across 372 live recommendations they agree on 31, and those 31 are all the
 * single word "bundle", which happens to exist in both. Serving looks cells up
 * by action_type - `validator._apply_calibration` passes
 * `rec.get("action_type")` and so does the per-card pass in deterministic.py -
 * so every leaf cell was fitted under a name nothing ever asks for. The lookup
 * missed, fell through to the global rung, and each bundle on the estate holds
 * exactly one fit: family "*", 8 cells skipped.
 *
 * This does NOT by itself un-flatten the curve, and it should not be sold as
 * though it does: the largest cell under the correct label holds 12 scored
 * outcomes against a 50-outcome minimum, so today the global rung is still the
 * only one that can fit. What it fixes is that the failure was PERMANENT -
 * leaf cells would have crossed 50 and still never been found - and that the
 * `skipped` map was keyed on names no card could look up, so the reason a cell
 * was skipped could never reach the card that wanted it.
 */
async function getScoredOutcomes(analyticsPool, clientId, locationId,
                                 windowDays = 30, engineVersion = null) {
  // ONE ENGINE PER FIT, NEVER POOLED (migration 032).
  //
  // A curve maps a raw ranking score onto an observed hit rate, so it is a
  // statement about the engine that produced those scores. Pooling outcomes
  // across engines fits a transform for a quantity that no engine computes.
  // Nothing recorded the provenance before 032, so the fitter could not have
  // done otherwise.
  //
  // When the caller names no version, the engine SERVING this store decides -
  // its most recent run - and anything older is left out. Returned alongside
  // the rows so the publisher can stamp the bundle with the version it is
  // valid for, which is what lets the recommender refuse a mismatch.
  const hasEngineVersion = await analyticsPool
    .query(`SELECT 1 FROM information_schema.columns
             WHERE table_name = 'recommendation_runs'
               AND column_name = 'engine_version' LIMIT 1`)
    .then((r) => r.rowCount > 0)
    .catch(() => false);

  let version = engineVersion;
  if (hasEngineVersion && version == null) {
    const latest = await analyticsPool.query(
      `SELECT engine_version FROM recommendation_runs
        WHERE engine_version IS NOT NULL
          ${clientId != null && locationId != null
    ? 'AND client_id = $1 AND location_id = $2' : ''}
        ORDER BY generated_at DESC, id DESC LIMIT 1`,
      clientId != null && locationId != null ? [clientId, locationId] : []
    );
    version = latest.rows[0] ? latest.rows[0].engine_version : null;
  }

  const params = [windowDays];
  let scope = '';
  if (clientId != null && locationId != null) {
    scope = ` AND r.client_id = $${params.length + 1} AND r.location_id = $${params.length + 2}`;
    params.push(clientId, locationId);
  }
  // IS NOT DISTINCT FROM would make NULL match NULL; a run that cannot name
  // its engine has unknown provenance and must not be pooled with one that
  // can, so this is a plain equality that NULL fails.
  let versionFilter = '';
  if (hasEngineVersion && version != null) {
    versionFilter = ` AND run.engine_version = $${params.length + 1}`;
    params.push(version);
  }

  const { rows } = await analyticsPool.query(
    `SELECT r.client_id, r.location_id, r.action_type AS family,
            r.confidence::float AS stated_confidence,
            (e.lift >= 1.0) AS hit
       FROM recommendation_evaluations e
       JOIN recommendations r ON r.id = e.rec_id
       JOIN recommendation_runs run ON run.id = r.run_id
      WHERE e.window_days = $1
        AND e.lift IS NOT NULL
        AND r.confidence IS NOT NULL
        AND (r.status IS DISTINCT FROM 'holdout')${scope}${versionFilter}
      ORDER BY r.confidence ASC`,
    params
  );
  const outcomes = rows.map((r) => ({
    client_id: r.client_id, location_id: r.location_id,
    family: r.family, stated_confidence: Number(r.stated_confidence),
    hit: r.hit === true,
  }));
  // The array carries the version as a non-enumerable property so every
  // existing caller - and JSON.stringify on the route - still sees a plain
  // array of outcomes and nothing changes shape underneath them.
  Object.defineProperty(outcomes, 'engineVersion', {
    value: version, enumerable: false,
  });
  return outcomes;
}

/** Store one fitted bundle. Replaces whatever that store had. */
async function upsertCalibrationBundle(analyticsPool, b) {
  await analyticsPool.query(
    `INSERT INTO calibration_bundle (
       client_id, location_id, version, fitted_at, bundle,
       outcomes_fitted, cells_fitted, cells_skipped, rungs, engine_version,
       published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (client_id, location_id) DO UPDATE SET
       version=$3, fitted_at=$4, bundle=$5, outcomes_fitted=$6,
       cells_fitted=$7, cells_skipped=$8, rungs=$9, engine_version=$10,
       published_at=now()`,
    [b.client_id, b.location_id, b.version, b.fitted_at,
     JSON.stringify(b.bundle), b.outcomes_fitted || 0, b.cells_fitted || 0,
     b.cells_skipped || 0, b.rungs || null, b.engine_version || null]
  );
}

/**
 * MEASURED SIGNAL EFFECTS - migration 029.
 *
 * The missing half of the signal chain. `cold_box` and `pre_stock` refuse without
 * a measured effect, which is right, and nothing could supply one: the fit happens
 * offline against day-of-week / month / trend controls and had nowhere to land. So
 * the engine gathered five to thirteen signals a store and cited none of them, at
 * every store, forever.
 *
 * REFUSALS ARE STORED TOO, and that is deliberate. 499 of 504 cells refused on the
 * first estate-wide fit. Keeping only the five that earned a beta would leave
 * nobody able to answer "did you look at sports, and what did you find" - which is
 * exactly what an owner asks when a card does not mention tonight's game.
 *
 * Replaces the store's whole set in one transaction. A partial publish would leave
 * a store citing January's heat effect beside July's cold one, and there is no
 * ordering of individual upserts that makes that safe.
 */
async function replaceSignalEffects(analyticsPool, clientId, locationId, rows) {
  const client = await analyticsPool.connect();
  try {
    await client.query('BEGIN');
    // DELETE then insert, inside the transaction: a cell that no longer appears
    // in the fit has stopped being estimable, and leaving the old row behind
    // would let a card cite an effect the current data no longer supports.
    await client.query(
      'DELETE FROM signal_effects WHERE client_id=$1 AND location_id=$2',
      [clientId, locationId]
    );
    let written = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || !r.signal_key || !r.category_family) continue;
      // `num` keeps absence as NULL. A beta of 0 is a measured no-effect and a
      // missing beta is a refusal; coercing either into the other loses the only
      // distinction this table exists to carry.
      const num = (v) => (Number.isFinite(v) ? v : null);
      await client.query(
        `INSERT INTO signal_effects (
           client_id, location_id, signal_key, category_family,
           beta, own_beta, interval_lo, interval_hi, own_weight,
           observations, active_days, refused_reason, basis,
           fit_from, fit_to, fitted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())`,
        [clientId, locationId, String(r.signal_key), String(r.category_family),
         num(r.beta), num(r.own_beta), num(r.interval_lo), num(r.interval_hi),
         num(r.own_weight),
         Number.isFinite(r.observations) ? r.observations : 0,
         Number.isFinite(r.active_days) ? r.active_days : 0,
         r.refused_reason ? String(r.refused_reason) : null,
         r.basis ? String(r.basis) : '',
         r.fit_from || null, r.fit_to || null]
      );
      written += 1;
    }
    await client.query('COMMIT');
    return written;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The effects for one store. `usableOnly` is the serving read.
 *
 * The recommender wants only what a card may cite; a human debugging why no card
 * mentioned the game wants the refusals as well. Both come from one table and the
 * `usable` column is GENERATED, so neither caller can apply a different rule.
 */
async function getSignalEffects(analyticsPool, clientId, locationId,
                                { usableOnly = true } = {}) {
  const { rows } = await analyticsPool.query(
    `SELECT signal_key, category_family, beta, own_beta, interval_lo,
            interval_hi, own_weight, observations, active_days,
            refused_reason, basis, fit_from, fit_to, usable
       FROM signal_effects
      WHERE client_id=$1 AND location_id=$2 ${usableOnly ? 'AND usable' : ''}
      ORDER BY signal_key, category_family`,
    [clientId, locationId]
  );
  const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
  const flt = (v) => (v == null ? null : Number(v));
  return rows.map((r) => ({
    signal_key: r.signal_key,
    category_family: r.category_family,
    beta: flt(r.beta),
    own_beta: flt(r.own_beta),
    interval_lo: flt(r.interval_lo),
    interval_hi: flt(r.interval_hi),
    own_weight: flt(r.own_weight),
    observations: r.observations,
    active_days: r.active_days,
    refused_reason: r.refused_reason,
    basis: r.basis,
    fit_from: day(r.fit_from),
    fit_to: day(r.fit_to),
    usable: r.usable,
  }));
}

/** The bundle for one store, or null when none has been fitted. */
async function getCalibrationBundle(analyticsPool, clientId, locationId) {
  const { rows } = await analyticsPool.query(
    `SELECT version, fitted_at, bundle, outcomes_fitted, cells_fitted,
            cells_skipped, rungs, engine_version, published_at
       FROM calibration_bundle WHERE client_id=$1 AND location_id=$2`,
    [clientId, locationId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    version: r.version,
    fitted_at: r.fitted_at instanceof Date
      ? r.fitted_at.toISOString().slice(0, 10) : r.fitted_at,
    bundle: r.bundle,
    outcomes_fitted: r.outcomes_fitted,
    cells_fitted: r.cells_fitted,
    cells_skipped: r.cells_skipped,
    rungs: r.rungs,
    // The engine this curve is valid FOR, so the recommender can refuse to
    // apply a transform fitted against a different engine's raw scores.
    engine_version: r.engine_version,
    published_at: r.published_at,
  };
}


/**
 * WRITE BACKFILLED SIGNAL HISTORY. Node owns this table; Python computes the rows.
 *
 * APPEND-ONLY, enforced by a trigger on the table itself. This inserts and never
 * updates, and `ON CONFLICT DO NOTHING` makes a re-run idempotent rather than a
 * duplicate - a signal was either active on a date or it was not, and two sources
 * agreeing is not two observations.
 *
 * `origin` arrives as 'computed' and must stay that way. It is what stops a
 * backfill being quoted later as evidence that capture was running: a holiday
 * reconstructed from a calendar is a different kind of fact from a temperature
 * somebody recorded, and an elasticity fitted on the first must not be reported as
 * if it rested on the second.
 */
async function insertSignalHistory(analyticsPool, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { inserted: 0, received: 0 };
  }
  let inserted = 0;
  const client = await analyticsPool.connect();
  try {
    await client.query('BEGIN');
    // Batched, because a backfill is thousands of rows and one round trip each
    // would take minutes.
    const SIZE = 500;
    for (let i = 0; i < rows.length; i += SIZE) {
      const batch = rows.slice(i, i + SIZE);
      const values = [];
      const params = [];
      batch.forEach((r, k) => {
        const b = k * 7;
        values.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`);
        params.push(r.client_id, r.location_id, r.as_of, r.signal_key,
                    r.strength === undefined ? null : r.strength,
                    r.source || null, r.origin || 'computed');
      });
      const res = await client.query(
        `INSERT INTO signal_history
           (client_id, location_id, as_of, signal_key, strength, source, origin)
         VALUES ${values.join(',')}
         ON CONFLICT DO NOTHING`,
        params
      );
      inserted += res.rowCount || 0;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { inserted, received: rows.length };
}

/** Signal history for one store, for the elasticity fit. */
async function getSignalHistory(analyticsPool, clientId, locationId,
                                sinceDays = 1000) {
  const { rows } = await analyticsPool.query(
    `SELECT to_char(as_of, 'YYYY-MM-DD') AS as_of, signal_key, strength, origin
       FROM signal_history
      WHERE client_id=$1 AND location_id=$2
        AND as_of >= (CURRENT_DATE - make_interval(days => $3::int))
      ORDER BY as_of ASC`,
    [clientId, locationId, sinceDays]
  );
  return rows.map((r) => ({
    as_of: r.as_of, signal_key: r.signal_key,
    strength: r.strength === null ? null : Number(r.strength),
    origin: r.origin,
  }));
}

module.exports = {
  REC_SERVICE_URL,
  callPythonService,
  persistRun,
  generateAndPersist,
  getLatest,
  getRecCase,
  resolveTriggers,
  castVote,
  getRecommendationHistory,
  getCardHistory,
  upsertStoreGateVerdict,
  getStoreGateVerdict,
  storeGateDecision,
  getScoredOutcomes,
  upsertCalibrationBundle,
  getCalibrationBundle,
  replaceSignalEffects,
  getSignalEffects,
  insertSignalHistory,
  getSignalHistory,
  computeLearning,
  listAllLocations,
};
