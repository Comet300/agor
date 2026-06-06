## Context

OLX Romania renders its SERP/product state into `window.__PRERENDERED_STATE__`, assigned as a JSON string (the value is a quoted, escaped string whose *contents* are JSON), inside an inline `<script>`. The bootstrap's `extractPayload` supports two locators — `script#<id>` and `window.<NAME> = {object}` — but not a string-valued global. The `olx.yaml` paths predate this and target `__NEXT_DATA__`, which the live page no longer contains. Verified against a live fetch: items at `state.listing.listing.ads` (search) and `state.ad.ad` (product), 11 ads, prices under `price.regularPrice.{value,currencyCode}` (a "Schimb"/exchange ad has `regularPrice: null`).

## Goals / Non-Goals

**Goals:**
- Read OLX's string-encoded `window.__PRERENDERED_STATE__` with the existing `window.<NAME>` locator.
- Recalibrate `olx.yaml` to the verified live paths for both search and product.
- A vendor layout change should fail *soft* (no items) rather than throw.
- Prove it against a real (trimmed) fixture; keep the engine tests independent of the production manifest.

**Non-Goals:**
- AutoVit/Storia recalibration (separate follow-ups; likely the same pattern).
- Phone-number reveal (OLX hides it behind a separate call) — out of scope here.
- Any pipeline/UX change.

## Decisions

### String-encoded `window.NAME` payloads
The `window.<NAME>` branch now inspects the first non-space char after `=`:
`{` → existing brace-matched object literal; `"`/`'` → scan the string literal
(respecting escapes), `JSON.parse` the literal to recover the inner JSON *text*,
then `JSON.parse` that to the object. *Why:* OLX double-encodes (a JSON string
containing JSON). Object-literal globals (e.g. other vendors) keep working
unchanged. Non-JSON string globals simply fail to parse and throw a clear error
— but a manifest only ever points `payload_locator` at a JSON payload.

### Extraction failure is a soft scrape failure
`engine.scrape()` wraps the `extract(body)` call: on throw it returns
`{ ok: false, status, rawNodes: [], benched }`. *Why:* a marketplace silently
changing its embedded-state shape should surface as a *failed cycle* (zero new
items, retriable) — the same path as a network failure — not an exception
bubbling into the scheduler's error handler. This also keeps the door open for
the planned "tell the user a watch is failing" work.

### Engine tests decouple from the production manifest
`scraping.test.ts` previously loaded the real `olx.yaml`; recalibrating it would
break those tests for the wrong reason. The engine tests move to an inline
synthetic `json-extractor` plugin matching their existing `__NEXT_DATA__`
fixture, so they test *the engine* (rotation, retry, rate-limit, extraction),
while a new `olx.test.ts` tests *the manifest* against a real-shaped fixture.
*Why:* a manifest is data; its calibration shouldn't live in the engine's unit
tests, and engine behavior shouldn't depend on a vendor's current page shape.

### Fixture is a trimmed real payload
`tests/fixtures/olx-prerendered.html` embeds `window.__PRERENDERED_STATE__ =
"<escaped JSON>"` with two real-shaped ads (one private with a price, one
business; plus one exchange ad with `regularPrice: null` to prove it is
dropped). *Why:* small, deterministic, and faithful to the live encoding.

## Risks / Trade-offs

- **OLX changes again** → soft-fail means a future shift yields empty cycles, not crashes; calibration is a manifest+fixture edit. Monitoring extraction success rate is the longer-term answer.
- **Double-parse on a non-JSON global** → only triggered if a manifest mis-points `payload_locator`; it throws a clear, located error (then soft-failed by the engine).
- **Single-quoted string globals** are not handled (OLX uses double quotes); documented, extend if a vendor needs it.

## Migration Plan

Additive/behavior-preserving for existing object-literal and `script#` payloads. Deploy: merge, then **restart the bot** (PM2 `restart` or re-run `npm start`) so the recalibrated `olx.yaml` loads. Rollback: revert the manifest (the engine changes are backward-compatible and harmless on their own).

## Open Questions

- Should a soft scrape failure increment a per-monitor failure counter to drive a user-facing "this watch is failing" notice? (Deferred to the failure-surfacing work.)
