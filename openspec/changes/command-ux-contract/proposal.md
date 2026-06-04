## Why

The bot's command names, button labels, and callback-data strings currently live only in the gateway implementation — they are not a contract, so there is nothing to test copy against and no guarantee they stay stable. The user-facing strings are also English-only and hard-coded inline, even though the target audience is Romanian. This change pins the **command + interaction surface** as a spec and moves all copy into a **localized catalog** (Romanian by default, English on request).

## What Changes

- Pin the exact **command surface**: `/start`, `/help`, `/track`, `/list`, `/remove`, `/lang`, plus the plain-URL shortcut — each with defined behavior and arguments.
- Pin the **callback-data contract** for every inline button (`sv:`, `ex:`, `go:`, `pg:`, `fq:`, `rm:`) so the wire format is stable and testable.
- Complete the tuning card: wire the **check-frequency** control (`fq:`) and a **remove** control (`rm:`), which the bootstrap left unimplemented.
- Introduce **localization**: a message catalog with `ro` and `en`, a `t(lang, key, params)` lookup, and a per-chat language resolved as *stored preference → Telegram `language_code` → `ro` default*, switchable via `/lang`.
- Route **all** user-facing strings (commands, cards, notifications, errors) through the catalog — no inline copy.
- Persist a per-chat language preference.

## Capabilities

### New Capabilities

- `command-surface`: the bot's command grammar and callback-data contract — every command/button, its behavior, arguments, and stable wire format.
- `localization`: RO/EN message catalog, language resolution (stored → Telegram locale → RO), `/lang` switching, and the rule that all user-facing text is sourced from the catalog.

### Modified Capabilities

- `persistence-layer`: ADD per-chat preference storage (the selected language).

## Impact

- **Code**: new `src/gateway/strings.ts` (catalog + `t()`), new `src/gateway/lang.ts` (resolution); `src/gateway/render.ts` and `src/gateway/bot.ts` take a `lang` and pull copy from the catalog; new `/remove`, `/lang`, and frequency/remove callback handlers; `src/gateway/keyboards.ts` labels become localized.
- **Persistence**: new `chat_prefs(chat_id, lang)` table + repo; `makeNotifier` looks up a chat's language before rendering.
- **No behavior change** to the monitoring engine, scraping, pipeline, or scheduler — this is presentation + persistence only.
- **Tests**: catalog completeness (every key in both languages), language resolution, localized render snapshots, and the new command/callback handlers.
