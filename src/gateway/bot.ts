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
import type { MessageRef, Monitor, Notification, SellerVisibility } from '../contracts';
import type { ItemSnapshot, Store } from '../persistence';
import type { Orchestrator } from '../orchestrator';
import { parseExclusionInput, phoneKey } from '../pipeline';
import { renderNotification, renderRegistrationCard, renderBrowseCard, renderBrowseScope, renderEditCard, renderListRow, renderPicker } from './render';
import { computeTrend, renderTrendBadge } from '../features/trend';
import { buildWeeklyReport } from '../features/weeklyReport';
import { runBackup, stageRestore } from '../features/backup';
import { unlink } from 'node:fs/promises';
import { toCsv } from '../util/csv';
import { formatMoney } from '../util/money';
import { findCheaperEquivalents, titleTokens } from '../features/cheaperFinder';
import { ratePrice } from '../features/priceRating';
import { marketInsight } from '../features/marketInsight';
import { parseNumericAttrs, inferCategory, hedonicFairValue } from '../features/fairValue';
import { registrationKeyboard, editKeyboard, confirmKeyboard, browseScopeLabel, browseKeyboard, type BrowseScope, type PickerSession, type PickerOption, type IdCommand } from './keyboards';
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

/** Columns + cap for the /export CSV (most-recent listings first). */
const EXPORT_HEADERS = [
  'itemId', 'title', 'price', 'currency', 'inStock', 'location',
  'seller', 'postedAt', 'url', 'firstSeen', 'lastSeen',
] as const;
const EXPORT_ROW_CAP = 5000;

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

/** Chats awaiting a target-price reply (chat id → monitor id). */
const pendingTarget = new ExpiringMap<number, number>(PENDING_TTL_MS);

/** Chats awaiting a price-range / attribute-range reply (chat id → monitor id). */
const pendingPriceRange = new ExpiringMap<number, number>(PENDING_TTL_MS);
const pendingAttrRange = new ExpiringMap<number, number>(PENDING_TTL_MS);

/** Chats awaiting a share / unshare target-chat-id reply (chat id → monitor id). */
const pendingShare = new ExpiringMap<number, number>(PENDING_TTL_MS);
const pendingUnshare = new ExpiringMap<number, number>(PENDING_TTL_MS);

/** Attributes the spec-range filter recognises (parsed numerics). */
const RANGE_ATTRS = ['year', 'km', 'area', 'rooms', 'power'] as const;

/** Parse "min-max" / "5000-" / "-15000" / "5000" → bounds (empty object clears). */
export function parsePriceRange(raw: string): { min?: number; max?: number } | null {
  const t = raw.replace(/\s/g, '');
  if (!t.includes('-')) {
    const n = Number(t.replace(/\D/g, ''));
    return Number.isFinite(n) && n > 0 ? { max: n } : null; // bare number = "under N"
  }
  const [lo, hi] = t.split('-');
  const min = (lo ?? '').replace(/\D/g, '');
  const max = (hi ?? '').replace(/\D/g, '');
  const out: { min?: number; max?: number } = {};
  if (min) out.min = Number(min);
  if (max) out.max = Number(max);
  return out; // {} when both blank → clears
}

/** Parse "year>=2019, km<=120000" → attribute ranges (only recognised attrs). */
export function parseAttrRanges(raw: string): Record<string, { min?: number; max?: number }> {
  const out: Record<string, { min?: number; max?: number }> = {};
  const re = /(year|km|area|rooms|power)\s*(>=|<=|>|<)\s*([\d.\s]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1]!.toLowerCase();
    const v = Number(m[3]!.replace(/\D/g, ''));
    if (!Number.isFinite(v) || !(RANGE_ATTRS as readonly string[]).includes(key)) continue;
    const range = out[key] ?? (out[key] = {});
    if (m[2]!.startsWith('>')) range.min = v;
    else range.max = v;
  }
  return out;
}

/** Open /edit option pickers (watch chooser, block/exclude/require), per chat. */
const pickerSessions = new ExpiringMap<number, PickerSession>(PENDING_TTL_MS);

/** Admins mid-way through /setname or /setemail (chat id → target user id). */
const pendingSetName = new ExpiringMap<number, number>(PENDING_TTL_MS);
const pendingSetEmail = new ExpiringMap<number, number>(PENDING_TTL_MS);

/** Candidate title-words offered in a keyword picker before pagination. */
const PICKER_WORD_CAP = 45;

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
 * Extract the first http(s) URL embedded anywhere in `text` (trailing sentence
 * punctuation stripped), or null. Used by forward-to-track, where a forwarded
 * listing message carries the link amid other text.
 */
export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s]+/);
  if (!m) return null;
  return m[0].replace(/[)\].,;!?]+$/, '');
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
  /** Live SQLite path — needed to stage a /restore for the next boot. */
  databasePath?: string;
  /** Optional directory each /backup snapshot is also copied to. */
  backupLocalDir?: string;
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
  const databasePath = options.databasePath;
  const backupLocalDir = options.backupLocalDir;

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
    // /chatid only echoes this chat's own numeric id (no data leak); it must work
    // in an un-allowed group so a watch owner can read the id to share alerts into.
    const isChatId = text.startsWith('/chatid');
    const midFlow = pendingAccess.has(chatId);
    // Let the request_access entry points and an in-flight name/email reply through.
    if (isStart || isRequest || isChatId || (midFlow && !text.startsWith('/'))) return next();

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
      // Intro, then one message per watch carrying its inline action row
      // (Edit / Pause / Remove) so the user can manage it without typing ids.
      await ctx.reply(tr(lang).list_intro);
      const now = Date.now();
      for (const m of monitors) {
        // Market trend is a per-search-query signal; a product watch tracks one item.
        const badge = m.type === 'search' ? renderTrendBadge(computeTrend(store.priceHistory, m.id, now)) : '';
        const row = renderListRow(m, lang, badge);
        await ctx.reply(row.text, row.keyboard ? { reply_markup: row.keyboard } : undefined);
      }
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  bot.command('stats', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const monitors = store.monitors.listByChat(chatId);
      const vendors = [...new Set(monitors.map((m) => m.vendor))].sort().join(', ');
      await ctx.reply(
        tr(lang).stats_summary({
          watches: monitors.length,
          search: monitors.filter((m) => m.type === 'search').length,
          product: monitors.filter((m) => m.type === 'product').length,
          paused: monitors.filter((m) => m.paused).length,
          tracked: monitors.filter((m) => m.origin === 'tracked').length,
          items: store.items.countForChat(chatId),
          vendors,
        }),
      );
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  bot.command('export', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const items = store.items.browse(chatId, EXPORT_ROW_CAP, 0);
      if (items.length === 0) {
        await ctx.reply(tr(lang).export_empty);
        return;
      }
      const csv = toCsv(EXPORT_HEADERS, items.map((s) => ({
        itemId: s.itemId,
        title: s.title ?? '',
        price: s.lastPrice,
        currency: s.currency,
        inStock: s.inStock ? 'yes' : 'no',
        location: s.location ?? '',
        seller: s.sellerPrivate === undefined ? '' : s.sellerPrivate ? 'private' : 'company',
        postedAt: s.postedAt ? new Date(s.postedAt).toISOString() : '',
        url: s.url ?? '',
        firstSeen: new Date(s.firstSeen).toISOString(),
        lastSeen: new Date(s.lastSeen).toISOString(),
      })));
      await ctx.replyWithDocument(new InputFile(Buffer.from(csv, 'utf8'), 'agor-listings.csv'), {
        caption: tr(lang).export_caption(items.length),
      });
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  bot.command('saved', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const snaps = store.itemFlags
        .listSaved(chatId)
        .map((s) => store.items.getSnapshot(s.monitorId, s.itemId))
        .filter((s): s is NonNullable<typeof s> => s !== undefined);
      if (snaps.length === 0) { await ctx.reply(tr(lang).saved_empty); return; }
      const lines = snaps.map((s) =>
        tr(lang).saved_item({ title: s.title ?? s.itemId, price: formatMoney(s.lastPrice, s.currency), url: s.url ?? '' }),
      );
      await replyChunked((t) => ctx.reply(t), `${tr(lang).saved_intro}\n\n${lines.join('\n\n')}`);
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  bot.command('history', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const id = parseId(ctx.match ?? '');
      if (id === undefined) { await openIdPicker(ctx, chatId, 'history'); return; }
      await runHistory(ctx, chatId, id);
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  bot.command('rate', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const url = (ctx.match ?? '').trim();
      if (!url) {
        await ctx.reply(tr(lang).rate_usage);
        return;
      }
      // Live scrape → throttle like /check.
      if (checkCooldownMs > 0 && checkCooldown.has(chatId)) {
        await ctx.reply(tr(lang).check_rate_limited);
        return;
      }
      if (checkCooldownMs > 0) checkCooldown.set(chatId, true);

      const preview = await orchestrator.previewItem(url);
      if (!preview.ok) {
        await ctx.reply(preview.reason === 'scrape_failed' ? tr(lang).rate_failed : tr(lang).rate_unsupported);
        return;
      }
      const it = preview.item;
      const rating = ratePrice(
        { itemId: it.id, title: it.title, price: it.price, currency: it.currency, ...(it.url ? { url: it.url } : {}) },
        store.items.browse(chatId, BROWSE_WINDOW, 0),
      );
      const line = rating.tag !== 'unknown' && rating.percentile !== undefined
        ? tr(lang).price_rating({ tag: rating.tag, percentile: rating.percentile, n: rating.n, suspicious: rating.suspicious })
        : tr(lang).rate_no_comps;
      await ctx.reply(`${tr(lang).rate_result({ title: it.title, price: formatMoney(it.price, it.currency) })}\n${line}`);
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  bot.command('cheaper', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const id = parseId(ctx.match ?? '');
      if (id === undefined) { await openIdPicker(ctx, chatId, 'cheaper'); return; }
      await runCheaper(ctx, chatId, id);
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
    const snap = items[i]!;
    const pool = store.items.browse(chatId, BROWSE_WINDOW, 0);
    // Rate this item's price against the chat's collected pool (category-agnostic).
    const rating = ratePrice(
      { itemId: snap.itemId, title: snap.title ?? snap.itemId, price: snap.lastPrice, currency: snap.currency, ...(snap.url ? { url: snap.url } : {}) },
      pool,
    );
    // Fair value (v2.1): hedonic comp-adjustment against the same pool.
    const cat = inferCategory(parseNumericAttrs(snap.attributes));
    const fairValue = cat
      ? hedonicFairValue(snap.attributes, snap.lastPrice, snap.currency, pool, store.valuation.get(cat, snap.currency), Date.now())
      : null;
    const saved = store.itemFlags.has(chatId, snap.itemId, 'saved');
    const view = renderBrowseCard(snap, i, items.length, lang, canSwitch, rating, fairValue, saved);
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
    // Hide listings the user has dismissed.
    const dismissed = store.itemFlags.dismissedIds(chatId);
    browseSessions.set(chatId, items.filter((s) => !dismissed.has(s.itemId)));
    await sendBrowseItem(ctx, chatId, 0);
  };

  // ── /edit option pickers ────────────────────────────────────────────────────

  /** Watch-chooser options: every watch in the chat (label, value = monitor id). */
  const buildEditOptions = (chatId: number): PickerOption[] =>
    store.monitors.listByChat(chatId).map((m) => ({
      label: `${m.paused ? '⏸ ' : ''}${m.origin === 'tracked' ? '📌 ' : ''}${m.label ?? `${m.vendor} · ${m.type}`}`,
      value: String(m.id),
    }));

  /** Block-seller options: distinct sellers seen in the watch, ✅ when blocked. */
  const buildBlockOptions = (monitor: Monitor): PickerOption[] => {
    const blockedNames = new Set(monitor.filters.blockedSellers ?? []);
    const blockedPhones = new Set((monitor.filters.blockedPhones ?? []).map(phoneKey));
    return store.items.sellersForMonitor(monitor.id).map((s) => ({
      label: s.count > 1 ? `${s.value} (${s.count})` : s.value,
      value: s.value,
      selected: s.kind === 'name' ? blockedNames.has(s.value.toLowerCase()) : blockedPhones.has(phoneKey(s.value)),
    }));
  };

  /** Keyword options: frequent title words in the watch ∪ already-selected, ✅-marked. */
  const buildWordOptions = (monitor: Monitor, selectedList: string[]): PickerOption[] => {
    const freq = new Map<string, number>();
    for (const s of store.items.browseByMonitor(monitor.id, BROWSE_WINDOW, 0)) {
      for (const w of titleTokens(s.title ?? '')) freq.set(w, (freq.get(w) ?? 0) + 1);
    }
    const selected = new Set(selectedList);
    const frequent = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, PICKER_WORD_CAP).map(([w]) => w);
    const all = [...new Set([...selectedList, ...frequent])];
    return all.map((w) => ({ label: freq.has(w) ? `${w} (${freq.get(w)})` : w, value: w, selected: selected.has(w) }));
  };

  /** (Re)build the option list for a session's kind against the current state. */
  const rebuildPickerOptions = (session: PickerSession): void => {
    if (session.kind === 'command') return; // command pickers are one-shot
    const monitor = store.monitors.get(session.monitorId);
    if (!monitor) return;
    if (session.kind === 'block') session.options = buildBlockOptions(monitor);
    else if (session.kind === 'exclude') session.options = buildWordOptions(monitor, monitor.filters.exclusionKeywords);
    else session.options = buildWordOptions(monitor, monitor.filters.requiredKeywords ?? []);
  };

  /** Open a picker: store the session and send its first page. */
  const openPicker = async (
    ctx: { reply: (t: string, o?: object) => Promise<unknown>; chat?: { id: number } },
    chatId: number,
    session: PickerSession,
  ): Promise<void> => {
    pickerSessions.set(chatId, session);
    const view = renderPicker(session, langFor(store, chatId));
    await ctx.reply(view.text, view.keyboard ? { reply_markup: view.keyboard } : undefined);
  };

  /** Add/remove a keyword in a filter list (toggle). */
  const toggleWord = (list: string[], w: string): string[] =>
    list.includes(w) ? list.filter((x) => x !== w) : [...list, w];

  /** Block or unblock a seller value (phone vs name decided by digit count). */
  const applyBlockToggle = (monitor: Monitor, value: string, currentlySelected: boolean): void => {
    if ((value.match(/\d/g) ?? []).length >= 6) {
      const phones = monitor.filters.blockedPhones ?? [];
      monitor.filters.blockedPhones = currentlySelected
        ? phones.filter((p) => phoneKey(p) !== phoneKey(value))
        : phones.some((p) => phoneKey(p) === phoneKey(value)) ? phones : [...phones, value];
    } else {
      const name = value.toLowerCase();
      const names = monitor.filters.blockedSellers ?? [];
      monitor.filters.blockedSellers = currentlySelected
        ? names.filter((n) => n !== name)
        : names.includes(name) ? names : [...names, name];
    }
    store.monitors.update(monitor);
  };

  // ── ID commands: a no-arg invocation opens a button picker of valid ids ─────

  /** /history core: send the watch item's price chart + a summary caption. */
  const runHistory = async (
    ctx: { reply: (t: string, o?: object) => Promise<unknown>; replyWithPhoto: (p: InputFile, o?: object) => Promise<unknown> },
    chatId: number,
    id: number,
  ): Promise<void> => {
    const lang = langFor(store, chatId);
    const monitor = store.monitors.get(id);
    if (!monitor || monitor.chatId !== chatId) { await ctx.reply(tr(lang).history_not_found); return; }
    const snap = store.items.browseByMonitor(id, 1, 0)[0];
    if (!snap) { await ctx.reply(tr(lang).history_not_found); return; }
    const points = store.priceHistory.history(id, snap.itemId, PRICE_HISTORY_RENDER_CAP);
    const chart = renderPriceHistory(points);
    if (!chart.ok) { await ctx.reply(tr(lang).price_history_insufficient); return; }
    const insight = marketInsight(snap.postedAt, points, Date.now());
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const days = Math.max(0, Math.round((last.observedAt - first.observedAt) / 86_400_000));
    await ctx.replyWithPhoto(new InputFile(chart.png), {
      caption: tr(lang).history_summary({
        title: snap.title ?? snap.itemId,
        first: formatMoney(first.price, first.currency),
        last: formatMoney(last.price, last.currency),
        low: formatMoney(insight.lowestPrice ?? last.price, last.currency),
        cuts: insight.priceCuts,
        points: points.length,
        days,
      }),
    });
  };

  /** /cheaper core: rate the tracked item + list cheaper equivalents from the pool. */
  const runCheaper = async (
    ctx: { reply: (t: string, o?: object) => Promise<unknown> },
    chatId: number,
    id: number,
  ): Promise<void> => {
    const lang = langFor(store, chatId);
    const monitor = store.monitors.get(id);
    if (!monitor || monitor.chatId !== chatId) { await ctx.reply(tr(lang).cheaper_not_found); return; }
    const snap = store.items.browseByMonitor(id, 1, 0)[0];
    if (!snap) { await ctx.reply(tr(lang).cheaper_not_found); return; }
    const pool = store.items.browse(chatId, BROWSE_WINDOW, 0);
    const target = { itemId: snap.itemId, title: snap.title ?? snap.itemId, price: snap.lastPrice, currency: snap.currency, ...(snap.url ? { url: snap.url } : {}) };
    const rating = ratePrice(target, pool);
    const ratingLine = rating.tag !== 'unknown' && rating.percentile !== undefined
      ? tr(lang).price_rating({ tag: rating.tag, percentile: rating.percentile, n: rating.n, suspicious: rating.suspicious }) + '\n'
      : '';
    const matches = findCheaperEquivalents(target, pool);
    if (matches.length === 0) { await ctx.reply(ratingLine + tr(lang).cheaper_none); return; }
    const lines = matches.map((m) => tr(lang).cheaper_item({ title: m.title, price: formatMoney(m.price, m.currency), url: m.url ?? '' }));
    await replyChunked((t) => ctx.reply(t), `${ratingLine}${tr(lang).cheaper_intro(snap.title ?? snap.itemId)}\n\n${lines.join('\n\n')}`);
  };

  /** Product/tracked watches only — for /cheaper. */
  const buildProductOptions = (chatId: number): PickerOption[] =>
    store.monitors.listByChat(chatId).filter((m) => m.type === 'product').map((m) => ({
      label: `${m.label ?? `${m.vendor} · ${m.type}`}`,
      value: String(m.id),
    }));

  /** Access users — for the admin id commands. */
  const buildUserOptions = (): PickerOption[] =>
    store.access.list().map((u) => ({
      label: `${u.name || u.chatId}${u.isAdmin ? ' 👑' : ''} · ${u.status}`,
      value: String(u.chatId),
    }));

  /** Where each id command sources its picker options. */
  const idPickerSource: Record<IdCommand, 'watch' | 'product' | 'user'> = {
    edit: 'watch', remove: 'watch', check: 'watch', history: 'watch', cheaper: 'product',
    share: 'watch', unshare: 'watch', report: 'watch',
    allow: 'user', deny: 'user', promote: 'user', demote: 'user', userinfo: 'user', setname: 'user', setemail: 'user',
  };

  /** Minimal ctx an id-command core needs (text + photo replies). */
  type IdCtx = {
    reply: (t: string, o?: object) => Promise<unknown>;
    replyWithPhoto: (p: InputFile, o?: object) => Promise<unknown>;
  };

  /** Open the right id picker for a command (or reply "empty" when nothing valid). */
  const openIdPicker = async (
    ctx: Parameters<typeof openPicker>[0],
    chatId: number,
    command: IdCommand,
  ): Promise<void> => {
    const lang = langFor(store, chatId);
    const src = idPickerSource[command];
    const options = src === 'user' ? buildUserOptions() : src === 'product' ? buildProductOptions(chatId) : buildEditOptions(chatId);
    if (options.length === 0) {
      await ctx.reply(src === 'user' ? tr(lang).access_users_empty : tr(lang).list_empty);
      return;
    }
    await openPicker(ctx, chatId, {
      kind: 'command', command, monitorId: 0, page: 0, allowType: false, options,
      prompt: src === 'user' ? tr(lang).picker_choose_user : tr(lang).picker_choose_watch,
    });
  };

  /** Run an id command's core against a resolved id (shared by the command + picker). */
  const runIdCommand = async (command: IdCommand, ctx: IdCtx, chatId: number, id: number): Promise<void> => {
    const lang = langFor(store, chatId);
    switch (command) {
      case 'edit': {
        const monitor = store.monitors.get(id);
        if (!monitor || monitor.chatId !== chatId) { await ctx.reply(tr(lang).edit_not_found); return; }
        const view = renderEditCard(monitor, lang);
        await ctx.reply(view.text, view.keyboard ? { reply_markup: view.keyboard } : undefined);
        return;
      }
      case 'remove': {
        const monitor = store.monitors.get(id);
        if (!monitor || monitor.chatId !== chatId) { await ctx.reply(tr(lang).remove_not_found); return; }
        await ctx.reply(tr(lang).confirm_remove(id), { reply_markup: confirmKeyboard('rm', id, lang) });
        return;
      }
      case 'check': {
        const monitor = store.monitors.get(id);
        if (!monitor || monitor.chatId !== chatId) { await ctx.reply(tr(lang).check_not_found); return; }
        if (checkCooldownMs > 0 && checkCooldown.has(chatId)) { await ctx.reply(tr(lang).check_rate_limited); return; }
        if (checkCooldownMs > 0) checkCooldown.set(chatId, true);
        const result = await orchestrator.runMonitorOnce(id);
        await ctx.reply(result.ok ? tr(lang).check_ok({ items: result.itemsActive, new: result.newItems }) : tr(lang).check_failed);
        return;
      }
      case 'history': {
        await runHistory(ctx, chatId, id);
        return;
      }
      case 'cheaper': {
        await runCheaper(ctx, chatId, id);
        return;
      }
      case 'share': {
        const monitor = store.monitors.get(id);
        if (!monitor || monitor.chatId !== chatId) { await ctx.reply(tr(lang).remove_not_found); return; }
        pendingShare.set(chatId, id);
        await ctx.reply(tr(lang).share_prompt);
        return;
      }
      case 'unshare': {
        const monitor = store.monitors.get(id);
        if (!monitor || monitor.chatId !== chatId) { await ctx.reply(tr(lang).remove_not_found); return; }
        const subs = store.watchSubscribers.listChats(id);
        if (subs.length === 0) { await ctx.reply(tr(lang).share_none); return; }
        pendingUnshare.set(chatId, id);
        await ctx.reply(tr(lang).unshare_prompt({ list: subs.join(', ') }));
        return;
      }
      case 'report': {
        const monitor = store.monitors.get(id);
        if (!monitor || monitor.chatId !== chatId) { await ctx.reply(tr(lang).remove_not_found); return; }
        const report = buildWeeklyReport(store, monitor, Date.now());
        if (!report) { await ctx.reply(tr(lang).browse_empty); return; }
        const msg = renderNotification({ kind: 'weekly_report', chatId, report }, lang);
        await ctx.reply(msg.text);
        return;
      }
      case 'allow': {
        if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
        const now = Date.now();
        store.access.allow(id, { by: chatId, at: now });
        const rec = store.access.get(id);
        store.audit.log('allow', id, chatId, now, rec?.name);
        log('access').info({ chatId: id, action: 'allow', by: chatId }, 'access granted');
        await ctx.reply(tr(lang).access_allow_done({ id, name: rec?.name ?? '' }));
        try { await bot.api.sendMessage(id, tr(langFor(store, id)).access_granted_user); } catch { /* blocked */ }
        return;
      }
      case 'deny': {
        if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
        const rec = store.access.get(id);
        await ctx.reply(tr(lang).confirm_deny({ id, name: rec?.name ?? '' }), { reply_markup: confirmKeyboard('dn', id, lang) });
        return;
      }
      case 'promote': {
        if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
        store.access.promote(id);
        store.audit.log('promote', id, chatId, Date.now());
        log('access').info({ chatId: id, action: 'promote', by: chatId }, 'user promoted to admin');
        await ctx.reply(tr(lang).access_promote_done({ id }));
        try { await bot.api.sendMessage(id, tr(langFor(store, id)).access_promoted_user); } catch { /* blocked */ }
        return;
      }
      case 'demote': {
        if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
        if (id === chatId) { await ctx.reply(tr(lang).access_demote_last_admin); return; }
        if (!store.access.isAdmin(id)) { await ctx.reply(tr(lang).access_demote_done({ id })); return; }
        await ctx.reply(tr(lang).confirm_demote(id), { reply_markup: confirmKeyboard('dm', id, lang) });
        return;
      }
      case 'userinfo': {
        if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
        const u = store.access.get(id);
        if (!u) { await ctx.reply(tr(lang).access_user_not_found); return; }
        await ctx.reply(tr(lang).access_userinfo({ id: u.chatId, status: u.status, isAdmin: u.isAdmin, name: u.name ?? '', email: u.email ?? '' }));
        return;
      }
      case 'setname': {
        if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
        pendingSetName.set(chatId, id);
        await ctx.reply(tr(lang).access_setname_prompt({ id }));
        return;
      }
      case 'setemail': {
        if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
        pendingSetEmail.set(chatId, id);
        await ctx.reply(tr(lang).access_setemail_prompt({ id }));
        return;
      }
    }
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
      const id = parseId(ctx.match ?? '');
      if (id === undefined) { await openIdPicker(ctx, chatId, 'remove'); return; }
      await runIdCommand('remove', ctx, chatId, id);
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  bot.command('edit', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const id = parseId(ctx.match ?? '');
      if (id === undefined) { await openIdPicker(ctx, chatId, 'edit'); return; }
      await runIdCommand('edit', ctx, chatId, id);
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  // Parse a target chat id for sharing: any non-zero integer (group ids are
  // negative, e.g. -1001234567890). Returns undefined on garbage.
  const parseChatId = (raw: string): number | undefined => {
    const n = Number((raw ?? '').trim());
    return Number.isInteger(n) && n !== 0 ? n : undefined;
  };

  /** Subscribe a target chat to one of the caller's watches. */
  const applyShare = async (ctx: IdCtx, chatId: number, monitorId: number, raw: string): Promise<void> => {
    const lang = langFor(store, chatId);
    const target = parseChatId(raw);
    if (target === undefined || target === chatId) { await ctx.reply(tr(lang).share_invalid); return; }
    store.watchSubscribers.add(monitorId, target, Date.now());
    await ctx.reply(tr(lang).share_added({ chatId: target, count: store.watchSubscribers.count(monitorId) }));
  };

  /** Unsubscribe a target chat from one of the caller's watches. */
  const applyUnshare = async (ctx: IdCtx, chatId: number, monitorId: number, raw: string): Promise<void> => {
    const lang = langFor(store, chatId);
    const target = parseChatId(raw);
    if (target === undefined || !store.watchSubscribers.remove(monitorId, target)) { await ctx.reply(tr(lang).share_invalid); return; }
    await ctx.reply(tr(lang).share_removed({ count: store.watchSubscribers.count(monitorId) }));
  };

  // /share [<id> [<chatId>]] — fan a watch's alerts out to another chat.
  bot.command('share', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const tokens = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
      const id = parseId(tokens[0] ?? '');
      if (id === undefined) { await openIdPicker(ctx, chatId, 'share'); return; }
      const monitor = store.monitors.get(id);
      if (!monitor || monitor.chatId !== chatId) { await ctx.reply(tr(lang).remove_not_found); return; }
      if (tokens.length >= 2) { await applyShare(ctx, chatId, id, tokens[1]!); return; }
      await runIdCommand('share', ctx, chatId, id); // sets the pending target-chat prompt
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  // /unshare [<id> [<chatId>]] — stop fanning a watch's alerts to a chat.
  bot.command('unshare', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const tokens = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
      const id = parseId(tokens[0] ?? '');
      if (id === undefined) { await openIdPicker(ctx, chatId, 'unshare'); return; }
      const monitor = store.monitors.get(id);
      if (!monitor || monitor.chatId !== chatId) { await ctx.reply(tr(lang).remove_not_found); return; }
      if (tokens.length >= 2) { await applyUnshare(ctx, chatId, id, tokens[1]!); return; }
      await runIdCommand('unshare', ctx, chatId, id);
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  // /chatid — echo this chat's numeric id (so it can be shared into).
  bot.command('chatid', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    await ctx.reply(tr(lang).chat_id_line(chatId));
  });

  // /backup — admin: snapshot the DB and upload it as a Telegram document
  // (and copy it to the local backup dir when configured).
  bot.command('backup', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
    let path: string | undefined;
    try {
      path = await runBackup(store.db, { now: Date.now(), ...(backupLocalDir ? { localDir: backupLocalDir } : {}) });
      await ctx.replyWithDocument(new InputFile(path), { caption: tr(lang).backup_caption });
    } catch (err) {
      log('backup').error({ chatId, err: (err as Error).message }, 'backup failed');
      await ctx.reply(tr(lang).backup_failed);
    } finally {
      if (path) await unlink(path).catch(() => {});
    }
  });

  // /restore <file-path> — admin: validate a backup on the host and stage it for
  // the next boot to apply (a live DB is never overwritten in place).
  bot.command('restore', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
    const src = (ctx.match ?? '').trim();
    if (!src || !databasePath) { await ctx.reply(tr(lang).restore_usage); return; }
    try {
      stageRestore(databasePath, src);
      log('backup').warn({ chatId, src }, 'restore staged for next boot');
      await ctx.reply(tr(lang).restore_staged);
    } catch {
      await ctx.reply(tr(lang).restore_invalid);
    }
  });

  // /report [<id>] — generate a watch's weekly market report on demand.
  bot.command('report', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const id = parseId(ctx.match ?? '');
      if (id === undefined) { await openIdPicker(ctx, chatId, 'report'); return; }
      await runIdCommand('report', ctx, chatId, id);
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  bot.command('check', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const id = parseId(ctx.match ?? '');
      if (id === undefined) { await openIdPicker(ctx, chatId, 'check'); return; }
      await runIdCommand('check', ctx, chatId, id);
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
    const tok = (raw ?? '').trim().split(/\s+/)[0] ?? '';
    if (tok === '') return undefined; // no id → caller opens a picker
    const n = Number(tok);
    return Number.isInteger(n) ? n : undefined;
  };

  // /allow <id> — admin grants access; the requester is notified.
  bot.command('allow', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
    try {
      const id = parseId(ctx.match ?? '');
      if (id === undefined) { await openIdPicker(ctx, chatId, 'allow'); return; }
      await runIdCommand('allow', ctx, chatId, id);
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
      if (id === undefined) { await openIdPicker(ctx, chatId, 'deny'); return; }
      await runIdCommand('deny', ctx, chatId, id);
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
      if (id === undefined) { await openIdPicker(ctx, chatId, 'userinfo'); return; }
      await runIdCommand('userinfo', ctx, chatId, id);
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  // /setname [<id> <name>] — admin edits a user's tracking name (id+name, or pick).
  bot.command('setname', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
    try {
      const parts = (ctx.match ?? '').trim().split(/\s+/);
      const id = parseId(parts[0] ?? '');
      if (id === undefined) { await openIdPicker(ctx, chatId, 'setname'); return; }
      const name = parts.slice(1).join(' ').trim();
      if (!name) { await runIdCommand('setname', ctx, chatId, id); return; } // prompt for the name
      store.access.setName(id, name);
      log('access').info({ chatId: id, action: 'setname', by: chatId }, 'user name edited');
      await ctx.reply(tr(lang).access_setname_done({ id, name }));
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  // /setemail [<id> <email>] — admin edits a user's tracking email (id+email, or pick).
  bot.command('setemail', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    if (!isAdmin(chatId)) { await ctx.reply(tr(lang).access_admin_only); return; }
    try {
      const parts = (ctx.match ?? '').trim().split(/\s+/);
      const id = parseId(parts[0] ?? '');
      if (id === undefined) { await openIdPicker(ctx, chatId, 'setemail'); return; }
      const email = (parts[1] ?? '').trim();
      if (!email) { await runIdCommand('setemail', ctx, chatId, id); return; } // prompt for the email
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
      if (id === undefined) { await openIdPicker(ctx, chatId, 'promote'); return; }
      await runIdCommand('promote', ctx, chatId, id);
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
      if (id === undefined) { await openIdPicker(ctx, chatId, 'demote'); return; }
      await runIdCommand('demote', ctx, chatId, id);
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

  // Edit-card digest toggle: edg:<monitorId> cycles off → daily → weekly → off.
  // Switching OFF flushes nothing (queued items just resume real-time next cycle);
  // any already-queued items stay until their window flushes or the watch is removed.
  bot.callbackQuery(/^edg:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitor = store.monitors.get(Number(ctx.match[1]));
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      const next = monitor.filters.digest === undefined ? 'daily' : monitor.filters.digest === 'daily' ? 'weekly' : undefined;
      if (next === undefined) delete monitor.filters.digest;
      else monitor.filters.digest = next;
      store.monitors.update(monitor);
      await ctx.answerCallbackQuery(tr(lang).cb_digest_set);
      await ctx.editMessageReplyMarkup({ reply_markup: editKeyboard(monitor, lang) });
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Edit-card weekly-report toggle: erp:<monitorId>. The flag drives the button
  // state; the report_state row drives the weekly flush (first one is immediate).
  bot.callbackQuery(/^erp:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitor = store.monitors.get(Number(ctx.match[1]));
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      const on = monitor.filters.weeklyReport !== true;
      if (on) monitor.filters.weeklyReport = true;
      else delete monitor.filters.weeklyReport;
      store.monitors.update(monitor);
      if (on) store.reportState.enable(monitor.id, monitor.chatId);
      else store.reportState.disable(monitor.id);
      await ctx.answerCallbackQuery(tr(lang).cb_report_set);
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

  // /list row → open the edit card: le:<monitorId>.
  bot.callbackQuery(/^le:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      await ctx.answerCallbackQuery();
      const view = renderEditCard(monitor, lang);
      await ctx.reply(view.text, view.keyboard ? { reply_markup: view.keyboard } : undefined);
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // /list row → toggle pause in place: lp:<monitorId> (re-renders the same row).
  bot.callbackQuery(/^lp:(\d+)$/, async (ctx) => {
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
      const row = renderListRow(monitor, lang);
      await ctx.editMessageText(row.text, row.keyboard ? { reply_markup: row.keyboard } : undefined);
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // Exclusion keywords: ex:<monitorId> → word picker (or text prompt if no words).
  bot.callbackQuery(/^ex:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (chatId ?? NaN) || chatId === undefined) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      await ctx.answerCallbackQuery();
      const options = buildWordOptions(monitor, monitor.filters.exclusionKeywords);
      if (options.length === 0) {
        pendingExclusion.set(chatId, monitorId);
        await ctx.reply(tr(lang).exclusion_prompt);
        return;
      }
      await openPicker(ctx, chatId, { kind: 'exclude', monitorId, options, page: 0, allowType: true, prompt: tr(lang).picker_exclude_prompt });
    } catch (err) {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // Required keywords: eq:<monitorId> → word picker (or text prompt if no words).
  bot.callbackQuery(/^eq:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (chatId ?? NaN) || chatId === undefined) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      await ctx.answerCallbackQuery();
      const options = buildWordOptions(monitor, monitor.filters.requiredKeywords ?? []);
      if (options.length === 0) {
        pendingRequired.set(chatId, monitorId);
        await ctx.reply(tr(lang).required_prompt);
        return;
      }
      await openPicker(ctx, chatId, { kind: 'require', monitorId, options, page: 0, allowType: true, prompt: tr(lang).picker_require_prompt });
    } catch (err) {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // Block seller: eb:<monitorId> → seller picker (or text prompt if none known).
  bot.callbackQuery(/^eb:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (chatId ?? NaN) || chatId === undefined) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      await ctx.answerCallbackQuery();
      const options = buildBlockOptions(monitor);
      if (options.length === 0) {
        // No seller identity captured yet — fall back to manual entry.
        pendingBlock.set(chatId, monitorId);
        await ctx.reply(tr(lang).block_prompt);
        return;
      }
      await openPicker(ctx, chatId, { kind: 'block', monitorId, options, page: 0, allowType: true, prompt: tr(lang).picker_block_prompt });
    } catch (err) {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // Picker page nav: kp:<page>.
  bot.callbackQuery(/^kp:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      await ctx.answerCallbackQuery();
      if (chatId === undefined) return;
      const session = pickerSessions.get(chatId);
      if (!session) return;
      session.page = Number(ctx.match[1]);
      const view = renderPicker(session, lang);
      await ctx.editMessageText(view.text, view.keyboard ? { reply_markup: view.keyboard } : undefined);
    } catch {
      try { await ctx.answerCallbackQuery(); } catch { /* expired */ }
    }
  });

  // Picker pick: ki:<index> — open a watch (editpick) or toggle a filter value.
  bot.callbackQuery(/^ki:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      if (chatId === undefined) { await ctx.answerCallbackQuery(); return; }
      const session = pickerSessions.get(chatId);
      const option = session?.options[Number(ctx.match[1])];
      if (!session || !option) { await ctx.answerCallbackQuery(); return; }

      // Command picker: a one-shot id chooser → run the command on the picked id.
      if (session.kind === 'command' && session.command) {
        pickerSessions.delete(chatId);
        await ctx.answerCallbackQuery();
        try { await ctx.editMessageReplyMarkup(); } catch { /* leave the chooser as-is */ }
        await runIdCommand(session.command, ctx, chatId, Number(option.value));
        return;
      }

      const monitor = store.monitors.get(session.monitorId);
      if (!monitor || monitor.chatId !== chatId) {
        pickerSessions.delete(chatId);
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      if (session.kind === 'block') {
        applyBlockToggle(monitor, option.value, option.selected === true);
      } else if (session.kind === 'exclude') {
        monitor.filters.exclusionKeywords = toggleWord(monitor.filters.exclusionKeywords, option.value);
        store.monitors.update(monitor);
      } else {
        monitor.filters.requiredKeywords = toggleWord(monitor.filters.requiredKeywords ?? [], option.value);
        store.monitors.update(monitor);
      }
      rebuildPickerOptions(session);
      await ctx.answerCallbackQuery();
      const view = renderPicker(session, lang);
      try { await ctx.editMessageText(view.text, view.keyboard ? { reply_markup: view.keyboard } : undefined); } catch { /* not modified */ }
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // Picker "type one": kt — fall back to the free-text prompt for this kind.
  bot.callbackQuery(/^kt$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      await ctx.answerCallbackQuery();
      if (chatId === undefined) return;
      const session = pickerSessions.get(chatId);
      if (!session) return;
      pickerSessions.delete(chatId);
      try { await ctx.editMessageReplyMarkup(); } catch { /* expired */ }
      if (session.kind === 'exclude') { pendingExclusion.set(chatId, session.monitorId); await ctx.reply(tr(lang).exclusion_prompt); }
      else if (session.kind === 'require') { pendingRequired.set(chatId, session.monitorId); await ctx.reply(tr(lang).required_prompt); }
      else if (session.kind === 'block') { pendingBlock.set(chatId, session.monitorId); await ctx.reply(tr(lang).block_prompt); }
    } catch {
      try { await ctx.answerCallbackQuery(); } catch { /* expired */ }
    }
  });

  // Picker done: kc — close and clear the keyboard.
  bot.callbackQuery(/^kc$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      if (chatId !== undefined) pickerSessions.delete(chatId);
      await ctx.answerCallbackQuery(tr(lang).cb_edit_done);
      try { await ctx.editMessageReplyMarkup(); } catch { /* expired */ }
    } catch { /* expired */ }
  });

  // Target price (product watch): et:<monitorId> → prompt + remember pending.
  bot.callbackQuery(/^et:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      pendingTarget.set(ctx.chat?.id ?? monitor.chatId, monitorId);
      await ctx.answerCallbackQuery();
      await ctx.reply(tr(lang).target_prompt);
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Price range: epr:<monitorId> → prompt + remember pending.
  bot.callbackQuery(/^epr:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      pendingPriceRange.set(ctx.chat?.id ?? monitor.chatId, monitorId);
      await ctx.answerCallbackQuery();
      await ctx.reply(tr(lang).price_range_prompt);
    } catch (err) {
      await ctx.answerCallbackQuery(tr(lang).cb_setting_error);
    }
  });

  // Attribute (spec) ranges: ear:<monitorId> → prompt + remember pending.
  bot.callbackQuery(/^ear:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || monitor.chatId !== (ctx.chat?.id ?? NaN)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      pendingAttrRange.set(ctx.chat?.id ?? monitor.chatId, monitorId);
      await ctx.answerCallbackQuery();
      await ctx.reply(tr(lang).attr_range_prompt);
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
        store.watchSubscribers.removeAll(id); // drop any shared-watch subscribers
        store.digestQueue.removeAll(id); // drop any parked digest items
        store.reportState.disable(id); // stop any weekly report
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

  // Browse save toggle: bsv:<index> — add/remove the item from the shortlist.
  bot.callbackQuery(/^bsv:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      if (chatId === undefined) { await ctx.answerCallbackQuery(); return; }
      const idx = Number(ctx.match[1]);
      const items = browseSessions.get(chatId);
      const snap = items?.[idx];
      if (!snap) { await ctx.answerCallbackQuery(tr(lang).browse_gone); return; }
      const nowSaved = !store.itemFlags.has(chatId, snap.itemId, 'saved');
      if (nowSaved) store.itemFlags.set(chatId, snap.itemId, snap.monitorId, 'saved', Date.now());
      else store.itemFlags.unset(chatId, snap.itemId, 'saved');
      await ctx.answerCallbackQuery(nowSaved ? tr(lang).cb_saved : tr(lang).cb_unsaved);
      const canSwitch = store.monitors.listByChat(chatId).length > 1;
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: browseKeyboard(idx, items!.length, snap.url ?? '', lang, canSwitch, nowSaved) });
      } catch { /* not modified / expired */ }
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // Browse dismiss: bdm:<index> — hide the item; drop it from the session.
  bot.callbackQuery(/^bdm:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      if (chatId === undefined) { await ctx.answerCallbackQuery(); return; }
      const idx = Number(ctx.match[1]);
      const items = browseSessions.get(chatId);
      const snap = items?.[idx];
      if (!snap) { await ctx.answerCallbackQuery(tr(lang).browse_gone); return; }
      store.itemFlags.set(chatId, snap.itemId, snap.monitorId, 'dismissed', Date.now());
      await ctx.answerCallbackQuery(tr(lang).cb_dismissed);
      const remaining = items!.filter((s) => s.itemId !== snap.itemId);
      browseSessions.set(chatId, remaining);
      if (remaining.length === 0) { await ctx.reply(tr(lang).browse_empty); return; }
      await sendBrowseItem(ctx, chatId, Math.min(idx, remaining.length - 1));
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

      // 1c-share. Awaiting the target chat id to share a watch with?
      const shareMonitorId = pendingShare.get(chatId);
      if (shareMonitorId !== undefined) {
        pendingShare.delete(chatId);
        if (text.trim() === '-') { await ctx.reply(tr(lang).cb_cancelled); return; }
        const monitor = store.monitors.get(shareMonitorId);
        if (!monitor || monitor.chatId !== chatId) { await ctx.reply(tr(lang).cb_watch_gone); return; }
        await applyShare(ctx, chatId, shareMonitorId, text);
        return;
      }

      // 1c-unshare. Awaiting the target chat id to stop sharing with?
      const unshareMonitorId = pendingUnshare.get(chatId);
      if (unshareMonitorId !== undefined) {
        pendingUnshare.delete(chatId);
        if (text.trim() === '-') { await ctx.reply(tr(lang).cb_cancelled); return; }
        const monitor = store.monitors.get(unshareMonitorId);
        if (!monitor || monitor.chatId !== chatId) { await ctx.reply(tr(lang).cb_watch_gone); return; }
        await applyUnshare(ctx, chatId, unshareMonitorId, text);
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

      // 1f-pre. Are we waiting for a target price?
      const targetMonitorId = pendingTarget.get(chatId);
      if (targetMonitorId !== undefined) {
        pendingTarget.delete(chatId);
        const monitor = store.monitors.get(targetMonitorId);
        if (!monitor || monitor.chatId !== chatId) {
          await ctx.reply(tr(lang).cb_watch_gone);
          return;
        }
        const raw = text.trim();
        if (raw === '-') {
          delete monitor.filters.targetPrice;
          store.monitors.update(monitor);
          await ctx.reply(tr(lang).target_cleared);
          return;
        }
        // Prices here are whole numbers; accept any format and keep the digits
        // ("12 000", "12.000", "12,000 lei" → 12000).
        const n = Number(raw.replace(/\D/g, ''));
        if (!Number.isFinite(n) || n <= 0) {
          await ctx.reply(tr(lang).target_invalid); // stay armed to retry
          pendingTarget.set(chatId, targetMonitorId);
          return;
        }
        monitor.filters.targetPrice = n;
        store.monitors.update(monitor);
        await ctx.reply(tr(lang).target_set(n));
        return;
      }

      // 1f-2. Are we waiting for a price range?
      const priceRangeMonitorId = pendingPriceRange.get(chatId);
      if (priceRangeMonitorId !== undefined) {
        pendingPriceRange.delete(chatId);
        const monitor = store.monitors.get(priceRangeMonitorId);
        if (!monitor || monitor.chatId !== chatId) { await ctx.reply(tr(lang).cb_watch_gone); return; }
        if (text.trim() === '-') {
          delete monitor.filters.priceMin;
          delete monitor.filters.priceMax;
          store.monitors.update(monitor);
          await ctx.reply(tr(lang).range_cleared);
          return;
        }
        const range = parsePriceRange(text);
        if (range === null) { await ctx.reply(tr(lang).price_range_prompt); pendingPriceRange.set(chatId, priceRangeMonitorId); return; }
        if (range.min !== undefined) monitor.filters.priceMin = range.min; else delete monitor.filters.priceMin;
        if (range.max !== undefined) monitor.filters.priceMax = range.max; else delete monitor.filters.priceMax;
        store.monitors.update(monitor);
        await ctx.reply(
          monitor.filters.priceMin === undefined && monitor.filters.priceMax === undefined
            ? tr(lang).range_cleared
            : tr(lang).price_range_set({ min: monitor.filters.priceMin, max: monitor.filters.priceMax }),
        );
        return;
      }

      // 1f-3. Are we waiting for attribute (spec) ranges?
      const attrRangeMonitorId = pendingAttrRange.get(chatId);
      if (attrRangeMonitorId !== undefined) {
        pendingAttrRange.delete(chatId);
        const monitor = store.monitors.get(attrRangeMonitorId);
        if (!monitor || monitor.chatId !== chatId) { await ctx.reply(tr(lang).cb_watch_gone); return; }
        if (text.trim() === '-') {
          delete monitor.filters.attrRanges;
          store.monitors.update(monitor);
          await ctx.reply(tr(lang).range_cleared);
          return;
        }
        const ranges = parseAttrRanges(text);
        if (Object.keys(ranges).length === 0) { await ctx.reply(tr(lang).attr_range_prompt); pendingAttrRange.set(chatId, attrRangeMonitorId); return; }
        monitor.filters.attrRanges = ranges;
        store.monitors.update(monitor);
        const summary = Object.entries(ranges)
          .map(([k, r]) => `${k}${r.min !== undefined ? `≥${r.min}` : ''}${r.max !== undefined ? `≤${r.max}` : ''}`)
          .join(', ');
        await ctx.reply(tr(lang).attr_range_set(summary));
        return;
      }

      // 1g. Admin mid-way through a picked /setname or /setemail.
      const setNameTarget = pendingSetName.get(chatId);
      if (setNameTarget !== undefined) {
        pendingSetName.delete(chatId);
        const name = text.trim();
        if (!name) { await ctx.reply(tr(lang).access_setname_usage); return; }
        store.access.setName(setNameTarget, name);
        log('access').info({ chatId: setNameTarget, action: 'setname', by: chatId }, 'user name edited');
        await ctx.reply(tr(lang).access_setname_done({ id: setNameTarget, name }));
        return;
      }
      const setEmailTarget = pendingSetEmail.get(chatId);
      if (setEmailTarget !== undefined) {
        const email = text.trim();
        if (!looksLikeEmail(email)) { await ctx.reply(tr(lang).access_email_invalid); return; } // stay armed
        pendingSetEmail.delete(chatId);
        store.access.setEmail(setEmailTarget, email);
        log('access').info({ chatId: setEmailTarget, action: 'setemail', by: chatId }, 'user email edited');
        await ctx.reply(tr(lang).access_setemail_done({ id: setEmailTarget, email }));
        return;
      }

      // 1f. A FORWARDED message carrying a listing link → track it (the link is
      // usually surrounded by the original post's text, so extract it).
      const fwd = ctx.message as unknown as { forward_origin?: unknown; forward_date?: number };
      if (fwd.forward_origin !== undefined || fwd.forward_date !== undefined) {
        const url = extractUrl(text);
        if (url) {
          if (urlRegisterCooldownMs > 0 && urlCooldown.has(chatId)) {
            await ctx.reply(tr(lang).url_rate_limited);
            return;
          }
          if (urlRegisterCooldownMs > 0) urlCooldown.set(chatId, true);
          await handleTrack(
            orchestrator, chatId, url, lang,
            (t, keyboard) => ctx.reply(t, keyboard ? { reply_markup: keyboard } : undefined),
            maxMonitorsPerChat,
          );
          return;
        }
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
