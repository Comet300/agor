/**
 * Minimal JSON path resolver used by the scraping engine (locate item arrays /
 * product nodes) and the pipeline normalizer (resolve per-field paths).
 *
 * Supports dot notation and numeric bracket indices:
 *   "props.pageProps.data.listing.items"
 *   "photos[0].link"
 *
 * Plus two segments for data nested inside opaque-keyed / string-encoded caches:
 *   "*"      — current value is an object; resolve the remaining path against
 *              each value and return the first that resolves (e.g. AutoVit's
 *              `urqlState.*` where the key is an opaque per-query hash).
 *   "~json"  — current value is a string; JSON.parse it and continue (e.g.
 *              AutoVit's stringified `urqlState.<hash>.data`).
 *
 * Returns `undefined` if any segment is missing.
 */
export function resolvePath(root: unknown, path: string): unknown {
  if (!path) return root;
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  return walk(root, segments);
}

function walk(cur: unknown, segments: string[]): unknown {
  if (segments.length === 0) return cur;
  if (cur == null) return undefined;
  const [head, ...rest] = segments as [string, ...string[]];

  // Wildcard: try each value of the current object, take the first that resolves.
  if (head === '*') {
    if (typeof cur !== 'object') return undefined;
    for (const value of Object.values(cur as Record<string, unknown>)) {
      const resolved = walk(value, rest);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }

  // Decode: the current value is a JSON string; parse and continue.
  if (head === '~json') {
    if (typeof cur !== 'string') return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(cur);
    } catch {
      return undefined;
    }
    return walk(parsed, rest);
  }

  if (typeof cur !== 'object') return undefined;
  return walk((cur as Record<string, unknown>)[head], rest);
}
