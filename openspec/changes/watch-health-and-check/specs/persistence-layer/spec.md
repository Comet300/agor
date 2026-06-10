## ADDED Requirements

### Requirement: Consecutive-failure persistence
The persistence layer SHALL store a per-monitor consecutive-failure count, defaulting to zero, readable on the monitor and updatable independently, so the failure/recovery state survives restarts.

#### Scenario: Failure count round-trips
- **WHEN** a monitor's consecutive-failure count is set to 3
- **THEN** loading that monitor reports a count of 3

#### Scenario: Default zero
- **WHEN** a monitor is created
- **THEN** its consecutive-failure count is 0
