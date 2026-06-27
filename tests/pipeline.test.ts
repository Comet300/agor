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
  applyRequired,
  applyBlocklist,
  phoneKey,
  applyPriceRange,
  applyAttrRanges,
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

  it('parses scientific-notation price strings without dropping the exponent', () => {
    // A JSON payload that ships a large price in exponential form must not be
    // mangled by the digit-stripping cleaner (which would turn "1e6" into 16).
    const nodes = [
      { id: 'a', title: 'T', price: '1e6', url: 'u' }, // -> 1_000_000
      { id: 'b', title: 'T', price: '5e-3', url: 'u' }, // -> 0.005
      { id: 'c', title: 'T', price: '1.5E+2', url: 'u' }, // -> 150
    ];
    const out = normalizeItems(nodes, PLUGIN, 'search');
    expect(out.map((i) => i.price)).toEqual([1_000_000, 0.005, 150]);
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

  it('empties an object-typed string field instead of emitting "[object Object]"', () => {
    // publi24 ships image as an object; a mis-pathed field must fail loud (empty),
    // not silently stringify to "[object Object]".
    const nodes = [
      { id: 'a', title: 't', price: '10', url: 'u', img: { '@type': 'ImageObject', contentUrl: 'x.jpg' } },
    ];
    const out = normalizeItems(nodes, PLUGIN, 'search');
    expect(out).toHaveLength(1);
    expect(out[0]!.imageUrl).toBeUndefined(); // object did NOT become "[object Object]"
  });

  it('decodes HTML entities in text fields (publi24 titles ship &#238; raw)', () => {
    const nodes = [
      { id: 'a', title: 'Inchiriez &#238;n F&#259;lticeni &amp; zona', price: '10', url: 'u' },
    ];
    const out = normalizeItems(nodes, PLUGIN, 'search');
    expect(out[0]!.title).toBe('Inchiriez în Fălticeni & zona');
  });

  it('canonicalizes currency case + maps lei -> RON', () => {
    const nodes = [
      { id: 'a', title: 't', price: '10', url: 'u', currency: 'eur' },
      { id: 'b', title: 't', price: '10', url: 'u', currency: 'lei' },
      { id: 'c', title: 't', price: '10', url: 'u', currency: 'RON' },
    ];
    const out = normalizeItems(nodes, PLUGIN, 'search');
    expect(out.map((i) => i.currency)).toEqual(['EUR', 'RON', 'RON']);
  });

  it('infers a blank currency from the raw price text (symbol/word)', () => {
    const nodes = [
      { id: 'a', title: 't', price: '16.990 eur', url: 'u' }, // word
      { id: 'b', title: 't', price: '124,000 €', url: 'u' }, // symbol
      { id: 'c', title: 't', price: '99', url: 'u' }, // nothing to infer
    ];
    const out = normalizeItems(nodes, PLUGIN, 'search');
    expect(out[0]!.currency).toBe('EUR');
    expect(out[1]!.currency).toBe('EUR');
    expect(out[2]!.currency).toBe(''); // left blank for benchmark-stage fallback
  });

  it('a declared currency still wins over price-text inference', () => {
    const nodes = [{ id: 'a', title: 't', price: '16.990 eur', url: 'u', currency: 'usd' }];
    const out = normalizeItems(nodes, PLUGIN, 'search');
    expect(out[0]!.currency).toBe('USD'); // declared field is authoritative
  });

  it('drops an item whose templated required URL has an empty segment', () => {
    // A slug-less ad would yield "https://x/ad/-123" — a broken deep link.
    const templated: IVendorPlugin = {
      ...PLUGIN,
      search_mapping: {
        ...PLUGIN.search_mapping,
        fields: { ...PLUGIN.search_mapping.fields, url: 'https://x/ad/{slug}-{id}' },
      },
    };
    const nodes = [
      { id: '1', title: 't', price: '10', slug: 'real-slug' }, // ok
      { id: '2', title: 't', price: '10' }, // slug missing => broken url => dropped
    ];
    const out = normalizeItems(nodes, templated, 'search');
    expect(out.map((i) => i.id)).toEqual(['1']);
    expect(out[0]!.url).toBe('https://x/ad/real-slug-1');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// normalize — enrichment fields (description / postedAt / attributes)
// ────────────────────────────────────────────────────────────────────────────
describe('normalizeItems enrichment', () => {
  /** A plugin that maps description, createdAt, and an attributes sub-map. */
  const ENRICH: IVendorPlugin = {
    vendor: 'Enrich',
    domain: 'enrich.example',
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
        description: 'desc',
        postedAt: 'createdTime',
      },
      attributes: {
        // OLX-style key/value array selector + a direct field.
        km: 'params.~find:key=rulaj.value',
        fuel: 'params.~find:key=petrol.value',
        rooms: 'roomsNumber',
      },
    },
    product_mapping: {
      payload_locator: 'script#data',
      json_path: 'advert',
      fields: { id: 'id', title: 'title', price: 'price', url: 'url' },
    },
  };

  it('extracts description and parses postedAt from an ISO date', () => {
    const nodes = [
      { id: 'a', title: 't', price: '10', url: 'u', desc: 'A nice car', createdTime: '2026-06-09T16:21:42+03:00' },
    ];
    const out = normalizeItems(nodes, ENRICH, 'search');
    expect(out[0]!.description).toBe('A nice car');
    expect(out[0]!.postedAt).toBe(Date.parse('2026-06-09T16:21:42+03:00'));
  });

  it('parses postedAt from a space-separated datetime ("2026-06-11 16:05:52")', () => {
    const nodes = [{ id: 'a', title: 't', price: '10', url: 'u', createdTime: '2026-06-11 16:05:52' }];
    const out = normalizeItems(nodes, ENRICH, 'search');
    expect(out[0]!.postedAt).toBe(Date.parse('2026-06-11T16:05:52'));
  });

  it('omits postedAt when the date is missing or unparseable', () => {
    const nodes = [
      { id: 'a', title: 't', price: '10', url: 'u' },
      { id: 'b', title: 't', price: '10', url: 'u', createdTime: 'not a date' },
    ];
    const out = normalizeItems(nodes, ENRICH, 'search');
    expect(out[0]!.postedAt).toBeUndefined();
    expect(out[1]!.postedAt).toBeUndefined();
  });

  it('builds the attributes bag from key/value arrays and direct fields', () => {
    const nodes = [
      {
        id: 'a', title: 't', price: '10', url: 'u',
        params: [
          { key: 'rulaj', value: '40 400 km' },
          { key: 'petrol', value: 'Electric' },
        ],
        roomsNumber: 'TWO',
      },
    ];
    const out = normalizeItems(nodes, ENRICH, 'search');
    expect(out[0]!.attributes).toEqual({ km: '40 400 km', fuel: 'Electric', rooms: 'TWO' });
  });

  it('omits attributes entirely when none resolve (no empty bag)', () => {
    const nodes = [{ id: 'a', title: 't', price: '10', url: 'u' }];
    const out = normalizeItems(nodes, ENRICH, 'search');
    expect(out[0]!.attributes).toBeUndefined();
  });

  it('includes only the attributes that resolved (partial bag)', () => {
    const nodes = [
      { id: 'a', title: 't', price: '10', url: 'u', params: [{ key: 'petrol', value: 'Diesel' }] },
    ];
    const out = normalizeItems(nodes, ENRICH, 'search');
    expect(out[0]!.attributes).toEqual({ fuel: 'Diesel' });
  });

  // ── attributes_from: flexible explode for multi-category vendors ────────────
  const FLEX: IVendorPlugin = {
    vendor: 'Flex',
    domain: 'flex.example',
    engine: 'json-extractor',
    rate_limit_ms: 1000,
    search_mapping: {
      payload_locator: 'script#data',
      json_path_to_items: 'items',
      fields: { id: 'id', title: 'title', price: 'price', url: 'url' },
      attributes_from: { path: 'params', key: 'name', value: 'value' },
    },
    product_mapping: { payload_locator: 'script#data', json_path: 'advert', fields: { id: 'id', title: 'title', price: 'price', url: 'url' } },
  };

  it('explodes WHATEVER params a listing carries (car shape)', () => {
    const nodes = [
      { id: 'a', title: 'Car', price: '10', url: 'u', params: [
        { key: 'rulaj_pana', name: 'Rulaj', value: '40 400 km' },
        { key: 'petrol', name: 'Combustibil', value: 'Electric' },
      ] },
    ];
    const out = normalizeItems(nodes, FLEX, 'search');
    expect(out[0]!.attributes).toEqual({ Rulaj: '40 400 km', Combustibil: 'Electric' });
  });

  it('explodes a DIFFERENT category from the same vendor (apartment shape)', () => {
    const nodes = [
      { id: 'b', title: 'Flat', price: '10', url: 'u', params: [
        { key: 'suprafata', name: 'Suprafață utilă', value: '62 m²' },
        { key: 'compartimentare', name: 'Compartimentare', value: 'Decomandat' },
      ] },
    ];
    const out = normalizeItems(nodes, FLEX, 'search');
    expect(out[0]!.attributes).toEqual({ 'Suprafață utilă': '62 m²', Compartimentare: 'Decomandat' });
  });

  it('omits attributes when the params array is absent or empty', () => {
    const out = normalizeItems(
      [{ id: 'a', title: 't', price: '10', url: 'u' }, { id: 'b', title: 't', price: '10', url: 'u', params: [] }],
      FLEX, 'search',
    );
    expect(out[0]!.attributes).toBeUndefined();
    expect(out[1]!.attributes).toBeUndefined();
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

describe('required keywords (whitelist)', () => {
  const items = [
    item({ id: '1', title: 'BMW 320d' }),
    item({ id: '2', title: 'Audi A4' }),
    item({ id: '3', title: 'VW Golf' }),
  ];

  it('keeps everything when there are no required keywords', () => {
    expect(applyRequired(items, []).map((i) => i.id)).toEqual(['1', '2', '3']);
  });

  it('keeps only titles matching at least one required keyword', () => {
    expect(applyRequired(items, ['bmw', 'audi']).map((i) => i.id)).toEqual(['1', '2']);
  });

  it('matches on a word boundary like exclusions', () => {
    expect(applyRequired([item({ id: 'x', title: 'Embmwedded' })], ['bmw'])).toHaveLength(0);
  });
});

describe('seller blocklist', () => {
  it('phoneKey normalizes to the last 9 digits regardless of formatting', () => {
    expect(phoneKey('+40 712 345 678')).toBe('712345678');
    expect(phoneKey('0712345678')).toBe('712345678');
    expect(phoneKey('0040-712-345-678')).toBe('712345678');
  });

  it('drops items whose seller name is blocked (case-insensitive)', () => {
    const items = [
      { ...item({ id: '1' }), sellerName: 'Premium Cars SRL' },
      { ...item({ id: '2' }), sellerName: 'Jane' },
    ];
    expect(applyBlocklist(items, ['premium cars srl'], []).map((i) => i.id)).toEqual(['2']);
  });

  it('drops items whose phone is blocked across formatting/prefix', () => {
    const items = [
      item({ id: '1', phone: '+40712345678' }),
      item({ id: '2', phone: '0722000000' }),
    ];
    expect(applyBlocklist(items, [], ['0712 345 678']).map((i) => i.id)).toEqual(['2']);
  });

  it('passes everything through with empty blocklists', () => {
    const items = [{ ...item({ id: '1' }), sellerName: 'X' }, item({ id: '2', phone: '0712345678' })];
    expect(applyBlocklist(items, [], [])).toHaveLength(2);
  });
});

describe('range filters', () => {
  it('applyPriceRange keeps items within [min,max] (bounds optional)', () => {
    const items = [item({ id: 'a', price: 3000 }), item({ id: 'b', price: 10000 }), item({ id: 'c', price: 20000 })];
    expect(applyPriceRange(items, 5000, 15000).map((i) => i.id)).toEqual(['b']);
    expect(applyPriceRange(items, undefined, 15000).map((i) => i.id)).toEqual(['a', 'b']);
    expect(applyPriceRange(items, 5000).map((i) => i.id)).toEqual(['b', 'c']);
    expect(applyPriceRange(items).map((i) => i.id)).toEqual(['a', 'b', 'c']); // no bounds
  });

  it('applyAttrRanges filters by parsed attributes, lenient on a missing attribute', () => {
    const items: IScrapedItem[] = [
      { ...item({ id: 'old' }), attributes: { year: '2015', km: '200.000' } },
      { ...item({ id: 'new' }), attributes: { year: '2021', km: '50.000' } },
      { ...item({ id: 'nokm' }), attributes: { year: '2022' } }, // km missing → lenient pass
    ];
    const out = applyAttrRanges(items, { year: { min: 2019 }, km: { max: 120000 } });
    expect(out.map((i) => i.id)).toEqual(['new', 'nokm']);
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

  it('dealTag returns undefined for a zero/near-zero median (no meaningful scale)', () => {
    // A free-listing category (all price 0) gives median 0; the thresholds
    // collapse to a single point and every priced item would read "overpriced".
    expect(dealTag(100, 0)).toBeUndefined();
    expect(dealTag(0, 0)).toBeUndefined();
    expect(dealTag(1, 0.001)).toBeUndefined();
    // A genuine small-but-real median still classifies normally.
    expect(dealTag(50, 100)).toBe('great_deal');
  });

  it('enrichWithBenchmark omits dealTag when the (confident) median is zero', () => {
    const items = [item({ id: 'free', price: 0 }), item({ id: 'priced', price: 100 })];
    const enriched = enrichWithBenchmark(items, [0, 0, 0], 3); // confident, median 0
    expect(enriched[0]?.benchmark?.confident).toBe(true);
    expect(enriched[0]?.dealTag).toBeUndefined();
    expect(enriched[1]?.dealTag).toBeUndefined(); // not nonsensically "overpriced"
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

  it('benchmarks each item against its OWN currency, not a mixed pool', () => {
    // A real-estate SERP in EUR with a single stray LEI listing: the LEI price
    // must NOT pollute the EUR median (and vice-versa).
    const eurItems = [
      item({ id: 'e1', price: 100_000, currency: 'EUR' }),
      item({ id: 'e2', price: 110_000, currency: 'EUR' }),
      item({ id: 'e3', price: 90_000, currency: 'EUR' }),
    ];
    const ronItem = item({ id: 'r1', price: 500_000, currency: 'RON' });
    const all = [...eurItems, ronItem];
    const prices = all.map((i) => ({ price: i.price, currency: i.currency }));

    const enriched = enrichWithBenchmark(all, prices, 3);
    const e1 = enriched.find((i) => i.id === 'e1')!;
    // EUR median is 100k (from 3 EUR prices only) — NOT skewed by the 500k RON.
    expect(e1.benchmark?.median).toBe(100_000);
    expect(e1.benchmark?.sampleSize).toBe(3);
    // The lone RON item has a sample of 1 -> not confident -> no misleading tag.
    const r1 = enriched.find((i) => i.id === 'r1')!;
    expect(r1.benchmark?.sampleSize).toBe(1);
    expect(r1.dealTag).toBeUndefined();
  });

  it('still accepts a plain number[] sample (back-compat, single currency)', () => {
    const items = [item({ id: 'x', price: 50, currency: 'RON' })];
    const enriched = enrichWithBenchmark(items, [90, 100, 110], 3);
    expect(enriched[0]?.benchmark?.median).toBe(100);
    expect(enriched[0]?.dealTag).toBe('great_deal');
  });

  it('a blank-currency item borrows the SERP-dominant currency bucket', () => {
    // Three EUR items + one item whose currency could not be resolved. The blank
    // one should be benchmarked against the dominant (EUR) bucket, not isolated.
    const eur = [
      item({ id: 'e1', price: 100_000, currency: 'EUR' }),
      item({ id: 'e2', price: 110_000, currency: 'EUR' }),
      item({ id: 'e3', price: 90_000, currency: 'EUR' }),
    ];
    const blank = item({ id: 'b1', price: 50_000, currency: '' });
    const all = [...eur, blank];
    const prices = all.map((i) => ({ price: i.price, currency: i.currency }));
    const enriched = enrichWithBenchmark(all, prices, 3);
    const b1 = enriched.find((i) => i.id === 'b1')!;
    // Resolved to the EUR bucket (median 100k, confident) → tagged great_deal.
    expect(b1.benchmark?.median).toBe(100_000);
    expect(b1.benchmark?.confident).toBe(true);
    expect(b1.dealTag).toBe('great_deal'); // 50k <= 100k*0.85
  });

  it('all-blank currency falls back to one implicit bucket (still benchmarked)', () => {
    const items = [
      item({ id: 'a', price: 90, currency: '' }),
      item({ id: 'b', price: 100, currency: '' }),
      item({ id: 'c', price: 110, currency: '' }),
    ];
    const prices = items.map((i) => ({ price: i.price, currency: i.currency }));
    const enriched = enrichWithBenchmark(items, prices, 3);
    // The '' bucket has all three → confident median 100; every item is tagged
    // (90 is within 0.85–1.05 of 100 → fair_price, not great_deal).
    expect(enriched.every((i) => i.benchmark?.confident)).toBe(true);
    expect(enriched.find((i) => i.id === 'a')!.benchmark?.median).toBe(100);
    expect(enriched.find((i) => i.id === 'a')!.dealTag).toBe('fair_price');
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

  it('persists across a simulated restart so a seen listing is not re-recorded', () => {
    // A tiny in-memory DedupStore standing in for the SQLite repo.
    const rows = new Map<string, { signature: string; firstSeenAt: number; entry: unknown }>();
    const store = {
      load: () => [...rows.values()],
      save: (_chatId: number, e: { signature: string; firstSeenAt: number; entry: unknown }) => { rows.set(e.signature, e); },
      remove: (_chatId: number, sig: string) => { rows.delete(sig); },
      pruneExpired: (now: number, maxAgeMs: number) => {
        for (const [sig, e] of rows) if (e.firstSeenAt < now - maxAgeMs) rows.delete(sig);
      },
    };

    // First process lifetime: record `a`.
    const first = new DedupBuffer(60_000, { store, chatId: 7 });
    expect(first.seen(a, 1_000)).toBeUndefined(); // recorded + persisted
    expect(rows.size).toBe(1);

    // "Restart": a brand-new buffer rehydrates from the same store.
    const second = new DedupBuffer(60_000, { store, chatId: 7 });
    const hit = second.seen(b, 2_000); // same signature as `a`
    expect(hit?.item.id).toBe('a'); // recognised as already-seen, NOT re-recorded

    // A prune past the window removes it from the store too.
    second.prune(120_000);
    expect(rows.size).toBe(0);
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
