/**
 * Future price-direction outlook for a tracked product, from its market-insight
 * signals (days-on-market, price-cut count) plus an optional category trend.
 *
 * This is an interpretable heuristic, not a trained forecaster: predicting an
 * actual future price needs labelled outcomes we do not collect. Instead we read
 * the seller's revealed behaviour — a seller who keeps cutting, or whose item has
 * sat for weeks with a cut, is likely to drop again; a fresh, un-cut listing is
 * more likely to hold.
 */
import type { MarketInsight } from '../contracts';
import type { TrendDir } from './trend';

export type PriceOutlook = 'falling' | 'stable' | 'unknown';

/** Days-on-market past which a single cut already signals a motivated seller. */
export const STALE_DAYS = 30;

/**
 * Predict where a tracked item's price is headed. `categoryTrend` (the search
 * market's 30-day direction, when known) tips a borderline call toward falling.
 */
export function predictDirection(insight: MarketInsight | undefined, categoryTrend?: TrendDir): PriceOutlook {
  if (!insight) return 'unknown';
  const { priceCuts, daysOnMarket } = insight;

  // Repeated cuts, or a stale listing already cut once → likely to drop further.
  if (priceCuts >= 2) return 'falling';
  if (daysOnMarket !== undefined && daysOnMarket >= STALE_DAYS && priceCuts >= 1) return 'falling';

  // A falling category nudges a single-cut item toward more drops.
  if (priceCuts >= 1 && categoryTrend === 'down') return 'falling';

  // Never cut → the price is holding; call it stable.
  if (priceCuts === 0) return 'stable';

  return 'unknown';
}
