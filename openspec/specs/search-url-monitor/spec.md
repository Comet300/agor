# search-url-monitor Specification

## Purpose
TBD - created by archiving change bootstrap-architecture. Update Purpose after archive.
## Requirements
### Requirement: Search URL registration and scrubbing
The system SHALL accept a valid HTTP/HTTPS marketplace filter URL matching a registered plugin domain, scrub volatile telemetry markers (e.g. `?utm_source=`, `&gclid=`) while retaining search parameters, and build a baseline of existing item IDs without firing notifications.

#### Scenario: Telemetry stripped, search params kept
- **WHEN** a user submits a filter URL containing `utm_source` and `gclid` plus genuine search filters
- **THEN** the system removes the tracking markers, preserves the search parameters, and stores the scrubbed URL

#### Scenario: Silent baseline indexing
- **WHEN** a search URL monitor is first registered
- **THEN** the system records all current item IDs as the baseline and sends no alerts for them

### Requirement: New-listing detection via set difference
The system SHALL identify new listings on each cycle as the set difference between current item IDs and historical item IDs (Δ = Current ∖ Historical) and alert only on the difference.

#### Scenario: New listing appears
- **WHEN** a polling cycle returns an item ID not present in the historical set
- **THEN** the system flags it as new and dispatches an alert for it

#### Scenario: No new listings
- **WHEN** a cycle returns only item IDs already in the historical set
- **THEN** the system dispatches no alert

### Requirement: Rich product card output
The system SHALL render each new-listing alert as a rich block showing the product card, source badge(s), pricing details, and quick-action trigger buttons.

#### Scenario: New-listing card rendered
- **WHEN** a new listing is alerted
- **THEN** the message shows its image, title, price, source badge, and action buttons

