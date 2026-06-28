import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../src/persistence';
import { buildWeeklyReport, WEEK_MS } from '../src/features/weeklyReport';
import { renderNotification } from '../src/gateway/render';
import { tr } from '../src/gateway/strings';
import type { IScrapedItem, Monitor, Notification, WeeklyReportData } from '../src/contracts';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function setup(): { store: Store; monitor: Monitor } {
  const store = openStore(':memory:');
  const monitor = store.monitors.create({
    type: 'search', chatId: 5, vendor: 'olx',
    url: 'https://www.olx.ro/q-golf/',
    filters: { sellerVisibility: 'both', exclusionKeywords: [] },
    intervalMs: 60_000, nextDueAt: 0,
  });
  return { store, monitor };
}

const item = (o: { id: string; price: number }): IScrapedItem => ({
  id: o.id, title: `Item ${o.id}`, price: o.price, currency: 'EUR',
  url: `https://x/${o.id}`, isPrivateOwner: true, inStock: true,
});

describe('buildWeeklyReport', () => {
  it('reports inventory delta, velocity, and best deals (cheapest first)', () => {
    const { store, monitor } = setup();
    // A: old (present a week ago). B, C: new this week. Prices 5000/3000/8000.
    store.items.upsert(monitor.id, item({ id: 'A', price: 5000 }), NOW - 40 * DAY);
    store.items.upsert(monitor.id, item({ id: 'B', price: 3000 }), NOW - 2 * DAY);
    store.items.upsert(monitor.id, item({ id: 'C', price: 8000 }), NOW - DAY);
    store.priceHistory.append({ monitorId: monitor.id, itemId: 'A', price: 5000, currency: 'EUR', observedAt: NOW - 40 * DAY });
    store.priceHistory.append({ monitorId: monitor.id, itemId: 'B', price: 3000, currency: 'EUR', observedAt: NOW - 2 * DAY });
    store.priceHistory.append({ monitorId: monitor.id, itemId: 'C', price: 8000, currency: 'EUR', observedAt: NOW - DAY });

    const r = buildWeeklyReport(store, monitor, NOW)!;
    expect(r.vendor).toBe('olx');
    expect(r.inventory).toBe(3);
    expect(r.inventoryDelta).toBe(2); // only A existed a week ago
    expect(r.newThisWeek).toBe(2); // B + C first seen within 7d
    expect(r.bestDeals.map((d) => d.title)).toEqual(['Item B', 'Item A', 'Item C']); // cheapest first
  });

  it('returns undefined when the watch has tracked nothing', () => {
    const { store, monitor } = setup();
    expect(buildWeeklyReport(store, monitor, NOW)).toBeUndefined();
  });
});

describe('ReportStateRepo', () => {
  it('enables (idempotent), lists pending, stamps sent, and disables', () => {
    const store = openStore(':memory:');
    store.reportState.enable(1, 5);
    store.reportState.enable(1, 5); // idempotent
    expect(store.reportState.has(1)).toBe(true);
    expect(store.reportState.pending()).toEqual([{ monitorId: 1, chatId: 5, lastSentAt: 0 }]);

    store.reportState.markSent(1, NOW);
    expect(store.reportState.pending()[0]!.lastSentAt).toBe(NOW);

    store.reportState.disable(1);
    expect(store.reportState.has(1)).toBe(false);
    expect(store.reportState.pending()).toEqual([]);
  });
});

describe('renderNotification — weekly_report', () => {
  it('renders header, inventory, velocity, and a ranked best-deals section', () => {
    const report: WeeklyReportData = {
      vendor: 'olx.ro', inventory: 12, inventoryDelta: 3, newThisWeek: 4, trendBadge: '📊 7d ▼5%',
      bestDeals: [
        { title: 'Cheap Golf', price: 3000, currency: 'EUR', url: 'https://x/a' },
        { title: 'Pricier Golf', price: 6000, currency: 'EUR', url: 'https://x/b' },
      ],
    };
    const msg = renderNotification({ kind: 'weekly_report', chatId: 1, report } as Notification, 'en');
    expect(msg.text).toContain(tr('en').report_title('olx.ro'));
    expect(msg.text).toContain(tr('en').report_inventory({ count: 12, delta: '+3' }));
    expect(msg.text).toContain('📊 7d ▼5%'); // trend badge surfaced
    expect(msg.text).toContain(tr('en').report_velocity({ n: 4 }));
    expect(msg.text).toContain(tr('en').report_best);
    expect(msg.text.indexOf('Cheap Golf')).toBeLessThan(msg.text.indexOf('Pricier Golf'));
  });

  it('formats a negative inventory delta without a plus sign', () => {
    const report: WeeklyReportData = { vendor: 'v', inventory: 5, inventoryDelta: -2, newThisWeek: 0, trendBadge: '', bestDeals: [] };
    const msg = renderNotification({ kind: 'weekly_report', chatId: 1, report } as Notification, 'en');
    expect(msg.text).toContain(tr('en').report_inventory({ count: 5, delta: '-2' }));
  });
});

describe('digest period sanity (shared constant)', () => {
  it('WEEK_MS is 7 days', () => {
    expect(WEEK_MS).toBe(7 * DAY);
  });
});
