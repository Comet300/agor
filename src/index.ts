/**
 * agor entrypoint (Phase 8 wiring).
 *
 * Composes the whole system from config:
 *   config → store → plugin registry → proxy pool → scraping engine
 *          → (optional) Telegram bot + notifier → orchestrator.
 *
 * When `BOT_TOKEN` is absent we log a warning and wire a no-op notifier so the
 * scheduler still runs (useful for fixture / headless operation). Nothing runs
 * until `main()` is awaited, and `main()` never throws when the token is missing.
 *
 * `dotenv/config` loads a local `.env` (if present) into `process.env` before
 * config is read; it silently no-ops when there is no file (CI / inline env).
 */
import 'dotenv/config';
import type { MessageRef, Notification } from './contracts';
import { loadConfig } from './config';
import { openStore } from './persistence';
import { PluginRegistry } from './registry';
import { ProxyPool } from './scraping/proxyPool';
import { ScrapingEngine } from './scraping/engine';
import { Orchestrator } from './orchestrator';
import { buildBot, makeNotifier } from './gateway/bot';
import { selectMode, startWebhook } from './gateway/webhook';

async function main(): Promise<void> {
  // 1. Configuration (env-driven, validated).
  const config = loadConfig();

  // 2. Persistence + vendor manifests.
  const store = openStore(config.databasePath);
  const registry = PluginRegistry.load('plugins');

  // 3. Scraping stack: a rotating proxy pool feeding the engine.
  const pool = new ProxyPool(config.proxyUrls, config.proxyBenchCooldownMs);
  const engine = new ScrapingEngine({ pool, cooldownMs: config.proxyBenchCooldownMs });

  // 4. Telegram bot — only when a token is configured. Without one we still run
  //    the scheduler against a no-op notifier (the bot is the sole consumer of
  //    notifications, so dropping them is the correct degenerate behaviour).
  let bot: ReturnType<typeof buildBot> | undefined;
  // The real Telegram notifier, built once after the bot exists. It returns the
  // sent message's MessageRef so the orchestrator can later edit an original
  // alert to append a cross-posted source.
  let botNotifier: ((n: Notification) => Promise<MessageRef | void>) | undefined;
  let notify: (n: Notification) => Promise<MessageRef | void>;

  if (config.botToken) {
    // The orchestrator and the bot are mutually dependent (the bot drives
    // registration; the orchestrator's notifier drives the bot). The notifier
    // delegates to `botNotifier`, which is assigned just below before any cycle
    // runs — and crucially RETURNS its MessageRef so cross-post edits work.
    notify = (n) => (botNotifier ? botNotifier(n) : Promise.resolve());
  } else {
    console.warn('[agor] BOT_TOKEN not set — running with a no-op notifier (no Telegram delivery).');
    notify = async () => {
      /* no-op: nothing to deliver without a bot. */
    };
  }

  // 5. Orchestrator: the engine that registration and polling drive through.
  const orchestrator = new Orchestrator({ registry, store, engine, config, notify });

  // Now that the orchestrator exists, build the bot that drives it (and the
  // notifier once, not per-message).
  if (config.botToken) {
    bot = buildBot(orchestrator, store, config.botToken);
    botNotifier = makeNotifier(bot, store);
  }

  // 6. Start the scheduler heartbeat, then (if present) the bot in the
  //    configured mode: webhook when a URL is set, otherwise long-polling.
  orchestrator.start();

  if (bot) {
    if (selectMode(config) === 'webhook' && config.webhookUrl) {
      await startWebhook(bot, {
        url: config.webhookUrl,
        port: config.webhookPort,
        secret: config.webhookSecret,
      });
      console.info(
        `[agor] webhook listening on :${config.webhookPort}, registered ${config.webhookUrl}`,
      );
      // The listening HTTP server keeps the process alive.
    } else {
      // Clear any previously-registered webhook so polling is not refused.
      await bot.api.deleteWebhook();
      console.info('[agor] starting Telegram long-polling…');
      // bot.start() resolves only when the bot stops, keeping the process alive.
      await bot.start();
    }
  } else {
    console.info('[agor] scheduler started (no bot). Press Ctrl+C to exit.');
  }
}

main().catch((err) => {
  console.error('[agor] fatal error:', err);
  process.exitCode = 1;
});
