#!/usr/bin/env node
/* eslint-disable no-console */
// -----------------------------------------------------------------------------
// frontend/.env sanity check - runs BEFORE `npm start` and `npm run build`.
//
// Why this exists as a build step and not only as a runtime guard:
//
//   CRA reads .env ONCE, at startup, and bakes REACT_APP_* into the bundle as
//   string literals. A bad value therefore survives every browser refresh - the
//   only cure is restarting the dev server. utils/env.js does sanitise the value
//   at runtime, but that sanitiser is itself part of the stale bundle, so it
//   cannot help a server that was already running when .env was fixed.
//
//   The failure it catches lies about itself, which is why it costs an afternoon
//   every time:
//       REACT_APP_API_URL=/api (for staging and prod)
//   dotenv only strips a trailing comment introduced by " #". Everything else
//   after the "=" IS the value, so every request goes to
//       /api(for%20staging%20and%20prod)/auth/login
//   and Express answers 404. The browser blames a missing route; nothing in the
//   error names the .env file.
//
// So: refuse to start. A build that cannot reach its API is worse than one that
// never began.
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RED = '\x1b[31m';
const YEL = '\x1b[33m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';
const B = '\x1b[1m';

// CRA's own precedence, highest first. We report which file a value came from,
// so the message points at the file to edit and not merely at the variable.
const ENV_FILES = ['.env.development.local', '.env.local', '.env.development', '.env'];

/** Parse a .env the way dotenv does - deliberately including its quirks. */
function parseEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return out;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    // dotenv strips a trailing comment ONLY when introduced by whitespace + #.
    value = value.replace(/\s+#.*$/, '').trim();
    // Strip surrounding quotes, as dotenv does.
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    if (!(key in out)) out[key] = value;
  }
  return out;
}

const seen = {}; // KEY -> { value, file }
for (const name of ENV_FILES) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) continue;
  const parsed = parseEnvFile(file);
  for (const key of Object.keys(parsed)) {
    if (!(key in seen)) seen[key] = { value: parsed[key], file: name };
  }
}

const problems = [];

/* -- REACT_APP_API_URL ----------------------------------------------------- */
const apiEntry = seen.REACT_APP_API_URL;
// Unset is fine: utils/env.js defaults to "/api", which the dev-server proxy
// forwards to the backend. Only a PRESENT-but-malformed value is an error.
if (apiEntry) {
  const value = apiEntry.value;
  const where = apiEntry.file + '  (REACT_APP_API_URL)';

  if (value === '') {
    problems.push({
      where,
      got: value,
      why: 'The value is empty, so every request would go to the page URL itself.',
      fix: 'Set REACT_APP_API_URL=/api, or delete the line to accept that default.',
    });
  } else if (/\s/.test(value)) {
    // Where does the value end and the note begin? Not simply at the first
    // space: "http://localhost:3000/api(for development)" glues the note
    // straight onto the URL, and cutting on whitespace alone suggests
    // ".../api(for" as the fix - which fails exactly like the original.
    // A "(" opens a note as reliably as a space does.
    const cut = value.search(/[\s(]/);
    const intended = cut === -1 ? value : value.slice(0, cut);
    problems.push({
      where,
      got: value,
      why:
        'The value contains whitespace. A note after the value IS part of the\n' +
        '           value - dotenv only strips a comment introduced by " #". Requests\n' +
        '           would go to ' + encodeURI(value) + '/auth/login and 404.',
      // Echo back THEIR value and THEIR note, not a generic example. The line
      // to type should be copy-pasteable; suggesting "/api" to someone who
      // deliberately wrote an absolute backend URL silently changes what they
      // meant, and they will type it back tomorrow.
      fix:
        'Put the note on its OWN line, above the value:\n' +
        '           # ' + value.slice(intended.length).trim().replace(/^\(|\)$/g, '') + '\n' +
        '           REACT_APP_API_URL=' + intended,
    });
  } else if (/[()]/.test(value)) {
    problems.push({
      where,
      got: value,
      why: 'The value contains parentheses, which are almost always a stray note.',
      fix: 'Comments belong on their own line. Use REACT_APP_API_URL=/api',
    });
  } else if (!value.startsWith('/') && !/^https?:\/\//i.test(value)) {
    problems.push({
      where,
      got: value,
      why: 'The value is neither a root-relative path nor an absolute http(s) URL.',
      fix: 'Use "/api" for the proxied same-origin setup, or "https://your-host/api".',
    });
  } else if (!/\/api\/?$/.test(value)) {
    problems.push({
      where,
      got: value,
      why:
        'The value does not end in /api. Every call site appends "/auth/login",\n' +
        '           "/dashboard", ... to it, so the /api mount must already be included.',
      fix: 'Did you mean ' + JSON.stringify(value.replace(/\/$/, '') + '/api') + ' ?',
    });
  } else if (value.endsWith('/')) {
    problems.push({
      where,
      got: value,
      why: 'A trailing slash produces a double slash: "/api//auth/login".',
      fix: 'Use ' + JSON.stringify(value.replace(/\/+$/, '')) + '.',
    });
  }

  // Not an error - it works on the machine running the backend, which is
  // exactly why it is worth saying. "localhost" is resolved by the BROWSER, so
  // an absolute localhost URL means "the backend on whatever machine is showing
  // this page". Open the app from a phone, another laptop or a tunnel and every
  // request goes to that device's own port 3000 and fails, while it keeps
  // working perfectly for the person who set it.
  //
  // "/api" has no such problem: it is same-origin, and the dev server proxies
  // it to the backend from the server side.
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(value)) {
    console.warn(
      YEL + '[check-env] ' + apiEntry.file + ': REACT_APP_API_URL is an absolute localhost URL.' + OFF +
      '\n' + DIM +
      '            ' + value + '\n' +
      '            This works only in a browser ON the machine running the backend.\n' +
      '            Anyone opening the app from another device - or through a tunnel -\n' +
      '            resolves "localhost" to THEIR machine and every request fails.\n' +
      '            Use REACT_APP_API_URL=/api to let the dev server proxy it instead.' +
      OFF + '\n',
    );
  }
}

/* -- REACT_APP_ENV --------------------------------------------------------- */
const envEntry = seen.REACT_APP_ENV;
if (envEntry) {
  const v = envEntry.value.trim().toLowerCase();
  const KNOWN = ['qa', 'test', 'staging', 'stg', 'stage', 'production', 'prod', ''];
  if (!KNOWN.includes(v)) {
    // Not fatal - utils/env.js fails safe to production - but silently losing the
    // internal tools looks like a bug in the app, so say it out loud.
    console.warn(
      YEL + '[check-env] ' + envEntry.file + ': REACT_APP_ENV=' +
      JSON.stringify(envEntry.value) + ' is not one of qa | staging | production.' + OFF +
      '\n' + DIM + '            This build behaves as PRODUCTION: no "show the query" ' +
      'control, no Generate Insights button.' + OFF + '\n',
    );
  }
  if (/\s/.test(envEntry.value)) {
    problems.push({
      where: envEntry.file + '  (REACT_APP_ENV)',
      got: envEntry.value,
      why: 'The value contains whitespace - again, a note that became the value.',
      fix: 'Put comments on their own line. Use REACT_APP_ENV=staging',
    });
  }
}

if (problems.length) {
  console.error('');
  console.error(RED + B + '  frontend/.env is misconfigured - refusing to start.' + OFF);
  console.error('');
  for (const p of problems) {
    console.error('  ' + B + p.where + OFF);
    console.error('     got:  ' + RED + JSON.stringify(p.got) + OFF);
    console.error('     why:  ' + p.why);
    console.error('     fix:  ' + p.fix);
    console.error('');
  }
  console.error(
    DIM +
    '  Edit frontend/.env, then run this command again. CRA reads .env once at\n' +
    '  startup - a server that is already running keeps serving the old value no\n' +
    '  matter how many times the browser is refreshed.' + OFF,
  );
  console.error('');
  process.exit(1);
}

// Quiet on success apart from one line, so the real dev-server output stays
// readable - but print the values, because "which API am I talking to, and which
// build is this" is the first question asked when data does not appear.
const api = apiEntry ? apiEntry.value : '/api (default)';
const env = envEntry ? envEntry.value : 'production (default)';
console.log(DIM + '[check-env] API base ' + OFF + api + DIM + '   build env ' + OFF + env);
