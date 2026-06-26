import { describe, it, expect } from 'vitest';
import { marketInsight } from '../src/features/marketInsight';
import { findCheaperEquivalents, titleTokens } from '../src/features/cheaperFinder';
import type { PricePoint } from '../src/contracts';
import type { ItemSnapshot } from '../src/persistence';

const DAY = 86_400_000;
function pts(...prices: number[]): PricePoint[] {
  return prices.map((p, i) => ({ monitorId: 1, itemId: 'x', price: p, currency: 'RON', observedAt: 1000 + i }));
}

describe('marketInsight', () => {
  it('counts days on market from postedAt', () => {
    const now = 100 * DAY;
    expect(marketInsight(80 * DAY, [], now).daysOnMarket).toBe(20);
  });

  it('omits daysOnMarket when postedAt is absent or in the future', () => {
    expect(marketInsight(undefined, [], 0).daysOnMarket).toBeUndefined();
    expect(marketInsight(10 * DAY, [], 5 * DAY).daysOnMarket).toBeUndefined();
  });

  it('counts price cuts (decreases) and the lowest price', () => {
    const i = marketInsight(undefined, pts(1000, 900, 900, 800, 850), 0);
    expect(i.priceCuts).toBe(2);      // 1000→900 and 900→800
    expect(i.lowestPrice).toBe(800);
  });

  it('is empty for no history', () => {
    expect(marketInsight(undefined, [], 0)).toEqual({ priceCuts: 0 });
  });
});

function snap(over: Partial<ItemSnapshot> & { itemId: string }): ItemSnapshot {
  return { monitorId: 1, inStock: true, lastPrice: 100, currency: 'RON', firstSeen: 1, lastSeen: 2, ...over };
}

describe('cheaperFinder', () => {
  it('tokenizes titles to significant tokens, dropping filler + short words', () => {
    expect([...titleTokens('Vand Toyota Corolla 1.8 Hybrid')]).toEqual(
      expect.arrayContaining(['toyota', 'corolla', 'hybrid']),
    );
    expect(titleTokens('Vand Toyota Corolla 1.8 Hybrid').has('vand')).toBe(false); // filler
  });

  it('finds cheaper, same-currency, similar-title listings (cheapest first)', () => {
    const target = { itemId: 't', title: 'Toyota Corolla Hybrid 2021', price: 15000, currency: 'EUR' };
    const candidates = [
      snap({ itemId: 'a', title: 'Toyota Corolla Hybrid 2020', lastPrice: 13000, currency: 'EUR', url: 'https://x/a' }),
      snap({ itemId: 'b', title: 'Toyota Corolla Hybrid clean', lastPrice: 14000, currency: 'EUR', url: 'https://x/b' }),
      snap({ itemId: 'c', title: 'Toyota Corolla Hybrid pricey', lastPrice: 16000, currency: 'EUR' }), // not cheaper
      snap({ itemId: 'd', title: 'VW Golf 7', lastPrice: 9000, currency: 'EUR' }),                    // not similar
      snap({ itemId: 'e', title: 'Toyota Corolla Hybrid RON', lastPrice: 12000, currency: 'RON' }),   // other currency
    ];
    const out = findCheaperEquivalents(target, candidates);
    expect(out.map((m) => m.itemId)).toEqual(['a', 'b']); // cheaper + similar, cheapest first
  });

  it('excludes the target itself by itemId or url', () => {
    const target = { itemId: 't', title: 'Toyota Corolla Hybrid', price: 15000, currency: 'EUR', url: 'https://x/t' };
    const candidates = [
      snap({ itemId: 't', title: 'Toyota Corolla Hybrid', lastPrice: 14000, currency: 'EUR' }),       // same id
      snap({ itemId: 'u', title: 'Toyota Corolla Hybrid', lastPrice: 14000, currency: 'EUR', url: 'https://x/t' }), // same url
    ];
    expect(findCheaperEquivalents(target, candidates)).toHaveLength(0);
  });
});
