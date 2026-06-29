import { describe, it, expect } from 'vitest';
import { parse } from 'node-html-parser';
import {
  fingerprintElement,
  fingerprintElements,
  relocate,
  type ElementFingerprint,
  type SelectorRole,
  type SelfHealer,
} from '../src/scraping/selfHeal';
import { domExtractSearch, domExtractProduct } from '../src/scraping/domExtract';
import type { IVendorPlugin } from '../src/contracts';

/** In-memory healer for tests. */
class MemHealer implements SelfHealer {
  readonly map = new Map<string, ElementFingerprint>();
  load(vendor: string, role: SelectorRole): ElementFingerprint | undefined {
    return this.map.get(`${vendor}:${role}`);
  }
  save(vendor: string, role: SelectorRole, fp: ElementFingerprint): void {
    this.map.set(`${vendor}:${role}`, fp);
  }
}

const PLUGIN: IVendorPlugin = {
  vendor: 'demo',
  domain: 'demo.test',
  engine: 'dom-selector',
  rate_limit_ms: 0,
  search_mapping: {
    payload_locator: '',
    json_path_to_items: 'li.card',
    fields: { id: '@data-id', title: 'h2.title', url: 'a.link@href' },
  },
  product_mapping: {
    payload_locator: '',
    json_path: 'div.product',
    fields: { id: '@data-id', title: 'h2.title' },
  },
};

const card = (id: string, cls = 'card') => `
  <li class="${cls}" data-id="${id}">
    <h2 class="title">Item ${id}</h2>
    <a class="link" href="https://demo.test/${id}">view</a>
  </li>`;

const page = (cls: string) => `<!doctype html><html><body><ul>${card('A', cls)}${card('B', cls)}</ul></body></html>`;

describe('selfHeal — fingerprint', () => {
  it('captures tag, classes, attrs, parent and child tags', () => {
    const root = parse(page('card'));
    const li = root.querySelector('li.card')!;
    const fp = fingerprintElement(li);
    expect(fp.tag).toBe('li');
    expect(fp.classes).toEqual(['card']);
    expect(fp.attrs).toEqual(['data-id']); // class excluded
    expect(fp.parentTag).toBe('ul');
    expect(fp.childTags).toEqual(['a', 'h2']); // sorted element children
  });

  it('fingerprintElements keeps only the class tokens common to all matches', () => {
    const root = parse(
      `<ul><li class="card hot" data-id="A"><h2 class="title">a</h2></li>` +
        `<li class="card" data-id="B"><h2 class="title">b</h2></li></ul>`,
    );
    const fp = fingerprintElements(root.querySelectorAll('li'));
    expect(fp.classes).toEqual(['card']); // 'hot' dropped (not on every card)
  });
});

describe('selfHeal — relocate', () => {
  it('relocates a repeated group whose class was renamed', () => {
    const fp = fingerprintElements(parse(page('card')).querySelectorAll('li.card'));
    // Same structure, container class renamed card -> listing: 'li.card' now misses.
    const changed = parse(page('listing'));
    expect(changed.querySelectorAll('li.card')).toHaveLength(0);

    const found = relocate(changed, fp);
    expect(found).toBeDefined();
    expect(found!.selector).toBe('li.listing');
    expect(found!.elements).toHaveLength(2);
    expect(found!.score).toBeGreaterThan(0.4);
  });

  it('returns undefined when nothing on the page is similar enough', () => {
    const fp = fingerprintElements(parse(page('card')).querySelectorAll('li.card'));
    const unrelated = parse('<main><p class="x">hello</p><p class="x">world</p></main>');
    expect(relocate(unrelated, fp)).toBeUndefined();
  });

  it('respects minGroup: a single product root relocates with minGroup 1', () => {
    const good = parse('<body><div class="product" data-id="P"><h2 class="title">t</h2></div></body>');
    const fp = fingerprintElements([good.querySelector('div.product')!]);
    const changed = parse('<body><div class="listing" data-id="P"><h2 class="title">t</h2></div></body>');
    expect(relocate(changed, fp, { minGroup: 1 })).toBeDefined();
    expect(relocate(changed, fp, { minGroup: 2 })).toBeUndefined(); // only one match
  });
});

describe('selfHeal — domExtractSearch integration', () => {
  it('stores a fingerprint on a good scrape and relocates on a broken one', () => {
    const healer = new MemHealer();

    // 1) Good scrape: selector matches → records extracted, fingerprint saved.
    const ok = domExtractSearch(page('card'), PLUGIN, healer);
    expect(ok.records).toHaveLength(2);
    expect(ok.healed).toBeUndefined();
    expect(healer.load('demo', 'search')).toBeDefined();

    // 2) Vendor renamed the class: 'li.card' misses, but the fingerprint relocates.
    const healed = domExtractSearch(page('listing'), PLUGIN, healer);
    expect(healed.records).toHaveLength(2);
    expect(healed.records[0]).toMatchObject({ id: 'A', title: 'Item A' });
    expect(healed.healed).toMatchObject({
      role: 'search',
      fromSelector: 'li.card',
      toSelector: 'li.listing',
      count: 2,
    });
  });

  it('does not relocate without a stored fingerprint (cold start, broken selector)', () => {
    const healer = new MemHealer();
    const res = domExtractSearch(page('listing'), PLUGIN, healer);
    expect(res.records).toHaveLength(0);
    expect(res.healed).toBeUndefined();
  });

  it('is a no-op passthrough when no healer is supplied', () => {
    const res = domExtractSearch(page('card'), PLUGIN);
    expect(res.records).toHaveLength(2);
    expect(res.healed).toBeUndefined();
  });

  it('heals the product root selector too', () => {
    const healer = new MemHealer();
    const good = '<body><div class="product" data-id="P1"><h2 class="title">iPhone</h2></div></body>';
    domExtractProduct(good, PLUGIN, healer); // store fingerprint
    const changed = '<body><section class="product-root" data-id="P1"><h2 class="title">iPhone</h2></section></body>';
    const res = domExtractProduct(changed, PLUGIN, healer);
    expect(res.records).toHaveLength(1);
    expect(res.records[0]).toMatchObject({ id: 'P1', title: 'iPhone' });
    expect(res.healed?.role).toBe('product');
  });
});
