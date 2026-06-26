/**
 * Seller blocklist filtering: drop listings from sellers the user has blocked,
 * matched by display name (case-insensitive) or phone number. Pure functions.
 *
 * Phone matching is forgiving about formatting and country-code prefixes: both
 * the stored block entry and the listing phone are reduced to digits, then
 * compared on their last 9 digits (so `+40712345678`, `0040712345678` and
 * `0712345678` all match the same Romanian mobile).
 */
import type { IScrapedItem } from '../contracts';

/** Reduce a phone string to a comparable key: digits, last 9 (national number). */
export function phoneKey(raw: string): string {
  const digits = raw.replace(/\D+/g, '');
  return digits.length > 9 ? digits.slice(-9) : digits;
}

/**
 * Drop items whose seller name (lowercased) is in `blockedSellers`, or whose
 * phone matches one in `blockedPhones`. Empty blocklists pass everything through.
 */
export function applyBlocklist(
  items: IScrapedItem[],
  blockedSellers: string[] = [],
  blockedPhones: string[] = [],
): IScrapedItem[] {
  const names = new Set(blockedSellers.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const phones = new Set(blockedPhones.map(phoneKey).filter(Boolean));
  if (names.size === 0 && phones.size === 0) return items;
  return items.filter((item) => {
    if (item.sellerName && names.has(item.sellerName.toLowerCase())) return false;
    if (item.phone && phones.has(phoneKey(item.phone))) return false;
    return true;
  });
}
