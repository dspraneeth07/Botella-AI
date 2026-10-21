/**
 * Image Generation - SQLite database (file-based, no server needed).
 * Stores ig_generations and ig_store_settings in a local .db file.
 * Exposes a .query(sql, params) interface matching PostgreSQL's pg Pool
 * so the route code works without any changes.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', 'data', 'imagegen');
const DB_PATH = path.join(DB_DIR, 'marketing.db');

let db = null;

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS ig_generations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id       INTEGER NOT NULL,
  location_id     INTEGER NOT NULL,
  product_name    TEXT NOT NULL,
  gen_type        TEXT NOT NULL,
  image_path      TEXT,
  original_price  REAL,
  discount_pct    INTEGER,
  event           TEXT,
  theme           TEXT,
  format          TEXT DEFAULT 'post',
  status          TEXT DEFAULT 'completed',
  error_message   TEXT,
  is_favorite     INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ig_gen_tenant ON ig_generations(client_id, location_id);
CREATE INDEX IF NOT EXISTS idx_ig_gen_created ON ig_generations(client_id, location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ig_store_settings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id             INTEGER NOT NULL,
  location_id           INTEGER NOT NULL,
  store_display_name    TEXT,
  logo_path             TEXT,
  weekly_limit          INTEGER DEFAULT 50,
  generations_this_week INTEGER DEFAULT 0,
  week_start            TEXT DEFAULT (date('now')),
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  UNIQUE(client_id, location_id)
);
`;

function getDB() {
  if (db) return db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  console.log(`[ImageGen DB] SQLite opened: ${DB_PATH}`);
  return db;
}

/**
 * Convert PostgreSQL-style $1, $2 params to SQLite ? params.
 * Also handles minor SQL differences.
 */
function convertSQL(sql, params) {
  let converted = sql;
  let newParams = params ? [...params] : [];

  // Replace $1, $2, ... with ?
  converted = converted.replace(/\$(\d+)/g, '?');

  // PostgreSQL: CURRENT_DATE → SQLite: date('now')
  converted = converted.replace(/\bCURRENT_DATE\b/g, "date('now')");

  // PostgreSQL: NOW() → SQLite: datetime('now')
  converted = converted.replace(/\bNOW\(\)/gi, "datetime('now')");

  // PostgreSQL: SERIAL → already handled by AUTOINCREMENT in CREATE
  // PostgreSQL: BOOLEAN true/false → SQLite 1/0
  if (newParams) {
    newParams = newParams.map(p => {
      if (p === true) return 1;
      if (p === false) return 0;
      return p;
    });
  }

  // PostgreSQL: INTERVAL '7 days' → SQLite: '-7 days' with date() function
  converted = converted.replace(
    /(\w+)\s*-\s*INTERVAL\s*'(\d+)\s*days?'/gi,
    (match, col, days) => `date(${col}, '-${days} days')`
  );

  // PostgreSQL: ::date cast → remove (SQLite handles date strings)
  converted = converted.replace(/::date/g, '');

  // PostgreSQL: COALESCE works in SQLite too - no change needed
  // PostgreSQL: ON CONFLICT (col) DO NOTHING → SQLite: OR IGNORE
  converted = converted.replace(
    /ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+NOTHING/gi,
    'ON CONFLICT DO NOTHING'
  );

  // PostgreSQL: RETURNING * → SQLite doesn't support RETURNING in older versions
  // but better-sqlite3 supports it in newer SQLite. Keep it for now.

  return { sql: converted, params: newParams };
}

/**
 * PostgreSQL-compatible query interface.
 * Returns { rows: [...] } just like pg Pool.query()
 */
function getIGPool() {
  const database = getDB();

  return {
    query: (sql, params) => {
      const { sql: convertedSQL, params: convertedParams } = convertSQL(sql, params);
      const trimmed = convertedSQL.trim().toUpperCase();

      try {
        if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
          const stmt = database.prepare(convertedSQL);
          const rows = stmt.all(...(convertedParams || []));
          // Convert is_favorite from 0/1 to boolean for consistency
          const mapped = rows.map(r => ({
            ...r,
            is_favorite: r.is_favorite !== undefined ? !!r.is_favorite : r.is_favorite,
          }));
          return { rows: mapped };
        } else if (trimmed.startsWith('INSERT') && convertedSQL.toUpperCase().includes('RETURNING')) {
          const stmt = database.prepare(convertedSQL);
          const row = stmt.get(...(convertedParams || []));
          return { rows: row ? [row] : [] };
        } else {
          const stmt = database.prepare(convertedSQL);
          const result = stmt.run(...(convertedParams || []));
          return { rows: [], rowCount: result.changes };
        }
      } catch (err) {
        // If RETURNING fails, retry without it
        if (err.message.includes('RETURNING') || err.message.includes('returning')) {
          const noReturning = convertedSQL.replace(/\s+RETURNING\s+.*/i, '');
          const stmt = database.prepare(noReturning);
          const result = stmt.run(...(convertedParams || []));
          return { rows: [], rowCount: result.changes };
        }
        throw err;
      }
    },
  };
}

function ensureTables() {
  try {
    const database = getDB();
    database.exec(CREATE_TABLES_SQL);
    console.log('[ImageGen DB] Tables verified/created successfully');
  } catch (err) {
    console.error('[ImageGen DB] Table creation error:', err.message);
  }
}

module.exports = { getIGPool, ensureTables };
