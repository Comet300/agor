/**
 * Realistic browser request headers.
 *
 * Romanian marketplaces gate or fingerprint obvious bot traffic, so every
 * request carries a modern desktop User-Agent and an `Accept-Language` defaulted
 * to Romanian. Callers may override the language for non-RO storefronts.
 */

/** A current desktop Chrome User-Agent string. */
const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Build the header set sent with every scrape request. `acceptLanguage`
 * defaults to Romanian (`ro-RO,ro;q=0.9`).
 */
export function browserHeaders(
  acceptLanguage = 'ro-RO,ro;q=0.9',
): Record<string, string> {
  return {
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,' +
      'image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': acceptLanguage,
    'Cache-Control': 'no-cache',
    'User-Agent': DESKTOP_USER_AGENT,
  };
}
