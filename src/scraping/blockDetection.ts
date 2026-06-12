/**
 * Anti-bot block detection by response signature.
 *
 * A challenge is identified from the HTTP STATUS plus PROVIDER-SIGNATURE HEADERS —
 * never from the response body. The live crawl proved a body grep is wrong: pages
 * that returned full data still embed `datadome`/`recaptcha`/`challenge-platform`
 * SDK references, so body-substring detection would false-positive every working
 * vendor to zero. Header signatures (paired with a deny status) do not.
 *
 * Signatures mirror the providers the marketplaces sit behind:
 *   - Akamai     — `server: AkamaiGHost` or `x-akamai-*`
 *   - Cloudflare — `cf-ray`
 *   - Imperva    — `x-iinfo` / `x-cdn: Incapsula`
 *   - Fastly     — `x-served-by`
 *   - CloudFront — `x-amz-cf-id`
 */

export type BlockProvider =
  | 'akamai'
  | 'cloudflare'
  | 'imperva'
  | 'fastly'
  | 'cloudfront'
  | 'unknown';

/** A response classification: whether it is a hard anti-bot block and by whom. */
export interface ResponseClassification {
  /** True only for a deny status carrying a recognised provider signature. */
  blocked: boolean;
  /** The protection provider, when a block (or recognised edge) is identified. */
  provider?: BlockProvider;
}

/** Statuses a protection edge uses to deny a bot. */
const DENY_STATUSES = new Set([403, 503]);

/** Case-insensitive header lookup over a plain record. */
function header(headers: Record<string, string | string[] | undefined>, name: string): string {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = direct ?? findCaseInsensitive(headers, name);
  if (value === undefined) return '';
  return Array.isArray(value) ? value.join(' ') : String(value);
}

function findCaseInsensitive(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | string[] | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

/**
 * Identify the protection provider fronting a response from its headers, or
 * `undefined` when none is recognised. Independent of status so it can label the
 * edge of a normal 200 too (useful for diagnostics), while {@link classifyResponse}
 * only treats a deny status as an actual block.
 */
export function detectProvider(
  headers: Record<string, string | string[] | undefined>,
): BlockProvider | undefined {
  const server = header(headers, 'server').toLowerCase();
  if (server.includes('akamaighost') || header(headers, 'x-akamai-request-id') !== '') {
    return 'akamai';
  }
  if (header(headers, 'cf-ray') !== '' || server.includes('cloudflare')) {
    return 'cloudflare';
  }
  if (
    header(headers, 'x-iinfo') !== '' ||
    header(headers, 'x-cdn').toLowerCase().includes('incapsula')
  ) {
    return 'imperva';
  }
  if (header(headers, 'x-amz-cf-id') !== '') {
    return 'cloudfront';
  }
  if (header(headers, 'x-served-by') !== '') {
    return 'fastly';
  }
  return undefined;
}

/**
 * Classify a response as a hard anti-bot block or not.
 *
 * `blocked` is true only when BOTH a deny status (403/503) AND a recognised
 * provider signature are present — so a working 200 (even from Cloudflare with a
 * `cf-ray` header) is never a block, and a bare 403 with no signature is left to
 * the engine's soft-ban/rotation path rather than tripping a circuit breaker.
 */
export function classifyResponse(
  status: number,
  headers: Record<string, string | string[] | undefined>,
): ResponseClassification {
  if (!DENY_STATUSES.has(status)) return { blocked: false };
  const provider = detectProvider(headers);
  if (provider === undefined) return { blocked: false };
  return { blocked: true, provider };
}
