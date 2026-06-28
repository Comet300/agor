/**
 * Weekly market report builder for a search watch: inventory trend, price
 * movement (reused from {@link computeTrend}), new-listing velocity, and the
 * current best deals. Reads the price-history and item snapshots; returns a
 * ready-to-render {@link WeeklyReportData} payload (the trend is pre-rendered as
 * a language-neutral badge so the contract stays free of feature types).
 */
import type { Monitor, WeeklyReportData } from '../contracts';
import type { PriceHistoryRepo } from '../persistence/priceHistory';
import type { ItemRepo } from '../persistence/items';
import { computeTrend, renderTrendBadge, DAY_MS } from './trend';

export const WEEK_MS = 7 * DAY_MS;
/** Most active listings scanned for velocity + best deals. */
export const REPORT_SCAN_CAP = 300;
/** Best deals shown in a report. */
export const REPORT_MAX_DEALS = 5;

export interface ReportRepos {
  priceHistory: PriceHistoryRepo;
  items: ItemRepo;
}

/**
 * Build a weekly report for a search watch, or `undefined` when there is nothing
 * to report (no tracked listings at all).
 */
export function buildWeeklyReport(repos: ReportRepos, monitor: Monitor, now: number): WeeklyReportData | undefined {
  const inventory = repos.priceHistory.pricesAsOf(monitor.id, now).length;
  const active = repos.items.browseByMonitor(monitor.id, REPORT_SCAN_CAP, 0);
  if (inventory === 0 && active.length === 0) return undefined;

  const weekAgo = repos.priceHistory.pricesAsOf(monitor.id, now - WEEK_MS).length;
  const cutoff = now - WEEK_MS;
  const newThisWeek = active.filter((i) => i.firstSeen >= cutoff).length;
  const bestDeals = [...active]
    .filter((i) => i.title)
    .sort((a, b) => a.lastPrice - b.lastPrice)
    .slice(0, REPORT_MAX_DEALS)
    .map((i) => ({ title: i.title!, price: i.lastPrice, currency: i.currency, url: i.url ?? '' }));

  return {
    vendor: monitor.vendor,
    inventory,
    inventoryDelta: inventory - weekAgo,
    newThisWeek,
    trendBadge: renderTrendBadge(computeTrend(repos.priceHistory, monitor.id, now)),
    bestDeals,
  };
}
