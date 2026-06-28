import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../src/persistence';
import { sellerReputation, SELLER_FAST_MS } from '../src/features/sellerReputation';
import type { IScrapedItem } from '../src/contracts';

const DAY = 86_400_000;

describe('sellerReputation (pure scoring)', () => {
  it('is neutral with too little history', () => {
    expect(sellerReputation({ listings: 2, delisted: 2, fastDelists: 2, relists: 9 }).trust).toBe('neutral');
  });

  it('flags caution on frequent fast flips', () => {
    const r = sellerReputation({ listings: 6, delisted: 4, fastDelists: 4, relists: 0 });
    expect(r.trust).toBe('caution');
    expect(r.reasons).toContain('frequent_fast_flips');
  });

  it('flags caution on frequent relisting', () => {
    const r = sellerReputation({ listings: 4, delisted: 1, fastDelists: 0, relists: 8 });
    expect(r.trust).toBe('caution');
    expect(r.reasons).toContain('frequent_relisting');
  });

  it('rewards a sizeable, stable history', () => {
    expect(sellerReputation({ listings: 8, delisted: 1, fastDelists: 0, relists: 1 }).trust).toBe('good');
  });

  it('stays neutral for a middling seller', () => {
    expect(sellerReputation({ listings: 4, delisted: 1, fastDelists: 1, relists: 2 }).trust).toBe('neutral');
  });
});

function freshMonitor(store: Store): number {
  return store.monitors.create({
    type: 'search', chatId: 1, vendor: 'olx', url: 'https://x/q',
    filters: { sellerVisibility: 'both', exclusionKeywords: [] }, intervalMs: 60_000, nextDueAt: 0,
  }).id;
}

const item = (id: string, phone: string, now: number): IScrapedItem => ({
  id, title: id, price: 100, currency: 'EUR', url: `https://x/${id}`,
  isPrivateOwner: true, inStock: true, phone,
});

describe('items.sellerStats', () => {
  it('aggregates a seller by phone: listings, fast delists, relists', () => {
    const store = openStore(':memory:');
    const m = freshMonitor(store);
    const t0 = 1_000_000_000_000;
    // 4 listings from the same phone; 2 delisted fast (1 day later).
    for (const id of ['a', 'b', 'c', 'd']) store.items.upsert(m, item(id, '+40700', t0), t0);
    // Delist a and b one day later (threshold 2 → two absent cycles stamp delisted_at).
    store.items.markAbsent(m, ['a', 'b'], t0 + DAY, 2);
    store.items.markAbsent(m, ['a', 'b'], t0 + DAY, 2); // crosses threshold → delisted_at = t0+DAY

    const s = store.items.sellerStats({ phone: '+40700' }, SELLER_FAST_MS);
    expect(s.listings).toBe(4);
    expect(s.delisted).toBe(2);
    expect(s.fastDelists).toBe(2); // both delisted within 3 days of first_seen
    expect(s.relists).toBe(4); // gone_count = 2 each on the two delisted items

    expect(store.items.sellerStats({ phone: '+49999' }, SELLER_FAST_MS).listings).toBe(0); // unknown seller
  });
});
