# agor — Deployment & Connection Runbook

This walks you from nothing to a running, connected bot on a **Raspberry Pi**,
kept alive with **PM2**. Two delivery modes are supported:

- **Long-polling** (default, zero-config): the bot dials out to Telegram. No
  public endpoint, no port-forwarding — works behind home NAT. Start here.
- **Webhook** (production): Telegram pushes updates to a public HTTPS URL. On a
  home Pi this needs an HTTPS tunnel; we use a **Cloudflare Tunnel** (free, no
  port-forwarding). Switch to this once long-polling works.

You can run the whole thing in long-polling mode and never touch the webhook
section. Webhook is an optimization, not a requirement.

---

## 0. Prerequisites

- A Raspberry Pi 3/4/5 running **64-bit Raspberry Pi OS** (Bullseye/Bookworm).
  64-bit matters: `better-sqlite3` and `@napi-rs/canvas` ship prebuilt `arm64`
  binaries, so install needs no compiler. (32-bit/armv7 → see [ARM notes](#arm--native-binary-notes).)
- A Telegram account.
- Internet access from the Pi.

---

## 1. Create the bot and get a token

1. In Telegram, message **@BotFather**.
2. Send `/newbot`, choose a name and a username ending in `bot`.
3. BotFather replies with a **token** like `123456:ABC-DEF...`. Keep it secret —
   it is the only credential needed to control the bot.

---

## 2. Prepare the Raspberry Pi

Install Node.js 20 (LTS) and git:

```bash
# Node 20 from NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# PM2 process manager (global)
sudo npm install -g pm2

node --version   # expect v20.x
```

---

## 3. Get the code and install dependencies

```bash
git clone <your-repo-url> agor
cd agor
npm ci            # clean install from package-lock.json
npm test          # optional: 150+ tests should pass, proving the build works
```

`npm ci` pulls prebuilt `arm64` binaries on 64-bit OS — no build step.

---

## 4. Configure

```bash
cp .env.example .env
nano .env
```

Fill in at least:

| Variable        | Value                                                            |
| --------------- | --------------------------------------------------------------- |
| `BOT_TOKEN`     | the token from BotFather                                         |
| `DATABASE_PATH` | e.g. `./agor.db` (or a path on external storage — see below)     |
| `PROXY_URLS`    | optional: comma-separated residential proxies; empty = direct   |

Leave `WEBHOOK_URL` **empty** for now (long-polling). `.env` is git-ignored —
never commit it.

Quick smoke test in the foreground (Ctrl+C to stop):

```bash
npm start
# → "[agor] starting Telegram long-polling…"
```

Message your bot `/start` — you should get the welcome card. Working? Move on.

---

## 5. Run under PM2 (survives crashes and reboots)

```bash
mkdir -p logs
pm2 start ecosystem.config.cjs     # start agor
pm2 save                           # remember it across reboots
pm2 startup                        # prints a sudo command — run that command
pm2 logs agor                      # tail logs (Ctrl+C to detach)
```

`pm2 startup` generates a systemd hook so PM2 (and agor) come back after a power
cut. That is the whole long-polling deployment.

---

## 6. (Optional) Switch to webhook via a Cloudflare Tunnel

A home Pi has no public IP, so "webhook" means: a public HTTPS hostname that
forwards to agor's **local** webhook port. `cloudflared` provides exactly that.

### 6a. Install cloudflared (arm64)

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 \
  -o /tmp/cloudflared && sudo install /tmp/cloudflared /usr/local/bin/cloudflared
cloudflared --version
```

### 6b. Create a tunnel to the local webhook port

agor listens on `WEBHOOK_PORT` (default `8443`). Point a tunnel at it.

**Quick (ephemeral URL, good for testing):**

```bash
cloudflared tunnel --url http://localhost:8443
# prints a https://<random>.trycloudflare.com URL
```

**Stable (named tunnel + your domain, recommended for production):** follow
Cloudflare's "Create a tunnel" guide once (`cloudflared tunnel login`,
`cloudflared tunnel create agor`, route a DNS hostname to it, run it as a
service with `cloudflared service install`). You get a fixed hostname like
`https://agor.yourdomain.com`.

### 6c. Point agor at the tunnel

First generate a secret (a random token Telegram echoes back so forged requests
are rejected):

```bash
openssl rand -hex 32          # copy the hex output
```

Then edit `.env` and paste that **literal** value — `.env` is read by dotenv,
which does *not* run shell commands, so `$(...)` would be stored verbatim:

```bash
WEBHOOK_URL=https://agor.yourdomain.com   # the tunnel's public HTTPS hostname
WEBHOOK_PORT=8443                         # must match the tunnel target
WEBHOOK_SECRET=<paste-the-hex-from-above>
```

Restart and verify:

```bash
pm2 restart agor
pm2 logs agor          # → "[agor] webhook listening on :8443, registered https://…"

# Ask Telegram what it sees. Load the token into your shell first (.env is read
# by the app, not your shell), then query getWebhookInfo:
set -a; source .env; set +a
curl "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo"
# → "url":"https://agor.yourdomain.com", pending_update_count:0, no last_error
```

On every boot agor calls `setWebhook`, so a URL change self-heals.

---

## 7. Verify end to end

Message the bot a marketplace link (or `/help`). Watch `pm2 logs agor` for the
registration and the first poll. Tap the inline buttons; alerts arrive as the
scheduler runs.

---

## 8. Operating it

```bash
pm2 logs agor          # live logs
pm2 restart agor       # restart (after an .env change)
pm2 stop agor          # stop
pm2 status             # overview

# Update to new code:
cd ~/agor && git pull && npm ci && pm2 restart agor
```

---

## 9. Switching modes back to long-polling

```bash
# In .env: clear WEBHOOK_URL (leave it empty), then:
pm2 restart agor
# agor calls deleteWebhook on boot before polling, so no stale webhook lingers.
```

You can also stop the Cloudflare Tunnel; long-polling needs no tunnel.

---

## Logging & Grafana Cloud (Loki)

agor logs every poll (and registrations, alerts, proxy benches, failures) as
structured JSON. It always writes to **stdout** (so `pm2 logs agor` shows it),
and **also ships to Grafana Cloud Loki** when you configure it.

The headline event — one per poll — looks like:

```json
{"level":30,"service":"agor","component":"cycle","monitorId":1,"vendor":"OLX",
 "ok":true,"status":200,"itemsActive":11,"newItems":0,"notifications":0,
 "durationMs":4042,"msg":"poll"}
```

### Ship to Grafana Cloud

1. Create a **free** Grafana Cloud account (grafana.com) — the free tier includes Loki.
2. Create a **write token**: grafana.com → **Administration → Users and access →
   Access Policies** → **Create access policy** (realm = your stack; scope
   **`logs:write`**) → **Add token** → copy the `glc_…` value.
   *A read token (e.g. the one shown on the Loki data-source page) returns
   `401 invalid scope` — you need `logs:write`.*
3. From the Loki **"Send Logs / Details"** panel, note the **URL** and **User**.
4. In `.env`:

   ```bash
   LOKI_URL=https://logs-prod-039.grafana.net   # your push host
   LOKI_USER=1640288                            # numeric instance id
   LOKI_TOKEN=glc_xxx                           # the logs:write token
   LOG_SERVICE=agor
   LOG_ENV=pi
   LOG_LEVEL=info                               # debug for fetch-level detail
   ```

5. `pm2 restart agor`. Within ~5s logs appear in Grafana → **Explore → Loki**,
   query `{service="agor"}`. Useful queries:
   - all polls: `{service="agor"} | json | component="cycle"`
   - failures: `{service="agor"} | json | ok="false"`
   - proxy benches: `{service="agor"} | json | component="engine" | msg=~".*benched.*"`

Logs batch every 5s; if Loki is unreachable they buffer (bounded) and stdout/PM2
still has everything. Leaving any of the three `LOKI_*` empty = stdout-only.

> More robust alternative: run **Grafana Alloy** on the Pi to tail PM2's log
> files and push to Loki (disk-buffered). The app-direct push above is the
> lowest-friction option and needs no agent.

## ARM / native-binary notes

- **64-bit OS is strongly recommended** — `better-sqlite3` and `@napi-rs/canvas`
  have prebuilt `arm64` binaries, so `npm ci` is fast and compiler-free.
- On **32-bit / armv7** there may be no prebuilt binary; install build tools
  first: `sudo apt-get install -y build-essential python3 libsqlite3-dev` and
  expect a longer `npm ci`. Upgrading to 64-bit OS is the easier path.

## SQLite on an SD card

agor writes to a single SQLite file (WAL enabled). SD cards wear under frequent
writes. For longevity, point `DATABASE_PATH` at an external **USB SSD**, and/or
back the file up periodically (`cp agor.db backup/agor-$(date +%F).db` from a
cron job).

## Troubleshooting

| Symptom                                   | Check                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `[agor] BOT_TOKEN not set` warning        | `.env` not loaded / token blank. PM2 runs in `cwd: __dirname`; ensure `.env` sits next to `ecosystem.config.cjs`. |
| Webhook `getWebhookInfo` shows last_error | Tunnel down or `WEBHOOK_PORT` ≠ tunnel target. Restart `cloudflared`; confirm ports match. |
| 401 from Telegram                         | Wrong `BOT_TOKEN`.                                                     |
| Updates not arriving (webhook)            | Forged-request protection: make sure `WEBHOOK_SECRET` is set and unchanged since the last `setWebhook` (a restart re-registers it). |
| `npm ci` tries to compile native modules  | You're on 32-bit OS — see ARM notes.                                   |
| Bot replies in the wrong language         | Per-chat; send `/lang ro` or `/lang en`.                              |
```
