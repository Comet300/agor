/**
 * Telegram Bot Gateway (Phase 8).
 *
 * Wires the grammY long-polling bot to the {@link Orchestrator} and the
 * persistence {@link Store}. This is the only place that touches the Telegram
 * API; all message bodies come from the PURE renderers in `./render`, and all
 * domain work is delegated to the orchestrator / store.
 *
 * Conversational state: a single command-less affordance — pasting a URL
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

/** Whether a string is one of the three valid seller-visibility values. */
function isSellerVisibility(v: string): v is SellerVisibility {
  return v === 'private' || v === 'company' || v === 'both';
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
  reply: (text: string, keyboard?: import('./render').RenderedMessage['keyboard']) => Promise<unknown>,
): Promise<void> {
  const result = await orchestrator.register({ chatId, rawUrl });
  if (!result.ok) {
    await reply(result.error);
    return;
  }

  const card = renderRegistrationCard({
    monitorId: result.monitor.id,
    vendor: result.monitor.vendor,
    summary: result.monitor.url,
    baselineCount: result.baselineCount,
  });
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
    await ctx.reply(
      'Welcome to agor.\n\n' +
        'Paste a marketplace search or product link (OLX, AutoVit, Storia…) ' +
        'and I will watch it for new listings, price drops and stock changes.\n\n' +
        'Try /help for the full command list.',
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      'How to use agor:\n\n' +
        '• Paste any http(s) listing link, or use /track <url>, to start a watch.\n' +
        '• After registering, tune the seller type and exclusion keywords, then ' +
        'tap “Start monitoring”.\n' +
        '• /list — show every watch in this chat.\n' +
        '• Tap “Price history” on any alert to get a price chart.',
    );
  });

  bot.command('track', async (ctx) => {
    const chatId = ctx.chat.id;
    const rawUrl = (ctx.match ?? '').trim();
    try {
      if (!rawUrl) {
        await ctx.reply('Usage: /track <url>');
        return;
      }
      await handleTrack(orchestrator, chatId, rawUrl, (text, keyboard) =>
        ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined),
      );
    } catch (err) {
      await ctx.reply('Sorry — I could not register that watch. Please try again.');
    }
  });

  bot.command('list', async (ctx) => {
    try {
      const monitors = store.monitors.listByChat(ctx.chat.id);
      if (monitors.length === 0) {
        await ctx.reply('No watches yet. Paste a listing link to create one.');
        return;
      }
      const lines = monitors.map(
        (m) =>
          `#${m.id} · ${m.vendor} · ${m.type} · ` +
          `seller=${m.filters.sellerVisibility}\n${m.url}`,
      );
      await ctx.reply(`Your watches:\n\n${lines.join('\n\n')}`);
    } catch (err) {
      await ctx.reply('Sorry — I could not list your watches.');
    }
  });

  // ── Callback queries (inline keyboard taps) ─────────────────────────────────

  // Seller visibility: sv:<monitorId>:<private|company|both>
  bot.callbackQuery(/^sv:(\d+):(private|company|both)$/, async (ctx) => {
    try {
      const monitorId = Number(ctx.match[1]);
      const visibility = ctx.match[2] ?? '';
      if (!isSellerVisibility(visibility)) {
        await ctx.answerCallbackQuery('Unknown option.');
        return;
      }

      const monitor = store.monitors.get(monitorId);
      if (!monitor) {
        await ctx.answerCallbackQuery('That watch no longer exists.');
        return;
      }

      monitor.filters.sellerVisibility = visibility;
      store.monitors.update(monitor);

      await ctx.answerCallbackQuery(`Seller filter: ${visibility}`);
      // Re-render the keyboard with the now-active option marked so the user sees
      // the new state. Passing the changed markup also avoids Telegram's
      // "message is not modified" 400 that re-sending identical markup triggers.
      await ctx.editMessageReplyMarkup({
        reply_markup: registrationKeyboard(monitorId, visibility),
      });
    } catch (err) {
      await ctx.answerCallbackQuery('Could not update that setting.');
    }
  });

  // Exclusion keywords: ex:<monitorId> → prompt + remember the pending state.
  bot.callbackQuery(/^ex:(\d+)$/, async (ctx) => {
    try {
      const monitorId = Number(ctx.match[1]);
      const monitor = store.monitors.get(monitorId);
      if (!monitor) {
        await ctx.answerCallbackQuery('That watch no longer exists.');
        return;
      }
      pendingExclusion.set(ctx.chat?.id ?? monitor.chatId, monitorId);
      await ctx.answerCallbackQuery();
      await ctx.reply(
        'Send a comma-separated list of keywords to exclude (e.g. `damaged, salvage, parts`).',
      );
    } catch (err) {
      await ctx.answerCallbackQuery('Could not start the exclusion prompt.');
    }
  });

  // Start monitoring: go:<monitorId>
  bot.callbackQuery(/^go:(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery('Monitoring started');
    } catch {
      // Best effort — an expired callback query is not worth surfacing.
    }
  });

  // Price history: pg:<vendor>:<id> OR pg:<id>
  bot.callbackQuery(/^pg:/, async (ctx) => {
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
        await ctx.reply('Not enough history yet.');
      }
    } catch (err) {
      await ctx.reply('Could not render the price history.');
    }
  });

  // ── Plain text: pending exclusion reply, or a URL to watch ──────────────────

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    try {
      // 1. Are we waiting for this chat to send exclusion keywords?
      const pendingMonitorId = pendingExclusion.get(chatId);
      if (pendingMonitorId !== undefined) {
        pendingExclusion.delete(chatId);
        const monitor = store.monitors.get(pendingMonitorId);
        if (!monitor) {
          await ctx.reply('That watch no longer exists.');
          return;
        }
        monitor.filters.exclusionKeywords = parseExclusionInput(text);
        store.monitors.update(monitor);
        const kw = monitor.filters.exclusionKeywords;
        await ctx.reply(
          kw.length > 0
            ? `Excluding: ${kw.join(', ')}`
            : 'Cleared all exclusion keywords.',
        );
        return;
      }

      // 2. A plain http(s) URL registers a new watch.
      if (looksLikeUrl(text)) {
        await handleTrack(orchestrator, chatId, text, (t, keyboard) =>
          ctx.reply(t, keyboard ? { reply_markup: keyboard } : undefined),
        );
        return;
      }

      // 3. Anything else: gentle nudge toward the supported flow.
      await ctx.reply('Send me a listing link to watch, or /help for usage.');
    } catch (err) {
      await ctx.reply('Sorry — something went wrong handling that message.');
    }
  });

  return bot;
}

/**
 * Build the notification sink the orchestrator dispatches through: render each
 * {@link Notification} with the PURE renderer and send it to its chat.
 *
 * For a `cross_post`, the original alert (identified by `messageRef`) is edited
 * in place to append the new source. For all other kinds a fresh message is
 * sent and its {@link MessageRef} is returned so the orchestrator can later edit
 * it when a cross-post arrives.
 */
export function makeNotifier(bot: Bot): (n: Notification) => Promise<MessageRef | void> {
  return async (n: Notification) => {
    const { text, keyboard } = renderNotification(n);

    if (n.kind === 'cross_post' && n.messageRef) {
      try {
        await bot.api.editMessageText(n.messageRef.chatId, n.messageRef.messageId, text, {
          reply_markup: keyboard,
        });
      } catch {
        // The original may be gone or unchanged; appending a source is best-effort.
      }
      return;
    }

    const msg = await bot.api.sendMessage(n.chatId, text, { reply_markup: keyboard });
    return { chatId: n.chatId, messageId: msg.message_id };
  };
}
