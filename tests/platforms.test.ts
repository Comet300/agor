/**
 * Platform-expansion calibration: each of the 8 new vendors' REAL manifests is
 * driven end-to-end (engine extract → pipeline normalize) against a fixture
 * trimmed from the live page captured during recon. Table-driven so every
 * platform asserts the same contract: item count plus spot-checked fields.
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

async function scrapeFixture(domain: string, fixture: string): Promise<IScrapedItem[]> {
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

interface Case {
  domain: string;
  fixture: string;
  min: number;
  spot: (items: IScrapedItem[]) => void;
}

const CASES: Case[] = [
  {
    domain: 'lajumate.ro',
    fixture: 'lajumate-next.html',
    min: 2,
    spot: (items) => {
      const a = items[0]!;
      expect(a.url).toMatch(/^https:\/\/lajumate\.ro\/ad\/.+-\d+$/); // template slug-id
      expect(a.price).toBeGreaterThan(0);
      expect(a.isPrivateOwner).toBe(true); // !user.is_company (absent)
      expect(a.location).toBeTruthy();
      expect(a.imageUrl).toMatch(/^https:\/\/lajumate\.ro\/media/);
    },
  },
  {
    domain: 'publi24.ro',
    fixture: 'publi24-ldjson.html',
    min: 1,
    spot: (items) => {
      const a = items[0]!;
      // The fixture's ld+json contains LITERAL control chars — sanitize worked.
      expect(a.url).toMatch(/^https:\/\/www\.publi24\.ro\/anunturi\//);
      expect(a.price).toBeGreaterThan(0);
      expect(a.currency).toBe('EUR');
      expect(a.isPrivateOwner).toBe(true);
      // image is an ImageObject[] → imageUrl reads [0].contentUrl, never "[object Object]".
      expect(a.imageUrl).toMatch(/^https:\/\/.*\.(webp|jpg|jpeg|png)/);
      expect(a.imageUrl).not.toContain('[object');
    },
  },
  {
    domain: 'imobiliare.ro',
    fixture: 'imobiliare-ldjson.html',
    min: 2,
    spot: (items) => {
      const a = items[0]!;
      expect(a.id).toMatch(/^\d+$/); // ~tail:- extracted the numeric id
      expect(a.url).toBe(`https://www.imobiliare.ro/oferta/a-${a.id}`); // rebuilt
      expect(a.currency).toBe('EUR');
      expect(a.imageUrl).toContain('roamcdn');
    },
  },
  {
    domain: 'imoradar24.ro',
    fixture: 'imoradar24-ldjson.html',
    min: 2,
    spot: (items) => {
      const a = items[0]!;
      expect(a.id).toMatch(/^\d+$/);
      expect(a.url).toBe(`https://www.imoradar24.ro/oferta/a-${a.id}`);
      expect(a.price).toBeGreaterThan(0);
    },
  },
  {
    domain: 'mobile.de',
    fixture: 'mobilede-flight.html',
    min: 2,
    spot: (items) => {
      const dealer = items.find((i) => !i.isPrivateOwner)!;
      const priv = items.find((i) => i.isPrivateOwner)!;
      expect(dealer).toBeTruthy(); // st: "Dealer"
      expect(priv).toBeTruthy(); // st: "Vânzător privat" (RO localization)
      expect(items[0]!.title).toMatch(/Suzuki Swace/); // {shortTitle} {subTitle}
      expect(items[0]!.price).toBeGreaterThan(1000); // "16.899 EUR" parsed
      expect(items[0]!.currency).toBe('EUR'); // =EUR literal
      expect(items[0]!.url).toMatch(/^https:\/\/suchen\.mobile\.de\/fahrzeuge\/details\.html\?id=\d+$/);
      expect(items[0]!.imageUrl).toMatch(/^https:\/\//);
    },
  },
  {
    domain: 'vinted.ro',
    fixture: 'vinted-flight.html',
    min: 2,
    spot: (items) => {
      const a = items[0]!;
      expect(a.url).toMatch(/^https:\/\/www\.vinted\.ro\/items\//);
      expect(a.price).toBeGreaterThan(0);
      expect(a.currency).toBe('RON');
      expect(a.isPrivateOwner).toBe(true); // !user.business
      expect(a.imageUrl).toMatch(/^https:\/\//);
    },
  },
  {
    domain: 'carzz.ro',
    fixture: 'carzz-dom.html',
    min: 2,
    spot: (items) => {
      const a = items[0]!;
      expect(a.url).toMatch(/-anunt_\d+\.html$/); // anchor IS the container
      expect(a.title.toLowerCase()).toContain('toyota');
      expect(a.price).toBeGreaterThan(1000); // "16.990 eur"
      expect(a.currency).toBe('EUR'); // =EUR literal
      expect(a.isPrivateOwner).toBe(true); // =privat literal
    },
  },
  {
    domain: 'homezz.ro',
    fixture: 'homezz-dom.html',
    min: 2,
    spot: (items) => {
      const a = items[0]!;
      expect(a.url).toMatch(/homezz\.ro\/.+\d+\.html$/);
      expect(a.title.toLowerCase()).toContain('apartament');
      expect(a.price).toBeGreaterThan(10_000); // "124,000 €"
      expect(a.location).toContain('Bucuresti');
      expect(a.imageUrl).toMatch(/^https:\/\/homezz\.ro\/media/);
    },
  },
];

describe('platform expansion: 8 new vendors, real manifests vs trimmed-real fixtures', () => {
  for (const c of CASES) {
    it(`${c.domain} extracts and normalizes`, async () => {
      const items = await scrapeFixture(c.domain, c.fixture);
      expect(items.length).toBeGreaterThanOrEqual(c.min);
      c.spot(items);
    });
  }

  it('registry now resolves all 11 vendor domains', () => {
    for (const d of [
      'olx.ro', 'autovit.ro', 'storia.ro', 'lajumate.ro', 'publi24.ro',
      'imobiliare.ro', 'imoradar24.ro', 'mobile.de', 'vinted.ro', 'carzz.ro', 'homezz.ro',
    ]) {
      expect(registry.getByDomain(d), d).toBeDefined();
    }
  });
});
