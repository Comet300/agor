/**
 * Phase 7 + Phase 10 — Core Orchestrator end-to-end suite.
 *
 * These ARE the integration tests for the three notification features:
 *   9.1 search new-listing, 9.2 price-drop, 9.3 back-in-stock.
 *
 * Everything is wired for real except the network: a single INJECTED fetcher
 * returns whatever HTML `currentBody` currently holds, so a test simulates a
 * page changing over time simply by swapping that body between cycles. No live
 * network, no real sleeping, and every timestamp is an explicit numeric ms so
 * the whole engine is deterministic.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { openStore, type Store } from '../src/persistence';
import { PluginRegistry } from '../src/registry';
import { ProxyPool } from '../src/scraping/proxyPool';
import { ScrapingEngine, type Fetcher } from '../src/scraping/engine';
import type { AppConfig } from '../src/config';
import type { IVendorPlugin, MessageRef, Notification } from '../src/contracts';
import { Orchestrator } from '../src/orchestrator';

// ────────────────────────────────────────────────────────────────────────────
// Synthetic vendor plugin
//
// A minimal manifest pointing at a `script#__NEXT_DATA__` payload whose search
// items live at `data.items` and whose product node lives at `data.product`.
// Field paths are flat so the fixtures below are trivial to author.
// ────────────────────────────────────────────────────────────────────────────

const SYNTH_PLUGIN: IVendorPlugin = {
  vendor: 'synth',
  domain: 'synth.test',
  engine: 'json-extractor',
  // 0 rate limit so back-to-back cycles never actually sleep.
  rate_limit_ms: 0,
  search_mapping: {
    payload_locator: 'script#__NEXT_DATA__',
    json_path_to_items: 'data.items',
    fields: {
      id: 'id',
      title: 'title',
      price: 'price',
      currency: 'currency',
      url: 'url',
      isPrivateOwner: '!business', // company => business:true => isPrivateOwner:false
      location: 'city',
      inStock: 'available',
    },
  },
  product_mapping: {
    payload_locator: 'script#__NEXT_DATA__',
    json_path: 'data.product',
    fields: {
      id: 'id',
      title: 'title',
      price: 'price',
      currency: 'currency',
      url: 'url',
      isPrivateOwner: '!business',
      location: 'city',
      inStock: 'available',
    },
  },
};

const SEARCH_URL = 'https://www.synth.test/search?q=phones';
const PRODUCT_URL = 'https://www.synth.test/d/item-7';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures: wrap a JS object as an HTML doc carrying a #__NEXT_DATA__ script.
// ────────────────────────────────────────────────────────────────────────────

/** Shape of one raw search/product node before normalization. */
interface RawNode {
  id: string;
  title: string;
  price: number;
  currency: string;
  url: string;
  /** true => company (B2C); false/absent => private owner. */
  business?: boolean;
  city?: string;
  /** Physical availability; defaults to true when absent. */
  available?: boolean;
}

/** Wrap a payload object as a Next.js-style HTML document. */
function htmlDoc(payload: unknown): string {
  return (
    '<!DOCTYPE html><html><body>' +
    '<script id="__NEXT_DATA__" type="application/json">' +
    JSON.stringify(payload) +
    '</script></body></html>'
  );
}

/** HTML for a search page exposing `data.items`. */
function searchDoc(items: RawNode[]): string {
  return htmlDoc({ data: { items } });
}

/** HTML for a product page exposing `data.product`. */
function productDoc(product: RawNode): string {
  return htmlDoc({ data: { product } });
}

// ────────────────────────────────────────────────────────────────────────────
// Harness: store + registry + engine (injected mutable fetcher) + orchestrator.
// ────────────────────────────────────────────────────────────────────────────

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    botToken: undefined,
    databasePath: ':memory:',
    proxyUrls: [],
    adminChatIds: [],
    defaultCheckIntervalMs: 600_000,
    oosFastIntervalMs: 120_000,
    dedupWindowMs: 86_400_000,
    benchmarkMinSample: 4,
    proxyBenchCooldownMs: 300_000,
    monitorCycleTimeoutMs: 120_000,
    failureAlertThreshold: 3,
    enableBrowserFallback: false,
    circuitBreakerThreshold: 10,
    logLevel: 'silent',
    logService: 'agor',
    logEnv: 'test',
    webhookUrl: undefined,
    webhookPort: 8443,
    webhookSecret: undefined,
    ...over,
  };
}

interface Harness {
  store: Store;
  orchestrator: Orchestrator;
  notify: Mock<(n: Notification) => Promise<MessageRef | void>>;
  notes: Notification[];
  /** Swap the HTML body the injected fetcher will return next. */
  setBody: (body: string) => void;
  /** Stage a recognised anti-bot hard block (403 + AkamaiGHost) for next fetches. */
  setBlocked: (blocked: boolean) => void;
  /** Stage the HTTP status the next non-blocked fetch returns. */
  setStatus: (status: number) => void;
  /** Stage the final (post-redirect) URL the next fetch reports. */
  setFinalUrl: (url: string | undefined) => void;
  /** The injectable clock the orchestrator reads. */
  setNow: (ms: number) => void;
}

function makeHarness(configOver: Partial<AppConfig> = {}): Harness {
  const store = openStore(':memory:');
  const registry = new PluginRegistry([SYNTH_PLUGIN]);

  // The fetcher returns whatever body is currently staged; we mutate it between
  // cycles to simulate the page changing over time. When `blocked` is staged it
  // returns a recognised Akamai hard block instead.
  let currentBody = searchDoc([]);
  let blocked = false;
  let nextStatus = 200;
  let nextFinalUrl: string | undefined;
  const fetcher: Fetcher = async (url) =>
    blocked
      ? { status: 403, body: 'Access Denied', headers: { server: 'AkamaiGHost' }, finalUrl: url }
      : { status: nextStatus, body: currentBody, finalUrl: nextFinalUrl ?? url };

  const engine = new ScrapingEngine({
    pool: new ProxyPool([], 1000), // empty pool => no proxy needed (size 0 path)
    cooldownMs: 1000,
    fetcher,
    // No-op sleep so rate limiting never actually waits.
    sleep: async () => {},
  });

  let nowMs = 1_000;
  let nextMessageId = 100;
  const notes: Notification[] = [];
  // Mirror the real notifier contract: return a MessageRef for sent messages so
  // the orchestrator can record originals for cross-post edits; void for edits.
  const notify = vi.fn(async (n: Notification): Promise<MessageRef | void> => {
    notes.push(n);
    if (n.kind === 'cross_post') return;
    return { chatId: n.chatId, messageId: nextMessageId++ };
  });

  const orchestrator = new Orchestrator({
    registry,
    store,
    engine,
    config: makeConfig(configOver),
    notify,
    now: () => nowMs,
  });

  return {
    store,
    orchestrator,
    notify,
    notes,
    setBody: (body: string) => {
      currentBody = body;
    },
    setBlocked: (b: boolean) => {
      blocked = b;
    },
    setStatus: (s: number) => {
      nextStatus = s;
    },
    setFinalUrl: (u: string | undefined) => {
      nextFinalUrl = u;
    },
    setNow: (ms: number) => {
      nowMs = ms;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 10.1 — Search new-listing (Feature 9.1)
// ────────────────────────────────────────────────────────────────────────────

describe('10.1 search registration + new-listing detection', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('registers a baseline silently, then notifies exactly the one added item', async () => {
    // Baseline page: two existing private listings.
    h.setBody(
      searchDoc([
        { id: 'A', title: 'iPhone 13', price: 2000, currency: 'RON', url: 'https://www.synth.test/A', city: 'Cluj' },
        { id: 'B', title: 'Pixel 8', price: 1800, currency: 'RON', url: 'https://www.synth.test/B', city: 'Iasi' },
      ]),
    );

    const res = await h.orchestrator.register({ chatId: 99, rawUrl: SEARCH_URL });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('register failed');
    expect(res.monitor.type).toBe('search');
    // Baseline captured both existing items.
    expect(res.baselineCount).toBe(2);
    // CRITICAL: registration fires NO notifications.
    expect(h.notify).not.toHaveBeenCalled();

    // ── Cycle 1: one brand-new item C appears alongside the two existing. ──
    h.setNow(2_000);
    h.setBody(
      searchDoc([
        { id: 'A', title: 'iPhone 13', price: 2000, currency: 'RON', url: 'https://www.synth.test/A', city: 'Cluj' },
        { id: 'B', title: 'Pixel 8', price: 1800, currency: 'RON', url: 'https://www.synth.test/B', city: 'Iasi' },
        { id: 'C', title: 'Galaxy S23', price: 2500, currency: 'RON', url: 'https://www.synth.test/C', city: 'Brasov' },
      ]),
    );

    const round1 = (await h.orchestrator.runMonitorOnce(res.monitor.id)).notifications;

    // Exactly one new_listing, and only for the genuinely new item C.
    expect(round1).toHaveLength(1);
    expect(round1[0]!.kind).toBe('new_listing');
    expect(round1[0]!.chatId).toBe(99);
    expect(round1[0]!.item!.id).toBe('C');
    // Dispatched through the notify sink as well.
    expect(h.notify).toHaveBeenCalledTimes(1);

    // ── Cycle 2: identical page, nothing new -> zero notifications. ──
    h.setNow(3_000);
    const round2 = (await h.orchestrator.runMonitorOnce(res.monitor.id)).notifications;
    expect(round2).toHaveLength(0);
    // No additional dispatch happened.
    expect(h.notify).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 10.2 — Product price-drop (Feature 9.2)
// ────────────────────────────────────────────────────────────────────────────

describe('10.2 product registration + price-drop detection', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('emits one price_drop with correct savings on a lower price, none on higher/equal', async () => {
    const base: RawNode = {
      id: 'P7',
      title: 'Watched widget',
      price: 1000,
      currency: 'RON',
      url: PRODUCT_URL,
      available: true,
    };

    // Baseline at 1000.
    h.setBody(productDoc(base));
    const res = await h.orchestrator.register({ chatId: 7, rawUrl: PRODUCT_URL, type: 'product' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('register failed');
    expect(res.monitor.type).toBe('product');
    expect(res.baselineCount).toBe(1);
    expect(h.notify).not.toHaveBeenCalled();

    // ── Cycle 1: price drops 1000 -> 850. ──
    h.setNow(2_000);
    h.setBody(productDoc({ ...base, price: 850 }));
    const drop = (await h.orchestrator.runMonitorOnce(res.monitor.id)).notifications;

    expect(drop).toHaveLength(1);
    expect(drop[0]!.kind).toBe('price_drop');
    expect(drop[0]!.chatId).toBe(7);
    expect(drop[0]!.priceDrop).toEqual({
      previousPrice: 1000,
      currentPrice: 850,
      savings: 150,
    });

    // ── Cycle 2: price rises 850 -> 900 -> no notification (still recorded). ──
    h.setNow(3_000);
    h.setBody(productDoc({ ...base, price: 900 }));
    const rise = (await h.orchestrator.runMonitorOnce(res.monitor.id)).notifications;
    expect(rise).toHaveLength(0);

    // ── Cycle 3: price equal to last (900) -> no notification. ──
    h.setNow(4_000);
    h.setBody(productDoc({ ...base, price: 900 }));
    const equal = (await h.orchestrator.runMonitorOnce(res.monitor.id)).notifications;
    expect(equal).toHaveLength(0);

    // The price was recorded each cycle: last logged price is 900, and a drop
    // measured against it would use 900 as the previous price.
    expect(h.store.priceHistory.lastPrice(res.monitor.id, 'P7')).toBe(900);

    // ── Cycle 4: drop again 900 -> 700, savings measured vs the latest 900. ──
    h.setNow(5_000);
    h.setBody(productDoc({ ...base, price: 700 }));
    const drop2 = (await h.orchestrator.runMonitorOnce(res.monitor.id)).notifications;
    expect(drop2).toHaveLength(1);
    expect(drop2[0]!.priceDrop?.savings).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 10.3 — Product back-in-stock (Feature 9.3)
// ────────────────────────────────────────────────────────────────────────────

describe('10.3 product back-in-stock detection + fast tier', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('flips fastTier on OOS (no notification), then emits one back_in_stock on restock', async () => {
    const base: RawNode = {
      id: 'P9',
      title: 'Sometimes available',
      price: 500,
      currency: 'RON',
      url: PRODUCT_URL,
      available: true,
    };

    // Baseline: in stock.
    h.setBody(productDoc(base));
    const res = await h.orchestrator.register({ chatId: 11, rawUrl: PRODUCT_URL, type: 'product' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('register failed');

    const m = h.store.monitors.get(res.monitor.id)!;
    expect(m.fastTier).toBe(false);

    // ── Cycle 1: item goes OUT of stock. fastTier becomes true, no notification. ──
    h.setNow(2_000);
    h.setBody(productDoc({ ...base, available: false }));
    const oos = (await h.orchestrator.runMonitorOnce(res.monitor.id)).notifications;
    expect(oos).toHaveLength(0); // out-of-stock alone is never notified

    // The cycle mutates monitor.fastTier in place on the object it loaded; to
    // observe it the orchestrator must hand us the same monitor. We re-load it
    // through a cycle on a monitor instance to confirm the in-place mutation.
    const loaded = h.store.monitors.get(res.monitor.id)!;
    const notesOos = (await h.orchestrator.cycle.run(loaded)).notifications;
    expect(notesOos).toHaveLength(0);
    // The cycle set fastTier on the in-memory monitor (still OOS).
    expect(loaded.fastTier).toBe(true);

    // ── Cycle 2: item comes BACK in stock -> exactly one back_in_stock. ──
    h.setNow(3_000);
    h.setBody(productDoc({ ...base, available: true }));
    const restock = h.store.monitors.get(res.monitor.id)!;
    const back = (await h.orchestrator.cycle.run(restock)).notifications;

    expect(back).toHaveLength(1);
    expect(back[0]!.kind).toBe('back_in_stock');
    expect(back[0]!.chatId).toBe(11);
    expect(back[0]!.item!.id).toBe('P9');
    // Now in stock again -> fastTier cleared on the in-memory monitor.
    expect(restock.fastTier).toBe(false);
  });

  it('starts a product already out-of-stock on the fast tier at registration', async () => {
    const base: RawNode = {
      id: 'P-OOS',
      title: 'Out of stock at signup',
      price: 500,
      currency: 'RON',
      url: PRODUCT_URL,
      available: false,
    };
    h.setNow(1_000);
    h.setBody(productDoc(base));

    const res = await h.orchestrator.register({ chatId: 22, rawUrl: PRODUCT_URL, type: 'product' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('register failed');

    // The baseline observed inStock:false, so the monitor is escalated immediately
    // rather than waiting a full default interval for its first poll.
    expect(res.monitor.fastTier).toBe(true);
    expect(res.monitor.nextDueAt).toBe(1_000 + 120_000); // startedAt + oosFastIntervalMs

    const persisted = h.store.monitors.get(res.monitor.id)!;
    expect(persisted.fastTier).toBe(true);
    expect(persisted.nextDueAt).toBe(1_000 + 120_000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 10.4 — Filters drop junk before notifying; deal tags appear with enough sample
// ────────────────────────────────────────────────────────────────────────────

describe('10.4 search filters + deal tagging', () => {
  it('exclusion keyword and seller-visibility=private drop items before they notify', async () => {
    const h = makeHarness();

    // Baseline empty so every item below is "new" on the first cycle.
    h.setBody(searchDoc([]));
    const res = await h.orchestrator.register({ chatId: 5, rawUrl: SEARCH_URL });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('register failed');
    expect(res.baselineCount).toBe(0);

    // Tighten the monitor's filters: exclude "broken" and only private sellers.
    const m = h.store.monitors.get(res.monitor.id)!;
    m.filters = { sellerVisibility: 'private', exclusionKeywords: ['broken'] };
    h.store.monitors.update(m);

    // Cycle with: a clean private item (KEEP), a junk private item (excluded by
    // keyword), and a clean COMPANY item (dropped by seller visibility).
    h.setNow(2_000);
    h.setBody(
      searchDoc([
        { id: 'K', title: 'Clean phone', price: 1500, currency: 'RON', url: 'https://www.synth.test/K', city: 'Cluj', business: false },
        { id: 'J', title: 'Broken phone parts', price: 200, currency: 'RON', url: 'https://www.synth.test/J', city: 'Cluj', business: false },
        { id: 'CO', title: 'Company phone', price: 1600, currency: 'RON', url: 'https://www.synth.test/CO', city: 'Iasi', business: true },
      ]),
    );

    const notes = (await h.orchestrator.runMonitorOnce(res.monitor.id)).notifications;

    // Only the clean private item survives the filters to become a notification.
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe('new_listing');
    expect(notes[0]!.item!.id).toBe('K');
  });

  it('attaches a deal tag once the active sample reaches minSample', async () => {
    // minSample=4: a batch of >=4 active listings makes the benchmark confident.
    const h = makeHarness({ benchmarkMinSample: 4 });

    h.setBody(searchDoc([]));
    const res = await h.orchestrator.register({ chatId: 8, rawUrl: SEARCH_URL });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('register failed');

    // Five private listings, all new this cycle. Median of [1000,1000,1000,1000,
    // 500] is 1000; the 500 listing is <= 0.85*median -> 'great_deal'; the rest
    // sit at the median -> 'fair_price'.
    h.setNow(2_000);
    h.setBody(
      searchDoc([
        { id: 'D1', title: 'Phone one', price: 1000, currency: 'RON', url: 'https://www.synth.test/D1', city: 'Cluj' },
        { id: 'D2', title: 'Phone two', price: 1000, currency: 'RON', url: 'https://www.synth.test/D2', city: 'Cluj' },
        { id: 'D3', title: 'Phone three', price: 1000, currency: 'RON', url: 'https://www.synth.test/D3', city: 'Cluj' },
        { id: 'D4', title: 'Phone four', price: 1000, currency: 'RON', url: 'https://www.synth.test/D4', city: 'Cluj' },
        { id: 'BARGAIN', title: 'Bargain phone', price: 500, currency: 'RON', url: 'https://www.synth.test/BARGAIN', city: 'Cluj' },
      ]),
    );

    const notes = (await h.orchestrator.runMonitorOnce(res.monitor.id)).notifications;
    expect(notes).toHaveLength(5);

    const byId = new Map(notes.map((n) => [n.item!.id, n.item!]));

    // The confident benchmark is attached to every enriched new item.
    const bargain = byId.get('BARGAIN')!;
    expect(bargain.benchmark?.confident).toBe(true);
    expect(bargain.benchmark?.median).toBe(1000);
    expect(bargain.dealTag).toBe('great_deal');

    // A median-priced listing reads as a fair price.
    expect(byId.get('D1')!.dealTag).toBe('fair_price');
  });

  it('omits the deal tag when the active sample is below minSample', async () => {
    // minSample=4 but only 2 active listings -> not confident -> no dealTag.
    const h = makeHarness({ benchmarkMinSample: 4 });

    h.setBody(searchDoc([]));
    const res = await h.orchestrator.register({ chatId: 8, rawUrl: SEARCH_URL });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('register failed');

    h.setNow(2_000);
    h.setBody(
      searchDoc([
        { id: 'S1', title: 'Phone one', price: 1000, currency: 'RON', url: 'https://www.synth.test/S1', city: 'Cluj' },
        { id: 'S2', title: 'Phone two', price: 500, currency: 'RON', url: 'https://www.synth.test/S2', city: 'Cluj' },
      ]),
    );

    const notes = (await h.orchestrator.runMonitorOnce(res.monitor.id)).notifications;
    expect(notes).toHaveLength(2);
    for (const n of notes) {
      expect(n.item!.benchmark?.confident).toBe(false);
      expect(n.item!.dealTag).toBeUndefined();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Guard rails: invalid / unsupported registration inputs.
// ────────────────────────────────────────────────────────────────────────────

describe('registration guard rails', () => {
  it('rejects an unparseable URL', async () => {
    const h = makeHarness();
    const res = await h.orchestrator.register({ chatId: 1, rawUrl: 'not a url' });
    expect(res).toEqual({ ok: false, error: 'Invalid URL' });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('rejects a domain no plugin claims', async () => {
    const h = makeHarness();
    const res = await h.orchestrator.register({
      chatId: 1,
      rawUrl: 'https://www.unknown-vendor.com/search',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.error).toMatch(/Unsupported site/);
  });

  it('rejects a search URL that returns a 4xx (wrong/dead URL) and leaves no monitor', async () => {
    const h = makeHarness();
    // The URL resolves to a 404 (carzz's apex stub / a wrong path), not a listing page.
    h.setStatus(404);
    const before = h.store.monitors.listByChat(1).length;
    const res = await h.orchestrator.register({ chatId: 1, rawUrl: SEARCH_URL });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.error).toMatch(/not reachable|could not|not found|invalid/i);
    // The transient monitor row must not be left behind.
    expect(h.store.monitors.listByChat(1).length).toBe(before);
  });

  it('KEEPS a legitimately EMPTY search (200, zero items) — empty is valid, not dead', async () => {
    const h = makeHarness();
    h.setBody(searchDoc([]));
    const res = await h.orchestrator.register({ chatId: 1, rawUrl: SEARCH_URL });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected success');
    expect(res.baselineCount).toBe(0);
  });

  it('KEEPS the watch on a 5xx at registration (transient, not a dead URL)', async () => {
    const h = makeHarness();
    h.setStatus(503);
    const res = await h.orchestrator.register({ chatId: 1, rawUrl: SEARCH_URL });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected success');
    expect(res.baselineCount).toBe(0);
  });

  it('KEEPS the watch on a hard block at registration (transient, not a dead URL)', async () => {
    const h = makeHarness();
    h.setBlocked(true);
    const res = await h.orchestrator.register({ chatId: 1, rawUrl: SEARCH_URL });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected success');
    expect(res.baselineCount).toBe(0);
  });

  it('persists the canonical (post-redirect) URL when the baseline followed a redirect', async () => {
    const h = makeHarness();
    h.setBody(searchDoc([{ id: 'A', title: 'iPhone 13', price: 2000, currency: 'RON', url: 'https://www.synth.test/A', city: 'Cluj' }]));
    // The www URL 301s to the apex; the engine reports the apex as finalUrl.
    h.setFinalUrl('https://synth.test/search?q=phones');
    const res = await h.orchestrator.register({ chatId: 1, rawUrl: SEARCH_URL });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected success');
    expect(res.monitor.url).toBe('https://synth.test/search?q=phones');
    // And it still resolves to the same vendor.
    expect(res.monitor.vendor).toBe('synth');
  });

  it('ignores a cross-domain redirect (open-redirect guard): keeps the scrubbed URL', async () => {
    const h = makeHarness();
    h.setBody(searchDoc([{ id: 'A', title: 'iPhone 13', price: 2000, currency: 'RON', url: 'https://www.synth.test/A', city: 'Cluj' }]));
    h.setFinalUrl('https://evil.example.com/phishing');
    const res = await h.orchestrator.register({ chatId: 1, rawUrl: SEARCH_URL });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected success');
    expect(res.monitor.url).toBe(SEARCH_URL); // unchanged — redirect not trusted
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Feature 6 — cross-platform dedup edits the original alert (cross-batch)
// ────────────────────────────────────────────────────────────────────────────

describe('cross-platform dedup appends the source to the original alert', () => {
  it('suppresses the later cross-post and emits a cross_post edit of the original', async () => {
    const h = makeHarness();

    // Register with an empty baseline so the first real cycle alerts item X.
    h.setBody(searchDoc([]));
    const res = await h.orchestrator.register({ chatId: 7, rawUrl: SEARCH_URL });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('register failed');

    // ── Cycle 1: original listing X appears -> one new_listing, ref recorded. ──
    h.setNow(2_000);
    h.setBody(
      searchDoc([
        { id: 'X1', title: 'Same Phone', price: 1000, currency: 'RON', url: 'https://www.synth.test/X1', city: 'Cluj' },
      ]),
    );
    const first = (await h.orchestrator.runMonitorOnce(res.monitor.id)).notifications;
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe('new_listing');

    // ── Cycle 2: a cross-post Y (same title/price/city, new id+url) appears. ──
    h.setNow(3_000);
    h.setBody(
      searchDoc([
        { id: 'X1', title: 'Same Phone', price: 1000, currency: 'RON', url: 'https://www.synth.test/X1', city: 'Cluj' },
        { id: 'Y1', title: 'Same Phone', price: 1000, currency: 'RON', url: 'https://www.synth.test/Y1', city: 'Cluj' },
      ]),
    );
    const second = (await h.orchestrator.runMonitorOnce(res.monitor.id)).notifications;

    // Y is NOT a fresh new_listing; instead the original alert is edited.
    expect(second.some((n) => n.kind === 'new_listing')).toBe(false);
    const cross = second.find((n) => n.kind === 'cross_post');
    expect(cross).toBeDefined();
    // It targets the original message (messageId 100, the first send).
    expect(cross!.messageRef).toEqual({ chatId: 7, messageId: 100 });
    // The edited card carries the new vendor source.
    expect(cross!.item!.alternativeSources).toContainEqual({
      vendor: 'synth',
      url: 'https://www.synth.test/Y1',
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Watch health — failure surfacing + recovery (watch-health-and-check)
// ────────────────────────────────────────────────────────────────────────────

describe('watch health: failure surfacing and /check semantics', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  /** Register a search watch with one baseline item. */
  async function registerSearch(): Promise<number> {
    h.setBody(searchDoc([{ id: 'A', title: 'iPhone 13', price: 2000, currency: 'RON', url: 'https://www.synth.test/A', city: 'Cluj' }]));
    const res = await h.orchestrator.register({ chatId: 5, rawUrl: SEARCH_URL });
    if (!res.ok) throw new Error('register failed');
    return res.monitor.id;
  }

  it('notifies watch_failing exactly once at the threshold, then watch_recovered once', async () => {
    const id = await registerSearch();

    // 5 consecutive failing cycles (HTTP 500 -> scrape ok:false).
    h.setBody('boom');
    for (let i = 0; i < 5; i++) {
      h.setNow(2_000 + i);
      const r = await h.orchestrator.runMonitorOnce(id);
      expect(r.ok).toBe(false);
    }

    // Exactly ONE failing notice (at the 3rd consecutive failure), not five.
    const failing = h.notes.filter((n) => n.kind === 'watch_failing');
    expect(failing).toHaveLength(1);
    expect(failing[0]!.health).toMatchObject({ monitorId: id, vendor: 'synth', consecutiveFailures: 3 });
    expect(h.store.monitors.get(id)!.consecutiveFailures).toBe(5);

    // Recovery: a healthy cycle -> exactly one recovered notice, counter reset.
    h.setBody(searchDoc([{ id: 'A', title: 'iPhone 13', price: 2000, currency: 'RON', url: 'https://www.synth.test/A', city: 'Cluj' }]));
    h.setNow(10_000);
    const ok = await h.orchestrator.runMonitorOnce(id);
    expect(ok.ok).toBe(true);
    expect(h.notes.filter((n) => n.kind === 'watch_recovered')).toHaveLength(1);
    expect(h.store.monitors.get(id)!.consecutiveFailures).toBe(0);
  });

  it('treats a search going empty (after having listings) as unhealthy', async () => {
    const id = await registerSearch();

    h.setBody(searchDoc([])); // ok:true but zero items, with a prior baseline
    for (let i = 0; i < 3; i++) {
      h.setNow(2_000 + i);
      await h.orchestrator.runMonitorOnce(id);
    }
    expect(h.notes.filter((n) => n.kind === 'watch_failing')).toHaveLength(1);
  });

  it('does NOT alarm for a brand-new search that is legitimately empty', async () => {
    h.setBody(searchDoc([])); // empty baseline, no prior listings
    const res = await h.orchestrator.register({ chatId: 5, rawUrl: SEARCH_URL });
    if (!res.ok) throw new Error('register failed');

    for (let i = 0; i < 4; i++) {
      h.setNow(2_000 + i);
      await h.orchestrator.runMonitorOnce(res.monitor.id);
    }
    expect(h.notes.filter((n) => n.kind === 'watch_failing')).toHaveLength(0);
  });

  it('does NOT alarm a product whose item is filtered out by the user (ok, 0 items)', async () => {
    h.setBody(productDoc({ id: 'P1', title: 'Widget', price: 100, currency: 'RON', url: PRODUCT_URL, business: true, available: true }));
    const res = await h.orchestrator.register({ chatId: 5, rawUrl: PRODUCT_URL, type: 'product' });
    if (!res.ok) throw new Error('register failed');

    // User restricts to private sellers; the (company) product is filtered out.
    const m = h.store.monitors.get(res.monitor.id)!;
    m.filters.sellerVisibility = 'private';
    h.store.monitors.update(m);

    for (let i = 0; i < 4; i++) {
      h.setNow(2_000 + i);
      const r = await h.orchestrator.runMonitorOnce(res.monitor.id);
      expect(r.ok).toBe(true); // intentional filtering is healthy
    }
    expect(h.notes.filter((n) => n.kind === 'watch_failing')).toHaveLength(0);
  });

  it('runMonitorOnce returns the CycleResult summary /check renders', async () => {
    const id = await registerSearch();
    h.setBody(searchDoc([
      { id: 'A', title: 'iPhone 13', price: 2000, currency: 'RON', url: 'https://www.synth.test/A', city: 'Cluj' },
      { id: 'B', title: 'Pixel 8', price: 1800, currency: 'RON', url: 'https://www.synth.test/B', city: 'Iasi' },
    ]));
    h.setNow(2_000);
    const r = await h.orchestrator.runMonitorOnce(id);
    expect(r).toMatchObject({ ok: true, itemsActive: 2, newItems: 1 });
    // Unknown monitor -> failed empty result (check_not_found is handled in bot.ts).
    expect((await h.orchestrator.runMonitorOnce(99_999)).ok).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Per-vendor circuit breaker: pause polling a hard-blocked vendor
// ────────────────────────────────────────────────────────────────────────────

describe('circuit breaker pauses polling a hard-blocked vendor', () => {
  let h: Harness;
  beforeEach(() => {
    // Low threshold so the test trips it in 3 cycles.
    h = makeHarness({ circuitBreakerThreshold: 3 });
  });

  async function registerSearch(): Promise<number> {
    h.setBody(searchDoc([{ id: 'A', title: 'iPhone 13', price: 2000, currency: 'RON', url: 'https://www.synth.test/A', city: 'Cluj' }]));
    const res = await h.orchestrator.register({ chatId: 5, rawUrl: SEARCH_URL });
    if (!res.ok) throw new Error('register failed');
    return res.monitor.id;
  }

  it('trips after N hard blocks, then SKIPS the scrape (no further fetch) until reset', async () => {
    const id = await registerSearch();

    // Stage an Akamai 403 hard block; 3 cycles trip the breaker.
    h.setBlocked(true);
    for (let i = 0; i < 3; i++) {
      h.setNow(2_000 + i);
      const r = await h.orchestrator.runMonitorOnce(id);
      expect(r.ok).toBe(false);
      expect(r.blocked).toBe(true);
    }
    expect(h.orchestrator.blockedVendors()).toContain('synth');

    // A blocked vendor must not be polled even though the page would now succeed:
    // unstage the block; the cycle is skipped (status 0, the skip sentinel), so it
    // does NOT report a 200 / items.
    h.setBlocked(false);
    h.setNow(5_000);
    const skipped = await h.orchestrator.runMonitorOnce(id);
    expect(skipped.ok).toBe(false);
    expect(skipped.status).toBe(0); // skip sentinel — no fetch happened
    expect(skipped.itemsActive).toBe(0);

    // Manual re-enable resumes polling: the now-healthy page is scraped again.
    h.orchestrator.resetCircuit('synth');
    expect(h.orchestrator.blockedVendors()).not.toContain('synth');
    h.setNow(6_000);
    const resumed = await h.orchestrator.runMonitorOnce(id);
    expect(resumed.ok).toBe(true);
    expect(resumed.itemsActive).toBe(1);
  });

  it('does not trip when cycles stay healthy', async () => {
    const id = await registerSearch();
    for (let i = 0; i < 5; i++) {
      h.setNow(2_000 + i);
      await h.orchestrator.runMonitorOnce(id);
    }
    expect(h.orchestrator.blockedVendors()).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Access control: a revoked owner's monitors are paused (not polled/notified)
// ────────────────────────────────────────────────────────────────────────────

describe('access control pauses a revoked owner’s monitors', () => {
  const ADMIN = 999;
  const OWNER = 42;

  it('does not poll or notify a monitor whose owner is not allowed; resumes when re-allowed', async () => {
    // Access control activates once an admin exists; the owner IS allowed at first.
    const h = makeHarness();
    h.store.access.seedAdmin(ADMIN);
    h.store.access.allow(OWNER, { by: ADMIN, at: 1 });

    h.setBody(searchDoc([{ id: 'A', title: 'iPhone', price: 2000, currency: 'RON', url: 'https://www.synth.test/A', city: 'Cluj' }]));
    const res = await h.orchestrator.register({ chatId: OWNER, rawUrl: SEARCH_URL });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('register failed');
    const id = res.monitor.id;

    // A normal cycle with a new item works while allowed.
    h.setNow(2_000);
    h.setBody(searchDoc([
      { id: 'A', title: 'iPhone', price: 2000, currency: 'RON', url: 'https://www.synth.test/A', city: 'Cluj' },
      { id: 'B', title: 'Pixel', price: 1800, currency: 'RON', url: 'https://www.synth.test/B', city: 'Iasi' },
    ]));
    const allowed = await h.orchestrator.runMonitorOnce(id);
    expect(allowed.ok).toBe(true);
    expect(allowed.newItems).toBe(1);

    // Revoke the owner — the monitor must now be skipped entirely.
    h.store.access.deny(OWNER, { by: ADMIN, at: 3_000 });
    const before = h.notify.mock.calls.length;
    h.setNow(4_000);
    h.setBody(searchDoc([
      { id: 'A', title: 'iPhone', price: 2000, currency: 'RON', url: 'https://www.synth.test/A', city: 'Cluj' },
      { id: 'B', title: 'Pixel', price: 1800, currency: 'RON', url: 'https://www.synth.test/B', city: 'Iasi' },
      { id: 'C', title: 'Galaxy', price: 2500, currency: 'RON', url: 'https://www.synth.test/C', city: 'Brasov' },
    ]));
    const revoked = await h.orchestrator.runMonitorOnce(id);
    expect(revoked.ok).toBe(false);
    expect(revoked.status).toBe(0); // skip sentinel — no fetch
    expect(h.notify.mock.calls.length).toBe(before); // nothing dispatched

    // Re-allow — polling resumes and the now-new item C is notified.
    h.store.access.allow(OWNER, { by: ADMIN, at: 5_000 });
    h.setNow(6_000);
    const resumed = await h.orchestrator.runMonitorOnce(id);
    expect(resumed.ok).toBe(true);
    expect(resumed.newItems).toBe(1); // C
  });

  it('pre-bootstrap (no admin exists yet): monitors run regardless of access rows', async () => {
    const h = makeHarness();
    // A denied row exists but NO admin has been created, so access control is not
    // yet active — the monitor still runs.
    h.store.access.deny(OWNER, { by: 0, at: 1 });
    h.setBody(searchDoc([{ id: 'A', title: 'iPhone', price: 2000, currency: 'RON', url: 'https://www.synth.test/A', city: 'Cluj' }]));
    const res = await h.orchestrator.register({ chatId: OWNER, rawUrl: SEARCH_URL });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('register failed');
    h.setNow(2_000);
    h.setBody(searchDoc([
      { id: 'A', title: 'iPhone', price: 2000, currency: 'RON', url: 'https://www.synth.test/A', city: 'Cluj' },
      { id: 'B', title: 'Pixel', price: 1800, currency: 'RON', url: 'https://www.synth.test/B', city: 'Iasi' },
    ]));
    const out = await h.orchestrator.runMonitorOnce(res.monitor.id);
    expect(out.ok).toBe(true);
    expect(out.newItems).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Per-chat dedup isolation: one user's listing cannot suppress another's alert
// ────────────────────────────────────────────────────────────────────────────

describe('dedup is isolated per chat (no cross-user suppression)', () => {
  it('two chats watching the same listing each get their own new_listing alert', async () => {
    const h = makeHarness(); // fail-open, no access control in the way

    // Both chats register an empty baseline so the first real cycle alerts.
    h.setBody(searchDoc([]));
    const a = await h.orchestrator.register({ chatId: 1, rawUrl: SEARCH_URL });
    const b = await h.orchestrator.register({ chatId: 2, rawUrl: SEARCH_URL });
    if (!a.ok || !b.ok) throw new Error('register failed');

    // The SAME listing appears for both.
    const body = searchDoc([
      { id: 'X1', title: 'Same Phone', price: 1000, currency: 'RON', url: 'https://www.synth.test/X1', city: 'Cluj' },
    ]);
    h.setNow(2_000);
    h.setBody(body);
    const aNotes = (await h.orchestrator.runMonitorOnce(a.monitor.id)).notifications;
    const bNotes = (await h.orchestrator.runMonitorOnce(b.monitor.id)).notifications;

    // Each chat gets its OWN new_listing — chat 2 is NOT cross-suppressed by chat 1.
    expect(aNotes.filter((n) => n.kind === 'new_listing')).toHaveLength(1);
    expect(bNotes.filter((n) => n.kind === 'new_listing')).toHaveLength(1);
    expect(aNotes[0]!.chatId).toBe(1);
    expect(bNotes[0]!.chatId).toBe(2);
    // No cross_post leaked across the two chats.
    expect(bNotes.some((n) => n.kind === 'cross_post')).toBe(false);
  });
});
