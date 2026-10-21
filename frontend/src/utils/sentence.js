// Present an engine's `reason` as a sentence.
//
// WHY THIS IS NEEDED. Every capability writes its refusal reason as a lowercase
// fragment, because they were written for briefings and log lines:
//
//     no sales data for this store
//     no location/geography on file for this store
//     this store's POS records no cashier on transactions
//     not enough nearby peer stores (3)
//     one id holds 48% of visits (looks like a system bucket)
//
// Those now reach an OWNER, as the explanatory paragraph of the "not available
// for your store" notice, where a lowercase fragment with no full stop reads
// like a truncated error rather than an answer. The engine strings themselves
// are load-bearing elsewhere - briefings, logs, tests all match on them - so
// the fix belongs here, at the boundary where prose becomes something someone
// reads, and nowhere else.
//
// Deliberately only capitalisation and a full stop. Rewording an engine's
// sentence would mean guessing at what it measured, and it knows that better
// than this function can.

/** Trailing punctuation that already ends a sentence. */
const TERMINATED = /[.!?…]["')\]]?$/;

/**
 * @param {unknown} text  a reason from an engine, or anything else
 * @returns {string|null} the same text as a sentence, or null if there is none
 */
export function sentence(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s) return null;
  // Capitalise only a lowercase LETTER: a reason that opens with a figure
  // ("3 of 5 stores...") or an already-capitalised word is left alone.
  const head = /^[a-z]/.test(s) ? s[0].toUpperCase() + s.slice(1) : s;
  return TERMINATED.test(head) ? head : `${head}.`;
}

export default sentence;
