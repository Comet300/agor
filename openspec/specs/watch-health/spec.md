# watch-health Specification

## Purpose
TBD - created by archiving change watch-health-and-check. Update Purpose after archive.
## Requirements
### Requirement: Failure detection and notification
The orchestrator SHALL track each monitor's consecutive unhealthy cycles and notify the owning chat once when the count reaches the configured threshold, and once when the watch next recovers. An unhealthy cycle is one whose scrape failed, or — for a search monitor that previously had listings — one that succeeded but returned zero items. A healthy cycle resets the count.

#### Scenario: A blocked watch is surfaced once
- **WHEN** a monitor's cycle fails for the threshold number of consecutive polls
- **THEN** the chat receives one "watch failing" notice (not one per cycle), naming the monitor and vendor

#### Scenario: Recovery is surfaced once
- **WHEN** a previously-failing monitor (already notified) next polls successfully with results
- **THEN** the chat receives one "watch recovered" notice and the failure count resets

#### Scenario: Empty search after having listings
- **WHEN** a search monitor that previously had listings returns zero items for the threshold consecutive polls
- **THEN** it is treated as unhealthy and surfaced (covering manifest drift / silent blocks)

#### Scenario: Intentional or genuinely-empty states do not alarm
- **WHEN** a product's single item is filtered out by the user's settings, or a brand-new search with no prior baseline returns zero
- **THEN** no failure is counted

### Requirement: On-demand check
The bot SHALL provide `/check <id>` to poll a chat-owned monitor immediately and reply with the outcome (success with item/new counts, or a failure indication). A monitor not owned by the chat SHALL NOT be checked.

#### Scenario: Check a working watch
- **WHEN** a user runs `/check <id>` for a monitor they own
- **THEN** the bot polls it now and replies with the result (e.g. items found and how many were new)

#### Scenario: Check a failing watch
- **WHEN** `/check <id>` polls a monitor whose scrape fails
- **THEN** the bot replies that the check failed (possibly blocked)

#### Scenario: Not owned
- **WHEN** `/check <id>` references a monitor not owned by the chat (or no id)
- **THEN** the bot replies with a not-found / usage message and does not poll it

