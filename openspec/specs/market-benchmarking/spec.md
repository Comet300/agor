# market-benchmarking Specification

## Purpose
TBD - created by archiving change bootstrap-architecture. Update Purpose after archive.
## Requirements
### Requirement: Median computation across a target
The system SHALL gather the price arrays of all entries active within the same target URL and compute the statistical median (M) as the benchmark, isolating it against outlier listings.

#### Scenario: Median computed for a target
- **WHEN** new listings are enriched for a search-URL target
- **THEN** the system computes the median price across all currently active listings of that target

### Requirement: Threshold-based deal tagging
The system SHALL assign a deal tag to each evaluated listing based on its price relative to the median: `[🔥 Great Deal]` when Price ≤ M×0.85, `[📊 Fair Market Price]` when M×0.85 < Price ≤ M×1.05, and `[📈 Overpriced]` when Price > M×1.05.

#### Scenario: Great deal tag
- **WHEN** a listing's price is at or below 85% of the median
- **THEN** the system tags it `[🔥 Great Deal]`

#### Scenario: Fair price tag
- **WHEN** a listing's price is above 85% and at or below 105% of the median
- **THEN** the system tags it `[📊 Fair Market Price]`

#### Scenario: Overpriced tag
- **WHEN** a listing's price is above 105% of the median
- **THEN** the system tags it `[📈 Overpriced]`

