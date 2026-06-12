/**
 * Gateway access-control integration: drive real Telegram updates through the
 * built bot (with a faked bot.api) and assert the authz gate, admin commands,
 * and the /request-access name/email flow behave correctly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildBot } from '../src/gateway/bot';
import { Orchestrator } from '../src/orchestrator';
import { openStore, type Store } from '../src/persistence';
import { PluginRegistry } from '../src/registry';
import { ProxyPool } from '../src/scraping/proxyPool';
import { ScrapingEngine } from '../src/scraping/engine';
import { loadConfig } from '../src/config';
import { tr } from '../src/gateway/strings';
import type { Bot } from 'grammy';

const ADMIN = 999;
const USER = 111;

interface Sent { chatId: number; text: string; hasKeyboard: boolean }

function harness(adminChatIds: number[]) {
  const store = openStore(':memory:');
  const registry = new PluginRegistry([]);
  const engine = new ScrapingEngine({ pool: new ProxyPool([], 1000), cooldownMs: 1000, sleep: async () => {} });
  const config = loadConfig({});
  const orchestrator = new Orchestrator({ registry, store, engine, config, notify: async () => {} });

  const sent: Sent[] = [];
  const answered: string[] = [];
  const bot = buildBot(orchestrator, store, 'fake-token', { adminChatIds });
  // Set a known bot identity so handleUpdate dispatches without a network init().
  (bot as unknown as { botInfo: unknown }).botInfo = {
    id: 1, is_bot: true, first_name: 'agor', username: 'agor_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  };
  // Intercept every API call via a transformer (keeps grammY internals intact),
  // capturing sendMessage and short-circuiting the network with a fake result.
  let msgId = 0;
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === 'sendMessage') {
      const p = payload as { chat_id: number; text: string; reply_markup?: unknown };
      sent.push({ chatId: p.chat_id, text: p.text, hasKeyboard: Boolean(p.reply_markup) });
      return { ok: true, result: { message_id: ++msgId } } as never;
    }
    return { ok: true, result: {} } as never;
  });
  return { store, bot, sent, answered };
}

let updateId = 1;
function textUpdate(chatId: number, text: string) {
  // Telegram tags a leading /command with a bot_command entity; grammY's command
  // plugin matches on that entity, so the harness must include it.
  const entities = text.startsWith('/')
    ? [{ type: 'bot_command' as const, offset: 0, length: text.split(/\s/)[0]!.length }]
    : undefined;
  return {
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
}

async function feed(bot: Bot, chatId: number, text: string): Promise<void> {
  await bot.handleUpdate(textUpdate(chatId, text) as unknown as Parameters<Bot['handleUpdate']>[0]);
}

/** Feed a callback-query update (an inline-button tap) with the given data. */
async function tap(bot: Bot, chatId: number, data: string): Promise<void> {
  const update = {
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      from: { id: chatId, is_bot: false, first_name: 'T' },
      chat_instance: 'ci',
      message: {
        message_id: updateId,
        date: 1,
        chat: { id: chatId, type: 'private' as const },
        from: { id: 1, is_bot: true, first_name: 'agor' },
        text: 'confirm?',
      },
      data,
    },
  };
  await bot.handleUpdate(update as unknown as Parameters<Bot['handleUpdate']>[0]);
}

describe('boot seeding of configured admins', () => {
  it('seeds every ADMIN_CHAT_IDS entry as an allowed admin at build time', () => {
    const h = harness([ADMIN, 1234]);
    expect(h.store.access.isAdmin(ADMIN)).toBe(true);
    expect(h.store.access.isAllowed(ADMIN)).toBe(true);
    expect(h.store.access.isAdmin(1234)).toBe(true);
  });
});

describe('access gate (bootstrap: first requester becomes admin)', () => {
  it('locks the bot before any admin exists; first /request-access claims admin', async () => {
    const h = harness([]); // no env admins; empty access table => locked
    // A normal command is refused before bootstrap.
    await feed(h.bot, USER, '/help');
    expect(h.sent.filter((s) => s.chatId === USER).pop()?.text).toBe(tr('ro').access_denied);

    // First /request-access → name → email → auto-approved AS ADMIN.
    await feed(h.bot, USER, '/request-access');
    await feed(h.bot, USER, 'Owner Person');
    await feed(h.bot, USER, 'owner@example.com');
    expect(h.sent.filter((s) => s.chatId === USER).pop()?.text).toBe(tr('ro').access_first_admin);
    expect(h.store.access.isAdmin(USER)).toBe(true);
    expect(h.store.access.isAllowed(USER)).toBe(true);
    // Name/email were recorded for the user table.
    expect(h.store.access.get(USER)).toMatchObject({ name: 'Owner Person', email: 'owner@example.com' });

    // Now they can use the bot.
    await feed(h.bot, USER, '/help');
    expect(h.sent.some((s) => s.chatId === USER && s.text === tr('ro').help_body)).toBe(true);
  });

  it('a SECOND requester (after an admin exists) becomes pending, not admin', async () => {
    const h = harness([]);
    // First claims admin.
    await feed(h.bot, USER, '/request-access');
    await feed(h.bot, USER, 'Owner');
    await feed(h.bot, USER, 'owner@example.com');
    expect(h.store.access.isAdmin(USER)).toBe(true);

    // Second requester: normal pending flow, admin notified.
    const SECOND = 222;
    await feed(h.bot, SECOND, '/request-access');
    await feed(h.bot, SECOND, 'Second Person');
    await feed(h.bot, SECOND, 'second@example.com');
    expect(h.sent.filter((s) => s.chatId === SECOND).pop()?.text).toBe(tr('ro').access_request_sent);
    expect(h.store.access.statusOf(SECOND)).toBe('pending');
    expect(h.store.access.isAdmin(SECOND)).toBe(false);
    // The first admin got a notification with buttons.
    expect(h.sent.some((s) => s.chatId === USER && s.hasKeyboard)).toBe(true);
  });
});

describe('access gate (enforced with an admin configured)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness([ADMIN]); });

  it('refuses a non-allowed chat and points it at /request-access', async () => {
    await feed(h.bot, USER, '/help');
    const last = h.sent.filter((s) => s.chatId === USER).pop();
    expect(last?.text).toBe(tr('ro').access_denied);
    // The help body must NOT have been sent.
    expect(h.sent.some((s) => s.text === tr('ro').help_body)).toBe(false);
  });

  it('lets the admin through', async () => {
    await feed(h.bot, ADMIN, '/help');
    expect(h.sent.some((s) => s.chatId === ADMIN && s.text === tr('ro').help_body)).toBe(true);
  });

  it('runs the /request-access name→email flow, records pending, notifies admin with buttons', async () => {
    await feed(h.bot, USER, '/request-access');
    expect(h.sent.filter((s) => s.chatId === USER).pop()?.text).toContain(tr('ro').access_ask_name);

    await feed(h.bot, USER, 'Ana Pop');
    expect(h.sent.filter((s) => s.chatId === USER).pop()?.text).toBe(tr('ro').access_ask_email);

    // Invalid email re-prompts, does not advance.
    await feed(h.bot, USER, 'not-an-email');
    expect(h.sent.filter((s) => s.chatId === USER).pop()?.text).toBe(tr('ro').access_email_invalid);

    await feed(h.bot, USER, 'ana@example.com');
    // Requester gets the confirmation.
    expect(h.sent.filter((s) => s.chatId === USER).pop()?.text).toBe(tr('ro').access_request_sent);
    // Persisted as pending with name + email.
    expect(h.store.access.get(USER)).toMatchObject({ status: 'pending', name: 'Ana Pop', email: 'ana@example.com' });
    // Admin notified WITH inline keyboard.
    const adminMsg = h.sent.filter((s) => s.chatId === ADMIN).pop();
    expect(adminMsg?.hasKeyboard).toBe(true);
    expect(adminMsg?.text).toContain('ana@example.com');
  });

  it('/allow grants access and notifies the requester; they can then use the bot', async () => {
    // User requests first.
    await feed(h.bot, USER, '/request-access');
    await feed(h.bot, USER, 'Ana');
    await feed(h.bot, USER, 'ana@example.com');

    await feed(h.bot, ADMIN, `/allow ${USER}`);
    expect(h.store.access.isAllowed(USER)).toBe(true);
    // Requester told they were granted.
    expect(h.sent.some((s) => s.chatId === USER && s.text === tr('ro').access_granted_user)).toBe(true);

    // Now the user can actually use the bot.
    await feed(h.bot, USER, '/help');
    expect(h.sent.some((s) => s.chatId === USER && s.text === tr('ro').help_body)).toBe(true);
  });

  it('a non-admin cannot use admin commands', async () => {
    h.store.access.allow(USER, { by: ADMIN, at: 1 }); // allowed, but not admin
    await feed(h.bot, USER, `/allow 222`);
    expect(h.store.access.isAllowed(222)).toBe(false); // nothing happened
    expect(h.sent.filter((s) => s.chatId === USER).pop()?.text).toBe(tr('ro').access_admin_only);
  });

  it('/deny prompts a confirmation, then revokes once confirmed and notifies the requester', async () => {
    h.store.access.allow(USER, { by: ADMIN, at: 1 });
    await feed(h.bot, ADMIN, `/deny ${USER}`);
    // Not yet denied — the command only asked for confirmation.
    expect(h.store.access.statusOf(USER)).toBe('allowed');
    expect(h.sent.filter((s) => s.chatId === ADMIN).pop()?.text).toBe(tr('ro').confirm_deny({ id: USER, name: '' }));
    // Confirm via the inline button → the deny actually happens.
    await tap(h.bot, ADMIN, `cf:dn:${USER}`);
    expect(h.store.access.statusOf(USER)).toBe('denied');
    expect(h.sent.some((s) => s.chatId === USER && s.text === tr('ro').access_denied_user)).toBe(true);
  });

  it('a denied user is refused /request-access UP-FRONT (not after filling name/email)', async () => {
    // Deny "just now" (with confirmation) so the 7-day cooldown is active.
    h.store.access.allow(USER, { by: ADMIN, at: 1 });
    await feed(h.bot, ADMIN, `/deny ${USER}`);
    await tap(h.bot, ADMIN, `cf:dn:${USER}`);
    const before = h.sent.length;
    await feed(h.bot, USER, '/request-access');
    // The very next reply is the cooldown notice — NOT the name prompt.
    const reply = h.sent.slice(before).find((s) => s.chatId === USER);
    expect(reply?.text).toContain('7'); // "...request again in 7 days"
    expect(reply?.text).not.toContain(tr('ro').access_ask_name);
  });

  it('/setname and /setemail edit tracking fields (admin only)', async () => {
    h.store.access.allow(USER, { by: ADMIN, at: 1 });
    await feed(h.bot, ADMIN, `/setname ${USER} Ana Maria`);
    await feed(h.bot, ADMIN, `/setemail ${USER} ana.maria@example.com`);
    expect(h.store.access.get(USER)).toMatchObject({ name: 'Ana Maria', email: 'ana.maria@example.com' });
  });

  it('/promote makes another chat an admin (admin only); a non-admin cannot', async () => {
    h.store.access.allow(USER, { by: ADMIN, at: 1 });
    // Non-admin USER cannot promote anyone.
    await feed(h.bot, USER, `/promote 222`);
    expect(h.store.access.isAdmin(222)).toBe(false);
    expect(h.sent.filter((s) => s.chatId === USER).pop()?.text).toBe(tr('ro').access_admin_only);
    // Admin promotes USER; USER is notified.
    await feed(h.bot, ADMIN, `/promote ${USER}`);
    expect(h.store.access.isAdmin(USER)).toBe(true);
    expect(h.sent.some((s) => s.chatId === USER && s.text === tr('ro').access_promoted_user)).toBe(true);
  });

  it('/demote confirms then removes another admin, but never the last admin or self', async () => {
    // Promote USER so there are two admins.
    await feed(h.bot, ADMIN, `/promote ${USER}`);
    expect(h.store.access.isAdmin(USER)).toBe(true);

    // ADMIN demotes USER → prompt, not yet applied.
    await feed(h.bot, ADMIN, `/demote ${USER}`);
    expect(h.store.access.isAdmin(USER)).toBe(true);
    // Confirm → demote happens, USER notified.
    await tap(h.bot, ADMIN, `cf:dm:${USER}`);
    expect(h.store.access.isAdmin(USER)).toBe(false);
    expect(h.sent.some((s) => s.chatId === USER && s.text === tr('ro').access_demoted_user)).toBe(true);

    // ADMIN is now the last admin — self-demote is refused up-front (no prompt).
    await feed(h.bot, ADMIN, `/demote ${ADMIN}`);
    expect(h.store.access.isAdmin(ADMIN)).toBe(true);
    expect(h.sent.filter((s) => s.chatId === ADMIN).pop()?.text).toBe(tr('ro').access_demote_last_admin);
  });

  it('cancelling a deny confirmation leaves access unchanged', async () => {
    h.store.access.allow(USER, { by: ADMIN, at: 1 });
    await feed(h.bot, ADMIN, `/deny ${USER}`);
    await tap(h.bot, ADMIN, 'cx'); // cancel
    expect(h.store.access.statusOf(USER)).toBe('allowed'); // untouched
  });

  it('/remove confirms before deleting a watch, and only the owner can', async () => {
    h.store.access.allow(USER, { by: ADMIN, at: 1 });
    const mon = h.store.monitors.create({
      type: 'search', chatId: USER, vendor: 'olx', url: 'https://www.olx.ro/x',
      filters: { sellerVisibility: 'both', exclusionKeywords: [] }, intervalMs: 60_000, nextDueAt: 0,
    });
    // Prompt, not yet deleted.
    await feed(h.bot, USER, `/remove ${mon.id}`);
    expect(h.store.monitors.get(mon.id)).toBeDefined();
    expect(h.sent.filter((s) => s.chatId === USER).pop()?.text).toBe(tr('ro').confirm_remove(mon.id));
    // Confirm → deleted.
    await tap(h.bot, USER, `cf:rm:${mon.id}`);
    expect(h.store.monitors.get(mon.id)).toBeUndefined();
  });
});
