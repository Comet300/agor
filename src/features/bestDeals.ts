/**
 * Best-deals ranking for /stats — the statistically cheapest listings in the
 * chat's collected pool.
 *
 * Each candidate is rated against the pool with {@link ratePrice} (same-currency,
 * title-similar comparables, percentile verdict). We keep the `great_deal`s,
 * drop the `suspicious` ones (too-good-to-be-true → likely a scam/typo, not a
 * deal to celebrate), and rank by how far below the comp median they sit.
 *
 * Pure; the rating scan is O(n²) over the (capped) pool, so it runs on demand
 * from the stats screen — never per cycle.
 */
import type { ItemSnapshot } from '../persistence';
import { ratePrice } from './priceRating';

export interface BestDeal {
  monitorId: number;
  itemId: string;
  title: string;
  price: number;
  currency: string;
  url?: string;
  /** Percent below the comparable median (rounded, ≥0). */
  discountPct: number;
  /** Comparables the verdict rests on. */
  n: number;
}

/** Rank the pool's standout great-deals by discount-below-median, best first. */
export function bestDeals(pool: ItemSnapshot[], limit = 5, scanCap = 250): BestDeal[] {
  const scan = pool.slice(0, scanCap); // pool is newest-first; bound the O(n²) cost
  const deals: BestDeal[] = [];
  for (const it of scan) {
    if (!it.title || it.lastPrice <= 0) continue;
    const r = ratePrice(
      { itemId: it.itemId, title: it.title, price: it.lastPrice, currency: it.currency, ...(it.url ? { url: it.url } : {}) },
      scan,
    );
    if (r.tag !== 'great_deal' || r.suspicious || r.median === undefined || r.median <= 0) continue;
    const discountPct = Math.max(0, Math.round((1 - it.lastPrice / r.median) * 100));
    deals.push({
      monitorId: it.monitorId,
      itemId: it.itemId,
      title: it.title,
      price: it.lastPrice,
      currency: it.currency,
      ...(it.url ? { url: it.url } : {}),
      discountPct,
      n: r.n,
    });
  }
  deals.sort((a, b) => b.discountPct - a.discountPct);
  return deals.slice(0, limit);
}
