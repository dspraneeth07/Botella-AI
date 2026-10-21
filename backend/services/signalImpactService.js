/**
 * SIGNAL IMPACT LEDGER - what each external signal has done for this store, by
 * the only two measurements that exist.
 *
 * The Effectiveness tab's trust ledger wants to say, per signal, "we cited the
 * game on N cards, M of them could be measured, they lifted sales by X, the owner
 * acted on K, and the fitted effect of that signal on this store is beta". Until
 * this existed those facts lived in three tables that nobody joined:
 *
 *   recommendations.signals_cited      which keys a card actually named. Filled
 *                                      by the Python engine for the signal
 *                                      families (cold_box, pre_stock, the LLM-era
 *                                      cards) and EMPTY on reorder / markdown /
 *                                      bundle cards, which consult no external
 *                                      signal and say so by citing nothing.
 *   recommendation_evaluations         what happened after, per card and window:
 *                                      lift against the SKU's own baseline,
 *                                      whether an owner action was detected,
 *                                      the margin impact where it is computable.
 *   signal_effects                     the weekly fit (migration 029): beta per
 *                                      (signal, drink family) with its interval,
 *                                      or the NAMED reason it refused.
 *
 * NULL IS NOT ZERO, ANYWHERE IN THIS FILE. A signal with no evaluated card has a
 * mean lift of null and a reason, not 0.0; a margin sum with nothing measurable is
 * null and a reason, not $0; a key the fit never saw has `effects: []` and a
 * reason, and a key the fit REFUSED carries the refusal. Measured in October at
 * the pilot stores, the honest ledger is almost entirely reasons - 1 usable cell
 * in 228 at the three production stores - and a ledger that rendered those as
 * zeros would be claiming the signals were measured and found inert, which is a
 * different and false statement.
 *
 * THE KEY SET IS THE UNION. A key appears if any non-holdout card cited it in the
 * history bound OR the fit has a row for it. The second half matters: the one
 * usable effect at Bethany (heat_advisory x beer, +15.8%) has been cited by no
 * card since the deterministic engine went live, and a ledger built only from
 * citations could never show that the measurement exists and is going unused.
 *
 * Holdout cards are excluded, as everywhere else owner-facing (the same rule as
 * recommendationEvalService.getEffectiveness): a card the owner never saw cannot
 * have earned an action, and counting it would overstate "issued".
 *
 * Read-only. The sole writer of every table here is elsewhere.
 */

const { EVAL_WINDOWS } = require('./recommendationEvalService');
const { shapeSignalsToday } = require('../lib/signalsToday');

// The same window vocabulary the Effectiveness tab already speaks, so a drill
// from this ledger into the card ledger lands on the same evaluation rows.
const DEFAULT_WINDOW_DAYS = EVAL_WINDOWS.includes(30) ? 30 : EVAL_WINDOWS[0];
// How far back "issued" reaches. Mirrors normalizeSince in the eval service
// (1..365, default a year here rather than the summary's 90: a signal fires a
// few times a season and a quarter would show most keys as never cited).
const DEFAULT_SINCE_DAYS = 365;
const MAX_SINCE_DAYS = 365;

// Internal evidence keys the LLM-era validator let through as "signals". They
// are facts about the store's own stock, not external signals, and the
// Effectiveness tab must not present them as weather or sport. Kept in the
// ledger - they were cited and that is history - but flagged so the UI can
// group them apart. Derived from what the validator accepts, not invented.
const INTERNAL_KEYS = new Set([
  'understock', 'overstock', 'overstock_severe', 'stockout', 'dead_stock',
  'lost_sale', 'dont_buy', 'new_arrival', 'area_winner', 'register_trend',
]);

function normalizeWindow(windowDays) {
  const n = parseInt(windowDays, 10);
  return EVAL_WINDOWS.includes(n) ? n : DEFAULT_WINDOW_DAYS;
}

function normalizeSince(sinceDays) {
  const n = parseInt(sinceDays, 10);
  if (!Number.isFinite(n)) return DEFAULT_SINCE_DAYS;
  return Math.min(MAX_SINCE_DAYS, Math.max(1, n));
}

const num = (v) => (v == null ? null : Number(v));
const day = (v) => (v == null ? null : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)));

/**
 * Which optional columns and tables this database actually has. The eval tables
 * arrived in migration 002 and the dollar columns in 003; a database without
 * them must read as "not measured", never as a failed query.
 */
async function probeSchema(analyticsPool) {
  const { rows } = await analyticsPool.query(
    `SELECT to_regclass('public.recommendation_evaluations') IS NOT NULL AS has_evals,
            to_regclass('public.signal_effects')             IS NOT NULL AS has_effects,
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'recommendation_evaluations'
                       AND column_name = 'margin_impact')     AS has_margin`
  );
  return rows[0];
}

/**
 * Per cited signal key: cards issued and what their evaluations say.
 *
 * One row per (card, key) is produced by unnesting signals_cited, then grouped by
 * key. A card citing two keys counts once under each - "cards that named the
 * game" and "cards that named the heat" are both true of it. Evaluations join at
 * the requested window; a card not yet evaluated contributes to `cards_issued`
 * and nothing else.
 */
async function citationRows(analyticsPool, clientId, locationId, window, since, schema) {
  if (!schema.has_evals) {
    const { rows } = await analyticsPool.query(
      `SELECT key AS signal_key, COUNT(*)::int AS cards_issued
         FROM recommendations r, unnest(r.signals_cited) AS key
        WHERE r.client_id = $1 AND r.location_id = $2
          AND r.status IS DISTINCT FROM 'holdout'
          AND r.created_at >= now() - make_interval(days => $3)
        GROUP BY key`,
      [clientId, locationId, since]
    );
    return rows.map((r) => ({ ...r, cards_evaluated: null, cards_with_lift: null,
      mean_lift: null, cards_acted: null, cards_action_unknown: null, margin_impact: null,
      margin_cards: null }));
  }
  const margin = schema.has_margin
    ? `SUM(e.margin_impact)                                  AS margin_impact,
       COUNT(e.margin_impact)::int                           AS margin_cards,`
    : `NULL::numeric AS margin_impact, NULL::int AS margin_cards,`;
  const { rows } = await analyticsPool.query(
    `SELECT key                                              AS signal_key,
            COUNT(*)::int                                    AS cards_issued,
            COUNT(e.rec_id)::int                             AS cards_evaluated,
            COUNT(e.lift)::int                               AS cards_with_lift,
            AVG(e.lift)                                      AS mean_lift,
            COUNT(*) FILTER (WHERE e.action_taken IS TRUE)::int  AS cards_acted,
            COUNT(*) FILTER (WHERE e.rec_id IS NOT NULL
                               AND e.action_taken IS NULL)::int AS cards_action_unknown,
            ${margin}
            MIN(r.created_at)                                AS first_cited,
            MAX(r.created_at)                                AS last_cited
       FROM recommendations r
       CROSS JOIN unnest(r.signals_cited) AS key
       LEFT JOIN recommendation_evaluations e
              ON e.rec_id = r.id AND e.window_days = $4
      WHERE r.client_id = $1 AND r.location_id = $2
        AND r.status IS DISTINCT FROM 'holdout'
        AND r.created_at >= now() - make_interval(days => $3)
      GROUP BY key`,
    [clientId, locationId, since, window]
  );
  return rows;
}

/** Every fitted cell for the store, refusals included, grouped by key. */
async function effectRows(analyticsPool, clientId, locationId, schema) {
  if (!schema.has_effects) return new Map();
  const { rows } = await analyticsPool.query(
    `SELECT signal_key, category_family, beta, interval_lo, interval_hi,
            observations, active_days, refused_reason, basis, usable,
            to_char(fit_from, 'YYYY-MM-DD') AS fit_from,
            to_char(fit_to,   'YYYY-MM-DD') AS fit_to,
            fitted_at
       FROM signal_effects
      WHERE client_id = $1 AND location_id = $2
      ORDER BY signal_key, category_family`,
    [clientId, locationId]
  );
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.signal_key)) byKey.set(r.signal_key, []);
    byKey.get(r.signal_key).push({
      category_family: r.category_family,
      beta: num(r.beta),
      interval_lo: num(r.interval_lo),
      interval_hi: num(r.interval_hi),
      observations: r.observations,
      active_days: r.active_days,
      usable: r.usable === true,
      // The fit's own words where it refused; where it did not refuse but the
      // interval spans zero the GENERATED `usable` column is false and the
      // reason is this one, stated rather than left to be inferred from two
      // numbers.
      refused_reason: r.refused_reason
        || (r.usable ? null : 'interval_spans_zero'),
      basis: r.basis,
      fit_from: r.fit_from,
      fit_to: r.fit_to,
      fitted_at: r.fitted_at,
    });
  }
  return byKey;
}

/** Why the effect side of a row is what it is, in one sentence. */
function effectSummary(effects, schema) {
  if (!schema.has_effects) {
    return { usable_families: [], reason: 'signal_effects table not provisioned (analytics migration 029)' };
  }
  if (!effects.length) {
    return { usable_families: [], reason: 'never fitted for this store: the key has no row in signal_history the weekly fit could use' };
  }
  const usable = effects.filter((e) => e.usable).map((e) => e.category_family);
  if (usable.length) return { usable_families: usable, reason: null };
  // Refusals, de-duplicated, so "too_few_active_days:4<20" shows once rather
  // than three times for three families with identical coverage.
  const reasons = [...new Set(effects.map((e) => e.refused_reason).filter(Boolean))];
  return { usable_families: [], reason: `refused in every family: ${reasons.join('; ')}` };
}

/**
 * The ledger. One entry per signal key, plus the totals the header needs.
 *
 * @param {import('pg').Pool} analyticsPool
 * @param {number} clientId
 * @param {number} locationId
 * @param {{windowDays?: number, sinceDays?: number}} [opts]
 */
async function signalImpactLedger(analyticsPool, clientId, locationId, opts = {}) {
  const window = normalizeWindow(opts.windowDays);
  const since = normalizeSince(opts.sinceDays);
  const schema = await probeSchema(analyticsPool);

  const [cited, effects, totals] = await Promise.all([
    citationRows(analyticsPool, clientId, locationId, window, since, schema),
    effectRows(analyticsPool, clientId, locationId, schema),
    analyticsPool.query(
      `SELECT COUNT(*)::int AS cards_total,
              COUNT(*) FILTER (WHERE cardinality(signals_cited) > 0)::int AS cards_citing,
              MAX(created_at) AS last_issued
         FROM recommendations
        WHERE client_id = $1 AND location_id = $2
          AND status IS DISTINCT FROM 'holdout'
          AND created_at >= now() - make_interval(days => $3)`,
      [clientId, locationId, since]
    ),
  ]);

  const keys = new Set([...cited.map((c) => c.signal_key), ...effects.keys()]);
  const citedByKey = new Map(cited.map((c) => [c.signal_key, c]));

  const signals = [...keys].sort().map((key) => {
    const c = citedByKey.get(key);
    const fx = effects.get(key) || [];
    const summary = effectSummary(fx, schema);
    const issued = c ? c.cards_issued : 0;
    const evaluated = c ? c.cards_evaluated : (schema.has_evals ? 0 : null);
    const withLift = c ? c.cards_with_lift : (schema.has_evals ? 0 : null);

    let liftReason = null;
    if (!schema.has_evals) liftReason = 'evaluation tables not provisioned (analytics migration 002)';
    else if (!issued) liftReason = 'no card cited this signal in the history bound';
    else if (!evaluated) liftReason = `no cited card has reached its ${window}-day evaluation yet`;
    else if (!withLift) liftReason = 'every evaluated card lacked a baseline: the SKU projected zero units, so lift is undefined';

    let marginReason = null;
    if (!schema.has_evals) marginReason = liftReason;
    else if (!schema.has_margin) marginReason = 'dollar columns not provisioned (analytics migration 003)';
    else if (!issued) marginReason = liftReason;
    else if (!c.margin_cards) marginReason = 'no evaluated card has a computable margin impact';

    return {
      signal_key: key,
      internal: INTERNAL_KEYS.has(key),
      cards_issued: issued,
      cards_evaluated: evaluated,
      cards_with_lift: withLift,
      mean_lift: c && c.mean_lift != null ? Number(c.mean_lift) : null,
      lift_reason: liftReason,
      cards_acted: c ? c.cards_acted : (schema.has_evals ? 0 : null),
      cards_action_unknown: c ? c.cards_action_unknown : (schema.has_evals ? 0 : null),
      margin_impact: c && c.margin_cards ? Number(c.margin_impact) : null,
      margin_cards: c ? c.margin_cards : null,
      margin_reason: marginReason,
      first_cited: c && c.first_cited ? c.first_cited : null,
      last_cited: c && c.last_cited ? c.last_cited : null,
      effects: fx,
      effect_usable_families: summary.usable_families,
      effect_reason: summary.reason,
    };
  });

  const t = totals.rows[0];
  return {
    window_days: window,
    since_days: since,
    schema: {
      evaluations: schema.has_evals === true,
      margin: schema.has_margin === true,
      effects: schema.has_effects === true,
    },
    cards_total: t.cards_total,
    cards_citing: t.cards_citing,
    last_issued: t.last_issued,
    signals_with_usable_effect: signals.filter((s) => s.effect_usable_families.length).length,
    effects_fitted_at: [...effects.values()].flat()
      .reduce((mx, e) => (e.fitted_at && (!mx || e.fitted_at > mx) ? e.fitted_at : mx), null),
    signals,
  };
}

/* ── Today: the live signals, their verdicts, and the cards they reached ───── */

/**
 * What is live at the store today and what the fit says about each of it.
 *
 * The ledger above is history - a year of citations and evaluations per key.
 * This is the present tense the Recommendations rail needs: one row per signal
 * active on the latest run's day, labelled from that run's own snapshot, with
 * the fit's verdict in words and the cards it touched. The shaping is
 * lib/signalsToday.js (pure, unit-tested); this function only gathers.
 *
 * Sources, in order of authority for "which keys were live":
 *   daily_store_signals.active_keys for (store, rec_date)   migration 014, the
 *                                                           engine's untrimmed record
 *   recommendation_runs.signal_snapshot.active_keys         the same list as sent
 *   the snapshot entries' .key plus weather alerts          pre-active_keys runs
 *
 * Every optional column and table is probed: a database whose migrations stop
 * before 014, 015 or 043 answers with less, never with a failed query.
 *
 * @param {import('pg').Pool} analyticsPool
 * @param {number} clientId
 * @param {number} locationId
 */
async function signalsToday(analyticsPool, clientId, locationId) {
  const probe = await analyticsPool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'recommendation_runs' AND column_name = 'rec_date') AS has_rec_date,
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'recommendations' AND column_name = 'signal_impact') AS has_impact,
            to_regclass('public.daily_store_signals') IS NOT NULL AS has_daily,
            to_regclass('public.signal_effects')      IS NOT NULL AS has_effects`
  );
  const p = probe.rows[0];

  // The same ordering getLatest uses, so the rail and the cards agree on
  // which run "today" is. rec_date read back ::text (DAILY-CAPTURE.md §4).
  const runRes = await analyticsPool.query(
    `SELECT id, generated_at, signal_snapshot
            ${p.has_rec_date ? ', rec_date::text AS rec_date' : ', NULL::text AS rec_date'}
       FROM recommendation_runs
      WHERE client_id = $1 AND location_id = $2
      ORDER BY generated_at DESC, id DESC
      LIMIT 1`,
    [clientId, locationId]
  );
  const run = runRes.rows[0] || null;
  if (!run) {
    return shapeSignalsToday({ run: null, snapshot: {}, dailyActiveKeys: null, signalDate: null,
      effectsByKey: new Map(), cards: [] });
  }
  const recDate = run.rec_date || day(run.generated_at);

  const [daily, cardsRes, effects] = await Promise.all([
    p.has_daily && recDate
      ? analyticsPool.query(
        `SELECT signal_date::text AS signal_date, active_keys
           FROM daily_store_signals
          WHERE client_id = $1 AND location_id = $2 AND signal_date = $3::date`,
        [clientId, locationId, recDate]
      )
      : Promise.resolve({ rows: [] }),
    analyticsPool.query(
      `SELECT id, rank, action_type, primary_skus, signals_cited, status
              ${p.has_impact ? ', signal_impact' : ''}
         FROM recommendations
        WHERE run_id = $1 AND client_id = $2 AND location_id = $3
          AND status IS DISTINCT FROM 'holdout'
        ORDER BY rank ASC`,
      [run.id, clientId, locationId]
    ),
    effectRows(analyticsPool, clientId, locationId, { has_effects: p.has_effects === true }),
  ]);
  const dailyRow = daily.rows[0] || null;

  return shapeSignalsToday({
    run: { id: run.id, rec_date: recDate },
    snapshot: run.signal_snapshot || {},
    dailyActiveKeys: dailyRow ? dailyRow.active_keys : null,
    signalDate: dailyRow ? dailyRow.signal_date : null,
    effectsByKey: effects,
    cards: cardsRes.rows.map((c) => ({
      ...c,
      signal_impact: Array.isArray(c.signal_impact) ? c.signal_impact : [],
    })),
  });
}

module.exports = {
  signalImpactLedger,
  signalsToday,
  normalizeWindow,
  normalizeSince,
  INTERNAL_KEYS,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_SINCE_DAYS,
};
