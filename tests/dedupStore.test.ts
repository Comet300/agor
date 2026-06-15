/**
 * DedupRepo persistence edge cases. A corrupt `entry_json` row must be skipped
 * during rehydration (never crash the buffer) AND logged, so silent data loss
 * leaves a diagnostic trail (T2-4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture warn() calls from the shared logger so we can assert the corrupt-row
// diagnostic without writing to real stdout.
const warnCalls: Array<{ fields: unknown; msg: string }> = [];
vi.mock('../src/logging/logger', () => ({
  log: () => ({
    warn: (fields: unknown, msg: string) => { warnCalls.push({ fields, msg }); },
    info: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import { openStore, type Store } from '../src/persistence';

describe('DedupRepo.load — corrupt row handling', () => {
  let store: Store;
  beforeEach(() => {
    warnCalls.length = 0;
    store = openStore(':memory:');
  });

  it('skips a corrupt entry_json row but keeps the valid ones', () => {
    store.dedup.save(7, { signature: 'good', firstSeenAt: 1_000, entry: { item: { id: 'a' } } });
    // Inject a row whose entry_json is not valid JSON (simulating WAL truncation).
    store.db
      .prepare(`INSERT INTO dedup (chat_id, signature, first_seen_at, entry_json) VALUES (?, ?, ?, ?)`)
      .run(7, 'broken', 2_000, '{"item": {');

    const loaded = store.dedup.load(7);
    expect(loaded.map((e) => e.signature)).toEqual(['good']); // corrupt row dropped
  });

  it('logs a warning when a row is skipped (no longer a silent swallow)', () => {
    store.db
      .prepare(`INSERT INTO dedup (chat_id, signature, first_seen_at, entry_json) VALUES (?, ?, ?, ?)`)
      .run(7, 'broken', 2_000, 'not json at all');

    store.dedup.load(7);

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]!.fields).toMatchObject({ chatId: 7, signature: 'broken' });
  });
});
