# data-pipeline Specification

## Purpose
TBD - created by archiving change bootstrap-architecture. Update Purpose after archive.
## Requirements
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

### Requirement: Template fields
The normalizer SHALL support template field values: a `fields.<name>` value containing one or more `{sub.path}` placeholders is built by replacing each placeholder with the string-coerced value resolved from that sub-path of the item node. A field value with no `{` is resolved as a plain path, exactly as before.

#### Scenario: Build a URL from a sub-path
- **WHEN** a manifest defines `url: "https://www.storia.ro/ro/oferta/{slug}"` and an item has `slug: "2-camere-IDHuS4"`
- **THEN** the normalized `url` is `https://www.storia.ro/ro/oferta/2-camere-IDHuS4`

#### Scenario: Plain field paths unaffected
- **WHEN** a field value contains no `{` placeholder
- **THEN** it is resolved as a path with the existing coercion and `!`-negation rules

### Requirement: Seller-type coercion covers professional/private
The private-owner coercion SHALL treat a located seller-type string of the form `professional*` as a company (not a private owner) and `private*` as a private owner, in addition to the existing `company`/`business`/`agency`/`private` mappings.

#### Scenario: Professional vs private seller typename
- **WHEN** `isPrivateOwner` resolves to `"ProfessionalSeller"` / `"PrivateSeller"` (e.g. AutoVit's `seller.__typename`)
- **THEN** the item's `isPrivateOwner` is `false` / `true` respectively

### Requirement: Literal-constant field values
The normalizer SHALL treat a `fields` value beginning with `=` as the literal text after the `=` (no path resolution), so manifests can supply constants the source page lacks (e.g. a fixed currency or seller type). Path, `!`-negated, and `{…}`-template values are unaffected.

#### Scenario: Constant currency
- **WHEN** a manifest declares `currency: "=EUR"` and the source has no machine-readable currency field
- **THEN** every normalized item carries `currency: "EUR"`

#### Scenario: Existing conventions unchanged
- **WHEN** a field value does not start with `=`
- **THEN** it is interpreted exactly as before (path, `!` negation, or `{…}` template)

