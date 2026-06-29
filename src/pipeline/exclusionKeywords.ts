/**
 * Exclusion-keyword filtering (Feature 8).
 *
 * Users supply a comma-separated blocklist; any item whose title contains one of
 * those keywords (as a whole word) is dropped. All functions are pure.
 */
import type { IScrapedItem } from '../contracts';

/** Escape regex metacharacters so a keyword is matched literally. */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse raw user input ("BMW, audi ,, AUDI") into a clean keyword list:
 * split on commas, trim, lowercase, drop empties, de-duplicate (order preserved).
 */
export function parseExclusionInput(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of input.split(',')) {
    const k = part.trim().toLowerCase();
    if (k === '' || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * Build a single case-insensitive regex that matches any keyword on a word
 * boundary. Each keyword is escaped so metacharacters are literal. Returns
 * `null` when there are no keywords (nothing to exclude).
 *
 * Boundaries are Unicode-aware: ASCII `\b` treats Romanian diacritics
 * (ă â î ș ț) as word *separators*, which both misses real matches
 * ("ștanță" never matches its own word) and fabricates false ones
 * ("avariat" matching "avariată"). Since the bot targets ro-RO listings we
 * assert against an explicit Unicode letter/number/underscore class with /u.
 */
const WORD_CHAR = '[\\p{L}\\p{N}_]';

export function buildExclusionRegex(keywords: string[]): RegExp | null {
  if (keywords.length === 0) return null;
  const union = keywords
    .map((k) => `(?<!${WORD_CHAR})${escapeRegex(k)}(?!${WORD_CHAR})`)
    .join('|');
  return new RegExp(union, 'iu');
}

/**
 * The text a keyword filter matches against: title AND description joined, so a
 * keyword that lives only in the body (e.g. "swace") still counts.
 */
export function keywordHaystack(item: { title?: string; description?: string }): string {
  return `${item.title ?? ''}\n${item.description ?? ''}`;
}

/**
 * Drop items whose title or description matches any exclusion keyword. With no
 * keywords the list passes through unchanged.
 */
export function applyExclusion(items: IScrapedItem[], keywords: string[]): IScrapedItem[] {
  const re = buildExclusionRegex(keywords);
  if (re === null) return items;
  return items.filter((item) => !re.test(keywordHaystack(item)));
}

/**
 * Required-keyword (whitelist) filter: when `keywords` is non-empty, keep only
 * items whose title OR description matches AT LEAST ONE keyword (same
 * word-boundary regex as exclusions). An empty list means "no requirement".
 */
export function applyRequired(items: IScrapedItem[], keywords: string[]): IScrapedItem[] {
  const re = buildExclusionRegex(keywords);
  if (re === null) return items;
  return items.filter((item) => re.test(keywordHaystack(item)));
}
