/**
 * Market price-trend analysis per watch (search query).
 *
 * Uses the accumulated price-history change-points to reconstruct the market's
 * median price now versus N days ago, over the SAME set of listings and in the
 * dominant currency, then classifies the move as rising / falling / stable. The
 * result is a compact, language-neutral badge surfaced on each /list row.
 *
 * It is a heuristic hint, not a valuation: it compares medians of whatever
 * listings carry history in both windows, so a thin or churny market yields no
 * trend (undefined) rather than a noisy one.
 */
import { median } from '../pipeline/benchmarking';
import type { PriceHistoryRepo } from '../persistence/priceHistory';

export const DAY_MS = 86_400_000;
/** Need at least this many comparable listings in a window to report a trend. */
export const TREND_MIN_ITEMS = 3;
/** |%| below this is "stable"; at or above tips rising/falling. */
export const TREND_FLAT_PCT = 3;

export type TrendDir = 'up' | 'down' | 'flat';
export interface TrendPoint {
  dir: TrendDir;
  /** Signed percent change of the median (negative = cheaper now). */
  pct: number;
  /** Listings compared (present in both windows, dominant currency). */
  n: number;
}
export interface Trend {
  d7?: TrendPoint;
  d30?: TrendPoint;
}

type Priced = { itemId: string; price: number; currency: string };

/** The currency carried by the most listings (ties broken by first seen). */
function dominantCurrency(rows: Priced[]): string | undefined {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  let best: string | undefined;
  let bestN = 0;
  for (const [cur, n] of counts) if (n > bestN) { best = cur; bestN = n; }
  return best;
}

/** Classify the median move between a past and current price map (same currency). */
function classify(current: Map<string, number>, past: Map<string, number>): TrendPoint | undefined {
  const ids = [...past.keys()].filter((id) => current.has(id));
  if (ids.length < TREND_MIN_ITEMS) return undefined;
  const now = median(ids.map((id) => current.get(id)!));
  const then = median(ids.map((id) => past.get(id)!));
  if (then === 0) return undefined;
  const pct = ((now - then) / then) * 100;
  const dir: TrendDir = pct >= TREND_FLAT_PCT ? 'up' : pct <= -TREND_FLAT_PCT ? 'down' : 'flat';
  return { dir, pct, n: ids.length };
}

/**
 * Compute the 7d and 30d market trend for a monitor. Both windows compare against
 * the SAME current snapshot, restricted to the dominant currency so a mixed-currency
 * SERP cannot distort the median.
 */
export function computeTrend(repo: PriceHistoryRepo, monitorId: number, now: number): Trend {
  const currentAll = repo.pricesAsOf(monitorId, now);
  const currency = dominantCurrency(currentAll);
  if (currency === undefined) return {};
  const toMap = (rows: Priced[]): Map<string, number> =>
    new Map(rows.filter((r) => r.currency === currency).map((r) => [r.itemId, r.price]));

  const current = toMap(currentAll);
  const out: Trend = {};
  const d7 = classify(current, toMap(repo.pricesAsOf(monitorId, now - 7 * DAY_MS)));
  if (d7) out.d7 = d7;
  const d30 = classify(current, toMap(repo.pricesAsOf(monitorId, now - 30 * DAY_MS)));
  if (d30) out.d30 = d30;
  return out;
}

/** Leading emoji = the overall price direction, so the badge reads at a glance. */
const LEAD: Record<TrendDir, string> = { up: '📈', down: '📉', flat: '➡️' };

/** One window as e.g. "7d -4%" — language-neutral (signed percent). */
function part(label: string, p: TrendPoint): string {
  const pct = Math.round(p.pct);
  return `${label} ${pct >= 0 ? '+' : ''}${pct}%`;
}

/**
 * A compact, language-neutral price-trend badge for a /list row, or '' when there
 * is not enough history. The leading emoji is the direction itself (📈/📉/➡️) so
 * it's obvious the figures are price movement, e.g. "📉 7d -4% · 30d -9%".
 */
export function renderTrendBadge(trend: Trend): string {
  const parts: string[] = [];
  if (trend.d7) parts.push(part('7d', trend.d7));
  if (trend.d30) parts.push(part('30d', trend.d30));
  if (parts.length === 0) return '';
  const lead = (trend.d30 ?? trend.d7)!.dir; // longest window decides the headline emoji
  return `${LEAD[lead]} 💶 ${parts.join(' · ')}`;
}
