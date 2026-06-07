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
import { commandMenu } from './gateway/strings';
import { selectMode, startWebhook } from './gateway/webhook';
import { configureLogging, hasLoki, log } from './logging/logger';

async function main(): Promise<void> {
  // 1. Configuration (env-driven, validated), then logging (so everything after
  //    this point is structured and shipped to Loki when configured).
  const config = loadConfig();
  configureLogging(config);
  log('boot').info(
    {
      mode: selectMode(config),
      dbPath: config.databasePath,
      hasBotToken: Boolean(config.botToken),
      proxies: config.proxyUrls.length,
      lokiEnabled: hasLoki(config),
      logLevel: config.logLevel,
      env: config.logEnv,
    },
    'starting agor',
  );

  // 2. Persistence + vendor manifests.
  const store = openStore(config.databasePath);
  const registry = PluginRegistry.load('plugins');
  log('boot').info({ vendors: registry.all().length }, 'plugins loaded');

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
    log('boot').warn('BOT_TOKEN not set — running with a no-op notifier (no Telegram delivery)');
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
    // Register the localized "/" command menu (Romanian default, English for
    // en-locale Telegram clients). Best-effort: a failure must not abort boot.
    try {
      await bot.api.setMyCommands(commandMenu.ro);
      await bot.api.setMyCommands(commandMenu.en, { language_code: 'en' });
    } catch (err) {
      log('boot').warn({ err: (err as Error).message }, 'could not register command menu');
    }
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
      log('boot').info(
        { port: config.webhookPort, url: config.webhookUrl },
        'webhook listening; the HTTP server keeps the process alive',
      );
    } else {
      // Clear any previously-registered webhook so polling is not refused.
      await bot.api.deleteWebhook();
      log('boot').info('starting Telegram long-polling');
      // bot.start() resolves only when the bot stops, keeping the process alive.
      await bot.start();
    }
  } else {
    log('boot').info('scheduler started (no bot); Ctrl+C to exit');
  }
}

main().catch((err) => {
  log('boot').error({ err: (err as Error).message }, 'fatal error');
  process.exitCode = 1;
});
