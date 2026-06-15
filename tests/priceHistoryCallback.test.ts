/**
 * The price-history (pg:) callback must surface render/send failures to the log
 * rather than swallowing them silently (T2-14). Here the faked photo-send API
 * throws and we assert an error is logged before the user-facing reply.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const errorCalls: Array<{ fields: unknown; msg: string }> = [];
vi.mock('../src/logging/logger', () => ({
  log: () => ({
    error: (fields: unknown, msg: string) => { errorCalls.push({ fields, msg }); },
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
}));

import { buildBot } from '../src/gateway/bot';
import { Orchestrator } from '../src/orchestrator';
import { openStore } from '../src/persistence';
import { PluginRegistry } from '../src/registry';
import { ProxyPool } from '../src/scraping/proxyPool';
import { ScrapingEngine } from '../src/scraping/engine';
import { loadConfig } from '../src/config';
import type { Bot } from 'grammy';

const USER = 4242;
let updateId = 1;

function harness() {
  const store = openStore(':memory:');
  const registry = new PluginRegistry([]);
  const engine = new ScrapingEngine({ pool: new ProxyPool([], 1000), cooldownMs: 1000, sleep: async () => {} });
  const config = loadConfig({});
  const orchestrator = new Orchestrator({ registry, store, engine, config, notify: async () => {} });
  store.access.seedAdmin(USER);

  const bot = buildBot(orchestrator, store, 'fake-token', { adminChatIds: [USER] });
  (bot as unknown as { botInfo: unknown }).botInfo = {
    id: 1, is_bot: true, first_name: 'agor', username: 'agor_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  };
  bot.api.config.use(async (_prev, method) => {
    // The photo send fails (e.g. canvas/Telegram error) → exercises the catch.
    if (method === 'sendPhoto') throw new Error('photo upload failed');
    if (method === 'answerCallbackQuery') return { ok: true, result: true } as never;
    return { ok: true, result: { message_id: 1 } } as never;
  });
  return { store, bot };
}

function tap(bot: Bot, chatId: number, data: string): Promise<void> {
  const update = {
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      from: { id: chatId, is_bot: false, first_name: 'T' },
      chat_instance: 'ci',
      message: {
        message_id: updateId, date: 1,
        chat: { id: chatId, type: 'private' as const },
        from: { id: 1, is_bot: true, first_name: 'agor' },
        text: 'card',
      },
      data,
    },
  };
  return bot.handleUpdate(update as unknown as Parameters<Bot['handleUpdate']>[0]);
}

describe('pg: price-history callback error logging', () => {
  beforeEach(() => { errorCalls.length = 0; });

  it('logs an error when the photo render/send throws (no silent swallow)', async () => {
    const h = harness();
    // A monitor with two price points so renderPriceHistory returns ok:true and
    // the code reaches replyWithPhoto (which the faked API rejects).
    const m = h.store.monitors.create({
      type: 'product', chatId: USER, vendor: 'olx', url: 'https://www.olx.ro/d/x',
      filters: { sellerVisibility: 'both', exclusionKeywords: [] }, intervalMs: 60_000, nextDueAt: 0,
    });
    h.store.priceHistory.append({ monitorId: m.id, itemId: 'item-9', price: 100, currency: 'RON', observedAt: 1_000 });
    h.store.priceHistory.append({ monitorId: m.id, itemId: 'item-9', price: 90, currency: 'RON', observedAt: 2_000 });

    await tap(h.bot, USER, 'pg:olx:item-9');

    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]!.msg).toMatch(/price history/i);
    expect(errorCalls[0]!.fields).toMatchObject({ chatId: USER });
  });
});
