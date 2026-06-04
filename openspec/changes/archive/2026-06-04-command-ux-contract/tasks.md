## 1. Localization core

- [x] 1.1 Add `src/gateway/strings.ts`: `Lang = 'ro'|'en'`, a `MessageKey` union, `messages: Record<Lang, Record<MessageKey, string | (p)=>string>>` (RO + EN), and `t(lang, key, params?)`
- [x] 1.2 Add `src/gateway/lang.ts`: `resolveLang(stored, telegramLangCode)` (stored → `en*`→en else ro → ro default)
- [x] 1.3 Test: both language maps share identical keysets; `t()` interpolation; resolution order

## 2. Chat-preference persistence

- [x] 2.1 Add `chat_prefs(chat_id PRIMARY KEY, lang)` to the schema (idempotent migration) and a `ChatPrefsRepo` (`getLang`, `setLang`) exposed on `Store`
- [x] 2.2 Test: set/read round-trip; unset returns undefined

## 3. Localized rendering

- [x] 3.1 Move every user-facing string in `render.ts` / `keyboards.ts` into the catalog; have `renderNotification(n, lang)`, `renderRegistrationCard(r, lang)`, and keyboard builders take a `Lang` (labels localized, callback data unchanged)
- [x] 3.2 Mark the active seller-visibility AND frequency preset in the registration keyboard; add `rm:` remove and `fq:<id>:<minutes>` frequency buttons
- [x] 3.3 Test: localized render snapshots (RO vs EN labels differ, callback data identical); deal-badge/offer formatting unchanged

## 4. Command surface

- [x] 4.1 Resolve `lang` per update from `ChatPrefsRepo` + `ctx.from?.language_code`; route all `bot.ts` replies through `t()`
- [x] 4.2 Add `/remove <id>` and `rm:<id>` (delete a monitor owned by the chat only); add `/lang [ro|en]`
- [x] 4.3 Wire `fq:<id>:<minutes>` to update `monitor.intervalMs` (presets 5/10/30/60) and reschedule
- [x] 4.4 `makeNotifier` resolves the recipient chat's language before rendering background alerts
- [x] 4.5 Test: the pure render/keyboard/command-helper logic for `/list` empty-state, `/lang` set/report, `rm`/`fq` callbacks, and notifier language lookup

## 5. Verification

- [x] 5.1 Full `npx tsc --noEmit` clean and `npx vitest run` green (no regression to the existing suite)
- [x] 5.2 Run `openspec validate command-ux-contract --strict`
