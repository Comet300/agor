/**
 * Minimal JSON path resolver used by the scraping engine (locate item arrays /
 * product nodes) and the pipeline normalizer (resolve per-field paths).
 *
 * Supports dot notation and numeric bracket indices:
 *   "props.pageProps.data.listing.items"
 *   "photos[0].link"
 * Returns `undefined` if any segment is missing.
 */
export function resolvePath(root: unknown, path: string): unknown {
  if (!path) return root;
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur: unknown = root;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
