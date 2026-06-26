# Deployment Architecture — Dokku on the Pi (agor + future apps)

Status: **design + runbook — committed as the spec.** The agor-repo *files* this
describes (Dockerfile, `.dockerignore`, deploy workflow, DEPLOYMENT.md rewrite, PM2
removal) are NOT yet implemented — they become a follow-up PR off `main` once the
feature stack (#8–#12) drains. This document is the authoritative spec for that PR.
Decision locked 2026-06-17.

## Decision recap
- **Platform:** Dokku (a control-plane-less PaaS: shell plugins over Docker + nginx).
  PM2 is dropped — Docker/Dokku owns restart, boot-survival, and log capture.
- **Logs + alerts:** Grafana Cloud. agor already ships structured JSON → Loki
  (`pino-loki`); alerting is log-based (see §7). No PaaS logging UI needed.
- **DB:** SQLite on the external SSD via a Dokku persistent-storage mount.
- **On-push:** push to `main` → CI gate → GitHub Action pushes to the Pi's Dokku
  git remote → Dokku builds the image on-box and redeploys that one app.
- **Browser fallback:** **enabled on the Pi** — the image bundles Chromium +
  Playwright + stealth so `fetch_strategy: browser` manifests (mobile.de) work.

## Hardware
Raspberry Pi 5 · 8GB RAM · active cooling · external 256GB SSD.
Docker data-root **and** Dokku storage live on the SSD (not the boot media) — see §6.

---

## 1. Architecture

```
   GitHub (push to main)
        │  ① CI runs tests/typecheck/manifest check (gate)
        ▼
   GitHub Action  ──② git push over SSH (via Tailscale/tunnel, see §5)──►  Pi
                                                                            │
   ┌────────────────────────────── Raspberry Pi 5 ──────────────────────────────┐
   │  Dokku (receives the push)                                                  │
   │    ③ builds the Dockerfile image on-box → ④ stops old container,            │
   │       starts new one with the app's restart policy + storage mounts         │
   │                                                                              │
   │   ┌── agor container ──┐   ┌── app-B container ─┐   ┌── app-C … ─┐           │
   │   │ node:20-bookworm   │   │  …                 │   │  …          │          │
   │   │ + Chromium/PW      │   │                    │   │             │          │
   │   │ logs → stdout ─────┼─► pushes JSON to Grafana Cloud Loki (per app)       │
   │   │ SQLite → /app/data ┼─► SSD volume  (survives redeploy/reboot)            │
   │   └────────────────────┘   └────────────────────┘   └─────────────┘         │
   │                                                                              │
   │   Docker daemon (enabled on boot) · SSD mounted before Docker (fstab nofail) │
   └──────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
   Grafana Cloud  ── log-based alert rules (no poll in N min, error-rate spike) ──► you
```

Each app = one Dokku app = one Docker container. The control plane is just Dokku's
shell tooling + nginx; nothing heavy runs idle (the reason we picked it over Coolify).

---

## 2. The agor container contract (agor repo)

These four artifacts ship in the agor repo. Everything else (Dokku commands, Pi boot
config) is machine-level runbook, §4–§6.

### 2a. `Dockerfile` (Playwright/Chromium enabled)

```dockerfile
# syntax=docker/dockerfile:1
# agor — Telegram marketplace monitor. Browser fallback ENABLED for the Pi.

# ── deps: install ALL deps (incl. dev: tsx runs the app; optional: playwright) ──
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci installs optionalDependencies (playwright, playwright-extra, stealth) by default.
RUN npm ci

# ── runtime ──
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    ENABLE_BROWSER_FALLBACK=true
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Chromium + its system libraries (arm64/bookworm). Installed to a shared, world-
# readable path so the non-root runtime user can launch it. --with-deps pulls the
# apt libraries Playwright needs; done as root before dropping privileges.
RUN npx playwright install --with-deps chromium \
 && chmod -R a+rx /ms-playwright \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Drop privileges. The node user (uid 1000) ships in the base image.
USER node

# Long-poll bot: bot.start() keeps the process alive; no inbound port required.
CMD ["npm", "start"]
```

Notes / rationale:
- **Base = `node:20-bookworm-slim` (glibc), NOT Alpine.** `better-sqlite3` and
  `@napi-rs/canvas` ship prebuilt **arm64 glibc** binaries; musl/Alpine would force a
  recompile or crash.
- **All deps kept (incl. dev).** `npm start` runs `tsx src/index.ts`, and `tsx` is a
  devDependency — so we can't `--omit=dev`. *Future optimization:* add a real `tsc`
  build → `node dist/index.js`, then prune dev deps to slim the image. Not required
  to ship; documented as hardening.
- **Image size ≈ 1.5–2 GB** with Chromium. Negligible on a 256GB SSD.
- **`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`** must be set *before* the install so the
  browser lands in the shared path the `node` user can read at runtime.
- The browser is only launched on a classified hard block for an opted-in manifest
  (mobile.de) — so the Chromium weight sits idle unless actually needed.

### 2b. `.dockerignore`

```
node_modules
.git
.github
logs
*.db
*.db-wal
*.db-shm
.env
.env.*
coverage
tests
openspec
*.md
docs/
task_plan.md
notes.md
context_summary.md
SCRAPING_ANALYSIS.md
SCRAPING_LIVE_ANALYSIS.md
```

Keeps the build context lean and — critically — **never copies a local `.env` or a
local `*.db`** into the image (secrets + state stay out of layers).

### 2c. Runtime config (Dokku env, NOT baked into the image)
Set via `dokku config:set` (§4). The image carries no secrets.

| Var | Value on the Pi | Why |
|---|---|---|
| `DATABASE_PATH` | `/app/data/agor.db` | points at the **mounted SSD volume**, not the ephemeral layer |
| `BOT_TOKEN` | (secret) | |
| `PROXY_URLS` | (secret, optional) | residential proxies |
| `ENABLE_BROWSER_FALLBACK` | `true` | already defaulted true in the image; explicit for clarity |
| `LOKI_URL` / `LOKI_USER` / `LOKI_TOKEN` | (Grafana Cloud) | log shipping |
| `LOG_ENV` | `pi` | log label |
| `ADMIN_CHAT_IDS` | (your chat id) | |
| `WEBHOOK_URL` | empty | long-poll mode (no inbound port) |

### 2d. Why the existing code already fits
- **logs → stdout** (`pino/file` to fd 1) → Grafana ingest unchanged.
- **SIGTERM clean shutdown** (shipped in PR #8): Docker/Dokku send SIGTERM on
  redeploy → agor stops the scheduler, closes the browser, closes the DB, then exits
  (10s force-exit cap). Deploys are graceful, not a yank.
- **DB on a volume + change-only price history** → a redeploy preserves all state.

---

## 3. Per-app process model (long-poll = no inbound port)

agor long-polls Telegram: it dials **out**, exposes **no port**. So in Dokku it's a
**worker-style app**, not a web app:
- `dokku proxy:disable agor` — no nginx vhost, nothing public.
- No domain, no SSL needed (Let's Encrypt is only for apps that serve inbound HTTPS;
  agor in long-poll mode never does. If you ever switch to webhook mode: re-enable
  proxy + `dokku letsencrypt:enable`).

> ⚠️ **Zero-downtime deploys + a single-consumer long-poll bot conflict.** Telegram
> allows exactly one `getUpdates` consumer per token. Dokku's default zero-downtime
> deploy briefly runs the **old and new container together** → the second poller gets
> a transient `409 Conflict` until the old one is retired. For a single bot this is
> harmless (the survivor takes over in seconds) but noisy. Two clean options:
> 1. **Accept the brief overlap** — simplest; a few seconds of 409 per deploy.
> 2. **Disable overlap** so Dokku stops-then-starts (`dokku checks:disable agor` and a
>    short `DOKKU_WAIT_TO_RETIRE`), trading a few seconds of downtime for no 409.
> Webhook-mode apps don't have this issue. Pick per-app; documented so it's not a surprise.

---

## 4. Dokku app setup (one-time, per app) — Pi runbook

```bash
# On the Pi. agor shown; repeat the pattern per app.
dokku apps:create agor

# Use the Dockerfile builder (auto-detected when a Dockerfile is present; set explicitly).
dokku builder:set agor selected dockerfile

# Persistent SQLite storage on the SSD. Dokku's data root is already on the SSD (§6),
# so this directory is SSD-backed. Make it writable by the container's node user (uid 1000).
dokku storage:ensure-directory agor                 # -> /var/lib/dokku/data/storage/agor
sudo chown -R 1000:1000 /var/lib/dokku/data/storage/agor
dokku storage:mount agor /var/lib/dokku/data/storage/agor:/app/data

# Config (secrets + env). DATABASE_PATH points into the mounted volume.
dokku config:set agor \
  DATABASE_PATH=/app/data/agor.db \
  ENABLE_BROWSER_FALLBACK=true \
  LOG_ENV=pi \
  BOT_TOKEN=… LOKI_URL=… LOKI_USER=… LOKI_TOKEN=… ADMIN_CHAT_IDS=…

# Worker-style app: no public proxy, no port.
dokku proxy:disable agor

# Survive crashes AND reboots (see §6 — this is the load-bearing line).
dokku ps:set-restart-policy agor unless-stopped

# Allow time/RAM for the on-box image build (Chromium download is sizeable).
# (First deploy only — subsequent builds use Docker layer cache.)
```

The first `git push` (§5) triggers the build + deploy.

---

## 5. On-push deploy (CI-gated, via Cloudflare Access SSH)

**Connectivity model (decided 2026-06-17): Cloudflare carries everything.** Inbound web
(§ webhooks / future web apps) AND the deploy SSH both ride the Cloudflare Tunnel — the
Pi opens **zero inbound ports**, and the **dynamic home IP is irrelevant** (the tunnel is
an outbound connection from `cloudflared` on the Pi; no DDNS, no A-record-to-the-home-IP,
no port forwarding). A GitHub-hosted runner reaches the Pi's Dokku SSH through a
**Cloudflare Access**–gated public hostname, authenticated by a **service token** (not a
human login), so the SSH endpoint is never openly exposed.

### 5a. GitHub Action (agor repo: `.github/workflows/deploy.yml`)

```yaml
name: deploy
on:
  push:
    branches: [main]          # ONLY main — never PR branches (a red push = instant downtime)

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run check:manifests

  deploy:
    needs: ci                 # gate: deploy only if CI is green
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }      # Dokku needs full history for the git push

      # Install cloudflared and configure SSH to proxy dokku's hostname through the
      # tunnel, authenticated by a Cloudflare Access SERVICE TOKEN (machine auth).
      - name: Set up Cloudflare Access SSH
        env:
          CF_ACCESS_CLIENT_ID: ${{ secrets.CF_ACCESS_CLIENT_ID }}
          CF_ACCESS_CLIENT_SECRET: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}
          DOKKU_SSH_KEY: ${{ secrets.DOKKU_SSH_KEY }}
        run: |
          # cloudflared
          curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
            -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared
          # deploy key
          mkdir -p ~/.ssh && echo "$DOKKU_SSH_KEY" > ~/.ssh/id_ed25519 && chmod 600 ~/.ssh/id_ed25519
          # route the dokku SSH host through the tunnel + present the Access service token
          cat >> ~/.ssh/config <<EOF
          Host ssh.yourdomain.com
            ProxyCommand cloudflared access ssh --hostname %h \
              --service-token-id $CF_ACCESS_CLIENT_ID \
              --service-token-secret $CF_ACCESS_CLIENT_SECRET
            StrictHostKeyChecking accept-new
          EOF

      - name: Deploy to Dokku
        run: |
          git remote add dokku ssh://dokku@ssh.yourdomain.com/agor
          git push dokku HEAD:refs/heads/main
```

> The `dokku/github-action` could replace the manual push, but the explicit
> `ProxyCommand` is shown so the Cloudflare-Access hop is legible. Either works.

### 5b. Pi / Cloudflare side (one-time, homelab runbook)
1. `cloudflared` runs on the Pi as a service with a **named tunnel** for your domain.
2. Tunnel ingress routes:
   - `ssh.yourdomain.com` → `ssh://localhost:22` (the Pi's sshd that Dokku uses), and
   - `app.yourdomain.com` → the relevant app (for webhook/web apps; agor long-poll needs none).
3. A **Cloudflare Access application** protects `ssh.yourdomain.com`, allowing a
   **service token** (the `CF_ACCESS_CLIENT_ID/SECRET` used above) — machine auth only,
   not your human SSO. Rotate the token periodically.
4. The Pi's sshd accepts the **Dokku deploy public key** (`dokku ssh-keys:add ci <pubkey>`);
   the matching private key is the `DOKKU_SSH_KEY` GitHub secret.
5. **Domain nameservers must point to Cloudflare** (required for Tunnel + Access). Free,
   but a real move if DNS lives elsewhere today.

> Per-app: each repo carries the same `deploy.yml` (its own `…/appname` remote). One
> Cloudflare Access service token can be reused across repos, or one per app for tighter
> blast-radius control. Adding an app = `apps:create` + tunnel ingress route + drop in
> this workflow.

### 5c. Free per-app SSL falls out of this for free
Because inbound web rides the same Cloudflare Tunnel with your domain, every web-serving
app gets `app.yourdomain.com` with **automatic, auto-renewed HTTPS from Cloudflare** — no
Dokku Let's Encrypt, no Traefik, no cert management. agor in long-poll mode still needs
none of this; future web apps (or agor in webhook mode) get HTTPS at zero extra effort.

---

## 6. Boot / reboot survival (the part Dokku does NOT do for free)

Three independent things must all hold, or a power-cut leaves apps down:

1. **Per-app restart policy** — `dokku ps:set-restart-policy <app> unless-stopped`.
   `unless-stopped` = restart on crash AND on boot, but stay down if you deliberately
   stopped it. (Dokku's default is *not* reliably this across versions — set it.)
2. **Docker enabled on boot** — `systemctl is-enabled docker` must say `enabled`
   (normally set by the Docker install; verify).
3. **SSD mounted BEFORE Docker starts** — Docker's data-root + Dokku storage are on the
   SSD. If Docker starts before the SSD mounts, containers come up pointing at empty
   paths (data "gone"). Fix with an `/etc/fstab` entry using **`nofail`** (so a missing
   disk doesn't hang boot) and a systemd mount-ordering dependency so `docker.service`
   waits for the mount.

```
# /etc/fstab  (example — use the SSD's UUID from `blkid`)
UUID=<ssd-uuid>  /mnt/ssd  ext4  defaults,nofail,x-systemd.before=docker.service  0  2
```
Then point Docker's data-root at the SSD (`/etc/docker/daemon.json`:
`{"data-root": "/mnt/ssd/docker"}`) and Dokku's storage lives under the SSD too.

This trio is the Docker-layer equivalent of the old `pm2 save` + `pm2 startup` — same
ceremony, different layer. "Works until the first power cut" is the classic miss here.

---

## 7. Observability — Grafana Cloud (logs + alerts)

Already wired: agor pushes structured JSON to Loki (`LOKI_*` config). Per-app, each
container does the same. **No Dokku/Docker log-driver config needed** — apps push
directly, which also dodges the "GitHub runner can't reach the Pi" problem for metrics.

**Health alerting is log-based** (no inbound port, works behind NAT):
- **Liveness:** alert if no `{"msg":"poll"}` event for app=agor in N minutes (the bot
  emits one per poll cycle) → "agor stopped polling".
- **Failure spike:** alert if the rate of `ok:false` poll events crosses a threshold →
  "agor watches failing / blocked".
- **Deploy health:** a deploy that crash-loops shows as a gap in poll events → caught by
  the liveness rule. (If you later want pre-cutover deploy gating, expose `/health` via
  `HEALTH_CHECK_PORT` + a Dokku `CHECKS` file — but mind the long-poll 409 overlap, §3.)

This replaces what a PaaS dashboard would give, using the Grafana you're already paying
for, and needs nothing inbound.

---

## 8. Migration from PM2 (what to remove)
- Delete `ecosystem.config.cjs` (PM2 process def).
- `DEPLOYMENT.md`: replace the PM2 long-poll runbook with a "Deploy via Dokku" section
  (this doc's §2–§6 condensed); keep the Cloudflare-Tunnel webhook section as the
  optional webhook path.
- `README.md`: the "new chats default to English" line is already stale (code defaults
  to Romanian) — fix opportunistically, unrelated.
- The PM2 memory-cap (`max_memory_restart: 300M`) → becomes a Dokku/Docker
  `mem-limit` if desired: `dokku resource:limit --memory 400m agor`.

---

## 9. Open items before implementation
1. ~~Pi connectivity for CI push~~ **DECIDED (2026-06-17):** Cloudflare Tunnel for ALL
   inbound (dynamic IP → irrelevant, zero open ports) + Cloudflare-Access service-token
   SSH for the deploy hop, from a GitHub-hosted runner (§5). Requires domain NS → Cloudflare.
2. **Zero-downtime overlap vs brief-downtime for the long-poll bot (§3).** Recommend
   brief-downtime to avoid the 409; trivial to flip. ← still to confirm.
3. **Verify-on-first-setup (can't be tested from here):** exact Dokku restart-policy
   default on the installed version; Cloudflare Access service-token SSH ProxyCommand on
   the exact cloudflared version; Playwright arm64 chromium install on the exact Pi OS
   image. All flagged; none are blockers, just "confirm on the box."
4. **Sequencing:** the agor-repo files (§2a–2c, §5a) become a PR **off `main`** — which
   requires draining the #8–#12 stack first. This doc is the spec for that PR.

## Agor-repo deliverables (the eventual PR, off main)
- `Dockerfile` (§2a) · `.dockerignore` (§2b) · `.github/workflows/deploy.yml` (§5a)
- `DEPLOYMENT.md` — new "Deploy via Dokku" section; remove PM2 runbook
- delete `ecosystem.config.cjs`
- optional: real `tsc` build to slim the image (hardening, §2a note)

## Machine-level (homelab runbook, NOT agor repo)
- §4 Dokku app setup · §6 boot/SSD config · §5b connectivity · Grafana alert rules (§7)
- the same `deploy.yml` convention copied into every other app's repo
