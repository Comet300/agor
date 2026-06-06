## ADDED Requirements

### Requirement: Registered command menu
The bot SHALL register its command menu with Telegram on startup so the `/` autocomplete shows localized descriptions: Romanian as the default menu, with an English menu scoped to `en` Telegram clients. A failure to register SHALL be logged without aborting startup.

#### Scenario: Romanian menu registered by default
- **WHEN** the bot starts with a token
- **THEN** it registers the command list with Romanian descriptions as the default menu (and an English-scoped menu for `en` clients)

#### Scenario: Registration failure is non-fatal
- **WHEN** the `setMyCommands` call fails
- **THEN** the error is logged and the bot continues to run

### Requirement: List shows exclusion keywords
The `/list` output for a monitor SHALL include its active exclusion keywords when any are set.

#### Scenario: Monitor with exclusions
- **WHEN** a user runs `/list` and a monitor has exclusion keywords
- **THEN** that monitor's line includes the localized exclusion keywords

#### Scenario: Monitor without exclusions
- **WHEN** a monitor has no exclusion keywords
- **THEN** its line omits the exclusions segment
