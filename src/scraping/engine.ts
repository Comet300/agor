/**
 * Distributed scraping engine (Phase 4).
 *
 * Drives a single search- or product-page scrape end to end:
 *   1. acquire a proxy from the {@link ProxyPool},
 *   2. issue the request through an injectable {@link Fetcher} with realistic
 *      {@link browserHeaders},
 *   3. on a 429/403 soft-ban, bench the offending proxy and retry once on a
 *      different one,
 *   4. on success, locate the embedded JSON payload ({@link extractPayload}) and
 *      resolve the configured path ({@link resolvePath}) to the raw item node(s).
 *
 * The fetcher and `sleep` are injectable so tests run with zero network and zero
 * real waiting; the default fetcher uses undici with a per-request
 * {@link ProxyAgent} dispatcher.
 */
import { request, ProxyAgent } from 'undici';
import type { IVendorPlugin } from '../contracts';
import { resolvePath } from '../util/jsonPath';
import { browserHeaders } from './headers';
import { extractPayload } from './extract';
import { ProxyPool } from './proxyPool';

/** Outcome of a single HTTP fetch (status + decoded text body). */
export interface FetchResult {
  status: number;
  body: string;
}

/** Injectable transport: resolves a URL (optionally via a proxy) to a body. */
export type Fetcher = (
  url: string,
  opts: { headers: Record<string, string>; proxyUrl?: string },
) => Promise<FetchResult>;

/** Result of a scrape: the raw vendor item nodes plus any benched proxies. */
export interface ScrapeOutcome {
  ok: boolean;
  status: number;
  /** Raw, un-normalized item node(s) located via the plugin's json path. */
  rawNodes: unknown[];
  /** Proxy URLs benched during this scrape (soft-ban victims). */
  benched: string[];
}

/** HTTP statuses that indicate a proxy-level soft ban worth rotating away from. */
const SOFT_BAN_STATUSES = new Set([429, 403]);

/**
 * Default {@link Fetcher} built on undici. Routes through a {@link ProxyAgent}
 * dispatcher when `proxyUrl` is supplied; reads the full body as text.
 */
const defaultFetcher: Fetcher = async (url, { headers, proxyUrl }) => {
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  const res = await request(url, { method: 'GET', headers, dispatcher });
  const body = await res.body.text();
  return { status: res.statusCode, body };
};

/** Default no-op-respecting sleep used when none is injected. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class ScrapingEngine {
  private readonly pool: ProxyPool;
  private readonly fetcher: Fetcher;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rateLimit: boolean;
  /** ms epoch of the last request issued per vendor (for rate limiting). */
  private readonly lastHit = new Map<string, number>();

  constructor(opts: {
    pool: ProxyPool;
    cooldownMs: number;
    fetcher?: Fetcher;
    sleep?: (ms: number) => Promise<void>;
    rateLimit?: boolean;
  }) {
    this.pool = opts.pool;
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.sleep = opts.sleep ?? defaultSleep;
    // Rate limiting is on unless explicitly disabled.
    this.rateLimit = opts.rateLimit !== false;
  }

  /**
   * Throttle per vendor: if the same vendor was hit within its `rate_limit_ms`
   * window, await `sleep(rate_limit_ms)` before issuing the next request. The
   * last-hit clock is stamped to `now` so back-to-back calls stay spaced.
   */
  private async respectRateLimit(plugin: IVendorPlugin, now: number): Promise<void> {
    if (this.rateLimit) {
      const last = this.lastHit.get(plugin.vendor);
      if (last !== undefined && now - last < plugin.rate_limit_ms) {
        await this.sleep(plugin.rate_limit_ms);
      }
    }
    this.lastHit.set(plugin.vendor, now);
  }

  /**
   * Fetch `url` with retry-once-on-soft-ban proxy rotation.
   *
   * Returns the successful {@link FetchResult} (or the final failing one) plus
   * the list of proxies benched along the way. A failure is signalled by a
   * `result` whose status is a soft-ban code, or by an absent body when no proxy
   * could be acquired.
   */
  private async fetchWithRotation(
    url: string,
    now: number,
  ): Promise<{ result?: FetchResult; benched: string[] }> {
    const benched: string[] = [];
    const headers = browserHeaders();

    // Up to two attempts: original proxy, then a different one after a bench.
    for (let attempt = 0; attempt < 2; attempt++) {
      const proxyUrl = this.pool.acquire(now);
      // No proxy available at all → cannot proceed.
      if (proxyUrl === undefined && this.pool.size > 0) {
        return { benched };
      }

      const result = await this.fetcher(url, { headers, proxyUrl });

      if (SOFT_BAN_STATUSES.has(result.status)) {
        // Bench the offending proxy and rotate to a different one (retry once).
        if (proxyUrl !== undefined) {
          this.pool.bench(proxyUrl, now);
          benched.push(proxyUrl);
        }
        // On the final attempt, surface the soft-ban status to the caller.
        if (attempt === 1) return { result, benched };
        continue;
      }

      // Any non-soft-ban status (2xx or otherwise) ends rotation.
      return { result, benched };
    }

    return { benched };
  }

  /** Shared request → extract → resolve pipeline for both scrape kinds. */
  private async scrape(
    plugin: IVendorPlugin,
    url: string,
    now: number,
    locator: string,
    jsonPath: string,
    coerce: (located: unknown) => unknown[],
  ): Promise<ScrapeOutcome> {
    await this.respectRateLimit(plugin, now);

    const { result, benched } = await this.fetchWithRotation(url, now);

    // No usable response (no proxy, or exhausted retries on a soft ban).
    if (!result || SOFT_BAN_STATUSES.has(result.status)) {
      return { ok: false, status: result?.status ?? 0, rawNodes: [], benched };
    }

    // Non-2xx, non-soft-ban (e.g. 404/500): report the status, no nodes.
    if (result.status < 200 || result.status >= 300) {
      return { ok: false, status: result.status, rawNodes: [], benched };
    }

    const payload = extractPayload(result.body, locator);
    const located = resolvePath(payload, jsonPath);
    return {
      ok: true,
      status: result.status,
      rawNodes: coerce(located),
      benched,
    };
  }

  /**
   * Scrape a search-results page: resolves `json_path_to_items` to an array of
   * raw item nodes (coerced to `[]` when the path is missing or not an array).
   */
  scrapeSearch(
    plugin: IVendorPlugin,
    url: string,
    now: number,
  ): Promise<ScrapeOutcome> {
    const { payload_locator, json_path_to_items } = plugin.search_mapping;
    return this.scrape(
      plugin,
      url,
      now,
      payload_locator,
      json_path_to_items,
      (located) => (Array.isArray(located) ? located : []),
    );
  }

  /**
   * Scrape a single product page: resolves `json_path` to one node, wrapped as
   * `[node]` (or `[]` when the node is absent).
   */
  scrapeProduct(
    plugin: IVendorPlugin,
    url: string,
    now: number,
  ): Promise<ScrapeOutcome> {
    const { payload_locator, json_path } = plugin.product_mapping;
    return this.scrape(
      plugin,
      url,
      now,
      payload_locator,
      json_path,
      (located) => (located == null ? [] : [located]),
    );
  }
}
