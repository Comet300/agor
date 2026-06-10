## Why

The user monitors far more marketplaces than the original three. Eight new platforms were requested (publi24.ro, mobile.de, carzz.ro, lajumate.ro, vinted.ro, imobiliare.ro, homezz.ro, imoradar24.ro — storia.ro and OLX.ro are already integrated). Live recon of every sample URL shows all eight are server-rendered and scrapeable, but they use **three data carriers our engine cannot yet read**: schema.org **ld+json** blocks (publi24, imobiliare, imoradar24), Next.js App-Router **RSC flight** payloads in `self.__next_f.push` chunks (mobile.de, vinted), and plain DOM (carzz, homezz). lajumate uses classic `__NEXT_DATA__` (already supported).

## What Changes

- **Engine — two new payload locators** (still fully data-driven, declared per manifest):
  - `ldjson` — extract `<script type="application/ld+json">` blocks; tolerant of embedded control characters (publi24 ships literal newlines inside JSON strings); tries each block and returns the first that parses and resolves.
  - `flight:<anchor>` — concatenate `self.__next_f.push([1,"…"])` chunks, JSON-decode the string bodies, locate `"<anchor>":` and slice/parse the balanced JSON value after it.
- **Path resolver**: `*` wildcard extended to arrays (ld+json `@graph` traversal); new `~tail:<sep>` segment (substring after the last separator — extracts the numeric id from imobiliare's `item.@id` URL).
- **Normalizer**: field values starting with `=` are literal constants (e.g. `currency: "=EUR"` for mobile.de, whose price is a display string).
- **Eight new vendor manifests** with trimmed-real fixtures and tests: lajumate (NEXT_DATA), publi24/imobiliare/imoradar24 (ldjson), mobilede/vinted (flight), carzz/homezz (dom-selector).
- Search monitoring is the calibrated path for all eight (the user's sample URLs are searches); product-page mappings are best-effort and calibrated on demand when a product watch is first used.

## Capabilities

### New Capabilities
None.

### Modified Capabilities

- `scraping-engine`: ADD the `ldjson` and `flight:<anchor>` payload locators; ADD array support to the `*` wildcard and the `~tail:<sep>` path segment.
- `data-pipeline`: ADD literal-constant field values (`=…`).

## Impact

- **Code**: `src/scraping/extract.ts` (+2 locators), `src/util/jsonPath.ts` (`*` arrays, `~tail`), `src/pipeline/normalize.ts` (`=` literals). All additive/backward-compatible.
- **Manifests**: 8 new files under `plugins/`; existing three untouched.
- **Tests**: fixtures + per-vendor extraction tests; resolver/locator unit tests.
- **Operational**: restart the bot to load the new manifests. vinted (DataDome) and mobile.de returned full content to direct fetches today, but are the likeliest to need proxies under sustained polling.
