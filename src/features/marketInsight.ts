/**
 * Market-insight derivation: turn a listing's posted date + recorded price
 * history into negotiation-relevant signals (how long it's been listed, how many
 * times the price was cut, and the lowest price ever seen). Pure.
 */
import type { MarketInsight, PricePoint } from '../contracts';

export type { MarketInsight };

const DAY_MS = 86_400_000;

/**
 * Compute the {@link MarketInsight} for one item. `points` is the ascending
 * price history (store-on-change, so each point is a real change); `now` is the
 * current epoch ms. A listing posted in the future yields no `daysOnMarket`.
 */
export function marketInsight(
  postedAt: number | undefined,
  points: PricePoint[],
  now: number,
): MarketInsight {
  const out: MarketInsight = { priceCuts: 0 };
  if (postedAt !== undefined) {
    const days = Math.floor((now - postedAt) / DAY_MS);
    if (days >= 0) out.daysOnMarket = days;
  }
  if (points.length > 0) {
    out.lowestPrice = Math.min(...points.map((p) => p.price));
    for (let i = 1; i < points.length; i++) {
      if (points[i]!.price < points[i - 1]!.price) out.priceCuts++;
    }
  }
  return out;
}

/** True when an insight carries anything worth showing. */
export function hasInsight(i: MarketInsight): boolean {
  return i.daysOnMarket !== undefined || i.priceCuts > 0;
}
