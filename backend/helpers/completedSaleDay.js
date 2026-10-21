// ─── The "completed sales day" anchor ────────────────────────────────────────
//
// Dashboards and reports must anchor on the most recent COMPLETED sales day,
// never on a day that is still filling. Two real-world failure modes drive the
// two predicates below (both observed across the 11 live stores on 2026-08-20):
//
//   1. Intraday feeds: stores whose POS syncs during the day have rows for the
//      current calendar date, so a plain MAX(sale_date) anchors the dashboard
//      on today's partial numbers. The wall-clock cap excludes the store-local
//      current date outright. sale_date is a NAIVE store-local timestamp, so
//      the comparison clock must be store-local too - America/Chicago covers
//      the Central-zone stores exactly and behaves conservatively (never shows
//      a store's current day) for the Eastern ones.
//
//   2. Midnight boundary artifacts: some feeds stamp a stray row seconds after
//      midnight when the POS day rolls over (store 177: 00:00:30, 179:
//      00:00:49, 46: 00:12:25). That single row makes the new date "exist",
//      so MAX(sale_date) lands on a nearly-empty day - store 179's frontier
//      day held ONE artifact row while its real last day was two days earlier.
//      Rows in the first half hour after midnight therefore cannot ESTABLISH
//      the anchor day (once a day is anchored, its <00:30 rows still count in
//      the day's numbers - the filter only applies to picking the day).
//
// A lagging feed still anchors on its true frontier: store 171 with data
// through Aug 17 (evening close) anchors Aug 17, not Aug 16 - this rule
// replaces summary.js's older 6-hour freshness heuristic, which the midnight
// artifacts defeated (an artifact row older than 6h made "today" look like a
// finished day).
const STORE_LOCAL_TZ = process.env.STORE_LOCAL_TZ || 'America/Chicago';
if (!/^[A-Za-z0-9_/+-]+$/.test(STORE_LOCAL_TZ)) {
  throw new Error(`STORE_LOCAL_TZ looks invalid: ${STORE_LOCAL_TZ}`);
}

/**
 * Returns a scalar SELECT (no alias) yielding the anchor date for one store.
 * Callers wrap it: `SELECT (${completedSaleDaySql()}) AS latest` or use it as
 * a CTE body. Parameter placeholders default to $1/$2 (client_id/location_id).
 */
function completedSaleDaySql(clientParam = '$1', locationParam = '$2') {
  return `SELECT MAX(sale_date::date)
            FROM sales
           WHERE client_id = ${clientParam} AND location_id = ${locationParam}
             AND sale_date::time >= TIME '00:30'
             AND sale_date < (now() AT TIME ZONE '${STORE_LOCAL_TZ}')::date`;
}

module.exports = { completedSaleDaySql };
