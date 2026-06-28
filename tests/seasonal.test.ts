import { describe, it, expect } from 'vitest';
import { seasonalHint, type MonthlyAvg } from '../src/features/seasonal';
import { renderNotification } from '../src/gateway/render';
import { tr } from '../src/gateway/strings';
import type { Notification, WeeklyReportData } from '../src/contracts';

const m = (month: number, avg: number, n = 10, currency = 'EUR'): MonthlyAvg => ({ month, currency, avg, n });

describe('seasonalHint', () => {
  it('finds the cheapest month once there is enough spread', () => {
    const hint = seasonalHint([m(1, 9000), m(4, 10000), m(7, 11000), m(10, 10500)]);
    expect(hint?.month).toBe(1); // January cheapest
    expect(hint?.belowPct).toBeGreaterThanOrEqual(5);
  });

  it('returns nothing with too few months', () => {
    expect(seasonalHint([m(1, 9000), m(2, 11000)])).toBeUndefined();
  });

  it('returns nothing with too few observations', () => {
    expect(seasonalHint([m(1, 9000, 2), m(4, 10000, 2), m(7, 11000, 2), m(10, 10500, 2)])).toBeUndefined();
  });

  it('returns nothing when the dip is negligible', () => {
    expect(seasonalHint([m(1, 10000), m(4, 10050), m(7, 10100), m(10, 10020)])).toBeUndefined();
  });

  it('ignores the minority currency', () => {
    const hint = seasonalHint([
      m(1, 9000), m(4, 10000), m(7, 11000), m(10, 10500),
      m(1, 5, 1, 'RON'), // a single RON point must not become the dominant currency
    ]);
    expect(hint?.month).toBe(1);
  });
});

describe('renderWeeklyReport — seasonal line', () => {
  it('renders the best-time-to-buy hint when present', () => {
    const report: WeeklyReportData = {
      vendor: 'olx', inventory: 5, inventoryDelta: 0, newThisWeek: 1, trendBadge: '',
      bestDeals: [], seasonalMonth: 1, seasonalBelowPct: 8,
    };
    const text = renderNotification({ kind: 'weekly_report', chatId: 1, report } as Notification, 'en').text;
    expect(text).toContain(tr('en').report_seasonal({ month: 'Jan', pct: 8 }));
  });
});
