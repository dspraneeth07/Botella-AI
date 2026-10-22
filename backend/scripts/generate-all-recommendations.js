#!/usr/bin/env node
/**
 * REGENERATE RECOMMENDATIONS FOR EVERY STORE, NOW.
 *
 *   node scripts/generate-all-recommendations.js                 # every store
 *   node scripts/generate-all-recommendations.js --stores 171,181
 *   node scripts/generate-all-recommendations.js --concurrency 3 --store-timeout 300
 *   node scripts/generate-all-recommendations.js --dry-run       # list only
 *
 * WHY A SCRIPT. The server's 04:00 batch (server.js runDailyRecommendationBatch)
 * is the only thing that fans out over the estate, and it has no manual
 * trigger. When the engine changes during the day - the hybrid slate of
 * 22 Oct 2026, engine stock cards plus model signal cards - every store's
 * "latest" run is still the one the old engine wrote at 04:00, and nobody can
 * see the change until tomorrow. This produces a fresh run per store with the
 * SAME function the batch and the /generate endpoint use (generateAndPersist),
 * behind the SAME quality gate (getStoreQuality + storeRefusals), so a store
 * that would be refused at 04:00 is refused here too and counted.
 *
 * "CLEAR THE CACHE" means this. There is no recommendation cache to clear:
 * the owner's screen reads the newest recommendation_runs row, so a new run
 * IS the fresh answer. The Python service's in-process signal cache (6 h) is
 * cleared by restarting that service, which a code change needs anyway.
 *
 * One store failing is logged and counted, never thrown. A store is given
 * --store-timeout seconds (default 300) because a run calls several signal
 * providers and two model calls; the whole pass is bounded by --budget
 * minutes (default 90) so a wedged provider cannot hold the console all day.
 * Exit code is non-zero only when the script itself cannot run.
 */
require('dotenv').config();

const { getPool, makeTenantScopedPool } = require('../database/connection');
const { getAnalyticsPool } = require('../database/analytics-connection');
const recommendationService = require('../services/recommendationService');
const recGate = require('../services/recommendationGateService');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const STORES = String(arg('stores', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Math.max(1, parseInt(arg('concurrency', '3'), 10) || 3);
const STORE_TIMEOUT_MS = (parseInt(arg('store-timeout', '300'), 10) || 300) * 1000;
const BUDGET_MS = (parseInt(arg('budget', '90'), 10) || 90) * 60 * 1000;
const DRY_RUN = arg('dry-run', false) === true;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function scoped(all) {
  if (!STORES.length) return all;
  const pairs = new Set();
  const clients = new Set();
  for (const part of STORES) {
    if (part.includes(':')) pairs.add(part);
    else clients.add(parseInt(part, 10));
  }
  return all.filter((l) => pairs.has(`${l.clientId}:${l.locationId}`) || clients.has(l.clientId));
}

async function main() {
  const syncgo = getPool();
  const analytics = getAnalyticsPool();
  const startedAt = Date.now();

  const locations = scoped(await recommendationService.listAllLocations(syncgo));
  console.log(`${locations.length} store(s) in scope` + (STORES.length ? ` (--stores ${STORES.join(',')})` : ''));
  if (DRY_RUN) {
    for (const l of locations) console.log(`  ${l.clientId}:${l.locationId}`);
    return;
  }

  const counts = { generated: 0, refused: 0, failed: 0, notReached: 0, cards: 0 };
  const byType = new Map();
  let cursor = 0;

  const worker = async () => {
    while (cursor < locations.length) {
      if (Date.now() - startedAt > BUDGET_MS) {
        counts.notReached += locations.length - cursor;
        cursor = locations.length;
        return;
      }
      const { clientId, locationId } = locations[cursor++];
      const tag = `${clientId}:${locationId}`;
      try {
        const quality = await recGate.getStoreQuality(analytics, clientId, locationId);
        const refusals = recGate.storeRefusals(quality);
        if (refusals.length) {
          counts.refused++;
          console.log(`  refused   ${tag} (${quality.verdict}) ${refusals.join(', ')}`);
          continue;
        }
        const summary = await withTimeout(
          recommendationService.generateAndPersist(analytics, clientId, locationId),
          STORE_TIMEOUT_MS, `store ${tag}`
        );
        counts.generated++;
        counts.cards += summary.recommendation_count || 0;
        // What kinds of cards the store will actually see, read back the way
        // the screen reads them, so the summary says "6 types" rather than
        // "10 cards" - the whole point of the hybrid slate is the mix.
        let mix = '';
        try {
          const latest = await recommendationService.getLatest(
            analytics, makeTenantScopedPool(syncgo, clientId, locationId), clientId, locationId
          );
          const types = {};
          for (const r of (latest && latest.recommendations) || []) {
            types[r.action_type] = (types[r.action_type] || 0) + 1;
            byType.set(r.action_type, (byType.get(r.action_type) || 0) + 1);
          }
          mix = Object.entries(types).map(([t, n]) => `${t}×${n}`).join(' ');
        } catch (e) {
          mix = `(mix unread: ${e.message})`;
        }
        console.log(`  generated ${tag} run ${summary.runId} ${summary.recommendation_count} card(s) ${mix}`);
      } catch (err) {
        counts.failed++;
        console.log(`  failed    ${tag} ${err.code || ''} ${err.message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, locations.length) }, worker));

  const secs = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n${counts.generated} generated, ${counts.refused} refused, ${counts.failed} failed, ` +
    `${counts.notReached} not reached in the budget (of ${locations.length}) in ${secs}s`);
  console.log(`${counts.cards} card(s) issued; shown by action type: ` +
    ([...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
