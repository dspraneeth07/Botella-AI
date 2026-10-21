require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const { getPool, testConnection, makeTenantScopedPool, probeRlsActive, isRunSqlAllowed } = require('./database/connection');
const { getAnalyticsPool, testAnalyticsConnection } = require('./database/analytics-connection');
const recommendationService = require('./services/recommendationService');
const recommendationEvalService = require('./services/recommendationEvalService');
const recommendationDigestService = require('./services/recommendationDigestService');
const storeIntelligenceService = require('./services/storeIntelligenceService');
const instagramTrendsService = require('./services/instagramTrendsService');
// Resolves the Python interpreter and the pipeline's scripts folder for the
// three jobs that shell out: the gate, the calibration refit and the weekly
// signal-effect fit. Both of the latter built the WINDOWS venv path inline,
// which does not exist on a Linux box.
const pythonRunner = require('./lib/pythonRunner');
const { verifyToken, verifyServiceToken } = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.EVAL_PORT || process.env.PORT || 3000;

app.use(cors({
  origin: true,           // allow all origins
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
}));
app.options('*', cors());  // handle preflight for all routes
app.use(express.json());

// Public, unauthenticated liveness probe for load balancers / nginx / the
// deploy pipeline's health gate. Must stay above the verifyToken-protected
// mounts below so it is reachable without a JWT.
app.get('/api/health', (req, res) => res.status(200).json({ ok: true }));

// Serve generated marketing images/videos as static files
app.use('/imagegen-files', require('express').static(path.join(__dirname, 'data', 'imagegen')));

// Middleware: attach the database pool, TENANT-SCOPED to the authenticated
// caller (Finding #1). attachPool always runs AFTER verifyToken, so req.user
// carries the JWT-bound client_id/location_id. Every query the request makes
// then runs under that tenant's RLS GUCs (database/connection.js). If a request
// somehow lacks a tenant (should not happen on protected routes), fall back to
// the bare pool - RLS would then return zero rows, which is fail-closed.
const attachPool = (req, res, next) => {
  try {
    const base = getPool();
    const cid = req.user && req.user.client_id;
    const lid = req.user && req.user.location_id;
    req.pool = (cid != null && lid != null) ? makeTenantScopedPool(base, cid, lid) : base;
    next();
  } catch (err) {
    console.error('[DB] Pool error:', err.message);
    return res.status(500).json({ error: 'Database connection error.' });
  }
};

// Public routes (no auth required)
app.use('/api/auth', require('./routes/auth'));
app.use('/api/leads', require('./routes/leads'));

// Gmail OAuth callback - must be public (Google redirects here, no auth token available)
const { google } = require('googleapis');
const fs = require('fs');
const oauthClient = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);
app.get('/api/email/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const { location_id } = JSON.parse(state);
    const { tokens } = await oauthClient.getToken(code);
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, `gmail_token_location_${location_id}.json`),
      JSON.stringify(tokens, null, 2)
    );
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    res.redirect(`${frontendUrl}/chat?email_connected=true`);
  } catch (err) {
    console.error('[Email] OAuth callback error:', err.message);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    res.redirect(`${frontendUrl}/chat?email_connected=false`);
  }
});

// Meta (Instagram/Facebook) OAuth callback - must be public
app.get('/api/imagegen/social/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const { client_id, location_id } = JSON.parse(state);
    const meta = require('./helpers/imagegen-meta');
    const tokenData = await meta.exchangeCodeForToken(code);
    const accounts = await meta.getConnectedAccounts(tokenData.access_token);
    tokenData.accounts = accounts;
    meta.saveToken(client_id, location_id, tokenData);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    res.redirect(`${frontendUrl}/chat?meta_connected=true`);
  } catch (err) {
    console.error('[ImageGen] Meta OAuth callback error:', err.message);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    res.redirect(`${frontendUrl}/chat?meta_connected=false`);
  }
});

// Protected routes (auth required + database pool attached)
app.use('/api/chat', verifyToken, attachPool, require('./routes/chat'));
app.use('/api/summary', verifyToken, attachPool, require('./routes/summary'));
app.use('/api/insights', verifyToken, attachPool, require('./routes/insights'));
app.use('/api/dead-stock', verifyToken, attachPool, require('./routes/dead-stock'));
app.use('/api/dashboard', verifyToken, attachPool, require('./routes/dashboard'));
app.use('/api/market-analysis', verifyToken, attachPool, require('./routes/market-analysis'));

// StoreAgent - proxy to the external Python service's /storeagent mount. No
// attachPool (it doesn't touch the syncgo pool); store/location come from the JWT
// inside the route.
app.use('/api/storeagent', verifyToken, require('./routes/storeagent'));

// Recommendations - read (and manually regenerate) the signal-aware stocking recs
// produced by the external Python service. req.pool is `syncgo` (products); the
// route fetches the analytics pool itself (where the rec tables live). Generation
// is normally cron-driven (below); the tab only reads /latest.
app.use('/api/recommendations', verifyToken, attachPool, require('./routes/recommendations'));
// Signal impact - per external signal: cards that cited it, measured lift, owner actions and the fitted beta (same gate as /api/recommendations).
app.use('/api/signal-impact', verifyToken, attachPool, require('./routes/signal-impact'));
// Money audit - per card: made money, lost money, or cannot be said yet, with the reason (same gate; own router because routes/recommendations.js is edited elsewhere and has no bare /:id GET to swallow this path).
app.use('/api/recommendations/money-audit', verifyToken, attachPool, require('./routes/money-audit'));

// PO-effectiveness - measures the Buying report's purchase-order suggestions
// (reorder qty) after the owner acts: acceptance, forecast accuracy and
// post-purchase performance. Analytics DB tables (migration 005).
app.use('/api/po-effectiveness', verifyToken, attachPool, require('./routes/po-effectiveness'));

// Conversations - chat history backed by the analytics DB.
// Uses its own pool internally; no need for attachPool (which would attach the
// production syncgo pool, which the conversations route doesn't use).
app.use('/api/conversations', verifyToken, require('./routes/conversations'));

// Feedback - thumbs / star rating / free-text, persisted to the analytics DB.
// Own pool internally (analytics), so no attachPool. Tenant + user from the JWT.
app.use('/api/feedback', verifyToken, require('./routes/feedback'));

// BottleSense - the measurement models from the August 2026 BottleSense
// research, run for one store on the one thing that estate does not have: cost.
app.use('/api/bottlesense', verifyToken, attachPool, require('./routes/bottlesense'));

// Email routes (protected - OAuth callback already registered above as public)
app.use('/api/email', verifyToken, attachPool, require('./routes/email'));

// Image Generation routes (protected)
app.use('/api/imagegen', verifyToken, attachPool, require('./routes/imagegen'));

// Purchase orders / invoices (protected). attachPool is required: the route
// reads and writes the store's own catalogue (syncgo) as well as our analytics
// rows, and the create-product path inserts into products.
app.use('/api/purchase-orders', verifyToken, attachPool, require('./routes/purchase-orders'));

// Card Statement Analysis (CARD-STATEMENTS.md). Analytics DB only, so no
// attachPool; scoped to the client from the JWT, not to the store.
app.use('/api/card-statements', verifyToken, require('./routes/card-statements'));

// Integration routes - consumed by the external Python recommendation service.
// Machine-to-machine: tenant keys arrive as path segments (/:clientId/locations/:locationId/*),
// NOT from a user JWT, so no verifyToken here. verifyServiceToken is a no-op until
// NODE_API_TOKEN is set; once set, every call must send `Authorization: Bearer
// <NODE_API_TOKEN>`. attachPool yields the bare pool (no req.user); integration.js
// tenant-scopes per path param so RLS (migration 002) still applies if enabled.
app.use('/api/clients', verifyServiceToken, attachPool, require('./routes/integration'));

// Ingestion control plane (sheet 01) - the durable raw log, sync outcomes, the
// staleness read downstream stages refuse on, and the connector-level digest.
// Server-to-server like /api/clients above: the POS fetcher, the digest cron
// and ops scripts call it, never a browser. req.pool is `syncgo` (read-only,
// the record of what actually synced); the analytics pool is fetched inside.
app.use('/api/ingestion', verifyServiceToken, attachPool, require('./routes/ingestion'));

// Global error handler - catches all unhandled route errors
app.use(errorHandler);

// Serve React build in production
app.use(express.static(path.join(__dirname, '..', 'frontend', 'build')));
app.get('*', (req, res) => {
  // Never serve the SPA shell for API paths - return a proper JSON 404 instead.
  // This prevents fetch() callers from receiving HTML and failing to parse JSON.
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API endpoint not found.' } });
  }
  res.sendFile(path.join(__dirname, '..', 'frontend', 'build', 'index.html'));
});

// Test database connection on startup, then probe whether RLS is active so the
// run_sql fallback can decide if it's safe to run (Finding #1).
testConnection()
  .then(() => logger.info('Database connected successfully'))
  .then(() => probeRlsActive(getPool()))
  .then((rls) => {
    if (isRunSqlAllowed()) {
      logger.info(`run_sql fallback ENABLED (RLS active=${rls}${process.env.BOTELLA_ALLOW_RUNSQL_WITHOUT_RLS === 'true' ? ', validator-only opt-out set' : ''})`);
    } else {
      logger.warn(`run_sql fallback DISABLED - RLS not active on tenant tables (apply migration 002, or set BOTELLA_ALLOW_RUNSQL_WITHOUT_RLS=true for dev/eval). Bot answers via metric tools only.`);
    }
  })
  .catch((err) => logger.error('Database connection failed', { error: err.message }));

// Also probe the analytics DB so its pool is created at boot (and any
// credential issue surfaces immediately instead of on the first chat).
testAnalyticsConnection()
  .then((ok) => {
    if (ok) logger.info('Analytics database connected successfully');
    else logger.warn('Analytics database NOT reachable - chat will work but interactions will not be logged');
  })
  .catch((err) => logger.error('Analytics database probe threw', { error: err.message }));

// ─── Boot-time analytics migrations ──────────────────────────────────────────
// Applies pending database/analytics-migrations/*.sql at startup (tracked in
// schema_migrations), so an environment converges without a manual psql step.
// Uses ANALYTICS_MIGRATE_DSN when set (owner/admin creds for environments where
// the app role has no schema-CREATE); otherwise the app-role connection.
// Syncgo migrations are never run at boot - they need DBA credentials by design.
//
// ON BY DEFAULT EVERYWHERE EXCEPT PRODUCTION.
//
// It used to be opt-in, and the cost of that landed on everyone who was not the
// developer who wrote the migration. The analytics database is per-machine and
// starts empty, so a fresh clone reached Purchase Orders and got
//
//     relation "purchase_orders" does not exist
//
// as a generic 500, on repeat, having done nothing wrong. There is no version
// of that where the right answer was "you should have run npm run migrate":
// these are OUR tables in OUR database, and the app knows which ones are
// missing at the moment it starts.
//
// Production stays opt-in. There the schema is the deploy's business, migrations
// want reviewing before they run against real tenants' data, and several
// instances boot at once.
//
// Failures stay NON-FATAL either way: every consumer of these tables degrades
// while one is missing, and `npm run migrate` remains the deliberate path.
const MIGRATE_ON_BOOT = process.env.MIGRATE_ON_BOOT == null || process.env.MIGRATE_ON_BOOT === ''
  ? process.env.NODE_ENV !== 'production'
  : ['1', 'true'].includes(String(process.env.MIGRATE_ON_BOOT).toLowerCase());

// Card statements left 'analysing' by the previous process would otherwise
// poll forever (CARD-STATEMENTS.md D13). Run after the boot migrations when
// there are any, so a fresh database has the table first; at once when there
// are not. Never fatal: recoverStuck() swallows its own errors and reads a
// missing table as nothing to sweep.
function recoverCardStatements() {
  try {
    return require('./services/cardStatementService').recoverStuck()
      .catch((err) => logger.warn(`[CS] boot recovery failed (continuing): ${err.message}`));
  } catch (err) {
    logger.warn(`[CS] boot recovery failed (continuing): ${err.message}`);
    return undefined;
  }
}

if (MIGRATE_ON_BOOT) {
  const { runMigrations } = require('./database/migrate');
  runMigrations('analytics', { log: (m) => logger.info(m) })
    .then(({ applied, drifted }) => {
      if (applied.length) logger.info(`[migrate] boot: applied ${applied.join(', ')}`);
      else logger.info('[migrate] boot: analytics schema up to date');
      if (drifted.length) logger.warn(`[migrate] boot: DRIFTED files detected: ${drifted.join(', ')}`);
    })
    .catch((err) => logger.error(`[migrate] boot migration failed (continuing degraded): ${err.message}`))
    // After success or failure alike: a failed later migration does not mean
    // the card statement tables are missing, and a missing one is harmless.
    .finally(recoverCardStatements);
} else {
  recoverCardStatements();
}

// Daily email cron job - runs at 8:00 AM every day
cron.schedule('0 8 * * *', async () => {
  console.log('[Cron] Running daily promo email check...');
  const dataDir = path.join(__dirname, 'data');
  // Scan for Gmail token files
  try {
    const files = fs.readdirSync(dataDir).filter(f => f.startsWith('gmail_token_location_') && f.endsWith('.json'));
    for (const file of files) {
      const locationId = file.replace('gmail_token_location_', '').replace('.json', '');
      console.log(`[Cron] Location ${locationId} has Gmail connected, checking promotions...`);
    }
  } catch (err) {
    // data dir might not exist yet
  }
});

// ─── Daily recommendation generation ─────────────────────────────────────────
// The Suggestions tab is read-only - it serves the LATEST persisted run. This
// cron is what produces those runs: once a day it fans out over the scoped
// stores, calls the external Python service (Node-mediated), and persists each
// RunResult to the analytics DB. Concurrency is bounded so a network of stores
// doesn't open hundreds of simultaneous Python/LLM calls. Per-store failures are
// logged and skipped (cron retries next day); one bad store never aborts the batch.
const REC_CRON_SCHEDULE = process.env.REC_CRON_SCHEDULE || '0 4 * * *'; // 04:00 daily
const REC_CRON_CONCURRENCY = parseInt(process.env.REC_CRON_CONCURRENCY || '5', 10);

// EVERY STORE, and the default used to be one.
//
// This read '46:46' - a single pilot location - so the nightly batch generated
// recommendations for ONE of 197 stores. Every other store had cards only if
// somebody hit /run-recommendations for it by hand, which is why logging into a
// store showed nothing: not because the engine could not serve it, but because
// nothing had ever asked.
//
// The comment it replaces said "revisit once run volume/cost is understood", and
// it now is: a run is bounded work against the store's own sales, the LLM writes
// prose AFTER the decision and an outage costs fluency rather than a card, and the
// pool below caps concurrency at 5. A store with no sales returns an empty slate
// in under a second, which is most of the long tail.
//
// Set REC_CRON_LOCATIONS to a comma-separated "client:location" list to narrow it
// again - the allowlist path is unchanged and still the right tool for a pilot.
const REC_CRON_LOCATIONS = process.env.REC_CRON_LOCATIONS || 'ALL';

function parseScopedLocations(raw) {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [c, l] = pair.split(':').map((n) => parseInt(n, 10));
      return { clientId: c, locationId: l };
    })
    .filter((p) => Number.isInteger(p.clientId) && Number.isInteger(p.locationId));
}

let recGenInFlight = false;

async function runDailyRecommendationBatch() {
  if (recGenInFlight) {
    logger.warn('[Rec cron] Previous batch still running - skipping this tick.');
    return;
  }
  recGenInFlight = true;
  const startedAt = Date.now();
  let ok = 0, failed = 0, refused = 0;
  try {
    const syncgoPool = getPool();
    const analyticsPool = getAnalyticsPool();
    const recGate = require('./services/recommendationGateService');
    // Default: explicit allowlist (the pilot store). REC_CRON_LOCATIONS=ALL → every store.
    const locations = REC_CRON_LOCATIONS.trim().toUpperCase() === 'ALL'
      ? await recommendationService.listAllLocations(syncgoPool)
      : parseScopedLocations(REC_CRON_LOCATIONS);
    logger.info(`[Rec cron] Generating recommendations for ${locations.length} store(s) (scope: ${REC_CRON_LOCATIONS})`);

    // Simple bounded-concurrency worker pool over the location list.
    let cursor = 0;
    const worker = async () => {
      while (cursor < locations.length) {
        const { clientId, locationId } = locations[cursor++];
        try {
          // ── THE QUALITY GATE, BEFORE A SLATE IS BUILT (checklist 13) ────
          //
          // The 03:50 quality job wrote this store's verdict minutes ago. A
          // store it REJECTED (never synced, schema broken), QUARANTINED
          // (anomalous batch) or whose feed is stale past six times its own
          // cadence must not produce a buy signal at all - not "produce one
          // and have the read path withhold it". The read path still applies
          // the same rule (`admit()`), from the same function, so a verdict
          // written AFTER generation is honoured too; this is the half that
          // stops the compute and the misleading `recommendation_runs` row.
          //
          // `unknown` - no row, or the job did not run - ADMITS, on purpose.
          // The quality job closing that gap store by store is the design;
          // its absence must not silence the estate. See ADMITTING_VERDICTS.
          const quality = await recGate.getStoreQuality(analyticsPool, clientId, locationId);
          const refusals = recGate.storeRefusals(quality);
          if (refusals.length) {
            refused++;
            logger.warn('[Rec cron] Store refused by data quality - no run generated', {
              clientId, locationId, verdict: quality.verdict, reasons: refusals,
              staleness_days: quality.staleness_days ?? null,
              median_interval_days: quality.median_interval_days ?? null,
              connector: quality.connector || null,
            });
            continue;
          }
          await recommendationService.generateAndPersist(analyticsPool, clientId, locationId);
          ok++;
        } catch (err) {
          failed++;
          // Log the CODE and the target URL, not just the message: several very
          // different faults (service down, wrong URL, bad API key, LLM failure)
          // collapse into the same user-facing sentence, which makes a bare
          // message nearly undiagnosable after the fact.
          logger.error('[Rec cron] Store failed', {
            clientId,
            locationId,
            code: err.code || 'UNKNOWN',
            status: err.statusCode,
            target: process.env.REC_SERVICE_URL || '(unset -> code default)',
            error: err.message,
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(REC_CRON_CONCURRENCY, locations.length) }, worker)
    );
    logger.info(`[Rec cron] Done - ${ok} ok, ${failed} failed, ${refused} refused by data quality in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (err) {
    logger.error('[Rec cron] Batch aborted', { error: err.message });
  } finally {
    recGenInFlight = false;
  }
}

// ─── Data quality gates (sheet 02) - nightly, before generation ──────────────
//
// `app/pipeline/contracts/gates.py` has held the four gates since sheet 02 and
// `store_quality_state` (migration 017) is the row the serving path reads
// before admitting a card. NOTHING ran the gates and NOTHING wrote the row, so
// every store read as `unknown`, which admits - and a POS feed three weeks dark
// looked exactly like a healthy one. Checklist 13.
//
// AT 03:50, and the slot is the point. The 03:00 ingestion digest refreshes
// sync_store_state from syncgo - that is the freshness input. The 04:00
// generation batch reads the verdict this writes before it builds a slate. Run
// it earlier and it judges yesterday's sync state; run it later and the batch
// generates cards for a store this would have refused.
//
// A cron schedule is not a dependency. If the digest ever grows past fifty
// minutes this judges stale state, silently; the fix then is to chain the two.
//
// FAILING IS SAFE. A night this does not run leaves every store's row as it
// was; a store never examined stays `unknown` and admits, which is the
// documented fail-open. The cost is a day's delay in refusing a store that
// went dark overnight, which is why this logs rather than pages.
const QUALITY_CRON_SCHEDULE = process.env.QUALITY_CRON_SCHEDULE || '50 3 * * *';
let qualityInFlight = false;

async function runDailyQualityGates() {
  if (qualityInFlight) {
    logger.warn('[Quality cron] Previous run still in flight - skipping this tick.');
    return;
  }
  qualityInFlight = true;
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    // Its own process, like the gate: it shells out to Python per store and
    // must not sit on the API's event loop.
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(__dirname, 'scripts', 'run-quality.js')],
      { maxBuffer: 16 * 1024 * 1024 }
    );
    const lines = stdout.trim().split(String.fromCharCode(10))
      .map((l) => l.trim()).filter(Boolean);
    logger.info(`[Quality cron] ${lines.length ? lines[lines.length - 1] : ''}`);

    // The refused stores are the morning list: each is a store whose owner
    // will see no cards today, with the reason on the row.
    const { rows } = await getAnalyticsPool().query(
      `SELECT client_id, location_id, connector, verdict, staleness_days,
              median_interval_days, never_synced, reasons
         FROM store_quality_state
        WHERE checked_at > now() - interval '1 day'
          AND (verdict IN ('reject', 'quarantine') OR never_synced)
        ORDER BY connector, client_id, location_id`
    );
    for (const r of rows) {
      logger.warn('[Quality cron] store refused', {
        store: `${r.client_id}:${r.location_id}`, connector: r.connector,
        verdict: r.verdict, never_synced: r.never_synced,
        staleness_days: r.staleness_days, reasons: r.reasons,
      });
    }
  } catch (err) {
    logger.error('[Quality cron] run failed', { error: err.message });
  } finally {
    qualityInFlight = false;
  }
}

cron.schedule(QUALITY_CRON_SCHEDULE, runDailyQualityGates);
logger.info(`[Quality cron] Scheduled nightly data-quality gates at "${QUALITY_CRON_SCHEDULE}" (after the 03:00 sync-state refresh, before the 04:00 batch)`);

// ─── Daily SHELF-COUNT capture, before generation ───────────────────────────
//
// `featureStoreService.captureOnHand` has existed and been reachable only from
// `scripts/build-feature-store.js`, a CLI nobody scheduled. Measured before
// adding this: feature_daily holds 95 stores and FIVE of them have a shelf
// count at all (106, 171, 22, 92, 97); the newest count anywhere was 15 days
// old; of the five pilot stores only 171 had any. So the table that is supposed
// to record what was on the shelf each day recorded almost nothing.
//
// WHAT THAT COSTS, PRECISELY. Live cards are not affected - the request path
// reads stock from syncgo when it builds a slate. What is lost is the ability to
// MEASURE them afterwards:
//
//   * a stockout card cannot be graded. "We said the shelf was empty and it
//     was" needs a count for that day, and a count taken next month is a
//     different fact.
//   * the evaluator's open-day rate falls back to calendar days, which it warns
//     about on every run. For a store that closes Sundays plus holidays - 200
//     closed days of 1,360 at Bethany - that understates every rate by 21.7%.
//   * the gate's volume-matched null pool reads this table, so the comparison
//     the gate makes is against a population that mostly does not exist.
//
// BEFORE THE 04:00 GENERATION, at 03:45, and the order is the point: the count
// recorded is then the closest one to the shelf the cards were built against.
// Capturing after generation would file today's cards against tomorrow's shelf.
//
// It runs AHEAD of the sales side of the feature store deliberately - the same
// reasoning `build-feature-store.js` already documents for its own ordering. A
// shelf count reads `products`, not `sale_items`, so "this store sold nothing"
// says nothing about whether its counts are worth recording; a store holding
// stock it is not selling is the DEAD STOCK case, which is the one most worth
// having a count for.
//
// FAILING IS SAFE AND NEVER REWRITES THE PAST. Capture is idempotent
// (`on_hand = COALESCE(feature_daily.on_hand, EXCLUDED.on_hand)`), a stale
// count is filed under the day it was actually observed rather than stamped
// with today, and negative counts are dropped rather than clamped - 9% of rows
// estate-wide report negative stock, and clamping turns "this count is wrong"
// into "this shelf is empty", which is the reading that orders the most.
const ON_HAND_CRON_SCHEDULE = process.env.ON_HAND_CRON_SCHEDULE || '45 3 * * *';
const ON_HAND_STALE_AFTER_DAYS = parseInt(
  process.env.ON_HAND_STALE_AFTER_DAYS || '7', 10);

let onHandInFlight = false;

async function runDailyOnHandCapture() {
  if (onHandInFlight) {
    logger.warn('[OnHand cron] Previous capture still in flight - skipping.');
    return;
  }
  onHandInFlight = true;
  const startedAt = Date.now();
  try {
    const featureStore = require('./services/featureStoreService');
    // Scoped exactly like the generation batch, so a deployment piloting five
    // stores does not capture ninety-five - and so the stores that HAVE cards
    // are the stores that have counts to grade them against.
    const locations = REC_CRON_LOCATIONS.trim().toUpperCase() === 'ALL'
      ? await recommendationService.listAllLocations(getPool())
      : parseScopedLocations(REC_CRON_LOCATIONS);
    if (!locations.length) {
      logger.info('[OnHand cron] No stores in scope.');
      return;
    }
    // The observation date is derived in SQL from `last_updated`, not here -
    // see featureStoreService. `asOf` only bounds the future-dated drop.
    const asOf = new Date().toISOString().slice(0, 10);
    const analytics = getAnalyticsPool();
    const syncgo = getPool();

    let stores = 0; let written = 0; let negative = 0; let future = 0;
    let retried = 0;
    const stale = [];
    for (const loc of locations) {
      try {
        // ONE RETRY, because the read is remote and its cost scales with the
        // store. The capture pulls every SKU's stock_qty from the warehouse at
        // another host; measured on the largest store here (29,790 SKUs) the
        // same call took 2.7s once and 18.2s a few minutes later, and the
        // syncgo statement timeout is 15s. So a slow minute, not a broken
        // store, is enough to lose a night of counts - and a count skipped
        // tonight is a day that can never be graded, since the shelf has moved
        // by tomorrow.
        //
        // Safe to repeat: capture is idempotent by construction
        // (`on_hand = COALESCE(feature_daily.on_hand, EXCLUDED.on_hand)`), so a
        // retry after a partial write finishes the job rather than doubling it.
        let r;
        try {
          r = await featureStore.captureOnHand(analytics, syncgo, {
            clientId: loc.clientId, locationId: loc.locationId, asOf,
          });
        } catch (first) {
          logger.warn('[OnHand cron] retrying one store', {
            store: `${loc.clientId}:${loc.locationId}`, error: first.message,
          });
          r = await featureStore.captureOnHand(analytics, syncgo, {
            clientId: loc.clientId, locationId: loc.locationId, asOf,
          });
          retried += 1;
        }
        stores += 1;
        written += r.written;
        negative += r.dropped_negative;
        future += r.dropped_future;
        if (r.staleness_days === null
            || r.staleness_days > ON_HAND_STALE_AFTER_DAYS) {
          stale.push({ store: `${loc.clientId}:${loc.locationId}`,
            newest: r.newest_observation, days: r.staleness_days });
        }
      } catch (err) {
        // Per store, so one broken feed cannot cost the other ninety-four
        // their counts.
        logger.warn('[OnHand cron] capture failed for one store', {
          store: `${loc.clientId}:${loc.locationId}`, error: err.message,
        });
      }
    }
    logger.info(`[OnHand cron] ${written} count(s) across ${stores} store(s) `
      + `in ${Math.round((Date.now() - startedAt) / 1000)}s`
      + `${negative ? `, ${negative} negative dropped` : ''}`
      + `${future ? `, ${future} future-dated dropped` : ''}`
      + `${retried ? `, ${retried} needed a retry` : ''}`);

    // The line a human should read. A store whose newest count predates the
    // threshold cannot have a reorder sized against it at all, and that is a
    // fact about the POS feed rather than about the engine.
    if (stale.length) {
      logger.warn(`[OnHand cron] ${stale.length} store(s) have no count newer `
        + `than ${ON_HAND_STALE_AFTER_DAYS} days - no reorder can be sized `
        + `for them`, { stores: stale.slice(0, 20) });
    }
  } catch (err) {
    logger.error('[OnHand cron] capture run failed', { error: err.message });
  } finally {
    onHandInFlight = false;
  }
}

cron.schedule(ON_HAND_CRON_SCHEDULE, runDailyOnHandCapture);
logger.info(`[OnHand cron] Scheduled daily shelf-count capture at `
  + `"${ON_HAND_CRON_SCHEDULE}" (before generation; stale after `
  + `${ON_HAND_STALE_AFTER_DAYS}d)`);

cron.schedule(REC_CRON_SCHEDULE, runDailyRecommendationBatch);

// ─── Daily ingestion digest (sheet 01) ───────────────────────────────────────
// ONE report per connector per day, never one per store. That distinction is
// the single change that makes 1,500 stores operable: at 26% failure a
// per-store alert stream is 390 messages a day and gets muted, after which
// stores go dark unnoticed while the engine serves stale data confidently.
//
// Runs at 03:00, before the 03:30 store-intelligence warm and the 04:00 rec
// batch, so the day's staleness is known before anything reasons on the data.
// Refreshes sync_store_state from syncgo first - the fetching happens outside
// this backend, so job_runs_history is the authority on what actually synced.
const INGEST_DIGEST_SCHEDULE = process.env.INGEST_DIGEST_SCHEDULE || '0 3 * * *';
let ingestDigestInFlight = false;

async function runDailyIngestionDigest() {
  if (ingestDigestInFlight) {
    logger.warn('[Ingest cron] Previous digest still running - skipping this tick.');
    return;
  }
  ingestDigestInFlight = true;
  try {
    const ingest = require('./services/ingestionService');
    const analyticsPool = getAnalyticsPool();
    const syncgoPool = getPool();

    const refreshed = await ingest.refreshSyncState(analyticsPool, syncgoPool);
    const digest = await ingest.buildConnectorDigest(analyticsPool, syncgoPool);

    logger.info(`[Ingest cron] state refreshed for ${refreshed.upserted} store-entities`);
    // Logged in full: this IS the daily report until it is wired to email.
    console.log(`\n${ingest.formatDigest(digest)}`);

    for (const row of digest) {
      // One line per connector that needs a human. Deliberately not per store.
      if (row.failed > 0 || row.stores_never > 0 || Number(row.cost_coverage_pct) === 0) {
        logger.warn('[Ingest cron] connector needs attention', {
          connector: row.connector,
          failed: row.failed,
          failure_pct: row.failure_pct,
          credential: row.credential_count,
          schema: row.schema_count,
          stores_never_synced: row.stores_never,
          stores_stale: row.stores_stale,
          cost_coverage_pct: row.cost_coverage_pct,
        });
      }
    }
  } catch (err) {
    logger.error('[Ingest cron] digest failed', { error: err.message });
  } finally {
    ingestDigestInFlight = false;
  }
}

cron.schedule(INGEST_DIGEST_SCHEDULE, runDailyIngestionDigest);
logger.info(`[Ingest cron] Scheduled daily connector digest at "${INGEST_DIGEST_SCHEDULE}"`);

// ─── Supplier lead times (migration 037) - nightly, after the digest ────────
// The reorder quantity rests on a delivery lead time that was declared seven
// days in three places and measured nowhere, because nothing recorded when an
// order arrived. `purchase_orders.received_date` now can, and this job turns a
// store's receipts into one row per vendor in `supplier_lead_times` - a median
// over the trailing year where at least LEAD_TIME_MIN_OBSERVATIONS receipts
// exist, the declared default (flagged as such) where they do not.
//
// 03:10: after the 03:00 ingestion digest and before the 03:30 store-intel
// warm and the 04:00 generation batch, so the night's cards read tonight's
// figures. Same scope as the rec cron. FAILING IS SAFE: a vendor row that is
// not refreshed keeps last night's value, and a store with no documents has
// nothing to refresh and loses nothing.
const LEAD_TIME_CRON_SCHEDULE = process.env.LEAD_TIME_CRON_SCHEDULE || '10 3 * * *';
let leadTimeRefreshInFlight = false;

async function runDailyLeadTimeRefresh() {
  if (leadTimeRefreshInFlight) {
    logger.warn('[LeadTime cron] Previous refresh still running - skipping this tick.');
    return;
  }
  leadTimeRefreshInFlight = true;
  const startedAt = Date.now();
  let stores = 0, vendors = 0, measured = 0, failed = 0;
  try {
    const leadTimeService = require('./services/leadTimeService');
    const analyticsPool = getAnalyticsPool();
    const locations = REC_CRON_LOCATIONS.trim().toUpperCase() === 'ALL'
      ? await recommendationService.listAllLocations(getPool())
      : parseScopedLocations(REC_CRON_LOCATIONS);
    for (const { clientId, locationId } of locations) {
      try {
        const r = await leadTimeService.refreshLeadTimes(analyticsPool, clientId, locationId);
        if (r.skipped) break; // the whole estate is pre-037; nothing to do tonight
        stores += 1; vendors += r.vendors; measured += r.measured;
      } catch (err) {
        failed += 1;
        logger.warn('[LeadTime cron] refresh failed for one store', {
          clientId, locationId, error: err.message });
      }
    }
    logger.info(`[LeadTime cron] ${vendors} vendor row(s) across ${stores} store(s), `
      + `${measured} measured, ${failed} failed, in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (err) {
    logger.error('[LeadTime cron] refresh run failed', { error: err.message });
  } finally {
    leadTimeRefreshInFlight = false;
  }
}

cron.schedule(LEAD_TIME_CRON_SCHEDULE, runDailyLeadTimeRefresh);
logger.info(`[LeadTime cron] Scheduled nightly supplier lead-time refresh at "${LEAD_TIME_CRON_SCHEDULE}"`);

// ─── The gate (sheets 17 + 19) - nightly ────────────────────────────────────
//
// Reads the outcomes the evaluation pass recorded, compares each store-family
// against a volume-matched null, and writes the verdict. This is what moves a
// family from shadow to live - and back to suspended if it stops working.
//
// AFTER the evaluation, and that ordering is the whole point: the gate judges
// on outcomes, so judging before the day's outcomes are scored would decide
// today's visibility on yesterday's evidence.
//
// AND IT WAS NOT AFTER IT. This read '0 5 * * *' and so does
// REC_EVAL_CRON_SCHEDULE below - the two fired in the same minute, in whatever
// order node-cron happened to register them, with the gate reading the very
// table the evaluation was writing. The comment above was right and the schedule
// did not implement it. 06:00 leaves the evaluation a clear hour, the same margin
// the evaluation itself gets after the 04:00 generation batch.
//
// A cron schedule is not a dependency. If the evaluation ever grows past an hour
// this is wrong again, silently, and the fix then is to chain the two rather than
// to widen the gap - see the note on runDailyRecommendationEvaluation.
//
// FAILING IS SAFE HERE. A gate that does not run leaves every family where it
// was - shadow stays shadow, live stays live. The cost of a missed night is a
// day's delay in a state change, not a wrong state, which is why this logs
// rather than pages.
const GATE_CRON_SCHEDULE = process.env.GATE_CRON_SCHEDULE || '0 6 * * *';
let gateInFlight = false;

async function runDailyGate() {
  if (gateInFlight) {
    logger.warn('[Gate cron] Previous run still in flight - skipping this tick.');
    return;
  }
  gateInFlight = true;
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const path = require('path');
    const execFileAsync = promisify(execFile);

    // Run as its own process: it shells out to Python for the statistics, and
    // a long randomisation test must not sit on the API's event loop.
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(__dirname, 'scripts', 'run-gate.js')],
      { maxBuffer: 16 * 1024 * 1024 }
    );
    const lines = stdout.trim().split(String.fromCharCode(10))
      .map((l) => l.trim()).filter(Boolean);
    const summary = lines.length ? lines[lines.length - 1] : '';
    logger.info(`[Gate cron] ${summary}`);

    // Transitions are the line a human should read: a family that was live for
    // three months and is now suspended is a signal about that store.
    const familyGate = require('./services/familyGateService');
    const transitions = await familyGate.recentTransitions(getAnalyticsPool(), { days: 1 });
    for (const t of transitions) {
      logger.warn('[Gate cron] family changed state', {
        store: `${t.client_id}:${t.location_id}`,
        family: t.family,
        from: t.previous_state,
        to: t.state,
        reason: t.reason,
        n_outcomes: t.n_outcomes,
        p_value: t.p_value,
      });
    }
  } catch (err) {
    logger.error('[Gate cron] run failed', { error: err.message });
  } finally {
    gateInFlight = false;
  }
}

cron.schedule(GATE_CRON_SCHEDULE, runDailyGate);
logger.info(`[Gate cron] Scheduled nightly gate evaluation at "${GATE_CRON_SCHEDULE}"`);

// ─── Drift (checklist 18) - nightly, after the gate ──────────────────────────
//
// The family gate above suspends one FAMILY that stops beating its null. Gate
// A/B (`store_gate_verdict`) judges the whole STORE, but only when somebody
// runs the publisher over a finished month - about four times a year - and a
// verdict then stands for 120 days. Between publishes a store can go quietly
// wrong while every family is individually still "not enough outcomes". This
// watches the store as a whole: below its volume-matched null in EVERY week of
// the trailing month, with enough outcomes, and it is suspended automatically.
//
// AFTER the 06:00 gate, for the same reason the gate runs after the 05:00
// evaluation: it reads the outcomes the evaluation scored, and the night's
// family verdicts should land before the store-level one so a morning reader
// sees them in cause-then-effect order.
//
// IT NEVER PROMOTES. A store whose drift clears is not re-opened here -
// opening a store is Gate A/B's job on measured accuracy and money, and a
// monitor that could both close and open would be a second gate with a weaker
// bar. `scripts/run-drift.js` writes nothing at all unless drift is proven.
//
// FAILING IS SAFE: a night this does not run leaves every store's verdict as
// the last publish or the last proven drift left it.
const DRIFT_CRON_SCHEDULE = process.env.DRIFT_CRON_SCHEDULE || '30 6 * * *';
let driftInFlight = false;

async function runDailyDrift() {
  if (driftInFlight) {
    logger.warn('[Drift cron] Previous run still in flight - skipping this tick.');
    return;
  }
  driftInFlight = true;
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(__dirname, 'scripts', 'run-drift.js')],
      { maxBuffer: 16 * 1024 * 1024 }
    );
    const lines = stdout.trim().split(String.fromCharCode(10))
      .map((l) => l.trim()).filter(Boolean);
    logger.info(`[Drift cron] ${lines.length ? lines[lines.length - 1] : ''}`);

    // A store that was LIVE and is now suspended is the line a human should
    // read: it is a signal about that store, not about the engine.
    for (const line of lines.filter((l) => l.startsWith('TRANSITION '))) {
      const [, store, from, , to, ...reason] = line.split(' ');
      logger.warn('[Drift cron] store changed state', {
        store, from, to, reason: reason.join(' '),
      });
    }
  } catch (err) {
    logger.error('[Drift cron] run failed', { error: err.message });
  } finally {
    driftInFlight = false;
  }
}

cron.schedule(DRIFT_CRON_SCHEDULE, runDailyDrift);
logger.info(`[Drift cron] Scheduled nightly store drift monitor at "${DRIFT_CRON_SCHEDULE}" (after the gate; suspends only, never promotes)`);
logger.info(`[Rec cron] Scheduled daily recommendation generation at "${REC_CRON_SCHEDULE}" (concurrency ${REC_CRON_CONCURRENCY})`);

// ─── Store-intelligence (StoreAgent) cache warming - nightly ─────────────────
// The Store-Intelligence tabs read storeagent_capability_results; a cold row is
// computed upstream on first view (slow). This cron re-computes every scoped
// store's capabilities so the tab always reads a warm row. Same scope/
// concurrency shape as the rec cron. The in-flight guard below means a batch
// that outlives the interval simply causes the next tick to be skipped - ticks
// never stack. Scope defaults to the rec scope (REC_CRON_LOCATIONS); override
// with STOREINTEL_CRON_LOCATIONS (pairs "c:l,c:l" or ALL).
//
// Nightly, not the former */15. Every capability anchors its windows to
// `as_of = max(sale_date)::date` and measures over 30/90/180/365 days, so the
// analysis cannot change until the calendar day turns - a 15-minute cadence
// recomputed the same date ranges ~96×/day. The serving layer already assumes
// this: it treats a cached row as fresh for STOREAGENT_CACHE_MAX_AGE_HOURS
// (24h). Runs at 03:30, before the 04:00 rec cron, so the day's intelligence is
// ready ahead of the downstream jobs and opening hours. Logging in also
// triggers an on-demand refresh (storeIntelligenceService.refreshStoreOnLogin),
// which covers "someone showed up and wants current numbers".
const STOREINTEL_CRON_SCHEDULE = process.env.STOREINTEL_CRON_SCHEDULE || '30 3 * * *'; // 03:30 daily
const STOREINTEL_CRON_CONCURRENCY = parseInt(process.env.STOREINTEL_CRON_CONCURRENCY || '3', 10);
const STOREINTEL_CRON_LOCATIONS = process.env.STOREINTEL_CRON_LOCATIONS || REC_CRON_LOCATIONS;

let storeIntelInFlight = false;

async function runDailyStoreIntelligenceBatch() {
  if (storeIntelInFlight) {
    logger.warn('[StoreIntel cron] Previous batch still running - skipping this tick.');
    return;
  }
  storeIntelInFlight = true;
  const startedAt = Date.now();
  let okStores = 0, failedStores = 0;
  try {
    const syncgoPool = getPool();
    const analyticsPool = getAnalyticsPool();
    const locations = STOREINTEL_CRON_LOCATIONS.trim().toUpperCase() === 'ALL'
      ? await recommendationService.listAllLocations(syncgoPool)
      : parseScopedLocations(STOREINTEL_CRON_LOCATIONS);
    logger.info(`[StoreIntel cron] Warming capabilities for ${locations.length} store(s) (scope: ${STOREINTEL_CRON_LOCATIONS}, caps: ${storeIntelligenceService.capabilitiesFromEnv().join(',')})`);

    let cursor = 0;
    const worker = async () => {
      while (cursor < locations.length) {
        const { clientId, locationId } = locations[cursor++];
        try {
          const { ok, failed } = await storeIntelligenceService.refreshStore(analyticsPool, clientId, locationId);
          if (failed > 0 && ok === 0) failedStores++; else okStores++;
        } catch (err) {
          failedStores++;
          logger.error('[StoreIntel cron] Store failed', { clientId, locationId, error: err.message });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(STOREINTEL_CRON_CONCURRENCY, locations.length) }, worker)
    );
    logger.info(`[StoreIntel cron] Done - ${okStores} ok, ${failedStores} failed in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (err) {
    logger.error('[StoreIntel cron] Batch aborted', { error: err.message });
  } finally {
    storeIntelInFlight = false;
  }
}

cron.schedule(STOREINTEL_CRON_SCHEDULE, runDailyStoreIntelligenceBatch);
logger.info(`[StoreIntel cron] Scheduled store-intelligence warming on "${STOREINTEL_CRON_SCHEDULE}" (concurrency ${STOREINTEL_CRON_CONCURRENCY})`);

// ─── Daily recommendation-effectiveness evaluation ───────────────────────────
// Measures every persisted rec against what actually happened (sales, restocks,
// price changes) over the REC_EVAL_WINDOWS horizons, writing one row per
// (rec, window) to the analytics DB. Runs after the 04:00 generation batch so
// each new run's baselines exist before its first evaluation. Iterates every
// tenant that has recs; per-tenant failures are logged and skipped. A window is
// only scored once the tenant's sales frontier has passed it, so a lagging POS
// sync defers evaluation instead of corrupting it.
const REC_EVAL_CRON_SCHEDULE = process.env.REC_EVAL_CRON_SCHEDULE || '0 5 * * *'; // 05:00 daily

let recEvalInFlight = false;
async function runDailyRecommendationEvaluation() {
  if (recEvalInFlight) {
    logger.warn('[RecEval cron] Previous evaluation still running - skipping this tick.');
    return;
  }
  recEvalInFlight = true;
  const startedAt = Date.now();
  try {
    const { tenants, evaluated } = await recommendationEvalService.evaluateAllTenants(getAnalyticsPool());
    logger.info(`[RecEval cron] Done - ${evaluated} evaluation(s) across ${tenants} tenant(s) in ${Math.round((Date.now() - startedAt) / 1000)}s`);

    // SHOWN VERSUS WITHHELD, every night, right where the outcomes were just
    // written. The holdout has been assigned since it went in - 63 of 372 live
    // recommendations - and reported nowhere, so the one measurement that
    // distinguishes "the engine picks things that sell" from "recommending
    // changes what sells" was being collected and discarded.
    //
    // Printed even when it cannot yet be stated, because the refusal carries
    // the count: that is how anyone notices the withheld arm is starved. At the
    // time of writing it reads 61 shown against 3 withheld at 30 days, which is
    // a fact about the experiment and not about the engine.
    try {
      for (const windowDays of [30, 90]) {
        const report = await recommendationEvalService.holdoutReport(
          getAnalyticsPool(), { windowDays });
        logger.info(`[RecEval cron] ${recommendationEvalService.holdoutLine(report)}`);
        // Per family, because an estate-wide average hides the case that
        // matters: one family carrying the whole effect while another is
        // negative. Only families with something measured in both arms are
        // worth a line of their own.
        for (const f of report.by_family) {
          if (!f.difference.refused_reason) {
            logger.info(`[RecEval cron]   ${f.family}: shown ${f.shown.avg_lift} `
              + `vs withheld ${f.withheld.avg_lift} over ${f.shown.measurable}/`
              + `${f.withheld.measurable} product-windows`);
          }
        }
      }
    } catch (err) {
      // Reporting must never cost an evaluation that already succeeded.
      logger.warn('[RecEval cron] holdout report failed', { error: err.message });
    }
  } catch (err) {
    logger.error('[RecEval cron] Batch aborted', { error: err.message });
  } finally {
    recEvalInFlight = false;
  }
}

// ─── Sheet 08: refit and publish the confidence curve ───────────────────────
//
// THIS WAS NEVER SCHEDULED, AND THE SYMPTOM REACHED AN OWNER'S CARD.
//
// `scripts/publish_calibration.py` fits the isotonic curve on accumulated
// outcomes and PUTs it where the recommender reads it. Nothing ran it but a
// person, once. So the live bundle was fitted on 56 pooled outcomes and stayed
// there: pool-adjacent-violators merges 56 noisy points into a single block, and
// a one-block monotone map is a CONSTANT. Bethany's nine reorder cards spanned
// raw scores 0.064 to 0.483 and every one displayed 0.444.
//
// The curve was not broken - it was starved. A fit needs outcomes and outcomes
// accumulate daily, so the fit has to run daily too.
//
// AFTER THE EVALUATION AND AFTER THE GATE, because it reads the same scored
// outcomes and there is no reason to contend with either. 07:00.
//
// FAILING IS SAFE. No new bundle means the recommender keeps applying the one it
// has, which is what it did for months; a card then states the older figure with
// its own basis attached rather than no figure at all.
const CALIB_CRON_SCHEDULE = process.env.CALIB_CRON_SCHEDULE || '0 7 * * *';
const CALIB_WINDOW_DAYS = parseInt(process.env.CALIB_WINDOW_DAYS || '30', 10);

let calibInFlight = false;

async function runDailyCalibrationRefit() {
  if (calibInFlight) {
    logger.warn('[Calib cron] Previous refit still in flight - skipping this tick.');
    return;
  }
  calibInFlight = true;
  const startedAt = Date.now();
  try {
    // Which stores. Scoped the same way the recommendation batch is scoped, so a
    // deployment that pilots four stores does not quietly refit ninety - and
    // `listAllLocations` reads `client_locations`, which lives in SYNCGO, not in
    // analytics.
    const locations = REC_CRON_LOCATIONS.trim().toUpperCase() === 'ALL'
      ? await recommendationService.listAllLocations(getPool())
      : parseScopedLocations(REC_CRON_LOCATIONS);
    const stores = locations
      .map((l) => `${l.clientId}:${l.locationId}`)
      .join(',');
    if (!stores) {
      logger.info('[Calib cron] No stores with recommendations yet - nothing to fit.');
      return;
    }

    // Its own process, like the gate: the fit is Python, and a pool-adjacent
    // violators pass over every store must not sit on the API's event loop.
    // --pooled, OR THIS JOB PUBLISHES NOTHING, EVER.
    //
    // A cell needs 50 scored outcomes. The estate has 55 and 35 of them sit at
    // one store, so NO store clears the floor on its own - the per-store path
    // prints "not enough to fit" for all seven and returns. The pool clears it
    // comfortably, which is why the only bundle in the table was published by
    // a manual --pooled run and has not moved since.
    //
    // This cron was added to keep that curve fresh as outcomes accumulate, and
    // without the flag it could not have: it would have run nightly, fitted
    // nothing and logged a success. The inheritance is not hidden - the bundle
    // is labelled `global(inherited)` and each card says which rung it got.
    const args = ['--stores', stores, '--pooled',
      '--node', process.env.SELF_BASE_URL || 'http://localhost:3000',
      '--window', String(CALIB_WINDOW_DAYS)];
    if (process.env.INTEGRATION_TOKEN) args.push('--token', process.env.INTEGRATION_TOKEN);

    const { stdout } = await pythonRunner.runScript('publish_calibration.py', args);
    const lines = stdout.trim().split(String.fromCharCode(10))
      .map((l) => l.trim()).filter(Boolean);
    logger.info(`[Calib cron] ${lines.length ? lines[lines.length - 1] : 'no output'} `
      + `in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (err) {
    // Non-fatal by design. The recommender keeps the bundle it already has.
    logger.error('[Calib cron] refit failed', { error: err.message });
  } finally {
    calibInFlight = false;
  }
}

// ─── N4.1: refit and publish the SIGNAL EFFECTS ─────────────────────────────
//
// WEEKLY, not daily, and that is the honest cadence. A signal effect is fitted
// over years of history against day-of-week / month / trend controls; one more
// day of data cannot move it, and refitting nightly would burn an hour of CPU to
// republish the same five betas. The calibration curve is different - it consumes
// outcomes that arrive daily - which is why that one runs every night.
//
// Sunday 08:00, after the week's generation and evaluation have settled.
//
// FAILING IS SAFE. No new fit leaves the previous one in place; an empty table
// leaves `cold_box` and `pre_stock` silent, which is exactly what they did for
// months and is the correct behaviour rather than a degraded one.
//
// AND IT CHECKS ITSELF. The script fits the `friday` key as a placebo and exits
// non-zero if that key earns a citable effect, because a Friday has no business
// carrying a demand effect once day-of-week is controlled for. A non-zero exit
// here means the controls are not working and the numbers cannot be trusted.
const SIGNAL_FIT_SCHEDULE = process.env.SIGNAL_FIT_SCHEDULE || '0 8 * * 0';
let signalFitInFlight = false;

async function runWeeklySignalFit() {
  if (signalFitInFlight) {
    logger.warn('[SignalFit cron] Previous fit still in flight - skipping.');
    return;
  }
  signalFitInFlight = true;
  const startedAt = Date.now();
  try {
    const locations = REC_CRON_LOCATIONS.trim().toUpperCase() === 'ALL'
      ? await recommendationService.listAllLocations(getPool())
      : parseScopedLocations(REC_CRON_LOCATIONS);
    const stores = locations.map((l) => l.locationId).join(',');
    if (!stores) {
      logger.info('[SignalFit cron] No stores in scope - nothing to fit.');
      return;
    }
    const path = require('path');
    const dataDir = process.env.SIGNAL_FIT_DATA
      || path.join(__dirname, '..', 'audit', 'data');

    // EXPORT FIRST, because nothing else does.
    //
    // The fit is a function of a CSV export: Python holds no analytics
    // credentials, so daily units per family reach it through `--data` rather
    // than a connection, which is what makes a published beta replayable
    // months later. But this job only ever CONSUMED that directory. On a
    // container there is no volume behind it and no other job writes it, so
    // the fit ran every Sunday against an empty folder and published nothing -
    // which is indistinguishable, from the outside, from "we looked and the
    // data cannot tell". `signal_effects` was empty on QA for exactly this
    // reason, and that is why no card could ever show a signal's impact.
    //
    // Exporting the SAME stores immediately before fitting them also closes a
    // subtler gap: a stale export would have the fit attribute this week's
    // signals to last month's sales.
    try {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const exporter = path.join(__dirname, 'scripts', 'export-store-sales.js');
      const { stdout: exported } = await execFileAsync(
        process.execPath, [exporter, '--locations', stores, '--out', dataDir],
        { maxBuffer: 32 * 1024 * 1024 }
      );
      const tail = exported.trim().split(String.fromCharCode(10)).filter(Boolean);
      logger.info(`[SignalFit cron] export: ${tail.length ? tail[tail.length - 1] : 'no output'}`);
    } catch (err) {
      // A failed export leaves whatever exports already exist, and the fit
      // below will refuse the stores it cannot read. Not fatal on its own.
      logger.warn('[SignalFit cron] export failed; fitting whatever exports exist',
        { error: err.message });
    }

    const args = ['--stores', stores, '--data', dataDir,
      '--node', process.env.SELF_BASE_URL || 'http://localhost:3000'];
    if (process.env.INTEGRATION_TOKEN) args.push('--token', process.env.INTEGRATION_TOKEN);

    const { stdout } = await pythonRunner.runScript('publish_signal_effects.py', args,
      { maxBuffer: 32 * 1024 * 1024 });
    const lines = stdout.trim().split(String.fromCharCode(10))
      .map((l) => l.trim()).filter(Boolean);
    logger.info(`[SignalFit cron] ${lines.length ? lines[lines.length - 1] : 'no output'} `
      + `in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (err) {
    // A non-zero exit is how the script reports a FAILED PLACEBO, so this is not
    // only a plumbing error - it may be the controls telling us the fit is junk.
    logger.error('[SignalFit cron] fit failed or placebo earned an effect; '
      + 'the previous published effects stand', { error: err.message });
  } finally {
    signalFitInFlight = false;
  }
}

cron.schedule(SIGNAL_FIT_SCHEDULE, runWeeklySignalFit);
logger.info(`[SignalFit cron] Scheduled weekly signal-effect fit at "${SIGNAL_FIT_SCHEDULE}"`);

cron.schedule(CALIB_CRON_SCHEDULE, runDailyCalibrationRefit);
logger.info(`[Calib cron] Scheduled daily calibration refit at "${CALIB_CRON_SCHEDULE}" `
  + `(window: ${CALIB_WINDOW_DAYS}d)`);

cron.schedule(REC_EVAL_CRON_SCHEDULE, runDailyRecommendationEvaluation);
logger.info(`[RecEval cron] Scheduled recommendation evaluation at "${REC_EVAL_CRON_SCHEDULE}" (windows: ${recommendationEvalService.EVAL_WINDOWS.join('/')}d)`);

// ─── Can the Python-backed jobs actually run? Say so NOW, not at 06:00 ───────
//
// Three of the scheduled jobs shell out to Python. Each one catches its own
// failure and logs a line, which is right - a failed gate must not take the API
// down - but it also means a box where Python is simply absent reports nothing
// at boot and one caught error a night thereafter. That is how an estate goes a
// month without gating and nobody notices.
//
// So this states the answer at startup, when somebody is reading the log.
(function preflightPythonJobs() {
  let interpreter;
  try {
    interpreter = pythonRunner.resolvePython();
  } catch (err) {
    logger.error('[Python jobs] NO INTERPRETER - the nightly gate, the daily '
      + 'calibration refit and the weekly signal-effect fit cannot run. Every '
      + 'confidence figure will stay at the bundle already published and no '
      + 'family will ever leave shadow.', { error: err.message });
    return;
  }

  const missing = [
    'gate_eval.py', 'publish_calibration.py', 'publish_signal_effects.py',
    // Checklist 13 and 18: the nightly quality gates and the drift monitor.
    'quality_eval.py', 'drift_eval.py',
  ].filter((s) => !pythonRunner.available(s));
  if (missing.length) {
    logger.error('[Python jobs] interpreter found but scripts are missing - '
      + 'those jobs cannot run. The image must ship them; PYTHON_SCRIPTS_DIR '
      + 'relocates the folder.', {
      interpreter, scriptsDir: pythonRunner.scriptsDir(), missing,
    });
    return;
  }

  // The signal fit is the one job with an input that is not code: the gzipped
  // sales exports it fits against. Checked separately because its absence is a
  // deployment gap rather than a broken install, and it only bites on Sunday.
  const signalData = process.env.SIGNAL_FIT_DATA
    || path.join(__dirname, '..', 'audit', 'data');
  if (!fs.existsSync(signalData)) {
    logger.warn('[Python jobs] gate and calibration are ready; the weekly '
      + 'signal-effect fit has no sales export directory, so it will fail on '
      + 'Sunday and the effects already published will stand. Set '
      + 'SIGNAL_FIT_DATA.', { interpreter, expected: signalData });
    return;
  }

  logger.info(`[Python jobs] ready - gate, calibration and signal fit will run `
    + `(${interpreter})`);
}());

// ─── Forward test, daily (16-30 Oct 2026 and onward) ─────────────────────────
// Scores the cards the engine really issued against the sales that really
// followed, assuming every card was accepted in full, and keeps a daily
// inventory snapshot of every SKU under test so a stockout is observed rather
// than inferred. scripts/forward-test-daily.js does the work and writes
// audit/forward/daily/<date>/ plus the index; the 30 Oct run adds --final.
//
// 04:15 IST, AFTER the 04:00 generation, and the timezone is stated rather
// than inherited: this test was asked for at four in the morning Indian time,
// and a box in UTC would otherwise run it at half past nine. The job also
// generates the day's cards itself for any store the batch missed, so a
// machine that was asleep at 04:00 still captures the day - the first three
// nights of this test were lost to exactly that.
const FORWARD_TEST_CRON_SCHEDULE = process.env.FORWARD_TEST_CRON_SCHEDULE || '15 4 * * *';
const FORWARD_TEST_FINAL_DATE = process.env.FORWARD_TEST_FINAL_DATE || '2026-10-30';
let forwardTestInFlight = false;
async function runDailyForwardTest() {
  if (forwardTestInFlight) {
    logger.warn('[ForwardTest cron] Previous run still running - skipping this tick.');
    return;
  }
  forwardTestInFlight = true;
  const startedAt = Date.now();
  try {
    const { execFile } = require('child_process');
    const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const args = [path.join(__dirname, 'scripts', 'forward-test-daily.js'),
      '--out', path.join(__dirname, '..', 'audit', 'forward')];
    if (todayIst === FORWARD_TEST_FINAL_DATE) args.push('--final');
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      execFile(process.execPath, args, { cwd: __dirname, maxBuffer: 32 * 1024 * 1024 },
        (err, out, errOut) => (err ? reject(Object.assign(err, { stdout: out, stderr: errOut }))
          : resolve({ stdout: out, stderr: errOut })));
    });
    const lines = String(stdout).trim().split('\n');
    logger.info(`[ForwardTest cron] Done in ${Math.round((Date.now() - startedAt) / 1000)}s - ${lines.slice(-3).join(' | ')}`);
    if (stderr && stderr.trim()) logger.warn('[ForwardTest cron] stderr', { stderr: String(stderr).slice(0, 2000) });
  } catch (err) {
    logger.error('[ForwardTest cron] Failed', { error: err.message, stderr: String(err.stderr || '').slice(0, 2000) });
  } finally {
    forwardTestInFlight = false;
  }
}
cron.schedule(FORWARD_TEST_CRON_SCHEDULE, runDailyForwardTest, { timezone: 'Asia/Kolkata' });
logger.info(`[ForwardTest cron] Scheduled daily forward test at "${FORWARD_TEST_CRON_SCHEDULE}" Asia/Kolkata (final report on ${FORWARD_TEST_FINAL_DATE})`);

// ─── Weekly recommendation digest ────────────────────────────────────────────
// Monday mornings, after the daily evaluation pass: build each store's
// last-week digest (archived in the analytics DB, shown in-app) and email it
// through the store's connected Gmail when one exists. Failures are per-tenant
// and non-fatal; regenerating a week upserts.
const REC_DIGEST_CRON_SCHEDULE = process.env.REC_DIGEST_CRON_SCHEDULE || '30 5 * * 1'; // Mon 05:30

let digestInFlight = false;
async function runWeeklyDigest() {
  if (digestInFlight) return;
  digestInFlight = true;
  try {
    const { generated, emailed } = await recommendationDigestService.generateAndSendAll(getAnalyticsPool());
    logger.info(`[Digest cron] Done - ${generated} digest(s) generated, ${emailed} emailed`);
  } catch (err) {
    logger.error('[Digest cron] Batch aborted', { error: err.message });
  } finally {
    digestInFlight = false;
  }
}

cron.schedule(REC_DIGEST_CRON_SCHEDULE, runWeeklyDigest);
logger.info(`[Digest cron] Scheduled weekly recommendation digest at "${REC_DIGEST_CRON_SCHEDULE}"`);

// ─── The pilot scoreboards - monthly, five stores, two boards ───────────────
//
// The checklist's test paragraph: "Five GOOD stores only. Two scoreboards kept
// separate: prediction accuracy (needs no owner action) and holdout money
// (shown vs withheld, action inferred from stock jumps and invoices). Report
// monthly per store, one line per product."
//
// First of the month at 07:30, for the month that just closed: after the
// 05:00 evaluation has scored the last windows that ended on the 30th/31st
// and after the 06:00 gate and 06:30 drift have read them. The same margin
// the gate takes after the evaluation, and for the same reason - a schedule
// is not a dependency, so the board must run after the writers it reads.
//
// Not ALL: scripts/pilot-scoreboard.js holds the five store ids in one place
// and refuses ALL with the reason. PILOT_SCOREBOARD_LOCATIONS overrides the
// list for a deployment whose pilot is different.
//
// Failing is safe: a month that does not get built on the first can be built
// by hand with the script, and the row upserts. One summary line per store -
// hit rate with its interval, and the holdout difference or its refusal - so
// the log says what the board says without opening it.
const PILOT_SCOREBOARD_CRON_SCHEDULE = process.env.PILOT_SCOREBOARD_CRON_SCHEDULE || '30 7 1 * *'; // 1st, 07:30

let scoreboardInFlight = false;
async function runMonthlyPilotScoreboards() {
  if (scoreboardInFlight) {
    logger.warn('[Scoreboard cron] Previous run still in flight - skipping this tick.');
    return;
  }
  scoreboardInFlight = true;
  try {
    const { runScoreboards } = require('./scripts/pilot-scoreboard');
    const results = await runScoreboards(getAnalyticsPool(), {
      log: (line) => logger.info(`[Scoreboard cron] ${line}`),
    });
    const failed = results.filter((r) => !r.ok);
    logger.info(`[Scoreboard cron] Done - ${results.length - failed.length} of ${results.length} store(s) written`);
    for (const f of failed) {
      logger.error('[Scoreboard cron] store failed', { store: `${f.clientId}:${f.locationId}`, error: f.error });
    }
  } catch (err) {
    logger.error('[Scoreboard cron] run failed', { error: err.message });
  } finally {
    scoreboardInFlight = false;
  }
}

cron.schedule(PILOT_SCOREBOARD_CRON_SCHEDULE, runMonthlyPilotScoreboards);
logger.info(`[Scoreboard cron] Scheduled monthly pilot scoreboards at "${PILOT_SCOREBOARD_CRON_SCHEDULE}"`);

// ─── Instagram hashtag trend polling ─────────────────────────────────────────
// Snapshots the drink-hashtag vocabulary's post velocity into the analytics DB
// (instagramTrendsService; migration 005). Runs at 02:30, BEFORE the 04:00 rec
// generation, so the Python service's social-trends pull sees today's data.
// The Monday 02:00 refresh re-exchanges the long-lived Meta token (60-day
// expiry) - weekly cadence means a missed tick still leaves ~7 weeks of
// runway, and a FAILED refresh is logged loudly (needs manual re-auth).
const IG_TRENDS_CRON_SCHEDULE = process.env.IG_TRENDS_CRON_SCHEDULE || '30 2 * * *'; // 02:30 daily
const IG_TOKEN_CRON_SCHEDULE = process.env.IG_TOKEN_CRON_SCHEDULE || '0 2 * * 1';   // Mon 02:00
// Staleness watchdog: daily, before the poll. No-op while weekly refreshes
// succeed; once the last success is >15 days old it retries on an escalating
// backoff (day 15, +1, +2, +3…) and alarms daily as the 60-day expiry nears.
const IG_TOKEN_WATCHDOG_SCHEDULE = process.env.IG_TOKEN_WATCHDOG_SCHEDULE || '10 2 * * *'; // 02:10 daily

if (instagramTrendsService.isConfigured()) {
  let igPollInFlight = false;
  cron.schedule(IG_TRENDS_CRON_SCHEDULE, async () => {
    if (igPollInFlight) {
      logger.warn('[IG trends cron] Previous poll still running - skipping this tick.');
      return;
    }
    igPollInFlight = true;
    try {
      await instagramTrendsService.pollAllHashtags(getAnalyticsPool());
    } catch (err) {
      logger.error('[IG trends cron] Poll aborted', { error: err.message });
    } finally {
      igPollInFlight = false;
    }
  });
  cron.schedule(IG_TOKEN_CRON_SCHEDULE, () =>
    instagramTrendsService.refreshToken(getAnalyticsPool())
      .catch((err) => logger.error('[IG trends cron] Token refresh threw', { error: err.message }))
  );
  cron.schedule(IG_TOKEN_WATCHDOG_SCHEDULE, () =>
    instagramTrendsService.checkAndRetryRefresh(getAnalyticsPool())
      .catch((err) => logger.error('[IG trends cron] Token watchdog threw', { error: err.message }))
  );
  logger.info(`[IG trends cron] Scheduled hashtag polling at "${IG_TRENDS_CRON_SCHEDULE}" (${instagramTrendsService.getVocabulary().length} core tags + dynamic slice), token refresh at "${IG_TOKEN_CRON_SCHEDULE}", watchdog at "${IG_TOKEN_WATCHDOG_SCHEDULE}"`);
} else {
  logger.info('[IG trends cron] Disabled - IG_USER_ID / IG_ACCESS_TOKEN / META_APP_* not set.');
}

app.listen(PORT, () => {
  logger.info(`Botella API running on http://localhost:${PORT}`);
});
