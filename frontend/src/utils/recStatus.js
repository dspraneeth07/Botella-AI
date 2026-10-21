// recStatus.js
// -----------------------------------------------------------------------------
// Status model for recommendations: Open → Accepted → Marked done → Completed,
// or Dismissed (with a reason).
//
// THE SERVER DECIDES. Until migration 039 "Completed" was a localStorage entry
// written the moment the owner clicked "Mark complete" - true in that browser,
// on that device, whatever the shelf did. Now every card from /latest carries
//
//   fulfilment_state   what the DATA says: pending | claimed | confirmed |
//                      not_followed | unobservable | expired
//   action_claim       what the OWNER said: did | did_not | dismissed | null
//   user_vote          the thumb: 'up' | 'down' | null
//
// and the four-state status the screen draws is DERIVED from those, by
// `deriveStatus`, with one hard rule: 'completed' only when fulfilment_state
// is 'confirmed' - a purchases-feed row, a matched invoice, a stock inflow, a
// price drop, a catalogue arrival. The owner's click is 'claimed' ("Marked
// done") until the data confirms or refutes it.
//
// localStorage is now an OPTIMISTIC OVERLAY, nothing more. A click writes the
// expected status here first so the card moves at once; the server's answer
// (the POST's response, then every /latest fetch) overrides it through
// `reconcile`. Between fetches the overlay wins, because the list in memory is
// stale the instant the owner acts and nothing re-fetches it until the next
// load. The overlay never outranks a server field it disagrees with once that
// field has been seen.
//
// The old key (botella_rec_status_v1) is migrated once: its 'completed' rows
// become 'claimed' - that is what they always were - and everything else
// carries over. Its timestamps (accepted_at, completed_at → claimed_at,
// dismissed_at) are kept; the server records that a claim happened and when,
// not these finer moments, so they still live here.
// -----------------------------------------------------------------------------

const KEY = 'botella_rec_status_v2';
const LEGACY_KEY = 'botella_rec_status_v1';
const listeners = new Set();

export const STATUSES = ['open', 'accepted', 'claimed', 'completed', 'dismissed'];

function readRaw(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

/**
 * One-time migration of the v1 map. A v1 'completed' was a click, so it
 * becomes 'claimed' with its completed_at kept as claimed_at; the server will
 * say 'completed' if and when the data confirms it. The v1 key is removed so
 * this cannot run twice and resurrect a status the server has since replaced.
 */
export function migrateLegacy(v1) {
  const out = {};
  for (const [id, entry] of Object.entries(v1 || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const next = { ...entry };
    if (next.status === 'completed') {
      next.status = 'claimed';
      if (next.completed_at && !next.claimed_at) next.claimed_at = next.completed_at;
      delete next.completed_at;
    }
    if (!STATUSES.includes(next.status)) next.status = 'open';
    next.migrated_from = 'v1';
    out[id] = next;
  }
  return out;
}

function readAll() {
  const v2 = readRaw(KEY);
  if (v2 && typeof v2 === 'object') return v2;
  const v1 = readRaw(LEGACY_KEY);
  if (v1 && typeof v1 === 'object') {
    const migrated = migrateLegacy(v1);
    try {
      localStorage.setItem(KEY, JSON.stringify(migrated));
      localStorage.removeItem(LEGACY_KEY);
    } catch { /* storage unavailable - the migrated map is still returned */ }
    return migrated;
  }
  return {};
}
function writeAll(map) {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* storage unavailable */ }
  listeners.forEach((fn) => { try { fn(map); } catch { /* ignore */ } });
}

export const DISMISS_REASONS = [
  'Already done',
  'Wrong product',
  'Wrong timing',
  'Disagree with the rationale',
  'Other',
];

/**
 * Which server claim a dismissal reason really is.
 *
 * "Already done" is the odd one out and the only one that matters to get right:
 * its plain meaning is that the action WAS taken, which is the opposite of
 * every other reason under the same button. Filing it as 'dismissed' would
 * record a completed action as a refusal, and then the shelf movement that
 * followed would have no explanation.
 *
 * It is sent as 'did' - a CLAIM. The card then shows as "Marked done", not
 * "Completed": the owner says it was already on order, and the data will say
 * whether an order appears. The reason text travels with it (dismiss_reason,
 * migration 039) so "Already done" is still readable on the row.
 *
 * The other four are genuine refusals and carry no claim about the shelf.
 */
export function claimForDismissal(reason) {
  return reason === 'Already done' ? 'did' : 'dismissed';
}

/**
 * The status the SERVER's fields imply, or null when the card carries none
 * (an older backend, or a list that has not been enriched). Precedence:
 *
 *   confirmed                 → completed   (the data showed it; nothing else counts)
 *   claimed                   → claimed     (the owner said so; the data has not)
 *   action_claim 'dismissed'  → dismissed
 *   user_vote 'up'            → accepted
 *   otherwise                 → open
 *
 * A 'did' claim on a not_followed card is NOT 'claimed': the data has refuted
 * it, so the card goes back to open/accepted and the screen shows the
 * "Not followed" treatment with the server's sentence saying both things.
 */
export function deriveStatus(rec) {
  if (!rec) return null;
  const fs = rec.fulfilment_state;
  const claim = rec.action_claim;
  const vote = rec.user_vote;
  const hasServerFields = fs !== undefined || claim !== undefined;
  if (!hasServerFields) return null;
  if (fs === 'confirmed') return 'completed';
  if (fs === 'claimed') return 'claimed';
  if (claim === 'dismissed') return 'dismissed';
  if (vote === 'up' || vote === 1) return 'accepted';
  return 'open';
}

/** { status, reason?, accepted_at?, claimed_at?, dismissed_at?, ...server meta } */
export function getStatus(id) {
  return readAll()[id] || { status: 'open' };
}

/**
 * The optimistic write. `meta.reason` is kept on a dismissal; a 'claimed'
 * write stamps claimed_at. Returns the stored entry.
 */
export function setStatus(id, status, meta = {}) {
  const map = readAll();
  const now = new Date().toISOString();
  const prev = map[id] || {};
  const next = { ...prev, status };
  if (status === 'accepted' && !next.accepted_at) next.accepted_at = now;
  if (status === 'claimed') next.claimed_at = now;
  if (status === 'completed' && !next.confirmed_at) next.confirmed_at = now;
  if (status === 'dismissed') { next.reason = meta.reason || 'Other'; next.dismissed_at = now; }
  if (status === 'open') { delete next.reason; }
  if (meta.summary !== undefined) next.summary = meta.summary;
  // The optimistic stamp: `withStatus` prefers this entry over the card's
  // (now stale) server fields until the next reconcile or POST response
  // writes server_seen_at past it.
  next.optimistic_at = now;
  map[id] = next;
  writeAll(map);
  return next;
}

/**
 * Fold one card's server fields into the overlay - called with the body of a
 * successful POST (/action-claim returns fulfilment_state and the sentence)
 * so a store whose feed already holds the order reads Completed on the same
 * click. Fields the body does not carry are left as they were.
 */
export function applyServerState(id, body) {
  if (!body) return getStatus(id);
  const map = readAll();
  const prev = map[id] || {};
  const merged = { ...prev };
  if ('fulfilment_state' in body) merged.fulfilment_state = body.fulfilment_state;
  if ('action_claim' in body) merged.action_claim = body.action_claim;
  if ('fulfilment_summary' in body) merged.summary = body.fulfilment_summary;
  if ('fulfilment_confirmed_at' in body && body.fulfilment_confirmed_at) merged.confirmed_at = body.fulfilment_confirmed_at;
  if ('dismiss_reason' in body && body.dismiss_reason) merged.reason = body.dismiss_reason;
  const derived = deriveStatus({
    fulfilment_state: merged.fulfilment_state,
    action_claim: merged.action_claim,
    user_vote: prev.user_vote,
  });
  if (derived) {
    merged.status = derived;
    merged.server_seen_at = new Date().toISOString();
    // The server has answered THIS click: the optimistic stamp is spent, and
    // this entry now knows more than the list in memory does - until the next
    // fetch reconciles, it speaks for the card.
    delete merged.optimistic_at;
    merged.fresher_than_list = true;
  }
  map[id] = merged;
  writeAll(map);
  return merged;
}

/**
 * THE SERVER OVERRIDES THE OVERLAY. Called with every /latest list: for each
 * card that carries server fields, the derived status replaces whatever the
 * overlay held, and the server's sentence, claim and state are kept on the
 * entry so the card can print them. Cards without server fields (older
 * backend) keep their local status. Writes once; notifies subscribers once.
 */
export function reconcile(recs) {
  const map = readAll();
  let changed = false;
  for (const r of recs || []) {
    const derived = deriveStatus(r);
    if (!derived) continue;
    const prev = map[r.id] || {};
    const next = {
      ...prev,
      status: derived,
      fulfilment_state: r.fulfilment_state ?? prev.fulfilment_state ?? null,
      action_claim: r.action_claim ?? null,
      user_vote: r.user_vote ?? null,
      summary: r.fulfilment_summary ?? prev.summary ?? null,
      ...(r.dismiss_reason ? { reason: r.dismiss_reason } : {}),
      ...(r.fulfilment_confirmed_at ? { confirmed_at: r.fulfilment_confirmed_at } : {}),
      ...(r.action_claim_at && r.action_claim === 'did' && !prev.claimed_at ? { claimed_at: r.action_claim_at } : {}),
      server_seen_at: new Date().toISOString(),
    };
    // A fetch is the server's word on every card it lists: whatever click
    // was pending is now either reflected in these fields or overruled, and
    // a POST response folded in earlier is no longer fresher than the list.
    delete next.optimistic_at;
    delete next.fresher_than_list;
    if (derived === 'accepted' && !next.accepted_at) next.accepted_at = next.server_seen_at;
    if (JSON.stringify(next) !== JSON.stringify(prev)) { map[r.id] = next; changed = true; }
  }
  if (changed) writeAll(map);
  return map;
}

/**
 * Merge status onto a live recommendation list. The server's fields on the
 * card win when present; the overlay fills in for cards without them and
 * carries the finer timestamps either way. Unknown ids default to open.
 *   _status      open | accepted | claimed | completed | dismissed
 *   _statusMeta  the overlay entry (timestamps, reason, summary)
 *   _fulfilment  the server's fulfilment_state, when known
 */
export function withStatus(recs) {
  const map = readAll();
  return (recs || []).map((r) => {
    const local = map[r.id] || {};
    const fromServer = deriveStatus(r);
    // Between a click and the next fetch the list in memory is stale: an
    // optimistic write wins until the next reconcile (or the POST's own
    // response) clears its stamp. No timestamp comparison - a click and a
    // fetch can land in the same millisecond, and the later EVENT must win.
    // The same holds for a POST response already folded in: it is the
    // server's answer to a click the list has not seen yet.
    const localWins = Boolean(local.status && (local.optimistic_at || local.fresher_than_list));
    const status = (localWins && local.status) || fromServer || local.status || 'open';
    return {
      ...r,
      _status: status,
      _statusMeta: local,
      _fulfilment: r.fulfilment_state ?? local.fulfilment_state ?? null,
    };
  });
}

export function counts(recs) {
  const withS = withStatus(recs);
  return {
    open: withS.filter((r) => r._status === 'open').length,
    accepted: withS.filter((r) => r._status === 'accepted').length,
    claimed: withS.filter((r) => r._status === 'claimed').length,
    completed: withS.filter((r) => r._status === 'completed').length,
  };
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test seam. */
export const _keys = { KEY, LEGACY_KEY };
