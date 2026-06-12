/**
 * Minimal JSON path resolver used by the scraping engine (locate item arrays /
 * product nodes) and the pipeline normalizer (resolve per-field paths).
 *
 * Supports dot notation and numeric bracket indices:
 *   "props.pageProps.data.listing.items"
 *   "photos[0].link"
 *
 * Plus three segments for data nested inside opaque-keyed / string-encoded caches:
 *   "*"          — current value is an object or ARRAY; resolve the remaining
 *                  path against each value/element and return the first that
 *                  resolves (AutoVit's `urqlState.*` opaque hash; ld+json
 *                  `@graph.*` node lists).
 *   "~json"      — current value is a string; JSON.parse it and continue (e.g.
 *                  AutoVit's stringified `urqlState.<hash>.data`).
 *   "~tail:<sep>"— current value is a string; take the substring after the LAST
 *                  `<sep>` (e.g. `item.@id.~tail:-` extracts the numeric id from
 *                  imobiliare's `…/item-273353106`).
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

  // Wildcard: try each value/element of the current object or array, take the
  // first where the remaining path resolves.
  if (head === '*') {
    if (typeof cur !== 'object') return undefined;
    const values = Array.isArray(cur) ? cur : Object.values(cur as Record<string, unknown>);
    for (const value of values) {
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

  // Find select: the current value is an array of records; pick the first element
  // whose `<key>` field equals `<value>`, then continue. Resolves key/value spec
  // arrays like OLX `params:[{key,value}]` / AutoVit `parameters:[{key,...}]`:
  //   params.~find:key=rulaj.value
  if (head.startsWith('~find:')) {
    const expr = head.slice('~find:'.length);
    const eq = expr.indexOf('=');
    if (eq === -1 || !Array.isArray(cur)) return undefined;
    const field = expr.slice(0, eq);
    const wanted = expr.slice(eq + 1);
    const node = cur.find(
      (el) => String((el as Record<string, unknown>)?.[field]) === wanted,
    );
    return node === undefined ? undefined : walk(node, rest);
  }

  // Type select: the current value is an array (e.g. an ld+json `@graph`); pick
  // the first element whose `@type` matches, then continue. Lets one mapping pull
  // fields from sibling nodes (Product name/@id + Offer price) on a split graph.
  if (head.startsWith('~type:')) {
    const wanted = head.slice('~type:'.length);
    if (!wanted || !Array.isArray(cur)) return undefined;
    const node = cur.find((el) => {
      const t = (el as { '@type'?: unknown })?.['@type'];
      return Array.isArray(t) ? t.includes(wanted) : t === wanted;
    });
    return node === undefined ? undefined : walk(node, rest);
  }

  // Tail: the current value is a string; keep what follows the LAST separator.
  if (head.startsWith('~tail:')) {
    if (typeof cur !== 'string') return undefined;
    const sep = head.slice('~tail:'.length);
    if (!sep) return undefined;
    const i = cur.lastIndexOf(sep);
    return walk(i === -1 ? cur : cur.slice(i + sep.length), rest);
  }

  if (typeof cur !== 'object') return undefined;
  return walk((cur as Record<string, unknown>)[head], rest);
}
