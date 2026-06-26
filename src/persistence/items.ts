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

/**
 * The full stored item, reconstructed for browsing. Metadata fields are optional
 * because a row first stored before the snapshot columns existed (or by a vendor
 * that omits a field) carries only the legacy state — it heals on the next poll.
 */
export interface ItemSnapshot {
  monitorId: number;
  itemId: string;
  inStock: boolean;
  lastPrice: number;
  currency: string;
  firstSeen: number;
  lastSeen: number;
  title?: string;
  url?: string;
  imageUrl?: string;
  location?: string;
  sellerPrivate?: boolean;
  postedAt?: number;
  description?: string;
  attributes?: Record<string, string>;
}

/** Raw shape of an `items` table row (snake_case, integer boolean). */
interface ItemRow {
  in_stock: number;
  last_price: number;
  currency: string;
}

/** Full raw row including the snapshot columns (any may be NULL). */
interface ItemSnapshotRow {
  monitor_id: number;
  item_id: string;
  in_stock: number;
  last_price: number;
  currency: string;
  first_seen: number;
  last_seen: number;
  title: string | null;
  url: string | null;
  image_url: string | null;
  location: string | null;
  seller_private: number | null;
  posted_at: number | null;
  description: string | null;
  attributes_json: string | null;
}

/** Parse a stored attributes_json blob back to a string map, tolerating corruption. */
function parseAttributes(json: string | null): Record<string, string> | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // corrupt blob treated as absent
  }
  return undefined;
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
   * subsequent sights update stock, price, currency, the full browsable snapshot
   * (title/url/image/location/seller/posted/description/attributes), and bump
   * `last_seen`. Clears `gone_count` and `delisted_at` so a reappearing item
   * is treated as live again.
   */
  upsert(monitorId: number, item: IScrapedItem, now: number): void {
    this.db
      .prepare(
        `INSERT INTO items
           (monitor_id, item_id, in_stock, last_price, currency, first_seen, last_seen,
            title, url, image_url, location, seller_private, posted_at, description, attributes_json)
         VALUES
           (@monitorId, @itemId, @inStock, @price, @currency, @now, @now,
            @title, @url, @imageUrl, @location, @sellerPrivate, @postedAt, @description, @attributesJson)
         ON CONFLICT(monitor_id, item_id) DO UPDATE SET
           in_stock        = excluded.in_stock,
           last_price      = excluded.last_price,
           currency        = excluded.currency,
           last_seen       = excluded.last_seen,
           title           = excluded.title,
           url             = excluded.url,
           image_url       = excluded.image_url,
           location        = excluded.location,
           seller_private  = excluded.seller_private,
           posted_at       = excluded.posted_at,
           description     = excluded.description,
           attributes_json = excluded.attributes_json,
           gone_count      = 0,
           delisted_at     = NULL`,
      )
      .run({
        monitorId,
        itemId: item.id,
        inStock: item.inStock ? 1 : 0,
        price: item.price,
        currency: item.currency,
        now,
        title: item.title ?? null,
        url: item.url ?? null,
        imageUrl: item.imageUrl ?? null,
        location: item.location ?? null,
        sellerPrivate: item.isPrivateOwner ? 1 : 0,
        postedAt: item.postedAt ?? null,
        description: item.description ?? null,
        attributesJson:
          item.attributes && Object.keys(item.attributes).length > 0
            ? JSON.stringify(item.attributes)
            : null,
      });
  }

  /** The full stored snapshot for one item, or `undefined` if never seen. */
  getSnapshot(monitorId: number, itemId: string): ItemSnapshot | undefined {
    const row = this.db
      .prepare(`SELECT * FROM items WHERE monitor_id = ? AND item_id = ?`)
      .get(monitorId, itemId) as ItemSnapshotRow | undefined;
    return row ? rowToSnapshot(row) : undefined;
  }

  /**
   * Number of browsable (non-delisted) items across all of a chat's monitors —
   * the "M" in a browse "item N of M".
   */
  countForChat(chatId: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM items i JOIN monitors m ON m.id = i.monitor_id
          WHERE m.chat_id = ? AND i.delisted_at IS NULL`,
      )
      .get(chatId) as { n: number };
    return row.n;
  }

  /**
   * One page of a chat's browsable items, unioned across its monitors, newest
   * `last_seen` first, excluding de-listed rows. `limit`/`offset` paginate.
   */
  browse(chatId: number, limit: number, offset: number): ItemSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT i.*
           FROM items i JOIN monitors m ON m.id = i.monitor_id
          WHERE m.chat_id = ? AND i.delisted_at IS NULL
          ORDER BY i.last_seen DESC, i.item_id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(chatId, limit, offset) as ItemSnapshotRow[];
    return rows.map(rowToSnapshot);
  }

  /**
   * One page of a single monitor's browsable items (newest `last_seen` first,
   * de-listed excluded) — the per-watch scope for /browse. Monitor ownership is
   * the caller's responsibility (the gateway validates the monitor belongs to the
   * chat before scoping to it).
   */
  browseByMonitor(monitorId: number, limit: number, offset: number): ItemSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT i.*
           FROM items i
          WHERE i.monitor_id = ? AND i.delisted_at IS NULL
          ORDER BY i.last_seen DESC, i.item_id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(monitorId, limit, offset) as ItemSnapshotRow[];
    return rows.map(rowToSnapshot);
  }

  /**
   * Browsable (non-delisted) item counts per monitor for a chat, keyed by monitor
   * id — powers the /browse scope picker's per-watch tallies. Monitors with no
   * browsable items are absent from the map (callers default those to 0).
   */
  browseCountsByMonitor(chatId: number): Map<number, number> {
    const rows = this.db
      .prepare(
        `SELECT i.monitor_id AS monitorId, COUNT(*) AS n
           FROM items i JOIN monitors m ON m.id = i.monitor_id
          WHERE m.chat_id = ? AND i.delisted_at IS NULL
          GROUP BY i.monitor_id`,
      )
      .all(chatId) as Array<{ monitorId: number; n: number }>;
    return new Map(rows.map((r) => [r.monitorId, r.n]));
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

  /** The de-listing bookkeeping for one item (absent-cycle counter + delist stamp). */
  delistState(monitorId: number, itemId: string): { goneCount: number; delistedAt?: number } | undefined {
    const row = this.db
      .prepare(`SELECT gone_count, delisted_at FROM items WHERE monitor_id = ? AND item_id = ?`)
      .get(monitorId, itemId) as { gone_count: number; delisted_at: number | null } | undefined;
    if (!row) return undefined;
    return { goneCount: row.gone_count ?? 0, ...(row.delisted_at != null ? { delistedAt: row.delisted_at } : {}) };
  }

  /**
   * Record that `absentIds` were NOT seen this cycle: increment each one's
   * `gone_count`. An item whose count reaches `threshold` for the FIRST time is
   * stamped `delisted_at = now` and returned, so the caller alerts exactly once.
   * Ids not stored for the monitor, or already delisted, are skipped. Wrapped in
   * a single transaction.
   */
  markAbsent(monitorId: number, absentIds: string[], now: number, threshold: number): string[] {
    if (absentIds.length === 0) return [];
    const bump = this.db.prepare(
      `UPDATE items SET gone_count = gone_count + 1
        WHERE monitor_id = ? AND item_id = ? AND delisted_at IS NULL`,
    );
    const stamp = this.db.prepare(
      `UPDATE items SET delisted_at = ?
        WHERE monitor_id = ? AND item_id = ? AND delisted_at IS NULL AND gone_count >= ?`,
    );
    const crossed: string[] = [];
    this.db.transaction(() => {
      for (const id of absentIds) {
        if (bump.run(monitorId, id).changes === 0) continue; // not stored / already delisted
        if (stamp.run(now, monitorId, id, threshold).changes > 0) crossed.push(id);
      }
    })();
    return crossed;
  }
}

/** Reconstruct an {@link ItemSnapshot} from a raw row (NULL metadata → undefined). */
function rowToSnapshot(r: ItemSnapshotRow): ItemSnapshot {
  const snap: ItemSnapshot = {
    monitorId: r.monitor_id,
    itemId: r.item_id,
    inStock: r.in_stock === 1,
    lastPrice: r.last_price,
    currency: r.currency,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  };
  if (r.title != null) snap.title = r.title;
  if (r.url != null) snap.url = r.url;
  if (r.image_url != null) snap.imageUrl = r.image_url;
  if (r.location != null) snap.location = r.location;
  if (r.seller_private != null) snap.sellerPrivate = r.seller_private === 1;
  if (r.posted_at != null) snap.postedAt = r.posted_at;
  if (r.description != null) snap.description = r.description;
  const attrs = parseAttributes(r.attributes_json);
  if (attrs) snap.attributes = attrs;
  return snap;
}
