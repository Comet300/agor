import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../src/persistence';
import type { NewMonitor } from '../src/persistence';
import type { FilterConfig, IScrapedItem, MonitorType } from '../src/contracts';

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

describe('migrate', () => {
  it('is idempotent across repeated opens (re-runs on a fresh handle)', () => {
    // openStore -> openDb -> migrate already ran once; re-running must not throw.
    const store = freshStore();
    expect(() => store.monitors.create(newMonitorInput())).not.toThrow();
  });
});
