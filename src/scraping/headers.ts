/**
 * Realistic browser request headers.
 *
 * Romanian marketplaces gate or fingerprint obvious bot traffic, so every
 * request mirrors a modern desktop Chrome: a rotated User-Agent, matching
 * Client Hints (`sec-ch-ua*`), and the navigation `Sec-Fetch-*` set a real
 * top-level document load carries. `Accept-Language` defaults to Romanian;
 * callers may override it for non-RO storefronts.
 */

/** A desktop Chrome profile: its UA string and the Chrome major it advertises. */
interface BrowserProfile {
  userAgent: string;
  chromeMajor: number;
  platform: string;
}

/** A small pool of current desktop Chrome profiles, rotated per request. */
const PROFILES: BrowserProfile[] = [
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    chromeMajor: 124,
    platform: '"Windows"',
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    chromeMajor: 125,
    platform: '"macOS"',
  },
  {
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    chromeMajor: 123,
    platform: '"Linux"',
  },
];

/** Rotation cursor so successive requests vary their fingerprint. */
let cursor = 0;

/** The `sec-ch-ua` brand list Chrome sends for a given major version. */
function brandList(major: number): string {
  return `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not.A/Brand";v="99"`;
}

/**
 * Build the header set sent with every scrape request. Rotates across a pool of
 * desktop Chrome profiles so the User-Agent and its Client Hints stay internally
 * consistent. `acceptLanguage` defaults to Romanian (`ro-RO,ro;q=0.9`).
 */
export function browserHeaders(
  acceptLanguage = 'ro-RO,ro;q=0.9',
): Record<string, string> {
  const profile = PROFILES[cursor % PROFILES.length]!;
  cursor++;
  return {
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,' +
      'image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': acceptLanguage,
    'Cache-Control': 'no-cache',
    'User-Agent': profile.userAgent,
    'sec-ch-ua': brandList(profile.chromeMajor),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': profile.platform,
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
    'Upgrade-Insecure-Requests': '1',
  };
}
