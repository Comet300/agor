## Why

A real OLX search (`olx.ro/auto-masini.../q-suzuki-swace-hibrid/...`) was fetched and the live page no longer carries `__NEXT_DATA__`. OLX now embeds its state as **`window.__PRERENDERED_STATE__`**, assigned as a **double-encoded JSON string** (`window.__PRERENDERED_STATE__ = "{\"listing\":…}"`). Two things make our current OLX scrape return **zero items**:

1. `extractPayload` only handles `window.NAME = { … }` (an object literal); it cannot read a string-encoded global.
2. `plugins/olx.yaml` still points at the stale `__NEXT_DATA__` / `props.pageProps…` paths.

This change calibrates OLX against the live structure so a real `/track` actually finds listings, and hardens extraction so a future vendor layout change degrades gracefully instead of throwing.

## What Changes

- **Engine**: `extractPayload` reads a string-encoded `window.NAME = "…"` payload (parse the JS string literal, then JSON-parse its contents) in addition to object literals.
- **Engine robustness**: a payload that cannot be located/parsed makes a scrape return `ok: false` with no items, instead of throwing into the scheduler — a layout change becomes a quiet failed cycle, not an error.
- **Manifest**: recalibrate `plugins/olx.yaml` to the live paths — search items at `listing.listing.ads`, product at `ad.ad`, with verified field paths (price under `price.regularPrice.value`/`currencyCode`, image `photos[0]`, seller `!isBusiness`, location `location.cityName`, stock `isActive`).
- **Tests**: decouple the engine tests from the production manifest (use a synthetic `json-extractor` plugin), and add a real-OLX fixture (a trimmed `window.__PRERENDERED_STATE__` page) proving end-to-end extract → normalize for both search and product.

## Capabilities

### New Capabilities
None.

### Modified Capabilities

- `scraping-engine`: ADD string-encoded `window.*` payload support and graceful (`ok: false`) handling of an unlocatable/unparseable payload.

## Impact

- **Code**: `src/scraping/extract.ts` (string-encoded window globals), `src/scraping/engine.ts` (wrap extraction, fail soft), `plugins/olx.yaml` (recalibrated paths).
- **Tests**: `tests/scraping.test.ts` (synthetic plugin), new `tests/olx.test.ts` + `tests/fixtures/olx-prerendered.html`.
- **No change** to the pipeline, scheduler, orchestrator, or UX.
- **Operational**: the running bot must be **restarted** to load the recalibrated manifest (manifests load at boot). AutoVit/Storia are likely on the same `__PRERENDERED_STATE__` pattern and can be recalibrated the same way in follow-ups.
