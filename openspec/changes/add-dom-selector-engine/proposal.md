## Why

The `IVendorPlugin` contract declares two extraction engines — `json-extractor` and `dom-selector` — but only `json-extractor` is implemented. Not every marketplace embeds a structural JSON tree (`__NEXT_DATA__` / `window.__STATE__`); some render listings only as server-side HTML. For those vendors there is currently no way to write a working manifest, leaving the architecture's promised CSS fallback unfulfilled (deferred in the bootstrap as task 4.2).

## What Changes

- Implement a real `dom-selector` extraction path in the scraping engine: parse fetched HTML and extract item records using CSS selectors declared in the manifest.
- Reinterpret the existing manifest mapping fields for `dom-selector` plugins:
  - `search_mapping.json_path_to_items` / `product_mapping.json_path` become the **item-container CSS selector**.
  - each `fields.<name>` value becomes a **CSS selector** relative to the item element, with two conventions: a trailing `@attr` reads an element attribute (e.g. `a.title@href`), and a leading `!` negates element presence/truthiness (mirroring the JSON `!` convention, e.g. `isPrivateOwner: "!.badge-company"`).
- Make pipeline normalization engine-aware so `dom-selector` records (already keyed by `IScrapedItem` field name) and `json-extractor` nodes (keyed by JSON path) share the same coercion (price parsing, booleans, string trim).
- Add a lightweight, dependency-light HTML parser (`node-html-parser`, no native build) used only by the new engine path.
- Add a fixture-driven `dom-selector` manifest + tests proving extraction without any live network.

No behavior changes for existing `json-extractor` vendors.

## Capabilities

### New Capabilities

None — this extends existing capabilities rather than introducing new ones.

### Modified Capabilities

- `scraping-engine`: ADD a requirement for the `dom-selector` extraction engine (HTML parse → container selector → per-field CSS/attr extraction with the `@attr` and `!` conventions).
- `data-pipeline`: ADD a requirement that normalization is engine-aware — it coerces `dom-selector` records by field name while preserving the existing `json-extractor` path unchanged.

## Impact

- **New dependency**: `node-html-parser` (pure JS, no node-gyp).
- **Code**: new `src/scraping/domExtract.ts`; `src/scraping/engine.ts` branches on `plugin.engine`; `src/pipeline/normalize.ts` refactored to share coercion across both engines.
- **Manifests**: `dom-selector` plugins reinterpret `json_path_to_items` / `json_path` as container selectors and `fields` as CSS selectors. The existing three JSON manifests are unaffected.
- **Tests**: new fixtures + unit/integration tests; no live marketplace traffic required.
