import { describe, it, expect } from 'vitest';
import { CookieJar, parseSetCookie, type CookiePersistence, type DomainJar } from '../src/scraping/cookieJar';
import { ScrapingEngine, type Fetcher } from '../src/scraping/engine';
import { ProxyPool } from '../src/scraping/proxyPool';
import type { IVendorPlugin } from '../src/contracts';

const D = 'v.test';

describe('parseSetCookie', () => {
  it('extracts name/value and ignores attributes without expiry', () => {
    expect(parseSetCookie('sid=abc; Path=/; HttpOnly', 1000)).toEqual({ name: 'sid', value: 'abc' });
  });
  it('reads Max-Age as a relative expiry', () => {
    expect(parseSetCookie('a=1; Max-Age=60', 1000)).toEqual({ name: 'a', value: '1', expiresAt: 1000 + 60_000 });
  });
  it('Max-Age wins over Expires', () => {
    const r = parseSetCookie('a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Max-Age=10', 0);
    expect(r?.expiresAt).toBe(10_000);
  });
  it('returns undefined for a valueless line', () => {
    expect(parseSetCookie('; Path=/', 0)).toBeUndefined();
  });
});

describe('CookieJar', () => {
  it('ingests then emits a Cookie header', () => {
    const jar = new CookieJar();
    jar.ingestSetCookie(D, ['sid=abc; Path=/', 'theme=dark'], 0);
    expect(jar.cookieHeader(D, 0)).toBe('sid=abc; theme=dark');
  });

  it('drops a cookie once it expires', () => {
    const jar = new CookieJar();
    jar.ingestSetCookie(D, ['a=1; Max-Age=10'], 0); // expires at 10_000
    expect(jar.cookieHeader(D, 5_000)).toBe('a=1');
    expect(jar.cookieHeader(D, 20_000)).toBe(''); // past expiry → gone
  });

  it('a set-cookie in the past deletes the cookie', () => {
    const jar = new CookieJar();
    jar.ingestSetCookie(D, ['a=1'], 0);
    jar.ingestSetCookie(D, ['a=x; Max-Age=-1'], 1000); // delete
    expect(jar.cookieHeader(D, 1000)).toBe('');
  });

  it('keeps domains isolated', () => {
    const jar = new CookieJar();
    jar.ingestSetCookie('a.test', ['x=1'], 0);
    jar.ingestSetCookie('b.test', ['y=2'], 0);
    expect(jar.cookieHeader('a.test', 0)).toBe('x=1');
    expect(jar.cookieHeader('b.test', 0)).toBe('y=2');
  });

  it('persists on change and loads from the backing store', () => {
    const saved: Record<string, DomainJar> = {};
    const persist: CookiePersistence = {
      load: (d) => saved[d],
      save: (d, j) => { saved[d] = structuredClone(j); },
    };
    new CookieJar(persist).ingestSetCookie(D, ['sid=abc'], 0);
    expect(saved[D]).toEqual({ sid: { value: 'abc' } });
    // A fresh jar over the same store sees the persisted cookie.
    expect(new CookieJar(persist).cookieHeader(D, 0)).toBe('sid=abc');
  });
});

describe('engine ↔ cookie jar round-trip', () => {
  const domPlugin: IVendorPlugin = {
    vendor: 'V',
    domain: D,
    engine: 'dom-selector',
    rate_limit_ms: 0,
    search_mapping: { payload_locator: '', json_path_to_items: 'li.card', fields: { id: '@data-id' } },
    product_mapping: { payload_locator: '', json_path: '', fields: {} },
  };

  it('ingests Set-Cookie on the first poll and replays it on the next', async () => {
    const seen: (string | undefined)[] = [];
    const fetcher: Fetcher = async (_url, opts) => {
      seen.push(opts.cookie);
      return { status: 200, body: '<ul><li class="card" data-id="A"></li></ul>', setCookie: ['sid=abc; Max-Age=3600'] };
    };
    const jar = new CookieJar();
    const engine = new ScrapingEngine({ pool: new ProxyPool([], 1000), cooldownMs: 1000, fetcher, sleep: async () => {}, cookieJar: jar });

    await engine.scrapeSearch(domPlugin, 'https://v.test/s', 1000);
    await engine.scrapeSearch(domPlugin, 'https://v.test/s', 2000);

    expect(seen[0]).toBeUndefined();   // first poll: no jar yet
    expect(seen[1]).toBe('sid=abc');   // second poll: replays the session cookie
  });
});
