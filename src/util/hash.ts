/** Composite signature hashing for cross-platform deduplication (Feature 6). */
import { createHash } from 'node:crypto';
import { priceBucket } from './money';

/** Unicode combining diacritical marks. */
const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');

/** Lowercase, strip diacritics & punctuation, collapse whitespace. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lowercase + trim an approximate location label. */
export function normalizeLocation(location: string | undefined): string {
  return (location ?? '').normalize('NFD').replace(DIACRITICS, '').toLowerCase().trim();
}

/**
 * Composite signature hash: f(NormalizedTitle, PriceBucket, ApproximateLocation).
 * Identical cross-posted listings collapse to the same signature.
 *
 * A non-positive / non-bucketable price (0 = "price on request", free) would make
 * the price slot a shared constant, wrongly collapsing every non-priced ad with
 * the same title+location into one. In that case the slot falls back to the
 * item's own `id` (when supplied), so distinct non-priced listings stay separate
 * while the SAME listing seen again is still stable. A real price ignores `id`,
 * so genuine cross-vendor dedup is unaffected.
 */
export function compositeSignature(input: {
  title: string;
  price: number;
  location?: string;
  id?: string;
}): string {
  const bucket = priceBucket(input.price);
  const priceSlot = bucket > 0 ? String(bucket) : `noprice:${input.id ?? ''}`;
  const parts = [normalizeTitle(input.title), priceSlot, normalizeLocation(input.location)];
  return createHash('sha1').update(parts.join('|')).digest('hex');
}
