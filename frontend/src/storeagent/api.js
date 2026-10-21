import { retrievalError } from './retrieval';
import { API_BASE as ENV_API_BASE } from '../utils/env';
// API client for the StoreAgent capabilities.
//
// These calls go through the SAME Node backend as the rest of BottleAI
// (REACT_APP_API_URL), under /storeagent. The Node side proxies them to the
// external Python service and injects the logged-in store from the JWT - so
// there is one origin to host/tunnel, the normal auth header is reused, and the
// browser never talks to the Python service directly.

const API_BASE = ENV_API_BASE;
const BASE = `${API_BASE.replace(/\/+$/, '')}/storeagent`;

// Same auth shape the rest of the app uses (Bearer token + the ngrok/devtunnel
// skip header).
function authHeaders() {
  const token = localStorage.getItem('botella_token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'ngrok-skip-browser-warning': 'true',
  };
}

// Every capability failure in the panel comes through here, so this is where
// it gets its reading: a store that has no such tables is not the same event
// as our service being down, and `retrievalError` is what tells them apart.
// A bare Error would reach the panel as "Something went wrong" with no way to
// recover the difference.
async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) throw await retrievalError(res, `HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

export const getHealth = () => getJSON('/health');

export const getCapabilities = () =>
  getJSON('/capabilities').then((d) => d.capabilities);

// Cache freshness only: { capability: computed_at ISO }. Tiny next to a real
// capability payload, so the panel can poll it while the login-triggered
// recompute runs and re-read only what actually changed.
export const getCacheStatus = () => getJSON('/cache-status').then((d) => d.computed_at || {});

// Base capability result. Store/location are resolved server-side from the JWT.
// opts.nocache (the refresh button) recomputes and overwrites the cached row.
// opts.window (30/60/90, inventory only) reruns the analysis over that lookback.
export function getCapability(capability, opts = {}) {
  const params = new URLSearchParams();
  if (opts.nocache) params.set('nocache', '1');
  if (opts.window) params.set('window', String(opts.window));
  const qs = params.toString();
  return getJSON(`/${capability}${qs ? `?${qs}` : ''}`);
}

// AI narration only - fetched separately so toggling AI never reloads the view.
// Returns the narration object ({ available, text, error }).
export function getNarration(capability, opts = {}) {
  const params = new URLSearchParams();
  if (opts.window) params.set('window', String(opts.window));
  const qs = params.toString();
  return getJSON(`/${capability}/narration${qs ? `?${qs}` : ''}`).then((d) => d.narration || d);
}
