/**
 * Append-only price log per (monitor, item). Powers price-drop detection and
 * the median benchmark analytics downstream.
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

  /** Record one observed price for an item. */
  append(p: {
    monitorId: number;
    itemId: string;
    price: number;
    currency: string;
    observedAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO price_history
           (monitor_id, item_id, price, currency, observed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(p.monitorId, p.itemId, p.price, p.currency, p.observedAt);
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

  /** Full price history for an item, oldest observation first. */
  history(monitorId: number, itemId: string): PricePoint[] {
    const rows = this.db
      .prepare(
        `SELECT monitor_id, item_id, price, currency, observed_at
           FROM price_history
          WHERE monitor_id = ? AND item_id = ?
          ORDER BY observed_at ASC, id ASC`,
      )
      .all(monitorId, itemId) as PriceRow[];
    return rows.map((r) => ({
      monitorId: r.monitor_id,
      itemId: r.item_id,
      price: r.price,
      currency: r.currency,
      observedAt: r.observed_at,
    }));
  }
}
