## Why

The bot is built for a Romanian audience, but it currently **auto-switches to English** when the user's Telegram client is set to English — so the operator sees English despite Romanian being the intended default. The Telegram command menu (the `/` autocomplete with descriptions) is also unregistered, and `/list` does not show a monitor's exclusion keywords, so the user can't see what a watch is filtering out.

## What Changes

- **Romanian-first**: language resolves to a stored preference, otherwise **Romanian** — dropping the Telegram-`language_code` auto-switch. English remains available via `/lang en`.
- **Romanian command menu**: register the command list via `setMyCommands` on startup (Romanian as the default menu; an English menu scoped to `en` Telegram clients).
- **`/list` shows exclusions**: each listed monitor includes its active exclusion keywords when set.

## Capabilities

### New Capabilities
None.

### Modified Capabilities

- `localization`: MODIFY language resolution — stored preference, else `ro` (no Telegram-locale detection); `/lang en` is the explicit opt-in to English.
- `command-surface`: ADD a registered Telegram command menu, and `/list` output that includes a monitor's exclusion keywords.

## Impact

- **Code**: `src/gateway/lang.ts` (resolve to RO without the locale branch), `src/gateway/bot.ts` (`langFor` drops the locale arg; `/list` includes exclusions), `src/index.ts` (register the command menu on boot), `src/gateway/strings.ts` (`list_item` gains exclusions; a `commandMenu` per language).
- **Tests**: resolution defaults to RO regardless of locale; `list_item` renders exclusions; command-menu catalog parity.
- **No engine/scraping change.** Operational: restart the bot to register the menu.
