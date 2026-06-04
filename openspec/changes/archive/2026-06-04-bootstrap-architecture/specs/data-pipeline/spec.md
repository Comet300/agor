## ADDED Requirements

### Requirement: Normalization to IScrapedItem
The pipeline SHALL transform raw extracted payloads into the `IScrapedItem` contract using the plugin's `fields` map, producing clean numeric prices, normalized ISO currency strings, and boolean availability flags.

#### Scenario: Raw payload normalized
- **WHEN** the scraping engine returns a raw data tree for a vendor
- **THEN** the pipeline maps it through the plugin `fields` paths into fully populated `IScrapedItem` objects

### Requirement: Deterministic filter ordering
The pipeline SHALL apply its functional stages in a fixed deterministic order: normalization → exclusion-keyword screening → seller-type filtering → delta analysis → deduplication + benchmarking enrichment → state update + dispatch.

#### Scenario: Filters precede delta
- **WHEN** a batch of normalized items is processed
- **THEN** exclusion-keyword and seller-type filters run before set-difference delta so excluded items never produce alerts

#### Scenario: Enrichment follows delta
- **WHEN** the delta has isolated brand-new listing IDs
- **THEN** deduplication and benchmark valuation run only on those new items

### Requirement: Determinism and idempotency
The pipeline SHALL be deterministic — identical input collections SHALL produce identical filtered output and identical persistence/notification decisions.

#### Scenario: Repeated run is stable
- **WHEN** the same item collection is processed twice without intervening state change
- **THEN** the pipeline produces the same set of alerts and the same persisted IDs
