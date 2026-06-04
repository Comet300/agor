## ADDED Requirements

### Requirement: Webhook update intake
The gateway SHALL support receiving Telegram updates via webhook in addition to long-polling, selected by configuration: when a webhook URL is configured the bot serves updates from an HTTP listener and registers that URL with Telegram; otherwise it uses long-polling. A configured webhook secret SHALL be enforced so forged requests are rejected.

#### Scenario: Webhook mode when a URL is configured
- **WHEN** a webhook URL is configured and the bot starts
- **THEN** the gateway starts an HTTP listener on the configured port and registers the URL with Telegram (with the secret token when provided)

#### Scenario: Long-polling fallback by default
- **WHEN** no webhook URL is configured
- **THEN** the gateway uses long-polling, requiring no inbound port, and clears any previously registered webhook before polling

#### Scenario: Forged update rejected
- **WHEN** a webhook secret is configured and a request arrives without the matching secret-token header
- **THEN** the listener rejects it and no update is processed
