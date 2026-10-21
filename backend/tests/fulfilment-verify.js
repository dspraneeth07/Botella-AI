/**
 * Fulfilment state machine verification (analytics migration 039) - drives
 * recommendationEvalService's fulfilment path end-to-end against the real
 * analytics DB (sentinel tenant) with a mocked syncgo warehouse, the way
 * rec-eval-verify.js drives the scoring path.
 *
 * THE RULE UNDER TEST: a card is COMPLETED only when database evidence shows
 * the owner followed it. The owner's click is a CLAIM until the data confirms
 * or refutes it, and it never moves the score.
 *
 *   A  the pure machine, every branch, no DB
 *   B  pending by default; a fresh endcap is 'unobservable' from day one
 *   C  the pending-actions walk WRITES THROUGH a mid-window confirmation and
 *      never lists a confirmed or dismissed card
 *   D  a purchases-feed row → confirmed, evidence names the order
 *   E  a matched, parsed invoice → confirmed, evidence names the invoice
 *   F  claim 'did' with nothing to confirm it → claimed; action_taken stays
 *      NULL and final_score does not move; the response carries the state
 *      and a sentence; the pending list keeps the row but flags it
 *   G  fresh snapshot, no inflow, 30-day window closed → not_followed, and a
 *      'did' claim does NOT lift it - the evidence records the conflict
 *   H  valid_through passed with nothing seen and nothing said → expired
 *   I  retract ('none') → a claimed card returns to pending; a confirmed one
 *      does not move
 *   J  confirmed never downgrades, even when a later pass sees nothing
 *   K  dismissal keeps its reason and leaves the fulfilment state alone
 *   L  /latest carries action_claim, dismiss_reason, fulfilment_state,
 *      fulfilment_confirmed_at and a fulfilment_summary sentence
 *   M  the claim route's bounded wait: with no time to wait it answers
 *      'queued' and the synchronous state
 *   N  a feed row whose `date` is the -infinity sentinel and whose
 *      invoice_date falls inside the window → confirmed via purchase_orders.
 *      This is every LiquorPOS store's feed (services/purchaseDateSql.js);
 *      the mock gives such a row a day ONLY when the SQL asks for the
 *      fallback expression, so a loader back on bare `date` fails here
 *
 * PREREQ: analytics migrations through 039 applied.
 * Run:  ANALYTICS_PG_HOST=localhost node tests/fulfilment-verify.js
 */
require('dotenv').config();

const { getAnalyticsPool } = require('../database/analytics-connection');
const evalSvc = require('../services/recommendationEvalService');
const recSvc = require('../services/recommendationService');

const CID = 999923;
const LID = 990023;

const dayMs = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => iso(Date.now() - n * dayMs);
const TODAY = daysAgo(0);        // sales frontier
const REC_DATE = daysAgo(10);    // the LATEST run: 7d closed, 30d open
const OLD_DATE = daysAgo(35);    // an older run: 30d closed, valid_through passed

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
}
const near = (a, b, eps = 0.001) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Mock syncgo warehouse ────────────────────────────────────────────────────
const salesRows = [];
function addDaily(sku, fromDaysAgo, toDaysAgo, unitsPerDay) {
  for (let n = fromDaysAgo; n > toDaysAgo; n--) salesRows.push({ sku, day: daysAgo(n), units: unitsPerDay });
}
addDaily('PO1', 38, 0, 1);   // D: steady seller, PO inside the 7d window
addDaily('INV1', 38, 0, 1);  // E: steady seller, invoice inside the 7d window
addDaily('CL1', 38, 0, 1);   // F: steady seller, nothing to confirm
addDaily('EC1', 38, 0, 1);   // B: endcap
addDaily('NF1', 63, 0, 1);   // G: steady seller, fresh snapshot, no inflow (old run)
                             // H: EX1 has no sales, no snapshot, no product (old run)
addDaily('DM1', 38, 0, 1);   // K: dismissed reorder
addDaily('KEEP', 38, 0, 1);  // J: confirmed by a PO the mock later forgets
addDaily('INF1', 38, 0, 1);  // N: steady seller; its feed row has date = -infinity, invoice_date in the window

const CURRENT_PRODUCTS = {
  PO1: { stock_qty: 30, price: 12, sale_price: null, product_name: 'Feed Vodka 750ml' },
  INV1: { stock_qty: 30, price: 12, sale_price: null, product_name: 'Invoice Gin 750ml' },
  CL1: { stock_qty: 5, price: 12, sale_price: null, product_name: 'Claimed Rum 750ml' },
  EC1: { stock_qty: 9, price: 12, sale_price: null, product_name: 'Endcap Tequila' },
  // NF1: snapshot on_hand 40 at the old rec date, 35 sold since, 5 on the
  // shelf now → net inflow 0 against a restock bar of 3: nothing arrived.
  NF1: { stock_qty: 5, price: 12, sale_price: null, product_name: 'Untouched Whisky' },
  DM1: { stock_qty: 5, price: 12, sale_price: null, product_name: 'Dismissed Mezcal' },
  KEEP: { stock_qty: 30, price: 12, sale_price: null, product_name: 'Kept Bourbon' },
  INF1: { stock_qty: 30, price: 12, sale_price: null, product_name: 'Sentinel Brandy 750ml' },
};
// Mutable so scenario J can make the feed forget a PO it once held.
// `day` is the row's `date`; null stands for the -infinity sentinel the sync
// writes at LiquorPOS stores, and `invoice_day` is its invoice_date.
let PURCHASE_ROWS = [
  { sku: 'PO1', day: daysAgo(6), units: 12, purchase_ids: ['PO-77001'] },
  { sku: 'KEEP', day: daysAgo(6), units: 6, purchase_ids: ['PO-77002'] },
  { sku: 'INF1', day: null, invoice_day: daysAgo(6), units: 9, purchase_ids: ['PO-77003'] },
];
// The purchase-day expression every reader must use (services/purchaseDateSql.js).
const PURCHASE_DAY_SQL = "COALESCE(NULLIF(date, '-infinity'), NULLIF(invoice_date, '-infinity'))";
const purchaseSqlSeen = [];

function route(text, params) {
  if (/information_schema\.columns/.test(text) && /purchases/.test(text)) return [{ n: 3 }];
  if (/MAX\(sale_date\)/.test(text)) return [{ latest: TODAY, d: TODAY }];
  if (/FROM sale_items/.test(text) && /AS sku,/.test(text) && /AS day,/.test(text)) {
    const skus = params[2];
    const since = String(params[3]).slice(0, 10);
    return salesRows.filter((r) => skus.includes(r.sku) && r.day >= since)
      .map((r) => ({ sku: r.sku, day: r.day, units: r.units }));
  }
  if (/FROM sale_items/.test(text) && /\bsku\)? = \$3/.test(text)) {
    return salesRows.filter((r) => r.sku === params[2] && r.day > String(params[3]).slice(0, 10))
      .map((r) => ({ day: r.day, units: r.units }));
  }
  if (/FROM sale_items/.test(text) && /AS sku,/.test(text)) {
    const skus = params[2];
    const totals = {};
    for (const r of salesRows) {
      if (skus.includes(r.sku) && r.day > daysAgo(28)) totals[r.sku] = (totals[r.sku] || 0) + r.units;
    }
    return Object.entries(totals).map(([sku, units]) => ({ sku, units }));
  }
  if (/FROM products/.test(text)) {
    const skus = params[2];
    if (!Array.isArray(skus)) {
      throw new Error(`fulfilment mock: FROM products matched with $3 = ${JSON.stringify(skus)}; query: ${text.slice(0, 120)}`);
    }
    return skus.filter((s) => CURRENT_PRODUCTS[s]).map((s) => ({ sku: s, ...CURRENT_PRODUCTS[s] }));
  }
  if (/count\(\*\)/.test(text) && /FROM purchases/.test(text)) return [{ n: PURCHASE_ROWS.length }];
  if (/FROM purchases/.test(text)) {
    purchaseSqlSeen.push(text);
    const skus = params[2];
    // The warehouse on the one point scenario N tests: a row whose `date` is
    // the sentinel has a day only through invoice_date, and only when the
    // query asks for the fallback. On bare `date` Postgres compares -infinity
    // against the lower bound and the row is gone - so it is here too.
    const usesFallback = text.includes(PURCHASE_DAY_SQL);
    const dayOf = (r) => r.day || (usesFallback ? r.invoice_day : null);
    return PURCHASE_ROWS.map((r) => ({ ...r, day: dayOf(r) }))
      .filter((r) => r.day && skus.includes(r.sku) && r.day >= String(params[3]).slice(0, 10))
      .map((r) => ({ sku: r.sku, day: r.day, units: r.units, purchase_ids: r.purchase_ids }));
  }
  return [];
}
const mockClient = {
  query: async (text, params) => ({ rows: /BEGIN|COMMIT|ROLLBACK|set_config/.test(text) ? [] : route(text, params) }),
  release: () => {},
};
const mockSyncgo = { query: async (t, p) => ({ rows: route(t, p) }), connect: async () => mockClient };

// ── Fixture ─────────────────────────────────────────────────────────────────
async function setup(pool) {
  const mkRun = async (recDate) => {
    const r = await pool.query(
      `INSERT INTO recommendation_runs
         (client_id, location_id, generated_at, data_as_of, candidate_count, recommendation_count, dropped_invalid, signal_snapshot, engine_version)
       VALUES ($1, $2, ($3 || 'T00:00:00Z')::timestamptz, $3::date, 10, 5, 0, '{}'::jsonb, '0.1.0-test') RETURNING id`,
      [CID, LID, recDate]
    );
    return r.rows[0].id;
  };
  const latestRun = await mkRun(REC_DATE);
  const oldRun = await mkRun(OLD_DATE);

  const mk = async (runId, recDate, rank, action, skus, { category = 'inventory_understock', claim = null } = {}) => {
    const r = await pool.query(
      `INSERT INTO recommendations
         (run_id, client_id, location_id, rank, category, action_type, primary_skus,
          rationale, signals_cited, confidence, valid_through, created_at, suggested_order_qty, action_claim, action_claim_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}',0.8,($9::date + 14),$9::date,12,$10,
               CASE WHEN $10::text IS NULL THEN NULL ELSE now() END)
       RETURNING id`,
      [runId, CID, LID, rank, category, action, skus, `${action} test rec for ${skus[0]}`, recDate, claim]
    );
    return r.rows[0].id;
  };
  const ids = {};
  ids.PO1 = await mk(latestRun, REC_DATE, 1, 'reorder', ['PO1']);
  ids.INV1 = await mk(latestRun, REC_DATE, 2, 'reorder', ['INV1']);
  ids.CL1 = await mk(latestRun, REC_DATE, 3, 'reorder', ['CL1']);
  ids.EC1 = await mk(latestRun, REC_DATE, 4, 'endcap', ['EC1'], { category: 'weather' });
  ids.DM1 = await mk(latestRun, REC_DATE, 5, 'reorder', ['DM1']);
  ids.KEEP = await mk(latestRun, REC_DATE, 6, 'reorder', ['KEEP']);
  ids.INF1 = await mk(latestRun, REC_DATE, 7, 'reorder', ['INF1']);
  ids.NF1 = await mk(oldRun, OLD_DATE, 1, 'reorder', ['NF1'], { claim: 'did' }); // owner says done; the shelf says otherwise
  ids.EX1 = await mk(oldRun, OLD_DATE, 2, 'reorder', ['EX1']);

  // Snapshots: NF1 captured fresh at its rec date with 40 on hand; the others
  // need none (PO / invoice / nothing decide them).
  await pool.query(
    `INSERT INTO recommendation_sku_state
       (rec_id, client_id, location_id, sku, on_hand, price, sale_price, weekly_rate, captured_at)
     VALUES ($1,$2,$3,'NF1',40,12,NULL,7,$4::date)`,
    [ids.NF1, CID, LID, OLD_DATE]
  );

  // E: a parsed invoice, one line a person matched to INV1, dated inside the
  // 7-day window; plus a FAILED parse that must never count.
  const mkInvoice = async (sku, qty, day, status, invoiceNo) => {
    const { rows: [po] } = await pool.query(
      `INSERT INTO purchase_orders
         (client_id, location_id, doc_type, status, vendor_name, invoice_no, invoice_date,
          file_name, file_mime, file_path)
       VALUES ($1,$2,'invoice',$3,'Test Vendor',$4,$5::date,'test.pdf','application/pdf','/dev/null')
       RETURNING id`,
      [CID, LID, status, invoiceNo, day]
    );
    await pool.query(
      `INSERT INTO purchase_order_items
         (purchase_order_id, client_id, location_id, line_no, product_name, quantity,
          matched_sku, match_source, matched_at)
       VALUES ($1,$2,$3,1,$4,$5,$6,'manual',now())`,
      [po.id, CID, LID, `${sku} line`, qty, sku]
    );
    return po.id;
  };
  ids.INV1_DOC = await mkInvoice('INV1', 24, daysAgo(5), 'parsed', 'INV-4471');
  await mkInvoice('INV1', 99, daysAgo(6), 'failed', 'INV-BAD');

  return { latestRun, oldRun, ids };
}

async function cleanup(pool) {
  await pool.query('DELETE FROM recommendation_runs WHERE client_id=$1 AND location_id=$2', [CID, LID]);
  await pool.query('DELETE FROM purchase_orders WHERE client_id=$1 AND location_id=$2', [CID, LID])
    .catch((e) => console.warn('purchase_orders cleanup skipped:', e.message));
  await pool.query('DELETE FROM recommendation_outcomes WHERE client_id=$1 AND location_id=$2', [CID, LID])
    .catch((e) => console.warn('recommendation_outcomes cleanup skipped:', e.message));
  await pool.query('DELETE FROM recommendation_digests WHERE client_id=$1 AND location_id=$2', [CID, LID])
    .catch(() => {});
}

const stateOf = async (pool, id) => {
  const { rows } = await pool.query(
    `SELECT fulfilment_state, fulfilment_evidence, fulfilment_confirmed_at, fulfilment_checked_at,
            action_claim, dismiss_reason FROM recommendations WHERE id = $1`, [id]
  );
  return rows[0];
};
const evalRow = async (pool, id, w) => {
  const { rows } = await pool.query(
    'SELECT action_taken, action_evidence, final_score FROM recommendation_evaluations WHERE rec_id=$1 AND window_days=$2',
    [id, w]
  );
  return rows[0] || null;
};

(async () => {
  const pool = getAnalyticsPool();
  try {
    const has039 = await evalSvc.fulfilmentColumnsExist(pool);
    if (!has039) {
      console.error('analytics migration 039 is not applied - run `npm run migrate` first.');
      process.exit(1);
    }
    await cleanup(pool);
    const { ids } = await setup(pool);
    const F = evalSvc.fulfilmentFrom;
    const det = (taken, skus) => ({ taken, evidence: { skus } });

    // ── A: the pure machine ─────────────────────────────────────────────────
    check('A1 feed TRUE → confirmed, detector and rows named',
      (() => { const r = F({ actionType: 'reorder', detection: det(true, [{ sku: 'X', taken: true, detector: 'purchase_orders', purchased_units: 12, purchase_days: [TODAY], purchase_ids: ['P1'] }]), claim: null, validThrough: null, windowClosed: false, today: TODAY });
        return r.state === 'confirmed' && r.evidence.detector === 'purchase_orders' && r.evidence.rows[0].purchase_ids[0] === 'P1'; })());
    check('A2 invoice TRUE → confirmed',
      F({ actionType: 'pre_stock', detection: det(true, [{ sku: 'X', taken: true, detector: 'invoice', invoice_units: 24, invoice_dates: [TODAY] }]), claim: null, validThrough: null, windowClosed: false, today: TODAY }).state === 'confirmed');
    check('A3 attributable stock delta TRUE → confirmed',
      F({ actionType: 'reorder', detection: det(true, [{ sku: 'X', taken: true, detector: 'stock_delta', net_inflow: 18, threshold: 3 }]), claim: null, validThrough: null, windowClosed: false, today: TODAY }).state === 'confirmed');
    check('A4 price drop TRUE → confirmed',
      F({ actionType: 'markdown', detection: det(true, [{ sku: 'X', taken: true, detector: 'price', effective_price_then: 20, effective_price_now: 16.99 }]), claim: null, validThrough: null, windowClosed: false, today: TODAY }).state === 'confirmed');
    check('A5 catalogue arrival TRUE → confirmed',
      F({ actionType: 'stock_new', detection: { taken: true, evidence: { detector: 'catalog_registry', upc: '1', arrived: { sku: 'N', first_seen: TODAY } } }, claim: null, validThrough: null, windowClosed: false, today: TODAY }).state === 'confirmed');
    check('A6 owner_reported TRUE never confirms',
      F({ actionType: 'endcap', detection: { taken: true, evidence: { detector: 'owner_reported', claim: 'did' } }, claim: 'did', validThrough: null, windowClosed: true, today: TODAY }).state === 'claimed');
    check('A7 FALSE + window closed → not_followed; a did claim does not override and the conflict is recorded',
      (() => { const r = F({ actionType: 'reorder', detection: det(false, [{ sku: 'X', taken: false, detector: 'stock_delta', net_inflow: 0, threshold: 3 }]), claim: 'did', validThrough: daysAgo(-10), windowClosed: true, today: TODAY });
        return r.state === 'not_followed' && /owner said done/.test(r.evidence.conflict) && r.evidence.claim === 'did'; })());
    check('A8 FALSE + valid_through passed (window open) → not_followed',
      F({ actionType: 'markdown', detection: det(false, [{ sku: 'X', taken: false, detector: 'price' }]), claim: null, validThrough: daysAgo(1), windowClosed: false, today: TODAY }).state === 'not_followed');
    check('A9 FALSE + window open + valid → pending (the data has not finished speaking)',
      F({ actionType: 'reorder', detection: det(false, [{ sku: 'X', taken: false, detector: 'stock_delta' }]), claim: null, validThrough: daysAgo(-5), windowClosed: false, today: TODAY }).state === 'pending');
    check('A10 FALSE + window open + did → claimed, noting nothing seen so far',
      (() => { const r = F({ actionType: 'reorder', detection: det(false, [{ sku: 'X', taken: false, detector: 'stock_delta' }]), claim: 'did', validThrough: daysAgo(-5), windowClosed: false, today: TODAY });
        return r.state === 'claimed' && /still open/.test(r.evidence.note); })());
    check('A11 NULL + did → claimed', F({ actionType: 'reorder', detection: det(null, [{ sku: 'X', taken: null, detector: 'none' }]), claim: 'did', validThrough: null, windowClosed: false, today: TODAY }).state === 'claimed');
    check('A12 unobservable type, no claim → unobservable',
      F({ actionType: 'cold_box', detection: { taken: null, evidence: { detector: 'unobservable', action_type: 'cold_box' } }, claim: null, validThrough: daysAgo(1), windowClosed: true, today: TODAY }).state === 'unobservable');
    check('A13 unobservable type + did → claimed, and says no detector can ever see it',
      /no detector can see/.test(F({ actionType: 'promote', detection: { taken: null, evidence: { detector: 'unobservable' } }, claim: 'did', validThrough: null, windowClosed: false, today: TODAY }).evidence.note || ''));
    check('A14 NULL + valid_through passed, no claim → expired',
      F({ actionType: 'reorder', detection: det(null, [{ sku: 'X', taken: null, detector: 'none' }]), claim: null, validThrough: daysAgo(1), windowClosed: true, today: TODAY }).state === 'expired');
    check('A15 NULL + did_not → pending with the claim recorded (an owner\'s no is not a detector\'s false)',
      (() => { const r = F({ actionType: 'reorder', detection: null, claim: 'did_not', validThrough: daysAgo(-5), windowClosed: false, today: TODAY }); return r.state === 'pending' && r.evidence.claim === 'did_not'; })());
    check('A16 no detection at all → pending', F({ actionType: 'reorder', detection: null, claim: null, validThrough: null, windowClosed: false, today: TODAY }).state === 'pending');
    check('A17 dismissed is not a fulfilment state: the data still decides',
      F({ actionType: 'reorder', detection: det(true, [{ sku: 'X', taken: true, detector: 'purchase_orders', purchased_units: 1 }]), claim: 'dismissed', validThrough: null, windowClosed: false, today: TODAY }).state === 'confirmed');
    check('A18 the summary sentence names the invoice',
      /Confirmed: 24 units received on .* \(invoice #4471\)/.test(evalSvc.fulfilmentSummary({
        state: 'confirmed', action_type: 'reorder',
        evidence: F({ actionType: 'reorder', detection: det(true, [{ sku: 'X', taken: true, detector: 'invoice', invoice_units: 24, invoice_dates: [daysAgo(5)], invoice_nos: ['4471'] }]), claim: null, validThrough: null, windowClosed: false, today: TODAY }).evidence,
      })));
    check('A19 the not_followed sentence says both: no order, and that you said done',
      /No order seen by .*; the shelf did not move\. You marked it done.*but the data shows no order\./.test(
        evalSvc.fulfilmentSummary({ state: 'not_followed', action_type: 'reorder', claim: 'did', claim_at: daysAgo(8), valid_through: daysAgo(1),
          evidence: { detector: 'stock_delta', rows: [], window: { data_through: TODAY } } })));

    // ── B: defaults, before any pass ────────────────────────────────────────
    check('B1 a fresh card is pending by default (the column default, never checked)',
      (await stateOf(pool, ids.PO1)).fulfilment_state === 'pending' && (await stateOf(pool, ids.PO1)).fulfilment_checked_at === null);

    // ── C: the pending-actions walk writes a confirmation through ───────────
    const pend0 = await evalSvc.getPendingActions(pool, CID, LID, { syncgoPool: mockSyncgo, nocache: true });
    const pendIds0 = pend0.pending.map((p) => Number(p.rec_id));
    const po1AfterWalk = await stateOf(pool, ids.PO1);
    check('C1 the walk saw PO1\'s feed row and wrote CONFIRMED before any evaluation ran',
      po1AfterWalk.fulfilment_state === 'confirmed' && po1AfterWalk.fulfilment_confirmed_at != null
      && /pending-actions walk/.test(po1AfterWalk.fulfilment_evidence.window.note || ''),
      JSON.stringify(po1AfterWalk));
    check('C2 ...and the invoice-backed card too, naming the document',
      (await stateOf(pool, ids.INV1)).fulfilment_state === 'confirmed'
      && (await stateOf(pool, ids.INV1)).fulfilment_evidence.rows[0].invoice_nos[0] === 'INV-4471',
      JSON.stringify((await stateOf(pool, ids.INV1)).fulfilment_evidence));
    check('C3 confirmed cards are not pending; the unconfirmed reorders are',
      !pendIds0.includes(Number(ids.PO1)) && !pendIds0.includes(Number(ids.INV1))
      && pendIds0.includes(Number(ids.CL1)) && pendIds0.includes(Number(ids.DM1)),
      JSON.stringify(pendIds0));
    check('C4 pending rows carry action_claim and fulfilment_state',
      pend0.pending.every((p) => 'action_claim' in p && 'fulfilment_state' in p));

    // ── First evaluation pass ──────────────────────────────────────────────
    const res = await evalSvc.evaluateTenant(pool, CID, LID, { syncgoPool: mockSyncgo });
    check('pass: every card was stated', res.fulfilment && res.fulfilment.stated === 9, JSON.stringify(res.fulfilment));

    // ── N: the LiquorPOS feed shape ─────────────────────────────────────────
    const inf1 = await stateOf(pool, ids.INF1);
    check('N1 a feed row with date = -infinity and invoice_date inside the window → confirmed, naming the order',
      inf1.fulfilment_state === 'confirmed' && inf1.fulfilment_evidence.detector === 'purchase_orders'
      && inf1.fulfilment_evidence.rows[0].purchase_ids[0] === 'PO-77003' && inf1.fulfilment_evidence.rows[0].units === 9,
      JSON.stringify(inf1.fulfilment_evidence));
    check('N2 every purchases query the evaluator sent asked for the fallback day and the 1990 floor',
      purchaseSqlSeen.length > 0 && purchaseSqlSeen.every((t) => t.includes(PURCHASE_DAY_SQL) && t.includes(">= DATE '1990-01-01'")),
      `${purchaseSqlSeen.length} queries; first: ${(purchaseSqlSeen[0] || '').replace(/\s+/g, ' ').slice(0, 160)}`);

    // ── B2 / D / E / H ──────────────────────────────────────────────────────
    check('B2 a fresh endcap is unobservable, not pending',
      (await stateOf(pool, ids.EC1)).fulfilment_state === 'unobservable');
    const po1 = await stateOf(pool, ids.PO1);
    check('D1 purchases-feed row → confirmed, evidence names purchase_orders and the order id',
      po1.fulfilment_state === 'confirmed' && po1.fulfilment_evidence.detector === 'purchase_orders'
      && po1.fulfilment_evidence.rows[0].purchase_ids[0] === 'PO-77001' && po1.fulfilment_evidence.rows[0].units === 12,
      JSON.stringify(po1.fulfilment_evidence));
    check('D2 the confirmed timestamp set by the walk was KEPT, not re-dated',
      String(po1.fulfilment_confirmed_at) === String(po1AfterWalk.fulfilment_confirmed_at));
    const inv1 = await stateOf(pool, ids.INV1);
    check('E1 matched invoice → confirmed; the failed parse (99 units) never counted',
      inv1.fulfilment_state === 'confirmed' && inv1.fulfilment_evidence.detector === 'invoice'
      && inv1.fulfilment_evidence.rows[0].units === 24 && inv1.fulfilment_evidence.rows[0].invoice_ids[0] === ids.INV1_DOC,
      JSON.stringify(inv1.fulfilment_evidence));
    const ex1 = await stateOf(pool, ids.EX1);
    check('H1 valid_through passed, nothing seen, nothing said → expired',
      ex1.fulfilment_state === 'expired' && ex1.fulfilment_evidence.decided_by === 'valid_through_passed_nothing_seen',
      JSON.stringify(ex1));

    // ── G: not_followed beats a 'did' claim ────────────────────────────────
    const nf1 = await stateOf(pool, ids.NF1);
    check('G1 fresh snapshot, no inflow, 30-day window closed → not_followed EVEN WITH a did claim',
      nf1.fulfilment_state === 'not_followed' && nf1.action_claim === 'did'
      && nf1.fulfilment_evidence.detector === 'stock_delta' && nf1.fulfilment_evidence.claim === 'did'
      && /owner said done/.test(nf1.fulfilment_evidence.conflict || ''),
      JSON.stringify(nf1));
    const nf1Eval = await evalRow(pool, ids.NF1, 30);
    check('G2 ...and action_taken on the closed window is the detector\'s FALSE, not the owner\'s TRUE',
      nf1Eval && nf1Eval.action_taken === false && nf1Eval.action_evidence.claim === 'did'
      && !JSON.stringify(nf1Eval.action_evidence).includes('owner_reported'),
      JSON.stringify(nf1Eval && nf1Eval.action_evidence));
    check('G3 the owner-facing sentence says both things',
      /No order seen.*You marked it done.*data shows no order/.test(evalSvc.fulfilmentSummary({
        state: nf1.fulfilment_state, evidence: nf1.fulfilment_evidence, claim: 'did', claim_at: TODAY,
        valid_through: daysAgo(21), action_type: 'reorder',
      })));

    // ── F: a claim with nothing to confirm it ──────────────────────────────
    const cl1Before = await evalRow(pool, ids.CL1, 7);
    check('F0 before the claim: pending, action unknown, scored on sales alone',
      (await stateOf(pool, ids.CL1)).fulfilment_state === 'pending' && cl1Before.action_taken === null && cl1Before.final_score != null);
    const claimed = await evalSvc.recordActionClaim(pool, CID, LID, ids.CL1, 'did', { syncgoPool: mockSyncgo });
    const cl1After = await evalRow(pool, ids.CL1, 7);
    check('F1 claim did → claimed; the response carries the state, the evidence and a sentence',
      claimed.ok === true && claimed.fulfilment_state === 'claimed' && claimed.evaluation === 'done'
      && claimed.fulfilment_evidence.claim === 'did' && /Marked done by you on .*; no order has appeared/.test(claimed.fulfilment_summary),
      JSON.stringify(claimed));
    check('F2 action_taken stays NULL and the claim sits beside it as a claim',
      cl1After.action_taken === null && cl1After.action_evidence.claim === 'did'
      && !JSON.stringify(cl1After.action_evidence).includes('owner_reported'));
    check('F3 final_score did not move', near(cl1Before.final_score, cl1After.final_score),
      `${cl1Before.final_score} -> ${cl1After.final_score}`);
    const pend1 = await evalSvc.getPendingActions(pool, CID, LID, { syncgoPool: mockSyncgo, nocache: true });
    const cl1Row = pend1.pending.find((p) => Number(p.rec_id) === Number(ids.CL1));
    check('F4 the pending list keeps the claimed row, flagged, so the UI shows "marked done" and never re-asks',
      cl1Row && cl1Row.action_claim === 'did' && cl1Row.fulfilment_state === 'claimed', JSON.stringify(cl1Row));
    const q = await evalSvc.getActionQuestion(pool, CID, LID, { syncgoPool: mockSyncgo });
    check('F5 the micro-question never asks about a claimed card',
      !q.question || Number(q.question.rec_id) !== Number(ids.CL1));

    // ── I: retract ─────────────────────────────────────────────────────────
    const retracted = await evalSvc.recordActionClaim(pool, CID, LID, ids.CL1, 'none', { syncgoPool: mockSyncgo });
    const cl1Retracted = await stateOf(pool, ids.CL1);
    check('I1 retract → pending; the claim is cleared on the row and in the evidence',
      retracted.ok === true && retracted.fulfilment_state === 'pending' && retracted.action_claim === null
      && cl1Retracted.fulfilment_state === 'pending' && cl1Retracted.action_claim === null
      && cl1Retracted.fulfilment_evidence.claim === undefined && cl1Retracted.fulfilment_evidence.decided_by === 'claim_retracted',
      JSON.stringify(cl1Retracted));
    await evalSvc.recordActionClaim(pool, CID, LID, ids.PO1, 'did', { syncgoPool: mockSyncgo });
    const po1Retract = await evalSvc.recordActionClaim(pool, CID, LID, ids.PO1, 'none', { syncgoPool: mockSyncgo });
    check('I2 retracting a claim on a CONFIRMED card changes nothing but the claim',
      po1Retract.fulfilment_state === 'confirmed' && po1Retract.action_claim === null
      && (await stateOf(pool, ids.PO1)).fulfilment_state === 'confirmed');

    // ── J: confirmed never downgrades ──────────────────────────────────────
    PURCHASE_ROWS = PURCHASE_ROWS.filter((r) => r.sku !== 'KEEP'); // the feed "forgets" the order
    await evalSvc.evaluateTenant(pool, CID, LID, { syncgoPool: mockSyncgo, force: true, onlyRecId: ids.KEEP });
    const keep = await stateOf(pool, ids.KEEP);
    check('J1 a later pass that sees nothing leaves a confirmed card confirmed, evidence intact',
      keep.fulfilment_state === 'confirmed' && keep.fulfilment_evidence.detector === 'purchase_orders'
      && keep.fulfilment_evidence.rows[0].purchase_ids[0] === 'PO-77002',
      JSON.stringify(keep));
    const keepWrite = await evalSvc.writeFulfilment(pool, CID, LID, ids.KEEP, { state: 'not_followed', evidence: { detector: 'stock_delta' } });
    check('J2 the writer itself refuses to downgrade', keepWrite.fulfilment_state === 'confirmed');
    let threw = false;
    try { await evalSvc.writeFulfilment(pool, CID, LID, ids.KEEP, { state: 'done', evidence: {} }); } catch { threw = true; }
    check('J3 the writer rejects a state the CHECK would reject', threw);

    // ── K: dismissal ───────────────────────────────────────────────────────
    const dm = await evalSvc.recordActionClaim(pool, CID, LID, ids.DM1, 'dismissed', { reason: 'Wrong product', syncgoPool: mockSyncgo });
    const dm1 = await stateOf(pool, ids.DM1);
    check('K1 dismissal keeps its reason and leaves the fulfilment state to the data',
      dm.ok === true && dm.evaluation === 'skipped' && dm1.action_claim === 'dismissed' && dm1.dismiss_reason === 'Wrong product'
      && dm1.fulfilment_state === 'pending', JSON.stringify(dm1));
    const pend2 = await evalSvc.getPendingActions(pool, CID, LID, { syncgoPool: mockSyncgo, nocache: true });
    check('K2 a dismissed card is not "waiting on you"',
      !pend2.pending.some((p) => Number(p.rec_id) === Number(ids.DM1)));
    check('K3 an unknown claim value is refused',
      await evalSvc.recordActionClaim(pool, CID, LID, ids.DM1, 'done').then(() => false, (e) => /must be one of/.test(e.message)));
    check('K4 a foreign rec is not found', (await evalSvc.recordActionClaim(pool, 12345, 1, ids.DM1, 'did', { syncgoPool: mockSyncgo })) === false);

    // ── L: /latest ─────────────────────────────────────────────────────────
    await evalSvc.recordActionClaim(pool, CID, LID, ids.CL1, 'did', { syncgoPool: mockSyncgo });
    let latest = null;
    try {
      latest = await recSvc.getLatest(pool, mockSyncgo, CID, LID);
    } catch (e) {
      console.warn('getLatest threw:', e.message);
    }
    const cards = latest ? [...(latest.recommendations || []), ...(latest.withheld || [])] : [];
    const card = (id) => cards.find((c) => Number(c.id) === Number(id));
    check('L1 /latest cards carry the fulfilment fields',
      cards.length === 7 && cards.every((c) => ['action_claim', 'action_claim_at', 'dismiss_reason', 'fulfilment_state', 'fulfilment_confirmed_at', 'fulfilment_summary'].every((k) => k in c)),
      `${cards.length} cards; keys ${cards[0] ? Object.keys(cards[0]).filter((k) => /fulfil|claim|dismiss/.test(k)).join(',') : 'none'}`);
    check('L2 the confirmed card reads confirmed with a sentence naming the order',
      card(ids.PO1)?.fulfilment_state === 'confirmed' && /^Confirmed: 12 units ordered on .*\(purchase order\)/.test(card(ids.PO1)?.fulfilment_summary || ''),
      JSON.stringify(card(ids.PO1) && { s: card(ids.PO1).fulfilment_state, t: card(ids.PO1).fulfilment_summary }));
    check('L3 the claimed card reads claimed, in the owner\'s words',
      card(ids.CL1)?.fulfilment_state === 'claimed' && card(ids.CL1)?.action_claim === 'did'
      && /Marked done by you/.test(card(ids.CL1)?.fulfilment_summary || ''));
    check('L4 the dismissed card carries its reason',
      card(ids.DM1)?.action_claim === 'dismissed' && card(ids.DM1)?.dismiss_reason === 'Wrong product');
    check('L5 the endcap reads unobservable and invites the claim',
      card(ids.EC1)?.fulfilment_state === 'unobservable' && /cannot show this kind of action/.test(card(ids.EC1)?.fulfilment_summary || ''));

    // ── The report, on the old run's window ────────────────────────────────
    const report = await evalSvc.getEffectiveness(pool, CID, LID, { windowDays: 30, sinceDays: 60 });
    check('R1 the report counts confirmed / claimed / not_followed apart',
      report.summary.confirmed === 4 && report.summary.acted_as_recommended === 4
      && report.summary.claimed === 1 && report.summary.not_followed === 1,
      JSON.stringify({ c: report.summary.confirmed, cl: report.summary.claimed, nf: report.summary.not_followed }));
    const ledger = await evalSvc.getEffectivenessLedger(pool, CID, LID, { windowDays: 30, sinceDays: 60, acted: 'false' });
    check('R2 the ledger\'s acted=false filter is not_followed, and the row names its detector',
      ledger.rows.length === 1 && Number(ledger.rows[0].rec_id) === Number(ids.NF1)
      && ledger.rows[0].fulfilment_state === 'not_followed' && ledger.rows[0].detector === 'stock_delta'
      && ledger.rows[0].acted_as_recommended === false,
      JSON.stringify(ledger.rows.map((r) => [r.rec_id, r.fulfilment_state, r.detector])));

    // ── M: the bounded wait ────────────────────────────────────────────────
    const queued = await evalSvc.recordActionClaim(pool, CID, LID, ids.EC1, 'did', { syncgoPool: mockSyncgo, waitMs: 0 });
    check('M1 with no time to wait the route answers "queued" with the synchronous state',
      queued.ok === true && queued.evaluation === 'queued' && queued.fulfilment_state === 'claimed', JSON.stringify(queued));
    await sleep(2500); // let the background re-evaluation finish before cleanup
    check('M2 ...and the background pass still lands', (await stateOf(pool, ids.EC1)).fulfilment_state === 'claimed');
  } finally {
    try { await cleanup(pool); } catch (e) { console.warn('cleanup failed:', e.message); }
    await pool.end();
  }
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error('verification crashed:', err); process.exit(1); });
