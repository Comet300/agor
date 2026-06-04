## ADDED Requirements

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
