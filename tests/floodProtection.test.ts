/**
 * Flood protection (T1-9): per-chat cooldown on /check, surfaced through the
 * built bot with a faked bot.api. Verifies the second rapid /check is refused
 * with the rate-limit message while the first is served.
 */
import { describe, it, expect } from 'vitest';
import { buildBot } from '../src/gateway/bot';
import { Orchestrator } from '../src/orchestrator';
import { openStore } from '../src/persistence';
import { PluginRegistry } from '../src/registry';
import { ProxyPool } from '../src/scraping/proxyPool';
import { ScrapingEngine } from '../src/scraping/engine';
import { loadConfig } from '../src/config';
import { tr } from '../src/gateway/strings';
import type { Bot } from 'grammy';

const USER = 555;

interface Sent { chatId: number; text: string }

function harness(opts: { checkCooldownMs?: number; urlRegisterCooldownMs?: number }) {
  const store = openStore(':memory:');
  const registry = new PluginRegistry([]);
  const engine = new ScrapingEngine({ pool: new ProxyPool([], 1000), cooldownMs: 1000, sleep: async () => {} });
  const config = loadConfig({});
  const orchestrator = new Orchestrator({ registry, store, engine, config, notify: async () => {} });

  // Allow the user up-front so the access gate lets commands through.
  store.access.seedAdmin(USER);

  const sent: Sent[] = [];
  const bot = buildBot(orchestrator, store, 'fake-token', { adminChatIds: [USER], ...opts });
  (bot as unknown as { botInfo: unknown }).botInfo = {
    id: 1, is_bot: true, first_name: 'agor', username: 'agor_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  };
  let msgId = 0;
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === 'sendMessage') {
      const p = payload as { chat_id: number; text: string };
      sent.push({ chatId: p.chat_id, text: p.text });
      return { ok: true, result: { message_id: ++msgId } } as never;
    }
    return { ok: true, result: {} } as never;
  });
  return { store, bot, sent };
}

let updateId = 1;
function feed(bot: Bot, chatId: number, text: string): Promise<void> {
  const entities = text.startsWith('/')
    ? [{ type: 'bot_command' as const, offset: 0, length: text.split(/\s/)[0]!.length }]
    : undefined;
  const update = {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: chatId, type: 'private' as const },
      from: { id: chatId, is_bot: false, first_name: 'T' },
      text,
      ...(entities ? { entities } : {}),
    },
  };
  return bot.handleUpdate(update as unknown as Parameters<Bot['handleUpdate']>[0]);
}

describe('flood protection: /check cooldown', () => {
  it('serves the first /check but refuses a rapid repeat with the rate-limit message', async () => {
    const h = harness({ checkCooldownMs: 10_000 });
    // A real monitor owned by USER so /check reaches the cooldown gate.
    const m = h.store.monitors.create({
      type: 'search', chatId: USER, vendor: 'olx', url: 'https://www.olx.ro/x/',
      filters: { sellerVisibility: 'both', exclusionKeywords: [] }, intervalMs: 60_000, nextDueAt: 0,
    });

    await feed(h.bot, USER, `/check ${m.id}`);
    await feed(h.bot, USER, `/check ${m.id}`);

    const limited = h.sent.filter((s) => s.text === tr('ro').check_rate_limited);
    expect(limited).toHaveLength(1); // exactly the second call was throttled
  });

  it('does not throttle when the cooldown is disabled (0)', async () => {
    const h = harness({ checkCooldownMs: 0 });
    const m = h.store.monitors.create({
      type: 'search', chatId: USER, vendor: 'olx', url: 'https://www.olx.ro/y/',
      filters: { sellerVisibility: 'both', exclusionKeywords: [] }, intervalMs: 60_000, nextDueAt: 0,
    });
    await feed(h.bot, USER, `/check ${m.id}`);
    await feed(h.bot, USER, `/check ${m.id}`);
    expect(h.sent.some((s) => s.text === tr('ro').check_rate_limited)).toBe(false);
  });
});
