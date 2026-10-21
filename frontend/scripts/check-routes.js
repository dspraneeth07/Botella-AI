#!/usr/bin/env node
/* eslint-disable no-console */
// -----------------------------------------------------------------------------
// Runs the backend's route check, when the backend is there to run it.
//
// The check itself lives in backend/scripts/check-routes.js, because it needs
// to LOAD the Express routers to build the route table - it cannot be done from
// the frontend alone. Wiring the frontend's prebuild straight at
// `../backend/scripts/check-routes.js` therefore worked in the repo and broke
// the moment the frontend was built on its own:
//
//     Error: Cannot find module '/backend/scripts/check-routes.js'
//
// frontend/Dockerfile copies only frontend/, so there is no sibling backend/ in
// that image, and the whole production build failed on a check that is a
// safeguard, not a build step. The check has its own guard for a missing
// backend/node_modules; it never got the chance to run, because the file it
// lives in was not there either.
//
// So: run it if present, skip loudly if not. A frontend-only image skips; a
// build from the full repo - a developer's machine, CI with a whole checkout -
// still gets the check, which is where it catches things anyway.
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const checker = path.resolve(__dirname, '..', '..', 'backend', 'scripts', 'check-routes.js');

if (!fs.existsSync(checker)) {
  console.log(
    '\x1b[33m[check-routes] no backend/ beside this frontend - route check SKIPPED.\x1b[0m\n' +
    '\x1b[2m              Expected when building the frontend image on its own.\x1b[0m',
  );
  process.exit(0);
}

const res = spawnSync(process.execPath, [checker], { stdio: 'inherit' });
process.exit(res.status === null ? 1 : res.status);
