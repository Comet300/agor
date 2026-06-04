## ADDED Requirements

### Requirement: Engine-aware normalization
The pipeline normalizer SHALL produce `IScrapedItem` objects from both `json-extractor` nodes and `dom-selector` records using shared coercion (price parsing, boolean handling, string trim, and skip-on-missing-id), selecting the raw value source by the plugin's engine.

For `json-extractor`, each field is resolved from the node via its JSON path (with the existing leading-`!` negation). For `dom-selector`, the record is already keyed by `IScrapedItem` field name (the engine resolved the CSS selectors, `@attr`, and `!`), so the normalizer reads each field directly. Both paths apply identical coercion so downstream stages cannot tell which engine produced an item.

#### Scenario: Normalize a dom-selector record
- **WHEN** the normalizer receives a `dom-selector` record with string fields (e.g. `price: "4 300"`, `isPrivateOwner: true`)
- **THEN** it produces an `IScrapedItem` with a numeric `price` (4300), the boolean `isPrivateOwner`, trimmed strings, and the plugin's `vendor`

#### Scenario: Shared coercion across engines
- **WHEN** equivalent data arrives via a `json-extractor` node and a `dom-selector` record
- **THEN** the two produce equivalent `IScrapedItem` objects (same price parsing, boolean and string handling)

#### Scenario: Missing required field is skipped
- **WHEN** a `dom-selector` record lacks an `id`, `title`, or `url`
- **THEN** the normalizer skips that record, exactly as it does for `json-extractor` nodes
