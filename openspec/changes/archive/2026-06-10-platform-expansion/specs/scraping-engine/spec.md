## ADDED Requirements

### Requirement: ld+json payload locator
The scraping engine SHALL support `payload_locator: "ldjson"`, extracting `<script type="application/ld+json">` blocks. Parsing SHALL tolerate embedded ASCII control characters (sanitized to spaces before a retry), and when multiple blocks exist the engine SHALL use the first block from which the manifest's item path resolves.

#### Scenario: Schema.org ItemList extracted
- **WHEN** a vendor embeds its listings in an ld+json ItemList (directly or under `@graph[*].mainEntity`)
- **THEN** the configured items path resolves to the listing nodes

#### Scenario: Malformed ld+json sanitized
- **WHEN** an ld+json block contains literal control characters inside strings (e.g. publi24)
- **THEN** the engine sanitizes and parses it instead of failing

### Requirement: RSC flight payload locator
The scraping engine SHALL support `payload_locator: "flight:<anchor>"` for Next.js App-Router pages: concatenate the `self.__next_f.push([1,"…"])` chunk bodies, decode them as JSON string literals, locate `"<anchor>":` in the decoded stream, and parse the balanced JSON value that follows.

#### Scenario: Listings inside a flight stream
- **WHEN** a vendor (e.g. mobile.de `searchResults`, vinted `items`) ships listings in RSC flight chunks
- **THEN** the anchored JSON value is recovered and the manifest's item path resolves within it

#### Scenario: Anchor absent
- **WHEN** the anchor does not occur in the decoded stream
- **THEN** extraction fails cleanly and the scrape soft-fails (`ok: false`)

### Requirement: Wildcard over arrays and tail segment
The path resolver's `*` segment SHALL also iterate array elements (first element where the remainder resolves), and a `~tail:<sep>` segment SHALL yield the substring after the last `<sep>` of a string value, composing inside template-field placeholders.

#### Scenario: Graph traversal
- **WHEN** a path uses `*` against an array (e.g. `@graph.*.mainEntity.itemListElement`)
- **THEN** it resolves through the first matching element

#### Scenario: Id extracted from a tail
- **WHEN** a path applies `~tail:-` to `https://site/#/schema/Product/item-273353106`
- **THEN** it yields `273353106` (usable inside a URL template)
