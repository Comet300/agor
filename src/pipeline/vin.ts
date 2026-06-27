/**
 * VIN extraction for car dedup. A VIN uniquely identifies a physical vehicle, so
 * two listings sharing one are the SAME car (a cross-post or re-list) regardless
 * of title/price differences. No manifest maps a VIN field, so we scan the
 * listing's attribute values and description for a valid VIN. Pure.
 *
 * A VIN is 17 characters from [A-HJ-NPR-Z0-9] (no I/O/Q). To avoid matching
 * arbitrary 17-char tokens we additionally require at least one letter AND one
 * digit (every real VIN mixes both).
 */
import type { IScrapedItem } from '../contracts';

const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;

/** Extract a normalized (uppercase) VIN from an item's attributes/description, or undefined. */
export function vinOf(item: Pick<IScrapedItem, 'attributes' | 'description'>): string | undefined {
  const haystacks = [...Object.values(item.attributes ?? {}), item.description ?? ''];
  for (const raw of haystacks) {
    const matches = raw.toUpperCase().match(VIN_RE);
    if (!matches) continue;
    for (const cand of matches) {
      if (/[A-Z]/.test(cand) && /[0-9]/.test(cand)) return cand;
    }
  }
  return undefined;
}
