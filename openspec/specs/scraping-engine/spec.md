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

