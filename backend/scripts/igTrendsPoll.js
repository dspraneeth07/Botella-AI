/**
 * Manual runner for the Instagram trends pipeline.
 *
 * In production everything is cron-driven (02:30 poll, 02:10 watchdog, Monday
 * 02:00 refresh - see server.js), so a dev terminal never shows these logs
 * unless you run them by hand. That's what this script is for.
 *
 * Usage (run from backend/; add ANALYTICS_PG_HOST=localhost when running on
 * the host while .env points at host.docker.internal):
 *
 *   npm run ig:trends                  poll the vocabulary NOW, then print the series
 *   npm run ig:trends -- --series      print the stored series only (no Meta calls)
 *   npm run ig:trends -- --refresh     token refresh now (what the Monday cron does)
 *   npm run ig:trends -- --seed-demo   DEV ONLY: backdate a synthetic low-velocity
 *                                      baseline for every term snapshotted so far, so
 *                                      acceleration computes TODAY (rows are tagged
 *                                      hashtag_id='demo-baseline'). Then generate a
 *                                      run in the UI and open the Trending tab.
 *   npm run ig:trends -- --clean-demo  remove every synthetic demo row
 *   npm run ig:trends -- --vocab       show the merged poll vocabulary (core +
 *                                      dynamic slice) and the weekly unique-tag
 *                                      budget state, without touching Meta
 *
 * Vocabulary override for a quick poll (mind Meta's 30-unique-hashtags/7-day
 * cap - stick to terms from the default vocabulary):
 *   IG_TREND_HASHTAGS=espressomartini,margarita npm run ig:trends
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getAnalyticsPool } = require('../database/analytics-connection');
const svc = require('../services/instagramTrendsService');

const DEMO_TAG = 'demo-baseline';

async function printSeries(pool) {
  const series = await svc.getTrendSeries(pool, 14);
  if (!series.length) {
    console.log('\n(series is empty - run a poll first)');
    return;
  }
  console.log('\n─── Trend series (14d window) ─────────────────────────────');
  for (const r of series) {
    console.log(
      `  ${r.display_term.padEnd(18)} pph=${String(r.posts_per_hour ?? '-').padEnd(7)}` +
      ` baseline=${String(r.baseline_posts_per_hour?.toFixed?.(2) ?? '-').padEnd(7)}` +
      ` accel=${String(r.acceleration ?? '- (needs a prior-day snapshot)')}` +
      ` engagement=${r.engagement ?? '-'}`
    );
  }
  const rising = series.filter((r) => r.acceleration >= 1.5);
  console.log(rising.length
    ? `\n${rising.length} term(s) clear the 1.5x bar - these reach the Python service as rising signals.`
    : '\nNo term clears the 1.5x acceleration bar yet.');
}

async function seedDemo(pool) {
  // One synthetic pair per term that has a real snapshot: ~45% and ~55% of its
  // latest velocity, 3 and 2 days back → acceleration lands near 2x (> 1.5).
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (term) term, posts_per_hour::float AS pph
    FROM ig_hashtag_snapshots
    WHERE hashtag_id <> $1
    ORDER BY term, captured_at DESC`, [DEMO_TAG]);
  let seeded = 0;
  for (const { term, pph } of rows) {
    if (!pph) continue; // latest sample too thin to rate - no point
    await pool.query(
      `INSERT INTO ig_hashtag_snapshots
         (term, captured_at, hashtag_id, posts_per_hour, sample_count, top_like_sum, top_comment_sum, top_sample_count)
       VALUES ($1, now() - interval '3 days', $2, $3, 30, 0, 0, 0),
              ($1, now() - interval '2 days', $2, $4, 30, 0, 0, 0)`,
      [term, DEMO_TAG, (pph * 0.45).toFixed(3), (pph * 0.55).toFixed(3)]
    );
    seeded++;
  }
  console.log(`Seeded a synthetic baseline for ${seeded} term(s) (tagged '${DEMO_TAG}').`);
  console.log('Remember: npm run ig:trends -- --clean-demo when you are done testing.');
}

async function cleanDemo(pool) {
  const del = await pool.query(
    'DELETE FROM ig_hashtag_snapshots WHERE hashtag_id = $1', [DEMO_TAG]
  );
  console.log(`Removed ${del.rowCount} synthetic demo row(s).`);
}

(async () => {
  const args = new Set(process.argv.slice(2));
  const pool = getAnalyticsPool();
  try {
    if (args.has('--refresh')) {
      const ok = await svc.refreshToken(pool);
      console.log('token refresh:', ok ? 'OK' : 'FAILED (see log above)');
    } else if (args.has('--seed-demo')) {
      await seedDemo(pool);
      await printSeries(pool);
    } else if (args.has('--clean-demo')) {
      await cleanDemo(pool);
      await printSeries(pool);
    } else if (args.has('--series')) {
      await printSeries(pool);
    } else if (args.has('--vocab')) {
      const core = svc.getVocabulary();
      const merged = await svc.buildPollVocabulary(pool);
      const dynamic = merged.filter((t) => !core.includes(t));
      const { rows } = await pool.query(
        `SELECT term, display_term, source,
                to_char(last_seen, 'MM-DD HH24:MI') AS seen
           FROM ig_dynamic_terms ORDER BY last_seen DESC LIMIT 15`
      ).catch(() => ({ rows: [] }));
      const { rows: spent } = await pool.query(
        `SELECT count(DISTINCT term)::int AS n FROM ig_hashtag_snapshots
          WHERE captured_at > now() - interval '7 days'`
      );
      console.log(`Core (${core.length}):    ${core.join(', ')}`);
      console.log(`Dynamic (${dynamic.length}): ${dynamic.join(', ') || '(none yet - runs a rec generation to populate)'}`);
      console.log(`Weekly unique-tag budget: ${spent[0].n} of 28 used (Meta cap 30/7d)`);
      if (rows.length) {
        console.log('\nObserved terms (freshest first):');
        for (const r of rows) console.log(`  ${r.term.padEnd(30)} "${r.display_term}"  via ${r.source}  last seen ${r.seen}`);
      }
    } else {
      const vocab = await svc.buildPollVocabulary(pool);
      console.log(`Polling ${vocab.length} hashtag(s) (core + dynamic) - roughly 30-40s per tag…`);
      await svc.pollAllHashtags(pool);
      await printSeries(pool);
    }
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
