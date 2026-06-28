/**
 * Weekly-report opt-in + cadence. A row exists only for watches that have the
 * weekly report enabled; `last_sent_at` gates delivery (0 = send on the next
 * flush, then weekly). Driving the flush off this table avoids scanning every
 * monitor each tick — only opted-in watches are visited.
 */
import type { DB } from './db';

export interface ReportStateRow {
  monitorId: number;
  chatId: number;
  lastSentAt: number;
}

export class ReportStateRepo {
  constructor(private readonly db: DB) {}

  /** Enable the weekly report for a watch (idempotent; keeps any last_sent_at). */
  enable(monitorId: number, chatId: number): void {
    this.db
      .prepare(
        `INSERT INTO report_state (monitor_id, chat_id, last_sent_at)
         VALUES (?, ?, 0)
         ON CONFLICT(monitor_id) DO UPDATE SET chat_id = excluded.chat_id`,
      )
      .run(monitorId, chatId);
  }

  /** Disable the weekly report for a watch (also the removal cleanup hook). */
  disable(monitorId: number): void {
    this.db.prepare(`DELETE FROM report_state WHERE monitor_id = ?`).run(monitorId);
  }

  /** Whether a watch currently has the weekly report enabled. */
  has(monitorId: number): boolean {
    return this.db.prepare(`SELECT 1 FROM report_state WHERE monitor_id = ? LIMIT 1`).get(monitorId) !== undefined;
  }

  /** Every opted-in watch with its last delivery time. */
  pending(): ReportStateRow[] {
    return this.db
      .prepare(`SELECT monitor_id AS monitorId, chat_id AS chatId, last_sent_at AS lastSentAt FROM report_state`)
      .all() as ReportStateRow[];
  }

  /** Stamp a delivery so the next one waits out the weekly cadence. */
  markSent(monitorId: number, now: number): void {
    this.db.prepare(`UPDATE report_state SET last_sent_at = ? WHERE monitor_id = ?`).run(now, monitorId);
  }
}
