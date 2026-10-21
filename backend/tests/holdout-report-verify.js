#!/usr/bin/env node
/**
 * Shown versus withheld - the only measurement that separates a forecast from
 * a recommendation.
 *
 * The holdout arm has been ASSIGNED since it went in (63 of 372 live
 * recommendations, a realised 16.9%) and reported nowhere. So the engine could
 * show a 2.07x average lift on the cards it displayed and nobody could say
 * whether displaying them caused any of it.
 *
 * The traps this guards, each of which produces a confident wrong number:
 *
 *   TOTALS INSTEAD OF PER-PRODUCT. The arms are deliberately unequal, so the
 *   shown arm always accumulates more dollars. On live data the totals read
 *   $15,515 shown against $1,632 withheld - a 9.5x "win" that is entirely a
 *   12.2x difference in how many products each arm held. Per product the
 *   withheld arm was AHEAD.
 *
 *   ONE PRODUCT COUNTED TWICE. Two cards in one window can name the same SKU,
 *   which would weight that product twice in a per-product average.
 *
 *   A NULL MARGIN READ AS ZERO. Cost is unknown for some products; "we do not
 *   know what this earned" is not "this earned nothing".
 *
 *   A DIFFERENCE STATED ON TWO OUTCOMES. Below the floor the report must
 *   refuse, and say what it is waiting for - that refusal is the only way
 *   anyone notices the withheld arm is starved.
 *
 * Run:  node tests/holdout-report-verify.js
 */

require('dotenv').config();

const { getAnalyticsPool } = require('../database/analytics-connection');
const evalSvc = require('../services/recommendationEvalService');

const CID = 999921;
const LID = 990021;
const W = 30;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** window_start today-ish so the lookback window includes it. */
const START = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
const END = new Date(Date.parse(`${START}T00:00:00Z`) + W * 86400000)
  .toISOString().slice(0, 10);

async function clean(pool) {
  await pool.query('DELETE FROM recommendation_outcomes WHERE client_id = $1', [CID]);
  await pool.query('DELETE FROM recommendation_runs WHERE client_id = $1', [CID]);
}

(async () => {
  const pool = getAnalyticsPool();
  await clean(pool);

  // One run, and a recommendation per outcome we want a margin for -
  // margin_impact lives on recommendation_evaluations, whose rec_id has a real
  // foreign key, so the money half cannot be faked without them.
  const { rows: [run] } = await pool.query(
    `INSERT INTO recommendation_runs (client_id, location_id, generated_at)
     VALUES ($1, $2, now()) RETURNING id`, [CID, LID]
  );

  /**
   * @param {object} spec arm, family, sku, lift, margin (null = cost unknown)
   */
  async function outcome(spec, rank) {
    const { rows: [rec] } = await pool.query(
      `INSERT INTO recommendations
         (run_id, client_id, location_id, rank, category, action_type, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [run.id, CID, LID, rank, 'test', spec.family,
        spec.arm === 'withheld' ? 'holdout' : null]
    );
    await pool.query(
      `INSERT INTO recommendation_outcomes
         (recommendation_id, client_id, location_id, sku, family, arm,
          window_start, window_end, open_days_in_window, lift, lift_reason,
          actual_units_sold)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [rec.id, CID, LID, spec.sku, spec.family, spec.arm, START, END, 24,
        spec.lift, spec.lift === null ? 'no baseline' : null, 10]
    );
    if (spec.margin !== undefined) {
      await pool.query(
        `INSERT INTO recommendation_evaluations
           (rec_id, client_id, location_id, window_days, verdict, margin_impact)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [rec.id, CID, LID, W, 'neutral', spec.margin]
      );
    }
    return rec.id;
  }

  console.log('\n-- Per product, never totals ------------------------------');

  // Six shown products at $100 each; two withheld at $300 each. The totals say
  // shown earned $600 and withheld $600 - a dead heat. Per product the withheld
  // arm earns three times as much. Only one of those is an effect.
  let rank = 0;
  for (let i = 0; i < 6; i++) {
    await outcome({ arm: 'shown', family: 'reorder', sku: `S${i}`,
      lift: 1.0, margin: 100 }, ++rank);
  }
  for (let i = 0; i < 2; i++) {
    await outcome({ arm: 'withheld', family: 'reorder', sku: `W${i}`,
      lift: 1.0, margin: 300 }, ++rank);
  }

  let r = await evalSvc.holdoutReport(pool,
    { clientId: CID, locationId: LID, windowDays: W });
  check('1  the totals really are equal (so 2 tests something)',
    r.overall.shown.dollars === 600 && r.overall.withheld.dollars === 600,
    `${r.overall.shown.dollars} vs ${r.overall.withheld.dollars}`);
  check('2  per product tells them apart',
    r.overall.shown.dollars_per_product === 100
    && r.overall.withheld.dollars_per_product === 300,
    `${r.overall.shown.dollars_per_product} vs ${r.overall.withheld.dollars_per_product}`);

  console.log('\n-- A difference needs both arms to clear the floor --------');

  check('3  two withheld outcomes buy no claim at all',
    r.overall.difference.lift === null
    && /have 6 shown and 2 withheld/.test(r.overall.difference.refused_reason),
    JSON.stringify(r.overall.difference));
  check('4  and the refusal is a REASON, not a zero',
    r.overall.difference.dollars_per_product === null);

  // Three more withheld products and the floor is cleared.
  for (let i = 2; i < 5; i++) {
    await outcome({ arm: 'withheld', family: 'reorder', sku: `W${i}`,
      lift: 1.0, margin: 300 }, ++rank);
  }
  r = await evalSvc.holdoutReport(pool,
    { clientId: CID, locationId: LID, windowDays: W });
  check('5  five per arm and the comparison is stated',
    r.overall.difference.refused_reason === null
    && r.overall.difference.lift === 0,
    JSON.stringify(r.overall.difference));
  check('6  the money difference is the PER-PRODUCT one',
    r.overall.difference.dollars_per_product === -200,
    String(r.overall.difference.dollars_per_product));
  // The totals and the per-product figure disagree by a factor of 4.5 here:
  // 600 - 1500 = -900 against -200. On live data they disagree in SIGN - the
  // totals said shown was $13,883 ahead while per product it was $72 behind -
  // which is why the difference is never taken on a sum.
  const totalGap = r.overall.shown.dollars - r.overall.withheld.dollars;
  check('7  ...and the totals would have overstated it 4.5x',
    totalGap === -900 && r.overall.difference.dollars_per_product === -200,
    `totals gap ${totalGap}, per product ${r.overall.difference.dollars_per_product}`);

  console.log('\n-- One outcome per product per window --------------------');

  // The same SKU recommended twice in the same window. It is one product.
  // The second card carries the SAME lift and margin, because that is what
  // reality produces: lift is computed from the product's own sales over the
  // window, so two cards naming one SKU in one window are two opinions about a
  // single fact, not two facts. The bug being guarded is counting it twice.
  const before = r.overall.shown.products;
  const beforeDollars = r.overall.shown.dollars;
  await outcome({ arm: 'shown', family: 'reorder', sku: 'S0',
    lift: 1.0, margin: 100 }, ++rank);
  r = await evalSvc.holdoutReport(pool,
    { clientId: CID, locationId: LID, windowDays: W });
  check('8  a product named twice in one window counts once',
    r.overall.shown.products === before,
    `${before} -> ${r.overall.shown.products}`);
  check('9  the average is unchanged by the duplicate',
    r.overall.shown.avg_lift === 1,
    String(r.overall.shown.avg_lift));
  check('9b and its money is not counted twice',
    r.overall.shown.dollars === beforeDollars,
    `${beforeDollars} -> ${r.overall.shown.dollars}`);

  console.log('\n-- Unknown cost is not zero earnings ---------------------');

  await outcome({ arm: 'shown', family: 'promote', sku: 'P0', lift: 2.0 }, ++rank);
  r = await evalSvc.holdoutReport(pool,
    { clientId: CID, locationId: LID, windowDays: W });
  const promote = r.by_family.find((f) => f.family === 'promote');
  check('10 a product with no cost is counted, but not priced',
    promote.shown.products === 1 && promote.shown.priced === 0,
    `products ${promote.shown.products}, priced ${promote.shown.priced}`);
  check('11 its dollars are NULL, not 0',
    promote.shown.dollars === null && promote.shown.dollars_per_product === null,
    `${promote.shown.dollars} / ${promote.shown.dollars_per_product}`);
  check('12 but its lift still counts',
    promote.shown.measurable === 1 && promote.shown.avg_lift === 2,
    String(promote.shown.avg_lift));

  console.log('\n-- An unmeasurable lift is excluded, not scored 0 --------');

  await outcome({ arm: 'shown', family: 'endcap', sku: 'E0',
    lift: null, margin: 50 }, ++rank);
  r = await evalSvc.holdoutReport(pool,
    { clientId: CID, locationId: LID, windowDays: W });
  const endcap = r.by_family.find((f) => f.family === 'endcap');
  check('13 a refused lift is not averaged in as zero',
    endcap.shown.products === 1 && endcap.shown.measurable === 0
    && endcap.shown.avg_lift === null,
    `measurable ${endcap.shown.measurable}, avg ${endcap.shown.avg_lift}`);
  check('14 while its money still counts, because it is known',
    endcap.shown.priced === 1 && endcap.shown.dollars === 50,
    `priced ${endcap.shown.priced}, $${endcap.shown.dollars}`);

  console.log('\n-- Per family, because an average hides the case ----------');

  check('15 families are reported separately',
    r.by_family.length === 3
    && r.by_family.every((f) => ['reorder', 'promote', 'endcap'].includes(f.family)),
    r.by_family.map((f) => f.family).join(', '));
  check('16 the family with both arms is the one that gets a verdict',
    r.by_family.find((f) => f.family === 'reorder').difference.refused_reason === null
    && r.by_family.find((f) => f.family === 'promote').difference.refused_reason !== null);

  console.log('\n-- The line a human reads --------------------------------');

  const line = evalSvc.holdoutLine(r);
  check('17 it names both arms, the per-product money and the counts',
    /shown [\d.]+ lift/.test(line) && /withheld [\d.]+ /.test(line)
    && /per product/.test(line) && /product-windows/.test(line), line);
  const starved = evalSvc.holdoutLine({
    window_days: 30,
    overall: { shown: {}, withheld: {},
      difference: { refused_reason: 'have 61 shown and 3 withheld' } },
  });
  check('18 and when it cannot speak it says what it is waiting for',
    /NOT YET MEASURABLE/.test(starved) && /3 withheld/.test(starved), starved);

  await clean(pool);
  console.log('');
  console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(async (err) => {
  console.error(err);
  try { await clean(getAnalyticsPool()); } catch { /* best effort */ }
  process.exit(1);
});
