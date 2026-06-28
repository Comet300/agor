/**
 * Group/shared watches: a watch (Monitor) is owned by one chat (monitors.chat_id),
 * but its listing alerts can also fan out to ADDITIONAL subscriber chats — e.g. a
 * Telegram group, a partner, or a team. This repo holds the (watch → subscriber)
 * links; the owning chat is implicit and never stored here.
 */
import type { DB } from './db';

export class WatchSubscribersRepo {
  constructor(private readonly db: DB) {}

  /**
   * Subscribe a chat to a watch's alerts (idempotent). `canEdit` promotes the
   * subscriber to a collaborator who may also manage the watch's filters; on a
   * repeat call the role is updated (so /share … edit can upgrade a viewer).
   */
  add(monitorId: number, chatId: number, now: number, canEdit = false): void {
    this.db
      .prepare(
        `INSERT INTO watch_subscribers (monitor_id, chat_id, created_at, can_edit)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(monitor_id, chat_id) DO UPDATE SET can_edit = excluded.can_edit`,
      )
      .run(monitorId, chatId, now, canEdit ? 1 : 0);
  }

  /** Whether a chat is a collaborator (editor) on a watch. */
  isEditor(monitorId: number, chatId: number): boolean {
    const row = this.db
      .prepare(`SELECT can_edit FROM watch_subscribers WHERE monitor_id = ? AND chat_id = ?`)
      .get(monitorId, chatId) as { can_edit: number } | undefined;
    return row?.can_edit === 1;
  }

  /** Unsubscribe a chat from a watch. Returns true if a row was removed. */
  remove(monitorId: number, chatId: number): boolean {
    const info = this.db
      .prepare(`DELETE FROM watch_subscribers WHERE monitor_id = ? AND chat_id = ?`)
      .run(monitorId, chatId);
    return info.changes > 0;
  }

  /** The subscriber chat ids for a watch (excludes the implicit owner). */
  listChats(monitorId: number): number[] {
    const rows = this.db
      .prepare(`SELECT chat_id FROM watch_subscribers WHERE monitor_id = ? ORDER BY created_at`)
      .all(monitorId) as Array<{ chat_id: number }>;
    return rows.map((r) => r.chat_id);
  }

  /** How many extra chats a watch is shared with. */
  count(monitorId: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM watch_subscribers WHERE monitor_id = ?`)
      .get(monitorId) as { n: number };
    return row.n;
  }

  /** Drop all subscribers of a watch (called when the watch is removed). */
  removeAll(monitorId: number): void {
    this.db.prepare(`DELETE FROM watch_subscribers WHERE monitor_id = ?`).run(monitorId);
  }
}
