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
import { extractPayload, extractCandidates, ExtractionError } from './extract';
import { domExtractSearch, domExtractProduct } from './domExtract';
import type { HealInfo, SelfHealer } from './selfHeal';
import type { CookieJar } from './cookieJar';
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
  /** Raw `Set-Cookie` header lines, for the per-vendor cookie jar. */
  setCookie?: string[];
}

/** Injectable transport: resolves a URL (optionally via a proxy) to a body. */
export type Fetcher = (
  url: string,
  opts: { headers: Record<string, string>; proxyUrl?: string; cookie?: string },
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
  /** Present when a dom-selector was relocated by self-healing this scrape. */
  healed?: HealInfo;
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
 * Generous cap on the response body read into memory (~30 MB). Far above any
 * real marketplace page (the largest live capture was ~8.5 MB), but bounds a
 * hostile/runaway response so it cannot exhaust memory on a small host.
 */
const MAX_BODY_BYTES = 30 * 1024 * 1024;

/**
 * Read a response body to text, stopping once {@link MAX_BODY_BYTES} is reached.
 * Streams chunks rather than buffering an unbounded `.text()`, so an oversized
 * (or never-ending) response is truncated instead of OOMing the process. The
 * underlying request is destroyed once the cap is hit.
 */
async function readCappedText(res: Awaited<ReturnType<typeof request>>): Promise<string> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of res.body) {
    const buf = chunk as Buffer;
    if (total + buf.length > MAX_BODY_BYTES) {
      chunks.push(buf.subarray(0, MAX_BODY_BYTES - total));
      res.body.destroy();
      total = MAX_BODY_BYTES;
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/**
 * Persistent undici dispatcher pool, keyed by proxy URL (`'direct'` for no
 * proxy). An {@link Agent}/{@link ProxyAgent} owns a connection pool with live
 * sockets; building one per request leaks file descriptors over a long-running
 * deployment. We build one per distinct route and reuse it, closing them all on
 * shutdown via {@link closeAgentPool}.
 */
const agentPool = new Map<string, Agent | ProxyAgent>();

/**
 * Return the pooled dispatcher for `proxyUrl` (or the shared direct dispatcher
 * when absent), constructing it on first use. Exported for lifecycle tests.
 */
export function getOrCreateAgent(proxyUrl: string | undefined): Agent | ProxyAgent {
  const key = proxyUrl ?? 'direct';
  let agent = agentPool.get(key);
  if (!agent) {
    agent = proxyUrl ? new ProxyAgent(proxyUrl) : new Agent();
    agentPool.set(key, agent);
  }
  return agent;
}

/**
 * Close every pooled dispatcher and empty the pool — call once on shutdown so
 * sockets are released cleanly. Best-effort per agent; a close failure is
 * swallowed so one bad dispatcher cannot block teardown.
 */
export async function closeAgentPool(): Promise<void> {
  const agents = [...agentPool.values()];
  agentPool.clear();
  await Promise.all(
    agents.map((a) => Promise.resolve(a.close()).catch(() => undefined)),
  );
}

/**
 * Default {@link Fetcher} built on undici. Routes through a pooled
 * {@link ProxyAgent} dispatcher when `proxyUrl` is supplied (else a shared
 * {@link Agent}), composes the redirect interceptor so 3xx canonicalizations
 * are followed, and surfaces the response headers plus the final (post-redirect)
 * URL for block detection and canonical persistence. The body is read with a
 * size cap so an oversized response cannot exhaust memory.
 */
export const defaultFetcher: Fetcher = async (url, { headers, proxyUrl, cookie }) => {
  const base = getOrCreateAgent(proxyUrl);
  const dispatcher = base.compose(interceptors.redirect({ maxRedirections: MAX_REDIRECTS }));
  // Attach the persisted session cookies for this domain, if any.
  const reqHeaders = cookie ? { ...headers, Cookie: cookie } : headers;
  const res = await request(url, { method: 'GET', headers: reqHeaders, dispatcher });
  const body = await readCappedText(res);
  // The redirect interceptor records the hop chain on res.context.history; the
  // last entry is the URL the request finally resolved to.
  const history = (res.context as { history?: URL[] } | undefined)?.history;
  const finalUrl =
    history && history.length > 0 ? String(history[history.length - 1]) : url;
  const sc = res.headers['set-cookie'];
  const setCookie = sc === undefined ? undefined : Array.isArray(sc) ? sc : [sc];
  return { status: res.statusCode, body, headers: res.headers, finalUrl, setCookie };
};

/** Default no-op-respecting sleep used when none is injected. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Build page-K's URL by setting the vendor's pagination query param. */
function withPageParam(url: string, param: string, page: number): string {
  try {
    const u = new URL(url);
    u.searchParams.set(param, String(page));
    return u.toString();
  } catch {
    return url; // non-absolute URL (shouldn't happen for a registered watch)
  }
}

export class ScrapingEngine {
  private readonly pool: ProxyPool;
  private readonly fetcher: Fetcher;
  /** Optional headless-browser transport for `fetch_strategy: browser` manifests. */
  private readonly browserFetcher?: Fetcher;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rateLimit: boolean;
  /** Optional self-healing store for `dom-selector` manifests. */
  private readonly selfHealer?: SelfHealer;
  /** Optional per-vendor cookie jar (session/clearance cookie reuse). */
  private readonly cookieJar?: CookieJar;
  /** Max search pages to walk for paginated vendors (1 = single page). */
  private readonly maxSearchPages: number;
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
    /** Fingerprint store enabling self-healing of broken dom-selectors. */
    selfHealer?: SelfHealer;
    /** Per-vendor cookie jar; when present, sessions persist across polls. */
    cookieJar?: CookieJar;
    /** Max search pages to walk for paginated vendors (default 1 = single page). */
    maxSearchPages?: number;
  }) {
    this.pool = opts.pool;
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.browserFetcher = opts.browserFetcher;
    this.sleep = opts.sleep ?? defaultSleep;
    this.selfHealer = opts.selfHealer;
    this.cookieJar = opts.cookieJar;
    this.maxSearchPages = Math.max(1, opts.maxSearchPages ?? 1);
    // Rate limiting is on unless explicitly disabled.
    this.rateLimit = opts.rateLimit !== false;
  }

  /**
   * Throttle per vendor: if the same vendor was hit within its `rate_limit_ms`
   * window, await only the time REMAINING in that window before issuing the next
   * request (not the full window — the elapsed gap since the last hit already
   * counts toward it). The last-hit clock is stamped to `now` so back-to-back
   * calls stay spaced exactly one window apart.
   */
  private async respectRateLimit(plugin: IVendorPlugin, now: number): Promise<void> {
    if (this.rateLimit) {
      const last = this.lastHit.get(plugin.vendor);
      if (last !== undefined) {
        const remaining = plugin.rate_limit_ms - (now - last);
        if (remaining > 0) await this.sleep(remaining);
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
    domain?: string,
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

      // Replay persisted session cookies for this domain; capture any updates.
      const cookie = domain && this.cookieJar ? this.cookieJar.cookieHeader(domain, now) : undefined;
      const result = await this.fetcher(url, { headers, proxyUrl, ...(cookie ? { cookie } : {}) });
      if (domain && this.cookieJar) this.cookieJar.ingestSetCookie(domain, result.setCookie, now);

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
    extract: (body: string) => { nodes: unknown[]; healed?: HealInfo },
  ): Promise<ScrapeOutcome> {
    await this.respectRateLimit(plugin, now);

    let { result, benched } = await this.fetchWithRotation(url, now, plugin.domain);
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
        // The browser pass is where a Cloudflare challenge actually clears, so
        // replay + capture cookies here too — the resulting clearance cookie then
        // rides the cheap HTTP transport on subsequent polls.
        const cookie = this.cookieJar ? this.cookieJar.cookieHeader(plugin.domain, now) : undefined;
        const browserResult = await this.browserFetcher(url, { headers: browserHeaders(), ...(cookie ? { cookie } : {}) });
        usedBrowser = true;
        result = browserResult;
        if (this.cookieJar) this.cookieJar.ingestSetCookie(plugin.domain, browserResult.setCookie, now);
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
    let healed: HealInfo | undefined;
    try {
      const extracted = extract(result.body);
      rawNodes = extracted.nodes;
      healed = extracted.healed;
    } catch (err) {
      // Distinguish WHY extraction failed (vendor layout change vs. malformed
      // response vs. a bad manifest) via the ExtractionError's machine-readable
      // reason; a non-ExtractionError keeps the generic 'extract_failed'.
      const reason = err instanceof ExtractionError ? err.reason : 'extract_failed';
      log('engine').warn(
        { vendor: plugin.vendor, url, status: result.status, reason, err: (err as Error).message },
        'payload extraction failed (vendor layout change?)',
      );
      return { ok: false, status: result.status, rawNodes: [], benched, ...blockFields };
    }

    if (healed) {
      log('engine').warn(
        { vendor: plugin.vendor, url, event: 'SELECTOR-HEALED', ...healed },
        'dom-selector relocated by self-healing — update the manifest',
      );
    }
    log('engine').debug(
      { vendor: plugin.vendor, url, status: result.status, items: rawNodes.length, usedBrowser },
      'fetch ok',
    );
    return { ok: true, status: result.status, rawNodes, benched, ...blockFields, healed };
  }

  /**
   * Scrape a search-results page. For `json-extractor` plugins this resolves
   * `json_path_to_items` to an array; for `dom-selector` plugins it extracts
   * item records via CSS selectors. Both yield raw nodes the normalizer consumes.
   */
  async scrapeSearch(
    plugin: IVendorPlugin,
    url: string,
    now: number,
  ): Promise<ScrapeOutcome> {
    const extract =
      plugin.engine === 'dom-selector'
        ? (body: string) => {
            const r = domExtractSearch(body, plugin, this.selfHealer);
            return { nodes: r.records, healed: r.healed };
          }
        : (body: string) => {
            const located = locate(body, plugin.search_mapping.payload_locator, plugin.search_mapping.json_path_to_items);
            return { nodes: Array.isArray(located) ? located : [] };
          };

    const first = await this.scrape(plugin, url, now, extract);
    // Single page unless the vendor opts into pagination and the page-1 scrape
    // succeeded with a full page worth of items.
    if (!first.ok || !plugin.pagination || this.maxSearchPages <= 1 || first.rawNodes.length === 0) {
      return first;
    }

    // Walk further pages, accumulating raw nodes. Each page goes through the same
    // rate-limited, proxy-rotated fetch (so vendor spacing is respected — ban-safe),
    // and we stop as soon as a page is empty or short (the last page) to avoid
    // over-fetching. The page cap is the hard ceiling.
    const merged = [...first.rawNodes];
    const pageSize = first.rawNodes.length;
    for (let page = 2; page <= this.maxSearchPages; page++) {
      const pageUrl = withPageParam(url, plugin.pagination.param, page);
      const r = await this.scrape(plugin, pageUrl, now, extract);
      if (!r.ok || r.rawNodes.length === 0) break;
      merged.push(...r.rawNodes);
      if (r.rawNodes.length < pageSize) break; // short page ⇒ last page
    }
    log('engine').debug(
      { vendor: plugin.vendor, url, pages: Math.ceil(merged.length / Math.max(1, pageSize)), items: merged.length },
      'paged search complete',
    );
    return { ...first, rawNodes: merged };
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
      return this.scrape(plugin, url, now, (body) => {
        const r = domExtractProduct(body, plugin, this.selfHealer);
        return { nodes: r.records, healed: r.healed };
      });
    }
    const { payload_locator, json_path } = plugin.product_mapping;
    return this.scrape(plugin, url, now, (body) => {
      const located = locate(body, payload_locator, json_path);
      return { nodes: located == null ? [] : [located] };
    });
  }
}
