# scheduler-engine Specification

## Purpose
TBD - created by archiving change bootstrap-architecture. Update Purpose after archive.
## Requirements
### Requirement: Interval task management
The scheduler SHALL manage recurring monitor tasks on configurable intervals and pull due tasks from the persistence layer when their interval triggers.

#### Scenario: Due task retrieval
- **WHEN** a monitor's scheduled interval elapses
- **THEN** the scheduler marks the task due and hands it to the scraping phase

### Requirement: Batch grouping
The scheduler SHALL group due tasks that target the same destination into unified processing batches to optimize network utilization.

#### Scenario: Identical destinations batched
- **WHEN** multiple due tasks target the same domain/endpoint
- **THEN** the scheduler coalesces them into a single batched request cycle

### Requirement: Priority escalation
The scheduler SHALL maintain a priority queue and dynamically scale loop velocity, moving high-priority targets (e.g. an out-of-stock item awaiting restock) to a faster polling tier.

#### Scenario: Out-of-stock escalation
- **WHEN** a tracked item reports `inStock: false`
- **THEN** the scheduler escalates that task to the faster priority tier until stock returns

#### Scenario: De-escalation after restock
- **WHEN** a previously out-of-stock item transitions to `inStock: true`
- **THEN** the scheduler returns the task to its normal polling cadence

