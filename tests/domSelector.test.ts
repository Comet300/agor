import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import {
  parseFieldSelector,
  domExtractSearch,
  domExtractProduct,
} from '../src/scraping/domExtract';
import { ScrapingEngine, type Fetcher } from '../src/scraping/engine';
import { ProxyPool } from '../src/scraping/proxyPool';
import { normalizeItems } from '../src/pipeline/normalize';
import { parsePlugin } from '../src/registry/validate';
import type { IVendorPlugin } from '../src/contracts';

// A dom-selector plugin: mapping fields are CSS selectors (with @attr and !).
const DOM_PLUGIN: IVendorPlugin = {
  vendor: 'domvendor',
  domain: 'domvendor.test',
  engine: 'dom-selector',
  rate_limit_ms: 0,
  search_mapping: {
    payload_locator: '',
    json_path_to_items: 'li.card',
    fields: {
      id: '@data-id',
      title: 'h2.title',
      price: 'span.price',
      currency: 'span.cur',
      url: 'a.link@href',
      imageUrl: 'img@src',
      isPrivateOwner: '!.badge-company',
      location: 'span.loc',
      inStock: '!.sold-out',
    },
  },
  product_mapping: {
    payload_locator: '',
    json_path: 'div.product',
    fields: {
      id: '@data-id',
      title: 'h2.title',
      price: 'span.price',
      currency: 'span.cur',
      url: 'a.link@href',
      isPrivateOwner: '!.badge-company',
      location: 'span.loc',
      inStock: '!.sold-out',
    },
  },
};

const SEARCH_HTML = `<!doctype html><html><body><ul>
  <li class="card" data-id="A1">
    <h2 class="title">VW Golf 5</h2>
    <span class="price">4 300</span>
    <span class="cur">RON</span>
    <a class="link" href="https://domvendor.test/A1">view</a>
    <img src="https://img/A1.jpg">
    <span class="loc">Cluj</span>
  </li>
  <li class="card" data-id="B2">
    <h2 class="title">Dealer BMW</h2>
    <span class="price">6.000</span>
    <span class="cur">RON</span>
    <a class="link" href="https://domvendor.test/B2">view</a>
    <span class="badge-company">Dealer</span>
    <span class="sold-out">Sold</span>
    <span class="loc">Iasi</span>
  </li>
</ul></body></html>`;

const PRODUCT_HTML = `<!doctype html><html><body>
  <div class="product" data-id="P1">
    <h2 class="title">iPhone 13</h2>
    <span class="price">2.000</span>
    <span class="cur">RON</span>
    <a class="link" href="https://domvendor.test/P1">x</a>
    <span class="loc">Cluj</span>
  </div>
</body></html>`;

describe('dom-selector manifest', () => {
  it('a real YAML manifest validates as a dom-selector plugin', () => {
    const raw = load(readFileSync('tests/fixtures/dom-vendor.yaml', 'utf8'));
    const plugin = parsePlugin(raw, 'dom-vendor.yaml');
    expect(plugin.engine).toBe('dom-selector');
    expect(plugin.domain).toBe('domvendor.example');
    expect(plugin.search_mapping.json_path_to_items).toBe('li.listing-card');
    expect(plugin.search_mapping.fields.url).toBe('h2.title a@href');
  });
});

describe('parseFieldSelector', () => {
  it('splits @attr, ! negation, and plain/empty selectors', () => {
    expect(parseFieldSelector('a.link@href')).toEqual({ selector: 'a.link', attr: 'href', negate: false });
    expect(parseFieldSelector('!.sold-out')).toEqual({ selector: '.sold-out', attr: undefined, negate: true });
    expect(parseFieldSelector('@data-id')).toEqual({ selector: '', attr: 'data-id', negate: false });
    expect(parseFieldSelector('h2.title')).toEqual({ selector: 'h2.title', attr: undefined, negate: false });
    expect(parseFieldSelector('!img@src')).toEqual({ selector: 'img', attr: 'src', negate: true });
  });
});

describe('domExtractSearch', () => {
  it('emits a field-name-keyed record per item with @attr and ! resolved', () => {
    const records = domExtractSearch(SEARCH_HTML, DOM_PLUGIN);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      id: 'A1',
      title: 'VW Golf 5',
      price: '4 300',
      currency: 'RON',
      url: 'https://domvendor.test/A1',
      imageUrl: 'https://img/A1.jpg',
      isPrivateOwner: true, // no company badge -> !false
      inStock: true, // no sold-out -> !false
      location: 'Cluj',
    });
    expect(records[1]).toMatchObject({
      id: 'B2',
      isPrivateOwner: false, // company badge present -> !true
      inStock: false, // sold-out present -> !true
    });
    expect(records[1]!.imageUrl).toBeUndefined(); // no <img> -> omitted
  });
});

describe('dom-selector engine end-to-end (engine -> pipeline)', () => {
  function engineFor(html: string) {
    const fetcher: Fetcher = async () => ({ status: 200, body: html });
    return new ScrapingEngine({
      pool: new ProxyPool([], 1000),
      cooldownMs: 1000,
      fetcher,
      sleep: async () => {},
    });
  }

  it('scrapes + normalizes a search page into IScrapedItems', async () => {
    const engine = engineFor(SEARCH_HTML);
    const outcome = await engine.scrapeSearch(DOM_PLUGIN, 'https://domvendor.test/s', 1000);
    expect(outcome.ok).toBe(true);

    const items = normalizeItems(outcome.rawNodes, DOM_PLUGIN, 'search');
    expect(items).toHaveLength(2);

    const a = items.find((i) => i.id === 'A1')!;
    expect(a).toMatchObject({
      title: 'VW Golf 5',
      price: 4300, // "4 300" parsed
      currency: 'RON',
      url: 'https://domvendor.test/A1',
      imageUrl: 'https://img/A1.jpg',
      isPrivateOwner: true,
      inStock: true,
      location: 'Cluj',
      vendor: 'domvendor',
    });

    const b = items.find((i) => i.id === 'B2')!;
    expect(b.price).toBe(6000); // "6.000" -> thousands group
    expect(b.isPrivateOwner).toBe(false);
    expect(b.inStock).toBe(false);
  });

  it('scrapes + normalizes a single product page', async () => {
    const engine = engineFor(PRODUCT_HTML);
    const outcome = await engine.scrapeProduct(DOM_PLUGIN, 'https://domvendor.test/p', 1000);
    expect(outcome.ok).toBe(true);

    const items = normalizeItems(outcome.rawNodes, DOM_PLUGIN, 'product');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'P1',
      title: 'iPhone 13',
      price: 2000,
      inStock: true, // no sold-out badge
      isPrivateOwner: true, // no company badge
      vendor: 'domvendor',
    });
  });

  it('skips an item missing a required field (no title)', () => {
    const html = `<ul><li class="card" data-id="X"><span class="price">10</span>
      <a class="link" href="https://domvendor.test/X">x</a></li></ul>`;
    const items = normalizeItems(domExtractSearch(html, DOM_PLUGIN), DOM_PLUGIN, 'search');
    expect(items).toHaveLength(0);
  });
});
