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
import { request, Agent, ProxyAgent, interceptors } from 'undici';
import type { IVendorPlugin } from '../contracts';
import { resolvePath } from '../util/jsonPath';
import { browserHeaders } from './headers';
import { extractPayload, extractCandidates } from './extract';
import { domExtractSearch, domExtractProduct } from './domExtract';
import { classifyResponse, type BlockProvider } from './blockDetection';
import { ProxyPool } from './proxyPool';
import { log } from '../logging/logger';

/** Outcome of a single HTTP fetch (status, decoded body, headers, final URL). */
export interface FetchResult {
  status: number;
  body: string;
  /** Response headers (lower-cased keys), used for anti-bot block detection. */
  headers?: Record<string, string | string[] | undefined>;
  /** The URL the request finally resolved to after following redirects. */
  finalUrl?: string;
}

/** Injectable transport: resolves a URL (optionally via a proxy) to a body. */
export type Fetcher = (
  url: string,
  opts: { headers: Record<string, string>; proxyUrl?: string },
) => Promise<FetchResult>;

/** Result of a scrape: the raw vendor item nodes plus transport/health metadata. */
export interface ScrapeOutcome {
  ok: boolean;
  status: number;
  /** Raw, un-normalized item node(s) located via the plugin's json path. */
  rawNodes: unknown[];
  /** Proxy URLs benched during this scrape (soft-ban victims). */
  benched: string[];
  /** True when the response was a recognised anti-bot hard block. */
  blocked: boolean;
  /** The protection provider when `blocked`, for the circuit breaker / logs. */
  blockProvider?: BlockProvider;
  /** The URL the fetch finally resolved to (after redirects), when known. */
  finalUrl?: string;
  /** True when the browser fallback produced this outcome. */
  usedBrowser: boolean;
}

/** HTTP statuses that indicate a proxy-level soft ban worth rotating away from. */
const SOFT_BAN_STATUSES = new Set([429, 403]);

/**
 * Locate the value at `path` for the given payload locator. Multi-candidate
 * locators (`ldjson`, `flight:<anchor>`) yield several parsed payloads — the
 * first whose path resolves wins; classic locators parse a single payload.
 */
function locate(body: string, locator: string, path: string): unknown {
  const candidates = extractCandidates(body, locator);
  if (candidates !== undefined) {
    for (const candidate of candidates) {
      const resolved = resolvePath(candidate, path);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  return resolvePath(extractPayload(body, locator), path);
}

/** Proxy host:port for logging, with any embedded `user:pass@` credentials stripped. */
function proxyHost(proxyUrl: string | undefined): string | undefined {
  if (!proxyUrl) return undefined;
  try {
    return new URL(proxyUrl).host;
  } catch {
    return '[proxy]';
  }
}

/** Bounded redirect following — marketplaces canonicalize www→apex via 301. */
const MAX_REDIRECTS = 5;

/**
 * Default {@link Fetcher} built on undici. Routes through a {@link ProxyAgent}
 * dispatcher when `proxyUrl` is supplied (else a plain {@link Agent}), composes
 * the redirect interceptor so 3xx canonicalizations are followed, and surfaces
 * the response headers plus the final (post-redirect) URL for block detection
 * and canonical persistence.
 */
export const defaultFetcher: Fetcher = async (url, { headers, proxyUrl }) => {
  const base = proxyUrl ? new ProxyAgent(proxyUrl) : new Agent();
  const dispatcher = base.compose(interceptors.redirect({ maxRedirections: MAX_REDIRECTS }));
  const res = await request(url, { method: 'GET', headers, dispatcher });
  const body = await res.body.text();
  // The redirect interceptor records the hop chain on res.context.history; the
  // last entry is the URL the request finally resolved to.
  const history = (res.context as { history?: URL[] } | undefined)?.history;
  const finalUrl =
    history && history.length > 0 ? String(history[history.length - 1]) : url;
  return { status: res.statusCode, body, headers: res.headers, finalUrl };
};

/** Default no-op-respecting sleep used when none is injected. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class ScrapingEngine {
  private readonly pool: ProxyPool;
  private readonly fetcher: Fetcher;
  /** Optional headless-browser transport for `fetch_strategy: browser` manifests. */
  private readonly browserFetcher?: Fetcher;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rateLimit: boolean;
  /** ms epoch of the last request issued per vendor (for rate limiting). */
  private readonly lastHit = new Map<string, number>();

  constructor(opts: {
    pool: ProxyPool;
    cooldownMs: number;
    fetcher?: Fetcher;
    /** Headless-browser transport, lazily provided; only used on a hard block. */
    browserFetcher?: Fetcher;
    sleep?: (ms: number) => Promise<void>;
    rateLimit?: boolean;
  }) {
    this.pool = opts.pool;
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.browserFetcher = opts.browserFetcher;
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
        log('engine').warn(
          { url, status: result.status, proxy: proxyHost(proxyUrl), attempt },
          'soft-ban: proxy benched, rotating',
        );
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

  /**
   * Shared request → soft-ban handling pipeline. The body→nodes extraction is
   * supplied by the caller, which selects JSON-path or DOM-selector extraction
   * based on `plugin.engine`.
   */
  private async scrape(
    plugin: IVendorPlugin,
    url: string,
    now: number,
    extract: (body: string) => unknown[],
  ): Promise<ScrapeOutcome> {
    await this.respectRateLimit(plugin, now);

    let { result, benched } = await this.fetchWithRotation(url, now);
    let usedBrowser = false;

    // Classify the response against provider block signatures (header-based,
    // never body-substring) so a real anti-bot wall is distinguishable from a
    // transient soft ban or an empty search.
    let classification = result
      ? classifyResponse(result.status, result.headers ?? {})
      : { blocked: false as const, provider: undefined as BlockProvider | undefined };

    // Escalate to the headless browser ONCE on a hard block, but only when the
    // manifest opted in (`fetch_strategy: browser`) and a browser transport is
    // available. The HTTP path stays the default for every other vendor.
    if (
      classification.blocked &&
      plugin.fetch_strategy === 'browser' &&
      this.browserFetcher !== undefined
    ) {
      log('engine').info(
        { vendor: plugin.vendor, url, provider: classification.provider, event: 'BROWSER-FALLBACK' },
        'hard block — escalating to headless browser',
      );
      try {
        const browserResult = await this.browserFetcher(url, { headers: browserHeaders() });
        usedBrowser = true;
        result = browserResult;
        classification = classifyResponse(browserResult.status, browserResult.headers ?? {});
      } catch (err) {
        log('engine').warn(
          { vendor: plugin.vendor, url, reason: 'browser_fetch_failed', err: (err as Error).message },
          'browser fallback failed',
        );
      }
    }

    const blockFields = {
      blocked: classification.blocked,
      blockProvider: classification.provider,
      finalUrl: result?.finalUrl,
      usedBrowser,
    };
    if (classification.blocked) {
      log('engine').warn(
        { vendor: plugin.vendor, url, status: result?.status, provider: classification.provider, event: 'BOT-BLOCKED' },
        'anti-bot hard block detected',
      );
    }

    // No usable response (no proxy, or exhausted retries on a soft ban).
    if (!result || SOFT_BAN_STATUSES.has(result.status)) {
      return { ok: false, status: result?.status ?? 0, rawNodes: [], benched, ...blockFields };
    }

    // Non-2xx, non-soft-ban (e.g. 404/500): report the status, no nodes.
    if (result.status < 200 || result.status >= 300) {
      return { ok: false, status: result.status, rawNodes: [], benched, ...blockFields };
    }

    // Extraction can fail if the vendor changed its embedded-state shape. Treat
    // that as a soft failure (empty, retriable cycle) rather than throwing into
    // the scheduler.
    let rawNodes: unknown[];
    try {
      rawNodes = extract(result.body);
    } catch (err) {
      log('engine').warn(
        { vendor: plugin.vendor, url, status: result.status, reason: 'extract_failed', err: (err as Error).message },
        'payload extraction failed (vendor layout change?)',
      );
      return { ok: false, status: result.status, rawNodes: [], benched, ...blockFields };
    }

    log('engine').debug(
      { vendor: plugin.vendor, url, status: result.status, items: rawNodes.length, usedBrowser },
      'fetch ok',
    );
    return { ok: true, status: result.status, rawNodes, benched, ...blockFields };
  }

  /**
   * Scrape a search-results page. For `json-extractor` plugins this resolves
   * `json_path_to_items` to an array; for `dom-selector` plugins it extracts
   * item records via CSS selectors. Both yield raw nodes the normalizer consumes.
   */
  scrapeSearch(
    plugin: IVendorPlugin,
    url: string,
    now: number,
  ): Promise<ScrapeOutcome> {
    if (plugin.engine === 'dom-selector') {
      return this.scrape(plugin, url, now, (body) => domExtractSearch(body, plugin));
    }
    const { payload_locator, json_path_to_items } = plugin.search_mapping;
    return this.scrape(plugin, url, now, (body) => {
      const located = locate(body, payload_locator, json_path_to_items);
      return Array.isArray(located) ? located : [];
    });
  }

  /**
   * Scrape a single product page. For `json-extractor` plugins this resolves
   * `json_path` to one node; for `dom-selector` plugins it extracts one record
   * from the product root selector. Either is wrapped as `[node]` (or `[]`).
   */
  scrapeProduct(
    plugin: IVendorPlugin,
    url: string,
    now: number,
  ): Promise<ScrapeOutcome> {
    if (plugin.engine === 'dom-selector') {
      return this.scrape(plugin, url, now, (body) => domExtractProduct(body, plugin));
    }
    const { payload_locator, json_path } = plugin.product_mapping;
    return this.scrape(plugin, url, now, (body) => {
      const located = locate(body, payload_locator, json_path);
      return located == null ? [] : [located];
    });
  }
}
