import { describe, it, expect } from 'vitest';
import { ScrapingEngine, type Fetcher } from '../src/scraping/engine';
import { ProxyPool } from '../src/scraping/proxyPool';
import type { IVendorPlugin } from '../src/contracts';

const body = (items: unknown[]): string =>
  `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ items })}</script>`;

function plugin(pagination?: { param: string }): IVendorPlugin {
  return {
    vendor: 'V',
    domain: 'v.test',
    engine: 'json-extractor',
    rate_limit_ms: 0,
    ...(pagination ? { pagination } : {}),
    search_mapping: { payload_locator: 'script#__NEXT_DATA__', json_path_to_items: 'items', fields: { id: 'id', title: 'title' } },
    product_mapping: { payload_locator: 'script#__NEXT_DATA__', json_path: 'product', fields: { id: 'id' } },
  };
}

// page 1 & 2 are full (2 items); page 3 is short (1) ⇒ last; page 4+ empty.
function pageItems(page: number): Array<{ id: string; title: string }> {
  if (page === 1) return [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
  if (page === 2) return [{ id: 'c', title: 'C' }, { id: 'd', title: 'D' }];
  if (page === 3) return [{ id: 'e', title: 'E' }];
  return [];
}

function engineWith(maxSearchPages: number, seen: number[]): ScrapingEngine {
  const fetcher: Fetcher = async (url) => {
    const pag = Number(new URL(url).searchParams.get('pag') ?? '1');
    seen.push(pag);
    return { status: 200, body: body(pageItems(pag)) };
  };
  return new ScrapingEngine({ pool: new ProxyPool([], 1000), cooldownMs: 1000, fetcher, sleep: async () => {}, maxSearchPages });
}

describe('multi-page search scraping', () => {
  it('walks pages until a short page, merging raw nodes (and sends the pag param)', async () => {
    const seen: number[] = [];
    const out = await engineWith(5, seen).scrapeSearch(plugin({ param: 'pag' }), 'https://v.test/s', 0);
    expect(out.ok).toBe(true);
    expect(seen).toEqual([1, 2, 3]); // stopped at the short page 3
    expect(out.rawNodes).toHaveLength(5); // A,B,C,D,E
  });

  it('respects the maxSearchPages cap', async () => {
    const seen: number[] = [];
    const out = await engineWith(2, seen).scrapeSearch(plugin({ param: 'pag' }), 'https://v.test/s', 0);
    expect(seen).toEqual([1, 2]);
    expect(out.rawNodes).toHaveLength(4);
  });

  it('stays single-page when the manifest has no pagination config', async () => {
    const seen: number[] = [];
    const out = await engineWith(5, seen).scrapeSearch(plugin(), 'https://v.test/s', 0);
    expect(seen).toEqual([1]);
    expect(out.rawNodes).toHaveLength(2);
  });

  it('stays single-page when maxSearchPages is 1 even with pagination', async () => {
    const seen: number[] = [];
    const out = await engineWith(1, seen).scrapeSearch(plugin({ param: 'pag' }), 'https://v.test/s', 0);
    expect(seen).toEqual([1]);
    expect(out.rawNodes).toHaveLength(2);
  });
});
