/**
 * Per-item state for a monitor: the latest known stock + price snapshot used to
 * detect new listings, back-in-stock transitions, and price changes.
 */

import type { IScrapedItem } from '../contracts';
import type { DB } from './db';

/** The mutable snapshot the change-detection pipeline reads back. */
export interface ItemState {
  inStock: boolean;
  lastPrice: number;
  currency: string;
}

/** Raw shape of an `items` table row (snake_case, integer boolean). */
interface ItemRow {
  in_stock: number;
  last_price: number;
  currency: string;
}

export class ItemRepo {
  constructor(private readonly db: DB) {}

  /** Every item id already recorded for a monitor. */
  knownIds(monitorId: number): Set<string> {
    const rows = this.db
      .prepare(`SELECT item_id FROM items WHERE monitor_id = ?`)
      .all(monitorId) as Array<{ item_id: string }>;
    return new Set(rows.map((r) => r.item_id));
  }

  /** The stored snapshot for one item, or `undefined` if never seen. */
  getState(monitorId: number, itemId: string): ItemState | undefined {
    const row = this.db
      .prepare(
        `SELECT in_stock, last_price, currency
           FROM items WHERE monitor_id = ? AND item_id = ?`,
      )
      .get(monitorId, itemId) as ItemRow | undefined;
    if (!row) return undefined;
    return {
      inStock: row.in_stock === 1,
      lastPrice: row.last_price,
      currency: row.currency,
    };
  }

  /**
   * Insert or refresh an item snapshot. On first sight `first_seen` is stamped;
   * subsequent sights update stock, price, currency and bump `last_seen`.
   */
  upsert(monitorId: number, item: IScrapedItem, now: number): void {
    this.db
      .prepare(
        `INSERT INTO items
           (monitor_id, item_id, in_stock, last_price, currency, first_seen, last_seen)
         VALUES
           (@monitorId, @itemId, @inStock, @price, @currency, @now, @now)
         ON CONFLICT(monitor_id, item_id) DO UPDATE SET
           in_stock   = excluded.in_stock,
           last_price = excluded.last_price,
           currency   = excluded.currency,
           last_seen  = excluded.last_seen`,
      )
      .run({
        monitorId,
        itemId: item.id,
        inStock: item.inStock ? 1 : 0,
        price: item.price,
        currency: item.currency,
        now,
      });
  }

  /**
   * Return the subset of `currentIds` not yet stored for this monitor. Pure
   * read — it never writes, so callers can decide how to treat the newcomers.
   */
  diffNewIds(monitorId: number, currentIds: string[]): string[] {
    if (currentIds.length === 0) return [];
    const known = this.knownIds(monitorId);
    return currentIds.filter((id) => !known.has(id));
  }
}
