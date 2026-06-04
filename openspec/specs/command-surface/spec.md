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

