/**
 * New-listing delta computation.
 *
 * Given the ids seen this cycle and the set of historically-known ids, isolate
 * the genuinely new listings so only those trigger notifications. Pure.
 */
import type { IScrapedItem } from '../contracts';

/**
 * Set difference: ids present in `currentIds` but absent from `historicalIds`,
 * de-duplicated while preserving first-seen order.
 */
export function computeDelta(currentIds: string[], historicalIds: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of currentIds) {
    if (historicalIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Items whose id is not in the historical set (the new listings this cycle). */
export function newItems(items: IScrapedItem[], historicalIds: Set<string>): IScrapedItem[] {
  return items.filter((item) => !historicalIds.has(item.id));
}
