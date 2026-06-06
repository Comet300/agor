/**
 * Calibration test: the REAL, recalibrated OLX manifest against a fixture in the
 * live `window.__PRERENDERED_STATE__` (double-encoded JSON) shape. Proves the
 * shipped paths extract + normalize correctly for both search and product.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PluginRegistry } from '../src/registry/index';
import type { IVendorPlugin } from '../src/contracts/index';
import { ProxyPool } from '../src/scraping/proxyPool';
import { ScrapingEngine, type Fetcher } from '../src/scraping/engine';
import { normalizeItems } from '../src/pipeline/normalize';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures', 'olx-prerendered.html'), 'utf8');

/** The real shipped OLX manifest. */
const olx: IVendorPlugin = PluginRegistry.load(join(here, '..', 'plugins')).getByDomain('olx.ro')!;

function engineReturning(body: string): ScrapingEngine {
  const fetcher: Fetcher = async () => ({ status: 200, body });
  return new ScrapingEngine({ pool: new ProxyPool([], 1000), cooldownMs: 1000, fetcher, sleep: async () => {} });
}

describe('OLX manifest calibration (window.__PRERENDERED_STATE__)', () => {
  it('uses the __PRERENDERED_STATE__ locator and live paths', () => {
    expect(olx.search_mapping.payload_locator).toBe('window.__PRERENDERED_STATE__');
    expect(olx.search_mapping.json_path_to_items).toBe('listing.listing.ads');
    expect(olx.product_mapping.json_path).toBe('ad.ad');
  });

  it('scrapes + normalizes the search SERP into IScrapedItems', async () => {
    const outcome = await engineReturning(fixture).scrapeSearch(olx, 'https://www.olx.ro/x', 0);
    expect(outcome.ok).toBe(true);
    expect(outcome.rawNodes.length).toBe(3); // 3 ads in the fixture

    const items = normalizeItems(outcome.rawNodes, olx, 'search');
    // The exchange ad (price.regularPrice = null) is dropped → 2 priced items.
    expect(items).toHaveLength(2);

    const priv = items.find((i) => i.id === '304434269')!;
    expect(priv).toMatchObject({
      title: 'Suzuki Swace 1.8 Hybrid 2021',
      price: 13800,
      currency: 'EUR',
      isPrivateOwner: true, // !isBusiness (false)
      location: 'Alexandria',
      vendor: 'OLX',
    });
    expect(priv.imageUrl).toContain('apollo.olxcdn.com'); // photos[0]
    expect(priv.url).toContain('/d/oferta/304434269');

    const biz = items.find((i) => i.id === '300089346')!;
    expect(biz.isPrivateOwner).toBe(false); // a dealer (isBusiness true)
    expect(biz.price).toBe(16999);
  });

  it('scrapes + normalizes a single product via ad.ad', async () => {
    const outcome = await engineReturning(fixture).scrapeProduct(olx, 'https://www.olx.ro/d/x', 0);
    expect(outcome.ok).toBe(true);
    const items = normalizeItems(outcome.rawNodes, olx, 'product');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: '300089346', price: 16999, currency: 'EUR', inStock: true });
  });

  it('soft-fails (ok:false, no throw) when the state is absent (layout change)', async () => {
    const outcome = await engineReturning('<html><body>no state here</body></html>').scrapeSearch(
      olx,
      'https://www.olx.ro/x',
      0,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.rawNodes).toEqual([]);
  });
});
