#!/usr/bin/env node
/**
 * doctor.js - why can't this machine log in?
 *
 *     node backend/scripts/doctor.js
 *     node backend/scripts/doctor.js --login someuser
 *
 * Login touches five things, and when it fails the browser shows the same
 * unhelpful message no matter which one broke. This walks them in order and
 * stops at the first real failure, so you get "the warehouse is not reachable
 * from this network" instead of "Invalid username or password".
 *
 *   1. backend/.env exists and has the variables login needs
 *   2. the native module the server requires actually loads
 *   3. TCP reaches the warehouse host and port
 *   4. Postgres accepts the credentials and the users table is readable
 *   5. a token can be signed
 *
 * Run it ON the machine that is failing. It prints no passwords.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT, 'backend', '.env');

const ok = (m, d) => console.log('  PASS   ' + m + (d ? '   ' + d : ''));
// Counted, so the closing summary cannot claim everything works after a check
// that failed without being fatal - the analytics database and the
// recommendation service both stop one feature rather than the whole app.
let failures = 0;
const bad = (m, d) => { failures++; console.log('  FAIL   ' + m + (d ? '   ' + d : '')); return false; };
const hint = (m) => console.log('         -> ' + m);

(async () => {
  console.log('\nBotella login doctor - ' + new Date().toISOString());
  console.log('repo: ' + ROOT + '\n');

  /* 1. Configuration ------------------------------------------------------ */
  if (!fs.existsSync(ENV_PATH)) {
    bad('backend/.env exists', 'not found');
    hint('cp backend/.env.example backend/.env  and fill in the values.');
    hint('Without it the server has no database host and no signing secret.');
    process.exit(1);
  }
  ok('backend/.env exists');

  require(path.join(ROOT, 'backend', 'node_modules', 'dotenv')).config({ path: ENV_PATH });

  const NEEDED = ['PG_HOST', 'PG_PORT', 'PG_DATABASE', 'PG_USER', 'PG_PASSWORD', 'JWT_SECRET'];
  const missing = NEEDED.filter((k) => !process.env[k]);
  if (missing.length) {
    bad('login variables set', 'missing: ' + missing.join(', '));
    hint('Login reads the users table from the warehouse and signs a JWT; it');
    hint('cannot do either without these. See backend/.env.example.');
    process.exit(1);
  }
  ok('login variables set', NEEDED.join(', '));

  /* 1b. The machine-to-machine token ------------------------------------- */
  //
  // The two sides must hold the SAME value, and until recently neither held
  // any: Node treated an unset token as "leave the routes open" and the Python
  // service sends the header only when its own copy is set. This is exactly the
  // kind of two-file mismatch the doctor exists to find - a 401 on every
  // engine call looks like a broken deploy, and an empty pair looks like
  // nothing at all until the port is reachable.
  const PY_ENV = path.join(ROOT, 'Botella_External_APIs', '.env');
  const readVar = (file, key) => {
    try {
      const lines = fs.readFileSync(file, 'utf8').split(String.fromCharCode(10));
      const line = lines.map((l) => l.trim())
        .find((l) => l.startsWith(`${key}=`));
      return line ? line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '') : null;
    } catch { return null; }
  };
  const nodeTok = process.env.NODE_API_TOKEN || '';
  const pyTok = readVar(PY_ENV, 'NODE_API_TOKEN') || '';
  if (!nodeTok && !pyTok) {
    bad('integration token set', 'neither side has NODE_API_TOKEN');
    hint('The integration routes serve any store named in the path and accept');
    hint('writes to analytics. Unset, they are reachable from LOOPBACK ONLY');
    hint('here, and a production server REFUSES TO START. Generate one with');
    hint('`openssl rand -hex 32` and put the same value in backend/.env and');
    hint('Botella_External_APIs/.env.');
  } else if (!nodeTok) {
    bad('integration token set', 'the Python service sends one, Node ignores it');
    hint('Node treats an unset token as loopback-only, so the engine gets a 401');
    hint('from a container. Copy the value into backend/.env as NODE_API_TOKEN.');
  } else if (!pyTok) {
    bad('integration token set', 'Node requires one, the Python service sends none');
    hint('Every engine call will 401. Copy the value into');
    hint('Botella_External_APIs/.env as NODE_API_TOKEN.');
  } else if (nodeTok !== pyTok) {
    bad('integration token set', 'the two sides disagree');
    hint('Both files have a token and they are different, so every engine call');
    hint('401s. They must match exactly.');
  } else {
    ok('integration token set', 'both sides match');
  }

  /* 2. Native module ------------------------------------------------------ */
  try {
    require(path.join(ROOT, 'backend', 'node_modules', 'better-sqlite3'));
    ok('better-sqlite3 loads');
  } catch (e) {
    bad('better-sqlite3 loads', e.message.split('\n')[0]);
    hint('npm ci leaves this unbuilt when npm\'s allow-scripts gate blocks its');
    hint('install script, and the server dies on require() before it can serve');
    hint('anything. Fix:');
    hint('  npm approve-scripts better-sqlite3 --prefix backend && npm ci --prefix backend');
    hint('A node_modules copied from another machine fails the same way: the');
    hint('compiled binary is built for THAT operating system.');
    process.exit(1);
  }

  /* 3. Can this network even reach the warehouse? ------------------------- */
  const host = process.env.PG_HOST, port = parseInt(process.env.PG_PORT || '5432', 10);
  const reachable = await new Promise((resolve) => {
    const s = new net.Socket();
    const done = (v) => { try { s.destroy(); } catch { /* */ } resolve(v); };
    s.setTimeout(8000);
    s.once('connect', () => done(true));
    s.once('timeout', () => done('timeout'));
    s.once('error', (e) => done(e.code || e.message));
    s.connect(port, host);
  });
  if (reachable !== true) {
    bad('TCP reaches ' + host + ':' + port, String(reachable));
    hint('This is the usual reason login works on one machine and not another.');
    hint('The warehouse is on a public IP behind a firewall / security group');
    hint('that allowlists specific addresses. This machine\'s IP is very likely');
    hint('not on that list - add it, or connect from the same network as the');
    hint('machine where login DOES work.');
    hint('A timeout means blocked; ECONNREFUSED means nothing is listening.');
    process.exit(1);
  }
  ok('TCP reaches ' + host + ':' + port);

  /* 4. Credentials and the users table ------------------------------------ */
  const { Pool } = require(path.join(ROOT, 'backend', 'node_modules', 'pg'));
  const pool = new Pool({
    host, port, database: process.env.PG_DATABASE,
    user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    ssl: { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 10000,
  });
  try {
    const r = await pool.query('SELECT count(*)::int AS n FROM users');
    ok('warehouse accepts the credentials', 'users table readable, ' + r.rows[0].n + ' rows');
  } catch (e) {
    bad('warehouse accepts the credentials', e.message.split('\n')[0]);
    if (/password|authentication/i.test(e.message)) hint('PG_USER / PG_PASSWORD are wrong for this database.');
    else if (/does not exist/i.test(e.message)) hint('PG_DATABASE is wrong, or this user cannot see the users table.');
    else if (/no pg_hba|not allowed/i.test(e.message)) hint('The server reached Postgres but this host is not permitted to connect.');
    await pool.end(); process.exit(1);
  }

  const who = process.argv.indexOf('--login') > -1 ? process.argv[process.argv.indexOf('--login') + 1] : null;
  if (who) {
    try {
      const r = await pool.query('SELECT user_id, client_id, location_id FROM users WHERE username=$1', [who]);
      if (!r.rows.length) {
        bad('user "' + who + '" exists', 'no such username in this database');
        hint('"Invalid username or password" can simply mean the account is not');
        hint('in the database this machine is pointed at. Check PG_DATABASE.');
      } else {
        ok('user "' + who + '" exists', 'client ' + r.rows[0].client_id + ' / location ' + r.rows[0].location_id);
      }
    } catch (e) { bad('user lookup', e.message.split('\n')[0]); }
  }

  /* 5. Token signing ------------------------------------------------------ */
  try {
    const jwt = require(path.join(ROOT, 'backend', 'node_modules', 'jsonwebtoken'));
    jwt.sign({ t: 1 }, process.env.JWT_SECRET, { expiresIn: '1m' });
    ok('a token can be signed');
  } catch (e) {
    bad('a token can be signed', e.message.split('\n')[0]);
  }

  await pool.end();

  /* 5b. The analytics database ------------------------------------------- */
  //
  // A SECOND database, easy to miss because login never touches it. The
  // warehouse (syncgo) is a shared remote mirror; this one is per-machine and
  // starts out empty, so a fresh clone reaches every screen that reads it and
  // fails with, e.g.:
  //
  //     [PO] list failed  relation "purchase_orders" does not exist
  //
  // which reads like a code fault rather than "run the migrations".
  //
  // Note what the server actually uses: the discrete ANALYTICS_PG_* variables.
  // ANALYTICS_DATABASE_URL is read by NOTHING at runtime - set only that and
  // the server connects somewhere else entirely, without saying so.
  const A = {
    host: process.env.ANALYTICS_PG_HOST || 'localhost',
    port: parseInt(process.env.ANALYTICS_PG_PORT || '5432', 10),
    database: process.env.ANALYTICS_PG_DATABASE || 'bottleai_analytics',
    user: process.env.ANALYTICS_PG_USER || process.env.PG_USER,
    password: process.env.ANALYTICS_PG_PASSWORD || process.env.PG_PASSWORD,
  };
  const apool = new Pool({ ...A, max: 2, connectionTimeoutMillis: 8000 });
  let analyticsOk = false;
  try {
    await apool.query('SELECT 1');
    ok('analytics DB reachable', A.user + '@' + A.host + ':' + A.port + '/' + A.database);
    analyticsOk = true;
  } catch (e) {
    bad('analytics DB reachable', e.message.split('\n')[0]);
    hint('This is a SEPARATE database from the warehouse, and it lives on THIS');
    hint('machine - a fresh clone has none. Screens that read it (purchase');
    hint('orders, recommendations, effectiveness, feedback) will return 500.');
    hint('Create it and run the migrations:');
    hint('  createdb ' + A.database);
    hint('  npm run migrate --prefix backend');
    if (process.env.ANALYTICS_DATABASE_URL) {
      hint('ANALYTICS_DATABASE_URL is set but the SERVER DOES NOT READ IT - only');
      hint('the ANALYTICS_PG_* variables above. Setting just the URL connects');
      hint('the app somewhere other than where you think.');
    }
  }

  if (analyticsOk) {
    // Reachable is not enough: an empty database answers SELECT 1 happily and
    // then fails every real query. Check the tables the app actually needs.
    const NEEDED = ['purchase_orders', 'purchase_order_items', 'recommendations', 'recommendation_runs',
      'card_statements', 'card_statement_events'];
    try {
      const r = await apool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
      );
      const have = new Set(r.rows.map((x) => x.table_name));
      const absent = NEEDED.filter((t) => !have.has(t));
      if (absent.length) {
        bad('analytics schema', 'missing: ' + absent.join(', '));
        hint('The database exists but the migrations have not been run against it.');
        hint('  npm run migrate --prefix backend');
        hint('Until then those screens answer 500 with "relation ... does not exist".');
      } else {
        ok('analytics schema', have.size + ' tables, all the ones the app needs');
      }
    } catch (e) {
      bad('analytics schema', e.message.split('\n')[0]);
    }
  }
  await apool.end().catch(() => {});

  /* 6. The half the browser actually uses --------------------------------- */
  //
  // Steps 1-5 prove the API could serve a login. They say nothing about
  // whether the browser can ask it to, and that is the half that differs
  // between one laptop and another: the database is shared, the local servers
  // are not. Checking only the database half is what produces "works on my
  // machine" - so walk the HTTP path too, from the same machine, in order.

  const APP_PORT = parseInt(process.env.PORT || '3000', 10);
  const DEV_PORT = 3001; // frontend/package.json start script pins this

  async function http(url, init) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      return { res: await fetch(url, { ...init, signal: ctl.signal }) };
    } catch (e) {
      return { err: e.name === 'AbortError' ? 'timed out after 6s' : (e.cause && e.cause.code) || e.message };
    } finally {
      clearTimeout(timer);
    }
  }

  // 6a. frontend/.env - the value the browser bundle is built from.
  const FE_ENV = path.join(ROOT, 'frontend', '.env');
  if (!fs.existsSync(FE_ENV)) {
    // Not fatal: utils/env.js defaults to /api, which the dev-server proxy
    // forwards. Worth saying, because it is gitignored and a fresh clone has
    // none - so this is normal on a new machine, not a fault.
    ok('frontend/.env', 'absent - the app will default to /api (fine with the dev server)');
  } else {
    const line = /^REACT_APP_API_URL=(.*)$/m.exec(fs.readFileSync(FE_ENV, 'utf8'));
    const val = line ? line[1].replace(/\s+#.*$/, '').trim() : null;
    if (val && /\s/.test(val)) {
      bad('frontend/.env REACT_APP_API_URL', JSON.stringify(val));
      hint('A note after the value IS the value - dotenv only strips a comment');
      hint('introduced by " #". Every request would go to a path that 404s.');
      hint('Put the comment on its own line, then RESTART the dev server.');
      process.exit(1);
    }
    ok('frontend/.env REACT_APP_API_URL', val ? JSON.stringify(val) : 'not set (defaults to /api)');
  }

  // 6b. Is the API listening on this machine at all?
  const health = await http('http://localhost:' + APP_PORT + '/api/health');
  if (health.err) {
    bad('API answers on localhost:' + APP_PORT, String(health.err));
    hint('Everything the API needs works, but the API itself is not running');
    hint('HERE. Each machine runs its own backend - a colleague\'s does not');
    hint('serve yours. Start it:  npm start --prefix backend');
    if (String(health.err) === 'ECONNREFUSED') hint('ECONNREFUSED = nothing is listening on that port.');
    process.exit(1);
  }
  ok('API answers on localhost:' + APP_PORT, 'HTTP ' + health.res.status + ' /api/health');

  // 6c. Does the login ROUTE exist over HTTP? A 401 is the pass condition:
  // it means the path resolved, the handler ran, and the query reached the
  // database. A 404 means the request landed somewhere else entirely.
  const probe = await http('http://localhost:' + APP_PORT + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '__doctor__', password: '__doctor__' }),
  });
  if (probe.err) {
    bad('POST /api/auth/login', String(probe.err));
    process.exit(1);
  } else if (probe.res.status === 401) {
    ok('POST /api/auth/login', '401 - route reached the database and rejected the probe (correct)');
  } else if (probe.res.status === 404) {
    bad('POST /api/auth/login', '404 - the route is not mounted');
    hint('The API is running but does not serve that path. A stale or partial');
    hint('checkout is the usual cause.');
    process.exit(1);
  } else {
    bad('POST /api/auth/login', 'HTTP ' + probe.res.status + ' (expected 401)');
    hint('The route answered, but not the way a healthy login does. A 500 here');
    hint('means the handler threw - check the backend console.');
  }

  // 6d. The dev server, if this machine runs one. Its proxy is what makes the
  // browser's same-origin "/api/..." reach the backend, and it is the piece
  // most often missing when the API is fine but the page still cannot log in.
  const dev = await http('http://localhost:' + DEV_PORT + '/api/health');
  if (dev.err) {
    ok('frontend dev server on :' + DEV_PORT, 'not running (fine if you use the built app on :' + APP_PORT + ')');
  } else if (dev.res.ok) {
    ok('dev server proxies /api to the backend', 'HTTP ' + dev.res.status);
  } else {
    bad('dev server proxies /api to the backend', 'HTTP ' + dev.res.status);
    hint('The dev server is up but did not forward /api. Check "proxy" in');
    hint('frontend/package.json - it must point at http://localhost:' + APP_PORT + '.');
    hint('Restart the dev server after changing it.');
  }

  /* 7. The recommendation service, and its way back ----------------------- */
  //
  // Generate Insights needs a round trip: this API calls the Python service to
  // start a run, and the Python service calls BACK here for the store's
  // profile, inventory and sales. Only the outward leg is obvious, so the
  // return leg is the one that breaks - and its failure surfaces as
  // "(node_api_error)", a code from the Python service that names neither side.
  const REC_URL = (process.env.REC_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  const rec = await http(REC_URL + '/health');
  if (rec.err) {
    // Not fatal: everything except Generate Insights works without it.
    ok('recommendation service', 'not running at ' + REC_URL + ' (' + rec.err + ')');
    hint('Generate Insights will fail until it is started. Everything else works.');
  } else {
    ok('recommendation service', REC_URL + ' answers HTTP ' + rec.res.status);
    const key = process.env.REC_SERVICE_API_KEY;
    if (key) {
      const auth = await http(REC_URL + '/auth-check', { headers: { 'X-API-Key': key } });
      if (auth.err || !auth.res.ok) {
        bad('recommendation service accepts our API key', auth.err || 'HTTP ' + auth.res.status);
        hint('REC_SERVICE_API_KEY here must equal SERVICE_API_KEY in the Python');
        hint('service\'s .env.');
      } else {
        ok('recommendation service accepts our API key');
      }
    }
    // The return leg. We cannot read the Python service's .env from here, but
    // we CAN say what it has to be able to reach, and name the trap.
    hint('If Generate Insights fails with (node_api_error), the run started and');
    hint('the Python service could not call back. In ITS .env, NODE_API_BASE_URL');
    hint('must reach this API - http://127.0.0.1:' + APP_PORT + ' when uvicorn runs');
    hint('natively. host.docker.internal works ONLY inside a container, and on a');
    hint('machine that has had Docker or WSL it resolves to a dead address and');
    hint('times out rather than failing fast. Restart uvicorn after changing it:');
    hint('it reads .env at startup and --reload watches .py only.');
  }

  if (failures) {
    console.log(
      '\n  ' + failures + ' check(s) FAILED above. Login itself may still work - the ' +
      'analytics\n  database and the recommendation service each break one feature, not ' +
      'the app -\n  but the screens they serve will return 500 until they are fixed.\n'
    );
    // exitCode, not exit(): calling process.exit() here kills the process while
    // the pg pool's handles are still closing, and libuv aborts on Windows with
    // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" - a crash instead
    // of the report, which is a poor way to end a diagnostic. Setting the code
    // and returning lets node unwind and exit 1 on its own.
    process.exitCode = 1;
    return;
  }

  console.log('\n  Every layer login needs works on this machine, browser side included.');
  console.log('  Open http://localhost:' + DEV_PORT + ' and check the console for the line:');
  console.log('      [botella] api base /api   build env staging');
  console.log('  If that line is absent the page is running an old bundle - hard-reload');
  console.log('  (Ctrl-Shift-R) or use a private window. If it shows a base you did not');
  console.log('  expect, that value is what to fix in frontend/.env.\n');
})().catch((e) => { console.error(e); process.exit(1); });
