import { describe, it, expect } from 'vitest';
import { openStore, openDb, maintainDb, type Store } from '../src/persistence';
import type { NewMonitor } from '../src/persistence';
import type { FilterConfig, IScrapedItem, MonitorType } from '../src/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function freshStore(): Store {
  return openStore(':memory:');
}

const baseFilters: FilterConfig = {
  sellerVisibility: 'private',
  exclusionKeywords: ['avariat', 'lovit'],
};

function newMonitorInput(over: Partial<NewMonitor> = {}): NewMonitor {
  return {
    type: 'search' as MonitorType,
    chatId: 42,
    vendor: 'olx',
    url: 'https://www.olx.ro/auto/q-golf/',
    filters: baseFilters,
    intervalMs: 60_000,
    nextDueAt: 1_000,
    ...over,
  };
}

function scrapedItem(over: Partial<IScrapedItem> = {}): IScrapedItem {
  return {
    id: 'item-1',
    title: 'VW Golf 5',
    price: 4300,
    currency: 'RON',
    url: 'https://www.olx.ro/d/item-1',
    isPrivateOwner: true,
    inStock: true,
    ...over,
  };
}

describe('MonitorRepo', () => {
  it('create + get roundtrips filters and defaults fast_tier to false', () => {
    const store = freshStore();
    const created = store.monitors.create(newMonitorInput());

    expect(created.id).toBeGreaterThan(0);
    expect(created.fastTier).toBe(false);
    expect(created.createdAt).toBeGreaterThan(0);

    const fetched = store.monitors.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.filters).toEqual(baseFilters);
    expect(fetched!.fastTier).toBe(false);
    expect(fetched!.chatId).toBe(42);
    expect(fetched!.vendor).toBe('olx');
    expect(fetched!.intervalMs).toBe(60_000);
    expect(fetched!.nextDueAt).toBe(1_000);
  });

  it('get returns undefined for a missing id', () => {
    const store = freshStore();
    expect(store.monitors.get(999)).toBeUndefined();
  });

  it('origin defaults to user and round-trips a tracked origin', () => {
    const store = freshStore();
    const normal = store.monitors.create(newMonitorInput());
    expect(store.monitors.get(normal.id)!.origin).toBe('user');

    const tracked = store.monitors.create(newMonitorInput({ type: 'product', origin: 'tracked' }));
    expect(store.monitors.get(tracked.id)!.origin).toBe('tracked');
  });

  it('listByChat returns only that chat\'s monitors', () => {
    const store = freshStore();
    store.monitors.create(newMonitorInput({ chatId: 1 }));
    store.monitors.create(newMonitorInput({ chatId: 1 }));
    store.monitors.create(newMonitorInput({ chatId: 2 }));

    expect(store.monitors.listByChat(1)).toHaveLength(2);
    expect(store.monitors.listByChat(2)).toHaveLength(1);
    expect(store.monitors.listByChat(3)).toHaveLength(0);
  });

  it('listDue respects next_due_at and orders soonest first', () => {
    const store = freshStore();
    const a = store.monitors.create(newMonitorInput({ nextDueAt: 500 }));
    const b = store.monitors.create(newMonitorInput({ nextDueAt: 100 }));
    store.monitors.create(newMonitorInput({ nextDueAt: 5_000 })); // not yet due

    const due = store.monitors.listDue(1_000);
    expect(due.map((m) => m.id)).toEqual([b.id, a.id]); // ascending next_due_at
  });

  it('update persists mutable fields including filters and fast_tier', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());

    const updatedFilters: FilterConfig = {
      sellerVisibility: 'both',
      exclusionKeywords: ['rabla'],
    };
    store.monitors.update({
      ...m,
      vendor: 'autovit',
      url: 'https://www.autovit.ro/x',
      filters: updatedFilters,
      intervalMs: 30_000,
      fastTier: true,
      nextDueAt: 7_777,
    });

    const reloaded = store.monitors.get(m.id)!;
    expect(reloaded.vendor).toBe('autovit');
    expect(reloaded.url).toBe('https://www.autovit.ro/x');
    expect(reloaded.filters).toEqual(updatedFilters);
    expect(reloaded.intervalMs).toBe(30_000);
    expect(reloaded.fastTier).toBe(true);
    expect(reloaded.nextDueAt).toBe(7_777);
  });

  it('setSchedule toggles fast_tier and re-arms next_due_at', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());

    store.monitors.setSchedule(m.id, 9_999, true);
    let reloaded = store.monitors.get(m.id)!;
    expect(reloaded.fastTier).toBe(true);
    expect(reloaded.nextDueAt).toBe(9_999);

    store.monitors.setSchedule(m.id, 12_345, false);
    reloaded = store.monitors.get(m.id)!;
    expect(reloaded.fastTier).toBe(false);
    expect(reloaded.nextDueAt).toBe(12_345);
  });

  it('delete removes the monitor', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    store.monitors.delete(m.id);
    expect(store.monitors.get(m.id)).toBeUndefined();
  });

  it('deleting a monitor CASCADES to its items and price history (FK on)', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    const item = scrapedItem({ id: 'casc-1' });
    store.items.upsert(m.id, item, 1_000);
    store.priceHistory.append({ monitorId: m.id, itemId: item.id, price: 4300, currency: 'RON', observedAt: 1_000 });
    // Sanity: both rows exist.
    expect(store.items.knownIds(m.id).has('casc-1')).toBe(true);
    expect(store.priceHistory.history(m.id, 'casc-1')).toHaveLength(1);

    store.monitors.delete(m.id);

    // FK ON DELETE CASCADE removed the dependent rows — no orphans left behind.
    expect(store.items.knownIds(m.id).size).toBe(0);
    expect(store.priceHistory.history(m.id, 'casc-1')).toHaveLength(0);
  });
});

describe('ItemRepo', () => {
  it('diffNewIds returns only unseen ids and does not persist them', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());

    store.items.upsert(m.id, scrapedItem({ id: 'a' }), 1_000);

    const fresh = store.items.diffNewIds(m.id, ['a', 'b', 'c']);
    expect(fresh).toEqual(['b', 'c']);

    // diffNewIds is read-only: b and c must remain unknown.
    expect(store.items.diffNewIds(m.id, ['a', 'b', 'c'])).toEqual(['b', 'c']);
    expect(store.items.knownIds(m.id)).toEqual(new Set(['a']));
  });

  it('diffNewIds on an empty input returns an empty array', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    expect(store.items.diffNewIds(m.id, [])).toEqual([]);
  });

  it('upsert inserts then updates in_stock & last_price (getState)', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());

    store.items.upsert(
      m.id,
      scrapedItem({ id: 'x', price: 4300, inStock: true, currency: 'RON' }),
      1_000,
    );
    expect(store.items.getState(m.id, 'x')).toEqual({
      inStock: true,
      lastPrice: 4300,
      currency: 'RON',
    });

    // Conflict on (monitor_id, item_id) updates rather than duplicates.
    store.items.upsert(
      m.id,
      scrapedItem({ id: 'x', price: 3900, inStock: false, currency: 'EUR' }),
      2_000,
    );
    expect(store.items.getState(m.id, 'x')).toEqual({
      inStock: false,
      lastPrice: 3900,
      currency: 'EUR',
    });
    // Still a single row for the item.
    expect(store.items.knownIds(m.id)).toEqual(new Set(['x']));
  });

  it('getState returns undefined for an unknown item', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    expect(store.items.getState(m.id, 'nope')).toBeUndefined();
  });

  it('upsert persists the full item snapshot, readable via getSnapshot', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    store.items.upsert(
      m.id,
      scrapedItem({
        id: 'snap',
        title: 'VW Golf 7',
        price: 12500,
        currency: 'EUR',
        url: 'https://www.olx.ro/d/snap',
        imageUrl: 'https://img/snap.jpg',
        location: 'Cluj-Napoca',
        isPrivateOwner: true,
        inStock: true,
        description: 'Stare excelenta, full options',
        postedAt: 1_700_000_000_000,
        attributes: { year: '2016', km: '145000', fuel: 'Diesel' },
      }),
      1_000,
    );

    const snap = store.items.getSnapshot(m.id, 'snap');
    expect(snap).toMatchObject({
      itemId: 'snap',
      title: 'VW Golf 7',
      lastPrice: 12500,
      currency: 'EUR',
      url: 'https://www.olx.ro/d/snap',
      imageUrl: 'https://img/snap.jpg',
      location: 'Cluj-Napoca',
      sellerPrivate: true,
      inStock: true,
      description: 'Stare excelenta, full options',
      postedAt: 1_700_000_000_000,
      attributes: { year: '2016', km: '145000', fuel: 'Diesel' },
    });
  });

  it('getSnapshot returns undefined for an unknown item', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    expect(store.items.getSnapshot(m.id, 'ghost')).toBeUndefined();
  });

  it('getSnapshot treats a non-object attributes_json (array/corrupt) as absent', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    store.items.upsert(m.id, scrapedItem({ id: 'x', url: 'https://x/x' }), 1_000);
    // Corrupt the attributes_json to an array, then to garbage.
    store.db.prepare(`UPDATE items SET attributes_json = '[1,2,3]' WHERE monitor_id = ? AND item_id = ?`).run(m.id, 'x');
    expect(store.items.getSnapshot(m.id, 'x')?.attributes).toBeUndefined();
    store.db.prepare(`UPDATE items SET attributes_json = 'not json' WHERE monitor_id = ? AND item_id = ?`).run(m.id, 'x');
    expect(store.items.getSnapshot(m.id, 'x')?.attributes).toBeUndefined();
  });

  it('upsert backfills metadata onto a row first stored without it (forward-heal)', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    // Simulate a pre-migration row: only the legacy columns set.
    store.db
      .prepare(
        `INSERT INTO items (monitor_id, item_id, in_stock, last_price, currency, first_seen, last_seen)
         VALUES (?, ?, 1, 100, 'RON', 1, 1)`,
      )
      .run(m.id, 'legacy');
    expect(store.items.getSnapshot(m.id, 'legacy')?.title).toBeUndefined();

    // A normal poll re-sights it with full metadata → row heals.
    store.items.upsert(m.id, scrapedItem({ id: 'legacy', title: 'Healed', url: 'https://x/h' }), 2_000);
    expect(store.items.getSnapshot(m.id, 'legacy')?.title).toBe('Healed');
  });

  it('markAbsent increments gone_count and stamps delisted_at only at the threshold', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    store.items.upsert(m.id, scrapedItem({ id: 'a', title: 'A', url: 'https://x/a' }), 1_000);

    // Cycle 1 absent: gone_count 1, below threshold(2) → not delisted yet.
    let crossed = store.items.markAbsent(m.id, ['a'], 2_000, 2);
    expect(crossed).toEqual([]);
    expect(store.items.delistState(m.id, 'a')?.goneCount).toBe(1);
    expect(store.items.delistState(m.id, 'a')?.delistedAt).toBeUndefined();

    // Cycle 2 absent: gone_count 2 → crosses → delisted_at stamped, id returned once.
    crossed = store.items.markAbsent(m.id, ['a'], 3_000, 2);
    expect(crossed).toEqual(['a']);
    expect(store.items.delistState(m.id, 'a')).toMatchObject({ goneCount: 2, delistedAt: 3_000 });

    // Cycle 3 still absent: stays delisted, NOT reported again (already crossed).
    crossed = store.items.markAbsent(m.id, ['a'], 4_000, 2);
    expect(crossed).toEqual([]);
    expect(store.items.delistState(m.id, 'a')?.delistedAt).toBe(3_000); // unchanged
  });

  it('a re-sight (upsert) clears gone_count and delisted_at', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    store.items.upsert(m.id, scrapedItem({ id: 'a', url: 'https://x/a' }), 1_000);
    store.items.markAbsent(m.id, ['a'], 2_000, 1); // threshold 1 → delisted immediately
    expect(store.items.delistState(m.id, 'a')?.delistedAt).toBe(2_000);

    store.items.upsert(m.id, scrapedItem({ id: 'a', url: 'https://x/a' }), 3_000);
    expect(store.items.delistState(m.id, 'a')?.goneCount).toBe(0);
    expect(store.items.delistState(m.id, 'a')?.delistedAt).toBeUndefined();
  });

  it('markAbsent ignores ids not stored for the monitor', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    expect(store.items.markAbsent(m.id, ['ghost'], 1_000, 1)).toEqual([]);
  });

  it('knownIds reflects upserts and is scoped per monitor', () => {
    const store = freshStore();
    const m1 = store.monitors.create(newMonitorInput());
    const m2 = store.monitors.create(newMonitorInput());

    store.items.upsert(m1.id, scrapedItem({ id: 'a' }), 1_000);
    store.items.upsert(m1.id, scrapedItem({ id: 'b' }), 1_000);
    store.items.upsert(m2.id, scrapedItem({ id: 'c' }), 1_000);

    expect(store.items.knownIds(m1.id)).toEqual(new Set(['a', 'b']));
    expect(store.items.knownIds(m2.id)).toEqual(new Set(['c']));
  });
});

describe('PriceHistoryRepo', () => {
  it('appends entries, orders history ascending, and reports lastPrice', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());

    // Append out of chronological order to prove ordering is by observed_at.
    store.priceHistory.append({ monitorId: m.id, itemId: 'x', price: 4300, currency: 'RON', observedAt: 200 });
    store.priceHistory.append({ monitorId: m.id, itemId: 'x', price: 4500, currency: 'RON', observedAt: 100 });
    store.priceHistory.append({ monitorId: m.id, itemId: 'x', price: 3900, currency: 'RON', observedAt: 300 });
    // Different item should not leak in.
    store.priceHistory.append({ monitorId: m.id, itemId: 'y', price: 1, currency: 'RON', observedAt: 999 });

    const hist = store.priceHistory.history(m.id, 'x');
    expect(hist.map((p) => p.observedAt)).toEqual([100, 200, 300]);
    expect(hist.map((p) => p.price)).toEqual([4500, 4300, 3900]);
    expect(hist[0]).toEqual({
      monitorId: m.id,
      itemId: 'x',
      price: 4500,
      currency: 'RON',
      observedAt: 100,
    });

    // Most recent observed_at wins.
    expect(store.priceHistory.lastPrice(m.id, 'x')).toBe(3900);
  });

  it('history(limit) returns the most recent N change points, still ascending', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    // 6 distinct change points at observed_at 100..105.
    [10, 20, 30, 40, 50, 60].forEach((price, i) =>
      store.priceHistory.append({ monitorId: m.id, itemId: 'x', price, currency: 'RON', observedAt: 100 + i }),
    );
    // Cap to the 3 newest, returned oldest-first for charting.
    const hist = store.priceHistory.history(m.id, 'x', 3);
    expect(hist.map((p) => p.price)).toEqual([40, 50, 60]);
    // Without a limit, the whole series comes back (back-compat default).
    expect(store.priceHistory.history(m.id, 'x')).toHaveLength(6);
  });

  it('append(lastPrice) uses the caller-provided last price and skips the internal lookup', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    // Seed a real prior price so the table has a row at 100.
    store.priceHistory.append({ monitorId: m.id, itemId: 'q', price: 100, currency: 'RON', observedAt: 1 });

    // Caller asserts the last price IS 100 (matching) → append must skip the insert
    // without consulting the table, so no new row appears.
    store.priceHistory.append({ monitorId: m.id, itemId: 'q', price: 100, currency: 'RON', observedAt: 2, lastPrice: 100 });
    expect(store.priceHistory.history(m.id, 'q')).toHaveLength(1);

    // Caller asserts there is NO prior price (undefined, explicitly provided) →
    // append must INSERT even though the table actually holds 100 (proves the
    // provided value is honored over a re-query). 'p' has the key, value undefined.
    store.priceHistory.append({ monitorId: m.id, itemId: 'q', price: 100, currency: 'RON', observedAt: 3, lastPrice: undefined });
    expect(store.priceHistory.history(m.id, 'q')).toHaveLength(2);
  });

  it('lastPrice and history are empty/undefined when nothing logged', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    expect(store.priceHistory.lastPrice(m.id, 'ghost')).toBeUndefined();
    expect(store.priceHistory.history(m.id, 'ghost')).toEqual([]);
  });

  it('store-on-change: a repeated identical price does NOT append a new row', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    // First sight is always recorded.
    store.priceHistory.append({ monitorId: m.id, itemId: 'z', price: 4300, currency: 'RON', observedAt: 100 });
    // Three more polls at the SAME price → no new rows (flat is implied).
    store.priceHistory.append({ monitorId: m.id, itemId: 'z', price: 4300, currency: 'RON', observedAt: 200 });
    store.priceHistory.append({ monitorId: m.id, itemId: 'z', price: 4300, currency: 'RON', observedAt: 300 });
    const hist = store.priceHistory.history(m.id, 'z');
    expect(hist).toHaveLength(1);
    expect(hist[0]!.observedAt).toBe(100); // only the original change point
    expect(store.priceHistory.lastPrice(m.id, 'z')).toBe(4300);
  });

  it('store-on-change: only genuine price changes are recorded (delta log)', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    const seq = [4300, 4300, 4300, 3900, 3900, 4100, 4100];
    seq.forEach((price, i) =>
      store.priceHistory.append({ monitorId: m.id, itemId: 'z', price, currency: 'RON', observedAt: 100 + i }),
    );
    // Only the distinct change points survive: 4300 → 3900 → 4100.
    expect(store.priceHistory.history(m.id, 'z').map((p) => p.price)).toEqual([4300, 3900, 4100]);
    expect(store.priceHistory.lastPrice(m.id, 'z')).toBe(4100);
  });

  it('store-on-change: a price that returns to an earlier value is still recorded', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    [4300, 3900, 4300].forEach((price, i) =>
      store.priceHistory.append({ monitorId: m.id, itemId: 'z', price, currency: 'RON', observedAt: 100 + i }),
    );
    // 4300 → 3900 → 4300: the bounce-back differs from the immediately-previous
    // (3900), so it IS a change and must be kept.
    expect(store.priceHistory.history(m.id, 'z').map((p) => p.price)).toEqual([4300, 3900, 4300]);
  });
});

describe('Store.transaction', () => {
  it('commits all writes on success', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    store.transaction(() => {
      store.items.upsert(m.id, scrapedItem({ id: 'tx-1' }), 1_000);
      store.priceHistory.append({ monitorId: m.id, itemId: 'tx-1', price: 100, currency: 'RON', observedAt: 1_000 });
    });
    expect(store.items.knownIds(m.id).has('tx-1')).toBe(true);
    expect(store.priceHistory.lastPrice(m.id, 'tx-1')).toBe(100);
  });

  it('rolls back EVERY write when the block throws (atomicity)', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    expect(() =>
      store.transaction(() => {
        store.items.upsert(m.id, scrapedItem({ id: 'tx-2' }), 1_000);
        // Second write would happen, then we blow up before commit.
        store.priceHistory.append({ monitorId: m.id, itemId: 'tx-2', price: 100, currency: 'RON', observedAt: 1_000 });
        throw new Error('mid-transaction failure');
      }),
    ).toThrow('mid-transaction failure');
    // Neither write survived — the item upsert was rolled back with the rest.
    expect(store.items.knownIds(m.id).has('tx-2')).toBe(false);
    expect(store.priceHistory.history(m.id, 'tx-2')).toHaveLength(0);
  });
});

describe('maintainDb', () => {
  it('checkpoints + optimizes a disk-backed DB without error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agor-maint-'));
    const path = join(dir, 'agor.db');
    try {
      const db = openDb(path);
      // Generate some WAL by writing, then maintain.
      db.prepare(
        `INSERT INTO monitors (type, chat_id, vendor, url, filters_json, interval_ms, fast_tier, next_due_at, created_at)
         VALUES ('search', 1, 'olx', 'https://x', '{}', 60000, 0, 0, 0)`,
      ).run();
      expect(() => maintainDb(db)).not.toThrow();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prunes dedup entries older than the dedup window, keeping recent ones', () => {
    const store = freshStore();
    const now = 100 * 86_400_000; // day 100
    const dedupMaxAgeMs = 86_400_000; // 1 day
    // Old (2 days ago) and recent (1 hour ago) entries for one chat.
    store.dedup.save(5, { signature: 'old', firstSeenAt: now - 2 * 86_400_000, entry: {} });
    store.dedup.save(5, { signature: 'fresh', firstSeenAt: now - 3_600_000, entry: {} });

    maintainDb(store.db, { now, dedupMaxAgeMs });

    const remaining = store.dedup.load(5).map((e) => e.signature);
    expect(remaining).toEqual(['fresh']);
  });

  it('prunes audit_log entries older than the retention window', () => {
    const store = freshStore();
    const now = 400 * 86_400_000; // day 400
    const auditRetentionDays = 365;
    store.audit.log('allow', 1, 9, now - 400 * 86_400_000, 'too old'); // > 365d
    store.audit.log('deny', 2, 9, now - 100 * 86_400_000, 'keep'); // < 365d
    store.audit.log('promote', 3, 9, now); // now

    maintainDb(store.db, { now, auditRetentionDays });

    const actions = store.audit.recent(100).map((e) => e.action);
    expect(actions).toEqual(['promote', 'deny']); // newest-first; 'allow' pruned
  });

  it('prunes delisted items older than the memory window, keeping active + recent-delist', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    const now = 100 * 86_400_000; // day 100
    const delistedMemoryDays = 30;

    // Active item (never delisted) → kept.
    store.items.upsert(m.id, scrapedItem({ id: 'active', url: 'https://x/a' }), now);
    // Delisted 40 days ago → past the 30-day window → pruned.
    store.items.upsert(m.id, scrapedItem({ id: 'old', url: 'https://x/o' }), now - 41 * 86_400_000);
    store.items.markAbsent(m.id, ['old'], now - 40 * 86_400_000, 1);
    // Delisted 10 days ago → within the window → kept (re-listing still possible).
    store.items.upsert(m.id, scrapedItem({ id: 'recent', url: 'https://x/r' }), now - 11 * 86_400_000);
    store.items.markAbsent(m.id, ['recent'], now - 10 * 86_400_000, 1);

    maintainDb(store.db, { now, delistedMemoryDays });

    expect(store.items.knownIds(m.id)).toEqual(new Set(['active', 'recent']));
  });

  it('does not prune when no retention options are supplied (back-compat)', () => {
    const store = freshStore();
    const now = 400 * 86_400_000;
    store.dedup.save(5, { signature: 'old', firstSeenAt: 0, entry: {} });
    store.audit.log('allow', 1, 9, 0);

    maintainDb(store.db); // no opts → checkpoint/optimize only, no DELETEs

    expect(store.dedup.load(5)).toHaveLength(1);
    expect(store.audit.recent(100)).toHaveLength(1);
  });
});

describe('DedupRepo.pruneExpired', () => {
  it('deletes entries older than maxAgeMs across ALL chats', () => {
    const store = freshStore();
    const now = 50 * 86_400_000;
    store.dedup.save(1, { signature: 'a-old', firstSeenAt: now - 10 * 86_400_000, entry: {} });
    store.dedup.save(2, { signature: 'b-old', firstSeenAt: now - 10 * 86_400_000, entry: {} });
    store.dedup.save(2, { signature: 'b-fresh', firstSeenAt: now - 1_000, entry: {} });

    store.dedup.pruneExpired(now, 86_400_000); // 1-day window

    expect(store.dedup.load(1)).toHaveLength(0);
    expect(store.dedup.load(2).map((e) => e.signature)).toEqual(['b-fresh']);
  });
});

describe('migrate', () => {
  it('is idempotent across repeated opens (re-runs on a fresh handle)', () => {
    // openStore -> openDb -> migrate already ran once; re-running must not throw.
    const store = freshStore();
    expect(() => store.monitors.create(newMonitorInput())).not.toThrow();
  });

  it('creates the items(monitor_id) lookup index', () => {
    const store = freshStore();
    const idx = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='items'`)
      .all() as Array<{ name: string }>;
    expect(idx.some((r) => r.name === 'idx_items_monitor_id')).toBe(true);
  });
});
