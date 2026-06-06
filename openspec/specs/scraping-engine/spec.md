# scraping-engine Specification

## Purpose
TBD - created by archiving change bootstrap-architecture. Update Purpose after archive.
## Requirements
### Requirement: Proxy-routed fetching
The scraping engine SHALL route every fetch through a rotating residential proxy pool, abstracting payload retrieval away from the processing rules.

#### Scenario: Fetch through proxy
- **WHEN** a scraping task executes
- **THEN** the engine selects a proxy from the pool and issues the request through it

### Requirement: JSON-tree extraction preference
The scraping engine SHALL prefer extracting structural JSON hidden in `<script>` tags (addressed by the plugin's `payload_locator`, e.g. `script#__NEXT_DATA__` or `window.__PRERENDERED_STATE__`) over volatile DOM CSS nodes, using `dom-selector` only as a fallback engine.

#### Scenario: JSON payload extracted
- **WHEN** a plugin declares `engine: json-extractor`
- **THEN** the engine reads the script payload at `payload_locator` and extracts the raw data tree

### Requirement: Browser-mirroring headers
The scraping engine SHALL attach headers that mirror a modern desktop browser on every request, including `Accept`, `Accept-Language: ro-RO,ro;q=0.9`, and `Cache-Control`.

#### Scenario: Romanian-locale headers sent
- **WHEN** the engine issues a request to a Romanian marketplace
- **THEN** the request carries the `ro-RO,ro;q=0.9` accept-language and browser-typical headers

### Requirement: Back-off and proxy benching
The scraping engine SHALL detect anti-bot rejections and bench the offending proxy, rerouting through a clean residential IP.

#### Scenario: Rate-limited or forbidden response
- **WHEN** a request returns HTTP `429` or `403`
- **THEN** the engine benches the active proxy node and retries through a different residential IP from the pool

### Requirement: Rate-limit adherence
The scraping engine SHALL respect each plugin's `rate_limit_ms` between requests to the same vendor.

#### Scenario: Spacing requests
- **WHEN** consecutive requests target the same vendor
- **THEN** the engine spaces them by at least the plugin's `rate_limit_ms`

### Requirement: DOM-selector extraction engine
The scraping engine SHALL support `engine: dom-selector` plugins by parsing the fetched HTML and extracting item records via CSS selectors declared in the manifest, returning the same `rawNodes` shape the pipeline consumes.

For a `dom-selector` plugin the manifest mapping is reinterpreted: the search `json_path_to_items` (and product `json_path`) is the item-container CSS selector, and each `fields.<name>` is a CSS selector relative to the item element. The engine SHALL honor two conventions when resolving a field selector: a trailing `@attr` reads that element attribute instead of text content, and a leading `!` negates the located value's truthiness (element presence for selectors).

#### Scenario: Extract search items from HTML
- **WHEN** a `dom-selector` plugin scrapes a search page
- **THEN** the engine selects each element matching the item-container selector and emits one record per element, keyed by `IScrapedItem` field name with values resolved from each field's CSS selector

#### Scenario: Attribute and negation conventions
- **WHEN** a field selector ends with `@href` or begins with `!`
- **THEN** the engine reads the named attribute for `@href`, and yields the negated truthiness of the located element for the leading `!`

#### Scenario: Single product extraction
- **WHEN** a `dom-selector` plugin scrapes a product page
- **THEN** the engine extracts exactly one record from the product root selector (or the document root when no root selector is given)

#### Scenario: json-extractor unaffected
- **WHEN** a plugin declares `engine: json-extractor`
- **THEN** the engine continues to extract via the script payload and JSON paths exactly as before, with no DOM parsing

#### Scenario: payload_locator optional for dom-selector
- **WHEN** a `dom-selector` manifest is validated
- **THEN** an empty `payload_locator` is accepted (it is unused), while a `json-extractor` manifest still requires a non-empty `payload_locator`

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

