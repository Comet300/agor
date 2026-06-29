import { describe, it, expect } from 'vitest';
import { bestDeals } from '../src/features/bestDeals';
import type { ItemSnapshot } from '../src/persistence';

function snap(id: string, price: number, title = 'Toyota Corolla Hybrid'): ItemSnapshot {
  return { monitorId: 1, itemId: id, inStock: true, lastPrice: price, currency: 'EUR', firstSeen: 0, lastSeen: 0, title, url: `https://x/${id}` };
}

describe('bestDeals', () => {
  it('ranks the statistically cheapest listing first, with a discount %', () => {
    const pool = [snap('a', 8000), snap('b', 15000), snap('c', 15500), snap('d', 16000), snap('e', 16500), snap('f', 17000)];
    const deals = bestDeals(pool, 5);
    expect(deals.length).toBeGreaterThanOrEqual(1);
    expect(deals[0]!.itemId).toBe('a'); // far below the comp median → top deal
    expect(deals[0]!.discountPct).toBeGreaterThan(20);
    expect(deals[0]!.n).toBeGreaterThanOrEqual(5);
  });

  it('returns nothing without enough comparables', () => {
    expect(bestDeals([snap('a', 8000), snap('b', 16000)], 5)).toEqual([]);
  });
});
