## Context

Verified against live fetches of every sample URL (all HTTP 200 with full content, browser-mirroring headers, no proxies):

- **lajumate.ro** — `__NEXT_DATA__` → `props.pageProps.adsServer[]` `{id,title,slug,price,currency,mainImage.path,city.name,user.phone}`; listing URL is `/ad/{slug}-{id}`; image path is relative.
- **publi24.ro** — one `ld+json` `ItemList` whose `itemListElement[]` carries `{name,description,url(relative),image,offers.price,offers.priceCurrency}` — but the JSON contains **literal control characters** inside strings (invalid JSON; needs sanitization before parse).
- **imobiliare.ro / imoradar24.ro** (same Roam platform) — one `ld+json` block; items at `@graph[*].mainEntity.itemListElement[]`, fields under `item.*` (`name`, `image.url`, `offers.priceSpecification.{price,priceCurrency}`, `@id` ending `…/item-<numeric-id>`). The ld+json has **no listing URL**, but `https://www.imobiliare.ro/oferta/<any-slug>-<id>` 301-redirects to the real listing (verified live), so the URL is rebuilt from the id.
- **mobile.de** — Next.js App Router: listings inside RSC flight chunks (`self.__next_f.push([1,"…"])`) at `"searchResults":{numResultsTotal,listings:[{id,shortTitle,subTitle,p:"16.899 EUR",st:"Dealer"|"Private…",attr.loc,images[0].uri(protocol-less)}]}`.
- **vinted.ro** — RSC flight; catalog at `"items":{"items":[{id,title,price:{amount,currency_code},path,photo.url,user.business}]}` (DataDome present but served full content).
- **carzz.ro / homezz.ro** — no embedded state; clean server HTML. carzz: `.main_items.item_cart` cards with `a[href*="-anunt_"]` + `.title`; homezz: `.card-box` cards with `.card-box-title/-price/-location`. → `dom-selector`.

## Goals / Non-Goals

**Goals:** all eight platforms scrapeable via manifests only; the three new carriers (ld+json, flight, arrays-in-graph) become general engine capabilities; everything proven against trimmed-real fixtures; live-verified extraction for each before shipping.

**Non-Goals:** product-page calibration for the new vendors (search is the requested and calibrated path; `product_mapping` is best-effort until first use). No CAPTCHA/DataDome countermeasures beyond the existing header/proxy/soft-fail machinery. No pagination.

## Decisions

### `ldjson` locator with sanitize-then-parse
`payload_locator: "ldjson"` collects every `<script type="application/ld+json">` body; for each, tries `JSON.parse` raw, then with ASCII control characters (`\x00-\x1f`) replaced by spaces (publi24's literal newlines inside strings; structural whitespace is unaffected by the substitution). Returns the first block that parses; when multiple blocks exist the manifest's `json_path` disambiguates (resolution failure on one block falls through to the next). *Why not DOM for these sites:* imobiliare/imoradar24 use volatile utility-class markup, while their ld+json is a stable, semantically-versioned contract.

### `flight:<anchor>` locator
`payload_locator: "flight:searchResults"` concatenates all `self.__next_f.push([1,"<body>"])` chunk bodies, decodes each as a JSON string literal (`JSON.parse('"'+body+'"')` — exact, no regex unescaping), finds `"<anchor>":` in the decoded stream, and slices the balanced JSON value that follows (brace/bracket matching, string-aware — same scanner the `window.*` extractor uses). The manifest's `json_path` then navigates inside the parsed value. *Why anchor-based:* RSC flight is a proprietary framed stream, not JSON; anchoring on a named key and balanced-slicing is robust to frame layout changes and avoids parsing the whole stream.

### `*` over arrays + `~tail:<sep>`
`*` now iterates array elements as well as object values (first element where the remaining path resolves) — needed for `@graph[*]`. `~tail:-` takes the substring after the last `-` (string values only) — extracts `273353106` from `…/item-273353106`; composes inside template placeholders (`url: "https://www.imobiliare.ro/oferta/a-{item.@id.~tail:-}"` relies on the verified slug-agnostic 301).

### `=` literal field constants
A `fields` value starting with `=` yields the literal text after it (e.g. `currency: "=EUR"` where the source has no machine currency field, `isPrivateOwner: "=private"` for pure-P2P contexts). Checked before the `{`-template and path interpretations; `!`/paths/templates are unaffected.

### Fixtures are trimmed real payloads
Every new vendor gets a fixture cut from the live page captured during recon (real structure, 1–3 items), so tests bind to reality, not invented shapes — same policy as OLX/AutoVit/Storia.

## Risks / Trade-offs

- **vinted/mobile.de anti-bot** (DataDome / Akamai) → served full pages today, but sustained polling may get challenged; the existing soft-fail + watch-health surfacing reports it to the user, and `PROXY_URLS` is the lever. Documented.
- **publi24 sanitization** could corrupt a string that legitimately contains a control char → only control chars are touched, and the affected fields (descriptions) are not extracted.
- **imobiliare URL rebuild** relies on slug-agnostic redirects → verified live; if it breaks, items still alert (URL leads to a 404 only if the platform changes redirect policy — manifest fix).
- **RSC flight drift** (key renames, framing changes) → soft-fail + health notice; anchor and paths are manifest data, fixable without code.

## Migration Plan

Additive: no contract change, no existing-manifest change. Deploy: merge + restart. Rollback: remove the new manifests (engine additions are inert without them).

## Open Questions

- Pagination for high-volume searches (vinted page 1 only) — deferred; new-listing detection needs only the newest page.
