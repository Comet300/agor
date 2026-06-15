/**
 * The access gate must resolve a chat's permission with a SINGLE access lookup
 * per message, not two (the old `isAllowed(id) || isAdmin(id)` ran get() twice
 * for every non-allowed chat — the common rejected case). T2-6.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildBot } from '../src/gateway/bot';
import { Orchestrator } from '../src/orchestrator';
import { openStore } from '../src/persistence';
import { PluginRegistry } from '../src/registry';
import { ProxyPool } from '../src/scraping/proxyPool';
import { ScrapingEngine } from '../src/scraping/engine';
import { loadConfig } from '../src/config';
import type { Bot } from 'grammy';

const DENIED = 321;
let updateId = 1;

function feed(bot: Bot, chatId: number, text: string): Promise<void> {
  const update = {
    update_id: updateId++,
    message: {
      message_id: updateId, date: 1,
      chat: { id: chatId, type: 'private' as const },
      from: { id: chatId, is_bot: false, first_name: 'T' },
      text,
    },
  };
  return bot.handleUpdate(update as unknown as Parameters<Bot['handleUpdate']>[0]);
}

describe('access gate query efficiency', () => {
  it('resolves permission with a single access.get() per incoming message', async () => {
    const store = openStore(':memory:');
    const registry = new PluginRegistry([]);
    const engine = new ScrapingEngine({ pool: new ProxyPool([], 1000), cooldownMs: 1000, sleep: async () => {} });
    const config = loadConfig({});
    const orchestrator = new Orchestrator({ registry, store, engine, config, notify: async () => {} });
    // An admin exists so the gate is active (deny-by-default); DENIED is not it.
    store.access.seedAdmin(999);

    const bot = buildBot(orchestrator, store, 'fake-token', { adminChatIds: [999] });
    (bot as unknown as { botInfo: unknown }).botInfo = {
      id: 1, is_bot: true, first_name: 'agor', username: 'agor_bot',
      can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    };
    bot.api.config.use(async () => ({ ok: true, result: { message_id: 1 } } as never));

    const getSpy = vi.spyOn(store.access, 'get');
    await feed(bot, DENIED, 'just some chatter'); // non-command, denied chat → gate rejects
    // The gate must consult the access record at most once for this message.
    const gateCalls = getSpy.mock.calls.filter(([id]) => id === DENIED).length;
    expect(gateCalls).toBe(1);
  });
});
