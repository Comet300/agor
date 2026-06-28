/**
 * Seller reputation from observed behaviour across a seller's listings:
 *  - fast flips: listings de-listed soon after appearing (resell churn),
 *  - relists: how often their items vanish and reappear (price/visibility games),
 *  - volume: a long, stable history is a mild trust signal.
 *
 * Pure: it scores an aggregate produced by {@link ItemRepo.sellerStats}. A seller
 * with too little history is 'neutral' (no badge shown). Price-manipulation
 * (raise-then-drop) detection would need the per-item price history and is left
 * as a follow-up.
 */
export const SELLER_FAST_MS = 3 * 86_400_000; // a delist within 3 days = a fast flip
/** Minimum listings before reputation is meaningful. */
export const SELLER_MIN_LISTINGS = 3;

export interface SellerStats {
  listings: number;
  delisted: number;
  fastDelists: number;
  relists: number;
}

export type SellerTrust = 'good' | 'neutral' | 'caution';

export interface SellerReputation {
  trust: SellerTrust;
  reasons: string[];
}

export function sellerReputation(stats: SellerStats): SellerReputation {
  if (stats.listings < SELLER_MIN_LISTINGS) return { trust: 'neutral', reasons: [] };

  const fastRatio = stats.fastDelists / stats.listings;
  const avgRelists = stats.relists / stats.listings;
  const reasons: string[] = [];

  if (fastRatio >= 0.5) reasons.push('frequent_fast_flips');
  if (avgRelists >= 1.5) reasons.push('frequent_relisting');
  if (reasons.length > 0) return { trust: 'caution', reasons };

  // A sizeable, stable history (little churn) earns a positive badge.
  if (stats.listings >= 5 && fastRatio < 0.2 && avgRelists < 0.5) {
    return { trust: 'good', reasons: ['stable_history'] };
  }
  return { trust: 'neutral', reasons: [] };
}
