/**
 * Calibration test: the real Storia manifest against a fixture in the live
 * searchAds.items shape. Exercises the normalizer's template-field URL build
 * and the direct isPrivateOwner boolean.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PluginRegistry } from '../src/registry/index';
import type { IVendorPlugin } from '../src/contracts/index';
import { ProxyPool } from '../src/scraping/proxyPool';
import { ScrapingEngine } from '../src/scraping/engine';
import { normalizeItems } from '../src/pipeline/normalize';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures', 'storia-next.html'), 'utf8');
const storia: IVendorPlugin = PluginRegistry.load(join(here, '..', 'plugins')).getByDomain('storia.ro')!;

describe('Storia manifest calibration (templated URL + direct isPrivateOwner)', () => {
  it('builds the offer URL from {slug} and reads the privacy boolean', async () => {
    const engine = new ScrapingEngine({
      pool: new ProxyPool([], 1000),
      cooldownMs: 1000,
      fetcher: async () => ({ status: 200, body: fixture }),
      sleep: async () => {},
    });

    const outcome = await engine.scrapeSearch(storia, 'https://www.storia.ro/x', 0);
    expect(outcome.ok).toBe(true);
    const items = normalizeItems(outcome.rawNodes, storia, 'search');
    expect(items).toHaveLength(2);

    const priv = items.find((i) => i.id === '10369352')!;
    expect(priv).toMatchObject({
      title: 'Apartament 2 camere privat',
      price: 71998,
      currency: 'EUR',
      isPrivateOwner: true, // direct boolean
      location: 'Berceni',
      vendor: 'Storia',
    });
    // URL built from the {slug} template, not the useless [lang]/ad href.
    expect(priv.url).toBe('https://www.storia.ro/ro/oferta/2-camere-priv-IDaaa');

    const agency = items.find((i) => i.id === '10366776')!;
    expect(agency.isPrivateOwner).toBe(false);
    expect(agency.url).toBe('https://www.storia.ro/ro/oferta/3-camere-ag-IDbbb');
  });
});
