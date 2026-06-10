import { describe, it, expect } from 'vitest';
import { PluginRegistry } from '../src/registry';
import { parsePlugin, VendorPluginSchema } from '../src/registry/validate';
import type { IVendorPlugin } from '../src/contracts';

/** A minimal, fully-valid manifest object for negative-test mutation. */
function validManifest(): Record<string, unknown> {
  return {
    vendor: 'OLX',
    domain: 'olx.ro',
    engine: 'json-extractor',
    rate_limit_ms: 2500,
    search_mapping: {
      payload_locator: 'script#__NEXT_DATA__',
      json_path_to_items: 'props.pageProps.data.listing.items',
      fields: { id: 'id', title: 'title' },
    },
    product_mapping: {
      payload_locator: 'script#__NEXT_DATA__',
      json_path: 'props.pageProps.ad',
      fields: { id: 'id', title: 'title' },
    },
  };
}

describe('PluginRegistry.load', () => {
  const registry = PluginRegistry.load('plugins');

  it('loads every authored manifest', () => {
    const vendors = registry.all().map((p) => p.vendor).sort();
    expect(registry.all()).toHaveLength(11);
    expect(vendors).toEqual([
      'AutoVit', 'Carzz', 'Homezz', 'Imobiliare', 'Imoradar24', 'Lajumate',
      'MobileDe', 'OLX', 'Publi24', 'Storia', 'Vinted',
    ]);
  });

  it('parses concrete fields off a manifest', () => {
    const olx = registry.getByDomain('olx.ro');
    expect(olx).toBeDefined();
    expect(olx?.engine).toBe('json-extractor');
    expect(olx?.rate_limit_ms).toBe(2500);
    expect(olx?.search_mapping.payload_locator).toBe('window.__PRERENDERED_STATE__');
    // The "!" NOT-prefix convention survives load untouched.
    expect(olx?.search_mapping.fields.isPrivateOwner).toBe('!isBusiness');
  });

  it('matchUrl resolves a www subdomain to OLX', () => {
    const hit = registry.matchUrl('https://www.olx.ro/auto/q-golf/?search[filter]=1');
    expect(hit?.vendor).toBe('OLX');
  });

  it('matchUrl resolves an apex domain to its plugin', () => {
    const hit = registry.matchUrl('https://autovit.ro/anunt/vw-golf');
    expect(hit?.vendor).toBe('AutoVit');
  });

  it('matchUrl returns undefined for an unknown domain', () => {
    expect(registry.matchUrl('https://www.ebay.com/itm/123')).toBeUndefined();
  });

  it('matchUrl returns undefined for an unparseable URL', () => {
    expect(registry.matchUrl('not a url')).toBeUndefined();
  });

  it('getByDomain is case-insensitive and www-agnostic', () => {
    expect(registry.getByDomain('STORIA.RO')?.vendor).toBe('Storia');
    expect(registry.getByDomain('unknown.ro')).toBeUndefined();
  });
});

describe('parsePlugin validation', () => {
  it('accepts a well-formed manifest', () => {
    const plugin: IVendorPlugin = parsePlugin(validManifest(), 'ok.yaml');
    expect(plugin.vendor).toBe('OLX');
    expect(plugin.domain).toBe('olx.ro');
  });

  it('rejects a manifest missing required fields, naming the source', () => {
    const bad = validManifest();
    delete bad.search_mapping;
    expect(() => parsePlugin(bad, 'broken.yaml')).toThrowError(/broken\.yaml/);
  });

  it('rejects an unknown engine', () => {
    const bad = { ...validManifest(), engine: 'magic' };
    expect(() => parsePlugin(bad, 'bad-engine.yaml')).toThrowError(/engine/);
  });

  it('rejects a non-positive rate_limit_ms', () => {
    const bad = { ...validManifest(), rate_limit_ms: 0 };
    expect(() => parsePlugin(bad)).toThrow();
  });

  it('rejects a completely empty object', () => {
    expect(() => parsePlugin({})).toThrow();
  });

  it('exposes the underlying zod schema', () => {
    expect(VendorPluginSchema.safeParse(validManifest()).success).toBe(true);
    expect(VendorPluginSchema.safeParse({}).success).toBe(false);
  });
});
