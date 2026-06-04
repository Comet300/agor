## ADDED Requirements

### Requirement: Runtime input validation
The orchestrator SHALL validate all runtime inputs before acting on them, including verifying that a submitted URL matches a registered plugin domain.

#### Scenario: URL matches a registered domain
- **WHEN** a user submits a marketplace URL whose domain matches a loaded plugin
- **THEN** the orchestrator accepts it and proceeds to configuration initialization

#### Scenario: URL matches no registered domain
- **WHEN** a user submits a URL with no matching plugin domain
- **THEN** the orchestrator rejects it with a standard error alert and does not create a monitor

### Requirement: Job routing
The orchestrator SHALL route validated requests to the correct downstream component (Scheduler, Scraping Engine, Pipeline) and coordinate state between user sessions and background scraping nodes.

#### Scenario: Monitor registration routed
- **WHEN** a validated monitor request arrives
- **THEN** the orchestrator coordinates the baseline indexing run and registers the recurring task with the Scheduler

### Requirement: Pipeline coordination
The orchestrator SHALL feed raw scraped data arrays into the Data Processing Pipeline and relay the resulting notification payloads to the Telegram Gateway.

#### Scenario: Raw data handed to pipeline
- **WHEN** the Scraping Engine returns raw payloads for a due task
- **THEN** the orchestrator passes them through the pipeline and forwards any resulting alerts to the gateway
