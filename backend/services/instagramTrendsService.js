/**
 * Instagram hashtag trend tracking - the Instagram leg of social_trending.
 *
 * Meta exposes NO "trending" API, so this service tracks a FIXED vocabulary of
 * drink hashtags: a daily cron (server.js) snapshots each tag's post velocity
 * (timestamp spread of the newest recent_media sample - Meta has no post-count
 * field) and top-post engagement into the analytics DB (migration 005). The
 * trend signal is acceleration across snapshots, served to the external Python
 * service via GET .../social-trends (routes/integration.js), which folds the
 * fast-moving terms into the same trend-validation flow Google Trends / Reddit
 * terms already ride (integrationService.getTrendValidation).
 *
 * HARD META CAPS this code is shaped around:
 *   - 30 unique hashtags queried per rolling 7 days, per IG user. Hence the
 *     vocabulary cap of 25 (headroom for ad-hoc debugging) and the ig_hashtags
 *     ID cache - ig_hashtag_search burns cap; media reads by cached ID count
 *     only that hashtag.
 *   - ~200 Graph calls/user/hour. Daily polling of ≤25 tags (2 media reads
 *     each) sits far under it; POLL_DELAY_MS spaces the calls anyway.
 *
 * TOKEN LIFECYCLE: long-lived user tokens die after ~60 days. A weekly cron
 * re-exchanges the current token (fb_exchange_token) and APPENDS the fresh one
 * to meta_token_history; readers take the latest row, falling back to the .env
 * IG_ACCESS_TOKEN seed when the table is empty/missing. A refresh only works
 * while the current token is VALID, so a failed refresh is logged loudly -
 * runbook: regenerate in Graph API Explorer (app "Botella Trends"), exchange
 * for long-lived, then either update IG_ACCESS_TOKEN + restart, or
 *   INSERT INTO meta_token_history (access_token, source) VALUES ('<tok>', 'manual');
 *
 * Everything degrades gracefully until migration 005 is applied (log + empty
 * result / env fallback) - no lazy CREATE here by design.
 */

const https = require('https');
const logger = require('../utils/logger');

const GRAPH = 'https://graph.facebook.com/v26.0';
const GRAPH_TIMEOUT_MS = 20000;

// Meta allows 30 unique hashtags / 7 days; keep headroom below the cliff.
const HASHTAG_CAP = 25;
const POLL_DELAY_MS = 500;
// Meta rejects large pages on busy hashtags with code 1 ("reduce the amount of
// data") - the ladders shrink the page until a size is accepted. Velocity from
// a smaller newest-posts sample is noisier but still a rate.
const RECENT_SAMPLE_LIMITS = [30, 15, 8];
const TOP_SAMPLE_LIMITS = [25, 12, 6];
const MIN_SAMPLE_FOR_RATE = 5;  // below this, posts_per_hour stays NULL (too thin to rate)

// Stable CORE vocabulary - the baseline layer that is always tracked.
// Deliberately 12, not 25: the headroom under Meta's 30-unique/7d cap is
// what the DYNAMIC slice spends (ig_dynamic_terms, migration 006 - terms the
// rec runs' discovery channels observed; see buildPollVocabulary). Override
// with IG_TREND_HASHTAGS (comma-separated, '#' optional); overrides replace
// the core but the dynamic slice still merges on top.
const DEFAULT_HASHTAGS = [
  'espressomartini', 'aperolspritz', 'ranchwater', 'margarita',
  'dirtymartini', 'oldfashioned', 'negroni', 'tequila',
  'mezcal', 'bourbon', 'hardseltzer', 'naturalwine',
];

// Dynamic-slice tuning: how many discovered terms ride along per poll, how
// long an unrefreshed term stays eligible, and the trailing-7-day unique-tag
// budget the merge must stay under (Meta's cap is 30; 28 leaves debug room).
const DYNAMIC_TERMS_MAX = 10;
const DYNAMIC_TERM_TTL_DAYS = 14;
const WEEKLY_UNIQUE_BUDGET = 28;

// Hashtags are concatenated but downstream consumers match WORD-BOUNDED text
// (register validation against product names, category classification), so
// the series carries a display form alongside each tag. Tags without an entry
// display as themselves; env-vocabulary additions should extend this map when
// they're compounds.
const DISPLAY_TERMS = {
  espressomartini: 'espresso martini',
  aperolspritz: 'aperol spritz',
  hugospritz: 'hugo spritz',
  ranchwater: 'ranch water',
  spicymargarita: 'spicy margarita',
  dirtymartini: 'dirty martini',
  oldfashioned: 'old fashioned',
  palomacocktail: 'paloma',
  japanesewhisky: 'japanese whisky',
  hardseltzer: 'hard seltzer',
  naturalwine: 'natural wine',
  orangewine: 'orange wine',
};

// ─── Vocabulary ──────────────────────────────────────────────────────────────

function normalizeTerm(raw) {
  const t = String(raw).toLowerCase().replace(/[^a-z0-9]/g, '');
  return t.length >= 2 && t.length <= 60 ? t : null;
}

function getVocabulary() {
  const raw = process.env.IG_TREND_HASHTAGS;
  const list = raw
    ? raw.split(',').map(normalizeTerm).filter(Boolean)
    : DEFAULT_HASHTAGS;
  const unique = [...new Set(list)];
  if (unique.length > HASHTAG_CAP) {
    logger.warn(
      `[IG trends] Vocabulary has ${unique.length} terms; truncating to ${HASHTAG_CAP} ` +
      `(Meta caps hashtag queries at 30 unique per 7 days).`
    );
    return unique.slice(0, HASHTAG_CAP);
  }
  return unique;
}

function isConfigured() {
  return Boolean(process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN
    && process.env.META_APP_ID && process.env.META_APP_SECRET);
}

/**
 * Record trend terms the Python service's discovery channels observed
 * (POST .../social-trends/observed-terms). Display form in, hashtag form
 * stored; core-vocabulary terms are skipped (already always tracked).
 * Returns how many terms were recorded/refreshed.
 */
async function recordObservedTerms(pool, entries) {
  const core = new Set(getVocabulary());
  let accepted = 0;
  for (const entry of (entries || []).slice(0, 20)) {
    const display = String(entry && (entry.display_term || entry.term) || '').trim().toLowerCase();
    const term = normalizeTerm(display);
    if (!term || core.has(term)) continue;
    const source = String((entry && entry.source) || 'discovery').slice(0, 60);
    try {
      await pool.query(
        `INSERT INTO ig_dynamic_terms (term, display_term, source)
         VALUES ($1, $2, $3)
         ON CONFLICT (term) DO UPDATE
           SET last_seen = now(), display_term = EXCLUDED.display_term`,
        [term, display, source]
      );
      accepted++;
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      logger.warn('[IG trends] ig_dynamic_terms missing (apply migration 006) - observed terms dropped');
      return 0;
    }
  }
  if (accepted) logger.info(`[IG trends] Recorded ${accepted} observed trend term(s) for the dynamic vocabulary`);
  return accepted;
}

/**
 * The poll's actual vocabulary: stable core + freshest dynamic terms, kept
 * under Meta's 30-unique-hashtags/7d cap. Governor logic: tags snapshotted in
 * the trailing 7 days are already spent; core tags always poll; dynamic terms
 * join newest-first while the projected unique count stays ≤ the budget.
 */
async function buildPollVocabulary(pool) {
  const core = getVocabulary();
  let dynamicRows = [];
  try {
    ({ rows: dynamicRows } = await pool.query(
      `SELECT term FROM ig_dynamic_terms
        WHERE last_seen > now() - make_interval(days => $1)
        ORDER BY last_seen DESC
        LIMIT $2`,
      [DYNAMIC_TERM_TTL_DAYS, DYNAMIC_TERMS_MAX]
    ));
  } catch (err) {
    if (!isMissingTable(err)) throw err; // pre-006 environments: core only
  }

  let spent = new Set();
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT term FROM ig_hashtag_snapshots
        WHERE captured_at > now() - interval '7 days'`
    );
    spent = new Set(rows.map((r) => r.term));
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }

  const vocabulary = [...core];
  const planned = new Set([...spent, ...core]);
  for (const { term } of dynamicRows) {
    if (planned.has(term)) {
      if (!vocabulary.includes(term)) vocabulary.push(term); // already budgeted - free to poll
      continue;
    }
    if (planned.size >= WEEKLY_UNIQUE_BUDGET) {
      logger.warn(`[IG trends] Weekly unique-hashtag budget reached (${WEEKLY_UNIQUE_BUDGET}) - deferring "${term}"`);
      continue;
    }
    planned.add(term);
    vocabulary.push(term);
  }
  return vocabulary;
}

// ─── Graph plumbing ──────────────────────────────────────────────────────────

/**
 * GET a Graph endpoint; throws with Meta's error message (token never logged).
 *
 * node:https with `family: 4`, NOT global fetch: some networks (this dev shell,
 * observed 2026-08-18) blackhole IPv6 to Meta - connects hang until timeout
 * instead of failing fast, and fetch's happy-eyeballs never recovers. Meta
 * serves IPv4 everywhere, so pinning costs nothing and matches the pattern in
 * helpers/imagegen-meta.js.
 */
function graphGet(path, params) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Promise((resolve, reject) => {
    const req = https.get(url, { family: 4, timeout: GRAPH_TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* handled below */ }
        if ((res.statusCode && res.statusCode >= 400) || (body && body.error)) {
          const e = (body && body.error) || {};
          const err = new Error(`Meta API ${path}: ${e.message || `HTTP ${res.statusCode}`}`);
          err.metaCode = e.code;
          return reject(err);
        }
        if (body == null) return reject(new Error(`Meta API ${path}: invalid JSON response`));
        resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('socket timeout')));
    req.on('error', (err) =>
      reject(new Error(`Meta API ${path}: network failure (${err.code || err.message})`))
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** graphGet retrying down a page-size ladder while Meta answers code 1. */
async function graphGetShrinking(path, params, limits) {
  let lastErr;
  for (const limit of limits) {
    try {
      return await graphGet(path, { ...params, limit });
    } catch (err) {
      if (err.metaCode !== 1) throw err; // only "too much data" shrinks the page
      lastErr = err;
      await sleep(300);
    }
  }
  throw lastErr;
}

/** True when the error is "relation does not exist" - migration 005 not applied. */
const isMissingTable = (err) => err && err.code === '42P01';

// ─── Token management ────────────────────────────────────────────────────────

/** Latest token from meta_token_history, else the .env seed. */
async function getCurrentToken(pool) {
  try {
    const { rows } = await pool.query(
      'SELECT access_token FROM meta_token_history ORDER BY created_at DESC LIMIT 1'
    );
    if (rows.length) return rows[0].access_token;
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    logger.warn('[IG trends] meta_token_history missing (apply migration 005) - using .env seed token');
  }
  return process.env.IG_ACCESS_TOKEN;
}

/**
 * Weekly cron body: exchange the current long-lived token for a fresh 60-day
 * one and append it. Loud on failure - an expired/invalidated token cannot be
 * refreshed programmatically (see runbook in the header).
 */
async function refreshToken(pool) {
  const current = await getCurrentToken(pool);
  if (!current) {
    logger.error('[IG trends] Token refresh skipped - no token available (set IG_ACCESS_TOKEN).');
    return false;
  }
  try {
    const body = await graphGet('oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      fb_exchange_token: current,
    });
    const expiresAt = body.expires_in
      ? new Date(Date.now() + body.expires_in * 1000)
      : null;
    await pool.query(
      'INSERT INTO meta_token_history (access_token, expires_at, source) VALUES ($1, $2, $3)',
      [body.access_token, expiresAt, 'refresh']
    );
    logger.info(`[IG trends] Token refreshed${expiresAt ? ` (expires ${expiresAt.toISOString().slice(0, 10)})` : ''}`);
    return true;
  } catch (err) {
    // Distinct log shape on purpose - this is the one failure in this service
    // that needs a HUMAN (re-auth in Graph API Explorer) before ~60 days pass.
    logger.error('[IG trends] TOKEN REFRESH FAILED - manual re-auth required before current token expires', {
      error: err.message,
      metaCode: err.metaCode,
      runbook: 'Graph API Explorer -> generate token -> exchange long-lived -> INSERT meta_token_history (source=manual)',
    });
    return false;
  }
}

// ─── Refresh staleness watchdog ──────────────────────────────────────────────
// The weekly refresh keeps token age ≤ 7 days; age crossing STALE_AFTER_DAYS
// means at least two weekly ticks failed (or the server slept through them).
// From there a DAILY cron calls checkAndRetryRefresh, which retries on an
// escalating schedule - 1 day after the threshold, then 2 more, then 3… -
// derived purely from the age, so it needs no persisted retry state and
// survives restarts. Past CRITICAL_AFTER_DAYS it alarms on every tick: the
// token dies at ~60 days and only a manual re-auth can save the pipeline.

const STALE_AFTER_DAYS = 15;
// Ages (whole days since last successful refresh) that trigger a retry:
// 15, then +1, +2, +3… - gaps grow by one day per failure.
const RETRY_AGE_DAYS = new Set([15, 16, 18, 21, 25, 30, 36, 43, 51]);
const CRITICAL_AFTER_DAYS = 52; // past the last scheduled retry - alarm daily

/** Pure schedule predicate (exported for tests): should age N days retry? */
function shouldRetryAtAge(ageDays) {
  return ageDays >= CRITICAL_AFTER_DAYS || RETRY_AGE_DAYS.has(ageDays);
}

/**
 * Daily cron body. No-op while the weekly refresh is healthy (age < 15 days);
 * otherwise retries per the escalating schedule above.
 */
async function checkAndRetryRefresh(pool) {
  let lastRefreshAt = null;
  try {
    const { rows } = await pool.query(
      'SELECT created_at FROM meta_token_history ORDER BY created_at DESC LIMIT 1'
    );
    if (rows.length) lastRefreshAt = rows[0].created_at;
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    return { checked: false, reason: 'table missing' }; // migration 005 pending - nothing to watch yet
  }

  // Empty table = still running on the .env seed (whose age we can't know).
  // Seed it now so the watchdog has a real timestamp to age against.
  if (!lastRefreshAt) {
    logger.info('[IG trends] No refresh history - seeding meta_token_history from the .env token.');
    const ok = await refreshToken(pool);
    return { checked: true, ageDays: null, attempted: true, ok };
  }

  const ageDays = Math.floor((Date.now() - new Date(lastRefreshAt).getTime()) / 86400000);
  if (ageDays < STALE_AFTER_DAYS) return { checked: true, ageDays, attempted: false };

  if (ageDays >= CRITICAL_AFTER_DAYS) {
    logger.error(`[IG trends] Token is ${ageDays} days old and refresh keeps failing - it EXPIRES around day 60. Manual re-auth required (see service header runbook).`);
  }
  if (!shouldRetryAtAge(ageDays)) {
    logger.warn(`[IG trends] Token refresh is stale (${ageDays} days old) - next scheduled retry per backoff.`);
    return { checked: true, ageDays, attempted: false };
  }
  logger.warn(`[IG trends] Token refresh stale (${ageDays} days old) - backoff retry now.`);
  const ok = await refreshToken(pool);
  return { checked: true, ageDays, attempted: true, ok };
}

// ─── Hashtag polling ─────────────────────────────────────────────────────────

/** term → hashtag ID, via the DB cache; searches (and caches) on first sight. */
async function resolveHashtagId(pool, token, term) {
  const { rows } = await pool.query(
    'SELECT hashtag_id FROM ig_hashtags WHERE term = $1', [term]
  );
  if (rows.length) return rows[0].hashtag_id;

  const body = await graphGet('ig_hashtag_search', {
    user_id: process.env.IG_USER_ID, q: term, access_token: token,
  });
  const id = body.data && body.data[0] && body.data[0].id;
  if (!id) throw new Error(`no hashtag ID returned for "${term}"`);

  // Concurrent first-resolve is impossible (poll loop is sequential), but keep
  // the insert conflict-safe anyway - the PK makes a duplicate a no-op.
  await pool.query(
    'INSERT INTO ig_hashtags (term, hashtag_id) VALUES ($1, $2) ON CONFLICT (term) DO NOTHING',
    [term, id]
  );
  return id;
}

/** One observation of one hashtag: velocity from recent_media, engagement from top_media. */
async function captureSnapshot(pool, token, term) {
  const hashtagId = await resolveHashtagId(pool, token, term);

  const recent = await graphGetShrinking(`${hashtagId}/recent_media`, {
    user_id: process.env.IG_USER_ID,
    fields: 'id,timestamp',
    access_token: token,
  }, RECENT_SAMPLE_LIMITS);
  const times = (recent.data || [])
    .map((m) => Date.parse(m.timestamp))
    .filter(Number.isFinite)
    .sort((a, b) => b - a); // newest first (Meta's order, but don't rely on it)

  let postsPerHour = null;
  if (times.length >= MIN_SAMPLE_FOR_RATE) {
    const spreadHours = (times[0] - times[times.length - 1]) / 3.6e6;
    if (spreadHours > 0) postsPerHour = (times.length - 1) / spreadHours;
  }

  const top = await graphGetShrinking(`${hashtagId}/top_media`, {
    user_id: process.env.IG_USER_ID,
    fields: 'id,like_count,comments_count',
    access_token: token,
  }, TOP_SAMPLE_LIMITS);
  const topRows = top.data || [];
  // like_count is omitted on some media (hidden counts) - treat missing as 0.
  const likeSum = topRows.reduce((s, m) => s + (m.like_count || 0), 0);
  const commentSum = topRows.reduce((s, m) => s + (m.comments_count || 0), 0);

  await pool.query(
    `INSERT INTO ig_hashtag_snapshots
       (term, hashtag_id, posts_per_hour, sample_count, newest_post_at,
        oldest_post_at, top_like_sum, top_comment_sum, top_sample_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      term, hashtagId,
      postsPerHour == null ? null : postsPerHour.toFixed(3),
      times.length,
      times.length ? new Date(times[0]) : null,
      times.length ? new Date(times[times.length - 1]) : null,
      likeSum, commentSum, topRows.length,
    ]
  );
  return { term, postsPerHour, sampleCount: times.length };
}

/**
 * Daily cron body: snapshot every vocabulary term. Sequential with spacing -
 * per-term failures are logged and skipped (the cron retries next day); one
 * bad tag never aborts the batch.
 */
async function pollAllHashtags(pool) {
  if (!isConfigured()) {
    logger.info('[IG trends] Not configured (IG_USER_ID / IG_ACCESS_TOKEN / META_APP_* unset) - poll skipped.');
    return { ok: 0, failed: 0, skipped: true };
  }
  const terms = await buildPollVocabulary(pool);
  const token = await getCurrentToken(pool);
  const startedAt = Date.now();
  let ok = 0, failed = 0;
  for (const term of terms) {
    try {
      await captureSnapshot(pool, token, term);
      ok++;
    } catch (err) {
      failed++;
      if (isMissingTable(err)) {
        logger.warn('[IG trends] Snapshot tables missing (apply migration 005) - aborting poll.');
        return { ok, failed, skipped: true };
      }
      logger.error('[IG trends] Hashtag poll failed', {
        term, error: err.message, metaCode: err.metaCode,
      });
    }
    await sleep(POLL_DELAY_MS);
  }
  logger.info(`[IG trends] Poll done - ${ok} ok, ${failed} failed of ${terms.length} tags in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  return { ok, failed, skipped: false };
}

// ─── Serving (integration route) ─────────────────────────────────────────────

/**
 * Per-term trend summary over the last `days`: the latest observation vs. the
 * baseline (average of PRIOR-DAY observations in the window), plus the
 * acceleration ratio the Python side ranks by. Terms with no baseline yet
 * (fresh deployment) come back with acceleration = null - observable, not
 * rankable, until yesterday's snapshot exists.
 *
 * The baseline gate is 20h, not 24h, ON PURPOSE: the poll cadence is daily,
 * so consecutive snapshots sit ~24h ± jitter apart - a strict 24h cutoff
 * made yesterday's observation randomly miss the baseline by minutes.
 * 20h means "not from the same poll day" without sitting on the boundary.
 */
async function getTrendSeries(pool, days = 14) {
  const windowDays = Math.min(Math.max(parseInt(days, 10) || 14, 2), 60);
  try {
    const { rows } = await pool.query(
      `WITH windowed AS (
         SELECT * FROM ig_hashtag_snapshots
         WHERE captured_at >= now() - make_interval(days => $1)
       ),
       latest AS (
         SELECT DISTINCT ON (term) *
         FROM windowed ORDER BY term, captured_at DESC
       ),
       baseline AS (
         SELECT w.term,
                avg(w.posts_per_hour)  AS base_pph,
                avg(w.top_like_sum + w.top_comment_sum) AS base_engagement,
                count(*)               AS n
         FROM windowed w
         JOIN latest l ON l.term = w.term
         WHERE w.captured_at < l.captured_at - interval '20 hours'
           AND w.posts_per_hour IS NOT NULL
         GROUP BY w.term
       )
       SELECT l.term, l.hashtag_id, l.captured_at,
              l.posts_per_hour::float          AS latest_posts_per_hour,
              (l.top_like_sum + l.top_comment_sum)::float AS latest_engagement,
              b.base_pph::float                AS baseline_posts_per_hour,
              b.base_engagement::float         AS baseline_engagement,
              COALESCE(b.n, 0)::int            AS baseline_points
       FROM latest l LEFT JOIN baseline b ON b.term = l.term
       ORDER BY l.term`,
      [windowDays]
    );
    // Dynamic terms carry their display form in ig_dynamic_terms; the static
    // map covers the core. Guarded separately so a pre-006 environment still
    // serves the series.
    let dynDisplay = new Map();
    try {
      const { rows: d } = await pool.query('SELECT term, display_term FROM ig_dynamic_terms');
      dynDisplay = new Map(d.map((r) => [r.term, r.display_term]));
    } catch (err) {
      if (!isMissingTable(err)) throw err;
    }
    return rows.map((r) => ({
      term: r.term,
      display_term: DISPLAY_TERMS[r.term] || dynDisplay.get(r.term) || r.term,
      hashtag_id: r.hashtag_id,
      captured_at: r.captured_at,
      posts_per_hour: r.latest_posts_per_hour,
      engagement: r.latest_engagement,
      baseline_posts_per_hour: r.baseline_posts_per_hour,
      baseline_points: r.baseline_points,
      acceleration:
        r.latest_posts_per_hour != null && r.baseline_posts_per_hour > 0
          ? +(r.latest_posts_per_hour / r.baseline_posts_per_hour).toFixed(3)
          : null,
    })).sort((a, b) => (b.acceleration ?? -1) - (a.acceleration ?? -1));
  } catch (err) {
    if (isMissingTable(err)) {
      logger.warn('[IG trends] ig_hashtag_snapshots missing (apply migration 005) - serving empty series.');
      return [];
    }
    throw err;
  }
}

module.exports = {
  isConfigured,
  getVocabulary,
  getCurrentToken,
  refreshToken,
  checkAndRetryRefresh,
  pollAllHashtags,
  getTrendSeries,
  recordObservedTerms,
  buildPollVocabulary,
  // exported for tests
  _internal: { normalizeTerm, captureSnapshot, resolveHashtagId, shouldRetryAtAge },
};
