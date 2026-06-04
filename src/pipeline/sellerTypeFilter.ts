/**
 * Seller-type visibility filtering (Feature 7).
 *
 * Isolates private (P2P) sellers from companies (B2C) based on the normalized
 * `isPrivateOwner` flag. Pure and deterministic.
 */
import type { IScrapedItem, SellerVisibility } from '../contracts';

/**
 * Filter items by the user's seller-type preference:
 *   'both'    -> everything passes through
 *   'private' -> only private owners (isPrivateOwner === true)
 *   'company' -> only companies     (isPrivateOwner === false)
 */
export function applySellerFilter(
  items: IScrapedItem[],
  visibility: SellerVisibility,
): IScrapedItem[] {
  if (visibility === 'both') return items;
  const wantPrivate = visibility === 'private';
  return items.filter((item) => item.isPrivateOwner === wantPrivate);
}
