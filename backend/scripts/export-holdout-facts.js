/**
 * Export the holdout scoreboard's raw facts for the engine report.
 *
 * WHY A NODE SCRIPT AND NOT A PYTHON QUERY. Node is the sole writer of
 * `bottleai_analytics` and the only process holding its credentials; the Python
 * side is stateless and reads what it is handed. The report builder therefore
 * gets a JSON file rather than a connection string.
 *
 * WHAT THE SCOREBOARD NEEDS, and what it will almost certainly report. A
 * shown-versus-withheld comparison needs three things: cards in both arms,
 * OUTCOMES scored for both arms, and some evidence of what the owner actually
 * did. This writes all three counts whether or not they are zero, because a
 * scoreboard that cannot be computed has to say which of the three is missing -
 * "no data" is not an answer anybody can act on.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getAnalyticsPool } = require('../database/analytics-connection');

const STORES = [171, 176, 177, 178, 181];

(async () => {
  const pool = getAnalyticsPool();

  // Cards issued, by arm. `status='holdout'` is the withheld arm: computed,
  // stored and scored exactly like any other card, and never shown.
  const { rows: cards } = await pool.query(
    `SELECT location_id,
            COUNT(*)::int AS cards,
            COUNT(*) FILTER (WHERE status = 'holdout')::int AS withheld,
            COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'holdout')::int AS shown,
            COUNT(*) FILTER (WHERE vote IS NOT NULL)::int AS voted,
            COUNT(*) FILTER (WHERE action_claim IS NOT NULL)::int AS claimed,
            MIN(created_at)::date AS first_issued,
            MAX(created_at)::date AS last_issued
       FROM recommendations
      WHERE location_id = ANY($1::int[])
      GROUP BY 1 ORDER BY 1`, [STORES]);

  // Outcomes, by arm. The money question lives here: a lift and a purchased
  // quantity for each arm is what makes "shown earned more than withheld" a
  // sentence with a number in it.
  const { rows: outcomes } = await pool.query(
    `SELECT location_id, arm,
            COUNT(*)::int AS scored,
            COUNT(*) FILTER (WHERE lift IS NOT NULL)::int AS with_lift,
            ROUND(AVG(lift)::numeric, 4) AS avg_lift,
            COUNT(*) FILTER (WHERE actual_purchased_qty > 0)::int AS purchases_seen,
            COUNT(*) FILTER (WHERE purchased_qty_source IS NOT NULL)::int AS purchase_evidence,
            COUNT(*) FILTER (WHERE delivery_evidence IS NOT NULL)::int AS delivery_evidence,
            COUNT(*) FILTER (WHERE on_hand_at_issue IS NOT NULL)::int AS stock_at_issue
       FROM recommendation_outcomes
      WHERE location_id = ANY($1::int[])
      GROUP BY 1, 2 ORDER BY 1, 2`, [STORES]);

  const out = {
    generated: new Date().toISOString(),
    stores: STORES,
    cards,
    outcomes,
    // The three preconditions, answered plainly so the report can name the one
    // that is missing rather than printing an empty table.
    preconditions: {
      both_arms_have_cards: cards.some((c) => c.withheld > 0 && c.shown > 0),
      both_arms_have_scored_lift: STORES.some((loc) => {
        const s = outcomes.find((o) => o.location_id === loc && o.arm === 'shown');
        const w = outcomes.find((o) => o.location_id === loc && o.arm === 'withheld');
        return (s?.with_lift ?? 0) > 0 && (w?.with_lift ?? 0) > 0;
      }),
      any_owner_action_recorded:
        cards.some((c) => c.voted > 0 || c.claimed > 0)
        || outcomes.some((o) => o.purchases_seen > 0 || o.purchase_evidence > 0),
    },
  };

  const dest = path.join(__dirname, '..', '..', 'audit', 'holdout_facts.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 1), 'utf8');
  console.log(`wrote ${dest}`);
  console.log(`  preconditions: ${JSON.stringify(out.preconditions)}`);
  process.exit(0);
})().catch((err) => { console.error('ERR:', err.message); process.exit(1); });
