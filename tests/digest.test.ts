import { describe, it, expect } from 'vitest';
import { rankDigest, digestStats, DIGEST_PERIOD_MS } from '../src/features/digest';
import { openStore } from '../src/persistence';
import { renderNotification } from '../src/gateway/render';
import { tr } from '../src/gateway/strings';
import type { DigestEntry, Notification } from '../src/contracts';

const entry = (o: Partial<DigestEntry> & { itemId: string }): DigestEntry => ({
  title: o.title ?? o.itemId,
  price: o.price ?? 100,
  currency: o.currency ?? 'EUR',
  url: o.url ?? `https://x/${o.itemId}`,
  ...o,
});

describe('rankDigest', () => {
  it('orders great_deal first, then most under fair value, then cheapest', () => {
    const ranked = rankDigest([
      entry({ itemId: 'a', price: 90, dealTag: 'fair_price' }),
      entry({ itemId: 'b', price: 200, dealTag: 'great_deal', deltaPct: -0.2 }),
      entry({ itemId: 'c', price: 80, dealTag: 'great_deal', deltaPct: -0.05 }),
      entry({ itemId: 'd', price: 70 }), // untagged → last group
    ]);
    expect(ranked.map((e) => e.itemId)).toEqual(['b', 'c', 'a', 'd']);
  });
});

describe('digestStats', () => {
  it('reports count and price spread over the dominant currency only', () => {
    const s = digestStats([
      entry({ itemId: 'a', price: 100, currency: 'EUR' }),
      entry({ itemId: 'b', price: 200, currency: 'EUR' }),
      entry({ itemId: 'c', price: 300, currency: 'EUR' }),
      entry({ itemId: 'r', price: 999999, currency: 'RON' }), // minority → excluded
    ]);
    expect(s.count).toBe(4);
    expect(s.currency).toBe('EUR');
    expect(s.median).toBe(200);
    expect(s.min).toBe(100);
    expect(s.max).toBe(300);
  });
});

describe('DigestQueueRepo', () => {
  it('enqueues idempotently, groups pending, lists, clears, and removes all', () => {
    const store = openStore(':memory:');
    store.digestQueue.enqueue(1, 5, { itemId: 'a', title: 'A', price: 100, currency: 'EUR', url: 'u/a', dealTag: 'great_deal' }, 1000);
    store.digestQueue.enqueue(1, 5, { itemId: 'b', title: 'B', price: 200, currency: 'EUR', url: 'u/b' }, 2000);
    store.digestQueue.enqueue(1, 5, { itemId: 'a', title: 'A2', price: 999, currency: 'EUR', url: 'u/a' }, 3000); // dup → ignored

    const pending = store.digestQueue.pending();
    expect(pending).toEqual([{ monitorId: 1, chatId: 5, oldest: 1000, count: 2 }]);

    const items = store.digestQueue.items(1, 5);
    expect(items.map((i) => i.itemId)).toEqual(['a', 'b']); // queued order
    expect(items[0]!.title).toBe('A'); // first enqueue kept, dup ignored
    expect(items[0]!.dealTag).toBe('great_deal');
    expect(items[1]!.dealTag).toBeUndefined();

    store.digestQueue.clear(1, 5);
    expect(store.digestQueue.pending()).toEqual([]);

    store.digestQueue.enqueue(1, 5, { itemId: 'a', title: 'A', price: 1, currency: 'EUR', url: 'u/a' }, 5000);
    store.digestQueue.removeAll(1);
    expect(store.digestQueue.pending()).toEqual([]);
  });
});

describe('renderNotification — digest', () => {
  it('renders a ranked summary with header, stats, and a hot badge on great deals', () => {
    const digest = {
      vendor: 'olx.ro',
      period: 'daily' as const,
      entries: [
        entry({ itemId: 'a', title: 'Cheap Golf', price: 5000, dealTag: 'great_deal', deltaPct: -0.2 }),
        entry({ itemId: 'b', title: 'Fair Golf', price: 7000, dealTag: 'fair_price' }),
      ],
    };
    const msg = renderNotification({ kind: 'digest', chatId: 1, digest } as Notification, 'en');
    expect(msg.text).toContain(tr('en').digest_intro({ count: 2, vendor: 'olx.ro' }));
    expect(msg.text).toContain('Median'); // stats line present
    // Great deal ranked first and flagged.
    const aIdx = msg.text.indexOf('Cheap Golf');
    const bIdx = msg.text.indexOf('Fair Golf');
    expect(aIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(bIdx);
    expect(msg.text).toContain('🔥');
    expect(msg.keyboard).toBeUndefined(); // a multi-item summary has no per-item buttons
  });
});

describe('digest period constants', () => {
  it('daily = 24h, weekly = 7d', () => {
    expect(DIGEST_PERIOD_MS.daily).toBe(86_400_000);
    expect(DIGEST_PERIOD_MS.weekly).toBe(7 * 86_400_000);
  });
});
