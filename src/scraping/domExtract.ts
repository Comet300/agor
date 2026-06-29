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
import { fingerprintElements, relocate, type HealInfo, type SelfHealer } from './selfHeal';

/** Result of a dom-selector extraction: the records plus any self-heal report. */
export interface DomExtractResult {
  records: Record<string, unknown>[];
  /** Present when the pinned selector was empty and a fingerprint relocated it. */
  healed?: HealInfo;
}

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
 * when found, or `undefined` when the selector matches nothing. A value starting
 * with `=` is a literal constant (mirrors the json-extractor convention) for
 * fields the page lacks (e.g. `currency: "=EUR"`, `isPrivateOwner: "=private"`).
 */
function extractField(el: HTMLElement, raw: string): string | boolean | undefined {
  if (raw.startsWith('=')) return raw.slice(1);
  const { selector, attr, negate } = parseFieldSelector(raw);
  const target = selector === '' ? el : el.querySelector(selector);

  if (negate) {
    // Presence-based negation: element found => not (e.g. has sold-out badge).
    return !target;
  }
  if (!target) return undefined;
  // Collapse interior whitespace in text content (multi-line DOM nodes).
  const value = attr ? target.getAttribute(attr) : target.text.replace(/\s+/g, ' ').trim();
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

/**
 * Extract every search-result item record from a page's HTML.
 *
 * When a `healer` is supplied this self-heals: a successful match refreshes the
 * stored fingerprint of the listing cards; an empty match (the pinned selector
 * broke) relocates via the last-good fingerprint so the cycle keeps working, and
 * reports the relocation through {@link DomExtractResult.healed}.
 */
export function domExtractSearch(
  html: string,
  plugin: IVendorPlugin,
  healer?: SelfHealer,
): DomExtractResult {
  const root = parse(html);
  const container = plugin.search_mapping.json_path_to_items;
  let elements = container ? root.querySelectorAll(container) : [];
  let healed: HealInfo | undefined;

  if (healer && container) {
    if (elements.length > 0) {
      // Good scrape → remember what the cards look like for next time.
      healer.save(plugin.vendor, 'search', fingerprintElements(elements));
    } else {
      // Selector matched nothing → try to relocate from the stored fingerprint.
      const fp = healer.load(plugin.vendor, 'search');
      const found = fp ? relocate(root, fp, { minGroup: 2 }) : undefined;
      if (found) {
        elements = found.elements;
        healed = {
          role: 'search',
          fromSelector: container,
          toSelector: found.selector,
          count: found.elements.length,
          score: found.score,
        };
      }
    }
  }

  return {
    records: elements.map((el) => extractRecord(el, plugin.search_mapping.fields)),
    healed,
  };
}

/**
 * Extract the single product record from a page's HTML (wrapped as an array).
 * Self-heals the product-root selector the same way as the search container,
 * relocating to the single best-matching element when the pinned selector breaks.
 */
export function domExtractProduct(
  html: string,
  plugin: IVendorPlugin,
  healer?: SelfHealer,
): DomExtractResult {
  const root = parse(html);
  const rootSelector = plugin.product_mapping.json_path;
  // No root selector = whole document; nothing to heal.
  if (!rootSelector) {
    return { records: [extractRecord(root, plugin.product_mapping.fields)] };
  }

  let el = root.querySelector(rootSelector);
  let healed: HealInfo | undefined;

  if (healer) {
    if (el) {
      healer.save(plugin.vendor, 'product', fingerprintElements([el]));
    } else {
      const fp = healer.load(plugin.vendor, 'product');
      const found = fp ? relocate(root, fp, { minGroup: 1 }) : undefined;
      if (found) {
        el = found.elements[0]!;
        healed = {
          role: 'product',
          fromSelector: rootSelector,
          toSelector: found.selector,
          count: 1,
          score: found.score,
        };
      }
    }
  }

  if (!el) return { records: [] };
  return { records: [extractRecord(el, plugin.product_mapping.fields)], healed };
}
