## ADDED Requirements

### Requirement: Wildcard and JSON-decode path segments
The JSON path resolver SHALL support two additional segment types so item arrays nested inside opaque-keyed and string-encoded caches are addressable from a manifest, without hardcoding keys or vendor logic:
- `*` — when the current value is an object, resolve the remaining path against each of its values and return the first that resolves to a defined value.
- `~json` — when the current value is a string, parse it as JSON and continue resolving.

Plain dotted/bracketed paths (containing neither `*` nor `~json`) SHALL behave exactly as before.

#### Scenario: Wildcard over an opaque-keyed object
- **WHEN** a path uses `*` (e.g. `urqlState.*.data`) against an object keyed by opaque hashes
- **THEN** the resolver returns the value from the first entry for which the remaining path resolves

#### Scenario: JSON-decode of a string-encoded segment
- **WHEN** a path crosses a `~json` segment whose current value is a JSON string (e.g. AutoVit's `urqlState.*.data.~json.advertSearch.edges`)
- **THEN** the resolver parses that string and resolves the remainder against the parsed object, returning the items array

#### Scenario: Plain paths unchanged
- **WHEN** a path contains neither `*` nor `~json`
- **THEN** resolution is identical to the previous behavior
