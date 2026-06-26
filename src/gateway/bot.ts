/**
 * Telegram Bot Gateway (Phase 8).
 *
 * Wires the grammY long-polling bot to the {@link Orchestrator} and the
 * persistence {@link Store}. This is the only place that touches the Telegram
 * API; all message bodies come from the typed message catalog (`tr(lang)`) and
 * the PURE renderers in `./render`, and all domain work is delegated to the
 * orchestrator / store.
 *
 * Localization: Romanian-first. Every reply is resolved per update via
 * {@link langFor} — the stored chat preference, else the Romanian default (the
 * Telegram client locale is not consulted; English is opt-in via /lang en).
 * Background notifications resolve the recipient chat's language in the notifier,
 * since alerts are produced without an incoming update context.
 *
 * Conversational state: a single command-less affordance — sending a URL
 * registers a watch — plus inline-keyboard callbacks for tuning. The only
 * stateful interaction is the exclusion-keyword prompt, tracked per-chat in a
 * module-level {@link pendingExclusion} map (the next plain text from that chat
 * is consumed as the keyword list).
 *
 * Handlers are defensive: each wraps its body in try/catch and replies with a
 * friendly error instead of crashing the polling loop.
 */
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import type { MessageRef, Notification, SellerVisibility } from '../contracts';
import type { ItemSnapshot, Store } from '../persistence';
import type { Orchestrator } from '../orchestrator';
import { parseExclusionInput, phoneKey } from '../pipeline';
import { renderNotification, renderRegistrationCard, renderBrowseCard, renderBrowseScope, renderEditCard } from './render';
import { registrationKeyboard, editKeyboard, confirmKeyboard, browseScopeLabel, type BrowseScope } from './keyboards';
import { renderPriceHistory } from '../features/priceGraph';
import { type Lang, tr, isLang } from './strings';
import { resolveLang } from './lang';
import { log } from '../logging/logger';

/**
 * A Map whose entries expire after a TTL, so an abandoned conversation never
 * leaks memory. `get`/`has` transparently drop a stale entry (and lazily sweep
 * the rest), so callers use it like a plain Map. Time is `Date.now()` — these
 * are short-lived UI prompts, not domain state, so no injected clock is needed.
 */
class ExpiringMap<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();
  constructor(private readonly ttlMs: number) {}

  set(key: K, value: V): void {
    this.sweep();
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
  get(key: K): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (Date.now() >= e.expiresAt) { this.entries.delete(key); return undefined; }
    return e.value;
  }
  has(key: K): boolean {
    return this.get(key) !== undefined;
  }
  delete(key: K): void {
    this.entries.delete(key);
  }
  /** Drop every expired entry (called opportunistically on writes). */
  private sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.entries) if (now >= e.expiresAt) this.entries.delete(k);
  }
}

/** How long an in-flight conversational prompt stays valid before it expires. */
const PENDING_TTL_MS = 15 * 60_000; // 15 minutes

/** Upper bound on price-history rows loaded for a chart (matches the renderer's cap). */
const PRICE_HISTORY_RENDER_CAP = 500;

/** Max items loaded into a single browse session (most-recent first). */
const BROWSE_WINDOW = 100;

/**
 * An open /browse session for a chat: the ordered snapshot of items captured when
 * /browse ran. Nav/Track callbacks index into THIS list, so ordering is stable
 * across taps and the callback payload stays a tiny `br:<index>` / `tk:<index>`
 * (well under Telegram's 64-byte limit). Re-running /browse refreshes it. Entries
 * expire so an abandoned carousel cannot leak.
 */
const browseSessions = new ExpiringMap<number, ItemSnapshot[]>(PENDING_TTL_MS);

/**
 * Chats awaiting an exclusion-keyword reply, keyed by chat id → monitor id.
 * The next plain text from that chat is consumed as the CSV keyword input rather
 * than treated as a URL. Entries expire so an abandoned prompt cannot leak.
 */
const pendingExclusion = new ExpiringMap<number, number>(PENDING_TTL_MS);

/**
 * Chats awaiting a browse "jump to #" reply, keyed by chat id. The stored number
 * is the session length at prompt time (for the re-prompt message); the actual
 * jump re-validates against the live session. The next plain text from that chat
 * is parsed as a 1-based item number rather than treated as a URL.
 */
const pendingJump = new ExpiringMap<number, number>(PENDING_TTL_MS);

/**
 * Chats awaiting a watch "rename" reply, keyed by chat id → monitor id. The next
 * plain text from that chat is consumed as the new label ("-" clears it) rather
 * than treated as a URL. Entries expire so an abandoned prompt cannot leak.
 */
const pendingRename = new ExpiringMap<number, number>(PENDING_TTL_MS);

/** Chats awaiting a required-keywords reply (chat id → monitor id). */
const pendingRequired = new ExpiringMap<number, number>(PENDING_TTL_MS);

/** Chats awaiting a block-seller reply (chat id → monitor id). */
const pendingBlock = new ExpiringMap<number, number>(PENDING_TTL_MS);

/**
 * Chats mid-way through the /request_access flow, keyed by chat id. `step` says
 * which field the next plain-text reply fills; `name` holds the captured name
 * once we advance to asking for the email. Entries expire so an abandoned flow
 * cannot leak.
 */
const pendingAccess = new ExpiringMap<number, { step: 'name' | 'email'; name?: string }>(
  PENDING_TTL_MS,
);

/** A minimal email shape check — good enough to reject obvious typos, not RFC 5322. */
function looksLikeEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}

/** Quick test for an http(s) URL — the only plain text we treat as a watch. */
function looksLikeUrl(text: string): boolean {
  try {
    const u = new URL(text.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Route a non-pending plain-text message: an http(s) link is a watch, a leading
 * slash is an unrecognized command (the known ones are handled above), anything
 * else is unrelated chatter.
 */
export function classifyMessage(text: string): 'url' | 'command' | 'other' {
  if (looksLikeUrl(text)) return 'url';
  if (text.trim().startsWith('/')) return 'command';
  return 'other';
}

/** Whether a string is one of the three valid seller-visibility values. */
function isSellerVisibility(v: string): v is SellerVisibility {
  return v === 'private' || v === 'company' || v === 'both';
}

/** Telegram's hard limit on a single text message. */
const TELEGRAM_MAX_CHARS = 4096;

/**
 * Split `text` into chunks that each fit Telegram's {@link TELEGRAM_MAX_CHARS}
 * limit, preferring `\n\n` (paragraph) boundaries so list items stay whole. A
 * single paragraph longer than the limit is hard-split. Pure + exported for test.
 */
export function splitForTelegram(text: string, max = TELEGRAM_MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const para of text.split('\n\n')) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (para.length <= max) {
      current = para;
    } else {
      // A single oversized paragraph: hard-split into max-sized slices.
      for (let i = 0; i < para.length; i += max) chunks.push(para.slice(i, i + max));
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Send `text` as one or more messages, each within Telegram's size limit. */
async function replyChunked(reply: (t: string) => Promise<unknown>, text: string): Promise<void> {
  for (const chunk of splitForTelegram(text)) await reply(chunk);
}

/** Resolve the language for a chat from its stored preference (Romanian-first). */
function langFor(store: Store, chatId: number): Lang {
  return resolveLang(store.chatPrefs.getLang(chatId));
}

/**
 * Register a raw URL as a watch and reply with the tuning card on success, or
 * the orchestrator's user-facing error string on failure. Shared by `/track`
 * and the plain-URL fast path.
 */
async function handleTrack(
  orchestrator: Orchestrator,
  chatId: number,
  rawUrl: string,
  lang: Lang,
  reply: (text: string, keyboard?: import('./render').RenderedMessage['keyboard']) => Promise<unknown>,
  quotaLimit = 0,
): Promise<void> {
  const result = await orchestrator.register({ chatId, rawUrl });
  if (!result.ok) {
    // A quota refusal gets its own actionable message; everything else is the
    // generic track error.
    await reply(result.reason === 'quota' ? tr(lang).quota_reached(quotaLimit) : tr(lang).track_error);
    return;
  }

  const card = renderRegistrationCard(
    {
      monitorId: result.monitor.id,
      vendor: result.monitor.vendor,
      summary: result.monitor.url,
      baselineCount: result.baselineCount,
      sellerVisibility: result.monitor.filters.sellerVisibility,
      intervalMinutes: Math.round(result.monitor.intervalMs / 60000),
    },
    lang,
  );
  await reply(card.text, card.keyboard);
}

/** Options controlling access + flood protection. */
export interface BotAccessOptions {
  /** Bootstrap admin chat ids (always allowed). Empty ⇒ access control fail-open. */
  adminChatIds?: number[];
  /** Max monitors a non-admin chat may hold (0 = unlimited); used for the message. */
  maxMonitorsPerChat?: number;
  /** Per-chat cooldown (ms) on /check (0 = off). */
  checkCooldownMs?: number;
  /** Per-chat cooldown (ms) on registering a watch from a pasted URL (0 = off). */
  urlRegisterCooldownMs?: number;
}

/**
 * Build (but do not start) the grammY bot. Caller is responsible for invoking
 * `bot.start()` (long polling) — see `src/index.ts`.
 *
 * Access control: the bot is deny-by-default — only allowed chats (and admins)
 * may use it; everyone else is limited to `/start` and `/request_access`. The
 * first chat to complete `/request_access` (when no admin exists yet) is
 * auto-approved as the admin, so no env setup is required; `adminChatIds` can
 * still seed known admins on boot.
 */
export function buildBot(
  orchestrator: Orchestrator,
  store: Store,
  token: string,
  options: BotAccessOptions = {},
): Bot {
  const bot = new Bot(token);
  const adminChatIds = options.adminChatIds ?? [];
  const maxMonitorsPerChat = options.maxMonitorsPerChat ?? 0;
  const checkCooldownMs = options.checkCooldownMs ?? 0;
  const urlRegisterCooldownMs = options.urlRegisterCooldownMs ?? 0;

  // Per-chat flood gates: an entry exists iff the chat acted within the cooldown
  // window (the TTL is the cooldown), so `has(chatId)` means "still cooling down".
  const checkCooldown = new ExpiringMap<number, true>(Math.max(1, checkCooldownMs));
  const urlCooldown = new ExpiringMap<number, true>(Math.max(1, urlRegisterCooldownMs));

  // Seed bootstrap admins from config (always allowed, can grant/revoke).
  // Idempotent — also a no-op when ADMIN_CHAT_IDS is unset, in which case the
  // first /request_access claims admin (see the request flow below).
  for (const id of adminChatIds) store.access.seedAdmin(id);

  /** True when `chatId` may use the bot fully (deny-by-default). Resolves both
   *  conditions from a SINGLE access lookup (avoids two queries per message). */
  const hasAccess = (chatId: number): boolean => {
    const rec = store.access.get(chatId);
    return rec?.status === 'allowed' || rec?.isAdmin === true;
  };

  /** True when `chatId` is an admin. */
  const isAdmin = (chatId: number): boolean => store.access.isAdmin(chatId);

  /** Notify every admin chat (DB admins + any configured) with text + keyboard. */
  const notifyAdmins = async (text: string, keyboard?: InlineKeyboard): Promise<void> => {
    const ids = new Set<number>(adminChatIds);
    for (const u of store.access.list()) if (u.isAdmin) ids.add(u.chatId);
    for (const id of ids) {
      try {
        await bot.api.sendMessage(id, text, keyboard ? { reply_markup: keyboard } : undefined);
      } catch (err) {
        log('access').warn({ adminId: id, err: (err as Error).message }, 'admin notify failed');
      }
    }
  };

  // ── Access gate ─────────────────────────────────────────────────────────────
  // Runs BEFORE every handler. A chat without access may only reach /start and
  // /request_access (and, mid-flow, its own name/email replies); everything else
  // is refused. Fail-safe: a lookup error denies (logged), never lets through.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return next(); // non-chat update; nothing to gate
    let allowed: boolean;
    try {
      allowed = hasAccess(chatId);
    } catch (err) {
      log('access').error({ chatId, err: (err as Error).message }, 'access check failed — denying');
      allowed = false;
    }
    if (allowed) return next();

    const lang = langFor(store, chatId);
    const text = ctx.message?.text ?? '';
    const isStart = text.startsWith('/start');
    const isRequest = text.startsWith('/request_access');
    const midFlow = pendingAccess.has(chatId);
    // Let the request_access entry points and an in-flight name/email reply through.
    if (isStart || isRequest || (midFlow && !text.startsWith('/'))) return next();

    // Refuse everything else. Answer callback queries so the spinner clears.
    if (ctx.callbackQuery) {
      try { await ctx.answerCallbackQuery(tr(lang).access_denied); } catch { /* expired */ }
    } else {
      try { await ctx.reply(tr(lang).access_denied); } catch { /* best effort */ }
    }
    return; // do NOT call next() — handler chain stops here
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  bot.command('start', async (ctx) => {
    const lang = langFor(store, ctx.chat.id);
    await ctx.reply(tr(lang).start_welcome);
  });

  bot.command('help', async (ctx) => {
    const lang = langFor(store, ctx.chat.id);
    await ctx.reply(tr(lang).help_body);
  });

  bot.command('track', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    const rawUrl = (ctx.match ?? '').trim();
    try {
      if (!rawUrl) {
        await ctx.reply(tr(lang).track_usage);
        return;
      }
      // Same flood gate as the plain-URL path: a registration runs a scrape.
      if (urlRegisterCooldownMs > 0 && urlCooldown.has(chatId)) {
        await ctx.reply(tr(lang).url_rate_limited);
        return;
      }
      if (urlRegisterCooldownMs > 0) urlCooldown.set(chatId, true);
      await handleTrack(
        orchestrator, chatId, rawUrl, lang,
        (text, keyboard) => ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined),
        maxMonitorsPerChat,
      );
    } catch (err) {
      await ctx.reply(tr(lang).track_error);
    }
  });

  bot.command('list', async (ctx) => {
    const lang = langFor(store, ctx.chat.id);
    try {
      const monitors = store.monitors.listByChat(ctx.chat.id);
      if (monitors.length === 0) {
        await ctx.reply(tr(lang).list_empty);
        return;
      }
      const lines = monitors.map((m) =>
        tr(lang).list_item({
          id: m.id,
          vendor: m.vendor,
          type: m.type,
          seller: m.filters.sellerVisibility,
          url: m.url,
          exclusions: m.filters.exclusionKeywords.join(', '),
          tracked: m.origin === 'tracked',
          paused: m.paused,
          dealsOnly: m.filters.dealsOnly === true,
          required: (m.filters.requiredKeywords ?? []).join(', '),
          blocked: (m.filters.blockedSellers ?? []).length + (m.filters.blockedPhones ?? []).length,
          ...(m.label ? { label: m.label } : {}),
        }),
      );
      await replyChunked((t) => ctx.reply(t), `${tr(lang).list_intro}\n\n${lines.join('\n\n')}`);
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  /**
   * Send the browse card for `index` of the chat's open session: a photo with the
   * card as caption when the item has an image, else a plain text card. Each view
   * is its own message (a media carousel can't reliably edit photo↔text in place),
   * so nav sends a fresh card and answers the callback to clear the spinner.
   */
  const sendBrowseItem = async (
    ctx: { reply: (t: string, o?: object) => Promise<unknown>; replyWithPhoto: (p: InputFile, o?: object) => Promise<unknown> },
    chatId: number,
    index: number,
  ): Promise<void> => {
    const lang = langFor(store, chatId);
    const items = browseSessions.get(chatId);
    if (!items || items.length === 0) {
      await ctx.reply(tr(lang).browse_empty);
      return;
    }
    const i = Math.max(0, Math.min(index, items.length - 1));
    // Offer the scope "Switch" affordance only when there's more than one watch
    // to switch between (otherwise browse-all is the only scope).
    const canSwitch = store.monitors.listByChat(chatId).length > 1;
    const view = renderBrowseCard(items[i]!, i, items.length, lang, canSwitch);
    const markup = view.keyboard ? { reply_markup: view.keyboard } : undefined;
    if (view.photoUrl) {
      try {
        await ctx.replyWithPhoto(new InputFile(new URL(view.photoUrl)), { caption: view.text, ...markup });
        return;
      } catch (err) {
        // A bad/unreachable image must not break browsing — fall back to text.
        log('gateway').warn({ chatId, err: (err as Error).message }, 'browse photo send failed; text fallback');
      }
    }
    await ctx.reply(view.text, markup);
  };

  /**
   * Build the scope picker's options for a chat: "All listings" first, then one
   * per watch that has browsable items (newest-watch-first, matching /list order).
   * Returns the chat-wide total alongside, so the caller can short-circuit empties.
   */
  const buildBrowseScopes = (chatId: number): { total: number; scopes: BrowseScope[] } => {
    const total = store.items.countForChat(chatId);
    const counts = store.items.browseCountsByMonitor(chatId);
    const scopes: BrowseScope[] = [
      { target: 'all', label: tr(langFor(store, chatId)).btn_browse_all, count: total },
    ];
    for (const m of store.monitors.listByChat(chatId)) {
      const count = counts.get(m.id) ?? 0;
      if (count === 0) continue; // a watch with nothing browsable isn't worth a button
      scopes.push({ target: m.id, label: m.label ?? browseScopeLabel(m.vendor, m.url), count });
    }
    return { total, scopes };
  };

  /** Capture a scope's items as the chat's browse session and show the first card. */
  const startBrowseSession = async (
    ctx: Parameters<typeof sendBrowseItem>[0],
    chatId: number,
    items: ItemSnapshot[],
  ): Promise<void> => {
    browseSessions.set(chatId, items);
    await sendBrowseItem(ctx, chatId, 0);
  };

  bot.command('browse', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const { total, scopes } = buildBrowseScopes(chatId);
      if (total === 0) {
        await ctx.reply(tr(lang).browse_empty);
        return;
      }
      // With more than one watch, let the user scope to a single watch or all.
      // With a single watch, the picker would be a one-option no-op — browse all.
      if (store.monitors.listByChat(chatId).length > 1) {
        const view = renderBrowseScope(scopes, lang);
        await ctx.reply(view.text, view.keyboard ? { reply_markup: view.keyboard } : undefined);
        return;
      }
      await startBrowseSession(ctx, chatId, store.items.browse(chatId, BROWSE_WINDOW, 0));
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  bot.command('remove', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const arg = (ctx.match ?? '').trim();
      const id = Number(arg);
      if (!arg || !Number.isInteger(id)) {
        await ctx.reply(tr(lang).remove_usage);
        return;
      }
      const monitor = store.monitors.get(id);
      if (!monitor || monitor.chatId !== chatId) {
        await ctx.reply(tr(lang).remove_not_found);
        return;
      }
      // Destructive → confirm first; the cf:rm callback performs the delete.
      await ctx.reply(tr(lang).confirm_remove(id), { reply_markup: confirmKeyboard('rm', id, lang) });
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  bot.command('edit', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const arg = (ctx.match ?? '').trim();
      const id = Number(arg);
      if (!arg || !Number.isInteger(id)) {
        await ctx.reply(tr(lang).edit_usage);
        return;
      }
      const monitor = store.monitors.get(id);
      if (!monitor || monitor.chatId !== chatId) {
        await ctx.reply(tr(lang).edit_not_found);
        return;
      }
      const view = renderEditCard(monitor, lang);
      await ctx.reply(view.text, view.keyboard ? { reply_markup: view.keyboard } : undefined);
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  bot.command('check', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const arg = (ctx.match ?? '').trim();
      const id = Number(arg);
      if (!arg || !Number.isInteger(id)) {
        await ctx.reply(tr(lang).check_usage);
        return;
      }
      const monitor = store.monitors.get(id);
      if (!monitor || monitor.chatId !== chatId) {
        await ctx.reply(tr(lang).check_not_found);
        return;
      }
      // Flood gate: /check forces a synchronous scrape, so throttle repeats.
      if (checkCooldownMs > 0 && checkCooldown.has(chatId)) {
        await ctx.reply(tr(lang).check_rate_limited);
        return;
      }
      if (checkCooldownMs > 0) checkCooldown.set(chatId, true);
      // Poll now (alerts + health notices fire as in a real cycle); reply summary.
      const result = await orchestrator.runMonitorOnce(id);
      await ctx.reply(
        result.ok
          ? tr(lang).check_ok({ items: result.itemsActive, new: result.newItems })
          : tr(lang).check_failed,
      );
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  bot.command('lang', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const arg = (ctx.match ?? '').trim().toLowerCase();
      if (!arg) {
        await ctx.reply(tr(lang).lang_current(tr(lang).lang_name));
        return;
      }
      if (!isLang(arg)) {
        await ctx.reply(tr(lang).lang_usage);
        return;
      }
      store.chatPrefs.setLang(chatId, arg);
      await ctx.reply(tr(arg).lang_set(tr(arg).lang_name));
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  // ── Access control ──────────────────────────────────────────────────────────

  // /request_access — start the name → email capture flow (non-allowed users).
  bot.command('request_access', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      // Already allowed? Nothing to request.
      if (store.access.isAllowed(chatId) || store.access.isAdmin(chatId)) {
        await ctx.reply(tr(lang).access_granted_user);
        return;
      }
      const rec = store.access.get(chatId);
      if (rec?.status === 'pending') {
        await ctx.reply(tr(lang).access_request_pending);
        return;
      }
      // Denied within the 7-day cooldown? Refuse up-front — don't make them fill
      // in name/email only to be told to wait.
      const daysLeft = store.access.cooldownDaysLeft(chatId, Date.now());
      if (daysLeft > 0) {
        await ctx.reply(tr(lang).access_request_too_soon(daysLeft));
        return;
      }
      pendingAccess.set(chatId, { step: 'name' });
      await ctx.reply(tr(lang).access_request_intro + tr(lang).access_ask_name);
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  /** Parse a leading numeric chat-id argument from a command match. */
  const parseId = (raw: string): number | undefined => {
    const n = Number((raw ?? '').trim().split(/\s+/)[0]);
    return Number.isInteger(n) ? n : undefined;
  };

  // /allow <id> — admin grants access; the requester is notified.
  bot.command('allow', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
    try {
      const id = parseId(ctx.match ?? '');
      if (id === undefined) { await ctx.reply(tr(lang).access_allow_usage); return; }
      const now = Date.now();
      store.access.allow(id, { by: chatId, at: now });
      const rec = store.access.get(id);
      store.audit.log('allow', id, chatId, now, rec?.name);
      log('access').info({ chatId: id, action: 'allow', by: chatId }, 'access granted');
      await ctx.reply(tr(lang).access_allow_done({ id, name: rec?.name ?? '' }));
      try { await bot.api.sendMessage(id, tr(langFor(store, id)).access_granted_user); } catch { /* user may have blocked */ }
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  // /deny <id> — admin denies/revokes; the requester is notified.
  bot.command('deny', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
    try {
      const id = parseId(ctx.match ?? '');
      if (id === undefined) { await ctx.reply(tr(lang).access_deny_usage); return; }
      // Destructive → confirm first; the cf:dn callback performs the deny.
      const rec = store.access.get(id);
      await ctx.reply(tr(lang).confirm_deny({ id, name: rec?.name ?? '' }), {
        reply_markup: confirmKeyboard('dn', id, lang),
      });
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  // /users — admin lists everyone with status + tracking fields.
  bot.command('users', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
    try {
      const users = store.access.list();
      if (users.length === 0) { await ctx.reply(tr(lang).access_users_empty); return; }
      const lines = users.map((u) =>
        tr(lang).access_users_item({ id: u.chatId, status: u.status, isAdmin: u.isAdmin, name: u.name ?? '', email: u.email ?? '' }),
      );
      await ctx.reply(`${tr(lang).access_users_intro}\n\n${lines.join('\n')}`);
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  // /audit — admin reads the recent access-decision audit trail.
  bot.command('audit', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
    try {
      const entries = store.audit.recent(20);
      if (entries.length === 0) { await ctx.reply(tr(lang).audit_empty); return; }
      const lines = entries.map((e) =>
        tr(lang).audit_item({
          action: e.action,
          targetId: e.targetChatId,
          actorId: e.actorChatId,
          at: new Date(e.at).toISOString().replace('T', ' ').slice(0, 19),
        }),
      );
      await ctx.reply(`${tr(lang).audit_intro}\n\n${lines.join('\n')}`);
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  // /userinfo <id> — admin views one user's full record.
  bot.command('userinfo', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
    try {
      const id = parseId(ctx.match ?? '');
      if (id === undefined) { await ctx.reply(tr(lang).access_userinfo_usage); return; }
      const u = store.access.get(id);
      if (!u) { await ctx.reply(tr(lang).access_user_not_found); return; }
      await ctx.reply(tr(lang).access_userinfo({ id: u.chatId, status: u.status, isAdmin: u.isAdmin, name: u.name ?? '', email: u.email ?? '' }));
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  // /setname <id> <name> — admin edits a user's tracking name.
  bot.command('setname', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
    try {
      const parts = (ctx.match ?? '').trim().split(/\s+/);
      const id = parseId(parts[0] ?? '');
      const name = parts.slice(1).join(' ').trim();
      if (id === undefined || !name) { await ctx.reply(tr(lang).access_setname_usage); return; }
      store.access.setName(id, name);
      log('access').info({ chatId: id, action: 'setname', by: chatId }, 'user name edited');
      await ctx.reply(tr(lang).access_setname_done({ id, name }));
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  // /setemail <id> <email> — admin edits a user's tracking email (format-checked).
  bot.command('setemail', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
    try {
      const parts = (ctx.match ?? '').trim().split(/\s+/);
      const id = parseId(parts[0] ?? '');
      const email = (parts[1] ?? '').trim();
      if (id === undefined || !email) { await ctx.reply(tr(lang).access_setemail_usage); return; }
      if (!looksLikeEmail(email)) { await ctx.reply(tr(lang).access_email_invalid); return; }
      store.access.setEmail(id, email);
      log('access').info({ chatId: id, action: 'setemail', by: chatId }, 'user email edited');
      await ctx.reply(tr(lang).access_setemail_done({ id, email }));
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  // /promote <id> — admin makes another chat an admin (only admins can do this).
  bot.command('promote', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
    try {
      const id = parseId(ctx.match ?? '');
      if (id === undefined) { await ctx.reply(tr(lang).access_promote_usage); return; }
      store.access.promote(id);
      store.audit.log('promote', id, chatId, Date.now());
      log('access').info({ chatId: id, action: 'promote', by: chatId }, 'user promoted to admin');
      await ctx.reply(tr(lang).access_promote_done({ id }));
      try { await bot.api.sendMessage(id, tr(langFor(store, id)).access_promoted_user); } catch { /* blocked */ }
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  // /demote <id> — admin removes another chat's admin rights (never the last admin,
  // and an admin cannot demote themselves — both guard against orphaning the bot).
  bot.command('demote', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
    try {
      const id = parseId(ctx.match ?? '');
      if (id === undefined) { await ctx.reply(tr(lang).access_demote_usage); return; }
      // Pre-validate the guards up-front so the user doesn't confirm a no-op.
      if (id === chatId) { await ctx.reply(tr(lang).access_demote_last_admin); return; } // no self-demote
      if (!store.access.isAdmin(id)) { await ctx.reply(tr(lang).access_demote_done({ id })); return; } // already not admin
      // Destructive → confirm first; the cf:dm callback performs the demote.
      await ctx.reply(tr(lang).confirm_demote(id), { reply_markup: confirmKeyboard('dm', id, lang) });
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  // ── Callback queries (inline keyboard taps) ─────────────────────────────────

  // Access allow/deny from the admin notification: al:<id> / dn:<id> (admin-only).
  bot.callbackQuery(/^(al|dn):(-?\d+)$/, async (ctx) => {
    const adminChatId = ctx.chat?.id ?? 0;
    const lang = langFor(store, adminChatId);
    try {
      if (!isAdmin(adminChatId)) { await ctx.answerCallbackQuery(tr(lang).access_admin_only); return; }
      const action = ctx.match[1];
      const id = Number(ctx.match[2]);
      if (action === 'al') {
        const now = Date.now();
        store.access.allow(id, { by: adminChatId, at: now });
        store.audit.log('allow', id, adminChatId, now);
        log('access').info({ chatId: id, action: 'allow', by: adminChatId }, 'access granted');
        await ctx.answerCallbackQuery(tr(lang).cb_allow_done({ id }));
        try { await bot.api.sendMessage(id, tr(langFor(store, id)).access_granted_user); } catch { /* blocked */ }
      } else {
        const now = Date.now();
        store.access.deny(id, { by: adminChatId, at: now });
        store.audit.log('deny', id, adminChatId, now);
        log('access').info({ chatId: id, action: 'deny', by: adminChatId }, 'access denied');
        await ctx.answerCallbackQuery(tr(lang).cb_deny_done({ id }));
        try { await bot.api.sendMessage(id, tr(langFor(store, id)).access_denied_user); } catch { /* blocked */ }
      }
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Seller visibility: sv:<monitorId>:<private|company|both>
  bot.callbackQuery(/^sv:(\d+):(private|company|both)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const visibility = ctx.match[2] ?? '';
      if (!isSellerVisibility(visibility)) {
        await ctx.answerCallbackQuery(tr(lang).cb_unknown_option);
        return;
      }

      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }

      monitor.filters.sellerVisibility = visibility;
      store.monitors.update(monitor);

      await ctx.answerCallbackQuery(tr(lang).cb_seller_set(visibility));
      // Re-render the keyboard with the now-active option marked so the user sees
      // the new state. Passing the changed markup also avoids Telegram's
      // "message is not modified" 400 that re-sending identical markup triggers.
      await ctx.editMessageReplyMarkup({
        reply_markup: registrationKeyboard(
          monitorId,
          lang,
          visibility,
          Math.round(monitor.intervalMs / 60000),
        ),
      });
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Check frequency: fq:<monitorId>:<minutes>
  bot.callbackQuery(/^fq:(\d+):(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const minutes = Number(ctx.match[2]);

      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }

      monitor.intervalMs = minutes * 60000;
      store.monitors.update(monitor);
      store.monitors.setSchedule(monitor.id, Date.now() + monitor.intervalMs, monitor.fastTier);

      await ctx.answerCallbackQuery(tr(lang).cb_freq_set(minutes));
      await ctx.editMessageReplyMarkup({
        reply_markup: registrationKeyboard(
          monitorId,
          lang,
          monitor.filters.sellerVisibility,
          minutes,
        ),
      });
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Edit-card seller visibility: esv:<monitorId>:<vis> — same mutation as sv: but
  // re-renders the EDIT keyboard (no "Start", type-tailored) instead of the
  // registration card.
  bot.callbackQuery(/^esv:(\d+):(private|company|both)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const visibility = ctx.match[2] ?? '';
      if (!isSellerVisibility(visibility)) {
        await ctx.answerCallbackQuery(tr(lang).cb_unknown_option);
        return;
      }
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      monitor.filters.sellerVisibility = visibility;
      store.monitors.update(monitor);
      await ctx.answerCallbackQuery(tr(lang).cb_seller_set(visibility));
      await ctx.editMessageReplyMarkup({ reply_markup: editKeyboard(monitor, lang) });
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Edit-card check frequency: efq:<monitorId>:<minutes> — mutate + reschedule,
  // then re-render the EDIT keyboard.
  bot.callbackQuery(/^efq:(\d+):(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const minutes = Number(ctx.match[2]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      monitor.intervalMs = minutes * 60000;
      store.monitors.update(monitor);
      store.monitors.setSchedule(monitor.id, Date.now() + monitor.intervalMs, monitor.fastTier);
      await ctx.answerCallbackQuery(tr(lang).cb_freq_set(minutes));
      await ctx.editMessageReplyMarkup({ reply_markup: editKeyboard(monitor, lang) });
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Edit-card deals-only toggle: eo:<monitorId> (search watches).
  bot.callbackQuery(/^eo:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      const next = !(monitor.filters.dealsOnly === true);
      monitor.filters.dealsOnly = next;
      store.monitors.update(monitor);
      await ctx.answerCallbackQuery(next ? tr(lang).cb_deals_on : tr(lang).cb_deals_off);
      await ctx.editMessageReplyMarkup({ reply_markup: editKeyboard(monitor, lang) });
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Edit-card pause/resume toggle: ep:<monitorId>. Resuming re-arms the next poll
  // for now so it does not wait out the old interval.
  bot.callbackQuery(/^ep:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      const nowPaused = !monitor.paused;
      store.monitors.setPaused(monitorId, nowPaused);
      if (!nowPaused) store.monitors.setSchedule(monitorId, Date.now(), monitor.fastTier);
      monitor.paused = nowPaused;
      await ctx.answerCallbackQuery(nowPaused ? tr(lang).cb_paused : tr(lang).cb_resumed);
      await ctx.editMessageReplyMarkup({ reply_markup: editKeyboard(monitor, lang) });
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Edit-card rename: er:<monitorId> → prompt + remember the pending state.
  bot.callbackQuery(/^er:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      pendingRename.set(ctx.chat?.id ?? monitor.chatId, monitorId);
      await ctx.answerCallbackQuery();
      await ctx.reply(tr(lang).rename_prompt);
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Edit done: ed — acknowledge and collapse the editor (clear its keyboard).
  bot.callbackQuery(/^ed$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      await ctx.answerCallbackQuery(tr(lang).cb_edit_done);
      try { await ctx.editMessageReplyMarkup(); } catch { /* already cleared / expired */ }
    } catch { /* expired */ }
  });

  // Exclusion keywords: ex:<monitorId> → prompt + remember the pending state.
  bot.callbackQuery(/^ex:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      pendingExclusion.set(ctx.chat?.id ?? monitor.chatId, monitorId);
      await ctx.answerCallbackQuery();
      await ctx.reply(tr(lang).exclusion_prompt);
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Required keywords: eq:<monitorId> → prompt + remember the pending state.
  bot.callbackQuery(/^eq:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      pendingRequired.set(ctx.chat?.id ?? monitor.chatId, monitorId);
      await ctx.answerCallbackQuery();
      await ctx.reply(tr(lang).required_prompt);
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Block seller: eb:<monitorId> → prompt + remember the pending state.
  bot.callbackQuery(/^eb:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      pendingBlock.set(ctx.chat?.id ?? monitor.chatId, monitorId);
      await ctx.answerCallbackQuery();
      await ctx.reply(tr(lang).block_prompt);
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Remove monitor button: rm:<monitorId> — prompts a confirmation (the cf:rm
  // callback performs the delete), only for a watch owned by this chat.
  bot.callbackQuery(/^rm:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id ?? 0;
    const lang = langFor(store, chatId);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== chatId) {
        await ctx.answerCallbackQuery(tr(lang).remove_not_found);
        return;
      }
      await ctx.answerCallbackQuery();
      await ctx.reply(tr(lang).confirm_remove(monitorId), {
        reply_markup: confirmKeyboard('rm', monitorId, lang),
      });
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Cancel a pending confirmation: cx (no-op beyond acknowledging).
  bot.callbackQuery(/^cx$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try { await ctx.answerCallbackQuery(tr(lang).cb_cancelled); } catch { /* expired */ }
  });

  // Confirmed destructive action: cf:<rm|dn|dm>:<id>. Re-validate ownership /
  // admin / guards here — never trust the action solely from the callback data.
  bot.callbackQuery(/^cf:(rm|dn|dm):(-?\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id ?? 0;
    const lang = langFor(store, chatId);
    try {
      const action = ctx.match[1];
      const id = Number(ctx.match[2]);
      if (action === 'rm') {
        const monitor = store.monitors.get(id);
        if (!monitor || monitor.chatId !== chatId) { await ctx.answerCallbackQuery(tr(lang).remove_not_found); return; }
        store.monitors.delete(id);
        log('cycle').info({ monitorId: id, chatId, action: 'remove' }, 'monitor removed');
        await ctx.answerCallbackQuery(tr(lang).cb_removed);
        return;
      }
      // dn / dm are admin-only.
      if (!isAdmin(chatId)) { await ctx.answerCallbackQuery(tr(lang).access_admin_only); return; }
      if (action === 'dn') {
        const now = Date.now();
        store.access.deny(id, { by: chatId, at: now });
        store.audit.log('deny', id, chatId, now);
        log('access').info({ chatId: id, action: 'deny', by: chatId }, 'access denied');
        await ctx.answerCallbackQuery(tr(lang).cb_deny_done({ id }));
        try { await bot.api.sendMessage(id, tr(langFor(store, id)).access_denied_user); } catch { /* blocked */ }
        return;
      }
      // action === 'dm'
      if (id === chatId || !store.access.demote(id)) { await ctx.answerCallbackQuery(tr(lang).access_demote_last_admin); return; }
      store.audit.log('demote', id, chatId, Date.now());
      log('access').info({ chatId: id, action: 'demote', by: chatId }, 'user demoted from admin');
      await ctx.answerCallbackQuery(tr(lang).access_demote_done({ id }));
      try { await bot.api.sendMessage(id, tr(langFor(store, id)).access_demoted_user); } catch { /* blocked */ }
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Start monitoring: go:<monitorId>
  bot.callbackQuery(/^go:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      await ctx.answerCallbackQuery(tr(lang).cb_monitoring_started);
    } catch {
      // Best effort — an expired callback query is not worth surfacing.
    }
  });

  // Price history: pg:<vendor>:<id> OR pg:<id>
  bot.callbackQuery(/^pg:/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      // Last colon-segment is always the item id (vendor may be empty/omitted).
      const data = ctx.callbackQuery.data;
      const parts = data.split(':');
      const itemId = parts[parts.length - 1] ?? '';
      await ctx.answerCallbackQuery();

      // The price chart needs the monitor id; resolve it from this chat's
      // monitors that have history for the item (first match wins).
      const chatId = ctx.chat?.id;
      const monitors = chatId !== undefined ? store.monitors.listByChat(chatId) : [];
      let points: ReturnType<Store['priceHistory']['history']> = [];
      for (const m of monitors) {
        // Cap the loaded rows: a long-lived item's history is bounded before it
        // reaches the renderer (which also downsamples) so a Pi can't OOM here.
        const h = store.priceHistory.history(m.id, itemId, PRICE_HISTORY_RENDER_CAP);
        if (h.length > 0) {
          points = h;
          break;
        }
      }

      const result = renderPriceHistory(points);
      if (result.ok) {
        await ctx.replyWithPhoto(new InputFile(result.png));
      } else {
        await ctx.reply(tr(lang).price_history_insufficient);
      }
    } catch (err) {
      // Surface the failure: a canvas OOM or a Telegram photo-send error here is
      // otherwise invisible to the operator (the user just sees a generic note).
      log('gateway').error(
        { chatId: ctx.chat?.id, err: (err as Error).message },
        'price history render/send failed',
      );
      await ctx.reply(tr(lang).price_history_error);
    }
  });

  // Browse navigation: br:<index> — show that item from the open session.
  bot.callbackQuery(/^br:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      await ctx.answerCallbackQuery();
      if (chatId === undefined) return;
      if (!browseSessions.has(chatId)) {
        // Session expired — prompt a fresh /browse rather than act on a stale index.
        await ctx.reply(tr(lang).browse_empty);
        return;
      }
      await sendBrowseItem(ctx, chatId, Number(ctx.match[1]));
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // Browse track: tk:<index> — turn the browsed item into a tracked product watch.
  bot.callbackQuery(/^tk:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      if (chatId === undefined) { await ctx.answerCallbackQuery(); return; }
      const items = browseSessions.get(chatId);
      const item = items?.[Number(ctx.match[1])];
      if (!item || !item.url) {
        await ctx.answerCallbackQuery(tr(lang).browse_gone);
        return;
      }
      // Already tracking this exact URL? Don't create a duplicate watch.
      const dup = store.monitors
        .listByChat(chatId)
        .some((m) => m.origin === 'tracked' && m.url === item.url);
      if (dup) {
        await ctx.answerCallbackQuery(tr(lang).browse_track_exists);
        return;
      }
      const result = await orchestrator.register({ chatId, rawUrl: item.url, type: 'product', origin: 'tracked' });
      await ctx.answerCallbackQuery();
      if (!result.ok) {
        await ctx.reply(result.reason === 'quota' ? tr(lang).quota_reached(maxMonitorsPerChat) : tr(lang).track_error);
        return;
      }
      await ctx.reply(tr(lang).browse_track_done(item.title ?? item.itemId));
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // Browse scope select: bs:all | bs:<monitorId> — load that scope and show item 0.
  bot.callbackQuery(/^bs:(all|\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      await ctx.answerCallbackQuery();
      if (chatId === undefined) return;
      const target = ctx.match[1]!;
      if (target === 'all') {
        await startBrowseSession(ctx, chatId, store.items.browse(chatId, BROWSE_WINDOW, 0));
        return;
      }
      const monitorId = Number(target);
      // Ownership check: only scope to a watch that belongs to this chat.
      if (!store.monitors.listByChat(chatId).some((m) => m.id === monitorId)) {
        await ctx.reply(tr(lang).cb_watch_gone);
        return;
      }
      await startBrowseSession(ctx, chatId, store.items.browseByMonitor(monitorId, BROWSE_WINDOW, 0));
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // Browse switch: bw — re-open the scope picker mid-browse.
  bot.callbackQuery(/^bw$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      await ctx.answerCallbackQuery();
      if (chatId === undefined) return;
      const { total, scopes } = buildBrowseScopes(chatId);
      if (total === 0) {
        await ctx.reply(tr(lang).browse_empty);
        return;
      }
      const view = renderBrowseScope(scopes, lang);
      await ctx.reply(view.text, view.keyboard ? { reply_markup: view.keyboard } : undefined);
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // Browse jump: bj — prompt for an item number; the reply is consumed below.
  bot.callbackQuery(/^bj$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      if (chatId === undefined) { await ctx.answerCallbackQuery(); return; }
      const items = browseSessions.get(chatId);
      if (!items || items.length === 0) {
        await ctx.answerCallbackQuery();
        await ctx.reply(tr(lang).browse_empty);
        return;
      }
      pendingJump.set(chatId, items.length);
      await ctx.answerCallbackQuery();
      await ctx.reply(tr(lang).browse_jump_prompt(items.length));
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // ── Plain text: pending exclusion reply, or a URL to watch ──────────────────

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    const text = ctx.message.text;

    try {
      // 0. Are we mid-way through the /request_access name/email capture?
      const flow = pendingAccess.get(chatId);
      if (flow !== undefined) {
        if (flow.step === 'name') {
          pendingAccess.set(chatId, { step: 'email', name: text.trim() });
          await ctx.reply(tr(lang).access_ask_email);
          return;
        }
        // step === 'email': validate, then persist the request (enforces cooldown).
        if (!looksLikeEmail(text)) {
          await ctx.reply(tr(lang).access_email_invalid);
          return; // stay on the email step
        }
        const name = flow.name ?? '';
        const email = text.trim();
        pendingAccess.delete(chatId);

        // Bootstrap: the FIRST person to complete a request (when no admin exists
        // yet) is auto-approved AND becomes the admin. Their name/email is still
        // recorded for the user table.
        if (!store.access.hasAnyAdmin()) {
          store.access.setName(chatId, name);
          store.access.setEmail(chatId, email);
          store.access.seedAdmin(chatId);
          store.audit.log('bootstrap_admin', chatId, chatId, Date.now(), name);
          log('access').info({ chatId, action: 'bootstrap_admin' }, 'first requester became admin');
          await ctx.reply(tr(lang).access_first_admin);
          return;
        }

        const result = store.access.request(chatId, { name, email }, Date.now());
        if (result.outcome === 'too_soon') {
          await ctx.reply(tr(lang).access_request_too_soon(result.daysLeft));
          return;
        }
        if (result.outcome === 'already_allowed') {
          await ctx.reply(tr(lang).access_granted_user);
          return;
        }
        log('access').info({ chatId, action: 'request' }, 'access requested');
        await ctx.reply(tr(lang).access_request_sent);
        // Notify admins with inline allow/deny buttons.
        const kb = new InlineKeyboard()
          .text(tr('ro').btn_allow, `al:${chatId}`)
          .text(tr('ro').btn_deny, `dn:${chatId}`);
        await notifyAdmins(tr('ro').access_admin_new_request({ id: chatId, name, email }), kb);
        return;
      }

      // 1. Are we waiting for this chat to send exclusion keywords?
      const pendingMonitorId = pendingExclusion.get(chatId);
      if (pendingMonitorId !== undefined) {
        pendingExclusion.delete(chatId);
        const monitor = store.monitors.get(pendingMonitorId);
        if (!monitor) {
          await ctx.reply(tr(lang).cb_watch_gone);
          return;
        }
        monitor.filters.exclusionKeywords = parseExclusionInput(text);
        store.monitors.update(monitor);
        const kw = monitor.filters.exclusionKeywords;
        await replyChunked(
          (t) => ctx.reply(t),
          kw.length > 0 ? tr(lang).exclusion_set(kw.join(', ')) : tr(lang).exclusion_cleared,
        );
        return;
      }

      // 1b. Are we waiting for a browse "jump to #" number?
      if (pendingJump.has(chatId)) {
        const items = browseSessions.get(chatId);
        if (!items || items.length === 0) {
          pendingJump.delete(chatId);
          await ctx.reply(tr(lang).browse_empty);
          return;
        }
        const n = Number(text.trim());
        if (!Number.isInteger(n) || n < 1 || n > items.length) {
          await ctx.reply(tr(lang).browse_jump_invalid(items.length)); // stay armed to retry
          return;
        }
        pendingJump.delete(chatId);
        await sendBrowseItem(ctx, chatId, n - 1); // 1-based input → 0-based index
        return;
      }

      // 1c. Are we waiting for a watch rename?
      const renameMonitorId = pendingRename.get(chatId);
      if (renameMonitorId !== undefined) {
        pendingRename.delete(chatId);
        const monitor = store.monitors.get(renameMonitorId);
        if (!monitor || monitor.chatId !== chatId) {
          await ctx.reply(tr(lang).cb_watch_gone);
          return;
        }
        const raw = text.trim();
        const label = raw === '-' ? '' : raw.slice(0, 40); // cap to keep /list tidy
        store.monitors.setLabel(renameMonitorId, label);
        await ctx.reply(label ? tr(lang).rename_done(label) : tr(lang).rename_cleared);
        return;
      }

      // 1d. Are we waiting for required keywords?
      const requiredMonitorId = pendingRequired.get(chatId);
      if (requiredMonitorId !== undefined) {
        pendingRequired.delete(chatId);
        const monitor = store.monitors.get(requiredMonitorId);
        if (!monitor || monitor.chatId !== chatId) {
          await ctx.reply(tr(lang).cb_watch_gone);
          return;
        }
        const kw = text.trim() === '-' ? [] : parseExclusionInput(text);
        monitor.filters.requiredKeywords = kw;
        store.monitors.update(monitor);
        await replyChunked(
          (t) => ctx.reply(t),
          kw.length > 0 ? tr(lang).required_set(kw.join(', ')) : tr(lang).required_cleared,
        );
        return;
      }

      // 1e. Are we waiting for a seller/phone to block?
      const blockMonitorId = pendingBlock.get(chatId);
      if (blockMonitorId !== undefined) {
        pendingBlock.delete(chatId);
        const monitor = store.monitors.get(blockMonitorId);
        if (!monitor || monitor.chatId !== chatId) {
          await ctx.reply(tr(lang).cb_watch_gone);
          return;
        }
        const entry = text.trim();
        if (entry === '-') {
          monitor.filters.blockedSellers = [];
          monitor.filters.blockedPhones = [];
          store.monitors.update(monitor);
          await ctx.reply(tr(lang).block_cleared);
          return;
        }
        // 6+ digits → treat as a phone; otherwise a seller display name.
        const digitCount = (entry.match(/\d/g) ?? []).length;
        if (digitCount >= 6) {
          const phones = monitor.filters.blockedPhones ?? [];
          if (!phones.some((p) => phoneKey(p) === phoneKey(entry))) phones.push(entry);
          monitor.filters.blockedPhones = phones;
          store.monitors.update(monitor);
          await ctx.reply(tr(lang).block_added_phone(entry));
        } else {
          const name = entry.toLowerCase();
          const sellers = monitor.filters.blockedSellers ?? [];
          if (!sellers.includes(name)) sellers.push(name);
          monitor.filters.blockedSellers = sellers;
          store.monitors.update(monitor);
          await ctx.reply(tr(lang).block_added_seller(entry));
        }
        return;
      }

      // 2. Route by message kind.
      const kind = classifyMessage(text);
      if (kind === 'url') {
        // Flood gate: registering a watch runs a baseline scrape, so throttle
        // rapid URL pastes per chat.
        if (urlRegisterCooldownMs > 0 && urlCooldown.has(chatId)) {
          await ctx.reply(tr(lang).url_rate_limited);
          return;
        }
        if (urlRegisterCooldownMs > 0) urlCooldown.set(chatId, true);
        await handleTrack(
          orchestrator, chatId, text, lang,
          (t, keyboard) => ctx.reply(t, keyboard ? { reply_markup: keyboard } : undefined),
          maxMonitorsPerChat,
        );
        return;
      }
      if (kind === 'command') {
        // An unrecognized slash-command (the six known ones are handled above).
        await ctx.reply(tr(lang).unknown_command);
        return;
      }

      // 3. Anything else: gentle nudge toward the supported flow.
      await ctx.reply(tr(lang).send_link_hint);
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  return bot;
}

/**
 * Build the notification sink the orchestrator dispatches through: render each
 * {@link Notification} with the PURE renderer (in the recipient chat's resolved
 * language) and send it to its chat.
 *
 * For a `cross_post`, the original alert (identified by `messageRef`) is edited
 * in place to append the new source. For all other kinds a fresh message is
 * sent and its {@link MessageRef} is returned so the orchestrator can later edit
 * it when a cross-post arrives.
 */
export function makeNotifier(
  bot: Bot,
  store: Store,
): (n: Notification) => Promise<MessageRef | void> {
  return async (n: Notification) => {
    const lang = resolveLang(store.chatPrefs.getLang(n.chatId));
    const { text, keyboard } = renderNotification(n, lang);

    if (n.kind === 'cross_post' && n.messageRef) {
      try {
        await bot.api.editMessageText(n.messageRef.chatId, n.messageRef.messageId, text, {
          reply_markup: keyboard,
        });
        log('notifier').info({ chatId: n.chatId, kind: n.kind, itemId: n.item?.id }, 'alert edited');
      } catch (err) {
        // The original may be gone or unchanged; appending a source is best-effort.
        log('notifier').warn(
          { chatId: n.chatId, kind: n.kind, err: (err as Error).message },
          'alert edit failed',
        );
      }
      return;
    }

    try {
      const msg = await bot.api.sendMessage(n.chatId, text, { reply_markup: keyboard });
      log('notifier').info({ chatId: n.chatId, kind: n.kind, itemId: n.item?.id }, 'alert sent');
      return { chatId: n.chatId, messageId: msg.message_id };
    } catch (err) {
      log('notifier').error(
        { chatId: n.chatId, kind: n.kind, err: (err as Error).message },
        'alert send failed',
      );
      return;
    }
  };
}
