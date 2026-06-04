# agor

A Telegram bot that monitors Romanian classified marketplaces (OLX, AutoVit,
Storia) for **new listings**, **price drops**, and **back-in-stock** events,
with market-value deal tags, cross-platform de-duplication, seller/keyword
filters, price-history charts, and one-tap contact/offer actions.

The engine is **data-driven**: vendor parsing lives in declarative YAML
manifests (`plugins/*.yaml`), so adding or repairing a marketplace is a config
change, not a code change. Two extraction engines are supported —
`json-extractor` (embedded `__NEXT_DATA__`/state JSON) and `dom-selector` (CSS
selectors for HTML-only sites).

## Stack

Node 20 (ESM) · TypeScript · grammY · better-sqlite3 · undici · @napi-rs/canvas
· vitest. Run via `tsx`.

## Quickstart (local)

```bash
npm ci
cp .env.example .env       # set BOT_TOKEN (from @BotFather)
npm test                   # 150+ tests
npm start                  # long-polling by default
```

Without a `BOT_TOKEN` the app still boots (scheduler runs, no Telegram delivery)
— handy for fixtures/CI.

## Run modes

- **Long-polling** (default): no public endpoint; leave `WEBHOOK_URL` empty.
- **Webhook** (production): set `WEBHOOK_URL` / `WEBHOOK_PORT` / `WEBHOOK_SECRET`
  and the bot serves updates from an HTTP listener (TLS terminated upstream).

## Deploy

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full Raspberry Pi + PM2 runbook,
including exposing HTTPS for webhook mode via a Cloudflare Tunnel.

## Commands

`/start` · `/help` · `/track <url>` (or paste a link) · `/list` · `/remove <id>`
· `/lang ro|en`. UI is Romanian by default (auto-detected, switchable).

## Spec & workflow

The architecture and behavior are specified under `openspec/specs/`; all changes
go through the OpenSpec propose → implement → archive flow (`openspec/changes/`).
