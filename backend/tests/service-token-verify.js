#!/usr/bin/env node
/**
 * The machine-to-machine integration routes must not be open.
 *
 * `verifyServiceToken` used to `return next()` whenever NODE_API_TOKEN was
 * unset, and it was unset on both sides of the estate - the Python service has
 * `NODE_API_TOKEN=` empty in its own .env, so it was not even sending a header.
 * These routes serve the sales, inventory and signal history of ANY tenant whose
 * id appears in the path, and accept PUT signal-effects, PUT calibration-bundle
 * and PUT gate-verdict. Whoever can publish a calibration bundle decides what
 * confidence figure every card in the estate displays.
 *
 * Run:  node tests/service-token-verify.js
 */

const { execFileSync } = require('child_process');
const path = require('path');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** Load auth.js fresh under a given environment. */
function loadAuth(env) {
  const key = require.resolve('../middleware/auth');
  delete require.cache[key];
  const saved = {};
  for (const k of ['NODE_API_TOKEN', 'NODE_ENV', 'JWT_SECRET']) saved[k] = process.env[k];
  Object.assign(process.env, env);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k];
  try {
    return require('../middleware/auth');
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    delete require.cache[key];
  }
}

/** Drive the middleware with a stub request and report what it decided. */
function callGate(gate, { token, peer }) {
  const req = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    socket: { remoteAddress: peer },
  };
  let status = null; let body = null; let passed = false;
  const res = {
    status(s) { status = s; return res; },
    json(b) { body = b; return res; },
  };
  gate(req, res, () => { passed = true; });
  return { passed, status, body };
}

console.log('\n-- With a token set, the header must match -----------------');
{
  const { verifyServiceToken: gate } = loadAuth({ NODE_API_TOKEN: 'correct-horse', NODE_ENV: 'test' });
  check('1  the right token is admitted',
    callGate(gate, { token: 'correct-horse', peer: '10.0.0.9' }).passed);
  const wrong = callGate(gate, { token: 'wrong', peer: '10.0.0.9' });
  check('2  a wrong token is refused', !wrong.passed && wrong.status === 401);
  const none = callGate(gate, { token: null, peer: '10.0.0.9' });
  check('3  a missing header is refused', !none.passed && none.status === 401);
  // The token is the only thing that matters once it is set: being local is not
  // a credential, or a compromised box inside the network would be enough.
  check('4  LOOPBACK IS NOT A SUBSTITUTE for the token',
    !callGate(gate, { token: null, peer: '127.0.0.1' }).passed);
}

console.log('\n-- Unset outside production: loopback only ----------------');
{
  const { verifyServiceToken: gate } = loadAuth({ NODE_API_TOKEN: '', NODE_ENV: 'test' });
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    check(`5  the documented dev flow still works (${peer})`,
      callGate(gate, { token: null, peer }).passed);
  }
  const remote = callGate(gate, { token: null, peer: '10.0.0.9' });
  check('6  a network caller is refused, not admitted',
    !remote.passed && remote.status === 401, JSON.stringify(remote.body));
  check('7  and the refusal names the variable to set',
    /NODE_API_TOKEN/.test(JSON.stringify(remote.body || {})));
  // X-Forwarded-For is set by the caller. If the gate trusted it, anyone could
  // claim to be local by adding a header.
  const spoof = {
    headers: { 'x-forwarded-for': '127.0.0.1' },
    ip: '127.0.0.1',                       // what Express would report
    socket: { remoteAddress: '10.0.0.9' }, // what the kernel reports
  };
  let spoofed = false;
  gate(spoof, { status: () => ({ json: () => {} }) }, () => { spoofed = true; });
  check('8  a forwarded-for header cannot claim to be loopback', !spoofed);
}

console.log('\n-- Unset in PRODUCTION: refuse to start -------------------');
{
  let threw = false; let message = '';
  try {
    execFileSync(process.execPath,
      ['-e', "require('./middleware/auth')"],
      { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'production', NODE_API_TOKEN: '',
               JWT_SECRET: 'present-so-only-one-thing-is-missing' } });
  } catch (err) {
    threw = true;
    message = String(err.stderr || '');
  }
  check('9  startup aborts rather than serving these routes open', threw);
  check('10 and the error says how to fix it',
    /NODE_API_TOKEN/.test(message) && /openssl rand/.test(message),
    message.split('\n').find((l) => l.includes('Error')) || '');

  // Sanity: with the token present production starts, so check 9 is about the
  // token and not about some other production-only requirement.
  let ok = true;
  try {
    execFileSync(process.execPath, ['-e', "require('./middleware/auth')"],
      { cwd: path.join(__dirname, '..'), stdio: 'ignore',
        env: { ...process.env, NODE_ENV: 'production', NODE_API_TOKEN: 'set',
               JWT_SECRET: 'also-set' } });
  } catch { ok = false; }
  check('11 ...and starts fine once it is set', ok);
}

console.log('');
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
