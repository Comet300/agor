## ADDED Requirements

### Requirement: Monitor persistence
The persistence layer SHALL store user-registered monitors including their type (search-URL vs product), target URL, owning chat, user filter configuration, and check frequency.

#### Scenario: Monitor saved on registration
- **WHEN** a monitor completes registration
- **THEN** its definition and configuration are durably stored and retrievable by the scheduler

### Requirement: Item ID baseline persistence
The persistence layer SHALL store the set of known item IDs per monitor so set-difference delta detection can compare current against historical IDs.

#### Scenario: Baseline written without alerts
- **WHEN** the initial baseline indexing run completes
- **THEN** the discovered item IDs are saved with no notifications fired

#### Scenario: New IDs appended after a cycle
- **WHEN** a polling cycle discovers new item IDs
- **THEN** the layer appends them to the monitor's historical ID set

### Requirement: Price history persistence
The persistence layer SHALL record timestamped price points per tracked product to support price-drop detection and historical graphing.

#### Scenario: Price point recorded
- **WHEN** a product monitor cycle observes a price
- **THEN** a timestamped price entry is appended to that product's history sequence
