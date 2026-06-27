/**
 * Price rating — category-AGNOSTIC. Rates a listing's price against a comparable
 * set drawn from the items the chat has already collected, then expresses it as a
 * robust percentile → a great_deal / fair_price / overpriced tag with a
 * confidence level. No model, no ML, no per-category schema: the universal
 * comparable key is "same currency + similar title", which every listing in
 * every category (cars, property, fashion, anything) has. Numeric attributes can
 * tighten the set later; they are not required here.
 *
 * Robustness: the percentile is taken against the comp prices directly, and the
 * tag thresholds are percentile-based, so a few scam under-prices or one absurd
 * outlier can't swing the verdict the way a mean would. When too few comparables
 * exist (even after widening the similarity threshold), the rating is `unknown`
 * rather than a fabricated verdict.
 */
import type { ItemSnapshot } from '../persistence';
import { titleTokens } from './cheaperFinder';

export type PriceTag = 'great_deal' | 'fair_price' | 'overpriced' | 'unknown';
export type RatingConfidence = 'high' | 'medium' | 'low' | 'none';

/** The listing being rated. */
export interface RateTarget {
  itemId: string;
  title: string;
  price: number;
  currency: string;
  url?: string;
}

export interface PriceRating {
  tag: PriceTag;
  /** Share of comps priced strictly below the target (0..1); absent when unknown. */
  percentile?: number;
  /** Median comp price; absent when unknown. */
  median?: number;
  /** Number of comparables the verdict rests on. */
  n: number;
  confidence: RatingConfidence;
}

export interface RateOptions {
  /** Minimum comparables for any verdict. Default 5. */
  minComps?: number;
  /** Comparables for a high-confidence verdict. Default 15. */
  strongComps?: number;
}

/** Count tokens shared between two sets. */
function sharedCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/** Median of a numeric array (assumes non-empty). */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Rate `target`'s price against `candidates`. The comparable set is same-currency
 * listings (excluding the target itself) whose title shares enough significant
 * tokens with the target; the shared-token threshold starts tight and relaxes
 * until at least `minComps` comparables are found. Returns `unknown` when even the
 * loosest threshold can't gather enough.
 */
export function ratePrice(
  target: RateTarget,
  candidates: ItemSnapshot[],
  opts: RateOptions = {},
): PriceRating {
  const minComps = opts.minComps ?? 5;
  const strongComps = opts.strongComps ?? 15;
  const targetTokens = titleTokens(target.title);

  // Same currency, not the target, with a parseable price. Pre-compute overlap.
  const pool = candidates
    .filter((c) => c.currency === target.currency && c.lastPrice > 0)
    .filter((c) => c.itemId !== target.itemId && !(target.url && c.url && c.url === target.url))
    .map((c) => ({ price: c.lastPrice, shared: sharedCount(targetTokens, titleTokens(c.title ?? '')) }));

  // Widen the similarity threshold from tight to loose until we have enough comps.
  const start = Math.min(3, targetTokens.size || 1);
  let comps: number[] = [];
  let usedThreshold = 0;
  for (let minShared = start; minShared >= 1; minShared--) {
    const matched = pool.filter((c) => c.shared >= minShared).map((c) => c.price);
    if (matched.length >= minComps || minShared === 1) {
      comps = matched;
      usedThreshold = minShared;
      if (matched.length >= minComps) break;
    }
  }

  if (comps.length < minComps) {
    return { tag: 'unknown', n: comps.length, confidence: 'none' };
  }

  const sorted = [...comps].sort((a, b) => a - b);
  const med = median(sorted);
  const below = sorted.filter((p) => p < target.price).length;
  const percentile = below / sorted.length;

  const tag: PriceTag =
    percentile <= 0.15 ? 'great_deal' : percentile >= 0.85 ? 'overpriced' : 'fair_price';

  // Confidence: many comps gathered at a meaningful similarity threshold = high.
  const confidence: RatingConfidence =
    comps.length >= strongComps && usedThreshold >= 2 ? 'high'
    : comps.length >= strongComps || usedThreshold >= 2 ? 'medium'
    : 'low';

  return { tag, percentile, median: med, n: comps.length, confidence };
}
