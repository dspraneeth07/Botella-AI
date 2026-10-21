// mainFold.js
// -----------------------------------------------------------------------------
// Which open cards lead the Recommendations screen, and which fold.
//
// THE RULE. The main fold is the top cards by estimated value - BUT every
// distinct non-reorder action type present in the slate is guaranteed at
// least one place, taking the highest-ranked card of that type, and the
// places come out of the lowest-value cards whose type already holds more
// than one seat (reorders first). The total never exceeds the limit.
//
// WHY. "I want to see which external signals exist and their impact on the
// recommendations; do not show me only reorder." The frontend's dollar
// estimate (`groundedValue`) is bounded by measured demand and is honest about
// what it cannot value: a markdown, a bundle, a stock_new, a pre_stock or a
// cold_box card gets $0 and the words "No sales history to project from". Under
// a pure value sort those are exactly the cards that sink into "N more
// recommendations - lower estimated value", so the owner opened the screen to
// five reorders every morning while the engine's event, trend and clearance
// work sat one click away, unseen. The engine ranked those cards into the
// slate on purpose; the fold should not undo that because the browser cannot
// put a number on them.
//
// What this does NOT do: it does not invent a value for the reserved cards,
// does not reorder the fold (the caller still sorts by value), and does not
// displace a type's only representative - a reorder is never dropped to make
// room if it is the last reorder on the list. When more types are present
// than seats can be freed, the remaining types fold; the cap wins.
// -----------------------------------------------------------------------------

/** A card is a reorder unless it says otherwise; a missing type reserves nothing. */
const typeOf = (card) => (card && card.action_type ? String(card.action_type) : null);
const rankOf = (card) => (card && Number.isFinite(Number(card.rank)) ? Number(card.rank) : 99);

/**
 * Select the main-fold cards.
 *
 * @param {object[]} cards  open cards ALREADY in display order (value desc,
 *   then rank) - the output keeps this relative order.
 * @param {number} limit    MAIN_CARD_LIMIT
 * @returns {object[]}      at most `limit` cards, in input order
 */
export function mainFold(cards, limit) {
  const list = Array.isArray(cards) ? cards : [];
  const cap = Math.max(0, Number(limit) || 0);
  if (list.length <= cap) return list.slice();

  // Seats by value, as before.
  const chosen = list.slice(0, cap);
  const chosenSet = new Set(chosen);

  // One candidate per non-reorder type: the highest-ranked card of that type
  // (lowest rank; ties fall to the more valuable one, i.e. earlier in input).
  const candidates = new Map();
  for (const card of list) {
    const t = typeOf(card);
    if (!t || t === 'reorder') continue;
    const cur = candidates.get(t);
    if (!cur || rankOf(card) < rankOf(cur)) candidates.set(t, card);
  }

  const seats = () => {
    const n = new Map();
    for (const c of chosen) n.set(typeOf(c), (n.get(typeOf(c)) || 0) + 1);
    return n;
  };

  // Types with no seat, most important first (the engine's rank).
  const missing = [...candidates.entries()]
    .filter(([t]) => !chosen.some((c) => typeOf(c) === t))
    .sort((a, b) => rankOf(a[1]) - rankOf(b[1]));

  for (const [, card] of missing) {
    const count = seats();
    // The seat to free: lowest value first (the end of `chosen`), only from a
    // type holding more than one seat, reorders before anything else.
    const displaceable = (pred) => {
      for (let i = chosen.length - 1; i >= 0; i -= 1) {
        const c = chosen[i];
        if ((count.get(typeOf(c)) || 0) > 1 && pred(c)) return i;
      }
      return -1;
    };
    let idx = displaceable((c) => typeOf(c) === 'reorder');
    if (idx < 0) idx = displaceable(() => true);
    if (idx < 0) break; // nothing can be freed without dropping a type's only card
    chosenSet.delete(chosen[idx]);
    chosen.splice(idx, 1);
    chosen.push(card);
    chosenSet.add(card);
  }

  // Back to the caller's order.
  return list.filter((c) => chosenSet.has(c));
}

export default mainFold;
