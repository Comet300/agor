## ADDED Requirements

### Requirement: Native activation on product targets
The system SHALL activate back-in-stock tracking natively across all unique single-item tracking targets monitored by the product monitor, requiring no separate user registration.

#### Scenario: Auto-enabled with product monitor
- **WHEN** a single product is registered for tracking
- **THEN** back-in-stock detection is active for it without additional setup

### Requirement: Priority escalation while out of stock
The system SHALL short-circuit scheduling priority to a faster tier whenever a tracked item's `inStock` baseline reports `false`.

#### Scenario: Out-of-stock accelerates polling
- **WHEN** a tracked item is observed as `inStock: false`
- **THEN** the system raises its polling cadence to the faster priority tier

### Requirement: Restock transition alert
The system SHALL trigger an immediate high-priority alert the moment `inStock` transitions cleanly from `false` to `true`.

#### Scenario: Item comes back in stock
- **WHEN** an item previously `inStock: false` is observed as `inStock: true`
- **THEN** the system fires an immediate high-priority back-in-stock alert

#### Scenario: Item stays out of stock
- **WHEN** an item remains `inStock: false` across cycles
- **THEN** the system fires no back-in-stock alert and keeps the fast polling tier
