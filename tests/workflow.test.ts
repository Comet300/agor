/**
 * Workflow features: inline /list action rows, /stats, /export CSV, and
 * forward-to-track — driven through the built bot with a faked bot.api.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildBot, extractUrl } from '../src/gateway/bot';
import { Orchestrator } from '../src/orchestrator';
import { openStore, type Store } from '../src/persistence';
import { PluginRegistry } from '../src/registry';
import { ProxyPool } from '../src/scraping/proxyPool';
import { ScrapingEngine } from '../src/scraping/engine';
import { loadConfig } from '../src/config';
import type { IScrapedItem, IVendorPlugin } from '../src/contracts';
import type { Bot } from 'grammy';

const USER = 8200;
let updateId = 1;

const PLUGIN: IVendorPlugin = {
  vendor: 'synth', domain: 'synth.test', engine: 'json-extractor', rate_limit_ms: 0,
  search_mapping: { payload_locator: 'script#__NEXT_DATA__', json_path_to_items: 'data.items',
    fields: { id: 'id', title: 'title', price: 'price', currency: 'currency', url: 'url' } },
  product_mapping: { payload_locator: 'script#__NEXT_DATA__', json_path: 'data.product',
    fields: { id: 'id', title: 'title', price: 'price', currency: 'currency', url: 'url' } },
};

interface Sent { kind: 'text' | 'doc'; text: string; data: string[]; filename?: string }

function item(over: Partial<IScrapedItem> = {}): IScrapedItem {
  return { id: 'i1', title: 'Item', price: 100, currency: 'RON', url: 'https://synth.test/i1',
    isPrivateOwner: true, inStock: true, ...over };
}

function harness() {
  const store = openStore(':memory:');
  const registry = new PluginRegistry([PLUGIN]);
  // Empty search doc so a forwarded URL registers cleanly (baseline 0).
  const fetcher = async () => ({ status: 200, body:
    '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ data: { items: [] } }) + '</script>' });
  const engine = new ScrapingEngine({ pool: new ProxyPool([], 1000), cooldownMs: 1000, fetcher, sleep: async () => {} });
  const orchestrator = new Orchestrator({ registry, store, engine, config: loadConfig({}), notify: async () => {}, now: () => 5_000 });
  store.access.seedAdmin(USER);
  store.chatPrefs.setLang(USER, 'en');

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
    if (method === 'sendDocument') {
      const p = payload as { caption?: string; document?: { filename?: string } };
      sent.push({ kind: 'doc', text: p.caption ?? '', data: [], filename: p.document?.filename });
      return { ok: true, result: { message_id: 1 } } as never;
    }
    if (method === 'editMessageText') {
      const p = payload as { text: string; reply_markup?: unknown };
      sent.push({ kind: 'text', text: p.text, data: kbData(p.reply_markup) });
      return { ok: true, result: { message_id: 1 } } as never;
    }
    if (method === 'answerCallbackQuery') {
      answered.push((payload as { text?: string }).text ?? '');
      return { ok: true, result: true } as never;
    }
    return { ok: true, result: {} } as never;
  });
  return { store, bot, sent, answered };
}

function cmd(bot: Bot, text: string): Promise<void> {
  const entities = [{ type: 'bot_command' as const, offset: 0, length: text.split(/\s/)[0]!.length }];
  return bot.handleUpdate({ update_id: updateId++,
    message: { message_id: updateId, date: 1, chat: { id: USER, type: 'private' as const },
      from: { id: USER, is_bot: false, first_name: 'T' }, text, entities } } as unknown as Parameters<Bot['handleUpdate']>[0]);
}
function tap(bot: Bot, data: string): Promise<void> {
  return bot.handleUpdate({ update_id: updateId++,
    callback_query: { id: String(updateId), from: { id: USER, is_bot: false, first_name: 'T' }, chat_instance: 'ci',
      message: { message_id: updateId, date: 1, chat: { id: USER, type: 'private' as const },
        from: { id: 1, is_bot: true, first_name: 'agor' }, text: 'row' }, data } } as unknown as Parameters<Bot['handleUpdate']>[0]);
}
/** A forwarded text message (forward_date set). */
function forward(bot: Bot, text: string): Promise<void> {
  return bot.handleUpdate({ update_id: updateId++,
    message: { message_id: updateId, date: 1, forward_date: 1, chat: { id: USER, type: 'private' as const },
      from: { id: USER, is_bot: false, first_name: 'T' }, text } } as unknown as Parameters<Bot['handleUpdate']>[0]);
}

function mkSearch(store: Store) {
  return store.monitors.create({ type: 'search', chatId: USER, vendor: 'synth', url: 'https://synth.test/s',
    filters: { sellerVisibility: 'both', exclusionKeywords: [] }, intervalMs: 60_000, nextDueAt: 0 });
}

describe('extractUrl', () => {
  it('pulls the first http(s) link out of surrounding text, trimming punctuation', () => {
    expect(extractUrl('look at https://synth.test/abc!')).toBe('https://synth.test/abc');
    expect(extractUrl('(https://x.test/y).')).toBe('https://x.test/y');
    expect(extractUrl('no link here')).toBeNull();
  });
});

describe('workflow commands', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('/list emits one row per watch with Edit/Pause/Remove buttons', async () => {
    const m = mkSearch(h.store);
    await cmd(h.bot, '/list');
    const row = h.sent.at(-1)!;
    expect(row.data).toContain(`le:${m.id}`);
    expect(row.data).toContain(`lp:${m.id}`);
    expect(row.data).toContain(`rm:${m.id}`);
  });

  it('le opens the edit card; lp toggles pause in place', async () => {
    const m = mkSearch(h.store);
    await cmd(h.bot, '/list');
    await tap(h.bot, `le:${m.id}`);
    expect(h.sent.at(-1)!.data.some((d) => d.startsWith('efq:'))).toBe(true); // edit card

    await tap(h.bot, `lp:${m.id}`);
    expect(h.store.monitors.get(m.id)!.paused).toBe(true);
    expect(h.answered.some((a) => /paused/i.test(a))).toBe(true);
  });

  it('/stats summarizes the portfolio', async () => {
    mkSearch(h.store);
    const m2 = mkSearch(h.store);
    h.store.monitors.setPaused(m2.id, true);
    await cmd(h.bot, '/stats');
    const txt = h.sent.at(-1)!.text;
    expect(txt).toMatch(/Watches: 2/);
    expect(txt).toMatch(/paused.*1/i);
  });

  it('/export sends a CSV document, or says empty', async () => {
    await cmd(h.bot, '/export');
    expect(h.sent.at(-1)!.text).toMatch(/nothing to export/i);

    const m = mkSearch(h.store);
    h.store.items.upsert(m.id, item({ id: 'a', title: 'Golf', url: 'https://synth.test/a' }), 1_000);
    await cmd(h.bot, '/export');
    const doc = h.sent.at(-1)!;
    expect(doc.kind).toBe('doc');
    expect(doc.filename).toBe('agor-listings.csv');
    expect(doc.text).toMatch(/Exported 1 listing/);
  });

  it('forwarding a message with a listing link creates a watch', async () => {
    await forward(h.bot, 'Check this out https://synth.test/forwarded');
    const monitors = h.store.monitors.listByChat(USER);
    expect(monitors.some((mo) => mo.url.includes('synth.test/forwarded'))).toBe(true);
  });
});
