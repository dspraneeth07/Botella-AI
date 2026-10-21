import {
  LEAD_DAYS, coverFromEngine, coverOf, deadlineFromCard, cardsBySku, rowFigures,
  localIso, parseLocalIso,
} from './cover';

/**
 * One deadline per bottle.
 *
 * Weber Ranch 1L, 19 October 2026. The Recommendations card read "selling about
 * 9.0 a week and you have 8 on hand - about 6 days of cover left ... Order by
 * Mon, Oct 19". The Purchasing row for the same bottle read "On hand 8 . Sold
 * 90d 121 . Qty to cover 28 . Order by Thu, Oct 22". Two causes: the card's
 * engine branch had its own arithmetic with a hard-coded seven-day lead while
 * this file's `coverOf` used three; and the card's quantity was the policy's
 * while the row's was the buying formula. Nothing stored either date.
 *
 * These pin the fix: the engine's stored `order_by` wins wherever it exists,
 * and where it does not there is ONE arithmetic on the engine's declared seven.
 */

// A fixed "today" so every assertion is about arithmetic, not the clock.
// Components form, not a string: a string would be parsed as UTC midnight.
const TODAY = new Date(2026, 9, 19); // Mon, 19 Oct 2026

const WEBER_ROW = { sku: 'WEBER1L', product_name: 'Weber Ranch 1L', on_hand: 8, units_90: 121, order_qty: 28 };
const WEBER_CARD = {
  id: 1, rank: 1, action_type: 'reorder', primary_skus: ['WEBER1L'],
  products: [{ sku: 'WEBER1L', product_name: 'Weber Ranch 1L' }],
  suggested_order_qty: 9, order_by: '2026-10-19', lead_time_days: 7, lead_time_basis: 'declared',
  engine_daily_rate: 9 / 7, engine_on_hand: 8, engine_days_cover: 6.2,
};

describe('the lead time the fallback arithmetic rests on', () => {
  test("is the engine's declared seven, not three", () => {
    // Three was never anyone's measured figure. It put Purchasing's date three
    // or four days after the card's on every bottle.
    expect(LEAD_DAYS).toBe(7);
  });
});

describe('coverFromEngine - the one arithmetic', () => {
  test("Weber Ranch on the engine's figures is due today, as the card said", () => {
    const c = coverFromEngine({ daily: 9 / 7, onHand: 8, daysCover: 6.2, today: TODAY });
    // 6.2 days of cover against a 7-day lead is inside the lead window.
    expect(c.dueInDays).toBe(0);
    expect(c.iso).toBe('2026-10-19');
    expect(c.weekly).toBeCloseTo(9, 5);
    expect(c.onHand).toBe(8);
    expect(c.leadDays).toBe(7);
  });

  test('floors the slack - a deadline is the last safe day', () => {
    // 20.6 days of cover, lead 7: 13.6 days of slack. The 13th day, never the
    // 14th, which is a day on which the shelf is already short.
    const c = coverFromEngine({ daily: 1, daysCover: 20.6, today: TODAY });
    expect(c.dueInDays).toBe(13);
    expect(c.iso).toBe('2026-11-01');
  });

  test("honours the card's own lead time when given one", () => {
    const declared = coverFromEngine({ daily: 1, daysCover: 20.6, today: TODAY });
    const measured = coverFromEngine({ daily: 1, daysCover: 20.6, leadDays: 3, today: TODAY });
    expect(measured.dueInDays).toBe(17);
    expect(measured.dueInDays - declared.dueInDays).toBe(4);
  });

  test('derives whichever of cover and on-hand the engine did not send', () => {
    const fromCount = coverFromEngine({ daily: 2, onHand: 10, today: TODAY });
    expect(fromCount.daysCover).toBe(5);
    const fromCover = coverFromEngine({ daily: 2, daysCover: 5, today: TODAY });
    expect(fromCover.onHand).toBe(10);
  });

  test('refuses rather than inventing: no rate, or neither figure, is null', () => {
    expect(coverFromEngine({ daily: 0, onHand: 8 })).toBeNull();
    expect(coverFromEngine({ daily: null, onHand: 8 })).toBeNull();
    expect(coverFromEngine({ daily: 2 })).toBeNull();
    expect(coverFromEngine()).toBeNull();
  });

  test('never dates the deadline in the past', () => {
    const c = coverFromEngine({ daily: 5, onHand: 1, today: TODAY }); // 0.2 days of cover
    expect(c.dueInDays).toBe(0);
    expect(c.iso).toBe('2026-10-19');
  });

  test('writes the date as the viewer sees it, never via toISOString', () => {
    const c = coverFromEngine({ daily: 1, daysCover: 7, today: TODAY });
    // Local midnight on the 19th + 0 days is the 19th in every timezone.
    expect(c.iso).toBe(localIso(TODAY));
    expect(c.iso).toBe('2026-10-19');
  });
});

describe('coverOf - a row with no card, through the same arithmetic', () => {
  test('agrees with coverFromEngine on identical inputs', () => {
    const viaRow = coverOf(WEBER_ROW, { today: TODAY });
    const viaEngine = coverFromEngine({ daily: 121 / 90, onHand: 8, today: TODAY });
    expect(viaRow.iso).toBe(viaEngine.iso);
    expect(viaRow.dueInDays).toBe(viaEngine.dueInDays);
    expect(viaRow.daysCover).toBeCloseTo(viaEngine.daysCover, 10);
    expect(viaRow.measured).toBe('buy_list');
    expect(viaRow.units90).toBe(121);
  });

  test('Weber Ranch on the 90-day average is ALSO due today now the lead is seven', () => {
    // 8 on hand at 121/90 a day is 5.95 days of cover. On a lead of three this
    // read Oct 22 - the row the owner saw. On the engine's seven it is today,
    // which is what the card said.
    const c = coverOf(WEBER_ROW, { today: TODAY });
    expect(c.iso).toBe('2026-10-19');
  });

  test('no sales in the window means no cover, not a deadline', () => {
    expect(coverOf({ on_hand: 12, units_90: 0 })).toBeNull();
    expect(coverOf(null)).toBeNull();
  });

  test('an out-of-stock row is due now - that is the point of flagging it', () => {
    const c = coverOf({ on_hand: 0, units_90: 30 }, { today: TODAY });
    expect(c.dueInDays).toBe(0);
    expect(c.daysCover).toBe(0);
  });
});

describe('deadlineFromCard - the server decides', () => {
  test("reads the engine's stored order_by as a local date", () => {
    const d = deadlineFromCard({ order_by: '2026-10-22', lead_time_days: 4, lead_time_basis: 'measured' }, TODAY);
    expect(d.iso).toBe('2026-10-22');
    expect(d.dueInDays).toBe(3);
    expect(d.clamped).toBe(false);
    expect(d.leadDays).toBe(4);
    expect(d.leadBasis).toBe('measured');
    expect(d.source).toBe('engine');
  });

  test('clamps a date behind the wall clock to today, and says so', () => {
    // The engine never dates before as_of, but as_of is the data frontier and
    // the frontier can lag. "Order by Saturday" on a Monday is a reproach.
    const d = deadlineFromCard({ order_by: '2026-10-17' }, TODAY);
    expect(d.iso).toBe('2026-10-19');
    expect(d.dueInDays).toBe(0);
    expect(d.clamped).toBe(true);
    expect(d.statedIso).toBe('2026-10-17');
  });

  test('no usable date is null, never today', () => {
    expect(deadlineFromCard(null, TODAY)).toBeNull();
    expect(deadlineFromCard({}, TODAY)).toBeNull();
    expect(deadlineFromCard({ order_by: null }, TODAY)).toBeNull();
    expect(deadlineFromCard({ order_by: 'Oct 19' }, TODAY)).toBeNull();
    expect(deadlineFromCard({ order_by: 20261019 }, TODAY)).toBeNull();
  });

  test('parses YYYY-MM-DD at LOCAL midnight', () => {
    const d = parseLocalIso('2026-10-19');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(9);
    expect(d.getDate()).toBe(19);
    expect(d.getHours()).toBe(0);
    expect(parseLocalIso('2026-10-19T04:00:00Z').getDate()).toBe(19);
  });
});

describe('cardsBySku', () => {
  test('indexes every SKU a card touches, first card winning', () => {
    const a = { rank: 1, primary_skus: ['S1'], products: [{ sku: 'S1' }, { sku: 'S2' }] };
    const b = { rank: 2, primary_skus: ['S2', 'S3'], products: [] };
    const m = cardsBySku([a, b]);
    expect(m.get('S1')).toBe(a);
    expect(m.get('S2')).toBe(a); // products[] reach, and rank 1 keeps it
    expect(m.get('S3')).toBe(b);
    expect(m.has('S4')).toBe(false);
  });

  test('tolerates empty and malformed input', () => {
    expect(cardsBySku(null).size).toBe(0);
    expect(cardsBySku([null, {}, { products: [null] }]).size).toBe(0);
  });
});

describe('rowFigures - the card and the row are one number', () => {
  test('the Weber Ranch row shows the card quantity and the card date', () => {
    const f = rowFigures(WEBER_ROW, WEBER_CARD, TODAY);
    expect(f.qty).toBe(9);
    expect(f.qtySource).toBe('card');
    expect(f.orderBy.iso).toBe('2026-10-19');
    expect(f.orderBy.source).toBe('engine');
    expect(f.card).toBe(WEBER_CARD);
  });

  test('and that is exactly what the card itself prints', () => {
    // The agreement, stated as a value: deadlineFromCard is what the card's
    // deadlineFor reads, rowFigures is what the Purchasing row reads.
    const card = deadlineFromCard(WEBER_CARD, TODAY);
    const row = rowFigures(WEBER_ROW, WEBER_CARD, TODAY);
    expect(row.orderBy.iso).toBe(card.iso);
    expect(row.orderBy.dueInDays).toBe(card.dueInDays);
    expect(row.qty).toBe(WEBER_CARD.suggested_order_qty);
  });

  test('a row with no card keeps the buying formula, on the shared seven', () => {
    const f = rowFigures(WEBER_ROW, undefined, TODAY);
    expect(f.qty).toBe(28);
    expect(f.qtySource).toBe('buying');
    expect(f.orderBy.source).toBe('buying');
    expect(f.orderBy.iso).toBe(coverOf(WEBER_ROW, { today: TODAY }).iso);
  });

  test('a card with a quantity but no stored date lends the quantity only', () => {
    const pre042 = { ...WEBER_CARD, order_by: null };
    const f = rowFigures(WEBER_ROW, pre042, TODAY);
    expect(f.qty).toBe(9);
    expect(f.qtySource).toBe('card');
    expect(f.orderBy.source).toBe('buying');
  });

  test('a markdown card lends nothing to a buy row', () => {
    // "Move it by" is not "order by", and a markdown has no order quantity.
    const markdown = { action_type: 'markdown', primary_skus: ['WEBER1L'], suggested_order_qty: null, order_by: null };
    const f = rowFigures(WEBER_ROW, markdown, TODAY);
    expect(f.qty).toBe(28);
    expect(f.qtySource).toBe('buying');
    expect(f.card).toBeNull();
  });

  test('a row with no quantity and no sales shows neither', () => {
    const f = rowFigures({ sku: 'X', on_hand: 3, units_90: 0 }, undefined, TODAY);
    expect(f.qty).toBeNull();
    expect(f.orderBy).toBeNull();
  });
});
