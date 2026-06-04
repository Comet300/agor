## Context

`agor` is a greenfield Telegram bot that monitors Romanian classified marketplaces (OLX, AutoVit, Storia) and notifies a user about new listings, price drops, and stock changes. These targets apply aggressive rate limiting and bot-protection, and they restructure their frontends frequently. The central design tension is therefore **resilience to vendor change** and **evasion of anti-bot walls** without coupling the core engine to any one marketplace.

The system follows a Modular Orchestrator design: seven components communicate through two strict data contracts. Everything vendor-specific is pushed out of code and into declarative YAML manifests parsed at boot.

## Goals / Non-Goals

**Goals:**
- A core engine that is fully agnostic of shop infrastructure, CSS layout, and platform mechanics.
- Adding/repairing a marketplace = authoring/editing a YAML manifest, never editing engine code.
- All third-party data normalized into the single `IScrapedItem` contract before any pipeline logic runs.
- Deterministic, ordered data pipeline (normalize → filter → analytics → persist → notify).
- Anti-bot resilience via JSON-tree extraction (not DOM scraping), browser-mirroring headers, and proxy rotation with back-off.

**Non-Goals:**
- No purchase/checkout automation — `agor` only observes and alerts.
- No multi-user tenancy guarantees in the bootstrap (single-operator focus; per-user sessions exist but scaling/isolation is later work).
- No machine-learning price prediction — benchmarking uses a deterministic median, not forecasting.
- No CAPTCHA-solving service integration in the bootstrap (back-off + proxy rotation only).

## Decisions

### Data contracts as the system spine
Two TypeScript interfaces are the contract every component speaks:

```ts
export interface IVendorPlugin {
  vendor: string;
  domain: string;
  engine: 'json-extractor' | 'dom-selector';
  rate_limit_ms: number;
  search_mapping:  { payload_locator: string; json_path_to_items: string; fields: Record<string, string>; };
  product_mapping: { payload_locator: string; json_path: string;          fields: Record<string, string>; };
}

export interface IScrapedItem {
  id: string; title: string; price: number; currency: string; url: string;
  imageUrl?: string; isPrivateOwner: boolean; location?: string; inStock: boolean;
}
```
*Why:* a single normalized item shape means every filter, analytic, and notification block is written once and works for all vendors. Alternative (per-vendor item shapes) was rejected — it pushes vendor knowledge into the pipeline.

### JSON-extractor over DOM scraping (default engine)
The scraping engine prefers structural JSON hidden in `<script>` tags (`__NEXT_DATA__`, `window.__PRERENDERED_STATE__`) addressed by the manifest's `payload_locator`, with `dom-selector` as a fallback engine. *Why:* JSON trees survive CSS/layout redesigns that break DOM selectors, drastically reducing engine breakage. Trade-off: if a vendor stops embedding state JSON, that manifest must switch to `dom-selector`.

### YAML manifests loaded at boot by the Plugin Registry
Domain→plugin resolution happens once at startup; manifests are validated against `IVendorPlugin` and rejected if malformed. *Why:* fail-fast on bad config; O(1) domain lookup at request time. Alternative (lazy per-request load) rejected for latency and silent-failure risk.

### Anti-bot strategy as a mitigation matrix (Lifecycle C)
- **Extraction preference:** structural JSON trees, never volatile DOM nodes.
- **Header shaping:** every request mirrors a modern desktop browser — `Accept`, `Accept-Language: ro-RO,ro;q=0.9`, `Cache-Control`.
- **Back-off:** a `429`/`403` response benches the active proxy node and reroutes through a clean residential IP from the pool.

### Scheduler priority escalation
The scheduler runs a cron/interval loop but holds a priority queue. When a tracked item reports `inStock: false`, its poll cadence short-circuits to a faster tier so the back-in-stock transition is caught quickly. *Why:* stock recovery is the most time-sensitive event; a flat interval would miss fast re-stocks.

### Deterministic pipeline ordering (Lifecycle B, steps 3–6)
Normalize → exclusion-keyword screen → B2C/P2P filter → set-difference delta → dedup + benchmark enrichment → persist + dispatch. *Why:* filtering before delta avoids alerting on items the user excluded; enrichment after delta avoids wasting analytics on already-seen items.

### Notification-time analytics
Median benchmarking computes across all live listings of the *same target URL* at notification time, not at ingest. *Why:* the median must reflect the current market snapshot, and only new items need a tag.

## Risks / Trade-offs

- **Anti-bot escalation by vendors** → Mitigated by JSON-tree extraction, header mirroring, proxy benching/rotation; CAPTCHA-solving deferred but the back-off hook leaves room for it.
- **Vendor JSON schema drift** → Manifests are validated at boot; a broken `json_path` surfaces as a load/extraction error rather than silent empty results. Monitoring of extraction success rate is recommended.
- **Proxy pool exhaustion under heavy 429/403** → Benched nodes need a cooldown/recovery policy; if the whole pool is benched, the scheduler must degrade gracefully (slow down) rather than hammer.
- **Median skew on thin markets** → A target URL with very few listings yields an unreliable median; benchmarking should note low-sample confidence (see open question).
- **Telegram message/PNG size limits** → Price graphs are rendered to standalone `.png` to bypass font/formatting breakage; large images must respect Telegram upload limits.
- **Dedup false merges** → The composite hash `f(NormalizedTitle, RoundedPrice, ApproximateLocation)` could merge genuinely distinct listings; the 24h evaluation buffer bounds blast radius.

## Migration Plan

Greenfield — no migration. Deployment order: (1) Persistence Layer schema, (2) Plugin Registry + initial OLX/AutoVit/Storia manifests, (3) Scraping Engine + proxy pool, (4) Data Pipeline, (5) Scheduler, (6) Core Orchestrator, (7) Telegram Gateway. Rollback = stop the bot process; no destructive external state is written to marketplaces.

## Resolved Decisions

- **Telegram framework:** grammY — TypeScript-first, ergonomic inline keyboards/middleware, best fit for the rich-card + button UX.
- **Database:** SQLite via `better-sqlite3` — single-file, zero-ops, synchronous, ideal for a single-operator bot and fast to test. Repository layer keeps it swappable later.
- **Update mode:** long-polling — no public HTTPS endpoint required; runs locally and anywhere. Webhook is a later deployment optimization.
- **Build depth (this change):** test-first, fixture-driven. The engine is verified end-to-end against saved HTML/JSON fixtures; a live bot token and proxy pool are wired but optional, so no live marketplace traffic is needed to prove correctness.
- **Runtime:** Node.js 20+ ESM + TypeScript, executed via `tsx`; HTTP via Node's built-in `undici` (`ProxyAgent`); charts via `@napi-rs/canvas` (prebuilt, no node-gyp); YAML via `js-yaml`; validation via `zod`; tests via `vitest`.

## Resolved Defaults (configurable)

- **Benchmark min sample:** `BENCHMARK_MIN_SAMPLE = 4`. The median is still computed below this, but the deal tag is rendered with a low-confidence marker so thin markets don't produce misleading `🔥 Great Deal` labels.
- **Proxy cooldown / degradation:** a benched proxy rests for `PROXY_BENCH_COOLDOWN_MS = 5 min` before re-entering rotation. If every proxy is benched, the scheduler degrades gracefully — it backs off (doubles the affected target's interval) rather than hammering the pool.

## Open Questions

- Multi-user scaling and per-user isolation guarantees (deferred — bootstrap is single-operator).
- CAPTCHA-solving integration if back-off + rotation proves insufficient against a specific vendor.
