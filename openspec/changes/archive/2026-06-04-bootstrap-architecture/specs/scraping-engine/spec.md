## ADDED Requirements

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
