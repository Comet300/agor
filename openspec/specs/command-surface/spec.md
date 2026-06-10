# command-surface Specification

## Purpose
TBD - created by archiving change command-ux-contract. Update Purpose after archive.
## Requirements
### Requirement: Command grammar
The bot SHALL expose a fixed set of commands, each with defined behavior: `/start` (welcome + usage), `/help` (usage), `/track <url>` and a plain HTTP(S) URL message (register a monitor), `/list` (list this chat's monitors), `/remove <id>` (stop and delete a monitor owned by this chat), and `/lang [ro|en]` (show or set the chat language).

#### Scenario: Track via command or plain URL
- **WHEN** a user sends `/track <url>` or a bare HTTP(S) URL
- **THEN** the bot registers a monitor for that URL and replies with the tuning card

#### Scenario: List shows this chat's monitors
- **WHEN** a user sends `/list`
- **THEN** the bot replies with the chat's monitors (id, vendor, type, target), or an empty-state message when there are none

#### Scenario: Remove a monitor
- **WHEN** a user sends `/remove <id>` or taps the remove button for a monitor they own
- **THEN** the bot deletes that monitor and confirms; a monitor not owned by the chat is never removed

#### Scenario: Unknown command
- **WHEN** a user sends an unrecognized command
- **THEN** the bot replies with a short hint pointing to `/help`

### Requirement: Callback-data contract
Every inline button SHALL use a stable, colon-delimited ASCII callback-data format under 64 bytes: `sv:<id>:<private|company|both>` (seller visibility), `ex:<id>` (exclusion prompt), `fq:<id>:<minutes>` (check frequency), `go:<id>` (start monitoring), `rm:<id>` (remove), and `pg:<vendor>:<id>` / `pg:<id>` (price history). Button labels are localized; the callback data is not.

#### Scenario: Stable wire format
- **WHEN** any inline keyboard is rendered
- **THEN** its buttons carry callback data matching the grammar above, with a numeric `<id>` and total length within Telegram's 64-byte limit

#### Scenario: Frequency control sets the interval
- **WHEN** a user taps a frequency preset (`fq:<id>:<minutes>`)
- **THEN** the monitor's check interval is updated to that many minutes and the keyboard reflects the selected preset

#### Scenario: Labels localized, data stable
- **WHEN** the same keyboard is rendered in `ro` versus `en`
- **THEN** the button labels differ by language while the callback-data strings are identical

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

### Requirement: Check command
The command grammar SHALL include `/check <id>` to poll a chat-owned monitor on demand, and the registered command menu SHALL list it.

#### Scenario: Check command in the menu and grammar
- **WHEN** the command menu is registered and a user types `/check <id>`
- **THEN** `/check` appears in the menu with a localized description, and the command polls the monitor and replies with the outcome

