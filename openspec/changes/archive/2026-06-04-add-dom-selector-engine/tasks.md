## 1. Dependency & extraction

- [x] 1.1 Add `node-html-parser` to dependencies and install
- [x] 1.2 Implement `src/scraping/domExtract.ts`: parse HTML, select item container(s), resolve each field selector with the `@attr` (trailing) and `!` (leading negation) conventions; export `domExtractSearch(html, plugin)` and `domExtractProduct(html, plugin)` returning records keyed by `IScrapedItem` field name
- [x] 1.3 Unit-test `domExtract` against an HTML fixture (text, `@attr`, `!` negation, missing field, multiple items)

## 2. Engine integration

- [x] 2.1 Branch `src/scraping/engine.ts` on `plugin.engine`: `dom-selector` → `domExtract*` on the fetched body; `json-extractor` → existing payload/JSON path (unchanged)
- [x] 2.2 Verify proxy rotation, headers, rate-limit, and 429/403 back-off apply identically to both engines

## 3. Engine-aware normalization

- [x] 3.1 Refactor `src/pipeline/normalize.ts` to share coercion via a `buildItem(rawAt, vendor)` helper; `json-extractor` resolves via JSON path + `!`, `dom-selector` reads the record by field name
- [x] 3.2 Confirm existing `json-extractor` normalization is byte-for-byte unchanged (all current pipeline tests stay green)

## 4. Manifest & end-to-end

- [x] 4.1 Author a fixture `dom-selector` manifest (container + field selectors incl. an `@attr` and a `!` field) under `plugins/` or the test fixtures
- [x] 4.2 Integration test: scrape a search HTML fixture end-to-end through the engine + pipeline, asserting correct `IScrapedItem[]` (and a product fixture for the single-item path)

## 5. Verification

- [x] 5.1 Full `npx tsc --noEmit` clean and `npx vitest run` green (no regressions to the 122 existing tests)
- [x] 5.2 Run `openspec validate add-dom-selector-engine --strict`
