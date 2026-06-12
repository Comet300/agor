/**
 * Product-page (detail) mapping calibration. Drives each vendor's REAL product
 * manifest through the engine + normalizer against a fixture trimmed from a live
 * detail page (PII anonymized), so the product surface is proven the same way
 * the search surface is in platforms.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PluginRegistry } from '../src/registry/index';
import type { IScrapedItem } from '../src/contracts/index';
import { ProxyPool } from '../src/scraping/proxyPool';
import { ScrapingEngine } from '../src/scraping/engine';
import { normalizeItems } from '../src/pipeline/normalize';

const here = dirname(fileURLToPath(import.meta.url));
const registry = PluginRegistry.load(join(here, '..', 'plugins'));

async function scrapeProduct(domain: string, fixture: string): Promise<IScrapedItem[]> {
  const body = readFileSync(join(here, 'fixtures', fixture), 'utf8');
  const plugin = registry.getByDomain(domain)!;
  const engine = new ScrapingEngine({
    pool: new ProxyPool([], 1000),
    cooldownMs: 1000,
    fetcher: async () => ({ status: 200, body }),
    sleep: async () => {},
  });
  const outcome = await engine.scrapeProduct(plugin, `https://www.${domain}/d/x`, 0);
  expect(outcome.ok).toBe(true);
  return normalizeItems(outcome.rawNodes, plugin, 'product');
}

describe('product-page mappings (real manifests vs trimmed-real detail fixtures)', () => {
  it('carzz product: reads its own price/id/title from the detail block (not sidebar)', async () => {
    const items = await scrapeProduct('carzz.ro', 'carzz-product-dom.html');
    expect(items).toHaveLength(1);
    const a = items[0]!;
    expect(a.title.toLowerCase()).toContain('toyota corolla');
    expect(a.price).toBe(13300); // the product's OWN price "13.300 eur", not a sidebar 16.500
    expect(a.currency).toBe('EUR');
    expect(a.id).toBe('4010525'); // from #ad_id_show, stable numeric id
    expect(a.url).toMatch(/anunt_4010525\.html$/); // og:url canonical
  });

  it('mobile.de product: resolves the listing flight node (id/price/title/seller)', async () => {
    const items = await scrapeProduct('mobile.de', 'mobilede-product-flight.html');
    expect(items).toHaveLength(1);
    const a = items[0]!;
    expect(a.id).toBe('449939778');
    expect(a.title).toMatch(/Toyota Corolla.*Hybrid/);
    expect(a.price).toBe(41480); // price.grs.amount
    expect(a.currency).toBe('EUR'); // price.grs.currency (real field, not a literal)
    expect(a.url).toBe('https://suchen.mobile.de/fahrzeuge/details.html?id=449939778');
    expect(a.isPrivateOwner).toBe(false); // contact.type "Dealer" => professional
  });
});
