// purchaseFeed.js
// -----------------------------------------------------------------------------
// ONE ANSWER to "can this store's purchase feed speak at all?", shared by every
// reader that needs it.
//
// Three places need it and they must agree:
//
//   poEffectivenessService  - to choose between `acted = false` ("the feed is
//                             live and silent on this SKU") and `acted = NULL`
//                             ("the feed cannot speak, so silence means
//                             nothing").
//   recommendationEvalService - to tell an owner why nothing is confirmed.
//   both reports            - to decide whether to put a NUMBER on screen.
//
// They disagreed, and that is the bug this module closes. At Bethany Discount
// Liquor (store 171) the whole of syncgo holds TWO purchase rows, both dated
// 2020-05-13, so no card issued since can ever be confirmed from an order.
// (Tuscany, store 173, is the OTHER case: a live feed of thousands of rows,
// which is why the scorer keeps `false` for it and NULL for 171.) The scorer knew that and recorded
// it. The report did not ask, so it rendered the arithmetic anyway:
//
//     Effectiveness to date   $-71,125
//     0 confirmed done by your data
//
// Every card ungradeable, summed, and presented to the owner as a verdict on
// their buying. The figure was not wrong arithmetic - it was arithmetic on an
// absence, which is the thing this codebase refuses everywhere else.
//
// `silent` is TRUE when the feed could not be READ, not only when it is empty.
// An unreadable feed is an absence of evidence, never evidence of inaction -
// the same rule migration 020 states in its own DDL.
// -----------------------------------------------------------------------------

const { getPool } = require('../database/connection');
const { purchaseDaySql, purchaseDaySaneSql } = require('./purchaseDateSql');
const logger = require('../utils/logger');

/**
 * @param {number|string} clientId
 * @param {number|string} locationId
 * @param {string|null} sinceIso  the oldest suggestion being measured, so the
 *   sentence can name a date the owner is able to go and check.
 * @returns {Promise<{rows: number|null, silent: boolean, reason: string|null}>}
 */
async function probePurchaseFeed(clientId, locationId, sinceIso) {
  if (!sinceIso) {
    return { rows: null, silent: true, reason: 'no suggestions to measure yet' };
  }

  let rows = null;
  try {
    // The day is purchaseDaySql(), not `date`: at LiquorPOS stores the sync
    // writes -infinity into `date` and the real day into invoice_date. On bare
    // `date` this count read 0 for Tuscany and the whole store fell into the
    // silent branch even where real orders existed.
    const feed = await getPool().query(
      `SELECT count(*)::int AS n FROM purchases
        WHERE client_id = $1 AND location_id = $2
          AND ${purchaseDaySaneSql()}
          AND ${purchaseDaySql()}::date > $3::date`,
      [clientId, locationId, sinceIso]
    );
    rows = feed.rows[0] ? feed.rows[0].n : null;
  } catch (err) {
    logger.warn(`[purchaseFeed] probe failed for ${clientId}:${locationId}: ${err.message}`);
  }

  const reason = rows === 0
    ? `no purchases rows for this store since ${sinceIso}: the POS does not sync orders here, so no order is not evidence of inaction`
    : rows === null
      ? 'the purchases feed could not be read, so no order is not evidence of inaction'
      : null;

  return { rows, silent: rows === 0 || rows === null, reason };
}

module.exports = { probePurchaseFeed };
