import { describe, it, expect } from "vitest";
import { openStore, openDb, maintainDb, type Store } from "../src/persistence";
import type { NewMonitor } from "../src/persistence";
import type { FilterConfig, IScrapedItem, MonitorType } from "../src/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freshStore(): Store {
  return openStore(":memory:");
}

const baseFilters: FilterConfig = {
  sellerVisibility: "private",
  exclusionKeywords: ["avariat", "lovit"],
};

function newMonitorInput(over: Partial<NewMonitor> = {}): NewMonitor {
  return {
    type: "search" as MonitorType,
    chatId: 42,
    vendor: "olx",
    url: "https://www.olx.ro/auto/q-golf/",
    filters: baseFilters,
    intervalMs: 60_000,
    nextDueAt: 1_000,
    ...over,
  };
}

function scrapedItem(over: Partial<IScrapedItem> = {}): IScrapedItem {
  return {
    id: "item-1",
    title: "VW Golf 5",
    price: 4300,
    currency: "RON",
    url: "https://www.olx.ro/d/item-1",
    isPrivateOwner: true,
    inStock: true,
    ...over,
  };
}

describe("MonitorRepo", () => {
  it("create + get roundtrips filters and defaults fast_tier to false", () => {
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
    expect(fetched!.vendor).toBe("olx");
    expect(fetched!.intervalMs).toBe(60_000);
    expect(fetched!.nextDueAt).toBe(1_000);
  });

  it("get returns undefined for a missing id", () => {
    const store = freshStore();
    expect(store.monitors.get(999)).toBeUndefined();
  });

  it("sets/clears a collection and lists a chat's watches by collection", () => {
    const store = freshStore();
    const a = store.monitors.create(newMonitorInput({ chatId: 7 }));
    const b = store.monitors.create(newMonitorInput({ chatId: 7 }));
    const c = store.monitors.create(newMonitorInput({ chatId: 7 }));
    store.monitors.setCollection(a.id, 'Winter tires');
    store.monitors.setCollection(b.id, 'Winter tires');
    store.monitors.setCollection(c.id, 'Apartment hunt');

    expect(store.monitors.get(a.id)!.collection).toBe('Winter tires');
    expect(store.monitors.listByCollection(7, 'Winter tires').map((m) => m.id)).toEqual([a.id, b.id]);
    expect(store.monitors.listByCollection(7, 'Apartment hunt').map((m) => m.id)).toEqual([c.id]);
    expect(store.monitors.listByCollection(99, 'Winter tires')).toEqual([]); // chat isolation

    store.monitors.setCollection(a.id, ''); // clear
    expect(store.monitors.get(a.id)!.collection).toBeUndefined();
    expect(store.monitors.listByCollection(7, 'Winter tires').map((m) => m.id)).toEqual([b.id]);
  });

  it("listByChat returns only that chat's monitors", () => {
    const store = freshStore();
    store.monitors.create(newMonitorInput({ chatId: 1 }));
    store.monitors.create(newMonitorInput({ chatId: 1 }));
    store.monitors.create(newMonitorInput({ chatId: 2 }));

    expect(store.monitors.listByChat(1)).toHaveLength(2);
    expect(store.monitors.listByChat(2)).toHaveLength(1);
    expect(store.monitors.listByChat(3)).toHaveLength(0);
  });

  it("listDue respects next_due_at and orders soonest first", () => {
    const store = freshStore();
    const a = store.monitors.create(newMonitorInput({ nextDueAt: 500 }));
    const b = store.monitors.create(newMonitorInput({ nextDueAt: 100 }));
    store.monitors.create(newMonitorInput({ nextDueAt: 5_000 })); // not yet due

    const due = store.monitors.listDue(1_000);
    expect(due.map((m) => m.id)).toEqual([b.id, a.id]); // ascending next_due_at
  });

  it("listDue skips paused watches", () => {
    const store = freshStore();
    const a = store.monitors.create(newMonitorInput({ nextDueAt: 100 }));
    const b = store.monitors.create(newMonitorInput({ nextDueAt: 200 }));
    expect(a.paused).toBe(false); // default off

    store.monitors.setPaused(a.id, true);
    expect(store.monitors.listDue(1_000).map((m) => m.id)).toEqual([b.id]); // a hidden
    expect(store.monitors.get(a.id)!.paused).toBe(true);

    store.monitors.setPaused(a.id, false);
    expect(store.monitors.listDue(1_000).map((m) => m.id)).toEqual([a.id, b.id]); // back
  });

  it("setLabel sets and clears a watch label", () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    expect(m.label).toBeUndefined();

    store.monitors.setLabel(m.id, "Corolla < 15k");
    expect(store.monitors.get(m.id)!.label).toBe("Corolla < 15k");

    store.monitors.setLabel(m.id, ""); // clear
    expect(store.monitors.get(m.id)!.label).toBeUndefined();
  });

  it("update persists mutable fields including filters and fast_tier", () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());

    const updatedFilters: FilterConfig = {
      sellerVisibility: "both",
      exclusionKeywords: ["rabla"],
    };
    store.monitors.update({
      ...m,
      vendor: "autovit",
      url: "https://www.autovit.ro/x",
      filters: updatedFilters,
      intervalMs: 30_000,
      fastTier: true,
      nextDueAt: 7_777,
    });

    const reloaded = store.monitors.get(m.id)!;
    expect(reloaded.vendor).toBe("autovit");
    expect(reloaded.url).toBe("https://www.autovit.ro/x");
    expect(reloaded.filters).toEqual(updatedFilters);
    expect(reloaded.intervalMs).toBe(30_000);
    expect(reloaded.fastTier).toBe(true);
    expect(reloaded.nextDueAt).toBe(7_777);
  });

  it("setSchedule toggles fast_tier and re-arms next_due_at", () => {
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

  it("delete removes the monitor", () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    store.monitors.delete(m.id);
    expect(store.monitors.get(m.id)).toBeUndefined();
  });

  it("deleting a monitor CASCADES to its items and price history (FK on)", () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    const item = scrapedItem({ id: "casc-1" });
    store.items.upsert(m.id, item, 1_000);
    store.priceHistory.append({
      monitorId: m.id,
      itemId: item.id,
      price: 4300,
      currency: "RON",
      observedAt: 1_000,
    });
    // Sanity: both rows exist.
    expect(store.items.knownIds(m.id).has("casc-1")).toBe(true);
    expect(store.priceHistory.history(m.id, "casc-1")).toHaveLength(1);

    store.monitors.delete(m.id);

    // FK ON DELETE CASCADE removed the dependent rows — no orphans left behind.
    expect(store.items.knownIds(m.id).size).toBe(0);
    expect(store.priceHistory.history(m.id, "casc-1")).toHaveLength(0);
  });
});

describe("ItemRepo", () => {
  it("diffNewIds returns only unseen ids and does not persist them", () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());

    store.items.upsert(m.id, scrapedItem({ id: "a" }), 1_000);

    const fresh = store.items.diffNewIds(m.id, ["a", "b", "c"]);
    expect(fresh).toEqual(["b", "c"]);

    // diffNewIds is read-only: b and c must remain unknown.
    expect(store.items.diffNewIds(m.id, ["a", "b", "c"])).toEqual(["b", "c"]);
    expect(store.items.knownIds(m.id)).toEqual(new Set(["a"]));
  });

  it("diffNewIds on an empty input returns an empty array", () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    expect(store.items.diffNewIds(m.id, [])).toEqual([]);
  });

  it("upsert inserts then updates in_stock & last_price (getState)", () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());

    store.items.upsert(
      m.id,
      scrapedItem({ id: "x", price: 4300, inStock: true, currency: "RON" }),
      1_000,
    );
    expect(store.items.getState(m.id, "x")).toEqual({
      inStock: true,
      lastPrice: 4300,
      currency: "RON",
    });

    // Conflict on (monitor_id, item_id) updates rather than duplicates.
    store.items.upsert(
      m.id,
      scrapedItem({ id: "x", price: 3900, inStock: false, currency: "EUR" }),
      2_000,
    );
    expect(store.items.getState(m.id, "x")).toEqual({
      inStock: false,
      lastPrice: 3900,
      currency: "EUR",
    });
    // Still a single row for the item.
    expect(store.items.knownIds(m.id)).toEqual(new Set(["x"]));
  });

  it("getState returns undefined for an unknown item", () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    expect(store.items.getState(m.id, "nope")).toBeUndefined();
  });

  it("knownIds reflects upserts and is scoped per monitor", () => {
    const store = freshStore();
    const m1 = store.monitors.create(newMonitorInput());
    const m2 = store.monitors.create(newMonitorInput());

    store.items.upsert(m1.id, scrapedItem({ id: "a" }), 1_000);
    store.items.upsert(m1.id, scrapedItem({ id: "b" }), 1_000);
    store.items.upsert(m2.id, scrapedItem({ id: "c" }), 1_000);

    expect(store.items.knownIds(m1.id)).toEqual(new Set(["a", "b"]));
    expect(store.items.knownIds(m2.id)).toEqual(new Set(["c"]));
  });
});

describe('ItemRepo.browse', () => {
  it('returns a chat\'s items across all its monitors, newest-seen first, paginated', () => {
    const store = freshStore();
    const m1 = store.monitors.create(newMonitorInput({ chatId: 7 }));
    const m2 = store.monitors.create(newMonitorInput({ chatId: 7, url: 'https://www.olx.ro/auto/q-passat/' }));
    const other = store.monitors.create(newMonitorInput({ chatId: 99 }));

    // last_seen ascending by insert; browse must return DESC (newest first).
    store.items.upsert(m1.id, scrapedItem({ id: 'a', title: 'A', url: 'https://x/a' }), 1_000);
    store.items.upsert(m2.id, scrapedItem({ id: 'b', title: 'B', url: 'https://x/b' }), 2_000);
    store.items.upsert(m1.id, scrapedItem({ id: 'c', title: 'C', url: 'https://x/c' }), 3_000);
    store.items.upsert(other.id, scrapedItem({ id: 'z', title: 'Z', url: 'https://x/z' }), 9_000); // not chat 7

    expect(store.items.countForChat(7)).toBe(3);
    const page = store.items.browse(7, 2, 0);
    expect(page.map((s) => s.itemId)).toEqual(['c', 'b']); // newest two, DESC
    expect(page[0]!.title).toBe('C'); // full snapshot carried
    expect(store.items.browse(7, 2, 2).map((s) => s.itemId)).toEqual(['a']); // second page
    expect(store.items.browse(99, 10, 0).map((s) => s.itemId)).toEqual(['z']); // isolation
  });

  it('excludes de-listed items from browse and the count', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput({ chatId: 5 }));
    store.items.upsert(m.id, scrapedItem({ id: 'live', title: 'Live', url: 'https://x/l' }), 1_000);
    store.items.upsert(m.id, scrapedItem({ id: 'gone', title: 'Gone', url: 'https://x/g' }), 1_000);
    store.items.markAbsent(m.id, ['gone'], 2_000, 1); // delist 'gone'

    expect(store.items.countForChat(5)).toBe(1);
    expect(store.items.browse(5, 10, 0).map((s) => s.itemId)).toEqual(['live']);
  });

  it('returns an empty page for a chat with no items', () => {
    const store = freshStore();
    expect(store.items.countForChat(123)).toBe(0);
    expect(store.items.browse(123, 10, 0)).toEqual([]);
  });

  it('browseByMonitor scopes to one watch, newest first, de-listed excluded', () => {
    const store = freshStore();
    const m1 = store.monitors.create(newMonitorInput({ chatId: 7 }));
    const m2 = store.monitors.create(newMonitorInput({ chatId: 7, url: 'https://www.olx.ro/auto/q-passat/' }));
    store.items.upsert(m1.id, scrapedItem({ id: 'a', title: 'A', url: 'https://x/a' }), 1_000);
    store.items.upsert(m1.id, scrapedItem({ id: 'b', title: 'B', url: 'https://x/b' }), 3_000);
    store.items.upsert(m2.id, scrapedItem({ id: 'c', title: 'C', url: 'https://x/c' }), 2_000);
    store.items.upsert(m1.id, scrapedItem({ id: 'd', title: 'D', url: 'https://x/d' }), 4_000);
    store.items.markAbsent(m1.id, ['d'], 5_000, 1); // delist d on m1

    expect(store.items.browseByMonitor(m1.id, 10, 0).map((s) => s.itemId)).toEqual(['b', 'a']); // m1 only, DESC, no d
    expect(store.items.browseByMonitor(m2.id, 10, 0).map((s) => s.itemId)).toEqual(['c']);     // m2 isolation
  });

  it('sellersForMonitor lists distinct sellers (name, else phone) by frequency', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    store.items.upsert(m.id, scrapedItem({ id: 'a', sellerName: 'Dealer X' }), 1_000);
    store.items.upsert(m.id, scrapedItem({ id: 'b', sellerName: 'Dealer X' }), 1_000);
    store.items.upsert(m.id, scrapedItem({ id: 'c', phone: '0712345678' }), 1_000); // no name → phone
    store.items.upsert(m.id, scrapedItem({ id: 'd' }), 1_000);                        // neither → skipped

    const sellers = store.items.sellersForMonitor(m.id);
    expect(sellers[0]).toMatchObject({ value: 'Dealer X', kind: 'name', count: 2 }); // most frequent first
    expect(sellers.some((s) => s.kind === 'phone' && s.value === '0712345678')).toBe(true);
    expect(sellers).toHaveLength(2);
  });

  it('browseCountsByMonitor tallies browsable items per monitor', () => {
    const store = freshStore();
    const m1 = store.monitors.create(newMonitorInput({ chatId: 7 }));
    const m2 = store.monitors.create(newMonitorInput({ chatId: 7, url: 'https://www.olx.ro/auto/q-passat/' }));
    const other = store.monitors.create(newMonitorInput({ chatId: 99 }));
    store.items.upsert(m1.id, scrapedItem({ id: 'a', url: 'https://x/a' }), 1_000);
    store.items.upsert(m1.id, scrapedItem({ id: 'b', url: 'https://x/b' }), 1_000);
    store.items.upsert(m2.id, scrapedItem({ id: 'c', url: 'https://x/c' }), 1_000);
    store.items.upsert(m2.id, scrapedItem({ id: 'gone', url: 'https://x/g' }), 1_000);
    store.items.markAbsent(m2.id, ['gone'], 2_000, 1); // delisted → excluded from the tally
    store.items.upsert(other.id, scrapedItem({ id: 'z', url: 'https://x/z' }), 1_000); // chat 99

    const counts = store.items.browseCountsByMonitor(7);
    expect(counts.get(m1.id)).toBe(2);
    expect(counts.get(m2.id)).toBe(1);
    expect(counts.has(other.id)).toBe(false); // other chat not included
  });
});

describe('ItemFlagsRepo', () => {
  it('saves/unsets, checks, lists the shortlist, and tracks dismissed ids', () => {
    const store = freshStore();
    store.itemFlags.set(7, 'a', 1, 'saved', 100);
    store.itemFlags.set(7, 'b', 1, 'saved', 200);
    store.itemFlags.set(7, 'c', 1, 'dismissed', 300);

    expect(store.itemFlags.has(7, 'a', 'saved')).toBe(true);
    expect(store.itemFlags.has(7, 'a', 'dismissed')).toBe(false);
    expect(store.itemFlags.listSaved(7).map((s) => s.itemId)).toEqual(['b', 'a']); // newest first
    expect([...store.itemFlags.dismissedIds(7)]).toEqual(['c']);

    store.itemFlags.unset(7, 'a', 'saved');
    expect(store.itemFlags.has(7, 'a', 'saved')).toBe(false);
    expect(store.itemFlags.dismissedIds(99).size).toBe(0); // chat isolation
  });

  it('attaches, reads, surfaces, and clears a per-item note (auto-saves the item)', () => {
    const store = freshStore();
    store.itemFlags.setNote(7, 'x', 1, 'nice area, noisy street', 100); // implies saved
    expect(store.itemFlags.has(7, 'x', 'saved')).toBe(true);
    expect(store.itemFlags.getNote(7, 'x')).toBe('nice area, noisy street');
    expect(store.itemFlags.listSaved(7).find((s) => s.itemId === 'x')?.note).toBe('nice area, noisy street');

    store.itemFlags.setNote(7, 'x', 1, '', 200); // clear note, stays saved
    expect(store.itemFlags.getNote(7, 'x')).toBeUndefined();
    expect(store.itemFlags.has(7, 'x', 'saved')).toBe(true);
    expect(store.itemFlags.getNote(8, 'x')).toBeUndefined(); // chat isolation
  });
});

describe('WatchSubscribersRepo', () => {
  it('adds (idempotent), lists, counts, removes, and clears subscribers', () => {
    const store = freshStore();
    store.watchSubscribers.add(1, 777, 100);
    store.watchSubscribers.add(1, -1001, 200);
    store.watchSubscribers.add(1, 777, 300); // duplicate → no-op

    expect(store.watchSubscribers.listChats(1)).toEqual([777, -1001]); // insertion order
    expect(store.watchSubscribers.count(1)).toBe(2);
    expect(store.watchSubscribers.count(2)).toBe(0); // watch isolation

    expect(store.watchSubscribers.remove(1, 777)).toBe(true);
    expect(store.watchSubscribers.remove(1, 555)).toBe(false); // not a subscriber
    expect(store.watchSubscribers.listChats(1)).toEqual([-1001]);

    store.watchSubscribers.removeAll(1);
    expect(store.watchSubscribers.count(1)).toBe(0);
  });

  it('tracks the editor (collaborator) role and can upgrade a viewer', () => {
    const store = freshStore();
    store.watchSubscribers.add(1, 777, 100); // viewer by default
    expect(store.watchSubscribers.isEditor(1, 777)).toBe(false);
    store.watchSubscribers.add(1, 777, 200, true); // re-share as editor → upgrade
    expect(store.watchSubscribers.isEditor(1, 777)).toBe(true);
    expect(store.watchSubscribers.count(1)).toBe(1); // still one row
    expect(store.watchSubscribers.isEditor(1, 555)).toBe(false); // unknown chat
  });
});

describe('PriceHistoryRepo', () => {
  it('appends entries, orders history ascending, and reports lastPrice', () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());

    // Append out of chronological order to prove ordering is by observed_at.
    store.priceHistory.append({
      monitorId: m.id,
      itemId: "x",
      price: 4300,
      currency: "RON",
      observedAt: 200,
    });
    store.priceHistory.append({
      monitorId: m.id,
      itemId: "x",
      price: 4500,
      currency: "RON",
      observedAt: 100,
    });
    store.priceHistory.append({
      monitorId: m.id,
      itemId: "x",
      price: 3900,
      currency: "RON",
      observedAt: 300,
    });
    // Different item should not leak in.
    store.priceHistory.append({
      monitorId: m.id,
      itemId: "y",
      price: 1,
      currency: "RON",
      observedAt: 999,
    });

    const hist = store.priceHistory.history(m.id, "x");
    expect(hist.map((p) => p.observedAt)).toEqual([100, 200, 300]);
    expect(hist.map((p) => p.price)).toEqual([4500, 4300, 3900]);
    expect(hist[0]).toEqual({
      monitorId: m.id,
      itemId: "x",
      price: 4500,
      currency: "RON",
      observedAt: 100,
    });

    // Most recent observed_at wins.
    expect(store.priceHistory.lastPrice(m.id, "x")).toBe(3900);
  });

  it("history(limit) returns the most recent N change points, still ascending", () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    // 6 distinct change points at observed_at 100..105.
    [10, 20, 30, 40, 50, 60].forEach((price, i) =>
      store.priceHistory.append({
        monitorId: m.id,
        itemId: "x",
        price,
        currency: "RON",
        observedAt: 100 + i,
      }),
    );
    // Cap to the 3 newest, returned oldest-first for charting.
    const hist = store.priceHistory.history(m.id, "x", 3);
    expect(hist.map((p) => p.price)).toEqual([40, 50, 60]);
    // Without a limit, the whole series comes back (back-compat default).
    expect(store.priceHistory.history(m.id, "x")).toHaveLength(6);
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

  it("lastPrice and history are empty/undefined when nothing logged", () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    expect(store.priceHistory.lastPrice(m.id, "ghost")).toBeUndefined();
    expect(store.priceHistory.history(m.id, "ghost")).toEqual([]);
  });

  it("store-on-change: a repeated identical price does NOT append a new row", () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    // First sight is always recorded.
    store.priceHistory.append({
      monitorId: m.id,
      itemId: "z",
      price: 4300,
      currency: "RON",
      observedAt: 100,
    });
    // Three more polls at the SAME price → no new rows (flat is implied).
    store.priceHistory.append({
      monitorId: m.id,
      itemId: "z",
      price: 4300,
      currency: "RON",
      observedAt: 200,
    });
    store.priceHistory.append({
      monitorId: m.id,
      itemId: "z",
      price: 4300,
      currency: "RON",
      observedAt: 300,
    });
    const hist = store.priceHistory.history(m.id, "z");
    expect(hist).toHaveLength(1);
    expect(hist[0]!.observedAt).toBe(100); // only the original change point
    expect(store.priceHistory.lastPrice(m.id, "z")).toBe(4300);
  });

  it("store-on-change: only genuine price changes are recorded (delta log)", () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    const seq = [4300, 4300, 4300, 3900, 3900, 4100, 4100];
    seq.forEach((price, i) =>
      store.priceHistory.append({
        monitorId: m.id,
        itemId: "z",
        price,
        currency: "RON",
        observedAt: 100 + i,
      }),
    );
    // Only the distinct change points survive: 4300 → 3900 → 4100.
    expect(store.priceHistory.history(m.id, "z").map((p) => p.price)).toEqual([
      4300, 3900, 4100,
    ]);
    expect(store.priceHistory.lastPrice(m.id, "z")).toBe(4100);
  });

  it("store-on-change: a price that returns to an earlier value is still recorded", () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    [4300, 3900, 4300].forEach((price, i) =>
      store.priceHistory.append({
        monitorId: m.id,
        itemId: "z",
        price,
        currency: "RON",
        observedAt: 100 + i,
      }),
    );
    // 4300 → 3900 → 4300: the bounce-back differs from the immediately-previous
    // (3900), so it IS a change and must be kept.
    expect(store.priceHistory.history(m.id, "z").map((p) => p.price)).toEqual([
      4300, 3900, 4300,
    ]);
  });
});

describe("Store.transaction", () => {
  it("commits all writes on success", () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    store.transaction(() => {
      store.items.upsert(m.id, scrapedItem({ id: "tx-1" }), 1_000);
      store.priceHistory.append({
        monitorId: m.id,
        itemId: "tx-1",
        price: 100,
        currency: "RON",
        observedAt: 1_000,
      });
    });
    expect(store.items.knownIds(m.id).has("tx-1")).toBe(true);
    expect(store.priceHistory.lastPrice(m.id, "tx-1")).toBe(100);
  });

  it("rolls back EVERY write when the block throws (atomicity)", () => {
    const store = freshStore();
    const m = store.monitors.create(newMonitorInput());
    expect(() =>
      store.transaction(() => {
        store.items.upsert(m.id, scrapedItem({ id: "tx-2" }), 1_000);
        // Second write would happen, then we blow up before commit.
        store.priceHistory.append({
          monitorId: m.id,
          itemId: "tx-2",
          price: 100,
          currency: "RON",
          observedAt: 1_000,
        });
        throw new Error("mid-transaction failure");
      }),
    ).toThrow("mid-transaction failure");
    // Neither write survived — the item upsert was rolled back with the rest.
    expect(store.items.knownIds(m.id).has("tx-2")).toBe(false);
    expect(store.priceHistory.history(m.id, "tx-2")).toHaveLength(0);
  });
});

describe("maintainDb", () => {
  it("checkpoints + optimizes a disk-backed DB without error", () => {
    const dir = mkdtempSync(join(tmpdir(), "agor-maint-"));
    const path = join(dir, "agor.db");
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

  it("prunes dedup entries older than the dedup window, keeping recent ones", () => {
    const store = freshStore();
    const now = 100 * 86_400_000; // day 100
    const dedupMaxAgeMs = 86_400_000; // 1 day
    // Old (2 days ago) and recent (1 hour ago) entries for one chat.
    store.dedup.save(5, {
      signature: "old",
      firstSeenAt: now - 2 * 86_400_000,
      entry: {},
    });
    store.dedup.save(5, {
      signature: "fresh",
      firstSeenAt: now - 3_600_000,
      entry: {},
    });

    maintainDb(store.db, { now, dedupMaxAgeMs });

    const remaining = store.dedup.load(5).map((e) => e.signature);
    expect(remaining).toEqual(["fresh"]);
  });

  it("prunes audit_log entries older than the retention window", () => {
    const store = freshStore();
    const now = 400 * 86_400_000; // day 400
    const auditRetentionDays = 365;
    store.audit.log("allow", 1, 9, now - 400 * 86_400_000, "too old"); // > 365d
    store.audit.log("deny", 2, 9, now - 100 * 86_400_000, "keep"); // < 365d
    store.audit.log("promote", 3, 9, now); // now

    maintainDb(store.db, { now, auditRetentionDays });

    const actions = store.audit.recent(100).map((e) => e.action);
    expect(actions).toEqual(["promote", "deny"]); // newest-first; 'allow' pruned
  });

  it("does not prune when no retention options are supplied (back-compat)", () => {
    const store = freshStore();
    const now = 400 * 86_400_000;
    store.dedup.save(5, { signature: "old", firstSeenAt: 0, entry: {} });
    store.audit.log("allow", 1, 9, 0);

    maintainDb(store.db); // no opts → checkpoint/optimize only, no DELETEs

    expect(store.dedup.load(5)).toHaveLength(1);
    expect(store.audit.recent(100)).toHaveLength(1);
  });
});

describe("DedupRepo.pruneExpired", () => {
  it("deletes entries older than maxAgeMs across ALL chats", () => {
    const store = freshStore();
    const now = 50 * 86_400_000;
    store.dedup.save(1, {
      signature: "a-old",
      firstSeenAt: now - 10 * 86_400_000,
      entry: {},
    });
    store.dedup.save(2, {
      signature: "b-old",
      firstSeenAt: now - 10 * 86_400_000,
      entry: {},
    });
    store.dedup.save(2, {
      signature: "b-fresh",
      firstSeenAt: now - 1_000,
      entry: {},
    });

    store.dedup.pruneExpired(now, 86_400_000); // 1-day window

    expect(store.dedup.load(1)).toHaveLength(0);
    expect(store.dedup.load(2).map((e) => e.signature)).toEqual(["b-fresh"]);
  });
});

describe("migrate", () => {
  it("is idempotent across repeated opens (re-runs on a fresh handle)", () => {
    // openStore -> openDb -> migrate already ran once; re-running must not throw.
    const store = freshStore();
    expect(() => store.monitors.create(newMonitorInput())).not.toThrow();
  });

  it("creates the items(monitor_id) lookup index", () => {
    const store = freshStore();
    const idx = store.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='items'`,
      )
      .all() as Array<{ name: string }>;
    expect(idx.some((r) => r.name === "idx_items_monitor_id")).toBe(true);
  });
});
