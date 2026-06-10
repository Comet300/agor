## ADDED Requirements

### Requirement: Literal-constant field values
The normalizer SHALL treat a `fields` value beginning with `=` as the literal text after the `=` (no path resolution), so manifests can supply constants the source page lacks (e.g. a fixed currency or seller type). Path, `!`-negated, and `{…}`-template values are unaffected.

#### Scenario: Constant currency
- **WHEN** a manifest declares `currency: "=EUR"` and the source has no machine-readable currency field
- **THEN** every normalized item carries `currency: "EUR"`

#### Scenario: Existing conventions unchanged
- **WHEN** a field value does not start with `=`
- **THEN** it is interpreted exactly as before (path, `!` negation, or `{…}` template)
