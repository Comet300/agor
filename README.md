# agor 🕵️

**Your tireless deal-hunting robot for online marketplaces.**

*Read this in another language: [English](./README.md) · [Română](./README.ro.md)*

You know the ritual: refresh a marketplace, refresh again, check another site,
*maybe* peek at a third, miss the good deal by 20 minutes, see it reposted next
day for 800 € more. agor ends the ritual. Paste a search link into Telegram, tap
**▶️ Start**, and go live your life — the bot watches the market and pings you
the moment something happens.

agor is **marketplace-agnostic**. The engine has **zero per-site code** — every
marketplace is a declarative YAML file in `plugins/`, so onboarding a new site
(any country, any category) means writing a manifest, not touching the engine.
It ships with eleven marketplaces integrated today (they happen to be Romanian —
that's where this started). **[Add your own →](./docs/ONBOARDING.md)**

## What it catches

- 🆕 **New listings** on any saved search — set-difference against everything
  it has already seen, so you're only pinged for *genuinely* new ads
- 📉 **Price drops** on a watched listing (with the savings spelled out)
- 🟢 **Back in stock** — out-of-stock items get polled on a *faster* tier,
  because restocks don't wait for polite schedules
- 🔥 **Deal tags** — every alert is benchmarked against the live market median
  (per currency): `🔥 great deal`, `📊 fair price`, or `📈 overpriced`
- 👯 **Cross-post collapse** — the same car posted on two sites becomes ONE
  alert with an "Also on:" line, not two pings at 7am
- 🚫 **Filters** — private vs. dealer sellers, exclusion keywords
  (`lovit, piese, dube` — gone), per-watch check frequency
- 📊 **Price history charts** rendered as PNGs, one tap away
- ✍️ **Offer drafts** — a copy-paste negotiation message anchored at −10%,
  rounded to a suspiciously human number
- ⚠️ **Health notices** — if a watch gets blocked or goes silent, the bot
  *tells you* instead of sulking quietly

## Add a marketplace

**Any marketplace can be onboarded by dropping a YAML manifest into `plugins/` —
no engine changes, no redeploy of logic.** A manifest declares *where the data
lives* and *which field maps to what*; the generic engine does the rest. New
site = new YAML; site redesign = edit that YAML.

The engine speaks four generic dialects of "where did you hide the data", so a
manifest just picks one:

- `script#__NEXT_DATA__` / `window.*` — embedded state JSON (incl. double-encoded
  `window.*` blobs)
- `ldjson` — schema.org blocks, tolerant of *creatively formatted* JSON
- `flight:<anchor>` — Next.js RSC streams (`self.__next_f` chunks, decoded and
  balanced-sliced)
- `dom-selector` — plain CSS selectors for server-rendered HTML

**→ Full walkthrough: [docs/ONBOARDING.md](./docs/ONBOARDING.md)** — pick a
dialect, find the payload, map the fields, and verify with a local test.

## Languages

The bot's UI is fully localized; pick yours with `/lang <code>`. Available today:

| Code | Language | README |
|---|---|---|
| `en` | English (default) | [README.md](./README.md) |
| `ro` | Română | [README.ro.md](./README.ro.md) |

Every user-facing string lives in one typed catalog (`src/gateway/strings.ts`),
and the type system makes a missing translation a *compile* error — so adding a
language is mechanical and can't ship half-done. Per-chat preference is
remembered; new chats default to English.

Commands: `/track <url>` (or just paste a link), `/list`, `/browse`, `/check <id>`,
`/remove <id>`, `/lang`, `/request-access`, `/help`. `/browse` flips through every
listing the bot has collected for you, one card at a time; tap **📌 Track** to
watch a specific item — tracked items alert on any price change (up or down) and
on de-listing.

## Who gets in

The bot is **deny-by-default**. A newcomer can only `/start` and `/request-access`
— which asks for a name and email, then notifies the admins (who approve or decline
with a tap). The **first person to complete `/request-access` becomes the admin**
automatically, so there's no chicken-and-egg setup; alternatively, seed known admin
chat ids via `ADMIN_CHAT_IDS`. Admins manage everyone from their own chat:
`/allow <id>`, `/deny <id>`, `/users`, `/userinfo <id>`, `/setname <id> <name>`,
`/setemail <id> <email>`, and `/promote <id>` / `/demote <id>` to make or unmake
other admins (the last admin can't be demoted). A declined user can re-apply after 7 days; revoking a user
pauses their watches (re-allowing resumes them). Name/email are tracking-only — they
live in the database (so you can see who a chat belongs to), never in logs.

## Run it

```bash
npm ci
cp .env.example .env       # add your BOT_TOKEN from @BotFather
npm test                   # 300+ tests, all green or your money back
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
matching Client Hints + `Sec-Fetch-*` and a per-storefront `Accept-Language`),
**redirect following** (a `www→apex` 301 no longer silently yields zero items), per-vendor
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

## Integrated marketplaces

Eleven shipped today (all Romanian — the first market this was pointed at).
Adding more from any country is a manifest away ([guide](./docs/ONBOARDING.md)).

| Cars | Real estate | General / other |
|---|---|---|
| OLX.ro | Storia.ro | Lajumate.ro |
| Autovit.ro | Imobiliare.ro | Publi24.ro |
| Carzz.ro | Imoradar24.ro | Vinted.ro |
| mobile.de (RO) | Homezz.ro | |

## License

[MIT](./LICENSE) © Valentin Mosor — take it, fork it, ship it; just keep the
copyright line. Happy hunting. 🏁
