/**
 * Digest-mode queue: new-listing alerts for a digest watch are parked here
 * instead of pinged in real time, then flushed as a ranked daily/weekly summary.
 * One row per (watch, chat, item); the earliest `queued_at` of a (watch, chat)
 * group decides when its digest window is due.
 */
import type { DealTag } from '../contracts';
import type { DB } from './db';

export interface DigestRow {
  itemId: string;
  title: string;
  price: number;
  currency: string;
  url: string;
  dealTag?: DealTag;
  deltaPct?: number;
}

/** One pending (watch, chat) group: when it first started filling and how big. */
export interface DigestPending {
  monitorId: number;
  chatId: number;
  oldest: number;
  count: number;
}

export class DigestQueueRepo {
  constructor(private readonly db: DB) {}

  /** Park a new listing for later digest delivery (idempotent; keeps first queued_at). */
  enqueue(monitorId: number, chatId: number, row: DigestRow, now: number): void {
    this.db
      .prepare(
        `INSERT INTO digest_queue
           (monitor_id, chat_id, item_id, title, price, currency, url, deal_tag, delta_pct, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(monitor_id, chat_id, item_id) DO NOTHING`,
      )
      .run(
        monitorId, chatId, row.itemId, row.title, row.price, row.currency, row.url,
        row.dealTag ?? null, row.deltaPct ?? null, now,
      );
  }

  /** All pending (watch, chat) groups with their oldest queue time and size. */
  pending(): DigestPending[] {
    return this.db
      .prepare(
        `SELECT monitor_id AS monitorId, chat_id AS chatId,
                MIN(queued_at) AS oldest, COUNT(*) AS count
           FROM digest_queue
          GROUP BY monitor_id, chat_id`,
      )
      .all() as DigestPending[];
  }

  /** The queued listings for a (watch, chat), oldest first. */
  items(monitorId: number, chatId: number): DigestRow[] {
    const rows = this.db
      .prepare(
        `SELECT item_id AS itemId, title, price, currency, url,
                deal_tag AS dealTag, delta_pct AS deltaPct
           FROM digest_queue
          WHERE monitor_id = ? AND chat_id = ?
          ORDER BY queued_at`,
      )
      .all(monitorId, chatId) as Array<DigestRow & { dealTag: DealTag | null; deltaPct: number | null }>;
    return rows.map((r) => ({
      itemId: r.itemId,
      title: r.title,
      price: r.price,
      currency: r.currency,
      url: r.url,
      ...(r.dealTag ? { dealTag: r.dealTag } : {}),
      ...(r.deltaPct !== null ? { deltaPct: r.deltaPct } : {}),
    }));
  }

  /** Drop a flushed (watch, chat) group. */
  clear(monitorId: number, chatId: number): void {
    this.db.prepare(`DELETE FROM digest_queue WHERE monitor_id = ? AND chat_id = ?`).run(monitorId, chatId);
  }

  /** Drop every queued row for a watch (called when the watch is removed). */
  removeAll(monitorId: number): void {
    this.db.prepare(`DELETE FROM digest_queue WHERE monitor_id = ?`).run(monitorId);
  }
}
