/**
 * Weekly recommendation digest - "here's what Botella did for you last week".
 *
 * Generated per store from the evaluation data (recommendationEvalService),
 * archived in recommendation_digests (analytics migration 003), and emailed
 * through the store's connected Gmail when one exists (the same per-location
 * OAuth tokens routes/email.js manages, sent to the connected address itself).
 * No Gmail connected → the digest is still generated and readable via
 * GET /api/recommendations/digest, and `emailed` stays false.
 *
 * Cadence: the Monday cron (server.js, REC_DIGEST_CRON_SCHEDULE) covers the
 * PREVIOUS Mon-Sun week. Regenerating the same week upserts - idempotent.
 *
 * Content rules: only measured facts. Unevaluated recs are reported as
 * "still being measured", never guessed; dollar figures render only when the
 * evaluator produced them.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { getPool, makeTenantScopedPool } = require('../database/connection');
const evalSvc = require('./recommendationEvalService');

const TOKEN_DIR = path.join(__dirname, '..', 'data');

const dayMs = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);

/** Monday (ISO) of the week containing `d`, minus `weeksBack` weeks. */
function mondayOf(d, weeksBack = 0) {
  const date = new Date(`${iso(d)}T00:00:00Z`);
  const dow = (date.getUTCDay() + 6) % 7; // Mon=0
  return iso(date.getTime() - (dow + weeksBack * 7) * dayMs);
}

const money = (n) => `$${Math.abs(Number(n)).toFixed(0)}`;

/**
 * Build (and upsert) the digest for one store for one week.
 * @param {string} [opts.weekStart] ISO Monday; default = last full week
 * @returns {object|null} the digest row content, or null when disabled
 */
async function generateDigest(analyticsPool, clientId, locationId, opts = {}) {
  if (!(await evalSvc.evalTablesExist(analyticsPool))) return null;
  const hasDigestTable = await analyticsPool
    .query("SELECT to_regclass('public.recommendation_digests') IS NOT NULL AS ok")
    .then((r) => r.rows[0].ok)
    .catch(() => false);
  if (!hasDigestTable) return null;

  const weekStart = opts.weekStart || mondayOf(Date.now(), 1);
  const weekEnd = iso(new Date(`${weekStart}T00:00:00Z`).getTime() + 6 * dayMs);

  // Store name - cosmetic, best-effort.
  let storeName = 'your store';
  try {
    const scoped = makeTenantScopedPool(opts.syncgoPool || getPool(), clientId, locationId);
    const loc = await scoped.query(
      `SELECT location_name FROM client_locations
        WHERE client_id = $1 AND location_id = $2`,
      [clientId, locationId]
    );
    if (loc.rows[0]?.location_name) storeName = loc.rows[0].location_name.trim();
  } catch { /* cosmetic only */ }

  // Last week's recs + their most-informative evaluation so far. The owner's
  // claim and the card's fulfilment state (039) ride along so "you acted on"
  // can mean CONFIRMED BY DATA and the owner's own word gets its own line.
  const hasClaims = await evalSvc.actionClaimColumnExists(analyticsPool).catch(() => false);
  const hasFulfilment = hasClaims && await evalSvc.fulfilmentColumnsExist(analyticsPool).catch(() => false);
  const { rows: recs } = await analyticsPool.query(
    `SELECT r.id, r.category, r.action_type, r.primary_skus, r.rationale, r.status,
            ev.verdict, ev.lift, ev.final_score, ev.action_taken, ev.action_evidence,
            ev.revenue_impact, ev.margin_impact
            ${hasClaims ? ', r.action_claim' : ''}
            ${hasFulfilment ? ', r.fulfilment_state, r.fulfilment_checked_at' : ''}
       FROM recommendations r
       JOIN recommendation_runs run ON run.id = r.run_id
       LEFT JOIN LATERAL (
         SELECT verdict, lift, final_score, action_taken, action_evidence, revenue_impact, margin_impact
           FROM recommendation_evaluations e
          WHERE e.rec_id = r.id
          ORDER BY e.window_days DESC LIMIT 1
       ) ev ON true
      WHERE r.client_id = $1 AND r.location_id = $2
        AND run.generated_at >= $3::date
        AND run.generated_at < ($4::date + 1)
        AND (r.status IS DISTINCT FROM 'holdout')`,
    [clientId, locationId, weekStart, weekEnd]
  );
  for (const r of recs) r.fulfilment = evalSvc.effectiveFulfilment(r);

  const measured = recs.filter((r) => r.verdict && r.verdict !== 'insufficient_data');
  const winners = measured.filter((r) => r.verdict === 'winner');
  const underperformers = measured.filter((r) => r.verdict === 'underperformer');
  // "Acted" is what the DATA confirmed - a feed row, an invoice, a stock
  // inflow, a price drop, a catalogue arrival. The owner's unconfirmed
  // "I did this" is `claimed`, said in the owner's words further down and
  // never folded into acted (039).
  const acted = recs.filter((r) => r.fulfilment === 'confirmed');
  const claimed = recs.filter((r) => r.fulfilment === 'claimed');
  const actedWon = acted.filter((r) => r.verdict === 'winner');
  const revenue = measured.map((r) => r.revenue_impact).filter((v) => v != null)
    .reduce((a, b) => a + Number(b), 0);
  const margin = measured.map((r) => r.margin_impact).filter((v) => v != null)
    .reduce((a, b) => a + Number(b), 0);
  const hasDollars = measured.some((r) => r.revenue_impact != null);

  const star = winners.slice().sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0))[0];
  const gist = (r) => String(r.rationale || '').split(/[.!?]/)[0].slice(0, 110);

  // Currently expiring, not-yet-acted recs (the nudge).
  let pendingCount = 0;
  let pendingLines = [];
  try {
    const pendingRes = await evalSvc.getPendingActions(analyticsPool, clientId, locationId, opts);
    const urgent = (pendingRes.pending || []).filter((p) => p.days_left != null && p.days_left <= 3);
    pendingCount = (pendingRes.pending || []).length;
    pendingLines = urgent.slice(0, 3).map(
      (p) => ` - ${p.rationale_gist.split('.')[0].slice(0, 90)} (${p.days_left} day${p.days_left === 1 ? '' : 's'} left)`
    );
  } catch { /* nudge section degrades */ }

  const lines = [];
  lines.push(`Here's how Botella's recommendations worked out at ${storeName} for the week of ${weekStart}.`);
  lines.push('');
  lines.push(`Recommendations made: ${recs.length}`);
  if (measured.length) {
    lines.push(
      `Measured so far: ${measured.length}, ${winners.length} worked, ` +
      `${underperformers.length} underperformed, ${measured.length - winners.length - underperformers.length} neutral.`
    );
  } else {
    lines.push('Results are still being measured (verdicts appear once a week of sales data accumulates).');
  }
  const observable = recs.filter((r) => r.action_taken === true || r.action_taken === false);
  if (observable.length) {
    lines.push(`Your data confirms you acted on ${acted.length} of the ${observable.length} trackable ones` +
      (actedWon.length ? `, ${actedWon.length} paid off.` : '.'));
  }
  if (claimed.length) {
    lines.push(`You marked ${claimed.length} as done that your sales and orders have not confirmed yet; ` +
      'they count once an order, invoice, stock rise or price change shows up.');
  }
  if (hasDollars) {
    lines.push(`Estimated extra revenue from measured recommendations: ${revenue >= 0 ? '+' : '-'}${money(revenue)}` +
      (margin ? ` (margin ${margin >= 0 ? '+' : '-'}${money(margin)})` : '') + '.');
  }
  // DID RECOMMENDING CHANGE ANYTHING? Everything above measures the cards that
  // were shown, which cannot separate "picked things that were going to sell"
  // from "caused them to sell". The withheld arm is the only thing that can.
  //
  // Stated in the owner's terms, and only when both arms carry enough measured
  // product-windows to support a comparison. Below that floor the digest says
  // nothing rather than quoting a difference built on one or two outcomes -
  // the same rule the rest of this file follows for unmeasured recs.
  try {
    const holdout = await evalSvc.holdoutReport(analyticsPool,
      { clientId, locationId, windowDays: 30 });
    const o = holdout.overall;
    if (!o.difference.refused_reason) {
      lines.push('');
      const better = o.difference.lift > 0;
      lines.push(`We held back ${o.withheld.measurable} comparable `
        + `recommendations at random and did not show them to you. The ones we `
        + `did show sold ${o.shown.avg_lift}x their usual rate; the ones we `
        + `held back sold ${o.withheld.avg_lift}x. So showing them `
        + `${better ? 'added' : 'did not add'} `
        + `${Math.abs(o.difference.lift)}x`
        + `${o.difference.dollars_per_product != null
          ? `, worth ${o.difference.dollars_per_product >= 0 ? '+' : '-'}`
            + `${money(Math.abs(o.difference.dollars_per_product))} per product`
          : ''}.`);
    }
  } catch { /* the digest degrades rather than failing over a comparison */ }

  if (star) {
    lines.push('');
    const liftBit = star.lift != null ? `, lift ${star.lift}x` : '';
    lines.push(`Star of the week: ${gist(star)}${liftBit}.`);
  }
  if (pendingLines.length) {
    lines.push('');
    lines.push(`Needs your attention, expiring without action:`);
    lines.push(...pendingLines);
  } else if (pendingCount) {
    lines.push('');
    lines.push(`${pendingCount} current recommendation${pendingCount === 1 ? '' : 's'} still await action.`);
  }
  lines.push('');
  lines.push('Full breakdown: Recommendations → Effectiveness in your Botella dashboard.');

  const subject = measured.length
    ? `Your Botella week: ${recs.length} recommendations, ${winners.length} wins` +
      (hasDollars && revenue > 0 ? `, ~${money(revenue)} added` : '')
    : `Your Botella week: ${recs.length} recommendations made`;

  const payload = {
    week_start: weekStart, week_end: weekEnd, store_name: storeName,
    recs: recs.length, measured: measured.length, winners: winners.length,
    underperformers: underperformers.length, acted: acted.length,
    acted_won: actedWon.length,
    // The owner's unconfirmed word, kept apart from `acted` (039).
    claimed: claimed.length,
    revenue_impact: hasDollars ? Math.round(revenue * 100) / 100 : null,
    margin_impact: hasDollars && margin ? Math.round(margin * 100) / 100 : null,
    pending_actions: pendingCount,
  };

  await analyticsPool.query(
    `INSERT INTO recommendation_digests
       (client_id, location_id, week_start, subject, body_text, payload)
     VALUES ($1, $2, $3::date, $4, $5, $6::jsonb)
     ON CONFLICT (client_id, location_id, week_start)
       DO UPDATE SET generated_at = now(), subject = EXCLUDED.subject,
                     body_text = EXCLUDED.body_text, payload = EXCLUDED.payload`,
    [clientId, locationId, weekStart, subject, lines.join('\n'), JSON.stringify(payload)]
  );

  return { week_start: weekStart, subject, body_text: lines.join('\n'), payload };
}

/**
 * Email a generated digest through the location's connected Gmail (sent to the
 * connected address itself). Returns true on send. Missing token / any API
 * failure → false, digest stays readable in-app.
 */
async function emailDigest(analyticsPool, clientId, locationId, digest) {
  const tokenPath = path.join(TOKEN_DIR, `gmail_token_location_${locationId}.json`);
  if (!fs.existsSync(tokenPath)) return false;
  try {
    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.GMAIL_REDIRECT_URI
    );
    oauth2Client.setCredentials(JSON.parse(fs.readFileSync(tokenPath, 'utf8')));
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const to = profile.data.emailAddress;
    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${digest.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${digest.body_text}`
    ).toString('base64url');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    await analyticsPool.query(
      `UPDATE recommendation_digests SET emailed = true
        WHERE client_id = $1 AND location_id = $2 AND week_start = $3::date`,
      [clientId, locationId, digest.week_start]
    );
    return true;
  } catch (err) {
    logger.warn(`[Digest] email failed for ${clientId}:${locationId}: ${err.message}`);
    return false;
  }
}

/** Weekly cron entry: generate (and best-effort email) for every tenant with recs. */
async function generateAndSendAll(analyticsPool, opts = {}) {
  const tenants = await analyticsPool.query(
    'SELECT DISTINCT client_id, location_id FROM recommendations'
  );
  let generated = 0;
  let emailed = 0;
  for (const t of tenants.rows) {
    try {
      const digest = await generateDigest(analyticsPool, t.client_id, t.location_id, opts);
      if (!digest) continue;
      generated++;
      if (await emailDigest(analyticsPool, t.client_id, t.location_id, digest)) emailed++;
    } catch (err) {
      logger.error('[Digest] tenant failed', {
        clientId: t.client_id, locationId: t.location_id, error: err.message,
      });
    }
  }
  return { tenants: tenants.rows.length, generated, emailed };
}

/** Latest archived digest for a store (the API read). */
async function getLatestDigest(analyticsPool, clientId, locationId) {
  const hasTable = await analyticsPool
    .query("SELECT to_regclass('public.recommendation_digests') IS NOT NULL AS ok")
    .then((r) => r.rows[0].ok)
    .catch(() => false);
  if (!hasTable) return null;
  const { rows } = await analyticsPool.query(
    `SELECT week_start, generated_at, subject, body_text, payload, emailed
       FROM recommendation_digests
      WHERE client_id = $1 AND location_id = $2
      ORDER BY week_start DESC LIMIT 1`,
    [clientId, locationId]
  );
  return rows[0] || null;
}

/**
 * Archived digests for a store, newest week first (the "Am I getting better?"
 * trend + digest accordion read). week_start ships as to_char'd text - bare
 * DATE parses to local midnight and shifts a day on non-UTC servers (house
 * rule). Missing table (migration 003 not applied) → [].
 */
async function getDigestHistory(analyticsPool, clientId, locationId, limit = 12) {
  const hasTable = await analyticsPool
    .query("SELECT to_regclass('public.recommendation_digests') IS NOT NULL AS ok")
    .then((r) => r.rows[0].ok)
    .catch(() => false);
  if (!hasTable) return [];
  const lim = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 52);
  const { rows } = await analyticsPool.query(
    `SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start,
            generated_at, emailed, subject, body_text, payload
       FROM recommendation_digests
      WHERE client_id = $1 AND location_id = $2
      ORDER BY week_start DESC
      LIMIT $3`,
    [clientId, locationId, lim]
  );
  return rows;
}

module.exports = {
  generateDigest, emailDigest, generateAndSendAll, getLatestDigest, getDigestHistory, mondayOf,
};
