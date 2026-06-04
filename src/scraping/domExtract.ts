/**
 * DOM-selector extraction (dom-selector engine).
 *
 * For `engine: dom-selector` plugins the manifest mapping is reinterpreted:
 *   - search `json_path_to_items` / product `json_path` = the item-container
 *     CSS selector (each match is one listing; empty product selector = doc root),
 *   - each `fields.<name>` = a CSS selector relative to the item element, with:
 *       · a trailing `@attr` reads that attribute instead of `.text`
 *         (e.g. `url: "a.title@href"`),
 *       · a leading `!` yields the NEGATED presence of the selected element
 *         (e.g. `inStock: "!.sold-out"`, `isPrivateOwner: "!.badge-company"`),
 *       · an empty selector (e.g. `"@data-id"`) targets the item element itself.
 *
 * Each item is emitted as a record keyed by `IScrapedItem` field name; the
 * pipeline normalizer then coerces those values exactly like json-extractor nodes.
 */
import { parse, type HTMLElement } from 'node-html-parser';
import type { IVendorPlugin } from '../contracts';

interface ParsedSelector {
  selector: string;
  attr?: string;
  negate: boolean;
}

/** Split a field selector into its `!` negation, base selector, and `@attr`. */
export function parseFieldSelector(raw: string): ParsedSelector {
  let negate = false;
  let s = raw.trim();
  if (s.startsWith('!')) {
    negate = true;
    s = s.slice(1).trim();
  }
  // Trailing `@attr`: only treat the suffix as an attribute when it is a simple
  // identifier, so a selector that legitimately contains `@` is left intact.
  const at = s.lastIndexOf('@');
  let attr: string | undefined;
  if (at !== -1) {
    const suffix = s.slice(at + 1);
    if (/^[a-zA-Z_][\w:-]*$/.test(suffix)) {
      attr = suffix;
      s = s.slice(0, at).trim();
    }
  }
  return { selector: s, attr, negate };
}

/**
 * Resolve one field selector against an item element.
 * Returns a boolean for a negated (presence) selector, the attribute/text string
 * when found, or `undefined` when the selector matches nothing.
 */
function extractField(el: HTMLElement, raw: string): string | boolean | undefined {
  const { selector, attr, negate } = parseFieldSelector(raw);
  const target = selector === '' ? el : el.querySelector(selector);

  if (negate) {
    // Presence-based negation: element found => not (e.g. has sold-out badge).
    return !target;
  }
  if (!target) return undefined;
  const value = attr ? target.getAttribute(attr) : target.text.trim();
  return value ?? undefined;
}

/** Build a field-name-keyed record for one item element. */
function extractRecord(el: HTMLElement, fields: Record<string, string>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [name, selector] of Object.entries(fields)) {
    const value = extractField(el, selector);
    if (value !== undefined) record[name] = value;
  }
  return record;
}

/** Extract every search-result item record from a page's HTML. */
export function domExtractSearch(html: string, plugin: IVendorPlugin): Record<string, unknown>[] {
  const root = parse(html);
  const container = plugin.search_mapping.json_path_to_items;
  const elements = container ? root.querySelectorAll(container) : [];
  return elements.map((el) => extractRecord(el, plugin.search_mapping.fields));
}

/** Extract the single product record from a page's HTML (wrapped as an array). */
export function domExtractProduct(html: string, plugin: IVendorPlugin): Record<string, unknown>[] {
  const root = parse(html);
  const rootSelector = plugin.product_mapping.json_path;
  const el = rootSelector ? root.querySelector(rootSelector) : root;
  if (!el) return [];
  return [extractRecord(el, plugin.product_mapping.fields)];
}
