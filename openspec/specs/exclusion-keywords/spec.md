# exclusion-keywords Specification

## Purpose
TBD - created by archiving change bootstrap-architecture. Update Purpose after archive.
## Requirements
### Requirement: Keyword input parsing
The system SHALL accept a comma-separated string of exclusion tokens and parse it into a clean keyword array, trimming whitespace and lowercasing each token (`input.split(',').map(s => s.trim().toLowerCase())`).

#### Scenario: Raw input normalized
- **WHEN** a user submits `"Broken, FOR parts ,  damaged"`
- **THEN** the system stores the keywords as `["broken", "for parts", "damaged"]`

### Requirement: Full-text exclusion matching
The system SHALL run word-boundary regex matches for the union of keywords across each incoming item's text and drop any item that produces a match before it reaches the messaging queue.

#### Scenario: Excluded item dropped
- **WHEN** an item's title or text matches any exclusion keyword on a word boundary
- **THEN** the system removes it completely from the notification queue

#### Scenario: Non-matching item passes
- **WHEN** an item's text matches none of the exclusion keywords
- **THEN** the system retains it for downstream processing

