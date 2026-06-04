## 1. Project Scaffold & Contracts

- [x] 1.1 Initialize Node.js + TypeScript project (tsconfig, linting, build scripts) in the agor repo
- [x] 1.2 Choose and pin core dependencies: Telegram bot framework, job scheduler, HTTP client with proxy support, charting lib, DB driver
- [x] 1.3 Define the `IVendorPlugin` and `IScrapedItem` interfaces in a shared `contracts` module
- [x] 1.4 Add environment/config loading (bot token, proxy credentials, DB connection) with validation
- [x] 1.5 Resolve design Open Questions (bot framework, DB choice, polling vs webhook) and record decisions

## 2. Persistence Layer

- [x] 2.1 Define schema for monitors (type, target URL, chat, filter config, frequency)
- [x] 2.2 Define schema for per-monitor historical item ID sets
- [x] 2.3 Define schema for per-product timestamped price history
- [x] 2.4 Implement repository functions: save/load monitors, append/compare ID baselines, append price points
- [x] 2.5 Verify baseline write fires no notifications and new IDs append correctly

## 3. Plugin Registry

- [x] 3.1 Implement YAML manifest loader that scans the plugins directory at boot
- [x] 3.2 Validate each manifest against `IVendorPlugin`; fail-fast with the offending manifest name
- [x] 3.3 Build the domain→plugin map for O(1) lookup and expose extraction-map linkage
- [x] 3.4 Author initial manifests for OLX, AutoVit, and Storia
- [x] 3.5 Verify malformed manifests are rejected and valid ones register

## 4. Distributed Scraping Engine

- [x] 4.1 Implement proxy pool abstraction with selection and rotation
- [x] 4.2 Implement `json-extractor` engine reading the `payload_locator` script tree; add `dom-selector` fallback (json-extractor + `window.__STATE__` done; `dom-selector` engine deferred — no current manifest uses it)
- [x] 4.3 Attach browser-mirroring headers (`Accept`, `Accept-Language: ro-RO,ro;q=0.9`, `Cache-Control`)
- [x] 4.4 Implement 429/403 detection → bench proxy → reroute through clean residential IP
- [x] 4.5 Enforce per-plugin `rate_limit_ms` spacing between same-vendor requests

## 5. Data Processing Pipeline

- [x] 5.1 Implement normalization from raw payload → `IScrapedItem` via plugin `fields` map
- [x] 5.2 Implement exclusion-keyword screening (parse, lowercase, word-boundary regex, drop matches)
- [x] 5.3 Implement seller-type filter on `isPrivateOwner` per monitor config
- [x] 5.4 Implement set-difference delta (Current ∖ Historical) for new-listing detection
- [x] 5.5 Implement cross-platform dedup composite hash + 24h buffer collapse
- [x] 5.6 Implement median benchmarking + deal-tag thresholds
- [x] 5.7 Wire the fixed stage order and verify determinism/idempotency

## 6. Scheduler Engine

- [x] 6.1 Implement interval/cron retrieval of due monitor tasks
- [x] 6.2 Implement batch grouping of same-destination tasks
- [x] 6.3 Implement priority queue with fast-tier escalation for out-of-stock targets and de-escalation on restock (scheduler honors `fastTier` via `oosFastIntervalMs`; orchestrator toggles the flag)

## 7. Core Orchestrator

- [x] 7.1 Implement URL validation against registered plugin domains with standard error on no match
- [x] 7.2 Implement monitor registration flow (config init, baseline indexing run, scheduler registration)
- [x] 7.3 Implement job routing and pipeline coordination, relaying alerts to the gateway

## 8. Telegram Bot Gateway

- [x] 8.1 Implement update intake (long-poll or webhook) and command forwarding to the orchestrator
- [x] 8.2 Implement inline-keyboard rendering/mutation for B2C/P2P toggle, exclusion strings, frequency
- [x] 8.3 Implement unified message block rendering (product card, source badges, pricing, quick actions)
- [x] 8.4 Implement registration tuning prompt card shown after baseline indexing

## 9. Monitoring Features

- [x] 9.1 Search URL Monitor: URL scrubbing (strip utm/gclid, keep search params) + new-listing alerts
- [x] 9.2 Exact Product Monitor: persist price + alert only on strict price decrease with savings delta line
- [x] 9.3 Back in Stock Alerts: native activation, false→true transition alert, priority escalation hook
- [x] 9.4 Historical Price Graph: extract history → render standalone `.png` → send as image
- [x] 9.5 Contact & Offer Generator: `tel:` deep link + RoundToNearest5(Price×0.90) offer template in backticks

## 10. Integration & Verification

- [x] 10.1 End-to-end: register a search URL, run a cycle, confirm only new listings alert
- [x] 10.2 End-to-end: register a product, simulate price drop and restock, confirm correct alerts
- [x] 10.3 Verify anti-bot back-off by simulating 429/403 responses
- [x] 10.4 Verify deal tags, dedup collapse, and both filters against a fixture dataset
- [x] 10.5 Run `openspec validate bootstrap-architecture --strict` and confirm the build/test suite passes
