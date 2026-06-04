## Why

There is no system today for tracking Romanian classified-marketplace listings (OLX, AutoVit, Storia) and surfacing new items, price drops, and stock changes to a user in real time. Manual refreshing is slow, easy to miss, and gives no analytical context (is this a good deal?). This change establishes the foundational architecture for `agor`: a Telegram bot that monitors marketplace search URLs and individual products, then alerts the user through rich, actionable messages.

The architecture is deliberately **data-driven**: the core engine knows nothing about any specific shop. All vendor-specific parsing lives in declarative YAML manifests, so adding or repairing a marketplace is a config change, not a code change.

## What Changes

- Introduce a **Modular Orchestrator + Data-Driven Plugin** architecture with seven decoupled components: Telegram Bot Gateway, Core Orchestrator, Scheduler Engine, Plugin Registry, Distributed Scraping Engine, Data Processing Pipeline, and Persistence Layer.
- Define the two canonical data contracts every component speaks: `IVendorPlugin` (the YAML manifest shape) and `IScrapedItem` (the normalized internal item).
- Deliver nine user-facing monitoring features (search URL monitor, exact product monitor, back-in-stock alerts, historical price graph, market-value benchmarking, cross-platform deduplication, B2C/P2P filtering, exclusion keywords, instant contact & offer generator).
- Establish three operational lifecycles: monitor registration, the polling/scraping background loop, and the anti-bot / fingerprinting strategy.

This is a greenfield bootstrap: no existing capabilities are modified or removed.

## Capabilities

### New Capabilities

Platform components:
- `telegram-gateway`: Sole presentation/interaction layer — update intake (long-poll/webhook), inline keyboard state, unified message block output, quick-action buttons.
- `core-orchestrator`: Runtime input validation, job routing, coordination between user sessions and scraping nodes, feeding raw arrays into the pipeline.
- `scheduler-engine`: Interval/cron task management with a priority queue and dynamic loop-velocity scaling for high-priority targets.
- `plugin-registry`: Loads and validates `.yaml` vendor manifests at boot, maps domains to extraction specs, exposes the `IVendorPlugin` contract.
- `scraping-engine`: Distributed fetching through rotating residential proxies, anti-bot header shaping, and 429/403 back-off/benching.
- `data-pipeline`: Deterministic sequence of normalization + filtering + analytics functions producing `IScrapedItem` collections before persistence/dispatch.
- `persistence-layer`: State database for monitors, item ID baselines, and price history.

Monitoring features:
- `search-url-monitor`: Track a marketplace filter URL and alert on new listings via set-difference of item IDs.
- `product-price-monitor`: Watch a single product URL and alert only on negative price movement.
- `back-in-stock-alerts`: Detect `inStock` false→true transitions on tracked single items and escalate scheduling priority.
- `price-history-graph`: Render stored price history to a standalone `.png` chart in chat.
- `market-benchmarking`: Compute the statistical median across a target's listings and assign deal tags.
- `cross-platform-dedup`: Collapse identical cross-posted listings via a composite signature hash within a 24h buffer.
- `seller-type-filter`: User-toggled B2C-vs-P2P visibility filtering on `isPrivateOwner`.
- `exclusion-keywords`: Drop listings whose text matches user-supplied exclusion tokens.
- `contact-offer-generator`: One-tap seller contact deep links and a pre-drafted negotiation offer message.

### Modified Capabilities

None — this is the initial bootstrap. `openspec/specs/` is empty.

## Impact

- **New project** at `/Users/valentin/Projects/agor` (greenfield; no existing code).
- **Runtime/stack**: Node.js + TypeScript, a Telegram Bot framework, a job scheduler, an HTTP client with proxy support, a charting dependency (e.g. node-canvas / Chart.js), and a state database.
- **External dependencies**: Telegram Bot API, rotating residential proxy pool, target marketplace endpoints (OLX, AutoVit, Storia).
- **Config surface**: per-vendor YAML manifests under a plugins directory; bot token, proxy credentials, and DB connection via environment.
