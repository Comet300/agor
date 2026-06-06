# localization Specification

## Purpose
TBD - created by archiving change command-ux-contract. Update Purpose after archive.
## Requirements
### Requirement: Message catalog
All user-facing text (commands, cards, notifications, errors, button labels) SHALL be sourced from a typed message catalog providing both `ro` and `en`, looked up via `t(lang, key, params?)`. No user-facing string is hard-coded at a call site.

#### Scenario: Both languages cover every key
- **WHEN** the catalog is loaded
- **THEN** the `ro` and `en` maps expose exactly the same set of message keys (no key missing in either language)

#### Scenario: Parameterized messages
- **WHEN** a message needs runtime values (e.g. a price or count)
- **THEN** `t(lang, key, params)` returns the localized string with those values interpolated

### Requirement: Language resolution and switching
The chat language SHALL resolve as: the stored chat preference if set, otherwise the Romanian (`ro`) default. The Telegram `language_code` SHALL NOT influence the language. `/lang ro|en` SHALL persist the preference; `/lang` with no argument SHALL report the current language.

#### Scenario: Romanian default regardless of Telegram locale
- **WHEN** a chat has no stored preference, whatever the Telegram `language_code`
- **THEN** the bot replies in Romanian

#### Scenario: Explicit override persists
- **WHEN** a user sends `/lang en` (or `/lang ro`)
- **THEN** the preference is stored and all subsequent replies and background notifications for that chat use that language

#### Scenario: English only by explicit opt-in
- **WHEN** an English-locale user has not sent `/lang en`
- **THEN** they receive Romanian until they explicitly switch

### Requirement: Localized background notifications
Background alerts SHALL be rendered in the recipient chat's resolved language, looked up by the notifier (since alerts are produced without an incoming update context).

#### Scenario: Alert respects stored language
- **WHEN** a monitor in a chat that selected `en` produces a new-listing alert
- **THEN** the delivered card is rendered in English

