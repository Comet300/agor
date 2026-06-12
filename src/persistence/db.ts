/**
 * SQLite connection + schema migration (Phase 2 persistence layer).
 *
 * A single physical database backs every repo. `openDb` is the only place that
 * constructs a `better-sqlite3` handle; everything else receives the {@link DB}.
 */

import Database from 'better-sqlite3';

/** The concrete better-sqlite3 handle shared by all repos. */
export type DB = Database.Database;

/**
 * Open (or create) the database at `path`, enable WAL for on-disk files, run
 * the idempotent migration, and hand back a ready-to-use handle.
 *
 * Pass `':memory:'` for an ephemeral database (used by the test suite); WAL is
 * skipped there because it has no meaning for an in-memory database.
 */
export function openDb(path: string): DB {
  const db = new Database(path);
  if (path !== ':memory:') {
    // Write-Ahead Logging lets reads proceed concurrently with the writer,
    // which matters once the scheduler and bot share one file.
    db.pragma('journal_mode = WAL');
  }
  // Foreign keys are OFF by default in SQLite and are a per-connection setting,
  // so enable them on every open. Combined with the ON DELETE CASCADE clauses in
  // the schema, deleting a monitor removes its items + price history atomically.
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * Create every table and index if they do not already exist. Safe to call on
 * each boot — `CREATE … IF NOT EXISTS` is a no-op on an up-to-date schema.
 */
export function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitors (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT,
      chat_id      INTEGER,
      vendor       TEXT,
      url          TEXT,
      filters_json TEXT,
      interval_ms  INTEGER,
      fast_tier    INTEGER,
      next_due_at  INTEGER,
      consecutive_failures INTEGER DEFAULT 0,
      created_at   INTEGER
    );

    CREATE TABLE IF NOT EXISTS items (
      monitor_id INTEGER,
      item_id    TEXT,
      in_stock   INTEGER,
      last_price REAL,
      currency   TEXT,
      first_seen INTEGER,
      last_seen  INTEGER,
      PRIMARY KEY (monitor_id, item_id),
      FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id  INTEGER,
      item_id     TEXT,
      price       REAL,
      currency    TEXT,
      observed_at INTEGER,
      FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_prefs (
      chat_id INTEGER PRIMARY KEY,
      lang    TEXT
    );

    CREATE TABLE IF NOT EXISTS access (
      chat_id      INTEGER PRIMARY KEY,
      status       TEXT NOT NULL,
      is_admin     INTEGER NOT NULL DEFAULT 0,
      name         TEXT,
      email        TEXT,
      requested_at INTEGER,
      decided_at   INTEGER,
      decided_by   INTEGER
    );

    CREATE TABLE IF NOT EXISTS dedup (
      chat_id       INTEGER NOT NULL,
      signature     TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      entry_json    TEXT NOT NULL,
      PRIMARY KEY (chat_id, signature)
    );

    CREATE INDEX IF NOT EXISTS idx_monitors_next_due_at
      ON monitors (next_due_at);

    CREATE INDEX IF NOT EXISTS idx_price_history_monitor_item
      ON price_history (monitor_id, item_id);
  `);

  // Idempotent column add for databases created before this column existed
  // (CREATE TABLE IF NOT EXISTS does not alter an existing table).
  const cols = db.prepare('PRAGMA table_info(monitors)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'consecutive_failures')) {
    db.exec('ALTER TABLE monitors ADD COLUMN consecutive_failures INTEGER DEFAULT 0');
  }
}
