/**
 * Numeric range filters: price (in the listing's own currency) and structured
 * attributes (year, km, area, …). Pure. Attribute values are parsed from their
 * display strings with the same locale-aware parser the fair-value model uses.
 *
 * Leniency: a listing missing a filtered attribute is KEPT, not dropped — sparse
 * marketplaces omit specs often, and dropping on absence would hide real matches.
 */
import type { FilterConfig, IScrapedItem } from '../contracts';
import { parseNumericAttrs } from '../features/fairValue/attributes';

/** Drop items outside [priceMin, priceMax] (either bound optional). */
export function applyPriceRange(items: IScrapedItem[], min?: number, max?: number): IScrapedItem[] {
  if (min === undefined && max === undefined) return items;
  return items.filter((i) => (min === undefined || i.price >= min) && (max === undefined || i.price <= max));
}

/**
 * Drop items violating any attribute range. Each range's min/max is checked
 * against the parsed numeric attribute; a missing attribute passes (lenient).
 */
export function applyAttrRanges(
  items: IScrapedItem[],
  ranges?: FilterConfig['attrRanges'],
): IScrapedItem[] {
  if (!ranges || Object.keys(ranges).length === 0) return items;
  return items.filter((item) => {
    const a = parseNumericAttrs(item.attributes) as Record<string, number | undefined>;
    for (const [key, range] of Object.entries(ranges)) {
      const v = a[key];
      if (v === undefined) continue; // missing → lenient pass
      if (range.min !== undefined && v < range.min) return false;
      if (range.max !== undefined && v > range.max) return false;
    }
    return true;
  });
}
