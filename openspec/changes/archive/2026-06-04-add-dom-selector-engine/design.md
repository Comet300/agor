## Context

The scraping engine currently only implements `json-extractor`: it regex-locates a `<script>` payload, `JSON.parse`s it, and resolves item nodes/fields via `resolvePath` (dot/bracket JSON paths). The pipeline normalizer then maps each `IScrapedItem` field through `fields[name]` (a JSON path) with `!`-negation and type coercion. `dom-selector` is declared in the `IVendorPlugin` union but unimplemented, so HTML-only marketplaces cannot be onboarded.

## Goals / Non-Goals

**Goals:**
- A working `dom-selector` engine that extracts items from raw HTML via CSS selectors, returning the same normalized `IScrapedItem[]` every downstream stage already consumes.
- Reuse the existing coercion (price parsing, boolean/`!` handling, string trim) for both engines — one source of truth.
- Zero change to the three existing `json-extractor` vendors and their tests.
- Fixture-driven, fully offline-testable.

**Non-Goals:**
- No headless browser / JS execution (static HTML only — consistent with the anti-bot strategy of avoiding heavy automation).
- No new real vendor adoption in this change (proven via a fixture manifest; real onboarding happens when a target needs it).
- No change to `IVendorPlugin`'s shape — the existing fields are *reinterpreted* per engine, not extended.

## Decisions

### Manifest reinterpretation per engine (no contract change)
`IVendorPlugin` already discriminates on `engine`. For `dom-selector`:
- `search_mapping.json_path_to_items` → the **item-container CSS selector** (each match is one listing element).
- `product_mapping.json_path` → the root selector for the single product (defaults to the document root when empty).
- `fields.<name>` → a **CSS selector relative to the item element**, with two conventions:
  - trailing `@attr` reads an attribute instead of text content: `url: "a.title@href"`.
  - leading `!` negates the located value's truthiness (presence for elements): `isPrivateOwner: "!.badge-company"`.

*Why reinterpret rather than extend the contract:* the two engines are mutually exclusive per manifest, so overloading the existing mapping keeps the `IVendorPlugin` shape unchanged. The only validation refinement: `payload_locator` (unused by `dom-selector`, which parses the whole HTML) becomes allowed-empty, with a top-level `superRefine` still requiring it for `json-extractor`. The semantics are documented in each manifest header (as the JSON `!` convention already is).

### Extraction in the engine, coercion in the pipeline
`src/scraping/domExtract.ts` parses HTML once (`node-html-parser`), selects item elements, and for each emits a **record keyed by `IScrapedItem` field name** whose values are already-extracted strings/booleans (the `@attr` and `!` conventions are resolved here, since they are DOM concerns). The engine returns these records as `rawNodes`.

The pipeline normalizer becomes **engine-aware**: it factors the existing per-field coercion into a shared `buildItem(rawAt, vendor)` where `rawAt(fieldName)` differs by engine:
- `json-extractor`: `rawAt = (name) => resolveWithBang(node, fields[name])` (today's behavior, unchanged).
- `dom-selector`: `rawAt = (name) => record[name]` (the engine already applied the selector/`@attr`/`!`).

*Why here:* extraction needs a DOM parser and belongs in the scraping layer; coercion (price `"4 300"` → `4300`, booleans, trimming, skip-if-missing-id) is engine-independent and must not be duplicated.

### `node-html-parser` over cheerio
`node-html-parser` is pure-JS (no node-gyp), small, and supports `querySelector`/`querySelectorAll` + attributes/text — sufficient for selector extraction. cheerio pulls a larger dependency tree we don't need.

## Risks / Trade-offs

- **Selector brittleness** → DOM selectors break more easily than JSON trees on redesigns. Mitigation: this is a *fallback* for vendors with no embedded JSON; the architecture still prefers `json-extractor`. Documented in the manifest header.
- **Coercion refactor could regress `json-extractor`** → Mitigation: the refactor is behavior-preserving; the full existing pipeline/orchestrator suite must stay green, and a determinism check guards output stability.
- **Attribute/`!` convention parsing edge cases** (e.g. a selector legitimately containing `@`) → Mitigation: split on the *last* `@` and only treat the suffix as an attribute when it matches a simple identifier; document the limitation.

## Migration Plan

Additive — no data migration. Order: (1) add `node-html-parser`; (2) `domExtract.ts` + tests; (3) engine branch on `plugin.engine`; (4) engine-aware normalize refactor (keep `json-extractor` identical); (5) fixture `dom-selector` manifest + integration test. Rollback = revert; existing JSON vendors are untouched throughout.

## Open Questions

- Should a `@attr` with no match fall back to text content, or yield empty? (Proposed: yield empty/undefined, let normalize skip when a required field is missing.)
