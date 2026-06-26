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
  if (path !== ':memory:') {
    // One-time, on-boot planner-stat refresh for this session. Cheap, synchronous,
    // not in any hot path. (No-op for in-memory test DBs.)
    db.pragma('optimize');
  }
  return db;
}

/** Optional retention pruning during {@link maintainDb}; all fields opt-in. */
export interface MaintainOptions {
  /** Injected clock (epoch ms). Required for any age-based pruning below. */
  now?: number;
  /** Delete dedup rows older than this many ms (needs `now`). */
  dedupMaxAgeMs?: number;
  /** Delete audit_log rows older than this many days (needs `now`). */
  auditRetentionDays?: number;
}

/**
 * Periodic DB housekeeping for a long-running, churn-heavy deployment (e.g. a
 * Pi). Checkpoints the WAL back into the main file (TRUNCATE resets the WAL so
 * it cannot grow without bound) and refreshes planner stats. When retention
 * options are supplied (with a `now`), also prunes append-only tables that would
 * otherwise grow unbounded — dedup signatures and the audit log. Best-effort:
 * the caller swallows failures so it never crashes a polling cycle.
 */
export function maintainDb(db: DB, opts: MaintainOptions = {}): void {
  const { now, dedupMaxAgeMs, auditRetentionDays } = opts;
  if (now !== undefined && dedupMaxAgeMs !== undefined) {
    db.prepare(`DELETE FROM dedup WHERE first_seen_at < ?`).run(now - dedupMaxAgeMs);
  }
  if (now !== undefined && auditRetentionDays !== undefined) {
    db.prepare(`DELETE FROM audit_log WHERE at < ?`).run(now - auditRetentionDays * 86_400_000);
  }
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.pragma('optimize');
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

    CREATE TABLE IF NOT EXISTS audit_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      action         TEXT NOT NULL,
      target_chat_id INTEGER NOT NULL,
      actor_chat_id  INTEGER NOT NULL,
      at             INTEGER NOT NULL,
      note           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_monitors_next_due_at
      ON monitors (next_due_at);

    CREATE INDEX IF NOT EXISTS idx_price_history_monitor_item
      ON price_history (monitor_id, item_id);

    CREATE INDEX IF NOT EXISTS idx_items_monitor_id
      ON items (monitor_id);

    CREATE INDEX IF NOT EXISTS idx_audit_log_at
      ON audit_log (at DESC);
  `);

  // Idempotent column additions for databases created before these columns existed.
  const monitorCols = db.prepare('PRAGMA table_info(monitors)').all() as Array<{ name: string }>;
  if (!monitorCols.some((c) => c.name === 'consecutive_failures')) {
    db.exec('ALTER TABLE monitors ADD COLUMN consecutive_failures INTEGER DEFAULT 0');
  }
  if (!monitorCols.some((c) => c.name === 'origin')) {
    db.exec("ALTER TABLE monitors ADD COLUMN origin TEXT DEFAULT 'user'");
  }

  const itemCols = db.prepare('PRAGMA table_info(items)').all() as Array<{ name: string }>;
  const itemAlters: Array<[string, string]> = [
    ['title',           'TEXT'],
    ['url',             'TEXT'],
    ['image_url',       'TEXT'],
    ['location',        'TEXT'],
    ['seller_private',  'INTEGER'],
    ['posted_at',       'INTEGER'],
    ['description',     'TEXT'],
    ['attributes_json', 'TEXT'],
    ['gone_count',      'INTEGER DEFAULT 0'],
    ['delisted_at',     'INTEGER'],
  ];
  for (const [col, type] of itemAlters) {
    if (!itemCols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE items ADD COLUMN ${col} ${type}`);
    }
  }
}
