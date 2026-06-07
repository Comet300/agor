## ADDED Requirements

### Requirement: Provided Grafana dashboard
The project SHALL provide an importable Grafana dashboard for the agor log stream, querying the Loki datasource over `{service="agor"}` and surfacing poll volume, poll success/failure, poll duration, detections/alerts, anti-bot benches, and a live log stream.

#### Scenario: Import and view
- **WHEN** an operator imports `grafana/agor-logs.json` and selects their Loki datasource
- **THEN** the dashboard renders panels driven by the structured log fields (`component`, `ok`, `vendor`, `durationMs`, `newItems`, …) with no manual query authoring

#### Scenario: Vendor filter
- **WHEN** the operator selects one or more vendors in the dashboard's vendor variable
- **THEN** the poll panels filter to those vendors
