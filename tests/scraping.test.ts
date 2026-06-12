/**
 * Phase 4 — Distributed Scraping Engine.
 *
 * Every test injects a synchronous fetcher (no live network) and a no-op `sleep`
 * (no real waiting), keeping the suite deterministic and instant. Timestamps are
 * passed explicitly so cooldown/rate-limit behavior is reproducible.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IVendorPlugin } from '../src/contracts/index';
import { ProxyPool } from '../src/scraping/proxyPool';
import { browserHeaders } from '../src/scraping/headers';
import { extractPayload } from '../src/scraping/extract';
import { classifyResponse } from '../src/scraping/blockDetection';
import { ScrapingEngine, type Fetcher } from '../src/scraping/engine';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureBody = readFileSync(join(here, 'fixtures', 'olx-search.html'), 'utf8');

/**
 * A synthetic json-extractor plugin matching the `__NEXT_DATA__` fixture. The
 * engine only uses the locator + json path (fields are the pipeline's concern),
 * so these tests exercise the ENGINE independently of any shipped manifest —
 * real-manifest calibration is covered by olx.test.ts.
 */
const synth: IVendorPlugin = {
  vendor: 'fixture',
  domain: 'fixture.test',
  engine: 'json-extractor',
  rate_limit_ms: 0,
  search_mapping: {
    payload_locator: 'script#__NEXT_DATA__',
    json_path_to_items: 'props.pageProps.data.listing.items',
    fields: { id: 'id', title: 'title', price: 'price', url: 'url' },
  },
  product_mapping: {
    payload_locator: 'script#__NEXT_DATA__',
    json_path: 'props.pageProps.ad',
    fields: { id: 'id', title: 'title', price: 'price', url: 'url' },
  },
};

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

  it('parses a window.<NAME> object-literal assignment', () => {
    const body = '<script>window.__STATE__ = {"a":{"b":[1,2]},"s":"};{"};</script>';
    const payload = extractPayload(body, 'window.__STATE__') as any;
    expect(payload.a.b).toEqual([1, 2]);
    expect(payload.s).toBe('};{');
  });

  it('parses a string-encoded window.<NAME> (double-encoded JSON, OLX-style)', () => {
    const inner = JSON.stringify({ listing: { listing: { ads: [{ id: 7 }] } } });
    const body = `<script>window.__PRERENDERED_STATE__= ${JSON.stringify(inner)};</script>`;
    const payload = extractPayload(body, 'window.__PRERENDERED_STATE__') as any;
    expect(payload.listing.listing.ads[0].id).toBe(7);
  });

  it('throws on a string-encoded global whose contents are not JSON', () => {
    const body = '<script>window.__X__ = "ro";</script>';
    expect(() => extractPayload(body, 'window.__X__')).toThrow();
  });

  it('skips decoys (=== guard, substring prefix) and finds the real assignment', () => {
    const inner = JSON.stringify({ ads: [{ id: 'real' }] });
    const body =
      '<script>' +
      'if (typeof window.__PRERENDERED_STATE__ === "undefined") { init(); }\n' +
      'subwindow.__PRERENDERED_STATE__ = "decoy";\n' +
      `window.__PRERENDERED_STATE__ = ${JSON.stringify(inner)};` +
      '</script>';
    const payload = extractPayload(body, 'window.__PRERENDERED_STATE__') as any;
    expect(payload.ads[0].id).toBe('real');
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

  it('carries modern Client Hints + Sec-Fetch metadata consistent with the UA', () => {
    const h = browserHeaders();
    expect(h['sec-ch-ua']).toMatch(/Chromium|Chrome|Not.A.Brand/);
    expect(h['sec-ch-ua-mobile']).toBe('?0');
    expect(h['sec-ch-ua-platform']).toBeDefined();
    expect(h['Sec-Fetch-Mode']).toBe('navigate');
    expect(h['Sec-Fetch-Dest']).toBe('document');
    expect(h['Upgrade-Insecure-Requests']).toBe('1');
    // The advertised brand version must agree with the UA's Chrome major.
    const major = /Chrome\/(\d+)/.exec(h['User-Agent'] ?? '')?.[1];
    expect(major).toBeDefined();
    expect(h['sec-ch-ua']).toContain(major!);
  });

  it('rotates the User-Agent across calls (not a single static string)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(browserHeaders()['User-Agent']!);
    expect(seen.size).toBeGreaterThan(1);
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

    const outcome = await engine.scrapeSearch(synth, 'https://www.olx.ro/search', 0);
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

    const outcome = await engine.scrapeSearch(synth, 'https://www.olx.ro/search', 0);
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

    const outcome = await engine.scrapeSearch(synth, 'https://www.olx.ro/search', 0);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(403);
    expect(outcome.rawNodes).toEqual([]);
    expect(outcome.benched).toEqual(['p1', 'p2']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// classifyResponse — header-signature block detection (never body substring)
// ────────────────────────────────────────────────────────────────────────────

describe('classifyResponse', () => {
  it('flags an Akamai 403 (server: AkamaiGHost) as a hard block', () => {
    const v = classifyResponse(403, { server: 'AkamaiGHost' });
    expect(v.blocked).toBe(true);
    expect(v.provider).toBe('akamai');
  });

  it('flags a Cloudflare 403 (cf-ray) as a block', () => {
    const v = classifyResponse(403, { 'cf-ray': '8a1b2c3d4e5f', server: 'cloudflare' });
    expect(v.blocked).toBe(true);
    expect(v.provider).toBe('cloudflare');
  });

  it('flags Imperva (x-iinfo + 403) and CloudFront (x-amz-cf-id + 403)', () => {
    expect(classifyResponse(403, { 'x-iinfo': '1-2-3' }).provider).toBe('imperva');
    expect(classifyResponse(403, { 'x-amz-cf-id': 'abc' }).provider).toBe('cloudfront');
  });

  it('does NOT flag a 200 even when anti-bot SDK headers/bodies are present', () => {
    // The live crawl proved working vendors ship cf-ray + datadome on 200s.
    const v = classifyResponse(200, { 'cf-ray': '8a1b2c3d4e5f', server: 'cloudflare' });
    expect(v.blocked).toBe(false);
  });

  it('treats a bare 403 with no provider signature as a soft ban, not a hard block', () => {
    const v = classifyResponse(403, {});
    expect(v.blocked).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// defaultFetcher — follows redirects and surfaces headers + finalUrl
// ────────────────────────────────────────────────────────────────────────────

describe('defaultFetcher (real undici transport)', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(301, { location: '/final' });
        res.end();
      } else if (req.url === '/final') {
        res.writeHead(200, { 'content-type': 'text/html', 'x-test': 'final' });
        res.end('<html>FINAL BODY</html>');
      } else if (req.url === '/deny') {
        res.writeHead(403, { server: 'AkamaiGHost' });
        res.end('Access Denied');
      } else if (req.url === '/large') {
        // ~2 MB streamed in chunks — well under the cap; must round-trip intact.
        res.writeHead(200, { 'content-type': 'text/html' });
        const chunk = 'a'.repeat(64 * 1024);
        for (let i = 0; i < 32; i++) res.write(chunk);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('follows a 301 and returns the final 200 body, headers, and finalUrl', async () => {
    const { defaultFetcher } = await import('../src/scraping/engine');
    const r = await defaultFetcher(`${base}/redirect`, { headers: browserHeaders() });
    expect(r.status).toBe(200);
    expect(r.body).toContain('FINAL BODY');
    expect(r.headers?.['x-test']).toBe('final');
    expect(r.finalUrl).toBe(`${base}/final`);
  });

  it('surfaces provider headers on a 403 so the engine can classify a block', async () => {
    const { defaultFetcher } = await import('../src/scraping/engine');
    const r = await defaultFetcher(`${base}/deny`, { headers: browserHeaders() });
    expect(r.status).toBe(403);
    expect(r.headers?.server).toBe('AkamaiGHost');
    expect(classifyResponse(r.status, r.headers ?? {}).blocked).toBe(true);
  });

  it('reads a multi-chunk body to completion (streaming reader round-trips intact)', async () => {
    const { defaultFetcher } = await import('../src/scraping/engine');
    const r = await defaultFetcher(`${base}/large`, { headers: browserHeaders() });
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(2 * 1024 * 1024); // full body, nothing dropped under the cap
    expect(r.body).toMatch(/^a+$/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ScrapingEngine — hard-block signalling
// ────────────────────────────────────────────────────────────────────────────

describe('ScrapingEngine hard-block signalling', () => {
  it('marks a hard block (403 + AkamaiGHost) distinctly from a soft ban', async () => {
    const pool = new ProxyPool([], 1000);
    const akamaiFetcher: Fetcher = async () => ({
      status: 403,
      body: 'Access Denied',
      headers: { server: 'AkamaiGHost' },
    });
    const engine = new ScrapingEngine({ pool, cooldownMs: 1000, fetcher: akamaiFetcher, sleep: noSleep });
    const outcome = await engine.scrapeSearch(synth, 'https://suchen.mobile.de/x', 0);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(403);
    expect(outcome.blocked).toBe(true);
    expect(outcome.blockProvider).toBe('akamai');
  });

  it('a plain 200 extraction reports blocked:false', async () => {
    const pool = new ProxyPool([], 1000);
    const engine = new ScrapingEngine({ pool, cooldownMs: 1000, fetcher: okFetcher, sleep: noSleep });
    const outcome = await engine.scrapeSearch(synth, 'https://www.olx.ro/search', 0);
    expect(outcome.ok).toBe(true);
    expect(outcome.blocked).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ScrapingEngine — opt-in browser-fallback escalation on a hard block
// ────────────────────────────────────────────────────────────────────────────

describe('ScrapingEngine browser-fallback escalation', () => {
  const browserPlugin: IVendorPlugin = { ...synth, fetch_strategy: 'browser' };

  it('escalates to the browser fetcher on a hard block (opted-in manifest)', async () => {
    const pool = new ProxyPool([], 1000);
    const httpFetcher: Fetcher = async () => ({
      status: 403,
      body: 'Access Denied',
      headers: { server: 'AkamaiGHost' },
    });
    let browserCalls = 0;
    const browserFetcher: Fetcher = async () => {
      browserCalls++;
      return { status: 200, body: fixtureBody };
    };
    const engine = new ScrapingEngine({
      pool,
      cooldownMs: 1000,
      fetcher: httpFetcher,
      browserFetcher,
      sleep: noSleep,
    });

    const outcome = await engine.scrapeSearch(browserPlugin, 'https://suchen.mobile.de/x', 0);
    expect(browserCalls).toBe(1);
    expect(outcome.ok).toBe(true);
    expect(outcome.usedBrowser).toBe(true);
    expect(outcome.rawNodes.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT escalate when the manifest did not opt in (default http)', async () => {
    const pool = new ProxyPool([], 1000);
    const httpFetcher: Fetcher = async () => ({
      status: 403,
      body: 'Access Denied',
      headers: { server: 'AkamaiGHost' },
    });
    let browserCalls = 0;
    const browserFetcher: Fetcher = async () => {
      browserCalls++;
      return { status: 200, body: fixtureBody };
    };
    const engine = new ScrapingEngine({
      pool,
      cooldownMs: 1000,
      fetcher: httpFetcher,
      browserFetcher,
      sleep: noSleep,
    });

    const outcome = await engine.scrapeSearch(synth, 'https://www.olx.ro/x', 0);
    expect(browserCalls).toBe(0);
    expect(outcome.ok).toBe(false);
    expect(outcome.blocked).toBe(true);
  });

  it('does NOT escalate a bare 403 soft-ban (no provider header) to the browser', async () => {
    const pool = new ProxyPool(['p1', 'p2'], 1000);
    const bareBan: Fetcher = async () => ({ status: 403, body: '' }); // no headers
    let browserCalls = 0;
    const browserFetcher: Fetcher = async () => {
      browserCalls++;
      return { status: 200, body: fixtureBody };
    };
    const engine = new ScrapingEngine({
      pool,
      cooldownMs: 1000,
      fetcher: bareBan,
      browserFetcher,
      sleep: noSleep,
    });

    const outcome = await engine.scrapeSearch(browserPlugin, 'https://suchen.mobile.de/x', 0);
    expect(browserCalls).toBe(0); // a soft ban rotates proxies, it does not render
    expect(outcome.ok).toBe(false);
    expect(outcome.blocked).toBe(false);
    expect(outcome.benched).toEqual(['p1', 'p2']);
  });

  it('does NOT escalate a normal 200 even for a browser-opted-in manifest', async () => {
    const pool = new ProxyPool([], 1000);
    let browserCalls = 0;
    const browserFetcher: Fetcher = async () => {
      browserCalls++;
      return { status: 200, body: fixtureBody };
    };
    const engine = new ScrapingEngine({
      pool,
      cooldownMs: 1000,
      fetcher: okFetcher,
      browserFetcher,
      sleep: noSleep,
    });

    const outcome = await engine.scrapeSearch(browserPlugin, 'https://suchen.mobile.de/x', 0);
    expect(browserCalls).toBe(0);
    expect(outcome.ok).toBe(true);
    expect(outcome.usedBrowser).toBe(false);
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

    const outcome = await engine.scrapeProduct(synth, 'https://www.olx.ro/d/ad', 0);
    expect(outcome.ok).toBe(true);
    expect(outcome.rawNodes).toHaveLength(1);
    expect((outcome.rawNodes[0] as any).id).toBe('9000');
  });
});
