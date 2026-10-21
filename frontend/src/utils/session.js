// Session lifetime: the auth keys every sign-out path clears, plus the
// idle-timeout rule that signs a user out after a long stretch of doing
// nothing.
//
// Why idle logout exists: the JWT is valid for 24h, so a browser left open on
// a shop counter stays signed in all day and overnight. Expiring the session
// after a few idle hours means an unattended machine stops being an open door.
//
// Scope: this is a CLIENT-side timeout. It clears local credentials so the app
// stops using them; it does not revoke the JWT, which the backend still honours
// until its own 24h expiry.

import { clearStoreAgentCache } from '../storeagent/StoreAgentPanel';

// Everything written at login (see LoginPage) - one list, so no sign-out path
// can forget a key and leave half a session behind.
const AUTH_KEYS = [
  'botella_token',
  'botella_client_id',
  'botella_location_id',
  'botella_client_name',
  'botella_location_name',
  'botella_username',
  'botella_session_started',
];

// Last time the user actually did something, as epoch ms. In localStorage, not
// memory, so it survives reloads and is shared across tabs: activity in one tab
// keeps the others alive, and a reload cannot silently reset the clock.
const LAST_ACTIVITY_KEY = 'botella_last_activity';

// 3.5h, between the 3-4h the product asked for. Override with
// REACT_APP_IDLE_TIMEOUT_MINUTES (0 or negative disables the timeout).
const IDLE_TIMEOUT_MINUTES = Number(process.env.REACT_APP_IDLE_TIMEOUT_MINUTES ?? 210);
export const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MINUTES * 60 * 1000;
export const IDLE_LOGOUT_ENABLED = IDLE_TIMEOUT_MINUTES > 0;

// Activity is recorded at most this often. Without it every mousemove would
// hit localStorage; second-level precision is meaningless against a 3.5h limit.
export const ACTIVITY_WRITE_THROTTLE_MS = 30_000;

/** Clear all client-side credentials. Used by logout, 401 handling and idle. */
export function clearSession() {
  try {
    AUTH_KEYS.forEach((k) => localStorage.removeItem(k));
    localStorage.removeItem(LAST_ACTIVITY_KEY);
  } catch {
    /* private mode / storage disabled - nothing to clear */
  }
  clearStoreAgentCache();
}

export function markActivity(now = Date.now()) {
  try {
    localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
  } catch {
    /* ignore */
  }
}

export function getLastActivity() {
  try {
    const raw = Number(localStorage.getItem(LAST_ACTIVITY_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Has the session been idle past the limit?
 * A missing timestamp counts as NOT idle and is stamped by the caller - an
 * existing session from before this feature shipped must not be logged out on
 * its next page load.
 */
export function isSessionIdle(now = Date.now()) {
  if (!IDLE_LOGOUT_ENABLED) return false;
  const last = getLastActivity();
  if (last == null) return false;
  return now - last > IDLE_TIMEOUT_MS;
}
