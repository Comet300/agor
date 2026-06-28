/**
 * Per-chat item flags: a listing can be `saved` (shortlist) or `dismissed`
 * (hidden from browse + suppressed from alerts). One row per (chat, item, flag);
 * `monitor_id` is kept so the item's stored snapshot can be re-fetched.
 */
import type { DB } from './db';

export type ItemFlag = 'saved' | 'dismissed';

export class ItemFlagsRepo {
  constructor(private readonly db: DB) {}

  /** Set a flag on an item for a chat (idempotent). */
  set(chatId: number, itemId: string, monitorId: number, flag: ItemFlag, now: number): void {
    this.db
      .prepare(
        `INSERT INTO item_flags (chat_id, item_id, monitor_id, flag, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, item_id, flag) DO UPDATE SET monitor_id = excluded.monitor_id`,
      )
      .run(chatId, itemId, monitorId, flag, now);
  }

  /** Clear a flag from an item for a chat. */
  unset(chatId: number, itemId: string, flag: ItemFlag): void {
    this.db.prepare(`DELETE FROM item_flags WHERE chat_id = ? AND item_id = ? AND flag = ?`).run(chatId, itemId, flag);
  }

  /** Whether an item carries a flag for a chat. */
  has(chatId: number, itemId: string, flag: ItemFlag): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM item_flags WHERE chat_id = ? AND item_id = ? AND flag = ? LIMIT 1`)
        .get(chatId, itemId, flag) !== undefined
    );
  }

  /** The shortlist for a chat (item + its monitor + any note), newest first. */
  listSaved(chatId: number): Array<{ itemId: string; monitorId: number; note?: string }> {
    const rows = this.db
      .prepare(
        `SELECT item_id AS itemId, monitor_id AS monitorId, note FROM item_flags
          WHERE chat_id = ? AND flag = 'saved' ORDER BY created_at DESC`,
      )
      .all(chatId) as Array<{ itemId: string; monitorId: number; note: string | null }>;
    return rows.map((r) => ({ itemId: r.itemId, monitorId: r.monitorId, ...(r.note ? { note: r.note } : {}) }));
  }

  /**
   * Attach (or clear, with note='') a free-text note to an item for a chat. A note
   * implies the item is saved, so this upserts the 'saved' row. Clearing leaves the
   * item saved but noteless.
   */
  setNote(chatId: number, itemId: string, monitorId: number, note: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO item_flags (chat_id, item_id, monitor_id, flag, created_at, note)
         VALUES (?, ?, ?, 'saved', ?, ?)
         ON CONFLICT(chat_id, item_id, flag) DO UPDATE SET note = excluded.note`,
      )
      .run(chatId, itemId, monitorId, now, note || null);
  }

  /** The note a chat attached to an item, if any. */
  getNote(chatId: number, itemId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT note FROM item_flags WHERE chat_id = ? AND item_id = ? AND flag = 'saved' LIMIT 1`)
      .get(chatId, itemId) as { note: string | null } | undefined;
    return row?.note ?? undefined;
  }

  /** The set of item ids a chat has dismissed (for browse + alert suppression). */
  dismissedIds(chatId: number): Set<string> {
    const rows = this.db
      .prepare(`SELECT item_id FROM item_flags WHERE chat_id = ? AND flag = 'dismissed'`)
      .all(chatId) as Array<{ item_id: string }>;
    return new Set(rows.map((r) => r.item_id));
  }
}
