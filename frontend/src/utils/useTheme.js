// useTheme.js
// -----------------------------------------------------------------------------
// ONE theme source for the whole product.
//
// There are two different things here and conflating them is what makes theme
// code go wrong:
//
//   PREFERENCE  what the user chose: 'light' | 'dark' | 'system'. Persisted.
//   RESOLVED    what is actually painted: 'light' | 'dark'. Never persisted,
//               because under 'system' it can change while the app is open.
//
// `data-theme` on <html> always carries the RESOLVED value, so every stylesheet
// keeps its simple two-state contract and nothing downstream has to know that
// 'system' exists. Under 'system' we subscribe to the OS setting and re-stamp
// the attribute when it flips - without that, choosing System would just freeze
// whatever the OS happened to be at load.
//
// ChatPage, LoginPage and SiteHeader all call this, so the signed-in app, the
// login screen and the marketing site can never disagree about the theme.
// -----------------------------------------------------------------------------

import { useState, useEffect, useCallback } from 'react';

export const THEME_KEY = 'botella_theme';

// 'system' is the default for a new visitor: matching the OS is the least
// surprising first impression, and it is what the OS-level setting is for.
export const DEFAULT_PREFERENCE = 'system';

const VALID = ['light', 'dark', 'system'];

const mql = () => (typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null);

export function systemTheme() {
  const m = mql();
  return m && m.matches ? 'dark' : 'light';
}

export function readPreference() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return VALID.includes(saved) ? saved : DEFAULT_PREFERENCE;
  } catch {
    // Private mode / storage disabled. Follow the OS rather than guessing.
    return DEFAULT_PREFERENCE;
  }
}

export function resolveTheme(preference) {
  return preference === 'system' ? systemTheme() : preference;
}

// Stamps <html data-theme>. Exported so index.js can call it before React
// mounts - otherwise the page paints the default register for one frame and
// flashes to the chosen one.
export function applyTheme(preference) {
  const resolved = resolveTheme(preference);
  document.documentElement.setAttribute('data-theme', resolved);
  return resolved;
}

export function useTheme() {
  const [preference, setPreferenceState] = useState(readPreference);
  const [resolved, setResolved] = useState(() => resolveTheme(readPreference()));

  // Paint whatever the preference resolves to, and persist the PREFERENCE.
  useEffect(() => {
    setResolved(applyTheme(preference));
    try { localStorage.setItem(THEME_KEY, preference); } catch { /* storage disabled */ }
  }, [preference]);

  // Under 'system', follow the OS while the app is open. Bound only in that
  // mode, so an explicit choice is never overridden by the OS changing.
  useEffect(() => {
    if (preference !== 'system') return undefined;
    const m = mql();
    if (!m) return undefined;
    const onChange = () => setResolved(applyTheme('system'));
    // Safari < 14 has addListener only.
    if (m.addEventListener) m.addEventListener('change', onChange);
    else m.addListener(onChange);
    return () => {
      if (m.removeEventListener) m.removeEventListener('change', onChange);
      else m.removeListener(onChange);
    };
  }, [preference]);

  // Another tab changing the preference should not leave this one stale.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === THEME_KEY) setPreferenceState(readPreference());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setPreference = useCallback((next) => {
    setPreferenceState(VALID.includes(next) ? next : DEFAULT_PREFERENCE);
  }, []);

  return { preference, resolved, setPreference };
}
