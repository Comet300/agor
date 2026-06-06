/**
 * Calibration test: the real AutoVit manifest against a fixture in the live
 * urql-cache shape (urqlState.<hash>.data = stringified advertSearch.edges).
 * Exercises the resolver's `*` wildcard + `~json` decode end-to-end.
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
const fixture = readFileSync(join(here, 'fixtures', 'autovit-next.html'), 'utf8');
const autovit: IVendorPlugin = PluginRegistry.load(join(here, '..', 'plugins')).getByDomain('autovit.ro')!;

function engine() {
  return new ScrapingEngine({
    pool: new ProxyPool([], 1000),
    cooldownMs: 1000,
    fetcher: async () => ({ status: 200, body: fixture }),
    sleep: async () => {},
  });
}

describe('AutoVit manifest calibration (urql cache)', () => {
  it('reaches edges via urqlState.*.data.~json and normalizes nodes', async () => {
    expect(autovit.search_mapping.json_path_to_items).toBe(
      'props.pageProps.urqlState.*.data.~json.advertSearch.edges',
    );

    const outcome = await engine().scrapeSearch(autovit, 'https://www.autovit.ro/x', 0);
    expect(outcome.ok).toBe(true);
    expect(outcome.rawNodes.length).toBe(2); // 2 edges

    const items = normalizeItems(outcome.rawNodes, autovit, 'search');
    expect(items).toHaveLength(2);

    const pro = items.find((i) => i.id === '7059958344')!;
    expect(pro).toMatchObject({
      title: 'Suzuki Swace Pro',
      price: 15500,
      currency: 'EUR',
      isPrivateOwner: false, // ProfessionalSeller
      location: 'Bucuresti',
      vendor: 'AutoVit',
    });
    expect(pro.url).toBe('https://www.autovit.ro/autoturisme/anunt/7059958344.html');

    const priv = items.find((i) => i.id === '7059958345')!;
    expect(priv.isPrivateOwner).toBe(true); // PrivateSeller
    expect(priv.price).toBe(14800);
  });
});
