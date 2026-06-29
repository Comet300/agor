/**
 * Data Processing Pipeline (Phase 5).
 *
 * A pure, deterministic chain that turns raw payload nodes into the two outputs
 * the rest of the system needs:
 *   - `active`      — every well-formed, user-filtered item this cycle (the
 *                     basis for the price benchmark sample and history).
 *   - `newEnriched` — only the genuinely new, deduplicated items, each enriched
 *                     with a benchmark and (when confident) a deal tag — i.e.
 *                     exactly what should be notified.
 *
 * No persistence, no network, no implicit clock: `now` is passed in.
 */
import type { EnrichedItem, FilterConfig, IScrapedItem, IVendorPlugin } from '../contracts';
import { normalizeItems } from './normalize';
import { applyExclusion, applyRequired } from './exclusionKeywords';
import { applyBlocklist } from './sellerBlocklist';
import { applySellerFilter } from './sellerTypeFilter';
import { newItems } from './delta';
import { collapseDuplicates, DedupBuffer, type CrossPost } from './dedup';
import { enrichWithBenchmark } from './benchmarking';

export interface PipelineInput {
  rawNodes: unknown[];
  plugin: IVendorPlugin;
  mapping: 'search' | 'product';
  filters: FilterConfig;
  historicalIds: Set<string>;
  minSample: number;
  /** Optional cross-batch dedup buffer; when omitted, dedup is skipped. */
  dedup?: DedupBuffer;
  now: number;
}

export interface PipelineOutput {
  active: IScrapedItem[];
  newEnriched: EnrichedItem[];
  /** Cross-batch duplicates whose source should be appended to their original alert. */
  crossPosts: CrossPost[];
}

/**
 * Run the full pipeline in its FIXED order:
 *   normalize
 *     -> applyExclusion
 *     -> applySellerFilter            (=> `active`)
 *     -> newItems(active, historical)
 *     -> collapseDuplicates           (only if a dedup buffer is supplied)
 *     -> enrichWithBenchmark(news, active prices, minSample)
 *
 * The benchmark sample is drawn from the *active* set (all listings this cycle),
 * not just the new ones, so a single fresh listing is still measured against the
 * whole market.
 */
export function runPipeline(input: PipelineInput): PipelineOutput {
  const { rawNodes, plugin, mapping, filters, historicalIds, minSample, dedup, now } = input;

  // 1. Normalize raw nodes into canonical items.
  const normalized = normalizeItems(rawNodes, plugin, mapping);

  // 2. Drop titles matching the exclusion blocklist.
  const afterExclusion = applyExclusion(normalized, filters.exclusionKeywords);

  // 2a. Keep only titles matching the required-keyword whitelist (if any).
  const afterRequired = applyRequired(afterExclusion, filters.requiredKeywords ?? []);

  // 2b. Drop listings from blocked sellers (by name or phone).
  const afterBlock = applyBlocklist(
    afterRequired,
    filters.blockedSellers ?? [],
    filters.blockedPhones ?? [],
  );

  // 3. Apply the seller-type visibility preference -> the active set.
  const active = applySellerFilter(afterBlock, filters.sellerVisibility);

  // 4. Isolate the genuinely new listings.
  const news = newItems(active, historicalIds);

  // 5. Collapse duplicates (intra-batch + cross-batch suppression) if enabled.
  //    new items are a structural subset of EnrichedItem, so the cast is safe.
  let deduped: EnrichedItem[];
  let crossPosts: CrossPost[] = [];
  if (dedup) {
    const collapsed = collapseDuplicates(news as EnrichedItem[], dedup, now);
    deduped = collapsed.items;
    crossPosts = collapsed.crossPosts;
  } else {
    deduped = news as EnrichedItem[];
  }

  // 6. Enrich the survivors with the benchmark (sampled from `active`, bucketed
  //    by currency so a mixed-currency SERP cannot contaminate a deal tag).
  const newEnriched = enrichWithBenchmark(
    deduped,
    active.map((i) => ({ price: i.price, currency: i.currency })),
    minSample,
  );

  return { active, newEnriched, crossPosts };
}

// ── Re-export the stage functions/types for direct use & testing ────────────
export { normalizeItems } from './normalize';
export {
  parseExclusionInput,
  buildExclusionRegex,
  applyExclusion,
  applyRequired,
} from './exclusionKeywords';
export { applyBlocklist, phoneKey } from './sellerBlocklist';
export { applySellerFilter } from './sellerTypeFilter';
export { snapshotHidden, type FilterableSnapshot } from './snapshotFilter';
export { computeDelta, newItems } from './delta';
export {
  median,
  benchmarkFor,
  dealTag,
  enrichWithBenchmark,
  type PricedSample,
} from './benchmarking';
export { DedupBuffer, collapseDuplicates } from './dedup';
export { vinOf } from './vin';
export type { DedupEntry, CrossPost, CollapseResult, AlternativeSource } from './dedup';
