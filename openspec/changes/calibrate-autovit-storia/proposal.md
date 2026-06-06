## Why

AutoVit and Storia are two of the three target marketplaces, but both ship with **stale, guessed** manifest paths — a real `/track` of either returns **0 items**. Live fetches (the user's Suzuki-Swace AutoVit search and a Bucharest-apartments Storia search) reveal two structures our extractor cannot yet address data-drivenly:

- **AutoVit** embeds listings in a GraphQL `urqlState` cache: `props.pageProps.urqlState.<hash>.data` is a **stringified JSON** containing `advertSearch.edges[].node`, and `<hash>` changes per query. A fixed dot-path cannot reach it.
- **Storia** exposes items at a known path, but the only per-item link is a templated `[lang]/ad/<slug>`; the real deep link is `https://www.storia.ro/ro/oferta/<slug>` — which must be *built*, not read.

This change extends the (still vendor-agnostic) extraction with two small, general capabilities and recalibrates both manifests so AutoVit and Storia actually return listings.

## What Changes

- **Path resolver** (`resolvePath`): add a `*` **wildcard** segment (try each value of an object, take the first where the rest resolves) and a `~json` **decode** segment (JSON-parse a string value and continue). Enables AutoVit's `urqlState.*.data.~json.advertSearch.edges`.
- **Normalizer**: add **template fields** — a `fields.<name>` value containing `{sub.path}` placeholders is built by interpolating resolved sub-paths (e.g. Storia `url: "https://www.storia.ro/ro/oferta/{slug}"`). Also recognize `professional*`/`private*` seller-type strings in the private-owner coercion (AutoVit's `seller.__typename`).
- **Manifests**: recalibrate `plugins/autovit.yaml` (urql path, fields relative to `node`) and `plugins/storia.yaml` (verified paths + templated URL + direct `isPrivateOwner`).
- **Tests**: real-shaped fixtures for both + end-to-end extract→normalize assertions; resolver and template-field unit tests.

## Capabilities

### New Capabilities
None.

### Modified Capabilities

- `scraping-engine`: ADD `*` wildcard and `~json` decode path segments (so item arrays inside opaque-keyed, string-encoded caches are addressable).
- `data-pipeline`: ADD template fields (interpolate `{sub.path}` placeholders) and broaden private-owner coercion to `professional*`/`private*` seller-type strings.

## Impact

- **Code**: `src/util/jsonPath.ts` (`*`, `~json`), `src/pipeline/normalize.ts` (template fields, seller coercion). Both backward-compatible — plain paths behave exactly as before.
- **Manifests**: `plugins/autovit.yaml`, `plugins/storia.yaml`.
- **Tests**: new `tests/autovit.test.ts`, `tests/storia.test.ts` + fixtures; `tests/jsonPath.test.ts` additions.
- **Operational**: restart the bot to load the recalibrated manifests.
- **No change** to scheduler, orchestrator, gateway, or OLX (already calibrated).
