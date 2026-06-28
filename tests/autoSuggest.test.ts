import { describe, it, expect } from 'vitest';
import { slugify, deslugify, suggestQuery, searchUrlFor, suggestVendors, extractQuery } from '../src/features/autoSuggest';
import type { IVendorPlugin } from '../src/contracts';

const plugin = (vendor: string, template?: string, categories?: string[]): IVendorPlugin => ({
  vendor, domain: `${vendor.toLowerCase()}.ro`, engine: 'json-extractor', rate_limit_ms: 1000,
  // Mappings are irrelevant to auto-suggest; a minimal stub keeps the test focused.
  search_mapping: {} as IVendorPlugin['search_mapping'],
  product_mapping: {} as IVendorPlugin['product_mapping'],
  ...(template ? { search_url_template: template } : {}),
  ...(categories ? { categories } : {}),
});

/** A template-bearing vendor of a given category, for compatibility tests. */
const tpl = (vendor: string, cats: string[]) => plugin(vendor, `https://${vendor.toLowerCase()}.ro/q-{query}/`, cats);

describe('slugify + suggestQuery', () => {
  it('slugifies to a dash query', () => {
    expect(slugify('BMW 320d!')).toBe('bmw-320d');
    expect(slugify('  Multiple   Spaces ')).toBe('multiple-spaces');
  });

  it('derives a brand+model query from a noisy title, dropping stopwords + tail', () => {
    expect(suggestQuery('BMW 320d 2.0 Diesel 2018 Automat')).toBe('BMW 320d Diesel'); // pure numbers dropped
    expect(suggestQuery('Apartament de 3 camere Cluj')).toBe('Apartament camere Cluj'); // "de" + "3" dropped
    expect(suggestQuery('')).toBe('');
  });
});

describe('extractQuery (extend search)', () => {
  const olx = plugin('OLX', 'https://www.olx.ro/oferte/q-{query}/');
  olx.search_query_pattern = 'q-([^/?#]+)';

  it('reads the query back out of a SERP URL and round-trips through build', () => {
    expect(deslugify('bmw-320d')).toBe('bmw 320d');
    const q = extractQuery(olx, 'https://www.olx.ro/oferte/q-bmw-320d/');
    expect(q).toBe('bmw 320d');
    expect(searchUrlFor(olx, q!)).toBe('https://www.olx.ro/oferte/q-bmw-320d/'); // build∘extract = identity
  });

  it('returns undefined for a non-matching URL or a vendor without a pattern', () => {
    expect(extractQuery(olx, 'https://www.olx.ro/d/oferta/some-product-123')).toBeUndefined();
    expect(extractQuery(plugin('AutoVit', 'https://x/{query}'), 'https://x/q-bmw')).toBeUndefined();
  });
});

describe('searchUrlFor', () => {
  it('fills the {query} slug, or undefined without a template', () => {
    expect(searchUrlFor(plugin('OLX', 'https://www.olx.ro/oferte/q-{query}/'), 'BMW 320d'))
      .toBe('https://www.olx.ro/oferte/q-bmw-320d/');
    expect(searchUrlFor(plugin('AutoVit'), 'BMW 320d')).toBeUndefined();
  });
});

describe('suggestVendors', () => {
  it('offers only template-bearing, category-compatible vendors, excluding the source, sorted', () => {
    const plugins = [
      tpl('OLX', ['general']),
      tpl('Lajumate', ['general']),
      plugin('AutoVit', undefined, ['cars']), // no template → not offered
    ];
    const s = suggestVendors(plugins, 'BMW 320d', tpl('Carzz', ['cars'])); // source: cars
    expect(s.map((x) => x.vendor)).toEqual(['Lajumate', 'OLX']); // both general → accept any query
  });

  it('excludes the source vendor so it does not suggest the same platform', () => {
    const olx = tpl('OLX', ['general']);
    expect(suggestVendors([olx], 'BMW', olx)).toEqual([]);
  });
});

describe('suggestVendors — category compatibility', () => {
  const olx = tpl('OLX', ['general']);
  const publi24 = tpl('Publi24', ['general']);
  const autovit = tpl('AutoVit', ['cars']);
  const vinted = tpl('Vinted', ['fashion']);
  const all = [olx, publi24, autovit, vinted];

  it('a car search extends to car + general sites, never to a clothes-only site', () => {
    const s = suggestVendors(all, 'bmw 320d', autovit).map((x) => x.vendor);
    expect(s).toEqual(['OLX', 'Publi24']); // general accepts; Vinted (fashion) excluded; AutoVit is source
    expect(s).not.toContain('Vinted');
  });

  it('a clothes search extends to fashion + general sites, never to a cars-only site', () => {
    const s = suggestVendors(all, 'nike hoodie', vinted).map((x) => x.vendor);
    expect(s).toEqual(['OLX', 'Publi24']);
    expect(s).not.toContain('AutoVit');
  });

  it('a search FROM a general marketplace only extends to other general sites (category unknown)', () => {
    const s = suggestVendors(all, 'bmw 320d', olx).map((x) => x.vendor);
    expect(s).toEqual(['Publi24']); // not AutoVit/Vinted — OLX URL cannot reveal the category
  });
});

describe('olx manifest carries a search template', () => {
  it('the shipped OLX plugin can build AND extract a search', async () => {
    const { PluginRegistry } = await import('../src/registry');
    const reg = PluginRegistry.load('plugins');
    const olx = reg.all().find((p) => p.domain === 'olx.ro')!;
    expect(olx.search_url_template).toContain('{query}');
    expect(extractQuery(olx, searchUrlFor(olx, 'dacia logan')!)).toBe('dacia logan'); // round-trips
  });
});
