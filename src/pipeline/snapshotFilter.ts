/**
 * Re-apply a watch's filters to a STORED snapshot.
 *
 * The cycle filters live results before deciding which NEW listings to notify,
 * but snapshots persist — so a filter added after an item was first seen (a new
 * exclusion keyword, a required-keyword whitelist, a blocked seller) leaves that
 * item in the browse carousel and the stats count. This predicate mirrors the
 * four pipeline filters exactly, against a stored snapshot, so `/browse` and
 * `/stats` can hide (and count) what the current filters would now drop.
 *
 * Pure; reuses the same matching primitives as the live pipeline so the two can
 * never diverge.
 */
import type { FilterConfig } from '../contracts';
import { buildExclusionRegex, keywordHaystack } from './exclusionKeywords';
import { phoneKey } from './sellerBlocklist';

/** The snapshot fields the filters read (structural subset of ItemSnapshot). */
export interface FilterableSnapshot {
  title?: string;
  description?: string;
  sellerPrivate?: boolean;
  sellerName?: string;
  phone?: string;
}

/**
 * True when `filters` would drop this snapshot — i.e. it should be hidden from
 * browse and counted as filtered in stats. Mirrors applyExclusion / applyRequired
 * / applySellerFilter / applyBlocklist.
 */
export function snapshotHidden(snap: FilterableSnapshot, filters: FilterConfig): boolean {
  // Keyword filters match title AND description (mirrors the live pipeline).
  const text = keywordHaystack(snap);

  // Exclusion: any excluded keyword in title/description hides it.
  const exclude = buildExclusionRegex(filters.exclusionKeywords ?? []);
  if (exclude && exclude.test(text)) return true;

  // Required (whitelist): when set, title/description matching none is hidden.
  const required = buildExclusionRegex(filters.requiredKeywords ?? []);
  if (required && !required.test(text)) return true;

  // Seller visibility: a non-'both' preference hides the other type — and an
  // unknown seller type too, matching applySellerFilter's strict equality.
  if (filters.sellerVisibility && filters.sellerVisibility !== 'both') {
    const wantPrivate = filters.sellerVisibility === 'private';
    if (snap.sellerPrivate !== wantPrivate) return true;
  }

  // Blocklist by seller name / phone.
  const names = new Set((filters.blockedSellers ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean));
  if (snap.sellerName && names.has(snap.sellerName.toLowerCase())) return true;
  const phones = new Set((filters.blockedPhones ?? []).map(phoneKey).filter(Boolean));
  if (snap.phone && phones.has(phoneKey(snap.phone))) return true;

  return false;
}
