/**
 * Scam-risk heuristic. Extends the price-only "suspicious" flag: a listing that
 * is too-good-to-be-true on PRICE *and* weak on seller-trust signals (no phone,
 * no photo) is the classic bait pattern. We combine those into a small score and
 * flag a listing only when the price is suspicious AND at least one trust signal
 * is missing — so a legitimately cheap listing with a phone + photo is NOT
 * flagged. Pure.
 *
 * Not yet modelled (would need more data / vision): stock-photo detection and
 * seller-account age. Hooks are left for the seller-reputation feature.
 */
import type { EnrichedItem } from '../contracts';
import type { FairValue } from './fairValue';

/** At/under this fraction below predicted fair value, the price is "too good". */
export const TOO_GOOD_PCT = -0.25;
/** Score at/above which a listing is flagged as a scam risk. */
export const SCAM_FLAG_SCORE = 3;

export interface ScamRisk {
  score: number;
  /** True only when the price is suspicious AND a trust signal is missing. */
  flagged: boolean;
  /** Machine-readable reasons (for logs/tests). */
  reasons: string[];
}

export function scamRisk(item: EnrichedItem, fairValue?: FairValue): ScamRisk {
  const reasons: string[] = [];
  let score = 0;

  const tooGood = fairValue !== undefined && fairValue.confidence !== 'low' && fairValue.deltaPct <= TOO_GOOD_PCT;
  if (tooGood) { score += 2; reasons.push('too_good_price'); }
  if (!item.phone) { score += 1; reasons.push('no_phone'); }
  if (!item.imageUrl) { score += 1; reasons.push('no_photo'); }

  // Only cry scam when the bait price coincides with a missing trust signal.
  const flagged = tooGood && score >= SCAM_FLAG_SCORE;
  return { score, flagged, reasons };
}
