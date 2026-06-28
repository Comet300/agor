/**
 * Digest-mode helpers: how long a digest window is, how to rank a batch of
 * listings "best deals first", and the market stats shown in the summary header.
 * Pure — no I/O, no clock.
 */
import type { DigestEntry } from '../contracts';
import { median } from '../pipeline/benchmarking';

export const DAY_MS = 86_400_000;

/** Window length per digest mode. */
export const DIGEST_PERIOD_MS: Record<'daily' | 'weekly', number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
};

const DEAL_RANK: Record<string, number> = { great_deal: 0, fair_price: 1, overpriced: 2 };
function dealRank(tag?: string): number {
  return tag !== undefined ? DEAL_RANK[tag] ?? 3 : 3;
}

/**
 * Rank a batch best-deals-first: great_deal before fair_price before the rest,
 * then most under fair value (lowest deltaPct), then cheapest. Stable, pure.
 */
export function rankDigest(entries: DigestEntry[]): DigestEntry[] {
  return [...entries].sort(
    (a, b) =>
      dealRank(a.dealTag) - dealRank(b.dealTag) ||
      (a.deltaPct ?? 0) - (b.deltaPct ?? 0) ||
      a.price - b.price,
  );
}

export interface DigestStats {
  count: number;
  /** The dominant currency the price stats are computed in (undefined if none). */
  currency?: string;
  median?: number;
  min?: number;
  max?: number;
}

/** The currency carried by the most entries (ties broken by first seen). */
function dominantCurrency(entries: DigestEntry[]): string | undefined {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.currency, (counts.get(e.currency) ?? 0) + 1);
  let best: string | undefined;
  let bestN = 0;
  for (const [cur, n] of counts) if (n > bestN) { best = cur; bestN = n; }
  return best;
}

/** Count + price spread (median/min/max) over the dominant-currency subset. */
export function digestStats(entries: DigestEntry[]): DigestStats {
  const currency = dominantCurrency(entries);
  if (currency === undefined) return { count: entries.length };
  const prices = entries.filter((e) => e.currency === currency).map((e) => e.price);
  return {
    count: entries.length,
    currency,
    median: median(prices),
    min: Math.min(...prices),
    max: Math.max(...prices),
  };
}
