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

/** A price observation tagged with its currency, for per-currency benchmarking. */
export interface PricedSample {
  price: number;
  currency: string;
}

/** Group sample prices by currency so each bucket benchmarks on its own scale. */
function bucketByCurrency(samples: PricedSample[]): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (const s of samples) {
    const bucket = buckets.get(s.currency);
    if (bucket) bucket.push(s.price);
    else buckets.set(s.currency, [s.price]);
  }
  return buckets;
}

/**
 * The most common NON-BLANK currency across the sample — the SERP's dominant
 * currency, used to resolve a blank-currency item so it can still be benchmarked
 * (vendors occasionally omit it on a stray listing). Returns '' when every item
 * is blank (nothing to infer from).
 */
function dominantCurrency(samples: PricedSample[]): string {
  const counts = new Map<string, number>();
  for (const s of samples) {
    if (s.currency !== '') counts.set(s.currency, (counts.get(s.currency) ?? 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [cur, n] of counts) {
    if (n > bestN) { best = cur; bestN = n; }
  }
  return best;
}

/**
 * Enrich items with a benchmark and a per-item deal tag, measured PER CURRENCY.
 *
 * Pooling prices across currencies corrupts the median (a single RON listing in
 * a EUR real-estate SERP would skew every EUR deal tag), so the sample is
 * bucketed by currency and each item is tagged against the median of its OWN
 * currency. A deal tag is attached only when that bucket is confident.
 *
 * Accepts either a currency-tagged sample (preferred) or a bare `number[]` for
 * back-compat (treated as a single implicit currency bucket).
 */
export function enrichWithBenchmark(
  items: IScrapedItem[],
  allActivePrices: number[] | PricedSample[],
  minSample: number,
): EnrichedItem[] {
  // Back-compat: a plain number[] is one undifferentiated bucket.
  const isNumberSample = allActivePrices.every((p) => typeof p === 'number');
  if (isNumberSample) {
    const benchmark = benchmarkFor(allActivePrices as number[], minSample);
    return items.map((item) => {
      const enriched: EnrichedItem = { ...item, benchmark };
      if (benchmark.confident) enriched.dealTag = dealTag(item.price, benchmark.median);
      return enriched;
    });
  }

  const samples = allActivePrices as PricedSample[];
  const buckets = bucketByCurrency(samples);
  const benchmarkByCurrency = new Map<string, ReturnType<typeof benchmarkFor>>();
  for (const [currency, prices] of buckets) {
    benchmarkByCurrency.set(currency, benchmarkFor(prices, minSample));
  }
  // A blank-currency item borrows the SERP's dominant currency bucket so it can
  // still be benchmarked; if every item is blank, they all share the '' bucket.
  const dominant = dominantCurrency(samples);

  return items.map((item) => {
    const bucketKey = item.currency !== '' ? item.currency : dominant;
    const benchmark =
      benchmarkByCurrency.get(bucketKey) ?? benchmarkFor([item.price], minSample);
    const enriched: EnrichedItem = { ...item, benchmark };
    if (benchmark.confident) enriched.dealTag = dealTag(item.price, benchmark.median);
    return enriched;
  });
}
