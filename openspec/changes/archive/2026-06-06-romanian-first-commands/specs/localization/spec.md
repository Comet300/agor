## MODIFIED Requirements

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
