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
 *       · an empty selector (e.g. `"@data-id"`) targets the item element itself,
 *       · a `~re:<pattern>` prefix finds the most specific descendant whose text
 *         matches the (case-insensitive) regex and returns capture group 1 (or
 *         the whole match) — a class-independent, text-anchored extraction
 *         (e.g. `price: "~re:([\\d.,]+)\\s*(?:lei|ron|eur)"`),
 *       · a `~text:<substring>` prefix returns the text of the most specific
 *         descendant containing that substring.
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
/**
 * Find the most specific descendant of `el` whose collapsed text matches, and
 * return a value from it. `pick` maps the matched element's text to the result;
 * "most specific" = the matching element with the SHORTEST text, so a price node
 * wins over the whole card that also contains it. The item element itself is the
 * last-resort candidate.
 */
function findByText(
  el: HTMLElement,
  matches: (text: string) => string | undefined,
): string | undefined {
  let best: { len: number; value: string } | undefined;
  const consider = (node: HTMLElement): void => {
    const text = node.text.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const value = matches(text);
    if (value === undefined) return;
    if (!best || text.length < best.len) best = { len: text.length, value };
  };
  for (const node of el.querySelectorAll('*')) consider(node);
  if (!best) consider(el);
  return best?.value;
}

function extractField(el: HTMLElement, raw: string): string | boolean | undefined {
  if (raw.startsWith('=')) return raw.slice(1);
  // Text-anchored operators: locate by content, independent of class/structure.
  if (raw.startsWith('~re:')) {
    let re: RegExp;
    try {
      re = new RegExp(raw.slice(4), 'i');
    } catch {
      return undefined; // a malformed manifest regex yields no value, not a throw
    }
    return findByText(el, (text) => {
      const m = re.exec(text);
      return m ? (m[1] ?? m[0]) : undefined;
    });
  }
  if (raw.startsWith('~text:')) {
    const needle = raw.slice(6).toLowerCase();
    return findByText(el, (text) => (text.toLowerCase().includes(needle) ? text : undefined));
  }
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
