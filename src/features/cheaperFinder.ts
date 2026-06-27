/**
 * Cheaper-equivalent finder: given a tracked item, surface listings the user has
 * ALREADY collected (across their search watches) that look like the same thing
 * but cost less. No new scraping — it mines the chat's existing item pool.
 *
 * Matching is title-token overlap: titles are reduced to significant tokens
 * (lowercased, de-accented-ish, length >= 3, common filler dropped) and a
 * candidate qualifies when it shares at least `minShared` tokens with the target,
 * costs strictly less (same currency), and is a different listing. Pure.
 */
import type { ItemSnapshot } from '../persistence';

/** The reference item we want cheaper equivalents of. */
export interface CheaperTarget {
  itemId: string;
  title: string;
  price: number;
  currency: string;
  url?: string;
}

export interface CheaperMatch {
  itemId: string;
  title: string;
  price: number;
  currency: string;
  url?: string;
  /** Number of significant title tokens shared with the target. */
  shared: number;
}

/** Filler tokens that carry no model signal. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'din', 'cu', 'de', 'la', 'pe', 'un', 'una', 'sau',
  'nou', 'noua', 'noi', 'full', 'set', 'buc', 'pret', 'oferta', 'vand', 'vanzare',
]);

/** Reduce a title to a set of significant lowercase tokens. */
export function titleTokens(title: string): Set<string> {
  const tokens = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/** Count tokens shared between two token sets. */
function sharedCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export interface CheaperOptions {
  /** Minimum shared significant tokens to count as "the same thing". Default 2. */
  minShared?: number;
  /** Cap on returned matches (cheapest first). Default 5. */
  limit?: number;
}

/**
 * Find cheaper equivalents of `target` among `candidates`, cheapest first. The
 * target itself (same itemId or url) is excluded; only strictly-cheaper, same-
 * currency listings sharing >= minShared title tokens qualify.
 */
export function findCheaperEquivalents(
  target: CheaperTarget,
  candidates: ItemSnapshot[],
  opts: CheaperOptions = {},
): CheaperMatch[] {
  const minShared = opts.minShared ?? 2;
  const limit = opts.limit ?? 5;
  const targetTokens = titleTokens(target.title);
  if (targetTokens.size === 0) return [];

  const matches: CheaperMatch[] = [];
  for (const c of candidates) {
    if (c.itemId === target.itemId) continue;
    if (target.url && c.url && c.url === target.url) continue;
    if (c.currency !== target.currency) continue;
    if (c.lastPrice >= target.price) continue;
    const shared = sharedCount(targetTokens, titleTokens(c.title ?? ''));
    if (shared < minShared) continue;
    matches.push({
      itemId: c.itemId,
      title: c.title ?? c.itemId,
      price: c.lastPrice,
      currency: c.currency,
      shared,
      ...(c.url ? { url: c.url } : {}),
    });
  }
  // Cheapest first; tie-break on more shared tokens.
  matches.sort((a, b) => a.price - b.price || b.shared - a.shared);
  return matches.slice(0, limit);
}
