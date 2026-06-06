## ADDED Requirements

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
