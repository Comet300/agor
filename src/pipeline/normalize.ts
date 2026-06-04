/**
 * Stage 1 of the pipeline: turn raw payload nodes into normalized {@link IScrapedItem}s.
 *
 * The normalizer is the only place where vendor-specific field paths (declared in
 * the YAML manifest's `search_mapping` / `product_mapping`) meet the canonical
 * internal item shape. It is pure and deterministic: same nodes + plugin in,
 * same items out — no clock, no network, no persistence.
 */
import type { IScrapedItem, IVendorPlugin } from '../contracts';
import { resolvePath } from '../util/jsonPath';

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
    if (v === 'company' || v === 'business' || v === 'agency') {
      return negate ? true : false;
    }
    if (v === 'private') {
      return negate ? false : true;
    }
  }
  const truthy = Boolean(value);
  return negate ? !truthy : truthy;
}

/**
 * Coerce a resolved (possibly missing) value into a string field.
 * Missing/undefined/null becomes an empty string so callers can detect absence.
 */
function coerceString(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
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
function buildItem(
  get: FieldAccessor,
  fields: Record<string, string>,
  vendor: string,
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
  const currency = coerceString(get('currency').value);
  const location = coerceString(get('location').value);
  const imageUrl = coerceString(get('imageUrl').value);
  const phone = coerceString(get('phone').value);

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
  const fields =
    mapping === 'search' ? plugin.search_mapping.fields : plugin.product_mapping.fields;

  const items: IScrapedItem[] = [];

  for (const node of rawNodes) {
    const get: FieldAccessor =
      plugin.engine === 'dom-selector'
        ? // dom-selector records are keyed by field name; `!`/`@attr` already applied.
          (field) => ({ negate: false, value: (node as Record<string, unknown>)?.[field] })
        : // json-extractor resolves a JSON path, honouring the leading "!" convention.
          (field) => {
            const path = fields[field];
            if (path == null) return { negate: false, value: undefined };
            const { negate, path: real } = splitNot(path);
            return { negate, value: resolvePath(node, real) };
          };

    const item = buildItem(get, fields, plugin.vendor);
    if (item) items.push(item);
  }

  return items;
}
