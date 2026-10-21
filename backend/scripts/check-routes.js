#!/usr/bin/env node
/* eslint-disable no-console */
// -----------------------------------------------------------------------------
// check-routes - every API path the frontend asks for must exist on the backend.
//
// A 404 from a mistyped path is the most expensive cheap bug in this repo. In
// the browser it reads as "endpoint not found", which looks like the server is
// down or a route was deleted, and it stays invisible until someone opens the
// one screen that calls it - often a tester, days later.
//
// This finds them without running the app:
//
//   1. Build the route table by LOADING each router and walking its Express
//      stack. Grepping for `router.get(` misses arrays, re-exports and anything
//      built in a loop; the stack is what Express will actually match on.
//   2. Resolve each frontend file's local API base. Call sites rarely write
//      `${API_BASE}/...` directly - almost every file first derives a local
//      `base`, usually by stripping the trailing /api back off:
//          const base = (apiUrl || '').replace(/\/api\/?$/, '');       -> ""
//          const base = ... + '/api/purchase-orders';                  -> "/api/purchase-orders"
//          const BASE = `${API_BASE.replace(/\/+$/, '')}/storeagent`;  -> "/api/storeagent"
//      Getting this wrong makes every call in the file look broken, so it is
//      resolved rather than assumed.
//   3. Match the two, collapsing path parameters on both sides so
//          frontend  `${base}/${detail.id}/items/${item.id}`
//          backend   router.put('/:poId/items/:itemId')
//      compare equal.
//
// This checks SHAPE and METHOD - what Express routes on. It cannot tell you a
// handler is wrong, only that nothing will answer the call at all.
//
//   npm run check-routes --prefix backend
//
// Exit 1 on any unmatched call, so CI fails on a broken path.
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const FRONTEND_SRC = path.resolve(BACKEND, '..', 'frontend', 'src');

const RED = '\x1b[31m';
const YEL = '\x1b[33m';
const GRN = '\x1b[32m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';
const B = '\x1b[1m';

if (!fs.existsSync(FRONTEND_SRC)) {
  console.log(DIM + '[check-routes] no frontend/src here - skipping.' + OFF);
  process.exit(0);
}

// The check loads the real routers, so it needs the backend's dependencies.
// It is also run from the frontend's prebuild, where a contributor working on
// the UI alone may never have installed them. Skip loudly rather than fail a
// build over a missing dev convenience.
if (!fs.existsSync(path.join(BACKEND, 'node_modules'))) {
  console.log(
    YEL + '[check-routes] backend/node_modules is missing - route check SKIPPED.' + OFF +
      '\n' + DIM + '              Run `npm ci --prefix backend` to enable it.' + OFF,
  );
  process.exit(0);
}

// Routers read config at require() time; load .env so they do not throw.
try {
  require('dotenv').config({ path: path.join(BACKEND, '.env') });
} catch (e) {
  /* dotenv absent is fine */
}

/* -- 1. Where each router is mounted --------------------------------------- */

const serverSrc = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');

// app.use('/api/x', middleware..., require('./routes/x'))
const MOUNT_RE =
  /app\.use\(\s*(['"])(\/api[^'"]*)\1\s*,[\s\S]*?require\((['"])(\.[^'"]+)\3\)\s*\)/g;

const mounts = [];
let m;
while ((m = MOUNT_RE.exec(serverSrc)) !== null) {
  mounts.push({ base: m[2], file: m[4] });
}

/* -- 2. Expand every router into concrete METHOD + path -------------------- */

const routes = [];
const loadErrors = [];

for (const mount of mounts) {
  let router;
  try {
    router = require(path.join(BACKEND, mount.file));
  } catch (err) {
    // A router that cannot be required is a startup crash waiting to happen.
    // Report it, rather than quietly checking against a short table.
    loadErrors.push({ file: mount.file, message: err.message });
    continue;
  }
  for (const layer of (router && router.stack) || []) {
    if (!layer.route) continue;
    const declared = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    for (const one of declared) {
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        routes.push({
          method: method.toUpperCase(),
          path: mount.base + (one === '/' ? '' : one),
          source: mount.file,
        });
      }
    }
  }
}

// Routes declared straight on the app, e.g. app.get('/api/health', ...)
const DIRECT_RE = /app\.(get|post|put|patch|delete)\(\s*(['"])(\/api[^'"]*)\2/g;
while ((m = DIRECT_RE.exec(serverSrc)) !== null) {
  routes.push({ method: m[1].toUpperCase(), path: m[3], source: 'server.js' });
}

/* -- 3. Resolve each frontend file's API base bindings --------------------- */

// The value of REACT_APP_API_URL wherever it matters. An absolute backend URL
// differs per deploy, but the PATH after the origin does not - and the path is
// all Express routes on.
const API_BASE_VALUE = '/api';

/**
 * Symbolically evaluate a base-variable initialiser.
 *
 * Handles the forms this codebase actually uses, and returns null for anything
 * it does not understand - a base resolved wrongly would turn every call in
 * that file into a false 404 report, which is worse than saying "skipped".
 */
function resolveBase(rhs) {
  const src = rhs.trim();

  // useMemo(() => EXPR, [deps])
  const memo = /^useMemo\(\s*\(\)\s*=>\s*([\s\S]*?),\s*\[[^\]]*\]\s*\)$/.exec(src);
  if (memo) return resolveBase(memo[1]);

  // Anything mentioning the api url starts life as REACT_APP_API_URL.
  if (!/\b(apiUrl|API_BASE|ENV_API_BASE|API_URL|apiBase|API_ORIGIN|ENV_API_ORIGIN)\b/.test(src)) {
    return null;
  }

  // `.replace(/\/api\/?$/, '')` strips the trailing /api, leaving the ORIGIN -
  // as does importing API_ORIGIN, which utils/env.js derives the same way.
  // Files holding an origin write "/api/..." themselves at every call site.
  const strippedApi = /\\\/api\\\/\?\$/.test(src) || /\b(API_ORIGIN|ENV_API_ORIGIN)\b/.test(src);
  const value = strippedApi ? '' : API_BASE_VALUE;

  // Literal path suffixes appended by concatenation or as a template tail. The
  // '' second argument of .replace() is not a path and is skipped by the /\//
  // requirement.
  const suffixes = [];

  // + '/api/purchase-orders'
  const CONCAT = /\+\s*(['"])(\/[^'"]*)\1/g;
  let hit;
  while ((hit = CONCAT.exec(src)) !== null) suffixes.push(hit[2]);

  // `${...}/storeagent`  - the tail after the last interpolation
  const TAIL = /`[\s\S]*\}([^`$]*)`/.exec(src);
  if (TAIL && TAIL[1] && TAIL[1].startsWith('/')) suffixes.push(TAIL[1]);

  return value + suffixes.join('');
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const BASE_NAME = /^(base|BASE|apiBase|API_BASE|API_URL|apiUrl|API_ORIGIN)$/;

/**
 * Split the argument list starting at `from` (just past the opening paren).
 *
 * Commas inside nested calls, objects, arrays, strings and template literals do
 * not separate arguments - a naive split(',') turns fetch options into three
 * bogus arguments and silently reads the wrong one. Returns null if the list is
 * unterminated.
 */
function splitArgs(src, from) {
  const args = [];
  let depth = 0;
  let start = from;
  let quote = null;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' && depth === 0) {
      args.push(src.slice(start, i));
      return args;
    }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
    if (ch === ',' && depth === 0) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}

const calls = [];
const dynamic = []; // call sites whose path is assembled at runtime
const unresolvedBases = [];

for (const file of walk(FRONTEND_SRC, [])) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(FRONTEND_SRC, file).replace(/\\/g, '/');
  if (rel === 'utils/env.js') continue; // defines the bases; calls nothing

  // -- bindings in this file: const <name> = <rhs>;
  const bases = new Map();
  const BIND = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*);/g;
  let bind;
  while ((bind = BIND.exec(src)) !== null) {
    const name = bind[1];
    if (!BASE_NAME.test(name)) continue;
    const resolved = resolveBase(bind[2]);
    if (resolved === null) {
      unresolvedBases.push({ file: rel, name, rhs: bind[2].trim().replace(/\s+/g, ' ').slice(0, 70) });
      continue;
    }
    // Several functions in one file derive the same base; identical values are
    // the norm, so first-wins is right and a genuine conflict is worth knowing.
    if (bases.has(name) && bases.get(name) !== resolved) {
      unresolvedBases.push({
        file: rel,
        name,
        rhs:
          'resolves two ways: ' + JSON.stringify(bases.get(name)) +
          ' and ' + JSON.stringify(resolved),
      });
    }
    if (!bases.has(name)) bases.set(name, resolved);
  }
  // Imported straight from utils/env.js without a local alias.
  if (!bases.has('API_ORIGIN') && /\bAPI_ORIGIN\b/.test(src)) bases.set('API_ORIGIN', '');
  if (!bases.has('API_BASE') && /\bAPI_BASE\b/.test(src)) bases.set('API_BASE', API_BASE_VALUE);

  // -- path-taking helpers.
  // Most screens do not call fetch() directly. They define one helper that
  // takes the path as an argument and every caller passes a literal:
  //     async function getJSON(path) { ... fetch(`${BASE}${path}`) ... }
  //     export const getHealth = () => getJSON('/health');
  // Without following that one hop, ten of the busiest call sites in the app
  // go unchecked - which is exactly where a typo would hide longest.
  const helpers = new Map(); // name -> { base, argIndex }
  const DECL =
    /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:useCallback\(\s*)?(?:async\s*)?\(([^)]*)\)\s*=>/g;
  let decl;
  while ((decl = DECL.exec(src)) !== null) {
    const name = decl[1] || decl[3];
    const params = (decl[2] || decl[4] || '')
      .split(',')
      .map((s) => s.trim().split('=')[0].trim())
      .filter(Boolean);
    if (!name || !params.length) continue;

    // The fetch belongs to this helper only if it comes before the next
    // declaration; a fixed window is enough for these one-line wrappers.
    const body = src.slice(decl.index, decl.index + 900);
    const inner = /fetch\(\s*`\$\{([A-Za-z_$][\w$]*)\}\$\{([A-Za-z_$][\w$]*)\}`/.exec(body);
    if (!inner) continue;

    // The base may be a parameter too (authedJson(apiUrl, path, token)); in
    // that case every caller passes the same api url, so treat it as origin.
    const baseName = inner[1];
    const base = bases.has(baseName)
      ? bases.get(baseName)
      : params.includes(baseName)
        ? ''
        : null;
    const argIndex = params.indexOf(inner[2]);
    if (base === null || argIndex === -1) continue;
    helpers.set(name, { base, argIndex });
  }

  // -- calls into those helpers with a literal path
  for (const [name, info] of helpers) {
    const HELPER_CALL = new RegExp('\\b' + name + '\\s*\\(', 'g');
    let hc;
    while ((hc = HELPER_CALL.exec(src)) !== null) {
      const args = splitArgs(src, hc.index + hc[0].length);
      if (!args) continue;
      const arg = (args[info.argIndex] || '').trim();
      const lit = /^(['"`])(\/[\s\S]*)\1$/.exec(arg);
      if (!lit) continue; // not a literal path - cannot verify, do not guess
      const line = src.slice(0, hc.index).split('\n').length;
      // Options are on the helper, not here; these wrappers are all GETs
      // unless the argument list carries an explicit method.
      const md = /method:\s*['"]([A-Za-z]+)['"]/.exec(args.join(','));
      calls.push({
        file: rel,
        line,
        method: md ? md[1].toUpperCase() : 'GET',
        raw: info.base + lit[2],
        via: name,
      });
    }
  }

  // -- URLs built into a variable, then fetched:
  //        const url = `${API_BASE}/auth/login`;
  //        ... fetch(url, { method: 'POST', ... })
  // Splitting the two is ordinary when the URL is also used in an error
  // message, and it hid the single most important call in the app - login -
  // from this check the moment that refactor happened.
  const urlVars = new Map(); // name -> resolved path
  const URL_BIND =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*`\$\{([A-Za-z_$][\w$]*)\}([^`]*)`/g;
  let ub;
  while ((ub = URL_BIND.exec(src)) !== null) {
    if (!bases.has(ub[2])) continue;
    urlVars.set(ub[1], { path: bases.get(ub[2]) + ub[3], line: src.slice(0, ub.index).split('\n').length });
  }
  for (const [name, info] of urlVars) {
    const USE = new RegExp('fetch\\(\\s*' + name + '\\s*[,)]', 'g');
    let use;
    while ((use = USE.exec(src)) !== null) {
      let window = src.slice(use.index, use.index + 900);
      const next = window.indexOf('fetch(', 6);
      if (next !== -1) window = window.slice(0, next);
      const md = /method:\s*['"]([A-Za-z]+)['"]/.exec(window);
      calls.push({
        file: rel,
        line: src.slice(0, use.index).split('\n').length,
        method: md ? md[1].toUpperCase() : 'GET',
        raw: info.path,
      });
    }
  }

  // -- call sites: fetch(`${<name>}<rest>`)
  const CALL = /fetch\(\s*`\$\{([A-Za-z_$][\w$]*)\}([^`]*)`/g;
  let hit;
  while ((hit = CALL.exec(src)) !== null) {
    const name = hit[1];
    const rest = hit[2];
    const line = src.slice(0, hit.index).split('\n').length;
    if (!bases.has(name)) continue; // not an API base (e.g. a blob or asset URL)

    // A path that begins with an interpolation is assembled by the caller and
    // cannot be resolved statically. Count it, do not call it a 404.
    if (rest.startsWith('${')) {
      dynamic.push({ file: rel, line, base: bases.get(name), rest });
      continue;
    }

    // The method lives in the options object of THIS call. Stop at the next
    // fetch( or the window happily reads the NEXT call's method: and reports a
    // GET as a POST.
    let window = src.slice(hit.index + 6, hit.index + 900);
    const nextCall = window.indexOf('fetch(');
    if (nextCall !== -1) window = window.slice(0, nextCall);
    const md = /method:\s*['"]([A-Za-z]+)['"]/.exec(window);
    calls.push({
      file: rel,
      line,
      method: md ? md[1].toUpperCase() : 'GET',
      raw: bases.get(name) + rest,
    });
  }
}

/* -- 4. Match -------------------------------------------------------------- */

const PARAM = '<param>';

/**
 * Reduce a path from either side to comparable segments.
 *
 * Interpolations collapse BEFORE the query string is dropped, because a
 * conditional interpolation can itself contain the "?":
 *     `${base}/${id}/file${download ? '?download=1' : ''}`
 * Splitting first would cut the path in half and report a route that exists.
 *
 * Express parameter constraints go too - `/:id(\d+)` routes exactly the same
 * paths as `/:id`, and leaving the "(\d+)" behind makes every such route fail
 * to match anything.
 */
/**
 * Replace every `${...}` with one token, matching braces properly.
 *
 * A regex cannot do this: interpolations nest, and the ones in this codebase
 * do - `${qs ? `?${qs}` : ''}` holds a whole template literal. A non-greedy
 * `\$\{[^}]*\}` stops at the inner brace and leaves the tail of the expression
 * behind as if it were part of the path.
 *
 * An interpolation that can only ever produce a query string is dropped rather
 * than tokenised: it is not a path segment, and leaving a token behind invents
 * a segment no route can match.
 */
function collapseInterpolations(p) {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== '$' || p[i + 1] !== '{') {
      out += p[i];
      continue;
    }
    let depth = 0;
    let j = i + 1;
    let quote = null;
    for (; j < p.length; j++) {
      const ch = p[j];
      if (quote) {
        if (ch === '\\') j++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    const inner = p.slice(i + 2, j);
    // Every branch of it is a query string, so it contributes no segment.
    out += /['"`]\?/.test(inner) ? '' : PARAM;
    i = j;
  }
  return out;
}

function shape(p) {
  const collapsed = collapseInterpolations(p)
    // Express parameter constraints: /:id(\d+) routes exactly what /:id does.
    .replace(/:[A-Za-z_][A-Za-z0-9_]*\([^)]*\)/g, PARAM)
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, PARAM);
  return collapsed.split('?')[0].replace(/\/+$/, '') || '/';
}

function segments(p) {
  return shape(p).split('/');
}

/**
 * Does a call reach a route?
 *
 * Same segment count, and each pair either matches literally or one side is a
 * parameter. A parameter is a wildcard on BOTH sides: the backend's `:capability`
 * really does serve the frontend's literal "buying", and a frontend `${cap}`
 * really can arrive as the backend's literal "health". Comparing collapsed
 * strings instead would report both as 404s.
 */
function reaches(callSegs, routeSegs) {
  if (callSegs.length !== routeSegs.length) return false;
  for (let i = 0; i < callSegs.length; i++) {
    const a = callSegs[i];
    const b = routeSegs[i];
    if (a === b) continue;
    if (a === PARAM || b === PARAM) continue;
    return false;
  }
  return true;
}

const routeSegs = routes.map((r) => ({ ...r, segs: segments(r.path) }));

const problems = [];
const seen = new Set();
for (const c of calls) {
  const segs = segments(c.raw);
  const key = c.method + ' ' + segs.join('/') + ' ' + c.file;
  if (seen.has(key)) continue;
  seen.add(key);

  const pathMatches = routeSegs.filter((r) => reaches(segs, r.segs));
  if (pathMatches.some((r) => r.method === c.method)) continue;

  problems.push({
    ...c,
    shape: segs.join('/'),
    // A path that exists under a different verb is a different, much easier
    // mistake, so say which of the two it is.
    allowed: pathMatches.length ? [...new Set(pathMatches.map((r) => r.method))] : null,
  });
}

/* -- 4b. Client-side routes ------------------------------------------------ */
//
// The other half of "a routing issue". An <a href> or navigate() pointing at a
// path App.js never declares does not 404 in the network sense - it silently
// falls through to the catch-all and renders NotFoundPage. To the person
// clicking it that is the same bug, and it is harder to trace because the
// network tab shows nothing wrong at all.

const appSrc = fs.readFileSync(path.join(FRONTEND_SRC, 'App.js'), 'utf8');

const declaredRoutes = new Set();
// <Route path="/login" ...>
for (const hit of appSrc.matchAll(/<Route[^>]*\spath="([^"]+)"/g)) declaredRoutes.add(hit[1]);
// { path: '/blog', element: ... } entries in SEO_PUBLIC_PAGES
for (const hit of appSrc.matchAll(/path:\s*'([^']+)'/g)) declaredRoutes.add(hit[1]);

// APP_VIEW_PATHS may live in App.js or be imported from the view it renders.
for (const file of [path.join(FRONTEND_SRC, 'App.js'), path.join(FRONTEND_SRC, 'pages', 'ChatPage.js')]) {
  if (!fs.existsSync(file)) continue;
  const listed = /APP_VIEW_PATHS\s*=\s*\[([\s\S]*?)\]/.exec(fs.readFileSync(file, 'utf8'));
  if (!listed) continue;
  for (const hit of listed[1].matchAll(/'([^']+)'/g)) declaredRoutes.add(hit[1]);
}

const hasCatchAll = declaredRoutes.has('*');

const navTargets = new Map(); // path -> Set(files)
let dynamicNav = 0; // <Link to={expr}> - the target comes from data, not source
function noteTarget(p, rel) {
  const clean = p.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
  if (!navTargets.has(clean)) navTargets.set(clean, new Set());
  navTargets.get(clean).add(rel);
}

for (const file of walk(FRONTEND_SRC, [])) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(FRONTEND_SRC, file).replace(/\\/g, '/');
  if (rel === 'App.js') continue; // declares them; navigates nowhere
  for (const hit of src.matchAll(/navigate\(\s*'(\/[^']*)'/g)) noteTarget(hit[1], rel);
  for (const hit of src.matchAll(/\bto="(\/[^"]*)"/g)) noteTarget(hit[1], rel);
  for (const hit of src.matchAll(/window\.location\.href\s*=\s*'(\/[^']*)'/g)) noteTarget(hit[1], rel);
  // Internal <a href="/x"> only - skip anything with a scheme or a dot in it
  // (assets, mailto, external links).
  for (const hit of src.matchAll(/href="(\/[A-Za-z0-9/_-]*)"/g)) noteTarget(hit[1], rel);
  // <Link to={item.href}> - resolved from data at render time, so it cannot be
  // checked here. Counted so the coverage line does not overstate itself.
  dynamicNav += (src.match(/\bto=\{/g) || []).length;
}

const deadLinks = [];
for (const [target, files] of navTargets) {
  if (declaredRoutes.has(target)) continue;
  deadLinks.push({ target, files: [...files] });
}

/* -- 5. Report ------------------------------------------------------------- */

console.log(
  DIM +
    '[check-routes] ' + routes.length + ' backend routes across ' + mounts.length +
    ' mounts; ' + calls.length + ' resolved frontend calls, ' + dynamic.length + ' dynamic' + OFF,
);

let failed = false;

if (loadErrors.length) {
  failed = true;
  console.error('');
  console.error(RED + B + '  Router files that could not be loaded:' + OFF);
  for (const e of loadErrors) console.error('    ' + B + e.file + OFF + ' - ' + e.message);
  console.error(DIM + '  Their routes are missing below, so this run is incomplete.' + OFF);
}

if (unresolvedBases.length) {
  console.error('');
  console.error(YEL + '  API base bindings this check could not resolve:' + OFF);
  for (const u of unresolvedBases) console.error('    ' + u.file + '  ' + u.name + ' = ' + u.rhs);
  console.error(DIM + '  Calls through them were skipped, not verified.' + OFF);
}

if (problems.length) {
  failed = true;
  console.error('');
  console.error(
    RED + B + '  ' + problems.length + ' frontend call(s) have no matching backend route:' + OFF,
  );
  console.error('');
  for (const p of problems) {
    console.error('  ' + B + p.file + ':' + p.line + OFF);
    console.error('     calls:  ' + RED + p.method + ' ' + p.shape + OFF);
    if (p.allowed) {
      console.error(
        '     but:    that path exists only as ' + YEL + p.allowed.join(', ') + OFF +
          ' - the method is wrong, not the path.',
      );
    } else {
      console.error('     but:    no backend route has that shape. It will 404.');
    }
    console.error('');
  }
}

console.log(
  DIM +
    '[check-routes] ' + declaredRoutes.size + ' client routes; ' + navTargets.size +
    ' literal navigation targets, ' + dynamicNav + ' dynamic' + OFF,
);

if (!hasCatchAll) {
  failed = true;
  console.error('');
  console.error(
    RED + B + '  App.js has no <Route path="*"> catch-all.' + OFF +
      '\n  An unknown URL renders nothing at all - a blank page, not a 404.',
  );
}

if (deadLinks.length) {
  failed = true;
  console.error('');
  console.error(
    RED + B + '  ' + deadLinks.length + ' navigation target(s) match no declared route:' + OFF,
  );
  console.error('');
  for (const d of deadLinks) {
    console.error('  ' + RED + d.target + OFF);
    console.error('     from:   ' + d.files.slice(0, 4).join(', ') + (d.files.length > 4 ? ' (+' + (d.files.length - 4) + ' more)' : ''));
    console.error('     effect: falls through to the catch-all and renders NotFoundPage.');
    console.error('');
  }
  console.error(
    DIM + '  Add the path to APP_VIEW_PATHS (auth-gated views) or SEO_PUBLIC_PAGES\n' +
      '  (public pages) in App.js, or fix the link.' + OFF,
  );
}

if (!failed) {
  console.log(
    GRN + '[check-routes] every API call reaches a route, and every link reaches a page.' + OFF,
  );
}

process.exit(failed ? 1 : 0);
