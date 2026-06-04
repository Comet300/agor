# seller-type-filter Specification

## Purpose
TBD - created by archiving change bootstrap-architecture. Update Purpose after archive.
## Requirements
### Requirement: B2C vs P2P toggle
The system SHALL expose an inline-keyboard toggle letting the user select whether corporate (B2C) listings, private peer-to-peer (P2P) listings, or both are visible, persisting the choice per monitor.

#### Scenario: User restricts to private sellers
- **WHEN** a user toggles the filter to private-only
- **THEN** the system stores that preference for the monitor

### Requirement: Filtering on isPrivateOwner
The system SHALL filter items against the `isPrivateOwner` property derived from the active YAML extraction schema and silently drop entries that fail the user's visibility restriction before data structures reach execution wrappers.

#### Scenario: Corporate listing dropped under private-only
- **WHEN** the monitor is set to private-only and an item has `isPrivateOwner: false`
- **THEN** the system silently drops it before notification

#### Scenario: Matching listing passes
- **WHEN** an item's `isPrivateOwner` value satisfies the user's selection
- **THEN** the system retains it for downstream processing

