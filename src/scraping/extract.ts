/**
 * Locate and parse the JSON payload embedded in a fetched HTML page.
 *
 * Two locator dialects are supported, matching the `payload_locator` field of a
 * vendor manifest:
 *   - `script#<id>`   — a `<script id="<id>" …>{ JSON }</script>` blob (the
 *                       Next.js `__NEXT_DATA__` pattern OLX/Storia use).
 *   - `window.<NAME>` — an inline `window.<NAME> = { … };` assignment.
 *
 * A clear {@link Error} is thrown when the payload cannot be located or its
 * contents fail to parse, so a vendor layout change surfaces loudly.
 */

/** Parse a `script#<id>` locator into its element id. */
function parseScriptLocator(locator: string): string | undefined {
  const m = /^script#(.+)$/.exec(locator);
  return m ? m[1] : undefined;
}

/** Parse a `window.<NAME>` locator into the global variable name. */
function parseWindowLocator(locator: string): string | undefined {
  const m = /^window\.(.+)$/.exec(locator);
  return m ? m[1] : undefined;
}

/** Escape a string for safe interpolation into a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract `window.<NAME> = { … };` by scanning forward from the assignment and
 * balancing braces, so nested objects and braces inside strings are tolerated.
 * Returns the raw object-literal source, or `undefined` if not present.
 */
function sliceWindowAssignment(body: string, name: string): string | undefined {
  const assign = new RegExp(`window\\.${escapeRegExp(name)}\\s*=\\s*`);
  const m = assign.exec(body);
  if (!m) return undefined;

  // Find the opening brace of the object literal.
  let i = m.index + m[0].length;
  while (i < body.length && body[i] !== '{') i++;
  if (body[i] !== '{') return undefined;

  const start = i;
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (; i < body.length; i++) {
    const ch = body[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Locate the embedded payload described by `locator` within `body` and return
 * the parsed JSON value.
 *
 * @throws Error when the locator is unsupported, the payload cannot be found, or
 *         its contents are not valid JSON.
 */
export function extractPayload(body: string, locator: string): unknown {
  const scriptId = parseScriptLocator(locator);
  if (scriptId !== undefined) {
    // Match <script ... id="<id>" ...>CONTENTS</script>; id may appear in any
    // attribute position, so we anchor on the id and capture up to </script>.
    const re = new RegExp(
      `<script\\b[^>]*\\bid=["']${escapeRegExp(scriptId)}["'][^>]*>([\\s\\S]*?)<\\/script>`,
      'i',
    );
    const m = re.exec(body);
    if (!m) {
      throw new Error(`extractPayload: <script id="${scriptId}"> not found`);
    }
    const raw = m[1]!.trim();
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `extractPayload: failed to JSON.parse <script id="${scriptId}">: ${(err as Error).message}`,
      );
    }
  }

  const windowName = parseWindowLocator(locator);
  if (windowName !== undefined) {
    const raw = sliceWindowAssignment(body, windowName);
    if (raw === undefined) {
      throw new Error(`extractPayload: window.${windowName} assignment not found`);
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `extractPayload: failed to JSON.parse window.${windowName}: ${(err as Error).message}`,
      );
    }
  }

  throw new Error(`extractPayload: unsupported locator "${locator}"`);
}
