/**
 * SQL migration runner - applies the .sql files in a migrations directory
 * exactly once per database, tracked in a `schema_migrations` table.
 *
 * Replaces "psql this file manually in every environment": new tables/DDL ship
 * as a numbered .sql file, and every environment converges by running the
 * runner (CLI in CI/CD, or at boot via MIGRATE_ON_BOOT - see below).
 *
 * TARGETS (two databases, two directories - never mixed):
 *   analytics (default) → database/analytics-migrations/*.sql  → bottleai_analytics
 *   syncgo              → database/migrations/*.sql            → syncgo warehouse
 *
 * CLI:
 *   node database/migrate.js [analytics|syncgo] [--status|--dry-run]
 *   npm run migrate            # apply pending analytics migrations
 *   npm run migrate:status     # show applied/pending without touching anything
 *
 * CREDENTIALS - the whole point of the runner is respecting least privilege:
 *   analytics: ANALYTICS_MIGRATE_DSN when set (an owner/admin connection string
 *     for environments where the app role has no schema-CREATE - prod/staging),
 *     else the app-role ANALYTICS_PG_* vars (fine in dev, where the app role
 *     owns the schema). A permission failure is reported, never half-applied.
 *   syncgo: SYNCGO_MIGRATE_DSN, REQUIRED - there is no fallback on purpose.
 *     The app's syncgo role is SELECT-only and these migrations (indexes, RLS)
 *     need table ownership or superuser; running them stays a deliberate,
 *     DBA-credentialed act.
 *
 * BOOT MODE: server.js calls runMigrations('analytics') when MIGRATE_ON_BOOT
 *   is truthy. Failures are logged and NON-FATAL - every consumer of these
 *   tables already degrades gracefully when one is missing, and a boot loop
 *   over a permissions problem would be worse than a warning.
 *
 * FILE RULES (matches the files that already exist):
 *   - Ordered by filename → use a numeric prefix: 001_..., 002_...
 *   - Each file is atomic: either it wraps itself in BEGIN/COMMIT (both
 *     existing numbered files do), or it relies on the implicit single-
 *     transaction execution of a multi-statement query string. Either way a
 *     failure applies nothing and records nothing.
 *   - Prefer idempotent DDL (IF NOT EXISTS / OR REPLACE): if recording a
 *     migration fails after it ran, or an environment applied a file manually
 *     before this runner existed, the re-run must be harmless.
 *   - NEVER edit an applied file (checksums are verified - drift is reported);
 *     fix forward with a new numbered file.
 *   - A file whose FIRST line is `-- @baseline` is exempt from the drift
 *     report: it is the authoritative text for DDL that is already applied
 *     (a recovered or squashed base schema), so a checksum mismatch is
 *     reconciled rather than warned about, and the file is not re-executed
 *     where it is already recorded. See isBaseline() for the full rule and
 *     analytics-migrations/000_base_tables.sql for the one file using it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const TARGETS = {
  analytics: {
    dir: path.join(__dirname, 'analytics-migrations'),
    connect: () => {
      if (process.env.ANALYTICS_MIGRATE_DSN) {
        return new Pool({ connectionString: process.env.ANALYTICS_MIGRATE_DSN, max: 1 });
      }
      return new Pool({
        host: process.env.ANALYTICS_PG_HOST || 'localhost',
        port: parseInt(process.env.ANALYTICS_PG_PORT || '5432', 10),
        database: process.env.ANALYTICS_PG_DATABASE || 'bottleai_analytics',
        user: process.env.ANALYTICS_PG_USER || process.env.PG_USER,
        password: process.env.ANALYTICS_PG_PASSWORD || process.env.PG_PASSWORD,
        max: 1,
      });
    },
  },
  syncgo: {
    dir: path.join(__dirname, 'migrations'),
    connect: () => {
      if (!process.env.SYNCGO_MIGRATE_DSN) {
        throw new Error(
          'syncgo migrations need SYNCGO_MIGRATE_DSN (an owner/superuser DSN). ' +
          'The app role is SELECT-only by design - there is no fallback.'
        );
      }
      return new Pool({ connectionString: process.env.SYNCGO_MIGRATE_DSN, max: 1 });
    },
  },
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * The tables a baseline file declares, from its `CREATE TABLE IF NOT EXISTS`
 * statements.
 *
 * Used to decide whether an unrecorded baseline is in fact already applied.
 * Deliberately narrow: only the IF NOT EXISTS form, only unquoted identifiers,
 * and comment lines are stripped first so a table named in prose is not
 * mistaken for a declaration. A baseline whose tables cannot be parsed yields
 * an empty list, which means "do not assume" - the file is executed as before.
 */
function baselineTables(sql) {
  const body = String(sql)
    .split(String.fromCharCode(10))
    .filter((l) => !l.trimStart().startsWith('--'))
    .join(String.fromCharCode(10));
  const found = new Set();
  const re = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  let m;
  while ((m = re.exec(body)) !== null) found.add(m[1]);
  return [...found];
}

async function ensureTrackingTable(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       text        PRIMARY KEY,
       checksum   text        NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`
  );
}

function listMigrationFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort() // numeric prefixes make lexicographic order = apply order
    .map((name) => {
      const sql = fs.readFileSync(path.join(dir, name), 'utf8');
      return { name, sql, checksum: sha256(sql), baseline: isBaseline(sql) };
    });
}

/**
 * True when the file's FIRST line is exactly `-- @baseline`.
 *
 * A baseline file is the authoritative text for DDL that is ALREADY APPLIED in
 * existing environments - a recovered or squashed base schema. Two rules
 * follow, and both are deliberate:
 *
 *   1. On a database where the name is already recorded, a checksum mismatch
 *      is RECONCILED (the stored checksum is updated) instead of reported as
 *      drift. Without this, a recovered baseline warns "was EDITED after being
 *      applied" on every run, forever, and teaches everyone to ignore the one
 *      warning that catches real tampering.
 *   2. The file is still NOT re-executed there. Editing a baseline therefore
 *      changes nothing in any existing database - only the repo's account of
 *      what those databases contain. Fix forward with a new numbered file.
 *
 * First line only, matched exactly: prose inside a file that merely MENTIONS
 * the pragma (000_base_tables.sql documents it at length) must never trip it.
 */
function isBaseline(sql) {
  return /^--\s*@baseline\s*$/.test(sql.split('\n', 1)[0].trim());
}

/**
 * Apply pending migrations for a target. Returns a summary
 * { applied: string[], skipped: number, drifted: string[], reconciled: string[] }.
 * @param {'analytics'|'syncgo'} target
 * @param {{ dryRun?: boolean, log?: (msg: string) => void }} [opts]
 */
async function runMigrations(target = 'analytics', opts = {}) {
  const cfg = TARGETS[target];
  if (!cfg) throw new Error(`Unknown migration target "${target}" (analytics|syncgo)`);
  const log = opts.log || ((m) => console.log(m));
  const files = listMigrationFiles(cfg.dir);
  if (files.length === 0) {
    log(`[migrate:${target}] no .sql files in ${cfg.dir}`);
    return { applied: [], skipped: 0, drifted: [], reconciled: [] };
  }

  const pool = cfg.connect();
  const summary = { applied: [], skipped: 0, drifted: [], reconciled: [] };
  try {
    await ensureTrackingTable(pool);
    const { rows } = await pool.query('SELECT name, checksum FROM schema_migrations');
    const appliedByName = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const appliedChecksum = appliedByName.get(file.name);
      if (appliedChecksum !== undefined) {
        summary.skipped += 1;
        if (appliedChecksum !== file.checksum) {
          if (file.baseline) {
            // Recovered/squashed baseline: the DDL is already in this database,
            // so re-running it is neither needed nor safe. Record that THIS text
            // is the authoritative account of it and move on - see isBaseline.
            if (!opts.dryRun) {
              await pool.query(
                'UPDATE schema_migrations SET checksum = $2 WHERE name = $1',
                [file.name, file.checksum]
              );
            }
            summary.reconciled.push(file.name);
            log(
              `[migrate:${target}] baseline ${file.name}: recorded checksum reconciled ` +
              '(DDL already applied here - NOT re-executed).'
            );
          } else {
            summary.drifted.push(file.name);
            log(
              `[migrate:${target}] WARNING ${file.name} was EDITED after being applied ` +
              '(checksum mismatch). Applied migrations are immutable - fix forward with a new file.'
            );
          }
        }
        continue;
      }
      if (opts.dryRun) {
        log(`[migrate:${target}] pending: ${file.name}`);
        continue;
      }

      // A BASELINE THAT IS ALREADY APPLIED BUT WAS NEVER RECORDED.
      //
      // The reconcile path above covers a baseline whose name IS recorded. The
      // case it missed is the one that actually happens: a database whose base
      // tables were created before this runner existed, so the name is absent
      // from schema_migrations while the DDL is fully present.
      //
      // The runner then tried to EXECUTE the baseline as the app role, and on
      // QA that failed - `CREATE INDEX IF NOT EXISTS` checks ownership BEFORE
      // the IF NOT EXISTS short-circuit, so re-declaring an index that already
      // exists on a table owned by someone else raises "must be owner of table
      // recommendation_runs". (A GRANT was fine, and `CREATE TABLE IF NOT
      // EXISTS` was fine - only the index is fatal, which is why this was so
      // easy to misdiagnose.)
      //
      // Because files apply in order and the runner stops at the first failure,
      // 000 failing meant migrations 013 through 037 NEVER RAN on QA. It had no
      // recommendation_outcomes, no store_gate_verdict, no signal_effects and
      // no card_statements, and what an owner saw was "the card statement
      // tables are missing from the analytics database".
      //
      // So: if every table a baseline declares already exists, the baseline IS
      // applied - that is what `-- @baseline` asserts - and it is recorded
      // without being re-executed. A fresh database still takes the normal
      // path, because there the tables are absent and the role creating them
      // owns them.
      if (file.baseline) {
        const declared = baselineTables(file.sql);
        const present = [];
        for (const name of declared) {
          const { rows: r } = await pool.query(
            'SELECT to_regclass($1) IS NOT NULL AS ok', [name]
          );
          if (r[0].ok) present.push(name);
        }
        if (declared.length && present.length === declared.length) {
          await pool.query(
            'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
            [file.name, file.checksum]
          );
          summary.reconciled.push(file.name);
          log(
            `[migrate:${target}] baseline ${file.name}: all ${declared.length} ` +
            'declared tables already exist - recorded WITHOUT executing. Its ' +
            'indexes and grants were not re-verified; use ANALYTICS_MIGRATE_DSN ' +
            'with an owner connection if they need to be.'
          );
          continue;
        }
      }

      log(`[migrate:${target}] applying ${file.name} …`);
      // The file is one multi-statement query: with its own BEGIN/COMMIT it
      // controls atomicity; without, the implicit transaction covers it all.
      await pool.query(file.sql);
      await pool.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
        [file.name, file.checksum]
      );
      summary.applied.push(file.name);
      log(`[migrate:${target}] applied  ${file.name}`);
    }
  } finally {
    await pool.end();
  }
  return summary;
}

/** Print applied/pending state without applying anything. */
async function printStatus(target) {
  const cfg = TARGETS[target];
  if (!cfg) throw new Error(`Unknown migration target "${target}" (analytics|syncgo)`);
  const files = listMigrationFiles(cfg.dir);
  const pool = cfg.connect();
  try {
    const exists = await pool.query(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok"
    );
    const appliedByName = new Map();
    if (exists.rows[0].ok) {
      const { rows } = await pool.query(
        'SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name'
      );
      rows.forEach((r) => appliedByName.set(r.name, r));
    }
    for (const file of files) {
      const rec = appliedByName.get(file.name);
      if (!rec) console.log(`pending   ${file.name}`);
      else if (rec.checksum === file.checksum) console.log(`applied   ${file.name} (${rec.applied_at.toISOString()})`);
      // A baseline's checksum mismatch is expected until the next run
      // reconciles it - reporting it as DRIFTED would be a false alarm.
      else if (file.baseline) console.log(`baseline  ${file.name} (applied ${rec.applied_at.toISOString()}; checksum reconciles on next migrate)`);
      else console.log(`DRIFTED   ${file.name} (applied ${rec.applied_at.toISOString()})`);
    }
    for (const name of appliedByName.keys()) {
      if (!files.some((f) => f.name === name)) console.log(`missing   ${name} (recorded as applied, file not found)`);
    }
  } finally {
    await pool.end();
  }
}

module.exports = { runMigrations, printStatus };

// ─── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--')) || 'analytics';
  const status = args.includes('--status');
  const dryRun = args.includes('--dry-run');

  (status ? printStatus(target) : runMigrations(target, { dryRun }))
    .then((summary) => {
      if (summary) {
        const { applied, skipped, drifted, reconciled = [] } = summary;
        console.log(
          `[migrate:${target}] done - ${applied.length} applied, ${skipped} already applied` +
          (reconciled.length ? `, ${reconciled.length} baseline reconciled` : '') +
          (drifted.length ? `, ${drifted.length} DRIFTED` : '')
        );
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[migrate:${target}] FAILED: ${err.message}`);
      process.exit(1);
    });
}
