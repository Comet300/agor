# Onboarding a new marketplace

agor has **zero per-site code**. Every marketplace is a declarative YAML file in
[`plugins/`](../plugins). To add a site you write one manifest describing *where
the listing data lives* and *which field maps to what* — the generic engine
fetches, extracts, normalizes, dedupes, benchmarks, and notifies for you.

This guide takes you from a marketplace URL to a working, tested manifest.

> **No country or category assumptions.** Cars, real estate, electronics,
> fashion — any country, any currency. The shipped manifests happen to be
> Romanian only because that was the first market.

---

## 1. The manifest shape

A manifest validates against a strict schema (`src/registry/validate.ts`); a
malformed one fails fast at load with the offending file named. The full shape:

```yaml
vendor: MyVendor              # display name
domain: myvendor.com          # canonical domain (www-stripped); matches URLs
engine: json-extractor        # json-extractor | dom-selector
fetch_strategy: http          # optional: http (default) | browser
rate_limit_ms: 3000           # min spacing between requests to this vendor

# The search-results page (the grid the bot polls by default).
search_mapping:
  payload_locator: "..."      # where the data hides (see dialects below)
  json_path_to_items: "..."   # path to the ARRAY of listing nodes
  fields: { ... }             # IScrapedItem field -> path within one node
  attributes: { ... }         # OPTIONAL structured specs (curated)
  attributes_from: { ... }    # OPTIONAL structured specs (flexible explode)

# A single product/detail page (opt-in: user tracks one listing URL).
product_mapping:
  payload_locator: "..."
  json_path: "..."            # path to the SINGLE listing node
  fields: { ... }
```

### Required vs optional fields

The normalizer drops any item missing a **required** field. Map these or the
listing won't survive:

| Field | Required | Notes |
|---|---|---|
| `id` | ✅ | stable unique key (vendor id, or a URL/slug) |
| `title` | ✅ | |
| `price` | ✅ | messy strings are parsed (`"16.990 eur"` → `16990`) |
| `url` | ✅ | the deep link; may be templated (below) |
| `currency` | optional | inferred from the price text if blank; else SERP-dominant |
| `imageUrl` | optional | |
| `isPrivateOwner` | optional | private vs. dealer; see coercion below |
| `location` | optional | |
| `inStock` | optional | defaults to `true` |
| `phone` | optional | powers the Call button |
| `description`, `postedAt` | optional | teaser + listing age |

---

## 2. Pick a dialect (`payload_locator`)

Open the search page, **View Source**, and find where the listings live. Most
modern sites embed JSON; old-school ones render HTML.

| Dialect | Use when the page has… | `payload_locator` |
|---|---|---|
| **Next.js data** | `<script id="__NEXT_DATA__">{…}</script>` | `script#__NEXT_DATA__` |
| **window global** | `window.__SOMETHING__ = {…}` (even a double-encoded JSON string) | `window.__SOMETHING__` |
| **schema.org** | `<script type="application/ld+json">` blocks | `ldjson` |
| **RSC flight** | `self.__next_f.push([1,"…"])` chunks | `flight:<anchorKey>` |
| **server HTML** | listing cards as plain HTML, no embedded JSON | `""` (empty) + `engine: dom-selector` |

For `json-extractor` engines, paths use a small resolver with these operators:

| Segment | Meaning |
|---|---|
| `a.b.c` / `arr[0]` | dot + numeric index |
| `*` | try each value/element; first whose remaining path resolves wins |
| `~json` | current value is a JSON *string* — parse it and continue |
| `~tail:<sep>` | string: take what follows the last `<sep>` (e.g. `@id.~tail:-`) |
| `~type:<T>` | array of `@type`-tagged nodes — pick the one of type `<T>` (ld+json `@graph`) |
| `~find:key=val` | array of records — pick the one whose `key` equals `val` |

---

## 3. Map the fields

### json-extractor example (Next.js / `__NEXT_DATA__`)

```yaml
search_mapping:
  payload_locator: "script#__NEXT_DATA__"
  json_path_to_items: "props.pageProps.data.searchAds.items"
  fields:
    id: "id"
    title: "title"
    price: "totalPrice.value"
    currency: "totalPrice.currency"
    url: "https://www.example.com/ad/{slug}"   # template — see below
    imageUrl: "images[0].medium"
    isPrivateOwner: "isPrivateOwner"
```

### dom-selector example (server-rendered HTML)

Here `json_path_to_items` is the **item-container CSS selector**, and each field
is a selector relative to that element:

```yaml
engine: dom-selector
search_mapping:
  payload_locator: ""
  json_path_to_items: 'a[href$=".html"]'   # each match is one card
  fields:
    id: "@href"                  # @attr reads an attribute of the element itself
    title: ".card-box-title"     # text of a child
    price: ".card-box-price"
    currency: "=EUR"             # =LITERAL: a constant when the page has no field
    url: "@href"
    isPrivateOwner: "=privat"
    location: ".card-box-location"
```

### Field-path conventions (both engines)

- **`!path`** — logical NOT of the value's truthiness. e.g. a site flags
  *companies* (`isBusiness`), so a private owner is `isPrivateOwner: "!isBusiness"`.
- **`=text`** — a literal constant (use when the page has no machine field, e.g.
  a single-currency site → `currency: "=EUR"`).
- **`{sub.path}` template** — interpolate resolved sub-paths into a string, e.g.
  `url: "https://x/ad/{slug}-{id}"`. If any placeholder resolves empty the field
  is treated as missing (so a slug-less ad doesn't ship a broken `/ad/-123`).
- **Seller type** coerces strings: `company`/`business`/`agency`/`dealer`/
  `professional` → not-private; `privat`/`private` → private. Otherwise truthiness.

### Structured specs (optional)

Surface year/km/area/etc. on the alert card. Two ways, **per vendor**:

- **Curated** — dedicated fields you name:
  ```yaml
  attributes:
    area: "areaInSquareMeters"
    rooms: "roomsNumber"
  ```
- **Flexible** — explode a key/value array verbatim (best for multi-category
  sites where each listing carries different params):
  ```yaml
  attributes_from:
    path: "params"     # array of {name, value}
    key: "name"
    value: "value"
  ```

---

## 4. Anti-bot strategy

Default is `http` (raw fetch). Set `fetch_strategy: browser` **only** for a site
that walls a plain fetch (TLS/JA3 fingerprinting, JS-gated content). The engine
then escalates to a headless browser *only on a recognised hard block*, and only
when `ENABLE_BROWSER_FALLBACK=true` (the optional Playwright deps installed). The
base install never needs Chromium.

---

## 5. Verify it

1. **Capture a real page** (read-only) and save the body to `tests/fixtures/`,
   trimmed to a representative slice — **anonymize any seller PII**.
2. **Add a case** to `tests/platforms.test.ts` (search) and/or
   `tests/productMappings.test.ts` (detail): drive your real manifest through the
   engine + normalizer against the fixture and assert the item count + spot-check
   fields.
3. Run it:
   ```bash
   npx vitest run tests/platforms.test.ts
   npx tsc --noEmit            # the manifest schema is type-checked at load
   ```
4. A green test against a fixture trimmed from a **live** page is the bar — it
   pins the dialect + paths so a future site redesign trips a test instead of
   silently yielding zero items.

> Tip: the existing manifests are worked examples of every dialect —
> `olx.yaml` (double-encoded `window.*`), `autovit.yaml` (urql `*`/`~json`),
> `imobiliare.yaml` (`@graph` `~type:`), `vinted.yaml` (flight + ld+json),
> `homezz.yaml`/`carzz.yaml` (dom-selector).

---

## 6. Checklist

- [ ] `plugins/<vendor>.yaml` created; `vendor`, `domain`, `engine`, `rate_limit_ms` set
- [ ] `search_mapping` resolves `id`/`title`/`price`/`url` on a live page
- [ ] `product_mapping` resolves the same on a detail page
- [ ] optional fields (currency/location/image/seller/specs) mapped where present
- [ ] `fetch_strategy: browser` only if a plain fetch is walled
- [ ] fixture committed (PII anonymized) + a passing test
- [ ] `npx tsc --noEmit` and the suite are green
