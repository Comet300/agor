/**
 * /edit gateway integration: drive /edit and the edit-card callbacks (efq/esv/ed)
 * through the built bot with a faked bot.api, asserting the card, the live
 * interval/seller mutations, and ownership/usage guards.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildBot } from '../src/gateway/bot';
import { Orchestrator } from '../src/orchestrator';
import { openStore, type Store } from '../src/persistence';
import { PluginRegistry } from '../src/registry';
import { ProxyPool } from '../src/scraping/proxyPool';
import { ScrapingEngine } from '../src/scraping/engine';
import { loadConfig } from '../src/config';
import type { Bot } from 'grammy';

const USER = 8100;
let updateId = 1;

interface Sent { text: string; data: string[] }

function harness() {
  const store = openStore(':memory:');
  const registry = new PluginRegistry([]);
  const engine = new ScrapingEngine({ pool: new ProxyPool([], 1000), cooldownMs: 1000, sleep: async () => {} });
  const config = loadConfig({});
  const orchestrator = new Orchestrator({ registry, store, engine, config, notify: async () => {} });
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
      sent.push({ text: p.text, data: kbData(p.reply_markup) });
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

function say(bot: Bot, text: string): Promise<void> {
  return bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: updateId, date: 1, chat: { id: USER, type: 'private' as const },
      from: { id: USER, is_bot: false, first_name: 'T' }, text },
  } as unknown as Parameters<Bot['handleUpdate']>[0]);
}

function mkMonitor(store: Store, type: 'search' | 'product') {
  return store.monitors.create({
    type, chatId: USER, vendor: 'OLX', url: `https://www.olx.ro/${type}/q-golf/`,
    filters: { sellerVisibility: 'both', exclusionKeywords: [] },
    intervalMs: 600000, nextDueAt: 0, origin: type === 'product' ? 'tracked' : 'user',
  });
}

describe('/edit', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('renders the edit card for a search watch (seller + freq + exclusion + remove + done)', async () => {
    const m = mkMonitor(h.store, 'search');
    await cmd(h.bot, `/edit ${m.id}`);
    const card = h.sent.at(-1)!;
    expect(card.text).toMatch(new RegExp(`Editing watch #${m.id}`));
    expect(card.data).toContain(`esv:${m.id}:both`);
    expect(card.data).toContain(`efq:${m.id}:30`);
    expect(card.data).toContain(`ex:${m.id}`);
    expect(card.data).toContain(`rm:${m.id}`);
    expect(card.data).toContain('ed');
  });

  it('renders a product watch card without seller/exclusion', async () => {
    const m = mkMonitor(h.store, 'product');
    await cmd(h.bot, `/edit ${m.id}`);
    const card = h.sent.at(-1)!;
    expect(card.data).toContain(`efq:${m.id}:5`);
    expect(card.data).toContain(`rm:${m.id}`);
    expect(card.data.some((d) => d.startsWith('esv:'))).toBe(false);
    expect(card.data.some((d) => d.startsWith('ex:'))).toBe(false);
  });

  it('efq changes the interval and reschedules the next poll', async () => {
    const m = mkMonitor(h.store, 'search');
    await cmd(h.bot, `/edit ${m.id}`);
    await tap(h.bot, `efq:${m.id}:30`);
    expect(h.store.monitors.get(m.id)!.intervalMs).toBe(30 * 60000);
    expect(h.answered.some((a) => /30 min/.test(a))).toBe(true);
  });

  it('esv changes the seller visibility', async () => {
    const m = mkMonitor(h.store, 'search');
    await cmd(h.bot, `/edit ${m.id}`);
    await tap(h.bot, `esv:${m.id}:private`);
    expect(h.store.monitors.get(m.id)!.filters.sellerVisibility).toBe('private');
  });

  it('rejects /edit with no id and a watch that is not yours', async () => {
    await cmd(h.bot, '/edit');
    expect(h.sent.at(-1)!.text).toMatch(/usage: \/edit/i);
    await cmd(h.bot, '/edit 999999');
    expect(h.sent.at(-1)!.text).toMatch(/does not exist or is not yours/i);
  });

  it('ep pauses and resumes the watch (scheduler skips while paused)', async () => {
    const m = mkMonitor(h.store, 'search');
    await cmd(h.bot, `/edit ${m.id}`);
    await tap(h.bot, `ep:${m.id}`);
    expect(h.store.monitors.get(m.id)!.paused).toBe(true);
    expect(h.store.monitors.listDue(Number.MAX_SAFE_INTEGER).some((x) => x.id === m.id)).toBe(false);
    await tap(h.bot, `ep:${m.id}`);
    expect(h.store.monitors.get(m.id)!.paused).toBe(false);
    expect(h.store.monitors.listDue(Number.MAX_SAFE_INTEGER).some((x) => x.id === m.id)).toBe(true);
  });

  it('eo toggles deals-only on a search watch', async () => {
    const m = mkMonitor(h.store, 'search');
    await cmd(h.bot, `/edit ${m.id}`);
    await tap(h.bot, `eo:${m.id}`);
    expect(h.store.monitors.get(m.id)!.filters.dealsOnly).toBe(true);
    await tap(h.bot, `eo:${m.id}`);
    expect(h.store.monitors.get(m.id)!.filters.dealsOnly).toBe(false);
  });

  it('er renames the watch from the next text reply ("-" clears)', async () => {
    const m = mkMonitor(h.store, 'search');
    await cmd(h.bot, `/edit ${m.id}`);
    await tap(h.bot, `er:${m.id}`);
    await say(h.bot, 'Corolla < 15k');
    expect(h.store.monitors.get(m.id)!.label).toBe('Corolla < 15k');
    expect(h.sent.at(-1)!.text).toMatch(/Corolla < 15k/);

    await tap(h.bot, `er:${m.id}`);
    await say(h.bot, '-');
    expect(h.store.monitors.get(m.id)!.label).toBeUndefined();
  });

  it('eq sets required keywords from the next text reply', async () => {
    const m = mkMonitor(h.store, 'search');
    await cmd(h.bot, `/edit ${m.id}`);
    await tap(h.bot, `eq:${m.id}`);
    await say(h.bot, 'hybrid, automat');
    expect(h.store.monitors.get(m.id)!.filters.requiredKeywords).toEqual(['hybrid', 'automat']);
    await tap(h.bot, `eq:${m.id}`);
    await say(h.bot, '-');
    expect(h.store.monitors.get(m.id)!.filters.requiredKeywords).toEqual([]);
  });

  it('et sets and clears a target price on a product watch', async () => {
    const m = mkMonitor(h.store, 'product');
    await cmd(h.bot, `/edit ${m.id}`);
    await tap(h.bot, `et:${m.id}`);
    await say(h.bot, '12.000');
    expect(h.store.monitors.get(m.id)!.filters.targetPrice).toBe(12000);
    await tap(h.bot, `et:${m.id}`);
    await say(h.bot, '-');
    expect(h.store.monitors.get(m.id)!.filters.targetPrice).toBeUndefined();
  });

  it('eb blocks a seller name or a phone, classifying by digit count', async () => {
    const m = mkMonitor(h.store, 'search');
    await cmd(h.bot, `/edit ${m.id}`);
    await tap(h.bot, `eb:${m.id}`);
    await say(h.bot, 'Premium Cars SRL');
    expect(h.store.monitors.get(m.id)!.filters.blockedSellers).toEqual(['premium cars srl']);

    await tap(h.bot, `eb:${m.id}`);
    await say(h.bot, '+40 712 345 678');
    expect(h.store.monitors.get(m.id)!.filters.blockedPhones).toEqual(['+40 712 345 678']);

    await tap(h.bot, `eb:${m.id}`);
    await say(h.bot, '-');
    expect(h.store.monitors.get(m.id)!.filters.blockedSellers).toEqual([]);
    expect(h.store.monitors.get(m.id)!.filters.blockedPhones).toEqual([]);
  });
});
