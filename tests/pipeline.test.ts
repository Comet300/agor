import { describe, it, expect } from 'vitest';
import type {
  EnrichedItem,
  FilterConfig,
  IScrapedItem,
  IVendorPlugin,
} from '../src/contracts';
import {
  normalizeItems,
  parseExclusionInput,
  buildExclusionRegex,
  applyExclusion,
  applySellerFilter,
  computeDelta,
  newItems,
  median,
  benchmarkFor,
  dealTag,
  enrichWithBenchmark,
  DedupBuffer,
  collapseDuplicates,
  runPipeline,
} from '../src/pipeline';

// ────────────────────────────────────────────────────────────────────────────
// Synthetic plugin: flat field paths so the raw nodes are easy to author.
// `isPrivateOwner` uses the "!" convention against a `business` flag (mirrors
// AutoVit), and `inStock` maps to a `sold` flag negated via "!".
// ────────────────────────────────────────────────────────────────────────────
const PLUGIN: IVendorPlugin = {
  vendor: 'TestVendor',
  domain: 'test.example',
  engine: 'json-extractor',
  rate_limit_ms: 1000,
  search_mapping: {
    payload_locator: 'script#data',
    json_path_to_items: 'items',
    fields: {
      id: 'id',
      title: 'title',
      price: 'price',
      currency: 'currency',
      url: 'url',
      imageUrl: 'img',
      isPrivateOwner: '!business',
      location: 'city',
      inStock: '!sold',
    },
  },
  product_mapping: {
    payload_locator: 'script#data',
    json_path: 'advert',
    fields: {
      id: 'id',
      title: 'title',
      price: 'price',
      currency: 'currency',
      url: 'url',
      // No inStock path here -> should default to TRUE.
      isPrivateOwner: 'sellerType',
    },
  },
};

function filters(partial: Partial<FilterConfig> = {}): FilterConfig {
  return {
    sellerVisibility: partial.sellerVisibility ?? 'both',
    exclusionKeywords: partial.exclusionKeywords ?? [],
  };
}

function item(partial: Partial<IScrapedItem> = {}): IScrapedItem {
  return {
    id: partial.id ?? 'i1',
    title: partial.title ?? 'Generic',
    price: partial.price ?? 100,
    currency: partial.currency ?? 'RON',
    url: partial.url ?? 'https://x/1',
    isPrivateOwner: partial.isPrivateOwner ?? true,
    inStock: partial.inStock ?? true,
    vendor: partial.vendor ?? 'TestVendor',
    ...(partial.location !== undefined ? { location: partial.location } : {}),
    ...(partial.imageUrl !== undefined ? { imageUrl: partial.imageUrl } : {}),
    ...(partial.phone !== undefined ? { phone: partial.phone } : {}),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// normalize
// ────────────────────────────────────────────────────────────────────────────
describe('normalizeItems', () => {
  it('coerces fields, applies "!" negation, parses messy prices', () => {
    const nodes = [
      // dealer (business=true) -> isPrivateOwner false; sold=false -> inStock true
      { id: 'a', title: 'Car A', price: '4.300', currency: 'RON', url: 'u/a', business: true, sold: false, img: 'a.jpg', city: 'Cluj' },
      // private (business absent => falsy) -> isPrivateOwner true; "4 300" -> 4300
      { id: 'b', title: 'Car B', price: '4 300', currency: 'EUR', url: 'u/b', sold: true },
      // decimal comma "4300,50" -> 4300.5
      { id: 'c', title: 'Car C', price: '4300,50', url: 'u/c' },
    ];
    const out = normalizeItems(nodes, PLUGIN, 'search');
    expect(out).toHaveLength(3);

    const [a, b, c] = out as [IScrapedItem, IScrapedItem, IScrapedItem];
    expect(a.price).toBe(4300);
    expect(a.isPrivateOwner).toBe(false); // !business, business=true
    expect(a.inStock).toBe(true); // !sold, sold=false
    expect(a.vendor).toBe('TestVendor');
    expect(a.location).toBe('Cluj');
    expect(a.imageUrl).toBe('a.jpg');

    expect(b.price).toBe(4300);
    expect(b.isPrivateOwner).toBe(true); // !business, business missing => falsy
    expect(b.inStock).toBe(false); // !sold, sold=true
    expect(b.location).toBeUndefined();

    expect(c.price).toBe(4300.5);
    expect(c.inStock).toBe(true); // sold missing -> !undefined defaults to TRUE
  });

  it('parses thousands+decimal mixed groupings', () => {
    const nodes = [
      { id: 'x', title: 'T', price: '1.234,56', url: 'u' }, // -> 1234.56
      { id: 'y', title: 'T', price: '1,234.56', url: 'u' }, // -> 1234.56
      { id: 'z', title: 'T', price: 4300, url: 'u' }, // already numeric
    ];
    const out = normalizeItems(nodes, PLUGIN, 'search');
    expect(out.map((i) => i.price)).toEqual([1234.56, 1234.56, 4300]);
  });

  it('skips nodes missing id/title/url or with unparseable price', () => {
    const nodes = [
      { title: 'no id', price: '10', url: 'u' }, // missing id
      { id: 'a', price: '10', url: 'u' }, // missing title
      { id: 'b', title: 't' }, // missing url
      { id: 'c', title: 't', price: 'free', url: 'u' }, // unparseable price
      { id: 'd', title: 't', price: '50', url: 'u' }, // OK
    ];
    const out = normalizeItems(nodes, PLUGIN, 'search');
    expect(out.map((i) => i.id)).toEqual(['d']);
  });

  it('handles string seller-type hints and product mapping inStock default', () => {
    const nodes = [
      { id: 'p1', title: 't', price: '10', url: 'u', sellerType: 'company' }, // => false
      { id: 'p2', title: 't', price: '10', url: 'u', sellerType: 'private' }, // => true
    ];
    const out = normalizeItems(nodes, PLUGIN, 'product');
    expect(out[0]?.isPrivateOwner).toBe(false);
    expect(out[1]?.isPrivateOwner).toBe(true);
    // product_mapping has no inStock path -> defaults TRUE for all.
    expect(out.every((i) => i.inStock === true)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// exclusion keywords
// ────────────────────────────────────────────────────────────────────────────
describe('exclusion keywords', () => {
  it('parses: split/trim/lowercase/drop-empty/dedupe', () => {
    expect(parseExclusionInput('BMW, audi ,, AUDI ,bmw')).toEqual(['bmw', 'audi']);
    expect(parseExclusionInput('   ')).toEqual([]);
  });

  it('builds null regex for empty keywords', () => {
    expect(buildExclusionRegex([])).toBeNull();
  });

  it('escapes regex metacharacters in keywords', () => {
    // "a.b" must match literally; the "." must NOT act as a regex wildcard.
    const re = buildExclusionRegex(['a.b']);
    expect(re).not.toBeNull();
    expect(re?.test('model a.b sedan')).toBe(true); // literal "a.b"
    expect(re?.test('model axb sedan')).toBe(false); // "." not a wildcard
  });

  it('drops items whose title matches on a word boundary', () => {
    const items = [
      item({ id: '1', title: 'BMW 320d' }),
      item({ id: '2', title: 'Audi A4' }),
      item({ id: '3', title: 'Embmwedded' }), // "bmw" inside a word -> NOT excluded
    ];
    const kept = applyExclusion(items, ['bmw']);
    expect(kept.map((i) => i.id)).toEqual(['2', '3']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// seller filter
// ────────────────────────────────────────────────────────────────────────────
describe('applySellerFilter', () => {
  const items = [
    item({ id: 'priv', isPrivateOwner: true }),
    item({ id: 'comp', isPrivateOwner: false }),
  ];
  it('both -> all', () => {
    expect(applySellerFilter(items, 'both').map((i) => i.id)).toEqual(['priv', 'comp']);
  });
  it('private -> only private owners', () => {
    expect(applySellerFilter(items, 'private').map((i) => i.id)).toEqual(['priv']);
  });
  it('company -> only companies', () => {
    expect(applySellerFilter(items, 'company').map((i) => i.id)).toEqual(['comp']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// delta
// ────────────────────────────────────────────────────────────────────────────
describe('delta', () => {
  it('computeDelta is a de-duplicated set difference', () => {
    const historical = new Set(['a', 'b']);
    expect(computeDelta(['a', 'b', 'c', 'c', 'd'], historical)).toEqual(['c', 'd']);
  });
  it('newItems keeps only items not in history', () => {
    const items = [item({ id: 'a' }), item({ id: 'c' }), item({ id: 'd' })];
    const out = newItems(items, new Set(['a']));
    expect(out.map((i) => i.id)).toEqual(['c', 'd']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// benchmarking
// ────────────────────────────────────────────────────────────────────────────
describe('benchmarking', () => {
  it('median odd/even and empty', () => {
    expect(median([3, 1, 2])).toBe(2); // odd
    expect(median([4, 1, 3, 2])).toBe(2.5); // even -> avg of 2 & 3
    expect(median([])).toBe(0);
    expect(median([NaN])).toBe(0);
  });

  it('dealTag thresholds at boundaries 0.85 and 1.05', () => {
    const med = 100;
    expect(dealTag(85, med)).toBe('great_deal'); // exactly med*0.85
    expect(dealTag(85.01, med)).toBe('fair_price'); // just over great
    expect(dealTag(105, med)).toBe('fair_price'); // exactly med*1.05
    expect(dealTag(105.01, med)).toBe('overpriced'); // just over fair
  });

  it('benchmark confidence depends on minSample', () => {
    expect(benchmarkFor([1, 2, 3], 3).confident).toBe(true);
    expect(benchmarkFor([1, 2], 3).confident).toBe(false);
    const b = benchmarkFor([10, 20, 30], 2);
    expect(b.sampleSize).toBe(3);
    expect(b.median).toBe(20);
  });

  it('enrichWithBenchmark omits dealTag when not confident', () => {
    const items = [item({ id: 'x', price: 50 })];
    const lowSample = enrichWithBenchmark(items, [100], 5); // sample 1 < 5
    expect(lowSample[0]?.benchmark?.confident).toBe(false);
    expect(lowSample[0]?.dealTag).toBeUndefined();

    const confident = enrichWithBenchmark(items, [90, 100, 110], 3);
    expect(confident[0]?.benchmark?.confident).toBe(true);
    expect(confident[0]?.dealTag).toBe('great_deal'); // 50 <= 100*0.85
  });
});

// ────────────────────────────────────────────────────────────────────────────
// dedup
// ────────────────────────────────────────────────────────────────────────────
describe('dedup', () => {
  // Two cross-posted listings: same title/price/location => same signature.
  const a = item({ id: 'a', vendor: 'V1', url: 'https://v1/a', title: 'Same Car', price: 1000, location: 'Cluj' }) as EnrichedItem;
  const b = item({ id: 'b', vendor: 'V2', url: 'https://v2/b', title: 'Same Car', price: 1000, location: 'Cluj' }) as EnrichedItem;
  const c = item({ id: 'c', vendor: 'V1', url: 'https://v1/c', title: 'Other Car', price: 5000, location: 'Iasi' }) as EnrichedItem;

  it('intra-batch collapse merges duplicates into alternativeSources', () => {
    const buffer = new DedupBuffer(60_000);
    const out = collapseDuplicates([a, b, c], buffer, 1_000);
    expect(out.items.map((i) => i.id)).toEqual(['a', 'c']);
    const rep = out.items.find((i) => i.id === 'a');
    expect(rep?.alternativeSources).toEqual([{ vendor: 'V2', url: 'https://v2/b' }]);
    expect(out.crossPosts).toEqual([]);
  });

  it('cross-batch suppression omits the dup AND surfaces it as a crossPost', () => {
    const buffer = new DedupBuffer(60_000);
    const first = collapseDuplicates([a], buffer, 1_000);
    expect(first.items.map((i) => i.id)).toEqual(['a']);
    expect(first.crossPosts).toEqual([]);

    // Same signature next cycle (within window) -> suppressed, but reported as a
    // crossPost carrying the original entry and the new source to append.
    const second = collapseDuplicates([b], buffer, 2_000);
    expect(second.items).toEqual([]);
    expect(second.crossPosts).toHaveLength(1);
    expect(second.crossPosts[0]!.source).toEqual({ vendor: 'V2', url: 'https://v2/b' });
    expect(second.crossPosts[0]!.entry.item.id).toBe('a'); // the original
    // The new source was appended to the stored original.
    expect(second.crossPosts[0]!.entry.item.alternativeSources).toContainEqual({
      vendor: 'V2',
      url: 'https://v2/b',
    });

    // After the window expires the signature can notify again.
    const third = collapseDuplicates([b], buffer, 1_000 + 60_001);
    expect(third.items.map((i) => i.id)).toEqual(['b']);
  });

  it('records the original message ref so cross-posts can edit it', () => {
    const buffer = new DedupBuffer(60_000);
    const first = collapseDuplicates([a], buffer, 1_000);
    const sig = buffer.signatureOf(first.items[0]!);
    buffer.setMessageRef(sig, { chatId: 5, messageId: 42 });

    const second = collapseDuplicates([b], buffer, 2_000);
    expect(second.crossPosts[0]!.entry.messageRef).toEqual({ chatId: 5, messageId: 42 });
  });

  it('DedupBuffer.seen records then matches, and prune drops expired', () => {
    const buffer = new DedupBuffer(1000);
    expect(buffer.seen(a, 0)).toBeUndefined(); // recorded
    const hit = buffer.seen(b, 500); // same signature within window
    expect(hit?.item.id).toBe('a'); // entry holds the original representative
    buffer.prune(2000); // beyond window -> evicted
    expect(buffer.seen(b, 2000)).toBeUndefined(); // recorded fresh again
  });
});

// ────────────────────────────────────────────────────────────────────────────
// runPipeline integration + determinism
// ────────────────────────────────────────────────────────────────────────────
describe('runPipeline', () => {
  function nodes() {
    return [
      // private, in stock, new
      { id: 'n1', title: 'Honda Civic', price: '5000', currency: 'RON', url: 'https://t/n1', business: false, sold: false, city: 'Cluj' },
      // company -> filtered out when sellerVisibility=private
      { id: 'n2', title: 'Dealer BMW', price: '6000', currency: 'RON', url: 'https://t/n2', business: true, sold: false, city: 'Cluj' },
      // matches exclusion keyword "rust" as a whole word
      { id: 'n3', title: 'Full of rust wreck', price: '500', currency: 'RON', url: 'https://t/n3', business: false, sold: false, city: 'Cluj' },
      // already in history -> active but not new
      { id: 'old', title: 'Old Listing', price: '5200', currency: 'RON', url: 'https://t/old', business: false, sold: false, city: 'Cluj' },
    ];
  }

  it('runs the fixed order and splits active vs newEnriched', () => {
    const out = runPipeline({
      rawNodes: nodes(),
      plugin: PLUGIN,
      mapping: 'search',
      filters: filters({ sellerVisibility: 'private', exclusionKeywords: ['rust'] }),
      historicalIds: new Set(['old']),
      minSample: 2,
      now: 1000,
    });

    // active = normalized - exclusion - seller filter (private only, not n2/n3)
    expect(out.active.map((i) => i.id).sort()).toEqual(['n1', 'old']);
    // new = active minus history(old) => just n1, enriched against active prices
    expect(out.newEnriched.map((i) => i.id)).toEqual(['n1']);
    const enriched = out.newEnriched[0];
    expect(enriched?.benchmark?.sampleSize).toBe(2); // active prices: 5000, 5200
    expect(enriched?.benchmark?.confident).toBe(true);
    expect(enriched?.dealTag).toBeDefined();
  });

  it('applies cross-batch dedup when a buffer is supplied', () => {
    const dedup = new DedupBuffer(60_000);
    const args = {
      rawNodes: nodes(),
      plugin: PLUGIN,
      mapping: 'search' as const,
      filters: filters({ sellerVisibility: 'private', exclusionKeywords: ['rust'] }),
      historicalIds: new Set<string>(), // nothing historical -> n1 & old both new
      minSample: 2,
      dedup,
      now: 1000,
    };
    const first = runPipeline(args);
    expect(first.newEnriched.length).toBeGreaterThan(0);
    // Second identical cycle: signatures already in buffer -> all suppressed.
    const second = runPipeline({ ...args, now: 2000 });
    expect(second.newEnriched).toEqual([]);
  });

  it('is deterministic: same input twice -> deep-equal output', () => {
    const build = () => ({
      rawNodes: nodes(),
      plugin: PLUGIN,
      mapping: 'search' as const,
      filters: filters({ sellerVisibility: 'both', exclusionKeywords: ['rust'] }),
      historicalIds: new Set(['old']),
      minSample: 2,
      now: 12345,
    });
    const a = runPipeline(build());
    const b = runPipeline(build());
    expect(a).toEqual(b);
  });
});
