## ADDED Requirements

### Requirement: Check command
The command grammar SHALL include `/check <id>` to poll a chat-owned monitor on demand, and the registered command menu SHALL list it.

#### Scenario: Check command in the menu and grammar
- **WHEN** the command menu is registered and a user types `/check <id>`
- **THEN** `/check` appears in the menu with a localized description, and the command polls the monitor and replies with the outcome
