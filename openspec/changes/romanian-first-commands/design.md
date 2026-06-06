## Context

`resolveLang(stored, telegramCode)` currently returns stored → (`telegramCode` starts with `en` ⇒ `en`) → `ro`. For a Romanian-audience bot that makes an English-locale operator see English. The `/lang` override and per-chat persistence already exist; only the *default* should change. Separately, `setMyCommands` is never called (empty `/` menu) and `/list` omits exclusion keywords.

## Goals / Non-Goals

**Goals:** Romanian by default for everyone; English still reachable via `/lang en`; a Romanian command menu (English menu for `en` clients); `/list` shows a monitor's exclusions.
**Non-Goals:** Removing English (kept). No Romanian command-name aliases (English command tokens stay; only descriptions are localized). No engine change.

## Decisions

### Drop the Telegram-locale branch
`resolveLang(stored)` = `isLang(stored) ? stored : 'ro'`. The `telegramCode` parameter and the `en*` auto-switch are removed; call sites stop passing `ctx.from?.language_code`. *Why:* the user explicitly wants Romanian-first; the locale heuristic was the only thing overriding it, and an explicit `/lang en` is a clearer opt-in than client locale.

### Command menu via `setMyCommands`, language-scoped
On startup register the menu twice: the Romanian list as the default, and the English list scoped to `language_code: 'en'`. *Why:* the `/` menu is a Telegram-UI surface keyed by the client's locale; a Romanian default with an English fallback keeps both audiences served without affecting the (now Romanian-first) message language. Descriptions come from a `commandMenu: Record<Lang, {command, description}[]>` in the catalog so they stay localized and complete.

### `/list` exclusions in the catalog
`list_item` gains an `exclusions: string` field; when non-empty it appends a localized "· excluse: …" segment. *Why:* keeping it in the templated catalog string preserves the single-source-of-truth and RO/EN parity.

## Risks / Trade-offs

- **Existing English-locale users** who relied on auto-English now get Romanian until they `/lang en` — intended, and a one-tap fix. Stored preferences are untouched.
- **`setMyCommands` is a network call** at boot; wrap it so a failure logs but doesn't abort startup (the bot still works; the menu just isn't updated).

## Migration Plan

Behavior change is config-free and additive in code. Deploy: restart the bot (registers the menu, applies the new default). Rollback: restore the locale branch in `resolveLang`. Stored `/lang` preferences continue to win in both directions.

## Open Questions
None.
