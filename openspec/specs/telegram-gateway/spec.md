# telegram-gateway Specification

## Purpose
TBD - created by archiving change bootstrap-architecture. Update Purpose after archive.
## Requirements
### Requirement: Update intake
The gateway SHALL be the exclusive interface between users and the system, consuming incoming Telegram updates via either long-polling or webhook and forwarding validated commands to the Core Orchestrator.

#### Scenario: Command received
- **WHEN** a user sends a command or message to the bot
- **THEN** the gateway ingests the update and routes it to the Core Orchestrator for validation

#### Scenario: No business logic in the gateway
- **WHEN** an incoming update requires scraping, filtering, or analytics
- **THEN** the gateway delegates entirely to the orchestrator and performs no domain logic itself

### Requirement: Inline keyboard state
The gateway SHALL render and mutate inline keyboards to capture user configuration (listing-type toggles, exclusion strings, check frequency) and reflect state changes back into the message.

#### Scenario: Toggle mutates keyboard
- **WHEN** a user taps an inline toggle (e.g. company/private listings)
- **THEN** the gateway updates the keyboard to show the new state and persists the choice via the orchestrator

### Requirement: Unified message blocks
The gateway SHALL output alerts as unified message blocks containing the product card, source badges, pricing details, and context-aware quick-action buttons.

#### Scenario: Alert dispatched
- **WHEN** the pipeline produces a notification payload
- **THEN** the gateway renders it as a single rich message block with quick-action buttons attached

