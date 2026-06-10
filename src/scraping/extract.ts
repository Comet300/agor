/**
 * Locate and parse the JSON payload embedded in a fetched HTML page.
 *
 * Four locator dialects are supported, matching the `payload_locator` field of a
 * vendor manifest:
 *   - `script#<id>`   — a `<script id="<id>" …>{ JSON }</script>` blob (the
 *                       Next.js `__NEXT_DATA__` pattern).
 *   - `window.<NAME>` — an inline `window.<NAME> = …;` assignment, where the
 *                       value is EITHER an object literal (`{ … }`) OR a JSON
 *                       string (`"…"`, contents are escaped JSON — OLX's
 *                       `window.__PRERENDERED_STATE__` does this).
 *   - `ldjson`        — every `<script type="application/ld+json">` block
 *                       (multi-candidate: the engine uses the first block whose
 *                       item path resolves). Tolerates embedded ASCII control
 *                       characters (publi24 ships literal newlines in strings).
 *   - `flight:<anchor>` — Next.js App-Router RSC flight: concatenates all
 *                       `self.__next_f.push([1,"…"])` chunk bodies, decodes
 *                       them as JSON string literals, then slices the balanced
 *                       JSON value after each `"<anchor>":` occurrence
 *                       (multi-candidate, like `ldjson`).
 *
 * A clear {@link Error} is thrown when the payload cannot be located or its
 * contents fail to parse; the scraping engine treats that as a soft failure.
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
 * Index of the first char of the VALUE in a real `window.<NAME> = <value>`
 * assignment whose value looks like a payload (object literal or string), or
 * undefined. Hardened against false matches so a recoverable payload is not
 * silently missed:
 *   - `(?<![\w.])` left boundary rejects `subwindow.`/`myWindow.` prefixes,
 *   - `=(?![=>])` rejects comparisons/arrows (`==`, `===`, `=>`),
 *   - candidates whose value does not start with `{`/`"`/`'` (e.g. `= someVar`,
 *     or the name merely appearing inside an earlier string) are skipped, and
 *     scanning continues to the genuine assignment later in the body.
 */
function findWindowValueStart(body: string, name: string): number | undefined {
  const assign = new RegExp(`(?<![\\w.])window\\.${escapeRegExp(name)}\\s*=(?![=>])\\s*`, 'g');
  let m: RegExpExecArray | null;
  while ((m = assign.exec(body)) !== null) {
    const i = m.index + m[0].length;
    const c = body[i];
    if (c === '{' || c === '"' || c === "'") return i;
  }
  return undefined;
}

/**
 * Slice a balanced `{ … }` object literal starting at `start` (which must be the
 * opening brace), tolerating braces inside strings. Returns the source or undefined.
 */
function sliceBalancedObject(body: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = start; i < body.length; i++) {
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
 * Slice a quoted string literal starting at `start` (the opening quote),
 * respecting backslash escapes. Returns the literal *including* both quotes.
 */
function sliceStringLiteral(body: string, start: number): string | undefined {
  const quote = body[start]!;
  let escaped = false;
  for (let i = start + 1; i < body.length; i++) {
    const ch = body[i]!;
    if (escaped) {
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === quote) {
      return body.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Parse the value of a `window.<NAME>` assignment (object literal or JSON string). */
function extractWindowPayload(body: string, name: string): unknown {
  const start = findWindowValueStart(body, name);
  if (start === undefined) {
    throw new Error(`extractPayload: window.${name} assignment not found`);
  }
  const first = body[start];

  if (first === '{') {
    const raw = sliceBalancedObject(body, start);
    if (raw === undefined) {
      throw new Error(`extractPayload: window.${name} object literal is unbalanced`);
    }
    return parseJson(raw, `window.${name}`);
  }

  if (first === '"') {
    // String-encoded: the literal's value is JSON text (often escaped). Parse
    // the JS string literal to recover that text, then parse the JSON.
    const literal = sliceStringLiteral(body, start);
    if (literal === undefined) {
      throw new Error(`extractPayload: window.${name} string literal is unterminated`);
    }
    const innerText = parseJson(literal, `window.${name} (string literal)`);
    if (typeof innerText !== 'string') {
      throw new Error(`extractPayload: window.${name} string literal did not yield text`);
    }
    return parseJson(innerText, `window.${name} (decoded JSON)`);
  }

  throw new Error(
    `extractPayload: window.${name} value is neither an object literal nor a string`,
  );
}

/** JSON.parse with a located error message. */
function parseJson(raw: string, where: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`extractPayload: failed to JSON.parse ${where}: ${(err as Error).message}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Multi-candidate locators: ldjson + flight:<anchor>
// ────────────────────────────────────────────────────────────────────────────

/**
 * Slice a balanced JSON value starting at `start` (`{`, `[`, or `"`), tolerant
 * of brackets/braces inside strings. Returns the raw source or undefined.
 */
function sliceBalancedJson(body: string, start: number): string | undefined {
  const first = body[start];
  if (first === '"') return sliceStringLiteral(body, start);
  if (first !== '{' && first !== '[') return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * All parsed `<script type="application/ld+json">` blocks. Each block is parsed
 * raw first; on failure, retried with ASCII control characters replaced by
 * spaces (some vendors ship literal newlines inside JSON strings — structural
 * whitespace is unaffected by the substitution). Unparseable blocks are skipped.
 */
function extractLdJsonCandidates(body: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const raw = m[1]!.trim();
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
      continue;
    } catch {
      /* retry sanitized below */
    }
    try {
      // eslint-disable-next-line no-control-regex
      out.push(JSON.parse(raw.replace(/[\x00-\x1f]/g, ' ')));
    } catch {
      /* skip the block */
    }
  }
  if (out.length === 0) throw new Error('extractPayload: no parseable application/ld+json block');
  return out;
}

/**
 * Candidate JSON values for `"<anchor>":` inside a decoded RSC flight stream.
 * Chunk bodies are decoded exactly (each is a valid JSON string body), then each
 * anchor occurrence's balanced value is sliced and parsed. Capped to keep a
 * pathological page bounded; the engine picks the first candidate whose item
 * path resolves.
 */
function extractFlightCandidates(body: string, anchor: string): unknown[] {
  const chunkRe = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
  let decoded = '';
  let m: RegExpExecArray | null;
  while ((m = chunkRe.exec(body)) !== null) {
    try {
      decoded += JSON.parse(`"${m[1]!}"`) as string;
    } catch {
      /* skip an undecodable chunk */
    }
  }
  if (decoded === '') throw new Error('extractPayload: no self.__next_f flight chunks found');

  const out: unknown[] = [];
  const needle = `"${anchor}":`;
  let from = 0;
  while (out.length < 16) {
    const i = decoded.indexOf(needle, from);
    if (i === -1) break;
    from = i + needle.length;
    // Skip whitespace to the value start.
    let v = from;
    while (v < decoded.length && (decoded[v] === ' ' || decoded[v] === '\n')) v++;
    const raw = sliceBalancedJson(decoded, v);
    if (raw === undefined) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      /* a non-JSON occurrence (e.g. inside framing); keep scanning */
    }
  }
  if (out.length === 0) {
    throw new Error(`extractPayload: flight anchor "${anchor}" yielded no JSON value`);
  }
  return out;
}

/**
 * Multi-candidate extraction for `ldjson` and `flight:<anchor>` locators.
 * Returns the candidate list, or `undefined` when `locator` is a classic
 * single-payload dialect (script# / window.*) — use {@link extractPayload} then.
 */
export function extractCandidates(body: string, locator: string): unknown[] | undefined {
  if (locator === 'ldjson') return extractLdJsonCandidates(body);
  const flight = /^flight:(.+)$/.exec(locator);
  if (flight) return extractFlightCandidates(body, flight[1]!);
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
    const re = new RegExp(
      `<script\\b[^>]*\\bid=["']${escapeRegExp(scriptId)}["'][^>]*>([\\s\\S]*?)<\\/script>`,
      'i',
    );
    const m = re.exec(body);
    if (!m) {
      throw new Error(`extractPayload: <script id="${scriptId}"> not found`);
    }
    return parseJson(m[1]!.trim(), `<script id="${scriptId}">`);
  }

  const windowName = parseWindowLocator(locator);
  if (windowName !== undefined) {
    return extractWindowPayload(body, windowName);
  }

  throw new Error(`extractPayload: unsupported locator "${locator}"`);
}
