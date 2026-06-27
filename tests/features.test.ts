import { describe, it, expect } from 'vitest';
import { marketInsight } from '../src/features/marketInsight';
import { findCheaperEquivalents, titleTokens } from '../src/features/cheaperFinder';
import { ratePrice } from '../src/features/priceRating';
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

describe('ratePrice (category-agnostic comparable percentile)', () => {
  function corollas(prices: number[], currency = 'EUR') {
    return prices.map((p, i) => snap({ itemId: `c${i}`, title: `Toyota Corolla Hybrid 20${10 + i}`, lastPrice: p, currency, url: `https://x/c${i}` }));
  }
  const target = (price: number, currency = 'EUR') => ({ itemId: 't', title: 'Toyota Corolla Hybrid 2021', price, currency });

  it('great_deal when cheaper than most comparables', () => {
    const r = ratePrice(target(9000), corollas([12000, 13000, 14000, 15000, 16000, 17000]));
    expect(r.tag).toBe('great_deal');
    expect(r.percentile).toBe(0); // below all comps
    expect(r.n).toBe(6);
  });

  it('overpriced when pricier than most comparables', () => {
    expect(ratePrice(target(25000), corollas([12000, 13000, 14000, 15000, 16000, 17000])).tag).toBe('overpriced');
  });

  it('fair_price in the middle of the pack', () => {
    expect(ratePrice(target(14500), corollas([12000, 13000, 14000, 15000, 16000, 17000])).tag).toBe('fair_price');
  });

  it('unknown when there are too few comparables', () => {
    const r = ratePrice(target(14000), corollas([13000, 15000]));
    expect(r.tag).toBe('unknown');
    expect(r.confidence).toBe('none');
  });

  it('ignores other-currency listings when gathering comps', () => {
    const mixed = [...corollas([12000, 13000], 'EUR'), ...corollas([100, 200, 300, 400, 500], 'RON')];
    expect(ratePrice(target(14000, 'EUR'), mixed).tag).toBe('unknown'); // only 2 EUR comps
  });

  it('works for a NON-car category (phones) via title similarity + widening', () => {
    const phones = [11, 12, 13, 14, 15].map((g, i) =>
      snap({ itemId: `p${i}`, title: `iPhone 13 Pro ${256}GB unit ${g}`, lastPrice: 3000 + i * 100, currency: 'RON', url: `https://x/p${i}` }));
    const r = ratePrice({ itemId: 't', title: 'iPhone 13 Pro 256GB', price: 2500, currency: 'RON' }, phones);
    expect(r.tag).toBe('great_deal'); // cheapest of the iPhone comps
    expect(r.n).toBe(5);
  });
});
