// Shared ask-budget for the two feedback prompts (in-chat banner + platform
// toast). One place decides whether ANY prompt may show, so the user is asked
// at most once per session and the asking rhythm persists across logins:
//
//   - answered (thumbs / stars / text)  -> quiet for 20 days, both flows
//   - dismissed (X)                     -> backoff: 3d, 7d, 14d, then 20d cap
//   - shown but ignored                 -> same gap as one dismissal (3d),
//                                          without growing the backoff
//   - brand-new user                    -> never ask in the first 24 hours
//
// State is per store in localStorage (same pattern as the daily digest
// cooldown); the once-per-session claim is per tab in sessionStorage.
const DAY_MS = 24 * 60 * 60 * 1000;
const ANSWER_QUIET_MS = 20 * DAY_MS;
const FIRST_SEEN_QUIET_MS = 1 * DAY_MS;
const DISMISS_BACKOFF_DAYS = [3, 7, 14, 20];

const SESSION_CLAIM_KEY = 'botella_fb_asked_session';

function storeKey() {
  let storeId = 'default';
  try { storeId = localStorage.getItem('botella_location_id') || 'default'; } catch { /* ignore */ }
  return `botella_fb_state_${storeId}`;
}

function readState() {
  try {
    const raw = localStorage.getItem(storeKey());
    const s = raw ? JSON.parse(raw) : {};
    return {
      firstSeen: Number(s.firstSeen) || 0,
      lastAsked: Number(s.lastAsked) || 0,
      lastAnswered: Number(s.lastAnswered) || 0,
      dismissCount: Number(s.dismissCount) || 0,
    };
  } catch {
    return { firstSeen: 0, lastAsked: 0, lastAnswered: 0, dismissCount: 0 };
  }
}

function writeState(s) {
  try { localStorage.setItem(storeKey(), JSON.stringify(s)); } catch { /* ignore */ }
}

function backoffMs(dismissCount) {
  const days = DISMISS_BACKOFF_DAYS[Math.min(dismissCount, DISMISS_BACKOFF_DAYS.length - 1)];
  return days * DAY_MS;
}

/** May a feedback prompt show right now? (Also stamps firstSeen on first call.) */
export function canAsk() {
  try {
    if (sessionStorage.getItem(SESSION_CLAIM_KEY) === '1') return false;
  } catch { /* ignore */ }
  const now = Date.now();
  const s = readState();
  if (!s.firstSeen) {
    writeState({ ...s, firstSeen: now });
    return false; // first sighting - let them use the product first
  }
  if (now - s.firstSeen < FIRST_SEEN_QUIET_MS) return false;
  if (s.lastAnswered && now - s.lastAnswered < ANSWER_QUIET_MS) return false;
  if (s.lastAsked && now - s.lastAsked < backoffMs(s.dismissCount)) return false;
  return true;
}

/** Claim this tab's single ask WITHOUT spending the durable budget.
 *
 *  For the in-chat chip, which is no longer rate-limited: it asks on the first
 *  message of every new chat. It still claims the session so the 5-minute toast
 *  cannot appear alongside it, but it must not stamp lastAsked - doing that on
 *  every new conversation would push the toast's backoff to its 20-day cap and
 *  silence the other flow permanently. */
export function claimSession() {
  try { sessionStorage.setItem(SESSION_CLAIM_KEY, '1'); } catch { /* ignore */ }
}

/** Call when a rate-limited prompt shows: claims this session's single ask and
 *  stamps lastAsked (so even an ignored prompt waits the base gap). */
export function claimAsk() {
  try { sessionStorage.setItem(SESSION_CLAIM_KEY, '1'); } catch { /* ignore */ }
  writeState({ ...readState(), lastAsked: Date.now() });
}

/** User responded (thumbs / stars / wrote to us): 20 days of quiet, and the
 *  dismissal backoff resets. */
export function recordAnswer() {
  const s = readState();
  writeState({ ...s, lastAnswered: Date.now(), dismissCount: 0 });
}

/** User explicitly dismissed (X): grow the backoff. */
export function recordDismiss() {
  const s = readState();
  writeState({ ...s, lastAsked: Date.now(), dismissCount: s.dismissCount + 1 });
}

// ── Server sync ──────────────────────────────────────────────────────────────
// The feedback table is the durable record: GET /api/feedback/status returns
// when this store last gave ANY feedback. Adopting it as lastAnswered makes the
// 20-day quiet period hold across devices and cleared browsers. Fetched at most
// once per session; failures fall back to local state (never blocks a prompt
// decision - canAsk() stays synchronous).
let syncStarted = false;

export function syncFromServer(apiBase, authToken) {
  if (syncStarted || !apiBase || !authToken) return;
  syncStarted = true;
  fetch(`${apiBase}/feedback/status`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
      'ngrok-skip-browser-warning': 'true',
    },
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const ts = d && d.last_feedback_at ? Date.parse(d.last_feedback_at) : 0;
      if (!ts) return;
      const s = readState();
      if (ts > s.lastAnswered) writeState({ ...s, lastAnswered: ts });
    })
    .catch(() => { /* local state is the fallback */ });
}
