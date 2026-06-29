import { describe, it, expect } from 'vitest';
import { openDb, migrate, type DB } from '../src/persistence';

function insertMonitor(db: DB, type: 'search' | 'product', origin: string, interval: number): void {
  db.prepare(
    `INSERT INTO monitors (type, chat_id, vendor, url, filters_json, interval_ms, fast_tier, next_due_at, created_at, origin)
     VALUES (@type, 1, 'V', 'https://v.test/x', '{"sellerVisibility":"both","exclusionKeywords":[]}', @interval, 0, 0, 0, @origin)`,
  ).run({ type, interval, origin });
}
const intervalOf = (db: DB, type: string): number =>
  (db.prepare(`SELECT interval_ms FROM monitors WHERE type = ?`).get(type) as { interval_ms: number }).interval_ms;

describe('interval re-tier backfill (PRAGMA user_version guarded)', () => {
  it('re-tiers existing watches once: search → 2h, product → 12h', () => {
    const db = openDb(':memory:'); // already migrated (user_version = 1)
    insertMonitor(db, 'search', 'user', 999);
    insertMonitor(db, 'product', 'tracked', 999);
    db.pragma('user_version = 0'); // simulate a pre-backfill database

    migrate(db);
    expect(intervalOf(db, 'search')).toBe(7_200_000); // 2h
    expect(intervalOf(db, 'product')).toBe(43_200_000); // 12h
  });

  it('does not re-run (preserves a later manual interval change)', () => {
    const db = openDb(':memory:');
    insertMonitor(db, 'search', 'user', 999);
    db.pragma('user_version = 0');
    migrate(db); // backfills → 2h, sets user_version = 1

    db.prepare(`UPDATE monitors SET interval_ms = 111 WHERE type = 'search'`).run(); // user edit
    migrate(db); // user_version already 1 → no clobber
    expect(intervalOf(db, 'search')).toBe(111);
  });
});
