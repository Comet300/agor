/**
 * Currency canonicalization + inference.
 *
 * One place that knows how a raw vendor currency token (an ISO code, a local
 * word, or a symbol embedded in a price string) maps to a canonical ISO code.
 * Used by the normalizer to fill a blank currency field from the price text.
 */

/**
 * Token → ISO code. Lower-cased keys; symbols and local words included. Keep
 * this the single source of truth for currency recognition across the app.
 */
export const CURRENCY_MAP: Record<string, string> = {
  // ISO codes (self-map, for case normalization).
  ron: 'RON',
  eur: 'EUR',
  usd: 'USD',
  gbp: 'GBP',
  // Local words / abbreviations.
  lei: 'RON',
  leu: 'RON',
  euro: 'EUR',
  // Symbols.
  '€': 'EUR',
  $: 'USD',
  '£': 'GBP',
  // 'lei' covers RON; the 'RON' symbol is just the word, handled above.
};

/** Canonicalize a known currency token to its ISO code, or '' if unrecognized. */
export function canonicalCurrency(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (v === '') return '';
  return CURRENCY_MAP[v] ?? raw.trim().toUpperCase();
}

/**
 * Infer an ISO currency from a raw price string by scanning it for any known
 * symbol or word token (e.g. "16.990 eur" → EUR, "124,000 €" → EUR). Returns ''
 * when nothing recognizable is present. Longer tokens are tried first so "euro"
 * wins over a bare "e" would-be match (none here, but order-safe).
 */
export function inferCurrencyFromText(priceText: string): string {
  if (!priceText) return '';
  const text = priceText.toLowerCase();
  // Word/abbrev tokens: match on word boundaries so "lei" doesn't fire inside
  // another word. Symbols: plain substring (they have no word boundary).
  const words = ['euro', 'eur', 'ron', 'lei', 'leu', 'usd', 'gbp'];
  for (const w of words) {
    if (new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(text)) {
      return CURRENCY_MAP[w]!;
    }
  }
  for (const sym of ['€', '$', '£']) {
    if (priceText.includes(sym)) return CURRENCY_MAP[sym]!;
  }
  return '';
}
