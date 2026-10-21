/**
 * Recommendation routes - read (and optionally regenerate) signal-aware stocking
 * recommendations produced by the external Python service.
 *
 * Mounted at `/api/recommendations` behind verifyToken + attachPool (server.js):
 *   GET  /api/recommendations/latest    → newest persisted run + items for the tenant
 *   POST /api/recommendations/generate  → run the Python service now + persist (manual/seed)
 *   POST /api/recommendations/:id/vote  → thumbs up/down/retract on one rec (per store)
 *
 * Generation is normally driven by the daily cron (server.js); the Suggestions
 * tab opens read-only on /latest. When a store has no run yet (the cron hasn't
 * covered it), the tab's empty state shows a "Generate recommendations" button
 * that POSTs /generate for the logged-in tenant on demand, then reloads /latest.
 *
 * Tenant keys come from the JWT (req.user), so the client_id + location_id filter
 * is always satisfied. Two pools: req.pool is `syncgo` (products); the analytics
 * pool (recommendation_runs / recommendations) is fetched here.
 *
 * Error shape matches the rest of the app: { "error": { "code", "message" } }.
 */

const router = require('express').Router();
const logger = require('../utils/logger');
const { toSafeError } = require('../utils/errors');
const { getAnalyticsPool } = require('../database/analytics-connection');
const svc = require('../services/recommendationService');
const evalSvc = require('../services/recommendationEvalService');
const digestSvc = require('../services/recommendationDigestService');
const scoreboardSvc = require('../services/pilotScoreboardService');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** Translate any thrown error into the contract envelope. */
function sendError(res, err, context) {
  const safe = toSafeError(err);
  logger.error(`Recommendations ${context} failed`, {
    error: err.message, code: safe.code, status: safe.statusCode,
  });
  res.status(safe.statusCode).json({ error: { code: safe.code, message: safe.userMessage } });
}

// ─── TWO SURFACES, ONE GATE (sheet 18) ───────────────────────────────────────
//
// The store sees what passed. Internal sees everything, including the shadow
// cards and the evidence behind the gate's verdict.
//
// THE CHECK IS HERE, NOT IN THE CLIENT.
//   A client-side filter is not a boundary: the payload still crossed the
//   network, and anybody with the devtools open has the shadow cards. So the
//   store route strips them server-side and the internal route is a DIFFERENT
//   endpoint behind a DIFFERENT credential - not a query parameter the browser
//   can flip.
//
// WHAT INTERNAL-ONLY ACTUALLY MEANS HERE
//   p-values, null means, matched-basket counts and the gate's reasoning are
//   ours, not the store's. They are stripped from the store surface
//   unconditionally - regardless of REC_GATE_ENFORCED, which controls whether
//   shadow CARDS are withheld, not whether our statistics leak.
//
//   That distinction matters right now: enforcement is off during the gate's
//   first quarter (sheet 17), so a store currently still SEES every card. It
//   has never seen a p-value, and will not.

/** Fields the store must never receive, whatever the gate's rollout state. */
const INTERNAL_ONLY_CARD_FIELDS = [
  'gate_state', 'gate_reason', 'gate_evidence', 'p_value', 'null_mean',
  'observed', 'holdout_bucket', 'shadow',
];

/**
 * The store's view of one card.
 *
 * An allow-list would be safer still, but the card shape is assembled from
 * several optional migrations and an allow-list here would silently drop a
 * field the moment one lands. A deny-list plus this test
 * (`tests/rec-surface-verify.js`) is the trade actually made, and the test is
 * what keeps it honest.
 */
function forStore(card) {
  const copy = { ...card };
  for (const field of INTERNAL_ONLY_CARD_FIELDS) delete copy[field];
  return copy;
}

/**
 * Is this request allowed the internal surface?
 *
 * A shared secret in a header, matching the `X-API-Key` convention already
 * used for service-to-service auth in this codebase. NOT the store's JWT:
 * there is no role on it today, and inventing an authorisation model inside a
 * recommendation route is how one ends up with two of them.
 *
 * FAILS CLOSED. With no key configured the internal surface does not exist -
 * it 404s rather than falling open, because a debugging endpoint that is
 * accidentally public is worse than one that is accidentally missing.
 */
const INTERNAL_KEY = process.env.REC_INTERNAL_API_KEY || '';

function isInternalRequest(req) {
  if (!INTERNAL_KEY) return false;
  const offered = req.get('X-Internal-Key') || '';
  // Length check first so the comparison below cannot be used as an oracle
  // for the key's length via timing.
  if (offered.length !== INTERNAL_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < INTERNAL_KEY.length; i++) {
    diff |= offered.charCodeAt(i) ^ INTERNAL_KEY.charCodeAt(i);
  }
  return diff === 0;
}

// ─── GET /api/recommendations/latest ─────────────────────────────────────────
// The STORE surface. Hot read path the tab opens on. Returns
// { run, recommendations } or, when no run exists yet (cron hasn't covered the
// store), { run: null, recommendations: [] }.
router.get(
  '/latest',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    try {
      const latest = await svc.getLatest(getAnalyticsPool(), req.pool, clientId, locationId);
      if (!latest) return res.json({ run: null, recommendations: [] });
      res.json({
        ...latest,
        recommendations: (latest.recommendations || []).map(forStore),
        withheld: (latest.withheld || []).map(forStore),
        // The store is told THAT some advice is still being measured, never
        // which advice or how it scored. "Why am I seeing fewer cards" has an
        // answer; "here is our p-value" is not that answer.
        gate: latest.gate ? { measuring: Boolean(latest.gate.withheld_by_gate) } : undefined,
      });
    } catch (err) {
      sendError(res, err, 'latest');
    }
  })
);

// ─── GET /api/recommendations/internal/latest ────────────────────────────────
// The INTERNAL surface. Same data, nothing stripped: shadow cards, gate states
// and the evidence behind them. This is where a shadow family is watched
// during the quarter it spends earning its way out of shadow.
router.get(
  '/internal/latest',
  asyncHandler(async (req, res) => {
    if (!isInternalRequest(req)) {
      // 404, not 403: an endpoint that answers "wrong key" confirms it exists.
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Not found' },
      });
    }
    const clientId = parseInt(req.query.client_id, 10) || req.user.client_id;
    const locationId = parseInt(req.query.location_id, 10) || req.user.location_id;
    try {
      const latest = await svc.getLatest(getAnalyticsPool(), req.pool, clientId, locationId);
      if (!latest) return res.json({ run: null, recommendations: [], surface: 'internal' });
      res.json({ ...latest, surface: 'internal' });
    } catch (err) {
      sendError(res, err, 'internal/latest');
    }
  })
);

// ─── POST /api/recommendations/generate ──────────────────────────────────────
// Manual / first-run seed: call the Python service for the current tenant now and
// persist the result. Returns the saved-run summary; the UI then reloads /latest.
router.post(
  '/generate',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    try {
      const summary = await svc.generateAndPersist(getAnalyticsPool(), clientId, locationId);
      res.json({ ok: true, ...summary });
    } catch (err) {
      sendError(res, err, 'generate');
    }
  })
);

// ─── GET /api/recommendations/effectiveness ──────────────────────────────────
// The evaluation report: how the store's recommendations actually performed -
// summary, winners vs underperformers, per-category / per-action / per-signal
// breakdowns, and the observable-compliance story ("you did what Botella
// suggested and it worked"). ?window=30 picks the evaluation window (must be
// one of REC_EVAL_WINDOWS); ?days=90 bounds how far back recs are included.
router.get(
  '/effectiveness',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    try {
      const report = await evalSvc.getEffectiveness(getAnalyticsPool(), clientId, locationId, {
        windowDays: parseInt(req.query.window, 10) || undefined,
        sinceDays: parseInt(req.query.days, 10) || undefined,
      });
      // What the measurements have taught us (Phase 3, additive): proven /
      // avoid SKU lists over the last year - the same lists that steer the
      // Python generator. Best-effort: a learning failure never sinks the
      // report; the UI hides the footer when both lists are empty.
      if (report && report.available) {
        try {
          report.learning = await svc.computeLearning(getAnalyticsPool(), req.pool, clientId, locationId);
        } catch (learnErr) {
          logger.warn('Effectiveness learning lists skipped', {
            error: learnErr.message, clientId, locationId,
          });
          report.learning = { proven: [], avoid: [] };
        }
      }
      res.json(report);
    } catch (err) {
      sendError(res, err, 'effectiveness');
    }
  })
);

// ─── GET /api/recommendations/effectiveness/ledger ───────────────────────────
// The full evaluated-rec ledger behind the report: same query + holdout
// exclusion as /effectiveness, but every owner-visible row - filterable
// (?verdict= ?category= ?signal= ?acted=true|false|unknown), sortable
// (?sort=impact|lift|date), paged (?limit= ?offset=), same ?window= / ?days=.
router.get(
  '/effectiveness/ledger',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    const verdict = req.query.verdict ? String(req.query.verdict) : undefined;
    const acted = req.query.acted ? String(req.query.acted) : undefined;
    const sort = req.query.sort ? String(req.query.sort) : undefined;
    if (verdict && !['winner', 'neutral', 'underperformer', 'insufficient_data'].includes(verdict)) {
      return res.status(400).json({
        error: { code: 'INVALID_PARAMS', message: "verdict must be 'winner', 'neutral', 'underperformer' or 'insufficient_data'." },
      });
    }
    if (acted && !['true', 'false', 'unknown'].includes(acted)) {
      return res.status(400).json({
        error: { code: 'INVALID_PARAMS', message: "acted must be 'true', 'false' or 'unknown'." },
      });
    }
    if (sort && !['impact', 'lift', 'date'].includes(sort)) {
      return res.status(400).json({
        error: { code: 'INVALID_PARAMS', message: "sort must be 'impact', 'lift' or 'date'." },
      });
    }
    try {
      const ledger = await evalSvc.getEffectivenessLedger(getAnalyticsPool(), clientId, locationId, {
        windowDays: parseInt(req.query.window, 10) || undefined,
        sinceDays: parseInt(req.query.days, 10) || undefined,
        verdict,
        category: req.query.category ? String(req.query.category) : undefined,
        signal: req.query.signal ? String(req.query.signal) : undefined,
        acted,
        sort,
        limit: parseInt(req.query.limit, 10) || undefined,
        offset: parseInt(req.query.offset, 10) || undefined,
      });
      res.json(ledger);
    } catch (err) {
      sendError(res, err, 'effectiveness-ledger');
    }
  })
);

// ─── GET /api/recommendations/pending-actions ────────────────────────────────
// Current recs (latest run) recommending an observable action the store has
// NOT taken yet, soonest-expiring first - the "don't let this lapse" list.
router.get(
  '/pending-actions',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    try {
      res.json(await evalSvc.getPendingActions(getAnalyticsPool(), clientId, locationId));
    } catch (err) {
      sendError(res, err, 'pending-actions');
    }
  })
);

// ─── GET /api/recommendations/action-question ────────────────────────────────
// The one-question micro-survey: at most ONE "did you actually do this?" for a
// physically unobservable action (endcap / cold box / promote / bundle). Empty
// { question: null } means nothing to ask - the UI shows nothing.
router.get(
  '/action-question',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    try {
      res.json(await evalSvc.getActionQuestion(getAnalyticsPool(), clientId, locationId));
    } catch (err) {
      sendError(res, err, 'action-question');
    }
  })
);

// ─── POST /api/recommendations/:id/action-claim ──────────────────────────────
// The owner's answer: { claim: 'did' | 'did_not' | 'dismissed' | 'none',
// reason? }. A CLAIM, not a completion (migration 039): 'did' marks the card
// 'claimed' and the data decides whether it becomes 'confirmed' - the response
// carries the state the re-evaluation reached, so a store whose purchases feed
// already holds the order sees 'confirmed' on the same click, and one whose
// feed is silent sees 'claimed' with a sentence saying so. 'none' retracts.
// `reason` is the dismissal menu's text, kept on the row (dismiss_reason).
// `evaluation` says whether the re-evaluation finished inside the wait
// ('done'), is still running ('queued'), failed, or was not needed.
router.post(
  '/:id/action-claim',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    const recId = /^\d+$/.test(String(req.params.id)) ? parseInt(req.params.id, 10) : null;
    const claim = String(req.body?.claim || '');
    if (!recId || !evalSvc.CLAIM_VALUES.includes(claim)) {
      return res.status(400).json({
        error: { code: 'INVALID_PARAMS', message: "claim must be 'did', 'did_not', 'dismissed' or 'none'." },
      });
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    try {
      const result = await evalSvc.recordActionClaim(
        getAnalyticsPool(), clientId, locationId, recId, claim, { reason }
      );
      if (!result) {
        return res.status(404).json({ error: { code: 'REC_NOT_FOUND', message: 'Recommendation not found.' } });
      }
      res.json(result);
    } catch (err) {
      sendError(res, err, 'action-claim');
    }
  })
);

// ─── GET /api/recommendations/digest ─────────────────────────────────────────
// Latest weekly digest for this store; ?generate=1 (re)builds the last full
// week on demand instead of waiting for the Monday cron.
router.get(
  '/digest',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    try {
      if (['1', 'true'].includes(String(req.query.generate || ''))) {
        await digestSvc.generateDigest(getAnalyticsPool(), clientId, locationId);
      }
      const digest = await digestSvc.getLatestDigest(getAnalyticsPool(), clientId, locationId);
      res.json({ digest });
    } catch (err) {
      sendError(res, err, 'digest');
    }
  })
);

// ─── GET /api/recommendations/digest/history ─────────────────────────────────
// The archived weekly digests, newest first (?limit=12, max 52) - powers the
// "Am I getting better?" trend and the digest accordion. Each row carries the
// structured payload plus subject/body_text for the "see the email" toggle.
router.get(
  '/digest/history',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    try {
      const digests = await digestSvc.getDigestHistory(
        getAnalyticsPool(), clientId, locationId, parseInt(req.query.limit, 10) || undefined
      );
      res.json({ digests });
    } catch (err) {
      sendError(res, err, 'digest-history');
    }
  })
);

// ─── GET /api/recommendations/scoreboard?month=YYYY-MM ──────────────────────
// The stored pilot scoreboard for the caller's store (pilot_scoreboards, 036):
// two boards kept apart, one line per product. Read-only - the monthly cron
// and scripts/pilot-scoreboard.js are the writers. Month defaults to the
// previous calendar month, the one the cron just built. 404 with a reason
// when no row exists; a store that is not one of the pilot five never has one.
router.get(
  '/scoreboard',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    const month = String(req.query.month || scoreboardSvc.previousMonth());
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'month must be YYYY-MM' } });
    }
    try {
      const row = await scoreboardSvc.getScoreboard(getAnalyticsPool(), clientId, locationId, month);
      if (!row) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: `no scoreboard for ${month}: the board is built on the first of the month for the pilot stores`,
          },
        });
      }
      return res.json({ scoreboard: row });
    } catch (err) {
      return sendError(res, err, 'scoreboard');
    }
  })
);

// ─── POST /api/recommendations/evaluate ──────────────────────────────────────
// Manual trigger for the current tenant (the daily cron is the normal path):
// captures any missing baselines and evaluates every (rec, window) whose
// window has closed in the sales data. Useful right after a backfill or demo.
router.post(
  '/evaluate',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    try {
      await evalSvc.captureMissing(getAnalyticsPool(), clientId, locationId);
      const result = await evalSvc.evaluateTenant(getAnalyticsPool(), clientId, locationId, {
        force: ['1', 'true'].includes(String(req.query.force || '')),
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      sendError(res, err, 'evaluate');
    }
  })
);

// ─── GET /api/recommendations/:id/evaluation ─────────────────────────────────
// Every evaluated window for one rec (tenant-scoped via the WHERE clause).
router.get(
  '/:id/evaluation',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    const recId = /^\d+$/.test(String(req.params.id)) ? parseInt(req.params.id, 10) : null;
    if (!recId) {
      return res.status(400).json({
        error: { code: 'INVALID_PARAMS', message: 'Recommendation id must be a positive integer.' },
      });
    }
    try {
      const windows = await evalSvc.getRecEvaluations(getAnalyticsPool(), clientId, locationId, recId);
      res.json({ rec_id: recId, windows });
    } catch (err) {
      sendError(res, err, 'evaluation');
    }
  })
);

// ─── GET /api/recommendations/:id/case ───────────────────────────────────────
// The full case file for one rec: complete rationale (not the gist), product
// names, the run's generated_at, and signals_cited resolved against the run's
// signal_snapshot into { key, kind, detail } trigger chips. Tenant-scoped;
// holdout recs 404 like every other owner-facing read.
router.get(
  '/:id/case',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    const recId = /^\d+$/.test(String(req.params.id)) ? parseInt(req.params.id, 10) : null;
    if (!recId) {
      return res.status(400).json({
        error: { code: 'INVALID_PARAMS', message: 'Recommendation id must be a positive integer.' },
      });
    }
    try {
      const caseFile = await svc.getRecCase(getAnalyticsPool(), req.pool, clientId, locationId, recId);
      if (!caseFile) {
        return res.status(404).json({ error: { code: 'REC_NOT_FOUND', message: 'Recommendation not found.' } });
      }
      res.json(caseFile);
    } catch (err) {
      sendError(res, err, 'case');
    }
  })
);

// ─── GET /api/recommendations/:id/sales-trace ────────────────────────────────
// Daily units around one rec for the case-file chart: 28-day baseline before
// the rec vs. the after-window (?window=30, one of the configured evaluation
// windows), zero-filled, summed across the rec's SKUs, never past the sales
// frontier. 5-min in-memory cache; holdout recs 404.
router.get(
  '/:id/sales-trace',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;
    const recId = /^\d+$/.test(String(req.params.id)) ? parseInt(req.params.id, 10) : null;
    if (!recId) {
      return res.status(400).json({
        error: { code: 'INVALID_PARAMS', message: 'Recommendation id must be a positive integer.' },
      });
    }
    try {
      const trace = await evalSvc.getSalesTrace(getAnalyticsPool(), clientId, locationId, recId, {
        windowDays: parseInt(req.query.window, 10) || undefined,
      });
      if (!trace) {
        return res.status(404).json({ error: { code: 'REC_NOT_FOUND', message: 'Recommendation not found.' } });
      }
      res.json(trace);
    } catch (err) {
      sendError(res, err, 'sales-trace');
    }
  })
);

// ─── POST /api/recommendations/:id/vote ──────────────────────────────────────
// Thumbs feedback on one rec: { vote: 'up' | 'down' | 'none' } ('none' retracts).
// One vote per rec, stored on the rec row itself (single role per store, no
// RBAC) - voting again flips it. Returns the fresh vote shape so the card can
// update in place. The vote also flows back to the Python service via the
// integration recommendation-history endpoint (feedback loop).
router.post(
  '/:id/vote',
  asyncHandler(async (req, res) => {
    const { client_id: clientId, location_id: locationId } = req.user;

    const recId = /^\d+$/.test(String(req.params.id)) ? parseInt(req.params.id, 10) : null;
    if (!recId) {
      return res.status(400).json({
        error: { code: 'INVALID_PARAMS', message: 'Recommendation id must be a positive integer.' },
      });
    }
    const vote = String(req.body?.vote || '');
    if (!['up', 'down', 'none'].includes(vote)) {
      return res.status(400).json({
        error: { code: 'INVALID_PARAMS', message: "vote must be 'up', 'down' or 'none'." },
      });
    }

    try {
      const counts = await svc.castVote(getAnalyticsPool(), clientId, locationId, recId, vote);
      res.json({ ok: true, id: recId, ...counts });
    } catch (err) {
      sendError(res, err, 'vote');
    }
  })
);

module.exports = router;
