# observability Specification

## Purpose
TBD - created by archiving change observability-logging. Update Purpose after archive.
## Requirements
### Requirement: Every poll is logged
The system SHALL emit exactly one structured log event per monitor poll, carrying at least: monitor id, vendor, monitor type, success flag, HTTP status, count of active items seen, count of new items, count of notifications dispatched, and the poll duration in milliseconds. A failed poll SHALL be logged at warning level with a reason.

#### Scenario: Successful poll
- **WHEN** the scheduler runs a monitor cycle that completes
- **THEN** one structured event is logged with the monitor/vendor, `ok: true`, status, item counts, notifications, and duration

#### Scenario: Failed poll
- **WHEN** a poll fails (fetch error, soft-fail extraction, or a non-2xx/blocked response)
- **THEN** one structured warning event is logged with the monitor/vendor, `ok: false`, status, and a reason

### Requirement: Failure and anti-bot visibility
The scraping path SHALL log proxy bench events on `429`/`403`, retries, and soft-fail extraction (an unlocatable/unparseable payload), so blocks and vendor layout changes are observable rather than silent.

#### Scenario: Proxy benched
- **WHEN** a request returns `429`/`403` and the engine benches the proxy and retries
- **THEN** a warning event records the vendor, status, and that the proxy was benched

### Requirement: Level-controlled structured logging
All operational logging SHALL be structured (JSON) and gated by `LOG_LEVEL` (`trace|debug|info|warn|error|fatal|silent`), always written to stdout.

#### Scenario: Level filtering
- **WHEN** `LOG_LEVEL` is `warn`
- **THEN** `info`/`debug` events are suppressed and `warn`/`error` events are emitted

### Requirement: Ship to Grafana Cloud Loki when configured
When a Loki URL, user, and token are configured, logs SHALL additionally be shipped to that Loki endpoint (batched, with service/env labels). When Loki is not fully configured, the system SHALL log to stdout only and run normally.

#### Scenario: Loki configured
- **WHEN** the Loki URL, user, and token are all set
- **THEN** logs are batched and pushed to `${LOKI_URL}/loki/api/v1/push` with Basic auth and labels, in addition to stdout

#### Scenario: Loki not configured
- **WHEN** any of the Loki settings is missing
- **THEN** logging is stdout-only and startup is unaffected

### Requirement: Secrets are never logged
The system SHALL NOT log secret values (bot token, proxy credentials, Loki token). Startup logging SHALL include only non-secret summary (mode, db path, vendor count, and booleans for whether proxy/Loki are configured).

#### Scenario: No secret leakage
- **WHEN** the system logs startup and per-poll events
- **THEN** no bot token, proxy credential, or Loki token value appears in any log

### Requirement: Provided Grafana dashboard
The project SHALL provide an importable Grafana dashboard for the agor log stream, querying the Loki datasource over `{service="agor"}` and surfacing poll volume, poll success/failure, poll duration, detections/alerts, anti-bot benches, and a live log stream.

#### Scenario: Import and view
- **WHEN** an operator imports `grafana/agor-logs.json` and selects their Loki datasource
- **THEN** the dashboard renders panels driven by the structured log fields (`component`, `ok`, `vendor`, `durationMs`, `newItems`, …) with no manual query authoring

#### Scenario: Vendor filter
- **WHEN** the operator selects one or more vendors in the dashboard's vendor variable
- **THEN** the poll panels filter to those vendors

