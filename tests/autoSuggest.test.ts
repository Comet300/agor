import { describe, it, expect } from 'vitest';
import { slugify, deslugify, suggestQuery, searchUrlFor, suggestVendors, extractQuery } from '../src/features/autoSuggest';
import type { IVendorPlugin } from '../src/contracts';

const plugin = (vendor: string, template?: string): IVendorPlugin => ({
  vendor, domain: `${vendor.toLowerCase()}.ro`, engine: 'json-extractor', rate_limit_ms: 1000,
  // Mappings are irrelevant to auto-suggest; a minimal stub keeps the test focused.
  search_mapping: {} as IVendorPlugin['search_mapping'],
  product_mapping: {} as IVendorPlugin['product_mapping'],
  ...(template ? { search_url_template: template } : {}),
});

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
  it('offers only template-bearing vendors, excluding the current one, sorted', () => {
    const plugins = [
      plugin('OLX', 'https://www.olx.ro/oferte/q-{query}/'),
      plugin('Lajumate', 'https://lajumate.ro/q-{query}'),
      plugin('AutoVit'), // no template → not offered
    ];
    const s = suggestVendors(plugins, 'BMW 320d', 'AutoVit');
    expect(s.map((x) => x.vendor)).toEqual(['Lajumate', 'OLX']); // sorted, AutoVit excluded (no template anyway)
    expect(s[1]!.url).toBe('https://www.olx.ro/oferte/q-bmw-320d/');
  });

  it('excludes the source vendor so it does not suggest the same platform', () => {
    const plugins = [plugin('OLX', 'https://www.olx.ro/oferte/q-{query}/')];
    expect(suggestVendors(plugins, 'BMW', 'OLX')).toEqual([]);
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
