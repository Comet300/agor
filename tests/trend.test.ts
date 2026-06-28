import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../src/persistence';
import { computeTrend, renderTrendBadge, DAY_MS, type Trend } from '../src/features/trend';

const NOW = 1_700_000_000_000;

/** A fresh store with one search monitor; price_history has an FK to monitors. */
function freshStore(): { store: Store; monitorId: number } {
  const store = openStore(':memory:');
  const m = store.monitors.create({
    type: 'search',
    chatId: 42,
    vendor: 'olx',
    url: 'https://www.olx.ro/q-golf/',
    filters: { sellerVisibility: 'both', exclusionKeywords: [] },
    intervalMs: 60_000,
    nextDueAt: 1_000,
  });
  return { store, monitorId: m.id };
}

function seed(store: Store, monitorId: number, points: Array<{ item: string; price: number; at: number; cur?: string }>): void {
  for (const p of points) {
    store.priceHistory.append({ monitorId, itemId: p.item, price: p.price, currency: p.cur ?? 'EUR', observedAt: p.at });
  }
}

describe('computeTrend', () => {
  it('reports a falling market when the median was cut', () => {
    const { store, monitorId } = freshStore();
    // 3 listings at 100 forty days ago, each cut to 90 two days ago.
    for (const item of ['a', 'b', 'c']) {
      seed(store, monitorId, [
        { item, price: 100, at: NOW - 40 * DAY_MS },
        { item, price: 90, at: NOW - 2 * DAY_MS },
      ]);
    }
    const t = computeTrend(store.priceHistory, monitorId, NOW);
    expect(t.d30?.dir).toBe('down');
    expect(Math.round(t.d30!.pct)).toBe(-10); // 90 vs 100
    expect(t.d30?.n).toBe(3);
    expect(t.d7?.dir).toBe('down'); // baseline at -40d is still the ≤(-7d) price
  });

  it('reports a rising market when the median was raised', () => {
    const { store, monitorId } = freshStore();
    for (const item of ['a', 'b', 'c']) {
      seed(store, monitorId, [
        { item, price: 100, at: NOW - 40 * DAY_MS },
        { item, price: 115, at: NOW - DAY_MS },
      ]);
    }
    expect(computeTrend(store.priceHistory, monitorId, NOW).d30?.dir).toBe('up');
  });

  it('reports stable when the median barely moved (< flat threshold)', () => {
    const { store, monitorId } = freshStore();
    for (const item of ['a', 'b', 'c']) {
      seed(store, monitorId, [
        { item, price: 100, at: NOW - 40 * DAY_MS },
        { item, price: 101, at: NOW - DAY_MS }, // +1% < 3%
      ]);
    }
    expect(computeTrend(store.priceHistory, monitorId, NOW).d30?.dir).toBe('flat');
  });

  it('returns no trend with too few comparable listings', () => {
    const { store, monitorId } = freshStore();
    seed(store, monitorId, [
      { item: 'a', price: 100, at: NOW - 40 * DAY_MS },
      { item: 'a', price: 80, at: NOW - DAY_MS },
      { item: 'b', price: 100, at: NOW - 40 * DAY_MS },
    ]);
    expect(computeTrend(store.priceHistory, monitorId, NOW)).toEqual({}); // < 3 items
  });

  it('ignores the minority currency so a mixed SERP cannot skew the median', () => {
    const { store, monitorId } = freshStore();
    // 3 EUR listings flat; one RON listing that crashed — must not flip the trend.
    for (const item of ['a', 'b', 'c']) {
      seed(store, monitorId, [{ item, price: 100, at: NOW - 40 * DAY_MS }, { item, price: 100, at: NOW - DAY_MS }]);
    }
    seed(store, monitorId, [
      { item: 'r', price: 500000, at: NOW - 40 * DAY_MS, cur: 'RON' },
      { item: 'r', price: 1, at: NOW - DAY_MS, cur: 'RON' },
    ]);
    // EUR is dominant (3 vs 1) → flat, RON crash ignored.
    expect(computeTrend(store.priceHistory, monitorId, NOW).d30?.dir).toBe('flat');
  });
});

describe('renderTrendBadge', () => {
  it('renders only the windows that have data, language-neutral', () => {
    expect(renderTrendBadge({})).toBe('');
    expect(renderTrendBadge({ d7: { dir: 'down', pct: -4.2, n: 3 } })).toBe('📊 7d ▼4%');
    const both: Trend = { d7: { dir: 'down', pct: -4, n: 3 }, d30: { dir: 'down', pct: -9, n: 5 } };
    expect(renderTrendBadge(both)).toBe('📊 7d ▼4% · 30d ▼9%');
    expect(renderTrendBadge({ d30: { dir: 'up', pct: 7.6, n: 4 } })).toBe('📊 30d ▲8%');
  });
});
