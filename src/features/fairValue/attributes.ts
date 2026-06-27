/**
 * Parse the display-string attribute bag into typed numerics for valuation.
 * Handles ro/en formatting: thousands dots ("145.000 km" → 145000), dotted years
 * ("2.016" → 2016), units ("65 m²" → 65, "116 CP" → 116), decimal commas
 * ("65,5" → 65.5). Pure.
 */

export interface NumericAttrs {
  year?: number;
  km?: number;
  area?: number;
  rooms?: number;
  power?: number;
}

/** Parse a single value: first number token, thousands-dots or decimal-comma aware. */
export function parseNumber(raw: string): number | undefined {
  const m = raw.replace(/\s/g, '').match(/[\d.,]+/);
  if (!m) return undefined;
  let t = m[0]!;
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) {
    t = t.replace(/[.,]/g, ''); // 145.000 / 12,345,678 → thousands
  } else {
    t = t.replace(',', '.'); // decimal comma → dot
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Pull the recognised numeric attributes out of the manifest attribute bag. */
export function parseNumericAttrs(attrs?: Record<string, string>): NumericAttrs {
  if (!attrs) return {};
  const out: NumericAttrs = {};
  const set = (k: keyof NumericAttrs, key: string): void => {
    const v = attrs[key];
    if (v !== undefined) {
      const n = parseNumber(v);
      if (n !== undefined) out[k] = n;
    }
  };
  set('year', 'year');
  set('km', 'km');
  set('area', 'area');
  set('rooms', 'rooms');
  set('power', 'power');
  return out;
}
