## ADDED Requirements

### Requirement: Configuration and secrets via environment
All runtime configuration and secrets (bot token, proxy credentials, database path, webhook settings) SHALL be supplied via environment variables and never committed to the repository.

#### Scenario: Secrets are not committed
- **WHEN** the repository is inspected
- **THEN** `.env` is git-ignored and only `.env.example` (placeholder values) is tracked

#### Scenario: Config is environment-driven
- **WHEN** the app boots
- **THEN** it reads its settings from the environment with validated defaults, requiring no code edits to deploy

### Requirement: Selectable update mode
The runtime mode SHALL be a pure function of configuration: webhook when a webhook URL is set, otherwise long-polling.

#### Scenario: Mode follows configuration
- **WHEN** a webhook URL is present in config
- **THEN** `selectMode` returns webhook; when absent it returns long-polling

### Requirement: Graceful degraded boot
The app SHALL boot without a Telegram token, logging a warning and running the scheduler with a no-op notifier, so headless/fixture operation never crashes at startup.

#### Scenario: No token present
- **WHEN** the app starts with no bot token
- **THEN** it logs a warning, wires a no-op notifier, starts the scheduler, and does not throw

### Requirement: Documented connection runbook
The project SHALL provide a deployment runbook covering, for the target host, obtaining a bot token, configuring environment, exposing an HTTPS endpoint for webhook mode, running under a process manager that survives reboots, and verifying the connection.

#### Scenario: Runbook present and reproducible
- **WHEN** an operator follows the runbook on the target host
- **THEN** the steps take them from a fresh checkout to a running, connected bot, including the HTTPS exposure a home network lacks and process persistence across reboots
