/**
 * Price benchmarking & deal tagging (Feature 5).
 *
 * Computes a median across a target's active listings and tags each new item as
 * a great deal / fair price / overpriced relative to that median. Pure: the
 * benchmark is computed once per call and shared across the enriched items.
 */
import type { Benchmark, DealTag, EnrichedItem, IScrapedItem } from '../contracts';

/**
 * Statistical median of `values`.
 * Even length averages the two middle elements; empty/NaN-only input -> 0.
 * The input is not mutated (we sort a copy).
 */
export function median(values: number[]): number {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] as number;
  }
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Build a {@link Benchmark} from a price sample. `confident` is true only when
 * the sample is at least `minSample` strong, guarding against noisy medians.
 */
export function benchmarkFor(prices: number[], minSample: number): Benchmark {
  return {
    median: median(prices),
    sampleSize: prices.length,
    confident: prices.length >= minSample,
  };
}

/**
 * Classify a price against a median:
 *   <= median * 0.85 -> 'great_deal'
 *   <= median * 1.05 -> 'fair_price'
 *   else             -> 'overpriced'
 */
export function dealTag(price: number, med: number): DealTag {
  if (price <= med * 0.85) return 'great_deal';
  if (price <= med * 1.05) return 'fair_price';
  return 'overpriced';
}

/**
 * Enrich items with the shared benchmark and a per-item deal tag.
 * The deal tag is only attached when the benchmark is confident; otherwise it is
 * omitted (an unreliable median should not mislabel a listing).
 */
export function enrichWithBenchmark(
  items: IScrapedItem[],
  allActivePrices: number[],
  minSample: number,
): EnrichedItem[] {
  const benchmark = benchmarkFor(allActivePrices, minSample);
  return items.map((item) => {
    const enriched: EnrichedItem = { ...item, benchmark };
    if (benchmark.confident) {
      enriched.dealTag = dealTag(item.price, benchmark.median);
    }
    return enriched;
  });
}
