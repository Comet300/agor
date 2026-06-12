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

  it('lajumate product: reads the detail ad from adData (not adServer)', async () => {
    const items = await scrapeProduct('lajumate.ro', 'lajumate-product-next.html');
    expect(items).toHaveLength(1);
    const a = items[0]!;
    expect(a.id).toBe('16868351');
    expect(a.price).toBeGreaterThan(0);
    expect(a.currency).toBe('RON'); // live "lei" canonicalized
    expect(a.url).toMatch(/^https:\/\/lajumate\.ro\/ad\/.+-16868351$/);
  });

  it('storia product: recovers currency from characteristics (target.Currency is null)', async () => {
    const items = await scrapeProduct('storia.ro', 'storia-product-next.html');
    expect(items).toHaveLength(1);
    const a = items[0]!;
    expect(a.price).toBe(85900); // target.Price
    expect(a.currency).toBe('EUR'); // characteristics[0].currency, NOT empty
    expect(a.url).toMatch(/^https:\/\/www\.storia\.ro\/ro\/oferta\//);
  });

  it('publi24 product: uses the absolute detail url verbatim (no double-prepend)', async () => {
    const items = await scrapeProduct('publi24.ro', 'publi24-product-ldjson.html');
    expect(items).toHaveLength(1);
    const a = items[0]!;
    expect(a.price).toBeGreaterThan(0);
    expect(a.currency).toBe('EUR');
    // The url must be a single clean host, not https://www.publi24.ro/https://...
    expect(a.url).toMatch(/^https:\/\/www\.publi24\.ro\/anunturi\//);
    expect(a.url).not.toMatch(/publi24\.ro\/https/);
  });

  it('vinted product: extracts from the ld+json Product (flight item is RSC-referenced)', async () => {
    const items = await scrapeProduct('vinted.ro', 'vinted-product-ldjson.html');
    expect(items).toHaveLength(1);
    const a = items[0]!;
    expect(a.title).toBeTruthy();
    expect(a.price).toBe(40);
    expect(a.currency).toBe('RON');
    expect(a.url).toBe('https://www.vinted.ro/items/9151836673-adidasi');
    expect(a.id).toBe('9151836673-adidasi'); // offers.url tail
    // Fashion specs from dedicated ld+json fields.
    expect(a.attributes).toMatchObject({ brand: 'Decathlon' });
  });

  it('imobiliare product: spans the split @graph (Product name/id + Offer price/url)', async () => {
    const items = await scrapeProduct('imobiliare.ro', 'imobiliare-product-ldjson.html');
    expect(items).toHaveLength(1);
    const a = items[0]!;
    expect(a.id).toBe('275647684'); // Product @id tail
    expect(a.title.toLowerCase()).toContain('apartament');
    expect(a.price).toBe(185000); // Offer.priceSpecification.price
    expect(a.currency).toBe('EUR');
    expect(a.url).toContain('/oferta/'); // the Offer's real listing url
    // Specs from the Accommodation node via ~type selector.
    expect(a.attributes).toMatchObject({ rooms: '2', baths: '2' });
    expect(a.attributes!.area).toBeTruthy();
  });

  it('imoradar24 product: same split-@graph handling as imobiliare', async () => {
    const items = await scrapeProduct('imoradar24.ro', 'imoradar24-product-ldjson.html');
    expect(items).toHaveLength(1);
    const a = items[0]!;
    expect(a.id).toBe('1749046');
    expect(a.price).toBe(185000);
    expect(a.currency).toBe('EUR');
    expect(a.url).toContain('/oferta/');
  });

  it('autovit product: resolves the advert node (flat price + seller type)', async () => {
    const items = await scrapeProduct('autovit.ro', 'autovit-product-next.html');
    expect(items).toHaveLength(1);
    const a = items[0]!;
    expect(a.title.toLowerCase()).toContain('passat');
    expect(a.price).toBe(10450); // price.value
    expect(a.currency).toBe('EUR');
    expect(a.url).toMatch(/^https:\/\/www\.autovit\.ro\/autoturisme\/anunt\//);
    expect(a.isPrivateOwner).toBe(false); // seller.type "PROFESSIONAL"
  });

  it('homezz product: reads its OWN price from .main-price (not the sidebar)', async () => {
    const items = await scrapeProduct('homezz.ro', 'homezz-product-dom.html');
    expect(items).toHaveLength(1);
    const a = items[0]!;
    expect(a.title.toLowerCase()).toContain('teren');
    expect(a.price).toBe(183370); // .main-price "183.370 €", NOT the 165.000 sidebar
    expect(a.currency).toBe('EUR');
    expect(a.url).toMatch(/homezz\.ro\/.+\.html$/); // og:url canonical
    expect(a.id).toBeTruthy();
  });
});
