// crossLink.js
// -----------------------------------------------------------------------------
// Carrying "which rows did you mean" across a screen change.
//
// Two directions, and only one of them existed:
//
//   recommendations -> a report   `botella_ref_highlight`, read by Purchasing.
//   a report -> recommendations   NOTHING. The "5 recommendations ->" buttons
//                                 on Market Comparison, Purchasing and
//                                 Customers navigated and landed the reader on
//                                 an unfiltered list of ten cards with nothing
//                                 marked, which is the same as not linking.
//
// Both directions now use this module, so a third screen wanting the same
// affordance does not invent a fourth key shape.
//
// sessionStorage, not a route param: the payload is a list of ids that means
// nothing in a URL a reader might share, and it is READ-ONCE - consuming it
// removes it, so a later manual visit to the screen is not still highlighting
// a selection the reader has forgotten making.
// -----------------------------------------------------------------------------

const REC_KEY = 'botella_rec_highlight';

/**
 * Hand a set of recommendation ids to the recommendations screen.
 * @param {Array<string|number>} recIds
 * @param {string} label  where the reader came from, shown on the banner
 */
export function markRecommendations(recIds, label) {
  const ids = (recIds || []).map(String).filter(Boolean);
  if (!ids.length) return;
  try {
    sessionStorage.setItem(REC_KEY, JSON.stringify({ ids, label: label || null }));
  } catch { /* storage unavailable - the link still navigates, just unmarked */ }
}

/** Read and CLEAR the pending recommendation highlight. */
export function takeRecommendationHighlight() {
  try {
    const raw = sessionStorage.getItem(REC_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(REC_KEY);
    const parsed = JSON.parse(raw);
    const ids = (parsed && parsed.ids) || [];
    return ids.length ? { ids: ids.map(String), label: parsed.label || null } : null;
  } catch {
    return null;
  }
}
