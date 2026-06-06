## Context

Verified against live pages (the user's AutoVit Suzuki-Swace and Storia Bucharest-apartments searches). Both still use `script#__NEXT_DATA__` (our existing locator), so only paths/fields change — plus two general resolver/normalizer features the live shapes demand.

- **AutoVit**: `props.pageProps.urqlState` is `{ "<opaque-hash>": { hasNext, data: "<JSON string>" } }`; the search response is one entry whose decoded `data` is `{ advertSearch: { edges: [{ node: {…} }] } }`. Node fields: `url` (absolute), `price.amount.value`+`currencyCode`, `location.city.name`, `thumbnail.x1`, `seller.__typename` (`ProfessionalSeller`/`PrivateSeller`).
- **Storia**: items at `props.pageProps.data.searchAds.items`; `id`, `title`, `totalPrice.{value,currency}`, `images[0].medium`, `location.address.city.name`, `isPrivateOwner` (direct boolean). The usable URL is `https://www.storia.ro/ro/oferta/<slug>` (the `href` field is a `[lang]/ad/…` template).

## Goals / Non-Goals

**Goals:** make both vendors return correct `IScrapedItem`s through config only; keep `resolvePath`/`normalize` general (no vendor branches); preserve all existing behavior; prove against trimmed real fixtures.

**Non-Goals:** AutoVit phone reveal; Storia rent-vs-sale price disambiguation beyond `totalPrice`; multi-page; any non-extraction change.

## Decisions

### `*` wildcard and `~json` decode in `resolvePath`
Two new path segments, both backward-compatible (a plain dotted path never contains them):
- `*` — current value must be an object; try resolving the remaining path against each value, return the first non-`undefined`. Addresses the opaque `urqlState.<hash>` key.
- `~json` — current value must be a string; `JSON.parse` it and continue. Decodes AutoVit's stringified `data`.

AutoVit search items path becomes `urqlState.*.data.~json.advertSearch.edges`; fields resolve against each edge (e.g. `node.id`). *Why:* the data is genuinely behind an opaque key and a string boundary; these are the minimal general operators that reach it without hardcoding a hash or vendor code.

### Template fields in the normalizer
If a `fields.<name>` value contains `{sub.path}` placeholders, the normalizer builds the value by replacing each placeholder with `coerceString(resolvePath(node, sub.path))`; otherwise it resolves the value as a path (unchanged). Storia: `url: "https://www.storia.ro/ro/oferta/{slug}"`. *Why:* Storia offers no absolute per-item URL; a tiny template keeps URL construction in the manifest (data), not code. Discriminator is the presence of `{` — unambiguous against real paths.

### Broaden private-owner coercion
`coercePrivateOwner` already maps `company`/`business`/`agency`→company and `private`→private. Extend (substring-aware) so `professional*`→company and `private*`→private, covering AutoVit's `seller.__typename` (`ProfessionalSeller`/`PrivateSeller`). Storia uses the direct `isPrivateOwner` boolean and needs none of this.

### Fixtures are trimmed real payloads
`tests/fixtures/autovit-next.html` embeds `__NEXT_DATA__` with a `urqlState` whose `data` is a stringified `advertSearch.edges` (2 nodes: one ProfessionalSeller, one PrivateSeller). `tests/fixtures/storia-next.html` embeds `searchAds.items` (a priced private + an agency listing). Faithful to the live encodings, small and deterministic.

## Risks / Trade-offs

- **Wildcard ambiguity** — `*` returns the first matching value; if two `urqlState` entries both resolved the remaining path, order is insertion order. For AutoVit only the search entry has `advertSearch`, so it is unambiguous; documented.
- **Template injection** — placeholders only reference sub-paths of the same node and are string-coerced; no code execution. A missing sub-path interpolates empty (and a URL-less item is dropped if `url` ends up empty).
- **Vendor shape drift** — same soft-fail (`ok:false`) safety net from the OLX change applies; recalibration stays a manifest+fixture edit.

## Migration Plan

Backward-compatible: existing OLX/dom-selector manifests and all plain paths are unaffected (no `*`/`~json`/`{}`). Deploy: merge, **restart the bot**. Rollback: revert the two manifests; the resolver/normalizer additions are inert without them.

## Open Questions

- Should `*` optionally match arrays too (currently object-values only)? Not needed for AutoVit; keep object-only until a case requires it.
