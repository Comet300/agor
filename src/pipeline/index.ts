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
import { applyExclusion } from './exclusionKeywords';
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
  /**
   * Every item id the vendor actually returned this cycle, BEFORE the user's
   * exclusion/seller filters. De-listing must diff against this (not `active`),
   * so an item merely filtered out — but still on the page — is not mistaken for
   * a removed listing.
   */
  presentIds: string[];
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
  // Every id the vendor returned this cycle (pre-filter) — the de-listing baseline.
  const presentIds = normalized.map((i) => i.id);

  // 2. Drop titles matching the exclusion blocklist.
  const afterExclusion = applyExclusion(normalized, filters.exclusionKeywords);

  // 3. Apply the seller-type visibility preference -> the active set.
  const active = applySellerFilter(afterExclusion, filters.sellerVisibility);

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

  return { active, newEnriched, crossPosts, presentIds };
}

// ── Re-export the stage functions/types for direct use & testing ────────────
export { normalizeItems } from './normalize';
export {
  parseExclusionInput,
  buildExclusionRegex,
  applyExclusion,
} from './exclusionKeywords';
export { applySellerFilter } from './sellerTypeFilter';
export { computeDelta, newItems } from './delta';
export {
  median,
  benchmarkFor,
  dealTag,
  enrichWithBenchmark,
  type PricedSample,
} from './benchmarking';
export { DedupBuffer, collapseDuplicates } from './dedup';
export type { DedupEntry, CrossPost, CollapseResult, AlternativeSource } from './dedup';
