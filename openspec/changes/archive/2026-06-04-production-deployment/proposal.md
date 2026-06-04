## Why

agor currently only talks to Telegram via long-polling, and there is no documented path from a fresh checkout to a running bot on the target host (a Raspberry Pi, managed with PM2). To go live we need (1) **webhook** update intake — the chosen production mode — and (2) a **connection runbook** that walks through getting a bot token, configuring the Pi, exposing an HTTPS endpoint, and keeping the process alive.

## What Changes

- Add **webhook** update intake alongside long-polling: a config-driven mode where the bot registers a public HTTPS URL with Telegram and serves updates from a small HTTP listener. Long-polling stays the default when no webhook URL is configured.
- Add webhook configuration (`WEBHOOK_URL`, `WEBHOOK_PORT`, `WEBHOOK_SECRET`) and a `selectMode()` rule that picks webhook vs long-polling.
- Ship a **deployment runbook** (`DEPLOYMENT.md`): BotFather token, `.env`, Raspberry Pi prep (64-bit OS for prebuilt native binaries), Node install, `npm ci`, a **PM2** ecosystem file + `pm2 startup`/`save`, exposing HTTPS via a **Cloudflare Tunnel** (no port-forwarding), `setWebhook`, verification, logs, and updates.
- Ship a **PM2 ecosystem file** and a short README quickstart so the runbook is reproducible.

## Capabilities

### New Capabilities

- `operations`: deployment & runtime contract — config via environment, secrets never committed, long-polling default with no inbound port, webhook mode requiring a public HTTPS endpoint, graceful no-token boot, and the documented connection runbook.

### Modified Capabilities

- `telegram-gateway`: ADD webhook update intake (config-selected) to the existing long-polling intake.

## Impact

- **Code**: `src/config` gains webhook settings; new `src/gateway/webhook.ts` (HTTP listener via grammY `webhookCallback`, `setWebhook` on boot); `src/index.ts` selects mode. No extra dependency — `webhookCallback` ships with grammY.
- **Ops files**: `DEPLOYMENT.md`, `ecosystem.config.cjs` (PM2), README quickstart, `.env.example` gains the webhook keys.
- **No change** to the monitoring engine, scraping, pipeline, scheduler, orchestrator, or the localized UX.
- **Tests**: config parsing of the webhook keys and the `selectMode()` decision.
