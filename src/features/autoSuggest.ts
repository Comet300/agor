/**
 * Cross-platform watch auto-suggest. When a user tracks a product, derive a
 * short search query from its title and offer to also watch the equivalent
 * SEARCH on other platforms — for every vendor whose manifest carries a
 * `search_url_template`. Pure URL/query construction; the bot layer does the
 * asking and the registering.
 */
import type { IVendorPlugin } from '../contracts';

/** Words that add no search signal — dropped from the derived query. */
const STOP = new Set(['de', 'la', 'cu', 'si', 'din', 'pentru', 'the', 'a', 'an', 'for', 'with']);
/** How many leading title tokens seed the query (brand + model + variant). */
const QUERY_TOKENS = 3;

/** Lowercase dash-slug for a SERP path, e.g. "BMW 320d!" → "bmw-320d". */
export function slugify(query: string): string {
  return query.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * A compact search query seeded from a listing title: the first few meaningful
 * tokens (brand + model). Returns '' when nothing usable remains.
 */
export function suggestQuery(title: string): string {
  const tokens = title
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]+/gu, ''))
    // Keep brand/model tokens; drop short noise, stopwords, and pure numbers
    // (years, engine sizes) which only narrow the search to one specific listing.
    .filter((w) => w.length > 1 && !STOP.has(w.toLowerCase()) && !/^\d+$/.test(w));
  return tokens.slice(0, QUERY_TOKENS).join(' ');
}

/** A dash/underscore slug back into a space-separated query: "bmw-320d" → "bmw 320d". */
export function deslugify(slug: string): string {
  return decodeURIComponent(slug).replace(/[-_+]+/g, ' ').trim();
}

/**
 * Extract the search query from one of `plugin`'s SERP URLs using its
 * `search_query_pattern` (capture group 1 = the slug). Returns undefined when the
 * vendor has no pattern or the URL doesn't match — so "extend search" only fires
 * on a recognisable keyword search.
 */
export function extractQuery(plugin: IVendorPlugin, url: string): string | undefined {
  if (!plugin.search_query_pattern) return undefined;
  let re: RegExp;
  try {
    re = new RegExp(plugin.search_query_pattern);
  } catch {
    return undefined; // a malformed manifest pattern must not throw
  }
  const m = re.exec(url);
  const slug = m?.[1];
  if (!slug) return undefined;
  const q = deslugify(slug);
  return q.length > 0 ? q : undefined;
}

/** Build a vendor's SERP URL for a query, or undefined when it has no template. */
export function searchUrlFor(plugin: IVendorPlugin, query: string): string | undefined {
  if (!plugin.search_url_template) return undefined;
  const slug = slugify(query);
  if (!slug) return undefined;
  return plugin.search_url_template.replace('{query}', slug);
}

export interface VendorSuggestion {
  vendor: string;
  url: string;
}

/**
 * Other platforms (excluding `excludeVendor`) that can be auto-watched for
 * `query`. Sorted by vendor name for a stable button order.
 */
export function suggestVendors(plugins: IVendorPlugin[], query: string, excludeVendor?: string): VendorSuggestion[] {
  const out: VendorSuggestion[] = [];
  for (const p of plugins) {
    if (p.vendor === excludeVendor) continue;
    const url = searchUrlFor(p, query);
    if (url) out.push({ vendor: p.vendor, url });
  }
  return out.sort((a, b) => a.vendor.localeCompare(b.vendor));
}
