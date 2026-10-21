// Signs the user out after a long idle stretch. Mounted once, in
// ProtectedRoute, so it covers every authenticated view.
//
// "Idle" means no real interaction anywhere in the app. Activity is written to
// localStorage (throttled), so it is shared across tabs and survives reloads -
// working in one tab keeps the whole session alive, and reloading cannot reset
// the clock to buy another full window.

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  ACTIVITY_WRITE_THROTTLE_MS,
  IDLE_LOGOUT_ENABLED,
  clearSession,
  getLastActivity,
  isSessionIdle,
  markActivity,
} from './session';

// Deliberately not mousemove: a nudged mouse, a scrolling ticker or a trackpad
// resting under a sleeve should not keep an unattended terminal signed in.
// These all require intent.
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];

// How often the timeout is checked. A minute is plenty against a 3.5h limit and
// costs nothing; the visibility handler covers the case of a machine that slept
// through several checks.
const CHECK_INTERVAL_MS = 60_000;

export default function useIdleLogout() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!IDLE_LOGOUT_ENABLED) return undefined;

    // First run of a session (or one predating this feature) has no timestamp:
    // start the clock rather than treating unknown as expired.
    if (getLastActivity() == null) markActivity();

    let lastWrite = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - lastWrite < ACTIVITY_WRITE_THROTTLE_MS) return;
      lastWrite = now;
      markActivity(now);
    };

    const expire = () => {
      clearSession();
      // replace: the expired view must not be reachable with Back.
      navigate('/login?reason=idle', { replace: true });
    };

    const check = () => {
      if (isSessionIdle()) expire();
    };

    // A tab hidden for hours (laptop closed) misses its interval ticks, so
    // re-check the moment it comes back rather than waiting a further minute.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') check();
    };

    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    document.addEventListener('visibilitychange', onVisibility);
    const timer = setInterval(check, CHECK_INTERVAL_MS);

    check(); // catches a tab reopened after the window elapsed

    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(timer);
    };
  }, [navigate]);
}
