/**
 * Browse carousel + click-to-track gateway integration (PR B). Drives /browse,
 * the br: nav callback, and the tk: track callback through the built bot with a
 * faked bot.api, asserting the cards, navigation, and the tracked-monitor flow.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildBot } from '../src/gateway/bot';
import { Orchestrator } from '../src/orchestrator';
import { openStore, type Store } from '../src/persistence';
import { PluginRegistry } from '../src/registry';
import { ProxyPool } from '../src/scraping/proxyPool';
import { ScrapingEngine } from '../src/scraping/engine';
import { loadConfig } from '../src/config';
import type { IScrapedItem, IVendorPlugin } from '../src/contracts';
import { emptyState, addObservation, featureVector } from '../src/features/fairValue';
import type { Bot } from 'grammy';

const USER = 7000;
let updateId = 1;

const PLUGIN: IVendorPlugin = {
  vendor: 'synth', domain: 'synth.test', engine: 'json-extractor', rate_limit_ms: 0,
  search_mapping: { payload_locator: 'script#__NEXT_DATA__', json_path_to_items: 'data.items',
    fields: { id: 'id', title: 'title', price: 'price', currency: 'currency', url: 'url' } },
  product_mapping: { payload_locator: 'script#__NEXT_DATA__', json_path: 'data.product',
    fields: { id: 'id', title: 'title', price: 'price', currency: 'currency', url: 'url' } },
};

interface Sent { kind: 'text' | 'photo'; text: string; data: string[] }

function item(over: Partial<IScrapedItem> = {}): IScrapedItem {
  return {
    id: 'i1', title: 'Item one', price: 100, currency: 'RON', url: 'https://synth.test/i1',
    isPrivateOwner: true, inStock: true, ...over,
  };
}

/** A product page body the Track baseline scrape can resolve (data.product). */
function productBody(it: { id: string; title: string; price: number; currency: string; url: string }): string {
  return (
    '<!DOCTYPE html><html><body>' +
    '<script id="__NEXT_DATA__" type="application/json">' +
    JSON.stringify({ data: { product: it } }) +
    '</script></body></html>'
  );
}

function harness() {
  const store = openStore(':memory:');
  const registry = new PluginRegistry([PLUGIN]);
  // Deterministic fetcher: the Track flow registers a product watch whose baseline
  // scrape must resolve offline. Echo a product node derived from the requested URL.
  const fetcher = async (url: string) => ({
    status: 200,
    body: productBody({ id: url.split('/').pop() ?? 'p', title: 'Tracked', price: 100, currency: 'RON', url }),
  });
  const engine = new ScrapingEngine({ pool: new ProxyPool([], 1000), cooldownMs: 1000, fetcher, sleep: async () => {} });
  const config = loadConfig({});
  // Product registration runs a baseline scrape; return one matching product node.
  const orchestrator = new Orchestrator({ registry, store, engine, config, notify: async () => {},
    now: () => 5_000 });
  store.access.seedAdmin(USER);
  store.chatPrefs.setLang(USER, 'en'); // assert against EN copy

  const sent: Sent[] = [];
  const answered: string[] = [];
  const bot = buildBot(orchestrator, store, 'fake-token', { adminChatIds: [USER] });
  (bot as unknown as { botInfo: unknown }).botInfo = {
    id: 1, is_bot: true, first_name: 'agor', username: 'agor_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  };
  const kbData = (markup: unknown): string[] => {
    const kb = (markup as { inline_keyboard?: Array<Array<Record<string, string>>> } | undefined)?.inline_keyboard ?? [];
    return kb.flat().map((b) => b.callback_data ?? `url:${b.url ?? ''}`);
  };
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === 'sendMessage') {
      const p = payload as { text: string; reply_markup?: unknown };
      sent.push({ kind: 'text', text: p.text, data: kbData(p.reply_markup) });
      return { ok: true, result: { message_id: 1 } } as never;
    }
    if (method === 'sendPhoto') {
      const p = payload as { caption?: string; reply_markup?: unknown };
      sent.push({ kind: 'photo', text: p.caption ?? '', data: kbData(p.reply_markup) });
      return { ok: true, result: { message_id: 1 } } as never;
    }
    if (method === 'answerCallbackQuery') {
      const p = payload as { text?: string };
      answered.push(p.text ?? '');
      return { ok: true, result: true } as never;
    }
    return { ok: true, result: {} } as never;
  });
  return { store, bot, sent, answered };
}

function cmd(bot: Bot, text: string): Promise<void> {
  const entities = [{ type: 'bot_command' as const, offset: 0, length: text.split(/\s/)[0]!.length }];
  return bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: updateId, date: 1, chat: { id: USER, type: 'private' as const },
      from: { id: USER, is_bot: false, first_name: 'T' }, text, entities },
  } as unknown as Parameters<Bot['handleUpdate']>[0]);
}

function tap(bot: Bot, data: string): Promise<void> {
  return bot.handleUpdate({
    update_id: updateId++,
    callback_query: { id: String(updateId), from: { id: USER, is_bot: false, first_name: 'T' },
      chat_instance: 'ci',
      message: { message_id: updateId, date: 1, chat: { id: USER, type: 'private' as const },
        from: { id: 1, is_bot: true, first_name: 'agor' }, text: 'card' },
      data },
  } as unknown as Parameters<Bot['handleUpdate']>[0]);
}

/** Send a plain text message (no bot_command entity) — e.g. a jump-to-# reply. */
function say(bot: Bot, text: string): Promise<void> {
  return bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: updateId, date: 1, chat: { id: USER, type: 'private' as const },
      from: { id: USER, is_bot: false, first_name: 'T' }, text },
  } as unknown as Parameters<Bot['handleUpdate']>[0]);
}

describe('/browse carousel', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  /** Seed a search monitor with stored item snapshots for USER. */
  function seedItems(items: IScrapedItem[]): number {
    const m = h.store.monitors.create({
      type: 'search', chatId: USER, vendor: 'synth', url: 'https://synth.test/s',
      filters: { sellerVisibility: 'both', exclusionKeywords: [] }, intervalMs: 60_000, nextDueAt: 0,
    });
    items.forEach((it, idx) => h.store.items.upsert(m.id, it, 1_000 + idx)); // ascending last_seen
    return m.id;
  }

  it('replies "no items" when nothing is collected', async () => {
    await cmd(h.bot, '/browse');
    expect(h.sent.at(-1)!.text).toMatch(/no items/i);
  });

  it('shows the newest item first with a Track + Next button (no Prev at index 0)', async () => {
    seedItems([
      item({ id: 'a', title: 'Oldest', url: 'https://synth.test/a' }),
      item({ id: 'b', title: 'Newest', url: 'https://synth.test/b', imageUrl: 'https://img/b.jpg' }),
    ]);
    await cmd(h.bot, '/browse');
    const first = h.sent.at(-1)!;
    expect(first.kind).toBe('photo'); // newest has an image → photo card
    expect(first.text).toContain('Newest');
    expect(first.text).toContain('item 1 of 2');
    expect(first.data).toContain('tk:0');
    expect(first.data).toContain('br:1');           // Next
    expect(first.data.some((d) => d.startsWith('br:-'))).toBe(false); // no Prev at the start
  });

  it('navigates with br:<index> to the next card', async () => {
    seedItems([
      item({ id: 'a', title: 'Oldest', url: 'https://synth.test/a' }),
      item({ id: 'b', title: 'Newest', url: 'https://synth.test/b' }),
    ]);
    await cmd(h.bot, '/browse');
    await tap(h.bot, 'br:1'); // → second item (the older one)
    const card = h.sent.at(-1)!;
    expect(card.text).toContain('Oldest');
    expect(card.text).toContain('item 2 of 2');
    expect(card.data).toContain('br:0');            // Prev back to index 0
    expect(card.data.some((d) => d.startsWith('br:2'))).toBe(false); // no Next past the end
  });

  it('tk:<index> creates a tracked product monitor and confirms', async () => {
    // The Track flow registers a product watch → baseline scrape returns this node.
    // (engine fetcher returns empty by default; provide a product body via a real
    // monitor URL the registry matches.)
    seedItems([item({ id: 'b', title: 'Track me', url: 'https://synth.test/b' })]);
    await cmd(h.bot, '/browse');
    await tap(h.bot, 'tk:0');

    // A tracked product monitor now exists for that URL.
    const tracked = h.store.monitors.listByChat(USER).filter((m) => m.origin === 'tracked');
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.url).toBe('https://synth.test/b');
    expect(tracked[0]!.type).toBe('product');
    expect(h.sent.at(-1)!.text).toMatch(/now tracking/i);
  });

  it('tk: on an already-tracked URL does not duplicate and says so', async () => {
    seedItems([item({ id: 'b', title: 'Track me', url: 'https://synth.test/b' })]);
    await cmd(h.bot, '/browse');
    await tap(h.bot, 'tk:0');
    await cmd(h.bot, '/browse'); // refresh session
    await tap(h.bot, 'tk:0');
    expect(h.store.monitors.listByChat(USER).filter((m) => m.origin === 'tracked')).toHaveLength(1);
    expect(h.answered.some((a) => /already tracking/i.test(a))).toBe(true);
  });

  /** Seed a second search monitor (own URL) with item snapshots for USER. */
  function seedMonitor(url: string, items: IScrapedItem[], base = 5_000): number {
    const m = h.store.monitors.create({
      type: 'search', chatId: USER, vendor: 'synth', url,
      filters: { sellerVisibility: 'both', exclusionKeywords: [] }, intervalMs: 60_000, nextDueAt: 0,
    });
    items.forEach((it, idx) => h.store.items.upsert(m.id, it, base + idx));
    return m.id;
  }

  it('single watch skips the scope picker and shows a Jump button, no Switch', async () => {
    seedItems([
      item({ id: 'a', title: 'Oldest', url: 'https://synth.test/a' }),
      item({ id: 'b', title: 'Newest', url: 'https://synth.test/b' }),
    ]);
    await cmd(h.bot, '/browse');
    const card = h.sent.at(-1)!;
    expect(card.text).toContain('item 1 of 2');
    expect(card.data).toContain('bj');          // Jump offered (more than one item)
    expect(card.data).not.toContain('bw');      // no Switch with a single watch
  });

  it('with 2+ watches /browse shows a scope picker (All + one per watch)', async () => {
    seedItems([item({ id: 'a', title: 'Golf', url: 'https://synth.test/a' })]); // watch 1
    seedMonitor('https://synth.test/s2?q=passat', [item({ id: 'b', title: 'Passat', url: 'https://synth.test/b' })]);
    await cmd(h.bot, '/browse');
    const picker = h.sent.at(-1)!;
    expect(picker.kind).toBe('text');
    expect(picker.text).toMatch(/what would you like to browse/i);
    expect(picker.data).toContain('bs:all');
    expect(picker.data.filter((d) => /^bs:\d+$/.test(d))).toHaveLength(2); // one button per watch
  });

  it('bs:all loads the chat-wide union and the card offers Switch', async () => {
    seedItems([item({ id: 'a', title: 'Golf', url: 'https://synth.test/a' })]);
    seedMonitor('https://synth.test/s2?q=passat', [item({ id: 'b', title: 'Passat', url: 'https://synth.test/b' })]);
    await cmd(h.bot, '/browse');
    await tap(h.bot, 'bs:all');
    const card = h.sent.at(-1)!;
    expect(card.text).toContain('item 1 of 2');  // both watches' items unioned
    expect(card.data).toContain('bw');           // Switch present with 2+ watches
  });

  it('bs:<monitorId> scopes browsing to a single watch', async () => {
    seedItems([item({ id: 'a', title: 'Golf', url: 'https://synth.test/a' })]);
    const m2 = seedMonitor('https://synth.test/s2?q=passat', [item({ id: 'b', title: 'Passat', url: 'https://synth.test/b' })]);
    await cmd(h.bot, '/browse');
    await tap(h.bot, `bs:${m2}`);
    const card = h.sent.at(-1)!;
    expect(card.text).toContain('Passat');
    expect(card.text).toContain('item 1 of 1'); // only that watch's single item
  });

  it('jump-to-#: bj prompts, then a number lands on that item', async () => {
    seedItems([
      item({ id: 'a', title: 'Oldest', url: 'https://synth.test/a' }),
      item({ id: 'b', title: 'Middle', url: 'https://synth.test/b' }),
      item({ id: 'c', title: 'Newest', url: 'https://synth.test/c' }),
    ]);
    await cmd(h.bot, '/browse');          // newest-first session: [Newest, Middle, Oldest]
    await tap(h.bot, 'bj');
    expect(h.sent.at(-1)!.text).toMatch(/1 to 3/);
    await say(h.bot, '3');                // 1-based → index 2 → the oldest
    const card = h.sent.at(-1)!;
    expect(card.text).toContain('Oldest');
    expect(card.text).toContain('item 3 of 3');
  });

  it('jump-to-#: an out-of-range number re-prompts and stays armed', async () => {
    seedItems([
      item({ id: 'a', title: 'Oldest', url: 'https://synth.test/a' }),
      item({ id: 'b', title: 'Newest', url: 'https://synth.test/b' }),
    ]);
    await cmd(h.bot, '/browse');
    await tap(h.bot, 'bj');
    await say(h.bot, '9');                // out of range
    expect(h.sent.at(-1)!.text).toMatch(/1 to 2/);
    await say(h.bot, '1');               // still armed → lands item 1
    expect(h.sent.at(-1)!.text).toContain('item 1 of 2');
  });

  it('shows a price rating on the card when enough comparables exist', async () => {
    // Six same-model listings; the newest (shown first) is the cheapest → great deal.
    seedItems([
      item({ id: 'a', title: 'Toyota Corolla Hybrid 2016', price: 20000, currency: 'EUR', url: 'https://synth.test/a' }),
      item({ id: 'b', title: 'Toyota Corolla Hybrid 2017', price: 19000, currency: 'EUR', url: 'https://synth.test/b' }),
      item({ id: 'c', title: 'Toyota Corolla Hybrid 2018', price: 21000, currency: 'EUR', url: 'https://synth.test/c' }),
      item({ id: 'd', title: 'Toyota Corolla Hybrid 2019', price: 22000, currency: 'EUR', url: 'https://synth.test/d' }),
      item({ id: 'e', title: 'Toyota Corolla Hybrid 2020', price: 18000, currency: 'EUR', url: 'https://synth.test/e' }),
      item({ id: 'f', title: 'Toyota Corolla Hybrid 2021', price: 12000, currency: 'EUR', url: 'https://synth.test/f' }),
    ]);
    await cmd(h.bot, '/browse');
    expect(h.sent.at(-1)!.text).toMatch(/great deal|cheaper than/i);
  });

  it('shows a model-predicted fair value on the card when the model is trained', async () => {
    const now = Date.now();
    const s = emptyState(3);
    for (let year = 2016; year <= 2025; year++) {
      for (const km of [50000, 100000, 150000]) {
        const x = featureVector('car', { year, km }, now)!;
        addObservation(s, x, 9 - 0.3 * x[1]! - 0.05 * x[2]!);
      }
    }
    h.store.valuation.save('car', 'RON', s, now);
    seedItems([item({ id: 'c1', title: 'Toyota Corolla', price: 90000, currency: 'RON', url: 'https://synth.test/c1', attributes: { year: '2018', km: '100000' } })]);
    await cmd(h.bot, '/browse');
    expect(h.sent.at(-1)!.text).toMatch(/fair ≈/i);
  });

  it('/rate scrapes a pasted link and replies with its price + a verdict', async () => {
    await cmd(h.bot, '/rate https://synth.test/somecar');
    const out = h.sent.at(-1)!;
    expect(out.text).toMatch(/Tracked/); // scraped item title (harness productBody)
    expect(out.text).toMatch(/100/);     // its price
  });

  it('/rate rejects a missing or unsupported link', async () => {
    await cmd(h.bot, '/rate');
    expect(h.sent.at(-1)!.text).toMatch(/usage: \/rate/i);
    await cmd(h.bot, '/rate not-a-url');
    expect(h.sent.at(-1)!.text).toMatch(/unsupported|invalid/i);
  });

  it('/history sends a price chart with a summary caption', async () => {
    const m = h.store.monitors.create({ type: 'product', chatId: USER, vendor: 'synth', url: 'https://synth.test/h',
      filters: { sellerVisibility: 'both', exclusionKeywords: [] }, intervalMs: 60_000, nextDueAt: 0, origin: 'tracked' });
    h.store.items.upsert(m.id, item({ id: 'hh', title: 'Tracked Phone', price: 900, currency: 'RON', url: 'https://synth.test/hh' }), 3_000);
    h.store.priceHistory.append({ monitorId: m.id, itemId: 'hh', price: 1000, currency: 'RON', observedAt: 1_000 });
    h.store.priceHistory.append({ monitorId: m.id, itemId: 'hh', price: 900, currency: 'RON', observedAt: 2_000 });

    await cmd(h.bot, `/history ${m.id}`);
    const out = h.sent.at(-1)!;
    expect(out.kind).toBe('photo');
    expect(out.text).toMatch(/Tracked Phone/);
    expect(out.text).toMatch(/points/i);
  });

  it('br: with no open session prompts a fresh browse', async () => {
    // A brand-new chat that never ran /browse — a different id so no module-global
    // session from earlier cases leaks in. Allow it and tap a stale-looking nav.
    const FRESH = 7999;
    h.store.access.seedAdmin(FRESH);
    h.store.chatPrefs.setLang(FRESH, 'en');
    await h.bot.handleUpdate({
      update_id: updateId++,
      callback_query: { id: String(updateId), from: { id: FRESH, is_bot: false, first_name: 'T' },
        chat_instance: 'ci',
        message: { message_id: updateId, date: 1, chat: { id: FRESH, type: 'private' as const },
          from: { id: 1, is_bot: true, first_name: 'agor' }, text: 'card' },
        data: 'br:0' },
    } as unknown as Parameters<Bot['handleUpdate']>[0]);
    expect(h.sent.at(-1)!.text).toMatch(/no items/i);
  });
});
