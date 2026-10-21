#!/usr/bin/env node
/**
 * Money audit verification - drives services/moneyAuditService.moneyAudit and
 * the /api/recommendations/money-audit route against the real analytics DB on
 * a sentinel tenant, covering the ways a "you are not losing money" page can
 * reassure wrongly:
 *
 *   1  a confirmed card whose increment outsold its holding cost -> made_money,
 *      with the net
 *   2  a confirmed card whose unsold units' holding cost exceeds the increment
 *      -> lost_money, with the AMOUNT, the holding cost taken proportionally
 *      from the engine's own figure, and the approximation stated
 *   3  a not_followed card with a negative lift -> not_followed_no_exposure:
 *      no money was at risk, whatever the product's sales did
 *   4  a card whose windows have not closed -> window_open, naming the close
 *   5  a card with no unit cost -> unmeasurable, with the reason
 *   6  a withheld (holdout) card is excluded from the shown table and counted
 *      as the control
 *   7  a confirmed card with a negative increment and no holding figure is a
 *      loss of AT LEAST that much (bounded), not "unmeasurable"
 *   8  a closed card with a negative net but fulfilment pending is
 *      exposure_unconfirmed - not a loss, not a gain, not nothing
 *   9  the summary: counts, the realised net over closed confirmed cards, the
 *      largest loss by card, "too few to bound", the floor and the below-$1
 *      count, the holdout report present
 *   10 the HTML lists losses first and carries every row's reason
 *   11 the route returns the audit for the JWT's tenant, 200, under {data}
 *   12 another tenant sees none of it
 *
 * PREREQ: analytics migrations through 039 applied (028 decision figures, 035
 * outcome quantities, 039 fulfilment state).
 * Run:  node tests/money-audit-verify.js
 */
require('dotenv').config();

const http = require('http');
const express = require('express');
const { getAnalyticsPool } = require('../database/analytics-connection');
const audit = require('../services/moneyAuditService');

const CID = 999924;
const LID = 990024;
const OTHER_CID = 999925;
const OTHER_LID = 990025;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const near = (a, b, eps = 0.005) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;

const dayMs = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => iso(Date.now() - n * dayMs);
const TODAY = daysAgo(0);
const OLD_DATE = daysAgo(40);   // every window up to 30 days has closed
const NEW_DATE = daysAgo(3);    // nothing has closed

async function clean(pool) {
  // outcomes have no FK to recommendations; everything else cascades from the run.
  for (const [c, l] of [[CID, LID], [OTHER_CID, OTHER_LID]]) {
    await pool.query('DELETE FROM recommendation_outcomes WHERE client_id=$1 AND location_id=$2', [c, l]);
    await pool.query('DELETE FROM recommendation_runs WHERE client_id=$1 AND location_id=$2', [c, l]);
  }
}

async function insertRun(pool, cid, lid, recDate) {
  const { rows: [run] } = await pool.query(
    `INSERT INTO recommendation_runs (client_id, location_id, generated_at, data_as_of, rec_date)
     VALUES ($1, $2, $3::date, $3::date, $3::date) RETURNING id`,
    [cid, lid, recDate]
  );
  return run.id;
}

/**
 * One card with everything the audit reads: the row, its rec-time price/cost,
 * its admission, its evaluations for every window and its outcome rows.
 *
 * spec: sku, family, qty, hc (holding_cost_if_unsold), fulfilment, status,
 *       price, cost (null = unknown), expected_profit (undefined = no admission
 *       row), closed (bool: data_through past every window), margin (per
 *       window: margin_impact; null = cost unknown), lift, unsold (units_unsold
 *       on the outcome; undefined = no outcome row)
 */
async function insertCard(pool, runId, cid, lid, recDate, rank, spec) {
  const { rows: [rec] } = await pool.query(
    `INSERT INTO recommendations
       (run_id, client_id, location_id, rank, category, action_type, primary_skus,
        rationale, confidence, valid_through, status, suggested_order_qty,
        holding_cost_if_unsold, holding_cost_basis, engine_family, fulfilment_state,
        fulfilment_evidence)
     VALUES ($1,$2,$3,$4,'test','reorder',ARRAY[$5::text],'r',0.7,$6::date + 14,$7,$8,$9,$10,$11,$12,$13::jsonb)
     RETURNING id`,
    [runId, cid, lid, rank, spec.sku, recDate, spec.status || null, spec.qty ?? null,
      spec.hc ?? null, spec.hc != null ? 'capital + shelf + a one-off obsolescence hazard at the spirits rate (test)' : null,
      spec.family || 'stockout', spec.fulfilment || 'pending',
      JSON.stringify({ detector: spec.fulfilment === 'confirmed' ? 'purchases_feed' : 'none' })]
  );
  await pool.query(
    `INSERT INTO recommendation_sku_state (rec_id, client_id, location_id, sku, on_hand, price, cost, captured_at)
     VALUES ($1,$2,$3,$4,5,$5,$6,now())`,
    [rec.id, cid, lid, spec.sku, spec.price ?? 20, spec.cost === undefined ? 12 : spec.cost]
  );
  if (spec.expected_profit !== undefined) {
    await pool.query(
      `INSERT INTO recommendation_admission (rec_id, client_id, location_id, rec_date, visible, reasons,
          explanation, expected_profit_usd, profit_basis, decided_at)
       VALUES ($1,$2,$3,$4::date,true,'{}','ok',$5,$6,now())`,
      [rec.id, cid, lid, recDate, spec.expected_profit, spec.expected_profit == null ? 'none' : 'avoided_stockout']
    );
  }
  for (const w of [7, 30, 60, 90]) {
    const dataThrough = spec.closed ? daysAgo(1) : TODAY;
    await pool.query(
      `INSERT INTO recommendation_evaluations (rec_id, client_id, location_id, window_days, evaluated_at,
          data_through, units_sold, expected_units, lift, verdict, margin_impact, revenue_impact)
       VALUES ($1,$2,$3,$4,now(),$5::date,$6,$7,$8,$9,$10,$11)`,
      [rec.id, cid, lid, w, dataThrough, spec.sold ?? 8, spec.expected ?? 4, spec.lift ?? null,
        spec.lift == null ? 'insufficient_data' : (spec.lift >= 1.2 ? 'winner' : 'neutral'),
        spec.margin === undefined ? null : spec.margin, spec.margin == null ? null : spec.margin * 2]
    );
    if (spec.unsold !== undefined) {
      const start = recDate;
      const end = iso(Date.parse(`${recDate}T00:00:00Z`) + w * dayMs);
      await pool.query(
        `INSERT INTO recommendation_outcomes (recommendation_id, client_id, location_id, sku, family, arm,
            window_start, window_end, open_days_in_window, lift, recommended_qty, actual_units_sold, units_unsold, scored_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11,$12,$13,now())`,
        [rec.id, cid, lid, spec.sku, spec.family || 'stockout', spec.status === 'holdout' ? 'withheld' : 'shown',
          start, end, Math.round(w * 0.85), spec.lift ?? null, spec.qty ?? null, spec.sold ?? 8, spec.unsold]
      );
    }
  }
  return rec.id;
}

(async () => {
  const pool = getAnalyticsPool();
  await clean(pool);

  const oldRun = await insertRun(pool, CID, LID, OLD_DATE);
  const newRun = await insertRun(pool, CID, LID, NEW_DATE);

  // 1  confirmed, everything sold, +$50 increment -> made_money $50
  const made = await insertCard(pool, oldRun, CID, LID, OLD_DATE, 1,
    { sku: 'MADE', qty: 10, hc: 20, fulfilment: 'confirmed', expected_profit: 30, closed: true, margin: 50, lift: 2.0, unsold: 0 });
  // 2  confirmed, 8 of 10 unsold: holding 20 x 8/10 = 16 against a +$4 increment -> lost_money -$12
  const lost = await insertCard(pool, oldRun, CID, LID, OLD_DATE, 2,
    { sku: 'LOST', qty: 10, hc: 20, fulfilment: 'confirmed', expected_profit: 25, closed: true, margin: 4, lift: 1.1, unsold: 8 });
  // 3  not followed, the product fell -$30 against baseline -> no exposure
  const notFollowed = await insertCard(pool, oldRun, CID, LID, OLD_DATE, 3,
    { sku: 'NOTF', qty: 6, hc: 9, fulfilment: 'not_followed', expected_profit: 12, closed: true, margin: -30, lift: 0.4, unsold: 6 });
  // 4  issued three days ago, nothing closed -> window_open. No admission row
  //    either (the audit's "expected profit unknown" case, which is every card
  //    at a store whose admission audit was never persisted).
  const open = await insertCard(pool, newRun, CID, LID, NEW_DATE, 1,
    { sku: 'OPEN', qty: 6, hc: 9, fulfilment: 'pending', closed: false, margin: 3, lift: 1.3, unsold: 4 });
  // 5  confirmed, no cost -> margin null -> unmeasurable with the reason
  const noCost = await insertCard(pool, oldRun, CID, LID, OLD_DATE, 4,
    { sku: 'NOCOST', qty: 6, hc: null, fulfilment: 'confirmed', expected_profit: null, closed: true, margin: null, lift: 1.8, cost: null, unsold: 2 });
  // 6  withheld
  const withheld = await insertCard(pool, oldRun, CID, LID, OLD_DATE, 5,
    { sku: 'HOLD', qty: 6, hc: 9, status: 'holdout', fulfilment: 'pending', closed: true, margin: 40, lift: 1.5, unsold: 0 });
  // 7  confirmed, -$5 increment, 3 unsold, NO holding figure -> loss of at least $5
  const bounded = await insertCard(pool, oldRun, CID, LID, OLD_DATE, 6,
    { sku: 'BOUND', qty: 6, hc: null, fulfilment: 'confirmed', expected_profit: 0.5, closed: true, margin: -5, lift: 0.8, unsold: 3 });
  // 8  closed, -$20 net, fulfilment pending -> exposure_unconfirmed
  const unconfirmed = await insertCard(pool, oldRun, CID, LID, OLD_DATE, 7,
    { sku: 'UNCONF', qty: 6, hc: 9, fulfilment: 'pending', expected_profit: 10, closed: true, margin: -20, lift: 0.5, unsold: 0 });

  // 14 a REPEAT of card 1: the same SKU issued again the same day, reading the
  //    same window. Listed with its own verdict; its $50 counted once.
  const repeat = await insertCard(pool, oldRun, CID, LID, OLD_DATE, 8,
    { sku: 'MADE', qty: 10, hc: 20, fulfilment: 'confirmed', expected_profit: 30, closed: true, margin: 50, lift: 2.0, unsold: 0 });

  // Another tenant with a confirmed loss that must never show up here.
  const otherRun = await insertRun(pool, OTHER_CID, OTHER_LID, OLD_DATE);
  await insertCard(pool, otherRun, OTHER_CID, OTHER_LID, OLD_DATE, 1,
    { sku: 'OTHER', qty: 10, hc: 20, fulfilment: 'confirmed', expected_profit: 9, closed: true, margin: -40, lift: 0.3, unsold: 10 });

  const report = await audit.moneyAudit(pool, CID, LID, { sinceDays: 120, storeName: 'Sentinel Liquors' });
  const byId = new Map(report.cards.map((c) => [c.rec_id, c]));
  const row = (id) => byId.get(Number(id));

  console.log('\n-- 1  made money ------------------------------------------');
  check('1  a confirmed card whose increment beat its holding cost is made_money',
    row(made).verdict === 'made_money', row(made).reason);
  check('1b with the net = increment - 0 holding (everything sold)',
    near(row(made).after_window.realised_net, 50) && row(made).after_window.holding_cost_incurred === 0,
    JSON.stringify(row(made).after_window));
  check('1c zero holding is a GENUINE zero, and says so',
    /nothing unsold/.test(row(made).after_window.holding_basis), row(made).after_window.holding_basis);

  console.log('\n-- 2  lost money, with the amount ---------------------------');
  check('2  a confirmed card whose unsold units cost more than the increment is lost_money',
    row(lost).verdict === 'lost_money', row(lost).reason);
  check('2b holding incurred is the engine figure prorated: 20 x 8/10 = 16',
    near(row(lost).after_window.holding_cost_incurred, 16), String(row(lost).after_window.holding_cost_incurred));
  check('2c the net is 4 - 16 = -12',
    near(row(lost).after_window.realised_net, -12), String(row(lost).after_window.realised_net));
  check('2d and the approximation is stated on the row',
    /approximation/.test(row(lost).after_window.holding_basis) && /8\/10/.test(row(lost).after_window.holding_basis),
    row(lost).after_window.holding_basis);
  check('2e the reason names the loss and the unsold units',
    /-\$12\.00/.test(row(lost).reason) && /8 of 10/.test(row(lost).reason), row(lost).reason);

  console.log('\n-- 3  not followed: no exposure -----------------------------');
  check('3  a not_followed card with a negative increment is not a loss',
    row(notFollowed).verdict === 'not_followed_no_exposure', row(notFollowed).reason);
  check('3b its figures stay on the record (the product did fall $30)',
    near(row(notFollowed).after_window.incremental_margin, -30) && /-\$30\.00/.test(row(notFollowed).reason),
    row(notFollowed).reason);

  console.log('\n-- 4  window open -------------------------------------------');
  check('4  a card issued three days ago is window_open',
    row(open).verdict === 'window_open' && row(open).after_window.window_closed === false, row(open).reason);
  check('4b and the reason names when the first window closes',
    row(open).reason.includes(iso(Date.parse(`${NEW_DATE}T00:00:00Z`) + 7 * dayMs)), row(open).reason);
  check('4c no net is stated for it', row(open).after_window.realised_net === null
    && row(open).after_window.holding_cost_incurred === null);

  console.log('\n-- 5  no cost: unmeasurable with the reason -----------------');
  check('5  a card with no unit cost is unmeasurable',
    row(noCost).verdict === 'unmeasurable', row(noCost).reason);
  check('5b the reason names the cost', /unit cost is unknown/.test(row(noCost).reason), row(noCost).reason);
  check('5c its lift is still reported', near(row(noCost).after_window.lift, 1.8));
  check('5d unit_cost is null, margin_per_unit is null, never 0',
    row(noCost).at_issue.unit_cost === null && row(noCost).at_issue.margin_per_unit === null);

  console.log('\n-- 6  withheld is the control, not a shown card -------------');
  check('6  the withheld card is not in the shown table', !byId.has(Number(withheld)));
  check('6b it is listed separately with its figures',
    report.withheld.length === 1 && report.withheld[0].rec_id === Number(withheld)
    && near(report.withheld[0].after_window.incremental_margin, 40), JSON.stringify(report.withheld.map((w) => w.rec_id)));
  check('6c and counted as the control', report.summary.cards_withheld === 1 && report.summary.cards_shown === 8,
    `${report.summary.cards_withheld} / ${report.summary.cards_shown}`);

  console.log('\n-- 7  a bounded loss is a loss ------------------------------');
  check('7  negative increment with no holding figure is lost_money, not unmeasurable',
    row(bounded).verdict === 'lost_money', row(bounded).reason);
  check('7b realised_net is null and the bound carries the amount',
    row(bounded).after_window.realised_net === null && near(row(bounded).after_window.realised_net_at_most, -5),
    JSON.stringify(row(bounded).after_window));
  check('7c the reason says "at least"', /AT LEAST/i.test(row(bounded).reason), row(bounded).reason);

  console.log('\n-- 8  exposure unconfirmed ----------------------------------');
  check('8  a closed negative net with fulfilment pending is exposure_unconfirmed',
    row(unconfirmed).verdict === 'exposure_unconfirmed', row(unconfirmed).reason);
  check('8b the net is computed and shown (-20), but attributed neither way',
    near(row(unconfirmed).after_window.realised_net, -20) && /not established/.test(row(unconfirmed).reason),
    row(unconfirmed).reason);

  console.log('\n-- 9  the summary -------------------------------------------');
  const s = report.summary;
  check('9  verdict counts (per card: the repeat has its own made_money)', s.verdicts.made_money === 2 && s.verdicts.lost_money === 2
    && s.verdicts.not_followed_no_exposure === 1 && s.verdicts.window_open === 1
    && s.verdicts.unmeasurable === 1 && s.verdicts.exposure_unconfirmed === 1,
  JSON.stringify(s.verdicts));
  check('9b confirmed 5, closed 7', s.confirmed === 5 && s.closed === 7, `${s.confirmed} / ${s.closed}`);
  check('9c realised net over closed confirmed PRODUCT-WINDOWS with a full net: 50 - 12 = 38 over 2, the repeat counted once',
    s.realised_net.cards === 2 && near(s.realised_net.sum, 38) && near(s.realised_net.mean, 19)
    && s.realised_net.settled_cards_including_repeats === 4,
  JSON.stringify(s.realised_net));
  check('9c2 the repeat is marked as such, and the first card is not',
    row(repeat).duplicate_of === Number(made) && row(made).duplicate_of === null
    && s.duplicate_cards === 1 && s.distinct_product_windows === 7,
  `${row(repeat).duplicate_of} / ${row(made).duplicate_of} / ${s.duplicate_cards} / ${s.distinct_product_windows}`);
  check('9c3 and the statement says so', /counted once/.test(s.realised_net.statement), s.realised_net.statement);
  check('9d the bounded loss is counted apart, never summed as its bound',
    s.realised_net.bounded_only_losses === 1 && near(s.realised_net.bounded_only_losses_at_least, 5),
    JSON.stringify(s.realised_net));
  check('9e two cards are too few to bound, and it says so',
    s.realised_net.ci95 === null && /too few to bound/.test(s.realised_net.ci_reason), s.realised_net.ci_reason);
  check('9f the largest single loss is card LOST at -12, with its sku and why',
    s.largest_loss.rec_id === Number(lost) && near(s.largest_loss.amount, -12) && s.largest_loss.sku === 'LOST'
    && /unsold/.test(s.largest_loss.why), JSON.stringify(s.largest_loss));
  check('9g the floor in force is reported as the gate module sees it',
    s.profit_floor.rec_min_profit_usd_in_force === require('../services/recommendationGateService').MIN_EXPECTED_PROFIT_USD);
  check('9h one card was issued below $1 expected profit; one has no admission row',
    s.profit_floor.issued_below_one_dollar === 1 && s.profit_floor.issued_without_admission_row === 1
    && s.profit_floor.issued_without_profit_figure === 1, JSON.stringify(s.profit_floor));
  check('9i the holdout report is present and refuses (one withheld outcome)',
    s.holdout && s.holdout.overall && s.holdout.overall.difference.refused_reason !== null
    && /NOT YET MEASURABLE/.test(s.holdout_line), s.holdout_line);
  check('9j the plain-English answer names the measured loss and what cannot be stated',
    report.answer.some((l) => /MEASURED LOSS on 2/.test(l)) && report.answer.some((l) => /Cannot be stated yet/.test(l)),
    report.answer.join(' | '));
  check('9k the windows used are the closed 30-day ones', s.windows_used['30d'] === 7, JSON.stringify(s.windows_used));
  check('9l the lost/made reasons say what sold against what was expected',
    /sold 8 vs 4\.0 expected over 30d/.test(row(lost).reason) && /\$8\.00\/unit margin/.test(row(lost).reason), row(lost).reason);

  console.log('\n-- 10 the HTML ----------------------------------------------');
  const html = audit.renderMoneyAuditHtml(report);
  const pos = (sku) => html.indexOf(`<td>${sku}</td>`);
  check('10 losses come first, the larger loss first',
    pos('LOST') > 0 && pos('LOST') < pos('BOUND') && pos('BOUND') < pos('MADE'),
    `LOST@${pos('LOST')} BOUND@${pos('BOUND')} MADE@${pos('MADE')}`);
  check('10b made_money follows the losses and the rest follow it',
    pos('MADE') < pos('UNCONF') && pos('UNCONF') < pos('NOTF') && pos('NOTF') < pos('OPEN') && pos('OPEN') < pos('NOCOST'),
    `MADE@${pos('MADE')} UNCONF@${pos('UNCONF')} NOTF@${pos('NOTF')} OPEN@${pos('OPEN')} NOCOST@${pos('NOCOST')}`);
  check('10c every shown row carries its reason',
    report.cards.every((c) => html.includes(c.reason.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])))));
  check('10d the withheld card is in its own table, after the shown rows',
    pos('HOLD') > pos('NOCOST') && html.indexOf('Withheld cards') < pos('HOLD'));
  check('10d2 the repeat card is labelled on the page', html.includes(`repeat of ${made}`));
  check('10e the page is self-contained (no external script or stylesheet)',
    !/<script\s+src=|<link\s+rel="stylesheet"/.test(html));
  check('10f the largest loss and the floor are on the page',
    html.includes('-$12.00') && html.includes('REC_MIN_PROFIT_USD='));

  console.log('\n-- 11 the route ---------------------------------------------');
  const app = express();
  app.use('/api/recommendations/money-audit', (req, _res, next) => {
    req.user = { client_id: CID, location_id: LID };
    next();
  }, require('../routes/money-audit'));
  const server = await new Promise((resolve) => {
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const { port } = server.address();
  const fetchJson = (p) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${p}`, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
  const res = await fetchJson('/api/recommendations/money-audit?days=120');
  check('11 200 under {data}', res.status === 200 && res.body.data && res.body.data.summary, `status ${res.status}`);
  check('11b the same verdicts the service returned',
    res.body.data && JSON.stringify(res.body.data.summary.verdicts) === JSON.stringify(s.verdicts));
  check('11c a silly days value is clamped, not rejected',
    (await fetchJson('/api/recommendations/money-audit?days=banana')).status === 200);
  server.close();

  console.log('\n-- 12 another tenant ----------------------------------------');
  const other = await audit.moneyAudit(pool, OTHER_CID, OTHER_LID, { sinceDays: 120 });
  check('12 the other tenant sees only its own card',
    other.summary.cards_shown === 1 && other.summary.verdicts.lost_money === 1
    && !other.cards.some((c) => byId.has(c.rec_id)), JSON.stringify(other.summary.verdicts));
  check('12b and ours never saw theirs', !report.cards.some((c) => c.sku === 'OTHER'));

  console.log('\n-- 13 the empty store ---------------------------------------');
  const empty = await audit.moneyAudit(pool, 999926, 990026, { sinceDays: 120, storeName: 'Nobody' });
  check('13 a store with no cards gets an answer, not an error',
    empty.summary.cards_shown === 0 && /no recommendation it could be losing money on/.test(empty.answer[0]),
    empty.answer[0]);
  check('13b its net is null, not zero', empty.summary.realised_net.sum === null);

  await clean(pool);
  console.log('');
  console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(async (err) => {
  console.error(err);
  try { await clean(getAnalyticsPool()); } catch { /* best effort */ }
  process.exit(1);
});
