# product-price-monitor Specification

## Purpose
TBD - created by archiving change bootstrap-architecture. Update Purpose after archive.
## Requirements
### Requirement: Single-product price tracking
The system SHALL accept a direct canonical single-product URL and persist its current price into the product's tracking history on each cycle.

#### Scenario: Price persisted each cycle
- **WHEN** a product monitor cycle observes the product's current price
- **THEN** the system appends a timestamped price point to that product's history

### Requirement: Price-drop alerting only
The system SHALL dispatch an alert if and only if the current price is strictly less than the previous recorded price (Price_current < Price_previous).

#### Scenario: Price decreases
- **WHEN** the current price is lower than the previously recorded price
- **THEN** the system dispatches a price-drop alert

#### Scenario: Price increases or is unchanged
- **WHEN** the current price is greater than or equal to the previous price
- **THEN** the system records the price but dispatches no alert

### Requirement: Delta warning output
The system SHALL render price-drop alerts as a single-line delta warning highlighting the raw savings between previous and current price.

#### Scenario: Savings highlighted
- **WHEN** a price-drop alert is produced
- **THEN** the message shows the old price, new price, and the savings amount on a single highlighted line

