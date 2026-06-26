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
