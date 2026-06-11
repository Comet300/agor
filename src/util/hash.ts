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
 * Composite signature hash: f(NormalizedTitle, RoundedPrice, ApproximateLocation).
 * Identical cross-posted listings collapse to the same signature.
 */
export function compositeSignature(input: {
  title: string;
  price: number;
  location?: string;
}): string {
  const parts = [
    normalizeTitle(input.title),
    String(priceBucket(input.price)),
    normalizeLocation(input.location),
  ];
  return createHash('sha1').update(parts.join('|')).digest('hex');
}
