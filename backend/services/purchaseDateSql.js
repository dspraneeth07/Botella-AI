/**
 * The day a syncgo `purchases` row happened on, as SQL.
 *
 * WHY THIS EXISTS. At every LiquorPOS store (173 Tuscany, 182, 184, 186:
 * 19,428 rows on 19 Oct 2026) `purchases.date` is '-infinity' on EVERY row,
 * while `invoice_date` is populated and sane. The SyncGo extraction query for
 * that connector reads ONE source column, ORD_IN.DATE, under two aliases:
 *
 *     SELECT PO_NUM AS PurchaseId, DATE AS PurchaseDate, ..., DATE AS InvoiceDate
 *
 * Every other connector aliases the same field `AS Date`, which is the name the
 * uploader binds `purchases.date` to. `PurchaseDate` matches nothing, so the
 * uploader writes its default DateTime (0001-01-01), and the Postgres driver
 * stores that as -infinity. The POS has the date; the sync drops it on the
 * floor. The same mechanism shows in reverse at PCAmerica stores, whose query
 * says `null as InvoiceDate` and whose invoice_date is -infinity throughout.
 *
 * The fix that belongs here is a config change in SyncGo (alias the column
 * `AS Date`). Until that lands, every reader that filters, groups or orders
 * on the purchase day uses this expression: the sync's `date` when it is a
 * real timestamp, else `invoice_date` - which for LiquorPOS is the SAME
 * source field - and never a sentinel. A bare `date >= $1` filter against
 * -infinity silently excludes the whole feed; a bare `ORDER BY date DESC`
 * picks an arbitrary "latest" row.
 *
 * WHAT THIS IS NOT. A receipt date. `invoice_date` is a billing date, and
 * lead times (leadTimeService) must never treat it as the day the goods
 * arrived; they do not read this table. This expression answers "did an
 * order happen, and roughly when" - cadence and confirmation - and nothing
 * finer.
 *
 * Both sides are passed through NULLIF so a row whose date is a sentinel in
 * BOTH columns yields NULL, not -infinity; the sanity bound then drops it
 * explicitly (nothing in this warehouse predates 1990).
 */

const PURCHASE_DAY_FLOOR = '1990-01-01';

/**
 * The purchase day as a timestamp expression, for SELECT / GROUP BY / ORDER BY.
 * `alias` prefixes the columns when the query joins (e.g. 'p' -> p.date).
 */
function purchaseDaySql(alias = '') {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(NULLIF(${a}date, '-infinity'), NULLIF(${a}invoice_date, '-infinity'))`;
}

/**
 * The WHERE predicate that keeps only rows whose purchase day is real: not a
 * sentinel in both columns, not before the floor. Combine with the caller's
 * own lower bound (`AND <purchaseDaySql()> >= $n::date`).
 */
function purchaseDaySaneSql(alias = '') {
  return `${purchaseDaySql(alias)} >= DATE '${PURCHASE_DAY_FLOOR}'`;
}

module.exports = { purchaseDaySql, purchaseDaySaneSql, PURCHASE_DAY_FLOOR };
