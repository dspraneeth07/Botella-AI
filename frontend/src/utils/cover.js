// cover.js
// -----------------------------------------------------------------------------
// How long the stock on hand lasts, and when it has to be ordered.
//
// ONE implementation, imported by both Purchasing and the recommendation cards.
// They used to disagree in public: Purchasing computed this from the buying
// query, while a recommendation card printed whatever date the model had put in
// `valid_through` and whatever velocity it had written into its prose. For
// Holladay Cask Strength that produced "about 22 bottles a week ... empty by
// September 20, order by Sep 21" on one screen and "Sat, Dec 5" on the other.
//
// The real figures were 26 on hand against 28 sold in 90 days - 2.2 bottles a
// week, 83 days of cover. The model was out by a factor of ten, and the card
// had no way to notice because nothing on it was derived from the data.
//
// So: the numbers on a card come from here, not from the model. The model is
// good at saying WHY something matters and poor at arithmetic it cannot check.
//
// AND THEN THEY DISAGREED AGAIN, with this file in place. Weber Ranch 1L,
// 19 October 2026: the card read "Order by Mon, Oct 19", the Purchasing row
// read "Thu, Oct 22". The card's engine branch in RecommendationsHome had its
// own copy of the arithmetic with a hard-coded seven-day lead; `coverOf` here
// used a lead of THREE, a figure that was never anyone's measured lead time.
// "One implementation" was true of the function and false of the callers.
//
// So, now:
//   1. The SERVER decides the deadline. The engine computes `order_by` once,
//      with the lead time the card actually quotes (measured per vendor where
//      receipts exist, the declared seven otherwise), and it is stored on the
//      recommendation (migration 042). `deadlineFromCard` reads it; the card
//      and the Purchasing row both show it. Agreement by construction.
//   2. Where there is no stored date - a card from before 042, a buy-list row
//      no card covers - `coverFromEngine` is the ONLY arithmetic, and
//      `LEAD_DAYS` is the engine's declared seven, so the fallback lands on
//      the same day the engine would have.
// -----------------------------------------------------------------------------

/**
 * Days between placing an order and the stock landing, when nothing better is
 * known. SEVEN: the engine's declared lead time
 * (`app/pipeline/policy/inventory.py` policy.lead_time_days.declared, and
 * `deterministic.LEAD_TIME_DAYS`). It was 3 here, which matched nothing - not
 * the engine, not any vendor's receipts - and is why Purchasing's date sat
 * three or four days later than the card's for every bottle.
 *
 * A card carries its own `lead_time_days` (measured for the vendor where Node
 * has receipts); use that when present. This is the figure for a row with no
 * card behind it.
 */
export const LEAD_DAYS = 7;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const finite = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);

/** Local midnight today (or of `now`), the anchor every date here counts from. */
export function startOfToday(now) {
  const d = now ? new Date(now) : new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * A calendar date as the VIEWER sees it, never via toISOString().
 *
 * `new Date()` with setHours(0,0,0,0) is LOCAL midnight. `toISOString()` then
 * converts to UTC, and on any timezone east of Greenwich that lands on the
 * PREVIOUS day: local midnight in IST is 18:30 UTC the day before, so
 * .slice(0, 10) returned yesterday.
 *
 * Observed, not theorised. On 29 September the cards read "Order by Mon,
 * Sep 28" - a deadline a day in the PAST, on a recommendation generated that
 * morning, which reads as either broken software or advice that arrived too
 * late. Both destroy trust in the number beside it.
 *
 * This is the same defect DAILY-CAPTURE.md section 4 documents on the backend,
 * where a Postgres date read back as local midnight and stringified a day
 * early. It was fixed there by keeping dates as strings at every boundary; the
 * frontend needs the same discipline, which is what this function is.
 */
export function localIso(d) {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * 'YYYY-MM-DD' to a Date at LOCAL midnight, or null for anything else.
 *
 * `new Date('2026-10-19')` is UTC midnight and reads as the 18th west of
 * Greenwich; the components form is local. Refuses non-strings and partial
 * strings rather than guessing: a deadline that cannot be parsed is no
 * deadline, not today's.
 */
export function parseLocalIso(iso) {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setHours(0, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole calendar days from local midnight `from` to local midnight `to`. */
function daysBetween(from, to) {
  // Round, not floor: a DST change makes the gap 23 or 25 hours and floor
  // would lose a day in spring.
  return Math.round((to - from) / 86400000);
}

/**
 * THE arithmetic. Cover and order-by from a daily rate and a shelf count.
 *
 * `daily` is units per day (the engine's open-day rate, or units_90 / 90 for a
 * row with no card). `daysCover` may be supplied - the engine's own figure -
 * or derived as onHand / daily; `onHand` may likewise be derived from
 * daysCover when the engine sent cover but no count. Null when the rate is not
 * positive: with no velocity there is no honest "days of cover", and a
 * fabricated one is how a bottle that has never sold ends up with a deadline.
 *
 * `dueInDays = max(0, floor(daysCover - leadDays))`, the same arithmetic as
 * the engine's `order_by_for` and the Buying tab's `_buy_row`. FLOOR, not
 * round: a deadline is the LAST safe day, and rounding 6.6 days of slack up to
 * 7 names a day on which the shelf is already short. Never negative: a product
 * already inside its lead window is due now, not three days ago.
 *
 * @param {{daily:number, onHand?:number, daysCover?:number, leadDays?:number, today?:Date}} args
 */
export function coverFromEngine({ daily, onHand, daysCover, leadDays, today } = {}) {
  const rate = finite(daily);
  if (rate == null || rate <= 0) return null;
  let cover = finite(daysCover);
  let have = finite(onHand);
  if (cover == null && have == null) return null;
  if (cover == null) cover = have / rate;
  if (have == null) have = cover * rate;
  const lead = finite(leadDays) != null && finite(leadDays) >= 0 ? finite(leadDays) : LEAD_DAYS;
  const dueInDays = Math.max(0, Math.floor(cover - lead));
  const date = startOfToday(today);
  date.setDate(date.getDate() + dueInDays);
  return {
    daily: rate,
    weekly: rate * 7,
    onHand: have,
    daysCover: cover,
    leadDays: lead,
    dueInDays,
    date,
    iso: localIso(date),
  };
}

/**
 * Cover and order-by for one buy-list row - the fallback for a row no card
 * covers. Same arithmetic as the card (`coverFromEngine`), on the row's 90-day
 * average and the shared LEAD_DAYS.
 *
 * Returns null when the product has no sales in the window. Out-of-stock rows
 * (on_hand 0) DO return a result - they are due now, which is the whole point
 * of flagging them.
 *
 * @param {{on_hand:number, units_90:number}} row
 * @param {{leadDays?:number, today?:Date}} [opts]
 */
export function coverOf(row, opts = {}) {
  if (!row) return null;
  const daily = num(row.units_90) / 90;
  if (daily <= 0) return null;
  const c = coverFromEngine({
    daily, onHand: num(row.on_hand), leadDays: opts.leadDays, today: opts.today,
  });
  return c ? { ...c, units90: num(row.units_90), measured: 'buy_list' } : null;
}

/**
 * The SERVER'S deadline for a card, when it sent one (migration 042).
 *
 * `card.order_by` is the engine's 'YYYY-MM-DD'. It is preferred over any
 * arithmetic here because it was computed with the lead time the card
 * actually quotes - measured for the vendor where receipts exist - and
 * because it is stored, so every surface can show the same day.
 *
 * Clamped to today on the viewer's clock, never earlier. The engine already
 * never dates it before `as_of`, but `as_of` is the data frontier and the
 * frontier can lag the wall clock by a day or more; the Buying tab applies the
 * same clamp for the same reason (`_buy_row`). An order-by in the past is not
 * information, it is a reproach. `clamped` says when this happened so a
 * surface can say "order today" rather than quietly moving the date.
 *
 * Null when the card carries no usable date - a markdown, the LLM path, a card
 * from before 042 - and the caller falls back to `coverFromEngine`.
 */
export function deadlineFromCard(card, today) {
  if (!card) return null;
  const stated = parseLocalIso(card.order_by);
  if (!stated) return null;
  const anchor = startOfToday(today);
  const clamped = stated < anchor;
  const date = clamped ? anchor : stated;
  return {
    iso: localIso(date),
    date,
    dueInDays: daysBetween(anchor, date),
    statedIso: localIso(stated),
    clamped,
    leadDays: finite(card.lead_time_days),
    leadBasis: typeof card.lead_time_basis === 'string' ? card.lead_time_basis : null,
    source: 'engine',
  };
}

/** "2.2 a week" / "9 a week" - one decimal only while it matters. */
export function rateLabel(weekly) {
  if (!Number.isFinite(weekly) || weekly <= 0) return null;
  return weekly >= 10 ? `${Math.round(weekly)} a week` : `${weekly.toFixed(1)} a week`;
}

/**
 * How the cover reads in a sentence. Deliberately vaguer than the arithmetic:
 * "about three weeks" is honest about a figure derived from a 90-day average,
 * where "20.6 days" would imply a precision the input does not carry.
 */
export function coverPhrase(daysCover) {
  if (!Number.isFinite(daysCover)) return null;
  if (daysCover <= 0) return 'out of stock now';
  if (daysCover < 1.5) return 'gone within a day';
  if (daysCover < 10) return `about ${Math.round(daysCover)} days of cover left`;
  if (daysCover < 70) return `about ${Math.round(daysCover / 7)} weeks of cover left`;
  return `about ${Math.round(daysCover / 30)} months of cover left`;
}

/** Index a buy_list (or any row list) by SKU for O(1) lookup from a rec card. */
export function bySku(rows) {
  const map = new Map();
  (rows || []).forEach((r) => {
    const k = r && r.sku != null ? String(r.sku) : null;
    if (k) map.set(k, r);
  });
  return map;
}

/**
 * Index the active cards by every SKU they touch - primary_skus and the full
 * products[] list, the same reach Purchasing's "Recommended" mark has - so a
 * buy-list row can find the card that covers it. The first card to claim a SKU
 * keeps it: /latest is ordered by rank, so that is the card the owner sees
 * highest on the Recommendations screen.
 */
export function cardsBySku(recs) {
  const map = new Map();
  (recs || []).forEach((card) => {
    if (!card) return;
    const skus = [
      ...(card.primary_skus || []),
      ...((card.products || []).map((p) => p && p.sku)),
    ];
    skus.forEach((s) => {
      if (s == null) return;
      const k = String(s);
      if (!map.has(k)) map.set(k, card);
    });
  });
  return map;
}

/**
 * What a Purchasing row shows for "Qty to cover" and "Order by", given the
 * card (if any) that covers its SKU.
 *
 * THE ONE-NUMBER RULE, applied at the row. When a card covers the SKU, the row
 * shows the CARD'S quantity (`suggested_order_qty`, the policy's order-up-to
 * figure) and the CARD'S stored deadline. The owner sees the same two numbers
 * on both screens because they are one number, not because two formulas
 * happened to agree. Without a card, the row keeps the buying tab's formula
 * for quantity and the shared arithmetic (on LEAD_DAYS) for the date.
 *
 * Each half falls back on its own: a card with a quantity but no stored date
 * (pre-042) lends the quantity and the date comes from the arithmetic; a card
 * with a date but no order quantity (a markdown has none) lends neither to a
 * buy row - a markdown's deadline is "move it by", not "order by".
 *
 * @returns {{qty:number|null, qtySource:'card'|'buying',
 *            orderBy:{date:Date, iso:string, dueInDays:number, source:'engine'|'buying'}|null,
 *            card:object|null}}
 */
export function rowFigures(row, card, today) {
  const cardQty = card ? finite(card.suggested_order_qty) : null;
  const useCard = cardQty != null && cardQty > 0;
  const qty = useCard ? cardQty : finite(row && row.order_qty);
  let orderBy = null;
  const fromCard = useCard ? deadlineFromCard(card, today) : null;
  if (fromCard) {
    orderBy = { date: fromCard.date, iso: fromCard.iso, dueInDays: fromCard.dueInDays, source: 'engine' };
  } else {
    const c = coverOf(row, { today });
    if (c) orderBy = { date: c.date, iso: c.iso, dueInDays: c.dueInDays, source: 'buying' };
  }
  return { qty, qtySource: useCard ? 'card' : 'buying', orderBy, card: useCard ? card : null };
}
