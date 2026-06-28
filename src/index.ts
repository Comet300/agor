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
import { loadConfig, droppedAdminIds, incompleteLokiKeys } from './config';
import { openStore } from './persistence';
import { applyStagedRestore, runBackup } from './features/backup';
import { InputFile } from 'grammy';
import { unlink } from 'node:fs/promises';
import { PluginRegistry } from './registry';
import { ProxyPool } from './scraping/proxyPool';
import { ScrapingEngine, closeAgentPool, type Fetcher } from './scraping/engine';
import { Orchestrator } from './orchestrator';
import { buildBot, makeNotifier } from './gateway/bot';
import { commandMenu } from './gateway/strings';
import { selectMode, startWebhook } from './gateway/webhook';
import { healthHandler, startHealthServer, type HealthDeps } from './gateway/health';
import { configureLogging, hasLoki, log } from './logging/logger';
import type { Server } from 'node:http';
import type { Store } from './persistence';

/**
 * Trap SIGINT/SIGTERM and tear down cleanly: stop the scheduler, close the
 * browser + HTTP server + DB, then exit. Idempotent (re-entry ignored) and
 * bounded (a stuck teardown still exits after a timeout).
 */
function installShutdown(resources: {
  orchestrator: Orchestrator;
  store: Store;
  closeBrowser?: () => Promise<void>;
  servers: Array<Server | undefined>;
}): void {
  let shuttingDown = false;
  const handle = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown").info(
      { signal },
      "received signal; shutting down gracefully",
    );
    const force = setTimeout(() => {
      log("shutdown").error({}, "shutdown exceeded 10s; forcing exit");
      process.exit(1);
    }, 10_000);
    force.unref?.();
    void (async () => {
      try {
        resources.orchestrator.stop();
        for (const s of resources.servers) {
          if (s) await new Promise<void>((r) => s.close(() => r()));
        }
        // Release pooled HTTP(S) dispatchers (sockets) before closing the rest.
        await closeAgentPool().catch((err) =>
          log("shutdown").warn(
            { err: (err as Error).message },
            "agent pool close failed",
          ),
        );
        if (resources.closeBrowser) {
          await resources
            .closeBrowser()
            .catch((err) =>
              log("shutdown").warn(
                { err: (err as Error).message },
                "browser close failed",
              ),
            );
        }
        try {
          resources.store.db.close();
        } catch (err) {
          log("shutdown").warn(
            { err: (err as Error).message },
            "db close failed",
          );
        }
        clearTimeout(force);
        log("shutdown").info({}, "shutdown complete");
        process.exit(0);
      } catch (err) {
        clearTimeout(force);
        log("shutdown").error(
          { err: (err as Error).message },
          "shutdown failed",
        );
        process.exit(1);
      }
    })();
  };
  process.once("SIGINT", () => handle("SIGINT"));
  process.once("SIGTERM", () => handle("SIGTERM"));
}

async function main(): Promise<void> {
  // 1. Configuration (env-driven, validated), then logging (so everything after
  //    this point is structured and shipped to Loki when configured).
  const config = loadConfig();
  configureLogging(config);

  // Surface silent misconfigurations the parser would otherwise drop quietly.
  const droppedAdmins = droppedAdminIds();
  if (droppedAdmins.length > 0) {
    log('config').warn(
      { dropped: droppedAdmins },
      'ADMIN_CHAT_IDS contained non-numeric entries; they were ignored (check for typos)',
    );
  }
  const missingLoki = incompleteLokiKeys();
  if (missingLoki.length > 0) {
    log('config').warn(
      { missing: missingLoki },
      'Loki is partially configured; logs ship to stdout only (all three of LOKI_URL/LOKI_USER/LOKI_TOKEN are required)',
    );
  }

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
    "starting agor",
  );

  // 2. Persistence + vendor manifests. A staged restore (from /restore) is applied
  //    here — before the DB is opened — so the live file is never overwritten in use.
  if (applyStagedRestore(config.databasePath)) {
    log("boot").warn({ dbPath: config.databasePath }, "applied a staged database restore");
  }
  const store = openStore(config.databasePath);
  const registry = PluginRegistry.load("plugins");
  log("boot").info({ vendors: registry.all().length }, "plugins loaded");

  // 3. Scraping stack: a rotating proxy pool feeding the engine. When the
  //    browser fallback is enabled AND a manifest opts in, attach the lazy
  //    headless-browser transport; otherwise the engine stays HTTP-only and
  //    Chromium is never imported.
  const pool = new ProxyPool(config.proxyUrls, config.proxyBenchCooldownMs);
  const wantsBrowser =
    config.enableBrowserFallback &&
    registry.all().some((p) => p.fetch_strategy === "browser");
  let browserFetcher: Fetcher | undefined;
  let closeBrowser: (() => Promise<void>) | undefined;
  if (wantsBrowser) {
    const mod = await import("./scraping/browserFetcher");
    browserFetcher = mod.createBrowserFetcher();
    closeBrowser = mod.closeBrowser;
    log("boot").info("browser fallback enabled for opted-in manifests");
  }
  const engine = new ScrapingEngine({
    pool,
    cooldownMs: config.proxyBenchCooldownMs,
    browserFetcher,
  });

  // 4. Telegram bot — only when a token is configured. Without one we still run
  //    the scheduler against a no-op notifier (the bot is the sole consumer of
  //    notifications, so dropping them is the correct degenerate behaviour).
  let bot: ReturnType<typeof buildBot> | undefined;
  // The real Telegram notifier, built once after the bot exists. It returns the
  // sent message's MessageRef so the orchestrator can later edit an original
  // alert to append a cross-posted source.
  let botNotifier:
    | ((n: Notification) => Promise<MessageRef | void>)
    | undefined;
  let notify: (n: Notification) => Promise<MessageRef | void>;

  if (config.botToken) {
    // The orchestrator and the bot are mutually dependent (the bot drives
    // registration; the orchestrator's notifier drives the bot). The notifier
    // delegates to `botNotifier`, which is assigned just below before any cycle
    // runs — and crucially RETURNS its MessageRef so cross-post edits work.
    notify = (n) => (botNotifier ? botNotifier(n) : Promise.resolve());
  } else {
    log("boot").warn(
      "BOT_TOKEN not set — running with a no-op notifier (no Telegram delivery)",
    );
    notify = async () => {
      /* no-op: nothing to deliver without a bot. */
    };
  }

  // 5. Orchestrator: the engine that registration and polling drive through.
  const orchestrator = new Orchestrator({
    registry,
    store,
    engine,
    config,
    notify,
  });

  // Now that the orchestrator exists, build the bot that drives it (and the
  // notifier once, not per-message).
  if (config.botToken) {
    bot = buildBot(orchestrator, store, config.botToken, {
      adminChatIds: config.adminChatIds,
      maxMonitorsPerChat: config.maxMonitorsPerChat,
      checkCooldownMs: config.checkCooldownMs,
      urlRegisterCooldownMs: config.urlRegisterCooldownMs,
      databasePath: config.databasePath,
      ...(config.backupLocalDir ? { backupLocalDir: config.backupLocalDir } : {}),
    });
    botNotifier = makeNotifier(bot, store);
    // Register the localized "/" command menu (Romanian default, English for
    // en-locale Telegram clients). Best-effort: a failure must not abort boot.
    try {
      await bot.api.setMyCommands(commandMenu.ro);
      await bot.api.setMyCommands(commandMenu.en, { language_code: "en" });
    } catch (err) {
      log("boot").warn(
        { err: (err as Error).message },
        "could not register command menu",
      );
    }
  }

  // 6. Start the scheduler heartbeat, then (if present) the bot in the
  //    configured mode: webhook when a URL is set, otherwise long-polling.
  orchestrator.start();

  // Scheduled auto-backup: snapshot the DB on a cadence and upload it to every
  // admin (and the local dir, when set). Unref'd so it never keeps the process up.
  if (bot) {
    const adminTargets = (): number[] => {
      const ids = new Set<number>(config.adminChatIds);
      for (const u of store.access.list()) if (u.isAdmin) ids.add(u.chatId);
      return [...ids];
    };
    const backupTimer = setInterval(async () => {
      let path: string | undefined;
      try {
        path = await runBackup(store.db, { now: Date.now(), ...(config.backupLocalDir ? { localDir: config.backupLocalDir } : {}) });
        for (const id of adminTargets()) {
          try { await bot!.api.sendDocument(id, new InputFile(path), { caption: 'agor backup' }); } catch { /* admin unreachable */ }
        }
      } catch (err) {
        log("backup").error({ err: (err as Error).message }, "scheduled backup failed");
      } finally {
        if (path) await unlink(path).catch(() => {});
      }
    }, config.backupIntervalMs);
    backupTimer.unref();
  }

  // Health/readiness: report the scheduler's liveness. In webhook mode the route
  // rides the webhook listener; in long-poll mode a tiny dedicated listener runs
  // only when HEALTH_CHECK_PORT is set.
  const healthDeps: HealthDeps = {
    getLastTickAt: () => orchestrator.scheduler.getLastTickAt(),
    getLastDueCount: () => orchestrator.scheduler.getLastDueCount(),
  };

  // Servers to close on shutdown (webhook and/or standalone health listener).
  const servers: Array<Server | undefined> = [];

  if (bot) {
    if (selectMode(config) === "webhook" && config.webhookUrl) {
      const health = healthHandler(healthDeps);
      const server = await startWebhook(bot, {
        url: config.webhookUrl,
        port: config.webhookPort,
        secret: config.webhookSecret,
        preHandler: (req, res) => health(req, res),
      });
      servers.push(server);
      log("boot").info(
        { port: config.webhookPort, url: config.webhookUrl },
        "webhook listening (health on /health); the HTTP server keeps the process alive",
      );
    } else {
      // Long-poll: optional standalone health listener.
      servers.push(startHealthServer(config.healthCheckPort, healthDeps));
      // Clear any previously-registered webhook so polling is not refused.
      await bot.api.deleteWebhook();
      installShutdown({ orchestrator, store, closeBrowser, servers });
      log("boot").info("starting Telegram long-polling");
      // bot.start() resolves only when the bot stops, keeping the process alive.
      await bot.start();
      return;
    }
  } else {
    servers.push(startHealthServer(config.healthCheckPort, healthDeps));
    log("boot").info("scheduler started (no bot); Ctrl+C to exit");
  }

  installShutdown({ orchestrator, store, closeBrowser, servers });
}

// `agor --check`: run the manifest self-test and exit, never booting the bot.
if (process.argv.includes("--check")) {
  void (async () => {
    const { runCheck, printReport } = await import("./bin/check");
    const { ok, results } = await runCheck();
    printReport(results);
    process.exit(ok ? 0 : 1);
  })();
} else {
  main().catch((err) => {
    log("boot").error({ err: (err as Error).message }, "fatal error");
    process.exitCode = 1;
  });
}
