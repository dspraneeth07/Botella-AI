// env.js
// -----------------------------------------------------------------------------
// Which environment this build is for, and what that unlocks.
//
// Set at BUILD time by CRA, so it is baked into the bundle:
//
//     REACT_APP_ENV=qa       npm run build     -> QA build
//     REACT_APP_ENV=staging  npm run build     -> staging build
//     npm run build                            -> production build (the default)
//
// FAIL SAFE IS PRODUCTION. Anything that must not reach a store owner is hidden
// unless the build explicitly names an internal environment. An unset or
// misspelled variable therefore yields the SAFE behaviour, not the leaky one -
// which is the right way round for a flag that gates raw SQL and schema names.
// -----------------------------------------------------------------------------

const RAW = String(process.env.REACT_APP_ENV || '').trim().toLowerCase();

/** 'qa' | 'staging' | 'production' - never anything else. */
export const APP_ENV = (RAW === 'qa' || RAW === 'test')
  ? 'qa'
  : (RAW === 'staging' || RAW === 'stg' || RAW === 'stage')
    ? 'staging'
    : 'production';

export const IS_QA = APP_ENV === 'qa';
export const IS_STAGING = APP_ENV === 'staging';

/**
 * An internal build - QA or staging. The people who test the product, as
 * opposed to the people who run a liquor store.
 */
export const IS_INTERNAL = IS_QA || IS_STAGING;

/**
 * May this build reveal the SQL behind a figure?
 *
 * QA and staging only. The query text names warehouse tables and columns and
 * shows how every metric is derived - useful to us when a number looks wrong,
 * not something to hand a store owner, and not something to publish about our
 * own data model.
 *
 * This is deliberately the SAME single flag that decides whether the queries are
 * compiled into the bundle at all (see storeagent/checkSql.js). A separate
 * override variable would let the two disagree - a build that renders the
 * control with no data behind it, or worse, one that ships the data with the
 * control hidden. There is also no way to force it on from the browser: a URL
 * parameter or a localStorage key is reachable by anyone who is told about it.
 */
export const CAN_REVEAL_SQL = IS_INTERNAL;

/**
 * May this build trigger a recommendation run by hand?
 *
 * Normally recommendations are produced by the nightly job. QA and staging get
 * a button so a tester does not have to wait for it - and so they can re-run
 * after changing the data underneath.
 */
export const CAN_GENERATE_INSIGHTS = IS_INTERNAL;

/** Short label for the environment badge. Null in production - a store owner
 *  should never see build plumbing. */
export const ENV_LABEL = IS_QA ? 'QA' : IS_STAGING ? 'STAGING' : null;

/* ── The API base ─────────────────────────────────────────────────────────── */

const RAW_API = String(process.env.REACT_APP_API_URL ?? '/api');

/**
 * REACT_APP_API_URL, validated.
 *
 * A note typed into the value costs an afternoon. `REACT_APP_API_URL=/api (for
 * staging and prod)` is not "/api" with a comment - dotenv keeps the whole line,
 * CRA bakes it into the bundle, and every request goes to
 * `/api(for%20staging%20and%20prod)/auth/login`, which 404s. The browser reports
 * a missing route; nothing anywhere points at the .env file.
 *
 * dotenv only strips a trailing comment when it is introduced by ` #`. Anything
 * else after the value - a parenthetical, a stray quote - IS the value.
 *
 * So: take the value up to the first whitespace, and say loudly what happened.
 * Falling back silently would hide a real misconfiguration; refusing to start
 * would take the whole app down over a stray note.
 */
export const API_BASE = (() => {
  const trimmed = RAW_API.trim();
  // Cut at the first whitespace OR the first "(", not whitespace alone. A note
  // is often glued straight onto the value with no space before it:
  //     REACT_APP_API_URL=http://localhost:3000/api(for development)
  // Splitting on whitespace leaves ".../api(for", which 404s exactly like the
  // untruncated value did - the guard would appear to run and change nothing.
  const cut = trimmed.search(/[\s(]/);
  const firstToken = cut === -1 ? trimmed : trimmed.slice(0, cut);
  if (firstToken !== trimmed) {
    // eslint-disable-next-line no-console
    console.error(
      [
        '[env] REACT_APP_API_URL carries a note and was truncated.',
        '      got:   ' + JSON.stringify(trimmed),
        '      using: ' + JSON.stringify(firstToken),
        '      A note after the value IS part of the value. Put comments on their',
        '      own line in frontend/.env, then RESTART the dev server - CRA reads',
        '      .env once at startup and bakes it into the bundle.',
      ].join('\n'),
    );
  }
  return firstToken || '/api';
})();

/**
 * The same value with a trailing /api removed - for the handful of call sites
 * that append their own "/api/..." path. Derived from API_BASE rather than read
 * again, so both forms get the same validation.
 */
export const API_ORIGIN = API_BASE.replace(/\/api\/?$/, '') || '';

/**
 * Say, once, at boot, which API this bundle talks to.
 *
 * "Which base is actually live?" is the first question whenever a request 404s
 * or data does not appear, and a screenshot of the failure cannot answer it: a
 * tab still running a bundle from before a .env fix looks EXACTLY like a real
 * misconfiguration. Both show the same 404 at the same URL.
 *
 * This line settles it in one glance. If the console does not show it, the page
 * is running a bundle older than this code - the fix is a hard reload (or a new
 * tab), not a change to any file. If it shows a base you did not expect, that is
 * a real problem and the value printed is the one to go and fix.
 *
 * console.info, not log: it belongs with the page's own diagnostics, and stays
 * out of the way at the default "Info" filter level while remaining visible.
 */
// eslint-disable-next-line no-console
console.info(
  '%c[botella]%c api base %c' + API_BASE + '%c   build env %c' + APP_ENV,
  'font-weight:bold',
  '',
  'font-weight:bold',
  '',
  'font-weight:bold',
);

export default { APP_ENV, IS_QA, IS_STAGING, IS_INTERNAL, CAN_REVEAL_SQL, CAN_GENERATE_INSIGHTS, ENV_LABEL, API_BASE, API_ORIGIN };
