/**
 * Where the Python half of the engine lives, and how to invoke it.
 *
 * WHY THIS IS A MODULE AND NOT FOUR COPIES OF A PATH
 *
 *   Four places shelled out to Python - the nightly gate, the calibration
 *   refit, the weekly signal-effect fit and the lift parity test - and each
 *   built the interpreter path itself. Three of them hardcoded
 *
 *       Botella_External_APIs/.venv/Scripts/python.exe
 *
 *   which is the WINDOWS venv layout. On Linux a virtualenv puts the
 *   interpreter at `.venv/bin/python` and never creates `Scripts/`, so every
 *   one of those jobs failed with ENOENT on the deployed box while passing on
 *   a developer's machine. The failure is also quiet: the gate cron catches,
 *   logs one line and carries on, so the estate simply never gated.
 *
 * WHAT IT RESOLVES, IN ORDER
 *
 *   1. PYTHON_BIN                     an explicit interpreter, which wins
 *   2. the sibling checkout's venv    both layouts, whichever exists
 *   3. python3 / python on PATH       probed, not assumed
 *
 *   PYTHON_SCRIPTS_DIR relocates the scripts folder the same way, for a
 *   deployment that does not keep the two checkouts side by side.
 *
 * AND WHY IT THROWS A SENTENCE RATHER THAN ENOENT
 *
 *   `spawn python.exe ENOENT` names a file the operator never configured and
 *   does not say what to set. The error below lists every candidate tried and
 *   the variable that overrides them, because this failure will be read from a
 *   log line at 06:00 by someone who did not write it.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.join(__dirname, '..', '..');
const PY_ROOT = path.join(REPO_ROOT, 'Botella_External_APIs');

/** Both virtualenv layouts. Windows puts the interpreter in Scripts/, POSIX in bin/. */
const VENV_CANDIDATES = [
  path.join(PY_ROOT, '.venv', 'Scripts', 'python.exe'),
  path.join(PY_ROOT, '.venv', 'bin', 'python'),
  path.join(PY_ROOT, '.venv', 'bin', 'python3'),
];

/** Interpreters to probe on PATH, once the venv has been ruled out. */
const PATH_CANDIDATES = process.platform === 'win32'
  ? ['python.exe', 'python3.exe']
  : ['python3', 'python'];

let cached;

function usable(bin) {
  // --version rather than existsSync: a name on PATH has no path to stat, and a
  // venv whose base interpreter was uninstalled exists but cannot start.
  const probe = spawnSync(bin, ['--version'], { timeout: 15000, windowsHide: true });
  return !probe.error && probe.status === 0;
}

/**
 * The interpreter to run the pipeline's scripts with.
 *
 * @param {{ quiet?: boolean }} [opts] quiet returns null instead of throwing,
 *   for a caller that has a non-Python fallback and wants to choose.
 * @returns {string|null}
 */
function resolvePython(opts = {}) {
  if (cached !== undefined) {
    if (cached === null && !opts.quiet) throw notFound();
    return cached;
  }

  const explicit = (process.env.PYTHON_BIN || '').trim();
  if (explicit) {
    // An explicit setting is NOT silently discarded when it does not work. An
    // operator who sets PYTHON_BIN and sees the venv used anyway has no way to
    // tell the setting was ignored.
    if (!usable(explicit)) {
      throw new Error(
        `PYTHON_BIN is set to "${explicit}" but it could not be run. `
        + 'Point it at a Python interpreter that has the Botella_External_APIs '
        + 'package installed (python -m pip install -e ".[dev]").'
      );
    }
    cached = explicit;
    return cached;
  }

  for (const candidate of VENV_CANDIDATES) {
    if (fs.existsSync(candidate) && usable(candidate)) {
      cached = candidate;
      return cached;
    }
  }
  for (const candidate of PATH_CANDIDATES) {
    if (usable(candidate)) {
      cached = candidate;
      return cached;
    }
  }

  cached = null;
  if (!opts.quiet) throw notFound();
  return null;
}

function notFound() {
  return new Error(
    'No Python interpreter found for the pipeline scripts. Tried PYTHON_BIN '
    + `(unset), ${VENV_CANDIDATES.join(', ')}, and ${PATH_CANDIDATES.join('/')} `
    + 'on PATH. Set PYTHON_BIN to an interpreter with the '
    + 'Botella_External_APIs package installed.'
  );
}

/** The folder holding the pipeline's scripts. */
function scriptsDir() {
  return (process.env.PYTHON_SCRIPTS_DIR || '').trim()
    || path.join(PY_ROOT, 'scripts');
}

/** Absolute path to one of the pipeline's scripts. */
function scriptPath(name) {
  return path.join(scriptsDir(), name);
}

/** True when both an interpreter and the named script are present. */
function available(name) {
  return resolvePython({ quiet: true }) !== null && fs.existsSync(scriptPath(name));
}

/**
 * Run one of the pipeline's scripts and return its stdout.
 *
 * `cwd` defaults to the Python checkout so a script's relative `--data` paths
 * mean what they mean when it is run by hand.
 */
async function runScript(name, args = [], opts = {}) {
  const python = resolvePython();
  const script = scriptPath(name);
  if (!fs.existsSync(script)) {
    throw new Error(
      `${name} not found at ${script}. The Python image must COPY scripts/, and `
      + 'PYTHON_SCRIPTS_DIR relocates the folder when the two checkouts are not '
      + 'side by side.'
    );
  }
  // The PARENT of the scripts folder, not a fixed repo path: each script does
  // sys.path.insert(parents[1]) to find `app`, and the container lays the two
  // out at /opt/pipeline/{app,scripts} rather than beside this checkout.
  return execFileAsync(python, [script, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    cwd: opts.cwd || path.dirname(scriptsDir()),
    ...opts,
  });
}

module.exports = {
  resolvePython, scriptPath, scriptsDir, available, runScript, REPO_ROOT, PY_ROOT,
  _resetCache: () => { cached = undefined; },
};
