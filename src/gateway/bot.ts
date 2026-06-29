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
import type { MessageRef, Monitor, Notification, SellerVisibility, EnrichedItem } from '../contracts';
import type { ItemSnapshot, Store } from '../persistence';
import type { Orchestrator } from '../orchestrator';
import { parseExclusionInput, phoneKey, snapshotHidden } from '../pipeline';
import { renderNotification, renderRegistrationCard, renderBrowseCard, renderDelistCard, renderBrowseScope, renderEditCard, listSummaryLine, renderPicker } from './render';
import { computeTrend, renderTrendBadge } from '../features/trend';
import { buildWeeklyReport } from '../features/weeklyReport';
import { runBackup, stageRestore } from '../features/backup';
import { sellerReputation, SELLER_FAST_MS } from '../features/sellerReputation';
import { unlink } from 'node:fs/promises';
import { toCsv } from '../util/csv';
import { formatMoney } from '../util/money';
import { findCheaperEquivalents, titleTokens } from '../features/cheaperFinder';
import { ratePrice } from '../features/priceRating';
import { bestDeals } from '../features/bestDeals';
import { marketInsight } from '../features/marketInsight';
import { parseNumericAttrs, inferCategory, hedonicFairValue } from '../features/fairValue';
import { registrationKeyboard, editKeyboard, confirmKeyboard, browseScopeLabel, browseKeyboard, frequencyPickerKeyboard, homeKeyboard, backHomeKeyboard, statsKeyboard, bestDealsKeyboard, langPickerKeyboard, groupPickerKeyboard, sellerMenuKeyboard, reportsMenuKeyboard, listKeyboard, favoritesKeyboard, quickActionsKeyboard, type BrowseScope, type PickerSession, type PickerOption, type IdCommand } from './keyboards';
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

/** Per-chat de-listing review carousel: the snapshots of the items that dropped. */
const delistSessions = new ExpiringMap<number, ItemSnapshot[]>(PENDING_TTL_MS);

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

/** Chats awaiting a share / unshare target-chat-id reply (chat id → monitor id). */
const pendingShare = new ExpiringMap<number, number>(PENDING_TTL_MS);
const pendingUnshare = new ExpiringMap<number, number>(PENDING_TTL_MS);

/** Chats awaiting a note reply for a browsed item (chat id → {monitorId, itemId}). */
const pendingNote = new ExpiringMap<number, { monitorId: number; itemId: string }>(PENDING_TTL_MS);

/** Chats awaiting a collection-name reply for a watch (chat id → monitor id). */
const pendingGroup = new ExpiringMap<number, number>(PENDING_TTL_MS);

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

  // A chat may manage a watch's config if it owns it OR is a collaborator (editor)
  // subscriber. Used by the edit-card filter callbacks; destructive/ownership
  // actions (remove, share) stay owner-only.
  const canManage = (monitor: Monitor, chatId: number | undefined): boolean =>
    chatId !== undefined && (monitor.chatId === chatId || store.watchSubscribers.isEditor(monitor.id, chatId));

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
    // The home menu's "request access" button (idx:access) is also a request entry.
    const isAccessBtn = ctx.callbackQuery?.data === 'idx:access';
    if (isStart || isRequest || isChatId || isAccessBtn || (midFlow && !text.startsWith('/'))) return next();

    // Refuse everything else. Answer callback queries so the spinner clears.
    if (ctx.callbackQuery) {
      try { await ctx.answerCallbackQuery(tr(lang).access_denied); } catch { /* expired */ }
    } else {
      try { await ctx.reply(tr(lang).access_denied); } catch { /* best effort */ }
    }
    return; // do NOT call next() — handler chain stops here
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  // Render the home/index menu in place (used by /start, the home back arrow,
  // and the language picker). Edits the current message; falls back to a fresh
  // reply when there's nothing editable (or the edit is a no-op).
  const renderHome = async (
    ctx: {
      editMessageText: (t: string, o?: object) => Promise<unknown>;
      reply: (t: string, o?: object) => Promise<unknown>;
    },
    chatId: number,
    lang: Lang,
  ): Promise<void> => {
    const markup = { reply_markup: homeKeyboard(lang, hasAccess(chatId)) };
    try { await ctx.editMessageText(tr(lang).start_welcome, markup); }
    catch { try { await ctx.reply(tr(lang).start_welcome, markup); } catch { /* expired */ } }
  };

  bot.command('start', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    // The index/home menu: action buttons routing to each command. Request-access
    // is offered only when the chat isn't allowed yet.
    await ctx.reply(tr(lang).start_welcome, { reply_markup: homeKeyboard(lang, hasAccess(chatId)) });
  });

  // Home/index router: idx:<action> runs the matching command's flow in place.
  bot.callbackQuery(/^idx:(home|list|browse|saved|stats|help|lang|access)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      if (chatId === undefined) { await ctx.answerCallbackQuery(); return; }
      await ctx.answerCallbackQuery();
      switch (ctx.match[1]) {
        case 'home': await renderHome(ctx, chatId, lang); break;
        case 'list': await editListPicker(ctx, chatId, langFor(store, chatId)); break;
        case 'browse': await runBrowse(ctx, chatId); break;
        case 'saved': {
          // Edit the home message into the saved list (back arrow → home). Long
          // lists fall back to a fresh chunked reply.
          const text = buildSavedText(chatId, lang) ?? tr(lang).saved_empty;
          try { await ctx.editMessageText(text, { reply_markup: backHomeKeyboard() }); }
          catch { await runSaved(ctx, chatId); }
          break;
        }
        case 'stats': await ctx.editMessageText(buildStatsText(chatId, lang), { reply_markup: statsKeyboard(lang) }); break;
        case 'help': await ctx.editMessageText(tr(lang).help_body, { reply_markup: backHomeKeyboard() }); break;
        // Language is a fixed set → show a button picker in place, not a text hint.
        case 'lang': await ctx.editMessageText(tr(lang).lang_pick_intro, { reply_markup: langPickerKeyboard(lang) }); break;
        case 'access': await runRequestAccess(ctx, chatId); break;
      }
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // Language picker selection: setlang:<code> sets the chat language and
  // re-renders the home menu in the new language.
  bot.callbackQuery(/^setlang:([a-z]{2})$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const prev = langFor(store, chatId ?? 0);
    try {
      if (chatId === undefined) { await ctx.answerCallbackQuery(); return; }
      const code = ctx.match[1];
      if (!isLang(code)) { await ctx.answerCallbackQuery(tr(prev).lang_usage); return; }
      store.chatPrefs.setLang(chatId, code);
      await ctx.answerCallbackQuery(tr(code).lang_set(tr(code).lang_name));
      await renderHome(ctx, chatId, code);
    } catch {
      try { await ctx.answerCallbackQuery(tr(prev).cb_setting_error); } catch { /* expired */ }
    }
  });

  bot.command('help', async (ctx) => {
    const lang = langFor(store, ctx.chat.id);
    await ctx.reply(tr(lang).help_body, { reply_markup: backHomeKeyboard() });
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

  /** Trend badge for a watch (search-only; a product watch tracks one listing). */
  const trendBadgeFor = (m: Monitor, now: number): string =>
    m.type === 'search' ? renderTrendBadge(computeTrend(store.priceHistory, m.id, now)) : '';

  /**
   * Build the /list picker rows: one per watch, label = its summary line + trend
   * badge. Ungrouped first, then grouped (collection name sorted) with a 📁 prefix
   * so collection membership survives the flattening into a button list.
   */
  const mkRow = (m: Monitor, lang: Lang, now: number): { id: number; label: string } => ({
    id: m.id,
    label: listSummaryLine(m, lang, trendBadgeFor(m, now)),
  });

  const listRowsFor = (chatId: number, lang: Lang, now: number): Array<{ id: number; label: string }> =>
    store.monitors.listByChat(chatId)
      .filter((m) => m.type === 'search' && !m.collection)
      .map((m) => mkRow(m, lang, now));

  /** Distinct collections (search watches), sorted — each becomes a 📁 folder. */
  const listCollections = (chatId: number): Array<{ name: string; count: number }> => {
    const counts = new Map<string, number>();
    for (const m of store.monitors.listByChat(chatId)) {
      if (m.type === 'search' && m.collection) counts.set(m.collection, (counts.get(m.collection) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));
  };

  /** Rows for one collection folder: its search watches. */
  const collectionRowsFor = (chatId: number, name: string, lang: Lang, now: number): Array<{ id: number; label: string }> =>
    store.monitors.listByChat(chatId)
      .filter((m) => m.type === 'search' && m.collection === name)
      .map((m) => mkRow(m, lang, now));

  /** Tracked (⭐ starred) watches in the chat. */
  const favoriteMonitors = (chatId: number): Monitor[] =>
    store.monitors.listByChat(chatId).filter((m) => m.type !== 'search');

  /** Favorites sub-list rows: tracked watches with a DETAILED label (the saved
   *  listing's title, not just the vendor — so each is identifiable). */
  const favoriteRowsFor = (chatId: number): Array<{ id: number; label: string }> =>
    favoriteMonitors(chatId).map((m) => {
      const snap = store.items.browseByMonitor(m.id, 1, 0)[0];
      const title = m.label ?? snap?.title ?? m.vendor;
      return { id: m.id, label: `📌 ${title}` };
    });

  const runList = async (ctx: IdCtx, chatId: number): Promise<void> => {
    const lang = langFor(store, chatId);
    try {
      const rows = listRowsFor(chatId, lang, Date.now());
      const favCount = favoriteMonitors(chatId).length;
      const collections = listCollections(chatId);
      if (rows.length === 0 && favCount === 0 && collections.length === 0) {
        await ctx.reply(tr(lang).list_empty);
        return;
      }
      // One compact index: ⭐ Favorites + 📁 collection folders first, then a button
      // per ungrouped search watch. Tapping opens the edit card (lw:<id>).
      await ctx.reply(tr(lang).list_intro, { reply_markup: listKeyboard(rows, lang, favCount, collections) });
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  };
  bot.command('list', (ctx) => runList(ctx, ctx.chat.id));

  /** Render the /list picker by EDITING the current message in place (used from
   *  the home index and the edit card's back button — no new card spawned). */
  const editListPicker = async (
    ctx: { editMessageText: (t: string, o?: object) => Promise<unknown>; reply: (t: string, o?: object) => Promise<unknown> },
    chatId: number,
    lang: Lang,
  ): Promise<void> => {
    const rows = listRowsFor(chatId, lang, Date.now());
    const favCount = favoriteMonitors(chatId).length;
    const collections = listCollections(chatId);
    const hasAny = rows.length > 0 || favCount > 0 || collections.length > 0;
    const markup = hasAny ? { reply_markup: listKeyboard(rows, lang, favCount, collections) } : undefined;
    const text = hasAny ? tr(lang).list_intro : tr(lang).list_empty;
    try { await ctx.editMessageText(text, markup); }
    catch { try { await ctx.reply(text, markup); } catch { /* expired */ } }
  };

  /** Render a collection folder's sub-list (its search watches) in place. */
  const editCollection = async (
    ctx: { editMessageText: (t: string, o?: object) => Promise<unknown>; reply: (t: string, o?: object) => Promise<unknown> },
    chatId: number,
    lang: Lang,
    index: number,
  ): Promise<void> => {
    const name = listCollections(chatId)[index]?.name;
    if (name === undefined) { await editListPicker(ctx, chatId, lang); return; }
    const rows = collectionRowsFor(chatId, name, lang, Date.now());
    const markup = { reply_markup: favoritesKeyboard(rows) }; // rows + ◀️ back to /list
    try { await ctx.editMessageText(`📁 ${name}`, markup); }
    catch { try { await ctx.reply(`📁 ${name}`, markup); } catch { /* expired */ } }
  };

  /** Render the Favorites sub-list (starred singles) in place. */
  const editFavorites = async (
    ctx: { editMessageText: (t: string, o?: object) => Promise<unknown>; reply: (t: string, o?: object) => Promise<unknown> },
    chatId: number,
    lang: Lang,
  ): Promise<void> => {
    const rows = favoriteRowsFor(chatId);
    if (rows.length === 0) { await editListPicker(ctx, chatId, lang); return; }
    const markup = { reply_markup: favoritesKeyboard(rows) };
    try { await ctx.editMessageText(tr(lang).favorites_intro, markup); }
    catch { try { await ctx.reply(tr(lang).favorites_intro, markup); } catch { /* expired */ } }
  };

  // /group <pause|resume|remove> <name> — bulk action on every watch in a collection.
  bot.command('group', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    try {
      const parts = (ctx.match ?? '').trim().split(/\s+/);
      const action = (parts[0] ?? '').toLowerCase();
      const name = parts.slice(1).join(' ').trim();
      if (!name || !['pause', 'resume', 'remove'].includes(action)) { await ctx.reply(tr(lang).group_usage); return; }
      const members = store.monitors.listByCollection(chatId, name);
      if (members.length === 0) { await ctx.reply(tr(lang).group_usage); return; }
      for (const m of members) {
        if (action === 'pause') {
          store.monitors.setPaused(m.id, true);
        } else if (action === 'resume') {
          store.monitors.setPaused(m.id, false);
          store.monitors.setSchedule(m.id, Date.now(), m.fastTier); // re-arm so it polls now
        } else {
          store.monitors.delete(m.id);
          store.watchSubscribers.removeAll(m.id);
          store.digestQueue.removeAll(m.id);
          store.reportState.disable(m.id);
        }
      }
      await ctx.reply(tr(lang).group_done({ count: members.length }));
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  });

  /** Build the (rich) /stats summary text for a chat. */
  const buildStatsText = (chatId: number, lang: Lang): string => {
    const monitors = store.monitors.listByChat(chatId);
    const filtersByMonitor = new Map(monitors.map((m) => [m.id, m.filters]));
    const vendorByMonitor = new Map(monitors.map((m) => [m.id, m.vendor]));
    const now = Date.now();
    const DAY = 86_400_000;
    // One pass over stored items: filtered count, per-vendor + per-currency breakdown,
    // recency (24h/7d), seller split and availability.
    let filtered = 0, new24 = 0, new7 = 0, priv = 0, comp = 0, inStock = 0, total = 0;
    const perVendor = new Map<string, number>();
    const pricesByCcy = new Map<string, number[]>();
    for (const s of store.items.browse(chatId, EXPORT_ROW_CAP, 0)) {
      total++;
      const f = filtersByMonitor.get(s.monitorId);
      if (f && snapshotHidden(s, f)) filtered++;
      const v = vendorByMonitor.get(s.monitorId);
      if (v) perVendor.set(v, (perVendor.get(v) ?? 0) + 1);
      if (s.firstSeen >= now - DAY) new24++;
      if (s.firstSeen >= now - 7 * DAY) new7++;
      if (s.sellerPrivate === true) priv++; else if (s.sellerPrivate === false) comp++;
      if (s.inStock) inStock++;
      if (s.lastPrice > 0) (pricesByCcy.get(s.currency) ?? pricesByCcy.set(s.currency, []).get(s.currency)!).push(s.lastPrice);
    }
    const vendors = [...perVendor.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}: ${n}`).join(' · ');
    // Price range in the dominant (most-collected) currency.
    const dom = [...pricesByCcy.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    let priceRange = '';
    if (dom) {
      const sorted = [...dom[1]].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)]!;
      priceRange = `${dom[0]} ${formatMoney(sorted[0]!, dom[0])} – ${formatMoney(sorted[sorted.length - 1]!, dom[0])} (med ${formatMoney(med, dom[0])})`;
    }

    const summary = tr(lang).stats_summary({
      watches: monitors.length,
      search: monitors.filter((m) => m.type === 'search').length,
      product: monitors.filter((m) => m.type === 'product').length,
      paused: monitors.filter((m) => m.paused).length,
      tracked: monitors.filter((m) => m.origin === 'tracked').length,
      items: store.items.countForChat(chatId),
      filtered,
      saved: store.itemFlags.listSaved(chatId).length,
      vendors,
    });
    const extra = tr(lang).stats_extra({ new24, new7, priv, comp, inStock, total, priceRange });
    return extra ? `${summary}\n${extra}` : summary;
  };

  /** The "best deals" view: statistically cheapest listings in the pool. */
  const buildBestDealsText = (chatId: number, lang: Lang): string => {
    const deals = bestDeals(store.items.browse(chatId, EXPORT_ROW_CAP, 0), 8);
    if (deals.length === 0) return tr(lang).best_deals_empty;
    const lines = deals.map((d, i) =>
      tr(lang).best_deals_line({ rank: i + 1, title: d.title, price: formatMoney(d.price, d.currency), discount: d.discountPct, n: d.n, url: d.url ?? '' }),
    );
    return `${tr(lang).best_deals_intro}\n\n${lines.join('\n\n')}`;
  };

  const runStats = async (ctx: IdCtx, chatId: number): Promise<void> => {
    const lang = langFor(store, chatId);
    try {
      await ctx.reply(buildStatsText(chatId, lang), { reply_markup: statsKeyboard(lang) });
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  };
  bot.command('stats', (ctx) => runStats(ctx, ctx.chat.id));

  // Stats screen: stats:deals opens the best-deals view, stats:back returns to
  // the summary. Both edit the message in place.
  bot.callbackQuery(/^stats:(deals|back)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      if (chatId === undefined) { await ctx.answerCallbackQuery(); return; }
      await ctx.answerCallbackQuery();
      if (ctx.match[1] === 'deals') {
        await ctx.editMessageText(buildBestDealsText(chatId, lang), { reply_markup: bestDealsKeyboard() });
      } else {
        await ctx.editMessageText(buildStatsText(chatId, lang), { reply_markup: statsKeyboard(lang) });
      }
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
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

  /** The saved-items text for a chat, or undefined when there are none. */
  const buildSavedText = (chatId: number, lang: Lang): string | undefined => {
    const lines: string[] = [];
    for (const s of store.itemFlags.listSaved(chatId)) {
      const snap = store.items.getSnapshot(s.monitorId, s.itemId);
      if (!snap) continue;
      const base = tr(lang).saved_item({ title: snap.title ?? snap.itemId, price: formatMoney(snap.lastPrice, snap.currency), url: snap.url ?? '' });
      lines.push(s.note ? `${base}\n📝 ${s.note}` : base);
    }
    return lines.length === 0 ? undefined : `${tr(lang).saved_intro}\n\n${lines.join('\n\n')}`;
  };

  const runSaved = async (ctx: IdCtx, chatId: number): Promise<void> => {
    const lang = langFor(store, chatId);
    try {
      const text = buildSavedText(chatId, lang);
      if (text === undefined) { await ctx.reply(tr(lang).saved_empty, { reply_markup: backHomeKeyboard() }); return; }
      // Chunk for length; the back button rides the final chunk.
      const chunks = splitForTelegram(text);
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        await ctx.reply(chunks[i]!, last ? { reply_markup: backHomeKeyboard() } : undefined);
      }
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  };
  bot.command('saved', (ctx) => runSaved(ctx, ctx.chat.id));

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
  /** Render the browse card for `index` in the chat's session (clamped), or
   * undefined when the session is empty. Pure of any send/edit side effect. */
  const browseViewFor = (chatId: number, index: number): ReturnType<typeof renderBrowseCard> | undefined => {
    const lang = langFor(store, chatId);
    const items = browseSessions.get(chatId);
    if (!items || items.length === 0) return undefined;
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
    return renderBrowseCard(snap, i, items.length, lang, canSwitch, rating, fairValue, saved);
  };

  const sendBrowseItem = async (
    ctx: { reply: (t: string, o?: object) => Promise<unknown>; replyWithPhoto: (p: InputFile, o?: object) => Promise<unknown> },
    chatId: number,
    index: number,
  ): Promise<void> => {
    const view = browseViewFor(chatId, index);
    if (!view) {
      await ctx.reply(tr(langFor(store, chatId)).browse_empty);
      return;
    }
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
   * Navigate the carousel by EDITING the current card in place (so prev/next
   * don't spam new messages). A photo card swaps via editMessageMedia, a text
   * card via editMessageText. When the message TYPE would have to change
   * (photo↔text — adjacent items differ in having an image) an in-place edit is
   * impossible, so it falls back to sending a fresh card.
   */
  const editBrowseItem = async (
    ctx: {
      reply: (t: string, o?: object) => Promise<unknown>;
      replyWithPhoto: (p: InputFile, o?: object) => Promise<unknown>;
      editMessageText: (t: string, o?: object) => Promise<unknown>;
    },
    chatId: number,
    index: number,
  ): Promise<void> => {
    const view = browseViewFor(chatId, index);
    if (!view) {
      await ctx.reply(tr(langFor(store, chatId)).browse_empty);
      return;
    }
    const markup = view.keyboard ? { reply_markup: view.keyboard } : undefined;
    try {
      if (view.photoUrl) {
        // editMessageMedia's InputMedia typing is narrower than this structural
        // ctx; the payload below is a valid InputMediaPhoto.
        const editMedia = (ctx as unknown as {
          editMessageMedia: (media: object, o?: object) => Promise<unknown>;
        }).editMessageMedia;
        await editMedia({ type: 'photo', media: view.photoUrl, caption: view.text }, markup);
      } else {
        await ctx.editMessageText(view.text, markup);
      }
      return;
    } catch {
      // Type mismatch (photo↔text) or unreachable image → post a fresh card.
      await sendBrowseItem(ctx, chatId, index);
    }
  };

  /**
   * Build the scope picker's options for a chat: "All listings" first, then one
   * per watch that has browsable items (newest-watch-first, matching /list order).
   * Returns the chat-wide total alongside, so the caller can short-circuit empties.
   */
  /** Monitor ids that yield browsable result lists — SEARCH watches only. A
   *  tracked single listing (a ⭐ star) is not a "listing to browse". */
  const searchMonitorIds = (chatId: number): Set<number> =>
    new Set(store.monitors.listByChat(chatId).filter((m) => m.type === 'search').map((m) => m.id));

  /** The browse-all pool: newest stored items from SEARCH watches only (capped). */
  const browseAllPool = (chatId: number): ReturnType<typeof store.items.browse> => {
    const ids = searchMonitorIds(chatId);
    return store.items.browse(chatId, EXPORT_ROW_CAP, 0).filter((s) => ids.has(s.monitorId)).slice(0, BROWSE_WINDOW);
  };

  const buildBrowseScopes = (chatId: number): { total: number; scopes: BrowseScope[] } => {
    const counts = store.items.browseCountsByMonitor(chatId);
    const searchWatches = store.monitors.listByChat(chatId).filter((m) => m.type === 'search');
    // Browse covers search-result listings only — exclude tracked single items.
    let total = 0;
    const watchScopes: BrowseScope[] = [];
    for (const m of searchWatches) {
      const count = counts.get(m.id) ?? 0;
      if (count === 0) continue; // a watch with nothing browsable isn't worth a button
      total += count;
      watchScopes.push({ target: m.id, label: m.label ?? browseScopeLabel(m.vendor, m.url), count });
    }
    const scopes: BrowseScope[] = [
      { target: 'all', label: tr(langFor(store, chatId)).btn_browse_all, count: total },
      ...watchScopes,
    ];
    return { total, scopes };
  };

  /** Capture a scope's items as the chat's browse session and show the first card. */
  const startBrowseSession = async (
    ctx: Parameters<typeof sendBrowseItem>[0],
    chatId: number,
    items: ItemSnapshot[],
  ): Promise<void> => {
    const lang = langFor(store, chatId);
    // Hide listings the user has dismissed, plus any that the owning watch's
    // current filters (exclusion / required words, seller block / visibility)
    // would now drop — and tally how many were hidden, per watch.
    const dismissed = store.itemFlags.dismissedIds(chatId);
    const monitorsById = new Map(store.monitors.listByChat(chatId).map((m) => [m.id, m]));
    const visible: ItemSnapshot[] = [];
    const hiddenByMonitor = new Map<number, number>();
    for (const s of items) {
      if (dismissed.has(s.itemId)) continue;
      const monitor = monitorsById.get(s.monitorId);
      if (monitor && snapshotHidden(s, monitor.filters)) {
        hiddenByMonitor.set(s.monitorId, (hiddenByMonitor.get(s.monitorId) ?? 0) + 1);
        continue;
      }
      visible.push(s);
    }
    browseSessions.set(chatId, visible);

    if (hiddenByMonitor.size > 0) {
      let total = 0;
      const lines: string[] = [];
      for (const [monitorId, n] of hiddenByMonitor) {
        total += n;
        const m = monitorsById.get(monitorId);
        const name = m?.label ?? (m ? `${m.vendor} · ${m.type}` : String(monitorId));
        lines.push(`• ${name}: ${n}`);
      }
      await ctx.reply(tr(lang).browse_filtered_notice({ total, breakdown: lines.join('\n') }));
    }
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
        if (!monitor || !canManage(monitor, chatId)) { await ctx.reply(tr(lang).edit_not_found); return; }
        const view = renderEditCard(monitor, lang, trendBadgeFor(monitor, Date.now()));
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

  const runBrowse = async (ctx: Parameters<typeof startBrowseSession>[0], chatId: number): Promise<void> => {
    const lang = langFor(store, chatId);
    try {
      const { total, scopes } = buildBrowseScopes(chatId);
      if (total === 0) {
        await ctx.reply(tr(lang).browse_empty);
        return;
      }
      // With more than one search watch, let the user scope to one or all.
      // With a single one, the picker would be a one-option no-op — browse all.
      if (scopes.length > 2) {
        const view = renderBrowseScope(scopes, lang);
        await ctx.reply(view.text, view.keyboard ? { reply_markup: view.keyboard } : undefined);
        return;
      }
      await startBrowseSession(ctx, chatId, browseAllPool(chatId));
    } catch (err) {
      await ctx.reply(tr(lang).generic_error);
    }
  };
  bot.command('browse', (ctx) => runBrowse(ctx, ctx.chat.id));

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

  /** Subscribe a target chat to a watch; `canEdit` makes it a collaborator (editor). */
  const applyShare = async (ctx: IdCtx, chatId: number, monitorId: number, raw: string, canEdit = false): Promise<void> => {
    const lang = langFor(store, chatId);
    const target = parseChatId(raw);
    if (target === undefined || target === chatId) { await ctx.reply(tr(lang).share_invalid); return; }
    store.watchSubscribers.add(monitorId, target, Date.now(), canEdit);
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
      // /share <id> <chatId> [edit] — a trailing "edit" makes the chat a collaborator.
      if (tokens.length >= 2) { await applyShare(ctx, chatId, id, tokens[1]!, (tokens[2] ?? '').toLowerCase() === 'edit'); return; }
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
  const runRequestAccess = async (ctx: IdCtx, chatId: number): Promise<void> => {
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
  };
  bot.command('request_access', (ctx) => runRequestAccess(ctx, ctx.chat.id));

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
      if (!monitor || !canManage(monitor, ctx.chat?.id)) {
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
      if (!monitor || !canManage(monitor, ctx.chat?.id)) {
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
      if (!monitor || !canManage(monitor, ctx.chat?.id)) {
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
      if (!monitor || !canManage(monitor, ctx.chat?.id)) {
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

  // Interval button → open the collapsed frequency picker (registration / edit),
  // and its back button → return to the originating card.
  const curMinutes = (m: { intervalMs: number }): number => Math.round(m.intervalMs / 60000);
  bot.callbackQuery(/^fqi:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitor = store.monitors.get(Number(ctx.match[1]));
      if (!monitor || !canManage(monitor, ctx.chat?.id)) { await ctx.answerCallbackQuery(tr(lang).cb_watch_gone); return; }
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: frequencyPickerKeyboard(monitor.id, curMinutes(monitor), lang, 'reg') });
    } catch { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); }
  });
  bot.callbackQuery(/^efi:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitor = store.monitors.get(Number(ctx.match[1]));
      if (!monitor || !canManage(monitor, ctx.chat?.id)) { await ctx.answerCallbackQuery(tr(lang).cb_watch_gone); return; }
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: frequencyPickerKeyboard(monitor.id, curMinutes(monitor), lang, 'edit', monitor.paused) });
    } catch { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); }
  });
  bot.callbackQuery(/^fqb:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitor = store.monitors.get(Number(ctx.match[1]));
      if (!monitor || !canManage(monitor, ctx.chat?.id)) { await ctx.answerCallbackQuery(tr(lang).cb_watch_gone); return; }
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: registrationKeyboard(monitor.id, lang, monitor.filters.sellerVisibility, curMinutes(monitor)) });
    } catch { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); }
  });
  // Back to the edit card from any submenu (freq / seller / reports). Restores
  // the card's text+markup; falls back to markup-only when the text is unchanged
  // (Telegram rejects a no-op editMessageText).
  bot.callbackQuery(/^efb:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitor = store.monitors.get(Number(ctx.match[1]));
      if (!monitor || !canManage(monitor, ctx.chat?.id)) { await ctx.answerCallbackQuery(tr(lang).cb_watch_gone); return; }
      await ctx.answerCallbackQuery();
      const view = renderEditCard(monitor, lang, trendBadgeFor(monitor, Date.now()));
      try { await ctx.editMessageText(view.text, view.keyboard ? { reply_markup: view.keyboard } : undefined); }
      catch { try { await ctx.editMessageReplyMarkup({ reply_markup: editKeyboard(monitor, lang) }); } catch { /* unchanged */ } }
    } catch { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); }
  });

  // Edit-card seller submenu open: esm:<id> → swap to the 3 seller options.
  bot.callbackQuery(/^esm:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitor = store.monitors.get(Number(ctx.match[1]));
      if (!monitor || !canManage(monitor, ctx.chat?.id)) { await ctx.answerCallbackQuery(tr(lang).cb_watch_gone); return; }
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: sellerMenuKeyboard(monitor, lang) });
    } catch { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); }
  });

  // Edit-card reports submenu open: erm:<id> → explainer text + Rezumat/Raport toggles.
  bot.callbackQuery(/^erm:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitor = store.monitors.get(Number(ctx.match[1]));
      if (!monitor || !canManage(monitor, ctx.chat?.id)) { await ctx.answerCallbackQuery(tr(lang).cb_watch_gone); return; }
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(tr(lang).reports_menu_intro, { reply_markup: reportsMenuKeyboard(monitor, lang) });
    } catch { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); }
  });

  // Edit-card digest toggle: edg:<monitorId> cycles off → daily → weekly → off.
  // Switching OFF flushes nothing (queued items just resume real-time next cycle);
  // any already-queued items stay until their window flushes or the watch is removed.
  bot.callbackQuery(/^edg:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitor = store.monitors.get(Number(ctx.match[1]));
      if (!monitor || !canManage(monitor, ctx.chat?.id)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      const next = monitor.filters.digest === undefined ? 'daily' : monitor.filters.digest === 'daily' ? 'weekly' : undefined;
      if (next === undefined) delete monitor.filters.digest;
      else monitor.filters.digest = next;
      store.monitors.update(monitor);
      await ctx.answerCallbackQuery(tr(lang).cb_digest_set);
      await ctx.editMessageReplyMarkup({ reply_markup: reportsMenuKeyboard(monitor, lang) });
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
      if (!monitor || !canManage(monitor, ctx.chat?.id)) {
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
      await ctx.editMessageReplyMarkup({ reply_markup: reportsMenuKeyboard(monitor, lang) });
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
      if (!monitor || !canManage(monitor, ctx.chat?.id)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      const nowPaused = !monitor.paused;
      store.monitors.setPaused(monitorId, nowPaused);
      if (!nowPaused) store.monitors.setSchedule(monitorId, Date.now(), monitor.fastTier);
      monitor.paused = nowPaused;
      await ctx.answerCallbackQuery(nowPaused ? tr(lang).cb_paused : tr(lang).cb_resumed);
      // ep: lives inside the interval picker now — re-render the picker in place so
      // the Pause/Resume label flips and the user stays on that screen. (The ⏸
      // marker in the card text refreshes when they tap back, via renderEditCard.)
      await ctx.editMessageReplyMarkup({
        reply_markup: frequencyPickerKeyboard(monitorId, curMinutes(monitor), lang, 'edit', nowPaused),
      });
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
      if (!monitor || !canManage(monitor, ctx.chat?.id)) {
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

  // Distinct, sorted collection names across a chat's watches — the option list
  // for the group picker. Selection is by index, so the egs: handler re-derives
  // this same list to resolve a tapped index back to a name.
  const groupNames = (chatId: number): string[] =>
    [...new Set(store.monitors.listByChat(chatId).map((m) => m.collection).filter((c): c is string => !!c))].sort();

  // Edit-card group: egr:<monitorId> → show a picker of existing groups (one tap
  // to join) instead of prompting. Only "new group" (egn:) asks for text.
  bot.callbackQuery(/^egr:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      const monitor = store.monitors.get(Number(ctx.match[1]));
      if (!monitor || !canManage(monitor, chatId)) { await ctx.answerCallbackQuery(tr(lang).cb_watch_gone); return; }
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: groupPickerKeyboard(monitor, groupNames(chatId ?? monitor.chatId), lang) });
    } catch { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); }
  });

  // Group picker "new group": egn:<monitorId> → drop to the text prompt.
  bot.callbackQuery(/^egn:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || !canManage(monitor, ctx.chat?.id)) { await ctx.answerCallbackQuery(tr(lang).cb_watch_gone); return; }
      pendingGroup.set(ctx.chat?.id ?? monitor.chatId, monitorId);
      await ctx.answerCallbackQuery();
      await ctx.reply(tr(lang).group_prompt);
    } catch { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); }
  });

  // Group picker selection: egs:<monitorId>:<index> joins an existing group by
  // index (index -1 clears the group). Then restores the edit card.
  bot.callbackQuery(/^egs:(\d+):(-?\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const idx = Number(ctx.match[2]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || !canManage(monitor, chatId)) { await ctx.answerCallbackQuery(tr(lang).cb_watch_gone); return; }
      if (idx === -1) {
        store.monitors.setCollection(monitorId, '');
        await ctx.answerCallbackQuery(tr(lang).group_cleared);
      } else {
        const name = groupNames(chatId ?? monitor.chatId)[idx];
        if (name === undefined) {
          // List shifted since render — re-show the current picker.
          await ctx.answerCallbackQuery();
          await ctx.editMessageReplyMarkup({ reply_markup: groupPickerKeyboard(monitor, groupNames(chatId ?? monitor.chatId), lang) });
          return;
        }
        store.monitors.setCollection(monitorId, name);
        await ctx.answerCallbackQuery(tr(lang).group_set(name));
      }
      const fresh = store.monitors.get(monitorId) ?? monitor;
      await ctx.editMessageReplyMarkup({ reply_markup: editKeyboard(fresh, lang) });
    } catch { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); }
  });

  // Edit done: ed — acknowledge and collapse the editor (clear its keyboard).
  // Done (Gata) → navigate back to the /start index/home menu.
  bot.callbackQuery(/^ed$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      await ctx.answerCallbackQuery(tr(lang).cb_edit_done);
      if (chatId !== undefined) await renderHome(ctx, chatId, lang);
    } catch { /* expired */ }
  });

  // /list row → open the edit card: le:<monitorId>.
  // /list picker: lw:<id> opens the watch's edit card directly (rich summary +
  // controls — the list detail and the edit card are now one screen); lw:back
  // returns to the picker. Both edit the single message in place (no new cards).
  // /list collection folder: lcf:<index> opens that collection's sub-list.
  bot.callbackQuery(/^lcf:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      if (chatId === undefined) { await ctx.answerCallbackQuery(); return; }
      await ctx.answerCallbackQuery();
      await editCollection(ctx, chatId, lang, Number(ctx.match[1]));
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  bot.callbackQuery(/^lw:(back|fav|\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      if (chatId === undefined) { await ctx.answerCallbackQuery(); return; }
      if (ctx.match[1] === 'back') {
        await ctx.answerCallbackQuery();
        await editListPicker(ctx, chatId, lang);
        return;
      }
      if (ctx.match[1] === 'fav') {
        await ctx.answerCallbackQuery();
        await editFavorites(ctx, chatId, lang);
        return;
      }
      const monitor = store.monitors.get(Number(ctx.match[1]));
      if (!monitor || !canManage(monitor, chatId)) { await ctx.answerCallbackQuery(tr(lang).cb_watch_gone); return; }
      await ctx.answerCallbackQuery();
      const view = renderEditCard(monitor, lang, trendBadgeFor(monitor, Date.now()));
      await ctx.editMessageText(view.text, view.keyboard ? { reply_markup: view.keyboard } : undefined);
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // le:<id> — open the edit card as a fresh message (used by the /edit picker).
  bot.callbackQuery(/^le:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor || !canManage(monitor, ctx.chat?.id)) {
        await ctx.answerCallbackQuery(tr(lang).cb_watch_gone);
        return;
      }
      await ctx.answerCallbackQuery();
      const view = renderEditCard(monitor, lang, trendBadgeFor(monitor, Date.now()));
      await ctx.reply(view.text, view.keyboard ? { reply_markup: view.keyboard } : undefined);
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
      if (!monitor || !canManage(monitor, ctx.chat?.id)) {
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
      await editBrowseItem(ctx, chatId, Number(ctx.match[1]));
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // De-listing review nav: dlb:<index> — prev/next across the dropped items.
  bot.callbackQuery(/^dlb:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      await ctx.answerCallbackQuery();
      if (chatId === undefined) return;
      const snaps = delistSessions.get(chatId);
      if (!snaps || snaps.length === 0) { await ctx.reply(tr(lang).browse_empty); return; }
      const i = Math.max(0, Math.min(Number(ctx.match[1]), snaps.length - 1));
      const view = renderDelistCard(snaps[i]!, i, snaps.length, lang);
      const markup = view.keyboard ? { reply_markup: view.keyboard } : undefined;
      if (view.photoUrl) {
        try { await ctx.replyWithPhoto(new InputFile(new URL(view.photoUrl)), { caption: view.text, ...markup }); return; }
        catch { /* bad image → text fallback */ }
      }
      await ctx.reply(view.text, markup);
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // New-listing alert ⭐ Save: nsv:<monitorId>:<itemId>. Same star = save + track
  // as browse's bsv:, but keyed by the stored item ref (an alert has no browse
  // session). Replaces the useless empty price history on a fresh listing.
  bot.callbackQuery(/^nsv:(\d+):(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      if (chatId === undefined) { await ctx.answerCallbackQuery(); return; }
      const monitorId = Number(ctx.match[1]);
      const itemId = ctx.match[2]!;
      const snap = store.items.getSnapshot(monitorId, itemId);
      if (!snap) { await ctx.answerCallbackQuery(tr(lang).browse_gone); return; }
      const trackedFor = (url: string): Monitor | undefined =>
        store.monitors.listByChat(chatId).find((m) => m.origin === 'tracked' && m.url === url);
      const nowSaved = !store.itemFlags.has(chatId, itemId, 'saved');
      let toast = nowSaved ? tr(lang).cb_saved : tr(lang).cb_unsaved;
      if (nowSaved) {
        store.itemFlags.set(chatId, itemId, monitorId, 'saved', Date.now());
        if (snap.url && !trackedFor(snap.url)) {
          const result = await orchestrator.register({ chatId, rawUrl: snap.url, type: 'product', origin: 'tracked' });
          if (!result.ok) toast = result.reason === 'quota' ? tr(lang).quota_reached(maxMonitorsPerChat) : tr(lang).track_error;
        }
      } else {
        store.itemFlags.unset(chatId, itemId, 'saved');
        if (snap.url) { const m = trackedFor(snap.url); if (m) store.monitors.delete(m.id); }
      }
      await ctx.answerCallbackQuery(toast);
      // Flip the alert's ⭐ button in place (a minimal item carries what the
      // keyboard reads: id / url / phone).
      const item = { id: itemId, url: snap.url ?? '', ...(snap.phone ? { phone: snap.phone } : {}) } as EnrichedItem;
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: quickActionsKeyboard(item, lang, { monitorId, itemId, saved: nowSaved }) });
      } catch { /* not modified / expired */ }
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // Browse star toggle: bsv:<index>. Star = save + track (starred ⇒ tracked):
  // turning it on shortlists the item AND registers a tracked product watch;
  // turning it off un-shortlists AND removes that watch. Quota failures keep the
  // shortlist flag (favoriting is local) and report the limit.
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
      const trackedFor = (url: string) =>
        store.monitors.listByChat(chatId).find((m) => m.origin === 'tracked' && m.url === url);
      let toast = nowSaved ? tr(lang).cb_saved : tr(lang).cb_unsaved;
      if (nowSaved) {
        store.itemFlags.set(chatId, snap.itemId, snap.monitorId, 'saved', Date.now());
        // Start tracking too, unless this URL is already a tracked watch.
        if (snap.url && !trackedFor(snap.url)) {
          const result = await orchestrator.register({ chatId, rawUrl: snap.url, type: 'product', origin: 'tracked' });
          if (!result.ok) toast = result.reason === 'quota' ? tr(lang).quota_reached(maxMonitorsPerChat) : tr(lang).track_error;
        }
      } else {
        store.itemFlags.unset(chatId, snap.itemId, 'saved');
        // Stop tracking the matching watch, if any.
        if (snap.url) { const m = trackedFor(snap.url); if (m) store.monitors.delete(m.id); }
      }
      await ctx.answerCallbackQuery(toast);
      const canSwitch = store.monitors.listByChat(chatId).length > 1;
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: browseKeyboard(idx, items!.length, snap.url ?? '', lang, canSwitch, nowSaved) });
      } catch { /* not modified / expired */ }
    } catch {
      try { await ctx.answerCallbackQuery(tr(lang).cb_setting_error); } catch { /* expired */ }
    }
  });

  // Browse note: bnt:<index> — attach a free-text note to the item (saves it too).
  bot.callbackQuery(/^bnt:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      if (chatId === undefined) { await ctx.answerCallbackQuery(); return; }
      const snap = browseSessions.get(chatId)?.[Number(ctx.match[1])];
      if (!snap) { await ctx.answerCallbackQuery(tr(lang).browse_gone); return; }
      pendingNote.set(chatId, { monitorId: snap.monitorId, itemId: snap.itemId });
      await ctx.answerCallbackQuery();
      await ctx.reply(tr(lang).note_prompt);
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

  // Browse Done → back to the /start home index.
  bot.callbackQuery(/^bdone$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const lang = langFor(store, chatId ?? 0);
    try {
      await ctx.answerCallbackQuery();
      if (chatId !== undefined) await renderHome(ctx, chatId, lang);
    } catch { /* expired */ }
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
        await startBrowseSession(ctx, chatId, browseAllPool(chatId));
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

      // 1c-group. Awaiting a collection name for a watch?
      const groupMonitorId = pendingGroup.get(chatId);
      if (groupMonitorId !== undefined) {
        pendingGroup.delete(chatId);
        const monitor = store.monitors.get(groupMonitorId);
        if (!monitor || monitor.chatId !== chatId) { await ctx.reply(tr(lang).cb_watch_gone); return; }
        const raw = text.trim();
        const name = raw === '-' ? '' : raw.slice(0, 40);
        store.monitors.setCollection(groupMonitorId, name);
        await ctx.reply(name ? tr(lang).group_set(name) : tr(lang).group_cleared);
        return;
      }

      // 1c-note. Awaiting a note for a browsed item?
      const noteTarget = pendingNote.get(chatId);
      if (noteTarget !== undefined) {
        pendingNote.delete(chatId);
        const raw = text.trim();
        const note = raw === '-' ? '' : raw.slice(0, 200);
        store.itemFlags.setNote(chatId, noteTarget.itemId, noteTarget.monitorId, note, Date.now());
        await ctx.reply(note ? tr(lang).note_set : tr(lang).note_cleared);
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

    // De-listing: show a browse-style carousel (photo + specs) of the gone items,
    // seeded into a per-chat session the dlb: nav pages through.
    if (n.kind === 'listings_dropped' && n.dropped) {
      const snaps = n.dropped.itemIds
        .map((id) => store.items.getSnapshot(n.dropped!.monitorId, id))
        .filter((s): s is ItemSnapshot => s !== undefined);
      if (snaps.length === 0) {
        try { await bot.api.sendMessage(n.chatId, tr(lang).listings_dropped_title(n.dropped.count, n.dropped.vendor)); } catch { /* blocked */ }
        return;
      }
      delistSessions.set(n.chatId, snaps);
      const view = renderDelistCard(snaps[0]!, 0, snaps.length, lang);
      const markup = view.keyboard ? { reply_markup: view.keyboard } : undefined;
      try {
        if (view.photoUrl) await bot.api.sendPhoto(n.chatId, new InputFile(new URL(view.photoUrl)), { caption: view.text, ...markup });
        else await bot.api.sendMessage(n.chatId, view.text, markup);
      } catch {
        try { await bot.api.sendMessage(n.chatId, view.text, markup); } catch { /* blocked */ }
      }
      return;
    }

    const rendered = renderNotification(n, lang);
    const { keyboard } = rendered;
    // Surface a saved-item note on its alerts (price drop / back in stock / re-list),
    // so a remembered detail resurfaces exactly when the item moves.
    let text = rendered.text;
    if (n.item) {
      const note = store.itemFlags.getNote(n.chatId, n.item.id);
      if (note) text += `\n📝 ${note}`;
      // Seller reputation from their track record across listings.
      const stats = store.items.sellerStats(
        { ...(n.item.phone ? { phone: n.item.phone } : {}), ...(n.item.sellerName ? { name: n.item.sellerName } : {}) },
        SELLER_FAST_MS,
      );
      const rep = sellerReputation(stats);
      if (rep.trust === 'good') text += `\n${tr(lang).seller_trust_good}`;
      else if (rep.trust === 'caution') text += `\n${tr(lang).seller_trust_caution}`;
    }

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
