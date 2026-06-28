/**
 * Store-on-change price log per (monitor, item). Each row is a genuine change
 * point: a poll whose price equals the last recorded one is NOT appended (the
 * price is assumed flat between change points). This keeps a forever history
 * that grows with price *changes*, not poll *count*. Powers price-drop detection
 * and the median benchmark analytics downstream; readers are unaffected since the
 * latest row is always the current price.
 */

import type { PricePoint } from '../contracts';
import type { DB } from './db';

/** Raw shape of a `price_history` table row needed to build a PricePoint. */
interface PriceRow {
  monitor_id: number;
  item_id: string;
  price: number;
  currency: string;
  observed_at: number;
}

export class PriceHistoryRepo {
  constructor(private readonly db: DB) {}

  /**
   * Record an observed price for an item — but only when it differs from the
   * last recorded one (or there is none yet). A poll at the same price is a
   * no-op, so the table stores change points, not every poll.
   */
  append(p: {
    monitorId: number;
    itemId: string;
    price: number;
    currency: string;
    observedAt: number;
    /**
     * The caller's already-known last price for this item, if it has one. When
     * the key is present the internal `lastPrice` lookup is skipped (avoids a
     * redundant SELECT per product poll — the cycle already fetched it). Pass
     * `undefined` to mean "no prior price known"; omit the key to re-query.
     */
    lastPrice?: number;
  }): void {
    const last = 'lastPrice' in p ? p.lastPrice : this.lastPrice(p.monitorId, p.itemId);
    if (last === p.price) return; // unchanged → assume flat, store nothing
    this.db
      .prepare(
        `INSERT INTO price_history
           (monitor_id, item_id, price, currency, observed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(p.monitorId, p.itemId, p.price, p.currency, p.observedAt);
  }

  /**
   * Each item's most-recent logged price at or before `asOf`, across the whole
   * monitor. Because the log stores change points (flat prices aren't re-logged),
   * the latest point ≤ asOf is the item's effective price at that instant. Used to
   * reconstruct the market's median price "now" vs "N days ago" for trend analysis.
   */
  pricesAsOf(monitorId: number, asOf: number): Array<{ itemId: string; price: number; currency: string }> {
    return this.db
      .prepare(
        `SELECT itemId, price, currency FROM (
           SELECT item_id AS itemId, price, currency,
                  ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY observed_at DESC, id DESC) AS rn
             FROM price_history
            WHERE monitor_id = ? AND observed_at <= ?
         ) WHERE rn = 1`,
      )
      .all(monitorId, asOf) as Array<{ itemId: string; price: number; currency: string }>;
  }

  /** Most recently observed price for an item, or `undefined` if none logged. */
  lastPrice(monitorId: number, itemId: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT price FROM price_history
          WHERE monitor_id = ? AND item_id = ?
          ORDER BY observed_at DESC, id DESC
          LIMIT 1`,
      )
      .get(monitorId, itemId) as { price: number } | undefined;
    return row?.price;
  }

  /**
   * Price history for an item, oldest observation first. With `limit`, returns
   * only the most recent `limit` change points (still ascending) so a years-long
   * history is bounded before it reaches the chart renderer; omit it for the
   * full series.
   */
  history(monitorId: number, itemId: string, limit?: number): PricePoint[] {
    // Fetch newest-first when capped (so LIMIT keeps the most recent points),
    // then restore ascending order for charting; uncapped stays plain ascending.
    const capped = limit !== undefined && limit > 0;
    const rows = this.db
      .prepare(
        `SELECT monitor_id, item_id, price, currency, observed_at
           FROM price_history
          WHERE monitor_id = ? AND item_id = ?
          ORDER BY observed_at ${capped ? 'DESC' : 'ASC'}, id ${capped ? 'DESC' : 'ASC'}
          ${capped ? 'LIMIT ?' : ''}`,
      )
      .all(...(capped ? [monitorId, itemId, limit] : [monitorId, itemId])) as PriceRow[];
    if (capped) rows.reverse();
    return rows.map((r) => ({
      monitorId: r.monitor_id,
      itemId: r.item_id,
      price: r.price,
      currency: r.currency,
      observedAt: r.observed_at,
    }));
  }
}
