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
import { Bot, InputFile } from 'grammy';
import type { MessageRef, Notification, SellerVisibility } from '../contracts';
import type { Store } from '../persistence';
import type { Orchestrator } from '../orchestrator';
import { parseExclusionInput } from '../pipeline';
import { renderNotification, renderRegistrationCard } from './render';
import { registrationKeyboard } from './keyboards';
import { renderPriceHistory } from '../features/priceGraph';
import { type Lang, tr, isLang } from './strings';
import { resolveLang } from './lang';
import { log } from '../logging/logger';

/**
 * Chats awaiting an exclusion-keyword reply, keyed by chat id → monitor id.
 * The next plain text message from such a chat is consumed as the CSV keyword
 * input rather than treated as a URL. Module-level by design (one bot process).
 */
const pendingExclusion = new Map<number, number>();

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
): Promise<void> {
  const result = await orchestrator.register({ chatId, rawUrl });
  if (!result.ok) {
    await reply(tr(lang).track_error);
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

/**
 * Build (but do not start) the grammY bot. Caller is responsible for invoking
 * `bot.start()` (long polling) — see `src/index.ts`.
 */
export function buildBot(orchestrator: Orchestrator, store: Store, token: string): Bot {
  const bot = new Bot(token);

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
      await handleTrack(orchestrator, chatId, rawUrl, lang, (text, keyboard) =>
        ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined),
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
        }),
      );
      await ctx.reply(`${tr(lang).list_intro}\n\n${lines.join('\n\n')}`);
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
      store.monitors.delete(id);
      await ctx.reply(tr(lang).remove_done(id));
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

  // ── Callback queries (inline keyboard taps) ─────────────────────────────────

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
      if (!monitor) {
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
      if (!monitor) {
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

  // Exclusion keywords: ex:<monitorId> → prompt + remember the pending state.
  bot.callbackQuery(/^ex:(\d+)$/, async (ctx) => {
    const lang = langFor(store, ctx.chat?.id ?? 0);
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor) {
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

  // Remove monitor: rm:<monitorId> — only if owned by this chat.
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
      store.monitors.delete(monitorId);
      await ctx.answerCallbackQuery(tr(lang).cb_removed);
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
        const h = store.priceHistory.history(m.id, itemId);
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
      await ctx.reply(tr(lang).price_history_error);
    }
  });

  // ── Plain text: pending exclusion reply, or a URL to watch ──────────────────

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    const lang = langFor(store, chatId);
    const text = ctx.message.text;

    try {
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
        await ctx.reply(
          kw.length > 0 ? tr(lang).exclusion_set(kw.join(', ')) : tr(lang).exclusion_cleared,
        );
        return;
      }

      // 2. Route by message kind.
      const kind = classifyMessage(text);
      if (kind === 'url') {
        await handleTrack(orchestrator, chatId, text, lang, (t, keyboard) =>
          ctx.reply(t, keyboard ? { reply_markup: keyboard } : undefined),
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
