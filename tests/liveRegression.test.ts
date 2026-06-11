/**
 * Live-shape regression: drive the REAL manifests + engine + normalizer against
 * fixtures trimmed from genuine live captures (2026-06-11), pinning the data-
 * quality fixes so a future manifest/shape drift trips a test rather than
 * silently degrading. Distinct from platforms.test.ts (synthetic-ish fixtures):
 * these payloads are real vendor shapes (PII anonymized).
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

async function scrape(domain: string, fixture: string): Promise<IScrapedItem[]> {
  const body = readFileSync(join(here, 'fixtures', fixture), 'utf8');
  const plugin = registry.getByDomain(domain)!;
  const engine = new ScrapingEngine({
    pool: new ProxyPool([], 1000),
    cooldownMs: 1000,
    fetcher: async () => ({ status: 200, body }),
    sleep: async () => {},
  });
  const outcome = await engine.scrapeSearch(plugin, `https://www.${domain}/x`, 0);
  expect(outcome.ok).toBe(true);
  return normalizeItems(outcome.rawNodes, plugin, 'search');
}

describe('live-shape regression (real vendor payloads, PII anonymized)', () => {
  it('publi24: real image is ImageObject[] → imageUrl is a real URL, plus recovered location', async () => {
    const items = await scrape('publi24.ro', 'publi24-live-ldjson.html');
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const it of items) {
      // The headline bug: image stringified to "[object Object]" — must be a URL now.
      expect(it.imageUrl).toMatch(/^https:\/\/.*\.(webp|jpg|jpeg|png)/i);
      expect(it.imageUrl).not.toContain('[object');
      // Location recovered from offers.availableAtOrFrom.address.addressLocality.
      expect(it.location).toBeTruthy();
      expect(it.currency).toBe('EUR');
    }
  });

  it('publi24: HTML entities in real titles are decoded (no raw &#238;)', async () => {
    const items = await scrape('publi24.ro', 'publi24-live-ldjson.html');
    for (const it of items) {
      expect(it.title).not.toMatch(/&#\d+;|&#x[0-9a-f]+;|&amp;/i);
    }
  });

  it('lajumate: lowercase live "eur" is canonicalized to EUR', async () => {
    const items = await scrape('lajumate.ro', 'lajumate-live-next.html');
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const it of items) {
      expect(it.currency).toBe('EUR'); // live ships lowercase "eur"
    }
  });

  it('lajumate: a slug-less ad is dropped (no broken /ad/-<id> deep link)', async () => {
    const items = await scrape('lajumate.ro', 'lajumate-live-next.html');
    // The fixture includes one slug-less ad; every surviving URL must be well-formed.
    for (const it of items) {
      expect(it.url).toMatch(/^https:\/\/lajumate\.ro\/ad\/.+-\d+$/);
      expect(it.url).not.toMatch(/\/ad\/-\d+$/); // no empty-slug artifact
    }
  });
});
