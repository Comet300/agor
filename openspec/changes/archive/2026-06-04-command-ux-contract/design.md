## Context

The gateway (`bot.ts`, `render.ts`, `keyboards.ts`) hard-codes English strings and ad-hoc callback-data formats. Commands work but are undocumented; the registration tuning card advertises a frequency toggle that was never wired, and there is no way to remove a monitor from chat. The audience is Romanian, so RO must be the default with EN available.

## Goals / Non-Goals

**Goals:**
- A single source of truth for every user-facing string, keyed and available in `ro` + `en`.
- A stable, documented callback-data grammar covering every inline button.
- Complete the tuning surface: change check frequency, remove a monitor.
- Per-chat language with sensible resolution and a `/lang` override.
- Zero change to the monitoring engine.

**Non-Goals:**
- No translation of scraped listing data (titles/locations stay as the vendor wrote them).
- No third-party i18n library — a small typed catalog is enough for two languages.
- No per-user (within a group) language; preference is per chat.

## Decisions

### Typed message catalog over an i18n library
`src/gateway/strings.ts` exports `type Lang = 'ro' | 'en'` and `messages: Record<Lang, Record<MessageKey, string | (p) => string>>`, with `t(lang, key, params?)`. `MessageKey` is a string-literal union so TypeScript fails the build if a key is missing in either language (completeness is compile-checked, not just tested).
*Why:* two languages and a few dozen keys don't justify a dependency; a typed record gives compile-time completeness and zero runtime cost.

### Language resolution order
`resolveLang(chatId, telegramLangCode)` = stored chat preference → (`telegramLangCode` starts with `en` ⇒ `en`, else `ro`) → `ro`. `/lang ro|en` writes the stored preference; `/lang` with no arg shows the current one.
*Why:* respects an explicit choice first, then the user's Telegram locale, then the RO default for the target market.

### Per-chat preference in a new table
`chat_prefs(chat_id INTEGER PRIMARY KEY, lang TEXT)` with a tiny `ChatPrefsRepo` (`getLang`, `setLang`). Added to the persistence layer rather than overloaded onto `monitors` (language is a chat property, and a chat may have zero monitors).
*Why:* clean separation; a chat can set a language before creating any monitor.

### Render + notifier take `lang`
`renderNotification(n, lang)`, `renderRegistrationCard(r, lang)`, and the keyboard builders take a `Lang`. `makeNotifier` resolves the recipient chat's language from `ChatPrefsRepo` (default `ro`) before rendering, so background alerts are localized too. Command handlers resolve `lang` from `ctx.chat.id` + `ctx.from?.language_code` per update.
*Why:* notifications are produced off a background cycle with no `ctx`, so the notifier must look the language up itself.

### Callback-data grammar (pinned)
`sv:<id>:<private|company|both>`, `ex:<id>`, `go:<id>`, `pg:<vendor>:<id>` (or `pg:<id>` when the verbose form exceeds 64 bytes), `fq:<id>:<minutes>`, `rm:<id>`. Colon-delimited, ASCII, `<id>` numeric — well within Telegram's 64-byte cap. Labels are localized; the data is not.
*Why:* a fixed wire format is forward-compatible and unit-testable independent of copy.

## Risks / Trade-offs

- **Catalog drift** (a key used but untranslated) → Mitigated by the `MessageKey` union: an unknown or missing key is a type error; a test also asserts both maps share identical keysets.
- **Markdown/emoji per language** → Keep formatting identical across languages; only words differ, so the offer draft's backtick code-span and badge emoji stay shared.
- **Frequency input validation** → `fq:` offers a fixed set of presets (e.g. 5/10/30/60 min) as buttons rather than free text, avoiding parse/abuse issues; the value maps to `intervalMs`.

## Migration Plan

Additive: new `chat_prefs` table (created by the idempotent migration; existing DBs gain it on next open). Resolution falls back to `ro` for chats with no stored preference, so nothing breaks. Order: catalog + `t()` → `ChatPrefsRepo` → render/keyboards take `lang` → bot handlers resolve + new commands → tests.

## Open Questions

- Frequency presets: which intervals to expose (proposed 5 / 10 / 30 / 60 minutes)?
- Should `/remove` require a confirmation tap, or remove immediately on `rm:<id>`? (Proposed: immediate, with an undo hint in the reply.)
