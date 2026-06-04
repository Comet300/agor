/** URL helpers: telemetry scrubbing (Feature 1) and domain extraction. */

/** Query params considered volatile tracking telemetry and stripped on ingest. */
const TELEMETRY_PARAMS = [
  /^utm_/i,
  /^gclid$/i,
  /^fbclid$/i,
  /^gad_/i,
  /^gbraid$/i,
  /^wbraid$/i,
  /^msclkid$/i,
  /^mc_/i,
  /^ref$/i,
  /^_ga$/i,
];

function isTelemetry(key: string): boolean {
  return TELEMETRY_PARAMS.some((re) => re.test(key));
}

/**
 * Remove volatile telemetry markers (utm_*, gclid, fbclid, …) while retaining
 * genuine search parameters. Throws on a non-HTTP(S) or unparseable URL.
 */
export function scrubUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  for (const key of [...url.searchParams.keys()]) {
    if (isTelemetry(key)) url.searchParams.delete(key);
  }
  url.hash = '';
  return url.toString();
}

/** Lowercased hostname without a leading `www.`. */
export function extractDomain(raw: string): string {
  return new URL(raw.trim()).hostname.toLowerCase().replace(/^www\./, '');
}
