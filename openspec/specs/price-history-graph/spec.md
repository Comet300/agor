# price-history-graph Specification

## Purpose
TBD - created by archiving change bootstrap-architecture. Update Purpose after archive.
## Requirements
### Requirement: Price history extraction
The system SHALL extract the stored timestamped price points for a given tracking ID or notification reference from the persistence layer.

#### Scenario: History requested
- **WHEN** a user requests the price history for a tracked item
- **THEN** the system retrieves that item's full timestamped price sequence

### Requirement: PNG chart rendering
The system SHALL feed the extracted price points to an isolated graphics rendering pipeline and compile the output into a standalone `.png` asset.

#### Scenario: Chart rendered to PNG
- **WHEN** a price history is graphed
- **THEN** the system produces a `.png` image of the price-over-time chart and sends it as an image rather than text

#### Scenario: Insufficient history
- **WHEN** an item has fewer than two recorded price points
- **THEN** the system informs the user there is not yet enough history to chart

