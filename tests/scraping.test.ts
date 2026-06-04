/**
 * Phase 4 — Distributed Scraping Engine.
 *
 * Every test injects a synchronous fetcher (no live network) and a no-op `sleep`
 * (no real waiting), keeping the suite deterministic and instant. Timestamps are
 * passed explicitly so cooldown/rate-limit behavior is reproducible.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PluginRegistry } from '../src/registry/index';
import type { IVendorPlugin } from '../src/contracts/index';
import { ProxyPool } from '../src/scraping/proxyPool';
import { browserHeaders } from '../src/scraping/headers';
import { extractPayload } from '../src/scraping/extract';
import { ScrapingEngine, type Fetcher } from '../src/scraping/engine';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureBody = readFileSync(join(here, 'fixtures', 'olx-search.html'), 'utf8');

/** Load the real OLX manifest so tests bind to the shipped field paths. */
const olx: IVendorPlugin = PluginRegistry.load(join(here, '..', 'plugins')).getByDomain(
  'olx.ro',
)!;

/** A fetcher that always returns the OLX search fixture with status 200. */
const okFetcher: Fetcher = async () => ({ status: 200, body: fixtureBody });

/** No-op sleep so rate limiting never actually waits. */
const noSleep = async (): Promise<void> => {};

// ────────────────────────────────────────────────────────────────────────────
// ProxyPool
// ────────────────────────────────────────────────────────────────────────────

describe('ProxyPool', () => {
  it('acquire rotates round-robin among proxies', () => {
    const pool = new ProxyPool(['p1', 'p2', 'p3'], 1000);
    expect(pool.size).toBe(3);
    expect(pool.acquire(0)).toBe('p1');
    expect(pool.acquire(0)).toBe('p2');
    expect(pool.acquire(0)).toBe('p3');
    expect(pool.acquire(0)).toBe('p1'); // wraps around
  });

  it('bench removes a proxy from rotation until the cooldown elapses', () => {
    const pool = new ProxyPool(['p1', 'p2'], 1000);
    pool.bench('p1', 100);
    expect(pool.available(100)).toBe(1);
    // p1 is benched until t=1100, so only p2 is handed out meanwhile.
    expect(pool.acquire(100)).toBe('p2');
    expect(pool.acquire(100)).toBe('p2');
    // After the cooldown elapses p1 is usable again.
    expect(pool.available(1100)).toBe(2);
    expect(pool.acquire(1100)).toBe('p1');
  });

  it('returns undefined when every proxy is benched', () => {
    const pool = new ProxyPool(['p1', 'p2'], 1000);
    pool.bench('p1', 0);
    pool.bench('p2', 0);
    expect(pool.acquire(500)).toBeUndefined();
    expect(pool.available(500)).toBe(0);
  });

  it('returns undefined for an empty pool', () => {
    const pool = new ProxyPool([], 1000);
    expect(pool.acquire(0)).toBeUndefined();
    expect(pool.size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// extractPayload
// ────────────────────────────────────────────────────────────────────────────

describe('extractPayload', () => {
  it('parses script#__NEXT_DATA__ from the fixture', () => {
    const payload = extractPayload(fixtureBody, 'script#__NEXT_DATA__') as any;
    const items = payload.props.pageProps.data.listing.items;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(3);
    expect(items[0].id).toBe('1001');
  });

  it('throws when the locator is missing from the body', () => {
    expect(() => extractPayload(fixtureBody, 'script#__MISSING__')).toThrow();
  });

  it('parses a window.<NAME> assignment', () => {
    const body = '<script>window.__STATE__ = {"a":{"b":[1,2]},"s":"};{"};</script>';
    const payload = extractPayload(body, 'window.__STATE__') as any;
    expect(payload.a.b).toEqual([1, 2]);
    expect(payload.s).toBe('};{');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// browserHeaders
// ────────────────────────────────────────────────────────────────────────────

describe('browserHeaders', () => {
  it("defaults Accept-Language to 'ro-RO,ro;q=0.9' and sets a desktop UA", () => {
    const h = browserHeaders();
    expect(h['Accept-Language']).toBe('ro-RO,ro;q=0.9');
    expect(h['User-Agent']).toMatch(/Mozilla\/5\.0/);
    expect(h.Accept).toBeDefined();
    expect(h['Cache-Control']).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ScrapingEngine
// ────────────────────────────────────────────────────────────────────────────

describe('ScrapingEngine.scrapeSearch', () => {
  it('returns the raw item nodes from the fixture and sets ok:true', async () => {
    const pool = new ProxyPool(['p1', 'p2'], 1000);
    const engine = new ScrapingEngine({
      pool,
      cooldownMs: 1000,
      fetcher: okFetcher,
      sleep: noSleep,
    });

    const outcome = await engine.scrapeSearch(olx, 'https://www.olx.ro/search', 0);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(200);
    expect(outcome.rawNodes.length).toBeGreaterThanOrEqual(2);
    expect(outcome.benched).toEqual([]);
    // Raw nodes follow the OLX item shape (paths resolved by the pipeline later).
    expect((outcome.rawNodes[0] as any).id).toBe('1001');
  });

  it('benches the first proxy on a 429 and retries on a different proxy', async () => {
    const pool = new ProxyPool(['p1', 'p2'], 1000);
    const seen: string[] = [];
    // First proxy (p1) soft-bans; the retry on p2 succeeds.
    const flakyFetcher: Fetcher = async (_url, { proxyUrl }) => {
      seen.push(proxyUrl!);
      if (proxyUrl === 'p1') return { status: 429, body: '' };
      return { status: 200, body: fixtureBody };
    };
    const engine = new ScrapingEngine({
      pool,
      cooldownMs: 1000,
      fetcher: flakyFetcher,
      sleep: noSleep,
    });

    const outcome = await engine.scrapeSearch(olx, 'https://www.olx.ro/search', 0);
    expect(outcome.benched).toContain('p1');
    expect(seen).toEqual(['p1', 'p2']); // rotated to a different proxy
    expect(outcome.ok).toBe(true); // second proxy delivered the payload
    expect(outcome.rawNodes.length).toBeGreaterThanOrEqual(2);
  });

  it('fails when both proxies soft-ban (retry exhausted)', async () => {
    const pool = new ProxyPool(['p1', 'p2'], 1000);
    const banFetcher: Fetcher = async () => ({ status: 403, body: '' });
    const engine = new ScrapingEngine({
      pool,
      cooldownMs: 1000,
      fetcher: banFetcher,
      sleep: noSleep,
    });

    const outcome = await engine.scrapeSearch(olx, 'https://www.olx.ro/search', 0);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(403);
    expect(outcome.rawNodes).toEqual([]);
    expect(outcome.benched).toEqual(['p1', 'p2']);
  });
});

describe('ScrapingEngine.scrapeProduct', () => {
  it('wraps the single product node into rawNodes', async () => {
    // A product fixture whose payload exposes props.pageProps.ad.
    const productBody =
      '<script id="__NEXT_DATA__" type="application/json">' +
      JSON.stringify({
        props: { pageProps: { ad: { id: '9000', title: 'Single ad', active: true } } },
      }) +
      '</script>';
    const pool = new ProxyPool(['p1'], 1000);
    const engine = new ScrapingEngine({
      pool,
      cooldownMs: 1000,
      fetcher: async () => ({ status: 200, body: productBody }),
      sleep: noSleep,
    });

    const outcome = await engine.scrapeProduct(olx, 'https://www.olx.ro/d/ad', 0);
    expect(outcome.ok).toBe(true);
    expect(outcome.rawNodes).toHaveLength(1);
    expect((outcome.rawNodes[0] as any).id).toBe('9000');
  });
});
