/**
 * Stage 1 of the pipeline: turn raw payload nodes into normalized {@link IScrapedItem}s.
 *
 * The normalizer is the only place where vendor-specific field paths (declared in
 * the YAML manifest's `search_mapping` / `product_mapping`) meet the canonical
 * internal item shape. It is pure and deterministic: same nodes + plugin in,
 * same items out — no clock, no network, no persistence.
 */
import type { AttributesFrom, IScrapedItem, IVendorPlugin } from '../contracts';
import { resolvePath } from '../util/jsonPath';
import { canonicalCurrency, inferCurrencyFromText } from '../util/currency';

/**
 * Field paths may be prefixed with "!" to mean "logical NOT of the located
 * value's truthiness" (e.g. AutoVit flags dealers as `business`, so a private
 * owner is `!node.sellerType.business`). Split that prefix off before resolving.
 */
function splitNot(path: string): { negate: boolean; path: string } {
  if (path.startsWith('!')) return { negate: true, path: path.slice(1) };
  return { negate: false, path };
}

/**
 * Parse a raw price value (number or messy string) into a clean float.
 *
 * Handles European and mixed groupings by keeping only digits and separators,
 * then deciding which separator is the decimal point:
 *   "4.300"     -> 4300      (dot used as a thousands group)
 *   "4 300"     -> 4300      (space group)
 *   "4300,50"   -> 4300.5    (comma as decimal)
 *   "1.234,56"  -> 1234.56   (dot groups, comma decimal)
 *   "1,234.56"  -> 1234.56   (comma groups, dot decimal)
 * Returns `null` when no sensible number can be extracted.
 */
function parsePrice(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== 'string') return null;

  // Keep only digits and the separators we understand (dot, comma, space).
  const cleaned = raw.replace(/[^\d.,\s]/g, '').trim();
  if (cleaned === '') return null;

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');

  let decimalSep: '.' | ',' | null = null;
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: whichever comes last is the decimal separator.
    decimalSep = lastDot > lastComma ? '.' : ',';
  } else if (lastComma !== -1) {
    // Only commas. A single comma followed by 1-2 digits reads as a decimal;
    // otherwise it is a thousands group (e.g. "1,234").
    const after = cleaned.slice(lastComma + 1).replace(/\s/g, '');
    decimalSep = cleaned.indexOf(',') === lastComma && /^\d{1,2}$/.test(after) ? ',' : null;
  } else if (lastDot !== -1) {
    // Only dots. A single dot followed by 1-2 digits reads as a decimal;
    // otherwise it is a thousands group (e.g. "4.300").
    const after = cleaned.slice(lastDot + 1).replace(/\s/g, '');
    decimalSep = cleaned.indexOf('.') === lastDot && /^\d{1,2}$/.test(after) ? '.' : null;
  }

  let normalized: string;
  if (decimalSep) {
    const [intPart, fracPart = ''] = cleaned.split(decimalSep);
    // Everything before the decimal separator: strip all grouping chars.
    const intDigits = (intPart ?? '').replace(/[^\d]/g, '');
    const fracDigits = fracPart.replace(/[^\d]/g, '');
    normalized = `${intDigits}.${fracDigits}`;
  } else {
    // No decimal separator: every separator is grouping — strip them all.
    normalized = cleaned.replace(/[^\d]/g, '');
  }

  if (normalized === '' || normalized === '.') return null;
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * Coerce a resolved value into a boolean seller-type flag.
 * String hints win over raw truthiness: 'company'/'business'/'agency' => false
 * (a professional seller), 'private' => true (a private owner).
 */
function coercePrivateOwner(value: unknown, negate: boolean): boolean {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    // Professional/corporate sellers (incl. AutoVit's "ProfessionalSeller").
    if (
      v.includes('professional') ||
      v === 'company' ||
      v === 'business' ||
      v === 'agency' ||
      v === 'dealer'
    ) {
      return negate ? true : false;
    }
    // Private owners: AutoVit "PrivateSeller", plain "private", and the
    // Romanian "privat" / "Vânzător privat" (mobile.de RO locale).
    if (v.includes('privat')) {
      return negate ? false : true;
    }
  }
  const truthy = Boolean(value);
  return negate ? !truthy : truthy;
}

/** Named & numeric HTML entities that show up in vendor JSON text. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Decode HTML entities in text vendors ship raw inside JSON strings (publi24
 * titles carry `&#238;`/`&#259;`/`&amp;`). Leaves text without entities intact.
 */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** True when stringifying a value yields a useless "[object …]" tag. */
function isObjectTag(s: string): boolean {
  return /^\[object [A-Za-z]+\]$/.test(s);
}

/**
 * Coerce a resolved (possibly missing) value into a string field.
 * Missing/undefined/null becomes an empty string so callers can detect absence.
 * An object that would stringify to "[object Object]" is also treated as absent
 * (empty) so a mis-pathed object-typed field fails loud rather than emitting the
 * tag; HTML entities in genuine text are decoded.
 */
function coerceString(value: unknown): string {
  if (value == null) return '';
  const s = String(value).trim();
  if (isObjectTag(s)) return '';
  return decodeEntities(s);
}

/**
 * Parse a vendor's posted-at date into epoch ms, or `undefined` when absent /
 * unparseable. Handles ISO 8601 (OLX `createdTime`, ld+json `datePublished`) and
 * a space-separated `YYYY-MM-DD HH:MM:SS` (Storia `dateCreated`) by normalizing
 * the space to `T` so it parses as local time deterministically.
 */
function parseDate(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (s === '') return undefined;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') : s;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** A resolved field: its raw value plus whether a leading "!" should negate it. */
type FieldValue = { negate: boolean; value: unknown };
/** Accessor that yields a field's raw value for one node/record. */
type FieldAccessor = (field: string) => FieldValue;

/**
 * Build one {@link IScrapedItem} from a field accessor, applying coercion by the
 * TARGET field name. Returns `null` for a node missing a required identity field
 * (id/title/url) or an unparseable price. Shared by both engines.
 */
/**
 * Explode a key/value array (e.g. OLX `params:[{name,value}]`) into a spec bag.
 * Multi-category vendors expose different params per listing (a car vs a flat vs
 * a phone), so this keeps WHATEVER the listing actually carries rather than a
 * fixed key list. Skips entries with an empty name or value.
 */
function explodeAttributes(node: unknown, spec: AttributesFrom): Record<string, string> {
  const arr = resolvePath(node, spec.path);
  if (!Array.isArray(arr)) return {};
  const out: Record<string, string> = {};
  for (const el of arr) {
    if (el == null || typeof el !== 'object') continue;
    const rec = el as Record<string, unknown>;
    const name = coerceString(rec[spec.key]);
    const value = coerceString(rec[spec.value]);
    if (name !== '' && value !== '') out[name] = value;
  }
  return out;
}

function buildItem(
  get: FieldAccessor,
  fields: Record<string, string>,
  vendor: string,
  attributeMap: Record<string, string> | undefined,
  explodedAttributes: Record<string, string>,
): IScrapedItem | null {
  // ── Required identity fields ──────────────────────────────────────────────
  const id = coerceString(get('id').value);
  const title = coerceString(get('title').value);
  const url = coerceString(get('url').value);
  if (id === '' || title === '' || url === '') return null;

  // ── Price (required, parseable) ───────────────────────────────────────────
  const price = parsePrice(get('price').value);
  if (price == null) return null;

  // ── Booleans ──────────────────────────────────────────────────────────────
  const priv = get('isPrivateOwner');
  const isPrivateOwner = coercePrivateOwner(priv.value, priv.negate);

  // inStock defaults to TRUE when the field is undeclared/unresolved.
  const stock = get('inStock');
  const inStock =
    'inStock' in fields && stock.value !== undefined
      ? stock.negate
        ? !Boolean(stock.value)
        : Boolean(stock.value)
      : true;

  // ── Optional string fields ────────────────────────────────────────────────
  // Currency: prefer the declared field; when blank, infer from the raw price
  // text (e.g. "16.990 eur" / "124,000 €"). A still-blank currency is left empty
  // for the benchmark stage to resolve via the SERP-dominant fallback.
  const currencyRaw = coerceString(get('currency').value);
  const currency =
    currencyRaw !== ''
      ? canonicalCurrency(currencyRaw)
      : inferCurrencyFromText(coerceString(get('price').value));
  const location = coerceString(get('location').value);
  const imageUrl = coerceString(get('imageUrl').value);
  const phone = coerceString(get('phone').value);

  const description = coerceString(get('description').value);
  const postedAt = parseDate(get('postedAt').value);

  const item: IScrapedItem = {
    id,
    title,
    price,
    currency,
    url,
    isPrivateOwner,
    inStock,
    vendor,
  };
  if (location !== '') item.location = location;
  if (imageUrl !== '') item.imageUrl = imageUrl;
  if (phone !== '') item.phone = phone;
  if (description !== '') item.description = description;
  if (postedAt !== undefined) item.postedAt = postedAt;

  // Structured specs: start from the flexible explode (whatever the listing
  // carries), then overlay the canonical named map. Both optional; only kept when
  // non-empty. The named map wins on a key clash (it's the curated form).
  const attributes: Record<string, string> = { ...explodedAttributes };
  if (attributeMap) {
    for (const name of Object.keys(attributeMap)) {
      const v = coerceString(get(`@attr:${name}`).value);
      if (v !== '') attributes[name] = v;
    }
  }
  if (Object.keys(attributes).length > 0) item.attributes = attributes;
  return item;
}

/**
 * Normalize raw payload nodes into well-formed {@link IScrapedItem}s.
 *
 * Engine-aware: for `json-extractor` each field is resolved from the node via its
 * JSON path (honouring the leading "!" convention); for `dom-selector` the record
 * is already keyed by field name (the scraping engine resolved the CSS selectors,
 * `@attr`, and `!`), so values are read directly. Both share {@link buildItem}.
 */
export function normalizeItems(
  rawNodes: unknown[],
  plugin: IVendorPlugin,
  mapping: 'search' | 'product',
): IScrapedItem[] {
  const m = mapping === 'search' ? plugin.search_mapping : plugin.product_mapping;
  const fields = m.fields;
  const attributeMap = m.attributes;
  const attributesFrom = m.attributes_from;

  // Combined path lookup: regular fields plus each attribute under an `@attr:<name>`
  // pseudo-field, so the single accessor resolves both with the same dialect rules.
  const paths: Record<string, string> = { ...fields };
  if (attributeMap) {
    for (const [name, path] of Object.entries(attributeMap)) paths[`@attr:${name}`] = path;
  }

  const items: IScrapedItem[] = [];

  for (const node of rawNodes) {
    const get: FieldAccessor =
      plugin.engine === 'dom-selector'
        ? // dom-selector records are keyed by field name; `!`/`@attr` already applied.
          (field) => ({ negate: false, value: (node as Record<string, unknown>)?.[field] })
        : // json-extractor resolves a JSON path, honouring the leading "!" convention.
          (field) => {
            const path = paths[field];
            if (path == null) return { negate: false, value: undefined };
            // Literal constant: "=EUR" yields the text after '=' verbatim — for
            // sources with no machine-readable field (e.g. mobile.de currency).
            if (path.startsWith('=')) {
              return { negate: false, value: path.slice(1) };
            }
            // Template field: a value with {sub.path} placeholders is built by
            // interpolating each resolved sub-path (e.g. Storia's offer URL). A
            // placeholder resolving to empty makes the whole field invalid (an
            // empty `{slug}` would yield a broken `/ad/-<id>` deep link) — signal
            // that with `undefined` so a required field (url) drops the item.
            if (path.includes('{')) {
              let anyEmpty = false;
              const value = path.replace(/\{([^}]+)\}/g, (_, sub: string) => {
                const resolved = coerceString(resolvePath(node, sub.trim()));
                if (resolved === '') anyEmpty = true;
                return resolved;
              });
              return { negate: false, value: anyEmpty ? undefined : value };
            }
            const { negate, path: real } = splitNot(path);
            return { negate, value: resolvePath(node, real) };
          };

    // The flexible explode reads the raw node directly (json-extractor only; a
    // dom-selector record is a flat field map with no array to explode).
    const exploded =
      attributesFrom && plugin.engine !== 'dom-selector'
        ? explodeAttributes(node, attributesFrom)
        : {};

    const item = buildItem(get, fields, plugin.vendor, attributeMap, exploded);
    if (item) items.push(item);
  }

  return items;
}
