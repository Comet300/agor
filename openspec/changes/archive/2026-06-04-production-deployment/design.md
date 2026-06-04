## Context

The bootstrap deliberately shipped long-polling (no public endpoint, works anywhere). Production target is a Raspberry Pi at home behind NAT, managed with PM2, and the operator wants webhook delivery. A home Pi has no public IP, so "webhook" in practice means *a public HTTPS endpoint tunnelled to a local port*. The app is otherwise self-contained (SQLite file, in-process scheduler).

## Goals / Non-Goals

**Goals:**
- Webhook update intake selectable purely by configuration; long-polling remains the zero-config default and fallback.
- A reproducible runbook taking the operator from "nothing" to "running bot" on a Raspberry Pi + PM2, including the HTTPS exposure a home network lacks.
- No new runtime dependency; reuse grammY's built-in `webhookCallback`.

**Non-Goals:**
- No managed reverse proxy / nginx config baked into the app (the tunnel handles TLS); the app serves plain HTTP locally.
- No multi-instance/clustered webhook handling (single Pi, single process).
- No change to monitoring behavior.

## Decisions

### Mode selection by config, not a flag
`selectMode(config)` returns `'webhook'` when `WEBHOOK_URL` is set, else `'long-polling'`. *Why:* one source of truth; an operator enables webhooks by providing the URL, and removing it cleanly falls back. A pure function makes the decision testable.

### Webhook served by grammY `webhookCallback` over Node's `http`
`startWebhook(bot, { url, port, secret })` builds `http.createServer(webhookCallback(bot, 'http', { secretToken }))`, listens on `port`, then calls `bot.init()` and `bot.api.setWebhook(url, { secret_token, allowed_updates })`. *Why:* `webhookCallback` is part of grammY core (no dependency), and the `secret_token` header lets the listener reject forged requests. The local listener binds `127.0.0.1` (or `0.0.0.0` for the tunnel) on a high port; TLS is terminated by the tunnel, not the app.

### HTTPS via Cloudflare Tunnel (runbook)
A home Pi has no public IP and self-signed certs are awkward with Telegram. The runbook uses **Cloudflare Tunnel** (`cloudflared`): it dials out to Cloudflare, gives a stable public HTTPS hostname, and forwards to the local webhook port — no port-forwarding, no inbound firewall changes, free TLS. *Why over ngrok:* stable hostname and no session limits; over port-forwarding: no router config and no exposed home IP. The runbook still documents long-polling as the dependency-free alternative.

### `.env` loaded via dotenv
The entrypoint imports `dotenv/config`, which loads a local `.env` into
`process.env` before config is read and silently no-ops when absent (CI / inline
env). *Why:* the runbook configures the bot through `.env`, but `tsx`/Node does
not auto-load it, and PM2's `env` object can't reference a file portably — so the
app must load it. `dotenv` is the only added dependency (webhook intake itself
needs none; `webhookCallback` ships with grammY).

### PM2 for process lifecycle
`ecosystem.config.cjs` runs `npm start` (tsx), `autorestart`, `max_memory_restart`, and an env file; `pm2 startup` + `pm2 save` survive reboots. *Why:* the operator asked for PM2; it gives boot-persistence and log management on the Pi without writing a systemd unit by hand.

### Raspberry Pi / ARM notes
`better-sqlite3` and `@napi-rs/canvas` ship prebuilt binaries for **arm64**; a 64-bit Raspberry Pi OS avoids a from-source build (and the canvas/native toolchain). The runbook calls this out and lists the build-essential fallback for 32-bit/armv7.

## Risks / Trade-offs

- **Tunnel as a dependency** → If `cloudflared` is down the webhook stops; mitigation: long-polling fallback is one env change away (unset `WEBHOOK_URL`).
- **Webhook secret** → Without `secret_token`, anyone who learns the URL can post fake updates; the listener enforces the secret header, and the runbook generates one.
- **SQLite on SD card** → frequent writes wear flash; mitigation noted in the runbook (WAL already on; consider an external SSD or periodic backup of the `.db`).
- **Stale webhook on redeploy** → `setWebhook` is idempotent and called on every boot, so a URL change self-heals; switching back to long-polling must `deleteWebhook` (the runbook notes this).

## Migration Plan

Additive and config-gated: with no `WEBHOOK_URL`, behavior is byte-identical to today (long-polling). To go live: set the webhook env, start `cloudflared`, boot under PM2 — the app registers the webhook on start. Rollback: unset `WEBHOOK_URL` (and `deleteWebhook`), restart; long-polling resumes.

## Open Questions

- Webhook local bind address: `127.0.0.1` (tunnel on same host) vs `0.0.0.0` (tunnel/container elsewhere)? Proposed default `0.0.0.0` with the runbook recommending the tunnel co-located on the Pi.
- Should boot `deleteWebhook` automatically when falling back to long-polling, to avoid a lingering registration? (Proposed: yes — call `deleteWebhook` before `bot.start()`.)
