# agor 🕵️

**Your tireless deal-hunting robot for Romanian marketplaces.**

You know the ritual: refresh OLX, refresh again, check Autovit, *maybe* peek at
Storia, miss the good Suzuki by 20 minutes, see it reposted next day for 800 €
more. agor ends the ritual. Paste a search link into Telegram, tap **▶️
Pornește**, and go live your life — the bot watches the market and pings you
the moment something happens.

## What it catches

- 🆕 **New listings** on any saved search — set-difference against everything
  it has already seen, so you're only pinged for *genuinely* new ads
- 📉 **Price drops** on a watched listing (with the savings spelled out)
- 🟢 **Back in stock** — out-of-stock items get polled on a *faster* tier,
  because restocks don't wait for polite schedules
- 🔥 **Deal tags** — every alert is benchmarked against the live market median:
  `🔥 Chilipir`, `📊 Preț corect`, or `📈 Supraevaluat`
- 👯 **Cross-post collapse** — the same car posted on two sites becomes ONE
  alert with an "Also on:" line, not two pings at 7am
- 🚫 **Filters** — private vs. dealer sellers, exclusion keywords
  (`lovit, piese, dube` — gone), per-watch check frequency
- 📊 **Price history charts** rendered as PNGs, one tap away
- ✍️ **Offer drafts** — a copy-paste negotiation message anchored at −10%,
  rounded to a suspiciously human number
- ⚠️ **Health notices** — if a watch gets blocked or goes silent, the bot
  *tells you* instead of sulking quietly

## Where it hunts

| Cars | Real estate | Everything else |
|---|---|---|
| OLX.ro | Storia.ro | Lajumate.ro |
| Autovit.ro | Imobiliare.ro | Publi24.ro |
| Carzz.ro | Imoradar24.ro | Vinted.ro |
| mobile.de (RO) | Homezz.ro | |

Eleven marketplaces, **zero per-site code**. Every vendor is a declarative YAML
manifest (`plugins/*.yaml`); the engine speaks four generic dialects of
"where did you hide the data":

- `script#__NEXT_DATA__` / `window.*` — embedded state JSON (incl. OLX's
  double-encoded `__PRERENDERED_STATE__`)
- `ldjson` — schema.org blocks, tolerant of, ahem, *creatively formatted* JSON
- `flight:<anchor>` — Next.js RSC streams (`self.__next_f` chunks, decoded and
  balanced-sliced)
- `dom-selector` — good old CSS selectors for honest server-rendered HTML

New marketplace = new YAML file. Site redesign = edit the YAML. The engine
doesn't care.

## The bot speaks Romanian 🇷🇴

Romanian-first UI (it's hunting Romanian marketplaces, after all), full English
one tap away with `/lang en`. Commands: `/track <url>` (or just paste a link),
`/list`, `/check <id>`, `/remove <id>`, `/lang`, `/help`.

## Run it

```bash
npm ci
cp .env.example .env       # add your BOT_TOKEN from @BotFather
npm test                   # ~190 tests, all green or your money back
npm start                  # long-polling — works from any laptop, behind any NAT
```

No token? It still boots in headless mode (scheduler runs, nothing delivered) —
handy for CI and tinkering.

### Production

It lives happily on a **Raspberry Pi under PM2**, optionally with **webhooks
via a Cloudflare Tunnel** and **structured logs shipped to Grafana Cloud**
(one JSON event per poll — "did it check alright every time?" is a dashboard
panel, not a mystery). The full from-zero runbook, including the ARM
gotchas and a ready-made Grafana dashboard (`grafana/agor-logs.json`), is in
**[DEPLOYMENT.md](./DEPLOYMENT.md)**.

## Under the hood

Node 20 (ESM) · TypeScript · [grammY](https://grammy.dev) · better-sqlite3 ·
undici · @napi-rs/canvas · pino (→ Loki) · vitest.

Anti-bot etiquette: browser-mirroring headers (rotated desktop-Chrome UA with
matching Client Hints + `Sec-Fetch-*`, `ro-RO` and everything), **redirect
following** (a `www→apex` 301 no longer silently yields zero items), per-vendor
rate limits, rotating proxy pool with bench-and-retry on 429/403, and *soft-fail*
extraction — a site redesign degrades into an empty cycle and a polite health
notice, never a crash loop.

Block-aware fetching: a recognised anti-bot wall is detected from **response
headers** (Akamai/Cloudflare/Imperva/Fastly/CloudFront signatures + a deny
status — never a body grep, which false-positives the anti-bot SDKs every
working page embeds). A vendor that stays blocked or failing trips a **per-vendor
circuit breaker** so a dead domain isn't hammered every cycle. Manifests may opt
into a **headless-browser fallback** (`fetch_strategy: browser`, lazy Playwright
+ stealth) for JS-gated or fingerprinted vendors (e.g. mobile.de) — off by
default (`ENABLE_BROWSER_FALLBACK`), so the Raspberry Pi base install never needs
Chromium. New watches are validated at registration: a 4xx/dead URL is rejected
up-front, and a post-redirect canonical URL is persisted.

The architecture is fully specified: every behavior lives in
`openspec/specs/`, and every change ships through an
[OpenSpec](https://github.com/Fission-AI/OpenSpec) propose → implement →
archive cycle (`openspec/changes/`). Yes, even this README's repo had its
features speced first. 📋

## License

[MIT](./LICENSE) © Valentin Mosor — take it, fork it, ship it; just keep the
copyright line. Happy hunting. 🏁
