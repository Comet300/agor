/**
 * Self-healing DOM selectors — a TypeScript translation of Scrapling's
 * "adaptive / auto-match" idea, scoped to our `dom-selector` engine.
 *
 * The problem: a `dom-selector` manifest pins listing cards (and product roots)
 * to CSS selectors. When a vendor renames a class or reshuffles its markup, the
 * selector matches nothing and the vendor silently yields zero items until a
 * human edits the YAML.
 *
 * The fix, mirroring Scrapling: on every SUCCESSFUL scrape we store a lightweight
 * structural *fingerprint* of the matched elements (tag, class tokens, attribute
 * names, parent tag, child tag set). On a scrape where the pinned selector finds
 * nothing, we score every element on the page against that fingerprint with a
 * Sørensen–Dice token overlap and relocate to the best-matching repeated group
 * above a similarity threshold — so the cycle keeps working through the change.
 *
 * This module is pure (no I/O): persistence is provided by a {@link SelfHealer}
 * and the relocation is a function of the parsed DOM + a stored fingerprint.
 */
import type { HTMLElement } from 'node-html-parser';

/** Which selector on a manifest is being fingerprinted/relocated. */
export type SelectorRole = 'search' | 'product';

/**
 * Structural signature of an element, kept small and position-independent so it
 * survives class/id/layout churn. Mirrors the properties Scrapling tracks.
 */
export interface ElementFingerprint {
  /** Lower-cased tag name (e.g. `li`, `article`, `div`). */
  tag: string;
  /** Sorted class tokens shared by the matched elements. */
  classes: string[];
  /** Sorted attribute names (excluding `class`). */
  attrs: string[];
  /** Parent element's tag name (`''` when none). */
  parentTag: string;
  /** Sorted tag names of the element's element-children. */
  childTags: string[];
}

/** Reported when a selector was relocated, for logs + the admin alert. */
export interface HealInfo {
  role: SelectorRole;
  /** The manifest selector that stopped matching. */
  fromSelector: string;
  /** The selector the fingerprint relocated to. */
  toSelector: string;
  /** How many elements the relocated selector matched. */
  count: number;
  /** Similarity score of the relocated group (0–1). */
  score: number;
}

/** Persistence seam for fingerprints (sqlite-backed in production). */
export interface SelfHealer {
  load(vendor: string, role: SelectorRole): ElementFingerprint | undefined;
  save(vendor: string, role: SelectorRole, fp: ElementFingerprint): void;
}

/** Default Sørensen–Dice similarity threshold (Scrapling defaults to 0.4). */
export const DEFAULT_THRESHOLD = 0.4;

function classTokensOf(el: HTMLElement): string[] {
  // node-html-parser exposes classList.value as a string[] of tokens.
  const list = (el.classList as unknown as { value?: string[] } | undefined)?.value;
  return Array.isArray(list) ? list.filter(Boolean) : [];
}

function childTagsOf(el: HTMLElement): string[] {
  return el.childNodes
    .filter((n) => n.nodeType === 1)
    .map((n) => (n as HTMLElement).rawTagName?.toLowerCase() ?? '')
    .filter(Boolean)
    .sort();
}

/** Build a fingerprint from one element. */
export function fingerprintElement(el: HTMLElement): ElementFingerprint {
  const attrs = Object.keys(el.attributes ?? {})
    .filter((a) => a !== 'class')
    .sort();
  const parent = el.parentNode as HTMLElement | null;
  return {
    tag: el.rawTagName?.toLowerCase() ?? '',
    classes: [...classTokensOf(el)].sort(),
    attrs,
    parentTag: parent?.rawTagName?.toLowerCase() ?? '',
    childTags: childTagsOf(el),
  };
}

/**
 * Build a representative fingerprint from the full matched set. Listing cards
 * repeat, so we keep only the class tokens common to ALL matches (the stable
 * shared signature) and take the rest of the structure from the first element.
 */
export function fingerprintElements(els: HTMLElement[]): ElementFingerprint {
  const first = els[0]!;
  let common = new Set(classTokensOf(first));
  for (const el of els.slice(1)) {
    const here = new Set(classTokensOf(el));
    common = new Set([...common].filter((c) => here.has(c)));
  }
  return { ...fingerprintElement(first), classes: [...common].sort() };
}

/** Flatten a fingerprint into a weighted token set for similarity scoring. */
function tokensOf(fp: ElementFingerprint): string[] {
  return [
    `tag:${fp.tag}`,
    `parent:${fp.parentTag}`,
    ...fp.classes.map((c) => `class:${c}`),
    ...fp.attrs.map((a) => `attr:${a}`),
    ...fp.childTags.map((t) => `child:${t}`),
  ];
}

/** Sørensen–Dice coefficient over two token sets (unique tokens). */
function dice(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return (2 * inter) / (sa.size + sb.size);
}

/** A `tag.class1.class2` selector key for an element (its grouping signature). */
function selectorKeyOf(el: HTMLElement): string {
  const tag = el.rawTagName?.toLowerCase();
  if (!tag) return '';
  const classes = [...classTokensOf(el)].sort();
  return tag + classes.map((c) => `.${cssEscape(c)}`).join('');
}

/** Escape a class token for use in a CSS selector (defensive; tokens are simple). */
function cssEscape(token: string): string {
  return token.replace(/[^\w-]/g, (ch) => `\\${ch}`);
}

export interface RelocateResult {
  elements: HTMLElement[];
  /** The derived selector the elements share (for the admin to patch the YAML). */
  selector: string;
  /** Similarity of the chosen group to the stored fingerprint (0–1). */
  score: number;
}

/**
 * Relocate a broken selector. Groups every element on the page by its
 * `tag.classes` signature, scores each group's representative against the stored
 * fingerprint, and returns the best group at/above the threshold with at least
 * `minGroup` members. `minGroup` defaults to 2 (a repeated list) — pass 1 for a
 * single product root.
 */
export function relocate(
  root: HTMLElement,
  fp: ElementFingerprint,
  opts: { threshold?: number; minGroup?: number } = {},
): RelocateResult | undefined {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const minGroup = opts.minGroup ?? 2;
  const wanted = tokensOf(fp);

  const groups = new Map<string, HTMLElement[]>();
  for (const el of root.querySelectorAll('*')) {
    const key = selectorKeyOf(el);
    if (!key) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(el);
    else groups.set(key, [el]);
  }

  let best: RelocateResult | undefined;
  for (const [key, els] of groups) {
    if (els.length < minGroup) continue;
    const score = dice(wanted, tokensOf(fingerprintElement(els[0]!)));
    if (score < threshold) continue;
    if (
      best === undefined ||
      score > best.score ||
      (score === best.score && els.length > best.elements.length)
    ) {
      best = { elements: els, selector: key, score };
    }
  }
  return best;
}
