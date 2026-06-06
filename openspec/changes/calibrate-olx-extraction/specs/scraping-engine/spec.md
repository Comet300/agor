## ADDED Requirements

### Requirement: String-encoded window payloads
The scraping engine SHALL extract a `window.<NAME>` payload whether the global is assigned an object literal (`window.NAME = { … }`) or a JSON **string** (`window.NAME = "…"`, where the string's contents are JSON, possibly escaped). For a string value it parses the string literal and then parses its JSON contents.

#### Scenario: Object-literal global
- **WHEN** a manifest's `payload_locator` is `window.NAME` and the page assigns an object literal
- **THEN** the engine returns the parsed object (unchanged behavior)

#### Scenario: String-encoded global
- **WHEN** the page assigns `window.NAME = "<escaped-JSON-string>"` (e.g. OLX's `window.__PRERENDERED_STATE__`)
- **THEN** the engine recovers the inner JSON text from the string literal and returns the parsed object

### Requirement: Graceful extraction failure
The scraping engine SHALL treat an unlocatable or unparseable payload as a failed scrape — returning `ok: false` with no items — rather than throwing, so a vendor layout change degrades to an empty, retriable cycle.

#### Scenario: Payload missing or malformed
- **WHEN** the configured payload cannot be located in the fetched body, or its contents do not parse
- **THEN** the scrape result is `{ ok: false }` with an empty item list, and no exception propagates to the caller

#### Scenario: Successful extraction unaffected
- **WHEN** the payload is present and valid
- **THEN** the scrape returns `ok: true` with the extracted item nodes as before
