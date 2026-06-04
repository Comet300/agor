/**
 * agor entrypoint (Phase 8 wiring).
 *
 * Composes the whole system from config:
 *   config → store → plugin registry → proxy pool → scraping engine
 *          → (optional) Telegram bot + notifier → orchestrator.
 *
 * When `BOT_TOKEN` is absent we log a warning and wire a no-op notifier so the
 * scheduler still runs (useful for fixture / headless operation). Import-time is
 * side-effect free: nothing runs until `main()` is awaited, and `main()` never
 * throws when the token is missing.
 */
import type { MessageRef, Notification } from './contracts';
import { loadConfig } from './config';
import { openStore } from './persistence';
import { PluginRegistry } from './registry';
import { ProxyPool } from './scraping/proxyPool';
import { ScrapingEngine } from './scraping/engine';
import { Orchestrator } from './orchestrator';
import { buildBot, makeNotifier } from './gateway/bot';

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

  // 6. Start the scheduler heartbeat, then (if present) the long-polling bot.
  orchestrator.start();

  if (bot) {
    console.info('[agor] starting Telegram long-polling…');
    // bot.start() resolves only when the bot stops, so this keeps the process
    // alive. Errors inside the polling loop are surfaced to the top-level catch.
    await bot.start();
  } else {
    console.info('[agor] scheduler started (no bot). Press Ctrl+C to exit.');
  }
}

main().catch((err) => {
  console.error('[agor] fatal error:', err);
  process.exitCode = 1;
});
